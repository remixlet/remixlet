// Is Remixlet actually set up? Computed from facts every time it is asked —
// never from a "user saw the welcome page" flag, which would survive a
// revoked toggle or a deleted provider and let someone into a control center
// that cannot work.
//
// Two conditions, both re-derivable at any moment:
//   1. the user-script lane is available (Chrome's per-extension toggle,
//      Firefox's optional permission), and
//   2. at least one provider is connected with at least one usable model.
//
// Condition 1 is decided per JS context at context CREATION (capabilities.ts),
// so a page that was loaded while the toggle was off keeps saying "locked"
// until it is reloaded — that is what the welcome page's iframe probe is for.
// Everything here reads the CURRENT document's view, which is exactly what a
// gate wants: a page that cannot see the API cannot use it either.
//
// The reverse direction needs one real call, not a namespace look: a document
// born while the grant was ON keeps chrome.userScripts after the user turns
// it off, and only calling it reveals the revocation (script-injector.ts).
// So scriptsReady() verifies — otherwise a control center that outlived the
// toggle keeps welcoming people into a broken install.

import { userScriptsSetupKind } from "../../platform/capabilities.js";
import { ext } from "../../platform/ext.js";
import { scriptInjector } from "../../platform/script-injector.js";
import {
  SETTINGS_KEY,
  normalizeProviderSettings,
  usableProviders,
  type ProviderSettings,
} from "../../shared/settings.js";

export interface SetupReadiness {
  /** Step 1: remixlets have a lane to run in. */
  scripts: boolean;
  /** Step 2: a provider with at least one model is connected. */
  models: boolean;
  /** Both — the only state in which the control center opens. */
  complete: boolean;
  usableProviderCount: number;
  modelCount: number;
}

/**
 * Safari has no user-script sandbox to unlock, so there is no toggle to wait
 * on and no permission to request. Locking the whole app behind something the
 * browser cannot do would strand those users, so the step counts as settled
 * there and the page says plainly which features stay off.
 *
 * Everywhere else the answer is proven with a real API call — see the module
 * header for why presence alone would lie in exactly the state this gate
 * exists to catch.
 */
export async function scriptsReady(): Promise<boolean> {
  if (userScriptsSetupKind() === "unsupported") return true;
  return scriptInjector().verifyAvailable();
}

export function modelsReady(settings: ProviderSettings): boolean {
  return usableProviders(settings).length > 0;
}

/** Provider settings as stored — extension-local, never through the worker. */
export async function readProviderSettings(): Promise<ProviderSettings> {
  const stored = await ext.storage.local.get(SETTINGS_KEY);
  return normalizeProviderSettings(stored[SETTINGS_KEY]);
}

export async function setupReadiness(settings: ProviderSettings): Promise<SetupReadiness> {
  const usable = usableProviders(settings);
  const scripts = await scriptsReady();
  const models = usable.length > 0;
  return {
    scripts,
    models,
    complete: scripts && models,
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
