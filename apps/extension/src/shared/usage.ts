// Usage aggregation for the control center's dashboard: pure functions over
// the stored shape, so worker/usage.ts stays a thin storage wrapper and the
// aggregation itself is unit-testable outside a worker context. A "run" is
// the injection gate actually executing a remixlet's files on a page — once
// per document, plus once per SPA navigation into a matching URL.
//
// Counts are pre-aggregated per LOCAL calendar day rather than kept as an
// event list: the dashboard's questions ("how often, when") are per-day, and
// a per-run append would grow storage.local without bound on busy sites.

/** Days of per-day history kept per remixlet; older buckets are pruned on write. */
export const USAGE_RETENTION_DAYS = 90;

export interface UsageRecord {
  /** Lifetime run count — survives day-bucket pruning. */
  total: number;
  /** ms epoch of the most recent run. */
  lastRunAt: number;
  /** Local-timezone YYYY-MM-DD → runs that day, bounded by USAGE_RETENTION_DAYS. */
  days: Record<string, number>;
}

/** Local-timezone calendar day for a timestamp, as sortable YYYY-MM-DD. */
export function usageDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The oldest day key still retained, looking back from `now`. */
export function usageRetentionCutoff(now: number, retentionDays = USAGE_RETENTION_DAYS): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
  return usageDayKey(cutoff.getTime());
}

/** Count one run into a record (a fresh one when undefined), pruning expired day buckets. */
export function recordUsageRun(record: UsageRecord | undefined, at: number): UsageRecord {
  const previous = record ?? { total: 0, lastRunAt: 0, days: {} };
  const key = usageDayKey(at);
  const cutoff = usageRetentionCutoff(at);
  const days: Record<string, number> = {};
  for (const [day, count] of Object.entries(previous.days)) {
    if (day >= cutoff) days[day] = count;
  }
  days[key] = (days[key] ?? 0) + 1;
  return { total: previous.total + 1, lastRunAt: Math.max(previous.lastRunAt, at), days };
}

/** Human "last ran" phrasing shared by the dashboard rows and the remixlet page's runs card. */
export function usageLastRunLabel(record: UsageRecord | undefined, now: number): string {
  if (!record || record.lastRunAt === 0) return "never";
  const minutes = Math.floor((now - record.lastRunAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(record.lastRunAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Runs across the trailing `dayCount` local days (today inclusive). */
export function usageRunsInWindow(record: UsageRecord, now: number, dayCount: number): number {
  const cutoff = usageRetentionCutoff(now, dayCount);
  let sum = 0;
  for (const [day, count] of Object.entries(record.days)) {
    if (day >= cutoff) sum += count;
  }
  return sum;
}

/**
 * The trailing `dayCount` local day keys ending today, oldest first — the
 * dashboard's x-axis, with zero-run days present rather than skipped.
 */
export function usageDaySpan(now: number, dayCount: number): string[] {
  const keys: string[] = [];
  for (let back = dayCount - 1; back >= 0; back -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - back);
    keys.push(usageDayKey(date.getTime()));
  }
  return keys;
}
