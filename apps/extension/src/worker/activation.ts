// Atomic activation pipeline (wiki/handoff.md §5): commit to git → rebuild mirror →
// re-register user scripts → reload the affected tab ONCE. All-or-nothing:
// any failure rolls the mirror (and registrations) back to the previous state
// and reports. Restart-free activation is a core product promise — any
// "reload the browser" path is a bug.
//
// CSS never needs an explicit teardown step here BECAUSE it is injected from
// the mirror on every navigation (css.ts) — the one tab reload re-applies it.
// DNR refresh joins the pipeline at M4.

import { isSupportedScriptFile, MANIFEST_FILE } from "../shared/remixlet.js";
import { parseRemixletManifest, parseStoredRemixletManifest, validateManifestFileReferences } from "../shared/remixlet.js";
import type { RemixletManifest } from "../shared/remixlet.js";
import { remixletCapabilityDisabledReason } from "../platform/capabilities.js";
import { getDynamicRules, replaceDynamicRules } from "../platform/dnr.js";
import { ext } from "../platform/ext.js";
import { scriptInjector } from "../platform/script-injector.js";
import { clearOwnedNotifications } from "../platform/notifications.js";
import { matchesCoverAllSites, matchesWiden, siteKeyForMatches, siteKeysPausing, urlMatchesAny, urlWithinSiteKey } from "../shared/site-key.js";
import {
  archivedIdCollisionMessage,
  RemixletStore,
  type FailedVerificationInput,
  type RegistryEntry,
} from "../store/remixlet-store.js";
import { refreshAllBadges } from "./badge.js";
import { observeHostPattern } from "../shared/observe-capability.js";
import { bridgeTokenFor, readMirror, reconcileUserScripts, relayTokenFor, writeMirror, type ActiveRemixlet } from "./injection.js";
import { reconcileNetRules, validateNetRulesFile } from "./netrules.js";
import { readPausedSites, setSitePaused, writePausedSites } from "./site-pause.js";
import { bridgeSkewReason } from "../shared/bridge-version.js";
import { appendScriptLogOnce, clearScriptLog } from "./script-log.js";
import { clearUsage } from "./usage.js";
import { invalidateCaptureDigestForTab, invalidateCaptureDigestForUrl } from "./capture-freshness.js";
import { clearMenuCommandsForPausedSites, clearMenuCommandsForRemixlet, reconcileMenuCommands } from "./menu.js";
import {
  clearOwnedSchedules,
  readScheduleSessionState,
  readScheduleState,
  reconcileScheduleOwners,
  restoreScheduleSessionState,
  restoreScheduleState,
  type ScheduleState,
} from "./schedule.js";
import { CapabilityGrantStore, type CapabilityGrants } from "./capability-grants.js";

export type ActivationOutcome =
  | { ok: true; entry: RegistryEntry; jsChanged: boolean }
  | { ok: false; reason: "failed"; message: string; rolledBack: boolean }
  | { ok: false; reason: "needs-capability-approval"; message: string; rolledBack: false; proposal: CapabilityApprovalProposal };

export type RollbackOutcome =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: "needs-capability-approval"; proposal: CapabilityApprovalProposal };

export interface CapabilityApprovalProposal {
  proposalId: string;
  remixletId: string;
  remixletName: string;
  requested: string[];
  added: string[];
  /**
   * Previously granted capabilities this activation drops (the grant record is
   * rewritten to exactly `requested`). Shown wherever the proposal is put to a
   * human, so a capability swap reads as a replacement, not extra access.
   */
  removed: string[];
  rationales: Record<string, string>;
  /**
   * The manifest's match patterns and their derived site key — the SCOPE this
   * activation would run on. The approval surface renders a panel-authored
   * scope card from these (never model prose), so the user sees which sites the
   * code covers, not just which capability names it names.
   */
  matches: string[];
  siteKey: string;
  /**
   * This activation reaches sites the previous version did not — a fresh
   * `<all_urls>`/bare-`*` install or a version-to-version widening. When set,
   * the scope must be SHOWN: the panel skips its one-click auto-approval so the
   * scope card is never bypassed.
   */
  broadScope: boolean;
  /**
   * A remixlet that already holds `netrules` is changing the CONTENT of its
   * rules file versus what was approved (H5). Capability names did not change,
   * so nothing else here would raise a dialog — this flag forces one, and the
   * panel shows a fixed line saying the network rules changed. Also blocks the
   * one-click auto-approval, so a rules rewrite is never bypassed.
   */
  netRulesChanged: boolean;
}

interface StoredCapabilityProposal extends CapabilityApprovalProposal {
  createdAt: number;
  artifactDigest: string;
}

const CAPABILITY_GRANTS_KEY = "remixletCapabilityGrants";
// Sentinel: set the first time the legacy manifest→grants migration runs, so a
// later missing grants key is read as a cleared record (fail closed) rather
// than a fresh legacy install to re-derive from (capability-grants.ts).
const CAPABILITY_GRANTS_MIGRATED_KEY = "remixletCapabilityGrantsMigrated";
const CAPABILITY_PROPOSALS_KEY = "remixletCapabilityProposals";
// Digest of the netRules file content the user last approved, per remixlet.
// Argument-free `netrules` grants would otherwise let v2 rewrite rules.json
// with no dialog (H5); binding the content here makes a change re-prompt.
const NET_RULES_DIGESTS_KEY = "remixletNetRulesDigests";
const PROPOSAL_MAX_AGE_MS = 10 * 60 * 1000;
type NetRulesDigests = Record<string, string>;

