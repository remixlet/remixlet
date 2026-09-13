// Service worker: thin, event-driven, no in-memory state that isn't
// reconstructible from storage (MV3 kills it at will). The agent lives in the
// panel; this side owns injection, the capability bridge, captures, lifecycle.

import { detectCapabilities } from "../platform/capabilities.js";
import { ext } from "../platform/ext.js";
import { panelSurface } from "../platform/panel-surface.js";
import { installAskNotificationClicks } from "../platform/notifications.js";
import { capturePage } from "../platform/observation/index.js";
import type { CaptureRequest } from "../platform/observation/types.js";
import { ANNOTATE_OPEN_MESSAGE } from "../shared/annotation.js";
import type { PanelToWorker, StampedWorkerToPanel, WorkerToPanel } from "../shared/protocol.js";
import type { JsonValue } from "../box/protocol.js";
import type { BoundPage } from "../shared/page-binding.js";
import {
  SHOW_CHANGES_OPEN_MESSAGE,
  sanitizeVerifiedAssertions,
  type ShowChangesSummary,
} from "../shared/show-changes.js";
import { remixletOnSite, urlMatchesAny } from "../shared/site-key.js";
import { captureContentDigest } from "../shared/capture-digest.js";
import { formatCaptureForModel } from "../shared/capture-format.js";
import { CaptureStore, captureSiteKey, latestDigestMatches, type CaptureRef } from "../store/capture-store.js";
import {
  invalidateCaptureDigestForTab,
  invalidateCaptureDigestForUrl,
} from "./capture-freshness.js";
import { ConversationIndex } from "../store/conversation-index.js";
import {
  activateRemixlet,
  type ActivationOutcome,
  denyCapabilityProposal,
  destroyRemixlet,
  invalidateCapabilityProposalsForNavigation,
  readRemixletCapabilities,
  recordFailedVerificationExit,
  remixletStore,
  removeRemixlet,
  restoreRemixlet,
  resumePendingDeletions,
  rollbackRemixletWithApproval,
  setSitePausedAtomic,
  setRemixletEnabled,
  type SiteAuthorization,
  syncMirror,
} from "./activation.js";
import { installBadge } from "./badge.js";
import {
  clickRightsFor,
  handleBoxWorkerMessage,
  installNavigationHints,
  isBoxWorkerMessage,
  settleTab,
  type BoxWorkerMessage,
  type BoxWorkerReply,
} from "./box.js";
import { readQuarantine } from "./eligibility.js";
import { listSiteIcons, recordSiteIcon, refreshSiteIcon } from "./site-icons.js";
import { installDevReload } from "./dev-reload.js";
import { readScriptLog } from "./script-log.js";
import { readUsage } from "./usage.js";
import { readPausedSites } from "./site-pause.js";
import {
  beginCodexSignIn,
  codexAuthStatus,
  getCodexAccessToken,
  handleCodexCallback,
  installCodexAuth,
  invalidateCodexAccessToken,
  signOutCodex,
} from "./codex-auth.js";
import { installCssInjection } from "./css.js";
import {
  devObserveGrantForRead,
  recordDevObserveGrant,
  removeDevObserveGrant,
} from "./dev-observe.js";
import { reconcileRegistrations } from "./injection.js";
import { navigateTab } from "./page-probe.js";
import { assertBoundPage, assertNavigationWithinSite, onBoundPage } from "./page-binding.js";
import { DEV_OBSERVE_REPLY_EVENT, DEV_OBSERVE_REQUEST_EVENT } from "../shared/dev-observe.js";
import { Check } from "typebox/value";
import { BUILD_ID } from "../shared/build-id.js";
import {
  PROBE_SCHEMAS,
  describeProbeParamsError,
  isProbeName,
  probeBuildSkewMessage,
  type ListNetworkResourcesParamsType,
  type ProbeName,
  type ReplayNetworkResourceParamsType,
} from "../shared/probe-schemas.js";
import { captureLookReview } from "./look-review.js";
import { ScreenshotIdentityChangedError } from "../platform/observation/snapshot.js";
import { sanitizeLookReview } from "../shared/look-review.js";
import { runProbe, type ProbePayload } from "./page-probes/engine.js";
import { readNetworkCensus, runListNetworkResources, runReplayNetworkResource } from "./network-ids.js";
import type { CaptureBundle } from "../shared/capture.js";
import { runInspectDesignProbe } from "./page-probes/stylesheets.js";
import {
  clearMenuCommandsForTab,
  enqueueMenuInvocation,
  listMenuCommands,
  reconcileMenuCommands,
} from "./menu.js";
import { installSchedule } from "./schedule.js";

type ProbeParameters = ProbePayload;

// Chrome exposes storage.local to extension content scripts by default. Lock
// it before any boot reconciliation or message handling can read provider
// keys, OAuth grants, mirrors, or remixlet state. Firefox and Safari do not
// currently expose this Chrome-only access-control method.
void ext.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) => console.error("[remixlet] could not restrict local storage", error));

/** The only general-worker messages authored by an extension content script. */
const CONTENT_SCRIPT_MESSAGE_KINDS = new Set(["annotation.reopen", "annotation.result"]);

/** Packaged UI documents that send the general PanelToWorker protocol. */
const TRUSTED_UI_PATHS = new Set(["/manager.html", "/oauth-callback.html", "/panel/index.html", "/popup.html", "/welcome.html"]);

