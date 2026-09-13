// AgentRuntime: the seam between Remixlet product code and the embedded agent
// implementation (wiki/handoff.md §3). Product code — panel UI, tool implementations,
// session plumbing — depends only on these types. The pi embedding lives
// behind createAgentRuntime(); nothing outside src/agent/ imports pi.

import type { TSchema } from "typebox";

/** A tool the agent can call. Parameters are a typebox schema (JSON Schema). */
export interface AgentToolSpec<TParams = unknown> {
  name: string;
  /** Human-readable label for UI display. */
  label: string;
  description: string;
  parameters: TSchema;
  /**
   * Scheduling within a multi-call assistant message. pi runs a message's tool
   * calls concurrently unless some call in the batch is sequential-mode (then
   * the WHOLE batch executes in message order). Order-dependent verification
   * tools (a batched click → assert → click → assert cycle) must not race, so
   * they declare "sequential"; read-only probes stay unmarked so their batches
   * keep running concurrently. String literals, not pi's type — this file is
   * the pi-free seam.
   */
  executionMode?: "sequential" | "parallel";
  /** Throw on failure — the runtime reports it to the model as a tool error. */
  execute(params: TParams, signal?: AbortSignal): Promise<AgentToolOutput>;
}

export interface AgentToolOutput {
  /** Text returned to the model. */
  text: string;
  /**
   * Images returned to the model alongside the text (raw base64, no data:
   * prefix). Attached unconditionally — for a non-vision model (endpoint
   * without `vision`) pi replaces them with a text placeholder, so no tool
   * needs to know what the model can see.
   */
  images?: { data: string; mimeType: string }[];
  /** Origin label used by the runtime contract; page-derived output is never trusted as authority. */
  provenance?: "untrusted-page";
  /** Structured details for logs / UI rendering (not sent to the model). */
  details?: unknown;
}

/**
 * Reasoning depth for models that take one, in pi's provider-neutral
 * vocabulary — each pi API adapter translates it to that provider's own dial
 * (effort string, token budget). Which levels a given model accepts is model
 * metadata, not this union: the Codex manifest names them per model, and the
 * pi catalog's `reasoning` flag gates the rest. Absent means "send nothing"
 * and the backend applies its own default.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

/**
 * Provider endpoint description. `baseUrl` is always explicit. API-key
 * provider settings can point at a mock or proxy; normalized Codex settings
 * always use the official ChatGPT backend (wiki/handoff.md §3).
 * Only APIs proven browser-clean are admitted here; which API a given
 * provider/model pair speaks is the catalog's call (provider-catalog.ts
 * `endpointPlan`), not the panel's.
 *
 * `provider` is the catalog kind — it labels persisted assistant messages and
 * run-log rows, and keys catalog metadata lookups in toModel().
 *
 * Codex: auth is a callback, not a stored key — access tokens expire and
 * rotate, so the provider fetches a fresh one from the worker per model call
 * (the worker refreshes single-flight behind it). `thinkingLevels` is the
 * model's manifest-declared reasoning dial (already intersected with
 * THINKING_LEVELS at discovery); toModel() turns it into the pi
 * thinkingLevelMap that marks everything else unsupported.
 */
export type ProviderEndpoint =
  | {
      api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
      provider: string;
      baseUrl: string;
      modelId: string;
      apiKey: string;
      vision?: boolean;
    }
  | {
      api: "openai-codex-responses";
      baseUrl: string;
      modelId: string;
      getAccessToken: () => Promise<string>;
      vision?: boolean;
      thinkingLevels?: readonly ThinkingLevel[];
    };

export interface AgentRuntimeConfig {
  systemPrompt: string;
  endpoint: ProviderEndpoint;
  tools: AgentToolSpec<never>[];
  /**
   * Budgets for one model call (src/agent/model-call.ts owns them; defaults
   * MODEL_CONNECT_MS, MODEL_STALL_MS, MODEL_ATTEMPTS, MODEL_RETRY_DELAYS_MS).
   * A request whose headers never arrive, or a stream that goes quiet, used to
   * wait until the user pressed Stop (the 2026-09-05 soundcloud run). Now each
   * attempt has a connect budget (request issued → response headers) and a
   * silence budget (longest gap between stream events); an attempt that
   * overruns either, or fails in a way that looks transient, is retried after
   * a short delay with the same context, and the turn rejects as a
   * ProviderTurnError only once every attempt is spent. Tests shorten them.
   */
  modelConnectMs?: number;
  modelStallMs?: number;
  modelAttempts?: number;
  /** Delay before attempt 2, 3, …; the last entry repeats. */
  modelRetryDelaysMs?: readonly number[];
  /**
   * Response-length hint for endpoints that take one per request (today only
   * the ChatGPT-subscription backend; other APIs ignore it). Derived from the
   * chat verbosity preference — see shared/chat-preferences.ts.
   */
  textVerbosity?: "low" | "medium" | "high";
  /**
   * Reasoning depth for the whole conversation, from the per-model setting
   * (shared/settings.ts). Omitted ⇒ nothing is sent and the backend applies
   * its own default — reasoning models spend real seconds here, so an
   * explicit level is the main latency dial (wiki/design/agent-latency.md).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Persist and resume this conversation (JSONL on OPFS). Open one with
   * ConversationSession.open(id); omit for an ephemeral runtime. Opaque to
   * product code — its innards are pi types.
   */
  session?: import("./conversation-session.js").ConversationSession;
}

