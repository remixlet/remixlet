// Action badge (wiki/plan.md §3 M3): per-tab count of remixlets live on the
// tab's current URL. "Live" means enabled AND unpaused — neither this site nor
// any other host the remixlet claims — computed from the same mirror + pause
// list injection reads, so the badge can't claim activity the page isn't
// getting. Empty text (no badge) for zero; event-driven, no state beyond
// storage.

import { ext } from "../platform/ext.js";
import { matchesPaused, urlMatchesAny, urlPaused } from "../shared/site-key.js";
import { readMirror } from "./injection.js";
import { readPausedSites } from "./site-pause.js";

export function installBadge(): void {
  ext.tabs.onActivated.addListener(({ tabId }) => void refreshBadge(tabId).catch(() => {}));
  ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined || changeInfo.status === "loading") {
      void refreshBadge(tabId, tab.url).catch(() => {});
    }
  });
  void ext.action.setBadgeBackgroundColor({ color: "#404040" });
  void ext.action.setBadgeTextColor?.({ color: "#ffffff" });
  void refreshAllBadges().catch(() => {});
}

export async function refreshBadge(tabId: number, url?: string): Promise<void> {
  const tabUrl = url ?? (await ext.tabs.get(tabId).catch(() => undefined))?.url;
  const count = tabUrl ? await liveCountForUrl(tabUrl) : 0;
  await ext.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" }).catch(() => {
    // Tab may be gone by the time we get here — nothing to show.
  });
}

/** Recompute every tab's badge — run after any mirror or pause change. */
export async function refreshAllBadges(): Promise<void> {
  for (const tab of await ext.tabs.query({})) {
    if (tab.id !== undefined) await refreshBadge(tab.id, tab.url);
  }
}

async function liveCountForUrl(url: string): Promise<number> {
  if (!/^https?:/.test(url)) return 0;
  const pausedSites = await readPausedSites();
  if (urlPaused(url, pausedSites)) return 0;
  // A remixlet paused from one of its OTHER hosts is not live here either —
  // the count has to agree with what injection actually registered.
  return (await readMirror()).filter(
    (remixlet) => urlMatchesAny(url, remixlet.matches) && !matchesPaused(remixlet.matches, pausedSites),
  ).length;
}