const store = new RemixletStore();
const capabilityGrantStore = new CapabilityGrantStore(
  async () => {
    const stored = await ext.storage.local.get(CAPABILITY_GRANTS_KEY);
    // SAFETY: CapabilityGrantStore is the sole writer for this persisted grants key.
    return stored[CAPABILITY_GRANTS_KEY] as CapabilityGrants | undefined;
  },
  async (grants) => {
    await ext.storage.local.set({ [CAPABILITY_GRANTS_KEY]: grants });
  },
  async () => {
    const migrated: CapabilityGrants = {};
    for (const entry of await store.list()) {
      const { manifest } = await store.read(entry.id);
      migrated[entry.id] = normalizedCapabilities(manifest.capabilities);
    }
    return migrated;
  },
  async () => (await ext.storage.local.get(CAPABILITY_GRANTS_MIGRATED_KEY))[CAPABILITY_GRANTS_MIGRATED_KEY] === true,
  async () => {
    await ext.storage.local.set({ [CAPABILITY_GRANTS_MIGRATED_KEY]: true });
  },
);
let activationMutationTail: Promise<void> = Promise.resolve();

function enqueueActivationMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = activationMutationTail.then(operation);
  activationMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The store instance the worker protocol handlers share. */
export function remixletStore(): RemixletStore {
  return store;
}

export async function activateRemixlet(
  files: Record<string, string>,
  reloadTabId?: number,
  capabilityApproval?: { proposalId: string },
  message?: string,
): Promise<ActivationOutcome> {
  return enqueueActivationMutation(() => activateRemixletUnlocked(files, reloadTabId, capabilityApproval, message));
}

