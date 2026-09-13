// Atomic activation pipeline (wiki/handoff.md §5): commit to git → rebuild mirror →
// reconcile the content-script registrations → reload the affected tab ONCE. All-or-nothing:
// any failure rolls the mirror (and registrations) back to the previous state
// and reports. Restart-free activation is a core product promise — any
// "reload the browser" path is a bug.
//
// CSS never needs an explicit teardown step here BECAUSE it is injected from
// the mirror on every navigation (css.ts) — the one tab reload re-applies it.
// DNR refresh joins the pipeline at M4.

import { isSupportedScriptFile, MANIFEST_FILE, stampManifestBuiltWith } from "../shared/remixlet.js";
import { parseRemixletManifest, parseStoredRemixletManifest, validateManifestFileReferences } from "../shared/remixlet.js";
import type { RemixletManifest } from "../shared/remixlet.js";
import { detectCapabilities, remixletCapabilityDisabledReason } from "../platform/capabilities.js";
import { getDynamicRules, replaceDynamicRules } from "../platform/dnr.js";
import { ext } from "../platform/ext.js";
import { clearOwnedNotifications } from "../platform/notifications.js";
import {
  matchesCoverAllSites,
  matchesSpanningPublicSuffix,
  matchesWiden,
  matchesWithinSite,
  siteKeyForMatches,
  siteKeysPausing,
  urlMatchesAny,
  urlWithinSiteKey,
} from "../shared/site-key.js";
import {
  archivedIdCollisionMessage,
  RemixletStore,
  type FailedVerificationInput,
  type RegistryEntry,
} from "../store/remixlet-store.js";
import { refreshAllBadges } from "./badge.js";
import { settleTab, waitForBoxRun } from "./box.js";
import { runsOn } from "../shared/eligibility.js";
import { observeHostPattern } from "../shared/observe-capability.js";
import { clearRemixletStorage } from "./bridge.js";
import { testDeletionFault } from "./deletion-fault.js";
import {
  clearDeletingMark,
  judgeArtifact,
  markDeleting,
  quarantineAdvice,
  readDeletingMarks,
  readQuarantine,
  writeQuarantine,
  type QuarantineRecord,
} from "./eligibility.js";
import {
  bridgeTokenFor,
  clearTokens,
  readMirror,
  reconcileRegistrations,
  writeMirror,
  type ActiveRemixlet,
} from "./injection.js";
import { reconcileNetRules, releaseNetRuleAllocation, validateNetRulesFile } from "./netrules.js";
import { readPausedSites, setSitePaused, writePausedSites } from "./site-pause.js";
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

export type ActivationOutcome =
  | {
      ok: true;
      entry: RegistryEntry;
      jsChanged: boolean;
      /**
       * Set when the bound tab was not reloaded because it no longer shows the
       * authorized site (closed, off the web, or on another site): the
       * remixlet is stored and runs on its site from the next load, and the
       * page in that tab is not the one to verify against. Model-readable.
       */
      reloadSkipped?: string;
    }
  | { ok: false; reason: "failed"; message: string; rolledBack: boolean }
  | { ok: false; reason: "needs-capability-approval"; message: string; rolledBack: false; proposal: CapabilityApprovalProposal };

export type RollbackOutcome =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: "needs-capability-approval"; proposal: CapabilityApprovalProposal };

/**
 * The page a conversation is authorized to act on. The PANEL captures it from
 * its tab binding (tab-binding.ts) and sends it with every agent-originated
 * activation; the model never authors it (wiki/ops/2026-09-04-security-remediation-plan.md
 * item 7). The worker rejects a manifest whose `matches` leave that site
 * without approval. A request with no authorization (nothing binds it to a
 * page: a future import) gets no silent path at all — its scope always goes
 * through the dialog.
 *
 * If the bound tab has MOVED TO ANOTHER SITE by activation time, the write is
 * refused before anything is stored (maintainer decision, 2026-09-04,
 * reversing the same day's earlier decision to install anyway): the page the
 * user was looking at when they asked is gone, so the request the install
 * answers can no longer be checked against anything, and the same rule that
 * refuses reads on a moved tab should not quietly exempt writes. A tab that is
 * merely CLOSED is not that case — nothing moved out from under anyone — and
 * still installs with the reload skipped.
 */
/** Why the bound tab is no longer the authorized page. `off-site` refuses the write; `closed` only skips the reload. */
interface SiteAuthorizationDrift {
  kind: "closed" | "off-site";
  message: string;
}

export interface SiteAuthorization {
  /** siteKeyForUrl of the bound tab at bind time — the site term. */
  siteKey: string;
  tabId: number;
}

