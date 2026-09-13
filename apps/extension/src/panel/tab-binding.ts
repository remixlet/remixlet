// Conversation↔tab binding: which browser tab this conversation's agent works
// on. The binding is set once — at the first message, at resume, or by an
// explicit user click — and every tool resolves through it, so the user can
// switch tabs while the agent keeps working on the right one. Tools never
// follow the user's focus: after the bound tab closes (or a resumed
// conversation finds no tab on its site) the binding refuses to resolve until
// an explicit rebind, instead of silently retargeting whatever is active.
//
// One instance per conversation, owned by the panel app; the tool belt
// (tools/index.ts) receives it and calls target() per tool call.
//
// A bound tab can also stop showing the page it was bound to, which is a
// different event from being closed: the user types a new address into it, a
// link replaces it, or the site redirects. That used to produce a NOTE asking
// the model to stop, appended to the page content it had already read. It is
// now a refusal (shared/page-binding.ts holds the comparison; the worker runs
// it again as the authority) plus an on-screen card, raised the moment the
// navigation commits rather than at the agent's next tool call.

import { resolveActiveBrowserTab } from "../platform/active-tab.js";
import { ext } from "../platform/ext.js";
import { readPageIdentity, watchTopFrameNavigation } from "../platform/page-identity.js";
import { type BoundPage, type PageIdentity, comparePage, pageOrigin } from "../shared/page-binding.js";
import { siteKeyForUrl, urlWithinSiteKey } from "../shared/site-key.js";

/** The chip's render model — everything the panel shows about the binding. */
export interface BoundTab {
  tabId: number;
  /** Site the conversation works on, recorded at bind time; a move is measured against it. */
  siteKey: string;
  /** Scheme + host + port of the bound page, refreshed as the tab moves within the site. */
  origin: string;
  /** The bound page's load id, refreshed the same way. Absent where the browser reports none. */
  documentId?: string;
  title: string;
  favIconUrl?: string;
}

export interface TargetTab {
  tabId: number;
  url?: string;
  /**
   * The bound page as the worker must see it — sent with every read so the
   * worker can refuse independently of this check (worker/page-binding.ts).
   */
  page: BoundPage;
}

/** The tab fields the binding reads; structural so tests can inject fakes. */
export interface TabInfo {
  id?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  active?: boolean;
}

export interface TabBindingDeps {
  getTab(tabId: number): Promise<TabInfo>;
  queryTabs(): Promise<TabInfo[]>;
  resolveActiveTab(): Promise<{ id: number; url: string } | undefined>;
  /** What the tab shows right now, named per page load where the browser can. */
  readIdentity(tabId: number): Promise<PageIdentity | undefined>;
  /** Committed top-frame navigations on one tab; returns the unsubscribe. */
  watchNavigation(tabId: number, onNavigated: (identity: PageIdentity) => void): () => void;
}

export interface TabBindingEvents {
  /** Every bind/unbind/refresh — the panel chip renders from this. */
  onChange?(bound: BoundTab | undefined): void;
  /** target() found the bound tab gone. The panel shows its rebind card. */
  onLost?(previous: BoundTab): void;
  /**
   * The bound tab left the conversation's site. The panel shows the recovery
   * card and drops the approvals that were given for the page being left.
   * Fired on the navigation itself, and again if a tool call finds the move
   * first (a panel that opened after the fact has no navigation to watch).
   */
  onMoved?(previous: BoundTab, currentSiteKey: string): void;
  /**
   * The bound tab is showing the conversation's site again. Nothing was
   * repaired by hand: the user navigated back, so the card comes down and
   * tools resolve again. Approvals dropped by onMoved stay dropped.
   */
  onReturned?(bound: BoundTab): void;
}

/** Thrown by target() when the bound tab is no longer showing the bound page. */
export class PageMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageMovedError";
  }
}

export type ResumeBindOutcome =
  /** A tab on the conversation's site was found and bound. */
  | "bound"
  /** The conversation has a site but no open tab is on it — explicit rebind required. */
  | "no-site-tab"
  /** No site expectation and no usable tab; the first message will bind lazily. */
  | "unbound";

const CLOSED_TAB_MESSAGE =
  "The tab this conversation was working on is closed. Tell the user — the panel offers a button to point this chat at their current tab.";

const noSiteTabMessage = (siteKey: string): string =>
  `No open tab is on ${siteKey} — the site this conversation was working on. Ask the user to open it, or to point this chat at another tab with the panel's button.`;

