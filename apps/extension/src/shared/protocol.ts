// Panel ↔ worker message protocol. Grows with the tool surface (wiki/plan.md §3).
// Every message is a tagged union member; no stringly-typed dispatch.

import type { PlatformCapabilities } from "../platform/capabilities.js";
import type { CodexAccount, CodexAuthStatus } from "./codex-oauth.js";
import type { CaptureRequest, CaptureResult } from "../platform/observation/types.js";
import type { CaptureRef } from "../store/capture-store.js";
import type { ConversationMeta } from "../store/conversation-index.js";
import type { RegistryEntry, RemixletVersion } from "../store/remixlet-store.js";
import type { ActivationOutcome, CapabilityApprovalProposal } from "../worker/activation.js";
import type { MenuCommandSummary } from "../worker/menu.js";
import type { PageMark } from "./annotation.js";
import type { ScriptLogEntry } from "./script-log.js";
import type { ShowChangesSummary, VerifiedAssertion } from "./show-changes.js";
import type { UsageRecord } from "./usage.js";
import type { ProbeName } from "./probe-schemas.js";

export type PanelToWorker =
  | { kind: "drawer.closed" }
  // Sent once by every panel document as it boots. The worker can see from the
  // sender whether this panel landed in a browser-owned sidebar or inside a
  // tab, and that is the only proof this browser's side panel is real rather
  // than a silent no-op (platform/panel-surface.ts).
  | { kind: "panel.hello" }
  | { kind: "capabilities.get" }
  // conversationEpoch identifies the panel's live conversation runtime (a
  // fresh id per tool belt). It scopes the worker's unchanged-page
  // short-circuit: a "you already have this capture" reply is only true for
  // the runtime that received the referenced capture — omitted or different,
  // the worker always returns full content.
  | { kind: "capture.request"; request: CaptureRequest; conversationEpoch?: string }
  // Remixlet lifecycle: the worker owns all store writes (single writer);
  // these back the agent's write_remixlet / list_remixlets / rollback tools
  // and, later, the history & manager UI.
  // message = the agent's commit message for this version (the store falls
  // back to "activate vN" when omitted). The commit happens on approval
  // resolution too, so the message rides both activation messages.
  // conversationId = the chat performing the write; the worker records the
  // conversation→remixlet link in the sidecar index atomically with the
  // activation, so the link survives a panel death right after the write.
  | { kind: "remixlet.activate"; files: Record<string, string>; message?: string; reloadTabId?: number; conversationId?: string }
  | {
      kind: "remixlet.resolveCapabilityApproval";
      proposalId: string;
      approved: boolean;
      files: Record<string, string>;
      message?: string;
      reloadTabId?: number;
      conversationId?: string;
    }
  | { kind: "remixlet.list" }
  | { kind: "remixlet.read"; id: string }
  | { kind: "remixlet.setEnabled"; id: string; enabled: boolean; reloadTabId?: number; reloadMatching?: boolean }
  // Trust surface: the capabilities a remixlet declares vs. currently holds, and
  // per-capability revocation (the only way to walk back one grant short of
  // deleting the whole remixlet). Revoke reloads the remixlet's matching tabs so
  // already-injected code loses the capability immediately.
  | { kind: "remixlet.capabilities"; id: string }
  | { kind: "remixlet.revokeCapability"; id: string; capability: string }
  | { kind: "remixlet.versions"; id: string }
  | { kind: "remixlet.rollback"; id: string; sha: string; reloadTabId?: number; reloadMatching?: boolean }
  | {
      kind: "remixlet.resolveRollbackCapabilityApproval";
      proposalId: string;
      approved: boolean;
      id: string;
      sha: string;
      reloadTabId?: number;
      reloadMatching?: boolean;
    }
  // M3 trust surface: soft-delete/restore, per-file version diffs for the
  // history UI, per-site pause. reloadMatching = "applied live" — the worker
  // reloads every open tab the remixlet's matches cover.
  | { kind: "remixlet.remove"; id: string; reloadTabId?: number; reloadMatching?: boolean }
  | { kind: "remixlet.restore"; id: string }
  // Hard delete: artifact, git history, grants — gone for good. The manager
  // UI sends this only after an explicit confirmation dialog; it is the one
  // lifecycle message restore cannot undo.
  | { kind: "remixlet.destroy"; id: string; reloadTabId?: number; reloadMatching?: boolean }
  // fromSha omitted = diff against the commit's real first parent (the
  // install commit has none: all adds).
  | { kind: "remixlet.diff"; id: string; toSha: string; fromSha?: string }
  // Full snapshot of every tracked file at a commit — the manager's per-version
  // code browser.
  | { kind: "remixlet.filesAt"; id: string; sha: string }
  // Bounded runtime log ring the bridge records per remixlet (captured
  // console output + errors/warnings, worker/script-log.ts) — the agent's
  // read_remixlet_logs tool. id omitted = entries for every remixlet.
  | { kind: "remixlet.readScriptLog"; id?: string }
  // Per-remixlet run counters the injection gate reports (worker/usage.ts) —
  // the control center's home dashboard.
  | { kind: "usage.read" }
  | {
      kind: "remixlet.recordVerification";
      id: string;
      // assertions = the fully passing assert_page_state run's params
      // (shared/show-changes.ts) — the spots "Show what changed" highlights.
      result: {
        ok: true;
        url: string;
        verifiedAt: string;
        version: number;
        headSha: string;
        assertions?: VerifiedAssertion[];
        conversationId?: string;
      };
    }
  // The failed-exit cleanup: a turn COMPLETED with an activation whose final
  // verification did not pass (or was blocked by the runtime safety check).
  // Panel-sent from the run loop's settle point — after the model stopped —
  // and from the auto-resume cap exhausting. The worker records the outcome
  // durably (lastVerifyResult), then rolls the code back to the last verified
  // version when one exists, else parks the remixlet as "needs-attention".
  | {
      kind: "remixlet.recordVerifyFailure";
      id: string;
      outcome: "failed" | "blocked";
      at: string;
      summary?: string;
      conversationId?: string;
      reloadTabId?: number;
    }
  // "Show what changed": inject the highlight overlay into the tab and mark
  // the spots the remixlet's stored verification assertions describe
  // (shared/show-changes.ts). Sent from the panel's button on the current
  // version's "vN applied" divider.
  | { kind: "showChanges.start"; tabId: number; id: string }
  | { kind: "site.setPaused"; siteKey: string; paused: boolean; reloadTabId?: number; reloadMatching?: boolean }
  | { kind: "site.pausedList" }
  | { kind: "menu.list"; tabId: number }
  | { kind: "menu.invoke"; tabId: number; registrationId: string }
  // Onboarding's "finish setup": if the worker's own context already sees
  // userScripts it just reconciles; otherwise it flags storage and reloads
  // the extension (the one sanctioned runtime.reload — a fresh worker context
  // is the only way the API materializes there).
  | { kind: "onboarding.finish" }
  // Page probing for the agent's verification loops. probe runs a fixed
  // extension-authored template (src/worker/page-probes/) with the model's
  // params crossing only as JSON data — the default lane. evaluate runs a
  // freeform code string the same way, but is the approval-gated escape
  // hatch: the panel shows the code to the user and sends this only after an
  // explicit click. Both use userScripts.execute in the USER_SCRIPT world —
  // the sanctioned dynamic-code lane, same sandbox remixlets live in. The
  // worker revalidates probe params against probe-schemas at this boundary.
  // buildId is the sender's compiled-in build stamp (shared/build-id.ts); the
  // worker refuses the probe with a named "build mismatch" error when it
  // differs from its own, so a stale worker cannot masquerade as a schema
  // error against a fresher panel's params.
  // conversationId (panel-sourced, never model-supplied — it rides beside
  // `params`, not inside it) scopes the observe_network_bodies grant gate to
  // the conversation that was granted observation, so a lingering grant from
  // another conversation on the same origin cannot authorize this read.
  | { kind: "page.probe"; tabId: number; probe: ProbeName; params: unknown; buildId: string; conversationId?: string }
  | { kind: "page.evaluate"; tabId: number; code: string }
  | { kind: "page.navigate"; tabId: number; url: string }
  // Development-time observation grant (wiki/raw/handoffs/
  // 2026-08-10-broad-observe-session-grant.md). enable is sent ONLY from the
  // panel's dev-observe card click handler: the worker pins the grant to the
  // active tab's origin, registers the MAIN-world observer for this
  // conversation, and reloads the tab so load-time traffic lands in the
  // buffer. disable clears the grant (conversation switch/close); expiry is
  // the worker-side TTL backstop. Never a manifest capability — the record
  // lives outside the durable capability grant store.
  | { kind: "devObserve.enable"; conversationId: string; tabId: number }
  | { kind: "devObserve.disable"; conversationId: string }
  // Annotate-page mode (shared/annotation.ts). start: the panel's pencil
  // button — the worker hides the drawer, injects annotate-host.js, and opens
  // markup mode on the tab. result: sent BY the overlay content script (like
  // drawer.closed, a tab-sender message) when the user finishes; the worker
  // restores the drawer, and the panel — which receives the same broadcast —
  // takes the payload as the next prompt's attachment. reopen: sent by the
  // overlay's idle pill after Done — the worker re-runs the start pipeline
  // for the sender's tab.
  | { kind: "annotation.start"; tabId: number }
  | { kind: "annotation.result"; cancelled: boolean; url: string; marks: PageMark[] }
  | { kind: "annotation.reopen" }
  // Codex subscription OAuth (wiki/handoff.md §6.1). begin/status/signOut come from
  // the panel settings UI; callback comes from oauth-callback.html;
  // getAccessToken is the provider's per-call token fetch (worker refreshes
  // single-flight); invalidateAccessToken is the 401-recovery path.
  | { kind: "codex.begin" }
  | { kind: "codex.status" }
  | { kind: "codex.signOut" }
  | { kind: "codex.getAccessToken" }
  | { kind: "codex.invalidateAccessToken" }
  | { kind: "codex.callback"; code: string; state: string }
  // Conversation sidecar index (wiki/handoff.md §8). The panel writes its session
  // JSONL itself (one panel = one conversation = one writer), but index
  // updates funnel through the worker so concurrent panels can't tear the file.
  | { kind: "conversation.upsert"; meta: { id: string } & Partial<Omit<ConversationMeta, "id">> }
  | { kind: "conversation.list" }
  // Site favicon snapshots: the panel reports the bound tab's favicon when a
  // chat binds (worker/site-icons.ts fetches + stores it once per source URL);
  // the control center reads them back to decorate site names.
  | { kind: "siteIcon.record"; siteKey: string; favIconUrl?: string }
  | { kind: "siteIcon.refresh"; siteKey: string }
  | { kind: "siteIcon.list" };