export interface CapabilityApprovalProposal {
  proposalId: string;
  remixletId: string;
  remixletName: string;
  requested: string[];
  added: string[];
  /**
   * Previously approved capabilities this activation drops (the stored
   * manifest is the approval record, and this activation replaces it with
   * exactly `requested`). Shown wherever the proposal is put to a human, so a
   * capability swap reads as a replacement, not extra access.
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
   * The scope is every site, or every site under a shared domain — the
   * strongest form of `broadScope`, split out so the dialog can ask the exact
   * question ("Run on every site?" versus "Run on more sites?").
   */
  coversAllSites: boolean;
  /**
   * A remixlet that already holds `netrules` is changing the CONTENT of its
   * rules file versus what was approved (H5). Capability names did not change,
   * so nothing else here would raise a dialog — this flag forces one, and the
   * panel shows a fixed line saying the network rules changed. Also blocks the
   * one-click auto-approval, so a rules rewrite is never bypassed.
   */
  netRulesChanged: boolean;
  /**
   * The manifest's `matches` reach outside the site the conversation is
   * authorized to act on (`authorizedSite`), or the request carried no site
   * authorization at all (`authorizedSite` undefined). Either way the scope
   * must be SHOWN: a fresh install aimed at a site the user is not on, a
   * mixed `[this site, another site]` install and a same-scope rewrite of an
   * off-site artifact all land here, and the panel's one-click auto-approval
   * never covers it.
   */
  offSite: boolean;
  authorizedSite: string | undefined;
}

interface StoredCapabilityProposal extends CapabilityApprovalProposal {
  createdAt: number;
  artifactDigest: string;
  /** The context that raised the proposal; approval must arrive from the same one. */
  authorization: SiteAuthorization | undefined;
}

const CAPABILITY_PROPOSALS_KEY = "remixletCapabilityProposals";
const PROPOSAL_MAX_AGE_MS = 10 * 60 * 1000;

const store = new RemixletStore();
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
  authorization?: SiteAuthorization,
): Promise<ActivationOutcome> {
  return enqueueActivationMutation(() =>
    activateRemixletUnlocked(files, reloadTabId, capabilityApproval, message, validSiteAuthorization(authorization)),
  );
}