async function activateRemixletUnlocked(
  files: Record<string, string>,
  reloadTabId?: number,
  capabilityApproval?: { proposalId: string },
  message?: string,
): Promise<ActivationOutcome> {
  let manifest;
  try {
    manifest = parseRemixletManifest(files[MANIFEST_FILE] ?? "");
    validateManifestFileReferences(manifest, files);
    validateNetRulesFile(manifest, files);
  } catch (error) {
    return { ok: false, reason: "failed", message: `not activated: ${String(error)}`, rolledBack: false };
  }
  // Verified with a real call, not just the namespace: this worker context
  // keeps chrome.userScripts after the browser revokes the lane, and
  // registering scripts that can never run is worse than refusing here
  // (script-injector.ts). Unconditional, because the sync capability checks
  // further down — page-world, network:observe — ride the same lane and read
  // the verdict this call settles.
  const scriptLane = await scriptInjector().verifyAvailable();
  if ((manifest.scripts?.length ?? 0) > 0 && !scriptLane) {
    return {
      ok: false,
      reason: "failed",
      message: `not activated: ${scriptInjector().disabledReason}`,
      rolledBack: false,
    };
  }

  // Id collisions with archived remixlets fail before the capability flow, so
  // the user is never asked to approve a doomed activation. The store's
  // activate() guard enforces the same rule; this is the courteous early exit.
  const previousEntry = (await store.list()).find((candidate) => candidate.id === manifest.id);
  if (previousEntry?.state === "archived") {
    return { ok: false, reason: "failed", message: `not activated: ${archivedIdCollisionMessage(manifest.id)}`, rolledBack: false };
  }

  const grants = await readCapabilityGrants();
  const requested = normalizedCapabilities(manifest.capabilities);
  const unsupported = requested
    .map((capability) => ({ capability, reason: remixletCapabilityDisabledReason(capability) }))
    .find((entry) => entry.reason !== undefined);
  if (unsupported) {
    return {
      ok: false,
      reason: "failed",
      message: `not activated: capability "${unsupported.capability}" is disabled — ${unsupported.reason}`,
      rolledBack: false,
    };
  }
  const previousGrants = grants[manifest.id] ?? [];
  const added = requested.filter((capability) => !previousGrants.includes(capability));
  // Scope is a gated power in its own right, not just capabilities (C1/Chain A).
  // Raise the approval surface when the code's reach GROWS versus the version
  // already live, and unconditionally whenever the manifest runs on every site
  // — a fresh <all_urls>/bare-* install has no previous version to widen from
  // but is exactly the silent-implant case.
  const scopeWidened = previousEntry !== undefined && matchesWiden(previousEntry.matches, manifest.matches);
  const coversAllSites = matchesCoverAllSites(manifest.matches);
  const broadScope = scopeWidened || coversAllSites;
  // A rewrite of already-granted network rules must re-prompt too (H5): the
  // capability name is unchanged, so nothing above would raise a dialog.
  const netRulesChanged = await netRulesContentChanged(manifest, files, previousGrants, requested);
  if (added.length > 0 || broadScope || netRulesChanged) {
    if (
      !capabilityApproval ||
      !(await consumeMatchingProposal(capabilityApproval.proposalId, manifest.id, requested, files))
    ) {
      const proposal = await createCapabilityProposal(
        manifest.id,
        manifest.name,
        requested,
        added,
        previousGrants.filter((capability) => !requested.includes(capability)),
        manifest.capabilityRationales ?? {},
        files,
        manifest.matches,
        broadScope,
        netRulesChanged,
      );
      return {
        ok: false,
        reason: "needs-capability-approval",
        message: approvalRequiredMessage(added, scopeWidened, coversAllSites, netRulesChanged),
        rolledBack: false,
        proposal,
      };
    }
  }

  const previousLive = await captureLiveState(grants);
  // Decided BEFORE store.activate() overwrites the stored version — at this
  // point store.read still returns the previous file set. A CSS-only diff owes
  // the agent no click-cycle re-verification (contracts.ts gates on this), and
  // only the store can answer "did any .js file actually change". Incoming
  // files were Prettier-formatted panel-side exactly as the previous version
  // was at its own write time, so the byte-compare is apples-to-apples. A
  // fresh install counts as changed.
  const jsChanged = previousEntry === undefined || (await jsFilesChanged(manifest.id, files));
  let entry: RegistryEntry;
  try {
    // 1. Snapshot first: even a failed activation leaves inspectable history
    // (its tag stays, so it remains a numbered, rollback-able version).
    entry = await store.activate(files, message);
  } catch (error) {
    return { ok: false, reason: "failed", message: `not activated: ${String(error)}`, rolledBack: false };
  }

  try {
    await writeCapabilityGrants({ ...grants, [manifest.id]: requested });
    // Bind the approved rules content to the grant (H5): a later version that
    // rewrites the file re-prompts. Cleared when the grant is dropped so a
    // re-added netrules grant starts from a fresh approval.
    await writeNetRulesDigest(
      manifest.id,
      requested.includes("netrules") ? await netRulesDigest(manifest, files) : undefined,
    );
    if (previousEntry) await clearOwnedSchedules(manifest.id);
    // Stale script-log entries describe the replaced version, not this one.
    // Cleared BEFORE the mirror rebuild so notes the rebuild itself records
    // about the new version (bridge skew) survive the activation.
    await clearScriptLog(manifest.id);
    await syncMirrorUnlocked();
    if (previousEntry) await clearMenuCommandsForRemixlet(manifest.id);
    if (previousGrants.includes("notifications") && !requested.includes("notifications")) {
      await clearOwnedNotifications(manifest.id);
    }
    if (reloadTabId !== undefined) {
      // The reload applies the new version, so any capture digest for the
      // page is stale. Cleared BEFORE the reload (and before this returns),
      // so the contract's post-write capture can never be answered with an
      // unchanged-page short-circuit — even if the new page digests
      // identically (e.g. a CSS-only change the digest text cannot see).
      await invalidateCaptureDigestForTab(reloadTabId);
      await ext.tabs.reload(reloadTabId);
    }
    return { ok: true, entry, jsChanged };
  } catch (error) {
    // Roll the live state back to the previous version. For an update the
    // history keeps the failed commit for inspection; a failed fresh install
    // vanishes entirely (see restoreStoreAfterFailedActivation).
    const storeRestored = await restoreStoreAfterFailedActivation(manifest.id, previousEntry);
    const liveRestored = await restoreLiveState(previousLive);
    const rolledBack = storeRestored && liveRestored;
    return { ok: false, reason: "failed", message: `activation failed: ${String(error)}`, rolledBack };
  }
}

/** Reject a pending proposal without changing the store, mirror, or grants. */
export async function denyCapabilityProposal(proposalId: string): Promise<void> {
  return enqueueActivationMutation(() => denyCapabilityProposalUnlocked(proposalId));
}

async function denyCapabilityProposalUnlocked(proposalId: string): Promise<void> {
  const proposals = await readCapabilityProposals();
  delete proposals[proposalId];
  await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
}

/** Durable human grant check used by every privileged bridge service. */
export async function hasCapabilityGrant(remixletId: string, capability: string): Promise<boolean> {
  return (await readCapabilityGrants())[remixletId]?.includes(capability) ?? false;
}

/**
 * What a remixlet asks for versus what it currently holds — the manager's
 * capability panel. `declared` is the manifest's set (normalized/sorted);
 * `granted` is the durable grant record. A capability can be declared but not
 * granted (revoked, or never approved) — the panel shows that difference.
 */
export async function readRemixletCapabilities(id: string): Promise<{ declared: string[]; granted: string[] }> {
  const { manifest } = await store.read(id);
  const granted = (await readCapabilityGrants())[id] ?? [];
  return { declared: normalizedCapabilities(manifest.capabilities), granted: [...granted].sort() };
}

/**
 * Revoke one capability from a live remixlet without deleting it. The grant
 * record is the single source of truth every bridge service re-checks, so
 * dropping the name here is enough to deny future calls; syncMirror then tears
 * down the derived live resources (network:observe interceptors, DNR rules,
 * schedule ownership) and the reload scope evicts already-injected code.
 *
 * The code was written assuming the capability it just lost, so it is now
 * known broken: the remixlet is parked "needs-attention" (with the revoke
 * recorded as the cause) rather than left injecting. A chat brings it back —
 * a fixing write_remixlet either drops the capability or re-declares it,
 * which re-runs the approval flow. Returns the remaining granted set.
 */