export type WorkerToPanel =
  | { kind: "drawer.closedAck" }
  | { kind: "panel.helloAck" }
  | { kind: "capabilities.result"; capabilities: PlatformCapabilities }
  // On success, `ref` points at the persisted copy in OPFS captures/ (absent
  // only if persistence failed — then bundle.missing says so).
  // unchangedSince set = the page digests identically to that earlier capture
  // in the SAME conversation and nothing page-mutating happened in between:
  // the panel renders a short unchanged notice instead of resending ~41KB of
  // identical content. The bundle is slimmed on that path (no dom/screenshot),
  // so the panel structurally cannot re-attach content it should not resend.
  | {
      kind: "capture.result";
      result: CaptureResult;
      ref?: CaptureRef;
      unchangedSince?: { ref: CaptureRef; capturedAt: string };
    }
  | { kind: "remixlet.activated"; outcome: ActivationOutcome }
  | { kind: "remixlet.capabilityDenied" }
  | { kind: "remixlet.listed"; entries: RegistryEntry[] }
  // headSha/version let the panel's read_remixlet tool answer a re-read of
  // unchanged content with a short notice instead of resending every file.
  | { kind: "remixlet.content"; files: Record<string, string>; headSha: string; version: number }
  | { kind: "remixlet.versionsListed"; versions: RemixletVersion[] }
  | { kind: "remixlet.capabilitiesResult"; id: string; declared: string[]; granted: string[] }
  | { kind: "remixlet.entry"; entry: RegistryEntry }
  // Reply to remixlet.destroy — no entry to return; it no longer exists.
  | { kind: "remixlet.destroyed"; id: string }
  | { kind: "remixlet.rollbackApprovalRequired"; proposal: CapabilityApprovalProposal }
  | { kind: "remixlet.error"; message: string }
  // Only paths that actually changed; absent side = file added/removed.
  | { kind: "remixlet.diffResult"; files: { path: string; before?: string; after?: string }[] }
  | { kind: "remixlet.filesAtResult"; files: Record<string, string> }
  | { kind: "remixlet.scriptLog"; entries: ScriptLogEntry[] }
  | { kind: "usage.result"; usage: Record<string, UsageRecord> }
  | { kind: "remixlet.verificationRecorded"; entry: RegistryEntry }
  // action says what the cleanup actually did, so the panel's plain-words
  // action row states the truth ("put back the last working version" vs
  // "switched it off") instead of guessing.
  | { kind: "remixlet.verifyFailureRecorded"; entry: RegistryEntry; action: "rolled-back" | "needs-attention" }
  | { kind: "site.pausedState"; pausedSiteKeys: string[] }
  | { kind: "menu.listed"; commands: MenuCommandSummary[] }
  | { kind: "menu.invoked"; queued: boolean }
  | { kind: "onboarding.finished"; reloading: boolean }
  | { kind: "annotation.started"; ok: boolean; message?: string }
  | { kind: "annotation.resultAck" }
  // summary reports what the overlay actually drew — highlighted marks plus
  // the honest remainders (selectors that no longer match, absence
  // assertions with nothing to point at).
  | { kind: "showChanges.started"; ok: true; summary: ShowChangesSummary }
  | { kind: "showChanges.started"; ok: false; message: string }
  | { kind: "page.probed"; ok: true; value: string }
  | { kind: "page.probed"; ok: false; message: string }
  // origin = the exact origin the grant was pinned to (shown nowhere raw, but
  // threaded into the panel-authored continuation prompt).
  | { kind: "devObserve.enabled"; ok: true; origin: string }
  | { kind: "devObserve.enabled"; ok: false; message: string }
  | { kind: "devObserve.disabled" }
  | { kind: "page.evaluated"; ok: true; value: string }
  | { kind: "page.evaluated"; ok: false; message: string }
  | { kind: "page.navigated"; ok: boolean; message?: string }
  | { kind: "codex.begun"; ok: boolean; message?: string }
  | { kind: "codex.statusResult"; status: CodexAuthStatus }
  | { kind: "codex.signedOut" }
  | { kind: "codex.accessToken"; ok: true; accessToken: string }
  | { kind: "codex.accessToken"; ok: false; message: string }
  | { kind: "codex.accessTokenInvalidated" }
  | { kind: "codex.callbackResult"; ok: boolean; message?: string; account?: CodexAccount }
  | { kind: "conversation.upserted"; meta: ConversationMeta }
  | { kind: "conversation.listed"; conversations: ConversationMeta[] }
  | { kind: "siteIcon.recorded" }
  // dataUrl is the snapshot now stored for the refreshed key, absent when the
  // re-capture found nothing (bad host, no /favicon.ico, oversized body).
  | { kind: "siteIcon.refreshed"; dataUrl?: string }
  // dataUrl per site key — render-ready, nothing to fetch.
  | { kind: "siteIcon.listed"; icons: Record<string, string> };

/**
 * What actually crosses the wire back to a page: the worker's listener stamps
 * every reply with its compiled-in build id (shared/build-id.ts), and
 * requireWorkerReply refuses stamps that differ from the page's own. That
 * names the "stale running worker, fresh page" state (an unpacked rebuild
 * without an extension reload) at the transport boundary, instead of letting
 * a reply that predates the page's types surface as a missing-field crash in
 * UI code. Handlers author plain WorkerToPanel replies; the stamp is added in
 * one place, the worker's onMessage listener.
 */
export type StampedWorkerToPanel = WorkerToPanel & { buildId: string };
