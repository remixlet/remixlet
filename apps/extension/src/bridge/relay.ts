// The MAIN-world relay for network:observe (wiki/design/mediated-execution.md,
// §Parts and §The relay). A file shipped in the
// package (relay.js, entry relay-entry.ts), registered ONCE per document as a
// MAIN-world content script at document_start (worker/injection.ts), never
// generated: nothing per remixlet is pasted into source text. It wraps fetch
// and XMLHttpRequest transparently (the page always receives the original
// response; observation reads a clone), keeps every textual http(s) response
// body in a bounded ring, and posts each one to the page agent as a DOM
// CustomEvent. The agent holds each box's manifest matches and granted observe
// patterns and decides which boxes, if any, receive a response
// (box/page-agent.ts). Configuration never becomes code here: no eval, no
// Function, no string timers, no field of any event is executed.
//
// Transport is a DOM CustomEvent named with a per-DOCUMENT token and carrying
// a JSON-string detail. The token is exchanged through the DOM at
// document_start, before any page script runs: the relay mints it and writes
// it as an attribute on <html>; the page agent, an ISOLATED-world
// document_start script on the same document, reads and removes it
// (claimRelayToken). Whichever of the two Chrome runs first, the attribute is
// gone before the parser reaches the page's first <script>; the relay suite
// proves it against a fixture whose <head> inline script looks for the
// attribute and fetches at once. The relay
// captures the DOM natives it needs (CustomEvent, dispatchEvent,
// addEventListener, getRandomValues) into its closure at the same moment, so
// a page that later swaps window.CustomEvent or document.dispatchEvent cannot
// read the token off a dispatched event and forge relay traffic under it.
//
// Trust posture: the MAIN world is page-shared, so everything crossing the
// relay is UNTRUSTED PAGE DATA. The token names the channel and carries no
// authority; the capability-bearing bridgeToken never enters the MAIN world.

export function relayEventName(relayToken: string): string {
  return `rmx-relay:${relayToken}`;
}

export function relaySyncEventName(relayToken: string): string {
  return `rmx-relay-sync:${relayToken}`;
}

/** The agent's host filter for the ring (announceRelayFilter); detail JSON `{ hosts: string[] }`. */
export function relayFilterEventName(relayToken: string): string {
  return `rmx-relay-filter:${relayToken}`;
}

/** Host patterns one filter may carry; a longer list is cut, never executed. */
export const RELAY_FILTER_HOSTS_CAP = 64;

/**
 * The <html> attribute the relay writes its token to and the page agent
 * removes. Present only between the two document_start scripts.
 */
export const RELAY_TOKEN_ATTRIBUTE = "data-rmx-relay-token";

/**
 * Ring buffer size for observed responses (late consumers get a replay).
 * Matches Chrome's default resource-timing buffer (250): at 50 a busy page's
 * tracking/poll chatter evicted load-time data responses within seconds (the
 * soundcloud /stream feed body was gone before the agent's first read). The
 * byte budget below is the real memory bound; this cap only limits entries.
 */
export const OBSERVE_BUFFER_MAX = 250;

/** Per-response body cap for observed responses, in characters. */
export const OBSERVE_BODY_CAP = 512 * 1024;

/**
 * Total body characters the ring may hold — the entry cap alone would admit
 * OBSERVE_BUFFER_MAX × OBSERVE_BODY_CAP in the worst case. Oldest-first
 * eviction, same as the entry cap.
 */
export const OBSERVE_BUFFER_BYTE_BUDGET = 6 * 1024 * 1024;

/** One response the relay recorded; what `network:response` carries. */
export interface ObservedResponse {
  seq: number;
  /** Absolute URL. */
  url: string;
  /** Upper-cased request method; "GET" when the request named none. */
  method: string;
  status: number;
  contentType: string | null;
  body: string;
  /** The stored body was cut at OBSERVE_BODY_CAP. */
  truncated: boolean;
}

/** What the fetch/XHR wrappers hand the ring: a response whose text has arrived. */
export interface CapturedResponse {
  rawUrl: string;
  method: string;
  status: number;
  contentType: string | null;
  text: string;
}

export interface RelayPayloads {
  "network:response": ObservedResponse;
  "navigation:change": { url: string };
}

/**
 * Textual bodies only: JSON (with +json suffixes), XML, text/* and script
 * bodies. Broad observation of media and asset bodies would buffer megabytes
 * for nothing, and a body without a content type is read as text (a fetch
 * Response built from a string reports text/plain; a truly typeless body is
 * still capped).
 */
export function isTextualContentType(contentType: string | null): boolean {
  if (contentType === null || contentType === "") return true;
  const lower = contentType.toLowerCase();
  return lower.startsWith("text/") || lower.includes("json") || lower.includes("xml") || lower.includes("javascript");
}