async function activateRemixletUnlocked(
  submitted: Record<string, string>,
  reloadTabId: number | undefined,
  capabilityApproval: { proposalId: string } | undefined,
  message: string | undefined,
  authorization: SiteAuthorization | undefined,
): Promise<ActivationOutcome> {
  // The bridge stamp is applied HERE, at the store's only write path, so no
  // caller (the panel's write tool, a harness suite, a future import) can
  // store an artifact without it. The panel stamps too, before formatting;
  // re-stamping the same value is idempotent.
  const files: Record<string, string> =
    submitted[MANIFEST_FILE] === undefined
      ? submitted
      : { ...submitted, [MANIFEST_FILE]: stampManifestBuiltWith(submitted[MANIFEST_FILE], ext.runtime.getManifest().version) };
  // Before the manifest is even parsed, and long before anything is stored:
  // a bound tab that moved to another site refuses the write outright. Read
  // from the live tab, never from what the panel or the model reports.
  const drift = authorization ? await siteAuthorizationDrift(authorization) : undefined;
  if (drift?.kind === "off-site") {
    return { ok: false, reason: "failed", message: `not activated: ${drift.message}`, rolledBack: false };
  }
  let manifest;
  try {
    manifest = parseRemixletManifest(files[MANIFEST_FILE] ?? "");
    validateManifestFileReferences(manifest, files);
    validateNetRulesFile(manifest, files);
  } catch (error) {
    return { ok: false, reason: "failed", message: `not activated: ${String(error)}`, rolledBack: false };
  }
  // Id collisions with archived remixlets fail before the capability flow, so
  // the user is never asked to approve a doomed activation. The store's
  // activate() guard enforces the same rule; this is the courteous early exit.
  const previousEntry = (await store.list()).find((candidate) => candidate.id === manifest.id);
  if (previousEntry?.state === "archived") {
    return { ok: false, reason: "failed", message: `not activated: ${archivedIdCollisionMessage(manifest.id)}`, rolledBack: false };
  }
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
  // Scripts run only in the box; a browser that cannot host one (Firefox,
  // Safari: platform/capabilities.ts) gets the reason here rather than a
  // stored remixlet that never runs.
  const boxReason = (manifest.scripts ?? []).length > 0 ? detectCapabilities().disabledReasons.box : undefined;
  if (boxReason !== undefined) {
    return { ok: false, reason: "failed", message: `not activated: ${boxReason}`, rolledBack: false };
  }
  // The previous STORED version is the approval record: this write gate is the
  // only path into the store, so a stored manifest only ever names capabilities
  // the user approved. An unreadable previous version proves nothing — treat it
  // as no approvals, so everything re-prompts (fail closed).
  const previousVersion = previousEntry ? await store.read(manifest.id).catch(() => undefined) : undefined;
  const previousApproved = previousVersion ? normalizedCapabilities(previousVersion.manifest.capabilities) : [];
  const added = requested.filter((capability) => !previousApproved.includes(capability));
  // Scope is a gated power in its own right, not just capabilities (C1/Chain A).
  // Raise the approval surface when the code's reach GROWS versus the version
  // already live, and unconditionally whenever the manifest runs on every site
  // — a fresh <all_urls>/bare-* install has no previous version to widen from
  // but is exactly the silent-implant case.
  const scopeWidened = previousEntry !== undefined && matchesWiden(previousEntry.matches, manifest.matches);
  const coversAllSites = matchesCoverAllSites(manifest.matches);
  // A wildcard over a public suffix (`*.appspot.com`) is refused at the write
  // gate for new manifests, but a stored artifact that predates the full list
  // (item 8) still parses; when one comes back through here, the scope is put
  // to the user as broad, never folded into the one-click auto-approval.
  const spansSuffix = matchesSpanningPublicSuffix(manifest.matches).length > 0;
  const broadScope = scopeWidened || coversAllSites || spansSuffix;
  // A rewrite of already-approved network rules must re-prompt too (H5): the
  // capability name is unchanged, so nothing above would raise a dialog.
  const netRulesChanged = netRulesContentChanged(manifest, files, previousVersion, previousApproved, requested);
  // The site term: every match pattern must fit inside the site the
  // conversation is bound to. This is what the three checks above cannot see
  // — a first install aimed at a site the user is not on has nothing to widen
  // from and names no capability, and a same-scope rewrite of an installed
  // off-site artifact changes nothing they compare. The stored version's
  // matches are NOT consent for this conversation to write it: the site term
  // is measured against the initiating context, every time. No binding at
  // all means no silent path.
  const offSite = authorization === undefined || !matchesWithinSite(manifest.matches, authorization.siteKey);
  if (added.length > 0 || broadScope || netRulesChanged || offSite) {
    if (
      !capabilityApproval ||
      !(await consumeMatchingProposal(capabilityApproval.proposalId, manifest.id, requested, files, authorization))
    ) {
      const proposal = await createCapabilityProposal(
        manifest.id,
        manifest.name,
        requested,
        added,
        previousApproved.filter((capability) => !requested.includes(capability)),
        manifest.capabilityRationales ?? {},
        files,
        manifest.matches,
        broadScope,
        coversAllSites || spansSuffix,
        netRulesChanged,
        offSite,
        authorization,
      );
      return {
        ok: false,
        reason: "needs-capability-approval",
        message: approvalRequiredMessage(added, scopeWidened, coversAllSites, spansSuffix, netRulesChanged, offSite),
        rolledBack: false,
        proposal,
      };
    }
  }

  const previousLive = await captureLiveState();
  // Incoming files were Prettier-formatted panel-side exactly as the previous
  // version was at its own write time, so the byte-compare is apples-to-apples.
  // A CSS-only diff owes the agent no click-cycle re-verification (contracts.ts
  // gates on this). A fresh install (or an unreadable previous version, which
  // cannot prove the scripts are unchanged) counts as changed.
  const jsChanged = previousVersion === undefined || jsFilesChanged(previousVersion.files, files);
  let entry: RegistryEntry;
  try {
    // 1. Snapshot first: even a failed activation leaves inspectable history
    // (its tag stays, so it remains a numbered, rollback-able version).
    // This write is also the consent record: the gate above ensured every
    // capability (and rules file) in `files` was just approved or already held.
    entry = await store.activate(files, message);
  } catch (error) {
    return { ok: false, reason: "failed", message: `not activated: ${String(error)}`, rolledBack: false };
  }

  try {
    if (previousEntry) await clearOwnedSchedules(manifest.id);
    // Stale script-log entries describe the replaced version, not this one.
    // Cleared BEFORE the mirror rebuild so notes the rebuild itself records
    // about the new version (bridge skew) survive the activation.
    await clearScriptLog(manifest.id);
    await syncMirrorUnlocked();
    if (previousEntry) await clearMenuCommandsForRemixlet(manifest.id);
    if (previousApproved.includes("notifications") && !requested.includes("notifications")) {
      await clearOwnedNotifications(manifest.id);
    }
    // A tab that moved to another site never reached here (refused above).
    // What remains is the closed tab, and one narrow race: a tab that moved
    // between that check and this line. Neither withholds the install at this
    // point — the artifact is already stored and runs only on its own site —
    // but reloading a tab that now shows some other page would be a side
    // effect on a page nobody pointed the agent at, so the reload is skipped
    // and the outcome says so.
    const reloadSkipped = (authorization ? await siteAuthorizationDrift(authorization) : undefined)?.message;
    if (reloadTabId !== undefined && reloadSkipped === undefined) {
      // The reload applies the new version, so any capture digest for the
      // page is stale. Cleared BEFORE the reload (and before this returns),
      // so the contract's post-write capture can never be answered with an
      // unchanged-page short-circuit — even if the new page digests
      // identically (e.g. a CSS-only change the digest text cannot see).
      await invalidateCaptureDigestForTab(reloadTabId);
      const reloadedAt = Date.now();
      await ext.tabs.reload(reloadTabId);
      await awaitBoxRunAfterReload(manifest.id, reloadTabId, reloadedAt);
    }
    return reloadSkipped === undefined ? { ok: true, entry, jsChanged } : { ok: true, entry, jsChanged, reloadSkipped };
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

/**
 * Drop every pending proposal raised from `tabId` once that tab navigates to
 * a page outside the site it was authorized for (remediation plan item 7,
 * approval binding). The proposal asked for consent on behalf of a page the
 * user was looking at; when the tab leaves the site that page is gone, so
 * the consent has nothing left to attach to. A navigation within the site
 * (a reload, an in-site link, a subdomain) keeps the proposals: the
 * activation reload itself is one of those. The site test is the one the
 * activation drift check applies: a non-web page or a host outside the site
 * key is a move. Runs on the activation lane so it cannot interleave with a
 * proposal being raised or consumed.
 */
export async function invalidateCapabilityProposalsForNavigation(tabId: number, url: string): Promise<void> {
  return enqueueActivationMutation(async () => {
    const proposals = await readCapabilityProposals();
    let changed = false;
    for (const [proposalId, proposal] of Object.entries(proposals)) {
      const authorization = proposal.authorization;
      if (authorization === undefined || authorization.tabId !== tabId) continue;
      if (/^https?:/.test(url) && urlWithinSiteKey(url, authorization.siteKey)) continue;
      delete proposals[proposalId];
      changed = true;
    }
    if (changed) await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
  });
}

async function denyCapabilityProposalUnlocked(proposalId: string): Promise<void> {
  const proposals = await readCapabilityProposals();
  delete proposals[proposalId];
  await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
}

/**
 * Approved-capability check used by every privileged bridge service. The
 * stored manifest IS the consent record: activation is the only write path
 * into the store, and it refuses any file set whose capabilities (or rules
 * content) the user has not approved — so a capability a stored manifest
 * names is one the user granted. Read from the committed snapshot at the
 * registry head (store.read), never the worktree. An unreadable remixlet
 * holds nothing.
 */
export async function hasCapabilityGrant(remixletId: string, capability: string): Promise<boolean> {
  try {
    const { manifest } = await store.read(remixletId);
    return (manifest.capabilities ?? []).includes(capability);
  } catch {
    return false;
  }
}

/**
 * The capabilities a remixlet holds — the manager's capability panel. Read
 * from the stored manifest, which is the approval record (see
 * hasCapabilityGrant), so declared and approved are the same set by
 * construction.
 */
export async function readRemixletCapabilities(id: string): Promise<string[]> {
  const { manifest } = await store.read(id);
  return normalizedCapabilities(manifest.capabilities);
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
  coversAllSites: boolean,
  netRulesChanged: boolean,
  offSite: boolean,
  authorization: SiteAuthorization | undefined,
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
    coversAllSites,
    netRulesChanged,
    offSite,
    authorizedSite: authorization?.siteKey,
    createdAt: Date.now(),
    artifactDigest: await digestArtifactFiles(files),
    authorization,
  };
  const proposals = await readCapabilityProposals();
  // One live proposal per remixlet. A newer agent attempt supersedes the old
  // one, so an old confirmation cannot authorize a later file set.
  for (const [id, existing] of Object.entries(proposals)) {
    if (existing.remixletId === remixletId) delete proposals[id];
  }
  proposals[proposal.proposalId] = proposal;
  await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
  const { createdAt: _, artifactDigest: __, authorization: ___, ...publicProposal } = proposal;
  return publicProposal;
}

/**
 * A proposal is consumed only by the context that raised it: same remixlet,
 * same capabilities, byte-identical artifact, and the same site authorization
 * (or none on both sides). An approval that arrives from another tab or
 * another site does not match, so the caller raises a fresh proposal instead
 * of spending stale consent.
 */
async function consumeMatchingProposal(
  proposalId: string,
  remixletId: string,
  requested: string[],
  files: Record<string, string>,
  authorization: SiteAuthorization | undefined,
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
    sameAuthorization(proposal.authorization, authorization) &&
    proposal.artifactDigest === (await digestArtifactFiles(files))
  );
}

