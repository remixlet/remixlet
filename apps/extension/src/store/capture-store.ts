// Capture persistence (wiki/handoff.md §5 "Observation"): bundles live per site in
// OPFS as captures/<site-key>/<capture-id>/ so the agent can re-read them
// across turns (and sessions). Layout:
//   meta.json        — CaptureMeta (cheap to list)
//   bundle.json      — everything except the screenshot blob
//   screenshot.txt   — PNG data URL, when captured
// No extension APIs here — plain OPFS via the store's FsPromises.

import type { CaptureBundle } from "../shared/capture.js";
import { siteKeyForUrl } from "../shared/site-key.js";
import { isFsError, OpfsFs, type FsPromises } from "./opfs-fs.js";

export interface CaptureRef {
  siteKey: string;
  id: string;
}

export interface CaptureMeta extends CaptureRef {
  url: string;
  title: string;
  capturedAt: string;
  producedBy: CaptureBundle["producedBy"];
  hasScreenshot: boolean;
}

/**
 * Retention: completed captures kept per site; save() prunes anything older.
 * The store has no production reader again (the read_capture tool was removed
 * 2026-08-22 for disuse; read() serves only latest() internally), but the
 * retention obligation stands regardless (SECURITY-REVIEW "captures persist
 * forever" finding): the archive must not grow without bound under
 * unlimitedStorage. Newest-first pruning can never remove the capture the
 * latest-digest record points at (that is always the newest).
 */
export const MAX_CAPTURES_PER_SITE = 20;

const ROOT = "/captures";
// Latest-digest records for the unchanged-page short-circuit live OUTSIDE the
// per-site capture directories: list() readdirs ${ROOT}/<siteKey> expecting
// only capture-id directories.
const DIGEST_DIR = `${ROOT}/.latest-digest`;

/**
 * The per-site record behind the unchanged-page capture short-circuit
 * (wiki/raw/handoffs/2026-08-10-capture-context-diet.md): the newest capture's
 * content digest, valid only while no page-mutating event has occurred since
 * (any such event deletes the record — worker/capture-freshness.ts). Persisted
 * in OPFS so a restarted worker keeps exactly the same behavior.
 */
export interface LatestCaptureDigest {
  /** shared/capture-digest.ts captureContentDigest of the formatted capture. */
  digest: string;
  /** The stored capture the digest describes — the one the short reply points at. */
  ref: CaptureRef;
  url: string;
  capturedAt: string;
  /**
   * The conversation runtime the capture was delivered to. A short "you
   * already have this content" reply is only true for that conversation while
   * it is still open — any other conversation (or the same one reopened) must
   * get a full capture, because the referenced content is not in its context.
   */
  conversationEpoch: string;
  /**
   * The screenshot is the one part of a capture the digest text cannot see,
   * so the short-circuit additionally requires the new capture's screenshot
   * shape to equal the recorded one — otherwise it could swallow a screenshot
   * the model explicitly asked for.
   */
  hasScreenshot: boolean;
  screenshotCoverage?: "visible" | "full";
  /** When a short-circuit last confirmed the page unchanged (the record of "the agent looked"). */
  lastConfirmedAt?: string;
}

/**
 * Whether a just-taken capture may be answered with a short unchanged notice
 * instead of its full content. Pure; decided in code once per capture. The
 * absence of a record (never captured, or invalidated by a page-mutating
 * event) always refuses — that is the safety mechanism, not the digest.
 */
export function latestDigestMatches(
  record: LatestCaptureDigest,
  current: {
    digest: string;
    url: string;
    conversationEpoch: string;
    hasScreenshot: boolean;
    screenshotCoverage?: "visible" | "full";
  },
): boolean {
  return (
    record.conversationEpoch === current.conversationEpoch &&
    record.url === current.url &&
    record.digest === current.digest &&
    record.hasScreenshot === current.hasScreenshot &&
    record.screenshotCoverage === current.screenshotCoverage
  );
}

export class CaptureStore {
  readonly #fs: FsPromises;
  readonly #maxPerSite: number;

  constructor(fs: FsPromises = new OpfsFs().promises, maxPerSite: number = MAX_CAPTURES_PER_SITE) {
    this.#fs = fs;
    this.#maxPerSite = maxPerSite;
  }

  async save(bundle: CaptureBundle): Promise<CaptureRef> {
    const siteKey = safeSiteKey(bundle.url);
    const id = captureId(bundle.capturedAt);
    const dir = `${ROOT}/${siteKey}/${id}`;

    const { screenshot, ...rest } = bundle;
    const meta: CaptureMeta = {
      siteKey,
      id,
      url: bundle.url,
      title: bundle.title,
      capturedAt: bundle.capturedAt,
      producedBy: bundle.producedBy,
      hasScreenshot: screenshot !== undefined,
    };

    await this.#fs.writeFile(`${dir}/bundle.json`, JSON.stringify({ ...rest, screenshot: screenshot && { coverage: screenshot.coverage } }));
    if (screenshot) await this.#fs.writeFile(`${dir}/screenshot.txt`, screenshot.dataUrl);
    // meta.json written LAST — its presence marks the capture complete, so a
    // torn write never shows up in list().
    await this.#fs.writeFile(`${dir}/meta.json`, JSON.stringify(meta));
    // Retention: never let pruning fail a save — an unprunable store only
    // costs disk, a failed save costs the capture.
    await this.#prune(siteKey).catch(() => {});
    return { siteKey, id };
  }

