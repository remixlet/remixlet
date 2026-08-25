// Conversation persistence: pi JSONL sessions on OPFS (wiki/handoff.md §8). One file
// per conversation at sessions/<id>.jsonl; Remixlet metadata (site key, title,
// linked remixlets) lives in the sidecar index (src/store/conversation-index.ts),
// NOT here — this module is pi's view of a conversation.
//
// ConversationSession is an opaque handle to product code: the panel opens
// one and passes it into createAgentRuntime; only src/agent/ sees pi types.

import {
  buildSessionContext,
  JsonlSessionRepo,
  Session,
  type AgentMessage,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { OpfsFs } from "../store/opfs-fs.js";
import { createSessionFs } from "./session-fs.js";
import { SESSIONS_DIR } from "./session-path.js";
import { classifyToolFailure, type ToolFailureKind } from "./tool-errors.js";
import {
  endsWithObserverRepairRequired,
  endsWithUnverifiedActivation,
  observerRepairIdsAtEnd,
  unverifiedActivationEntryAtEnd,
} from "./session-tail.js";

export { SESSIONS_DIR } from "./session-path.js";

/**
 * A session that died mid-tool-call (panel closed, worker killed) has an
 * assistant message whose toolCall blocks never got a toolResult. Providers
 * reject such context — repair it by synthesizing an error result for each
 * dangling call, right after its assistant message. The history stays intact
 * (the JSONL is append-only); only the rebuilt context is patched.
 */
export function sanitizeDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") answered.add(message.toolCallId);
  }
  const repaired: AgentMessage[] = [];
  for (const message of messages) {
    repaired.push(message);
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || answered.has(block.id)) continue;
      const synthetic: ToolResultMessage = {
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: "Tool call interrupted — the panel closed before this tool finished. Re-run it if still needed." }],
        isError: true,
        timestamp: message.timestamp,
      };
      repaired.push(synthetic);
    }
  }
  return repaired;
}

/**
 * A pi-free rendering of a resumed conversation for the history UI. Tool
 * steps carry the tool name + outcome; the panel maps them to the same
 * plain-English phrases the live chat uses. Product code sees only this.
 */
export type SessionTranscriptItem =
  | { kind: "user" | "assistant"; text: string }
  | { kind: "tool"; toolName: string; ok: boolean; failure?: ToolFailureKind };

export class ConversationSession {
  readonly id: string;
  /** Sanitized context, resolved at open() so runtime creation stays sync. */
  readonly initialMessages: AgentMessage[];
  readonly #session: Session<JsonlSessionMetadata>;
  /** Serializes appends so JSONL lines land in event order. */
  #appendChain: Promise<void> = Promise.resolve();

  private constructor(id: string, session: Session<JsonlSessionMetadata>, initialMessages: AgentMessage[]) {
    this.id = id;
    this.#session = session;
    this.initialMessages = initialMessages;
  }

  /** Open an existing conversation (resuming its context) or start a new one. */
  static async open(conversationId: string, fs: OpfsFs = new OpfsFs()): Promise<ConversationSession> {
    const repo = new JsonlSessionRepo({ fs: createSessionFs(fs), sessionsRoot: SESSIONS_DIR });
    // list() reads one header line per stored session — fine at conversation
    // scale, and it keeps us on the repo's public open-by-metadata contract.
    const existing = (await repo.list()).find((metadata) => metadata.id === conversationId);
    const session = existing ? await repo.open(existing) : await repo.create({ cwd: "/", id: conversationId });
    const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
    const context = buildSessionContext(entries);
    return new ConversationSession(conversationId, session, sanitizeDanglingToolCalls([...context.messages]));
  }

  /**
   * Persist one message. Failed assistant turns (stopReason error/aborted)
   * are skipped — they carry no context, and skipping them is what keeps
   * "died mid-turn" sessions loadable without further repair. Tool-result
   * images (capture screenshots) are replaced with a placeholder: base64
   * frames would balloon the JSONL, and a resumed turn re-captures anyway.
   */
  append(message: AgentMessage): void {
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) return;
    const persistable = durable(message.role === "toolResult" ? withoutImages(message) : message);
    this.#appendChain = this.#appendChain
      .then(() => this.#session.appendMessage(persistable))
      .then(() => undefined)
      .catch((cause: unknown) => {
        console.error(`[remixlet] session append failed (${this.id})`, cause);
      });
  }

  /**
   * A turn that failed (provider error, contract violation, runtime setup)
   * leaves no trace in the JSONL — its assistant message is skipped above and
   * the error only ever surfaces in the panel's chat. Record it as a custom
   * entry so the run log can show why a prompt has no reply. Custom entries
   * are omitted from model context, so this never reaches the provider.
   */
  recordRunError(message: string): void {
    this.#appendCustom("run_error", { message });
  }

