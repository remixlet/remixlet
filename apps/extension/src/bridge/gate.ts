// Runtime URL-gate codegen shared by both worlds' injections. Registration is
// origin-wide (shared/site-key.ts originWidePatterns) because the browser
// evaluates userScripts `matches` only when a document is created — a
// client-side (history.pushState) navigation never re-evaluates them, so a
// path-scoped pattern would miss every SPA route arrival. The injected code
// therefore carries the manifest's REAL matches, compiled here, and decides at
// runtime whether the current URL is one the remixlet is active on. The
// predicate mirrors urlMatchesPattern's MV3 semantics exactly (scheme `*` is
// http+https, `*.host` covers the base domain, ports ignored, path `*`-glob).

import { compileMatchPatterns } from "../shared/site-key.js";

/** A JS expression evaluating to a `(rawUrl) => boolean` active-URL predicate. */
export function urlActivePredicateCode(matches: readonly string[]): string {
  return `((patterns) => (raw) => {
    let url;
    try { url = new URL(raw); } catch { return false; }
    const scheme = url.protocol.replace(/:$/, "");
    const host = url.hostname.toLowerCase();
    const path = url.pathname + url.search;
    return patterns.some((p) => {
      if (p.scheme === "*" ? scheme !== "http" && scheme !== "https" : scheme !== p.scheme) return false;
      if (!(p.host === "*" || (p.host.startsWith("*.") ? host === p.host.slice(2) || host.endsWith("." + p.host.slice(2)) : host === p.host))) return false;
      return new RegExp(p.pathRe).test(path);
    });
  })(${JSON.stringify(compileMatchPatterns(matches))})`;
}
