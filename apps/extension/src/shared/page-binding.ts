// Is the tab still showing the page this conversation was pointed at?
// (wiki/design/page-binding.md, wiki/ops/2026-09-04-security-remediation-plan.md item 7.)
//
// The conversation binds to a tab, and the tab can be navigated by the user,
// by a link, or by the site itself while the agent is mid-turn. Until this
// module existed the read tools noticed and appended a note ASKING the model
// to stop — advice printed next to the page it had just read. This is the
// check that replaces it: the page is compared BEFORE anything is read, and
// the read is refused outright when the tab moved.
//
// Three outcomes, because a reload is not the same event as leaving:
//
//   same-document  the app changed its own URL (SPA routing) — nothing to do
//   same-site      a reload or an in-site link — the read proceeds, but the
//                  page is a new one, so anything the agent believed about it
//                  is stale (the digest that carries that belief is cleared by
//                  worker/index.ts's onBeforeNavigate listener, not here)
//   moved          a different site, a scheme downgrade, or off the web — stop
//
// Pure functions, no extension APIs: the panel checks before it sends
// (panel/tab-binding.ts) and the worker checks again before it reads
// (worker/page-binding.ts), and both must reach the same verdict from the
// same rules.

import { canonicalUrlHostname } from "./hostname.js";
import { hostSpansPublicSuffix } from "./public-suffix.js";
import { siteKeyForUrl, urlWithinSiteKey } from "./site-key.js";

/**
 * What the conversation was pointed at, recorded by the panel at bind time and
 * refreshed as the tab moves WITHIN the site. Panel-authored throughout: no
 * field here is ever taken from a model-supplied argument.
 */
export interface BoundPage {
  /** The conversation's site (shared/site-key.ts). Empty means no baseline: nothing is refused. */
  siteKey: string;
  /** Scheme + host + port at bind time. Empty when the tab's URL had not committed yet. */
  origin: string;
  /** The browser's per-page-load id. Absent where the browser cannot report one. */
  documentId?: string;
}

/** What the tab is showing right now (platform/page-identity.ts reads it). */
export interface PageIdentity {
  url?: string;
  documentId?: string;
}

export type PageVerdict =
  /** Same page load: the site's own routing changed the URL, or nothing changed. */
  | { kind: "same-document" }
  /** A new page load within the site: allowed, but earlier observations describe a page that is gone. */
  | { kind: "same-site"; siteKey: string; origin: string; documentId?: string }
  /** The tab left the conversation's page. Nothing may be read from it. */
  | { kind: "moved"; siteKey: string; message: string };