export async function revokeCapability(id: string, capability: string, scope: ReloadScope = {}): Promise<string[]> {
  return enqueueActivationMutation(() => revokeCapabilityUnlocked(id, capability, scope));
}

async function revokeCapabilityUnlocked(id: string, capability: string, scope: ReloadScope): Promise<string[]> {
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown remixlet: ${id}`);
  const grants = await readCapabilityGrants();
  const current = grants[id] ?? [];
  if (!current.includes(capability)) return [...current].sort();
  const next = current.filter((name) => name !== capability);
  const live = await captureLiveState(grants);
  try {
    await writeCapabilityGrants({ ...grants, [id]: next });
    // Park before the mirror rebuild so the rebuild already sees the entry as
    // not-enabled and drops it from injection. Archived entries are already
    // inert and stay archived.
    if (entry.state !== "archived") {
      await store.parkNeedsAttention(id, { kind: "capability-revoked", capability, at: new Date().toISOString() });
    }
    // Tear down what this specific capability backed, mirroring the per-capability
    // cleanup an activation does when a manifest drops it.
    if (capability === "netrules") await writeNetRulesDigest(id, undefined);
    if (capability === "notifications") await clearOwnedNotifications(id);
    if (capability === "schedule") await clearOwnedSchedules(id);
    if (capability === "menu") await clearMenuCommandsForRemixlet(id);
    await syncMirrorUnlocked();
    await applyReloadScope(entry, scope);
    return [...next].sort();
  } catch (error) {
    await store.restoreEntry(entry).catch(() => {});
    await restoreLiveState(live);
    throw error;
  }
}

async function createCapabilityProposal(
  remixletId: string,
  remixletName: string,
  requested: string[],
  added: string[],
  removed: string[],
  rationales: Record<string, string>,
  files: Record<string, string>,
  matches: string[],
  broadScope: boolean,
  netRulesChanged: boolean,
): Promise<CapabilityApprovalProposal> {
  let siteKey: string;
  try {
    siteKey = siteKeyForMatches(matches);
  } catch {
    // No valid host in the patterns (can't happen post-parse) — fall back to a
    // literal join so the scope card still has something honest to render.
    siteKey = matches.join("+");
  }
  const proposal: StoredCapabilityProposal = {
    proposalId: crypto.randomUUID(),
    remixletId,
    remixletName,
    requested,
    added,
    removed,
    rationales: Object.fromEntries(added.flatMap((capability) => {
      const rationale = rationales[capability]?.trim();
      return rationale ? [[capability, rationale]] : [];
    })),
    matches,
    siteKey,
    broadScope,
    netRulesChanged,
    createdAt: Date.now(),
    artifactDigest: await digestArtifactFiles(files),
  };
  const proposals = await readCapabilityProposals();
  // One live proposal per remixlet. A newer agent attempt supersedes the old
  // one, so an old confirmation cannot authorize a later file set.
  for (const [id, existing] of Object.entries(proposals)) {
    if (existing.remixletId === remixletId) delete proposals[id];
  }
  proposals[proposal.proposalId] = proposal;
  await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
  const { createdAt: _, artifactDigest: __, ...publicProposal } = proposal;
  return publicProposal;
}

async function consumeMatchingProposal(
  proposalId: string,
  remixletId: string,
  requested: string[],
  files: Record<string, string>,
): Promise<boolean> {
  const proposals = await readCapabilityProposals();
  const proposal = proposals[proposalId];
  delete proposals[proposalId];
  await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
  return (
    proposal !== undefined &&
    Date.now() - proposal.createdAt <= PROPOSAL_MAX_AGE_MS &&
    proposal.remixletId === remixletId &&
    arraysEqual(proposal.requested, requested) &&
    proposal.artifactDigest === (await digestArtifactFiles(files))
  );
}

async function readCapabilityProposals(): Promise<Record<string, StoredCapabilityProposal>> {
  const stored = await ext.storage.session.get(CAPABILITY_PROPOSALS_KEY);
  // SAFETY: createCapabilityProposal is the sole writer for this session-scoped proposals key.
  return (stored[CAPABILITY_PROPOSALS_KEY] as Record<string, StoredCapabilityProposal> | undefined) ?? {};
}

async function readCapabilityGrants(): Promise<CapabilityGrants> {
  return capabilityGrantStore.read();
}

async function writeCapabilityGrants(grants: CapabilityGrants): Promise<void> {
  await capabilityGrantStore.write(grants);
}

function normalizedCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set(capabilities ?? [])].sort();
}

function rollbackRationales(
  rationales: Record<string, string> | undefined,
  added: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    added.map((capability) => [
      capability,
      rationales?.[capability]?.trim() ||
        `This legacy version requested ${capability}; restoring it would add that authority again.`,
    ]),
  );
}

async function readNetRulesDigests(): Promise<NetRulesDigests> {
  const stored = await ext.storage.local.get(NET_RULES_DIGESTS_KEY);
  // SAFETY: writeNetRulesDigest is the sole writer for this local digest map.
  return (stored[NET_RULES_DIGESTS_KEY] as NetRulesDigests | undefined) ?? {};
}

async function writeNetRulesDigest(remixletId: string, digest: string | undefined): Promise<void> {
  const digests = await readNetRulesDigests();
  if (digest === undefined) delete digests[remixletId];
  else digests[remixletId] = digest;
  await ext.storage.local.set({ [NET_RULES_DIGESTS_KEY]: digests });
}

/** SHA-256 of a remixlet's rules file content, or "" when it declares none. */
async function netRulesDigest(manifest: RemixletManifest, files: Record<string, string>): Promise<string> {
  const source = manifest.netRules ? files[manifest.netRules] : undefined;
  if (source === undefined) return "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether an activation rewrites the network rules a remixlet already holds a
 * grant for (H5). Only meaningful when `netrules` is both requested and
 * already granted — a fresh `netrules` grant rides the ordinary added-capability
 * gate, and a remixlet without the grant has no rules to protect.
 */
async function netRulesContentChanged(
  manifest: RemixletManifest,
  files: Record<string, string>,
  previousGrants: readonly string[],
  requested: readonly string[],
): Promise<boolean> {
  if (!requested.includes("netrules") || !previousGrants.includes("netrules")) return false;
  const approved = (await readNetRulesDigests())[manifest.id];
  return approved !== undefined && approved !== (await netRulesDigest(manifest, files));
}

async function digestArtifactFiles(files: Record<string, string>): Promise<string> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (const path of Object.keys(files).sort()) {
    const pathBytes = encoder.encode(path);
    const contentBytes = encoder.encode(files[path]!);
    const header = encoder.encode(`${pathBytes.byteLength}:${contentBytes.byteLength}:`);
    chunks.push(header, pathBytes, contentBytes);
    byteLength += header.byteLength + pathBytes.byteLength + contentBytes.byteLength;
  }
  const canonical = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    canonical.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", canonical));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The outcome message for a gated activation — names capabilities and/or scope. */
function approvalRequiredMessage(
  added: readonly string[],
  scopeWidened: boolean,
  coversAllSites: boolean,
  netRulesChanged: boolean,
): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`capabilities: ${added.join(", ")}`);
  if (coversAllSites) parts.push("running on every site");
  else if (scopeWidened) parts.push("running on more sites");
  if (netRulesChanged) parts.push("changed network rules");
  return `Approval required for ${parts.join(" and ") || "this change"}`;
}

/**
 * Whether the incoming file set's .js entries differ from the stored previous
 * version's — an added, removed, or edited script file all count. Path-set
 * equality falls out of the length check plus per-path compare: a path present
 * on only one side reads as undefined on the other and mismatches.
 */
async function jsFilesChanged(id: string, incoming: Record<string, string>): Promise<boolean> {
  let previous: Record<string, string>;
  try {
    previous = (await store.read(id)).files;
  } catch {
    // An unreadable previous version cannot prove the scripts are unchanged.
    return true;
  }
  const jsPaths = (files: Record<string, string>) => Object.keys(files).filter(isSupportedScriptFile);
  const incomingJs = jsPaths(incoming);
  return incomingJs.length !== jsPaths(previous).length || incomingJs.some((path) => incoming[path] !== previous[path]);
}

/** Where a lifecycle change should become visible immediately. */
export interface ReloadScope {
  /** One specific tab (the popup's current tab). */
  reloadTabId?: number;
  /** Every open tab the remixlet's matches cover (the manager's "applied live"). */
  reloadMatching?: boolean;
}

export async function setRemixletEnabled(id: string, enabled: boolean, scope: ReloadScope = {}): Promise<RegistryEntry> {
  return enqueueActivationMutation(() => setRemixletEnabledUnlocked(id, enabled, scope));
}

async function setRemixletEnabledUnlocked(id: string, enabled: boolean, scope: ReloadScope): Promise<RegistryEntry> {
  const previous = (await store.list()).find((entry) => entry.id === id);
  if (!previous) throw new Error(`unknown remixlet: ${id}`);
  const live = await captureLiveState();
  try {
    const entry = await store.setEnabled(id, enabled);
    await syncMirrorUnlocked();
    if (!enabled) await clearOwnedNotifications(id);
    if (!enabled) await clearMenuCommandsForRemixlet(id);
    await applyReloadScope(entry, scope);
    return entry;
  } catch (error) {
    await store.restoreEntry(previous).catch(() => {});
    await restoreLiveState(live);
    throw error;
  }
}

export async function rollbackRemixletWithApproval(
  id: string,
  sha: string,
  scope: ReloadScope = {},
  capabilityApproval?: { proposalId: string },
): Promise<RollbackOutcome> {
  return enqueueActivationMutation(() => rollbackRemixletUnlocked(id, sha, scope, capabilityApproval));
}

async function rollbackRemixletUnlocked(
  id: string,
  sha: string,
  scope: ReloadScope,
  capabilityApproval?: { proposalId: string },
): Promise<RollbackOutcome> {
  const previous = (await store.list()).find((entry) => entry.id === id);
  if (!previous) throw new Error(`unknown remixlet: ${id}`);
  const files = await store.filesAt(id, sha);
  const targetManifest = parseStoredRemixletManifest(files[MANIFEST_FILE] ?? "");
  validateNetRulesFile(targetManifest, files);
  const grants = await readCapabilityGrants();
  const requested = normalizedCapabilities(targetManifest.capabilities);
  const unsupported = requested
    .map((capability) => ({ capability, reason: remixletCapabilityDisabledReason(capability) }))
    .find((entry) => entry.reason !== undefined);
  if (unsupported) {
    throw new Error(`rollback unavailable: capability "${unsupported.capability}" is disabled — ${unsupported.reason}`);
  }
  const previousGrants = grants[id] ?? [];
  const added = requested.filter((capability) => !previousGrants.includes(capability));
  // Same scope gate as forward activation: rolling BACK can just as easily
  // restore or introduce broad reach, so widening versus the live version — or
  // any all-sites target — must be approved, not just added capabilities.
  const scopeWidened = matchesWiden(previous.matches, targetManifest.matches);
  const coversAllSites = matchesCoverAllSites(targetManifest.matches);
  const broadScope = scopeWidened || coversAllSites;
  const netRulesChanged = await netRulesContentChanged(targetManifest, files, previousGrants, requested);
  if (
    (added.length > 0 || broadScope || netRulesChanged) &&
    (!capabilityApproval ||
      !(await consumeMatchingProposal(capabilityApproval.proposalId, id, requested, files)))
  ) {
    return {
      ok: false,
      reason: "needs-capability-approval",
      proposal: await createCapabilityProposal(
        id,
        targetManifest.name,
        requested,
        added,
        previousGrants.filter((capability) => !requested.includes(capability)),
        rollbackRationales(targetManifest.capabilityRationales, added),
        files,
        targetManifest.matches,
        broadScope,
        netRulesChanged,
      ),
    };
  }
  const live = await captureLiveState(grants);
  try {
    const entry = await store.rollback(id, sha);
    await writeCapabilityGrants({ ...grants, [id]: requested });
    await writeNetRulesDigest(id, requested.includes("netrules") ? await netRulesDigest(targetManifest, files) : undefined);
    await clearOwnedSchedules(id);
    await syncMirrorUnlocked();
    await clearMenuCommandsForRemixlet(id);
    if (!(targetManifest.capabilities ?? []).includes("notifications")) {
      await clearOwnedNotifications(id);
    }
    await applyReloadScope(entry, scope);
    return { ok: true, entry };
  } catch (error) {
    await store.rollback(id, previous.headSha).catch(() => store.restoreEntry(previous));
    await restoreLiveState(live);
    throw error;
  }
}

/**
 * The failed-exit cleanup (wiki/raw/handoffs/2026-08-19-failure-handling-…): a
 * turn COMPLETED with an activation whose final verification did not pass.
 * Record the outcome durably, then act on it — roll the active code back to
 * the last verified version when one exists, otherwise park the remixlet as
 * "needs-attention" so known-broken code stops injecting. Harness-driven: the
 * panel sends this after the model has already stopped, so no approval dialog
 * is possible — a rollback that would need capability approval parks instead.
 */
export type FailedVerifyExitAction = "rolled-back" | "needs-attention";

export async function recordFailedVerificationExit(
  id: string,
  record: FailedVerificationInput,
  scope: ReloadScope = {},
): Promise<{ entry: RegistryEntry; action: FailedVerifyExitAction }> {
  return enqueueActivationMutation(() => recordFailedVerificationExitUnlocked(id, record, scope));
}

async function recordFailedVerificationExitUnlocked(
  id: string,
  record: FailedVerificationInput,
  scope: ReloadScope,
): Promise<{ entry: RegistryEntry; action: FailedVerifyExitAction }> {
  // The record first: whatever the state change below does (or fails to do),
  // the failure context must survive for the next session on the site.
  const recorded = await store.recordFailedVerification(id, record);
  const target = recorded.lastVerifiedAgainst?.headSha;
  if (target !== undefined && target !== recorded.headSha) {
    const outcome = await rollbackRemixletUnlocked(id, target, scope);
    if (outcome.ok) return { entry: outcome.entry, action: "rolled-back" };
    // The verified version needs capability approval to restore (its grants
    // were narrowed since). Nobody is here to click Allow, so drop the
    // proposal and park instead — the user can roll back from the manager.
    await denyCapabilityProposalUnlocked(outcome.proposal.proposalId).catch(() => {});
  }
  const live = await captureLiveState();
  try {
    const entry = await store.parkNeedsAttention(id);
    await syncMirrorUnlocked();
    await clearOwnedNotifications(id);
    await clearMenuCommandsForRemixlet(id);
    await applyReloadScope(entry, scope);
    return { entry, action: "needs-attention" };
  } catch (error) {
    await store.restoreEntry(recorded).catch(() => {});
    await restoreLiveState(live);
    throw error;
  }
}

/** Soft delete: history stays; the mirror and matching tabs drop it now. */
export async function removeRemixlet(id: string, scope: ReloadScope = {}): Promise<RegistryEntry> {
  return enqueueActivationMutation(() => removeRemixletUnlocked(id, scope));
}

async function removeRemixletUnlocked(id: string, scope: ReloadScope): Promise<RegistryEntry> {
  const previous = (await store.list()).find((entry) => entry.id === id);
  if (!previous) throw new Error(`unknown remixlet: ${id}`);
  const live = await captureLiveState();
  try {
    const entry = await store.remove(id);
    await syncMirrorUnlocked();
    await clearOwnedNotifications(id);
    await clearMenuCommandsForRemixlet(id);
    await applyReloadScope(entry, scope);
    return entry;
  } catch (error) {
    await store.restoreEntry(previous).catch(() => {});
    await restoreLiveState(live);
    throw error;
  }
}

/** Restore from the archive to "disabled" — enabling is a separate, explicit step. */
export async function restoreRemixlet(id: string): Promise<RegistryEntry> {
  return enqueueActivationMutation(() => store.restore(id));
}

/**
 * Hard delete: artifact, git history, capability grants, and every owned
 * live resource. Irreversible by design, so unlike the other lifecycle
 * mutations there is no compensation path — the store deletes the tree
 * before the registry entry, so a partial failure leaves the remixlet
 * listed and this operation retryable.
 */
export async function destroyRemixlet(id: string, scope: ReloadScope = {}): Promise<void> {
  return enqueueActivationMutation(() => destroyRemixletUnlocked(id, scope));
}

async function destroyRemixletUnlocked(id: string, scope: ReloadScope): Promise<void> {
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown remixlet: ${id}`);
  await store.destroy(id);
  const grants = await readCapabilityGrants();
  if (grants[id]) {
    const next = { ...grants };
    delete next[id];
    await writeCapabilityGrants(next);
  }
  await writeNetRulesDigest(id, undefined);
  await clearOwnedSchedules(id);
  await clearOwnedNotifications(id);
  await clearMenuCommandsForRemixlet(id);
  await clearUsage(id);
  await syncMirrorUnlocked();
  await applyReloadScope(entry, scope);
}

