// SnapshotBackend — the Chrome observation path. Content-script DOM snapshot
// (ISOLATED world; host perms already <all_urls>) plus a visible-viewport
// screenshot. Needs no permission beyond what the base install carries.

import { SCREENSHOT_IDENTITY_CHANGED_MESSAGE, type CaptureBundle } from "../../shared/capture.js";
import { SENSITIVE_FIELD_SELECTOR } from "../../shared/sensitive-fields.js";
import { BROWSER_TARGET, ext } from "../ext.js";
import { platformReason } from "../capability-reasons.js";
import { readPageIdentity } from "../page-identity.js";
import type { CaptureRequest, CaptureResult, ObservationBackend, ObservationProvides } from "./types.js";

interface DomSnapshot {
  url: string;
  title: string;
  html: string;
  frames: { title: string; origin: string; rect: { x: number; y: number; width: number; height: number } }[];
  /** The document's page-load token, for the worker to match the network census against. */
  pageLoad: string;
}

/** Runs inside the page (ISOLATED world) — must stay self-contained. Exported for the browser test suite. */
export function readDomSnapshot(sensitiveFieldSelector: string): DomSnapshot {
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
  // The page-load token (shared/network-ids.ts PAGE_LOAD_TOKEN_GLOBAL):
  // minted here when this snapshot is the first extension read of the
  // document, read back by probes.js otherwise. The worker compares it with
  // the token the network census reports moments later, so a census of a
  // different document (the page reloaded between the two reads) is dropped
  // rather than attached to this DOM. Inlined, since this function is
  // serialised and can import nothing; capture.test.ts proves the two agree.
  // SAFETY: the token is the one property the extension owns on this world's global (shared/network-ids.ts).
  const holder = globalThis as { __rmxPageLoad?: string };
  let pageLoad = holder.__rmxPageLoad ?? "";
  if (pageLoad.length === 0) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    pageLoad = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    holder.__rmxPageLoad = pageLoad;
  }
  const root = document.documentElement;
  let html = root.outerHTML;
  if (root.querySelector(sensitiveFieldSelector) !== null) {
    const inert = document.implementation.createHTMLDocument("");
    const copy = inert.importNode(root, true);
    for (const field of copy.querySelectorAll(sensitiveFieldSelector)) field.setAttribute("value", "");
    html = copy.outerHTML;
  }
  return {
    url: location.href,
    title: document.title,
    html,
    frames,
    pageLoad,
  };
}

/**
 * Chrome rate-limits tabs.captureVisibleTab (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_
 * SECOND); back-to-back agent captures — e.g. a recapture right after the
 * one-click capability authorization, or the look review's capture right
 * after a verification capture — trip it. One short wait clears it. Exported
 * for the look review (worker/look-review.ts), which crops one of these PNGs
 * down to the element under review; it is the only other caller.
 */
export { SCREENSHOT_IDENTITY_CHANGED_MESSAGE };

export class ScreenshotIdentityChangedError extends Error {
  readonly code = "screenshot-identity-changed";

  constructor() {
    super(SCREENSHOT_IDENTITY_CHANGED_MESSAGE);
    this.name = "ScreenshotIdentityChangedError";
  }
}

interface ScreenshotCaptureGuard {
  capture(): Promise<string>;
  assertCurrent(): Promise<void>;
}

interface CaptureBaseline {
  windowId: number;
  url?: string;
  documentId?: string;
}

/**
 * Hold a visible-tab screenshot to one tab activation and one page load.
 * Event listeners stay live through the caller's crop/store work, so an
 * away-and-back switch cannot pass a simple before/after equality check.
 */