/** Scheme + host + port, canonically spelled. Empty for anything that is not an http(s) page. */
export function pageOrigin(url: string | undefined): string {
  if (url === undefined || !/^https?:/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${canonicalUrlHostname(parsed)}${parsed.port === "" ? "" : `:${parsed.port}`}`;
  } catch {
    return "";
  }
}

/**
 * Whether `url`'s host is part of `siteKey` for the purpose of "still the page
 * we were pointed at". This is site-key containment (the exact host plus hosts
 * under it, the same rule that decides where a remixlet may run) with ONE
 * extra guard: a site key that is itself shared hosting — `github.io`,
 * `appspot.com` — has unrelated tenants underneath it, so only the exact host
 * counts there. A composite key (`a+b`, written by matches, never by a
 * binding) is handled part by part so the guard cannot be sidestepped.
 */
function hostWithinBoundSite(url: string, siteKey: string): boolean {
  return siteKey
    .split("+")
    .some((part) => (hostSpansPublicSuffix(part) ? urlHostEquals(url, part) : urlWithinSiteKey(url, part)));
}

function urlHostEquals(url: string, host: string): boolean {
  try {
    return canonicalUrlHostname(new URL(url)) === host;
  } catch {
    return false;
  }
}

function safeSiteKey(url: string): string {
  try {
    return siteKeyForUrl(url);
  } catch {
    return "";
  }
}

const stopSentence = (siteKey: string): string =>
  `Nothing was read. Tell the user the page moved and stop; the panel offers them a button to reopen ${siteKey}.`;

/**
 * The comparison both checkers run. `expected.siteKey` empty means the
 * conversation has no site baseline (a binding made before the URL committed),
 * and nothing is ever refused against it — same rule the drift notice used.
 */
export function comparePage(expected: BoundPage, actual: PageIdentity): PageVerdict {
  if (expected.siteKey === "") return { kind: "same-document" };
  const url = actual.url;
  if (url === undefined || !/^https?:/i.test(url)) {
    return {
      kind: "moved",
      siteKey: "",
      message:
        `The tab this conversation works on no longer shows a normal web page (it moved off ${expected.siteKey}). ` +
        stopSentence(expected.siteKey),
    };
  }
  const origin = pageOrigin(url);
  // Scheme and port before host: site-key containment compares hostnames only,
  // so https → http on the same host reads as the same site while being a
  // downgrade to a page anyone on the network can rewrite.
  if (expected.origin !== "" && !sameSchemeAndPort(expected.origin, origin)) {
    return {
      kind: "moved",
      siteKey: safeSiteKey(url),
      message:
        `The tab this conversation works on is now showing ${origin}, not ${expected.origin}. ` +
        stopSentence(expected.siteKey),
    };
  }
  if (!hostWithinBoundSite(url, expected.siteKey)) {
    const current = safeSiteKey(url) || "a different site";
    return {
      kind: "moved",
      siteKey: safeSiteKey(url),
      message:
        `The tab this conversation works on is now showing ${current}, not ${expected.siteKey}. ` +
        stopSentence(expected.siteKey),
    };
  }
  // Within the site. Same page load only when both sides can name the load and
  // the names agree: where the browser reports no document id there is nothing
  // to tell a reload from a re-read, and "same-site" is the safe reading —
  // it allows the read and claims nothing about the page being unchanged.
  if (expected.documentId !== undefined && actual.documentId === expected.documentId) return { kind: "same-document" };
  return { kind: "same-site", siteKey: safeSiteKey(url), origin, documentId: actual.documentId };
}

/**
 * Whether the agent may drive the bound tab to `url`: the same site test as
 * above, applied to a destination instead of to what the tab already shows.
 * Returns the refusal sentence, or undefined when the destination is in scope.
 */
export function navigationRefusal(expected: BoundPage, url: string): string | undefined {
  let destination: string;
  try {
    destination = safeSiteKey(url) || new URL(url).hostname;
  } catch {
    return `navigate: "${url}" is not a URL.`;
  }
  // The SAME verdict the read gate uses, asked of a destination instead of of
  // the tab's current page: one rule set, so a rule added above cannot be
  // missing here. The document id is dropped because a page not yet loaded has
  // none — that only ever downgrades "same-document" to "same-site", and both
  // mean the destination is in scope.
  const verdict = comparePage({ siteKey: expected.siteKey, origin: expected.origin }, { url });
  if (verdict.kind !== "moved") return undefined;
  const where = destination || pageOrigin(url) || url;
  return (
    `navigate: this conversation works on ${expected.siteKey || expected.origin}, so it cannot drive the tab to ${where}. ` +
    `Ask the user to open ${where} and start a chat there.`
  );
}

function sameSchemeAndPort(expected: string, actual: string): boolean {
  const split = (origin: string): [string, string] => {
    const [scheme = "", rest = ""] = origin.split("//");
    const port = rest.includes(":") ? rest.slice(rest.lastIndexOf(":") + 1) : defaultPort(scheme);
    return [scheme, port];
  };
  const [expectedScheme, expectedPort] = split(expected);
  const [actualScheme, actualPort] = split(actual);
  return expectedScheme === actualScheme && expectedPort === actualPort;
}

const defaultPort = (scheme: string): string => (scheme === "http:" ? "80" : "443");