/** Per-site pause participates in the same live transaction as lifecycle changes. */
export async function setSitePausedAtomic(siteKey: string, paused: boolean, scope: ReloadScope = {}): Promise<string[]> {
  return enqueueActivationMutation(() => setSitePausedAtomicUnlocked(siteKey, paused, scope));
}

async function setSitePausedAtomicUnlocked(siteKey: string, paused: boolean, scope: ReloadScope): Promise<string[]> {
  const previousPaused = await readPausedSites();
  const live = await captureLiveState();
  try {
    const next = await setSitePaused(siteKey, paused);
    // A pause owns whole remixlets, so the commands to drop are not only the
    // paused site's — an owned remixlet's commands on its other hosts go too.
    if (paused) await clearMenuCommandsForPausedSites(next);
    await syncMirrorUnlocked();
    // Reload after re-registration so a pause is a real kill switch: without
    // this, already-injected code keeps running in every open tab until it is
    // navigated. reloadMatching covers every tab the toggle changes; a resume
    // reloads the same tabs so the remixlet comes back live.
    if (scope.reloadTabId !== undefined) {
      await invalidateCaptureDigestForTab(scope.reloadTabId);
      await ext.tabs.reload(scope.reloadTabId).catch(() => {});
    }
    if (scope.reloadMatching) await reloadTabsForPauseChange(siteKey, scope.reloadTabId);
    return next;
  } catch (error) {
    await writePausedSites(previousPaused).catch(() => {});
    await restoreLiveState(live);
    throw error;
  }
}

