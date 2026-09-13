// Resolves, via the tabs/windows APIs, which browser page an extension
// surface (popup or panel) should act on. "The active tab" is not one lookup:
// most browsers attach an action popup to its owning browser window, but a
// detached popup window has no active tab in currentWindow, and the
// last-focused normal window is then the best representation of the page the
// popup was opened from. Consumers: the popup and the panel app/worker-client.

import { ext } from "./ext.js";

export interface ActiveBrowserTab {
  id: number;
  url: string;
  windowId: number;
}

function usableTab(tab: chrome.tabs.Tab | undefined): ActiveBrowserTab | undefined {
  if (tab?.id === undefined || tab.windowId === undefined || !tab.url) return undefined;
  return { id: tab.id, url: tab.url, windowId: tab.windowId };
}

/**
 * Whether a tab is hosting the panel document itself (Safari's popup-fallback
 * surface), so the agent never operates on its own UI. Matched by the
 * resource PATH, not a full getURL()-prefix, so it holds for any
 * extension-origin host the document is served under (test harness included).
 */
function isPanelDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome-extension:" && parsed.pathname === "/panel/index.html";
  } catch {
    return false;
  }
}

export async function resolveActiveBrowserTab(): Promise<ActiveBrowserTab | undefined> {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    const current = usableTab(tab);
    // A popup fallback hosts the panel in its own extension tab. That tab is
    // the UI surface, not the browser page the agent should operate on.
    if (current && !isPanelDocumentUrl(current.url)) return current;
  } catch {
    // A detached popup can have no meaningful current browser window. Fall
    // through to the normal-window lookup below.
  }

  try {
    const window = await ext.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    const active = usableTab(window.tabs?.find((tab) => tab.active));
    // Same rule as above: a panel hosted in a tab is the UI surface, never
    // the page to operate on. Better no answer than the panel itself.
    return active && !isPanelDocumentUrl(active.url) ? active : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring a tab forward: activate it in its window and focus that window, so
 * the page comes into view whichever window it lives in. A tab that has since
 * closed is a silent no-op — the caller's binding watcher reports the loss.
 */
export async function focusTab(tabId: number): Promise<void> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  if (tab?.id === undefined) return;
  await ext.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true });
}
