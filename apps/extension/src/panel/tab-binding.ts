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

import { resolveActiveBrowserTab } from "../platform/active-tab.js";
import { ext } from "../platform/ext.js";
import { siteKeyForUrl, urlWithinSiteKey } from "../shared/site-key.js";

/** The chip's render model — everything the panel shows about the binding. */
export interface BoundTab {
  tabId: number;
  /** Site the conversation works on, recorded at bind time; drift is measured against it. */
  siteKey: string;
  title: string;
  favIconUrl?: string;
}

export interface TargetTab {
  tabId: number;
  url?: string;
  /** Set when the bound tab has left the bound site — tools append it to their result text. */
  driftNotice?: string;
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
}

export interface TabBindingEvents {
  /** Every bind/unbind/refresh — the panel chip renders from this. */
  onChange?(bound: BoundTab | undefined): void;
  /** target() found the bound tab gone. The panel shows its rebind card. */
  onLost?(previous: BoundTab): void;
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

  constructor(events: TabBindingEvents = {}, deps: TabBindingDeps = defaultDeps()) {
    this.#deps = deps;
    this.#events = events;
  }

  get bound(): BoundTab | undefined {
    return this.#bound;
  }

  /**
   * Explicit bind to a known tab id (drawer pin, the rebind card's open-site
   * button, tests). No-op when the tab is unreadable. `siteKey` records the
   * intended site as the drift baseline when the tab was just created and its
   * URL hasn't committed yet — deriving from the empty URL would record "" and
   * turn drift notices off for the conversation.
   */
  async bindTab(tabId: number, siteKey?: string): Promise<BoundTab | undefined> {
    const tab = await this.#deps.getTab(tabId).catch(() => undefined);
    if (tab?.id === undefined) return undefined;
    return this.#setBound(tab, siteKey);
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
   * message when no tab can be resolved; reports drift when the bound tab has
   * navigated off the conversation's site.
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
    // (it is the drift baseline, re-derived only by an explicit rebind).
    if ((tab.title ?? "") !== bound.title || tab.favIconUrl !== bound.favIconUrl) {
      this.#bound = { ...bound, title: tab.title ?? "", favIconUrl: tab.favIconUrl };
      this.#events.onChange?.(this.#bound);
    }
    return { tabId: tab.id, url: tab.url, driftNotice: this.#driftNotice(bound, tab.url) };
  }

  #driftNotice(bound: BoundTab, url: string | undefined): string | undefined {
    if (bound.siteKey === "" || url === undefined) return undefined;
    if (!/^https?:/.test(url)) {
      return `Note: the tab this conversation works on no longer shows a normal web page (it moved off ${bound.siteKey}). Stop and ask the user how to continue.`;
    }
    if (urlWithinSiteKey(url, bound.siteKey)) return undefined;
    const current = safeSiteKey(url) || "a different site";
    return (
      `Note: the tab this conversation works on is now showing ${current}, not ${bound.siteKey}. ` +
      `Earlier page observations are stale. If working on ${current} is not what the user wants, stop and ask.`
    );
  }

  #setBound(tab: TabInfo, siteKey?: string): BoundTab {
    this.#refuseLazyBind = undefined;
    this.#bound = {
      // SAFETY: every path to #setBound first checks the tab has an id.
      tabId: tab.id as number,
      siteKey: siteKey || safeSiteKey(tab.url),
      title: tab.title ?? "",
      favIconUrl: tab.favIconUrl,
    };
    this.#events.onChange?.(this.#bound);
    return this.#bound;
  }
}