function sameAuthorization(a: SiteAuthorization | undefined, b: SiteAuthorization | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.siteKey === b.siteKey && a.tabId === b.tabId;
}

/**
 * The authorization as sent, or undefined when it binds to no site: the
 * panel records an empty site key for a tab whose URL had not committed at
 * bind time, and that must read as "no binding" (every scope goes through
 * the dialog), never as a binding to nothing.
 */
function validSiteAuthorization(authorization: SiteAuthorization | undefined): SiteAuthorization | undefined {
  if (authorization === undefined || authorization.siteKey.trim() === "") return undefined;
  return { siteKey: authorization.siteKey, tabId: authorization.tabId };
}

/**
 * Why the bound tab is no longer a page on the authorized site, or undefined
 * while it still is. Read from the live tab, not from anything the panel or
 * model reports. The wording is for the model: it explains why the tab was
 * not reloaded and that this tab is not the page to verify against.
 */
async function siteAuthorizationDrift(authorization: SiteAuthorization): Promise<SiteAuthorizationDrift | undefined> {
  const tab = await ext.tabs.get(authorization.tabId).catch(() => undefined);
  if (tab?.id === undefined) {
    return { kind: "closed", message: "the tab this conversation works on is closed, so no tab was reloaded" };
  }
  const url = tab.url ?? "";
  if (!/^https?:/.test(url)) {
    return {
      kind: "off-site",
      message:
        `the tab this conversation works on no longer shows a web page on ${authorization.siteKey}. ` +
        "Nothing was written. Tell the user the page moved; the panel offers them a button to reopen it.",
    };
  }
  if (!urlWithinSiteKey(url, authorization.siteKey)) {
    let current = "a different site";
    try {
      current = new URL(url).hostname || current;
    } catch {
      // Unparseable URL — the generic wording stands.
    }
    return {
      kind: "off-site",
      message:
        `the tab this conversation works on is now showing ${current}, not ${authorization.siteKey}. ` +
        `Nothing was written. Tell the user the page moved; the panel offers them a button to reopen ${authorization.siteKey}.`,
    };
  }
  return undefined;
}

