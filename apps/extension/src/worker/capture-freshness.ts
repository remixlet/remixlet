// Invalidation half of the unchanged-page capture short-circuit
// (wiki/raw/handoffs/2026-08-10-capture-context-diet.md). The digest compare in
// handleCaptureRequest carries no correctness weight: every event that can
// change what a page shows clears the site's latest-digest record FIRST
// (awaited before the event's reload or navigation is triggered where we
// control the ordering), so the capture that follows is always a full one.
//
// All helpers are best-effort and never throw: activation and navigation must
// not fail over a cost-optimization record. If OPFS is broken enough that a
// clear fails, reads fail too and the short-circuit refuses on its own.

import { ext } from "../platform/ext.js";
import { CaptureStore, captureSiteKey } from "../store/capture-store.js";

const store = new CaptureStore();

export async function invalidateCaptureDigestForUrl(url: string | undefined): Promise<void> {
  if (!url) return;
  await store.clearLatestDigest(captureSiteKey(url));
}

/** Invalidate by the tab's current page — the exact key a capture of it would use. */
export async function invalidateCaptureDigestForTab(tabId: number): Promise<void> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  await invalidateCaptureDigestForUrl(tab?.url ?? tab?.pendingUrl);
}
