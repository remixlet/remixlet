// Service worker: thin, event-driven, no in-memory state that isn't
// reconstructible from storage (MV3 kills it at will). The agent lives in the
// panel; this side owns injection, the capability bridge, captures, lifecycle.

import { detectCapabilities, verifiedCapabilities } from "../platform/capabilities.js";
import { ext } from "../platform/ext.js";
import {
  clearDrawerPanelState,
  confirmSidePanelSurface,
  panelSurface,
  restoreDrawerPanel,
} from "../platform/panel-surface.js";
import { capturePage } from "../platform/observation/index.js";
import type { CaptureRequest } from "../platform/observation/types.js";
import { ANNOTATE_OPEN_MESSAGE } from "../shared/annotation.js";
import type { PanelToWorker, StampedWorkerToPanel, WorkerToPanel } from "../shared/protocol.js";
import {
  SHOW_CHANGES_OPEN_MESSAGE,
  sanitizeVerifiedAssertions,
  type ShowChangesSummary,
} from "../shared/show-changes.js";
import { urlMatchesAny } from "../shared/site-key.js";
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
  readRemixletCapabilities,
  recordFailedVerificationExit,
  remixletStore,
  removeRemixlet,
  restoreRemixlet,
  revokeCapability,
  rollbackRemixletWithApproval,
  setSitePausedAtomic,
  setRemixletEnabled,
  syncMirror,
} from "./activation.js";
import { installBadge } from "./badge.js";
import { listSiteIcons, recordSiteIcon, refreshSiteIcon } from "./site-icons.js";
import { handleBridgeMessage, isBridgeMessage } from "./bridge.js";
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
import { reconcileUserScripts } from "./injection.js";
import { evaluateInPage, navigateTab } from "./page-probe.js";
import { devObserveReplyEventName, devObserveRequestEventName } from "../shared/dev-observe.js";
import { Check } from "typebox/value";
import { BUILD_ID } from "../shared/build-id.js";
import { PROBE_SCHEMAS, describeProbeParamsError, isProbeName, probeBuildSkewMessage, type ProbeName } from "../shared/probe-schemas.js";
import { runProbe, type ProbePayload } from "./page-probes/engine.js";
import { PROBE_TEMPLATES, PROBE_WORLDS } from "./page-probes/probes.js";
import {
  clearMenuCommandsForTab,
  enqueueMenuInvocation,
  listMenuCommands,
  reconcileMenuCommands,
} from "./menu.js";
import { installSchedule } from "./schedule.js";

type ProbeParameters = ProbePayload;

ext.runtime.onInstalled.addListener((details) => {
  console.log(`[remixlet] installed (${details.reason})`, detectCapabilities());
  bootReconcile();
  // A fresh install always lands on the welcome page: nothing else opens
  // until setup is complete, and the second half of "complete" is a connected
  // model provider — a fact only extension-UI documents may read, never this
  // worker. So the page decides what is still missing; the worker just opens
  // it. Every later entry point (panel alert, popup, control center) sends
  // people to the same page.
  if (details.reason === "install") {
    void ext.tabs.create({ url: ext.runtime.getURL("welcome.html") });
  }
});

// Every worker boot: rebuild the mirror FROM THE STORE, then reconcile
// registrations. The store is the truth — a mirror alone can be stale (e.g.
// an activation that ran while userScripts was still locked rolled it back).
// No top-level await in a service worker — fire and forget, listeners are
// already attached.
function bootReconcile(): void {
  if (!detectCapabilities().userScripts) {
    if (detectCapabilities().panelSurface !== "popup") {
      console.warn("[remixlet] userScripts unavailable — onboarding toggle not enabled");
      return;
    }
    console.info("[remixlet] Safari limited mode — JavaScript remixlets disabled");
  }
  void syncMirror().catch((error) => console.error("[remixlet] boot sync failed", error));
}
bootReconcile();
void reconcileMenuCommands().catch((error) => console.error("[remixlet] menu reconcile failed", error));

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    void clearMenuCommandsForTab(details.tabId).catch(() => {});
    // Catch-all invalidation for user-driven navigations and reloads: the
    // destination page's content is about to be regenerated, so its stored
    // capture digest is stale. Agent-driven mutations (activation reloads,
    // the navigate tool, clicks) additionally invalidate deterministically at
    // their call sites — this listener alone would race the capture that
    // follows a write.
    void invalidateCaptureDigestForUrl(details.url);
  }
});
ext.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  void ext.tabs
    .get(details.tabId)
    .then((tab) => restoreDrawerPanel(details.tabId, tab.windowId))
    .catch(() => {});
});
ext.tabs.onRemoved.addListener((tabId) => {
  void clearMenuCommandsForTab(tabId).catch(() => {});
  void clearDrawerPanelState(tabId).catch(() => {});
});

