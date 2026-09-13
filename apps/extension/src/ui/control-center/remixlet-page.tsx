// One remixlet's whole page: the trust surface for a single mod. The Overview
// tab leads with the README — the plain-English statement of what the remixlet
// is supposed to do — beside a small rail answering "is it actually running"
// (run counts from the usage store) and "what version is live". The Activity
// tab is one day-grouped timeline of the chats that shaped the remixlet and
// the versions they produced — colored diffs, code at any commit, one-click
// LIVE rollback. The header carries the enable switch and a ⋯ menu for the
// rare lifecycle actions.
//
// There is no Code tab: source needs the full viewport width, and a full-bleed
// tab beside column-width ones reads wrong. Code is reached from where it's
// relevant instead — any version's row on Activity ("Code") and the Version
// card on Overview — always via the sliding window.
//
// A version's diff or code opens as a sliding window rather than an inline
// expansion or a dialog: the page slides left and a full-size panel slides in
// from the right, with a back button (and Escape) to return. The page stays
// mounted underneath, so tab choice and scroll survive the round trip. The
// page proper sits in the same centered max-w-4xl column as the Chats page;
// only the slide spans the whole panel.

import { useEffect, useState } from "react";
import { ArrowLeft, FileCode2, History, MessagesSquare, ShieldCheck } from "lucide-react";

import { SparkAreaChart } from "@/components/charts/spark-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { capabilityExplanation } from "../../shared/capability-copy.js";
import { describeLookReview } from "../../shared/look-review.js";

import type { ConversationMeta } from "../../store/conversation-index.js";
import type { RegistryEntry, RemixletVersion } from "../../store/remixlet-store.js";
import { usageDaySpan, usageLastRunLabel, usageRunsInWindow, type UsageRecord } from "../../shared/usage.js";
import { SiteIcon } from "../site-icon.js";
import { FileDiff, VersionCode, type DiffFile } from "./code-view.js";
import { groupByDay, relativeTimeLabel, timeFormat } from "./day-groups.js";
import { ReadmeView } from "./readme-view.js";
import { RemixletActionsMenu } from "./remixlet-actions.js";
import { routeHash } from "./router.js";
import { rollbackWithApproval, send } from "./send.js";

const RUNS_WINDOW_DAYS = 30;

const numberFormat = new Intl.NumberFormat();

// ---- activity ---------------------------------------------------------------

// Chats and versions are interleaved by time rather than nested under each
// other: versions record no conversation id, so any chat→version pairing
// would be a guess. The day grouping still reads as the story — the request,
// then the version that landed moments later.
type ActivityItem =
  | { kind: "version"; when: number; version: RemixletVersion }
  | { kind: "chat"; when: number; meta: ConversationMeta };

function ChatRow({ meta }: { meta: ConversationMeta }) {
  return (
    <a
      href={routeHash({ kind: "conversation", id: meta.id })}
      className="remixlet-chat-link group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50"
      data-id={meta.id}
    >
      {/* Icon sits in the same w-7 gutter as the version rows' tag, and the
          title carries the diff button's px-1.5, so chat and version text
          share one left edge. */}
      <span className="flex w-7 shrink-0 items-center" aria-hidden>
        <MessagesSquare className="size-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 truncate px-1.5 text-sm group-hover:text-foreground">
        {meta.title || "Untitled conversation"}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {timeFormat.format(meta.updatedAt)}
      </span>
    </a>
  );
}

