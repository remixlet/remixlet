// Model provider settings. Credentials stay in extension-local storage and
// are only read by extension-owned UI documents. The page/worker bridge never
// sees API-key provider configuration.
//
// Which providers exist — and their labels and endpoints — comes from the
// pi-derived catalog (agent/provider-catalog.ts); this module only stores and
// validates what the user connected.

import { PROVIDER_CATALOG, type ProviderKind } from "../agent/provider-catalog.js";
import { isThinkingLevel, type ThinkingLevel } from "../agent/types.js";
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

/**
 * A model's reasoning dial as its provider declares it — for Codex, the
 * manifest's per-model levels (already intersected with pi's vocabulary at
 * discovery). Stored so the panel and runtime can offer/apply levels without
 * re-fetching the manifest. Absent for providers whose support is derived
 * from the pi catalog instead (agent/providers.ts supportedThinkingLevels).
 */
export interface ModelThinking {
  levels: ThinkingLevel[];
  /** What the backend applies when no level is sent — labels the "Default" choice. */
  defaultLevel?: ThinkingLevel;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** Reasoning-dial metadata per model id, for models whose provider declares one. */
  modelThinking?: Record<string, ModelThinking>;
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
  /**
   * The user's chosen reasoning depth, keyed by thinkingLevelKey(). A model
   * without an entry sends nothing and the backend applies its own default —
   * so this map only ever holds deliberate choices.
   */
  thinkingLevels?: Record<string, ThinkingLevel>;
}

/** Storage key for one model's thinking-level choice. */
export function thinkingLevelKey(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/** The chosen reasoning depth for the selected model, if the user set one. */
export function selectedThinkingLevel(settings: ProviderSettings): ThinkingLevel | undefined {
  if (!settings.selectedModel) return undefined;
  return settings.thinkingLevels?.[thinkingLevelKey(settings.selectedModel)];
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
  // Stored order is meaningful — discovery writes it (Codex: the manifest's
  // own priority ranking; everyone else: alphabetical) and models[0] is the
  // first-connect default — so dedupe without re-sorting.
  return [...new Set(value.flatMap((model) => storedString(model)?.trim() ?? []))].filter(Boolean);
}

function normalizeModelThinking(value: StoredValue | undefined, models: string[]): Record<string, ModelThinking> | undefined {
  if (value === undefined || !isStoredObject(value)) return undefined;
  const thinking: Record<string, ModelThinking> = {};
  for (const [modelId, entry] of Object.entries(value)) {
    if (!models.includes(modelId) || !isStoredObject(entry) || !Array.isArray(entry.levels)) continue;
    const levels = [
      ...new Set(
        entry.levels.flatMap((level) => {
          const name = storedString(level);
          return name !== undefined && isThinkingLevel(name) ? [name] : [];
        }),
      ),
    ];
    if (levels.length === 0) continue;
    const item: ModelThinking = { levels };
    const defaultLevel = storedString(entry.defaultLevel);
    if (defaultLevel !== undefined && isThinkingLevel(defaultLevel) && levels.includes(defaultLevel)) {
      item.defaultLevel = defaultLevel;
    }
    thinking[modelId] = item;
  }
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

function normalizeProvider(value: StoredValue): ProviderConfig | undefined {
  if (!isStoredObject(value)) return undefined;
  const kind = storedString(value.kind);
  const id = storedString(value.id);
  if (!kind || !isProviderKind(kind) || !id) return undefined;
  const defaults = PROVIDER_DEFAULTS[kind];
  const name = storedString(value.name)?.trim() || defaults.label;
  // A Codex access token authorizes OpenAI's ChatGPT backend, not an
  // arbitrary OpenAI-compatible endpoint. Pin it while normalizing so a
  // corrupted store cannot move the bearer or account id to another origin.
  const baseUrl = kind === "codex" ? defaults.baseUrl : storedString(value.baseUrl)?.trim() || defaults.baseUrl;
  const provider: ProviderConfig = {
    id,
    kind,
    name,
    baseUrl,
    apiKey: kind !== "codex" ? storedString(value.apiKey) ?? "" : "",
    models: uniqueModels(value.models),
  };
  const modelThinking = normalizeModelThinking(value.modelThinking, provider.models);
  if (modelThinking) provider.modelThinking = modelThinking;
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

/** Keep only choices that still point at a listed model and a real level. */
function validThinkingLevels(
  providers: ProviderConfig[],
  value: StoredValue | undefined,
): Record<string, ThinkingLevel> | undefined {
  if (value === undefined || !isStoredObject(value)) return undefined;
  const choices: Record<string, ThinkingLevel> = {};
  for (const [key, stored] of Object.entries(value)) {
    const level = storedString(stored);
    if (level === undefined || !isThinkingLevel(level)) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const provider = providers.find((item) => item.id === key.slice(0, slash));
    if (!provider?.models.includes(key.slice(slash + 1))) continue;
    choices[key] = level;
  }
  return Object.keys(choices).length > 0 ? choices : undefined;
}

/**
 * Load the provider catalog. Anything but the current shape reads as empty:
 * there is no older shape to migrate from (pre-launch, no installed users).
 */
export function normalizeProviderSettings(stored: StoredValue): ProviderSettings {
  if (!isStoredObject(stored)) return { ...DEFAULT_SETTINGS, providers: [] };
  const raw = stored;
  if (raw.version !== 2 || !Array.isArray(raw.providers)) return { ...DEFAULT_SETTINGS, providers: [] };
  const providers = raw.providers.map(normalizeProvider).filter((item): item is ProviderConfig => item !== undefined);
  const settings: ProviderSettings = {
    version: 2,
    providers,
    selectedModel: validSelection(providers, raw.selectedModel) ?? firstSelection(providers),
  };
  const thinkingLevels = validThinkingLevels(providers, raw.thinkingLevels);
  if (thinkingLevels) settings.thinkingLevels = thinkingLevels;
  return settings;
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
    thinking: settings.thinkingLevels ?? {},
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