function defaultDeps(): TabBindingDeps {
  return {
    getTab: (tabId) => ext.tabs.get(tabId),
    queryTabs: () => ext.tabs.query({}),
    resolveActiveTab: () => resolveActiveBrowserTab(),
    readIdentity: (tabId) => readPageIdentity(tabId),
    watchNavigation: (tabId, onNavigated) => watchTopFrameNavigation(tabId, onNavigated),
  };
}

function safeSiteKey(url: string | undefined): string {
  if (url === undefined || !/^https?:/.test(url)) return "";
  try {
    return siteKeyForUrl(url);
  } catch {
    return "";
  }
}

export class TabBinding {
  readonly #deps: TabBindingDeps;
  readonly #events: TabBindingEvents;
  #bound: BoundTab | undefined;
  /** Set after a loss or an empty resume: lazy binding is off, only an explicit rebind clears it. */
  #refuseLazyBind: string | undefined;
  #lazyBindInFlight: Promise<BoundTab | undefined> | undefined;
  /** True between a move being reported and the tab coming back — one card, one clear. */
  #moved = false;
  /** Unsubscribe for the bound tab's navigation watch; re-armed by every bind. */
  #unwatch: (() => void) | undefined;

  constructor(events: TabBindingEvents = {}, deps: TabBindingDeps = defaultDeps()) {
    this.#deps = deps;
    this.#events = events;
  }

  get bound(): BoundTab | undefined {
    return this.#bound;
  }

  /**
   * Explicit bind to a known tab id (the rebind card's open-site button,
   * tests). No-op when the tab is unreadable. `siteKey` records the intended
   * site as the baseline when the tab was just created and its URL hasn't
   * committed yet — deriving from the empty URL would record "" and turn the
   * check off for the conversation.
   */
  async bindTab(tabId: number, siteKey?: string): Promise<BoundTab | undefined> {
    const tab = await this.#deps.getTab(tabId).catch(() => undefined);
    if (tab?.id === undefined) return undefined;
    const bound = this.#setBound(tab, siteKey);
    // Which page LOAD, not just which URL: without it a reload cannot be told
    // from a re-read. Best-effort — a tab that cannot report one binds anyway
    // and is held to its site alone.
    const identity = await this.#deps.readIdentity(tab.id).catch(() => undefined);
    if (identity?.documentId !== undefined && this.#bound?.tabId === bound.tabId) {
      this.#bound = { ...this.#bound, documentId: identity.documentId, origin: pageOrigin(identity.url) || bound.origin };
    }
    return this.#bound ?? bound;
  }

  /** Explicit bind to the user's current tab — the rebind button, and the lazy first-message bind. */
  async bindActiveTab(): Promise<BoundTab | undefined> {
    const active = await this.#deps.resolveActiveTab().catch(() => undefined);
    // Browser and extension pages never bind: no tool can touch them, so a
    // chat started there would fail on every step. The composer refuses such
    // pages up front (panel app); this is the backstop for a stale gate.
    if (!active || !/^https?:/.test(active.url)) return undefined;
    return this.bindTab(active.id);
  }

  /**
   * Resume-time bind for a conversation whose site is known: the user's
   * current tab when it is on the site, otherwise any open tab on the site,
   * otherwise nothing — resolving to a wrong-site tab is never an option.
   */
  async bindForResume(siteKey: string): Promise<ResumeBindOutcome> {
    const site = siteKey.trim();
    if (site === "") {
      return (await this.bindActiveTab()) ? "bound" : "unbound";
    }
    const active = await this.#deps.resolveActiveTab().catch(() => undefined);
    if (active && urlWithinSiteKey(active.url, site) && (await this.bindTab(active.id))) return "bound";
    // SAFETY: queryTabs resolves TabInfo[]; the fallback models its failed empty result.
    const tabs = await this.#deps.queryTabs().catch(() => [] as TabInfo[]);
    for (const tab of tabs) {
      if (tab.id === undefined || tab.url === undefined || !/^https?:/.test(tab.url)) continue;
      if (urlWithinSiteKey(tab.url, site) && (await this.bindTab(tab.id))) return "bound";
    }
    this.#refuseLazyBind = noSiteTabMessage(site);
    return "no-site-tab";
  }

  /**
   * The bound tab, binding lazily to the current tab on first use (a fresh
   * conversation's first message). After a loss or an empty resume this
   * rejects instead — only an explicit rebind may retarget.
   */
  ensureBound(): Promise<BoundTab | undefined> {
    if (this.#bound) return Promise.resolve(this.#bound);
    if (this.#refuseLazyBind !== undefined) return Promise.reject(new Error(this.#refuseLazyBind));
    this.#lazyBindInFlight ??= this.bindActiveTab().finally(() => {
      this.#lazyBindInFlight = undefined;
    });
    return this.#lazyBindInFlight;
  }