async function readCapabilityProposals(): Promise<Record<string, StoredCapabilityProposal>> {
  const stored = await ext.storage.session.get(CAPABILITY_PROPOSALS_KEY);
  // SAFETY: createCapabilityProposal is the sole writer for this session-scoped proposals key.
  return (stored[CAPABILITY_PROPOSALS_KEY] as Record<string, StoredCapabilityProposal> | undefined) ?? {};
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

/**
 * Whether an activation rewrites the network rules a remixlet already holds
 * approval for (H5). The approved content is the previous stored version's own
 * rules file — the store is the approval record, for rules content as for
 * capability names. Only meaningful when `netrules` is both requested and
 * already approved: a fresh `netrules` ask rides the ordinary added-capability
 * gate, and a remixlet without the approval has no rules to protect.
 */
function netRulesContentChanged(
  manifest: RemixletManifest,
  files: Record<string, string>,
  previousVersion: { manifest: RemixletManifest; files: Record<string, string> } | undefined,
  previousApproved: readonly string[],
  requested: readonly string[],
): boolean {
  if (!requested.includes("netrules") || !previousApproved.includes("netrules") || previousVersion === undefined) {
    return false;
  }
  const approved = previousVersion.manifest.netRules ? previousVersion.files[previousVersion.manifest.netRules] : undefined;
  const incoming = manifest.netRules ? files[manifest.netRules] : undefined;
  return approved !== incoming;
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
  spansSuffix: boolean,
  netRulesChanged: boolean,
  offSite: boolean,
): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`capabilities: ${added.join(", ")}`);
  if (coversAllSites) parts.push("running on every site");
  else if (spansSuffix) parts.push("running on every site under a shared domain");
  else if (scopeWidened) parts.push("running on more sites");
  else if (offSite) parts.push("running outside the site this chat works on");
  if (netRulesChanged) parts.push("changed network rules");
  return `Approval required for ${parts.join(" and ") || "this change"}`;
}

/**
 * Whether the incoming file set's .js entries differ from the stored previous
 * version's — an added, removed, or edited script file all count. Path-set
 * equality falls out of the length check plus per-path compare: a path present
 * on only one side reads as undefined on the other and mismatches.
 */
function jsFilesChanged(previous: Record<string, string>, incoming: Record<string, string>): boolean {
  const jsPaths = (files: Record<string, string>) => Object.keys(files).filter(isSupportedScriptFile);
  const incomingJs = jsPaths(incoming);
  return incomingJs.length !== jsPaths(previous).length || incomingJs.some((path) => incoming[path] !== previous[path]);
}

/**
 * Where a lifecycle change should become visible immediately. Box refresh
 * revokes listeners, observers and handles in every live document whether or
 * not this scope asks for a reload. A caller may still reload its own tab or
 * every matching tab to remove page marks and elements left by the old run
 * (wiki/decisions/leftover-marks.md).
 */