/**
 * Per-turn options for AgentRuntime.prompt. `grantedCapabilities` is the
 * out-of-band authority channel: the capability names the user's panel click
 * granted and a build has not yet spent — the panel threads them into every
 * turn until a successful write consumes them, so an interruption between the
 * click and the build cannot strand the grant. The contract's write gate
 * checks manifest capabilities against this set — prompt TEXT never carries authority,
 * so counterfeit "the user authorized X" prose (typed, model-authored, or
 * injected via history) grants nothing.
 */
export interface AgentPromptOptions {
  grantedCapabilities?: readonly string[];
  /**
   * True while the conversation holds the development-time observation grant
   * (the dev-observe card's click; wiki/raw/handoffs/
   * 2026-08-10-broad-observe-session-grant.md). Out-of-band like
   * grantedCapabilities: paired with the DEV_OBSERVE_GRANT_MARKER prefix it
   * marks the click's own continuation turn (which keeps the pre-grant turn's
   * contract state); a forged marker without it is an ordinary turn. It
   * carries no read authority itself — the worker gates the probe on the
   * stored grant.
   */
  devObserveGranted?: boolean;
}

/**
 * Runtime lifecycle events, in emission order within a prompt() call — with
 * one exception: the runtime's turn-start auto-inventory (a synthetic
 * list_remixlets run with an "auto-inventory-" toolCallId) emits its
 * tool_start/tool_end pair before turn_start, because it runs before the
 * model is prompted.
 */
export type AgentRuntimeEvent =
  | { kind: "turn_start" }
  | { kind: "turn_aborted" }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_message"; text: string }
  // The model's working notes (reasoning-summary / thinking stream). Emitted
  // for every reasoning model regardless of settings — whether to SHOW them is
  // the panel's call (chat verbosity). Never part of the transcript.
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  // `bounced` marks a failed call the contract stopped before the tool ran (an
  // ordering violation) — the step was withheld pending prerequisites, not
  // attempted and failed, and the panel renders those differently.
  | {
      kind: "tool_end";
      toolCallId: string;
      toolName: string;
      ok: boolean;
      bounced?: boolean;
      /**
       * A bounced call's own text (the contract's message). The chat phrases
       * it in plain words (panel/chat-phrases.tsx bouncePhrase) and never
       * shows it raw.
       */
      reason?: string;
      /** A pre-activation safety review sent the write back (tool-errors.ts). */
      gateRejected?: boolean;
      /** The user declined the approval this step asked for. */
      declined?: boolean;
      details?: unknown;
    }
  | ModelWaitEvent
  | { kind: "turn_end" };

/**
 * Progress of one model call, so the panel can show the wait instead of a
 * silent spinner. Emitted when the request is issued (`connecting`), when
 * response headers arrive (`streaming`), about once a second while either
 * phase lasts, when an attempt is given up and the next one is about to start
 * (`retrying`, with the plain-words reason), and once when the call settles
 * (`done`: answered, failed for good, or stopped by the user). `elapsedMs`
 * counts from the first attempt; `silenceMs` is how long the current attempt
 * has heard nothing from the model.
 */
export interface ModelWaitEvent {
  kind: "model_wait";
  phase: "connecting" | "streaming" | "retrying" | "done";
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  silenceMs: number;
  reason?: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

/**
 * A turn that failed because the provider's answer did (network failure, HTTP
 * error, stream cut short) — as opposed to a contract violation or a setup
 * problem. The panel uses the distinction to record provider health: only
 * these failures may mark a provider as needing attention.
 */
export class ProviderTurnError extends Error {}

export interface AgentRuntime {
  /**
   * Run one full agent turn (assistant response + tool calls + follow-ups)
   * to completion. Rejects on provider/stream/contract failure — the
   * rejection is the runtime's ONLY failure report (events never carry
   * errors), so the caller renders it exactly once. A rejected prompt
   * leaves the runtime reusable.
   */
  prompt(text: string, options?: AgentPromptOptions): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void;
  /**
   * Abort the in-flight turn, if any. A user abort settles the current
   * prompt normally and emits `turn_aborted`; it is not a provider error.
   */
  abort(): void;
  /** Flat text transcript (for UI; full session persistence lands at M2). */
  transcript(): TranscriptEntry[];
}