  /**
   * Resolve the tab a tool call should act on. Throws with a model-readable
   * message when no tab can be resolved, and refuses outright when the bound
   * tab has left the conversation's page — the refusal a note used to be.
   *
   * Deliberately NOT sticky: the verdict is recomputed from the live page
   * every call, so a user who wanders off in that tab and comes back before
   * the agent's next step never sees a card and never has to rebind.
   */
  async target(): Promise<TargetTab> {
    const bound = await this.ensureBound();
    if (!bound) throw new Error("No page tab is available to work on — ask the user to open the page in a browser tab.");
    const tab = await this.#deps.getTab(bound.tabId).catch(() => undefined);
    if (tab?.id === undefined) {
      this.#bound = undefined;
      this.#refuseLazyBind = CLOSED_TAB_MESSAGE;
      this.#events.onChange?.(undefined);
      this.#events.onLost?.(bound);
      throw new Error(CLOSED_TAB_MESSAGE);
    }
    // Keep the chip honest as the tab navigates; the bound siteKey stays put
    // (it is the baseline a move is measured against, re-derived only by an
    // explicit rebind).
    if ((tab.title ?? "") !== bound.title || tab.favIconUrl !== bound.favIconUrl) {
      this.#bound = { ...bound, title: tab.title ?? "", favIconUrl: tab.favIconUrl };
      this.#events.onChange?.(this.#bound);
    }
    const identity = (await this.#deps.readIdentity(tab.id).catch(() => undefined)) ?? { url: tab.url };
    const verdict = comparePage(boundPage(this.#bound ?? bound), identity);
    if (verdict.kind === "moved") {
      // The watcher usually got here first; when the panel opened after the
      // move there was no navigation to watch, so raise the card from here.
      this.#reportMoved(verdict.siteKey);
      throw new PageMovedError(verdict.message);
    }
    if (verdict.kind === "same-site") this.#refreshPage(verdict);
    return { tabId: tab.id, url: identity.url ?? tab.url, page: boundPage(this.#bound ?? bound) };
  }

  /**
   * Stop watching. The panel calls this when it swaps the binding for a new or
   * resumed conversation; a binding that is merely retargeted re-subscribes on
   * its own.
   */
  dispose(): void {
    this.#unwatch?.();
    this.#unwatch = undefined;
  }

  /**
   * Watch the bound tab so a move reaches the screen when it happens rather
   * than at the agent's next tool call — the user who comes back to the panel
   * after wandering off should not have to send a message to find out. Started
   * by every bind, so the subscription always follows the current tab.
   */
  #watch(): void {
    this.#unwatch?.();
    const bound = this.#bound;
    if (!bound) return;
    this.#unwatch = this.#deps.watchNavigation(bound.tabId, (identity) => {
      const current = this.#bound;
      if (!current || current.tabId !== bound.tabId) return;
      const verdict = comparePage(boundPage(current), identity);
      if (verdict.kind === "moved") {
        this.#reportMoved(verdict.siteKey);
        return;
      }
      const wasMoved = this.#moved;
      if (verdict.kind === "same-site") this.#refreshPage(verdict);
      const refreshed = this.#bound;
      if (wasMoved && refreshed) {
        this.#moved = false;
        this.#events.onReturned?.(refreshed);
      }
    });
  }

  #reportMoved(currentSiteKey: string): void {
    const bound = this.#bound;
    if (!bound || this.#moved) return;
    this.#moved = true;
    this.#events.onMoved?.(bound, currentSiteKey);
  }

  /** Record the page load the tab is on now, so the baseline tracks in-site moves. */
  #refreshPage(verdict: { origin: string; documentId?: string }): void {
    const bound = this.#bound;
    if (!bound) return;
    this.#bound = { ...bound, origin: verdict.origin, documentId: verdict.documentId };
  }

  #setBound(tab: TabInfo, siteKey?: string): BoundTab {
    this.#refuseLazyBind = undefined;
    this.#moved = false;
    this.#bound = {
      // SAFETY: every path to #setBound first checks the tab has an id.
      tabId: tab.id as number,
      siteKey: siteKey || safeSiteKey(tab.url),
      origin: pageOrigin(tab.url),
      title: tab.title ?? "",
      favIconUrl: tab.favIconUrl,
    };
    this.#events.onChange?.(this.#bound);
    this.#watch();
    return this.#bound;
  }
}

/** The record the worker checks against — the binding's page half, nothing else. */
function boundPage(bound: BoundTab): BoundPage {
  const page: BoundPage = { siteKey: bound.siteKey, origin: bound.origin };
  if (bound.documentId !== undefined) page.documentId = bound.documentId;
  return page;
}
