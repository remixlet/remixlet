// Shared shape of the per-remixlet runtime log (worker/script-log.ts holds
// the storage half). Lives in shared/ because three sides speak it: the
// bridge world writes entries over the rmx.log lane, the worker stores them,
// and the panel reads them back through the read_remixlet_logs tool. Every
// entry originates in the page world: formatted lines are DATA for the
// agent, never authority.
//
// The bounding rules live here too, as pure functions over the stored shape,
// so the store suite can exercise them without a worker. Design and cap
// rationale: wiki/design/script-log.md.

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * log/info come from captured console output in the remixlet's box
 * (box/runtime.ts); warn/error additionally come from rmx.log.warn/error,
 * wrapped callback exceptions, the page agent's observer-budget warnings,
 * policy refusals, and worker-side capability denials.
 */
export type ScriptLogLevel = "log" | "info" | "warn" | "error";

export interface ScriptLogEntry {
  remixletId: string;
  /** Wall-clock ms at the moment the worker received the line; orders a post-mortem. */
  at: number;
  level: ScriptLogLevel;
  message: string;
  url?: string;
}

/** One entry as stored: the remixlet id is the key it sits under. */
export type StoredScriptLogEntry = Omit<ScriptLogEntry, "remixletId">;

/** The whole durable log: every remixlet's entries in append order, under one storage.local key. */
export type StoredScriptLogs = Record<string, StoredScriptLogEntry[]>;

/** storage.local key holding a StoredScriptLogs value (worker/script-log.ts is its only writer). */
export const SCRIPT_LOGS_STORAGE_KEY = "scriptLogs";

/**
 * Per-remixlet entry cap. Console capture shares the ring with errors, so the
 * bound is well above the error-only days (20) — and eviction still protects
 * errors: the oldest log/info lines go first (boundScriptLogs). The log is
 * durable across browser restarts, so the cap is sized for a post-mortem of a
 * failed run, not one fix turn; read_remixlet_logs shows the newest slice.
 */
export const SCRIPT_LOG_MAX_ENTRIES = 300;

/** Messages are clamped on write; the bridge also caps before sending. */
export const SCRIPT_LOG_MAX_MESSAGE_LENGTH = 500;

/** The sender URL is clamped on write too: a page's href can be arbitrarily long, the log's slots cannot. */
export const SCRIPT_LOG_MAX_URL_LENGTH = 2048;

/** Per-remixlet byte cap (JSON length of its entry array), enforced after the entry cap. */
export const SCRIPT_LOG_MAX_BYTES_PER_REMIXLET = 256 * 1024;

/**
 * Byte budget for every remixlet's log together. Bounds the one storage.local
 * value the worker rewrites on each flush, so a chatty remixlet can never make
 * the whole extension's storage grow without bound. When the sum exceeds it,
 * the oldest entry across all remixlets goes first, whatever its level.
 */
export const SCRIPT_LOG_MAX_BYTES_TOTAL = 3 * 1024 * 1024;

/** Approximate stored size of one entry: its JSON plus the array separator. */
export function scriptLogEntryBytes(entry: StoredScriptLogEntry): number {
  return JSON.stringify(entry).length + 1;
}

// The unparsed value storage.local hands back for the key — named, like the
// look review's payload, so the normalizer is the one place its shape is decided.
const StoredScriptLogsPayloadSchema = Type.Unknown();
export type StoredScriptLogsPayload = Static<typeof StoredScriptLogsPayloadSchema>;