function ActivityTimeline({
  versions,
  chats,
  chatsError,
  busy,
  onShowDiff,
  onShowCode,
  onRollback,
}: {
  versions: RemixletVersion[] | undefined;
  chats: ConversationMeta[] | undefined;
  chatsError: string | undefined;
  busy: boolean;
  onShowDiff: (version: RemixletVersion) => void;
  onShowCode: (version: RemixletVersion) => void;
  onRollback: (sha: string) => void;
}) {
  if (!versions) return <p className="text-xs text-muted-foreground">Loading history…</p>;

  const items: ActivityItem[] = [
    ...versions.map((version) => ({ kind: "version" as const, when: version.when, version })),
    ...(chats ?? []).map((meta) => ({ kind: "chat" as const, when: meta.updatedAt, meta })),
  ].sort((a, b) => b.when - a.when);
  const groups = groupByDay(items, (item) => item.when, new Date());

  return (
    <div className="flex flex-col gap-4">
      {chatsError !== undefined && <p className="text-xs text-destructive">Couldn’t load chats: {chatsError}</p>}
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</h2>
          <Card className="py-0">
            <CardContent className="flex flex-col divide-y px-0">
              {group.items.map((item) =>
                item.kind === "chat" ? (
                  <ChatRow key={item.meta.id} meta={item.meta} />
                ) : (
                  <div
                    key={item.version.sha}
                    className="version-row flex flex-col"
                    data-sha={item.version.sha}
                    data-version={item.version.version}
                    data-current={item.version.current ? "" : undefined}
                  >
                    <div className="flex items-center gap-3 px-4 py-2">
                      <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground">{item.version.tag}</span>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted"
                        data-action="show-diff"
                        onClick={() => onShowDiff(item.version)}
                      >
                        {item.version.message.split("\n")[0]}
                      </button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        data-action="view-code"
                        onClick={() => onShowCode(item.version)}
                      >
                        <FileCode2 data-icon="inline-start" />
                        Code
                      </Button>
                      {/* Fixed-width actions cell: the badge and the button occupy the
                          same track, so rows align whichever one a row carries. */}
                      <span className="flex w-24 shrink-0 justify-end">
                        {item.version.current ? (
                          <Badge variant="secondary">current</Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            data-action="rollback"
                            disabled={busy}
                            onClick={() => onRollback(item.version.sha)}
                          >
                            <History data-icon="inline-start" />
                            Roll back
                          </Button>
                        )}
                      </span>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {timeFormat.format(item.version.when)}
                      </span>
                    </div>
                  </div>
                ),
              )}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}

// ---- sliding version window ---------------------------------------------------

// Which full-size panel is slid in over the page: one version's diff against
// its parent, or its complete source.
type SlideView = { view: "diff" | "code"; version: RemixletVersion };

// The full-size panel itself. Enter/exit are CSS animations (tw-animate-css)
// so the mount slides in and the unmount waits for the exit to finish; the
// page underneath handles its own matching transform via a transition.
function VersionSlide({
  entry,
  slide,
  closing,
  onBack,
  onClosed,
}: {
  entry: RegistryEntry;
  slide: SlideView;
  closing: boolean;
  onBack: () => void;
  onClosed: () => void;
}) {
  const { view, version } = slide;
  const [diff, setDiff] = useState<DiffFile[] | undefined>(undefined);

  useEffect(() => {
    if (view !== "diff") return;
    setDiff(undefined);
    // No fromSha: the worker diffs against the commit's real first parent —
    // after a rollback fork, the list neighbor is not the git parent.
    void send({ kind: "remixlet.diff", id: entry.id, toSha: version.sha }, "remixlet.diffResult").then((reply) =>
      setDiff(reply.files),
    );
  }, [entry.id, version.sha, view]);

  return (
    <div
      id="version-slide"
      data-view={view}
      data-sha={version.sha}
      className={cn(
        "absolute inset-0 z-10 flex flex-col gap-3 bg-background duration-300 ease-out",
        closing ? "animate-out slide-out-to-right fill-mode-forwards" : "animate-in slide-in-from-right",
      )}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onClosed();
      }}
    >
      <header className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          data-action="slide-back"
          aria-label="Back to remixlet"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {view === "diff" ? `Changes in ${version.tag}` : `Code at ${version.tag}`}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {version.message.split("\n")[0]} · <span className="font-mono">{version.sha.slice(0, 7)}</span> ·{" "}
            {new Date(version.when).toLocaleString()}
          </p>
        </div>
        {version.current && (
          <Badge variant="secondary" className="shrink-0">
            current
          </Badge>
        )}
      </header>
      {view === "code" ? (
        <div className="min-h-0 flex-1">
          <VersionCode key={version.sha} id={entry.id} sha={version.sha} height="100%" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-2 pb-4">
            {diff === undefined && <p className="text-xs text-muted-foreground">Loading diff…</p>}
            {diff?.length === 0 && <p className="text-xs text-muted-foreground">No file changes in this version.</p>}
            {diff?.map((file) => <FileDiff key={file.path} file={file} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- overview rail ----------------------------------------------------------

// Runs and Version share one "health" card — two sections split by a divider
// rather than two floating cards, so the rail reads as one answer to "is it
// alive and what's live".
function HealthCard({
  entry,
  versions,
  record,
  loaded,
  onShowCode,
}: {
  entry: RegistryEntry;
  versions: RemixletVersion[] | undefined;
  record: UsageRecord | undefined;
  loaded: boolean;
  onShowCode: (version: RemixletVersion) => void;
}) {
  const now = Date.now();
  const spark = usageDaySpan(now, RUNS_WINDOW_DAYS).map((dayKey) => ({
    day: dayKey,
    runs: record?.days[dayKey] ?? 0,
  }));
  const current = versions?.find((version) => version.current);
  return (
    <Card id="remixlet-health" className="py-0">
      <CardContent className="flex flex-col divide-y px-0">
        <div id="remixlet-usage" className="flex flex-col gap-2 p-4">
          <p className="text-xs text-muted-foreground">Runs · {RUNS_WINDOW_DAYS} days</p>
          <p className="text-2xl font-semibold tracking-tight">
            {loaded ? numberFormat.format(record ? usageRunsInWindow(record, now, RUNS_WINDOW_DAYS) : 0) : "…"}
          </p>
          <SparkAreaChart className="h-8 w-full" data={spark} index="day" categories={["runs"]} colors={["accent"]} />
          <p className="text-xs text-muted-foreground">{loaded ? `Last ran ${usageLastRunLabel(record, now)}` : " "}</p>
        </div>
        <div id="remixlet-version" className="flex flex-col gap-2 p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-xs text-muted-foreground">Version</p>
            {current && (
              <button
                type="button"
                id="open-current-code"
                className="text-xs text-primary hover:underline"
                onClick={() => onShowCode(current)}
              >
                View code →
              </button>
            )}
          </div>
          <p className="text-2xl font-semibold tracking-tight">v{entry.version}</p>
          <p className="text-xs text-muted-foreground">
            {current ? (
              <span title={new Date(current.when).toISOString()}>
                Updated {relativeTimeLabel(current.when, new Date())}
              </span>
            ) : (
              "…"
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// The visual review (wiki/design/look-review.md): what the model said after
// comparing cropped screenshots of its control with the page's own, and —
// when stored — the crop it compared, so the user can judge the judgement in
// one glance. Stale reviews (an older version's) say which. It renders as the
// last section of the README sheet, in the README's own heading style: it is
// prose about the remixlet, not a health number, and the crop needs the
// width. It stays its own component because it is not part of README.md —
// it is a store field carried forward across versions.
function VisualReviewSection({ entry }: { entry: RegistryEntry }) {
  const review = entry.lookReview;
  const [crop, setCrop] = useState<string | undefined>(undefined);
  const hasCrop = review?.hasCrop === true;
  useEffect(() => {
    setCrop(undefined);
    if (!hasCrop) return;
    let cancelled = false;
    void send({ kind: "remixlet.readLookCrop", id: entry.id }, "remixlet.lookCrop")
      .then((reply) => {
        if (!cancelled) setCrop(reply.dataUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entry.id, entry.headSha, hasCrop]);
  if (!review) return null;
  const stale = review.version !== undefined && review.version !== entry.version ? ` (v${review.version})` : "";
  return (
    <section id="remixlet-look" className="readme-doc mt-3" data-verdict={review.verdict}>
      <h2>Visual review{stale}</h2>
      <p className="look-review-line">{describeLookReview(review)}</p>
      {crop && (
        <img
          className="look-review-crop max-w-full rounded-md border"
          src={crop}
          alt="The control as Remixlet saw it, in its row on the page"
          title="What Remixlet compared"
        />
      )}
    </section>
  );
}

// The newest linked conversation, its title styled like the panel's user
// bubble — the rail's pointer back into the chat that shaped this remixlet.
function LatestChatCard({ chats }: { chats: ConversationMeta[] | undefined }) {
  const latest = chats?.[0];
  if (!latest) return null;
  return (
    <Card id="remixlet-latest-chat" className="gap-2 py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <p className="font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
          Latest chat
        </p>
        <span className="self-end rounded-[10px_10px_3px_10px] bg-[var(--accent-deep)] px-3 py-2 text-[12.5px] leading-[18px]">
          {latest.title || "Untitled conversation"}
        </span>
        <div className="flex items-baseline justify-between">
          <a href={routeHash({ kind: "conversation", id: latest.id })} className="text-xs text-primary hover:underline">
            Open chat →
          </a>
          <span className="text-xs tabular-nums text-muted-foreground">
            {relativeTimeLabel(latest.updatedAt, new Date())}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- capabilities -----------------------------------------------------------

// What the remixlet is allowed to do, in plain words — the first surface that
// shows, standing, what a live remixlet holds. The stored manifest is the
// approval record (every capability here passed the activation dialog), so
// there is nothing to toggle: walking a permission back means asking a chat
// for a version without it, or archiving/deleting the remixlet.
//
// The baseline row is always first: every remixlet reads and changes the
// page it runs on, and the box (wiki/design/mediated-execution.md) bounds
// where what it reads can go — the site itself and the granted hosts listed
// under it. An empty grant list is not "no permissions"; it is the baseline
// and nothing more.
const BASELINE_TITLE = "Reads and changes the page it runs on";
const BASELINE_DETAIL =
  "Its code runs in a sandbox, so what it reads can reach only this site and the sites listed below.";

function CapabilitiesCard({ capabilities }: { capabilities: string[] | undefined }) {
  return (
    <Card id="remixlet-capabilities" className="gap-2 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <p className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
          <ShieldCheck className="size-3.5" aria-hidden />
          Permissions
        </p>
        {capabilities === undefined ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <ul className="flex flex-col divide-y">
            <li id="remixlet-capabilities-baseline" className="capability-row flex items-start gap-8 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{BASELINE_TITLE}</p>
                <p className="text-xs text-muted-foreground">{BASELINE_DETAIL}</p>
              </div>
            </li>
            {capabilities.map((capability) => {
              const copy = capabilityExplanation(capability);
              return (
                <li
                  key={capability}
                  className="capability-row flex items-start gap-8 py-2.5 first:pt-0 last:pb-0"
                  data-capability={capability}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{copy.title}</p>
                    <p className="text-xs text-muted-foreground">{copy.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// The plain-words account of why a system-parked remixlet is off the page,
// with the stored failure detail when the record carries one.
function needsAttentionExplanation(entry: RegistryEntry): string {
  const base = "The last change couldn't be confirmed working, so this remixlet is off the page until it's fixed.";
  const result = entry.lastVerifyResult;
  if (!result || result.outcome === "passed") return base;
  const detail = result.summary ? ` (${result.summary})` : "";
  return `${base} Verification failed ${result.at.slice(0, 10)}${detail}.`;
}

// ---- page -------------------------------------------------------------------

export function RemixletPage({
  entry,
  quarantine,
  siteIcons,
  onChanged,
}: {
  entry: RegistryEntry;
  /** Why the worker refuses to run this enabled artifact, when it does. */
  quarantine: string | undefined;
  siteIcons: Record<string, string> | undefined;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // Controlled so tab-gated children can mount fresh per visit: Base UI keeps
  // inactive panels mounted (hidden), so a child that fetches on mount would
  // otherwise show stale data forever.
  const [tab, setTab] = useState("overview");
  const [versions, setVersions] = useState<RemixletVersion[] | undefined>(undefined);
  const [usage, setUsage] = useState<Record<string, UsageRecord> | undefined>(undefined);
  const [chats, setChats] = useState<ConversationMeta[] | undefined>(undefined);
  const [chatsError, setChatsError] = useState<string | undefined>(undefined);
  // The slid-in version window. `slide` holds what it shows (kept mounted
  // through the exit animation); `slideClosing` drives that exit — the panel
  // unmounts only when its animation reports done.
  const [slide, setSlide] = useState<SlideView | undefined>(undefined);
  const [slideClosing, setSlideClosing] = useState(false);
  const [capabilities, setCapabilities] = useState<string[] | undefined>(undefined);

  const archived = entry.state === "archived";
  const slideOpen = slide !== undefined && !slideClosing;

  function openSlide(view: SlideView["view"], version: RemixletVersion): void {
    setSlideClosing(false);
    setSlide({ view, version });
  }

  useEffect(() => {
    if (!slideOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSlideClosing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slideOpen]);

  useEffect(() => {
    void send({ kind: "remixlet.versions", id: entry.id }, "remixlet.versionsListed").then((reply) =>
      setVersions(reply.versions),
    );
  }, [entry.id, entry.headSha]);

  // Re-read after every version change too: the stored manifest is the
  // approval record, so each activation can change the set and the panel must
  // not show a stale one.
  useEffect(() => {
    setCapabilities(undefined);
    void send({ kind: "remixlet.capabilities", id: entry.id }, "remixlet.capabilitiesResult")
      .then((reply) => setCapabilities(reply.capabilities))
      .catch((cause: unknown) => console.error("[remixlet] capability read failed", cause));
  }, [entry.id, entry.headSha]);

  useEffect(() => {
    void send({ kind: "usage.read" }, "usage.result")
      .then((reply) => setUsage(reply.usage))
      .catch((cause: unknown) => {
        console.error("[remixlet] usage read failed", cause);
        setUsage({});
      });
  }, [entry.id]);

  // The chats that wrote this remixlet — the reverse view of the sidecar
  // index's remixletIds. Filtered client-side (the index is one small JSON
  // file) and refetched on every tab switch, so returning to Activity always
  // shows chats linked since the last visit.
  useEffect(() => {
    void send({ kind: "conversation.list" }, "conversation.listed")
      .then((reply) => setChats(reply.conversations.filter((meta) => meta.remixletIds.includes(entry.id))))
      .catch((cause: unknown) => setChatsError(String(cause)));
  }, [entry.id, tab]);

  function runAction(fn: () => Promise<void>): void {
    if (busy) return;
    setBusy(true);
    void fn()
      .catch((cause: unknown) => console.error("[remixlet] manager action failed", cause))
      .then(() => onChanged())
      .finally(() => setBusy(false));
  }

  const activityCount = versions && chats ? versions.length + chats.length : undefined;

  return (
    <div className="remixlet-page relative min-h-0 flex-1 overflow-hidden" data-id={entry.id} data-state={entry.state}>
      {/* The page proper, in the same centered column as the Chats page. When
          the version window is up this layer slides a quarter-width left and
          dims (the stacked-cards read), and goes inert so the covered controls
          can't be reached. Only the slide gets the panel's full width. */}
      <div
        className={cn(
          "mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-6 transition-[transform,opacity] duration-300 ease-out",
          slideOpen && "pointer-events-none -translate-x-1/4 opacity-50",
        )}
        aria-hidden={slideOpen || undefined}
      >
        <header className="flex items-center gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card shadow-xs">
            <SiteIcon icons={siteIcons} siteKey={entry.siteKey} className="size-8 rounded-md" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{entry.name}</h1>
            <p className="truncate font-mono text-xs text-muted-foreground">{entry.matches.join(", ")}</p>
          </div>
          {archived ? (
            <Badge variant="outline" className="entry-state shrink-0">
              archived
            </Badge>
          ) : entry.state === "needs-attention" ? (
            // System-parked: no toggle at all — the store rejects setEnabled
            // for this state, so a switch here could only lie. The badge is
            // the state; the failure detail rides its tooltip.
            <Badge
              variant="outline"
              className="entry-state shrink-0 border-[var(--signal)]/40 text-[var(--signal)]"
              title={needsAttentionExplanation(entry)}
            >
              needs attention
            </Badge>
          ) : (
            <>
              {quarantine !== undefined && (
                // The switch says on and is honest — the user did not turn it
                // off — but the worker could not admit the files. The badge is
                // the state; the reason rides its tooltip.
                <Badge
                  variant="outline"
                  className="entry-quarantined shrink-0 border-[var(--signal)]/40 text-[var(--signal)]"
                  title={`Not running: ${quarantine}. Update it from a chat, roll back to an earlier version, or delete it.`}
                >
                  not running
                </Badge>
              )}
              <Switch
                className="entry-toggle"
                checked={entry.state === "enabled"}
                disabled={busy}
                onCheckedChange={(checked) =>
                  runAction(async () => {
                    await send({ kind: "remixlet.setEnabled", id: entry.id, enabled: checked, reloadMatching: true }, "remixlet.entry");
                  })
                }
              />
            </>
          )}
          {/* Archive and delete-forever live behind this menu rather than as
              standing buttons: they are rare, and two of the three are one-way. */}
          <RemixletActionsMenu entry={entry} onChanged={onChanged} />
        </header>

        {/* The README leads and is the default tab — the plain-English account
            of the remixlet comes before its source. */}
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="min-h-0 flex-1 gap-5">
          <TabsList>
            <TabsTrigger value="overview" id="tab-overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="activity" id="tab-activity">
              Activity
              {activityCount !== undefined && (
                <span className="inline-flex size-4.5 items-center justify-center rounded-full bg-background text-[11px] font-normal text-muted-foreground tabular-nums">
                  {activityCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" id="current-readme" className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-5">
                {/* The doc sheet: the README sits on a card like everything
                    else on the page, not bare on the canvas. */}
                <Card className="py-0">
                  <CardContent className="p-7">
                    <ReadmeView key={entry.headSha} id={entry.id} sha={entry.headSha} />
                    {entry.lookReview && <VisualReviewSection entry={entry} />}
                  </CardContent>
                </Card>
                {/* Permissions sit in the main column under the README — wide
                    enough for the titles and revoke consequences to read, but
                    not stretched under the rail. Only for an entry the mirror
                    build admitted: a quarantined one holds nothing live, and
                    its stored names may predate this build's copy table. */}
                {quarantine === undefined && <CapabilitiesCard capabilities={capabilities} />}
              </div>
              <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-64">
                <HealthCard
                  entry={entry}
                  versions={versions}
                  record={usage?.[entry.id]}
                  loaded={usage !== undefined}
                  onShowCode={(version) => openSlide("code", version)}
                />
                <LatestChatCard chats={chats} />
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="activity" id="remixlet-activity" className="min-h-0 flex-1 overflow-y-auto">
            <ActivityTimeline
              versions={versions}
              chats={chats}
              chatsError={chatsError}
              busy={busy}
              onShowDiff={(version) => openSlide("diff", version)}
              onShowCode={(version) => openSlide("code", version)}
              onRollback={(sha) => runAction(() => rollbackWithApproval(entry.id, sha))}
            />
          </TabsContent>
        </Tabs>
      </div>

      {slide && (
        <VersionSlide
          entry={entry}
          slide={slide}
          closing={slideClosing}
          onBack={() => setSlideClosing(true)}
          onClosed={() => {
            setSlide(undefined);
            setSlideClosing(false);
          }}
        />
      )}
    </div>
  );
}
