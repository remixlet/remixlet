// SnapshotBackend — the Chrome observation path. Content-script DOM snapshot
// (ISOLATED world; host perms already <all_urls>) plus a visible-viewport
// screenshot. Needs no permission beyond what the base install carries.

import type { CaptureBundle } from "../../shared/capture.js";
import { BROWSER_TARGET, ext } from "../ext.js";
import { platformReason } from "../capability-reasons.js";
import type { CaptureRequest, CaptureResult, ObservationBackend, ObservationProvides } from "./types.js";

interface DomSnapshot {
  url: string;
  title: string;
  html: string;
  frames: { title: string; origin: string; rect: { x: number; y: number; width: number; height: number } }[];
  dataRequests: { host: string; count: number; jsonCount: number }[];
}

/** Runs inside the page (ISOLATED world) — must stay self-contained. Exported for the browser test suite. */
export function readDomSnapshot(): DomSnapshot {
  // Frame inventory (wiki/raw/handoffs/2026-08-10-early-scoping-and-frame-
  // inventory.md): top-document iframes only, computed once at snapshot time
  // — the facts are free here, no probe round trips. Origin only, never the
  // src path/query (tracking parameters must not ride into model context).
  const frames = Array.from(document.querySelectorAll("iframe")).map((frame) => {
    const rect = frame.getBoundingClientRect();
    let origin = "";
    const src = frame.getAttribute("src") ?? "";
    if (src) {
      try {
        origin = new URL(src, location.href).origin;
      } catch {
        origin = "";
      }
    }
    // Opaque origins (about:blank, srcdoc) serialize as the string "null" —
    // report them as "" so the line reads honestly as "no origin".
    if (origin === "null") origin = "";
    return {
      title: (frame.getAttribute("title") ?? "").slice(0, 80),
      origin,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
  // Data-request inventory: like the frame inventory, these facts are free at
  // snapshot time — the resource timeline is readable from the ISOLATED world
  // — and they spare the model a probe round on "does this page fetch data,
  // and from where". Per-host counts only, never paths or query strings (the
  // FrameEntry.origin rule). "Data request" mirrors classifyNetworkResource
  // (worker/page-probes/probes.ts): a fetch/XHR initiator, or a JSON/XML
  // content type — contentType is recent-Chrome resource timing, so absence
  // just means the initiator rule carries the classification alone.
  const hostTallies = new Map<string, { count: number; jsonCount: number }>();
  // Page-boundary values (the probes' PageValue idiom): resource-timing
  // fields whose presence varies by browser, parsed behind a tag check.
  type TimingValue = string | number | boolean | object | null | undefined;
  const asText = (value: TimingValue): value is string => Object.prototype.toString.call(value) === "[object String]";
  for (const entry of performance.getEntriesByType("resource")) {
    // SAFETY: structural view over a PerformanceEntry — the newer fields
    // (initiatorType/contentType) may be absent depending on browser, so each
    // is read behind the asText tag check and never written.
    const timing = entry as PerformanceEntry & { initiatorType?: TimingValue; contentType?: TimingValue };
    const initiator = asText(timing.initiatorType) ? timing.initiatorType : "";
    const contentType = asText(timing.contentType) ? timing.contentType.toLowerCase() : "";
    const isData =
      initiator === "fetch" || initiator === "xmlhttprequest" || contentType.includes("json") || contentType.includes("xml");
    if (!isData || entry.name.slice(0, 5) === "data:") continue;
    let host = "";
    try {
      host = new URL(entry.name).hostname;
    } catch {}
    if (host.length === 0) continue;
    const tally = hostTallies.get(host) ?? { count: 0, jsonCount: 0 };
    tally.count += 1;
    if (contentType.includes("json")) tally.jsonCount += 1;
    hostTallies.set(host, tally);
  }
  const dataRequests = Array.from(hostTallies.entries())
    .map(([host, tally]) => ({ host, count: tally.count, jsonCount: tally.jsonCount }))
    .sort((a, b) => b.count - a.count);
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    frames,
    dataRequests,
  };
}

/**
 * Chrome rate-limits tabs.captureVisibleTab (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_
 * SECOND); back-to-back agent captures — e.g. a recapture right after the
 * one-click capability authorization — trip it. One short wait clears it.
 */
async function captureVisibleTabPastQuota(windowId: number): Promise<string> {
  try {
    return await ext.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(error))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return await ext.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

export class SnapshotBackend implements ObservationBackend {
  readonly kind = "snapshot";
  readonly provides: ObservationProvides = {
    dom: true,
    screenshot: "visible",
    network: false,
    console: false,
    evaluate: false,
  };

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const bundle: CaptureBundle = {
      url: "",
      title: "",
      capturedAt: new Date().toISOString(),
      producedBy: "snapshot",
      missing: [],
    };
    try {
      if (req.needDom !== false) {
        const [injection] = await ext.scripting.executeScript({
          target: { tabId: req.tabId },
          world: "ISOLATED",
          func: readDomSnapshot,
        });
        const dom = injection?.result;
        if (dom) {
          bundle.url = dom.url;
          bundle.title = dom.title;
          bundle.dom = dom.html;
          bundle.frames = dom.frames;
          bundle.dataRequests = dom.dataRequests;
        }
      }
      // The network note names what IS visible when the snapshot succeeded:
      // URL-level data-request tallies (the Data requests section), still no
      // bodies. Both wordings keep the "network:" prefix the firefox/safari
      // wrappers filter on.
      bundle.missing.push(
        bundle.dataRequests
          ? "network: request/response bodies not captured — the Data requests section tallies fetch/XHR activity per host from the resource timeline only"
          : "network: not captured — the snapshot backend cannot see requests",
        "console: not captured — the snapshot backend cannot read page logs",
      );
      if (req.needDom !== false) {
        bundle.missing.push(
          "dom: closed shadow roots and cross-origin iframe contents not included (ISOLATED-world snapshot)",
        );
      }
      // The honesty convention: an absent frames field always carries a note,
      // so "not collected" never reads as "the page has no iframes".
      if (!bundle.frames) {
        bundle.missing.push("frames: not captured — the frame inventory is collected with the DOM snapshot");
      }

      if ((req.needScreenshot ?? "visible") === "visible") {
        if (!(ext.tabs?.captureVisibleTab instanceof Function)) {
          bundle.missing.push(`screenshot: ${platformReason(BROWSER_TARGET, "visibleTabCapture")}`);
          return { ok: true, bundle };
        }
        const tab = await ext.tabs.get(req.tabId);
        if (!bundle.url) {
          bundle.url = tab.url ?? "";
          bundle.title = tab.title ?? "";
        }
        // captureVisibleTab only sees the window's active tab — capturing a
        // background tab would silently picture the wrong page.
        if (tab.active) {
          try {
            const dataUrl = await captureVisibleTabPastQuota(tab.windowId);
            bundle.screenshot = { dataUrl, coverage: "visible" };
            bundle.missing.push("screenshot: visible viewport only — content below the fold not included");
          } catch (error) {
            // A screenshot problem must not discard a good DOM snapshot —
            // degrade honestly instead of failing the whole capture.
            bundle.missing.push(`screenshot: not captured — ${String(error)}`);
          }
        } else {
          bundle.missing.push("screenshot: skipped — tab is not the active tab in its window");
        }
      }

      return { ok: true, bundle };
    } catch (error) {
      return { ok: false, reason: "failed", message: `snapshot capture failed: ${String(error)}` };
    }
  }
}
