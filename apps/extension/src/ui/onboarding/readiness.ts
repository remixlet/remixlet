// Is Remixlet actually set up? Computed from facts every time it is asked —
// never from a "user saw the welcome page" flag, which would survive a
// deleted provider and let someone into a control center that cannot work.
//
// One condition, re-derivable at any moment: at least one provider is
// connected with at least one usable model. Nothing else about setup is the
// user's to do. What the browser gives the runtime (the box, the page probes)
// is fixed at install and reported by platform/capabilities.ts; where it is
// missing the product runs in limited mode with the reason on show, and no
// gate could change that.

import { ext } from "../../platform/ext.js";
import {
  SETTINGS_KEY,
  normalizeProviderSettings,
  usableProviders,
  type ProviderSettings,
} from "../../shared/settings.js";

export interface SetupReadiness {
  /** A provider with at least one model is connected. */
  models: boolean;
  /** The only state in which the control center opens. */
  complete: boolean;
  usableProviderCount: number;
  modelCount: number;
}

export function modelsReady(settings: ProviderSettings): boolean {
  return usableProviders(settings).length > 0;
}

/** Provider settings as stored — extension-local, never through the worker. */
export async function readProviderSettings(): Promise<ProviderSettings> {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeProviderSettings(stored[SETTINGS_KEY]);
}

export function setupReadiness(settings: ProviderSettings): SetupReadiness {
  const usable = usableProviders(settings);
  const models = usable.length > 0;
  return {
    models,
    complete: models,
    usableProviderCount: usable.length,
    modelCount: usable.reduce((total, provider) => total + provider.models.length, 0),
  };
}

export async function readSetupReadiness(): Promise<SetupReadiness> {
  return setupReadiness(await readProviderSettings());
}

/** Where an unfinished surface sends people. */
export function welcomeUrl(): string {
  return ext.runtime.getURL("welcome.html");
}
