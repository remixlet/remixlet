// Hostname canonicalisation — the one spelling every host comparison uses
// (wiki/ops/2026-09-04-security-remediation-plan.md item 8). A host reaches
// the extension in several spellings: a page URL (already ASCII and lowercase
// from the URL parser, but possibly with a trailing dot), a manifest match
// pattern (model-written: any case, unicode, trailing dot), a stored site key
// or pause key written by an earlier release. Comparing two spellings of the
// same host as different sites is how a pause on `example.com` failed to cover
// `example.com.`, and how a unicode homograph reached the consent card. Pure
// module, no extension APIs.

/**
 * The canonical form of a bare hostname: lowercase, IDNA (punycode) for
 * non-ASCII labels, no trailing dot. `undefined` when the text is not a
 * hostname at all (empty, spaces, a path or port glued on, characters the
 * URL parser refuses). IPv4 literals and `localhost` canonicalise to
 * themselves; an IPv6 literal keeps its brackets, as URL.hostname does.
 */
export function canonicalHostname(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let url: URL;
  try {
    // The WHATWG URL parser is the converter: it lowercases, applies IDNA and
    // validates the character set — the same conversion a page's own
    // location.hostname went through, so both sides agree by construction.
    url = new URL(`http://${trimmed}/`);
  } catch {
    return undefined;
  }
  // Anything the parser peeled off means the input carried more than a host.
  if (url.username !== "" || url.password !== "" || url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  const hostname = stripTrailingDot(url.hostname);
  // The parser tolerates characters a hostname never has (`*` among them);
  // a wildcard is pattern syntax the callers strip before asking.
  return HOSTNAME_RE.test(hostname) ? hostname : undefined;
}

const HOSTNAME_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*)$/;

/** Canonical hostname of an already-parsed URL (lowercase, no trailing dot). */
export function canonicalUrlHostname(url: URL): string {
  return stripTrailingDot(url.hostname.toLowerCase());
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/** A dotted-quad IPv4 literal — never a domain name, so never a public suffix. */
export function isIpv4Literal(host: string): boolean {
  const pieces = host.split(".");
  return (
    pieces.length === 4 &&
    pieces.every((piece) => /^(?:0|[1-9][0-9]{0,2})$/.test(piece) && Number(piece) <= 255)
  );
}

/** A host with no domain-name structure to classify: loopback names and IP literals. */
export function isNonDomainHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.startsWith("[") || isIpv4Literal(host);
}