/**
 * Reload every open tab whose run state a pause/resume of `siteKey` changes: a
 * tab within the toggled site (an <all_urls> remixlet's excludeMatches just
 * changed there) and any tab running a remixlet the key owns (pause owns the
 * whole remixlet, so a multi-host one changes on its OTHER hosts too). The
 * predicate is direction-agnostic — the same tabs need the reload whether the
 * toggle paused or resumed.
 */
async function reloadTabsForPauseChange(siteKey: string, exceptTabId?: number): Promise<void> {
  const owned = (await store.active()).filter((entry) => siteKeysPausing(entry.siteKey, [siteKey]).length > 0);
  for (const tab of await ext.tabs.query({})) {
    if (tab.id === undefined || tab.id === exceptTabId || !tab.url || !/^https?:/.test(tab.url)) continue;
    if (urlWithinSiteKey(tab.url, siteKey) || owned.some((entry) => urlMatchesAny(tab.url!, entry.matches))) {
      await invalidateCaptureDigestForUrl(tab.url);
      await ext.tabs.reload(tab.id).catch(() => {});
    }
  }
}

async function applyReloadScope(entry: RegistryEntry, scope: ReloadScope): Promise<void> {
  // Each reload changes what runs on its page: clear the page's capture
  // digest first so the next capture there is a full one (capture-freshness).
  if (scope.reloadTabId !== undefined) {
    await invalidateCaptureDigestForTab(scope.reloadTabId);
    await ext.tabs.reload(scope.reloadTabId);
  }
  if (scope.reloadMatching) {
    for (const tab of await ext.tabs.query({})) {
      if (tab.id === undefined || tab.id === scope.reloadTabId || !tab.url) continue;
      if (urlMatchesAny(tab.url, entry.matches)) {
        await invalidateCaptureDigestForUrl(tab.url);
        await ext.tabs.reload(tab.id).catch(() => {});
      }
    }
  }
}

