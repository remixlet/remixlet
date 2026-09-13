// Side panel app: the agent host (wiki/handoff.md §3 — the agent lives HERE, in a
// long-lived document). Chat UI + AgentRuntime + tool dispatch. A turn
// requires the panel open; closing it aborts the turn — that contract is why
// none of this lives in the worker.
//
// UI is the shadcn (Base UI) design system; see src/components/ui/. Contract
// with the conversation suite: #input, #composer (requestSubmit), #chat with
// `.msg <kind>` children, and body[data-rmx-turn] running/idle transitions.

import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  ArrowLeft,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  History,
  Info,
  MessageSquarePlus,
  PenLine,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Response } from "@/components/ui/response";

import {
  catalogModel,
  ConversationSession,
  createAgentRuntime,
  endpointPlan,
  isContractNudgePrompt,
  isFeaturedModel,
  ProviderTurnError,
  resumeVerificationPrompt,
  supportedThinkingLevels,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentPromptOptions,
  type ModelWaitEvent,
  type ProviderEndpoint,
  type SessionTranscriptItem,
  type ThinkingLevel,
} from "../agent/index.js";
import type { PlatformCapabilities } from "../platform/capabilities.js";
import { TabBinding, type BoundTab } from "./tab-binding.js";
import { focusTab } from "../platform/active-tab.js";
import { ext } from "../platform/ext.js";
import { clearAskNotification, showAskNotification } from "../platform/notifications.js";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  availableModels,
  normalizeProviderSettings,
  providerRuntimeFingerprint,
  recordProviderOutcome,
  selectedProvider,
  selectedThinkingLevel,
  settingsComplete,
  thinkingLevelKey,
  type AvailableModel,
  type ProviderSettings,
} from "../shared/settings.js";
import {
  approvalDialogTitle,
  capabilityExplanation,
  capabilityGrantActionLabel,
  capabilityGrantFromPrompt,
  capabilityGrantPrompt,
  capabilityRemovalNote,
  capabilityRequestFromVerdict,
  DEV_OBSERVE_EXPLANATION,
  DEV_OBSERVE_GRANT_ACTION_LABEL,
  devObserveGrantPrompt,
  devObserveRequestFromVerdict,
  isDevObserveGrantPrompt,
  scopeExplanation,
  type PendingCapabilityRequest,
} from "./capability-request.js";
import {
  describeTool,
  HELD_ICON,
  hostOf,
  MessageBody,
  runErrorDisplayText,
  settledToolMessage,
  transcriptMessage,
  type ActivityState,
  type MessageKind,
  type ToolPhrase,
} from "./chat-phrases.js";
import { askNotificationCopy, panelViewFacts, shouldNotifyForAsk, type PendingAskKind } from "./ask-notifications.js";
import { PermissionCard } from "./permission-card.js";
import { DEV_OBSERVE_ICON, SCOPE_ICON, capabilityIcon } from "../shared/capability-icon.js";
import { StartHere, useActivePage } from "./start-here.js";
import { TurnStatus } from "./turn-status.js";
import { SiteIcon } from "../ui/site-icon.js";
import { ProviderLogo } from "../ui/provider-settings/provider-logo.js";
import { groupByDay, timeFormat } from "../ui/control-center/day-groups.js";
import { routeHash } from "../ui/control-center/router.js";
import { explicitVerificationRecord } from "./verification.js";
import { sanitizeLookReview } from "../shared/look-review.js";
import type { ConversationMeta } from "../store/conversation-index.js";
import type { RegistryEntry } from "../store/remixlet-store.js";
import type { CapabilityApprovalProposal } from "../worker/activation.js";
import {
  ANNOTATE_CLEAR_MESSAGE,
  ANNOTATION_RESULT_KIND,
  appendAnnotationToPrompt,
  splitAnnotationFromPrompt,
  type AnnotationResultPayload,
} from "../shared/annotation.js";
import {
  CHAT_PREFERENCES_KEY,
  DEFAULT_CHAT_PREFERENCES,
  codexTextVerbosity,
  normalizeChatPreferences,
  verbosityShowsWorkingNotes,
  type ChatPreferences,
} from "../shared/chat-preferences.js";
import { systemPromptFor } from "./system-prompt.js";
import { buildTools } from "./tools/index.js";
import { sendRaw, sendToWorker } from "./worker-client.js";

// A version event marks the end of an exchange that activated a remixlet.
// Each divider is a restore point: lines for versions other than the
// remixlet's current one offer "Revert", which rolls back TO that line's
// version. It renders as a divider, NOT as a `.msg` row — the conversation
// suite reconstructs transcripts from `#chat .msg` and must not see these.
interface VersionEvent {
  remixletId: string;
  remixletName: string;
  version: number;
}
interface ChatMessage {
  id: number;
  kind: MessageKind;
  text: string;
  icon?: LucideIcon;
  state?: ActivityState;
  versionEvent?: VersionEvent;
  // A notice about the chat itself rather than about the work — currently
  // only "switched model". Rendered in the same divider frame as a version
  // event, and like it, deliberately not a `.msg` row.
  notice?: boolean;
  // The model's working notes (thinking stream), shown only at the "detailed"
  // verbosity level. Rendered as a muted row, deliberately NOT a `.msg` row —
  // the conversation suite reconstructs transcripts from `#chat .msg`, and
  // working notes are not part of the transcript.
  thinking?: boolean;
}

interface QueuedPrompt {
  id: number;
  text: string;
}

// Bounded auto-resume of an owed verification. When a conversation resumes on
// top of an unverified activation (the verifying turn died with the runtime —
// a panel closed or killed right after the activation's reload), the panel
// drives a verify-or-fix continuation. Each attempt can itself trigger a fix
// that re-activates and reloads, so the count must be DURABLE — it survives the
// reload the way the in-memory obligation cannot. The cap turns "loop until it
// works" into "loop a few times, then hand back to the user" so a genuinely
// unfixable feature never loops forever.
const VERIFY_RESUME_LIMIT = 4;
const verifyResumeKey = (conversationId: string): string => `remixletVerifyResume:${conversationId}`;

function isAnnotationResultMessage(
  message: AnnotationResultPayload | { kind?: string },
): message is AnnotationResultPayload & { kind: typeof ANNOTATION_RESULT_KIND } {
  if (!(message instanceof Object)) return false;
  return (
    Object.getOwnPropertyDescriptor(message, "kind")?.value === ANNOTATION_RESULT_KIND &&
    Array.isArray(Object.getOwnPropertyDescriptor(message, "marks")?.value)
  );
}

async function readVerifyResumeCount(conversationId: string): Promise<number> {
  const key = verifyResumeKey(conversationId);
  const stored = await ext.storage.session.get(key).catch(() => ({}));
  const value = Object.getOwnPropertyDescriptor(stored, key)?.value;
  return Number.isFinite(value) ? value : 0;
}

async function bumpVerifyResumeCount(conversationId: string): Promise<number> {
  const next = (await readVerifyResumeCount(conversationId)) + 1;
  await ext.storage.session.set({ [verifyResumeKey(conversationId)]: next }).catch(() => {});
  return next;
}

// The stored failure summary: "condition selector" per failed assertion, a few
// words each, from the assert tool's failedAssertions details (model-authored
// params, never page text). Bounded — it decorates one inventory line.
function failedAssertionSummary(failed: Extract<AgentRuntimeEvent, { kind: "tool_end" }>["details"]): string | undefined {
  if (!Array.isArray(failed)) return undefined;
  const parts = failed
    .map((entry) => {
      if (!(entry instanceof Object) || Array.isArray(entry)) return undefined;
      // SAFETY: the object check above excludes primitives and arrays before reading assertion fields.
      const { condition, selector } = entry as { condition?: string; selector?: string };
      if (!condition) return undefined;
      return selector ? `${condition} ${selector}` : condition;
    })
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  return parts.join("; ").slice(0, 300);
}

function clearVerifyResumeCount(conversationId: string): void {
  void ext.storage.session.remove(verifyResumeKey(conversationId)).catch(() => {});
}

// ---- settings ---------------------------------------------------------------

async function loadSettings(): Promise<ProviderSettings> {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeProviderSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(settings: ProviderSettings): Promise<void> {
  await ext.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function loadChatPreferences(): Promise<ChatPreferences> {
  const stored = await ext.storage.local.get(CHAT_PREFERENCES_KEY);
  return normalizeChatPreferences(stored[CHAT_PREFERENCES_KEY]);
}

// Provider health, written at the only moments a provider is actually
// contacted (a chat turn settling). The Providers page renders these fields;
// nothing anywhere polls a provider to compute them. Best-effort: a storage
// hiccup must never affect the turn itself.
function recordProviderTurnOutcome(providerId: string, outcome: { ok: true } | { ok: false; message: string }): void {
  void loadSettings()
    .then((settings) =>
      saveSettings(
        recordProviderOutcome(
          settings,
          providerId,
          outcome.ok ? { ok: true, at: new Date().toISOString() } : { ok: false, error: outcome.message },
        ),
      ),
    )
    .catch((cause) => console.error("[remixlet] provider health record failed", cause));
}

// Vision capability per endpoint: Anthropic/Google/Codex model families all
// accept images; for OpenAI-compatible endpoints only known multimodal
// families do — unknown (local/proxied) model ids stay text-only, and pi
// swaps attached images for a text placeholder, so guessing low is safe.
function modelSupportsImages(modelId: string): boolean {
  return /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt|^o[134](-|$))/i.test(modelId);
}

/** The pi catalog's display name for a model, falling back to the raw id. */
function modelDisplayName(model: { providerKind: string; modelId: string }): string {
  return catalogModel(model.providerKind, model.modelId)?.name ?? model.modelId;
}

// UI copy for pi's provider-neutral levels ("xhigh" is not a word).
const THINKING_LEVEL_LABELS = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
} satisfies Record<ThinkingLevel, string>;

