// Public Suffix List classifier (wiki/ops/2026-09-04-security-remediation-plan.md
// item 8; wiki/decisions/public-suffix-list.md). A public suffix is a domain
// under which unrelated parties register names: `co.uk`, `github.io`,
// `appspot.com`, `s3.amazonaws.com`. A `*.`-wildcard over one of those is not
// "one site and its subdomains" — it is every site anyone hosts there — and
// that is what this module exists to tell apart. It answers ONE question for
// the manifest `matches` grammar and the `fetch:` / `network:observe:` host
// grammar alike: does a wildcard on this base span a public suffix?
//
// The data is the vendored list in public-suffix-data.ts (ICANN and PRIVATE
// sections, wildcard and exception rules, IDNA form), parsed once on first
// use. Site grouping stays separate: a site key is still the page's own host,
// and the site term (site-key.ts matchesWithinSite) still rejects scope
// outside it — membership here is a set of known shared boundaries, not proof
// that anything unlisted has a single owner. Pure module, no extension APIs.

import { isNonDomainHost } from "./hostname.js";
import { PUBLIC_SUFFIX_ICANN_RULES, PUBLIC_SUFFIX_LIST_VERSION, PUBLIC_SUFFIX_PRIVATE_RULES } from "./public-suffix-data.js";

export { PUBLIC_SUFFIX_LIST_VERSION };

interface Tables {
  /** Exact rules: `com`, `co.uk`, `appspot.com`. */
  exact: Set<string>;
  /** Bases of wildcard rules: `ck` for `*.ck`, `compute.amazonaws.com` for `*.compute.amazonaws.com`. */
  wildcardBases: Set<string>;
  /** Exception rules, without the `!`: `www.ck`. Registrable despite a wildcard above them. */
  exceptions: Set<string>;
  /**
   * Every proper ancestor of a rule domain that is not itself a rule, mapped to
   * one rule beneath it — `amazonaws.com` → `s3.amazonaws.com`. A wildcard on
   * such an ancestor spans every tenant of every suffix under it (the plan's
   * descendant-suffix product rule), even though the ancestor alone is not a
   * suffix.
   */
  ancestors: Map<string, string>;
}

let tables: Tables | undefined;

function loadTables(): Tables {
  if (tables) return tables;
  const exact = new Set<string>();
  const wildcardBases = new Set<string>();
  const exceptions = new Set<string>();
  for (const line of `${PUBLIC_SUFFIX_ICANN_RULES}\n${PUBLIC_SUFFIX_PRIVATE_RULES}`.split("\n")) {
    if (line.length === 0) continue;
    const [tld, ...tokens] = line.split(" ");
    for (const token of tokens) {
      if (token === ".") exact.add(tld!);
      else if (token === "*") wildcardBases.add(tld!);
      else if (token.startsWith("*.")) wildcardBases.add(`${token.slice(2)}.${tld}`);
      else if (token.startsWith("!")) exceptions.add(`${token.slice(1)}.${tld}`);
      else exact.add(`${token}.${tld}`);
    }
  }
  const ancestors = new Map<string, string>();
  for (const domain of [...exact, ...wildcardBases]) {
    const labels = domain.split(".");
    for (let index = 1; index < labels.length; index += 1) {
      const ancestor = labels.slice(index).join(".");
      if (!exact.has(ancestor) && !wildcardBases.has(ancestor) && !ancestors.has(ancestor)) ancestors.set(ancestor, domain);
    }
  }
  tables = { exact, wildcardBases, exceptions, ancestors };
  return tables;
}

/**
 * Whether a canonical hostname is itself a public suffix: an exact rule, a
 * name one label under a wildcard rule, or a single label (the list's implicit
 * `*` rule: an unlisted top-level label still registers names). Exception
 * rules win over the wildcard above them. Loopback names and IP literals are
 * never suffixes.
 */
export function isPublicSuffix(host: string): boolean {
  if (isNonDomainHost(host)) return false;
  const { exact, wildcardBases, exceptions } = loadTables();
  if (exceptions.has(host)) return false;
  if (exact.has(host)) return true;
  const dot = host.indexOf(".");
  if (dot === -1) return true;
  return wildcardBases.has(host.slice(dot + 1));
}

/**
 * The public suffix a `*.<base>` wildcard would span, or `undefined` when the
 * wildcard stays inside one owner's names. `base` itself when it is a suffix
 * or carries a wildcard rule (`*.ck`: every name under `ck` is a suffix); a
 * descendant rule when a suffix sits beneath it (`amazonaws.com` →
 * `s3.amazonaws.com`). Callers pass the canonical base host.
 */
export function publicSuffixSpannedBy(base: string): string | undefined {
  if (isNonDomainHost(base)) return undefined;
  const { wildcardBases, exceptions, ancestors } = loadTables();
  if (exceptions.has(base)) return undefined;
  if (isPublicSuffix(base) || wildcardBases.has(base)) return base;
  return ancestors.get(base);
}

/** Whether a `*.<base>` wildcard would span a public suffix. */
export function hostSpansPublicSuffix(base: string): boolean {
  return publicSuffixSpannedBy(base) !== undefined;
}

/** The one sentence every wildcard-on-a-suffix refusal uses, whichever grammar raised it. */
export function spannedSuffixError(base: string, spanned: string, example: (suffix: string) => string): string {
  const reach =
    spanned === base
      ? `"*.${base}" spans a public suffix, which would cover every unrelated site under it`
      : `"*.${base}" spans shared hosting (${spanned} and other public suffixes sit under it), which would cover every unrelated site hosted there`;
  return `${reach} — name a specific domain such as ${example(spanned)}`;
}
