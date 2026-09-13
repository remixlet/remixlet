// User-facing copy for platform features that are missing on a given browser
// target. Kept as one static target × feature table so every "unavailable
// because…" string ships reviewed, honest, and consistent — detection code
// (capabilities.ts, dnr.ts, panel-surface.ts, …) looks its copy up here
// instead of composing its own.

import type { BrowserTarget } from "./ext.js";

export type PlatformFeature =
  | "box"
  | "pageProbes"
  | "sidePanel"
  | "panelSurface"
  | "dnr"
  | "dnrRegexSubstitution"
  | "filterResponseData"
  | "visibleTabCapture"
  | "oauthRedirect";

export const PLATFORM_REASON_COPY = {
  chrome: {
    box: "JavaScript remixlets are unavailable because this browser cannot host the box: it lacks the offscreen document or the scripting API that registers the page agent.",
    pageProbes:
      "Page reads are unavailable because this browser cannot run the extension's page scripts (scripting.executeScript is missing).",
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
    box: "JavaScript remixlets are unavailable in Firefox: this build hosts the box in an offscreen document, which Firefox does not have. CSS and network-rule remixlets remain available.",
    pageProbes:
      "Page reads are unavailable because this Firefox runtime cannot run the extension's page scripts (scripting.executeScript is missing).",
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
    box: "JavaScript remixlets are unavailable in Safari because it has no offscreen document and no sandboxed extension page to host the box. CSS and supported network-rule remixlets remain available.",
    pageProbes:
      "Page reads are unavailable because this Safari runtime cannot run the extension's page scripts (scripting.executeScript is missing).",
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

export function platformReason(target: BrowserTarget, feature: PlatformFeature): string {
  return PLATFORM_REASON_COPY[target][feature];
}
