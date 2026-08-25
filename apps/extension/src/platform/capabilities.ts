// Runtime feature detection over the WebExtensions API surface. A
// "capability" is a browser feature Remixlet depends on — a script-injection
// lane, a panel surface, an observation backend, DNR — probed from the actual
// API objects and manifest, never a UA sniff. (The one version read in the
// codebase, in user-scripts-gate.ts, picks which browser-UI instructions
// onboarding shows; it never decides whether a capability exists.)
// This is the single source of
// truth for which backends get instantiated and which features the UI
// presents as available: every missing capability carries user-facing copy
// from capability-reasons.ts, so its feature disables with an explanation and
// never silently half-works. Consumed by the onboarding/manager/popup UI and
// the worker. See the matrix in wiki/plan.md §1.

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason, type PlatformFeature } from "./capability-reasons.js";
import { panelSurface } from "./panel-surface.js";
import { scriptInjector } from "./script-injector.js";
import { userScriptsSetupKind, userScriptsUnlocked, type UserScriptsSetupKind } from "./user-scripts-gate.js";

// The unlock probe lives in user-scripts-gate.ts (script-injector.ts needs it
// too, and imports this module's dependencies the other way round), but this
// stays its published door — every consumer reads capabilities from here.
export { userScriptsSetupKind, userScriptsSetupReason, userScriptsUnlocked } from "./user-scripts-gate.js";
export type { UserScriptsSetupKind } from "./user-scripts-gate.js";

/** The detected capability set — see the module header for semantics. */
export interface PlatformCapabilities {
  target: typeof BROWSER_TARGET;
  /** Setup path the UI can actually offer for userScripts. */
  userScriptsSetup: UserScriptsSetupKind;
  /** Every false/unavailable field below has a matching, user-facing reason. */
  disabledReasons: Partial<Record<PlatformFeature, string>>;
  /** userScripts API present AND unlocked (Chrome's "Allow user scripts" toggle / dev mode). */
  userScripts: boolean;
  /** Honest setup copy for the current target when userScripts is absent. */
  userScriptsDisabledReason?: string;
  /** chrome.sidePanel surface (Firefox uses sidebar_action instead). */
  sidePanel: boolean;
  /** Either Chrome sidePanel or Firefox sidebarAction. */
  panelSurface: "side-panel" | "sidebar" | "popup" | "unavailable";
  panelSurfaceDisabledReason?: string;
  /** declarativeNetRequest dynamic rules (netrules capability + OAuth intercept). */
  dnr: boolean;
  /** DNR redirect.regexSubstitution is supported by this target contract. */
  dnrRegexSubstitution: boolean;
  /** Firefox-only response-stream observation backend. */
  filterResponseData: boolean;
  /** tabs.captureVisibleTab baseline screenshot support. */
  visibleTabCapture: boolean;
  /** Which OAuth callback intercept the target deliberately uses. */
  oauthRedirect: "dnr" | "webNavigation" | "unavailable";
}

export function detectCapabilities(): PlatformCapabilities {
  const injector = scriptInjector();
  const panel = panelSurface();
  // SAFETY: Firefox adds filterResponseData to the standard webRequest namespace.
  const webRequest = ext.webRequest as typeof chrome.webRequest & { filterResponseData?: () => void };
  const dnr = "declarativeNetRequest" in ext;
  const webNavigation = "webNavigation" in ext;
  const values: Omit<PlatformCapabilities, "disabledReasons"> = {
    target: BROWSER_TARGET,
    userScriptsSetup: userScriptsSetupKind(),
    userScripts: injector.available,
    sidePanel: "sidePanel" in ext,
    panelSurface: panel.kind,
    dnr,
    dnrRegexSubstitution: dnrRegexSubstitutionAvailable(),
    filterResponseData: "filterResponseData" in webRequest,
    visibleTabCapture: "captureVisibleTab" in ext.tabs,
    oauthRedirect: BROWSER_TARGET === "chrome" && dnr ? "dnr" : webNavigation ? "webNavigation" : "unavailable",
  };
  if (injector.disabledReason) values.userScriptsDisabledReason = injector.disabledReason;
  if (panel.disabledReason) values.panelSurfaceDisabledReason = panel.disabledReason;
  const disabledReasons: Partial<Record<PlatformFeature, string>> = {};
  if (!values.userScripts) disabledReasons.userScripts = injector.disabledReason ?? platformReason(BROWSER_TARGET, "userScripts");
  if (!values.sidePanel) disabledReasons.sidePanel = platformReason(BROWSER_TARGET, "sidePanel");
  if (values.panelSurface === "unavailable") {
    disabledReasons.panelSurface = panel.disabledReason ?? platformReason(BROWSER_TARGET, "panelSurface");
  }
  if (!values.dnr) disabledReasons.dnr = platformReason(BROWSER_TARGET, "dnr");
  if (!values.dnrRegexSubstitution) {
    disabledReasons.dnrRegexSubstitution = platformReason(BROWSER_TARGET, "dnrRegexSubstitution");
  }
  if (!values.filterResponseData) disabledReasons.filterResponseData = platformReason(BROWSER_TARGET, "filterResponseData");
  if (!values.visibleTabCapture) disabledReasons.visibleTabCapture = platformReason(BROWSER_TARGET, "visibleTabCapture");
  if (values.oauthRedirect === "unavailable") disabledReasons.oauthRedirect = platformReason(BROWSER_TARGET, "oauthRedirect");
  return { ...values, disabledReasons };
}

