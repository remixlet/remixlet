// Which page a tab is showing right now, named precisely enough to tell a
// reload from a re-read (wiki/design/page-binding.md). The comparison itself
// is browser-free and lives in shared/page-binding.ts; this is the seam that
// gets the two facts it compares against.
//
// `webNavigation.getFrame` on the top frame is the only lookup that reports a
// document id — a UUID the browser mints per page load, so an identical URL
// after a reload reads as the new page it is. Where the namespace or the field
// is missing (Firefox and Safari do not report it on every release we build
// for), the URL alone still answers "which site", which is the half that
// refuses reads; the reload half degrades to "assume it is a new load", which
// allows the read and claims nothing.

import { ext } from "./ext.js";
import type { PageIdentity } from "../shared/page-binding.js";

/** Top-frame url + document id. Undefined only when the tab itself is gone. */
export async function readPageIdentity(tabId: number): Promise<PageIdentity | undefined> {
  const frame = await topFrame(tabId);
  if (frame) return frame;
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  if (tab === undefined) return undefined;
  return { url: tab.url ?? tab.pendingUrl };
}

async function topFrame(tabId: number): Promise<PageIdentity | undefined> {
  if (!("webNavigation" in ext) || !(ext.webNavigation?.getFrame instanceof Function)) return undefined;
  try {
    const frame = await ext.webNavigation.getFrame({ tabId, frameId: 0 });
    // A frame mid-navigation reports the document it is LEAVING; reading it as
    // the current page would let a read land on the page being replaced. The
    // tabs lookup above sees pendingUrl instead, which names where it is going.
    if (!frame || frame.documentLifecycle === "pending_deletion") return undefined;
    return { url: frame.url, documentId: frame.documentId };
  } catch {
    // No such tab, or a browser whose getFrame rejects for the top frame.
    return undefined;
  }
}

/**
 * Committed top-frame navigations on one tab: the panel watches its bound tab
 * so a move is on screen the moment the user comes back, rather than at the
 * agent's next tool call. Same-document navigations (SPA routing) fire too, so
 * the handler sees every URL change; the verdict is the caller's to compute.
 * Returns the unsubscribe.
 */
export function watchTopFrameNavigation(tabId: number, onNavigated: (identity: PageIdentity) => void): () => void {
  if (!("webNavigation" in ext)) return () => {};
  const relevant = (details: { tabId: number; frameId: number }): boolean =>
    details.tabId === tabId && details.frameId === 0;
  const committed = (details: { tabId: number; frameId: number; url: string; documentId?: string }): void => {
    if (relevant(details)) onNavigated({ url: details.url, documentId: details.documentId });
  };
  ext.webNavigation.onCommitted.addListener(committed);
  ext.webNavigation.onHistoryStateUpdated.addListener(committed);
  ext.webNavigation.onReferenceFragmentUpdated.addListener(committed);
  return () => {
    ext.webNavigation.onCommitted.removeListener(committed);
    ext.webNavigation.onHistoryStateUpdated.removeListener(committed);
    ext.webNavigation.onReferenceFragmentUpdated.removeListener(committed);
  };
}
