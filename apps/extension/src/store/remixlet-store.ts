// Remixlet store (wiki/handoff.md §6): each remixlet is a folder in OPFS with its own
// git history; a registry records which remixlets exist and their state.
// Invariants:
//   - snapshot-on-activate: every activation is a commit tagged `vN`; the
//     store assigns N (max existing tag + 1) and stamps it into the committed
//     remixlet.json, so the artifact and the tag always agree
//   - tags are immutable once created and version numbers are never reused;
//     every version stays permanently reachable via its tag (this is what
//     makes future sync/export append-only: commits+tags union cleanly)
//   - `main` always points at a tagged commit; rollback MOVES `main` back to
//     the target tag (no new commit, nothing rewritten) — a later change
//     forks off it as v(max+1) while the bypassed versions stay listed
//   - remove is soft ("archived" state) — restore is always possible; the
//     only exception is destroy, an explicit, user-confirmed hard delete
//   - archived remixlets are read-only: no mutation (activate, rollback,
//     enable/disable, verification) may touch one until the user restores it,
//     and an activation whose id collides with an archived entry is rejected
//     rather than resurrecting it or inheriting its history
//   - one git history per remixlet; rolling one back can never touch another
//
// OPFS-driven deviation from the handoff's sketch: state (enabled / disabled /
// archived) lives in the registry rather than in .disabled/.archive folders —
// OPFS cannot move directories, and the registry was already the state index.
//
// No extension APIs here. The worker owns writes (single writer); the panel
// reads via the worker protocol.

import {
  MANIFEST_FILE,
  parseRemixletManifest,
  parseStoredRemixletManifest,
  type RemixletManifest,
} from "../shared/remixlet.js";
import { sanitizeVerifiedAssertions, type VerifiedAssertion } from "../shared/show-changes.js";
import { sanitizeLookReview, type LookReview } from "../shared/look-review.js";
import { siteKeyForMatches, siteKeyForUrl, urlMatchesAny } from "../shared/site-key.js";
import { git, TREE } from "./git.js";
import { isFsError, OpfsFs, type FsPromises } from "./opfs-fs.js";

// "needs-attention" is system-parked: the final verification of an activation
// failed and no verified version existed to roll back to. It does not inject
// (only "enabled" does) and the enable/disable toggle rejects it — the code is
// known broken, so flipping it on makes no sense and flipping it "off" is a
// no-op lie. Its only exits are a fixing activation (activate() returns it to
// "enabled" so the build/verify loop injects) or archive. Plain "disabled"
// cannot express this: activate() must preserve a user's disable, but a fresh
// attempt on a system-parked remixlet must inject or the fix loop tests
// nothing — the state records WHY the remixlet is off.
export type RemixletState = "enabled" | "disabled" | "archived" | "needs-attention";

export interface RegistryEntry {
  id: string;
  name: string;
  state: RemixletState;
  siteKey: string;
  matches: string[];
  version: number;
  headSha: string;
  /** Set only by recordSuccessfulVerification; activation never advances it. */
  lastVerifiedAt?: string;
  lastVerifiedAgainst?: VerificationTarget;
  /**
   * The assert_page_state assertions that ALL passed in the run that minted
   * lastVerifiedAt — what the panel's "Show what changed" highlights point at.
   * Same staleness rule as the marker itself: activation carries it forward
   * untouched, and lastVerifiedAgainst says which version it describes.
   */
  lastVerifiedAssertions?: VerifiedAssertion[];
  /**
   * How the most recent owed verification concluded — pass, fail, or blocked
   * by the runtime safety check. Unlike lastVerifiedAt (which only ever moves
   * forward on success), this records failure too, so the next conversation
   * on the site starts with the failure context instead of archaeology.
   * Absent = never recorded (older entries; the registry parse is tolerant).
   */
  lastVerifyResult?: VerifyResult;
  /**
   * The model's recorded look verdict for the version it names (record_look
   * after look_at_change; wiki/design/look-review.md) — the "Visual review"
   * section on the manager's remixlet page. Carried forward by activation like the
   * verification marker, so its version/headSha say what it describes.
   * Absent on entries written before 2026-09-03 (optional on read).
   */
  lookReview?: LookReview;
}

