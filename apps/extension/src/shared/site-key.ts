// THE host-match + site-key module (wiki/handoff.md §8): one shared implementation
// used by remixlet `matches`, capture grouping, and conversation tagging —
// deliberately never two. Pure functions, no extension APIs.
//
// Hostnames are compared in ONE canonical spelling (hostname.ts): lowercase,
// IDNA, no trailing dot. A page URL, a model-written match pattern and a site
// key stored by an earlier release all reach the comparisons below through
// that spelling, so `Example.com.` and `example.com` are one site everywhere
// — the matcher, the pause checks, approval comparison and display.

import { canonicalHostname, canonicalUrlHostname } from "./hostname.js";
import { publicSuffixSpannedBy, spannedSuffixError } from "./public-suffix.js";

/**
 * Site key: the grouping identity for captures, conversations, and manager
 * UI. Derived from a URL's hostname (lowercased, `www.` stripped) or from a
 * remixlet's match patterns (per-pattern base hosts, deduped, sorted, joined
 * with `+`). Keys are filesystem-safe by construction (hostname charset).
 */
export function siteKeyForUrl(url: string): string {
  const hostname = canonicalUrlHostname(new URL(url));
  return stripWww(hostname) || hostname;
}

/**
 * A site key in canonical spelling: each `+` part canonicalised, parts that
 * are not hostnames dropped (a bare `*` is kept — it names "every site"),
 * deduplicated and sorted. Keys written by earlier releases can carry a
 * unicode host or a trailing dot; reading them through here is the migration,
 * and it can only ever merge two spellings of the SAME host — two different
 * hosts never canonicalise to one name.
 */
export function canonicalSiteKey(siteKey: string): string {
  const parts = new Set<string>();
  for (const part of siteKey.split("+")) {
    if (part === "*") {
      parts.add("*");
      continue;
    }
    const host = canonicalHostname(part);
    if (host !== undefined) parts.add(stripWww(host) || host);
  }
  return [...parts].sort().join("+");
}

export function siteKeyForMatches(matches: readonly string[]): string {
  const hosts = matchHosts(matches);
  if (hosts.length === 0) throw new Error(`no valid match patterns in ${JSON.stringify(matches)}`);
  return hosts.join("+");
}

/** The base hosts a set of match patterns claims — the site key's `+` parts. */
function matchHosts(matches: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const pattern of matches) {
    const parsed = parseMatchPattern(pattern);
    if (parsed === undefined) continue;
    if (parsed.host === "*") {
      hosts.add("*");
      continue;
    }
    hosts.add(stripWww(parsed.host.replace(/^\*\./, "")) || parsed.host);
  }
  return [...hosts].sort();
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

/** Parsed MV3 match pattern. `<all_urls>` parses as scheme *, host *, path /*. */
export interface MatchPattern {
  /** "*" (http|https), "http", "https". */
  scheme: string;
  /** "*", "*.example.com", or an exact host. */
  host: string;
  /** Always starts with "/"; may contain "*" globs. */
  path: string;
}

const PATTERN_RE = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*:]+)(\/.*)$/;

/** Parse an MV3 match pattern; undefined when malformed. */
export function parseMatchPattern(pattern: string): MatchPattern | undefined {
  if (pattern === "<all_urls>") return { scheme: "*", host: "*", path: "/*" };
  const match = PATTERN_RE.exec(pattern);
  if (!match) return undefined;
  const host = canonicalPatternHost(match[2]!);
  if (host === undefined) return undefined;
  return { scheme: match[1]!, host, path: match[3]! };
}

/** `*`, or `*.`-prefix plus a canonical hostname; undefined when the host is not one. */
function canonicalPatternHost(raw: string): string | undefined {
  if (raw === "*") return "*";
  const wildcard = raw.startsWith("*.");
  const host = canonicalHostname(wildcard ? raw.slice(2) : raw);
  if (host === undefined) return undefined;
  return wildcard ? `*.${host}` : host;
}

