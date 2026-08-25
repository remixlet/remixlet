// Model provider settings. Credentials stay in extension-local storage and
// are only read by extension-owned UI documents. The page/worker bridge never
// sees API-key provider configuration.
//
// Which providers exist — and their labels and endpoints — comes from the
// pi-derived catalog (agent/provider-catalog.ts); this module only stores and
// validates what the user connected.

import { PROVIDER_CATALOG, type ProviderKind } from "../agent/provider-catalog.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type { ProviderKind } from "../agent/provider-catalog.js";

export interface ProviderDefaults {
  label: string;
  baseUrl: string;
}

const providerDefaults = Object.fromEntries(
  PROVIDER_CATALOG.map((entry) => [entry.kind, { label: entry.label, baseUrl: entry.baseUrl }]),
);
// SAFETY: PROVIDER_CATALOG contains exactly one entry for every ProviderKind.
const PROVIDER_DEFAULTS = providerDefaults as Record<ProviderKind, ProviderDefaults>;
export { PROVIDER_DEFAULTS };

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** When a request to this provider last succeeded — a chat turn or an
   *  explicit refresh. Never written on a schedule: the extension must not
   *  contact providers outside an active use. */
  lastUsedAt?: string;
  /** The failure message from the most recent attempted use, cleared by the
   *  next success. Present ⇒ the provider renders as needing attention. */
  lastError?: string;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface ProviderSettings {
  version: 2;
  providers: ProviderConfig[];
  selectedModel: ModelSelection | null;
}

export interface AvailableModel extends ModelSelection {
  providerName: string;
  providerKind: ProviderKind;
}

export const SETTINGS_KEY = "providerSettings";

export const DEFAULT_SETTINGS: ProviderSettings = {
  version: 2,
  providers: [],
  selectedModel: null,
};

type StoredValue = string | number | boolean | null | StoredValue[] | StoredObject;
interface StoredObject {
  [key: string]: StoredValue;
}

const StoredString = Type.String();

function storedString(value: StoredValue | undefined): string | undefined {
  return Value.Check(StoredString, value) ? value : undefined;
}

function isStoredObject(value: StoredValue): value is StoredObject {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_CATALOG.some((entry) => entry.kind === value);
}

function uniqueModels(value: StoredValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((model) => storedString(model)?.trim() ?? []))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeProvider(value: StoredValue): ProviderConfig | undefined {
  if (!isStoredObject(value)) return undefined;
  const kind = storedString(value.kind);
  const id = storedString(value.id);
  if (!kind || !isProviderKind(kind) || !id) return undefined;
  const defaults = PROVIDER_DEFAULTS[kind];
  const name = storedString(value.name)?.trim() || defaults.label;
  const baseUrl = storedString(value.baseUrl)?.trim() || defaults.baseUrl;
  const provider: ProviderConfig = {
    id,
    kind,
    name,
    baseUrl,
    apiKey: kind !== "codex" ? storedString(value.apiKey) ?? "" : "",
    models: uniqueModels(value.models),
  };
  const lastUsedAt = storedString(value.lastUsedAt) ?? storedString(value.lastRefreshedAt);
  const lastError = storedString(value.lastError);
  if (lastUsedAt) provider.lastUsedAt = lastUsedAt;
  if (lastError) provider.lastError = lastError;
  return provider;
}

/**
 * Record the outcome of a real request to a provider — a chat turn or an
 * explicit refresh. Success stamps lastUsedAt and clears any standing failure;
 * failure keeps the last-known-good timestamp and model list and only records
 * what went wrong.
 */
export function recordProviderOutcome(
  settings: ProviderSettings,
  providerId: string,
  outcome: { ok: true; at: string } | { ok: false; error: string },
): ProviderSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      if (outcome.ok) {
        const { lastError: _cleared, ...rest } = provider;
        return { ...rest, lastUsedAt: outcome.at };
      }
      return { ...provider, lastError: outcome.error };
    }),
  };
}

function validSelection(providers: ProviderConfig[], value: StoredValue | undefined): ModelSelection | null {
  if (value === undefined || !isStoredObject(value)) return null;
  const providerId = storedString(value.providerId);
  const modelId = storedString(value.modelId);
  if (!providerId || !modelId) return null;
  const provider = providers.find((item) => item.id === providerId);
  return provider?.models.includes(modelId) ? { providerId, modelId } : null;
}

