// The pure provenance + pause decision the capability bridge applies to every
// lane (bridge.ts handleBridgeMessage). Split into its own module — importing
// only shared/site-key — so the decision is unit-testable without pulling the
// whole worker graph into a browser test bundle.

import { matchesPaused, urlMatchesAny, urlPaused } from "../shared/site-key.js";

/**
 * A denial string, or undefined when the call may proceed. The caller must be a
 * page the remixlet's matches actually cover, and neither that page nor the
 * remixlet may be paused — a pause owns the whole remixlet, so a call from any
 * of its hosts is refused while any host it claims is paused.
 */
export function bridgeGateReason(
  id: string,
  matches: readonly string[],
  senderUrl: string | undefined,
  pausedSiteKeys: readonly string[],
): string | undefined {
  if (senderUrl === undefined || !urlMatchesAny(senderUrl, matches)) {
    return `remixlet "${id}" bridge call is not from a page it runs on`;
  }
  if (urlPaused(senderUrl, pausedSiteKeys) || matchesPaused(matches, pausedSiteKeys)) {
    return `remixlet "${id}" is paused on this site`;
  }
  return undefined;
}
