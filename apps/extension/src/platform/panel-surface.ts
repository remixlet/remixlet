// Where the shared panel document opens, per browser. The panel is one HTML
// document (panel/index.html); browsers differ in which surface can host it:
// Chrome's sidePanel API, Firefox's sidebarAction sidebar, a plain popup
// window on Safari, and — for Chromium browsers whose sidePanel.open
// silently no-ops (Arc) — an injected in-page drawer
// (drawer-host-content.ts). This module hides that behind one PanelSurface
// interface: open() places the panel and reports which window owns it.
// Consumers: the popup, onboarding, and the worker's action handler.

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
export const DRAWER_STATE_PREFIX = "remixletDrawer:";

// Whether THIS browser's sidePanel.open produces a real surface is a fixed
// property of the browser (Chrome: yes; Arc: silently no), but it can only be
// learned by observation. The observation is a FACT the panel document itself
// reports — panel/main.tsx announces its arrival and the worker resolves which
// surface it landed in (confirmSidePanelSurface below).
//
// A timeout is never evidence that a browser lacks a side panel. The earlier
// version polled runtime.getContexts from whichever context called open(), and
// that context is usually the toolbar popup — which Chrome destroys the moment
// the side panel takes focus, mid-poll. So real Chrome rarely recorded
// "works", every click re-probed, and the first slow panel boot put the side
// panel AND the drawer on screen together and persisted "this browser has no
// side panel" forever. Hence the three rules here: only a live panel writes
// `true`, only a resolved-but-silent open() writes `false`, and open() is
// still attempted under a `false` verdict so a wrong one heals on the next
// click instead of latching for the life of the profile.
const SIDE_PANEL_VERDICT_KEY = "remixletSidePanelWorks";

// How long open() waits for that announcement before putting the drawer on
// screen. Unknown browser: long enough for a cold panel boot. Browser already
// believed to be a no-op: short, but never zero — a stale `false` must not put
// two surfaces on screen at once, which is the failure users actually notice.
const ANNOUNCE_GRACE_MS = 2500;
const ANNOUNCE_GRACE_AFTER_NO_OP_MS = 600;

async function readSidePanelVerdict(): Promise<boolean | undefined> {
  const stored = await ext.storage.local.get(SIDE_PANEL_VERDICT_KEY).catch(() => ({}));
  const value = Object.getOwnPropertyDescriptor(stored, SIDE_PANEL_VERDICT_KEY)?.value;
  return value === true || value === false ? value : undefined;
}

async function writeSidePanelVerdict(works: boolean): Promise<void> {
  await ext.storage.local.set({ [SIDE_PANEL_VERDICT_KEY]: works }).catch(() => {});
}

interface DrawerState {
  windowId: number;
  conversationId: string;
  /**
   * A per-drawer secret placed in the drawer's panel URL (`?nonce=`) and here
   * in session state. active-tab.ts honors the `?tabId=` only when the URL's
   * nonce matches this stored one, so a hostile page that frames the panel and
   * passes a bare `?tabId=` cannot pin the worker to someone else's tab (H3).
   */
  nonce: string;
}

export interface PanelSurface {
  readonly kind: "side-panel" | "sidebar" | "popup" | "unavailable";
  readonly available: boolean;
  readonly disabledReason?: string;
  /** Opens/focuses the surface and identifies the window that owns the panel document. */
  open(windowId?: number, tabId?: number): Promise<{ targetWindowId: number }>;
}

class ChromePanelSurface implements PanelSurface {
  readonly kind = "side-panel";
  readonly available = true;

