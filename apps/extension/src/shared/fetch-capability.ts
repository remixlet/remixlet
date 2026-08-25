// Pure parsing/matching for fetch:<host-pattern> capabilities. A pattern is
// either one ASCII hostname ("api.example.com") or a subdomain wildcard
// ("*.example.com", which also covers the apex). Schemes, ports, paths, bare
// wildcards, and embedded credentials are deliberately not capability syntax.

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
  if (isIpv4(host)) return raw;
  const labels = host.split(".");
  if (labels.some((label) => !HOST_LABEL_RE.test(label))) return undefined;
  if (raw.startsWith("*.") && labels.length < 2) return undefined;
  return raw;
}

export function urlMatchesFetchHostPattern(url: URL, pattern: string): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const hostname = url.hostname.toLowerCase();
  if (!pattern.startsWith("*.")) return hostname === pattern;
  const apex = pattern.slice(2);
  return hostname === apex || hostname.endsWith(`.${apex}`);
}

function isIpv4(host: string): boolean {
  const pieces = host.split(".");
  return pieces.length === 4 && pieces.every((piece) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(piece)) return false;
    const value = Number(piece);
    return value >= 0 && value <= 255;
  });
}
