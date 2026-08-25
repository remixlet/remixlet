// MAIN-world codegen: the MAIN↔USER_SCRIPT relay and the network:observe
// interceptor library (wiki/raw/handoffs/network-data-visibility.md §Layer 3 and
// §mixed-world). Extension-authored, injected AHEAD of a remixlet's own
// MAIN-world files; remixlet MAIN code never gets the rmx.* bridge — only the
// lexical `rmxRelay` handle this module provides.
//
// Transport is a DOM CustomEvent with a per-remixlet token in the event name
// and a JSON-string detail. The IIFE captures the DOM natives it needs
// (CustomEvent, dispatchEvent, addEventListener) into its closure at
// document_start, before any page script runs, so the per-remixlet relay token
// stays inside this closure: a page that later swaps window.CustomEvent or
// document.dispatchEvent cannot read the token off a dispatched event and forge
// relay traffic under it. The page still shares the MAIN world, so the trust
// posture is unchanged — everything crossing the relay is UNTRUSTED PAGE DATA
// and the token authenticates the channel, it does not carry capability
// authority (the capability-bearing bridgeToken deliberately never enters the
// MAIN world).

import { urlActivePredicateCode } from "./gate.js";

export function relayEventName(relayToken: string): string {
  return `rmx-relay:${relayToken}`;
}

export function relaySyncEventName(relayToken: string): string {
  return `rmx-relay-sync:${relayToken}`;
}

export interface MainWorldFile {
  code: string;
  runAt?: "document_start" | "document_end" | "document_idle";
}

export interface MainWorldCodeOptions {
  relayToken: string;
  /** The manifest's REAL matches — registration is origin-wide (injection.ts). */
  matches: readonly string[];
  /** GRANTED network:observe host patterns; empty = no interceptor. */
  observePatterns: string[];
  /** The remixlet's own MAIN-world files, in manifest order. */
  files: MainWorldFile[];
  /** The runAt the whole registration was scheduled with. */
  registrationRunAt: "document_start" | "document_end" | "document_idle";
}

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

/**
 * One self-contained IIFE for a remixlet's MAIN-world registration:
 * relay first, interceptor (when granted) second, remixlet files last — each
 * file isolated in its own try/catch so one failure cannot kill the rest.
 */
