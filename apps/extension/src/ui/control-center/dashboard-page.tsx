// Landing page of the control center: the usage dashboard. The sidebar is
// already the library listing, so home answers the question the sidebar
// can't — how often and when each remixlet actually runs. Counters come from
// the injection gate's run pings (worker/usage.ts) read over usage.read;
// zero-run days are rendered, not skipped, so a quiet week looks quiet.

import { useEffect, useState } from "react";

import { BarChart } from "@/components/charts/bar-chart";
import { AvailableChartColors, type AvailableChartColorsKeys } from "@/components/charts/chart-colors";
import { SparkAreaChart } from "@/components/charts/spark-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { RegistryEntry } from "../../store/remixlet-store.js";
import { usageDaySpan, usageLastRunLabel, usageRunsInWindow, type UsageRecord } from "../../shared/usage.js";
import { siteIconFor, SiteIcon } from "../site-icon.js";
import { routeHash } from "./router.js";
import { send } from "./send.js";

/** Series beyond the validated palette's eight slots fold into one muted "Other". */
const MAX_CHART_SERIES = 8;
interface UsageChartRow {
  day: string;
  [series: string]: number | string;
}
const CHART_DAYS = 30;
const OTHER_LABEL = "Other";

const numberFormat = new Intl.NumberFormat();