function isHttpUrl(raw: string, base: string): boolean {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/**
 * The fetch:/network:observe: host-pattern grammar (shared/fetch-capability.ts
 * urlMatchesFetchHostPattern, without the public-suffix module the relay has
 * no use for): an exact host, or `*.apex` covering the apex and every
 * subdomain. Hostnames arrive lower-cased from URL.
 */
export function hostMatchesObservePattern(hostname: string, pattern: string): boolean {
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!pattern.startsWith("*.")) return host === pattern;
  const apex = pattern.slice(2);
  return host === apex || host.endsWith(`.${apex}`);
}

// ---------------------------------------------------------------------------
// Natives

/**
 * The DOM natives the relay uses after document_start, bound at install time.
 * A page that later replaces window.CustomEvent or document.dispatchEvent
 * gets the replacement for its own use; the relay keeps these.
 */
export interface RelayNatives {
  CustomEvent: typeof CustomEvent;
  dispatchEvent: (event: Event) => boolean;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  getRandomValues: (array: Uint8Array) => Uint8Array;
  URL: typeof URL;
  Request: typeof Request;
  resolve: <Value>(value: Value | PromiseLike<Value>) => Promise<Value>;
}

export function captureNatives(window: Window & typeof globalThis): RelayNatives {
  const document = window.document;
  const crypto = window.crypto;
  return {
    CustomEvent: window.CustomEvent,
    dispatchEvent: document.dispatchEvent.bind(document),
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    getRandomValues: crypto.getRandomValues.bind(crypto),
    URL: window.URL,
    Request: window.Request,
    resolve: window.Promise.resolve.bind(window.Promise),
  };
}

/** 128 random bits as hex; works in insecure contexts too (randomUUID does not). */
export function mintRelayToken(natives: RelayNatives): string {
  const bytes = natives.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Ring buffer

export interface ResponseRing {
  /** Record one response; returns the stored entry (its body already capped). */
  record(captured: CapturedResponse, base: string): ObservedResponse;
  /** Drop every held entry the predicate refuses. */
  retain(keep: (entry: ObservedResponse) => boolean): void;
  /** Oldest first. */
  entries(): ObservedResponse[];
  /** Entries currently held. */
  size(): number;
  /** Every response ever recorded, evicted ones included. */
  recorded(): number;
}

export interface ResponseRingOptions {
  max: number;
  byteBudget: number;
  /**
   * Keep only the LATEST body per URL+method: pages poll endpoints (an
   * activities check every few seconds), and identical polls evicting
   * distinct load-time responses is how the soundcloud /stream feed body
   * vanished before the agent could read it. seq keeps counting every
   * response ever recorded, so a reader can report the gap honestly.
   */
  latestPerUrl: boolean;
}

export function createResponseRing(options: ResponseRingOptions): ResponseRing {
  const buffer: ObservedResponse[] = [];
  let bytes = 0;
  let seq = 0;
  return {
    record(captured, base) {
      let url = captured.rawUrl;
      try {
        url = new URL(captured.rawUrl, base).href;
      } catch {
        // Keep the raw form; the wrappers only hand over http(s) URLs.
      }
      const text = captured.text;
      const entry: ObservedResponse = {
        seq: (seq += 1),
        url,
        method: captured.method === "" ? "GET" : captured.method.toUpperCase(),
        status: captured.status,
        contentType: captured.contentType === "" ? null : captured.contentType,
        body: text.length > OBSERVE_BODY_CAP ? text.slice(0, OBSERVE_BODY_CAP) : text,
        truncated: text.length > OBSERVE_BODY_CAP,
      };
      if (options.latestPerUrl) {
        for (let index = buffer.length - 1; index >= 0; index -= 1) {
          const held = buffer[index]!;
          if (held.url === entry.url && held.method === entry.method) {
            bytes -= held.body.length;
            buffer.splice(index, 1);
            break;
          }
        }
      }
      buffer.push(entry);
      bytes += entry.body.length;
      while (buffer.length > options.max || bytes > options.byteBudget) {
        bytes -= buffer.shift()!.body.length;
      }
      return entry;
    },
    retain(keep) {
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const held = buffer[index]!;
        if (keep(held)) continue;
        bytes -= held.body.length;
        buffer.splice(index, 1);
      }
    },
    entries: () => buffer.slice(),
    size: () => buffer.length,
    recorded: () => seq,
  };
}

// ---------------------------------------------------------------------------
// fetch / XHR capture

