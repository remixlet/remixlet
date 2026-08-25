// THE host-match + site-key module (wiki/handoff.md §8): one shared implementation
// used by remixlet `matches`, capture grouping, and conversation tagging —
// deliberately never two. Pure functions, no extension APIs.

/**
 * Site key: the grouping identity for captures, conversations, and manager
 * UI. Derived from a URL's hostname (lowercased, `www.` stripped) or from a
 * remixlet's match patterns (per-pattern base hosts, deduped, sorted, joined
 * with `+`). Keys are filesystem-safe by construction (hostname charset).
 */
export function siteKeyForUrl(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  return stripWww(hostname) || hostname;
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
  return { scheme: match[1]!, host: match[2]!.toLowerCase(), path: match[3]! };
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
  if (!hostMatches(target.hostname.toLowerCase(), parsed.host)) return false;
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
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return siteKey
    .split("+")
    .some((part) => part.length > 0 && (hostMatches(hostname, part) || hostMatches(hostname, `*.${part}`)));
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

/** siteKeyPaused straight from match patterns — the shape the worker mirror carries. */
export function matchesPaused(matches: readonly string[], pausedSiteKeys: readonly string[]): boolean {
  return siteKeyPaused(matchHosts(matches).join("+"), pausedSiteKeys);
}

/** Site-key parts naming a real site; `*` names none. */
function ownedHosts(siteKey: string): string[] {
  return siteKey.split("+").filter((part) => part.length > 0 && part !== "*");
}

/** Either host covering the other, `*.base` style. */
function hostsOverlap(a: string, b: string): boolean {
  return hostMatches(a, `*.${b}`) || hostMatches(b, `*.${a}`);
}

/** userScripts excludeMatches patterns that keep a paused site's pages clear. */
export function siteKeyExcludePatterns(siteKey: string): string[] {
  return siteKey
    .split("+")
    .filter((part) => part.length > 0 && part !== "*")
    .flatMap((part) => [`*://${part}/*`, `*://*.${part}/*`]);
}

/**
 * Registration-time patterns: each manifest pattern widened to its whole
 * origin (`scheme://host/*`). The browser evaluates userScripts `matches`
 * only when a DOCUMENT is created, so a path-scoped pattern never fires for
 * pages that reach the path via a client-side (history.pushState) navigation
 * — the SPA case. Registration is therefore origin-wide and the injected
 * runtime gate (bridge/gate.ts) enforces the manifest's real path matches.
 * Unparseable patterns pass through untouched so registration fails exactly
 * the way it would have without widening.
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

/** Pre-parsed match pattern, JSON-embeddable in generated injection code. */
export interface CompiledMatchPattern {
  scheme: string;
  host: string;
  /** RegExp source over pathname+search — same glob semantics as globMatches. */
  pathRe: string;
}

/** Compile patterns for the injected runtime gate; malformed ones drop out. */
export function compileMatchPatterns(patterns: readonly string[]): CompiledMatchPattern[] {
  return patterns.flatMap((pattern) => {
    const parsed = parseMatchPattern(pattern);
    return parsed === undefined
      ? []
      : [{ scheme: parsed.scheme, host: parsed.host, pathRe: pathGlobRegExpSource(parsed.path) }];
  });
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
 * A small denylist of multi-label public suffixes a `*.`-wildcard must never
 * span — NOT the full Public Suffix List, just the shapes a hostile manifest
 * would reach for. A single-label base (a bare TLD like `com`) is refused
 * structurally by matchPatternStorageError regardless of this set.
 */
const PUBLIC_SUFFIX_BASES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk", "nhs.uk",
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "id.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.za", "org.za", "gov.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.in", "net.in", "org.in", "gov.in",
  "co.kr", "or.kr",
  "com.mx", "com.tr", "com.sg", "com.hk", "com.tw", "com.ar",
  "github.io", "githubusercontent.com", "gitlab.io", "pages.dev", "workers.dev",
  "netlify.app", "vercel.app", "web.app", "firebaseapp.com", "herokuapp.com",
  "azurewebsites.net", "cloudfront.net", "blogspot.com",
]);

/**
 * Whether a manifest match pattern is safe to STORE. Returns an error string
 * for a malformed pattern and for a `*.`-wildcard that spans a public suffix
 * (a bare TLD like `*.com`, or a known multi-label suffix like `*.co.uk` /
 * `*.github.io`) — those hand one manifest authority over every unrelated site
 * under that suffix. `<all_urls>` and a bare `*` host are VALID here and stay
 * storable: their scope is put to the user at activation, not blocked at parse.
 * `undefined` means the pattern is allowed.
 */
export function matchPatternStorageError(pattern: string): string | undefined {
  if (pattern === "<all_urls>") return undefined;
  const parsed = parseMatchPattern(pattern);
  if (parsed === undefined) return "not a valid match pattern (use scheme://host/path, e.g. https://example.com/*)";
  if (parsed.host === "*") return undefined;
  if (parsed.host.startsWith("*.")) {
    const base = parsed.host.slice(2);
    if (base.split(".").length < 2 || PUBLIC_SUFFIX_BASES.has(base)) {
      return `"*.${base}" spans a public suffix, which would cover every unrelated site under it — name a specific domain such as *.yoursite.${base.split(".").at(-1)}`;
    }
  }
  return undefined;
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