export interface VerifyResult {
  outcome: "passed" | "failed" | "blocked";
  /** UTC ISO date-time of the run that concluded. */
  at: string;
  /** For failures: the failed assertions, a few words each (condition + selector). */
  summary?: string;
  /** The conversation the verification ran in. */
  conversationId?: string;
  /** The version the outcome describes. */
  version?: number;
  headSha?: string;
}

export interface VerificationTarget {
  url: string;
  siteKey: string;
  /** Optional for migrated/external verification records. */
  version?: number;
  headSha?: string;
}

export interface RemixletVerification {
  lastVerifiedAt: string;
  lastVerifiedAgainst: VerificationTarget;
}

export interface SuccessfulVerificationInput {
  url: string;
  /** Explicit for deterministic storage and testability. */
  verifiedAt: string;
  /** When present, must identify the current live version. */
  version?: number;
  /** When present, must identify the current live commit. */
  headSha?: string;
  /** The assertions that all passed in this run; replaces any stored set. */
  assertions?: VerifiedAssertion[];
  /** The conversation the verification ran in, for lastVerifyResult. */
  conversationId?: string;
}

export interface FailedVerificationInput {
  outcome: "failed" | "blocked";
  /** Explicit for deterministic storage and testability. */
  at: string;
  summary?: string;
  conversationId?: string;
}

export interface RemixletVersion {
  /** N from the `vN` tag. */
  version: number;
  /** "vN". */
  tag: string;
  sha: string;
  /** Full commit message; the UI shows the subject line only. */
  message: string;
  /** Tagged commit's author timestamp, ms since epoch. */
  when: number;
  /** True when this tag's commit is where refs/heads/main points. */
  current: boolean;
}

/**
 * One coherent read of a stored remixlet: the registry entry and the files
 * committed at its `headSha`, with the manifest parsed from those files. The
 * worktree is never consulted (see read()).
 */
export interface RemixletContent {
  entry: RegistryEntry;
  manifest: RemixletManifest;
  files: Record<string, string>;
}

const ROOT = "/remixlets";
const REGISTRY_DIR = `${ROOT}/.registry`;
const LOOK_REVIEW_DIR = `${ROOT}/.look-review`;
const REGISTRY_FILE = "registry.json";
const AUTHOR = { name: "remixlet", email: "agent@remixlet.com" };

export class RemixletStore {
  readonly #fs: FsPromises & { removeTree?(dir: string): Promise<void> };
  // MV3 message handlers interleave at every await. Reads and writes share
  // this lane so no caller can observe or overwrite a half-finished commit.
  #operationTail: Promise<void> = Promise.resolve();

  constructor(fs: FsPromises = new OpfsFs().promises) {
    this.#fs = fs;
  }

