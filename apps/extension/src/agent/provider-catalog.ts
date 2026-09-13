// The provider catalog: which model providers Remixlet offers, sourced from
// pi instead of hand-maintained tables. pi's generated per-provider catalogs
// (`@earendil-works/pi-ai/providers/<id>.models`) are pure data — model ids,
// display names, the API each model speaks, endpoint base URLs, context
// windows, vision inputs, prices — verified browser-clean and ~29KB minified
// for the four providers here (spike-a addendum). Adding a provider is one
// catalog import plus one entry below, IF its models' API is one this
// extension already bundles (SUPPORTED_APIS); pi providers speaking other
// APIs (Bedrock, Mistral conversations…) are not admitted by this filter.
//
// This module lives in src/agent/ because it imports pi; everything it
// EXPORTS is pi-free plain data, so product code (settings, provider UI)
// may consume it without crossing the pi seam (see types.ts).

import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { CODEX_API_BASE_URL } from "../shared/codex-oauth.js";

/** The chat APIs this extension bundles stream implementations for (agent/providers.ts). */
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const satisfies readonly ProviderApi[];

/** One model as pi catalogs it, reduced to the pi-free facts Remixlet uses. */
export interface CatalogModel {
  id: string;
  name: string;
  api: ProviderApi;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  /** USD per million tokens, for the run log's cost accounting. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ProviderCatalogEntry {
  kind: ProviderKind;
  /** Short provider name — settings fallback label and key-prompt copy. */
  label: string;
  /** Card copy on the add-provider step. */
  title: string;
  description: string;
  access: "subscription" | "api-key";
  /** The "· API key" style qualifier next to a connected provider's name. */
  qualifier: string;
  baseUrl: string;
  /** Where to create an API key, when the provider has a console for that. */
  keyConsole?: { label: string; url: string };
  /** API for model ids pi's catalog doesn't know (typed in, or discovered). */
  defaultApi: ProviderApi | "openai-codex-responses";
  /** pi's catalog for this provider; empty for kinds pi cannot know (an
   *  arbitrary OpenAI-compatible endpoint, the ChatGPT subscription). */
  models: CatalogModel[];
}

/** Loose view of one pi catalog entry; the generated data is richer than this. */
interface PiCatalogModel {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type PiCatalog = Readonly<Record<string, PiCatalogModel>>;

function fromPi(catalog: PiCatalog): CatalogModel[] {
  return Object.values(catalog)
    .map((value) => value)
    .filter((model): model is PiCatalogModel & { api: ProviderApi } => isProviderApi(model.api))
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      vision: model.input.includes("image"),
      cost: { ...model.cost },
    }));
}

function isProviderApi(value: string): value is ProviderApi {
  return SUPPORTED_APIS.some((api) => api === value);
}

/** The provider's endpoint as pi records it on its models, with a fallback for safety. */
function baseUrlFrom(catalog: PiCatalog, fallback: string): string {
  const first = Object.values(catalog)[0];
  return first?.baseUrl ?? fallback;
}

export type ProviderKind = "remixlet" | "openai" | "anthropic" | "google" | "xai" | "codex";

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    kind: "codex",
    label: "ChatGPT",
    title: "ChatGPT",
    description: "Codex models included with a paid ChatGPT plan (Plus, Pro, Team…)",
    access: "subscription",
    qualifier: "subscription",
    baseUrl: CODEX_API_BASE_URL,
    defaultApi: "openai-codex-responses",
    models: [],
  },
  {
    kind: "openai",
    label: "OpenAI",
    title: "OpenAI",
    description: "GPT models, with an OpenAI API key",
    access: "api-key",
    qualifier: "API key",
    baseUrl: baseUrlFrom(OPENAI_MODELS, "https://api.openai.com/v1"),
    keyConsole: { label: "platform.openai.com", url: "https://platform.openai.com/api-keys" },
    defaultApi: "openai-responses",
    models: fromPi(OPENAI_MODELS),
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    title: "Anthropic",
    description: "Claude models, with an Anthropic API key",
    access: "api-key",
    qualifier: "API key",
    baseUrl: baseUrlFrom(ANTHROPIC_MODELS, "https://api.anthropic.com"),
    keyConsole: { label: "console.anthropic.com", url: "https://console.anthropic.com/settings/keys" },
    defaultApi: "anthropic-messages",
    models: fromPi(ANTHROPIC_MODELS),
  },
  {
    kind: "google",
    label: "Google",
    title: "Google",
    description: "Gemini models, with a Google AI API key",
    access: "api-key",
    qualifier: "API key",
    baseUrl: baseUrlFrom(GOOGLE_MODELS, "https://generativelanguage.googleapis.com/v1beta"),
    keyConsole: { label: "aistudio.google.com", url: "https://aistudio.google.com/apikey" },
    defaultApi: "google-generative-ai",
    models: fromPi(GOOGLE_MODELS),
  },
  {
    kind: "xai",
    label: "xAI",
    title: "xAI",
    description: "Grok models, with an xAI API key",
    access: "api-key",
    qualifier: "API key",
    baseUrl: baseUrlFrom(XAI_MODELS, "https://api.x.ai/v1"),
    keyConsole: { label: "console.x.ai", url: "https://console.x.ai" },
    // xAI's documented OpenAI-compatible surface; catalog models that speak
    // openai-responses carry that api on themselves.
    defaultApi: "openai-completions",
    models: fromPi(XAI_MODELS),
  },
  {
    kind: "remixlet",
    label: "OpenAI-compatible",
    title: "OpenAI-compatible endpoint",
    description: "Anything that speaks the OpenAI API — OpenRouter, Ollama, a local server",
    access: "api-key",
    qualifier: "OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultApi: "openai-completions",
    models: [],
  },
];

export function catalogEntry(kind: ProviderKind): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`unknown provider kind: ${kind}`);
  return entry;
}

/** pi's record of this model under this provider kind, when it has one. */
export function catalogModel(kind: string, modelId: string): CatalogModel | undefined {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.kind === kind);
  return entry?.models.find((model) => model.id === modelId);
}

/**
 * Whether the model picker lists this model in its featured tier. pi's
 * catalog is a curation, not a mirror — it carries the models worth reaching
 * for, while live discovery returns everything the credential can see — so
 * catalog membership is the featured signal. Kinds whose lists pi cannot
 * judge feature everything: the Codex manifest is already curated upstream
 * (visibility === "list"), and a custom endpoint's models are exactly what
 * the user connected it for.
 *
 * One structural demotion on top: a dated snapshot (…-YYYY-MM-DD) whose
 * undated base id is also in `siblingIds` (the same provider's model list)
 * is never featured — the base alias is the one to pick, and the snapshot
 * stays reachable under "All models".
 */
export function isFeaturedModel(kind: ProviderKind, modelId: string, siblingIds: readonly string[]): boolean {
  const snapshot = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(modelId);
  if (snapshot && siblingIds.includes(snapshot[1]!)) return false;
  if (kind === "codex" || kind === "remixlet") return true;
  return catalogModel(kind, modelId) !== undefined;
}

/**
 * Which API to speak, and whether the model can see images, for one selected
 * model. `vision: undefined` means pi doesn't know this model — the caller
 * applies its own conservative heuristic.
 */
export function endpointPlan(kind: ProviderKind, modelId: string): { api: ProviderApi | "openai-codex-responses"; vision: boolean | undefined } {
  const model = catalogModel(kind, modelId);
  return model ? { api: model.api, vision: model.vision } : { api: catalogEntry(kind).defaultApi, vision: undefined };
}
