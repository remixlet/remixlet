// Runtime feature detection over the WebExtensions API surface. A
// "capability" is a browser feature Remixlet depends on — the box that runs
// remixlet code, the page-probe lane, a panel surface, an observation
// backend, DNR — probed from the actual API objects and manifest, never a UA
// sniff. This is the single source of truth for which backends get
// instantiated and which features the UI presents as available: every
// missing capability carries user-facing copy from capability-reasons.ts, so
// its feature disables with an explanation and never silently half-works.
// Consumed by the onboarding/manager/popup UI and the worker. See the matrix
// in wiki/plan.md §1.
//
// Nothing here waits on a user-flipped switch. The user-scripts permission and
// its "Allow user scripts" toggle are gone (wiki/design/mediated-execution.md,
// "The user-scripts permission"): what remixlet code and the agent's page
// reads need is fixed by the browser at install time, so one synchronous read
// of the API surface is the whole answer, in every context, for the life of
// the context.

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason, type PlatformFeature } from "./capability-reasons.js";
import { contentScriptRegistry } from "./content-script-registry.js";
import { offscreenDocumentAvailable } from "./offscreen-document.js";
import { panelSurface } from "./panel-surface.js";
import { scriptExecutor } from "./script-executor.js";
import { NETWORK_OBSERVE_PREFIX } from "../shared/observe-capability.js";

/** The detected capability set — see the module header for semantics. */
export interface PlatformCapabilities {
  target: typeof BROWSER_TARGET;
  /** Every false/unavailable field below has a matching, user-facing reason. */
  disabledReasons: Partial<Record<PlatformFeature, string>>;
  /**
   * JavaScript remixlets can run: the offscreen document that hosts the
   * sandboxed box exists AND the scripting API can register the page agent
   * (wiki/design/mediated-execution.md §Parts). Chrome only today — Firefox
   * has no offscreen API and Safari neither that nor a sandboxed page.
   */
  box: boolean;
  /** The agent's structured page probes (scripting.executeScript into a tab). */
  pageProbes: boolean;
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
  const panel = panelSurface();
  // SAFETY: Firefox adds filterResponseData to the standard webRequest namespace.
  const webRequest = ext.webRequest as typeof chrome.webRequest & { filterResponseData?: () => void };
  const dnr = "declarativeNetRequest" in ext;
  const webNavigation = "webNavigation" in ext;
  const values: Omit<PlatformCapabilities, "disabledReasons"> = {
    target: BROWSER_TARGET,
    box: boxAvailable(),
    pageProbes: scriptExecutor().available,
    sidePanel: "sidePanel" in ext,
    panelSurface: panel.kind,
    dnr,
    dnrRegexSubstitution: dnrRegexSubstitutionAvailable(),
    filterResponseData: "filterResponseData" in webRequest,
    visibleTabCapture: "captureVisibleTab" in ext.tabs,
    oauthRedirect: BROWSER_TARGET === "chrome" && dnr ? "dnr" : webNavigation ? "webNavigation" : "unavailable",
  };
  if (panel.disabledReason) values.panelSurfaceDisabledReason = panel.disabledReason;
  const disabledReasons: Partial<Record<PlatformFeature, string>> = {};
  if (!values.box) disabledReasons.box = platformReason(BROWSER_TARGET, "box");
  if (!values.pageProbes) disabledReasons.pageProbes = platformReason(BROWSER_TARGET, "pageProbes");
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
 * The box needs two things from the browser: the offscreen document that
 * hosts box.html (Chrome only, platform/offscreen-document.ts) and the
 * scripting registry that puts the page agent on the pages the mirror wants
 * (worker/injection.ts). The manifest `sandbox` key that gives box.html its
 * CSP is a build-time fact of every target's manifest, not a runtime one.
 */
export function boxAvailable(): boolean {
  return offscreenDocumentAvailable() && contentScriptRegistry().available;
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

/** Runtime-granted remixlet services that are impossible on this target.
 * Activation uses this before proposing a human capability grant. */
export function remixletCapabilityDisabledReason(capability: string): string | undefined {
  if (capability === "netrules" && !("declarativeNetRequest" in ext)) {
    return platformReason(BROWSER_TARGET, "dnr");
  }
  // The network:observe relay is a shipped file registered as a MAIN-world
  // content script (worker/injection.ts); it needs the scripting registry.
  if (capability.startsWith(NETWORK_OBSERVE_PREFIX) && !contentScriptRegistry().available) {
    return "network observation is unavailable because this browser cannot register the extension's page relay";
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
