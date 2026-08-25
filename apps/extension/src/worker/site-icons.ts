// Worker half of site favicon snapshots: the panel reports the bound tab's
// favicon URL whenever a chat binds to a tab (siteIcon.record), and this
// module snapshots an icon once and stores it as a data URL against the site
// key (store/site-icons.ts). The tab-reported URL is Chrome's 16px tab-strip
// pick, so capture first tries favicon-discovery.ts for the largest icon the
// site's own HTML declares, falling back to the reported URL. The <all_urls>
// host permission is what lets the worker fetch cross-origin here; an
// unchanged reportedUrl short-circuits, so repeated binds on the same site
// cost one index read, not a refetch.

import { SiteIconStore } from "../store/site-icons.js";

import { discoverIconUrl } from "./favicon-discovery.js";

/** Favicons are tiny; anything past this is not one. */
const MAX_ICON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

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

async function snapshotDataUrl(sourceUrl: string): Promise<string | undefined> {
  // Pages sometimes carry their favicon inline already — keep it verbatim.
  if (sourceUrl.startsWith("data:image/")) {
    return sourceUrl.length <= MAX_ICON_BYTES ? sourceUrl : undefined;
  }
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return undefined;
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return undefined;
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
export function recordSiteIcon(siteKey: string, favIconUrl: string | undefined): Promise<void> {
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
    const discovered = await discoverIconUrl(siteKey.split("+")[0] ?? siteKey).catch(() => undefined);
    for (const sourceUrl of discovered === undefined ? [favIconUrl] : [discovered, favIconUrl]) {
      let dataUrl: string | undefined;
      try {
        dataUrl = await snapshotDataUrl(sourceUrl);
      } catch {
        continue;
      }
      if (dataUrl === undefined) continue;
      await store.put(siteKey, { sourceUrl, reportedUrl: favIconUrl, dataUrl, updatedAt: Date.now() });
      return;
    }
  });
}

// One re-capture attempt per site key per worker lifetime: a site with no
// reachable favicon would otherwise be probed on every render of its row.
const refreshAttempted = new Set<string>();

/**
 * Re-capture the icon for a site key whose first snapshot never landed
 * (siteIcon.refresh, sent when the UI is about to render the globe
 * fallback). The favicon URL the tab once reported is gone — a failed
 * record stores nothing — so this falls back to the well-known
 * `/favicon.ico` path on each concrete host in the key. Returns the data
 * URL now stored for the key (pre-existing or freshly captured), or
 * undefined when there is still none.
 */
export function refreshSiteIcon(siteKey: string): Promise<string | undefined> {
  return enqueue(async () => {
    const hosts = siteKey.split("+").filter((part) => part.length > 0 && !part.includes("*") && !part.includes("/"));
    for (const key of [siteKey, ...hosts]) {
      const existing = await store.get(key);
      if (existing) return existing.dataUrl;
    }
    if (refreshAttempted.has(siteKey)) return undefined;
    refreshAttempted.add(siteKey);
    for (const host of hosts) {
      const discovered = await discoverIconUrl(host).catch(() => undefined);
      const candidates = discovered === undefined ? [`https://${host}/favicon.ico`] : [discovered, `https://${host}/favicon.ico`];
      for (const sourceUrl of candidates) {
        let dataUrl: string | undefined;
        try {
          dataUrl = await snapshotDataUrl(sourceUrl);
        } catch {
          continue;
        }
        if (dataUrl === undefined) continue;
        // Stored per single host, same as recordSiteIcon via the panel bind.
        await store.put(host, { sourceUrl, dataUrl, updatedAt: Date.now() });
        return dataUrl;
      }
    }
    return undefined;
  });
}

/** Every stored icon's data URL by site key — the control center's read. */
export function listSiteIcons(): Promise<Record<string, string>> {
  return enqueue(() => store.list());
}