export function mainWorldCode(options: MainWorldCodeOptions): string {
  const interceptorBody =
    options.observePatterns.length === 0
      ? ""
      : `
  // network:observe interceptor — transparent pass-through: the page always
  // receives the ORIGINAL response/promise; observation reads a clone.
  const observePatterns = ${JSON.stringify(options.observePatterns)};
  const hostMatches = (hostname) =>
    observePatterns.some((pattern) =>
      pattern.startsWith("*.")
        ? hostname === pattern.slice(2) || hostname.endsWith("." + pattern.slice(2))
        : hostname === pattern);
  const urlMatches = (raw) => {
    try {
      const url = new URL(raw, location.href);
      return (url.protocol === "http:" || url.protocol === "https:") && hostMatches(url.hostname.toLowerCase());
    } catch { return false; }
  };
  const observeBuffer = [];
  let observeBufferBytes = 0;
  let observeSeq = 0;
  const record = (rawUrl, status, contentType, bodyText) => {
    const text = String(bodyText == null ? "" : bodyText);
    let url = rawUrl;
    try { url = new URL(rawUrl, location.href).href; } catch {}
    const entry = {
      seq: (observeSeq += 1),
      url,
      status,
      contentType: contentType || null,
      body: text.length > ${OBSERVE_BODY_CAP} ? text.slice(0, ${OBSERVE_BODY_CAP}) : text,
      truncated: text.length > ${OBSERVE_BODY_CAP},
    };
    observeBuffer.push(entry);
    observeBufferBytes += entry.body.length;
    while (observeBuffer.length > ${OBSERVE_BUFFER_MAX} || observeBufferBytes > ${OBSERVE_BUFFER_BYTE_BUDGET}) {
      observeBufferBytes -= observeBuffer.shift().body.length;
    }
    post("network:response", entry);
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function () {
      const result = originalFetch.apply(this, arguments);
      try {
        const input = arguments[0];
        const rawUrl = typeof input === "string" ? input
          : input instanceof URL ? input.href
          : input && typeof input.url === "string" ? input.url : "";
        if (rawUrl && urlMatches(rawUrl) && result && typeof result.then === "function") {
          result.then((response) => {
            try {
              if (!response || typeof response.clone !== "function") return;
              const clone = response.clone();
              clone.text().then(
                (text) => record(rawUrl, response.status, response.headers && response.headers.get("content-type"), text),
                () => {},
              );
            } catch {}
          }, () => {});
        }
      } catch {}
      return result;
    };
  }
  const Xhr = window.XMLHttpRequest;
  if (Xhr && Xhr.prototype) {
    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    Xhr.prototype.open = function (method, url) {
      try { this.__rmxObservedUrl = typeof url === "string" ? url : String(url); } catch {}
      return originalOpen.apply(this, arguments);
    };
    Xhr.prototype.send = function () {
      try {
        const rawUrl = this.__rmxObservedUrl;
        if (rawUrl && urlMatches(rawUrl)) {
          this.addEventListener("load", () => {
            try {
              if (this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
              const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
              record(rawUrl, this.status, this.getResponseHeader("content-type"), text);
            } catch {}
          });
        }
      } catch {}
      return originalSend.apply(this, arguments);
    };
  }
  docAddEventListener(${JSON.stringify(relaySyncEventName(options.relayToken))}, () => {
    for (const entry of observeBuffer.slice()) post("network:response", entry);
  });
`;

  const files = options.files
    .map((file) => {
      const body = `try { (function () {\n${file.code}\n}).call(undefined); } catch (error) { console.error("[remixlet] MAIN-world script failed", error); }`;
      // A registration pulled to document_start (the nav watcher pins every
      // MAIN registration there) must not surprise files authored for a later
      // phase — defer them to DOM-ready.
      const wantsDom = (file.runAt ?? "document_idle") !== "document_start";
      if (options.registrationRunAt === "document_start" && wantsDom) {
        return `if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", function () { ${body} }); } else { ${body} }`;
      }
      return body;
    })
    .join("\n");

  return `(() => {
  // Natives captured at document_start, before any page script runs: the relay
  // token lives only inside this closure, so a page that later replaces
  // window.CustomEvent or document.dispatchEvent cannot observe the tokenized
  // event name and forge relay traffic (relay.ts header).
  const CustomEventCtor = window.CustomEvent;
  const docDispatch = document.dispatchEvent.bind(document);
  const docAddEventListener = document.addEventListener.bind(document);
  const winAddEventListener = window.addEventListener.bind(window);
  const post = (topic, data) => {
    try {
      docDispatch(new CustomEventCtor(${JSON.stringify(relayEventName(options.relayToken))}, {
        detail: JSON.stringify({ topic: String(topic), data }),
      }));
    } catch {}
  };
  const rmxRelay = Object.freeze({ post });
  void rmxRelay;
  // The network:observe interceptor installs together with the remixlet's files,
  // BELOW the urlActive gate: registration is origin-wide, so patching fetch/XHR
  // eagerly would record bodies on paths the manifest's real matches exclude.
  const installInterceptor = () => {${interceptorBody}
  };
  // Runtime URL gate for the remixlet's MAIN files: registration matches are
  // origin-wide (SPA-aware injection, worker/injection.ts) so the manifest's
  // real matches are enforced here — files run when the URL first satisfies
  // them, at load or after a client-side navigation, at most once per document.
  const urlActive = ${urlActivePredicateCode(options.matches)};
  let filesActivated = false;
  const runFiles = () => {
    filesActivated = true;
    try { installInterceptor(); } catch {}
${files}
  };
  const tryActivateFiles = () => { if (!filesActivated && urlActive(location.href)) runFiles(); };
  // SPA navigation watcher: only this world sees the page's history calls.
  // Patch pushState/replaceState, cover traversal, and post navigation:change
  // over the relay. It stays ABOVE the gate on purpose — it is how a URL that
  // starts inactive becomes active — and carries no page data or authority
  // (receivers re-read location.href; standard relay trust posture).
  const postNav = () => {
    try { post("navigation:change", { url: location.href }); } catch {}
    try { tryActivateFiles(); } catch {}
  };
  const wrapHistory = (name) => {
    try {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function () {
        const result = original.apply(this, arguments);
        postNav();
        return result;
      };
    } catch {}
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");
  winAddEventListener("popstate", postNav);
  winAddEventListener("hashchange", postNav);
  tryActivateFiles();
})();`;
}