/**
 * Wrap window.fetch and XMLHttpRequest so every textual http(s) response body
 * reaches `onResponse` once its text has arrived. Transparent pass-through:
 * the page receives the ORIGINAL promise, response and XHR events; a body is
 * read from a clone (fetch) or from the finished request (XHR). Anything the
 * page hands in that is not a string, URL or Request is passed through
 * unobserved rather than inspected.
 */
export function installNetworkCapture(
  window: Window & typeof globalThis,
  natives: RelayNatives,
  onResponse: (captured: CapturedResponse) => void,
): void {
  const base = (): string => window.location.href;
  const requestUrlOf = (input: RequestInfo | URL): string =>
    isString(input) ? input : input instanceof natives.URL ? input.href : input instanceof natives.Request ? input.url : "";
  const requestMethodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string => {
    if (init !== undefined && isString(init.method)) return init.method;
    return input instanceof natives.Request ? input.method : "GET";
  };

  const originalFetch = window.fetch;
  if (originalFetch instanceof Function) {
    window.fetch = function (this: Window | undefined, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const result = originalFetch.call(this, input, init);
      try {
        const rawUrl = requestUrlOf(input);
        const method = requestMethodOf(input, init);
        if (rawUrl !== "" && isHttpUrl(rawUrl, base())) {
          // Every failure along the way (a rejected fetch, a body that cannot
          // be cloned or read, a throwing consumer) ends here, unobserved.
          void natives
            .resolve(result)
            .then((response) => {
              const contentType = response.headers.get("content-type");
              if (!isTextualContentType(contentType)) return undefined;
              return response
                .clone()
                .text()
                .then((text) => onResponse({ rawUrl, method, status: response.status, contentType, text }));
            })
            .catch(() => undefined);
        }
      } catch {
        // Observation never changes what the page gets back.
      }
      return result;
    };
  }

  const Xhr = window.XMLHttpRequest;
  // Stashed per request in a WeakMap, not on the object: an expando would be
  // page-visible and page-writable.
  const opened = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  const originalOpen = Xhr.prototype.open;
  const originalSend = Xhr.prototype.send;
  Xhr.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    try {
      opened.set(this, { url: isString(url) ? url : String(url), method: isString(method) ? method : String(method) });
    } catch {
      // A request whose arguments cannot be read is simply not observed.
    }
    // The two-argument form is the five-argument form with async true.
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };
  Xhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    try {
      const request = opened.get(this);
      if (request !== undefined && isHttpUrl(request.url, base())) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
            const contentType = this.getResponseHeader("content-type");
            if (!isTextualContentType(contentType)) return;
            const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
            onResponse({ rawUrl: request.url, method: request.method, status: this.status, contentType, text: text ?? "" });
          } catch {
            // Same rule: a body that cannot be read is not observed.
          }
        });
      }
    } catch {
      // Same rule.
    }
    return originalSend.call(this, body);
  };
}

// ---------------------------------------------------------------------------
// Token exchange

/** Write the token on <html>; false when the document has no root yet (nothing to relay to). */
export function publishRelayToken(document: Document, token: string): boolean {
  const root = document.documentElement;
  if (root === null) return false;
  root.setAttribute(RELAY_TOKEN_ATTRIBUTE, token);
  return true;
}

/**
 * The agent's announcement of which hosts anyone on this page may observe:
 * the union of the granted network:observe patterns of the remixlets the
 * worker resolved for the page (worker/box.ts handleAgentHello), sent under
 * the token so the page cannot forge it. The relay drops everything else
 * from its ring and records nothing else afterwards: this is the one URL
 * gate the relay keeps, and it exists to bound buffering, not to decide
 * delivery (the agent still decides per box). Empty means nobody listens
 * here and the ring is cleared.
 */
export function announceRelayFilter(document: Document, relayToken: string, hosts: readonly string[]): void {
  document.dispatchEvent(new CustomEvent(relayFilterEventName(relayToken), { detail: JSON.stringify({ hosts }) }));
}

/** The hosts of a filter announcement's detail; undefined for anything that is not one. */
function parseRelayFilter(detail: string): string[] | undefined {
  let parsed: { hosts?: string[] };
  try {
    // SAFETY: announceRelayFilter serializes { hosts: string[] }; anything else fails the checks below.
    parsed = JSON.parse(detail) as { hosts?: string[] };
  } catch {
    return undefined;
  }
  if (Object.prototype.toString.call(parsed) !== "[object Object]" || !Array.isArray(parsed.hosts)) return undefined;
  return parsed.hosts.filter(isString).slice(0, RELAY_FILTER_HOSTS_CAP);
}

export interface RelayTokenClaim {
  /** The token, once the relay has published it; undefined while it has not. */
  current(): string | undefined;
  /** How it arrived: read at once (the relay ran first) or through the attribute observer (the agent ran first). */
  how(): "read" | "observed" | "none";
}

