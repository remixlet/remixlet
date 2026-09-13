// read_page_state's crossing into the page's MAIN world. The template reads
// the page's own globals, so it has to run where they live; every other probe
// runs in the extension's ISOLATED world. The two halves here talk the way
// the dev observer and its probe do (shared/dev-observe.ts): the ISOLATED
// runner dispatches a request CustomEvent on `document` whose detail is the
// params as a JSON string, and the MAIN reader answers with a reply event
// during that same dispatch, its detail the envelope (envelope.ts). Params
// cross as text and are parsed back into a value; nothing on either side
// turns them into code.
//
// The reader ships as page-state.js (page-state-entry.ts), injected by the
// worker engine through scripting.executeScript before the read, guarded by a
// non-enumerable marker on the page's window so a second injection installs
// nothing (non-enumerable, so read_page_state's own key listing of `window`
// does not show it).

import { envelopeOf, errorEnvelope } from "./envelope.js";
import type { ProbePayload } from "./payload.js";
import { probeHelpers, readPageStateProbe } from "./probes.js";
import type { ReadPageStateParamsType } from "../../shared/probe-schemas.js";

export const PAGE_STATE_REQUEST_EVENT = "rmx-pagestate-req";
export const PAGE_STATE_REPLY_EVENT = "rmx-pagestate-rep";

const READER_MARK = "__rmxPageStateReader";

/** MAIN world: answer state reads for this document. Idempotent per document. */
export function installPageStateReader(document: Document): void {
  const page = document.defaultView;
  if (page === null) return;
  if (Object.prototype.hasOwnProperty.call(page, READER_MARK)) return;
  Object.defineProperty(page, READER_MARK, { value: true, enumerable: false, writable: false, configurable: false });
  document.addEventListener(PAGE_STATE_REQUEST_EVENT, (event) => {
    const detail = event instanceof CustomEvent ? String(event.detail) : "";
    const reply = envelopeOf(() => {
      // SAFETY: the ISOLATED runner serialised params the worker validated against ReadPageStateParams.
      const params = JSON.parse(detail) as ReadPageStateParamsType;
      return readPageStateProbe(params, probeHelpers());
    });
    document.dispatchEvent(new CustomEvent(PAGE_STATE_REPLY_EVENT, { detail: reply }));
  });
}

/** ISOLATED world: one synchronous read through the installed reader. */
export function readPageStateThroughReader(document: Document, params: ProbePayload): string {
  let reply: string | undefined;
  const onReply = (event: Event): void => {
    reply = event instanceof CustomEvent ? String(event.detail) : undefined;
  };
  document.addEventListener(PAGE_STATE_REPLY_EVENT, onReply, { once: true });
  document.dispatchEvent(new CustomEvent(PAGE_STATE_REQUEST_EVENT, { detail: JSON.stringify(params) }));
  document.removeEventListener(PAGE_STATE_REPLY_EVENT, onReply);
  return reply ?? errorEnvelope("read_page_state: the page-world reader did not answer; the extension's page-state.js is not installed in this document");
}
