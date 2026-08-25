// One chat's run log: the unabridged, behind-the-scenes record of every agent
// run in that conversation, read straight from its session JSONL in OPFS.
// This page is the counterpart to the panel's plain-English chat — here tool
// names, arguments, results, model/token accounting, and failures are the
// content, not something to hide. Read-only: the panel stays the session's
// single writer.
//
// Visuals follow the chat-detail design handoff: meta chips instead of the raw
// UUID/"Started …" lines, underline tabs, and one surface card of divider-
// separated rows for the run log. Ids (#tab-chat, #log-entries, #log-summary,
// #log-missing, …) and data-kind/data-tool attributes are a contract with the
// test suites — restyle freely, but keep them.

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { readConversationLog, type ConversationLog, type ConversationLogEntry } from "../../agent/conversation-log.js";
import type { ConversationMeta } from "../../store/conversation-index.js";
import { ChatTranscript } from "./chat-transcript.js";
import { dayLabel, timeFormat } from "./day-groups.js";
import { routeHash } from "./router.js";
import { send } from "./send.js";

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

// The left rail's fixed-width clock; the full date rides the row's title.
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function formatTime(at: number): string {
  return at > 0 ? clockFormat.format(at) : "—";
}

function pretty(value: ConversationLogEntry["raw"]): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// The one code-block treatment: tool output, JSON, raw records. Failed results
// swap to the destructive block colors.
function CodeBlock({ failed, children }: { failed?: boolean; children: ReactNode }) {
  return (
    <pre
      className={cn(
        "max-h-[220px] overflow-auto rounded-md px-3 py-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap",
        failed ? "bg-destructive/10 text-destructive" : "bg-secondary/60 text-foreground/80",
      )}
    >
      {children}
    </pre>
  );
}

function Json({ value }: { value: unknown }) {
  return <CodeBlock>{pretty(value)}</CodeBlock>;
}

