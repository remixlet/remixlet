// The one page-level run decision for a mirrored remixlet, shared by every
// consumer of the mirror (bridge lanes, rmx.menu, CSS insertion, the badge).
// Pure — imports only site-key — so the decision is unit-testable without the
// worker graph.
//
// The mirror itself is the artifact-level answer: worker/eligibility.ts
// admits only artifacts that are enabled, not being deleted, not quarantined,
// bridge-compatible and readable from their committed snapshot, so a remixlet
// absent from the mirror may not run at all. These functions answer the
// remaining question for one that is present: may it act, and on THIS page?

import { matchesPaused, urlMatchesAny, urlPaused } from "./site-key.js";

export interface RunnableRemixlet {
  id: string;
  matches: readonly string[];
}

/**
 * Why the remixlet may not act anywhere right now, or undefined when it may:
 * a pause on any host it claims (a pause owns the whole remixlet, so it is
 * refused on its unpaused hosts too while another host is paused).
 */
export function ineligibleReason(remixlet: RunnableRemixlet, pausedSiteKeys: readonly string[]): string | undefined {
  if (matchesPaused(remixlet.matches, pausedSiteKeys)) return `remixlet "${remixlet.id}" is paused on this site`;
  return undefined;
}

/**
 * Why the remixlet may not act on the page at `url`, or undefined when it
 * may. A missing URL (a bridge sender with no page) is refused, as is a page
 * outside the remixlet's matches or one whose site is paused. Messages are
 * the bridge's denial text: the remixlet's own catch block usually swallows
 * the error, so the reason lands in the script log verbatim.
 */
export function pageIneligibleReason(
  remixlet: RunnableRemixlet,
  url: string | undefined,
  pausedSiteKeys: readonly string[],
): string | undefined {
  if (url === undefined || !urlMatchesAny(url, remixlet.matches)) {
    return `remixlet "${remixlet.id}" bridge call is not from a page it runs on`;
  }
  const reason = ineligibleReason(remixlet, pausedSiteKeys);
  if (reason !== undefined) return reason;
  if (urlPaused(url, pausedSiteKeys)) return `remixlet "${remixlet.id}" is paused on this site`;
  return undefined;
}

/** pageIneligibleReason as a predicate, for the consumers that only filter. */
export function runsOn(remixlet: RunnableRemixlet, url: string, pausedSiteKeys: readonly string[]): boolean {
  return pageIneligibleReason(remixlet, url, pausedSiteKeys) === undefined;
}
