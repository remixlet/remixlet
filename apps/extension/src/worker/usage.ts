// Worker half of remixlet usage tracking: the injection gate reports each
// run over the authenticated bridge (kind "rmx.run"), and this module folds
// it into a per-remixlet, per-day aggregate in storage.local — durable
// across browser sessions, reconstructible-from-storage as MV3 requires,
// and bounded by shared/usage.ts's retention pruning. The control center's
// dashboard reads it back through the usage.read protocol message.

import { ext } from "../platform/ext.js";
import { recordUsageRun, type UsageRecord } from "../shared/usage.js";

export type { UsageRecord };

const usageKey = (remixletId: string) => `usage:${remixletId}`;

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

export function recordRemixletRun(remixletId: string, at = Date.now()): Promise<void> {
  return enqueue(async () => {
    const key = usageKey(remixletId);
    const storedValue = (await ext.storage.local.get(key))[key];
    // SAFETY: recordUsageRun accepts absent or malformed storage values and normalizes them.
    const stored = storedValue as UsageRecord | undefined;
    await ext.storage.local.set({ [key]: recordUsageRun(stored, at) });
  });
}

/** Every remixlet's usage record, keyed by remixlet id. */
export function readUsage(): Promise<Record<string, UsageRecord>> {
  return enqueue(async () => {
    const all = await ext.storage.local.get(null);
    const usage: Record<string, UsageRecord> = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("usage:")) continue;
      // SAFETY: usage records are written only by recordRemixletRun in this module.
      usage[key.slice("usage:".length)] = value as UsageRecord;
    }
    return usage;
  });
}

/** Called on hard delete so a destroyed remixlet leaves no counters behind. */
export function clearUsage(remixletId: string): Promise<void> {
  return enqueue(async () => {
    await ext.storage.local.remove(usageKey(remixletId));
  });
}