async function buildEndpoint(settings: ProviderSettings): Promise<ProviderEndpoint> {
  const provider = selectedProvider(settings);
  const selection = settings.selectedModel;
  if (!provider || !selection) throw new Error("Choose a model before starting a chat.");

  if (provider.kind === "codex") {
    const { status: auth } = await sendToWorker({ kind: "codex.status" }, "codex.statusResult");
    if (auth.state !== "signed-in") throw new Error("Not signed in to ChatGPT — open model provider settings.");
    return {
      api: "openai-codex-responses",
      baseUrl: provider.baseUrl,
      modelId: selection.modelId,
      vision: true,
      thinkingLevels: provider.modelThinking?.[selection.modelId]?.levels,
      getAccessToken: async () => {
        const reply = await sendToWorker({ kind: "codex.getAccessToken" }, "codex.accessToken");
        if (!reply.ok) throw new Error(reply.message);
        return reply.accessToken;
      },
    };
  }
  // The catalog decides which API this provider/model pair speaks and whether
  // it can see images; models pi doesn't know fall back to per-kind defaults —
  // Anthropic/Google model families all accept images, while for
  // OpenAI-compatible endpoints only known multimodal families do.
  const plan = endpointPlan(provider.kind, selection.modelId);
  if (plan.api === "openai-codex-responses") throw new Error("Choose a model before starting a chat.");
  const fallbackVision =
    provider.kind === "anthropic" || provider.kind === "google" ? true : modelSupportsImages(selection.modelId);
  return {
    api: plan.api,
    provider: provider.kind,
    baseUrl: provider.baseUrl,
    modelId: selection.modelId,
    apiKey: provider.apiKey,
    vision: plan.vision ?? fallbackVision,
  };
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Current version per remixlet activated this session — decides which
  // version-event divider is the live one (no Revert button) versus a restore
  // point. Keyed by remixlet id; reset with the message list, since dividers
  // exist only in-session.
  const [currentVersions, setCurrentVersions] = useState<Record<string, number>>({});
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState("");
  // Hover hint for the composer's status cap — replaces native title
  // tooltips on action buttons. Held separately from statusText so it can
  // sit on top while hovering and let the underlying message return after.
  const [hoverHint, setHoverHint] = useState("");
  // A run starting or ending disables/unmounts hovered controls (the stop
  // button vanishes, others grey out), and a disabled or removed element
  // never fires mouseleave — drop the hint so it can't stick.
  useEffect(() => setHoverHint(""), [running]);
  const [elapsedMs, setElapsedMs] = useState(0);
  // The model call in flight, as the runtime last reported it (model_wait
  // events; null between calls and while tools run). Drives the running
  // indicator's words: a long quiet and each retry become visible instead of
  // the spinner alone.
  const [modelWait, setModelWait] = useState<ModelWaitEvent | null>(null);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [approvalProposal, setApprovalProposal] = useState<CapabilityApprovalProposal | null>(null);
  // The end-of-turn capability ask (capability-request.ts): shown only once the
  // turn has settled, because mid-turn the agent may still find a cheaper rung.
  const [capabilityRequest, setCapabilityRequest] = useState<PendingCapabilityRequest | null>(null);
  // The end-of-turn development-time observation ask (a "needs-network-
  // visibility" verdict): same settle-first lifecycle as the capability card.
  const [devObserveRequest, setDevObserveRequest] = useState(false);
  // Chat is the default; "history" swaps the transcript area for the
  // conversation list (M3 history menu over the sidecar index).
  const [view, setView] = useState<"chat" | "history">("chat");
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  // Snapshotted favicons by site key, fetched alongside the conversation list
  // so history rows carry the same site icons as the control center's Chats
  // index. `undefined` = not loaded yet (SiteIcon shows the globe without
  // asking the worker for a re-capture).
  const [siteIcons, setSiteIcons] = useState<Record<string, string> | undefined>(undefined);
  // Annotate-page mode: the last finished markup result, held as an
  // attachment card on the composer until the next send attaches it (or the
  // user discards it). The overlay keeps the marks visible on the page until
  // then — annotationTabRef remembers which tab to tell to clear them.
  const [pendingAnnotation, setPendingAnnotation] = useState<AnnotationResultPayload | null>(null);
  const annotationTabRef = useRef<number | undefined>(undefined);
  const [annotating, setAnnotating] = useState(false);

  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS);
  const [providerReady, setProviderReady] = useState(false);

  // The user's current tab, tracked live (start-here.ts): the empty state
  // previews it, and the composer gate below refuses to start a chat on a
  // page remixlets cannot touch.
  const activePage = useActivePage();

  // Composer card state (sidebar-composer redesign): the whole card takes the
  // focus ring while the textarea has focus; the send button's enabled look
  // tracks whether there is anything to send (the textarea stays uncontrolled
  // — the conversation suite sets #input.value directly, so this state is a
  // visual mirror, never the source of truth); the model and reasoning menus
  // expand inside the card below the toolbar, one at a time.
  const [composerFocused, setComposerFocused] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const [composerMenu, setComposerMenu] = useState<"model" | "reasoning" | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [allModelsOpen, setAllModelsOpen] = useState(false);
  // Keyboard cursor over the menu's rows (models and the "All models"
  // disclosure alike); focus itself stays on the search input throughout.
  const [activeModelIndex, setActiveModelIndex] = useState(0);

  // Conversation↔tab binding mirrors (tab-binding.ts): the chip renders
  // boundTab; the blocking decision screen renders bindingIssue. The binding
  // itself lives in tabBindingRef below and is swapped with the session refs
  // on new/resume. Both kinds carry the site so the screen can reopen it.
  const [boundTab, setBoundTab] = useState<BoundTab | undefined>(undefined);
  // "moved" carries `now` as well: the tab is still open and still bound, it
  // is just showing somewhere else, and naming that somewhere is what makes
  // the card readable ("now showing bank.com"). Empty when the tab is on a
  // page with no site to name (a PDF, a browser page).
  const [bindingIssue, setBindingIssue] = useState<
    | { kind: "tab-closed"; siteKey: string }
    | { kind: "no-site-tab"; siteKey: string }
    | { kind: "moved"; siteKey: string; now: string }
    | null
  >(null);

  const runtimeRef = useRef<AgentRuntime | undefined>(undefined);
  const runtimeProviderKindRef = useRef<string | undefined>(undefined);
  // Which provider the live runtime talks to, so a settled turn can stamp
  // that provider's lastUsedAt / lastError in settings (provider health).
  const runtimeProviderIdRef = useRef<string | undefined>(undefined);
  const streamingIdRef = useRef<number | null>(null);
  // The working-notes row currently being streamed into (verbosity
  // "detailed"). Any non-thinking event closes it, so each burst of notes
  // between steps reads as its own row.
  const thinkingIdRef = useRef<number | null>(null);
  // Read synchronously by the event handler; refreshed on boot and whenever
  // the Settings page writes the key (storage listener below).
  const chatPrefsRef = useRef<ChatPreferences>(DEFAULT_CHAT_PREFERENCES);
  // toolCallId → the chat message showing that step, so tool_end can update the
  // same line (running → done/failed) instead of printing a second one.
  const toolMsgRef = useRef<Map<string, { id: number; phrase: ToolPhrase }>>(new Map());
  const nextIdRef = useRef(0);
  const nextQueuedIdRef = useRef(0);
  const runningRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // One conversation at a time, persisted as sessions/<id>.jsonl. The history
  // menu swaps which one by pointing these refs at another id — the session
  // machinery (open → sanitized resume) is the same either way.
  const conversationIdRef = useRef<string>(crypto.randomUUID());
  // The tab this conversation's agent works on. Bound at the first message
  // (or resume), then fixed: tools resolve through it instead of "the active
  // tab", so the user can browse other tabs while a turn runs. Only an
  // explicit user click (chip/card button) or a conversation switch rebinds.
  const tabBindingRef = useRef<TabBinding | null>(null);
  function newTabBinding(): TabBinding {
    return new TabBinding({
      onChange: (bound) => {
        setBoundTab(bound);
        if (bound) setBindingIssue(null);
        // Snapshot the site's favicon while a tab on it is at hand — the
        // manager's lists have no page to ask later. The worker dedupes by
        // source URL, so repeated binds on one site are a cheap no-op.
        if (bound && bound.siteKey) {
          void sendToWorker(
            { kind: "siteIcon.record", siteKey: bound.siteKey, pageOrigin: bound.origin, favIconUrl: bound.favIconUrl },
            "siteIcon.recorded",
          ).catch(() => {});
        }
      },
      onLost: (previous) => setBindingIssue({ kind: "tab-closed", siteKey: previous.siteKey }),
      // The bound tab is showing another site. Two things happen, and the
      // order matters: the approval given for the page being LEFT is
      // dropped first, then the card goes up. The dev-observe grant was
      // pinned to one origin; it does not travel with the tab.
      onMoved: (previous, now) => {
        void sendToWorker(
          { kind: "devObserve.disable", conversationId: conversationIdRef.current },
          "devObserve.disabled",
        ).catch(() => {});
        setBindingIssue({ kind: "moved", siteKey: previous.siteKey, now });
      },
      // Back on the site under their own steam: the card comes down and tools
      // resolve again. The grant dropped above stays dropped: it was
      // answered about a page that has been replaced since.
      onReturned: () => setBindingIssue((issue) => (issue?.kind === "moved" ? null : issue)),
    });
  }
  tabBindingRef.current ??= newTabBinding();
  const sessionRef = useRef<ConversationSession | undefined>(undefined);
  const indexedRef = useRef(false);
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const pendingVerificationRef = useRef<RegistryEntry | undefined>(undefined);
  // What the latest look_at_change framed, so record_look's stored verdict
  // names the control and whether a crop of it was stored.
  const lookSubjectRef = useRef<string | undefined>(undefined);
  const lookCropStoredRef = useRef(false);
  // The failed-exit evidence: the last post-activation assert_page_state that
  // did NOT pass, for the activation pendingVerificationRef still holds. When
  // a turn COMPLETES (not dies) with both refs set for the same remixlet, the
  // harness — not the model — acts on the exit: the worker records the failure
  // durably and rolls back to the last verified version or parks the remixlet
  // as needs-attention. Cleared by a fresh write (the obligation re-arms
  // against the newer activation) and by a passing verification.
  const failedVerificationRef = useRef<
    { remixletId: string; outcome: "failed" | "blocked"; summary?: string } | undefined
  >(undefined);
  // The remixlet version this turn activated, if any. Settled into a version
  // event divider when the turn ends — the divider separates exchanges, so it
  // must land after the exchange's activity rows and reply, not mid-list.
  const appliedVersionRef = useRef<RegistryEntry | undefined>(undefined);
  const pendingCapabilityRequestRef = useRef<PendingCapabilityRequest | undefined>(undefined);
  // Capabilities the user one-click authorized via the #capability-request card
  // and no build has spent yet. The grant lives at CONVERSATION scope: it is
  // threaded into every turn (so the agent can plan and build with it), it
  // auto-approves an activation whose added capabilities all fall inside it,
  // and it is consumed by the first successful write_remixlet. Surviving
  // interruptions is the point — a SoundCloud run showed a "why did you stop?"
  // between the click and the build forcing the user to Allow the identical
  // access a second time. Anything outside the set still gets the dialog, and
  // switching conversations clears it.
  const unspentGrantRef = useRef<Set<string> | null>(null);
  // The dev-observe ask/grant pair (wiki/raw/handoffs/2026-08-10-broad-observe-
  // session-grant.md), conversation-scoped like the refs above. The pending
  // ref parks a "needs-network-visibility" verdict until the turn settles; the
  // granted ref remembers the Allow click for the rest of the conversation —
  // it suppresses re-asks, marks the continuation turn out-of-band
  // (AgentPromptOptions.devObserveGranted), and is cleared on conversation
  // switch/close alongside a worker-side disable. Read authority lives in the
  // worker's stored grant, never in these refs.
  const pendingDevObserveRequestRef = useRef(false);
  const devObserveGrantedRef = useRef(false);

  function addMessage(kind: MessageKind, text: string, icon?: LucideIcon, state: ActivityState = "done"): number {
    const id = ++nextIdRef.current;
    setMessages((prev) => [...prev, { id, kind, text, icon, state }]);
    return id;
  }

  // The "vN applied" divider that closes an exchange which activated a
  // remixlet. kind "tool" is nominal — versionEvent rows render as a divider
  // without the `.msg` class, invisible to the conversation suite.
  function addVersionEvent(entry: RegistryEntry): void {
    const id = ++nextIdRef.current;
    setCurrentVersions((prev) => ({ ...prev, [entry.id]: entry.version }));
    setMessages((prev) => [
      ...prev,
      {
        id,
        kind: "tool",
        text: `v${entry.version} applied`,
        versionEvent: { remixletId: entry.id, remixletName: entry.name, version: entry.version },
      },
    ]);
  }

  // A divider marking a change to the chat itself, in the same frame as the
  // version events. kind "tool" is nominal, as above.
  function addNotice(text: string): void {
    const id = ++nextIdRef.current;
    setMessages((prev) => [...prev, { id, kind: "tool", text, notice: true }]);
  }

  // Revert on a version divider: roll the remixlet back TO the version that
  // divider announced (the button only shows on non-current versions). The
  // store's rollback moves `main`; a rollback that would restore extra
  // capabilities routes through the same approval dialog the agent's
  // activations use.
  function revertVersionEvent(versionEvent: VersionEvent): void {
    if (runningRef.current) return;
    void (async () => {
      try {
        const { versions } = await sendToWorker(
          { kind: "remixlet.versions", id: versionEvent.remixletId },
          "remixlet.versionsListed",
        );
        const target = versions.find((candidate) => candidate.version === versionEvent.version);
        if (!target) {
          addMessage("error", `Couldn't find v${versionEvent.version} in the version history.`);
          return;
        }
        let reply = await sendRaw({
          kind: "remixlet.rollback",
          id: versionEvent.remixletId,
          sha: target.sha,
          reloadMatching: true,
        });
        if (reply.kind === "remixlet.rollbackApprovalRequired") {
          const proposal = reply.proposal;
          approvalResolverRef.current?.(false);
          const approved = await new Promise<boolean>((resolve) => {
            approvalResolverRef.current = resolve;
            setApprovalProposal(proposal);
          });
          reply = await sendRaw({
            kind: "remixlet.resolveRollbackCapabilityApproval",
            proposalId: proposal.proposalId,
            approved,
            id: versionEvent.remixletId,
            sha: target.sha,
            reloadMatching: true,
          });
          if (!approved) return;
        }
        if (reply.kind === "remixlet.error") throw new Error(reply.message);
        if (reply.kind !== "remixlet.entry") throw new Error(`unexpected worker reply ${reply.kind}`);
        setCurrentVersions((prev) => ({ ...prev, [versionEvent.remixletId]: reply.entry.version }));
        addMessage("tool", `Went back to v${target.version} of "${versionEvent.remixletName}" — the page reloaded`, History);
      } catch (error) {
        addMessage("error", `Couldn't revert: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  // "Show what changed" on a version divider: ask the worker to highlight the
  // remixlet's verified spots on the bound tab (shared/show-changes.ts). The
  // highlights themselves are the feedback — the overlay's own pill reports
  // misses — so success adds no chat message; only failure does.
  function showVersionEventChanges(versionEvent: VersionEvent): void {
    if (runningRef.current) return;
    void (async () => {
      try {
        const { tabId } = await tabBindingRef.current!.target();
        const reply = await sendToWorker(
          { kind: "showChanges.start", tabId, id: versionEvent.remixletId },
          "showChanges.started",
        );
        if (!reply.ok) addMessage("error", reply.message);
      } catch (error) {
        addMessage(
          "error",
          `Couldn't show the changes: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  function replaceQueuedPrompts(next: QueuedPrompt[]): void {
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }

  function enqueuePrompt(text: string): void {
    const next = [...queuedPromptsRef.current, { id: ++nextQueuedIdRef.current, text }];
    replaceQueuedPrompts(next);
    setStatusText(`${next.length} message${next.length === 1 ? "" : "s"} queued`);
  }

  function removeQueuedPrompt(id: number): void {
    const next = queuedPromptsRef.current.filter((prompt) => prompt.id !== id);
    replaceQueuedPrompts(next);
    setStatusText(next.length === 0 ? "" : `${next.length} message${next.length === 1 ? "" : "s"} queued`);
  }

  // ---- agent ----------------------------------------------------------------

  // Sidecar index upkeep (wiki/handoff.md §8): provisional site key from the active
  // tab at first prompt; superseded by the target site of any remixlet this
  // conversation writes. Writes funnel through the worker (single writer).
  function upsertConversation(meta: { siteKey?: string; title?: string; remixletIds?: string[] }): void {
    void sendToWorker(
      { kind: "conversation.upsert", meta: { id: conversationIdRef.current, ...meta } },
      "conversation.upserted",
    ).catch((cause) => console.error("[remixlet] conversation index update failed", cause));
  }

  // Grant-continuation and nudge prompts render back as action rows, never as
  // user bubbles — chat-phrases.ts owns that mapping; only the ids are local.
  function chatMessagesFromTranscript(items: SessionTranscriptItem[]): ChatMessage[] {
    return items.map((item) => ({ id: ++nextIdRef.current, ...transcriptMessage(item) }));
  }

  function onAgentEvent(event: AgentRuntimeEvent): void {
    if (event.kind === "tool_end" && event.toolName === "write_remixlet" && event.ok) {
      // SAFETY: successful write_remixlet tool events carry the activated registry entry.
      const entry = event.details as RegistryEntry | undefined;
      if (entry?.siteKey) {
        pendingVerificationRef.current = entry;
        // A fresh activation supersedes any earlier failure evidence: the
        // obligation is now owed against the newer version.
        failedVerificationRef.current = undefined;
        appliedVersionRef.current = entry;
        // No index upsert here: the worker records the conversation→remixlet
        // link (and pins the site key) atomically with the activation itself,
        // so the edge survives a panel death right after the write.
      }
      // The build got through with the authority it needed; nothing left to
      // ask — and the clicked grant is spent, so a LATER activation naming the
      // same capabilities asks properly again.
      pendingCapabilityRequestRef.current = undefined;
      unspentGrantRef.current = null;
    }
    // A rejected observe read means the worker-side grant is gone (TTL expiry,
    // or the tab navigated off the pinned origin) while the panel still thinks
    // it is granted. Forget the stale grant so the next needs-network-
    // visibility verdict re-shows the card instead of the conversation
    // wedging — the probe's own failure message tells the model to re-record
    // that verdict, and the suppression check keys on this ref.
    if (event.kind === "tool_end" && event.toolName === "observe_network_bodies" && !event.ok) {
      devObserveGrantedRef.current = false;
    }
    if (event.kind === "tool_end" && event.toolName === "assess_feasibility" && event.ok) {
      const request = capabilityRequestFromVerdict(event.details);
      // A verdict naming only capabilities the user's click already granted
      // (still unspent) needs no card — re-offering it is the double ask the
      // second SoundCloud run hit after an interruption.
      const unspent = unspentGrantRef.current;
      pendingCapabilityRequestRef.current =
        request && unspent && request.capabilities.every((capability) => unspent.has(capability))
          ? undefined
          : request;
      // Same double-ask suppression for the dev-observe ask: once granted for
      // this conversation, a repeat verdict needs reading, not another card.
      pendingDevObserveRequestRef.current = devObserveRequestFromVerdict(event.details) && !devObserveGrantedRef.current;
    }
    // A post-activation assert that did not fully pass is the failed-exit
    // evidence. Read mechanically from the tool details, never from prose;
    // condition/selector in the summary come from the model-authored params.
    if (event.kind === "tool_end" && event.toolName === "assert_page_state" && event.ok && pendingVerificationRef.current) {
      // SAFETY: successful assert_page_state tool events carry this documented verification detail payload.
      const details = event.details as
        | { verificationSucceeded?: unknown; verificationBlockedByObserverLoop?: unknown; failedAssertions?: unknown }
        | undefined;
      if (details?.verificationSucceeded !== true) {
        failedVerificationRef.current = {
          remixletId: pendingVerificationRef.current.id,
          outcome: details?.verificationBlockedByObserverLoop === true ? "blocked" : "failed",
          summary: failedAssertionSummary(details?.failedAssertions),
        };
      }
    }
    // The recorded look verdict (record_look) is stored beside the activated
    // version's verification marker: the manager and popup show it as
    // "Looked at it: …". Read from the tool's details (the contract added the
    // reference it compared against), never from prose; the worker sanitizes
    // it again at its boundary.
    if (event.kind === "tool_end" && event.toolName === "record_look" && event.ok && appliedVersionRef.current) {
      // SAFETY: successful record_look tool events carry the documented verdict details; sanitizeLookReview re-checks the shape.
      const details = event.details as { verdict?: unknown; observed?: unknown; referenceSelector?: unknown; selector?: unknown } | undefined;
      const review = sanitizeLookReview({
        verdict: details?.verdict,
        observed: details?.observed,
        referenceSelector: details?.referenceSelector,
        selector: lookSubjectRef.current,
        reviewedAt: new Date().toISOString(),
        hasCrop: lookCropStoredRef.current,
      });
      if (review) {
        void sendToWorker(
          { kind: "remixlet.recordLookReview", id: appliedVersionRef.current.id, review },
          "remixlet.lookReviewRecorded",
        ).catch((cause) => console.error("[remixlet] look review not recorded", cause));
      }
    }
    if (event.kind === "tool_end" && event.toolName === "look_at_change" && event.ok) {
      // SAFETY: successful look_at_change tool events carry the documented location details.
      const details = event.details as { selector?: unknown; cropStored?: unknown } | undefined;
      const selector = details?.selector;
      lookSubjectRef.current = Object.prototype.toString.call(selector) === "[object String]" ? String(selector) : undefined;
      lookCropStoredRef.current = details?.cropStored === true;
    }
    const verification = explicitVerificationRecord(event, pendingVerificationRef.current, new Date().toISOString());
    if (verification) {
      pendingVerificationRef.current = undefined;
      failedVerificationRef.current = undefined;
      // The owed verification is now paid — the auto-resume loop can forget its
      // attempt count so a future, unrelated activation starts fresh.
      clearVerifyResumeCount(conversationIdRef.current);
      void sendToWorker(
        {
          kind: "remixlet.recordVerification",
          id: verification.id,
          result: { ...verification.result, conversationId: conversationIdRef.current },
        },
        "remixlet.verificationRecorded",
      ).catch((cause) => console.error("[remixlet] verification marker not recorded", cause));
    }
    if (event.kind === "model_wait") {
      setModelWait(event.phase === "done" ? null : event);
      if (event.phase === "retrying") {
        // The attempt that streamed these words was given up; the next one
        // answers from scratch, so its bubble and working notes go too.
        const abandoned = [streamingIdRef.current, thinkingIdRef.current].filter((id): id is number => id !== null);
        streamingIdRef.current = null;
        thinkingIdRef.current = null;
        if (abandoned.length > 0) setMessages((prev) => prev.filter((m) => !abandoned.includes(m.id)));
      }
      // Progress ticks arrive between working-notes deltas and must not split
      // that row — return before the row-ending rule below.
      return;
    }
    // A non-thinking event ends the current working-notes row: the next burst
    // of notes (after a tool call or an answer) starts a fresh row.
    if (event.kind !== "thinking_delta") thinkingIdRef.current = null;
    switch (event.kind) {
      case "turn_aborted":
        // User-initiated stops are rendered by the run loop after the runtime
        // settles, so they never masquerade as provider errors.
        break;
      case "thinking_delta": {
        if (!verbosityShowsWorkingNotes(chatPrefsRef.current.verbosity)) break;
        if (thinkingIdRef.current === null) {
          const id = ++nextIdRef.current;
          thinkingIdRef.current = id;
          setMessages((prev) => [...prev, { id, kind: "assistant", text: event.text, thinking: true }]);
        } else {
          const id = thinkingIdRef.current;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + event.text } : m)));
        }
        break;
      }
      case "assistant_delta":
        if (streamingIdRef.current === null) {
          streamingIdRef.current = addMessage("assistant", event.text);
        } else {
          const id = streamingIdRef.current;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + event.text } : m)));
        }
        break;
      case "assistant_message": {
        const id = streamingIdRef.current;
        streamingIdRef.current = null;
        if (id !== null) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: event.text } : m)));
        else addMessage("assistant", event.text);
        break;
      }
      case "tool_start": {
        const phrase = describeTool(event.toolName, event.args);
        const id = addMessage("tool", phrase.active, phrase.icon, "active");
        toolMsgRef.current.set(event.toolCallId, { id, phrase });
        break;
      }
      case "tool_end": {
        const tracked = toolMsgRef.current.get(event.toolCallId);
        toolMsgRef.current.delete(event.toolCallId);
        const phrase = tracked?.phrase ?? describeTool(event.toolName, undefined);
        // A contract bounce settles too: the in-flight row becomes the
        // plain-words "held" line (chat-phrases.tsx bouncePhrase) so the
        // user can read that the step waited and why.
        const settled = settledToolMessage(event.toolName, phrase, event);
        if (tracked) {
          setMessages((prev) =>
            prev.map((m) => (m.id === tracked.id ? { ...m, text: settled.text, icon: settled.icon, state: settled.state } : m)),
          );
        } else addMessage("tool", settled.text, settled.icon, settled.state);
        break;
      }
    }
  }

  function confirmCapabilityApproval(proposal: CapabilityApprovalProposal): Promise<boolean> {
    // The one-click authorization card and this dialog gate different things
    // (plan-and-build vs. grant), but when they would name the identical
    // validated capability set for the same request, the second ask is pure
    // noise — the live SoundCloud run showed it reads as being asked to
    // authorize the same thing twice. Auto-approve exactly that case: every
    // ADDED capability is in the still-unspent set the user's click
    // authorized. The grant is consumed by the successful write this approval
    // is part of (not here), so a failed activation leaves it available to
    // retry. When the activation also drops capabilities, say so — that is
    // what makes a source swap read as a replacement, not extra access.
    // A broadened scope (fresh all-sites install, or a version-to-version
    // widening) must always be SHOWN — the one-click capability grant never
    // authorized where the code runs, only which capability names it may use.
    const authorized = unspentGrantRef.current;
    // A changed network-rules file must always be SHOWN (item 9), never folded
    // into the one-click auto-approval — the click authorized capability names,
    // not a rewrite of what the rules do. Neither is a scope outside the site
    // this chat is bound to: the click was made on one site, and authorizes
    // nothing on another.
    if (
      !proposal.broadScope &&
      !proposal.netRulesChanged &&
      !proposal.offSite &&
      authorized &&
      proposal.added.length > 0 &&
      proposal.added.every((capability) => authorized.has(capability))
    ) {
      addMessage("tool", `Gave "${proposal.remixletName}" the access you allowed`, ShieldCheck);
      const removalNote = capabilityRemovalNote(proposal.removed);
      if (removalNote) addMessage("tool", removalNote, ShieldCheck);
      return Promise.resolve(true);
    }
    // A turn is serial, so only one tool can be waiting for approval. Resolve
    // defensively if a provider nevertheless produces overlapping calls.
    approvalResolverRef.current?.(false);
    setApprovalProposal(proposal);
    return new Promise((resolve) => {
      approvalResolverRef.current = resolve;
    });
  }

  function resolveCapabilityApproval(approved: boolean): void {
    const resolve = approvalResolverRef.current;
    approvalResolverRef.current = null;
    setApprovalProposal(null);
    resolve?.(approved);
  }

  async function ensureRuntime(): Promise<AgentRuntime> {
    if (runtimeRef.current) return runtimeRef.current;
    const settings = await loadSettings();
    if (!settingsComplete(settings)) throw new Error("No model is ready — open model provider settings.");
    // Fresh read, not the ref: a runtime is built rarely, and the stored
    // value is the authority the Settings page writes.
    const chatPrefs = await loadChatPreferences();
    chatPrefsRef.current = chatPrefs;
    let session = sessionRef.current;
    if (!session || session.id !== conversationIdRef.current) {
      session = await ConversationSession.open(conversationIdRef.current);
      sessionRef.current = session;
    }
    const runtime = createAgentRuntime({
      systemPrompt: systemPromptFor(chatPrefs.verbosity),
      textVerbosity: codexTextVerbosity(chatPrefs.verbosity),
      endpoint: await buildEndpoint(settings),
      tools: buildTools(
        { confirmCapabilityApproval },
        conversationIdRef.current,
        tabBindingRef.current!,
        // The look review stores its crop beside the remixlet this turn
        // activated (the divider's entry, held until the turn ends).
        { activatedRemixletId: () => appliedVersionRef.current?.id },
      ),
      thinkingLevel: selectedThinkingLevel(settings),
      session,
    });
    runtime.subscribe(onAgentEvent);
    runtimeRef.current = runtime;
    const provider = selectedProvider(settings);
    runtimeProviderKindRef.current = provider?.kind;
    runtimeProviderIdRef.current = provider?.id;
    return runtime;
  }

  // ---- history menu ----------------------------------------------------------

  function openHistory(): void {
    void Promise.all([
      sendToWorker({ kind: "conversation.list" }, "conversation.listed"),
      sendToWorker({ kind: "siteIcon.list" }, "siteIcon.listed"),
    ]).then(([listed, icons]) => {
      setConversations(listed.conversations);
      setSiteIcons(icons.icons);
      setView("history");
    });
  }

  // The dev-observe grant dies with the conversation: tell the worker to drop
  // the record (which unregisters the observer on its reconcile) and forget
  // the panel-side refs. Best-effort — the worker's TTL backstop covers a
  // disable that never lands.
  function releaseDevObserveGrant(conversationId: string): void {
    setDevObserveRequest(false);
    pendingDevObserveRequestRef.current = false;
    if (!devObserveGrantedRef.current) return;
    devObserveGrantedRef.current = false;
    void sendToWorker({ kind: "devObserve.disable", conversationId }, "devObserve.disabled").catch((cause) =>
      console.error("[remixlet] dev-observe release failed", cause),
    );
  }

  function startNewConversation(): void {
    if (runningRef.current) return;
    releaseDevObserveGrant(conversationIdRef.current);
    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;
    // A fresh conversation gets a fresh binding: it binds at the first
    // message. Dispose the outgoing one so its navigation watch stops.
    tabBindingRef.current?.dispose();
    tabBindingRef.current = newTabBinding();
    setBoundTab(undefined);
    setBindingIssue(null);
    sessionRef.current = undefined;
    runtimeRef.current = undefined;
    indexedRef.current = false;
    setMessages([]);
    setCurrentVersions({});
    setCapabilityRequest(null);
    pendingCapabilityRequestRef.current = undefined;
    unspentGrantRef.current = null;
    pendingVerificationRef.current = undefined;
    failedVerificationRef.current = undefined;
    replaceQueuedPrompts([]);
    setStatusText("");
    setView("chat");
  }

  function resumeConversation(meta: ConversationMeta): void {
    if (runningRef.current) return;
    releaseDevObserveGrant(conversationIdRef.current);
    void (async () => {
      try {
        const session = await ConversationSession.open(meta.id);
        // A grant record from an earlier panel session of THIS conversation
        // may still be live worker-side; the fresh panel starts ungranted, so
        // make the worker agree rather than leaving a readable buffer behind.
        void sendToWorker({ kind: "devObserve.disable", conversationId: meta.id }, "devObserve.disabled").catch(() => {});
        conversationIdRef.current = meta.id;
        // Site-aware rebind: the resumed conversation must never silently
        // operate on a wrong-site tab. Current tab if it matches the
        // conversation's site, else any open tab on the site, else unbound
        // with the card offering an explicit choice.
        tabBindingRef.current?.dispose();
        tabBindingRef.current = newTabBinding();
        setBoundTab(undefined);
        setBindingIssue(null);
        void tabBindingRef.current.bindForResume(meta.siteKey).then((outcome) => {
          if (outcome === "no-site-tab") setBindingIssue({ kind: "no-site-tab", siteKey: meta.siteKey });
        });
        sessionRef.current = session;
        runtimeRef.current = undefined; // next turn binds the runtime to this session
        indexedRef.current = true; // it's already in the index
        replaceQueuedPrompts([]);
        setCapabilityRequest(null);
        pendingCapabilityRequestRef.current = undefined;
        unspentGrantRef.current = null;
        setMessages(chatMessagesFromTranscript(session.transcriptItems()));
        setCurrentVersions({});
        setStatusText("");
        setView("chat");
        maybeResumeVerification(session);
      } catch (error) {
        addMessage("error", `Couldn't resume that conversation: ${String(error)}`);
        setView("chat");
      }
    })();
  }

  // After a conversation resumes, close the loop the reload broke: if it ended
  // on an activation that was never verified, drive the verify-or-fix
  // continuation automatically instead of sitting idle until the user notices
  // the broken page (the Instagram v1 spinner). Bounded per conversation so an
  // unfixable feature hands back to the user rather than looping forever. The
  // contract has already re-armed the obligation for this turn (session-tail),
  // so even if the model tries to stop without verifying it cannot.
  function maybeResumeVerification(session: ConversationSession): void {
    if (!session.pendingActivationVerification) {
      clearVerifyResumeCount(session.id);
      return;
    }
    void (async () => {
      if (runningRef.current || queuedPromptsRef.current.length > 0) return;
      if ((await readVerifyResumeCount(session.id)) >= VERIFY_RESUME_LIMIT) {
        // The attempt cap exhausting is a second entrance to the same
        // failed-exit cleanup the settle point runs: the loop is giving up, so
        // the unverified activation must not stay live and indistinguishable
        // from verified remixlets.
        const pending = session.pendingActivationEntry;
        if (pending) {
          await runFailedVerificationCleanup(pending, {
            outcome: "failed",
            summary: "automatic verification attempts were exhausted",
          });
        }
        addMessage(
          "assistant",
          "I activated the last change but couldn't confirm it working after several tries. Tell me what you're seeing and I'll take another look.",
        );
        return;
      }
      await bumpVerifyResumeCount(session.id);
      // A prompt may have started while we awaited storage; don't double-drive.
      if (runningRef.current || queuedPromptsRef.current.length > 0) return;
      runPromptSequence(resumeVerificationPrompt());
    })();
  }

  /**
   * The failed-exit cleanup, sent to the worker AFTER the model's closing
   * message: record the failure durably, then roll back to the last verified
   * version or park the remixlet as needs-attention. The statement to the user
   * is panel-authored (a deterministic action row) — never depend on the model
   * narrating a state change that happens after it stops. Best-effort: a
   * failure here must never take down the run loop.
   */
  async function runFailedVerificationCleanup(
    remixlet: { id: string; name: string },
    failure: { outcome: "failed" | "blocked"; summary?: string },
  ): Promise<void> {
    try {
      const reloadTabId = await tabBindingRef.current!.target().then(
        (target) => target.tabId,
        () => undefined,
      );
      const reply = await sendToWorker(
        {
          kind: "remixlet.recordVerifyFailure",
          id: remixlet.id,
          outcome: failure.outcome,
          at: new Date().toISOString(),
          summary: failure.summary,
          conversationId: conversationIdRef.current,
          reloadTabId,
        },
        "remixlet.verifyFailureRecorded",
      );
      sessionRef.current?.recordVerifyFailureCleanup({ id: remixlet.id, action: reply.action });
      addMessage(
        "tool",
        reply.action === "rolled-back"
          ? `I couldn't confirm the last change to "${remixlet.name}" works, so I put back the last version that did.`
          : `I couldn't confirm the last change to "${remixlet.name}" works, so I've taken it off the page until it's fixed.`,
        HELD_ICON,
      );
    } catch (error) {
      console.error("[remixlet] failed-verification cleanup failed", error);
    }
  }

  // The ONLY way the binding moves to another tab: the user's explicit click
  // on the chip or the rebind card. The agent never follows their focus.
  function rebindToCurrentTab(): void {
    void tabBindingRef.current!.bindActiveTab().then((bound) => {
      if (!bound) setStatusText("No page tab to work on — open the page in a tab first");
    });
  }

  // The rebind card's primary action when no open tab is on the chat's site:
  // open the site and bind the new tab in one click. Conversation site keys
  // are single hostnames (siteKeyForUrl), so `https://host/` is the site root.
  // The card's primary action. An already-open tab on the site is preferred
  // over a new one, and the tab the user moved elsewhere is never navigated
  // back: they are using it for something, and taking it away to repair a
  // binding would be the second thing today that moved a page out from under
  // them. bindForResume owns the "current tab, else any site tab" search.
  function openSiteAndBind(siteKey: string): void {
    const binding = tabBindingRef.current;
    if (!binding) return;
    void binding.bindForResume(siteKey).then((outcome) => {
      if (outcome === "bound") {
        setBindingIssue(null);
        return;
      }
      void ext.tabs.create({ url: `https://${siteKey}/` }).then((tab) => {
        if (tab.id !== undefined) void binding.bindTab(tab.id, siteKey);
      });
    });
  }

  function openManager(): void {
    void ext.tabs.create({ url: ext.runtime.getURL("manager.html") });
  }

  // The "Working on" label brings the bound tab back into view — the panel
  // follows the user across tabs, so the page a chat works on is often not
  // the one they are looking at.
  function showBoundTab(): void {
    if (!boundTab) return;
    void focusTab(boundTab.tabId);
  }

  function openSecureSettings(): void {
    void ext.tabs.create({ url: ext.runtime.getURL("manager.html#/settings/providers") });
  }

  // The version divider's "vN" opens that remixlet's page in the control
  // center — its version history, diffs, and code — in a new tab, the same
  // way every other manager link from the panel opens.
  function openRemixletPage(remixletId: string): void {
    void ext.tabs.create({ url: ext.runtime.getURL(`manager.html${routeHash({ kind: "remixlet", id: remixletId })}`) });
  }

  function indexFirstPrompt(text: string): void {
    if (indexedRef.current) return;
    indexedRef.current = true;
    const title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    // The provisional site key comes from the tab BINDING (bound at this
    // first message), so the history entry and the tab tools act on can
    // never disagree.
    void tabBindingRef
      .current!.ensureBound()
      .then((bound) => upsertConversation({ title, siteKey: bound?.siteKey ?? "" }))
      .catch(() => upsertConversation({ title }));
  }

  function markTurnStopped(): void {
    // The aborted assistant message never persists (conversation-session.ts),
    // so note the stop in the run log where the dropped turn would have been.
    sessionRef.current?.recordRunAborted();
    const trackedIds = new Set([...toolMsgRef.current.values()].map(({ id }) => id));
    if (trackedIds.size > 0) {
      setMessages((prev) =>
        prev.map((message) => (trackedIds.has(message.id) ? { ...message, text: "■ Stopped before this step finished" } : message)),
      );
    } else {
      addMessage("tool", "■ Stopped");
    }
  }

  function stopCurrentTurn(): void {
    if (!runningRef.current || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStatusText("Stopping…");
    // A capability prompt is part of the current turn. Resolve it before
    // aborting so no tool remains suspended behind a modal.
    resolveCapabilityApproval(false);
    runtimeRef.current?.abort();
  }

  function runQueuedPrompts(): void {
    if (runningRef.current) return;
    const [next, ...rest] = queuedPromptsRef.current;
    if (!next) return;
    replaceQueuedPrompts(rest);
    runPromptSequence(next.text);
  }

  function runPromptSequence(firstText: string): void {
    if (runningRef.current) {
      enqueuePrompt(firstText);
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setStatusText("");
    setCapabilityRequest(null);
    pendingCapabilityRequestRef.current = undefined;
    setDevObserveRequest(false);
    pendingDevObserveRequestRef.current = false;
    document.body.dataset.rmxTurn = "running";
    void (async () => {
      // Bind the conversation's tab BEFORE the model runs, so the chip shows
      // the target while the user can still see it, and later tool calls
      // cannot bind to whatever tab they switched to mid-turn. Failures are
      // surfaced per tool call, not here.
      await tabBindingRef.current!.ensureBound().catch(() => {});
      let text: string | undefined = firstText;
      let paused = false;
      let failed = false;

      while (text !== undefined) {
        stopRequestedRef.current = false;
        appliedVersionRef.current = undefined;
        // A grant continuation is the user's click, and a resume verification
        // is the panel's own follow-up — both are actions, not something the
        // user typed, so they render as an action row, never a user bubble.
        const grantedForDisplay = capabilityGrantFromPrompt(text);
        // A prompt carrying a page-annotation block renders as the typed text
        // plus a short note — the machine block never shows in the bubble.
        const { display: typedPart, hasAnnotation } = splitAnnotationFromPrompt(text);
        const userBubble = hasAnnotation
          ? typedPart.length > 0
            ? `${typedPart}\n\n✏ with marks drawn on the page`
            : "✏ Marked up the page"
          : text;
        if (grantedForDisplay) addMessage("tool", capabilityGrantActionLabel(grantedForDisplay), ShieldCheck);
        else if (isDevObserveGrantPrompt(text)) addMessage("tool", DEV_OBSERVE_GRANT_ACTION_LABEL, ShieldCheck);
        else if (isContractNudgePrompt(text)) addMessage("tool", "Verifying the last change before finishing", HELD_ICON);
        else addMessage("user", userBubble);
        if (!isContractNudgePrompt(text)) indexFirstPrompt(hasAnnotation ? userBubble : text);
        try {
          const agent = await ensureRuntime();
          if (stopRequestedRef.current) {
            paused = true;
            markTurnStopped();
            break;
          }
          // The clicked grant rides along until a build spends it (the write-ok
          // handler clears the ref), so an interrupted granted turn or an
          // intervening user question cannot strand it behind a second ask.
          const unspent = unspentGrantRef.current;
          const options: AgentPromptOptions = {};
          if (unspent && unspent.size > 0) options.grantedCapabilities = [...unspent];
          if (devObserveGrantedRef.current) options.devObserveGranted = true;
          await agent.prompt(text, Object.keys(options).length > 0 ? options : undefined);
          // The provider answered a real request — stamp its lastUsedAt.
          if (runtimeProviderIdRef.current) recordProviderTurnOutcome(runtimeProviderIdRef.current, { ok: true });
          if (stopRequestedRef.current) {
            paused = true;
            markTurnStopped();
            break;
          }
        } catch (error) {
          if (stopRequestedRef.current) {
            paused = true;
            markTurnStopped();
            break;
          }
          failed = true;
          // Sole error-rendering point: runtime events never carry errors,
          // so every failure (provider, contract, ensureRuntime) lands here.
          // Contract text renders as the plain unfinished-turn words; the raw
          // message still goes to recordRunError below for the run log.
          const message = error instanceof Error ? error.message : String(error);
          addMessage("error", runErrorDisplayText(message));
          // Only a provider failure marks the provider as needing attention —
          // contract violations and setup errors say nothing about its health.
          if (error instanceof ProviderTurnError && runtimeProviderIdRef.current) {
            recordProviderTurnOutcome(runtimeProviderIdRef.current, { ok: false, message });
          }
          // Failed turns drop their assistant message from the JSONL; this is
          // the only durable record of why the run stopped (run-log viewer).
          sessionRef.current?.recordRunError(message);
          setStatusText("Error");
          // Codex 401 mid-turn: the access token was revoked/expired server-side.
          // Drop it so the next turn's getAccessToken refreshes (wiki/handoff.md §6.1 ¶7).
          if (runtimeProviderKindRef.current === "codex" && (/\b401\b|unauthorized/i.test(message))) {
            void sendToWorker({ kind: "codex.invalidateAccessToken" }, "codex.accessTokenInvalidated");
          }
          break;
        } finally {
          const unverified = pendingVerificationRef.current;
          const failedVerify = failedVerificationRef.current;
          pendingVerificationRef.current = undefined;
          failedVerificationRef.current = undefined;
          streamingIdRef.current = null;
          thinkingIdRef.current = null;
          setModelWait(null);
          toolMsgRef.current.clear();
          // The exchange is over one way or another; if it activated a
          // version, close it with the divider (a stopped or errored turn
          // still applied — the activation already happened).
          const applied = appliedVersionRef.current;
          appliedVersionRef.current = undefined;
          if (applied) addVersionEvent(applied);
          // The failed-exit cleanup: this turn COMPLETED (a stopped or errored
          // turn takes the existing resume-obligation path instead) with an
          // activation whose last assert_page_state did not pass. The harness
          // acts — the model already gave its closing message. Awaited so a
          // queued prompt cannot race the worker's rollback/park.
          if (!paused && !failed && unverified && failedVerify?.remixletId === unverified.id) {
            await runFailedVerificationCleanup(unverified, failedVerify);
          }
        }

        const [next, ...rest] = queuedPromptsRef.current;
        if (!next) {
          text = undefined;
        } else {
          replaceQueuedPrompts(rest);
          setStatusText(rest.length === 0 ? "Running queued message" : `${rest.length} more queued`);
          text = next.text;
        }
      }

      stopRequestedRef.current = false;
      runningRef.current = false;
      setRunning(false);
      // A verdict that named capabilities but produced no build is the one case
      // the workflow cannot finish on its own: offer the authorizing turn. (An
      // unspent clicked grant deliberately outlives the sequence — it is
      // cleared by the build that uses it or by leaving the conversation.)
      setCapabilityRequest(pendingCapabilityRequestRef.current ?? null);
      setDevObserveRequest(pendingDevObserveRequestRef.current);
      document.body.dataset.rmxTurn = "idle";
      if (paused) {
        const count = queuedPromptsRef.current.length;
        setStatusText(count === 0 ? "Stopped" : `Stopped — ${count} queued`);
      } else if (!failed) {
        setStatusText("");
      }
    })();
  }

  // One click = the grant. Its authority travels out of band — into the
  // contract via grantedCapabilities and into the activation auto-approval via
  // unspentGrantRef; the continuation prompt is narration the chat renders as
  // an action row, and forging its text grants nothing. A second click while
  // an earlier grant is unspent replaces it: one pending authorization at a
  // time keeps "what did I allow?" answerable.
  function authorizeCapabilityRequest(): void {
    const pending = capabilityRequest;
    if (!pending || runningRef.current || queuedPromptsRef.current.length > 0) return;
    setCapabilityRequest(null);
    pendingCapabilityRequestRef.current = undefined;
    unspentGrantRef.current = new Set(pending.capabilities);
    runPromptSequence(capabilityGrantPrompt(pending.capabilities));
  }

  // The dev-observe card's Allow: the click (and only the click) makes the
  // worker pin the grant to the tab's origin, register the observer, and
  // reload the tab; the continuation prompt is narration, and the granted ref
  // travels out of band like unspentGrantRef. Failures land in the chat as the
  // extension's own error, with nothing granted.
  function authorizeDevObserveRequest(): void {
    if (!devObserveRequest || runningRef.current || queuedPromptsRef.current.length > 0) return;
    setDevObserveRequest(false);
    pendingDevObserveRequestRef.current = false;
    void (async () => {
      try {
        const { tabId } = await tabBindingRef.current!.target();
        const reply = await sendToWorker(
          { kind: "devObserve.enable", conversationId: conversationIdRef.current, tabId },
          "devObserve.enabled",
        );
        if (!reply.ok) throw new Error(reply.message);
        devObserveGrantedRef.current = true;
        runPromptSequence(devObserveGrantPrompt(reply.origin));
      } catch (error) {
        addMessage("error", `Couldn't start watching this page's data: ${String(error)}`);
      }
    })();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Mirrors the send button's disabled state (pageBlocked) for the Enter
    // key — a chat must not start against a page remixlets cannot touch.
    if (!boundTab && messages.length === 0 && activePage.kind === "not-web") return;
    const input = inputRef.current;
    if (!input) return;
    const typed = input.value.trim();
    const annotation = pendingAnnotation;
    // A markup result can be sent on its own — the block says the user drew.
    if (typed.length === 0 && !annotation) return;
    input.value = "";
    setDraftEmpty(true);
    const text = annotation ? appendAnnotationToPrompt(typed, annotation) : typed;
    if (annotation) {
      setPendingAnnotation(null);
      clearAnnotationOnPage();
    }
    // The user is steering again — reset the auto-verify attempt budget so a
    // later activation in this conversation gets its own fresh set of tries.
    clearVerifyResumeCount(conversationIdRef.current);
    if (runningRef.current || queuedPromptsRef.current.length > 0) enqueuePrompt(text);
    else runPromptSequence(text);
  }

  // ---- draw-on-page markup mode (SPIKE) --------------------------------------

  // Deliberately re-clickable while a markup session is open: the overlay's
  // open() is idempotent, and a session that died without reporting (the tab
  // navigated mid-draw) must not strand the button disabled.
  function startMarkup(): void {
    if (runningRef.current) return;
    void (async () => {
      setAnnotating(true);
      try {
        const { tabId } = await tabBindingRef.current!.target();
        // Drawing happens on screen — a background bound tab can't host it.
        const tab = await ext.tabs.get(tabId);
        if (!tab.active) {
          setAnnotating(false);
          setStatusText("Switch to the tab this chat is working on, then draw");
          return;
        }
        const reply = await sendToWorker({ kind: "annotation.start", tabId }, "annotation.started");
        if (!reply.ok) throw new Error(reply.message ?? "markup mode failed to open");
        setStatusText("Draw on the page, then press Done there");
      } catch (error) {
        setAnnotating(false);
        setStatusText(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  // The pending marks stay visible on the page (the overlay's passive state)
  // until consumed or discarded — this tells that tab to clear them.
  function clearAnnotationOnPage(): void {
    const tabId = annotationTabRef.current;
    annotationTabRef.current = undefined;
    if (tabId !== undefined) {
      void ext.tabs.sendMessage(tabId, { kind: ANNOTATE_CLEAR_MESSAGE }).catch(() => {});
    }
  }

  function discardPendingAnnotation(): void {
    setPendingAnnotation(null);
    clearAnnotationOnPage();
  }

  // The overlay broadcasts its result to every extension context; the panel is
  // the consumer of the payload (the worker only acknowledges the broadcast).
  useEffect(() => {
    const onRuntimeMessage = (message: AnnotationResultPayload | { kind?: string }, sender: { tab?: { id?: number } }): undefined => {
      if (!isAnnotationResultMessage(message)) return;
      const payload = message;
      setAnnotating(false);
      const kept = !payload.cancelled && payload.marks.length > 0 ? payload : null;
      // A fresh result from a different tab supersedes marks left on the old one.
      const previousTab = annotationTabRef.current;
      const senderTab = sender.tab?.id;
      if (previousTab !== undefined && previousTab !== senderTab) {
        void ext.tabs.sendMessage(previousTab, { kind: ANNOTATE_CLEAR_MESSAGE }).catch(() => {});
      }
      annotationTabRef.current = kept ? senderTab : undefined;
      setPendingAnnotation(kept);
      setStatusText(kept ? "" : "Markup cancelled");
      return;
    };
    ext.runtime.onMessage.addListener(onRuntimeMessage);
    return () => ext.runtime.onMessage.removeListener(onRuntimeMessage);
  }, []);

  // ---- model selection -------------------------------------------------------

  const modelMenuOpen = composerMenu === "model";
  const reasoningMenuOpen = composerMenu === "reasoning";

  // Closing hands focus back to the trigger: the menu owned it (the search
  // input, or a level row), and it unmounts with the menu.
  function closeModelMenu(): void {
    setComposerMenu(null);
    document.getElementById("chat-model")?.focus();
  }

  function closeReasoningMenu(): void {
    setComposerMenu(null);
    document.getElementById("chat-reasoning")?.focus();
  }

  function selectModel(selection: NonNullable<ProviderSettings["selectedModel"]>): void {
    const previous = providerSettings.selectedModel;
    const next = { ...providerSettings, selectedModel: { providerId: selection.providerId, modelId: selection.modelId } };
    setProviderSettings(next);
    setProviderReady(settingsComplete(next));
    closeModelMenu();
    runtimeRef.current = undefined;
    runtimeProviderKindRef.current = undefined;
    runtimeProviderIdRef.current = undefined;
    // A switch mid-chat changes who wrote what below it, so the transcript
    // records it. Picking the first model isn't a switch — nothing above the
    // line was written by anything else — so it stays silent.
    if (previous && (previous.providerId !== selection.providerId || previous.modelId !== selection.modelId)) {
      addNotice(`Model changed to ${selection.modelId}`);
    }
    void saveSettings(next);
  }

  // The chosen level is baked into the runtime (pi's thinkingLevel), so like
  // a verbosity change this rebuilds on the next turn; the transcript stays
  // silent — the author doesn't change, only how long it thinks.
  function selectThinkingLevel(level: ThinkingLevel | undefined): void {
    const selection = providerSettings.selectedModel;
    if (!selection) return;
    const key = thinkingLevelKey(selection);
    const levels = { ...providerSettings.thinkingLevels };
    if (level === undefined) delete levels[key];
    else levels[key] = level;
    const next: ProviderSettings = { ...providerSettings };
    delete next.thinkingLevels;
    if (Object.keys(levels).length > 0) next.thinkingLevels = levels;
    setProviderSettings(next);
    closeReasoningMenu();
    runtimeRef.current = undefined;
    void saveSettings(next);
  }

  // ---- boot ------------------------------------------------------------------

  useEffect(() => {
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === "local" && CHAT_PREFERENCES_KEY in changes) {
        void loadChatPreferences().then((prefs) => {
          // Verbosity is baked into the runtime (system prompt, response-
          // length hint), so changing it rebuilds on the next turn. A theme
          // change touches neither.
          if (prefs.verbosity !== chatPrefsRef.current.verbosity) runtimeRef.current = undefined;
          chatPrefsRef.current = prefs;
        });
      }
      if (area === "local" && SETTINGS_KEY in changes) {
        void loadSettings().then((settings) => {
          setProviderSettings((previous) => {
            // Only a change to what the runtime actually talks to (endpoint,
            // credential, models, selection) invalidates it — the health
            // stamps this panel writes after every turn must not.
            if (providerRuntimeFingerprint(previous) !== providerRuntimeFingerprint(settings)) {
              runtimeRef.current = undefined;
              runtimeProviderKindRef.current = undefined;
              runtimeProviderIdRef.current = undefined;
            }
            return settings;
          });
          setProviderReady(settingsComplete(settings));
        });
      }
    };
    ext.storage.onChanged.addListener(onStorageChanged);
    void loadChatPreferences().then((prefs) => {
      chatPrefsRef.current = prefs;
    });
    void (async () => {
      const settings = await loadSettings();
      setProviderSettings(settings);
      setProviderReady(settingsComplete(settings));
      const reply = await sendToWorker({ kind: "capabilities.get" }, "capabilities.result");
      setCapabilities(reply.capabilities);
      document.body.dataset.rmxTurn = "idle";
    })();
    return () => {
      ext.storage.onChanged.removeListener(onStorageChanged);
      approvalResolverRef.current?.(false);
      approvalResolverRef.current = null;
      runtimeRef.current?.abort();
    };
  }, []);

  // ---- ask notification (ask-notifications.ts) -------------------------------
  //
  // Whichever ask is waiting on the user right now, in the order the surfaces
  // stack: the modal dialogs cover the cards. Null while nothing waits.
  const pendingAsk: PendingAskKind | null = approvalProposal
    ? "capability-approval"
    : capabilityRequest
      ? "capability-request"
      : devObserveRequest
        ? "dev-observe-request"
        : null;
  const askTabId = boundTab?.tabId;
  const askHost = hostOf(boundTab?.origin);
  useEffect(() => {
    if (!pendingAsk || askTabId === undefined || !chatPrefsRef.current.askNotifications) return;
    // The view check is async, so the ask can resolve before it lands: the
    // cancelled flag stops a late create, and the clear on cleanup chains
    // behind any create still in flight so it never runs first.
    let cancelled = false;
    let shown: Promise<void> = Promise.resolve();
    const copy = askNotificationCopy(pendingAsk, askHost);
    const clear = (): void => {
      void shown.then(() => clearAskNotification(askTabId)).catch(() => {});
    };
    void panelViewFacts().then((facts) => {
      if (cancelled || !shouldNotifyForAsk({ enabled: true, ...facts })) return;
      shown = showAskNotification(askTabId, copy.title, copy.message).catch(() => {});
    });
    // Coming back by any route (not only the toast's click, which the worker
    // clears itself) takes the toast down: the ask is on screen again.
    const onSeen = (): void => {
      void panelViewFacts().then((facts) => {
        if (!cancelled && !facts.hidden && facts.windowFocused) clear();
      });
    };
    document.addEventListener("visibilitychange", onSeen);
    window.addEventListener("focus", onSeen);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onSeen);
      window.removeEventListener("focus", onSeen);
      clear();
    };
  }, [pendingAsk, askTabId, askHost]);

  // Elapsed-time ticker for the running indicator at the bottom of the chat.
  useEffect(() => {
    if (!running) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [running]);

  // The composer menus dismiss on any pointer press outside themselves and
  // their triggers — pressing the textarea, the transcript, or anywhere else
  // means "never mind". Pointer only: focus keeps moving freely (the search
  // input owns it while the model menu is open) and Escape already covers
  // the keyboard.
  useEffect(() => {
    if (composerMenu === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inside = ["model-menu", "reasoning-menu", "chat-model", "chat-reasoning"].some((id) =>
        document.getElementById(id)?.contains(target),
      );
      if (!inside) setComposerMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [composerMenu]);

  // The reasoning menu is a radiogroup with roving focus: opening moves
  // focus onto the effective row so the arrow keys work immediately.
  useEffect(() => {
    if (composerMenu !== "reasoning") return;
    const menu = document.getElementById("reasoning-menu");
    const checked = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? menu?.querySelector<HTMLButtonElement>('[role="radio"]'))?.focus();
  }, [composerMenu]);

  // ---- view -------------------------------------------------------------------

  const boundHost = boundTab?.siteKey ?? "";
  const modelOptions = availableModels(providerSettings);
  // The picker's two tiers: featured (pi's curated catalog knows the model, or
  // the provider kind has no catalog to judge by) up front, everything else the
  // credential can see behind the "All models" disclosure. A split needs two
  // non-empty tiers — when either side is empty the list renders flat. Typing
  // in the search box replaces the tiers with one flat filtered list, so a
  // model pi doesn't know yet is always reachable by name.
  const providerModelIds = (providerId: string): readonly string[] =>
    providerSettings.providers.find((provider) => provider.id === providerId)?.models ?? [];
  const featuredModels = modelOptions.filter((model) =>
    isFeaturedModel(model.providerKind, model.modelId, providerModelIds(model.providerId)),
  );
  const extraModels = modelOptions.filter(
    (model) => !isFeaturedModel(model.providerKind, model.modelId, providerModelIds(model.providerId)),
  );
  const modelTiersSplit = featuredModels.length > 0 && extraModels.length > 0;
  const modelFilter = modelQuery.trim().toLowerCase();
  // Filtered results run featured-first, so the top hit (what Enter selects)
  // is a curated model whenever one matches. The haystack carries the pi
  // catalog's display name alongside the raw id, so both spellings match.
  const filteredModels = modelFilter
    ? [...featuredModels, ...extraModels].filter((model) =>
        `${model.modelId} ${modelDisplayName(model)} ${model.providerName}`.toLowerCase().includes(modelFilter),
      )
    : null;
  // Every row the keyboard cursor can land on, in render order: the "All
  // models" disclosure is a navigable item like the models around it, so
  // arrows reach it and Enter toggles it without leaving the search input.
  const modelMenuItems: ({ kind: "model"; model: AvailableModel } | { kind: "all-models" })[] = filteredModels
    ? filteredModels.map((model) => ({ kind: "model", model }))
    : [
        ...(modelTiersSplit ? featuredModels : modelOptions).map((model) => ({ kind: "model" as const, model })),
        ...(modelTiersSplit ? [{ kind: "all-models" as const }] : []),
        ...(modelTiersSplit && allModelsOpen ? extraModels.map((model) => ({ kind: "model" as const, model })) : []),
      ];
  // The cursor state survives list reshapes (typing, toggling the disclosure);
  // clamp rather than reset so it never points past the end.
  const activeModelPos = Math.min(activeModelIndex, Math.max(0, modelMenuItems.length - 1));
  const modelOptionId = (index: number): string =>
    modelMenuItems[index]?.kind === "all-models" ? "all-models" : `model-option-${index}`;
  const openModelMenu = (): void => {
    setModelQuery("");
    setActiveModelIndex(0);
    // The disclosure starts open when the current selection lives behind it,
    // so its checkmark is visible on open.
    const selected = selectedProvider(providerSettings);
    setAllModelsOpen(
      selected !== undefined &&
        providerSettings.selectedModel !== null &&
        !isFeaturedModel(selected.kind, providerSettings.selectedModel.modelId, selected.models),
    );
    setComposerMenu("model");
  };
  const modelRow = (model: AvailableModel, index: number) => {
    const current =
      providerSettings.selectedModel?.providerId === model.providerId &&
      providerSettings.selectedModel?.modelId === model.modelId;
    const name = modelDisplayName(model);
    return (
      <button
        key={`${model.providerId}:${model.modelId}`}
        id={`model-option-${index}`}
        type="button"
        role="option"
        aria-selected={current}
        tabIndex={-1}
        className={`flex shrink-0 items-center justify-between gap-2 rounded-[7px] px-2 py-[7px] text-left ${
          index === activeModelPos ? "bg-foreground/7" : ""
        }`}
        onMouseEnter={() => setActiveModelIndex(index)}
        onClick={() => selectModel(model)}
      >
        <span className="flex min-w-0 flex-col gap-px">
          <span className="truncate text-[12.5px] text-foreground">{name}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {/* The raw id rides along whenever the display name replaced it —
                it's what error messages and the transcript notice cite. */}
            {name === model.modelId ? model.providerName : `${model.providerName} · ${model.modelId}`}
          </span>
        </span>
        {current && <Check className="size-[13px] shrink-0 text-primary" strokeWidth={2.4} aria-hidden />}
      </button>
    );
  };
  // The selected model's reasoning dial: which levels it takes (declared by
  // its provider, or derived from the pi catalog), the user's stored choice,
  // and the backend default that carries the "Default" badge. Empty ⇒ the
  // model has no dial and the reasoning control disappears with it — the
  // control exists exactly when it means something.
  const thinkingProvider = selectedProvider(providerSettings);
  const thinkingModelId = providerSettings.selectedModel?.modelId;
  const thinkingDeclared = thinkingModelId ? thinkingProvider?.modelThinking?.[thinkingModelId] : undefined;
  const thinkingOptions =
    thinkingProvider && thinkingModelId
      ? supportedThinkingLevels(thinkingProvider.kind, thinkingModelId, thinkingDeclared?.levels)
      : [];
  const chosenThinkingLevel = selectedThinkingLevel(providerSettings);
  // What the trigger reads: a stored override by name, else the provider's
  // declared default by name, else the word "Default" — no override stored
  // means the backend decides, and the label says so in words.
  const reasoningTriggerLabel =
    chosenThinkingLevel !== undefined
      ? THINKING_LEVEL_LABELS[chosenThinkingLevel]
      : thinkingDeclared?.defaultLevel !== undefined
        ? THINKING_LEVEL_LABELS[thinkingDeclared.defaultLevel]
        : "Default";
  const composerHasContent = !draftEmpty || pendingAnnotation !== null;
  // A fresh, unbound chat while the user is on a browser or extension page:
  // there is no page a first message could work on, so the composer refuses to
  // start one (and the empty state says why). Once a tab is bound — or the
  // conversation already has messages — the chat targets its own tab and the
  // user's focus is irrelevant, so the gate stays out of the way.
  const pageBlocked = !boundTab && messages.length === 0 && activePage.kind === "not-web";
  // The status cap fused to the composer card: a hover hint from an action
  // button wins while the pointer is over it, then transient panel status,
  // then the markup-mode state. No filler — when there's nothing to say the
  // cap collapses away entirely. The tint keys on markup mode alone, so the
  // cap and the pencil toggle flip together.
  const capText =
    hoverHint || statusText || (annotating ? "Markup is on — draw on the page, then press Done there" : "");
  // Hover/focus handlers standing in for a native title tooltip. Activating
  // the control clears the hint (capture phase, so it composes with the
  // button's own onClick) — the action's resulting status should show, not
  // the hint for the button just pressed.
  const statusHint = (text: string) => ({
    onMouseEnter: () => setHoverHint(text),
    onMouseLeave: () => setHoverHint(""),
    onFocus: () => setHoverHint(text),
    onBlur: () => setHoverHint(""),
    onClickCapture: () => setHoverHint(""),
  });

  return (
    <div className="flex h-dvh flex-col bg-card">
      {approvalProposal && (
        <div
          id="capability-approval"
          className="fixed inset-0 z-50 flex items-end bg-black/45 p-3"
          role="dialog"
          aria-modal="true"
          aria-labelledby="capability-approval-title"
        >
          {/* One raised surface and no lines: the panel is bg-secondary with a
              shadow, no border, and the rows inside are plain text marked by an
              icon rather than boxed (wiki/design/permission-copy.md, "Dialog
              layout"). */}
          <div className="w-full rounded-xl bg-secondary p-4 shadow-xl">
            <h2 id="capability-approval-title" className="text-sm font-semibold">
              {approvalDialogTitle(approvalProposal)}
            </h2>
            <ul className="mt-3.5 flex flex-col gap-3.5">
              {/* Scope row, ABOVE the capability rows. The copy is panel-authored
                  (scopeExplanation) from the manifest's own matches/siteKey —
                  never model prose — so a remixlet cannot describe its own reach. */}
              {(() => {
                const scope = scopeExplanation(approvalProposal.matches, approvalProposal.siteKey);
                return (
                  <li id="capability-approval-scope" className="flex items-start gap-2.5">
                    <SCOPE_ICON className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[13px] leading-[18px] font-medium">{scope.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{scope.detail}</p>
                    </div>
                  </li>
                );
              })()}
              {approvalProposal.added.map((capability) => {
                // Extension-authored copy only (H2): the manifest's rationale
                // stays in the approval record and never renders here — the
                // chat has already said why the agent is asking.
                const copy = capabilityExplanation(capability);
                const Icon = capabilityIcon(capability);
                return (
                  <li key={capability} className="flex items-start gap-2.5">
                    <Icon className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[13px] leading-[18px] font-medium">{copy.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{copy.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {approvalProposal.offSite && (
              // The site term (remediation plan item 7): the code would run
              // outside the site this chat is bound to, or the request has no
              // page binding at all. Panel-authored, never model prose; the
              // scope card above names every host.
              <p id="capability-approval-off-site" className="mt-3.5 text-xs text-muted-foreground">
                {approvalProposal.authorizedSite
                  ? `This chat is working on ${approvalProposal.authorizedSite}, but the remixlet would run on sites outside it.`
                  : "This request is not tied to a page you are working on, so the sites it runs on need your approval."}
              </p>
            )}
            {approvalProposal.netRulesChanged && (
              // Item 9: a netrules remixlet whose rules file content changed
              // versus what was approved. Panel-authored, never model prose.
              <p id="capability-approval-netrules-changed" className="mt-3.5 text-xs text-muted-foreground">
                Its network rules — what it blocks, redirects, or changes — are different from the ones you approved before.
              </p>
            )}
            {approvalProposal.removed.length > 0 && (
              // The replacement half of a capability swap: this activation
              // durably drops these grants, and saying so is what keeps the
              // ask from reading as ever-growing access.
              <p id="capability-approval-removed" className="mt-3.5 text-xs text-muted-foreground">
                {capabilityRemovalNote(approvalProposal.removed)}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button id="capability-deny" type="button" variant="ghost" onClick={() => resolveCapabilityApproval(false)}>
                Don’t allow
              </Button>
              <Button id="capability-approve" type="button" onClick={() => resolveCapabilityApproval(true)}>
                Allow and apply
              </Button>
            </div>
          </div>
        </div>
      )}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line-soft)] px-4 py-3">
        {/* The browser's own chrome already titles the panel "Remixlet", so
            the wordmark stays screen-reader-only. The host mirrors the tab
            binding, so it appears once bound. */}
        <div className="flex min-w-0 items-center gap-2">
          {/* While the history list is open the left side becomes the way
              back — someone who tapped the history icon mid-chat needs an
              obvious return to the conversation they were in. Chat view
              keeps the wordmark/host here as before. */}
          {view === "history" ? (
            <Button
              id="history-back"
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-[26px] gap-1.5 rounded-[7px] px-2 text-xs font-medium text-muted-foreground"
              {...statusHint("Back to the chat")}
              onClick={() => setView("chat")}
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          ) : (
            <>
              <h1 className="sr-only">Remixlet</h1>
              {boundHost && <span className="min-w-0 truncate text-xs text-muted-foreground">{boundHost}</span>}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            id="history"
            type="button"
            variant="ghost"
            size="icon-sm"
            className={`size-[26px] rounded-[7px] ${view === "history" ? "bg-foreground/7 text-foreground" : ""}`}
            aria-label={view === "history" ? "Back to the chat" : "Conversation history"}
            aria-pressed={view === "history"}
            {...statusHint(view === "history" ? "Back to the chat" : "Conversation history")}
            disabled={running}
            onClick={() => (view === "history" ? setView("chat") : openHistory())}
          >
            <History className="size-3.5" />
          </Button>
          <Button
            id="open-manager"
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-[26px] rounded-[7px]"
            aria-label="Manage remixlets"
            {...statusHint("Manage remixlets")}
            onClick={openManager}
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
          {/* No settings affordance here — Choose a model falls back to
              openSecureSettings when nothing is configured. */}
        </div>
      </header>

      {/* One bar: what this chat works on, and the way to start a fresh one.
          It appears only once a tab is bound — an unbound chat is already the
          fresh one, so there is nothing to say and nothing to offer. A
          conversation then stays on the tab it bound; retargeting it is
          recovery only, offered by the blocking decision screen when the
          binding is lost, never as an everyday control. */}
      {boundTab && view === "chat" && (
        <div
          id="bound-tab"
          className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <SiteIcon eager siteKey={boundTab.siteKey} pageOrigin={boundTab.origin} favIconUrl={boundTab.favIconUrl} className="size-3.5" />
          <button
            id="show-bound-tab"
            type="button"
            className="min-w-0 truncate rounded-sm text-left hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={boundTab.title || boundTab.siteKey}
            {...statusHint("Go to this tab")}
            onClick={showBoundTab}
          >
            Working on: {boundTab.title || boundTab.siteKey || "this tab"}
          </button>
          <Button
            id="new-chat"
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 shrink-0 gap-1 px-2 text-xs"
            disabled={running}
            {...statusHint("Start a new conversation")}
            onClick={startNewConversation}
          >
            <MessageSquarePlus className="size-3.5" />
            New chat
          </Button>
        </div>
      )}

      {/* Everything from here down to the composer belongs to the CURRENT
          chat. The history view hides all of it — a setup alert or a live
          composer floating over the conversation list reads as part of the
          list (and the composer would type into a chat the user can't see).
          A pending tab-binding decision hides it too: the screen below is the
          whole panel until the user opens the site or goes back. */}
      {view === "chat" && !bindingIssue && capabilities && !capabilities.box && (
        <Alert variant="default" className="m-3 mb-0 w-auto shrink-0" id="limited-mode-alert">
          <AlertTitle>JavaScript remixlets aren’t available</AlertTitle>
          <AlertDescription>{capabilities.disabledReasons.box}</AlertDescription>
        </Alert>
      )}

      {view === "chat" && !bindingIssue && !providerReady && (
        <Alert className="m-4 mb-0 w-auto shrink-0 !gap-0 !p-4" id="provider-alert">
          <AlertTitle className="text-base">Connect a model securely</AlertTitle>
          <AlertDescription className="mt-1 leading-relaxed">
            Add a provider and check its available models on the dedicated settings page.
          </AlertDescription>
          <div className="mt-4 flex justify-end">
            <Button id="open-secure-settings" type="button" variant="outline" size="sm" onClick={openSecureSettings}>
              Open settings
            </Button>
          </div>
        </Alert>
      )}

      {view === "chat" && bindingIssue ? (
        // The chat cannot continue without a tab on its site, so a lost or
        // unresolvable binding is a BLOCKING decision, not a dismissable card:
        // the screen replaces the transcript and composer until the user opens
        // the site or goes back to their chats. Design: the "Remixlet Decision
        // Screens" canvas (2026-08-21).
        <div id="tab-binding-decision" className="flex flex-1 flex-col items-center justify-center p-6">
          <div className="flex w-full max-w-70 flex-col items-center gap-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <AppWindow className="size-5.5" strokeWidth={1.75} aria-hidden />
            </div>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-[15px] leading-snug font-semibold">
                {bindingIssue.kind === "no-site-tab"
                  ? `No open tab is on ${bindingIssue.siteKey}`
                  : bindingIssue.kind === "moved"
                    ? `This chat works on ${bindingIssue.siteKey}`
                    : bindingIssue.siteKey
                      ? `The ${bindingIssue.siteKey} tab was closed`
                      : "The tab this chat was working on is closed"}
              </h2>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {/* The move gets its own sentence: the tab is open and still
                    bound, it is just somewhere else, and saying where is what
                    tells the user whether they did it or the site did. */}
                {bindingIssue.kind === "moved"
                  ? (bindingIssue.now
                      ? `That tab is now showing ${bindingIssue.now}.`
                      : "That tab is no longer showing a web page.") +
                    ` Nothing was read from it. Open ${bindingIssue.siteKey} again to keep going.`
                  : bindingIssue.siteKey
                    ? `This chat works on ${bindingIssue.siteKey}. ` +
                      (bindingIssue.kind === "no-site-tab"
                        ? "Open the site to continue where it left off."
                        : "Reopen the site to keep going.")
                    : "Point the chat at the tab you're looking at now, or go back to your chats."}
              </p>
            </div>
            <div className="mt-2 flex w-full flex-col gap-2">
              {bindingIssue.siteKey ? (
                <Button
                  id="open-site-and-bind"
                  type="button"
                  onClick={() => openSiteAndBind(bindingIssue.siteKey)}
                >
                  {bindingIssue.kind === "tab-closed" ? "Reopen" : "Open"} {bindingIssue.siteKey}
                </Button>
              ) : (
                // A binding without a site (bound to a page no site key could
                // be derived from) has no site to reopen — the current tab is
                // the only offer left.
                <Button id="rebind-tab-card" type="button" onClick={rebindToCurrentTab}>
                  Use this tab
                </Button>
              )}
              <Button id="binding-back-to-chats" type="button" variant="ghost" onClick={openHistory}>
                Back to chats
              </Button>
            </div>
          </div>
        </div>
      ) : view === "history" ? (
        // Same reading order as the control center's Chats index: newest
        // first under "Today / Yesterday / Sat 15 Aug" headers, each row a
        // title over favicon + site + time-of-day (the day lives in the
        // header). The `.conversation` class + data-id stay the resume
        // control the conversation suite clicks.
        <div id="history-list" className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
          {/* The way out is explicit: a New chat row at the top of the list.
              Picking a conversation resumes it; this starts a fresh one. The
              header's history toggle also returns to the current chat. */}
          <button
            id="history-new-chat"
            type="button"
            disabled={running}
            className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--line-soft)] px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
            onClick={startNewConversation}
          >
            <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
            New chat
          </button>
          {conversations.length === 0 && <p className="m-auto text-sm text-muted-foreground">No conversations yet.</p>}
          {groupByDay(conversations, (meta) => meta.updatedAt, new Date()).map((group) => (
            <section key={group.label} className="flex flex-col gap-0.5">
              <h2 className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </h2>
              {group.items.map((meta) => (
                <button
                  key={meta.id}
                  type="button"
                  className="conversation flex min-w-0 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
                  data-id={meta.id}
                  onClick={() => resumeConversation(meta)}
                >
                  <span className="w-full truncate text-sm">{meta.title || "Untitled conversation"}</span>
                  <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
                    {meta.siteKey && (
                      <>
                        <SiteIcon icons={siteIcons} siteKey={meta.siteKey} className="size-3.5" />
                        <span className="truncate">{meta.siteKey}</span>
                      </>
                    )}
                    <span className="ml-auto shrink-0 tabular-nums">{timeFormat.format(meta.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      ) : (
        // The message scroller owns transcript scrolling: it follows the live
        // edge while a reply streams and stays put once the reader scrolls up.
        // No scrollAnchor on items — anchoring a user turn switches the
        // scroller into anchored-to-message mode, which pins that turn to the
        // top and stops following the bottom until an explicit wheel/touch/key
        // gesture breaks it.
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              {/* Tight base gap so consecutive activity rows read as one list;
                  bubbles push their own breathing room out via `.msg` margins. */}
              <MessageScrollerContent id="chat" className="gap-[7px] p-4">
                {/* Inside #chat but deliberately NOT a `.msg` row — the
                    conversation suite reconstructs transcripts from
                    `#chat .msg`, same rule the version-event dividers follow. */}
                {messages.length === 0 && !running && <StartHere page={activePage} />}
                {messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={String(message.id)}
                    className="flex flex-col"
                  >
                    {message.notice ? (
                      // Chat notice divider — same frame as a version event and,
                      // like it, deliberately NOT a `.msg` row.
                      <div className="chat-notice my-0.5 flex items-center gap-2.5">
                        <span className="h-px flex-1 bg-[var(--line-soft)]" aria-hidden />
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Sparkles className="size-[11px] shrink-0" aria-hidden />
                          <span>{message.text}</span>
                        </span>
                        <span className="h-px flex-1 bg-[var(--line-soft)]" aria-hidden />
                      </div>
                    ) : message.versionEvent ? (
                      // Version event divider — deliberately NOT a `.msg` row:
                      // the conversation suite reads only `#chat .msg`.
                      <div className="version-event my-0.5 flex items-center gap-2.5">
                        <span className="h-px flex-1 bg-[var(--line-soft)]" aria-hidden />
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Check className="size-[11px] shrink-0 text-primary" strokeWidth={2.4} aria-hidden />
                          <span>
                            <button
                              type="button"
                              className="version-link underline underline-offset-2 hover:text-foreground"
                              title={`Open "${message.versionEvent.remixletName}" in the control center`}
                              onClick={() => openRemixletPage(message.versionEvent!.remixletId)}
                            >
                              v{message.versionEvent.version}
                            </button>{" "}
                            applied
                          </span>
                          {/* Revert restores THIS line's version, so the line
                              matching the remixlet's current version gets no
                              button — there's nothing to restore. It gets
                              "Show what changed" instead: the stored
                              verification spots describe the CURRENT version,
                              so only its own line may claim them. */}
                          {currentVersions[message.versionEvent.remixletId] !== message.versionEvent.version ? (
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                              disabled={running}
                              onClick={() => revertVersionEvent(message.versionEvent!)}
                            >
                              Revert
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="show-changes underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                              disabled={running}
                              onClick={() => showVersionEventChanges(message.versionEvent!)}
                            >
                              Show what changed
                            </button>
                          )}
                        </span>
                        <span className="h-px flex-1 bg-[var(--line-soft)]" aria-hidden />
                      </div>
                    ) : message.thinking ? (
                      // Working notes ("detailed" verbosity) — muted and
                      // deliberately NOT a `.msg` row: the conversation suite
                      // reads only `#chat .msg`, and notes aren't transcript.
                      <div className="thinking-note border-l-2 border-[var(--line-soft)] pl-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
                        {message.text}
                      </div>
                    ) : (
                      /* className stays exactly `msg <kind>` — the conversation
                         suite reconstructs the transcript from it. Status lives
                         on the icon, never in another class here. */
                      <div className={`msg ${message.kind}`}>
                        {message.kind === "assistant" ? (
                          <Response>{message.text}</Response>
                        ) : (
                          <MessageBody message={message} />
                        )}
                      </div>
                    )}
                  </MessageScrollerItem>
                ))}
                {running && <TurnStatus wait={modelWait} elapsedMs={elapsedMs} />}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}

      {view === "chat" && capabilityRequest && (
        <PermissionCard
          id="capability-request"
          title="Remixlet needs permission"
          rows={capabilityRequest.capabilities.map((capability) => ({
            ...capabilityExplanation(capability),
            icon: capabilityIcon(capability),
          }))}
          allowLabel="Allow"
          allowDisabled={running || !providerReady}
          onAllow={authorizeCapabilityRequest}
          onDismiss={() => setCapabilityRequest(null)}
        />
      )}

      {view === "chat" && devObserveRequest && !capabilityRequest && (
        // The dev-observe ask (wiki/raw/handoffs/2026-08-10-broad-observe-session-
        // grant.md): session-scoped grant on Allow, and Allow reloads the page,
        // so the button says so.
        <PermissionCard
          id="dev-observe-request"
          title="Remixlet needs a closer look"
          rows={[{ ...DEV_OBSERVE_EXPLANATION, icon: DEV_OBSERVE_ICON }]}
          allowLabel="Allow and reload"
          allowDisabled={running || !providerReady}
          onAllow={authorizeDevObserveRequest}
          onDismiss={() => setDevObserveRequest(false)}
        />
      )}

      {view === "chat" && !bindingIssue && queuedPrompts.length > 0 && (
        <div id="prompt-queue" className="shrink-0 border-t bg-muted/35 px-3 py-2" aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              Next up · {queuedPrompts.length}
            </span>
            {!running && (
              <Button id="run-queued" type="button" variant="ghost" size="xs" onClick={runQueuedPrompts}>
                <Play />
                Continue
              </Button>
            )}
          </div>
          <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
            {queuedPrompts.map((prompt) => (
              <div
                key={prompt.id}
                className="queued-prompt flex items-center gap-1.5 rounded-md border bg-background px-2 py-1"
                data-id={prompt.id}
              >
                <span className="min-w-0 flex-1 truncate text-xs">{prompt.text}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove queued message: ${prompt.text}`}
                  {...statusHint("Remove from queue")}
                  onClick={() => removeQueuedPrompt(prompt.id)}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The composer is ONE integrated card: status cap, textarea, toolbar
          (model chip · markup toggle · send), and the inline model menu share
          a surface and a focus ring that lights the whole card. */}
      {/* Hidden (not unmounted) while the history view or the tab-binding
          decision screen is up: the textarea is uncontrolled, so unmounting
          would drop a half-typed draft. display:none also takes it out of the
          tab order, so nothing can submit into a chat the user can't see (or
          into a chat with no tab to work on). */}
      <form
        id="composer"
        onSubmit={handleSubmit}
        className={`shrink-0 flex-col gap-2 px-3 pb-3 ${view === "history" || bindingIssue ? "hidden" : "flex"}`}
      >
        {pendingAnnotation && (
          // Attachment card (annotate-mode design handoff): what the next
          // message carries — the numbered marks with their notes.
          <div id="annotation-chip" className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-2.5">
            <div className="flex items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-deep)]">
                <Square className="size-3 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold leading-tight">Page annotation</div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground">
                  {hostOf(pendingAnnotation.url) || "the page"} ·{" "}
                  {pendingAnnotation.marks.length === 1 ? "1 annotation" : `${pendingAnnotation.marks.length} annotations`}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Discard the marks drawn on the page"
                {...statusHint("Discard the marks")}
                onClick={discardPendingAnnotation}
              >
                <X />
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {pendingAnnotation.marks.map((mark, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{mark.note.length > 0 ? mark.note : "Marked area"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div
          className={`flex flex-col overflow-hidden rounded-xl bg-secondary transition-shadow duration-150 ${
            composerFocused
              ? "shadow-[0_0_0_1px_var(--accent),0_0_0_4px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
              : "shadow-[var(--ring-1)]"
          }`}
        >
          <textarea
            id="input"
            ref={inputRef}
            rows={2}
            disabled={pageBlocked}
            placeholder={
              pageBlocked
                ? "Switch to a website to start a chat"
                : running
                  ? "Add a message for the next turn…"
                  : "Describe how this page should change…"
            }
            className="field-sizing-content max-h-40 min-h-[58px] w-full resize-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-[19px] text-foreground outline-none placeholder:text-muted-foreground"
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onInput={(event) => setDraftEmpty(event.currentTarget.value.trim().length === 0)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {/* Toolbar chips are lean on purpose: a side panel can be 320px
              wide, and every pixel of chrome (padding, caret) comes straight
              out of the model name. The hover fill is the whole "this opens a
              menu" affordance; the menu itself opens on click only. When the
              row overflows, only the model name truncates: the reasoning chip
              is shrink-0, since "Medi…" tells the user nothing. */}
          <div className="flex items-center gap-1 p-2">
            <button
              id="chat-model"
              type="button"
              disabled={running}
              aria-label="Choose model"
              aria-expanded={modelMenuOpen}
              {...statusHint("Model")}
              className="inline-flex h-7 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/7 hover:text-foreground disabled:opacity-50"
              onClick={() => {
                if (modelOptions.length === 0) {
                  openSecureSettings();
                  return;
                }
                if (modelMenuOpen) setComposerMenu(null);
                else openModelMenu();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && !modelMenuOpen && modelOptions.length > 0) {
                  event.preventDefault();
                  openModelMenu();
                }
              }}
            >
              {/* The provider's mark, so two providers serving the same model
                  id stay tellable apart while the menu is closed. */}
              {thinkingProvider && providerSettings.selectedModel ? (
                <ProviderLogo kind={thinkingProvider.kind} className="size-3 shrink-0" />
              ) : (
                <Sparkles className="size-3 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 max-w-40 truncate">
                {thinkingProvider && providerSettings.selectedModel
                  ? modelDisplayName({ providerKind: thinkingProvider.kind, modelId: providerSettings.selectedModel.modelId })
                  : "Choose a model"}
              </span>
            </button>
            {thinkingOptions.length > 0 && (
              <button
                id="chat-reasoning"
                type="button"
                disabled={running}
                aria-label="Choose reasoning level"
                aria-expanded={reasoningMenuOpen}
                {...statusHint("Reasoning level")}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/7 hover:text-foreground disabled:opacity-50"
                onClick={() => setComposerMenu(reasoningMenuOpen ? null : "reasoning")}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && !reasoningMenuOpen) {
                    event.preventDefault();
                    setComposerMenu("reasoning");
                  }
                }}
              >
                <Brain className="size-3 shrink-0" aria-hidden />
                <span className="max-w-24 truncate">{reasoningTriggerLabel}</span>
              </button>
            )}
            <div className="flex-1" />
            <button
              id="markup-page"
              type="button"
              disabled={running || pageBlocked}
              aria-label="Draw on the page"
              aria-pressed={annotating}
              {...statusHint(annotating ? "Markup mode is open on the page" : "Draw on the page to show what you mean")}
              className={`inline-flex size-7 shrink-0 items-center justify-center rounded-lg disabled:opacity-50 ${
                annotating
                  ? "bg-[var(--accent-deep)] text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_50%,transparent)]"
                  : "text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
              }`}
              onClick={startMarkup}
            >
              <PenLine className="size-3.5" aria-hidden />
            </button>
            <button
              id="send"
              type="submit"
              disabled={!providerReady || pageBlocked}
              aria-label={running || queuedPrompts.length > 0 ? "Queue message" : "Send"}
              {...statusHint(running || queuedPrompts.length > 0 ? "Queue for next turn" : "Send")}
              className={`inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-100 disabled:opacity-50 ${
                composerHasContent ? "bg-primary text-primary-foreground" : "bg-foreground/7 text-foreground/35"
              }`}
            >
              <ArrowUp className="size-3.5" strokeWidth={2.2} aria-hidden />
            </button>
            {running && (
              <button
                id="stop"
                type="button"
                aria-label="Stop agent"
                {...statusHint("Stop agent")}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-destructive text-white"
                onClick={stopCurrentTurn}
              >
                <Square className="size-3 fill-current" aria-hidden />
              </button>
            )}
          </div>
          {modelMenuOpen && (
            <div id="model-menu" className="flex flex-col gap-0.5 border-t border-[var(--line-soft)] p-1.5">
              <input
                id="model-search"
                type="text"
                autoFocus
                value={modelQuery}
                placeholder="Search models"
                aria-label="Search models"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded
                aria-controls="model-listbox"
                aria-autocomplete="list"
                aria-activedescendant={modelMenuItems.length > 0 ? modelOptionId(activeModelPos) : undefined}
                className="mb-0.5 h-7 rounded-[7px] border border-[var(--line-soft)] bg-transparent px-2 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/45"
                onChange={(event) => {
                  setModelQuery(event.target.value);
                  setActiveModelIndex(0);
                }}
                onKeyDown={(event) => {
                  const count = modelMenuItems.length;
                  const step = (next: number): void => {
                    event.preventDefault();
                    setActiveModelIndex(next);
                    document.getElementById(modelOptionId(next))?.scrollIntoView({ block: "nearest" });
                  };
                  if (event.key === "ArrowDown" && count > 0) step((activeModelPos + 1) % count);
                  if (event.key === "ArrowUp" && count > 0) step((activeModelPos - 1 + count) % count);
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeModelMenu();
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const item = modelMenuItems[activeModelPos];
                    if (!item) return;
                    if (item.kind === "model") selectModel(item.model);
                    else setAllModelsOpen((open) => !open);
                  }
                }}
              />
              {/* Constant height regardless of row count: the menu hangs off a
                  bottom-anchored card, so any height change while typing would
                  move the search input under the user's fingers. The list
                  scrolls instead. */}
              <div id="model-listbox" role="listbox" aria-label="Models" className="flex h-[264px] flex-col gap-0.5 overflow-y-auto">
                {modelMenuItems.map((item, index) =>
                  item.kind === "model" ? (
                    modelRow(item.model, index)
                  ) : (
                    <button
                      key="all-models"
                      id="all-models"
                      type="button"
                      role="option"
                      aria-selected={false}
                      aria-expanded={allModelsOpen}
                      tabIndex={-1}
                      className={`flex shrink-0 items-center gap-[5px] rounded-[7px] px-2 py-[7px] text-left text-[11px] font-medium ${
                        index === activeModelPos ? "bg-foreground/7 text-foreground" : "text-muted-foreground"
                      }`}
                      onMouseEnter={() => setActiveModelIndex(index)}
                      onClick={() => setAllModelsOpen((open) => !open)}
                    >
                      <ChevronDown
                        className={`size-2.5 shrink-0 transition-transform ${allModelsOpen ? "" : "-rotate-90"}`}
                        aria-hidden
                      />
                      All models ({extraModels.length})
                    </button>
                  ),
                )}
                {filteredModels && filteredModels.length === 0 && (
                  <p className="shrink-0 px-2 py-[7px] text-[11px] text-muted-foreground">
                    No models match “{modelQuery.trim()}”
                  </p>
                )}
              </div>
            </div>
          )}
          {reasoningMenuOpen && (
            <div
              id="reasoning-menu"
              role="radiogroup"
              aria-label="Reasoning level"
              className="flex flex-col gap-0.5 border-t border-[var(--line-soft)] p-1.5"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeReasoningMenu();
                  return;
                }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
                const at = rows.findIndex((row) => row === document.activeElement);
                const count = rows.length;
                if (count === 0) return;
                rows[(at + (event.key === "ArrowDown" ? 1 : -1) + count) % count]?.focus();
              }}
            >
              {/* A model whose provider names no default gets a "Default" row
                  meaning "let the provider decide" — choosing it clears the
                  stored override, which is also what choosing the declared
                  default (badged below) does. The stored map only ever holds
                  deliberate overrides. */}
              {thinkingDeclared?.defaultLevel === undefined && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosenThinkingLevel === undefined}
                  tabIndex={-1}
                  className="flex shrink-0 items-center justify-between gap-2 rounded-[7px] px-2 py-[7px] text-left outline-none hover:bg-foreground/7 focus:bg-foreground/7"
                  onClick={() => selectThinkingLevel(undefined)}
                >
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="truncate text-[12.5px] text-foreground">Default</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      Let {thinkingProvider?.name ?? "the provider"} decide
                    </span>
                  </span>
                  {chosenThinkingLevel === undefined && (
                    <Check className="size-[13px] shrink-0 text-primary" strokeWidth={2.4} aria-hidden />
                  )}
                </button>
              )}
              {thinkingOptions.map((level) => {
                const isDeclaredDefault = level === thinkingDeclared?.defaultLevel;
                const current = level === (chosenThinkingLevel ?? thinkingDeclared?.defaultLevel);
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={current}
                    tabIndex={-1}
                    className="flex shrink-0 items-center justify-between gap-2 rounded-[7px] px-2 py-[7px] text-left outline-none hover:bg-foreground/7 focus:bg-foreground/7"
                    onClick={() => selectThinkingLevel(isDeclaredDefault ? undefined : level)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12.5px] text-foreground">{THINKING_LEVEL_LABELS[level]}</span>
                      {isDeclaredDefault && (
                        <span className="shrink-0 rounded-full border border-[var(--line-soft)] px-1.5 text-[10px] text-muted-foreground">
                          Default
                        </span>
                      )}
                    </span>
                    {current && <Check className="size-[13px] shrink-0 text-primary" strokeWidth={2.4} aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </form>

      {/* Panel status bar — a fixed-height footer on every pane. It used to be
          a cap fused to the composer card, but the history view and the
          tab-binding decision screen hide the composer, so status could never
          show there. Constant 30px (border + 7px padding ×2 + 15px line) so
          appearing text never shifts the layout above; stays mounted so
          aria-live announces it. Tint and dot flip with markup mode. */}
      <div
        id="panel-status"
        aria-live="polite"
        className={`flex h-[30px] shrink-0 items-center gap-2 border-t px-3.5 ${
          annotating ? "border-primary/25 bg-primary/12" : "border-[var(--line-soft)] bg-foreground/4"
        }`}
      >
        {capText && (
          <>
            {/* A hover hint is informational — it gets the info glyph; real
                panel status keeps the signal dot. The dot sits in a glyph-wide
                slot so the text's left edge never shifts between the two. */}
            {hoverHint ? (
              <Info className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
                <span
                  className={`size-1.5 rounded-full ${annotating ? "animate-pulse bg-primary" : "bg-[var(--signal)]"}`}
                />
              </span>
            )}
            <span
              className={`min-w-0 truncate text-[11.5px] leading-[15px] font-medium ${
                annotating ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {capText}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