/**
 * detectCapabilities() reads the userScripts lane from namespace presence,
 * which a long-lived context can hold long after the browser revoked the lane
 * (script-injector.ts). Anything REPORTING the lane to a human — the popup
 * and panel capability alerts, onboarding's finish step — asks here instead,
 * so one real call decides before the answer is shown.
 */
export async function verifiedCapabilities(): Promise<PlatformCapabilities> {
  await scriptInjector().verifyAvailable();
  return detectCapabilities();
}

/**
 * Chrome and Firefox both document redirect.regexSubstitution in their DNR
 * contracts. Safari's converter accepting DNR is not enough evidence that its
 * runtime implements capture-group substitution, so that narrower operation
 * stays gated until it is verified on Safari.
 */
export function dnrRegexSubstitutionAvailable(): boolean {
  return "declarativeNetRequest" in ext && BROWSER_TARGET !== "safari";
}

/** Firefox exposes userScripts as an optional MV3 permission; request it only
 * from an extension-page click so the browser can show its native prompt. */
export async function requestUserScriptsAccess(): Promise<boolean> {
  if (userScriptsUnlocked()) return true;
  if (BROWSER_TARGET !== "firefox") return false;
  const optional = ext.runtime.getManifest().optional_permissions ?? [];
  if (!optional.includes("userScripts")) return false;
  return ext.permissions.request({ permissions: ["userScripts"] });
}

/** Runtime-granted remixlet services that are impossible on this target.
 * Activation uses this before proposing a human capability grant. */
export function remixletCapabilityDisabledReason(capability: string): string | undefined {
  if (capability === "netrules" && !("declarativeNetRequest" in ext)) {
    return platformReason(BROWSER_TARGET, "dnr");
  }
  // Both ride the userScripts MAIN-world injection lane; without it neither
  // the page-world scripts nor the network:observe interceptor can exist.
  if ((capability === "page-world" || capability.startsWith("network:observe:")) && !scriptInjector().available) {
    return scriptInjector().disabledReason ?? platformReason(BROWSER_TARGET, "userScripts");
  }
  if (capability === "clipboard" && BROWSER_TARGET !== "chrome") {
    return BROWSER_TARGET === "safari"
      ? "clipboard is unavailable because Safari has no supported background clipboard-write backend"
      : "clipboard is unavailable because Firefox has no supported background clipboard-write backend";
  }
  if (capability === "notifications" && !("notifications" in ext && "create" in ext.notifications)) {
    return "notifications are unavailable because this browser does not expose the WebExtensions notifications API";
  }
  if (
    capability === "schedule" &&
    (!("alarms" in ext && "create" in ext.alarms) || !("notifications" in ext && "create" in ext.notifications))
  ) {
    return "schedule is unavailable because this browser lacks its alarm or notification delivery backend";
  }
  if (BROWSER_TARGET !== "safari") return undefined;
  if (capability === "clipboard") {
    return "clipboard is unavailable because Safari has no supported background clipboard-write backend";
  }
  if (capability === "notifications") {
    return "notifications are unavailable because Safari does not support the WebExtensions notifications API";
  }
  if (capability === "schedule") {
    return "schedule is unavailable because its Safari notification delivery backend is unsupported";
  }
  return undefined;
}

/**
 * Enterprise-policy detection for onboarding: an admin can strip permissions
 * via ExtensionSettings `blocked_permissions`. When that hits `userScripts`,
 * the manifest still lists the permission but the browser reports it as not
 * held — a state no toggle can fix, so onboarding says "ask your admin"
 * instead of pointing at a switch that isn't there. (The ordinary locked
 * state — toggle off — keeps the permission GRANTED; only the API namespace
 * is gated. That asymmetry is what makes this probe truthful.)
 */
export async function userScriptsBlockedByPolicy(): Promise<boolean> {
  if (!(ext.runtime.getManifest().permissions ?? []).includes("userScripts")) return false;
  try {
    return !(await ext.permissions.contains({ permissions: ["userScripts"] }));
  } catch {
    return false;
  }
}