  /**
   * Write files and commit — install and new-version share this path
   * (snapshot-on-activate). The store assigns the version number and stamps
   * it into the committed remixlet.json; `message` (the agent's commit
   * message) falls back to `activate vN` when omitted. Returns the committed
   * version info.
   */
  async activate(files: Record<string, string>, message?: string): Promise<RegistryEntry> {
    return this.#mutate(async () => {
    const manifestJson = files[MANIFEST_FILE];
    if (manifestJson === undefined) throw new Error(`missing ${MANIFEST_FILE}`);
    const manifest = parseRemixletManifest(manifestJson);
    // Archived remixlets are invisible to the agent, so a colliding id is
    // accidental — never a request to resurrect. The archived folder, its
    // history, and its registry entry stay untouched.
    const previous = await this.#registryEntry(manifest.id);
    if (previous?.state === "archived") throw new Error(archivedIdCollisionMessage(manifest.id));
    const dir = `${ROOT}/${manifest.id}`;

    const fresh = !(await this.#exists(dir));
    if (fresh) await git.init({ fs: this.#fs, dir, defaultBranch: "main" });

    const version = (await this.#versionTags(dir)).reduce((max, tag) => Math.max(max, tag.n), 0) + 1;
    const stampedManifest = JSON.parse(manifestJson);
    stampedManifest.version = version;
    const stamped = {
      ...files,
      [MANIFEST_FILE]: `${JSON.stringify(stampedManifest, null, 2)}\n`,
    };
    for (const [name, content] of Object.entries(stamped)) {
      assertSafeFileName(name);
      await this.#fs.writeFile(`${dir}/${name}`, content);
      await git.add({ fs: this.#fs, dir, filepath: name });
    }
    // Files present in the previous version but absent now are removed.
    for (const gone of await this.#trackedFiles(dir)) {
      if (!Object.hasOwn(stamped, gone)) {
        await this.#fs.unlink(`${dir}/${gone}`).catch(() => undefined);
        await git.remove({ fs: this.#fs, dir, filepath: gone });
      }
    }
    const headSha = await git.commit({
      fs: this.#fs,
      dir,
      message: (message?.trim() || `activate v${version}${fresh ? " (install)" : ""}`).slice(0, 10_240),
      author: AUTHOR,
    });
    // Tag before the registry advances: a crash in between leaves an orphan,
    // untagged commit (never listed) that the next activation re-tags safely.
    await git.tag({ fs: this.#fs, dir, ref: `v${version}`, object: headSha, force: true });

    const entry: RegistryEntry = {
      id: manifest.id,
      name: manifest.name,
      // A user's disable survives new versions; a system park does not — a
      // fresh activation on a needs-attention remixlet is a fix attempt and
      // must inject, or the build/verify loop silently tests nothing.
      state: previous?.state === "disabled" ? "disabled" : "enabled",
      siteKey: siteKeyForMatches(manifest.matches),
      matches: manifest.matches,
      version,
      headSha,
    };
    if (previous?.lastVerifiedAt && previous.lastVerifiedAgainst) {
      entry.lastVerifiedAt = previous.lastVerifiedAt;
      entry.lastVerifiedAgainst = { ...previous.lastVerifiedAgainst };
      if (previous.lastVerifiedAssertions) {
        entry.lastVerifiedAssertions = previous.lastVerifiedAssertions.map((assertion) => ({ ...assertion }));
      }
    }
    // Carried forward like the verification marker: the record's own
    // version/headSha say which version the outcome describes.
    if (previous?.lastVerifyResult) entry.lastVerifyResult = { ...previous.lastVerifyResult };
    if (previous?.lookReview) entry.lookReview = { ...previous.lookReview };
    await this.#updateRegistry(entry);
    return entry;
    });
  }

  /**
   * Record the model's look verdict for the CURRENT version (record_look,
   * wiki/design/look-review.md). Stored beside the verification marker; a
   * malformed review is rejected, never half-stored. Replaces any earlier
   * review: only the latest look describes the live code.
   */
  async recordLookReview(id: string, input: LookReview): Promise<RegistryEntry> {
    return this.#mutate(async () => {
      const entry = await this.#mustGetEditable(id);
      const review = sanitizeLookReview({ ...input, reviewedAt: validatedIsoDate(input.reviewedAt) });
      if (!review) throw new Error("look review is malformed");
      review.version = entry.version;
      review.headSha = entry.headSha;
      entry.lookReview = review;
      await this.#updateRegistry(entry);
      return entry;
    });
  }

  /**
   * The subject crop the model looked at, latest only, kept outside both git
   * repos (the remixlet's worktree and the registry) so it is never committed
   * or diffed. A missing file is an ordinary "no crop" answer.
   */
  async writeLookCrop(id: string, png: Uint8Array): Promise<void> {
    assertSafeFileName(id);
    await this.#fs.writeFile(`${LOOK_REVIEW_DIR}/${id}.png`, png);
  }

  async readLookCrop(id: string): Promise<Uint8Array | undefined> {
    assertSafeFileName(id);
    try {
      const bytes = await this.#fs.readFile(`${LOOK_REVIEW_DIR}/${id}.png`);
      return bytes instanceof Uint8Array ? bytes : undefined;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  /**
   * The committed read every authorization decision is made from: the files
   * at the registry entry's `headSha`, never the worktree. The worktree is a
   * staging area (activate and rollback rewrite it before committing); an
   * interrupted activation or anything else that touches those files must
   * not change what counts as approved or what gets injected
   * (wiki/ops/2026-09-04-security-remediation-plan.md item 10). An
   * unregistered id has no committed identity and reads as unknown.
   */
  async read(id: string): Promise<RemixletContent> {
    return this.#inspect(async () => {
      const entry = await this.#mustGet(id);
      const files = await this.#filesAt(`${ROOT}/${id}`, entry.headSha);
      const manifestJson = files[MANIFEST_FILE];
      if (manifestJson === undefined) throw new Error(`remixlet ${id} has no ${MANIFEST_FILE}`);
      return { entry, manifest: parseStoredRemixletManifest(manifestJson), files };
    });
  }

  async list(): Promise<RegistryEntry[]> {
    return this.#inspect(async () =>
      Object.values(await this.#readRegistry()).sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  async active(): Promise<RegistryEntry[]> {
    return (await this.list()).filter((entry) => entry.state === "enabled");
  }

  async readVerification(id: string): Promise<RemixletVerification | undefined> {
    return this.#inspect(async () => {
    const entry = await this.#mustGet(id);
    if (!entry.lastVerifiedAt || !entry.lastVerifiedAgainst) return undefined;
    return {
      lastVerifiedAt: entry.lastVerifiedAt,
      lastVerifiedAgainst: { ...entry.lastVerifiedAgainst },
    };
    });
  }

  /**
   * Record an explicit successful verification of the current artifact.
   * Calling activate/rollback never calls this method or implies success.
   */
  async recordSuccessfulVerification(
    id: string,
    input: SuccessfulVerificationInput,
  ): Promise<RemixletVerification> {
    return this.#mutate(async () => {
    const entry = await this.#mustGetEditable(id);
    const verifiedAt = validatedIsoDate(input.verifiedAt);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error("verification URL must be an absolute http(s) URL");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !urlMatchesAny(url.href, entry.matches)) {
      throw new Error("verification URL must be an http(s) URL matched by the remixlet");
    }
    if (input.version !== undefined && input.version !== entry.version) {
      throw new Error(`verification version ${input.version} is not current version ${entry.version}`);
    }
    if (input.headSha !== undefined && input.headSha !== entry.headSha) {
      throw new Error(`verification head ${input.headSha} is not current head ${entry.headSha}`);
    }
    const lastVerifiedAgainst: VerificationTarget = {
      url: url.href,
      siteKey: siteKeyForUrl(url.href),
    };
    if (input.version !== undefined) lastVerifiedAgainst.version = input.version;
    if (input.headSha !== undefined) lastVerifiedAgainst.headSha = input.headSha;
    const verification: RemixletVerification = {
      lastVerifiedAt: verifiedAt,
      lastVerifiedAgainst,
    };
    entry.lastVerifiedAt = verification.lastVerifiedAt;
    entry.lastVerifiedAgainst = { ...verification.lastVerifiedAgainst };
    // The new record replaces the stored set either way: keeping a previous
    // version's spots under a fresh marker would let "Show what changed"
    // highlight places this verification never checked.
    const assertions = sanitizeVerifiedAssertions(input.assertions);
    if (assertions.length > 0) entry.lastVerifiedAssertions = assertions;
    else delete entry.lastVerifiedAssertions;
    entry.lastVerifyResult = {
      outcome: "passed",
      at: verifiedAt,
      version: entry.version,
      headSha: entry.headSha,
    };
    if (input.conversationId) entry.lastVerifyResult.conversationId = input.conversationId;
    // A pass on the live version is the ordinary fixing exit from a system
    // park (the fixing activation already returned it to "enabled"); if the
    // park somehow outlived it, the verified code must not stay parked.
    if (entry.state === "needs-attention") entry.state = "enabled";
    await this.#updateRegistry(entry);
    return verification;
    });
  }

  /**
   * Record that the owed verification of the current artifact concluded
   * without passing — failed assertions, or blocked by the runtime safety
   * check. Never touches lastVerifiedAt: that marker only ever means an
   * all-passing run.
   */
  async recordFailedVerification(id: string, input: FailedVerificationInput): Promise<RegistryEntry> {
    return this.#mutate(async () => {
      const entry = await this.#mustGetEditable(id);
      entry.lastVerifyResult = {
        outcome: input.outcome,
        at: validatedIsoDate(input.at),
        version: entry.version,
        headSha: entry.headSha,
      };
      if (input.summary?.trim()) entry.lastVerifyResult.summary = input.summary.trim().slice(0, 500);
      if (input.conversationId) entry.lastVerifyResult.conversationId = input.conversationId;
      await this.#updateRegistry(entry);
      return entry;
    });
  }