  /** Delete completed captures beyond the newest #maxPerSite for a site. */
  async #prune(siteKey: string): Promise<void> {
    const metas = await this.list(siteKey);
    for (const meta of metas.slice(this.#maxPerSite)) {
      const dir = `${ROOT}/${meta.siteKey}/${meta.id}`;
      // meta.json goes FIRST: without it the capture vanishes from list()
      // (the torn-write rule in save()), so a prune interrupted mid-way
      // leaves an invisible remnant, never a listed-but-unreadable capture.
      for (const file of ["meta.json", "screenshot.txt", "bundle.json"]) {
        try {
          await this.#fs.unlink(`${dir}/${file}`);
        } catch (error) {
          if (!isFsError(error, "ENOENT")) throw error;
        }
      }
      await this.#fs.rmdir(dir);
    }
  }

  /** Rehydrate a full bundle, large blobs included. */
  async read(ref: CaptureRef): Promise<CaptureBundle> {
    const dir = `${ROOT}/${ref.siteKey}/${ref.id}`;
    // SAFETY: save() writes bundle.json from this exact CaptureBundle subset.
    const stored = JSON.parse((await this.#fs.readFile(`${dir}/bundle.json`, "utf8")) as string) as Omit<
      CaptureBundle,
      "screenshot"
    > & { screenshot?: { coverage: "visible" | "full" } };

    const bundle: CaptureBundle = { ...stored, screenshot: undefined };
    if (stored.screenshot) {
      // SAFETY: save() writes screenshot.txt as the captured screenshot data URL.
      const dataUrl = (await this.#fs.readFile(`${dir}/screenshot.txt`, "utf8")) as string;
      bundle.screenshot = { dataUrl, coverage: stored.screenshot.coverage };
    }
    if (bundle.screenshot === undefined) delete bundle.screenshot;
    return bundle;
  }

  /** Completed captures for a site, newest first. */
  async list(siteKey: string): Promise<CaptureMeta[]> {
    let ids: string[];
    try {
      ids = await this.#fs.readdir(`${ROOT}/${siteKey}`);
    } catch (error) {
      if (isFsError(error, "ENOENT")) return [];
      throw error;
    }
    const metas: CaptureMeta[] = [];
    for (const id of ids) {
      try {
        // SAFETY: save() writes meta.json from this exact CaptureMeta contract before exposing a capture in list().
        metas.push(JSON.parse((await this.#fs.readFile(`${ROOT}/${siteKey}/${id}/meta.json`, "utf8")) as string) as CaptureMeta);
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error; // incomplete capture: no meta yet — skip
      }
    }
    return metas.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async latest(siteKey: string): Promise<CaptureBundle | undefined> {
    const [newest] = await this.list(siteKey);
    return newest && this.read(newest);
  }

  // ---- latest-digest records (unchanged-page short-circuit) ----------------
  // All three operations fail toward a full capture: an unreadable or corrupt
  // record reads as absent, and clearing tolerates "already gone".

  async readLatestDigest(siteKey: string): Promise<LatestCaptureDigest | undefined> {
    try {
      // SAFETY: writeLatestDigest() serializes this exact digest contract at this path.
      const record = JSON.parse(
        (await this.#fs.readFile(`${DIGEST_DIR}/${siteKey}.json`, "utf8")) as string,
      ) as LatestCaptureDigest;
      if (!hasDigestFields(record)) return undefined;
      return record;
    } catch {
      return undefined;
    }
  }

  async writeLatestDigest(siteKey: string, record: LatestCaptureDigest): Promise<void> {
    await this.#fs.writeFile(`${DIGEST_DIR}/${siteKey}.json`, JSON.stringify(record));
  }

  /** Invalidate: the next capture for this site is always a full one. Never throws. */
  async clearLatestDigest(siteKey: string): Promise<void> {
    try {
      await this.#fs.unlink(`${DIGEST_DIR}/${siteKey}.json`);
    } catch {
      // Absent already, or OPFS unavailable — either way there is nothing a
      // caller (activation, navigation) should fail over; if OPFS is broken,
      // readLatestDigest fails toward a full capture too.
    }
  }

  /** Record that a short-circuit confirmed the page unchanged at `at`. */
  async confirmLatestDigest(siteKey: string, at: string): Promise<void> {
    const record = await this.readLatestDigest(siteKey);
    if (record) await this.writeLatestDigest(siteKey, { ...record, lastConfirmedAt: at });
  }
}

function hasDigestFields(record: LatestCaptureDigest): record is LatestCaptureDigest & { digest: string; conversationEpoch: string } {
  return (
    Object.prototype.toString.call(record.digest) === "[object String]" &&
    Object.prototype.toString.call(record.conversationEpoch) === "[object String]"
  );
}

/**
 * Captures of pages without a usable host (about:blank, files) still persist.
 * Exported so the digest record and its invalidation derive the SAME key a
 * save() would — a mismatch would silently break invalidation.
 */
export function captureSiteKey(url: string): string {
  return safeSiteKey(url);
}

function safeSiteKey(url: string): string {
  try {
    return siteKeyForUrl(url) || "unknown-site";
  } catch {
    return "unknown-site";
  }
}

function captureId(capturedAt: string): string {
  const stamp = capturedAt.replace(/[-:]/g, "").replace(/\..*$/, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}
