// MAIN-world codegen for the development-time network observer
// (wiki/raw/handoffs/2026-08-10-broad-observe-session-grant.md): an
// extension-owned sibling of relay.ts's network:observe interceptor, injected
// as its OWN registration (worker/dev-observe.ts builds it) while a
// conversation holds the dev-observe grant. It buffers the page's own
// fetch/XHR response bodies so the agent's observe_network_bodies probe can
// read where the data really lives BEFORE any capability is requested.
//
// Differences from the remixlet interceptor, all deliberate:
// - No host patterns: it observes every host the page contacts. Scope comes
//   from the registration's matches (the origin pinned at grant time) and the
//   conversation-scoped grant record, not from per-host grants.
// - Textual responses only (JSON/text content types): broad observation of
//   media/asset bodies would buffer megabytes for nothing.
// - Entries carry the request METHOD — the whole point is verifying endpoints
//   replay cannot reach, and "it was a POST" is part of that answer.
// - Delivery is a sync request/reply CustomEvent pair read by the probe lane,
//   not the remixlet relay: no remixlet exists yet while this runs.
//
// Trust posture, same as the relay (relay.ts header): the MAIN world is
// page-shared, so the page can observe or forge this traffic — every body here
// is the page's OWN response data, and the token names events, it grants
// nothing. The model-facing gate is the worker's grant check on the probe.

import { OBSERVE_BODY_CAP, OBSERVE_BUFFER_BYTE_BUDGET, OBSERVE_BUFFER_MAX } from "./relay.js";
import { devObserveReplyEventName, devObserveRequestEventName } from "../shared/dev-observe.js";

export interface DevObserveCodeOptions {
  /** Names the sync events; embedded in page-readable MAIN-world code. */
  token: string;
}

/**
 * One self-contained IIFE: fetch/XHR patches feeding a capped ring buffer,
 * plus the sync read listener. Idempotent per token — a re-registration that
 * races an already-injected document must not double-patch fetch.
 */
export function devObserveCode(options: DevObserveCodeOptions): string {
  return `(() => {
  try {
    // Per-token double-install guard (same __rmx marker convention as rmx.ts).
    const guards = (window.__rmxDevObsInstalled = window.__rmxDevObsInstalled || {});
    if (guards[${JSON.stringify(options.token)}]) return;
    guards[${JSON.stringify(options.token)}] = true;

    // Textual filter: JSON (incl. +json suffixes) and text/* bodies only.
    const isTextual = (contentType) =>
      typeof contentType === "string" && (contentType.includes("json") || contentType.slice(0, 5) === "text/");
    const isHttpUrl = (raw) => {
      try {
        const url = new URL(raw, location.href);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch { return false; }
    };

    const buffer = [];
    let bufferBytes = 0;
    let seq = 0;
    const record = (rawUrl, method, status, contentType, bodyText) => {
      const text = String(bodyText == null ? "" : bodyText);
      let url = rawUrl;
      try { url = new URL(rawUrl, location.href).href; } catch {}
      const entry = {
        seq: (seq += 1),
        url,
        method: typeof method === "string" && method.length > 0 ? method.toUpperCase() : "GET",
        status,
        contentType: contentType || null,
        body: text.length > ${OBSERVE_BODY_CAP} ? text.slice(0, ${OBSERVE_BODY_CAP}) : text,
        truncated: text.length > ${OBSERVE_BODY_CAP},
      };
      // Keep only the LATEST body per URL+method: pages poll endpoints (an
      // activities check every few seconds), and identical polls evicting
      // distinct load-time responses is how the soundcloud /stream feed body
      // vanished before the agent could read it. seq keeps counting every
      // response ever recorded, so the probe can report the gap honestly.
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index].url === entry.url && buffer[index].method === entry.method) {
          bufferBytes -= buffer[index].body.length;
          buffer.splice(index, 1);
          break;
        }
      }
      buffer.push(entry);
      bufferBytes += entry.body.length;
      while (buffer.length > ${OBSERVE_BUFFER_MAX} || bufferBytes > ${OBSERVE_BUFFER_BYTE_BUDGET}) {
        bufferBytes -= buffer.shift().body.length;
      }
    };

    // fetch — transparent pass-through: the page always receives the ORIGINAL
    // promise/response; observation reads a clone, and only textual bodies.
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function () {
        const result = originalFetch.apply(this, arguments);
        try {
          const input = arguments[0];
          const init = arguments[1];
          const rawUrl =
            typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
          const method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
          if (rawUrl && isHttpUrl(rawUrl) && result && typeof result.then === "function") {
            result.then((response) => {
              try {
                if (!response || typeof response.clone !== "function") return;
                const contentType = response.headers && response.headers.get("content-type");
                if (!isTextual(contentType)) return;
                const clone = response.clone();
                clone.text().then((text) => record(rawUrl, method, response.status, contentType, text), () => {});
              } catch {}
            }, () => {});
          }
        } catch {}
        return result;
      };
    }

    // XHR — stash url+method at open, read textual bodies at load.
    const Xhr = window.XMLHttpRequest;
    if (Xhr && Xhr.prototype) {
      const originalOpen = Xhr.prototype.open;
      const originalSend = Xhr.prototype.send;
      Xhr.prototype.open = function (method, url) {
        try {
          this.__rmxDevObsUrl = typeof url === "string" ? url : String(url);
          this.__rmxDevObsMethod = typeof method === "string" ? method : String(method);
        } catch {}
        return originalOpen.apply(this, arguments);
      };
      Xhr.prototype.send = function () {
        try {
          const rawUrl = this.__rmxDevObsUrl;
          if (rawUrl && isHttpUrl(rawUrl)) {
            this.addEventListener("load", function () {
              try {
                if (this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
                const contentType = this.getResponseHeader("content-type");
                if (!isTextual(contentType)) return;
                const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
                record(rawUrl, this.__rmxDevObsMethod, this.status, contentType, text);
              } catch {}
            });
          }
        } catch {}
        return originalSend.apply(this, arguments);
      };
    }

    // Sync read: the probe dispatches the request event (JSON-string detail:
    // { urlFilter, limit }) and hears the reply synchronously during dispatch.
    document.addEventListener(${JSON.stringify(devObserveRequestEventName(options.token))}, (event) => {
      try {
        let urlFilter;
        let limit = ${OBSERVE_BUFFER_MAX};
        try {
          const detail = event instanceof CustomEvent ? JSON.parse(String(event.detail)) : {};
          if (typeof detail.urlFilter === "string" && detail.urlFilter.length > 0) urlFilter = detail.urlFilter;
          if (typeof detail.limit === "number" && detail.limit >= 1) limit = Math.floor(detail.limit);
        } catch {}
        const matched = urlFilter === undefined ? buffer.slice() : buffer.filter((entry) => entry.url.includes(urlFilter));
        document.dispatchEvent(new CustomEvent(${JSON.stringify(devObserveReplyEventName(options.token))}, {
          detail: JSON.stringify({ total: buffer.length, matched: matched.length, recorded: seq, entries: matched.slice(-limit) }),
        }));
      } catch {}
    });
  } catch {}
})();`;
}
