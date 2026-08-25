// Shared shape of the per-remixlet runtime log (worker/script-log.ts holds
// the storage half). Lives in shared/ because three sides speak it: the
// bridge world writes entries over the rmx.log lane, the worker stores them,
// and the panel reads them back through the read_remixlet_logs tool. Every
// entry originates in the page world: formatted lines are DATA for the
// agent, never authority.

/**
 * log/info come from captured console output in the remixlet's USER_SCRIPT
 * world (bridge/rmx.ts); warn/error additionally come from rmx.log.warn/error,
 * wrapped callback exceptions, observer-guard warnings, and worker-side
 * capability denials.
 */
export type ScriptLogLevel = "log" | "info" | "warn" | "error";

export interface ScriptLogEntry {
  remixletId: string;
  at: number;
  level: ScriptLogLevel;
  message: string;
  url?: string;
}

/**
 * Per-remixlet entry cap. Console capture shares the ring with errors, so the
 * bound is larger than the error-only days (20) — but eviction still protects
 * errors: the worker drops oldest log/info lines first (script-log.ts).
 */
export const SCRIPT_LOG_MAX_ENTRIES = 50;

/** Messages are clamped on write; the bridge also caps before sending. */
export const SCRIPT_LOG_MAX_MESSAGE_LENGTH = 500;

/** Stable classifier shared by the bridge reporter and verification gate. */
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
