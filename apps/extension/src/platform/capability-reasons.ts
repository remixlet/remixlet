// User-facing copy for platform features that are missing on a given browser
// target. Kept as one static target × feature table so every "unavailable
// because…" string ships reviewed, honest, and consistent — detection code
// (capabilities.ts, dnr.ts, panel-surface.ts, …) looks its copy up here
// instead of composing its own.

import type { BrowserTarget } from "./ext.js";

export type PlatformFeature =
  | "userScripts"
  | "sidePanel"
  | "panelSurface"
  | "dnr"
  | "dnrRegexSubstitution"
  | "filterResponseData"
  | "visibleTabCapture"
  | "oauthRedirect";

export const PLATFORM_REASON_COPY = {
  chrome: {
    userScripts:
      'JavaScript remixlets are disabled until "Allow user scripts" is enabled for this extension in Chrome.',
    sidePanel: "Chrome's side-panel API is unavailable in this browser version.",
    panelSurface: "The Remixlet panel cannot open because this browser exposes no supported panel surface.",
    dnr: "Network-rule remixlets are unavailable because declarativeNetRequest is missing.",
    dnrRegexSubstitution:
      "Regex-substitution redirects are unavailable because declarativeNetRequest is missing.",
    filterResponseData:
      "Response-stream capture is Firefox-specific; network capture is not available in Chrome.",
    visibleTabCapture: "Visible-screen capture is unavailable because tabs.captureVisibleTab is missing.",
    oauthRedirect: "ChatGPT sign-in is unavailable because neither the DNR redirect nor webNavigation fallback exists.",
  },
  firefox: {
    userScripts:
      "JavaScript remixlets are disabled until Firefox's optional user-scripts permission is granted.",
    sidePanel: "Chrome's side-panel API is not available in Firefox; Remixlet uses the Firefox sidebar.",
    panelSurface: "The Remixlet panel cannot open because Firefox's sidebar API is unavailable.",
    dnr: "Network-rule remixlets are unavailable because declarativeNetRequest is missing.",
    dnrRegexSubstitution:
      "Regex-substitution redirects are unavailable because declarativeNetRequest is missing in this Firefox runtime.",
    filterResponseData:
      "Network response bodies are unavailable because this Firefox runtime does not expose webRequest.filterResponseData.",
    visibleTabCapture: "Visible-screen capture is unavailable because tabs.captureVisibleTab is missing.",
    oauthRedirect: "ChatGPT sign-in is unavailable because the webNavigation callback fallback is missing.",
  },
  safari: {
    userScripts:
      "JavaScript remixlets are unavailable in Safari because it has no userScripts dynamic-code lane. CSS and supported network-rule remixlets remain available.",
    sidePanel: "A browser sidebar is unavailable in Safari; Remixlet uses a focused popup panel.",
    panelSurface: "The Remixlet panel cannot open because Safari's popup-window API is unavailable.",
    dnr: "Network-rule remixlets are unavailable because this Safari version does not expose declarativeNetRequest.",
    dnrRegexSubstitution:
      "Regex-substitution redirects are disabled because Safari's DNR implementation has not been runtime-verified. Use a fixed URL redirect instead.",
    filterResponseData: "Network response-body capture is unavailable in Safari WebExtensions.",
    visibleTabCapture: "Visible-screen capture is unavailable because tabs.captureVisibleTab is missing.",
    oauthRedirect: "ChatGPT sign-in is unavailable because the webNavigation callback fallback is missing.",
  },
} satisfies Record<BrowserTarget, Record<PlatformFeature, string>>;

/**
 * Chrome's userScripts row has a second string because Chrome asks for two
 * different unlocks depending on version: 138 introduced the per-extension
 * "Allow user scripts" toggle the table above names, and before that the API
 * was gated on Developer mode, which no per-extension toggle can turn on.
 * Which one is true for the running browser is decided in
 * user-scripts-gate.ts; naming the wrong switch sends people hunting for a
 * control their Chrome does not draw.
 */
export const CHROME_DEV_MODE_USER_SCRIPTS_REASON =
  'JavaScript remixlets are disabled until Developer mode is turned on in chrome://extensions — this Chrome is older than 138, so it has no per-extension "Allow user scripts" toggle.';

export function platformReason(target: BrowserTarget, feature: PlatformFeature): string {
  return PLATFORM_REASON_COPY[target][feature];
}
