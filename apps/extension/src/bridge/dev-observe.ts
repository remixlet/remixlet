// The development-time network observer
// (wiki/raw/handoffs/2026-08-10-broad-observe-session-grant.md): an
// extension-owned sibling of relay.ts, shipped as its own file
// (dev-observe.js, entry dev-observe-entry.ts) and registered as ONE
// MAIN-world content script over the origins pinned by the live dev-observe
// grants (worker/injection.ts) while a conversation holds a grant. It buffers
// the page's own fetch/XHR response bodies so the agent's
// observe_network_bodies probe can read where the data really lives BEFORE
// any capability is requested.
//
// Differences from the relay, all deliberate:
// - No agent, no relay events: no remixlet exists yet while this runs, and
//   the page agent is not registered on an origin only a grant names.
// - Only the latest body per URL+method is held (createResponseRing
//   latestPerUrl), so a poll cannot evict a load-time data response.
// - Delivery is a sync request/reply CustomEvent pair, read by the probe:
//   the probe dispatches DEV_OBSERVE_REQUEST_EVENT with a JSON-string detail
//   { urlFilter?, limit? } and hears DEV_OBSERVE_REPLY_EVENT synchronously
//   during its own dispatch, detail JSON { total, matched, recorded, entries }
//   (shared/dev-observe.ts documents the contract; the probe's world changed
//   when it became a shipped file, this pair did not).
//
// The event names are constants, not per-grant tokens: a shipped file can
// receive no per-registration data, and the token never was authority. The
// model-facing gate is the worker's grant check on the probe
// (worker/index.ts devObserveProbeParams): without a live grant for the
// conversation and the tab's origin the probe never runs. What the buffer
// holds is the page's OWN response data, in the page's own world.
//
// Trust posture, same as the relay: the MAIN world is page-shared, so the
// page can observe or forge this traffic; nothing here evaluates a string.

import { DEV_OBSERVE_REPLY_EVENT, DEV_OBSERVE_REQUEST_EVENT } from "../shared/dev-observe.js";
import {
  OBSERVE_BUFFER_BYTE_BUDGET,
  OBSERVE_BUFFER_MAX,
  captureNatives,
  createResponseRing,
  installNetworkCapture,
} from "./relay.js";

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber<Value>(value: Value): value is Value & number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

interface ReadRequest {
  urlFilter: string | undefined;
  limit: number;
}

/** The probe's request detail, decoded; a malformed one reads everything. */
function parseReadRequest(detail: string): ReadRequest {
  const request: ReadRequest = { urlFilter: undefined, limit: OBSERVE_BUFFER_MAX };
  let parsed: { urlFilter?: string; limit?: number };
  try {
    // SAFETY: the probe serializes { urlFilter?, limit? }; unexpected shapes fall back to the defaults below.
    parsed = JSON.parse(detail) as { urlFilter?: string; limit?: number };
  } catch {
    return request;
  }
  if (Object.prototype.toString.call(parsed) !== "[object Object]") return request;
  if (isString(parsed.urlFilter) && parsed.urlFilter.length > 0) request.urlFilter = parsed.urlFilter;
  if (isNumber(parsed.limit) && parsed.limit >= 1) request.limit = Math.floor(parsed.limit);
  return request;
}

export interface DevObserverInstallation {
  /** Stop answering reads (the fetch/XHR wrappers stay, inert); tests install more than one observer per page. */
  stop(): void;
}

/**
 * Install the observer on a document: wrap fetch and XHR into a latest-per-URL
 * ring and answer the probe's sync reads. Natives are captured at install
 * time (document_start), as the relay does.
 */
export function installDevObserver(window: Window & typeof globalThis): DevObserverInstallation {
  const natives = captureNatives(window);
  const ring = createResponseRing({ max: OBSERVE_BUFFER_MAX, byteBudget: OBSERVE_BUFFER_BYTE_BUDGET, latestPerUrl: true });
  installNetworkCapture(window, natives, (captured) => {
    ring.record(captured, window.location.href);
  });
  const onRead = (event: Event): void => {
    try {
      const request = parseReadRequest(event instanceof natives.CustomEvent ? String(event.detail) : "");
      const held = ring.entries();
      const matched = request.urlFilter === undefined ? held : held.filter((entry) => entry.url.includes(request.urlFilter!));
      natives.dispatchEvent(
        new natives.CustomEvent(DEV_OBSERVE_REPLY_EVENT, {
          detail: JSON.stringify({
            total: held.length,
            matched: matched.length,
            recorded: ring.recorded(),
            entries: matched.slice(-request.limit),
          }),
        }),
      );
    } catch {
      // The probe reports "observer-not-running" when no reply lands.
    }
  };
  natives.addEventListener(DEV_OBSERVE_REQUEST_EVENT, onRead);
  return { stop: () => natives.removeEventListener(DEV_OBSERVE_REQUEST_EVENT, onRead) };
}
