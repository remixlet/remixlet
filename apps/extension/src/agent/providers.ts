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

import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGoogleGenerativeAI } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { catalogModel, endpointPlan, type ProviderKind } from "./provider-catalog.js";
import { THINKING_LEVELS, type ProviderEndpoint, type ThinkingLevel } from "./types.js";

/**
 * The thinking levels one model genuinely accepts — what the panel's dial may
 * offer. Codex models bring their manifest-declared list (with a safe floor
 * when a manifest predates the field); everything else follows the pi
 * catalog's `reasoning` flag, with pi's own default level set. An empty
 * result means the model takes no reasoning dial and the panel hides it.
 */
export function supportedThinkingLevels(
  kind: ProviderKind,
  modelId: string,
  declared?: readonly ThinkingLevel[],
): readonly ThinkingLevel[] {
  const plan = endpointPlan(kind, modelId);
  if (plan.api === "openai-codex-responses") {
    return declared && declared.length > 0 ? declared : ["low", "medium", "high"];
  }
  const known = catalogModel(kind, modelId);
  const reasoning = known ? known.reasoning : plan.api === "anthropic-messages" || plan.api === "google-generative-ai";
  // Mirrors pi's getSupportedThinkingLevels for a map-less model: xhigh/max
  // need an explicit per-model mapping, which the pi-free catalog cannot carry.
  return reasoning ? ["minimal", "low", "medium", "high"] : [];
}

/**
 * pi semantics: a level mapping to null is unsupported; xhigh/max count as
 * supported only when mapped. Identity-mapping the declared levels and
 * null-ing the rest makes pi's clamp and request builder agree exactly with
 * the manifest.
 */
function codexThinkingLevelMap(levels: readonly ThinkingLevel[]): ThinkingLevelMap {
  return Object.fromEntries(THINKING_LEVELS.map((level) => [level, levels.includes(level) ? level : null]));
}

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
    case "openai-codex-responses": {
      // Codex models are reasoning models with large contexts; these bounds
      // are conservative and only steer pi's budgeting, not the backend. The
      // manifest-declared levels become the thinkingLevelMap so pi never
      // sends this model an effort it does not take.
      const model: Model<"openai-codex-responses"> = {
        ...base,
        api: endpoint.api,
        reasoning: true,
        contextWindow: 272000,
        maxTokens: 32000,
      };
      if (endpoint.thinkingLevels && endpoint.thinkingLevels.length > 0) {
        model.thinkingLevelMap = codexThinkingLevelMap(endpoint.thinkingLevels);
      }
      return model;
    }
  }
}

/**
 * Retries and timeouts are NOT set here: the runtime's model-call wrapper
 * (model-call.ts) owns both and passes `maxRetries: 0` in the options each
 * branch spreads, so the adapters never run their own silent retry loop.
 */
export function resolveStreamFn(endpoint: ProviderEndpoint, opts: { textVerbosity?: "low" | "medium" | "high" }): StreamFn {
  switch (endpoint.api) {
    case "openai-completions":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamOpenAICompletions(model as Model<"openai-completions">, context, {
          ...options,
          apiKey: endpoint.apiKey,
        });
    case "openai-responses":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamOpenAIResponses(model as Model<"openai-responses">, context, {
          ...options,
          apiKey: endpoint.apiKey,
        });
    case "anthropic-messages":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamAnthropicMessages(model as Model<"anthropic-messages">, context, {
          ...options,
          apiKey: endpoint.apiKey,
        });
    case "google-generative-ai":
      return (model, context, options) =>
        // SAFETY: endpoint.api selects this stream branch, so pi supplied this model for the matching API.
        streamGoogleGenerativeAI(model as Model<"google-generative-ai">, context, {
          ...options,
          apiKey: endpoint.apiKey,
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
      // mapping streamSimple applies, plus its reasoning→reasoningEffort
      // step, re-done here without pi's clamp helper (only pi-ai's root
      // entry exports it, and that entry is not browser-clean). The model's
      // thinkingLevelMap makes the request builder equivalent: declared
      // levels pass through by identity, anything else maps to null and the
      // builder sends no reasoning at all — a stale stored level degrades to
      // the backend default instead of a guessed neighbour.
      const sessionId = crypto.randomUUID();
      return async (model, context, options) => {
        // SAFETY: endpoint.api selects this branch, so pi supplied this model for the Codex Responses API.
        const codexModel = model as Model<"openai-codex-responses">;
        // pi's Agent already turned thinkingLevel "off" into undefined, and
        // the request builder treats undefined as "send no reasoning". The
        // null check re-applies the map's unsupported marker ourselves: the
        // raw builder coalesces null back to the requested effort, so without
        // it a stale stored level would reach the wire. Degrading to "send
        // nothing" (backend default) is deliberate — never a guessed neighbour.
        const reasoning = options?.reasoning;
        return streamCodexResponses(codexModel, context, {
          ...buildBaseOptions(codexModel, context, options, await endpoint.getAccessToken()),
          transport: "sse",
          sessionId,
          textVerbosity: opts.textVerbosity,
          reasoningEffort:
            reasoning !== undefined && codexModel.thinkingLevelMap?.[reasoning] !== null ? reasoning : undefined,
        });
      };
    }
  }
}
