import { isThinkingLevel, type ThinkingLevel } from "../agent/types.js";
import type { ModelThinking, ProviderKind } from "../shared/settings.js";

interface DiscoveryOptions {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  accountId?: string;
}

export interface DiscoveredModel {
  id: string;
  /**
   * The model's reasoning dial when its manifest declares one (today only the
   * Codex manifest does), already intersected with pi's level vocabulary —
   * efforts pi cannot express (e.g. "ultra") are dropped rather than guessed.
   */
  thinking?: ModelThinking;
}

// The models endpoint filters out entries that require a newer Codex client.
// Keep this mirrored with the Codex release whose model manifest we support.
const CODEX_MODELS_CLIENT_VERSION = "0.146.0";

type ProviderResponse = string | number | boolean | null | ProviderResponse[] | { [key: string]: ProviderResponse };
type ProviderRecord = { [key: string]: ProviderResponse };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function messageFromBody(body: ProviderResponse): string {
  if (!isProviderRecord(body)) return "";
  if (isString(body.message)) return body.message;
  if (isString(body.error)) return body.error;
  if (isProviderRecord(body.error)) {
    if (isString(body.error.message)) return body.error.message;
  }
  return "";
}

function manifestThinking(model: ProviderRecord): ModelThinking | undefined {
  if (!Array.isArray(model.supported_reasoning_levels)) return undefined;
  const levels = [
    ...new Set(
      model.supported_reasoning_levels.flatMap((entry): ThinkingLevel[] => {
        const effort = isProviderRecord(entry) && isString(entry.effort) ? entry.effort : undefined;
        return effort !== undefined && isThinkingLevel(effort) ? [effort] : [];
      }),
    ),
  ];
  if (levels.length === 0) return undefined;
  const thinking: ModelThinking = { levels };
  const defaultLevel = isString(model.default_reasoning_level) ? model.default_reasoning_level : "";
  if (isThinkingLevel(defaultLevel) && levels.includes(defaultLevel)) thinking.defaultLevel = defaultLevel;
  return thinking;
}

function discoveredModels(kind: ProviderKind, body: ProviderResponse): DiscoveredModel[] {
  if (!isProviderRecord(body)) return [];
  const candidates =
    kind === "google"
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : body.models;
  if (!Array.isArray(candidates)) return [];

  const models = new Map<string, DiscoveredModel>();
  const priorities = new Map<string, number>();
  for (const item of candidates) {
    let id = "";
    let thinking: ModelThinking | undefined;
    let priority: number | undefined;
    if (isString(item)) {
      id = item;
    } else if (isProviderRecord(item)) {
      const model = item;
      // The Codex endpoint returns a complete model manifest, including
      // hidden internal models that the ChatGPT account API will reject.
      // Match Codex's own picker contract and expose only listable entries.
      if (kind === "codex" && model.visibility !== "list") continue;
      id =
        isString(model.id)
          ? model.id
          : isString(model.slug)
            ? model.slug
            : isString(model.name)
              ? model.name
              : "";
      if (kind === "google") id = id.replace(/^models\//, "");
      if (kind === "codex") {
        thinking = manifestThinking(model);
        if (isNumber(model.priority)) priority = model.priority;
      }
    }
    id = id.trim();
    if (!id || models.has(id)) continue;
    models.set(id, thinking ? { id, thinking } : { id });
    if (priority !== undefined) priorities.set(id, priority);
  }
  // Stored order is meaningful: the picker renders it, and the first entry
  // becomes the default selection when none exists. The Codex manifest
  // publishes its own ranking — `priority`, ascending, is how Codex's picker
  // orders models, with the first listable entry the default for new users
  // (openai/codex models-manager) — so honor it; a manifest predating the
  // field keeps its order (stable sort). No other provider publishes a
  // ranking, so their lists stay alphabetical.
  const discovered = [...models.values()];
  if (kind === "codex") {
    return discovered.sort(
      (left, right) =>
        (priorities.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priorities.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return discovered.sort((left, right) => left.id.localeCompare(right.id));
}

/** Ask a configured provider for the models available to this credential. */
export async function discoverProviderModels(options: DiscoveryOptions): Promise<DiscoveredModel[]> {
  const baseUrl = options.baseUrl.trim();
  if (!baseUrl) throw new Error("Enter a base URL.");

  let url: string;
  const headers = new Headers({ Accept: "application/json" });

  switch (options.kind) {
    case "remixlet":
    case "openai":
    case "xai":
      if (!options.apiKey) throw new Error("Enter an API key.");
      url = endpoint(baseUrl, "models");
      headers.set("Authorization", `Bearer ${options.apiKey}`);
      break;
    case "anthropic":
      if (!options.apiKey) throw new Error("Enter an API key.");
      url = endpoint(baseUrl, "v1/models");
      headers.set("x-api-key", options.apiKey);
      headers.set("anthropic-version", "2023-06-01");
      break;
    case "google":
      if (!options.apiKey) throw new Error("Enter an API key.");
      // Header, never the `?key=` query form: a URL lands in logs, error
      // text and history, and the chat path already sends this header.
      url = endpoint(baseUrl, "models");
      headers.set("x-goog-api-key", options.apiKey);
      break;
    case "codex": {
      if (!options.accessToken || !options.accountId) throw new Error("Sign in with ChatGPT first.");
      const codexUrl = new URL(endpoint(baseUrl, "codex/models"));
      codexUrl.searchParams.set("client_version", CODEX_MODELS_CLIENT_VERSION);
      url = codexUrl.href;
      headers.set("Authorization", `Bearer ${options.accessToken}`);
      headers.set("ChatGPT-Account-ID", options.accountId);
      break;
    }
  }

  const response = await fetch(url, { headers });
  let body: ProviderResponse = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    const detail = messageFromBody(body);
    throw new Error(detail || `The provider returned ${response.status}.`);
  }

  const models = discoveredModels(options.kind, body);
  if (models.length === 0) throw new Error("The provider connected, but did not report any models.");
  return models;
}

function isProviderRecord(value: ProviderResponse | undefined): value is ProviderRecord {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: ProviderResponse | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: ProviderResponse | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}