/**
 * MV3 match-pattern semantics (the subset remixlets use — http/https):
 * scheme `*` matches http+https; host `*.example.com` matches the base domain
 * and subdomains; ports are ignored; path is a `*`-glob.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (parsed === undefined) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.replace(/:$/, "");
  if (parsed.scheme === "*" ? !(scheme === "http" || scheme === "https") : scheme !== parsed.scheme) return false;
  if (!hostMatches(canonicalUrlHostname(target), parsed.host)) return false;
  return globMatches(target.pathname + target.search, parsed.path);
}

export function urlMatchesAny(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => urlMatchesPattern(url, pattern));
}

/**
 * Whether a URL falls under a site key — the relation per-site pause uses.
 * A key covers its host and every subdomain (site keys already strip `www.`),
 * mirroring the `*://key/*` + `*://*.key/*` exclude patterns registration
 * uses, so "what the badge says" and "what actually injects" cannot disagree.
 * Composite keys (`a.com+b.com`, from multi-host matches) cover each part.
 */
export function urlWithinSiteKey(url: string, siteKey: string): boolean {
  let hostname: string;
  try {
    hostname = canonicalUrlHostname(new URL(url));
  } catch {
    return false;
  }
  return ownedHosts(siteKey).some((part) => hostMatches(hostname, part) || hostMatches(hostname, `*.${part}`));
}

export function urlPaused(url: string, pausedSiteKeys: readonly string[]): boolean {
  return pausedSiteKeys.some((key) => urlWithinSiteKey(url, key));
}

/**
 * The paused site keys that silence a remixlet OUTRIGHT, on every host it
 * matches. Pause is authored on one site, but the thing paused is the
 * remixlet: one whose matches span several hosts stops on all of them, so the
 * manager can never show a multi-host remixlet as "paused" while it keeps
 * running on its other host. Overlap is symmetric — a pause keyed
 * `mail.example.com` covers a `*.example.com` remixlet and vice versa —
 * because either gesture was made on a page where that remixlet was running.
 *
 * A `*` host (an `<all_urls>` remixlet) claims no site of its own, so no
 * single-site pause owns it; the per-URL rule (urlPaused for CSS/menus,
 * siteKeyExcludePatterns for registration) still keeps it off paused pages.
 */
export function siteKeysPausing(siteKey: string, pausedSiteKeys: readonly string[]): string[] {
  const hosts = ownedHosts(siteKey);
  return pausedSiteKeys.filter((key) =>
    ownedHosts(key).some((pausedHost) => hosts.some((host) => hostsOverlap(host, pausedHost))),
  );
}

export function siteKeyPaused(siteKey: string, pausedSiteKeys: readonly string[]): boolean {
  return siteKeysPausing(siteKey, pausedSiteKeys).length > 0;
}

/**
 * Whether a remixlet keyed `remixletSiteKey` belongs to the site a chat is
 * bound to: the two keys share a host, or one is a subdomain of the other
 * (a remixlet keyed `soundcloud.com` belongs to a chat on m.soundcloud.com,
 * and one keyed `m.soundcloud.com` to a chat on soundcloud.com). This is the
 * one rule for "this site's remixlets" on the agent's side: list_remixlets
 * lists exactly these in full and read_remixlet returns exactly these
 * (wiki/ops/2026-09-04-security-remediation-plan.md item 7, cross-site
 * reads), so nothing is readable that was not listed. A composite key
 * belongs to the site of any of its parts. An all-sites remixlet (a `*`
 * part, from `<all_urls>` or a bare `*` host) runs on every page, so it
 * belongs to every site: the user put it there through the scope dialog,
 * and a chat on any page may need to refine it. A chat bound to nothing
 * (an empty key) owns nothing, all-sites remixlets included.
 */
export function remixletOnSite(remixletSiteKey: string, boundSiteKey: string): boolean {
  if (ownedHosts(boundSiteKey).length === 0) return false;
  if (canonicalSiteKey(remixletSiteKey).split("+").includes("*")) return true;
  return siteKeyPaused(remixletSiteKey, [boundSiteKey]);
}

/** siteKeyPaused straight from match patterns — the shape the worker mirror carries. */
export function matchesPaused(matches: readonly string[], pausedSiteKeys: readonly string[]): boolean {
  return siteKeyPaused(matchHosts(matches).join("+"), pausedSiteKeys);
}

/** Site-key parts naming a real site, in canonical spelling; `*` names none. */
function ownedHosts(siteKey: string): string[] {
  return canonicalSiteKey(siteKey)
    .split("+")
    .filter((part) => part.length > 0 && part !== "*");
}