/**
 * The page agent's half of the exchange, run synchronously at document_start.
 * Relay first: the attribute is already there, read it and remove it. Agent
 * first: nothing is written (a marker on every page the agent visits would
 * tell the page the extension is installed, and most pages the agent visits
 * have no relay), so an attribute observer on <html> waits for the relay's
 * write and removes it in the microtask that follows the relay's own script,
 * still ahead of the page's first <script>. The observer is dropped once the
 * token is in hand or the document has parsed: after that no document_start
 * script can follow.
 */
export function claimRelayToken(document: Document): RelayTokenClaim {
  let token: string | undefined;
  let how: "read" | "observed" | "none" = "none";
  const root = document.documentElement;
  const take = (): boolean => {
    const value = root.getAttribute(RELAY_TOKEN_ATTRIBUTE);
    if (value === null || value === "") return false;
    root.removeAttribute(RELAY_TOKEN_ATTRIBUTE);
    token = value;
    return true;
  };
  if (take()) {
    how = "read";
  } else {
    const observer = new MutationObserver(() => {
      if (!take()) return;
      how = "observed";
      observer.disconnect();
    });
    observer.observe(root, { attributes: true, attributeFilter: [RELAY_TOKEN_ATTRIBUTE] });
    document.addEventListener("DOMContentLoaded", () => observer.disconnect(), { once: true });
  }
  return { current: () => token, how: () => how };
}

// ---------------------------------------------------------------------------
// The relay itself

export interface RelayInstallation {
  /** The per-document token; undefined when the document had no root to publish it on. */
  token: string | undefined;
}

/**
 * Install the relay on a document: publish the token, wrap fetch and XHR,
 * post every recorded response live and replay the ring on the agent's sync
 * event. The ring holds textual responses for the document's life, bounded
 * by OBSERVE_BUFFER_MAX and OBSERVE_BUFFER_BYTE_BUDGET. Until the agent's
 * filter announcement lands (the hello round trip after document_start, a
 * few tens of milliseconds) it holds every host's, because the relay is
 * handed no configuration at registration; from then on it holds only the
 * announced hosts', so another host's chatter cannot evict a granted body
 * that arrived before a box attached (the load-time feed response is exactly
 * what a remixlet is waiting for). Which paths a remixlet claims and which
 * box hears what stay the agent's decisions. The replay is synchronous: the
 * sync listener re-posts the whole ring during the agent's dispatch, so the
 * agent can rely on a replay never interleaving with a live record (its
 * per-box seq high-water mark depends on that).
 */
export function installRelay(window: Window & typeof globalThis): RelayInstallation {
  const natives = captureNatives(window);
  const token = mintRelayToken(natives);
  if (!publishRelayToken(window.document, token)) return { token: undefined };
  const ring = createResponseRing({ max: OBSERVE_BUFFER_MAX, byteBudget: OBSERVE_BUFFER_BYTE_BUDGET, latestPerUrl: false });
  const post = <Topic extends keyof RelayPayloads>(topic: Topic, data: RelayPayloads[Topic]): void => {
    try {
      natives.dispatchEvent(new natives.CustomEvent(relayEventName(token), { detail: JSON.stringify({ topic, data }) }));
    } catch {
      // A listener that throws is the agent's problem, never the page's.
    }
  };
  let hostFilter: string[] | undefined;
  const wanted = (url: string): boolean => {
    if (hostFilter === undefined) return true;
    let hostname: string;
    try {
      hostname = new natives.URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return hostFilter.some((pattern) => hostMatchesObservePattern(hostname, pattern));
  };
  installNetworkCapture(window, natives, (captured) => {
    if (!wanted(new natives.URL(captured.rawUrl, window.location.href).href)) return;
    post("network:response", ring.record(captured, window.location.href));
  });
  natives.addEventListener(relaySyncEventName(token), () => {
    for (const entry of ring.entries()) post("network:response", entry);
  });
  natives.addEventListener(relayFilterEventName(token), (event) => {
    const hosts = parseRelayFilter(event instanceof natives.CustomEvent ? String(event.detail) : "");
    if (hosts === undefined) return;
    hostFilter = hosts;
    ring.retain((entry) => wanted(entry.url));
  });

  // SPA navigation hint: only this world sees the page's history calls. The
  // agent notices same-document navigations itself (the Navigation API in its
  // world) and treats this as a fallback; it carries no page data and no
  // authority (receivers re-read location.href).
  const postNav = (): void => post("navigation:change", { url: window.location.href });
  const history = window.history;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    if (!(original instanceof Function)) continue;
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>): void {
      original.apply(this, args);
      postNav();
    };
  }
  window.addEventListener("popstate", postNav);
  window.addEventListener("hashchange", postNav);
  return { token };
}
