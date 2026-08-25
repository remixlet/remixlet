// The privileged network boundary for rmx.fetch. "Privileged" because the
// request runs from the extension context under its host permissions — it
// carries the user's cookies and is not subject to page CORS — so this
// module owns every control on that power: the worker supplies an already
// authenticated grant predicate, and this module performs the actual fetch
// with manual redirect validation, method/header policy, byte caps, and a
// deadline. No Response object or extension-origin detail crosses the
// bridge.

import { ext } from "./ext.js";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

const FetchOptionsSchema = Type.Object({
  method: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]))),
  body: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});
type FetchOptionsInput = Static<typeof FetchOptionsSchema>;
type FetchInput = string | FetchOptionsInput;

export interface PrivilegedFetchRequest {
  url: FetchInput;
  options?: FetchInput;
}

export interface PrivilegedFetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  content: string;
  redirected: boolean;
}

export const FETCH_REQUEST_MAX_BYTES = 1024 * 1024;
export const FETCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MAX_MS = 30_000;

const FETCH_TIMEOUT_DEFAULT_MS = 15_000;
const FETCH_MAX_REDIRECTS = 5;
const FETCH_HEADERS_MAX_BYTES = 32 * 1024;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const FORBIDDEN_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);
interface ParsedOptions {
  method: string;
  headers: Headers;
  body?: string;
  timeoutMs: number;
}

export async function privilegedFetch(
  request: PrivilegedFetchRequest,
  isAllowed: (url: URL) => boolean,
): Promise<PrivilegedFetchResult> {
  const initialUrl = parseUrl(request.url);
  if (!isAllowed(initialUrl)) throw new Error("URL is outside the granted fetch host patterns");
  const options = parseOptions(request.options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  let url = initialUrl;
  let method = options.method;
  let body = options.body;
  let headers = new Headers(options.headers);
  let redirected = false;
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const hop = await fetchOneHop(url, method, headers, body, controller);
      if ("redirectUrl" in hop) {
        if (redirectCount >= FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
        const nextUrl = parseUrl(hop.redirectUrl);
        if (!isAllowed(nextUrl)) throw new Error("redirect escaped the granted fetch host patterns");
        redirected = true;
        if (nextUrl.origin !== url.origin) {
          headers = new Headers(headers);
          headers.delete("authorization");
        }
        if (
          (hop.statusCode === 303 && method !== "GET" && method !== "HEAD") ||
          ((hop.statusCode === 301 || hop.statusCode === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          headers = new Headers(headers);
          for (const name of ["content-encoding", "content-language", "content-location", "content-type"]) {
            headers.delete(name);
          }
        }
        url = nextUrl;
        continue;
      }

      const response = hop.response;
      const content = method === "HEAD" ? "" : await readBoundedText(response, controller.signal);
      return {
        url: response.url || url.href,
        status: response.status,
        statusText: response.statusText,
        headers: safeResponseHeaders(response.headers),
        content,
        redirected,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chrome extension fetch currently follows redirects even with
 * redirect:"manual". redirect:"error" is the only mode that guarantees the
 * browser will not issue the next request. webRequest reveals the proposed
 * target; we then validate it and perform that hop ourselves.
 */
async function fetchOneHop(
  url: URL,
  method: string,
  headers: Headers,
  body: string | undefined,
  controller: AbortController,
): Promise<{ response: Response } | { redirectUrl: string; statusCode: number }> {
  let redirect: { redirectUrl: string; statusCode: number } | undefined;
  let resolveRedirect: (() => void) | undefined;
  const redirectObserved = new Promise<void>((resolve) => {
    resolveRedirect = resolve;
  });
  const expectedUrl = withoutFragment(url);
  const onBeforeRedirect = (details: chrome.webRequest.WebRedirectionResponseDetails): void => {
    if (details.url === expectedUrl && details.method === method) {
      redirect = { redirectUrl: details.redirectUrl, statusCode: details.statusCode };
      resolveRedirect?.();
    }
  };
  ext.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, { urls: ["<all_urls>"] });
  try {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      return { response };
    } catch {
      // Chrome dispatches the redirect event before rejecting fetch, but the
      // listener callback can be delivered on a later task (notably on Linux
      // CI). Give that authoritative event a bounded window to arrive.
      if (redirect === undefined && !controller.signal.aborted) {
        await Promise.race([
          redirectObserved,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      if (redirect !== undefined) return redirect;
      if (controller.signal.aborted) throw new Error("fetch request timed out");
      throw new Error("network request failed");
    }
  } finally {
    ext.webRequest.onBeforeRedirect.removeListener(onBeforeRedirect);
  }
}

function withoutFragment(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href;
}

function parseUrl(value: FetchInput): URL {
  if (!Check(Type.String(), value)) throw new Error("fetch URL must be a string");
  const href = Parse(Type.String(), value);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error("fetch URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("fetch URL must be HTTP(S) without embedded credentials");
  }
  return url;
}

function parseOptions(value: FetchInput | undefined): ParsedOptions {
  if (value !== undefined && !Check(FetchOptionsSchema, value)) throw new Error("fetch options must be an object");
  const raw = value === undefined ? {} : Parse(FetchOptionsSchema, value);
  const method = raw.method === undefined ? "GET" : raw.method.toUpperCase();
  if (!METHODS.has(method)) throw new Error(`fetch method "${method}" is not allowed`);

  const headers = new Headers();
  if (raw.headers !== undefined) {
    let headerBytes = 0;
    for (const pair of raw.headers) {
      const name = pair[0].toLowerCase();
      if (
        FORBIDDEN_HEADERS.has(name) ||
        name.startsWith("sec-") ||
        name.startsWith("proxy-") ||
        !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
      ) {
        throw new Error(`fetch header "${pair[0]}" is not allowed`);
      }
      if (/[\0\r\n]/.test(pair[1])) throw new Error(`fetch header "${pair[0]}" has an invalid value`);
      headerBytes += pair[0].length + pair[1].length;
      if (headerBytes > FETCH_HEADERS_MAX_BYTES) throw new Error("fetch request headers are too large");
      headers.append(pair[0], pair[1]);
    }
  }

  let body: string | undefined;
  if (raw.body !== undefined) {
    if (method === "GET" || method === "HEAD") throw new Error(`${method} requests cannot have a body`);
    if (new TextEncoder().encode(raw.body).byteLength > FETCH_REQUEST_MAX_BYTES) {
      throw new Error(`fetch request body exceeds ${FETCH_REQUEST_MAX_BYTES} bytes`);
    }
    body = raw.body;
  }

  const timeoutMs = raw.timeoutMs ?? FETCH_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > FETCH_TIMEOUT_MAX_MS) {
    throw new Error(`fetch timeoutMs must be an integer from 1 to ${FETCH_TIMEOUT_MAX_MS}`);
  }
  return { method, headers, body, timeoutMs };
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > FETCH_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`fetch response exceeds ${FETCH_RESPONSE_MAX_BYTES} bytes`);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        if (signal.aborted) throw new Error("fetch request timed out");
        throw new Error("network response failed");
      }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > FETCH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`fetch response exceeds ${FETCH_RESPONSE_MAX_BYTES} bytes`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeResponseHeaders(headers: Headers): [string, string][] {
  return [...headers.entries()].filter(([name]) => name !== "set-cookie" && name !== "set-cookie2");
}