/** Either host covering the other, `*.base` style. */
function hostsOverlap(a: string, b: string): boolean {
  return hostMatches(a, `*.${b}`) || hostMatches(b, `*.${a}`);
}

/** Content-script excludeMatches patterns that keep a paused site's pages clear. */
export function siteKeyExcludePatterns(siteKey: string): string[] {
  return ownedHosts(siteKey).flatMap((part) => [`*://${part}/*`, `*://*.${part}/*`]);
}

/**
 * Registration-time patterns: each manifest pattern widened to its whole
 * origin (`scheme://host/*`). The browser evaluates content-script `matches`
 * only when a DOCUMENT is created, so a path-scoped pattern never fires for
 * pages that reach the path via a client-side (history.pushState) navigation
 * — the SPA case. Registration is therefore origin-wide and the manifest's
 * real path matches are applied at runtime (the box for its files, the page
 * agent for the relay's records; worker/injection.ts). Unparseable patterns
 * pass through untouched so registration fails exactly the way it would have
 * without widening.
 */
export function originWidePatterns(patterns: readonly string[]): string[] {
  const wide: string[] = [];
  for (const pattern of patterns) {
    const parsed = parseMatchPattern(pattern);
    const next = parsed === undefined || pattern === "<all_urls>" ? pattern : `${parsed.scheme}://${parsed.host}/*`;
    if (!wide.includes(next)) wide.push(next);
  }
  return wide;
}

/**
 * Whether ANY of a manifest's match patterns reaches every site — an
 * `<all_urls>` entry or a bare `*` host (an all-hosts pattern). Such code
 * runs on the user's bank and webmail with no per-site limit, so activation
 * always puts the scope in front of the user (activation.ts).
 */
export function matchesCoverAllSites(matches: readonly string[]): boolean {
  return matches.some((pattern) => {
    if (pattern === "<all_urls>") return true;
    return parseMatchPattern(pattern)?.host === "*";
  });
}

/**
 * The initiator/request domains a manifest's `matches` confine DNR rules to
 * (C2). Each domain covers itself and its subdomains, matching MV3 `*.base`
 * and DNR's own domain semantics: a `*.example.com` pattern yields
 * `example.com`, an exact `mail.example.com` yields `mail.example.com`.
 * Returns `undefined` when the matches reach every site (`<all_urls>` or a
 * bare `*` host) — such a remixlet's broad scope was itself approved at
 * activation, so its rules are not narrowed here.
 */
export function manifestDnrDomains(matches: readonly string[]): string[] | undefined {
  if (matchesCoverAllSites(matches)) return undefined;
  const domains = new Set<string>();
  for (const pattern of matches) {
    const parsed = parseMatchPattern(pattern);
    if (parsed === undefined || parsed.host === "*") continue;
    domains.add(parsed.host.startsWith("*.") ? parsed.host.slice(2) : parsed.host);
  }
  return [...domains].sort();
}

function schemeSubsumes(broad: string, narrow: string): boolean {
  return broad === "*" || broad === narrow;
}

/** Whether pattern host `broad` covers everything host `narrow` does. */
function hostSubsumes(broad: string, narrow: string): boolean {
  if (broad === "*") return true;
  if (narrow === "*") return false;
  const narrowBase = narrow.startsWith("*.") ? narrow.slice(2) : narrow;
  if (broad.startsWith("*.")) {
    const base = broad.slice(2);
    return narrowBase === base || narrowBase.endsWith(`.${base}`);
  }
  // An exact host covers only the identical exact host — never a wildcard.
  return !narrow.startsWith("*.") && narrow === broad;
}

/** Conservative path-glob subset: `/*` covers everything; else require equality. */
function pathSubsumes(broad: string, narrow: string): boolean {
  return broad === "/*" || broad === narrow;
}

/**
 * Whether match pattern `broad` covers every URL that `narrow` covers. Used to
 * decide version-to-version scope WIDENING without a full glob-subset solver:
 * scheme and host use exact MV3 semantics; path is treated conservatively
 * (`/*` is universal, otherwise equality), so the only error is over-reporting
 * widening — which merely surfaces the approval dialog, never hides scope.
 */
export function matchPatternSubsumes(broad: string, narrow: string): boolean {
  const b = parseMatchPattern(broad);
  const n = parseMatchPattern(narrow);
  if (b === undefined || n === undefined) return false;
  return schemeSubsumes(b.scheme, n.scheme) && hostSubsumes(b.host, n.host) && pathSubsumes(b.path, n.path);
}