const StoredScriptLogsByRemixlet = Type.Record(Type.String(), Type.Unknown());
const StoredEntryList = Type.Array(Type.Unknown());
// Additional properties pass: a later release may add fields, and an older
// build must keep reading what it understands.
const StoredScriptLogEntrySchema = Type.Object({
  at: Type.Number(),
  level: Type.Union([Type.Literal("log"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
  message: Type.String(),
  url: Type.Optional(Type.String()),
});

/**
 * Migrate-on-read for the stored value: an absent, foreign, or partly damaged
 * value yields whatever entries still parse, never a throw. Installed browsers
 * hold data written by every shipped release, so an unreadable entry is
 * dropped alone rather than taking its remixlet's log with it.
 */
export function normalizeStoredScriptLogs(value: StoredScriptLogsPayload): StoredScriptLogs {
  if (!Check(StoredScriptLogsByRemixlet, value)) return {};
  const logs: [string, StoredScriptLogEntry[]][] = [];
  for (const [remixletId, entries] of Object.entries(value)) {
    if (!Check(StoredEntryList, entries)) continue;
    const kept = entries.filter((entry) => Check(StoredScriptLogEntrySchema, entry));
    if (kept.length > 0) logs.push([remixletId, kept]);
  }
  return Object.fromEntries(logs);
}

/**
 * Enforce one remixlet's entry and byte caps. Console chatter and errors share
 * one ring, but errors are what a fix turn actually needs — so eviction drops
 * the oldest log/info lines first, and warn/error entries are only dropped
 * when they alone exceed a cap. Otherwise a remixlet that console.logs every
 * mutation would flush its own crash out of the buffer before the agent ever
 * reads it.
 */
function boundRemixletLog(entries: readonly StoredScriptLogEntry[]): StoredScriptLogEntry[] {
  const sizes = entries.map(scriptLogEntryBytes);
  let count = entries.length;
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  const over = () => count > SCRIPT_LOG_MAX_ENTRIES || bytes > SCRIPT_LOG_MAX_BYTES_PER_REMIXLET;
  if (!over()) return [...entries];
  const dropped = new Set<number>();
  const drop = (index: number) => {
    dropped.add(index);
    count -= 1;
    bytes -= sizes[index] ?? 0;
  };
  for (let index = 0; index < entries.length && over(); index += 1) {
    const level = entries[index]?.level;
    if (level === "log" || level === "info") drop(index);
  }
  for (let index = 0; index < entries.length && over(); index += 1) {
    if (!dropped.has(index)) drop(index);
  }
  return entries.filter((_, index) => !dropped.has(index));
}

/**
 * The whole bound, applied before every write: each remixlet's caps first,
 * then the global byte budget, oldest entry first across remixlets. Returns a
 * new value; remixlets left with no entries disappear from it.
 */
export function boundScriptLogs(logs: StoredScriptLogs): StoredScriptLogs {
  const bounded: [string, StoredScriptLogEntry[]][] = [];
  let total = 0;
  for (const [remixletId, entries] of Object.entries(logs)) {
    const kept = boundRemixletLog(entries);
    if (kept.length === 0) continue;
    bounded.push([remixletId, kept]);
    for (const entry of kept) total += scriptLogEntryBytes(entry);
  }
  while (total > SCRIPT_LOG_MAX_BYTES_TOTAL) {
    let oldest: StoredScriptLogEntry[] | undefined;
    for (const [, entries] of bounded) {
      const head = entries[0];
      if (head !== undefined && (oldest?.[0] === undefined || head.at < oldest[0].at)) oldest = entries;
    }
    const removed = oldest?.shift();
    if (removed === undefined) break;
    total -= scriptLogEntryBytes(removed);
  }
  return Object.fromEntries(bounded.filter(([, entries]) => entries.length > 0));
}

/** Stable classifier shared by the bridge reporter and verification gate. */
/**
 * Prefix of the line the box runtime logs (once per distinct reason) when the
 * page agent refused a write — src/box/runtime.ts. The system prompt and the
 * box suite name it, so it is pinned here beside the observer prefixes.
 */
export const POLICY_REFUSED_PREFIX = "policy refused: ";

/**
 * Prefix of the line the box runtime logs when the page agent dropped a
 * listener because the node it was bound to left the document (the page
 * redrew it) — src/box/runtime.ts on `dom.stale`. The box suite counts
 * these lines per redraw.
 */
export const STALE_LISTENER_NOTICE_PREFIX = "listener dropped: ";

export const MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX = "MutationObserver callback ran more than ";

export function isMutationObserverFeedbackLoopMessage(message: string): boolean {
  return message.startsWith(MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX) && message.includes("likely a feedback loop");
}

/**
 * The guard's other outcome: budget exceeded by page-driven churn (deliveries
 * spread across the window), contained by coalescing. Informational — never
 * blocks verification; assert_page_state surfaces it as a caveat.
 */
export const MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX = "MutationObserver deliveries exceeded ";

export function isMutationObserverThrottleNoticeMessage(message: string): boolean {
  return message.startsWith(MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX) && message.includes("not a feedback loop");
}

/** Convert current-page runtime evidence into the verification gate details. */
export interface RuntimeAwareVerificationDetails {
  verificationSucceeded: boolean;
  verificationBlockedByObserverLoop: boolean;
  observerFeedbackLoopCount: number;
  observerFeedbackLoopRemixletIds: string[];
  observerThrottleCount: number;
  siteScopedErrorCount: number;
}

export function runtimeAwareVerificationDetails(
  assertionsPassed: boolean,
  currentUrl: string | undefined,
  entries: readonly ScriptLogEntry[],
): RuntimeAwareVerificationDetails {
  const siteEntries = entries.filter((entry) => runtimeLogMatchesCurrentSite(entry.url, currentUrl));
  const observerEntries = siteEntries.filter((entry) => isMutationObserverFeedbackLoopMessage(entry.message));
  const observerFeedbackLoopCount = observerEntries.length;
  const observerFeedbackLoopRemixletIds = [...new Set(observerEntries.map((entry) => entry.remixletId))];
  const verificationBlockedByObserverLoop = observerFeedbackLoopCount > 0;
  return {
    verificationSucceeded: assertionsPassed && !verificationBlockedByObserverLoop,
    verificationBlockedByObserverLoop,
    observerFeedbackLoopCount,
    observerFeedbackLoopRemixletIds,
    observerThrottleCount: siteEntries.filter((entry) => isMutationObserverThrottleNoticeMessage(entry.message)).length,
    siteScopedErrorCount: siteEntries.filter((entry) => entry.level === "warn" || entry.level === "error").length,
  };
}

function runtimeLogMatchesCurrentSite(entryUrl: string | undefined, currentUrl: string | undefined): boolean {
  if (!entryUrl || !currentUrl) return true;
  try {
    // A remixlet remains live across same-site SPA/query/fragment navigation;
    // exact href equality would let that navigation hide its earlier warning.
    return new URL(entryUrl).origin === new URL(currentUrl).origin;
  } catch {
    return entryUrl === currentUrl;
  }
}

/**
 * Newest entries a tool puts in front of the model; the store keeps more. One
 * cap for both readers, read_remixlet_logs and the observer-loop block in
 * assert_page_state, so the block carries exactly the slice a read would.
 */
export const READ_REMIXLET_LOGS_MAX_LINES = 100;

/**
 * The evidence a blocked verification carries: the newest entries of the
 * remixlets whose observer looped, on the current site, most recent first as
 * the store returns them. Same site rule as the block itself, so the lines
 * shown are the ones that blocked.
 */
export function observerLoopEvidenceEntries(
  currentUrl: string | undefined,
  entries: readonly ScriptLogEntry[],
  remixletIds: readonly string[],
  limit: number = READ_REMIXLET_LOGS_MAX_LINES,
): ScriptLogEntry[] {
  const ids = new Set(remixletIds);
  return entries
    .filter((entry) => ids.has(entry.remixletId) && runtimeLogMatchesCurrentSite(entry.url, currentUrl))
    .slice(0, limit);
}

/**
 * One line per entry, the same rendering everywhere the agent sees the log
 * so log evidence reads identically across conversations.
 */
export function formatScriptLogLines(entries: readonly ScriptLogEntry[]): string[] {
  return entries.map(
    (entry) =>
      `[${entry.level}] ${new Date(entry.at).toISOString()} ${entry.remixletId}: ${entry.message}` +
      (entry.url ? ` (${entry.url})` : ""),
  );
}
