// inspect_design's fetch rounds (wiki/design/inspect-probes.md): the probe
// reports the stylesheets the page world could not read (cross-origin sheets
// throw on cssRules), this module fetches them through the probe-only lane in
// platform/privileged-fetch.ts, and runs the probe again with their text as
// params.fetchedSheets. The text goes page-side only; the model gets the same
// stateRules summary as before plus the hrefs that were fetched.
//
// Verdicts are decided once per session: each page-origin + href body or
// failure is cached in storage.session, so authority and cached content do
// not bleed between origins.

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ext } from "../../platform/ext.js";
import { fetchProbeStylesheet } from "../../platform/privileged-fetch.js";
import { runProbe, type ProbePayload } from "./engine.js";
import type { FetchedProbeStylesheet } from "./probes.js";

const CACHE_KEY = "probeStylesheetCache";
/** Bound on cached sheet text across all hrefs; oldest entries leave first. */
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
/** Round 1 reads the page's sheets, round 2 their fetched text, round 3 the @imports that text named. */
const MAX_ROUNDS = 3;
const MAX_SHEETS_PER_RUN = 8;

const CacheEntrySchema = Type.Object({
  text: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  at: Type.Number(),
});
const StylesheetCacheSchema = Type.Record(Type.String(), CacheEntrySchema);
type CacheEntry = Static<typeof CacheEntrySchema>;
type StylesheetCache = Static<typeof StylesheetCacheSchema>;

/** The one field of the probe's result this module reads. */
const SheetReportSchema = Type.Object({
  stateRules: Type.Optional(Type.Object({ unreadableSheetHrefs: Type.Optional(Type.Array(Type.String())) })),
});

export async function runInspectDesignProbe(tabId: number, params: ProbePayload, boundOrigin?: string): Promise<string> {
  const pageOrigin = boundOrigin ?? await tabOrigin(tabId);
  const fetched: FetchedProbeStylesheet[] = [];
  const attempted = new Set<string>();
  for (let round = 1; ; round += 1) {
    // Spread last: whatever the panel sent under fetchedSheets is replaced by
    // the worker's own list, so no model-supplied text reaches the page.
    const value = await runProbe(tabId, "inspect_design", {
      ...params,
      fetchedSheets: fetched.map((sheet) => ({ href: sheet.href, text: sheet.text })),
    });
    if (round >= MAX_ROUNDS) return value;
    const wanted = unreadableSheetHrefs(value).filter((href) => !attempted.has(href));
    if (wanted.length === 0) return value;
    let added = 0;
    const cache = await readCache();
    for (const href of wanted) {
      if (attempted.size >= MAX_SHEETS_PER_RUN) break;
      attempted.add(href);
      const entry = await sheetEntry(href, pageOrigin, cache);
      if (entry.text !== undefined) {
        fetched.push({ href, text: entry.text });
        added += 1;
      }
    }
    await writeCache(cache);
    if (added === 0) return value;
  }
}

/** The probe's fetch list, taken only from the result it just produced. */
function unreadableSheetHrefs(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // A capped or otherwise unparseable result gets no fetch round.
    return [];
  }
  if (!Check(SheetReportSchema, parsed)) return [];
  const accepted: string[] = [];
  for (const href of parsed.stateRules?.unreadableSheetHrefs ?? []) {
    try {
      const url = new URL(href);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (!accepted.includes(href)) accepted.push(href);
  }
  return accepted;
}

async function sheetEntry(href: string, pageOrigin: string, cache: StylesheetCache): Promise<CacheEntry> {
  const key = `${pageOrigin}\n${href}`;
  const hit = cache[key];
  if (hit !== undefined) return hit;
  let entry: CacheEntry;
  try {
    entry = { text: await fetchProbeStylesheet(href, pageOrigin), at: Date.now() };
  } catch (error) {
    entry = { error: error instanceof Error ? error.message : String(error), at: Date.now() };
  }
  cache[key] = entry;
  return entry;
}

async function tabOrigin(tabId: number): Promise<string> {
  const tab = await ext.tabs.get(tabId);
  const href = tab.url ?? tab.pendingUrl;
  if (href === undefined) throw new Error("the page origin is unavailable");
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the page origin is not HTTP(S)");
  return url.origin;
}

async function readCache(): Promise<StylesheetCache> {
  const stored = await ext.storage.session.get(CACHE_KEY);
  const cache = stored[CACHE_KEY];
  return Check(StylesheetCacheSchema, cache) ? cache : {};
}

async function writeCache(cache: StylesheetCache): Promise<void> {
  const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at);
  const kept: StylesheetCache = {};
  let bytes = 0;
  for (const [href, entry] of entries) {
    bytes += entry.text?.length ?? 0;
    if (bytes > CACHE_MAX_BYTES) break;
    kept[href] = entry;
  }
  await ext.storage.session.set({ [CACHE_KEY]: kept });
}