/**
 * General worker operations belong to packaged extension pages. A content
 * script has a browser-attested web URL and gets only the annotation messages
 * above. Chrome sets sender.tab for packaged UI opened in a tab too, so the
 * tab field alone cannot distinguish it from a content script; those senders
 * must also name one of the exact extension UI paths. The page-agent and
 * offscreen box messages keep their own narrower checks in worker/box.ts.
 */
function generalMessageSenderAllowed(message: { kind: string }, sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== ext.runtime.id) return false;
  if (sender.tab === undefined) return true;
  if (sender.url?.startsWith(ext.runtime.getURL(""))) {
    try {
      return TRUSTED_UI_PATHS.has(new URL(sender.url).pathname);
    } catch {
      return false;
    }
  }
  return CONTENT_SCRIPT_MESSAGE_KINDS.has(message.kind);
}

ext.runtime.onInstalled.addListener((details) => {
  console.log(`[remixlet] installed (${details.reason})`, detectCapabilities());
  bootReconcile();
  // A fresh install always lands on the welcome page: nothing else opens
  // until setup is complete, and "complete" means a connected model provider
  // — a fact only extension-UI documents may read, never this worker. So the
  // page decides what is still missing; the worker just opens it. Every later
  // entry point (popup, control center) sends people to the same page.
  if (details.reason === "install") {
    void ext.tabs.create({ url: ext.runtime.getURL("welcome.html") });
  }
});

// Every worker boot: rebuild the mirror FROM THE STORE, then reconcile
// registrations. The store is the truth — a mirror alone can be stale (e.g.
// an activation that failed after the mirror write rolled it back).
// No top-level await in a service worker — fire and forget, listeners are
// already attached.
function bootReconcile(): void {
  // Nothing here waits on the user: what the box needs is fixed at install
  // (platform/capabilities.ts). A browser without it still runs the CSS and
  // network-rule remixlets, and the activation gate names the reason
  // (limited mode: Firefox and Safari today).
  const capabilities = detectCapabilities();
  if (!capabilities.box) console.info(`[remixlet] limited mode — ${capabilities.disabledReasons.box}`);
  // The boot sync already leaves out anything marked deleting; the resume
  // then finishes the interrupted sequence (worker/activation.ts).
  void syncMirror()
    .catch((error) => console.error("[remixlet] boot sync failed", error))
    .then(() => resumePendingDeletions())
    .catch((error) => console.error("[remixlet] deletion resume failed", error));
}
bootReconcile();
void reconcileMenuCommands().catch((error) => console.error("[remixlet] menu reconcile failed", error));

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    void clearMenuCommandsForTab(details.tabId).catch(() => {});
    // A pending capability proposal was raised for a page on one site; when
    // that tab leaves the site, the consent it asked for has nothing left to
    // attach to (remediation plan item 7, approval binding).
    void invalidateCapabilityProposalsForNavigation(details.tabId, details.url).catch(() => {});
    // Catch-all invalidation for user-driven navigations and reloads: the
    // destination page's content is about to be regenerated, so its stored
    // capture digest is stale. Agent-driven mutations (activation reloads,
    // the navigate tool, clicks) additionally invalidate deterministically at
    // their call sites — this listener alone would race the capture that
    // follows a write.
    void invalidateCaptureDigestForUrl(details.url);
  }
});
ext.tabs.onRemoved.addListener((tabId) => {
  void clearMenuCommandsForTab(tabId).catch(() => {});
});

// Toolbar click opens the popup (manifest action.default_popup: per-site
// toggles + pause). The chat panel keeps its keyboard command; Firefox's
// sidebar_action affordance is the M6 PanelSurface backend's job.
ext.commands?.onCommand.addListener((command, tab) => {
  if (command === "open-panel") {
    void panelSurface().open(tab?.windowId).catch(() => {});
  }
});

installBadge();
installDevReload();
installAskNotificationClicks();

installCssInjection();
installCodexAuth();
installSchedule();
installNavigationHints();