/** Whether `next` reaches any origin/path the `previous` patterns did not already cover. */
export function matchesWiden(previous: readonly string[], next: readonly string[]): boolean {
  return next.some((pattern) => !previous.some((prior) => matchPatternSubsumes(prior, pattern)));
}

/**
 * Whether EVERY match pattern stays inside one site — the activation site
 * term (wiki/ops/2026-09-04-security-remediation-plan.md item 7). `siteKey`
 * is the site a conversation is bound to (siteKeyForUrl of its tab), and a
 * pattern fits when its host is that site or a subdomain of it, `www.`
 * included. An ancestor wildcard (`*.example.com` against a binding on
 * `mail.example.com`), an ancestor exact host, an unrelated host, an
 * all-sites host and a malformed pattern all fail: each reaches pages the
 * conversation was never opened on. Composite keys (`a.com+b.com`) accept a
 * pattern inside any part; an empty key fits nothing.
 */
export function matchesWithinSite(matches: readonly string[], siteKey: string): boolean {
  const parts = ownedHosts(siteKey);
  if (parts.length === 0 || matches.length === 0) return false;
  return matches.every((pattern) => {
    const parsed = parseMatchPattern(pattern);
    if (parsed === undefined || parsed.host === "*") return false;
    const base = parsed.host.startsWith("*.") ? parsed.host.slice(2) : parsed.host;
    return parts.some((part) => hostMatches(base, part) || hostMatches(base, `*.${part}`));
  });
}

/**
 * Whether a manifest match pattern is safe to STORE. Returns an error string
 * for a malformed pattern (a host the canonicaliser refuses) and for a
 * `*.`-wildcard that spans a public suffix: a bare TLD like `*.com`, a listed
 * suffix like `*.co.il` or `*.appspot.com`, or a host with suffixes beneath it
 * like `*.amazonaws.com` (public-suffix.ts). Those hand one manifest authority
 * over every unrelated site under that name. `<all_urls>` and a bare `*` host
 * are VALID here and stay storable: their scope is put to the user at
 * activation, not blocked at parse. `undefined` means the pattern is allowed.
 */
export function matchPatternStorageError(pattern: string): string | undefined {
  const parsed = parseMatchPattern(pattern);
  if (parsed === undefined) return "not a valid match pattern (expected scheme://host/path, e.g. *://*.example.com/*)";
  const spanned = wildcardSpannedSuffix(parsed.host);
  if (spanned === undefined) return undefined;
  return spannedSuffixError(parsed.host.slice(2), spanned, (suffix) => `*.yoursite.${suffix}`);
}

/**
 * The public suffix a `*.`-wildcard pattern host spans, if any. A bare `*`
 * and an exact host span nothing here (an exact host is one site).
 */
function wildcardSpannedSuffix(patternHost: string): string | undefined {
  if (!patternHost.startsWith("*.")) return undefined;
  return publicSuffixSpannedBy(patternHost.slice(2));
}

/**
 * The wildcard bases in a manifest's `matches` that span a public suffix —
 * empty for every manifest the write gate accepts today. Stored artifacts
 * predate the full list (parseStoredRemixletManifest skips the storage
 * check so the mirror can always rebuild), so activation treats a non-empty
 * result as broad scope: the dialog says the code runs on every site under
 * that name, and the panel never auto-approves it.
 */
export function matchesSpanningPublicSuffix(matches: readonly string[]): string[] {
  const bases: string[] = [];
  for (const pattern of matches) {
    const parsed = parseMatchPattern(pattern);
    if (parsed === undefined) continue;
    const spanned = wildcardSpannedSuffix(parsed.host);
    const base = parsed.host.slice(2);
    if (spanned !== undefined && !bases.includes(base)) bases.push(base);
  }
  return bases;
}

function hostMatches(hostname: string, patternHost: string): boolean {
  if (patternHost === "*") return true;
  if (patternHost.startsWith("*.")) {
    const base = patternHost.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === patternHost;
}

function globMatches(path: string, glob: string): boolean {
  return new RegExp(pathGlobRegExpSource(glob)).test(path);
}

function pathGlobRegExpSource(glob: string): string {
  const regex = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return `^${regex}$`;
}