/** Rebuild the injection mirror from the store and re-register. */
export async function syncMirror(): Promise<void> {
  return enqueueActivationMutation(syncMirrorUnlocked);
}

async function syncMirrorUnlocked(): Promise<void> {
  const previousMirror = await readMirror();
  const previousRules = await getDynamicRules();
  const grants = await readCapabilityGrants();
  const mirror: ActiveRemixlet[] = [];
  const activeContents: { manifest: ReturnType<typeof parseRemixletManifest>; files: Record<string, string> }[] = [];
  for (const entry of await store.active()) {
    const { manifest, files } = await store.read(entry.id);
    validateNetRulesFile(manifest, files);
    activeContents.push({ manifest, files });
    // The interceptor injects only for GRANTED observe capabilities — the
    // human approval, not the manifest text, is what turns it on.
    const granted = grants[entry.id] ?? [];
    const networkObserve = (manifest.capabilities ?? []).flatMap((capability) => {
      const pattern = observeHostPattern(capability);
      return pattern !== undefined && granted.includes(capability) ? [pattern] : [];
    });
    // Skew is decided HERE because the mirror build is the one place every
    // enabled remixlet's manifest is read before any of its code can run. A
    // skewed remixlet stays in the mirror but marked: registration and CSS
    // skip it, and a script-log entry (the health surface the agent already
    // reads) says why.
    const skew = bridgeSkewReason(manifest.builtWith);
    if (skew !== undefined) {
      await appendScriptLogOnce(entry.id, "error", `not injected: ${skew} — rebuild the remixlet to fix this`);
    }
    const active: ActiveRemixlet = {
      id: entry.id,
      bridgeToken: await bridgeTokenFor(entry.id),
      relayToken: await relayTokenFor(entry.id),
      matches: manifest.matches,
      js: (manifest.scripts ?? []).flatMap((script) => {
        // Worker-side assertion of the write-time invariant (isSupportedScriptFile
        // is enforced at the parse boundary too): never inject a script whose
        // extension the formatter could not syntax-check, even from a stored or
        // legacy artifact that predates that gate.
        const code = files[script.file];
        return code === undefined || !isSupportedScriptFile(script.file)
          ? []
          : [{ code, world: script.world, runAt: script.runAt }];
      }),
      css: (manifest.styles ?? []).flatMap((style) => (files[style] === undefined ? [] : [files[style]])),
      capabilities: manifest.capabilities ?? [],
      networkObserve,
    };
    if (skew !== undefined) active.skew = skew;
    mirror.push(active);
  }
  const grantedNetRules = new Set(
    Object.entries(grants)
      .filter(([, capabilities]) => capabilities.includes("netrules"))
      .map(([id]) => id),
  );
  try {
    await writeMirror(mirror);
    await reconcileUserScripts();
    await reconcileNetRules(activeContents, await readPausedSites(), grantedNetRules);
    await reconcileMenuCommands();
    await reconcileScheduleOwners(
      new Set(
        mirror
          .filter(
            (remixlet) =>
              remixlet.capabilities.includes("schedule") &&
              (grants[remixlet.id] ?? []).includes("schedule"),
          )
          .map((remixlet) => remixlet.id),
      ),
    );
    // Counts changed for any tab the mirror covers; recompute them all.
    await refreshAllBadges().catch(() => {});
  } catch (error) {
    await writeMirror(previousMirror).catch(() => {});
    await reconcileUserScripts().catch(() => {});
    await replaceDynamicRules(previousRules).catch(() => {});
    throw error;
  }
}