ext.runtime.onMessage.addListener(
  (message: PanelToWorker | BoxWorkerMessage | undefined, sender, respondRaw: (r: StampedWorkerToPanel | BoxWorkerReply) => void) => {
    if (message?.kind === undefined || sender.id !== ext.runtime.id) return false;
    // The box runtime's lanes (page agent hello, offscreen host resolve and
    // bridge) answer with their own wire shapes, unstamped: no panel reads
    // them, and the agent compares nothing against a build id.
    if (isBoxWorkerMessage(message)) {
      void handleBoxWorkerMessage(message, sender)
        .catch((error): BoxWorkerReply => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .then((reply) => respondRaw(reply));
      return true; // async sendResponse
    }
    if (!generalMessageSenderAllowed(message, sender)) return false;
    // Every reply carries this build's stamp (StampedWorkerToPanel), so the
    // handlers below stay stamp-unaware.
    const sendResponse = (reply: WorkerToPanel): void => respondRaw({ ...reply, buildId: BUILD_ID });
    switch (message.kind) {
      case "capabilities.get":
        sendResponse({ kind: "capabilities.result", capabilities: detectCapabilities() });
        return false;
      case "capture.request":
        void handleCaptureRequest(message.request, message.conversationEpoch, message.page).then((reply) =>
          sendResponse(reply),
        );
        return true; // async sendResponse
      case "remixlet.activate":
        void activateRemixlet(message.files, message.reloadTabId, undefined, message.message, message.authorization)
          .then((outcome) => recordConversationLink(outcome, message.conversationId))
          .then((outcome) => sendResponse({ kind: "remixlet.activated", outcome }));
        return true;
      case "remixlet.resolveCapabilityApproval":
        if (!message.approved) {
          void denyCapabilityProposal(message.proposalId).then(() => sendResponse({ kind: "remixlet.capabilityDenied" }));
          return true;
        }
        void activateRemixlet(
          message.files,
          message.reloadTabId,
          { proposalId: message.proposalId },
          message.message,
          message.authorization,
        )
          .then((outcome) => recordConversationLink(outcome, message.conversationId))
          .then((outcome) => sendResponse({ kind: "remixlet.activated", outcome }));
        return true;
      case "remixlet.list":
        void Promise.all([remixletStore().list(), readQuarantine()]).then(([entries, quarantine]) =>
          sendResponse({
            kind: "remixlet.listed",
            entries,
            quarantined: Object.fromEntries(Object.entries(quarantine).map(([id, record]) => [id, record.reason])),
          }),
        );
        return true;
      case "remixlet.setEnabled":
        void wrapEntry(
          () => setRemixletEnabled(message.id, message.enabled, { reloadTabId: message.reloadTabId, reloadMatching: message.reloadMatching }),
          sendResponse,
        );
        return true;
      case "remixlet.versions":
        void remixletStore()
          .versions(message.id)
          .then((versions) => sendResponse({ kind: "remixlet.versionsListed", versions }));
        return true;
      case "remixlet.capabilities":
        void readRemixletCapabilities(message.id)
          .then((capabilities) => sendResponse({ kind: "remixlet.capabilitiesResult", id: message.id, capabilities }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.rollback":
        void handleRollback(
          message.id,
          message.sha,
          { reloadTabId: message.reloadTabId, reloadMatching: message.reloadMatching },
          sendResponse,
        );
        return true;
      case "remixlet.resolveRollbackCapabilityApproval":
        if (!message.approved) {
          void denyCapabilityProposal(message.proposalId).then(() => sendResponse({ kind: "remixlet.capabilityDenied" }));
          return true;
        }
        void handleRollback(
          message.id,
          message.sha,
          { reloadTabId: message.reloadTabId, reloadMatching: message.reloadMatching },
          sendResponse,
          { proposalId: message.proposalId },
        );
        return true;
      case "remixlet.remove":
        void wrapEntry(
          () => removeRemixlet(message.id, { reloadTabId: message.reloadTabId, reloadMatching: message.reloadMatching }),
          sendResponse,
        );
        return true;
      case "remixlet.restore":
        void wrapEntry(() => restoreRemixlet(message.id), sendResponse);
        return true;
      case "remixlet.destroy":
        void destroyRemixlet(message.id, { reloadTabId: message.reloadTabId, reloadMatching: message.reloadMatching })
          .then(() => sendResponse({ kind: "remixlet.destroyed", id: message.id }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.diff":
        void handleDiffRequest(message.id, message.toSha, message.fromSha)
          .then((files) => sendResponse({ kind: "remixlet.diffResult", files }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.filesAt":
        void remixletStore()
          .filesAt(message.id, message.sha)
          .then((files) => sendResponse({ kind: "remixlet.filesAtResult", files }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.readScriptLog":
        void readScriptLog(message.id)
          .then((entries) => sendResponse({ kind: "remixlet.scriptLog", entries }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "usage.read":
        void readUsage()
          .then((usage) => sendResponse({ kind: "usage.result", usage }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.recordVerification":
        if (message.result.ok !== true) {
          sendResponse({ kind: "remixlet.error", message: "only an explicit successful verification may be recorded" });
          return false;
        }
        void remixletStore()
          .list()
          .then(async (before) => {
            const parked = before.find((candidate) => candidate.id === message.id)?.state === "needs-attention";
            await remixletStore().recordSuccessfulVerification(message.id, message.result);
            const entry = (await remixletStore().list()).find((candidate) => candidate.id === message.id);
            if (!entry) throw new Error(`unknown remixlet ${message.id}`);
            // A pass is the fixing exit from a needs-attention park: the
            // record flips the state back to enabled, and eligibility is
            // decided by the mirror build, so rebuild it or the remixlet
            // stays out of service until the next unrelated sync.
            if (parked) await syncMirror().catch((error) => console.error("[remixlet] post-verification sync failed", error));
            sendResponse({ kind: "remixlet.verificationRecorded", entry });
          })
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.recordVerifyFailure":
        void recordFailedVerificationExit(
          message.id,
          {
            outcome: message.outcome,
            at: message.at,
            summary: message.summary,
            conversationId: message.conversationId,
          },
          { reloadTabId: message.reloadTabId },
        )
          .then(({ entry, action }) => sendResponse({ kind: "remixlet.verifyFailureRecorded", entry, action }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "site.setPaused":
        // The reload (tab and/or matching) is part of the same atomic pause
        // mutation now, so a pause evicts already-injected code instead of
        // leaving it live in other tabs (Phase 3 kill switch).
        void setSitePausedAtomic(message.siteKey, message.paused, {
          reloadTabId: message.reloadTabId,
          reloadMatching: message.reloadMatching,
        })
          .then((pausedSiteKeys) => sendResponse({ kind: "site.pausedState", pausedSiteKeys }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "site.pausedList":
        void readPausedSites().then((pausedSiteKeys) => sendResponse({ kind: "site.pausedState", pausedSiteKeys }));
        return true;
      case "menu.list":
        void listMenuCommands(message.tabId)
          .then((commands) => sendResponse({ kind: "menu.listed", commands }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "menu.invoke":
        // A menu command runs remixlet code that may mutate the page.
        void invalidateCaptureDigestForTab(message.tabId);
        void enqueueMenuInvocation(message.tabId, message.registrationId)
          .then((queued) => sendResponse({ kind: "menu.invoked", queued }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.read":
        void readVisibleRemixlet(message.id, message.authorization)
          .then(({ files, headSha, version }) => sendResponse({ kind: "remixlet.content", files, headSha, version }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "page.probe": {
        // Build agreement comes first: when the running worker and the panel
        // were stamped by different builds, every later check compares the
        // panel's params against schemas the panel never saw — name that
        // state instead of reporting it as an unknown probe or invalid params.
        const skew = probeBuildSkewMessage(message.buildId, BUILD_ID);
        if (skew !== undefined) {
          sendResponse({ kind: "page.probed", ok: false, message: skew });
          return false;
        }
        if (!isProbeName(message.probe)) {
          sendResponse({ kind: "page.probed", ok: false, message: `unknown probe "${String(message.probe)}"` });
          return false;
        }
        if (!Check(PROBE_SCHEMAS[message.probe], message.params)) {
          sendResponse({
            kind: "page.probed",
            ok: false,
            message: `invalid params for probe "${message.probe}": ${describeProbeParamsError(message.probe, message.params)}`,
          });
          return false;
        }
        void handleProbeRequest(message.tabId, message.probe, message.params, message.conversationId, message.page)
          .then((reply) => sendResponse(reply))
          .catch((error) => sendResponse({ kind: "page.probed", ok: false, message: String(error) }));
        return true;
      }
      case "look.capture": {
        // Same trust boundary as page.probe: build agreement, then the params
        // shape against the locate_for_review schema, before anything runs.
        const skew = probeBuildSkewMessage(message.buildId, BUILD_ID);
        if (skew !== undefined) {
          sendResponse({ kind: "look.captured", ok: false, message: skew });
          return false;
        }
        if (!Check(PROBE_SCHEMAS.locate_for_review, message.params)) {
          sendResponse({
            kind: "look.captured",
            ok: false,
            message: `invalid params for look_at_change: ${describeProbeParamsError("locate_for_review", message.params)}`,
          });
          return false;
        }
        const remixletId = message.remixletId;
        // Bound to a const so the Check above keeps narrowing it inside the
        // closure below (TypeScript drops a property narrowing at a callback).
        const lookParams = message.params;
        const lookPage = message.page;
        const lookTabId = message.tabId;
        // Bracketed, and checked once more inside: the crop is written beside
        // the remixlet BEFORE captureLookReview returns, so the outer trailing
        // check alone would refuse a moved tab's shot after storing it. A
        // throw from storeCrop is already swallowed as "crop not stored",
        // which is the outcome wanted here — the outer check still refuses.
        void onBoundPage(lookTabId, lookPage, () =>
          captureLookReview(
            lookTabId,
            lookParams,
            remixletId === undefined
              ? undefined
              : async (png) => {
                  await assertBoundPage(lookTabId, lookPage);
                  await remixletStore().writeLookCrop(remixletId, png.bytes);
                },
          ),
        )
          .then((result) => sendResponse({ kind: "look.captured", ok: true, result }))
          .catch((error) =>
            sendResponse({
              kind: "look.captured",
              ok: false,
              message: error instanceof Error ? error.message : String(error),
              reason: error instanceof ScreenshotIdentityChangedError ? "screenshot-identity-changed" : undefined,
            }),
          );
        return true;
      }
      case "remixlet.recordLookReview": {
        const review = sanitizeLookReview(message.review);
        if (!review) {
          sendResponse({ kind: "remixlet.error", message: "look review is malformed" });
          return false;
        }
        void remixletStore()
          .recordLookReview(message.id, review)
          .then((entry) => sendResponse({ kind: "remixlet.lookReviewRecorded", entry }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      }
      case "remixlet.readLookCrop":
        void remixletStore()
          .readLookCrop(message.id)
          .then((bytes) => sendResponse({ kind: "remixlet.lookCrop", id: message.id, dataUrl: bytes && pngDataUrl(bytes) }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "devObserve.enable":
        void enableDevObserve(message.conversationId, message.tabId)
          .then((origin) => sendResponse({ kind: "devObserve.enabled", ok: true, origin }))
          .catch((error) => sendResponse({ kind: "devObserve.enabled", ok: false, message: String(error) }));
        return true;
      case "devObserve.disable":
        void disableDevObserve(message.conversationId)
          .then(() => sendResponse({ kind: "devObserve.disabled" }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "page.navigate":
        // Held to the bound site at BOTH ends. The tab must still be on the
        // conversation's page (nothing else may be driven), and the
        // destination must be within it — an agent that could navigate the tab
        // off-site would be manufacturing the drift every other read refuses,
        // and the user would come back to a stopped chat blaming a move they
        // never made.
        void assertBoundPage(message.tabId, message.page)
          .then(() => assertNavigationWithinSite(message.url, message.page))
          .then(() => navigateTab(message.tabId, message.url))
          .then(() => sendResponse({ kind: "page.navigated", ok: true }))
          .catch((error) => sendResponse({ kind: "page.navigated", ok: false, message: String(error) }));
        return true;
      case "annotation.start":
        void startPageAnnotation(message.tabId)
          .then(() => sendResponse({ kind: "annotation.started", ok: true }))
          .catch((error) => sendResponse({ kind: "annotation.started", ok: false, message: String(error) }));
        return true;
      case "showChanges.start":
        void startShowChanges(message.tabId, message.id)
          .then((summary) => sendResponse({ kind: "showChanges.started", ok: true, summary }))
          .catch((error) =>
            sendResponse({
              kind: "showChanges.started",
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      case "annotation.reopen": {
        // The overlay's idle pill (after Done): re-run the start pipeline for
        // the tab the pill lives in, reopening markup mode.
        const reopenTabId = sender.tab?.id;
        if (reopenTabId === undefined) {
          sendResponse({ kind: "annotation.started", ok: false, message: "No sender tab." });
          return false;
        }
        void startPageAnnotation(reopenTabId)
          .then(() => sendResponse({ kind: "annotation.started", ok: true }))
          .catch((error) => sendResponse({ kind: "annotation.started", ok: false, message: String(error) }));
        return true;
      }
      case "annotation.result":
        // Broadcast by the overlay content script when markup mode ends. The
        // panel receives the same broadcast and owns the payload; this side
        // only acknowledges, so the overlay's sendMessage settles even when
        // no panel is open.
        sendResponse({ kind: "annotation.resultAck" });
        return false;
      case "codex.begin":
        void beginCodexSignIn()
          .then(() => sendResponse({ kind: "codex.begun", ok: true }))
          .catch((error) => sendResponse({ kind: "codex.begun", ok: false, message: String(error) }));
        return true;
      case "codex.status":
        void codexAuthStatus().then((status) => sendResponse({ kind: "codex.statusResult", status }));
        return true;
      case "codex.signOut":
        void signOutCodex().then(() => sendResponse({ kind: "codex.signedOut" }));
        return true;
      case "codex.getAccessToken":
        void getCodexAccessToken()
          .then((accessToken) => sendResponse({ kind: "codex.accessToken", ok: true, accessToken }))
          .catch((error) =>
            sendResponse({ kind: "codex.accessToken", ok: false, message: error instanceof Error ? error.message : String(error) }),
          );
        return true;
      case "codex.invalidateAccessToken":
        void invalidateCodexAccessToken().then(() => sendResponse({ kind: "codex.accessTokenInvalidated" }));
        return true;
      case "conversation.upsert":
        void conversationIndex
          .upsert(message.meta)
          .then((meta) => sendResponse({ kind: "conversation.upserted", meta }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "conversation.list":
        void conversationIndex
          .list()
          .then((conversations) => sendResponse({ kind: "conversation.listed", conversations }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "siteIcon.record":
        // Fire-and-forget semantics inside a request/reply transport: the
        // snapshot fetch happens after the ack, and failures only mean the
        // icon stays unsnapshotted.
        void recordSiteIcon(message.siteKey, message.pageOrigin, message.favIconUrl).catch(() => {});
        sendResponse({ kind: "siteIcon.recorded" });
        return false;
      case "siteIcon.refresh":
        void refreshSiteIcon(message.siteKey)
          .then((dataUrl) => sendResponse({ kind: "siteIcon.refreshed", dataUrl }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "siteIcon.list":
        void listSiteIcons()
          .then((icons) => sendResponse({ kind: "siteIcon.listed", icons }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "codex.callback": {
        const senderTabId = sender.tab?.id;
        void handleCodexCallback(message.code, message.state).then((outcome) => {
          sendResponse({ kind: "codex.callbackResult", ok: outcome.ok, message: outcome.message, account: outcome.account });
          // Leave the success page visible for a beat, then tidy the tab away
          // (window.close() is unreliable for tabs the page didn't open).
          if (outcome.ok && senderTabId !== undefined) {
            setTimeout(() => void ext.tabs.remove(senderTabId).catch(() => {}), 1500);
          }
        });
        return true;
      }
    }
  },
);

/**
 * "Show what changed": inject the passive highlight overlay and hand it the
 * remixlet's stored verification assertions. Every failure is a plain-words
 * message the panel shows verbatim, and the overlay's summary comes back so
 * the panel knows what was actually drawn.
 */
async function startShowChanges(tabId: number, id: string): Promise<ShowChangesSummary> {
  const entry = (await remixletStore().list()).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`unknown remixlet ${id}`);
  // Sanitized again at this boundary — the registry file is data, not code.
  const assertions = sanitizeVerifiedAssertions(entry.lastVerifiedAssertions);
  if (assertions.length === 0) {
    throw new Error("This remixlet has no recorded verification spots to show yet.");
  }
  const tab = await ext.tabs.get(tabId);
  const url = tab.url ?? tab.pendingUrl;
  if (!url || !/^https?:/.test(url)) throw new Error("Showing the changes needs a normal web page in the active tab.");
  if (!urlMatchesAny(url, entry.matches)) throw new Error("This page isn't one the remixlet runs on.");
  await ext.scripting.executeScript({ target: { tabId }, files: ["show-changes-host.js"], world: "ISOLATED" });
  // SAFETY: show-changes-host.js responds with this payload after it is injected above.
  const reply = (await ext.tabs.sendMessage(tabId, {
    kind: SHOW_CHANGES_OPEN_MESSAGE,
    remixletName: entry.name,
    assertions,
  })) as { ok?: boolean; summary?: ShowChangesSummary; message?: string } | undefined;
  if (!reply?.ok || !reply.summary) {
    throw new Error(reply?.message || "The page did not accept the highlight overlay.");
  }
  return reply.summary;
}

async function startPageAnnotation(tabId: number): Promise<void> {
  const tab = await ext.tabs.get(tabId);
  const url = tab.url ?? tab.pendingUrl;
  if (!url || !/^https?:/.test(url)) throw new Error("Drawing on the page needs a normal web page in the active tab.");
  await ext.scripting.executeScript({ target: { tabId }, files: ["annotate-host.js"], world: "ISOLATED" });
  // SAFETY: annotate-host.js responds with this payload after it is injected above.
  const reply = (await ext.tabs.sendMessage(tabId, { kind: ANNOTATE_OPEN_MESSAGE })) as { ok?: boolean } | undefined;
  if (!reply?.ok) throw new Error("The page did not accept markup mode.");
}

/**
 * The page.probe trust boundary: the "page.probe" switch case above
 * revalidates build agreement, the probe name, and the params shape before
 * this ever runs — never trusted from the panel (a compromised panel must not
 * reach the templates with unvetted values).
 *
 * Nothing may reject: a rejection would skip sendResponse, close the message
 * channel, and reach the panel as an undefined reply — the SAME opaque symptom
 * an unhandled message kind produces. So the caller carries a belt-and-braces
 * .catch like every other case in the switch, on top of this try.
 */
async function handleProbeRequest(
  tabId: number,
  probe: ProbeName,
  params: ProbeParameters,
  conversationId: string | undefined,
  page: BoundPage | undefined,
): Promise<WorkerToPanel> {
  try {
    // Before the grant lookup and before the click invalidation: a moved tab
    // is refused without any of the work a probe would otherwise do.
    await assertBoundPage(tabId, page);
    // Build agreement and the probe/params shape are both validated by the
    // caller (the "page.probe" switch case) before this runs.
    // observe_network_bodies reads the dev observer's buffer: gate on the
    // stored grant for this tab's origin, and inject the sync event names
    // server-side AFTER validation (worker-authored fields, spread last so
    // nothing model-supplied can shadow them; without a grant the probe never
    // runs at all).
    let effectiveParams = params;
    if (probe === "observe_network_bodies") {
      const prepared = await devObserveProbeParams(tabId, params, conversationId);
      if (prepared[0] === undefined) return { kind: "page.probed", ok: false, message: prepared[1] };
      effectiveParams = prepared[0];
    }
    // A click mutates the page; invalidate the capture digest BEFORE it runs
    // so the next capture is a full one regardless of how the click lands.
    // The click rights go in the same way the observe probe's event names do:
    // worker-authored, after validation, spread last.
    if (probe === "click_element") {
      await invalidateCaptureDigestForTab(tabId);
      effectiveParams = await clickProbeParams(tabId, effectiveParams);
    }
    // inspect_design may need fetch rounds for cross-origin stylesheets
    // (page-probes/stylesheets.ts); every other probe is one injection.
    // The network probes go through the id registry (worker/network-ids.ts):
    // a listing's URLs become ids before the panel sees it, and a replay's
    // id becomes the recorded URL only here.
    // SAFETY: the "page.probe" case validated effectiveParams against the named probe's schema before this runs.
    const value = await onBoundPage(tabId, page, () =>
      probe === "inspect_design"
        ? runInspectDesignProbe(tabId, effectiveParams, page?.origin)
        : probe === "list_network_resources"
          ? runListNetworkResources(tabId, effectiveParams as ListNetworkResourcesParamsType)
          : probe === "replay_network_resource"
            ? runReplayNetworkResource(tabId, effectiveParams as ReplayNetworkResourceParamsType)
            : runProbe(tabId, probe, effectiveParams),
    );
    return { kind: "page.probed", ok: true, value: probe === "click_element" ? await settledClick(tabId, value) : value };
  } catch (error) {
    return { kind: "page.probed", ok: false, message: String(error) };
  }
}

/**
 * A click's handler runs in the box as a chain of round trips, so the click
 * reply is held until every box on the page is idle (worker/box.ts settleTab):
 * the assert that follows then reads the effect, not the gap before it. The
 * outcome rides on the probe's own result; no answer means no box on the page.
 */
async function settledClick(tabId: number, value: string): Promise<string> {
  const reply = await settleTab(tabId);
  if (reply === undefined) return value;
  // The probe answers a JSON object (clickElementProbe's ProbeResult); anything else is left as it came.
  let result: JsonValue;
  try {
    // SAFETY: JSON.parse of the probe's own serialised result; a non-object is handled below.
    result = JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
  if (!(result instanceof Object) || Array.isArray(result)) return value;
  return JSON.stringify(
    reply.settled
      ? { ...result, settled: true }
      : {
          ...result,
          settled: false,
          settleNote: "the page's remixlet code was still running when the wait ran out; read_remixlet_logs shows what it was doing",
        },
  );
}

/**
 * Server-side param injection for click_element: the matches and `fetch:`
 * grants of the boxed remixlets running on the tab's page (worker/box.ts
 * clickRightsFor), which is what the page-side `clickDecision` judges an
 * off-site destination against. Authored here, never accepted from the panel:
 * the model-facing schema (shared/probe-schemas.ts ClickElementParams) does
 * not declare these fields, and they are spread LAST so a model-supplied
 * field of the same name is overwritten. A tab with no readable URL, or a page
 * with no boxed remixlet, yields empty lists, so only same-origin clicks pass.
 */
async function clickProbeParams(tabId: number, params: ProbeParameters): Promise<ProbeParameters> {
  const tab = await ext.tabs.get(tabId);
  const rights = tab.url === undefined ? { matches: [], grantedHosts: [] } : await clickRightsFor(tab.url);
  return { ...params, matches: rights.matches, grantedHosts: rights.grantedHosts };
}

/**
 * Grant gate + server-side param injection for observe_network_bodies.
 * Returns the augmented params, or the fail-closed error message when no live
 * grant covers the tab's origin.
 */
async function devObserveProbeParams(
  tabId: number,
  params: ProbeParameters,
  conversationId: string | undefined,
): Promise<[ProbeParameters] | [undefined, string]> {
  const tab = await ext.tabs.get(tabId);
  let origin: string | undefined;
  try {
    origin = tab.url === undefined ? undefined : new URL(tab.url).origin;
  } catch {
    origin = undefined;
  }
  if (origin === undefined) return [undefined, "observe_network_bodies: the active tab has no readable URL"];
  const grant = await devObserveGrantForRead(conversationId, origin);
  if (grant === undefined) {
    return [
      undefined,
        "observe_network_bodies: watching this page's data is not enabled for this conversation. It is enabled only " +
        'by the user clicking Allow on the panel\'s card — record an assess_feasibility verdict of ' +
        '"needs-network-visibility" so the panel can ask, and read the responses in the turn that follows their click.',
    ];
  }
  return [
    {
      ...params,
      requestEvent: DEV_OBSERVE_REQUEST_EVENT,
      replyEvent: DEV_OBSERVE_REPLY_EVENT,
    },
  ];
}

/**
 * The dev-observe card's Allow click (and only that click) lands here: pin the
 * grant to the tab's origin NOW, register the observer via the shared
 * reconcile, and reload the tab so its load-time requests are the first thing
 * the buffer holds. Returns the pinned origin for the panel's continuation.
 */
async function enableDevObserve(conversationId: string, tabId: number): Promise<string> {
  const tab = await ext.tabs.get(tabId);
  if (tab.url === undefined) throw new Error("the active tab has no readable URL");
  const url = new URL(tab.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`observation only works on http(s) pages (this tab is ${url.protocol})`);
  }
  await recordDevObserveGrant({ conversationId, origin: url.origin, grantedAt: Date.now() });
  await reconcileRegistrations();
  // The reload both arms the document_start observer and changes the page, so
  // the next capture must be a full one.
  await invalidateCaptureDigestForTab(tabId);
  await ext.tabs.reload(tabId).catch(() => {});
  return url.origin;
}

async function disableDevObserve(conversationId: string): Promise<void> {
  const removed = await removeDevObserveGrant(conversationId);
  if (removed) await reconcileRegistrations();
}

/** Changed files between two commits, full contents both sides (UI diffs locally).
 *  fromSha omitted = the commit's real first parent (list order lies after a
 *  rollback fork); no parent (the install commit) = empty "before". */
async function handleDiffRequest(
  id: string,
  toSha: string,
  fromSha?: string,
): Promise<{ path: string; before?: string; after?: string }[]> {
  const store = remixletStore();
  const resolvedFrom = fromSha ?? (await store.parentOf(id, toSha));
  const before = resolvedFrom ? await store.filesAt(id, resolvedFrom) : {};
  const after = await store.filesAt(id, toSha);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths
    .filter((path) => before[path] !== after[path])
    .map((path) => ({ path, before: before[path], after: after[path] }));
}

/**
 * The agent's read surface. Archived remixlets are soft-deleted and stay
 * invisible to the agent — list_remixlets omits them, so a read by id must
 * fail closed rather than become the way back in. The error deliberately does
 * not distinguish archived from absent; restoring is the user's move in the
 * manager.
 *
 * An agent read carries the chat's bound site and is held to it: a remixlet
 * that belongs to another site is not returned (remediation plan item 7,
 * cross-site reads), so a page the user never trusted cannot, through the
 * model, learn what they built elsewhere. The rule is the one list_remixlets
 * lists in full by (remixletOnSite), so the agent can read exactly what it
 * was shown. A read with no authorization is the user's own action from the
 * manager and is not scoped.
 */
async function readVisibleRemixlet(
  id: string,
  authorization: SiteAuthorization | undefined,
): Promise<{ files: Record<string, string>; headSha: string; version: number }> {
  const store = remixletStore();
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry || entry.state === "archived") throw new Error(`unknown remixlet ${id}`);
  if (authorization !== undefined) {
    const site = authorization.siteKey.trim();
    if (site === "") {
      throw new Error(`this chat is not bound to a site yet, so remixlet ${id} was not read. Capture the page first.`);
    }
    if (!remixletOnSite(entry.siteKey, site)) {
      throw new Error(
        `remixlet ${id} belongs to ${entry.siteKey}, not ${site}, the site this chat works on. Its files were not read. ` +
          `The user can open it from the manager, or start a chat on ${entry.siteKey} to change it. ` +
          `To build something new for ${site}, choose a different id.`,
      );
    }
  }
  const { files } = await store.read(id);
  return { files, headSha: entry.headSha, version: entry.version };
}

/** A stored PNG as a data: URL the manager can put straight into an <img>. */
function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function wrapEntry(
  action: () => Promise<import("../store/remixlet-store.js").RegistryEntry>,
  sendResponse: (r: WorkerToPanel) => void,
): Promise<void> {
  try {
    sendResponse({ kind: "remixlet.entry", entry: await action() });
  } catch (error) {
    sendResponse({ kind: "remixlet.error", message: String(error) });
  }
}

async function handleRollback(
  id: string,
  sha: string,
  scope: import("./activation.js").ReloadScope,
  sendResponse: (r: WorkerToPanel) => void,
  capabilityApproval?: { proposalId: string },
): Promise<void> {
  try {
    const outcome = await rollbackRemixletWithApproval(id, sha, scope, capabilityApproval);
    sendResponse(
      outcome.ok
        ? { kind: "remixlet.entry", entry: outcome.entry }
        : { kind: "remixlet.rollbackApprovalRequired", proposal: outcome.proposal },
    );
  } catch (error) {
    sendResponse({ kind: "remixlet.error", message: String(error) });
  }
}

// Capture, then persist to OPFS captures/<site-key>/ so the agent can re-read
// bundles across turns. Persistence failure never fails the capture — it is
// annotated in bundle.missing (and the observation suite asserts `ref` exists,
// so a service-worker OPFS regression turns CI red rather than going silent).
const captureStore = new CaptureStore();
const conversationIndex = new ConversationIndex();

// The conversation→remixlet link is recorded here, worker-side, in the same
// message turn as the activation — not as a panel after-effect — so a panel
// death right after write_remixlet cannot lose the edge. Index failure never
// fails the activation (the index is rebuildable UI state).
async function recordConversationLink(
  outcome: ActivationOutcome,
  conversationId: string | undefined,
): Promise<ActivationOutcome> {
  if (conversationId !== undefined && outcome.ok) {
    await conversationIndex
      .upsert({ id: conversationId, siteKey: outcome.entry.siteKey, remixletIds: [outcome.entry.id] })
      .catch((error) => console.error("[remixlet] conversation link update failed", error));
  }
  return outcome;
}

/**
 * The capture's Data endpoints section (wiki/design/network-probes.md): the
 * network listing in census mode, registered so every row carries an id,
 * attached to the bundle. Best effort: a census that cannot be read, or one
 * from a different document than the snapshot (the page reloaded between
 * the two reads), leaves a missing[] note instead of failing the capture.
 */
async function attachNetworkCensus(
  tabId: number,
  page: BoundPage | undefined,
  bundle: CaptureBundle,
  pageLoad: string | undefined,
): Promise<void> {
  try {
    const census = await onBoundPage(tabId, page, () => readNetworkCensus(tabId, pageLoad));
    if (census === undefined) {
      bundle.missing.push("network endpoints: the page reloaded while it was being captured; capture again to list its data endpoints");
      return;
    }
    bundle.networkCensus = census;
  } catch (error) {
    bundle.missing.push(`network endpoints: not listed (${String(error)}); list_network_resources still works`);
  }
}

async function handleCaptureRequest(
  request: CaptureRequest,
  conversationEpoch?: string,
  page?: BoundPage,
): Promise<WorkerToPanel> {
  let result: Awaited<ReturnType<typeof capturePage>>;
  try {
    // Bracketed: nothing is captured from a tab that already moved, and a tab
    // that moves DURING the capture throws here — before the bundle reaches
    // OPFS below, and before it reaches the panel as model context.
    result = await onBoundPage(request.tabId, page, () => capturePage(request));
  } catch (error) {
    result = { ok: false, reason: "failed", message: String(error) };
  }
  if (!result.ok) return { kind: "capture.result", result };
  await attachNetworkCensus(request.tabId, page, result.bundle, result.pageLoad);

  // Unchanged-page short-circuit (wiki/raw/handoffs/2026-08-10-capture-context-diet.md):
  // when the capture digests identically to the newest one this SAME
  // conversation already received — and no page-mutating event cleared the
  // record in between (capture-freshness.ts) — reply with a pointer instead
  // of ~41KB of identical content. The bundle is slimmed so the panel cannot
  // re-attach content it should not resend. Digest work must never fail a
  // capture, so every step here degrades to the full path.
  const siteKey = captureSiteKey(result.bundle.url);
  let digest: string | undefined;
  if (conversationEpoch !== undefined) {
    try {
      digest = await captureContentDigest(formatCaptureForModel(result.bundle));
      const record = await captureStore.readLatestDigest(siteKey);
      if (
        record &&
        latestDigestMatches(record, {
          digest,
          url: result.bundle.url,
          conversationEpoch,
          hasScreenshot: result.bundle.screenshot !== undefined,
          screenshotCoverage: result.bundle.screenshot?.coverage,
        })
      ) {
        await captureStore.confirmLatestDigest(siteKey, result.bundle.capturedAt);
        const { url, title, capturedAt, producedBy, missing } = result.bundle;
        return {
          kind: "capture.result",
          result: { ok: true, bundle: { url, title, capturedAt, producedBy, missing } },
          ref: record.ref,
          unchangedSince: { ref: record.ref, capturedAt: record.capturedAt },
        };
      }
    } catch {
      digest = undefined;
    }
  }

  let ref: CaptureRef | undefined;
  try {
    ref = await captureStore.save(result.bundle);
  } catch (error) {
    result.bundle.missing.push(`persistence: capture not saved to OPFS — ${String(error)}`);
  }
  if (ref !== undefined && conversationEpoch !== undefined && digest !== undefined) {
    try {
      await captureStore.writeLatestDigest(siteKey, {
        digest,
        ref,
        url: result.bundle.url,
        capturedAt: result.bundle.capturedAt,
        conversationEpoch,
        hasScreenshot: result.bundle.screenshot !== undefined,
        screenshotCoverage: result.bundle.screenshot?.coverage,
      });
    } catch {
      // Record not written — the next capture is full, nothing worse.
    }
  }
  return { kind: "capture.result", result, ref };
}