// The onboarding "finish setup" path reloads the extension so a fresh worker
// context picks up the just-unlocked API (onboarding.finish below). That
// reload killed the welcome tab — bring it back showing the green state.
void ext.storage.local.get("reopenOnboarding").then(async (stored) => {
  if (!stored["reopenOnboarding"]) return;
  await ext.storage.local.remove("reopenOnboarding");
  const url = ext.runtime.getURL("welcome.html");
  const existing = await ext.tabs.query({ url: `${url}*` });
  if (existing.length > 0) {
    for (const tab of existing)
      if (tab.id !== undefined) {
        void ext.tabs
          .update(tab.id, { url })
          .then(() => ext.tabs.reload(tab.id!))
          .catch(() => {});
      }
  } else {
    void ext.tabs.create({ url });
  }
});

// Toolbar click opens the popup (manifest action.default_popup: per-site
// toggles + pause). The chat panel keeps its keyboard command; Firefox's
// sidebar_action affordance is the M6 PanelSurface backend's job.
ext.commands?.onCommand.addListener((command, tab) => {
  if (command === "open-panel") {
    void panelSurface().open(tab?.windowId, tab?.id).catch(() => {});
  }
});

installBadge();
installDevReload();

installCssInjection();
installCodexAuth();
installSchedule();

/**
 * Chain C guard: a panel running as a cross-origin SUBFRAME of a web page — the
 * Arc drawer frames panel/index.html into the page (sender.frameId !== 0) — may
 * only drive its own host tab. A hostile page that frames the panel and passes
 * a `?tabId=` for someone else's tab reaches the worker as a subframe whose
 * sender.tab.id is the hostile tab, never the target, so a mismatch is refused.
 * The native side panel (sender.tab undefined) and the Safari popup panel (a
 * top-level tab, frameId 0) resolve their target via active-tab.ts and are not
 * confined here — only a framed panel is.
 */
function framedPanelTabMismatch(sender: chrome.runtime.MessageSender, tabId: number | undefined): boolean {
  if (sender.tab?.id === undefined || sender.frameId === undefined || sender.frameId === 0) return false;
  return tabId !== sender.tab.id;
}
const CROSS_TAB_REFUSED = "refused: this surface may only act on the tab it is bound to";