export interface ReloadScope {
  /** One specific tab (the popup's current tab), reloaded even when the matches do not cover it. */
  reloadTabId?: number;
  /** Reload every other open tab covered by the changed remixlet. */
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
  const requested = normalizedCapabilities(targetManifest.capabilities);
  const unsupported = requested
    .map((capability) => ({ capability, reason: remixletCapabilityDisabledReason(capability) }))
    .find((entry) => entry.reason !== undefined);
  if (unsupported) {
    throw new Error(`rollback unavailable: capability "${unsupported.capability}" is disabled — ${unsupported.reason}`);
  }
  // The LIVE stored version is the approval record; the rollback target's own
  // manifest proves nothing about current consent (its approval may have been
  // superseded by versions since). Fail closed when the live version is
  // unreadable, same as forward activation.
  const liveVersion = await store.read(id).catch(() => undefined);
  const previousApproved = liveVersion ? normalizedCapabilities(liveVersion.manifest.capabilities) : [];
  const added = requested.filter((capability) => !previousApproved.includes(capability));
  // Same scope gate as forward activation: rolling BACK can just as easily
  // restore or introduce broad reach, so widening versus the live version — or
  // any all-sites target — must be approved, not just added capabilities.
  const scopeWidened = matchesWiden(previous.matches, targetManifest.matches);
  const coversAllSites = matchesCoverAllSites(targetManifest.matches);
  const spansSuffix = matchesSpanningPublicSuffix(targetManifest.matches).length > 0;
  const broadScope = scopeWidened || coversAllSites || spansSuffix;
  const netRulesChanged = netRulesContentChanged(targetManifest, files, liveVersion, previousApproved, requested);
  // No site term here: a rollback is a manager action on an artifact the user
  // selected, with no page binding to measure against, and the target's
  // matches were the live scope of a version they already ran.
  if (
    (added.length > 0 || broadScope || netRulesChanged) &&
    (!capabilityApproval ||
      !(await consumeMatchingProposal(capabilityApproval.proposalId, id, requested, files, undefined)))
  ) {
    return {
      ok: false,
      reason: "needs-capability-approval",
      proposal: await createCapabilityProposal(
        id,
        targetManifest.name,
        requested,
        added,
        previousApproved.filter((capability) => !requested.includes(capability)),
        rollbackRationales(targetManifest.capabilityRationales, added),
        files,
        targetManifest.matches,
        broadScope,
        coversAllSites || spansSuffix,
        netRulesChanged,
        false,
        undefined,
      ),
    };
  }
  const live = await captureLiveState();
  try {
    // The rollback rewrites the stored HEAD, and with it the approval record.
    const entry = await store.rollback(id, sha);
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
    // The verified version needs capability approval to restore (the versions
    // since narrowed what is approved). Nobody is here to click Allow, so drop
    // the proposal and park instead — the user can roll back from the manager.
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
 * Hard delete: artifact, git history, and every owned resource — the
 * artifact's manifest is the capability approval record, so deleting it
 * revokes everything at once. Irreversible by design, so unlike the other
 * lifecycle mutations there is no compensation path; instead the operation is
 * a fixed sequence of idempotent steps behind a durable "deleting" mark
 * (wiki/ops/2026-09-04-security-remediation-plan.md item 9):
 *
 *   1. write the mark — from here the artifact is ineligible, and a worker
 *      death anywhere below is finished by resumePendingDeletions at boot;
 *   2. rebuild the mirror without it — scripts unregister, its DNR rules go,
 *      menu commands and schedules reconcile away, no bridge token is in reach;
 *   3. release its DNR allocation (after its rules: the reconciler finds
 *      owned rules through the allocation map, so the reverse order orphans
 *      them);
*   4. forget everything else it owned: rmx.storage record, both tokens,
 *      script log, pending proposals, usage, notifications, schedules, menu
 *      commands;
 *   5. erase the artifact (tree, history, look crop, registry entry);
 *   6. clear the mark.
 *
 * A same-id install afterwards starts with fresh tokens and empty storage; a
 * page still holding the old bridge token cannot authenticate.
 */
export async function destroyRemixlet(id: string, scope: ReloadScope = {}): Promise<void> {
  return enqueueActivationMutation(() => destroyRemixletUnlocked(id, scope));
}

async function destroyRemixletUnlocked(id: string, scope: ReloadScope): Promise<void> {
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry && !(await readDeletingMarks()).has(id)) throw new Error(`unknown remixlet: ${id}`);
  await markDeleting(id);
  await deletionFaultAfter("mark");
  await finishDeletionUnlocked(id);
  if (entry) await applyReloadScope(entry, scope);
}

/**
 * Boot: finish any delete-forever a worker death interrupted. The mark is
 * the only trigger — nothing here infers "orphan" from a failed registry
 * read, and a disabled or archived artifact is never swept.
 */
export async function resumePendingDeletions(): Promise<void> {
  for (const id of await readDeletingMarks()) {
    await enqueueActivationMutation(() => finishDeletionUnlocked(id)).catch((error) =>
      console.error(`[remixlet] resuming deletion of ${id} failed`, error),
    );
  }
}

/** Steps 2 to 6 above; every step tolerates having already run. */
async function finishDeletionUnlocked(id: string): Promise<void> {
  await syncMirrorUnlocked();
  await deletionFaultAfter("sync");
  await releaseNetRuleAllocation(id);
  await deletionFaultAfter("netrules");
  await forgetRemixletResources(id);
  await deletionFaultAfter("resources");
  if ((await store.list()).some((candidate) => candidate.id === id)) await store.destroy(id);
  await deletionFaultAfter("store");
  await clearDeletingMark(id);
}

/**
 * Everything a remixlet owns outside the store and the mirror. Shared by
 * delete-forever and the failed-fresh-install cleanup, which otherwise left
 * the tokens and allocation the mirror build had already minted.
 */
async function forgetRemixletResources(id: string): Promise<void> {
  await clearRemixletStorage(id);
  await clearTokens(id);
  await clearScriptLog(id);
  await clearCapabilityProposalsFor(id);
  await clearUsage(id);
  await clearOwnedNotifications(id);
  await clearOwnedSchedules(id);
  await clearMenuCommandsForRemixlet(id);
}

async function clearCapabilityProposalsFor(remixletId: string): Promise<void> {
  const proposals = await readCapabilityProposals();
  let changed = false;
  for (const [proposalId, proposal] of Object.entries(proposals)) {
    if (proposal.remixletId !== remixletId) continue;
    delete proposals[proposalId];
    changed = true;
  }
  if (changed) await ext.storage.session.set({ [CAPABILITY_PROPOSALS_KEY]: proposals });
}

/** Development builds only (deletion-fault.ts): the lifecycle harness's crash point. */
async function deletionFaultAfter(step: string): Promise<void> {
  if ((await testDeletionFault()) === step) throw new Error(`deletion interrupted after ${step} (test fault)`);
}

/** Per-site pause participates in the same live transaction as lifecycle changes. */
export async function setSitePausedAtomic(siteKey: string, paused: boolean, scope: ReloadScope = {}): Promise<string[]> {
  return enqueueActivationMutation(() => setSitePausedAtomicUnlocked(siteKey, paused, scope));
}

/**
 * Hold the activation reply until the remixlet's code has actually started in
 * the reloaded tab (worker/box.ts waitForBoxRun), so "the tab reloaded with
 * it live" is true when the model reads it and its first verification never
 * judges a page the remixlet has not reached yet. Only when there is code to
 * run on that page: a styles-only remixlet, or a page its matches exclude,
 * has no run to wait for. Bounded, so a page that never gets its agent (a
 * navigation mid-reload, a locked-down page) delays the reply, never holds it.
 */
const BOX_RUN_WAIT_MS = 8000;

async function awaitBoxRunAfterReload(remixletId: string, tabId: number, since: number): Promise<void> {
  const remixlet = (await readMirror()).find((entry) => entry.id === remixletId);
  if (!remixlet || remixlet.js.length === 0) return;
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || !runsOn(remixlet, tab.url, await readPausedSites())) return;
  await waitForBoxRun(remixletId, tabId, since, BOX_RUN_WAIT_MS);
  // Then its files' top-level code and first keep pass: the reply says the
  // remixlet is live, so the page must already show what it does at load.
  await settleTab(tabId);
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
    // Refresh revokes live box authority without a reload. UI callers may
    // still request reloads so old page marks disappear and a resumed box can
    // start in a fresh document.
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

/**
 * The caller's tab, then every open tab the entry's matches cover: the
 * remixlet stopped running there (or an older version now runs), so the page
 * must show that, with nothing of the old run left on it.
 */
async function applyReloadScope(entry: RegistryEntry, scope: ReloadScope): Promise<void> {
  // Each reload changes what runs on its page: clear the page's capture
  // digest first so the next capture there is a full one (capture-freshness).
  if (scope.reloadTabId !== undefined) {
    await invalidateCaptureDigestForTab(scope.reloadTabId);
    await ext.tabs.reload(scope.reloadTabId);
  }
  if (!scope.reloadMatching) return;
  for (const tab of await ext.tabs.query({})) {
    if (tab.id === undefined || tab.id === scope.reloadTabId || !tab.url || !/^https?:/.test(tab.url)) continue;
    if (urlMatchesAny(tab.url, entry.matches)) {
      await invalidateCaptureDigestForUrl(tab.url);
      await ext.tabs.reload(tab.id).catch(() => {});
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
  // Read the schedule-owner snapshot at the same point as the authorization
  // facts (the store contents the mirror is built from):
  // reconcileScheduleOwners judges only the owners in it, so a registration
  // that lands while this sync runs is never judged by facts that predate it
  // (wiki/design/menu-reconcile-race.md).
  const scheduleOwnerSnapshot = new Set(Object.keys((await readScheduleState()).owners));
  const mirror: ActiveRemixlet[] = [];
  const activeContents: { manifest: ReturnType<typeof parseRemixletManifest>; files: Record<string, string> }[] = [];
  // Eligibility is decided HERE, once per artifact, because the mirror build
  // is the one place every artifact is read before any of its code can run;
  // mirror membership is the verdict every runtime consumer reads
  // (worker/eligibility.ts). Each artifact is judged on its own: a
  // quarantined one (unreadable, invalid rules, bridge skew) gets no entry
  // and a script-log line saying why, and the healthy rest are admitted —
  // one bad artifact never aborts the rebuild for the others.
  const deleting = await readDeletingMarks();
  const previousQuarantine = await readQuarantine();
  const quarantine: Record<string, QuarantineRecord> = {};
  for (const listed of await store.list()) {
    const verdict = await judgeArtifact(store, listed, deleting);
    if (!verdict.eligible) {
      if (verdict.quarantine) {
        const previous = previousQuarantine[listed.id];
        quarantine[listed.id] = {
          reason: verdict.reason,
          headSha: listed.headSha,
          at: previous?.headSha === listed.headSha ? previous.at : Date.now(),
        };
        await appendScriptLogOnce(listed.id, "error", quarantineAdvice(verdict.reason));
      }
      continue;
    }
    const { entry, manifest, files } = verdict.content;
    activeContents.push({ manifest, files });
    // A stored manifest only names APPROVED capabilities (the activation gate
    // is the store's only write path), so declaring an observe capability is
    // proof of the human approval that turns the interceptor on.
    const networkObserve = (manifest.capabilities ?? []).flatMap((capability) => {
      const pattern = observeHostPattern(capability);
      return pattern !== undefined ? [pattern] : [];
    });
    const active: ActiveRemixlet = {
      id: entry.id,
      bridgeToken: await bridgeTokenFor(entry.id),
      matches: manifest.matches,
      js: (manifest.scripts ?? []).flatMap((script) => {
        // Worker-side assertion of the write-time invariant (isSupportedScriptFile
        // is enforced at the parse boundary too): never inject a script whose
        // extension the formatter could not syntax-check, even from a stored or
        // legacy artifact that predates that gate.
        const code = files[script.file];
        return code === undefined || !isSupportedScriptFile(script.file)
          ? []
          : [{ code, file: script.file, runAt: script.runAt }];
      }),
      css: (manifest.styles ?? []).flatMap((style) => (files[style] === undefined ? [] : [files[style]])),
      capabilities: manifest.capabilities ?? [],
      networkObserve,
    };
    mirror.push(active);
  }
  const grantedNetRules = new Set(
    activeContents
      .filter(({ manifest }) => (manifest.capabilities ?? []).includes("netrules"))
      .map(({ manifest }) => manifest.id),
  );
  try {
    await writeMirror(mirror);
    await writeQuarantine(quarantine);
    await reconcileRegistrations();
    await reconcileNetRules(activeContents, await readPausedSites(), grantedNetRules);
    await reconcileMenuCommands();
    await reconcileScheduleOwners(
      new Set(mirror.filter((remixlet) => remixlet.capabilities.includes("schedule")).map((remixlet) => remixlet.id)),
      scheduleOwnerSnapshot,
    );
    // Counts changed for any tab the mirror covers; recompute them all.
    await refreshAllBadges().catch(() => {});
  } catch (error) {
    await writeMirror(previousMirror).catch(() => {});
    await reconcileRegistrations().catch(() => {});
    await replaceDynamicRules(previousRules).catch(() => {});
    throw error;
  }
}

interface LiveState {
  mirror: ActiveRemixlet[];
  dynamicRules: chrome.declarativeNetRequest.Rule[];
  schedules: ScheduleState;
  scheduleSession: string[];
}

async function captureLiveState(): Promise<LiveState> {
  return {
    mirror: await readMirror(),
    dynamicRules: await getDynamicRules(),
    schedules: await readScheduleState(),
    scheduleSession: await readScheduleSessionState(),
  };
}

async function restoreLiveState(state: LiveState): Promise<boolean> {
  let restored = true;
  await writeMirror(state.mirror).catch(() => {
    restored = false;
  });
  await reconcileRegistrations().catch(() => {
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
    else {
      // A failed FRESH install must vanish entirely: nothing was ever live to
      // inspect, and leaving it archived would reserve the id forever now that
      // archived remixlets are never editable. The mirror build that failed
      // may already have minted its tokens and DNR allocation — forget those
      // too, or the next install under the id would inherit them.
      await store.destroy(id);
      await releaseNetRuleAllocation(id);
      await forgetRemixletResources(id);
    }
    return true;
  } catch {
    return false;
  }
}

export { MANIFEST_FILE };
