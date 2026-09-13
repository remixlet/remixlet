// The chat's plain-English presentation layer, shared by the panel's live
// transcript and the control center's read-only chat view — one catalogue so
// a stored conversation replays with exactly the phrases and icons the
// sidebar showed live.
//
// Tool calls are shown to non-technical users, so never surface tool names or
// JSON. Each tool maps to a plain-English "what/why" phrase in three tenses:
// while it runs, when it finishes, and if it fails, plus the icon its activity
// row carries. The icon says WHICH KIND of step this was (look, scan, measure,
// write) — a column of identical ticks tells the reader nothing. Status is
// carried by the icon's colour, not by swapping in a different glyph, so a
// finished run reads as a list of distinct actions rather than a checklist.

import {
  BadgeCheck,
  Braces,
  Bug,
  CircleDashed,
  CirclePause,
  CircleX,
  Compass,
  Crosshair,
  Eye,
  FileCode,
  Layers,
  MousePointerClick,
  Navigation,
  Network,
  Repeat2,
  Ruler,
  Search,
  ShieldCheck,
  Tags,
  Undo2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";

import { classifyToolFailure, isContractNudgePrompt, type SessionTranscriptItem } from "../agent/index.js";
import type { AgentRuntimeEvent, ModelWaitEvent } from "../agent/types.js";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import {
  capabilityGrantActionLabel,
  capabilityGrantFromPrompt,
  DEV_OBSERVE_GRANT_ACTION_LABEL,
  isDevObserveGrantPrompt,
} from "./capability-request.js";

export type MessageKind = "user" | "assistant" | "tool" | "error";
// Activity rows (kind "tool") carry an icon and the state it's in; the state
// only ever changes the icon's colour, never the `msg <kind>` className the
// conversation suite reads. "held" is a step the contract bounced: it waited
// for an earlier step, and the row says which in plain words.
export type ActivityState = "active" | "done" | "failed" | "held";

export interface ToolPhrase {
  active: string;
  done: string;
  failed: string;
  icon: LucideIcon;
}

type ToolInput = Extract<AgentRuntimeEvent, { kind: "tool_start" }>["args"];
type ToolEndDetails = Extract<AgentRuntimeEvent, { kind: "tool_end" }>["details"];

// Failure is the one state that DOES override the tool's own icon: it's rare,
// and being unmistakable matters more there than being specific. HELD_ICON
// remains for the finish-check action row; BOUNCED_ICON marks a step the
// contract held (the pause says "waited", where the tool's own icon would
// claim the step happened).
export const FAILED_ICON = CircleX;
export const HELD_ICON = Undo2;
export const BOUNCED_ICON = CirclePause;

// A contract bounce (tool-errors.ts): the extension held a step because an
// earlier one had not happened yet, and the agent redoes the order. The user
// reads it as one calm line in the flow. It has to be readable: on the
// 2026-09-09 SoundCloud run two bounced writes each cost a full ~40 s
// regeneration and, dropped from the chat, made the visible verification
// steps look like the slow part. An earlier design showed a red icon with no
// words, which alarmed without explaining; a plain sentence with the reason
// is what a person can actually use. The raw contract text is harness-to-
// agent choreography (tool names, prescribed recoveries) and never renders.
//
// Each contract family gets its own words, keyed on a stable fragment of the
// message contracts.ts throws. Write bounces say "held"/"paused" rather than
// "rejected": a held write is re-submitted, and the words stay true whether
// the model resends the files or only asks for them to go through. Nothing
// here names a capability or a remixlet id — the hostile-page case bounces
// on an attacker-chosen capability, and its name must not reach the chat.
export const BOUNCE_FALLBACK_TEXT = "Paused a step until an earlier one is done";
const BOUNCE_PHRASES: readonly { needle: string; text: string }[] = [
  // write_remixlet (contracts.ts #assertWriteAllowed), in check order.
  { needle: "list_remixlets must succeed before write_remixlet", text: "Held the write for a moment: existing remixlets have to be checked first" },
  { needle: "capture_page must successfully capture the page before write_remixlet", text: "Held the write for a moment: the page needs a fresh look first" },
  { needle: "has no user grant behind it", text: "Held the write until you decide on the access below" },
  { needle: "has not been granted by the user", text: "Held the write until you decide on the access below" },
  { needle: "read_remixlet must succeed for existing remixlet", text: "Held the write for a moment: the existing remixlet has to be read before it's changed" },
  { needle: "assess_feasibility must succeed before write_remixlet", text: "Held the write for a moment: whether this is possible has to be checked first" },
  { needle: "read_remixlet_logs has not run since that failure", text: "Paused the rewrite: the runtime log has to be read after that failed check" },
  { needle: "the logs since the failure are empty", text: "Paused the rewrite: the next version has to record what it does, so the failure can be traced" },
  { needle: "no inspect_design ran this turn", text: "Held the write for a moment: the page's own styling has to be looked at before adding a control" },
  { needle: 'verdict was "infeasible"', text: "Held the write: the check found this isn't possible on this page, so nothing gets built on a guess" },
  { needle: 'verdict was "needs-network-visibility"', text: "Held the write: the data the page loads has to be seen first" },
  // write_remixlet shape checks (contracts.ts parseWriteTarget): an incomplete file set.
  { needle: "write_remixlet files are missing", text: "Held the write: the file set was incomplete, so it's being redone" },
  { needle: "write_remixlet must include", text: "Held the write: the file set was incomplete, so it's being redone" },
  { needle: "remixlet.json is not valid JSON", text: "Held the write: the file set was incomplete, so it's being redone" },
  { needle: "remixlet.json has no id", text: "Held the write: the file set was incomplete, so it's being redone" },
  { needle: "capabilities must be an array", text: "Held the write: the file set was incomplete, so it's being redone" },
  // assess_feasibility.
  { needle: "assess_feasibility must run after observing the page", text: "Held the feasibility check for a moment: the page has to be looked at first" },
  { needle: "Refused: the evidence cites", text: "Held the feasibility check: it leaned on a leftover mark from an old remixlet, not on the page itself" },
  // record_look.
  { needle: "record_look must follow a look_at_change", text: "Held the note for a moment: the new control has to be looked at first" },
];

/** The plain-words line for a bounced step, from the contract's own message; never the message itself. */
export function bouncePhrase(reason: string | undefined): string {
  if (reason === undefined) return BOUNCE_FALLBACK_TEXT;
  return BOUNCE_PHRASES.find((entry) => reason.includes(entry.needle))?.text ?? BOUNCE_FALLBACK_TEXT;
}

// A pre-activation safety review sent a draft back: nothing was saved, the
// page is untouched, and the agent writes a new version in the same turn.
// Rendered as protection working (shield, settled tone), never as a failure —
// the Spotify record-label session showed these as red "Couldn't apply the
// remixlet" rows, which read as the user having broken something.
export const SAFETY_GATE_TEXT = "This version could have misbehaved on the page, so it was sent back — writing a safer one";

// A turn that ended with the contract's finish checks still unmet. The stored
// run_error keeps the raw joined "Contract violation:" prose for the run-log
// diagnostics page, but chat surfaces render these plain words instead: the
// raw text is harness-to-agent choreography (tool-errors.ts), and the
// SoundCloud feed-filter run showed it verbatim in a red bubble directly
// above the permission card it was describing.
export const UNFINISHED_TURN_TEXT =
  "Stopped before finishing every required check — the last change may not be complete or verified. " +
  "Continuing the conversation picks this back up.";

/**
 * The running indicator's words while a model call is in flight. Nothing to
 * say for the first seconds (the ticker beside it already counts); a call the
 * model has kept quiet for a while says so with the wait; a retry says it is
 * one, with the count. `detail` is the plain-words reason of a retry, shown
 * dimmer beside the label.
 */
export const MODEL_WAIT_SLOW_MS = 10_000;
export const THINKING_LABEL = "Thinking…";
export interface TurnStatusWords {
  label: string;
  detail?: string;
}
export function modelWaitLabel(wait: ModelWaitEvent | null): TurnStatusWords {
  if (wait === null || wait.phase === "done") return { label: THINKING_LABEL };
  if (wait.phase === "retrying") {
    return { label: `Connection trouble, retrying (${wait.attempt} of ${wait.maxAttempts})…`, detail: wait.reason };
  }
  if (wait.silenceMs >= MODEL_WAIT_SLOW_MS) {
    return { label: `Still waiting for the model (${Math.round(wait.silenceMs / 1000)}s)` };
  }
  return { label: THINKING_LABEL };
}

/**
 * What a turn-level run error shows in chat: contract text (classified from
 * the message the same way stored tool failures are) becomes the plain
 * unfinished-turn words; anything else — provider errors, setup failures — is
 * already addressed to the user and passes through unchanged.
 */
export function runErrorDisplayText(message: string): string {
  return classifyToolFailure(message) === "bounced" ? UNFINISHED_TURN_TEXT : message;
}

// The user's own "no" to an approval is a decision, not a malfunction: say
// what they chose and where that leaves things, in a settled (never red) row.
function declinedText(toolName: string): string {
  if (toolName === "write_remixlet") return "You declined the extra access — the previous version stays active";
  return "You declined this step";
}

/**
 * How a settled tool call renders, given the failure classification carried on
 * the tool_end event (live) or recovered from the stored result text (replay).
 * A contract bounce settles as a muted "held" row saying why the step waited
 * (bouncePhrase); `reason` is the contract's own message, live or stored.
 */
export function settledToolMessage(
  toolName: string,
  phrase: ToolPhrase,
  outcome: {
    ok: boolean;
    bounced?: boolean;
    reason?: string;
    gateRejected?: boolean;
    declined?: boolean;
    details?: ToolEndDetails;
  },
): TranscriptMessage {
  if (outcome.ok) {
    return { kind: "tool", text: refineDonePhrase(toolName, phrase, outcome.details), icon: phrase.icon, state: "done" };
  }
  if (outcome.bounced) return { kind: "tool", text: bouncePhrase(outcome.reason), icon: BOUNCED_ICON, state: "held" };
  if (outcome.gateRejected) return { kind: "tool", text: SAFETY_GATE_TEXT, icon: ShieldCheck, state: "done" };
  if (outcome.declined) return { kind: "tool", text: declinedText(toolName), icon: phrase.icon, state: "done" };
  return { kind: "tool", text: phrase.failed, icon: FAILED_ICON, state: "failed" };
}

// State is a colour on the icon, nothing else: a running step's icon pulses at
// low contrast, a finished one takes the brand tint, a failed one goes
// destructive, a held one stays at the row's own muted tone (it is neither an
// achievement nor a failure). Same icon, same row geometry throughout — only
// the tone moves.
export const ACTIVITY_ICON_TONE = {
  active: "animate-pulse text-muted-foreground/60",
  done: "text-primary",
  failed: "text-destructive",
  held: "text-muted-foreground",
} satisfies Record<ActivityState, string>;

export function hostOf(url: string | undefined): string {
  if (url === undefined) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// "a", "a and b", "a, b and c" — for listing what a step is gathering.
function joinHuman(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// capture_page args say exactly what it's collecting — turn the flags into a
// human list so the user sees "reading the layout and taking a screenshot"
// instead of a blank "Looking at the page".
interface ToolArguments {
  archive?: boolean;
  code?: string;
  console?: boolean;
  /** replay_network_resource's network id (r12). */
  id?: string;
  network?: boolean;
  screenshot?: string;
  selector?: string;
  url?: string;
}

const ToolArgumentsSchema = Type.Object({
  archive: Type.Optional(Type.Boolean()),
  code: Type.Optional(Type.String()),
  console: Type.Optional(Type.Boolean()),
  id: Type.Optional(Type.String()),
  network: Type.Optional(Type.Boolean()),
  screenshot: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});
const ToolOutcomeDetailsSchema = Type.Object({
  verificationSucceeded: Type.Optional(Type.Boolean()),
  // click_element's outcome: a click the page-side policy refused dispatched
  // nothing, and the row says so instead of claiming the control was tried.
  clicked: Type.Optional(Type.Boolean()),
  refused: Type.Optional(Type.String()),
  // assess_feasibility's verdicts and record_look's share the field name;
  // refineDonePhrase reads it per tool.
  verdict: Type.Optional(
    Type.Union([
      Type.Literal("feasible"),
      Type.Literal("feasible-with-capability"),
      Type.Literal("partial"),
      Type.Literal("infeasible"),
      Type.Literal("matches"),
      Type.Literal("differs"),
      Type.Literal("wrong-kind"),
      Type.Literal("not-reviewable"),
    ]),
  ),
  observed: Type.Optional(Type.String()),
  screenshotDiscarded: Type.Optional(Type.Boolean()),
});

function describeCapture(args: ToolArguments): string {
  const parts = ["reading the layout and text"];
  if (args.screenshot !== undefined && args.screenshot !== "none") parts.push("taking a screenshot");
  if (args.network) parts.push("checking network activity");
  if (args.console) parts.push("reading the console");
  if (args.archive) parts.push("saving a full copy");
  return joinHuman(parts);
}


// The structured probes carry their selector as a plain argument — no code
// parsing needed to say what the step is looking at.
function describeSelector(selector: string | undefined): string {
  return selector !== undefined && selector.length > 0 ? ` — looking at “${selector}”` : "";
}

export function describeTool(toolName: string, args: ToolInput): ToolPhrase {
  const a = Check(ToolArgumentsSchema, args) ? Parse(ToolArgumentsSchema, args) : {};
  switch (toolName) {
    case "capture_page":
      return {
        active: `Looking at the page — ${describeCapture(a)}`,
        done: "Looked at the page",
        failed: "Couldn't read the page",
        icon: Eye,
      };
    case "write_remixlet":
      return {
        active: "Applying your remixlet to the page",
        done: "Applied your remixlet — the page updated",
        failed: "Something went wrong saving this version — it was not applied",
        icon: WandSparkles,
      };
    case "list_remixlets":
      return {
        active: "Checking existing remixlets",
        done: "Checked existing remixlets",
        failed: "Couldn't check existing remixlets",
        icon: Layers,
      };
    case "read_remixlet":
      return {
        active: "Opening an existing remixlet to build on it",
        done: "Reviewed an existing remixlet",
        failed: "Couldn't open that remixlet",
        icon: FileCode,
      };
    case "query_elements":
      return {
        active: `Scanning the page${describeSelector(a.selector)}`,
        done: "Scanned the page",
        failed: "Couldn't scan the page",
        icon: Search,
      };
    case "inspect_element":
      return {
        active: `Inspecting an element${describeSelector(a.selector)}`,
        done: "Inspected an element",
        failed: "Couldn't inspect that element",
        icon: Crosshair,
      };
    case "inspect_design":
      return {
        active: `Looking at how the page styles things${describeSelector(a.selector)}`,
        done: "Looked at how the page styles things",
        failed: "Couldn't read the page's styling",
        icon: Ruler,
      };
    case "read_structured_data":
      return {
        active: "Reading the page's metadata",
        done: "Read the page's metadata",
        failed: "Couldn't read the page's metadata",
        icon: Tags,
      };
    case "read_page_state":
      return {
        active: "Reading the page's app data",
        done: "Read the page's app data",
        failed: "Couldn't read the page's app data",
        icon: Braces,
      };
    case "list_network_resources":
      return {
        active: "Checking what the page loads",
        done: "Checked what the page loads",
        failed: "Couldn't check what the page loads",
        icon: Network,
      };
    case "replay_network_resource": {
      const id = a.id !== undefined && /^r\d+$/.test(a.id) ? a.id : "";
      return {
        active: id ? `Re-checking data the page loaded (${id})` : "Re-checking data the page loaded",
        done: "Re-checked data the page loaded",
        failed: "Couldn't re-check that data",
        icon: Repeat2,
      };
    }
    case "observe_network_bodies":
      return {
        active: "Reading the data the page loaded",
        done: "Read the data the page loaded",
        failed: "Couldn't read the data the page loaded",
        icon: Network,
      };
    case "look_at_change":
      return {
        active: `Looking at the new control next to the page's own${describeSelector(a.selector)}`,
        done: "Looked at the new control next to the page's own",
        failed: "Couldn't get a picture of the new control",
        icon: Eye,
      };
    case "record_look":
      // Neutral by default: refineDonePhrase says what the look concluded.
      return {
        active: "Noting what it looks like",
        done: "Noted what it looks like",
        failed: "Couldn't note what it looks like",
        icon: Eye,
      };
    case "click_element":
      return {
        active: `Clicking the control to try it${describeSelector(a.selector)}`,
        done: "Clicked the control to try it",
        failed: "Couldn't click that control",
        icon: MousePointerClick,
      };
    case "assert_page_state": {
      // Neutral by default: only a probe whose assertions ALL passed may claim
      // the remixlet worked (refineDonePhrase upgrades it from tool_end details).
      return {
        active: "Verifying the change on the page",
        done: "Checked the page",
        failed: "Couldn't verify the page",
        icon: BadgeCheck,
      };
    }
    case "read_remixlet_logs":
      return {
        active: "Reading the remixlet's runtime log",
        done: "Read the remixlet's runtime log",
        failed: "Couldn't read the remixlet's runtime log",
        icon: Bug,
      };
    case "assess_feasibility":
      return {
        active: "Checking whether this is possible on this page",
        done: "Checked whether this is possible",
        failed: "Couldn't check whether this is possible",
        icon: Compass,
      };
    case "navigate": {
      const host = hostOf(a.url);
      return {
        active: host ? `Opening ${host}` : "Opening the page",
        done: host ? `Opened ${host}` : "Opened the page",
        failed: host ? `Couldn't open ${host}` : "Couldn't open the page",
        icon: Navigation,
      };
    }
    default:
      // Unreachable for a shipped tool — every name above is covered. A bare
      // "Done" row means a tool was added without its phrase; say something
      // truthful rather than pretending the step is describable.
      return { active: "Working on it", done: "Finished a step", failed: "That step didn't work", icon: CircleDashed };
  }
}

// A settled step can say more than its start phrase promised: tool_end details
// carry the actual outcome. Only an assert_page_state whose assertions all
// passed may claim the remixlet worked (same bar as verification.ts), and the
// feasibility step surfaces its verdict instead of a generic "done".
export function refineDonePhrase(toolName: string, phrase: ToolPhrase, details: ToolEndDetails): string {
  const d = Check(ToolOutcomeDetailsSchema, details) ? Parse(ToolOutcomeDetailsSchema, details) : {};
  if ((toolName === "capture_page" || toolName === "look_at_change") && d.screenshotDiscarded === true) {
    return "Skipped a screenshot because the active tab or page changed while it was being taken";
  }
  if (toolName === "assert_page_state" && d.verificationSucceeded === true) return "Confirmed the remixlet worked";
  if (toolName === "click_element" && d.refused !== undefined) return "Didn't click that control: it would have left this site";
  if (toolName === "record_look") {
    if (d.verdict === "matches") return "Looked at it — reads as the page's own";
    if (d.verdict === "differs") return d.observed ? `Looked at it — ${d.observed}` : "Looked at it — spotted a difference";
    if (d.verdict === "wrong-kind") return "Looked at it — wrong kind of control, rebuilding";
    if (d.verdict === "not-reviewable") return "Couldn't check the look by eye";
  }
  if (toolName === "assess_feasibility") {
    if (d.verdict === "feasible") return "Checked what's possible — this is doable on this page";
    if (d.verdict === "feasible-with-capability") return "Checked what's possible — doable with extra access you'd approve";
    if (d.verdict === "partial") return "Checked what's possible — only part of this is doable";
    if (d.verdict === "infeasible") return "Checked what's possible — this page doesn't expose what the request needs";
  }
  return phrase.done;
}

/** One transcript row, presentation-ready — ChatMessage minus the panel's ids. */
export interface TranscriptMessage {
  kind: MessageKind;
  text: string;
  icon?: LucideIcon;
  state?: ActivityState;
}

// A transcript row's contents. Activity rows lead with the icon of the step
// they describe; user and error messages are plain text.
export function MessageBody({ message }: { message: TranscriptMessage }) {
  const Icon = message.icon;
  if (!Icon) return <>{message.text}</>;
  return (
    <span className="flex items-start gap-2">
      <Icon className={`mt-px size-[13px] shrink-0 ${ACTIVITY_ICON_TONE[message.state ?? "done"]}`} aria-hidden />
      <span className="min-w-0 flex-1">{message.text}</span>
    </span>
  );
}

/**
 * How a stored transcript item renders back into the chat. A persisted grant
 * continuation (marker prefix) renders as the action row the click originally
 * produced, never as a user bubble — the click was an action, not something
 * typed. Shared by the panel's resume paths and the control center's read-only
 * chat view.
 */
export function transcriptMessage(item: SessionTranscriptItem): TranscriptMessage {
  if (item.kind === "tool") {
    const phrase = describeTool(item.toolName, undefined);
    return settledToolMessage(item.toolName, phrase, {
      ok: item.ok,
      bounced: item.failure === "bounced",
      reason: item.reason,
      gateRejected: item.failure === "gate",
      declined: item.failure === "declined",
    });
  }
  if (item.kind === "user") {
    const granted = capabilityGrantFromPrompt(item.text);
    if (granted) {
      return { kind: "tool", text: capabilityGrantActionLabel(granted), icon: ShieldCheck, state: "done" };
    }
    if (isDevObserveGrantPrompt(item.text)) {
      return { kind: "tool", text: DEV_OBSERVE_GRANT_ACTION_LABEL, icon: ShieldCheck, state: "done" };
    }
    // The runtime's own finish-check follow-up (verification was still
    // pending when the model tried to stop) — an action, not typed input.
    if (isContractNudgePrompt(item.text)) {
      return { kind: "tool", text: "Asked the agent to verify before finishing", icon: HELD_ICON, state: "done" };
    }
  }
  return { kind: item.kind, text: item.text };
}
