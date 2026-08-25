// Firefox observation backend: DOM snapshot + visible screenshot, augmented
// with network response bodies observed via webRequest.filterResponseData —
// Firefox's own API (no Chrome equivalent) that hands the extension each
// response's byte stream during a controlled reload. The stream is always
// written through unchanged; observation never alters what the page loads.

import type { CaptureBundle, NetworkEntry } from "../../shared/capture.js";
import { ext } from "../ext.js";
import { SnapshotBackend } from "./snapshot.js";
import type { CaptureRequest, CaptureResult, ObservationBackend, ObservationProvides } from "./types.js";

const LOAD_TIMEOUT_MS = 12_000;
const SETTLE_MS = 800;
const BODY_LIMIT = 64 * 1024;

interface FirefoxStreamFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  write(data: ArrayBuffer): void;
  close(): void;
  disconnect(): void;
}

interface FirefoxWebRequestApi {
  filterResponseData?(requestId: string): FirefoxStreamFilter;
}

interface CapturedNetworkEntry extends NetworkEntry {
  requestId: string;
}

export class FirefoxObservationBackend implements ObservationBackend {
  readonly kind = "firefox";
  readonly provides: ObservationProvides = {
    dom: true,
    screenshot: "visible",
    network: true,
    console: false,
    evaluate: false,
  };

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const entries = new Map<string, CapturedNetworkEntry>();
    const filters = new Set<FirefoxStreamFilter>();
    // SAFETY: Firefox exposes filterResponseData on the same webRequest object as Chrome's compatible API.
    const webRequest = ext.webRequest as typeof chrome.webRequest & FirefoxWebRequestApi;
    const canCaptureBodies = webRequest.filterResponseData !== undefined;

    const onBeforeRequest = (details: chrome.webRequest.WebRequestBodyDetails): void => {
      if (!req.needNetwork || details.tabId !== req.tabId) return;
      const entry: CapturedNetworkEntry = {
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        status: 0,
        mimeType: "",
      };
      entries.set(details.requestId, entry);
      if (!canCaptureBodies) return;

      const filter = webRequest.filterResponseData!(details.requestId);
      filters.add(filter);
      const decoder = new TextDecoder();
      let body = "";
      let seenBytes = 0;
      filter.ondata = (event) => {
        try {
          if (seenBytes < BODY_LIMIT) {
            const remaining = BODY_LIMIT - seenBytes;
            const bytes = new Uint8Array(event.data);
            body += decoder.decode(bytes.subarray(0, remaining), { stream: true });
          }
          seenBytes += event.data.byteLength;
          filter.write(event.data);
        } catch {
          filter.disconnect();
        }
      };
      filter.onstop = () => {
        if (seenBytes <= BODY_LIMIT) body += decoder.decode();
        if (body) entry.body = body;
        if (seenBytes > BODY_LIMIT) entry.bodyTruncated = true;
        filters.delete(filter);
        filter.close();
      };
      filter.onerror = () => {
        filters.delete(filter);
        filter.disconnect();
      };
    };

    const onHeadersReceived = (details: chrome.webRequest.WebResponseHeadersDetails): void => {
      const entry = entries.get(details.requestId);
      if (!entry) return;
      entry.status = details.statusCode;
      entry.mimeType =
        details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value?.split(";")[0] ??
        "";
    };

    try {
      if (req.needNetwork) {
        webRequest.onBeforeRequest.addListener(
          onBeforeRequest,
          { urls: ["<all_urls>"], tabId: req.tabId },
          ["blocking"],
        );
        webRequest.onHeadersReceived.addListener(
          onHeadersReceived,
          { urls: ["<all_urls>"], tabId: req.tabId },
          ["responseHeaders"],
        );
        await reloadAndWait(req.tabId);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        await waitForFilters(filters, 1_000);
      }

      const snapshot = await new SnapshotBackend().capture({
        ...req,
        needScreenshot: req.needScreenshot === "full" ? "visible" : req.needScreenshot,
        needNetwork: false,
        needConsole: false,
      });
      if (!snapshot.ok) return snapshot;

      const bundle: CaptureBundle = {
        ...snapshot.bundle,
        producedBy: "firefox",
        missing: snapshot.bundle.missing.filter(
          (message) => !message.startsWith("network:") && !message.startsWith("console:"),
        ),
      };
      if (req.needNetwork) {
        bundle.network = [...entries.values()].map(({ requestId: _requestId, ...entry }) => {
          if (!/json|text|javascript|xml|html|svg/.test(entry.mimeType)) {
            delete entry.body;
            delete entry.bodyTruncated;
          }
          return entry;
        });
        if (filters.size > 0) {
          bundle.missing.push("network bodies: some responses were still streaming when capture finished");
        }
        if (!canCaptureBodies) {
          bundle.missing.push(
            "network bodies: unavailable because this Firefox runtime does not expose webRequest.filterResponseData",
          );
        }
      } else {
        bundle.missing.push("network: not requested");
      }
      if (req.needConsole) {
        bundle.missing.push("console: Firefox WebExtensions do not expose page console history");
      }
      if (req.needScreenshot === "full") {
        bundle.missing.push("screenshot: Firefox capture is limited to the visible viewport");
      }
      return { ok: true, bundle };
    } catch (error) {
      return { ok: false, reason: "failed", message: `Firefox capture failed: ${String(error)}` };
    } finally {
      if (req.needNetwork) {
        webRequest.onBeforeRequest.removeListener(onBeforeRequest);
        webRequest.onHeadersReceived.removeListener(onHeadersReceived);
      }
    }
  }
}

async function waitForFilters(filters: Set<FirefoxStreamFilter>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (filters.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reloadAndWait(tabId: number): Promise<void> {
  let resolveLoaded = (): void => {};
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });
  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
    if (updatedTabId === tabId && changeInfo.status === "complete") resolveLoaded();
  };
  ext.tabs.onUpdated.addListener(onUpdated);
  try {
    await ext.tabs.reload(tabId);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))]);
  } finally {
    ext.tabs.onUpdated.removeListener(onUpdated);
  }
}
