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
//   - JS: reconcileRegistrations drops owned remixlets from registration, and
//     adds excludeMatches for every paused key (which is what still stops an
//     <all_urls> remixlet, owned by no single site, on a paused site's pages)
//   - CSS: the navigation-time injector skips paused URLs and owned remixlets
//   - menus: commands of an owned remixlet are cleared wherever they live
//   - the badge, so "paused" always shows as 0 active.

import { ext } from "../platform/ext.js";
import { canonicalSiteKey } from "../shared/site-key.js";

const PAUSED_KEY = "pausedSites";

/**
 * The paused keys in canonical spelling. Keys written by earlier releases can
 * carry a trailing dot or a unicode host (item 8); reading them through
 * canonicalSiteKey is the migration, applied in place when it changes
 * anything. It never loses a pause (a key that is no hostname at all is kept
 * verbatim rather than dropped) and never merges two sites: only two
 * spellings of the same host canonicalise to one key.
 */
export async function readPausedSites(): Promise<string[]> {
  const stored = await ext.storage.local.get(PAUSED_KEY);
  // SAFETY: writePausedSites and setSitePaused store only string arrays under this key.
  const raw = (stored[PAUSED_KEY] as string[] | undefined) ?? [];
  const canonical = [...new Set(raw.map(canonicalPauseKey))].sort();
  if (canonical.length !== raw.length || canonical.some((key, index) => key !== raw[index])) {
    await ext.storage.local.set({ [PAUSED_KEY]: canonical });
  }
  return canonical;
}

function canonicalPauseKey(siteKey: string): string {
  const canonical = canonicalSiteKey(siteKey);
  return canonical.length > 0 ? canonical : siteKey;
}

/** Idempotent set/clear; returns the new list. */
export async function setSitePaused(siteKey: string, paused: boolean): Promise<string[]> {
  if (siteKey.length === 0) throw new Error("site pause needs a site key");
  const key = canonicalPauseKey(siteKey);
  const current = await readPausedSites();
  const next = paused ? [...new Set([...current, key])].sort() : current.filter((entry) => entry !== key);
  await ext.storage.local.set({ [PAUSED_KEY]: next });
  return next;
}

/** Exact restoration for lifecycle transactions. */
export async function writePausedSites(siteKeys: string[]): Promise<void> {
  await ext.storage.local.set({ [PAUSED_KEY]: siteKeys });
}
