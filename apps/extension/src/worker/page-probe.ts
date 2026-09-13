// The agent's `navigate` tool, worker side (wiki/handoff.md §7): drive the
// bound tab to a URL within its site and wait for the new page's remixlets
// to settle. The site check itself is the caller's (worker/index.ts,
// assertNavigationWithinSite). Nothing here is state.

import { ext } from "../platform/ext.js";
import { invalidateCaptureDigestForTab, invalidateCaptureDigestForUrl } from "./capture-freshness.js";
import { settleTab } from "./box.js";

export async function navigateTab(tabId: number, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`navigate: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  // Both the page being left and the page being loaded stop matching their
  // stored capture digests; cleared BEFORE the navigation starts so the
  // capture that follows is deterministically a full one (capture-freshness).
  await invalidateCaptureDigestForTab(tabId);
  await invalidateCaptureDigestForUrl(parsed.href);
  await ext.tabs.update(tabId, { url });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const tab = await ext.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && new URL(tab.url).href.startsWith(parsed.origin)) {
      // The remixlets on the new page have run by now; wait for their first pass to finish.
      await settleTab(tabId);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`navigate: ${url} did not finish loading within 20s`);
}
