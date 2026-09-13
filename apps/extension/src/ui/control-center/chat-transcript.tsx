// A stored conversation rendered the way the sidebar showed it: the same
// bubble classes (`msg <kind>`, styles.css), the same plain-English tool
// phrases, the same markdown renderer — chat-phrases.ts is the single source
// of that presentation. Built from the same log entries as the run-log tab,
// so the two tabs are two views of one read.

import { Response } from "@/components/ui/response";

import type { ConversationLogEntry } from "../../agent/conversation-log.js";
import { classifyToolFailure } from "../../agent/tool-errors.js";
import {
  describeTool,
  MessageBody,
  runErrorDisplayText,
  settledToolMessage,
  transcriptMessage,
  type TranscriptMessage,
} from "../../panel/chat-phrases.js";

// How one log entry rendered in the sidebar; undefined for the bookkeeping
// lines chat never showed. Tool rows come from tool_result entries — the same
// source transcriptItems() uses on resume — but keep their details, so settled
// phrases read as they did live ("Confirmed the remixlet worked"), not as the
// generic resume wording.
function messageFor(entry: ConversationLogEntry): TranscriptMessage | undefined {
  switch (entry.kind) {
    case "user":
      return entry.text.length > 0 ? transcriptMessage({ kind: "user", text: entry.text }) : undefined;
    case "assistant":
      return entry.text.length > 0 ? transcriptMessage({ kind: "assistant", text: entry.text }) : undefined;
    case "tool_result": {
      // Same settling logic as the live chat; failed steps are classified
      // from the recorded result text, so bounces keep their plain-words
      // held rows and gate rejections/declines their calm rows on replay too.
      const phrase = describeTool(entry.toolName, undefined);
      const failure = entry.ok ? undefined : classifyToolFailure(entry.text);
      return settledToolMessage(entry.toolName, phrase, {
        ok: entry.ok,
        bounced: failure === "bounced",
        reason: failure === "bounced" ? entry.text : undefined,
        gateRejected: failure === "gate",
        declined: failure === "declined",
        details: entry.details,
      });
    }
    // The two custom entries recorded for turns that never persisted an
    // assistant message, shown as the sidebar showed them live. Stored run
    // errors carry the raw message (the run-log tab is its diagnostic home);
    // chat renders contract text as the plain unfinished-turn words.
    case "run_error":
      return { kind: "error", text: runErrorDisplayText(entry.message) };
    case "run_aborted":
      return { kind: "tool", text: "■ Stopped" };
    default:
      return undefined;
  }
}

export function ChatTranscript({ entries }: { entries: ConversationLogEntry[] }) {
  const messages = entries.map(messageFor).filter((message): message is TranscriptMessage => message !== undefined);
  if (messages.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Nothing to show — this chat has no messages.</p>;
  }
  // Consecutive tool rows collapse into one tight activity group (the
  // chat-detail handoff's 7px column) so the transcript's 14px rhythm stays
  // between exchanges, not between every step of a burst of tool calls.
  const blocks: TranscriptMessage[][] = [];
  for (const message of messages) {
    const last = blocks[blocks.length - 1];
    if (message.kind === "tool" && last?.[0]?.kind === "tool") last.push(message);
    else blocks.push([message]);
  }
  return (
    // The `msg <kind>` class vocabulary is the panel's; this page's bubble
    // geometry comes from the #chat-transcript overrides in styles.css.
    <div id="chat-transcript" className="flex max-w-[620px] flex-col gap-3.5 pt-2 pb-6">
      {blocks.map((block, blockIndex) =>
        block[0]?.kind === "tool" ? (
          <div key={blockIndex} className="flex flex-col gap-[7px] px-1">
            {block.map((message, index) => (
              <div key={index} className="msg tool">
                <MessageBody message={message} />
              </div>
            ))}
          </div>
        ) : (
          block.map((message, index) => (
            <div key={`${blockIndex}-${index}`} className={`msg ${message.kind}`}>
              {message.kind === "assistant" ? <Response>{message.text}</Response> : <MessageBody message={message} />}
            </div>
          ))
        ),
      )}
    </div>
  );
}