  async open(windowId?: number, tabId?: number): Promise<{ targetWindowId: number }> {
    if (windowId === undefined) throw new Error("The Chrome side panel needs a browser window.");
    const verdict = await readSidePanelVerdict();
    if (verdict === true) {
      // Confirmed real side panel: it either opens or the caller gets the
      // error. Falling back to the drawer here is what put two panels on
      // screen at once.
      await ext.sidePanel.open({ windowId });
      if (tabId !== undefined) void dismissDrawerPanel(tabId);
      return { targetWindowId: windowId };
    }
    // Unknown, or believed to be a no-op: ask for the side panel either way, so
    // the panel document always gets the chance to prove the verdict wrong.
    // Armed before open() — a panel that boots faster than this code must not
    // be missed.
    const announced = watchForPanelAnnouncement();
    let resolved = false;
    try {
      await ext.sidePanel.open({ windowId });
      resolved = true;
    } catch {
      // A rejection means no panel is coming from THIS call, but says nothing
      // about the browser (Arc rejects; Chrome also rejects outside a user
      // gesture, e.g. openSiteTabWithPanel's post-tabs.create call). Fall back
      // immediately, record nothing.
    }
    // A rejection ends the wait immediately — no panel is coming from this
    // call, so there is nothing to wait for. The waiter still runs, so the
    // announcement listener is always released.
    const grace = !resolved ? 0 : verdict === false ? ANNOUNCE_GRACE_AFTER_NO_OP_MS : ANNOUNCE_GRACE_MS;
    if (await announced(grace)) {
      if (tabId !== undefined) void dismissDrawerPanel(tabId);
      return { targetWindowId: windowId };
    }
    // open() resolved and no panel ever announced itself — the Arc signature.
    if (resolved) await writeSidePanelVerdict(false);
    if (tabId !== undefined) return openDrawerPanel(tabId, windowId);
    return openPopupPanel();
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
 * Listens for the panel's own announcement, then hands back a waiter. Split in
 * two so callers arm the listener BEFORE sidePanel.open(); the waiter re-reads
 * storage as well, covering an announcement that landed in the gap.
 */
function watchForPanelAnnouncement(): (graceMs: number) => Promise<boolean> {
  let announced = false;
  let wake: (() => void) | undefined;
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local" || changes[SIDE_PANEL_VERDICT_KEY]?.newValue !== true) return;
    announced = true;
    wake?.();
  };
  ext.storage.onChanged.addListener(onChanged);
  return async (graceMs: number): Promise<boolean> => {
    try {
      if (announced || (await readSidePanelVerdict()) === true) return true;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, graceMs);
      });
      return announced || (await readSidePanelVerdict()) === true;
    } finally {
      ext.storage.onChanged.removeListener(onChanged);
    }
  };
}

/**
 * A panel document reporting the surface it landed in — the only thing that
 * can record a working side panel. The worker calls this for every panel that
 * says hello (worker/index.ts, "panel.hello"), passing whether the sender was a
 * browser-owned sidebar rather than a tab.
 */
export async function confirmSidePanelSurface(isBrowserSidebar: boolean): Promise<void> {
  if (!isBrowserSidebar || !("sidePanel" in ext)) return;
  if ((await readSidePanelVerdict()) === true) return;
  await writeSidePanelVerdict(true);
  // Reaching here means the verdict was wrong until a moment ago, so every
  // drawer this profile has is a leftover of that mistake.
  await dismissAllDrawerPanels();
}

async function dismissAllDrawerPanels(): Promise<void> {
  const stored = await ext.storage.session.get(null).catch(() => ({}));
  for (const key of Object.keys(stored)) {
    if (!key.startsWith(DRAWER_STATE_PREFIX)) continue;
    const tabId = Number(key.slice(DRAWER_STATE_PREFIX.length));
    if (Number.isInteger(tabId) && tabId >= 0) await dismissDrawerPanel(tabId);
    else await ext.storage.session.remove(key).catch(() => {});
  }
}

