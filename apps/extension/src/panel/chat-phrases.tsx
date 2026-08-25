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
  Terminal,
  Undo2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";

import { classifyToolFailure, isContractNudgePrompt, type SessionTranscriptItem } from "../agent/index.js";
import type { AgentRuntimeEvent } from "../agent/types.js";
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
// conversation suite reads.
export type ActivityState = "active" | "done" | "failed";

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
// remains for the finish-check action row.
export const FAILED_ICON = CircleX;
export const HELD_ICON = Undo2;

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
  if (toolName === "evaluate_js") return "You chose not to run that script";
  return "You declined this step";
}

/**
 * How a settled tool call renders, given the failure classification carried on
 * the tool_end event (live) or recovered from the stored result text (replay).
 * Returns undefined for a contract bounce: the extension holding a step until
 * its prerequisites ran is harness-to-agent choreography the agent remedies
 * within seconds — showing it only reads as something going wrong, so the
 * step's row is dropped and the user sees the corrected order instead.
 */
export function settledToolMessage(
  toolName: string,
  phrase: ToolPhrase,
  outcome: { ok: boolean; bounced?: boolean; gateRejected?: boolean; declined?: boolean; details?: ToolEndDetails },
): TranscriptMessage | undefined {
  if (outcome.ok) {
    return { kind: "tool", text: refineDonePhrase(toolName, phrase, outcome.details), icon: phrase.icon, state: "done" };
  }
  if (outcome.bounced) return undefined;
  if (outcome.gateRejected) return { kind: "tool", text: SAFETY_GATE_TEXT, icon: ShieldCheck, state: "done" };
  if (outcome.declined) return { kind: "tool", text: declinedText(toolName), icon: phrase.icon, state: "done" };
  return { kind: "tool", text: phrase.failed, icon: FAILED_ICON, state: "failed" };
}

// State is a colour on the icon, nothing else: a running step's icon pulses at
// low contrast, a finished one takes the brand tint, a failed one goes
// destructive. Same icon, same row geometry throughout — only the tone moves.
export const ACTIVITY_ICON_TONE = {
  active: "animate-pulse text-muted-foreground/60",
  done: "text-primary",
  failed: "text-destructive",
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
  network?: boolean;
  screenshot?: string;
  selector?: string;
  url?: string;
}

const ToolArgumentsSchema = Type.Object({
  archive: Type.Optional(Type.Boolean()),
  code: Type.Optional(Type.String()),
  console: Type.Optional(Type.Boolean()),
  network: Type.Optional(Type.Boolean()),
  screenshot: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});
const ToolOutcomeDetailsSchema = Type.Object({
  verificationSucceeded: Type.Optional(Type.Boolean()),
  verdict: Type.Optional(Type.Union([Type.Literal("feasible"), Type.Literal("feasible-with-capability"), Type.Literal("partial"), Type.Literal("infeasible")])),
});

function describeCapture(args: ToolArguments): string {
  const parts = ["reading the layout and text"];
  if (args.screenshot !== undefined && args.screenshot !== "none") parts.push("taking a screenshot");
  if (args.network) parts.push("checking network activity");
  if (args.console) parts.push("reading the console");
  if (args.archive) parts.push("saving a full copy");
  return joinHuman(parts);
}

// evaluate_js is a page probe; the CSS selector it queries is the most telling
// "what is it looking for". Surface that when the code is a simple query,
// otherwise stay generic rather than showing raw JavaScript.
function describeProbe(code: string | undefined): string {
  if (code === undefined) return "";
  const match = code.match(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/);
  return match ? `looking for “${match[1]}” on the page` : "";
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
      const host = hostOf(a.url);
      return {
        active: host ? `Re-checking data the page loaded from ${host}` : "Re-checking data the page loaded",
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
    case "evaluate_js": {
      const probe = describeProbe(a.code);
      return {
        active: probe ? `Running an approved script — ${probe}` : "Running an approved script",
        done: probe ? `Checked the page — ${probe}` : "Checked the page",
        failed: "Couldn't run that script",
        icon: Terminal,
      };
    }
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
  if (toolName === "assert_page_state" && d.verificationSucceeded === true) return "Confirmed the remixlet worked";
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
 * How a stored transcript item renders back into the chat — or undefined for
 * rows the live chat would not have kept (contract bounces). A persisted grant
 * continuation (marker prefix) renders as the action row the click originally
 * produced, never as a user bubble — the click was an action, not something
 * typed. Shared by the panel's resume paths and the control center's read-only
 * chat view.
 */
export function transcriptMessage(item: SessionTranscriptItem): TranscriptMessage | undefined {
  if (item.kind === "tool") {
    const phrase = describeTool(item.toolName, undefined);
    return settledToolMessage(item.toolName, phrase, {
      ok: item.ok,
      bounced: item.failure === "bounced",
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
