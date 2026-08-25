// Day grouping shared by the chats index and each remixlet's activity
// timeline, so "Today / Yesterday / Sat 15 Aug" reads identically everywhere.

export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today" / "Yesterday", then explicit dates; the year appears only once it differs. */
export function dayLabel(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** "3 min ago" / "2 days ago" / "5 months ago", rounded — not meant to be precise. */
export function relativeTimeLabel(timestamp: number, now: Date): string {
  const seconds = Math.round((now.getTime() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.round(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** Preserves the incoming newest-first order; groups are consecutive runs of the same day. */
export function groupByDay<T>(items: T[], when: (item: T) => number, now: Date): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(when(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