async function openDrawerPanel(tabId: number, windowId: number): Promise<{ targetWindowId: number }> {
  const tab = await ext.tabs.get(tabId);
  // pendingUrl covers a tab created moments ago whose first navigation has
  // not committed yet (the manager sidebar's "+" path).
  const url = tab.url || tab.pendingUrl;
  if (!url || !/^https?:/.test(url)) {
    // Extension-owned onboarding/manager pages cannot host an injected
    // drawer. Their settings/import flows stay in a browser-owned window.
    return openPopupPanel();
  }
  const key = drawerStateKey(tabId);
  const stored = await ext.storage.session.get(key);
  // SAFETY: drawer state is written only by openDrawerPanel under this exact storage key.
  const existing = stored[key] as Partial<DrawerState> | undefined;
  const state: DrawerState = {
    windowId,
    conversationId:
      isString(existing?.conversationId) && /^[A-Za-z0-9-]+$/.test(existing.conversationId)
        ? existing.conversationId
        : crypto.randomUUID(),
    nonce:
      isString(existing?.nonce) && /^[A-Za-z0-9-]+$/.test(existing.nonce)
        ? existing.nonce
        : crypto.randomUUID(),
  };
  await ext.storage.session.set({ [key]: state });
  try {
    await injectDrawerPanel(tabId, state.conversationId, state.nonce);
  } catch (error) {
    // A still-loading tab cannot host the drawer yet. The state is already
    // stored, so the worker's webNavigation.onCompleted restore injects it
    // the moment the page lands — only a loaded page that refused the
    // drawer is a real failure.
    if (tab.status === "complete") throw error;
  }
  return { targetWindowId: windowId };
}

async function injectDrawerPanel(tabId: number, conversationId: string, nonce: string): Promise<void> {
  // getURL returns the rotating dynamic URL (the panel WAR entry sets
  // use_dynamic_url), so a hostile page cannot frame a guessable panel URL.
  const panelUrl = new URL(ext.runtime.getURL(PANEL_PATH));
  panelUrl.searchParams.set("surface", "drawer");
  panelUrl.searchParams.set("tabId", String(tabId));
  panelUrl.searchParams.set("conversationId", conversationId);
  panelUrl.searchParams.set("nonce", nonce);

  await ext.scripting.executeScript({
    target: { tabId },
    files: ["drawer-host.js"],
    world: "ISOLATED",
  });
  // SAFETY: drawer-host sends this exact reply shape after handling remixlet.drawer.open.
  const reply = (await ext.tabs.sendMessage(tabId, {
    kind: "remixlet.drawer.open",
    panelUrl: panelUrl.href,
  })) as { ok?: boolean } | undefined;
  if (!reply?.ok) throw new Error("The page did not accept the Remixlet drawer.");
}

/**
 * Create a tab at `url` and open the panel alongside it — the manager
 * sidebar's "+" action. Sequencing differs per surface: Firefox's
 * sidebarAction.open() is only valid before the first await inside the user
 * gesture, while every other surface needs the created tab's ids first.
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
  await surface.open(tab.windowId, tab.id);
}

/** Removes a tab's drawer (host element + session state), if it has one. A
 * confirmed side panel calls this so a drawer left behind by an earlier
 * mis-detection cannot stay on screen alongside it. */
export async function dismissDrawerPanel(tabId: number): Promise<void> {
  await ext.tabs.sendMessage(tabId, { kind: "remixlet.drawer.close" }).catch(() => {});
  await clearDrawerPanelState(tabId).catch(() => {});
}

export async function restoreDrawerPanel(tabId: number, windowId: number): Promise<boolean> {
  // On a browser with a working side panel the drawer must never resurface;
  // any stored drawer state is a leftover from before the verdict was known.
  if ((await readSidePanelVerdict()) === true) {
    await clearDrawerPanelState(tabId).catch(() => {});
    return false;
  }
  const key = drawerStateKey(tabId);
  const stored = await ext.storage.session.get(key);
  // SAFETY: drawer state is written only by openDrawerPanel under this exact storage key.
  const state = stored[key] as Partial<DrawerState> | undefined;
  if (
    state?.windowId !== windowId ||
    !isString(state.conversationId) ||
    !/^[A-Za-z0-9-]+$/.test(state.conversationId) ||
    !isString(state.nonce) ||
    !/^[A-Za-z0-9-]+$/.test(state.nonce)
  ) {
    return false;
  }
  const tab = await ext.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) return false;
  await injectDrawerPanel(tabId, state.conversationId, state.nonce);
  return true;
}

export async function clearDrawerPanelState(tabId: number): Promise<void> {
  await ext.storage.session.remove(drawerStateKey(tabId));
}

function drawerStateKey(tabId: number): string {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("drawer state needs a valid tab");
  return `${DRAWER_STATE_PREFIX}${tabId}`;
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

function isString(value: string | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