ext.runtime.onMessage.addListener(
  (message: PanelToWorker, sender, respondRaw: (r: StampedWorkerToPanel) => void) => {
    // Every reply carries this build's stamp (StampedWorkerToPanel), so the
    // handlers below stay stamp-unaware.
    const sendResponse = (reply: WorkerToPanel): void => respondRaw({ ...reply, buildId: BUILD_ID });
    switch (message.kind) {
      case "drawer.closed":
        if (sender.tab?.id !== undefined) {
          void clearDrawerPanelState(sender.tab.id).then(() => sendResponse({ kind: "drawer.closedAck" }));
          return true;
        }
        sendResponse({ kind: "drawer.closedAck" });
        return false;
      case "panel.hello":
        // A panel with no sender.tab is a browser-owned sidebar surface. The
        // drawer is an iframe inside a content tab and Safari's panel is a tab
        // in a popup window, so both of those carry one.
        void confirmSidePanelSurface(sender.tab === undefined).then(() => sendResponse({ kind: "panel.helloAck" }));
        return true;
      case "capabilities.get":
        // Verified, not merely detected: this worker context can outlive the
        // browser toggle that granted the script lane, and it keeps the
        // namespace after the grant is gone (script-injector.ts). Everything
        // asking here puts the answer in front of a human.
        void verifiedCapabilities().then((capabilities) => sendResponse({ kind: "capabilities.result", capabilities }));
        return true; // async sendResponse
      case "capture.request":
        if (framedPanelTabMismatch(sender, message.request.tabId)) {
          sendResponse({ kind: "capture.result", result: { ok: false, reason: "failed", message: CROSS_TAB_REFUSED } });
          return false;
        }
        void handleCaptureRequest(message.request, message.conversationEpoch).then((reply) => sendResponse(reply));
        return true; // async sendResponse
      case "remixlet.activate":
        if (framedPanelTabMismatch(sender, message.reloadTabId)) {
          sendResponse({ kind: "remixlet.activated", outcome: { ok: false, reason: "failed", message: CROSS_TAB_REFUSED, rolledBack: false } });
          return false;
        }
        void activateRemixlet(message.files, message.reloadTabId, undefined, message.message)
          .then((outcome) => recordConversationLink(outcome, message.conversationId))
          .then((outcome) => sendResponse({ kind: "remixlet.activated", outcome }));
        return true;
      case "remixlet.resolveCapabilityApproval":
        if (!message.approved) {
          void denyCapabilityProposal(message.proposalId).then(() => sendResponse({ kind: "remixlet.capabilityDenied" }));
          return true;
        }
        if (framedPanelTabMismatch(sender, message.reloadTabId)) {
          sendResponse({ kind: "remixlet.activated", outcome: { ok: false, reason: "failed", message: CROSS_TAB_REFUSED, rolledBack: false } });
          return false;
        }
        void activateRemixlet(message.files, message.reloadTabId, { proposalId: message.proposalId }, message.message)
          .then((outcome) => recordConversationLink(outcome, message.conversationId))
          .then((outcome) => sendResponse({ kind: "remixlet.activated", outcome }));
        return true;
      case "remixlet.list":
        void remixletStore()
          .list()
          .then((entries) => sendResponse({ kind: "remixlet.listed", entries }));
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
          .then(({ declared, granted }) =>
            sendResponse({ kind: "remixlet.capabilitiesResult", id: message.id, declared, granted }),
          )
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.revokeCapability":
        void revokeCapability(message.id, message.capability, { reloadMatching: true })
          .then(async (granted) => {
            const { declared } = await readRemixletCapabilities(message.id);
            sendResponse({ kind: "remixlet.capabilitiesResult", id: message.id, declared, granted });
          })
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
          .recordSuccessfulVerification(message.id, message.result)
          .then(async () => {
            const entry = (await remixletStore().list()).find((candidate) => candidate.id === message.id);
            if (!entry) throw new Error(`unknown remixlet ${message.id}`);
            sendResponse({ kind: "remixlet.verificationRecorded", entry });
          })
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "remixlet.recordVerifyFailure":
        if (framedPanelTabMismatch(sender, message.reloadTabId)) {
          sendResponse({ kind: "remixlet.error", message: CROSS_TAB_REFUSED });
          return false;
        }
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
      case "onboarding.finish":
        void finishOnboarding(sendResponse);
        return true;
      case "remixlet.read":
        void readVisibleRemixlet(message.id)
          .then(({ files, headSha, version }) => sendResponse({ kind: "remixlet.content", files, headSha, version }))
          .catch((error) => sendResponse({ kind: "remixlet.error", message: String(error) }));
        return true;
      case "page.probe": {
        if (framedPanelTabMismatch(sender, message.tabId)) {
          sendResponse({ kind: "page.probed", ok: false, message: CROSS_TAB_REFUSED });
          return false;
        }
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
        void handleProbeRequest(message.tabId, message.probe, message.params, message.conversationId)
          .then((reply) => sendResponse(reply))
          .catch((error) => sendResponse({ kind: "page.probed", ok: false, message: String(error) }));
        return true;
      }
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
      case "page.evaluate":
        if (framedPanelTabMismatch(sender, message.tabId)) {
          sendResponse({ kind: "page.evaluated", ok: false, message: CROSS_TAB_REFUSED });
          return false;
        }
        // Freeform code can mutate the page; invalidate BEFORE it runs so the
        // next capture is a full one even if the script throws mid-mutation.
        void invalidateCaptureDigestForTab(message.tabId)
          .then(() => evaluateInPage(message.tabId, message.code))
          .then((value) => sendResponse({ kind: "page.evaluated", ok: true, value }))
          .catch((error) => sendResponse({ kind: "page.evaluated", ok: false, message: String(error) }));
        return true;
      case "page.navigate":
        if (framedPanelTabMismatch(sender, message.tabId)) {
          sendResponse({ kind: "page.navigated", ok: false, message: CROSS_TAB_REFUSED });
          return false;
        }
        void navigateTab(message.tabId, message.url)
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
        // the tab the pill lives in — hide the drawer again, open markup mode.
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
        // only restores the drawer that annotation.start hid (idempotent — a
        // tab without a drawer just ignores the message).
        if (sender.tab?.id !== undefined) {
          void ext.tabs
            .sendMessage(sender.tab.id, { kind: "remixlet.drawer.visibility", visible: true })
            .catch(() => {});
        }
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
        void recordSiteIcon(message.siteKey, message.favIconUrl).catch(() => {});
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
 * Draw-on-page SPIKE: put the active tab into markup mode. The drawer (Arc's
 * in-page panel surface) occupies the right edge of the page, so it is hidden
 * for the duration — the annotation.result handler above restores it whether
 * or not this worker instance is the one that hid it (MV3 may have replaced
 * it while the user drew).
 */
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
  await ext.tabs.sendMessage(tabId, { kind: "remixlet.drawer.visibility", visible: false }).catch(() => {});
  try {
    await ext.scripting.executeScript({ target: { tabId }, files: ["annotate-host.js"], world: "ISOLATED" });
    // SAFETY: annotate-host.js responds with this payload after it is injected above.
    const reply = (await ext.tabs.sendMessage(tabId, { kind: ANNOTATE_OPEN_MESSAGE })) as { ok?: boolean } | undefined;
    if (!reply?.ok) throw new Error("The page did not accept markup mode.");
  } catch (error) {
    await ext.tabs.sendMessage(tabId, { kind: "remixlet.drawer.visibility", visible: true }).catch(() => {});
    throw error;
  }
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
): Promise<WorkerToPanel> {
  try {
    // Build agreement and the probe/params shape are both validated by the
    // caller (the "page.probe" switch case) before this runs.
    // observe_network_bodies reads the dev observer's buffer: gate on the
    // stored grant for this tab's origin, and inject the grant token's sync
    // event names server-side AFTER validation (worker-authored fields, spread
    // last so nothing model-supplied can shadow them; the token never enters
    // model context).
    let effectiveParams = params;
    if (probe === "observe_network_bodies") {
      const prepared = await devObserveProbeParams(tabId, params, conversationId);
      if (prepared[0] === undefined) return { kind: "page.probed", ok: false, message: prepared[1] };
      effectiveParams = prepared[0];
    }
    // A click mutates the page; invalidate the capture digest BEFORE it runs
    // so the next capture is a full one regardless of how the click lands.
    if (probe === "click_element") await invalidateCaptureDigestForTab(tabId);
    return { kind: "page.probed", ok: true, value: await runProbe(tabId, PROBE_TEMPLATES[probe], effectiveParams, PROBE_WORLDS[probe]) };
  } catch (error) {
    return { kind: "page.probed", ok: false, message: String(error) };
  }
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
      requestEvent: devObserveRequestEventName(grant.token),
      replyEvent: devObserveReplyEventName(grant.token),
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
  await recordDevObserveGrant({
    conversationId,
    origin: url.origin,
    token: crypto.randomUUID(),
    grantedAt: Date.now(),
  });
  await reconcileUserScripts();
  // The reload both arms the document_start observer and changes the page, so
  // the next capture must be a full one.
  await invalidateCaptureDigestForTab(tabId);
  await ext.tabs.reload(tabId).catch(() => {});
  return url.origin;
}

async function disableDevObserve(conversationId: string): Promise<void> {
  const removed = await removeDevObserveGrant(conversationId);
  if (removed) await reconcileUserScripts();
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
 */
async function readVisibleRemixlet(
  id: string,
): Promise<{ files: Record<string, string>; headSha: string; version: number }> {
  const store = remixletStore();
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry || entry.state === "archived") throw new Error(`unknown remixlet ${id}`);
  const { files } = await store.read(id);
  return { files, headSha: entry.headSha, version: entry.version };
}

/**
 * Onboarding's finish step. If this worker context already sees userScripts
 * (born after the toggle flip), reconcile and done. Otherwise the API can
 * only materialize in a fresh context: flag storage so boot reopens the
 * onboarding tab, reply first (the reload kills this context), then reload.
 */
async function finishOnboarding(sendResponse: (r: WorkerToPanel) => void): Promise<void> {
  if ((await verifiedCapabilities()).userScripts) {
    await syncMirror().catch((error) => console.error("[remixlet] onboarding sync failed", error));
    sendResponse({ kind: "onboarding.finished", reloading: false });
    return;
  }
  await ext.storage.local.set({ reopenOnboarding: true });
  sendResponse({ kind: "onboarding.finished", reloading: true });
  setTimeout(() => ext.runtime.reload(), 100);
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

async function handleCaptureRequest(request: CaptureRequest, conversationEpoch?: string): Promise<WorkerToPanel> {
  let result: Awaited<ReturnType<typeof capturePage>>;
  const drawerHidden = await ext.tabs
    .sendMessage(request.tabId, { kind: "remixlet.drawer.visibility", visible: false })
    .then((reply: { ok?: boolean } | undefined) => reply?.ok === true)
    .catch(() => false);
  try {
    result = await capturePage(request);
  } catch (error) {
    result = { ok: false, reason: "failed", message: String(error) };
  } finally {
    if (drawerHidden) {
      await ext.tabs
        .sendMessage(request.tabId, { kind: "remixlet.drawer.visibility", visible: true })
        .catch(() => {});
    }
  }
  if (!result.ok) return { kind: "capture.result", result };

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

// Messages from USER_SCRIPT-world scripts arrive on a dedicated event — the
// capability-bridge transport. Grants are enforced in handleBridgeMessage.
ext.runtime.onUserScriptMessage?.addListener((message: { kind?: string }, sender, sendResponse) => {
  if (message.kind === "rmx.ping") {
    sendResponse({ pong: "worker" });
    return false;
  }
  if (isBridgeMessage(message)) {
    void handleBridgeMessage(message, sender).then((reply) => sendResponse(reply));
    return true; // async sendResponse
  }
});
