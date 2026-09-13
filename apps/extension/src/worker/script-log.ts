// Bounded per-remixlet runtime log (the worker half of the bridge's rmx.log
// lane). Exists so the agent has visibility into the scripts it ships:
// entries come from captured console output in each remixlet's box,
// wrapped callback exceptions, observer-guard warnings, and
// worker-side capability denials; the panel's read_remixlet_logs tool reads
// them back.
//
// storage.local, one key for every remixlet's log: a failed run has to be
// examinable after the browser restarts (the 2026-09-05 Canary run left
// nothing on disk when the log lived in storage.session). Lines arrive many
// per second from a chatty remixlet, so they are batched here and written
// once per flush window instead of once per line. The batch is the only
// state this module holds outside storage, and losing it (worker death
// inside the window) loses at most that window's lines — the stored value is
// always a complete, bounded log. Design: wiki/design/script-log.md.

import { ext } from "../platform/ext.js";
import {
  boundScriptLogs,
  normalizeStoredScriptLogs,
  SCRIPT_LOG_MAX_ENTRIES,
  SCRIPT_LOG_MAX_MESSAGE_LENGTH,
  SCRIPT_LOG_MAX_URL_LENGTH,
  SCRIPT_LOGS_STORAGE_KEY,
  type ScriptLogEntry,
  type ScriptLogLevel,
  type StoredScriptLogEntry,
  type StoredScriptLogs,
} from "../shared/script-log.js";

export { SCRIPT_LOG_MAX_ENTRIES, SCRIPT_LOG_MAX_MESSAGE_LENGTH };
export type { ScriptLogEntry, ScriptLogLevel };

/** How long appended lines wait for company before one storage.local write lands them all. */
export const SCRIPT_LOG_FLUSH_DELAY_MS = 250;

// MV3 handlers interleave at every await; serialize every read-modify-write
// of the stored value. Flushes, clears, and reads all pass through here, so
// a read always sees every flush enqueued before it.
let operationTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStored(): Promise<StoredScriptLogs> {
  const stored = await ext.storage.local.get(SCRIPT_LOGS_STORAGE_KEY);
  return normalizeStoredScriptLogs(stored[SCRIPT_LOGS_STORAGE_KEY]);
}

interface PendingLine {
  remixletId: string;
  entry: StoredScriptLogEntry;
  /** Skip at flush time when the remixlet's log already carries this message. */
  once: boolean;
}

let pending: PendingLine[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Land the pending batch in one write. Once-lines are checked against the
 * log as it stands after the earlier lines of the same batch, so two
 * identical once-lines queued in one window still collapse to one entry.
 */
function flushPending(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pending.length === 0) return Promise.resolve();
  const batch = pending;
  pending = [];
  return enqueue(async () => {
    const logs = await readStored();
    for (const line of batch) {
      const entries = (logs[line.remixletId] ??= []);
      if (line.once && entries.some((entry) => entry.message === line.entry.message)) continue;
      entries.push(line.entry);
    }
    await ext.storage.local.set({ [SCRIPT_LOGS_STORAGE_KEY]: boundScriptLogs(logs) });
  });
}

function queueLine(line: PendingLine): void {
  pending.push(line);
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushPending().catch((error) => console.error("[remixlet] script-log flush failed", error));
    }, SCRIPT_LOG_FLUSH_DELAY_MS);
  }
}

/**
 * Queue one line. Resolves once the line is queued, not once it is stored:
 * the bridge answers rmx.log without waiting on the write, and the line lands
 * within SCRIPT_LOG_FLUSH_DELAY_MS (or sooner, when a read forces the flush).
 */
export function appendScriptLog(remixletId: string, level: ScriptLogLevel, message: string, url?: string): Promise<void> {
  const entry: StoredScriptLogEntry = { at: Date.now(), level, message: message.slice(0, SCRIPT_LOG_MAX_MESSAGE_LENGTH) };
  if (url !== undefined) entry.url = url.slice(0, SCRIPT_LOG_MAX_URL_LENGTH);
  queueLine({ remixletId, entry, once: false });
  return Promise.resolve();
}

/**
 * Append unless an identical message is already logged for this remixlet.
 * For conditions RE-DETECTED on every mirror rebuild (worker boot, any
 * activation) — bridge skew is one — a plain append would refill the bounded
 * ring with the same line and evict the entries the agent actually needs.
 */
export function appendScriptLogOnce(remixletId: string, level: "warn" | "error", message: string): Promise<void> {
  queueLine({ remixletId, entry: { at: Date.now(), level, message: message.slice(0, SCRIPT_LOG_MAX_MESSAGE_LENGTH) }, once: true });
  return Promise.resolve();
}

/** Entries for one remixlet (or all remixlets), most recent first. Flushes pending lines first so a read never lags the log. */
export function readScriptLog(remixletId?: string): Promise<ScriptLogEntry[]> {
  void flushPending().catch(() => {});
  return enqueue(async () => {
    const logs = await readStored();
    const entries: ScriptLogEntry[] = [];
    for (const [id, stored] of Object.entries(logs)) {
      if (remixletId !== undefined && id !== remixletId) continue;
      for (const entry of stored) entries.push({ remixletId: id, ...entry });
    }
    return entries.sort((a, b) => b.at - a.at);
  });
}

/**
 * Drop one remixlet's log. Called on successful activation so entries always
 * describe the live version, and on delete-forever so nothing is left behind.
 * Lines queued before the call describe the old version too, so they are
 * dropped unflushed; lines queued after it flush behind the clear.
 */
export function clearScriptLog(remixletId: string): Promise<void> {
  pending = pending.filter((line) => line.remixletId !== remixletId);
  return enqueue(async () => {
    const logs = await readStored();
    if (!(remixletId in logs)) return;
    delete logs[remixletId];
    await ext.storage.local.set({ [SCRIPT_LOGS_STORAGE_KEY]: logs });
  });
}