function dayLabel(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Chart series need a human label per remixlet, but names are not unique the
 * way ids are — a duplicate name would silently merge two series into one
 * data key. Duplicates get their id appended, so every remixlet keeps its
 * own bar segment.
 */
function seriesLabels(entries: RegistryEntry[]): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const entry of entries) {
    labels.set(entry.id, (nameCounts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.id})` : entry.name);
  }
  return labels;
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="flex flex-col gap-1 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tracking-tight">{numberFormat.format(value)}</p>
      </CardContent>
    </Card>
  );
}

export function DashboardPage({
  entries,
  quarantined,
  siteIcons,
}: {
  entries: RegistryEntry[] | undefined;
  /** Enabled artifacts the worker refuses to run, id → reason. */
  quarantined: Record<string, string>;
  siteIcons: Record<string, string> | undefined;
}) {
  const [usage, setUsage] = useState<Record<string, UsageRecord> | undefined>(undefined);

  useEffect(() => {
    void send({ kind: "usage.read" }, "usage.result")
      .then((reply) => setUsage(reply.usage))
      .catch((error: Error) => {
        console.error("[remixlet] usage read failed", error);
        setUsage({});
      });
  }, []);

  const now = Date.now();
  const loaded = entries !== undefined && usage !== undefined;
  const records = usage ?? {};

  const sumWindow = (days: number) =>
    Object.values(records).reduce((sum, record) => sum + usageRunsInWindow(record, now, days), 0);
  const allTime = Object.values(records).reduce((sum, record) => sum + record.total, 0);

  // Rows cover every remixlet, ran or not; the chart ranks by recent runs and
  // folds everything past the palette's eight slots into a muted "Other".
  const labels = seriesLabels(entries ?? []);
  const ranked = [...(entries ?? [])].sort(
    (a, b) =>
      usageRunsInWindow(records[b.id] ?? { total: 0, lastRunAt: 0, days: {} }, now, CHART_DAYS) -
      usageRunsInWindow(records[a.id] ?? { total: 0, lastRunAt: 0, days: {} }, now, CHART_DAYS),
  );
  const charted = ranked.filter((entry) => records[entry.id]).slice(0, MAX_CHART_SERIES);
  const folded = ranked.filter((entry) => records[entry.id]).slice(MAX_CHART_SERIES);
  const categories = charted.map((entry) => labels.get(entry.id)!);
  const colors: AvailableChartColorsKeys[] = AvailableChartColors.slice(0, charted.length);
  const chartIcons = new Map<string, string>();
  for (const entry of charted) {
    const icon = siteIconFor(siteIcons, entry.siteKey);
    if (icon) chartIcons.set(labels.get(entry.id)!, icon);
  }
  if (folded.length > 0) {
    categories.push(OTHER_LABEL);
    colors.push("muted");
  }
  const chartData = usageDaySpan(now, CHART_DAYS).map((dayKey) => {
    const row: UsageChartRow = { day: dayLabel(dayKey) };
    for (const entry of charted) row[labels.get(entry.id)!] = records[entry.id]?.days[dayKey] ?? 0;
    if (folded.length > 0) {
      row[OTHER_LABEL] = folded.reduce((sum, entry) => sum + (records[entry.id]?.days[dayKey] ?? 0), 0);
    }
    return row;
  });
  const hasRuns = allTime > 0;

  return (
    <div id="dashboard-page" className="flex flex-col gap-5">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
          <p className="text-sm text-muted-foreground">How often and when each of your remixlets runs.</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {entries ? `${entries.filter((e) => e.state === "enabled").length} enabled · ${entries.length} total` : ""}
        </span>
      </header>

      {entries?.length === 0 && (
        <p id="manager-empty" className="text-sm text-muted-foreground">
          Nothing here yet — open the Remixlet panel on any page and describe a change.
        </p>
      )}

      {loaded && entries.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Runs today" value={sumWindow(1)} />
            <StatTile label="Runs · 7 days" value={sumWindow(7)} />
            <StatTile label="Runs · 30 days" value={sumWindow(CHART_DAYS)} />
            <StatTile label="Runs · all time" value={allTime} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Runs per day · last {CHART_DAYS} days</CardTitle>
            </CardHeader>
            <CardContent>
              {hasRuns ? (
                <BarChart
                  id="usage-chart"
                  className="h-64"
                  data={chartData}
                  index="day"
                  categories={categories}
                  icons={chartIcons}
                  colors={colors}
                  type="stacked"
                  yAxisWidth={40}
                  valueFormatter={(value) => numberFormat.format(value)}
                  allowDecimals={false}
                />
              ) : (
                <p id="usage-chart-empty" className="py-10 text-center text-sm text-muted-foreground">
                  No runs recorded yet — this chart fills in as your remixlets run on their pages.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per remixlet</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              <div className="flex items-end gap-3 px-2 pb-1 text-xs text-muted-foreground">
                <span className="size-8 shrink-0" />
                <span className="min-w-0 flex-1" />
                <span className="w-24 shrink-0" />
                <span className="w-24 shrink-0 text-right">Runs ({CHART_DAYS}d)</span>
                <span className="w-20 shrink-0 text-right">Runs (Total)</span>
                <span className="w-24 shrink-0 text-right">Last used</span>
              </div>
              {ranked.map((entry) => {
                const record = records[entry.id];
                const spark = usageDaySpan(now, CHART_DAYS).map((dayKey) => ({
                  day: dayKey,
                  runs: record?.days[dayKey] ?? 0,
                }));
                return (
                  <a
                    key={entry.id}
                    href={routeHash({ kind: "remixlet", id: entry.id })}
                    data-usage-remixlet={entry.id}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
                      <SiteIcon icons={siteIcons} siteKey={entry.siteKey} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{entry.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{entry.siteKey}</span>
                    </span>
                    {entry.state !== "enabled" ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0",
                          entry.state === "needs-attention" && "border-[var(--signal)]/40 text-[var(--signal)]",
                        )}
                      >
                        {entry.state === "needs-attention" ? "needs attention" : entry.state}
                      </Badge>
                    ) : quarantined[entry.id] !== undefined ? (
                      <Badge
                        variant="outline"
                        className="entry-quarantined shrink-0 border-[var(--signal)]/40 text-[var(--signal)]"
                        title={quarantined[entry.id]}
                      >
                        not running
                      </Badge>
                    ) : null}
                    <SparkAreaChart
                      className="h-8 w-24 shrink-0"
                      data={spark}
                      index="day"
                      categories={["runs"]}
                      colors={["chart1"]}
                    />
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {numberFormat.format(record ? usageRunsInWindow(record, now, CHART_DAYS) : 0)}
                    </span>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {numberFormat.format(record?.total ?? 0)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {usageLastRunLabel(record, now)}
                    </span>
                  </a>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      {!loaded && entries === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
    </div>
  );
}