  /** A user-initiated stop, recorded for the same reason as recordRunError. */
  recordRunAborted(): void {
    this.#appendCustom("run_aborted");
  }

  /**
   * The harness-authored failed-exit cleanup (rollback or needs-attention
   * park), recorded so the run log shows why the remixlet's state changed
   * after the model's closing message.
   */
  recordVerifyFailureCleanup(payload: { id: string; action: "rolled-back" | "needs-attention" }): void {
    this.#appendCustom("verify_failure_cleanup", payload);
  }

  /**
   * The runtime's turn-start auto-run of list_remixlets never passes through
   * pi (no model authored the call), so message_end persists nothing for it —
   * without this the run would be invisible to the run log. A custom entry,
   * never a message: custom entries are omitted from model context, whereas an
   * orphan toolResult is rejected by the provider on resume.
   */
  recordAutoInventory(payload: { ok: true; count: number } | { ok: false; error: string }): void {
    this.#appendCustom("auto_inventory", payload);
  }

  #appendCustom<T>(customType: string, data?: T): void {
    this.#appendChain = this.#appendChain
      .then(() => this.#session.appendCustomEntry(customType, data === undefined ? undefined : durable(data)))
      .then(() => undefined)
      .catch((cause: unknown) => {
        console.error(`[remixlet] session custom entry failed (${this.id})`, cause);
      });
  }

  /** Settles when every append issued so far has hit storage. */
  flush(): Promise<void> {
    return this.#appendChain;
  }

  /**
   * Whether this resumed conversation ended on an activation that was never
   * verified — the obligation the in-memory contract cannot carry across a
   * runtime death (session-tail.ts). The runtime re-arms verification from it,
   * and the panel drives a verify-or-fix continuation on resume. Computed from
   * the resolved context, so it reflects the conversation as reopened.
   */
  get pendingActivationVerification(): boolean {
    return endsWithUnverifiedActivation(this.initialMessages);
  }

  /** The remixlet the unverified tail activation wrote, when there is one. */
  get pendingActivationEntry(): { id: string; name: string } | undefined {
    return unverifiedActivationEntryAtEnd(this.initialMessages);
  }

  /** Whether a resumed activation specifically requires a corrective write. */
  get pendingObserverRepair(): boolean {
    return endsWithObserverRepairRequired(this.initialMessages);
  }

  get pendingObserverRepairIds(): string[] {
    return observerRepairIdsAtEnd(this.initialMessages);
  }

  /**
   * The resumed conversation, rendered for the panel's chat view. Tool steps
   * come from toolResult messages (every call has one after sanitization), so
   * a call never renders twice.
   */
  transcriptItems(): SessionTranscriptItem[] {
    const items: SessionTranscriptItem[] = [];
    for (const message of this.initialMessages) {
      if (message.role === "user") {
        const text = isTextContent(message.content) ? message.content : extractText(message.content);
        if (text.length > 0) items.push({ kind: "user", text });
      } else if (message.role === "assistant") {
        const text = extractText(message.content);
        if (text.length > 0) items.push({ kind: "assistant", text });
      } else if (message.role === "toolResult") {
        // Failed steps are classified from the stored result text so a resume
        // renders bounces/gate-rejections/declines the way the live chat did,
        // not as a wall of red "Couldn't …" rows.
        items.push({
          kind: "tool",
          toolName: message.toolName,
          ok: !message.isError,
          failure: message.isError ? classifyToolFailure(extractText(message.content)) : undefined,
        });
      }
    }
    return items;
  }
}

/**
 * pi's session refuses payloads that aren't durably JSON (undefined-valued
 * fields, non-plain objects — tool `details` routinely carry both). A JSON
 * round-trip is exactly the durability the store wants: undefined props drop,
 * exotic objects flatten, and what comes back is what a resume would read.
 */
function durable<T>(value: T): T {
  // SAFETY: JSON round-tripping preserves the JSON-compatible values accepted by pi's session storage.
  return JSON.parse(JSON.stringify(value)) as T;
}

function withoutImages(message: ToolResultMessage): ToolResultMessage {
  if (!message.content.some((block) => block.type === "image")) return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "image" ? { type: "text" as const, text: "(tool image omitted from saved history)" } : block,
    ),
  };
}

function extractText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isTextContent(content: string | ReadonlyArray<{ type: string }>): content is string {
  return Object.prototype.toString.call(content) === "[object String]";
}
