// Read-only view of a conversation's session JSONL for the run-log UI: every
// line rendered pi-free, nothing filtered. Where the chat deliberately hides
// tool names and payloads behind plain English (panel/app.tsx), this is the
// escape hatch that shows exactly what the agent did — prompts, tool calls
// with their arguments, results, model/token accounting, and the run_error /
// run_aborted custom entries ConversationSession records for turns whose
// assistant messages never persist.
//
// Parses pi's v4 session format directly: a {kind:"header"} first line, then
// one mutation per line — {kind:"entry"} lines carry the messages and custom
// entries; lane/record/fact mutations are bookkeeping and render as "other".

import { isFsError, OpfsFs } from "../store/opfs-fs.js";
import { findSessionFile } from "./session-path.js";

export interface LogUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Total cost in USD, when the provider prices are known. */
  cost: number;
}

export interface LogToolCall {
  id: string;
  name: string;
  args: unknown;
}

type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };
type ToolArguments = Record<string, LogValue>;
type LogContent = string | LogBlock[];

interface LogBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: ToolArguments;
}

interface LogCustomData {
  message?: string;
}

/**
 * One JSONL line, shaped for display. Every entry keeps `raw` (the parsed
 * line) so the viewer can always show the unabridged record.
 */
export type ConversationLogEntry =
  | { kind: "user"; at: number; text: string; raw: unknown }
  | {
      kind: "assistant";
      at: number;
      text: string;
      thinking: string;
      toolCalls: LogToolCall[];
      model: string;
      provider: string;
      api: string;
      stopReason: string;
      usage: LogUsage | undefined;
      raw: unknown;
    }
  | { kind: "tool_result"; at: number; toolCallId: string; toolName: string; ok: boolean; text: string; details: unknown; raw: unknown }
  | { kind: "run_error"; at: number; message: string; raw: unknown }
  | { kind: "run_aborted"; at: number; raw: unknown }
  | { kind: "other"; at: number; label: string; raw: unknown };

export interface ConversationLog {
  id: string;
  /** From the JSONL header line; undefined if the header is missing/torn. */
  startedAt: number | undefined;
  entries: ConversationLogEntry[];
}

/** The v4 fields this viewer reads from one parsed line; everything is optional because torn lines still render. */
interface LogLine {
  kind?: string;
  type?: string;
  timestamp?: number;
  createdAt?: number;
  customType?: string;
  data?: LogCustomData;
  message?: {
    role?: string;
    content?: LogContent;
    timestamp?: number;
    model?: string;
    provider?: string;
    api?: string;
    stopReason?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    details?: LogValue;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
  };
}

/**
 * Parse the conversation's session JSONL into display entries, or undefined
 * when the conversation has no file yet. Reads the file directly — OPFS is
 * shared by every extension document, and this never writes, so the panel's
 * one-writer-per-session rule is untouched.
 */
export async function readConversationLog(conversationId: string, fs: OpfsFs = new OpfsFs()): Promise<ConversationLog | undefined> {
  const path = await findSessionFile(conversationId, fs);
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = String(await fs.promises.readFile(path, "utf8"));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return undefined;
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let startedAt: number | undefined;
  const entries: ConversationLogEntry[] = [];
  for (const line of lines) {
    let parsed: LogValue;
    try {
      parsed = JSON.parse(line);
    } catch {
      entries.push({ kind: "other", at: 0, label: "unparseable line", raw: line });
      continue;
    }
    // SAFETY: pi writes JSON object lines; LogLine exposes only optional fields and all display reads have fallbacks.
    const record = parsed as LogLine;
    if (record.kind === "header") {
      if (isNumber(record.createdAt)) startedAt = record.createdAt;
      continue;
    }
    entries.push(toLogEntry(record));
  }
  return { id: conversationId, startedAt, entries };
}

function toLogEntry(line: LogLine): ConversationLogEntry {
  const fallbackAt = isNumber(line.timestamp) ? line.timestamp : 0;
  if (line.kind === "entry" && line.type === "message" && line.message !== undefined) {
    const message = line.message;
    const at = isNumber(message.timestamp) ? message.timestamp : fallbackAt;
    if (message.role === "user") {
      return { kind: "user", at, text: isString(message.content) ? message.content : blockText(message.content), raw: line };
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      return {
        kind: "assistant",
        at,
        text: blockText(content),
        thinking: content
          .filter((block): block is LogBlock & { type: "thinking"; thinking: string } => block.type === "thinking" && isString(block.thinking))
          .map((block) => block.thinking)
          .join("\n"),
        toolCalls: content
          .filter(
            (block): block is LogBlock & { type: "toolCall"; id: string; name: string; arguments: ToolArguments } =>
              block.type === "toolCall" && isString(block.id) && isString(block.name) && block.arguments !== undefined,
          )
          .map((block) => ({ id: block.id, name: block.name, args: block.arguments })),
        model: message.model ?? "",
        provider: message.provider ?? "",
        api: message.api ?? "",
        stopReason: message.stopReason ?? "",
        usage: message.usage
          ? {
              input: message.usage.input,
              output: message.usage.output,
              cacheRead: message.usage.cacheRead,
              cacheWrite: message.usage.cacheWrite,
              totalTokens: message.usage.totalTokens,
              cost: message.usage.cost.total,
            }
          : undefined,
        raw: line,
      };
    }
    if (message.role === "toolResult") {
      return {
        kind: "tool_result",
        at,
        toolCallId: message.toolCallId ?? "",
        toolName: message.toolName ?? "",
        ok: !message.isError,
        text: blockText(message.content),
        details: message.details,
        raw: line,
      };
    }
  }
  if (line.kind === "entry" && line.type === "custom") {
    const data = line.data;
    if (line.customType === "run_error") {
      return { kind: "run_error", at: fallbackAt, message: isString(data?.message) ? data.message : "(unknown error)", raw: line };
    }
    if (line.customType === "run_aborted") return { kind: "run_aborted", at: fallbackAt, raw: line };
    return { kind: "other", at: fallbackAt, label: `custom: ${line.customType}`, raw: line };
  }
  if (line.kind === "entry") return { kind: "other", at: fallbackAt, label: line.type ?? "entry", raw: line };
  return { kind: "other", at: fallbackAt, label: `${line.kind ?? "unknown"}${line.type ? `: ${line.type}` : ""}`, raw: line };
}

function blockText(content: LogContent | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is LogBlock & { type: "text"; text: string } => block.type === "text" && isString(block.text))
    .map((block) => block.text)
    .join("");
}

function isNumber(value: number | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isString(value: LogValue | LogContent | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