  /**
   * System park: stops injection while keeping code and history. Entered by
   * the failed-exit cleanup (a failed final verification with no verified
   * version to roll back to — lastVerifyResult carries the story).
   * activate() and archive are its only exits.
   */
  async parkNeedsAttention(id: string): Promise<RegistryEntry> {
    return this.#mutate(async () => {
      const entry = await this.#mustGetEditable(id);
      entry.state = "needs-attention";
      await this.#updateRegistry(entry);
      return entry;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<RegistryEntry> {
    return this.#mutate(async () => {
    const entry = await this.#mustGetEditable(id);
    // Mirrors the archived mutation guard so EVERY surface that sends
    // setEnabled is covered by one rule: a system-parked remixlet is known
    // broken — enabling it re-injects broken code, and "disabling" it is a
    // no-op lie (it already does not inject). Fix it or archive it.
    if (entry.state === "needs-attention") {
      throw new Error(
        `remixlet ${id} needs attention — its last change could not be verified; update it or archive it`,
      );
    }
    entry.state = enabled ? "enabled" : "disabled";
    await this.#updateRegistry(entry);
    return entry;
    });
  }

  /** Soft delete: never touches the folder or its history. */
  async remove(id: string): Promise<RegistryEntry> {
    return this.#mutate(async () => {
    const entry = await this.#mustGet(id);
    entry.state = "archived";
    await this.#updateRegistry(entry);
    return entry;
    });
  }

  async restore(id: string): Promise<RegistryEntry> {
    return this.#mutate(async () => {
    const entry = await this.#mustGet(id);
    if (entry.state === "archived") entry.state = "disabled";
    await this.#updateRegistry(entry);
    return entry;
    });
  }

  /**
   * Hard delete: erases the folder, its entire git history, and the registry
   * entry. Irreversible — the one lifecycle step restore cannot undo. The
   * tree goes first so a partial failure leaves the entry listed and destroy
   * retryable; the registry drops the id only once the files are gone.
   */
  async destroy(id: string): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#mustGet(id);
      await this.#removeDirTree(`${ROOT}/${id}`);
      try {
        await this.#fs.unlink(`${LOOK_REVIEW_DIR}/${id}.png`);
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
      await this.#removeFromRegistry(entry);
    });
  }

  /** Internal lifecycle compensation: restore registry metadata exactly. */
  async restoreEntry(entry: RegistryEntry): Promise<void> {
    await this.#mutate(async () => {
      const restored: RegistryEntry = {
        ...entry,
        matches: [...entry.matches],
      };
      if (entry.lastVerifiedAgainst) restored.lastVerifiedAgainst = { ...entry.lastVerifiedAgainst };
      if (entry.lastVerifyResult) restored.lastVerifyResult = { ...entry.lastVerifyResult };
      await this.#updateRegistry(restored);
    });
  }

  /** One entry per `vN` tag, newest version first. */
  async versions(id: string): Promise<RemixletVersion[]> {
    return this.#inspect(async () => {
      const dir = `${ROOT}/${id}`;
      const head = await git.resolveRef({ fs: this.#fs, dir, ref: "refs/heads/main" });
      const versions: RemixletVersion[] = [];
      for (const { tag, n } of await this.#versionTags(dir)) {
        const sha = await git.resolveRef({ fs: this.#fs, dir, ref: `refs/tags/${tag}` });
        const { commit } = await git.readCommit({ fs: this.#fs, dir, oid: sha });
        versions.push({
          version: n,
          tag,
          sha,
          message: commit.message.trim(),
          when: commit.author.timestamp * 1000,
          current: sha === head,
        });
      }
      return versions.sort((a, b) => b.version - a.version);
    });
  }

  /** First parent of a commit — the diff-vs-parent default (after a rollback
   *  fork, the list neighbor is NOT the git parent). */
  async parentOf(id: string, sha: string): Promise<string | undefined> {
    return this.#inspect(async () => {
      const { commit } = await git.readCommit({ fs: this.#fs, dir: `${ROOT}/${id}`, oid: sha });
      return commit.parent[0];
    });
  }

  /** File paths that differ between two commits (defaults: HEAD vs its parent). */
  async changes(id: string, shaA?: string, shaB?: string): Promise<string[]> {
    return this.#inspect(async () => {
    const dir = `${ROOT}/${id}`;
    const log = await git.log({ fs: this.#fs, dir, depth: 2 });
    const a = shaA ?? log[0]?.oid;
    const b = shaB ?? log[1]?.oid;
    if (!a || !b) return [];
    const changed = await git.walk({
      fs: this.#fs,
      dir,
      trees: [TREE({ ref: a }), TREE({ ref: b })],
      map: async (filepath: string, [x, y]: (WalkerEntry | null)[]) => {
        if (filepath === ".") return undefined;
        return (await x?.oid()) === (await y?.oid()) ? undefined : filepath;
      },
    });
    // SAFETY: git.walk returns the map callback's filepath strings.
    return changed as string[];
    });
  }

  /** Full file contents at a commit — the history UI diffs two of these. */
  async filesAt(id: string, sha: string): Promise<Record<string, string>> {
    return this.#inspect(() => this.#filesAt(`${ROOT}/${id}`, sha));
  }

  /**
   * Move refs/heads/main back to the tagged commit at `sha` — no new commit.
   * The bypassed versions stay reachable via their tags; the next activation
   * forks off the target as v(max+1). Rolling forward works the same way.
   */
  async rollback(id: string, sha: string): Promise<RegistryEntry> {
    return this.#mutate(async () => {
    const dir = `${ROOT}/${id}`;
    await this.#mustGetEditable(id);
    // Only tag targets are valid: a forged protocol message must not be able
    // to point main at an arbitrary object.
    let tagged = false;
    for (const { tag } of await this.#versionTags(dir)) {
      if ((await git.resolveRef({ fs: this.#fs, dir, ref: `refs/tags/${tag}` })) === sha) {
        tagged = true;
        break;
      }
    }
    if (!tagged) throw new Error(`rollback target ${sha} is not a tagged version of ${id}`);
    const files = await this.#filesAt(dir, sha);
    for (const [name, content] of Object.entries(files)) {
      await this.#fs.writeFile(`${dir}/${name}`, content);
      await git.add({ fs: this.#fs, dir, filepath: name });
    }
    for (const gone of await this.#trackedFiles(dir)) {
      if (files[gone] === undefined) {
        await this.#fs.unlink(`${dir}/${gone}`).catch(() => undefined);
        await git.remove({ fs: this.#fs, dir, filepath: gone });
      }
    }
    await git.writeRef({ fs: this.#fs, dir, ref: "refs/heads/main", value: sha, force: true });

    const manifest = parseStoredRemixletManifest(files[MANIFEST_FILE] ?? "{}");
    const entry = await this.#mustGet(id);
    entry.headSha = sha;
    entry.version = manifest.version;
    entry.name = manifest.name;
    entry.matches = manifest.matches;
    entry.siteKey = siteKeyForMatches(manifest.matches);
    await this.#updateRegistry(entry);
    return entry;
    });
  }

  // ---- internals ------------------------------------------------------------

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(operation);
  }

  #inspect<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(operation);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #exists(dir: string): Promise<boolean> {
    try {
      await this.#fs.readdir(dir);
      return true;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** The repo's version tags (`vN`), unsorted; [] for a fresh/missing repo. */
  async #versionTags(dir: string): Promise<{ tag: string; n: number }[]> {
    let tags: string[];
    try {
      tags = await git.listTags({ fs: this.#fs, dir });
    } catch {
      return [];
    }
    return tags.flatMap((tag) => {
      const match = /^v([1-9]\d*)$/.exec(tag);
      return match ? [{ tag, n: Number(match[1]) }] : [];
    });
  }

  async #trackedFiles(dir: string): Promise<string[]> {
    try {
      return await git.listFiles({ fs: this.#fs, dir });
    } catch {
      return [];
    }
  }

  async #filesAt(dir: string, sha: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const decoder = new TextDecoder();
    const paths = await git.listFiles({ fs: this.#fs, dir, ref: sha });
    for (const filepath of paths) {
      const { blob } = await git.readBlob({ fs: this.#fs, dir, oid: sha, filepath });
      files[filepath] = decoder.decode(blob);
    }
    return files;
  }

  /** Depth-first delete over FsPromises — OPFS has no recursive rmdir here. */
  async #removeDirTree(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await this.#fs.readdir(dir);
    } catch (error) {
      if (isFsError(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      if ((await this.#fs.lstat(path)).isDirectory()) await this.#removeDirTree(path);
      else await this.#fs.unlink(path);
    }
    await this.#fs.rmdir(dir);
  }

  async #mustGet(id: string): Promise<RegistryEntry> {
    const entry = await this.#registryEntry(id);
    if (!entry) throw new Error(`unknown remixlet: ${id}`);
    return entry;
  }

  /** Archived remixlets are read-only; only restore and destroy accept them. */
  async #mustGetEditable(id: string): Promise<RegistryEntry> {
    const entry = await this.#mustGet(id);
    if (entry.state === "archived") throw new Error(`remixlet ${id} is archived — restore it first`);
    return entry;
  }

  async #registryEntry(id: string): Promise<RegistryEntry | undefined> {
    return (await this.#readRegistry())[id];
  }

  async #readRegistry(): Promise<Record<string, RegistryEntry>> {
    try {
      // SAFETY: readFile's utf8 overload resolves to a string.
      const json = (await this.#fs.readFile(`${REGISTRY_DIR}/${REGISTRY_FILE}`, "utf8")) as string;
      // SAFETY: the registry is only committed through #commitRegistry using RegistryEntry values.
      return JSON.parse(json) as Record<string, RegistryEntry>;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return {};
      throw error;
    }
  }

  /** Registry is itself a tiny git repo — whole-setup history for free. */
  async #updateRegistry(entry: RegistryEntry): Promise<void> {
    const registry = await this.#readRegistry();
    registry[entry.id] = entry;
    await this.#commitRegistry(registry, `${entry.id}: ${entry.state} v${entry.version} @ ${entry.headSha.slice(0, 7)}`);
  }

  async #removeFromRegistry(entry: RegistryEntry): Promise<void> {
    const registry = await this.#readRegistry();
    delete registry[entry.id];
    await this.#commitRegistry(registry, `${entry.id}: destroyed v${entry.version} @ ${entry.headSha.slice(0, 7)}`);
  }

  async #commitRegistry(registry: Record<string, RegistryEntry>, message: string): Promise<void> {
    if (!(await this.#exists(`${REGISTRY_DIR}/.git`))) {
      await git.init({ fs: this.#fs, dir: REGISTRY_DIR, defaultBranch: "main" });
    }
    await this.#fs.writeFile(`${REGISTRY_DIR}/${REGISTRY_FILE}`, JSON.stringify(registry, null, 2));
    await git.add({ fs: this.#fs, dir: REGISTRY_DIR, filepath: REGISTRY_FILE });
    await git.commit({ fs: this.#fs, dir: REGISTRY_DIR, message, author: AUTHOR });
  }
}

/**
 * Shared by the store guard and the worker's pre-proposal check. Deliberately
 * does not say WHY the id is taken: archived remixlets stay invisible to the
 * agent, which should simply pick a fresh id.
 */
export function archivedIdCollisionMessage(id: string): string {
  return `remixlet id "${id}" is not available — choose a different id for this new remixlet`;
}

// isomorphic-git's WalkerEntry type, structurally (avoids exporting its types upward).
interface WalkerEntry {
  oid(): Promise<string | undefined>;
}

function assertSafeFileName(name: string): void {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.includes("..") || name.startsWith(".git")) {
    throw new Error(`unsafe remixlet file name: ${JSON.stringify(name)}`);
  }
}

function validatedIsoDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error("verification timestamp must be a UTC ISO date-time");
  }
  return value;
}
