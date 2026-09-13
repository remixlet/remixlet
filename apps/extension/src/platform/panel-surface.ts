// Where the shared panel document opens, per browser. The panel is one HTML
// document (panel/index.html); browsers differ in which surface can host it:
// Chromium's sidePanel API, Firefox's sidebarAction sidebar, and a plain
// popup window on Safari. Chromium browsers whose sidePanel.open resolves
// without showing a real surface (Arc) are unsupported — the in-page drawer
// fallback that once covered them was removed
// (wiki/decisions/drop-drawer-panel-fallback.md). This module hides the
// per-browser difference behind one PanelSurface interface: open() places the
// panel and reports which window owns it. Consumers: the popup, onboarding,
// and the worker's command handler.

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason } from "./capability-reasons.js";

interface FirefoxSidebarAction {
  open(): Promise<void>;
}

interface ExtWithSidebar {
  sidebarAction?: FirefoxSidebarAction;
}

interface PopupWindowsApi {
  getAll(options: { populate: true }): Promise<chrome.windows.Window[]>;
  update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>;
  create(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
}

interface ExtWithPopupWindows {
  windows?: Partial<PopupWindowsApi>;
}

const PANEL_PATH = "panel/index.html";

export interface PanelSurface {
  readonly kind: "side-panel" | "sidebar" | "popup" | "unavailable";
  readonly available: boolean;
  readonly disabledReason?: string;
  /** Opens/focuses the surface and identifies the window that owns the panel document. */
  open(windowId?: number): Promise<{ targetWindowId: number }>;
}

class ChromePanelSurface implements PanelSurface {
  readonly kind = "side-panel";
  readonly available = true;

  async open(windowId?: number): Promise<{ targetWindowId: number }> {
    if (windowId === undefined) throw new Error("The Chrome side panel needs a browser window.");
    // sidePanel.open demands a user gesture, so callers invoke this inside
    // one (popup click, ⌘J command, extension-page click). A rejection is
    // surfaced, not swallowed: on a supported browser it means the gesture
    // was spent, and that is a caller bug to hear about.
    await ext.sidePanel.open({ windowId });
    return { targetWindowId: windowId };
  }
}

class FirefoxPanelSurface implements PanelSurface {
  readonly kind = "sidebar";
  readonly available = true;

  async open(windowId?: number): Promise<{ targetWindowId: number }> {
    if (windowId === undefined) throw new Error("The Firefox sidebar needs a source browser window.");
    // Firefox deliberately accepts no window id and only permits this call in
    // a user-action handler (toolbar popup, command, or extension-page click).
    // SAFETY: Firefox exposes sidebarAction when panelSurface selected this browser surface.
    await (ext as ExtWithSidebar).sidebarAction!.open();
    return { targetWindowId: windowId };
  }
}

class PopupPanelSurface implements PanelSurface {
  readonly kind = "popup";
  readonly available = true;

  async open(): Promise<{ targetWindowId: number }> {
    return openPopupPanel("Safari did not return the panel popup window.");
  }
}

/**
 * Create a tab at `url` and open the panel alongside it — the manager
 * sidebar's "+" action. Sequencing differs per surface: Firefox's
 * sidebarAction.open() is only valid before the first await inside the user
 * gesture, while the other surfaces need the created tab's window first. On
 * Chromium the post-create sidePanel.open still sits inside the click's
 * transient-activation window.
 */
export async function openSiteTabWithPanel(url: string): Promise<void> {
  const surface = panelSurface();
  if (!surface.available) throw new Error(surface.disabledReason);
  if (surface.kind === "sidebar") {
    // SAFETY: the sidebar branch above establishes Firefox's sidebarAction surface.
    await (ext as ExtWithSidebar).sidebarAction!.open();
    await ext.tabs.create({ url });
    return;
  }
  const tab = await ext.tabs.create({ url });
  await surface.open(tab.windowId);
}

async function openPopupPanel(
  missingWindowReason = "The browser did not return the panel popup window.",
): Promise<{ targetWindowId: number }> {
  const panelUrl = ext.runtime.getURL(PANEL_PATH);
  const existing = (await ext.windows.getAll({ populate: true })).find((window) =>
    window.tabs?.some((tab) => tab.url === panelUrl),
  );
  if (existing?.id !== undefined) {
    await ext.windows.update(existing.id, { focused: true });
    return { targetWindowId: existing.id };
  }
  const created = await ext.windows.create({
    url: panelUrl,
    type: "popup",
    width: 420,
    height: 720,
    focused: true,
  });
  if (created?.id === undefined) throw new Error(missingWindowReason);
  return { targetWindowId: created.id };
}

class UnavailablePanelSurface implements PanelSurface {
  readonly kind = "unavailable";
  readonly available = false;
  readonly disabledReason = platformReason(BROWSER_TARGET, "panelSurface");

  async open(): Promise<{ targetWindowId: number }> {
    throw new Error(this.disabledReason);
  }
}

export function panelSurface(): PanelSurface {
  if ("sidePanel" in ext) return new ChromePanelSurface();
  // SAFETY: runtime feature detection below only reads Safari's optional sidebarAction namespace.
  const sidebarExt = ext as ExtWithSidebar;
  if (sidebarExt.sidebarAction?.open) return new FirefoxPanelSurface();
  // SAFETY: runtime feature detection below only reads Safari's optional windows namespace.
  const popupExt = ext as ExtWithPopupWindows;
  const windows = popupExt.windows;
  if (
    BROWSER_TARGET === "safari" &&
    windows?.getAll instanceof Function &&
    windows.update instanceof Function &&
    windows.create instanceof Function
  ) {
    return new PopupPanelSurface();
  }
  return new UnavailablePanelSurface();
}