interface LiveState {
  mirror: ActiveRemixlet[];
  grants: CapabilityGrants;
  dynamicRules: chrome.declarativeNetRequest.Rule[];
  schedules: ScheduleState;
  scheduleSession: string[];
}

async function captureLiveState(grants?: CapabilityGrants): Promise<LiveState> {
  return {
    mirror: await readMirror(),
    grants: grants ?? (await readCapabilityGrants()),
    dynamicRules: await getDynamicRules(),
    schedules: await readScheduleState(),
    scheduleSession: await readScheduleSessionState(),
  };
}

async function restoreLiveState(state: LiveState): Promise<boolean> {
  let restored = true;
  await writeCapabilityGrants(state.grants).catch(() => {
    restored = false;
  });
  await writeMirror(state.mirror).catch(() => {
    restored = false;
  });
  await reconcileUserScripts().catch(() => {
    restored = false;
  });
  await replaceDynamicRules(state.dynamicRules).catch(() => {
    restored = false;
  });
  await restoreScheduleState(state.schedules).catch(() => {
    restored = false;
  });
  await restoreScheduleSessionState(state.scheduleSession).catch(() => {
    restored = false;
  });
  return restored;
}

async function restoreStoreAfterFailedActivation(id: string, previous?: RegistryEntry): Promise<boolean> {
  try {
    if (previous) await store.rollback(id, previous.headSha);
    // A failed FRESH install must vanish entirely: nothing was ever live to
    // inspect, and leaving it archived would reserve the id forever now that
    // archived remixlets are never editable.
    else await store.destroy(id);
    return true;
  } catch {
    return false;
  }
}

export { MANIFEST_FILE };
