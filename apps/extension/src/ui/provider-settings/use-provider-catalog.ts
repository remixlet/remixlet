// The provider catalog, as a hook: load, connect, refresh, edit, remove, plus
// the ChatGPT sign-in that a subscription provider needs first. Two surfaces
// drive the same catalog — the welcome page's "connect a model" step and the
// control center's Providers page — so the mutations live here once and each
// page only decides how to lay them out.
//
// Credentials stay extension-local: this reads and writes ext.storage from the
// calling document and never routes a key through the worker or the bridge.
// The worker is asked only for the ChatGPT OAuth material, which it owns.

import { useEffect, useState } from "react";

import { discoverProviderModels } from "../../panel/provider-models.js";
import { sendToWorker } from "../../panel/worker-client.js";
import { ext } from "../../platform/ext.js";
import { type CodexAuthStatus } from "../../shared/codex-oauth.js";
import {
  DEFAULT_SETTINGS,
  PROVIDER_DEFAULTS,
  SETTINGS_KEY,
  normalizeProviderSettings,
  recordProviderOutcome,
  type ProviderConfig,
  type ProviderSettings,
} from "../../shared/settings.js";
import type { DraftProvider } from "./add-provider-form.js";

function fallbackModelIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function loadSettings(): Promise<ProviderSettings> {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeProviderSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(settings: ProviderSettings): Promise<void> {
  await ext.storage.local.set({ [SETTINGS_KEY]: settings });
}

export interface ProviderCatalog {
  settings: ProviderSettings;
  loaded: boolean;
  codexStatus: CodexAuthStatus;
  busyProviderId: string | null;
  busy: boolean;
  status: string;
  error: string;
  clearMessages: () => void;
  /** Resolves true when the provider connected and its models were listed. */
  addProvider: (draft: DraftProvider) => Promise<boolean>;
  refreshModels: (provider: ProviderConfig) => void;
  updateProvider: (provider: ProviderConfig, changes: Pick<ProviderConfig, "name" | "baseUrl" | "apiKey">) => void;
  removeProvider: (provider: ProviderConfig) => void;
  beginCodexSignIn: () => void;
  signOutCodex: () => void;
}

export function useProviderCatalog(): ProviderCatalog {
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [codexStatus, setCodexStatus] = useState<CodexAuthStatus>({
    state: "signed-out",
  });

  async function refreshCodexStatus(): Promise<CodexAuthStatus> {
    const reply = await sendToWorker({ kind: "codex.status" }, "codex.statusResult");
    setCodexStatus(reply.status);
    return reply.status;
  }

  useEffect(() => {
    void Promise.all([loadSettings(), refreshCodexStatus()]).then(([loadedSettings]) => {
      setSettings(loadedSettings);
      setLoaded(true);
    });
    // The catalog is written from more than one document (this page, the
    // panel's model menu), and storage is the only thing they share.
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== "local") return;
      if ("codexAuth" in changes) void refreshCodexStatus();
      if (SETTINGS_KEY in changes) void loadSettings().then(setSettings);
    };
    ext.storage.onChanged.addListener(onStorageChanged);
    return () => ext.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  async function persist(next: ProviderSettings, message: string): Promise<void> {
    await saveSettings(next);
    setSettings(next);
    setStatus(message);
    setError("");
  }

  async function discoveryOptions(provider: Pick<ProviderConfig, "kind" | "baseUrl" | "apiKey">) {
    if (provider.kind !== "codex") return provider;
    const auth = await refreshCodexStatus();
    if (auth.state !== "signed-in") throw new Error("Sign in with ChatGPT before connecting this provider.");
    const token = await sendToWorker({ kind: "codex.getAccessToken" }, "codex.accessToken");
    if (!token.ok) throw new Error(token.message);
    return {
      ...provider,
      accessToken: token.accessToken,
      accountId: auth.accountId,
    };
  }

  async function addProvider(draft: DraftProvider): Promise<boolean> {
    const id = crypto.randomUUID();
    setBusyProviderId(id);
    setStatus("");
    setError("");
    try {
      let models: string[];
      try {
        models = await discoverProviderModels(
          await discoveryOptions({
            kind: draft.kind,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
          }),
        );
      } catch (discoveryError) {
        // A provider that cannot list its models is still usable when the
        // human typed the ids in by hand; with neither, the failure stands.
        // Codex is the exception: its model list only ever comes from the
        // signed-in ChatGPT plan, so a failure there is a failure.
        if (draft.kind === "codex") throw discoveryError;
        models = fallbackModelIds(draft.fallbackModels);
        if (models.length === 0) throw discoveryError;
      }
      const provider: ProviderConfig = {
        id,
        kind: draft.kind,
        name: draft.name.trim() || PROVIDER_DEFAULTS[draft.kind].label,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.kind === "codex" ? "" : draft.apiKey.trim(),
        models,
        lastUsedAt: new Date().toISOString(),
      };
      await persist(
        {
          version: 2,
          providers: [...settings.providers, provider],
          selectedModel: settings.selectedModel ?? {
            providerId: id,
            modelId: models[0]!,
          },
        },
        `${provider.name} connected with ${models.length} available model${models.length === 1 ? "" : "s"}.`,
      );
      return true;
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusyProviderId(null);
    }
  }

  function refreshModels(provider: ProviderConfig): void {
    setBusyProviderId(provider.id);
    setStatus("");
    setError("");
    void (async () => {
      const models = await discoverProviderModels(await discoveryOptions(provider));
      const { lastError: _cleared, ...healthy } = provider;
      const refreshed = {
        ...healthy,
        models,
        lastUsedAt: new Date().toISOString(),
      };
      const selectedModel =
        settings.selectedModel?.providerId === provider.id && !models.includes(settings.selectedModel.modelId)
          ? { providerId: provider.id, modelId: models[0]! }
          : (settings.selectedModel ?? {
              providerId: provider.id,
              modelId: models[0]!,
            });
      await persist(
        {
          version: 2,
          providers: settings.providers.map((item) => (item.id === provider.id ? refreshed : item)),
          selectedModel,
        },
        `${provider.name} now reports ${models.length} available model${models.length === 1 ? "" : "s"}.`,
      );
    })()
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        // A failed attempt is the fact the list's "needs attention" state
        // renders from — persist it so every surface (and the next session)
        // agrees, keeping the last-known-good model list and timestamp.
        const next = recordProviderOutcome(settings, provider.id, { ok: false, error: message });
        setSettings(next);
        void saveSettings(next);
      })
      .finally(() => setBusyProviderId(null));
  }

  function updateProvider(
    provider: ProviderConfig,
    changes: Pick<ProviderConfig, "name" | "baseUrl" | "apiKey">,
  ): void {
    void persist(
      {
        ...settings,
        providers: settings.providers.map((item) => (item.id === provider.id ? { ...item, ...changes } : item)),
      },
      `${changes.name} updated. Refresh its models to check the new connection.`,
    );
  }

  function removeProvider(provider: ProviderConfig): void {
    if (!confirm(`Remove ${provider.name}? Its stored credentials and model list will be deleted.`)) return;
    const providers = settings.providers.filter((item) => item.id !== provider.id);
    const selectedModel =
      settings.selectedModel?.providerId === provider.id && providers[0]?.models[0]
        ? { providerId: providers[0].id, modelId: providers[0].models[0] }
        : settings.selectedModel?.providerId === provider.id
          ? null
          : settings.selectedModel;
    void persist({ version: 2, providers, selectedModel }, `${provider.name} removed.`);
  }

  function beginCodexSignIn(): void {
    setError("");
    void sendToWorker({ kind: "codex.begin" }, "codex.begun").then((reply) => {
      if (!reply.ok) setError(reply.message ?? "ChatGPT sign-in could not start.");
      else
        setStatus(
          "OpenAI opened in a new tab. Confirm the account shown and choose Continue, then return here to connect the provider.",
        );
    });
  }

  function signOutCodex(): void {
    void sendToWorker({ kind: "codex.signOut" }, "codex.signedOut").then(() => {
      void refreshCodexStatus();
      setStatus("Signed out of ChatGPT.");
    });
  }

  return {
    settings,
    loaded,
    codexStatus,
    busyProviderId,
    busy: busyProviderId !== null,
    status,
    error,
    clearMessages: () => {
      setStatus("");
      setError("");
    },
    addProvider,
    refreshModels,
    updateProvider,
    removeProvider,
    beginCodexSignIn,
    signOutCodex,
  };
}