function firstSelection(providers: ProviderConfig[]): ModelSelection | null {
  const provider = providers.find((item) => item.models.length > 0);
  const modelId = provider?.models[0];
  return provider && modelId ? { providerId: provider.id, modelId } : null;
}

/** Load the provider catalog and migrate the former single-provider shape. */
export function normalizeProviderSettings(stored: StoredValue): ProviderSettings {
  if (!isStoredObject(stored)) return { ...DEFAULT_SETTINGS, providers: [] };
  const raw = stored;

  if (raw.version === 2 && Array.isArray(raw.providers)) {
    const providers = raw.providers.map(normalizeProvider).filter((item): item is ProviderConfig => item !== undefined);
    return {
      version: 2,
      providers,
      selectedModel: validSelection(providers, raw.selectedModel) ?? firstSelection(providers),
    };
  }

  // v1 stored exactly one API-key or Codex provider. Preserve its endpoint,
  // credential, and selected model while moving it into the catalog.
  const mode = raw.mode === "codex" ? "codex" : "api-key";
  const storedProvider = storedString(raw.provider);
  const legacyKind: ProviderKind =
    mode === "codex" ? "codex" : storedProvider && isProviderKind(storedProvider) && storedProvider !== "codex" ? storedProvider : "remixlet";
  const defaults = PROVIDER_DEFAULTS[legacyKind];
  const storedModelId = storedString(mode === "codex" ? raw.codexModelId : raw.modelId)?.trim();
  const modelId = storedModelId ?? "";
  const storedBaseUrl = storedString(mode === "codex" ? raw.codexBaseUrl : raw.baseUrl)?.trim();
  const baseUrl = storedBaseUrl || defaults.baseUrl;
  const apiKey = mode === "api-key" ? storedString(raw.apiKey) ?? "" : "";
  const hasLegacyProvider = modelId.length > 0 || apiKey.length > 0;
  if (!hasLegacyProvider) return { ...DEFAULT_SETTINGS, providers: [] };

  const provider: ProviderConfig = {
    id: `migrated-${legacyKind}`,
    kind: legacyKind,
    name: defaults.label,
    baseUrl,
    apiKey,
    models: modelId ? [modelId] : [],
  };
  return {
    version: 2,
    providers: [provider],
    selectedModel: modelId ? { providerId: provider.id, modelId } : null,
  };
}

export function availableModels(settings: ProviderSettings): AvailableModel[] {
  return settings.providers.flatMap((provider) =>
    provider.models.map((modelId) => ({
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      modelId,
    })),
  );
}

export function selectedProvider(settings: ProviderSettings): ProviderConfig | undefined {
  if (!settings.selectedModel) return undefined;
  return settings.providers.find((provider) => provider.id === settings.selectedModel?.providerId);
}

/**
 * A provider that could answer a request right now: an endpoint, at least one
 * model, and whatever credential its kind needs. The subscription provider
 * carries its credential in the worker's OAuth store rather than here, and an
 * OpenAI-compatible endpoint may legitimately have no key at all (a local
 * server) — the same rule the connect form applies before it offers Connect.
 */
export function providerUsable(provider: ProviderConfig): boolean {
  if (provider.models.length === 0 || provider.baseUrl.length === 0) return false;
  return provider.kind === "codex" || provider.kind === "remixlet" || provider.apiKey.length > 0;
}

/**
 * The parts of the catalog that determine what a live chat runtime talks to:
 * endpoints, credentials, model lists, and the selection. Health stamps
 * (lastUsedAt / lastError) are deliberately excluded — the panel writes them
 * after every turn, and an unchanged fingerprint means an existing runtime
 * can keep running.
 */
export function providerRuntimeFingerprint(settings: ProviderSettings): string {
  return JSON.stringify({
    selected: settings.selectedModel,
    providers: settings.providers.map(({ lastUsedAt: _at, lastError: _err, ...rest }) => rest),
  });
}

/** Every provider that could serve a model today — the fact onboarding asks for. */
export function usableProviders(settings: ProviderSettings): ProviderConfig[] {
  return settings.providers.filter(providerUsable);
}

/** Whether chat has a valid provider/model pair to start a turn with. */
export function settingsComplete(settings: ProviderSettings): boolean {
  const provider = selectedProvider(settings);
  if (!provider || !settings.selectedModel || !provider.models.includes(settings.selectedModel.modelId)) return false;
  return providerUsable(provider);
}
