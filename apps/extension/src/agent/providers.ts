// Stream wiring: our own small map of APIs proven browser-clean, imported
// per-module — never pi-ai's /compat entry, which statically pulls
// Node-entangled SDKs into the graph (wiki/design/spike-a-pi-browser.md §2).
// WHICH providers and models exist comes from pi via provider-catalog.ts;
// this module only turns an endpoint into a pi Model + stream function.
//
// openai-codex-responses (the ChatGPT-subscription backend, wiki/handoff.md §6.1) is
// browser-clean by upstream design: its only Node touchpoints (os for the
// user-agent string, zlib for zstd request compression) are runtime-guarded
// `process.getBuiltinModule` lookups with browser fallbacks — verified against
// pi-ai 0.81.1 and re-checked at 0.84.2; the spike-a §5 "inspect first"
// question is settled as use-upstream, no shim, no fork.

import type { Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { catalogModel } from "./provider-catalog.js";
import type { ProviderEndpoint } from "./types.js";

export function toModel(endpoint: ProviderEndpoint): Model<ProviderEndpoint["api"]> {
  // pi's catalog knows real context windows, output caps, reasoning support,
  // and prices for the models it lists; endpoints pointing at models pi has
  // never heard of (local servers, proxies, brand-new releases) fall back to
  // the conservative per-API defaults below.
  const known = endpoint.api === "openai-codex-responses" ? undefined : catalogModel(endpoint.provider, endpoint.modelId);
  const base = {
    id: endpoint.modelId,
    name: endpoint.modelId,
    provider: endpoint.api === "openai-codex-responses" ? "openai-codex" : endpoint.provider,
    baseUrl: endpoint.baseUrl,
    // pi keys image handling on this list: for text-only models it swaps any
    // attached image blocks for a "(tool image omitted…)" placeholder, so
    // tools may always attach and nothing hard-requires vision.
    input: endpoint.vision ? ["text" as const, "image" as const] : ["text" as const],
    cost: known ? { ...known.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (known) {
    return { ...base, api: endpoint.api, reasoning: known.reasoning, contextWindow: known.contextWindow, maxTokens: known.maxTokens };
  }
  switch (endpoint.api) {
    case "openai-completions":
    case "openai-responses":
      return { ...base, api: endpoint.api, reasoning: false, contextWindow: 128000, maxTokens: 8192 };
    case "anthropic-messages":
      return { ...base, api: endpoint.api, reasoning: true, contextWindow: 200000, maxTokens: 8192 };
    case "google-generative-ai":
      return { ...base, api: endpoint.api, reasoning: true, contextWindow: 1_000_000, maxTokens: 8192 };
    case "openai-codex-responses":
      // Codex models are reasoning models with large contexts; these bounds
      // are conservative and only steer pi's budgeting, not the backend.
      return { ...base, api: endpoint.api, reasoning: true, contextWindow: 272000, maxTokens: 32000 };
  }
}

export function resolveStreamFn(
  endpoint: ProviderEndpoint,
  opts: { maxRetries: number; textVerbosity?: "low" | "medium" | "high" },
): StreamFn {
  switch (endpoint.api) {
    case "openai-completions":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamOpenAICompletions(model as Model<"openai-completions">, context, {
          ...options,
          apiKey: endpoint.apiKey,
          maxRetries: opts.maxRetries,
        });
    case "openai-responses":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamOpenAIResponses(model as Model<"openai-responses">, context, {
          ...options,
          apiKey: endpoint.apiKey,
          maxRetries: opts.maxRetries,
        });
    case "anthropic-messages":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamAnthropicMessages(model as Model<"anthropic-messages">, context, {
          ...options,
          apiKey: endpoint.apiKey,
          maxRetries: opts.maxRetries,
        });
    case "google-generative-ai":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamGoogleGenerativeAI(model as Model<"google-generative-ai">, context, {
          ...options,
          apiKey: endpoint.apiKey,
          maxRetries: opts.maxRetries,
        });
    case "openai-codex-responses": {
      // One session id per runtime — the backend keys server-side state
      // (and our mock's assertions) on it. SSE transport: the fetch +
      // ReadableStream path is the one the panel's CSP and the mock provider
      // exercise; the websocket transport stays off.
      //
      // This branch calls the full stream fn, not streamSimple: streamSimple
      // forwards only the base option set, which drops textVerbosity — the
      // one knob that lifts this backend's request-level default of "low"
      // (near-silence between tool calls). buildBaseOptions is the same
      // mapping streamSimple applies; its reasoning→reasoningEffort step is
      // omitted because this runtime never sets a thinking level (Agent
      // state stays at "off", so options.reasoning is always undefined).
      const sessionId = crypto.randomUUID();
      return async (model, context, options) => {
        // SAFETY: endpoint.api selects this branch, so pi supplied this model for the Codex Responses API.
        const codexModel = model as Model<"openai-codex-responses">;
        return streamCodexResponses(codexModel, context, {
          ...buildBaseOptions(codexModel, context, options, await endpoint.getAccessToken()),
          maxRetries: opts.maxRetries,
          transport: "sse",
          sessionId,
          textVerbosity: opts.textVerbosity,
        });
      };
    }
  }
}
