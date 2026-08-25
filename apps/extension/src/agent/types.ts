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
 * Provider endpoint description. `baseUrl` is always explicit — settings
 * (`remixletEndpoint`) can point any provider at a mock or proxy (wiki/handoff.md §3).
 * Only APIs proven browser-clean are admitted here; which API a given
 * provider/model pair speaks is the catalog's call (provider-catalog.ts
 * `endpointPlan`), not the panel's.
 *
 * `provider` is the catalog kind — it labels persisted assistant messages and
 * run-log rows, and keys catalog metadata lookups in toModel().
 *
 * Codex: auth is a callback, not a stored key — access tokens expire and
 * rotate, so the provider fetches a fresh one from the worker per model call
 * (the worker refreshes single-flight behind it).
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
    };

export interface AgentRuntimeConfig {
  systemPrompt: string;
  endpoint: ProviderEndpoint;
  tools: AgentToolSpec<never>[];
  /** Provider retry cap. Tests use 0; product default lives in the runtime. */
  maxRetries?: number;
  /**
   * Response-length hint for endpoints that take one per request (today only
   * the ChatGPT-subscription backend; other APIs ignore it). Derived from the
   * chat verbosity preference — see shared/chat-preferences.ts.
   */
  textVerbosity?: "low" | "medium" | "high";
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
      /** A pre-activation safety review sent the write back (tool-errors.ts). */
      gateRejected?: boolean;
      /** The user declined the approval this step asked for. */
      declined?: boolean;
      details?: unknown;
    }
  | { kind: "turn_end" };

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
