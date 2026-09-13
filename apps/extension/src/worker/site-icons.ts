// Worker half of site favicon snapshots: the panel reports the bound tab's
// favicon URL whenever a chat binds to a tab (siteIcon.record), and this
// module snapshots an icon once and stores it as a data URL against the site
// key (store/site-icons.ts). The tab-reported URL is Chrome's 16px tab-strip
// pick, so capture first tries favicon-discovery.ts for the largest icon the
// site's own HTML declares, falling back to the reported URL. Both fetches
// stay on the live page's exact origin. An unchanged reportedUrl
// short-circuits, so repeated binds on the same site cost one index read.

import { SiteIconStore } from "../store/site-icons.js";
import { fetchPageIcon, PAGE_ICON_MAX_BYTES } from "../platform/privileged-fetch.js";

import { discoverIconUrl } from "./favicon-discovery.js";

/** Favicons are tiny; anything past this is not one. */
const MAX_ICON_BYTES = PAGE_ICON_MAX_BYTES;

const store = new SiteIconStore();

// MV3 handlers interleave at every await; serialize read-modify-write.
let operationTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function snapshotDataUrl(sourceUrl: string, pageOrigin: string): Promise<string | undefined> {
  // Pages sometimes carry their favicon inline already — keep it verbatim.
  if (sourceUrl.startsWith("data:image/")) {
    return sourceUrl.length <= MAX_ICON_BYTES ? sourceUrl : undefined;
  }
  const response = await fetchPageIcon(sourceUrl, pageOrigin);
  if (response.status < 200 || response.status >= 300) return undefined;
  const type = response.headers.find(([name]) => name === "content-type")?.[1].split(";")[0]?.trim() ?? "";
  const bytes = response.bytes;
  if (bytes.length === 0) return undefined;
  // Favicon endpoints are frequently mis-typed (text/plain .ico is common);
  // require only that the body is not obviously an HTML error page.
  if (type.startsWith("text/html")) return undefined;
  const mime = type.startsWith("image/") ? type : "image/x-icon";
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/**
 * Snapshot `favIconUrl` against `siteKey`. Missing or non-fetchable URLs and
 * failed fetches are quietly no-ops — an icon is decoration, never worth an
 * error surface; the stored snapshot (if any) simply remains.
 */
export function recordSiteIcon(siteKey: string, pageOrigin: string, favIconUrl: string | undefined): Promise<void> {
  return enqueue(async () => {
    if (!siteKey || !favIconUrl) return;
    if (!/^(https?:|data:image\/)/.test(favIconUrl)) return;
    const existing = await store.get(siteKey);
    // Short-circuit on the REPORTED url: sourceUrl may be a discovered
    // high-res URL the tab never mentions. Pre-discovery records have no
    // reportedUrl and so re-record (and upgrade) once.
    if (existing?.reportedUrl === favIconUrl) return;
    // The tab-reported favIconUrl is Chrome's 16px tab-strip pick; the site's
    // HTML usually declares far larger icons — prefer those when present.
    const discovered = await discoverIconUrl(pageOrigin).catch(() => undefined);
    for (const sourceUrl of discovered === undefined ? [favIconUrl] : [discovered, favIconUrl]) {
      let dataUrl: string | undefined;
      try {
        dataUrl = await snapshotDataUrl(sourceUrl, pageOrigin);
      } catch {
        continue;
      }
      if (dataUrl === undefined) continue;
      await store.put(siteKey, { sourceUrl, reportedUrl: favIconUrl, dataUrl, updatedAt: Date.now() });
      return;
    }
  });
}

/**
 * Re-read an icon for a site key whose first snapshot may have landed.
 * A list or manager view has no live page origin to authorize a network
 * request, so this never guesses a scheme, port, or `/favicon.ico` URL.
 */
export function refreshSiteIcon(siteKey: string): Promise<string | undefined> {
  return enqueue(async () => {
    const hosts = siteKey.split("+").filter((part) => part.length > 0 && !part.includes("*") && !part.includes("/"));
    for (const key of [siteKey, ...hosts]) {
      const existing = await store.get(key);
      if (existing) return existing.dataUrl;
    }
    return undefined;
  });
}

/** Every stored icon's data URL by site key — the control center's read. */
export function listSiteIcons(): Promise<Record<string, string>> {
  return enqueue(() => store.list());
}
