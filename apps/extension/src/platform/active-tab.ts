// Resolves, via the tabs/windows APIs, which browser page an extension
// surface (popup or panel) should act on. "The active tab" is not one lookup:
// most browsers attach an action popup to its owning browser window, but Arc
// can host that popup in a separate floating window — there currentWindow has
// no active tab, and the last-focused normal window is the best
// representation of the page the popup was opened from. A drawer-hosted panel
// instead pins its target tab via its ?tabId= query parameter, which wins
// when present. Consumers: the popup and the panel app/worker-client.

import { ext } from "./ext.js";
import { DRAWER_STATE_PREFIX } from "./panel-surface.js";

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
 * Whether a tab is hosting the panel document itself (the popup-fallback and
 * drawer surfaces), so the agent never operates on its own UI. Matched by the
 * resource PATH, not a full URL: the panel WAR entry uses use_dynamic_url, so
 * its framed URL carries a rotating GUID host — a getURL()-prefix check would
 * miss the static-host panel documents (side panel, popup, test harness).
 */
function isPanelDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome-extension:" && parsed.pathname === "/panel/index.html";
  } catch {
    return false;
  }
}

/**
 * Whether a `?tabId=` may be honored: only when the URL also carries the
 * `?nonce=` the worker stored in this tab's drawer session state (H3). A bare
 * `?tabId=` from a hostile frame has no matching nonce and is refused — the
 * caller falls through to the active-tab lookup instead of targeting the tab
 * the page named. A missing/empty stored nonce never matches.
 */
export function drawerTabAuthorized(nonceParam: string | null, storedNonce: string | undefined): boolean {
  return storedNonce !== undefined && storedNonce.length > 0 && nonceParam === storedNonce;
}

export async function resolveActiveBrowserTab(): Promise<ActiveBrowserTab | undefined> {
  // "location" in globalThis (rather than a direct reference) is deliberate:
  // this module also runs in the Node-based test harness, which has no global
  // location at all, and a bare reference there would throw ReferenceError.
  // SAFETY: the "location" in globalThis check just confirmed this property exists and is the standard Location global.
  const loc = "location" in globalThis ? (globalThis as { location: Location }).location : undefined;
  const params = loc?.protocol === "chrome-extension:" ? new URLSearchParams(loc.search) : undefined;
  const pinnedTabIdText = params?.get("tabId") ?? null;
  // Number(null) is 0, and tab 0 is a valid Chrome tab id. Treating an absent
  // query parameter as that id silently targets an unrelated tab instead of
  // the active page (the toolbar popup and Chrome side panel normally have no
  // tabId parameter at all).
  const pinnedTabId = pinnedTabIdText === null ? Number.NaN : Number(pinnedTabIdText);
  if (Number.isInteger(pinnedTabId) && pinnedTabId >= 0) {
    const key = `${DRAWER_STATE_PREFIX}${pinnedTabId}`;
    const stored = await ext.storage.session.get(key).catch(() => ({}));
    const value = Object.getOwnPropertyDescriptor(stored, key)?.value;
    const nonce = value instanceof Object ? Object.getOwnPropertyDescriptor(value, "nonce")?.value : undefined;
    if (drawerTabAuthorized(params?.get("nonce") ?? null, Object.prototype.toString.call(nonce) === "[object String]" ? nonce : undefined)) {
      const pinned = await ext.tabs.get(pinnedTabId).catch(() => undefined);
      const target = usableTab(pinned);
      if (target) return target;
    }
  }

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