export async function withVisibleTabCaptureGuard<T>(
  tabId: number,
  run: (guard: ScreenshotCaptureGuard) => Promise<T>,
): Promise<T> {
  let baseline: CaptureBaseline | undefined;
  let changed = false;
  const changedError = (): ScreenshotIdentityChangedError => new ScreenshotIdentityChangedError();
  const markForTab = (candidateTabId: number): void => {
    if (candidateTabId === tabId) changed = true;
  };
  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (baseline === undefined || info.windowId === baseline.windowId) changed = true;
  };
  const onAttached = (candidateTabId: number): void => markForTab(candidateTabId);
  const onDetached = (candidateTabId: number): void => markForTab(candidateTabId);
  const onRemoved = (candidateTabId: number): void => markForTab(candidateTabId);
  const onUpdated = (candidateTabId: number, info: chrome.tabs.TabChangeInfo): void => {
    if (candidateTabId === tabId && (info.status === "loading" || info.url !== undefined)) changed = true;
  };
  const onNavigation = (info: { tabId: number; frameId: number }): void => {
    if (info.tabId === tabId && info.frameId === 0) changed = true;
  };

  ext.tabs.onActivated.addListener(onActivated);
  ext.tabs.onAttached.addListener(onAttached);
  ext.tabs.onDetached.addListener(onDetached);
  ext.tabs.onRemoved.addListener(onRemoved);
  ext.tabs.onUpdated.addListener(onUpdated);
  if ("webNavigation" in ext) {
    ext.webNavigation.onBeforeNavigate.addListener(onNavigation);
    ext.webNavigation.onCommitted.addListener(onNavigation);
    ext.webNavigation.onHistoryStateUpdated.addListener(onNavigation);
    ext.webNavigation.onReferenceFragmentUpdated.addListener(onNavigation);
  }

  const assertCurrent = async (): Promise<void> => {
    if (changed) throw changedError();
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    if (changed || tab === undefined || tab.windowId !== baseline?.windowId) throw changedError();
    const [active] = await ext.tabs.query({ active: true, windowId: baseline.windowId });
    if (changed || active?.id !== tabId || !tab.active) throw changedError();
    const page = await readPageIdentity(tabId);
    if (changed || page === undefined || page.url !== baseline.url) throw changedError();
    if (baseline.documentId !== undefined && page.documentId !== baseline.documentId) throw changedError();
  };

  try {
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined) throw changedError();
    const page = await readPageIdentity(tabId);
    baseline = { windowId: tab.windowId, url: page?.url ?? tab.url ?? tab.pendingUrl, documentId: page?.documentId };
    await assertCurrent();
    const captureWindowId = baseline.windowId;

    const captureAttempt = async (): Promise<string> => {
      await assertCurrent();
      let shot: string;
      try {
        shot = await ext.tabs.captureVisibleTab(captureWindowId, { format: "png" });
      } catch (error) {
        await assertCurrent();
        throw error;
      }
      await assertCurrent();
      return shot;
    };
    const guard: ScreenshotCaptureGuard = {
      assertCurrent,
      async capture() {
        try {
          return await captureAttempt();
        } catch (error) {
          if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 600));
          await assertCurrent();
          return captureAttempt();
        }
      },
    };
    const result = await run(guard);
    await assertCurrent();
    return result;
  } finally {
    ext.tabs.onActivated.removeListener(onActivated);
    ext.tabs.onAttached.removeListener(onAttached);
    ext.tabs.onDetached.removeListener(onDetached);
    ext.tabs.onRemoved.removeListener(onRemoved);
    ext.tabs.onUpdated.removeListener(onUpdated);
    if ("webNavigation" in ext) {
      ext.webNavigation.onBeforeNavigate.removeListener(onNavigation);
      ext.webNavigation.onCommitted.removeListener(onNavigation);
      ext.webNavigation.onHistoryStateUpdated.removeListener(onNavigation);
      ext.webNavigation.onReferenceFragmentUpdated.removeListener(onNavigation);
    }
  }
}

export function captureVisibleTabForTab(tabId: number): Promise<string> {
  return withVisibleTabCaptureGuard(tabId, (guard) => guard.capture());
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
    let pageLoad: string | undefined;
    try {
      if (req.needDom !== false) {
        const [injection] = await ext.scripting.executeScript({
          target: { tabId: req.tabId },
          world: "ISOLATED",
          func: readDomSnapshot,
          args: [SENSITIVE_FIELD_SELECTOR],
        });
        const dom = injection?.result;
        if (dom) {
          bundle.url = dom.url;
          bundle.title = dom.title;
          bundle.dom = dom.html;
          bundle.frames = dom.frames;
          pageLoad = dom.pageLoad;
        }
      }
      // The network note names what IS visible: the worker attaches the Data
      // endpoints census after this snapshot (worker/network-ids.ts), still no
      // bodies. The wording keeps the "network:" prefix the firefox/safari
      // wrappers filter on.
      bundle.missing.push(
        "network: request/response bodies not captured; the Data endpoints section lists the page's fetch/XHR endpoints from the resource timeline, with ids and no URLs",
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
          return { ok: true, bundle, pageLoad };
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
            const dataUrl = await captureVisibleTabForTab(req.tabId);
            bundle.screenshot = { dataUrl, coverage: "visible" };
            bundle.missing.push("screenshot: visible viewport only — content below the fold not included");
          } catch (error) {
            // A screenshot problem must not discard a good DOM snapshot —
            // degrade honestly instead of failing the whole capture.
            bundle.missing.push(
              error instanceof ScreenshotIdentityChangedError
                ? `screenshot: ${SCREENSHOT_IDENTITY_CHANGED_MESSAGE}`
                : `screenshot: not captured — ${String(error)}`,
            );
          }
        } else {
          bundle.missing.push("screenshot: skipped — tab is not the active tab in its window");
        }
      }

      return { ok: true, bundle, pageLoad };
    } catch (error) {
      return { ok: false, reason: "failed", message: `snapshot capture failed: ${String(error)}` };
    }
  }
}
