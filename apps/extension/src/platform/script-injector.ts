// Cross-browser seam over the userScripts API — MV3's lane for registering
// persistent scripts that run in pages inside a sandboxed USER_SCRIPT world,
// and the only lane allowed to execute remixlet-authored code. Product code
// (worker injection/activation) supplies browser-neutral registrations; this
// module owns the API-shape and availability differences: Chrome gates the
// API behind its "Allow user scripts" toggle, Firefox behind an optional
// permission, and Safari has no lane at all (see capabilities.ts).

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason } from "./capability-reasons.js";
import { userScriptsSetupReason } from "./user-scripts-gate.js";

export type UserScriptWorld = "USER_SCRIPT" | "MAIN";

export interface UserScriptRegistration {
  id: string;
  matches: string[];
  excludeMatches?: string[];
  js: { code: string }[];
  runAt?: "document_start" | "document_end" | "document_idle";
  world?: UserScriptWorld;
  worldId?: string;
}

export interface ScriptInjector {
  readonly kind: "chrome-user-scripts" | "firefox-user-scripts" | "unavailable";
  /** Cheap and synchronous: the namespace is here and has not been revoked. */
  readonly available: boolean;
  readonly disabledReason?: string;
  /** Proven by a real call — see the revocation note on the base class. */
  verifyAvailable(): Promise<boolean>;
  getScripts(): Promise<UserScriptRegistration[]>;
  register(scripts: UserScriptRegistration[]): Promise<void>;
  update(scripts: UserScriptRegistration[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
  configureWorld(worldId: string, csp?: string): Promise<void>;
  execute(tabId: number, code: string, world?: UserScriptWorld): Promise<{ result?: unknown; error?: string }[]>;
}

/**
 * Default Content-Security-Policy for the per-remixlet USER_SCRIPT worlds
 * (H1). It stops injected script from turning a small, reviewed artifact into a
 * live-updating backdoor: `script-src 'self'` blocks a remote `<script>`/import,
 * `object-src 'none'` blocks plugin embeds. The bridge is postMessage/
 * CustomEvent based, so messaging is unaffected. Exfiltration via `fetch`/
 * `sendBeacon`/`img` is still possible under this directive and is contained by
 * the capability model + data-minimization work, not by the world CSP.
 */
export const USER_SCRIPT_WORLD_CSP = "script-src 'self'; object-src 'none'";

type UserScriptsApi = typeof chrome.userScripts & {
  configureWorld(properties: chrome.userScripts.WorldProperties & { worldId?: string; csp?: string }): Promise<void>;
  execute?(injection: {
    target: { tabId: number };
    js: { code: string }[];
    world?: UserScriptWorld;
    injectImmediately?: boolean;
  }): Promise<{ result?: unknown; error?: string }[]>;
};

/**
 * Chrome revokes the lane WITHOUT taking the namespace away. A context born
 * while "Allow user scripts" was on keeps `chrome.userScripts` — object,
 * methods and all — after the user turns the toggle back off; every call then
 * fails with "'userScripts.<method>' is not available in this context."
 * (measured on Chrome 151). The MV3 worker is exactly such a long-lived
 * context, so presence alone would have it reporting a working script lane
 * while remixlets silently stopped running. Any call that fails that way
 * revokes this injector for the rest of the context's life — the API can
 * never come back inside it, because availability is fixed at context
 * creation.
 */
const REVOKED_PATTERN = /not available in this context/i;

abstract class BaseUserScriptsInjector implements ScriptInjector {
  abstract readonly kind: ScriptInjector["kind"];
  abstract readonly disabledReason?: string;
  private revoked = false;

  protected get api(): UserScriptsApi {
    // SAFETY: ext.userScripts is the browser-provided userScripts surface represented by UserScriptsApi.
    const api = ext.userScripts as UserScriptsApi | undefined;
    if (!api) throw new Error(this.disabledReason ?? "The browser userScripts API is unavailable.");
    return api;
  }

  get available(): boolean {
    if (this.revoked) return false;
    try {
      return ext.userScripts?.getScripts !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * One real call, because presence lies (see above). Not cached: a verdict
   * of "available" is exactly the one that goes stale mid-context, and the
   * call is a single in-process API round trip on surfaces (capability
   * reports, activation preflight) that ask at most once per user action.
   */
  async verifyAvailable(): Promise<boolean> {
    if (!this.available) return false;
    try {
      await this.getScripts();
      return true;
    } catch {
      return this.available;
    }
  }

  async getScripts(): Promise<UserScriptRegistration[]> {
    // SAFETY: the normalized platform API exposes registrations in the extension's UserScriptRegistration shape.
    return this.call(async () => (await this.api.getScripts()) as UserScriptRegistration[]);
  }

  async register(scripts: UserScriptRegistration[]): Promise<void> {
    // SAFETY: UserScriptRegistration is the extension's compatible subset of Chrome's registered script input.
    await this.call(() => this.api.register(scripts as chrome.userScripts.RegisteredUserScript[]));
  }

  async update(scripts: UserScriptRegistration[]): Promise<void> {
    // SAFETY: UserScriptRegistration is the extension's compatible subset of Chrome's registered script input.
    await this.call(() => this.api.update(scripts as chrome.userScripts.RegisteredUserScript[]));
  }

  async unregister(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.call(() => this.api.unregister({ ids }));
  }

  async configureWorld(worldId: string, csp: string = USER_SCRIPT_WORLD_CSP): Promise<void> {
    await this.call(() => this.api.configureWorld({ worldId, messaging: true, csp }));
  }

  async execute(tabId: number, code: string, world: UserScriptWorld = "USER_SCRIPT"): Promise<{ result?: unknown; error?: string }[]> {
    if (this.api.execute === undefined) {
      throw new Error("One-shot user-script execution is unavailable in this browser version.");
    }
    return this.call(() =>
      this.api.execute!({
        target: { tabId },
        js: [{ code }],
        world,
        injectImmediately: true,
      }),
    );
  }

  /** Every API call goes through here so a revocation is never missed. */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (REVOKED_PATTERN.test(error instanceof Error ? error.message : String(error))) this.revoked = true;
      throw error;
    }
  }
}

class ChromeScriptInjector extends BaseUserScriptsInjector {
  readonly kind = "chrome-user-scripts";
  get disabledReason(): string | undefined {
    // Names the switch this Chrome actually has — the toggle on 138+, or
    // Developer mode on the versions that never got one.
    return this.available ? undefined : userScriptsSetupReason();
  }
}

class FirefoxScriptInjector extends BaseUserScriptsInjector {
  readonly kind = "firefox-user-scripts";
  get disabledReason(): string | undefined {
    return this.available ? undefined : platformReason("firefox", "userScripts");
  }
}

class UnavailableScriptInjector extends BaseUserScriptsInjector {
  readonly kind = "unavailable";
  readonly disabledReason = platformReason("safari", "userScripts");
}

const injector: ScriptInjector =
  BROWSER_TARGET === "firefox"
    ? new FirefoxScriptInjector()
    : BROWSER_TARGET === "safari"
      ? new UnavailableScriptInjector()
      : new ChromeScriptInjector();

export function scriptInjector(): ScriptInjector {
  return injector;
}
