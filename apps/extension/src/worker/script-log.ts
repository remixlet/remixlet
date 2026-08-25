// Bounded per-remixlet runtime log (the worker half of the bridge's rmx.log
// lane). Exists so the agent has visibility into the scripts it ships:
// entries come from captured console output in each remixlet's USER_SCRIPT
// world, wrapped callback exceptions, observer-guard warnings, and
// worker-side capability denials; the panel's read_remixlet_logs tool reads
// them back. storage.session: entries are diagnostics for the running
// browser session, not durable state — and session storage survives worker
// death, so a dying MV3 worker loses nothing.

import { ext } from "../platform/ext.js";
import { SCRIPT_LOG_MAX_ENTRIES, SCRIPT_LOG_MAX_MESSAGE_LENGTH, type ScriptLogEntry, type ScriptLogLevel } from "../shared/script-log.js";

export { SCRIPT_LOG_MAX_ENTRIES, SCRIPT_LOG_MAX_MESSAGE_LENGTH };
export type { ScriptLogEntry, ScriptLogLevel };

const logKey = (remixletId: string) => `script-log:${remixletId}`;

// MV3 handlers interleave at every await; serialize read-modify-write.
let operationTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

type StoredEntry = Omit<ScriptLogEntry, "remixletId">;

/**
 * Enforce the ring bound. Console chatter and errors share one ring, but
 * errors are what a fix turn actually needs — so eviction drops the oldest
 * log/info lines first, and warn/error entries are only dropped when they
 * alone exceed the cap. Otherwise a remixlet that console.logs every
 * mutation would flush its own crash out of the buffer before the agent
 * ever reads it.
 */
function bounded(entries: StoredEntry[]): StoredEntry[] {
  let excess = entries.length - SCRIPT_LOG_MAX_ENTRIES;
  if (excess <= 0) return entries;
  const kept: StoredEntry[] = [];
  for (const entry of entries) {
    if (excess > 0 && (entry.level === "log" || entry.level === "info")) {
      excess -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept.slice(Math.max(0, kept.length - SCRIPT_LOG_MAX_ENTRIES));
}

export function appendScriptLog(
  remixletId: string,
  level: ScriptLogLevel,
  message: string,
  url?: string,
): Promise<void> {
  return enqueue(async () => {
    const key = logKey(remixletId);
    // SAFETY: this module exclusively writes this key as a StoredEntry array.
    const stored = ((await ext.storage.session.get(key))[key] as StoredEntry[] | undefined) ?? [];
    const entry: StoredEntry = {
      at: Date.now(),
      level,
      message: message.slice(0, SCRIPT_LOG_MAX_MESSAGE_LENGTH),
    };
    if (url !== undefined) entry.url = url;
    stored.push(entry);
    await ext.storage.session.set({ [key]: bounded(stored) });
  });
}

/**
 * Append unless an identical message is already logged for this remixlet.
 * For conditions RE-DETECTED on every mirror rebuild (worker boot, any
 * activation) — bridge skew is one — a plain append would refill the bounded
 * ring with the same line and evict the entries the agent actually needs.
 */
export function appendScriptLogOnce(remixletId: string, level: "warn" | "error", message: string): Promise<void> {
  return enqueue(async () => {
    const key = logKey(remixletId);
    // SAFETY: this module exclusively writes this key as a StoredEntry array.
    const stored = ((await ext.storage.session.get(key))[key] as StoredEntry[] | undefined) ?? [];
    const clamped = message.slice(0, SCRIPT_LOG_MAX_MESSAGE_LENGTH);
    if (stored.some((entry) => entry.message === clamped)) return;
    stored.push({ at: Date.now(), level, message: clamped });
    await ext.storage.session.set({ [key]: bounded(stored) });
  });
}

/** Entries for one remixlet (or all remixlets), most recent first. */
export function readScriptLog(remixletId?: string): Promise<ScriptLogEntry[]> {
  return enqueue(async () => {
    const all = await ext.storage.session.get(null);
    const entries: ScriptLogEntry[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("script-log:")) continue;
      const id = key.slice("script-log:".length);
      if (remixletId !== undefined && id !== remixletId) continue;
      // SAFETY: this module exclusively writes script-log keys as StoredEntry arrays.
      for (const entry of (value as StoredEntry[] | undefined) ?? []) entries.push({ remixletId: id, ...entry });
    }
    return entries.sort((a, b) => b.at - a.at);
  });
}

/** Called on successful activation so entries always describe the live version. */
export function clearScriptLog(remixletId: string): Promise<void> {
  return enqueue(async () => {
    await ext.storage.session.remove(logKey(remixletId));
  });
}
