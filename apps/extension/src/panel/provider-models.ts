import type { ProviderKind } from "../shared/settings.js";

interface DiscoveryOptions {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  accessToken?: string;
  accountId?: string;
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

function modelIds(kind: ProviderKind, body: ProviderResponse): string[] {
  if (!isProviderRecord(body)) return [];
  const candidates =
    kind === "google"
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : body.models;
  if (!Array.isArray(candidates)) return [];

  return [
    ...new Set(
      candidates
        .map((item) => {
          if (isString(item)) return item;
          if (!isProviderRecord(item)) return "";
          const model = item;
          // The Codex endpoint returns a complete model manifest, including
          // hidden internal models that the ChatGPT account API will reject.
          // Match Codex's own picker contract and expose only listable entries.
          if (kind === "codex" && model.visibility !== "list") return "";
          const id =
            isString(model.id)
              ? model.id
              : isString(model.slug)
                ? model.slug
                : isString(model.name)
                  ? model.name
                  : "";
          return kind === "google" ? id.replace(/^models\//, "") : id;
        })
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/** Ask a configured provider for the models available to this credential. */
export async function discoverProviderModels(options: DiscoveryOptions): Promise<string[]> {
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
    case "google": {
      if (!options.apiKey) throw new Error("Enter an API key.");
      const googleUrl = new URL(endpoint(baseUrl, "models"));
      googleUrl.searchParams.set("key", options.apiKey);
      url = googleUrl.href;
      break;
    }
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

  const models = modelIds(options.kind, body);
  if (models.length === 0) throw new Error("The provider connected, but did not report any models.");
  return models;
}

function isProviderRecord(value: ProviderResponse | undefined): value is ProviderRecord {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: ProviderResponse | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
