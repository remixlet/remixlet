// The pi-backed AgentRuntime implementation. One of the three modules (with
// providers.ts and model-call.ts) that import pi types — everything else sees
// src/agent/types.
// Version pinned deliberately; upgrades re-run the agent suite as the
// compatibility check (wiki/design/spike-a-pi-browser.md).

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  ProviderTurnError,
  type AgentPromptOptions,
  type AgentRuntime,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type AgentToolOutput,
  type AgentToolSpec,
  type TranscriptEntry,
} from "./types.js";
import {
  AgentContract,
  CAPABILITY_GRANT_MARKER,
  ContractViolationError,
  DEV_OBSERVE_GRANT_MARKER,
  contractNudgePrompt,
  type ToolCallInput,
} from "./contracts.js";
import { resolveStreamFn, toModel } from "./providers.js";
import {
  MODEL_ATTEMPTS,
  MODEL_CONNECT_MS,
  MODEL_RETRY_DELAYS_MS,
  MODEL_STALL_MS,
  withModelCallRetries,
} from "./model-call.js";
import { SafetyGateError, UserDeclinedError } from "./tool-errors.js";

export { MODEL_ATTEMPTS, MODEL_CONNECT_MS, MODEL_RETRY_DELAYS_MS, MODEL_STALL_MS } from "./model-call.js";

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const emit = (event: AgentRuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };

  // Every model call pi issues goes through the bounded, retrying wrapper
  // (model-call.ts): per-attempt connect and silence budgets, a few attempts
  // with short delays, progress reported as model_wait events. pi sees one
  // stream per call; a failed attempt never reaches it or the session log.
  const streamFn = withModelCallRetries(
    resolveStreamFn(config.endpoint, { textVerbosity: config.textVerbosity }),
    {
      connectMs: config.modelConnectMs ?? MODEL_CONNECT_MS,
      stallMs: config.modelStallMs ?? MODEL_STALL_MS,
      attempts: config.modelAttempts ?? MODEL_ATTEMPTS,
      retryDelaysMs: config.modelRetryDelaysMs ?? MODEL_RETRY_DELAYS_MS,
    },
    emit,
  );
  // A conversation resumed on top of an unverified activation (its verifying
  // turn died with the runtime — see session-tail.ts) re-arms the verification
  // obligation on the first turn, so the resumed conversation cannot treat the
  // stale activation as finished.
  const contract = new AgentContract({
    resumedUnverifiedActivation: config.session?.pendingActivationVerification ?? false,
    resumedObserverRepair: config.session?.pendingObserverRepair ?? false,
    resumedObserverRepairIds: config.session?.pendingObserverRepairIds ?? [],
  });
  // Tool calls the contract bounced (ordering violations — the tool never
  // ran), keyed by toolCallId with the contract's own message. pi reports
  // them as plain error results, so this is the side channel that lets
  // tool_end carry the distinction and the reason the chat phrases.
  const bouncedToolCalls = new Map<string, string>();
  // The other two not-a-breakage failure classes (tool-errors.ts), same side
  // channel: safety-gate rejections and user declines each get their own
  // tool_end flag so the chat can render them honestly instead of as failures.
  const gateRejectedToolCalls = new Set<string>();
  const declinedToolCalls = new Set<string>();
  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: toModel(config.endpoint),
      tools: config.tools.map((tool) => toPiTool(tool, contract, bouncedToolCalls, gateRejectedToolCalls, declinedToolCalls)),
      // Resuming: the session's sanitized context becomes the live history,
      // so transcript() (and the model) see the prior conversation.
      messages: config.session ? [...config.session.initialMessages] : [],
      // Reasoning depth rides pi's own channel: the Agent forwards any level
      // other than "off" to the stream as options.reasoning, and each API
      // adapter translates it. Unset (undefined) falls back to pi's "off" —
      // nothing is sent and the backend keeps its default.
      thinkingLevel: config.thinkingLevel,
    },
    streamFn,
  });

  // Persistence: every settled message (user prompt, assistant, tool result)
  // flows through message_end exactly once — append in that order.
  if (config.session) {
    const session = config.session;
    agent.subscribe((event) => {
      if (event.type === "message_end") session.append(event.message);
    });
  }

  let turnError: string | undefined;
  // Provider stops (stopReason "error": the endpoint failed to answer) reject
  // as ProviderTurnError so the panel can record provider health; contract
  // violations reject as plain Error — the provider answered fine.
  let turnErrorFromProvider = false;
  let turnAborted = false;
  // Covers the abort window the auto-inventory opens: agent.abort() is a no-op
  // until pi has an active run, and the panel re-checks its stop flag only
  // after prompt() resolves — so a Stop click during the auto-run's await
  // would otherwise be swallowed.
  let abortRequested = false;
  // Namespaced, monotonic ids so a synthetic call can never collide with a
  // model-authored toolCallId.
  let autoInventoryCount = 0;

  // Turn-start auto-inventory: list_remixlets is a pure storage read whose
  // per-turn freshness the write gate requires, and a forgotten re-run after a
  // user-turn boundary costs a full write_remixlet regeneration
  // (wiki/raw/handoffs/2026-08-10-pre-write-contract-preflight.md). The loop
  // satisfies the gate itself — a genuine tool success recorded through the
  // contract — instead of spending a model round trip on a statically
  // decidable step. Tool events go through the normal emit path so the
  // activity feed and run log stay truthful about what ran.
  async function runAutoInventory(): Promise<void> {
    const listSpec = config.tools.find((tool) => tool.name === "list_remixlets");
    if (!listSpec) return;
    autoInventoryCount += 1;
    const toolCallId = `auto-inventory-${autoInventoryCount}`;
    emit({ kind: "tool_start", toolCallId, toolName: listSpec.name, args: {} });
    try {
      const output = await contract.execute(listSpec, {}, undefined);
      emit({ kind: "tool_end", toolCallId, toolName: listSpec.name, ok: true, bounced: false, details: output.details });
      config.session?.recordAutoInventory({ ok: true, count: Array.isArray(output.details) ? output.details.length : 0 });
    } catch (error) {
      // Degrade to the status-quo cost — the model must call list_remixlets
      // itself. A storage hiccup at turn start never fails the turn.
      emit({ kind: "tool_end", toolCallId, toolName: listSpec.name, ok: false, bounced: false });
      config.session?.recordAutoInventory({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // One completion recovery per turn: when the model settles with text while
  // an obligation is unmet (unverified activation), a follow-up message feeds
  // the obligation back and the loop continues. A second unmet settle fails
  // the turn as before — the nudge is a bounded second chance, not a loop.
  let completionNudged = false;
  agent.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        emit({ kind: "turn_start" });
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta" && contract.allowsAssistantOutput) {
          emit({ kind: "assistant_delta", text: event.assistantMessageEvent.delta });
        }
        // Working notes stream under the same completion gate as text: they
        // are narration, and narration while an obligation is unmet is the
        // "sounds finished but isn't" surface the gate exists to close.
        if (event.assistantMessageEvent.type === "thinking_delta" && contract.allowsAssistantOutput) {
          emit({ kind: "thinking_delta", text: event.assistantMessageEvent.delta });
        }
        break;
      case "message_end": {
        const message = event.message;
        if (message.role === "assistant") {
          if (message.stopReason === "aborted") {
            // pi records its synthetic aborted assistant message before
            // notifying subscribers. It contains no useful context and the
            // session deliberately skips it, so remove it from the live
            // runtime too. This keeps the runtime reusable after Stop. (Only
            // the user's Stop gets here: the wrapper's own per-attempt aborts
            // never reach pi — model-call.ts.)
            agent.state.messages = agent.state.messages.filter((candidate) => candidate !== message);
            turnAborted = true;
            emit({ kind: "turn_aborted" });
          } else if (message.stopReason === "error") {
            // Captured here, reported once: prompt() rejects with it below.
            // A call the wrapper gave up on arrives with its counted-attempts
            // text already composed (model-call.ts).
            turnError = message.errorMessage ?? `assistant stopped: ${message.stopReason}`;
            turnErrorFromProvider = true;
          } else {
            // A tool-calling assistant message is an intermediate step, not a
            // completion claim. Validate only a settled text response — but
            // still finalize any narration it streamed, so the panel closes
            // that bubble and the next message renders as its own.
            if (message.content.some((block) => block.type === "toolCall")) {
              const narration = extractText(message.content);
              if (narration.length > 0 && contract.allowsAssistantOutput) {
                emit({ kind: "assistant_message", text: narration });
              }
              break;
            }
            try {
              contract.assertCanComplete();
            } catch (error) {
              const violation = error instanceof Error ? error.message : String(error);
              if (!completionNudged) {
                completionNudged = true;
                agent.followUp({
                  role: "user",
                  content: [{ type: "text", text: contractNudgePrompt(violation) }],
                  timestamp: Date.now(),
                });
                break;
              }
              turnError = violation;
              break;
            }
            const text = extractText(message.content);
            if (text.length > 0) emit({ kind: "assistant_message", text });
          }
        }
        break;
      }
      case "tool_execution_start":
        emit({ kind: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_end": {
        const bounceReason = bouncedToolCalls.get(event.toolCallId);
        bouncedToolCalls.delete(event.toolCallId);
        emit({
          kind: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: !event.isError,
          bounced: bounceReason !== undefined,
          reason: bounceReason,
          gateRejected: gateRejectedToolCalls.delete(event.toolCallId),
          declined: declinedToolCalls.delete(event.toolCallId),
          details: event.result?.details,
        });
        break;
      }
      case "turn_end":
        emit({ kind: "turn_end" });
        break;
    }
  });

  return {
    async prompt(text: string, options?: AgentPromptOptions): Promise<void> {
      turnError = undefined;
      turnErrorFromProvider = false;
      turnAborted = false;
      abortRequested = false;
      completionNudged = false;
      bouncedToolCalls.clear();
      gateRejectedToolCalls.clear();
      declinedToolCalls.clear();
      // The click's own continuation turn (grant prompt + out-of-band grant)
      // keeps the pre-grant turn's contract state; a later turn that still
      // carries the unspent grant is an ordinary turn with extra authority.
      // Both parts are required — the marker text alone is forgeable and
      // carries nothing.
      const grantContinuation =
        ((options?.grantedCapabilities?.length ?? 0) > 0 && text.startsWith(CAPABILITY_GRANT_MARKER)) ||
        (options?.devObserveGranted === true && text.startsWith(DEV_OBSERVE_GRANT_MARKER));
      contract.beginTurn(options?.grantedCapabilities, grantContinuation);
      // Grant continuations carry #lastList across beginTurn, so the auto-run
      // would be redundant there.
      if (!grantContinuation) {
        await runAutoInventory();
        if (abortRequested) {
          emit({ kind: "turn_aborted" });
          return;
        }
      }
      await agent.prompt(text);
      if (turnAborted) return;
      if (turnError !== undefined) {
        throw turnErrorFromProvider ? new ProviderTurnError(turnError) : new Error(turnError);
      }
      contract.assertCanComplete();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      abortRequested = true;
      agent.abort();
    },
    transcript(): TranscriptEntry[] {
      const entries: TranscriptEntry[] = [];
      for (const message of agent.state.messages) {
        if (message.role === "user") {
          const text = Array.isArray(message.content) ? extractText(message.content) : message.content;
          if (text.length > 0) entries.push({ role: "user", text });
        } else if (message.role === "assistant") {
          const text = extractText(message.content);
          if (text.length > 0) entries.push({ role: "assistant", text });
        }
      }
      return entries;
    },
  };
}

function extractText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function toPiTool(
  spec: AgentToolSpec<never>,
  contract: AgentContract,
  bouncedToolCalls: Map<string, string>,
  gateRejectedToolCalls: Set<string>,
  declinedToolCalls: Set<string>,
): AgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: spec.executionMode,
    async execute(toolCallId, params, signal) {
      let output: AgentToolOutput;
      try {
        // SAFETY: pi invokes tools only after validating params against the registered TypeBox schema.
        output = await contract.execute(spec, params as ToolCallInput, signal);
      } catch (error) {
        if (error instanceof ContractViolationError) bouncedToolCalls.set(toolCallId, error.message);
        else if (error instanceof SafetyGateError) gateRejectedToolCalls.add(toolCallId);
        else if (error instanceof UserDeclinedError) declinedToolCalls.add(toolCallId);
        throw error;
      }
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: output.text },
      ];
      for (const image of output.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      return { content, details: output.details };
    },
  };
}
