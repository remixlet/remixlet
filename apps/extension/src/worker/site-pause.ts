// Per-site pause (wiki/plan.md §3 M3): "leave this site alone" without
// touching any remixlet's enabled state. Keyed by site key — the same
// derivation captures, conversations, and matches use — and stored in
// storage.local, which is what survives both browser restarts and the
// unpacked reinstall path (--load-extension re-registration); registrations
// themselves never persist there, the reconcile rebuilds them.
//
// A pause owns whole remixlets, not just pages: every remixlet whose matches
// claim a paused host stops on ALL the hosts it matches (shared/site-key.ts
// siteKeysPausing). Pausing one host of a two-host remixlet and having it keep
// running on the other is the state this rules out — the manager would show it
// as paused while it kept editing pages.
//
// Enforcement reads this one list from four places:
//   - JS: reconcileUserScripts drops owned remixlets from registration, and
//     adds excludeMatches for every paused key (which is what still stops an
//     <all_urls> remixlet, owned by no single site, on a paused site's pages)
//   - CSS: the navigation-time injector skips paused URLs and owned remixlets
//   - menus: commands of an owned remixlet are cleared wherever they live
//   - the badge, so "paused" always shows as 0 active.

import { ext } from "../platform/ext.js";

const PAUSED_KEY = "pausedSites";

export async function readPausedSites(): Promise<string[]> {
  const stored = await ext.storage.local.get(PAUSED_KEY);
  // SAFETY: writePausedSites and setSitePaused store only string arrays under this key.
  return (stored[PAUSED_KEY] as string[] | undefined) ?? [];
}

/** Idempotent set/clear; returns the new list. */
export async function setSitePaused(siteKey: string, paused: boolean): Promise<string[]> {
  if (siteKey.length === 0) throw new Error("site pause needs a site key");
  const current = await readPausedSites();
  const next = paused ? [...new Set([...current, siteKey])].sort() : current.filter((key) => key !== siteKey);
  await ext.storage.local.set({ [PAUSED_KEY]: next });
  return next;
}

/** Exact restoration for lifecycle transactions. */
export async function writePausedSites(siteKeys: string[]): Promise<void> {
  await ext.storage.local.set({ [PAUSED_KEY]: siteKeys });
}
