// Pure parsing/matching for fetch:<host-pattern> capabilities. A pattern is
// either one ASCII hostname ("api.example.com") or a subdomain wildcard
// ("*.example.com", which also covers the apex). Schemes, ports, paths, bare
// wildcards, and embedded credentials are deliberately not capability syntax.
//
// Two layers, like manifest matches (site-key.ts): hostPatternFromRaw is the
// GRAMMAR, which every stored capability must keep passing so the mirror can
// rebuild; hostPatternStorageError is the WRITE gate, which also refuses a
// wildcard spanning a public suffix (`fetch:*.appspot.com` reaches every
// tenant) and a bare suffix host (`fetch:com` matches only the literal host
// `com`, which is almost nothing — a mistake, not a reach). Stored grants that
// predate the gate are the compatibility case wiki/decisions/public-suffix-list.md
// records: they keep parsing and keep their exact semantics.

import { canonicalUrlHostname, isIpv4Literal } from "./hostname.js";
import { isPublicSuffix, publicSuffixSpannedBy, spannedSuffixError } from "./public-suffix.js";

export const FETCH_CAPABILITY_PREFIX = "fetch:";

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function fetchHostPattern(capability: string): string | undefined {
  if (!capability.startsWith(FETCH_CAPABILITY_PREFIX)) return undefined;
  return hostPatternFromRaw(capability.slice(FETCH_CAPABILITY_PREFIX.length));
}

/** Validate a bare host pattern — shared with network:observe:<host-pattern>. */
export function hostPatternFromRaw(raw: string): string | undefined {
  const host = raw.startsWith("*.") ? raw.slice(2) : raw;
  if (host.length === 0 || host.length > 253 || host !== host.toLowerCase()) return undefined;
  if (host === "localhost") return raw;
  if (isIpv4Literal(host)) return raw;
  const labels = host.split(".");
  if (labels.some((label) => !HOST_LABEL_RE.test(label))) return undefined;
  if (raw.startsWith("*.") && labels.length < 2) return undefined;
  return raw;
}

/**
 * Why a validated host pattern must not be STORED as a new grant, or undefined
 * when it may. `prefix` is the capability prefix the message names
 * (`fetch:` or `network:observe:`). Grammar failures are the caller's
 * (hostPatternFromRaw); this only judges the reach of a well-formed pattern.
 */
export function hostPatternStorageError(raw: string, prefix: string): string | undefined {
  const wildcard = raw.startsWith("*.");
  const host = wildcard ? raw.slice(2) : raw;
  if (wildcard) {
    const spanned = publicSuffixSpannedBy(host);
    if (spanned === undefined) return undefined;
    return spannedSuffixError(host, spanned, (suffix) => `${prefix}*.yourservice.${suffix}`);
  }
  if (!isPublicSuffix(host)) return undefined;
  return `"${prefix}${host}" names a public suffix, so it would match only the literal host "${host}" and reach almost nothing — name the specific host the code calls, such as ${prefix}api.yourservice.${host}`;
}

/**
 * The host patterns from a remixlet's approved capabilities that may admit a
 * DOM URL (BoxRemixletSpec.grantedHosts, judged by box/policy.ts). `fetch:`
 * grants only: a `network:observe:` grant is permission to WATCH a host's
 * responses, and watching is not permission to make new requests there
 * (wiki/ops/2026-09-12-security-review-plan.md, F2). Order-preserving and
 * de-duplicated.
 */
export function urlGrantedHostPatterns(capabilities: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const capability of capabilities) {
    const pattern = fetchHostPattern(capability);
    if (pattern !== undefined && !hosts.includes(pattern)) hosts.push(pattern);
  }
  return hosts;
}

export function urlMatchesFetchHostPattern(url: URL, pattern: string): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const hostname = canonicalUrlHostname(url);
  if (!pattern.startsWith("*.")) return hostname === pattern;
  const apex = pattern.slice(2);
  return hostname === apex || hostname.endsWith(`.${apex}`);
}