// Collapsed-by-default disclosure with the chevron summary the handoff gives
// for "Raw" — Thinking and Details share the treatment.
function Disclosure({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <details className={cn("text-[11px]", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-[5px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-2.5" strokeWidth={2.5} aria-hidden />
        {label}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

function RawDisclosure({ raw }: { raw: unknown }) {
  return (
    <Disclosure label="Raw" className="log-raw">
      <Json value={raw} />
    </Disclosure>
  );
}

// The row's kind pill. user/system sit on surface-2, assistant on accent —
// Badge already maps those; the handoff's pill geometry rides className.
const PILL = "rounded-[10px] text-[11px] font-normal";

// Tool results get an outlined pill: status dot + tool name, "failed" spelled
// out in destructive when the call errored — replaces "tool ok"/"tool failed".
function ToolPill({ toolName, ok }: { toolName: string; ok: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[10px] bg-card px-2 ring-1",
        ok ? "ring-foreground/15" : "ring-destructive/35",
      )}
    >
      <span className={cn("size-1.5 rounded-full", ok ? "bg-primary" : "bg-destructive")} aria-hidden />
      <span className="font-mono text-[10.5px] text-foreground">{toolName}</span>
      {!ok && <span className="text-[11px] text-destructive">failed</span>}
    </span>
  );
}

// Every entry renders the same frame — time rail on the left, pill row +
// kind-specific body on the right, the raw JSONL record behind one disclosure.
function LogRow({ entry, pills, children }: { entry: ConversationLogEntry; pills: ReactNode; children?: ReactNode }) {
  return (
    <div className="log-entry flex gap-3.5 px-[18px] py-3.5" data-kind={entry.kind}>
      <span
        className="w-14 shrink-0 pt-[3px] font-mono text-[11px] tabular-nums text-muted-foreground"
        title={entry.at > 0 ? new Date(entry.at).toLocaleString() : undefined}
      >
        {formatTime(entry.at)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">{pills}</div>
        {children}
        <RawDisclosure raw={entry.raw} />
      </div>
    </div>
  );
}

// One assistant tool call: name plus args as an inline chip when the JSON is
// short, a scrolling block when it isn't.
function ToolCallLine({ name, args }: { name: string; args: unknown }) {
  let inline: string | undefined;
  try {
    inline = JSON.stringify(args);
  } catch {
    inline = undefined;
  }
  const short = inline !== undefined && inline.length <= 72;
  return (
    <div className="tool-call flex flex-col gap-1" data-tool={name}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11.5px]">→ {name}</span>
        {short && (
          <code className="min-w-0 rounded bg-secondary px-1.5 py-px font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">
            {inline}
          </code>
        )}
      </div>
      {!short && <Json value={args} />}
    </div>
  );
}

function LogEntryRow({ entry }: { entry: ConversationLogEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <LogRow entry={entry} pills={<Badge variant="secondary" className={PILL}>user</Badge>}>
          <p className="text-[13px] leading-[1.6] whitespace-pre-wrap">{entry.text}</p>
        </LogRow>
      );
    case "assistant": {
      // Model and token totals headline the pill row; api/stopReason stay in
      // the Raw disclosure rather than repeating on every entry.
      const usage = entry.usage;
      return (
        <LogRow
          entry={entry}
          pills={
            <>
              <Badge className={PILL}>assistant</Badge>
              {entry.model.length > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">{entry.model}</span>}
              {usage && (
                <span className="text-[11px] text-muted-foreground">
                  {formatTokens(usage.input + usage.cacheRead)} in / {formatTokens(usage.output)} out
                </span>
              )}
            </>
          }
        >
          {entry.thinking.length > 0 && (
            <Disclosure label="Thinking">
              <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">{entry.thinking}</p>
            </Disclosure>
          )}
          {entry.text.length > 0 && <p className="text-[13px] leading-[1.6] whitespace-pre-wrap">{entry.text}</p>}
          {entry.toolCalls.length > 0 && (
            <div className="flex flex-col gap-1">
              {entry.toolCalls.map((call) => (
                <ToolCallLine key={call.id} name={call.name} args={call.args} />
              ))}
            </div>
          )}
        </LogRow>
      );
    }
    case "tool_result":
      return (
        <LogRow entry={entry} pills={<ToolPill toolName={entry.toolName} ok={entry.ok} />}>
          {entry.text.length > 0 && <CodeBlock failed={!entry.ok}>{entry.text}</CodeBlock>}
          {entry.details !== undefined && (
            <Disclosure label="Details">
              <Json value={entry.details} />
            </Disclosure>
          )}
        </LogRow>
      );
    case "run_error":
      return (
        <LogRow entry={entry} pills={<Badge variant="destructive" className={PILL}>error</Badge>}>
          <p className="text-[13px] leading-[1.6] whitespace-pre-wrap text-destructive">{entry.message}</p>
        </LogRow>
      );
    case "run_aborted":
      return (
        <LogRow entry={entry} pills={<Badge variant="secondary" className={cn(PILL, "text-muted-foreground")}>stopped</Badge>}>
          <p className="text-[13px] text-muted-foreground">The run was stopped before it finished.</p>
        </LogRow>
      );
    default:
      // Bookkeeping lines: a "system" pill plus the entry's own label (the
      // parser's "custom:" prefix is display noise — Raw keeps the full record).
      return (
        <LogRow
          entry={entry}
          pills={
            <>
              <Badge variant="secondary" className={cn(PILL, "text-muted-foreground")}>system</Badge>
              <span className="font-mono text-[11px] text-muted-foreground">{entry.label.replace(/^custom: /, "")}</span>
            </>
          }
        />
      );
  }
}

// Header meta chip; the site chip is mono and carries the conversation id as
// its hover tooltip — the id's only remaining surface on the page.
function MetaChip({ mono, title, children }: { mono?: boolean; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 items-center rounded-xl bg-card px-[9px] text-muted-foreground shadow-(--ring-1)",
        mono ? "font-mono text-[10.5px]" : "text-[11.5px]",
      )}
    >
      {children}
    </span>
  );
}

// Underline tab per the handoff: 13px, accent inset underline when active.
const TAB =
  "flex-none rounded-none px-0.5 pt-2 pb-2.5 text-[13px] font-normal text-muted-foreground data-active:font-medium data-active:shadow-[inset_0_-2px_0_var(--accent)]";

export function ConversationLogPage({ id }: { id: string }) {
  const [log, setLog] = useState<ConversationLog | undefined | "missing">(undefined);
  const [meta, setMeta] = useState<ConversationMeta | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Chat leads and is the default tab — the conversation as the sidebar
  // showed it comes before the unabridged run log.
  const [tab, setTab] = useState("chat");

  useEffect(() => {
    void readConversationLog(id)
      .then((read) => setLog(read ?? "missing"))
      .catch((cause: unknown) => setError(String(cause)));
    // The index is metadata-only; a conversation can have a JSONL without an
    // index row (e.g. the first prompt never settled), so a miss is fine.
    void send({ kind: "conversation.list" }, "conversation.listed")
      .then((reply) => setMeta(reply.conversations.find((candidate) => candidate.id === id)))
      .catch(() => undefined);
  }, [id]);

  const entries = log === undefined || log === "missing" ? [] : log.entries;
  const totals = entries.reduce(
    (sum, entry) =>
      entry.kind === "assistant" && entry.usage
        ? { input: sum.input + entry.usage.input + entry.usage.cacheRead, output: sum.output + entry.usage.output, cost: sum.cost + entry.usage.cost }
        : sum,
    { input: 0, output: 0, cost: 0 },
  );

  return (
    <div id="conversation-log-page" className="flex flex-col gap-4" data-id={id}>
      <header className="flex flex-col gap-2.5">
        <a
          href={routeHash({ kind: "conversations" })}
          className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-[13px]" aria-hidden />
          All chats
        </a>
        <h1 className="text-2xl font-semibold tracking-tight text-pretty">{meta?.title || "Untitled conversation"}</h1>
        {log !== undefined && log !== "missing" && (
          <div id="log-summary" className="flex flex-wrap gap-2">
            {meta?.siteKey && (
              <MetaChip mono title={id}>
                {meta.siteKey}
              </MetaChip>
            )}
            {log.startedAt !== undefined && (
              <MetaChip>{`${dayLabel(log.startedAt, new Date())}, ${timeFormat.format(log.startedAt)}`}</MetaChip>
            )}
            <MetaChip>{entries.length} entries</MetaChip>
            {totals.input + totals.output > 0 && (
              <MetaChip>{`${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`}</MetaChip>
            )}
            {totals.cost > 0 && <MetaChip>${totals.cost.toFixed(4)}</MetaChip>}
          </div>
        )}
      </header>

      {error !== undefined && <p className="text-[13px] text-destructive">Couldn’t read this chat’s log: {error}</p>}
      {log === undefined && error === undefined && <p className="text-[13px] text-muted-foreground">Loading log…</p>}
      {log === "missing" && (
        <p id="log-missing" className="text-[13px] text-muted-foreground">
          No log recorded for this chat yet — it exists once the first prompt runs.
        </p>
      )}

      {log !== undefined && log !== "missing" && (
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-4">
          <TabsList variant="line" className="h-auto w-full justify-start gap-[18px] border-b border-(--line-soft) p-0">
            <TabsTrigger value="chat" id="tab-chat" className={TAB}>
              Chat
            </TabsTrigger>
            <TabsTrigger value="log" id="tab-log" className={TAB}>
              Run log
              <span className="rounded-md bg-secondary px-1.5 py-px text-[10.5px] font-normal text-muted-foreground tabular-nums">
                {entries.length}
              </span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat" id="conversation-chat">
            <ChatTranscript entries={entries} />
          </TabsContent>
          <TabsContent value="log" id="log-entries" className="mb-6">
            <Card className="py-0">
              <CardContent className="flex flex-col divide-y divide-(--line-soft) px-0">
                {entries.map((entry, index) => (
                  <LogEntryRow key={index} entry={entry} />
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
