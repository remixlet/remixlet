// High-resolution favicon discovery. The URL the panel reports at bind time
// is `tab.favIconUrl` — the icon Chrome picked for its 16px tab strip, which
// for most sites is the smallest one they declare. Sites routinely declare
// far better icons alongside it (`apple-touch-icon` at 180px, PNG `icon`
// entries with a sizes list), so this module fetches the site's own HTML and
// picks the largest declared icon; the tab-reported URL stays as fallback.
//
// The HTML fetch is credential-free and held to the page's exact origin by
// the shared privileged-fetch boundary.

import { fetchPageHtml } from "../platform/privileged-fetch.js";

/**
 * Below this declared size the discovered icon is no improvement over the
 * tab-reported one (rendered at up to 32px in the manager), so the caller's
 * fallback is used instead.
 */
const MIN_USEFUL_SIZE = 64;

/** Vector icons scale to any slot; scored as a large fixed size. */
const SVG_SCORE = 256;

/** Apple's documented default when an apple-touch-icon carries no sizes. */
const APPLE_TOUCH_DEFAULT = 180;

/** The classic un-sized `rel="icon"` is almost always 16 or 32px. */
const PLAIN_ICON_DEFAULT = 16;

function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function scoreOf(tag: string): { href: string; score: number } | undefined {
  const rel = (attributeOf(tag, "rel") ?? "").toLowerCase().split(/\s+/);
  // mask-icon is excluded by construction: its rel token is "mask-icon", not
  // "icon", and it is a monochrome template image — wrong for an icon slot.
  if (!rel.includes("icon") && !rel.includes("apple-touch-icon") && !rel.includes("apple-touch-icon-precomposed")) {
    return undefined;
  }
  const href = attributeOf(tag, "href");
  if (href === undefined || href === "") return undefined;
  const type = (attributeOf(tag, "type") ?? "").toLowerCase();
  const isSvg = type.includes("svg") || /\.svg(?:[?#]|$)/i.test(href);
  const sizes = (attributeOf(tag, "sizes") ?? "").toLowerCase();
  let score = 0;
  for (const match of sizes.matchAll(/(\d+)x\d+/g)) score = Math.max(score, Number(match[1]));
  if (isSvg || sizes.includes("any")) score = Math.max(score, SVG_SCORE);
  if (score === 0) score = rel.includes("icon") ? PLAIN_ICON_DEFAULT : APPLE_TOUCH_DEFAULT;
  return { href, score };
}

/**
 * The largest icon URL the HTML declares, resolved against `baseUrl`, or
 * undefined when nothing declared beats MIN_USEFUL_SIZE. Regex-parsed —
 * MV3 service workers have no DOMParser — which is fine for <link> tags:
 * they are void elements with flat attribute lists.
 */
export function bestIconUrl(html: string, baseUrl: string): string | undefined {
  let best: { url: string; score: number } | undefined;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const scored = scoreOf(tag);
    if (scored === undefined || scored.score < MIN_USEFUL_SIZE) continue;
    if (best !== undefined && scored.score <= best.score) continue;
    let url: string;
    try {
      url = new URL(scored.href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^(https?:|data:image\/)/.test(url)) continue;
    best = { url, score: scored.score };
  }
  return best?.url;
}

/**
 * Fetch the root of `pageOrigin` and return the largest icon URL its HTML declares,
 * or undefined on any failure — discovery is best-effort decoration, callers
 * always have a fallback. Redirects are followed only while they remain on
 * that origin; `response.url` is the post-redirect base for relative hrefs.
 */
export async function discoverIconUrl(pageOrigin: string): Promise<string | undefined> {
  let response: Awaited<ReturnType<typeof fetchPageHtml>>;
  try {
    response = await fetchPageHtml(pageOrigin);
  } catch {
    return undefined;
  }
  const type = response.headers.find(([name]) => name === "content-type")?.[1].split(";")[0]?.trim() ?? "";
  if (response.status !== 200 || type !== "text/html") return undefined;
  return bestIconUrl(response.content, response.url || `${pageOrigin}/`);
}
