// The page agent: the one piece of extension-authored code that touches the
// real document on a box's behalf (wiki/design/mediated-execution.md). It
// answers `dom.call` operations over a transport the content-script entry
// (platform/page-agent-content.ts) builds on the host port, applies
// src/box/policy.ts to every write, delivers events and coalesced mutation
// notices back, forwards MAIN-world relay traffic, reports navigation, and
// pushes `page.facts` (url, title, readyState, viewport) so the box's
// synchronous `location`/`navigator`/`window` facades stay current.
//
// One agent per document multiplexes every box for that document by
// remixletId: each gets its own handle table, listeners, observers, manifest
// matches, granted hosts and observe patterns, so releasing or tearing one
// down never touches another. The MAIN-world relay (bridge/relay.ts) is one
// per document too: the agent listens once, under the per-document token the
// two exchanged at document_start, and decides per box which
// `network:response` records to forward: a box hears a response only once
// the page URL has satisfied its manifest matches (sticky for the document,
// as the old per-remixlet interceptor's install gate was) and only from a
// host its granted network:observe patterns name. Each box's seq high-water
// mark keeps a replay (requested on configure and when the URL gate opens)
// from delivering a record twice. Nothing here is authority: the box cannot
// reach the page except through these ops, and every op is bounded by the
// caps in protocol.ts.
//
// Marks (shared/marks.ts): a write of an attribute or class on one of the
// page's own elements passes the mark rule (the name must carry the box's
// prefix, `rmx-<id>`), and every element a box creates, clones, writes as
// HTML or adds as a stylesheet is stamped `data-rmx-owner="<id>"` here, so
// the capture can name any mark no installed remixlet owns as a leftover.
//
// The agent runs from document_start (worker/injection.ts), so `body` and
// `head` may not exist yet when the first op arrives: those handles answer a
// plain error until they do, while `document` roots (query, waitFor, observe)
// work from the first byte.
//
// The runaway-observer guard from the old in-page bridge (bridge/rmx.ts) lives
// here now, per observer: raw MutationObserver deliveries are budgeted per
// window and coalesced, leading edge first (the first delivery after a quiet
// spell is sent at once, the rest fold into one trailing notice per
// MUTATION_COALESCE_MS). Saturation is classified by cause exactly as before
// (fast refills in consecutive windows are a feedback loop, slow ones a busy
// page) and reported as `dom.notice` with the same message text, so the
// verification gate still recognises it. Only a fast refill holds deliveries
// until the window's trailing notice: that starvation is what bounds a loop to
// one burst per window. A page that churns on its own keeps its coalesced
// notices, because in the box the remixlet's reaction never runs on the page's
// thread, so the page has nothing to be protected from.
//
// Same-document navigations are noticed here without waiting for the worker's
// webNavigation hint: the Navigation API's `currententrychange` fires in this
// world the moment the URL moves (pushState, replaceState, traversal), and the
// hint plus popstate/hashchange stay as fallbacks for browsers without it.
//
// A listener dies with its node. Every coalesced mutation flush checks the
// box's listened nodes (a pass over the listeners, never a walk per
// mutation): one that was in the document and is not any more was redrawn by
// the page, so its listeners are dropped, its handle marked stale, and the box
// told once per handle (`dom.stale`) ahead of that flush's `dom.mutated`, so
// the keep that bound the listener can apply again and bind afresh.

import {
  CREATE_DEPTH_CAP,
  CREATE_TREE_CAP,
  HANDLE_TABLE_CAP,
  HTML_READ_CAP,
  HTML_WRITE_CAP,
  INFO_TEXT_CAP,
  MUTATION_BUDGET,
  MUTATION_COALESCE_MS,
  MUTATION_WINDOW_MS,
  QUERY_ALL_CAP,
  type AgentPortMessage,
  type AgentToBox,
  type CloneOptions,
  type CloneResult,
  type CreateSpec,
  type DomCall,
  type DomOp,
  type DomResults,
  type ElementInfo,
  type Handle,
  type HostToAgentEnvelope,
  type JsonValue,
  type ListenerOptions,
  type MutationObserveOptions,
  type PageFacts,
  type Rect,
  type SerializedEvent,
  type Viewport,
} from "./protocol.js";
import { relayEventName, relaySyncEventName } from "../bridge/relay.js";
import { urlMatchesFetchHostPattern } from "../shared/fetch-capability.js";
import { urlMatchesAny } from "../shared/site-key.js";
import {
  SVG_NAMESPACE,
  SVG_TAGS,
  attributeDecision,
  classWriteDecision,
  clickDecision,
  createTagDecision,
  isOwnedBy,
  pageResourceUrls,
  removeAttributeDecision,
  sanitizeClone,
  sanitizeHtml,
  stampOwner,
  styleDecision,
  textWriteDecision,
  type AttributeDecision,
  type PageElementWrite,
  type PolicyDecision,
  type UrlContext,
} from "./policy.js";
import { MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX, MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX } from "../shared/script-log.js";
import { isSensitiveField, markupWithoutSecrets } from "../shared/sensitive-fields.js";

export interface AgentTransport {
  send(message: AgentPortMessage): void;
  onMessage(handler: (envelope: HostToAgentEnvelope) => void): void;
}

export interface PageAgentOptions {
  document: Document;
  window: Window;
  /** Initial location.href; the agent re-reads window.location on navigation signals. */
  pageUrl?: string;
  transport: AgentTransport;
  /**
   * The per-document relay token (bridge/relay.ts claimRelayToken), read when
   * the first box with observe patterns is configured; undefined means no
   * relay has published one yet, and a later configure asks again.
   */
  relayToken?: () => string | undefined;
}

export interface BoxConfig {
  /** The manifest's REAL matches, for URL vetting. */
  matches: readonly string[];
  /** Granted fetch: host patterns, for URL vetting (BoxRemixletSpec.grantedHosts). */
  grantedHosts: readonly string[];
  /** Granted network:observe host patterns; empty = this box hears no relay traffic. */
  observePatterns: readonly string[];
}

/** What crossed the relay for this document and what reached a box (tests and diagnostics). */
export interface RelayStats {
  received: number;
  receivedBytes: number;
  delivered: number;
  deliveredBytes: number;
}

export interface SettleOptions {
  /** Total time to wait for the boxes' answers; default SETTLE_BUDGET_MS. */
  budgetMs?: number;
  /** Rounds to allow while the page keeps changing; default SETTLE_MAX_ROUNDS. */
  maxRounds?: number;
}

export interface SettleOutcome {
  /** True when every box answered idle in a round the page did not change during. */
  settled: boolean;
  rounds: number;
  boxes: number;
}

export interface PageAgent {
  /** Set (or replace) a box's matches, granted hosts and observe patterns, then push page.facts. Also arrives as a `dom.configure` envelope. */
  configure(remixletId: string, config: BoxConfig): void;
  /**
   * Wait until every box on the page is idle (protocol.ts DomSettleMessage).
   * Pending mutation notices go out first, so a keep they wake is counted in
   * the box's answer; a round the page changed during is followed by another.
   */
  settle(options?: SettleOptions): Promise<SettleOutcome>;
  /** A navigation hint from outside (the worker's webNavigation events); notifies only on a real URL change. */
  noteNavigation(): void;
  /** Drop one box: its handles, listeners and observers. */
  dropRemixlet(remixletId: string): void;
  /** Drop everything; the agent ignores every later message. */
  teardown(): void;
  /** Handles currently held for a box (tests and diagnostics). */
  handleCount(remixletId: string): number;
  /** Relay records received for the document and delivered to boxes, as counts and body characters. */
  relayStats(): RelayStats;
}

/** Fast saturation threshold, as in the old world guard. */
const FAST_SATURATION_MS = 250;
const WAIT_FOR_MAX_MS = 120000;
const WAIT_FOR_CHECK_INTERVAL_MS = 50;
const COMPUTED_PROPS_CAP = 100;
/** resize/scroll fold into one trailing page.facts per this window. */
const FACTS_THROTTLE_MS = 250;
/** How long one read of the page's own resource URLs serves URL decisions. */
const PAGE_URLS_CACHE_MS = 1000;
/** The settle handshake's total wait for the boxes' answers, and its round cap while the page keeps changing. */
const SETTLE_BUDGET_MS = 5000;
const SETTLE_MAX_ROUNDS = 5;
/** The pseudo-handle for window-level events (`on`/`off` only). */
const WINDOW_HANDLE = "window";
/** Stale handle ids remembered per box so ops on them answer the stale error rather than "unknown". */
const STALE_HANDLES_CAP = 1000;
/** What every op (except isConnected and release) answers on a handle whose listened node left the document. */
export const STALE_HANDLE_MESSAGE = "stale: the node this handle named left the document (the page redrew it); query again for the node now in its place";

/** The window's Navigation API object, when the browser has one; lib.dom does not type it yet, so only its event surface is used. */
function navigationApiOf(window: Window): EventTarget | undefined {
  // SAFETY: `navigation` is a Window attribute on browsers with the Navigation API; anything else is treated as absent.
  const candidate = (window as Window & { navigation?: unknown }).navigation;
  return candidate instanceof EventTarget ? candidate : undefined;
}

/** Event types `on("window", …)` accepts; visibilitychange is a document event and registers there. */
const WINDOW_EVENT_TYPES: ReadonlySet<string> = new Set(["scroll", "resize", "keydown", "keyup", "focus", "blur", "visibilitychange"]);

class PolicyRefusal extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`);
  }
}

class OpError extends Error {}

/** What one `dom.call` answers with: the DomResults value for its op. */
type DomResultValue = DomResults[DomOp["op"]];

// Port and relay payloads crossed structured clone or JSON.parse, so the only
// shapes that reach these checks are primitives, plain objects and arrays.
function isRecord<Value>(value: Value): value is Value & object {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber<Value>(value: Value): value is Value & number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isBoolean<Value>(value: Value): value is Value & boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

/** A node a handle can name: an element, the document, or an open shadow root. */
type HandleNode = Element | Document | ShadowRoot;

/** nodeType 1 is ELEMENT_NODE; the document is 9, a shadow root (a DocumentFragment) 11. */
function isElementNode(node: HandleNode): node is Element {
  return node.nodeType === 1;
}

function isDocumentNode(node: HandleNode): node is Document {
  return node.nodeType === 9;
}

function isInput(element: Element): element is HTMLInputElement {
  return element.localName === "input";
}

interface ListenerState {
  target: EventTarget;
  type: string;
  listener: EventListener;
  capture: boolean;
  /** The handle the box listened on ("window" for window events). */
  handle: Handle;
  /** The node behind that handle; undefined for the window. */
  node: HandleNode | undefined;
  /**
   * Whether the node has been in the document since the listener was bound.
   * A listener on a created node that is not attached yet is not stale: only
   * a node that was connected and then left counts as one the page redrew.
   */
  wasConnected: boolean;
}

/** Where a listener registers, and the node that bounds its delegation (none for the window). */
interface ListenerTarget {
  target: EventTarget;
  scope: HandleNode | undefined;
}

interface ObserverState {
  observer: MutationObserver;
  pendingDeliveries: number;
  /** Send the pending notice now (the settle handshake); a no-op with nothing pending. */
  flush: () => void;
  /** Armed after every flush; while set, deliveries wait for its trailing flush. */
  coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Armed by a fast saturation; deliveries are held until it flushes and opens a new window. */
  trailingTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while a fast saturation holds deliveries for the trailing flush. */
  holding: boolean;
  lastFlushAt: number;
  windowStart: number;
  calls: number;
  lastFastSaturationAt: number;
  warnedLoop: boolean;
  notedThrottle: boolean;
}

interface BoxState {
  remixletId: string;
  matches: readonly string[];
  grantedHosts: readonly string[];
  observePatterns: readonly string[];
  /** The page URL has satisfied `matches` at some point in this document: responses flow from then on. */
  observeActive: boolean;
  /** Highest relay seq delivered to this box; a replay never re-delivers below it. */
  relaySeq: number;
  handles: Map<Handle, Element | ShadowRoot>;
  reverse: WeakMap<Element | ShadowRoot, Handle>;
  nextHandle: number;
  listeners: Map<number, ListenerState>;
  observers: Map<number, ObserverState>;
  /**
   * Handles whose node left the document while listened on. Out of the
   * handle table (a fresh query of the replacement mints a new handle) but
   * remembered so ops on the old one answer "stale: …" rather than "unknown";
   * bounded, oldest forgotten first.
   */
  stale: Set<Handle>;
}

export function createPageAgent(options: PageAgentOptions): PageAgent {
  const { document, window, transport } = options;
  const boxes = new Map<string, BoxState>();
  let currentUrl = options.pageUrl ?? window.location.href;
  let alive = true;
  /** Raw MutationObserver deliveries seen, any box: the settle handshake's "did the page change during this round". */
  let mutationSeq = 0;

  const send = (message: AgentPortMessage): void => {
    if (!alive) return;
    try {
      transport.send(message);
    } catch {
      // A dead port ends the document's session; the disconnect handler tears down.
    }
  };
  const sendTo = (remixletId: string, payload: AgentToBox): void => send({ remixletId, payload });

  // -------------------------------------------------------------------------
  // Boxes

  const boxFor = (remixletId: string): BoxState => {
    let box = boxes.get(remixletId);
    if (!box) {
      box = {
        remixletId,
        matches: [],
        grantedHosts: [],
        observePatterns: [],
        observeActive: false,
        relaySeq: 0,
        handles: new Map(),
        reverse: new WeakMap(),
        nextHandle: 1,
        listeners: new Map(),
        observers: new Map(),
        stale: new Set(),
      };
      boxes.set(remixletId, box);
    }
    return box;
  };

  // -------------------------------------------------------------------------
  // Relay: one document listener, attached once a box with observe patterns
  // exists and the relay's token is known.

  let relayToken: string | undefined;
  let relayListener: EventListener | undefined;
  const relayStats: RelayStats = { received: 0, receivedBytes: 0, delivered: 0, deliveredBytes: 0 };

  const relayBoxes = (): BoxState[] => [...boxes.values()].filter((box) => box.observePatterns.length > 0);

  /** Whether this box hears responses now; opens once the URL satisfies its matches and stays open. */
  const observeGateOpen = (box: BoxState): boolean => {
    if (!box.observeActive && urlMatchesAny(currentUrl, box.matches)) box.observeActive = true;
    return box.observeActive;
  };

  const deliverResponse = (data: JsonValue): void => {
    if (!isJsonObject(data) || !isString(data.url) || !isNumber(data.seq)) return;
    relayStats.received += 1;
    if (isString(data.body)) relayStats.receivedBytes += data.body.length;
    let url: URL;
    try {
      url = new URL(data.url);
    } catch {
      return;
    }
    for (const box of relayBoxes()) {
      if (data.seq <= box.relaySeq || !observeGateOpen(box)) continue;
      if (!box.observePatterns.some((pattern) => urlMatchesFetchHostPattern(url, pattern))) continue;
      box.relaySeq = data.seq;
      relayStats.delivered += 1;
      if (isString(data.body)) relayStats.deliveredBytes += data.body.length;
      sendTo(box.remixletId, { kind: "relay.message", topic: "network:response", data });
    }
  };

  const onRelayEvent: EventListener = (event) => {
    let message: JsonValue;
    try {
      // SAFETY: the relay dispatches CustomEvents under this name; any other event has no detail, and
      // String(undefined) fails the parse below. JSON.parse yields only JSON values.
      message = JSON.parse(String((event as CustomEvent).detail)) as JsonValue;
    } catch {
      return;
    }
    if (!isJsonObject(message) || !isString(message.topic)) return;
    const data = message.data ?? null;
    // Everything crossing the relay is untrusted page data; a forged
    // navigation:change can at most trigger a harmless re-check, and a forged
    // response is what the page could have served anyway.
    if (message.topic === "navigation:change") navCheck();
    if (message.topic === "network:response") {
      deliverResponse(data);
      return;
    }
    for (const box of relayBoxes()) sendTo(box.remixletId, { kind: "relay.message", topic: message.topic, data });
  };

  /** Attach the document listener if the relay's token is known; false until it is. */
  const ensureRelay = (): boolean => {
    if (relayListener !== undefined) return true;
    const token = options.relayToken?.();
    if (token === undefined || token === "") return false;
    relayToken = token;
    relayListener = onRelayEvent;
    document.addEventListener(relayEventName(token), onRelayEvent);
    return true;
  };

  /** Ask the relay to re-post its ring; it answers synchronously, and each box's relaySeq skips what it already has. */
  const requestRelaySync = (): void => {
    if (relayToken === undefined) return;
    try {
      document.dispatchEvent(new CustomEvent(relaySyncEventName(relayToken)));
    } catch {
      // The sync is a courtesy replay request; nothing depends on it.
    }
  };

  const detachRelay = (): void => {
    if (relayListener === undefined || relayToken === undefined) return;
    document.removeEventListener(relayEventName(relayToken), relayListener);
    relayListener = undefined;
  };

  const configure = (remixletId: string, config: BoxConfig): void => {
    if (!alive) return;
    const box = boxFor(remixletId);
    box.matches = [...config.matches];
    box.grantedHosts = [...config.grantedHosts];
    box.observePatterns = [...config.observePatterns];
    box.observeActive = false;
    // The replay lands in the box before its files run (the host configures
    // ahead of box.run); a box whose URL gate is still closed gets one when
    // the gate opens (navCheck).
    if (box.observePatterns.length > 0 && ensureRelay() && observeGateOpen(box)) requestRelaySync();
    // The box's facades need a snapshot before its first op; the port keeps
    // this ahead of every dom.result that follows.
    postFacts();
  };

  // -------------------------------------------------------------------------
  // URL vetting context: per box, with the page's own resource URLs read
  // lazily and cached briefly (a listing page sets many thumbnails in one burst).

  let pageUrlsCache: { at: number; urls: ReadonlySet<string> } | undefined;
  const pageUrls = (): ReadonlySet<string> => {
    const now = Date.now();
    if (pageUrlsCache && now - pageUrlsCache.at < PAGE_URLS_CACHE_MS) return pageUrlsCache.urls;
    const urls = pageResourceUrls(document, window);
    pageUrlsCache = { at: now, urls };
    return urls;
  };
  // baseUrl is read here, at the moment of the decision, because the page can
  // change it at any time: a <base href> pointing at another origin is what the
  // browser would resolve a relative URL against, so vetting resolves there too.
  const urlContextFor = (box: BoxState): UrlContext => ({
    pageUrl: currentUrl,
    baseUrl: document.baseURI,
    matches: box.matches,
    grantedHosts: box.grantedHosts,
    pageUrls,
  });

  const dropBox = (box: BoxState): void => {
    for (const listener of box.listeners.values()) {
      listener.target.removeEventListener(listener.type, listener.listener, listener.capture);
    }
    box.listeners.clear();
    for (const state of box.observers.values()) stopObserver(state);
    box.observers.clear();
    box.handles.clear();
    box.stale.clear();
    boxes.delete(box.remixletId);
  };

  // -------------------------------------------------------------------------
  // Handles

  const handleFor = (box: BoxState, node: Element | ShadowRoot): Handle => {
    if (node === document.body) return "body";
    if (node === document.head) return "head";
    const existing = box.reverse.get(node);
    if (existing !== undefined && box.handles.has(existing)) return existing;
    if (box.handles.size >= HANDLE_TABLE_CAP) {
      throw new OpError(`handle table is full (${HANDLE_TABLE_CAP} handles); release handles you no longer need`);
    }
    const handle = `h${box.nextHandle}`;
    box.nextHandle += 1;
    box.handles.set(handle, node);
    box.reverse.set(node, handle);
    return handle;
  };

  const nodeFor = (box: BoxState, handle: Handle): HandleNode => {
    if (handle === "document") return document;
    if (handle === "body") {
      if (!document.body) throw new OpError("the page has no body yet");
      return document.body;
    }
    if (handle === "head") {
      if (!document.head) throw new OpError("the page has no head yet");
      return document.head;
    }
    if (handle === WINDOW_HANDLE) throw new OpError("the window handle is for on() and off() only");
    const node = box.handles.get(handle);
    if (!node) {
      if (box.stale.has(handle)) throw new OpError(STALE_HANDLE_MESSAGE);
      throw new OpError(`unknown handle ${String(handle)} (released, or never minted)`);
    }
    return node;
  };

  const elementFor = (box: BoxState, handle: Handle): Element => {
    const node = nodeFor(box, handle);
    if (isElementNode(node)) return node;
    if (isDocumentNode(node)) throw new OpError("the document handle is not an element; use body or head");
    throw new OpError("a shadow root has no attributes; query an element inside it");
  };

  const rootFor = (box: BoxState, handle: Handle | undefined): HandleNode => (handle === undefined ? document : nodeFor(box, handle));

  const handleOrNull = (box: BoxState, node: Element | null): Handle | null => (node ? handleFor(box, node) : null);

  // -------------------------------------------------------------------------
  // Reads

  const rectOf = (element: Element): Rect => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right };
  };

  const isVisible = (element: Element, rect: Rect): boolean => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const isFormControl = (element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
    const tag = element.localName;
    return tag === "input" || tag === "textarea" || tag === "select";
  };

  const cap = (text: string, limit: number): string => (text.length > limit ? text.slice(0, limit) : text);

  /**
   * What a form control's value reads as: the value itself, or the empty
   * string for a password field, whose value never leaves the page
   * (shared/sensitive-fields.ts). One helper serves info(), the `value` op and
   * the event payload, so no read path can forget.
   */
  const valueOf = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, limit: number): string =>
    isSensitiveField(element) ? "" : cap(String(element.value ?? ""), limit);

  const infoOf = (box: BoxState, element: Element): ElementInfo => {
    const sensitive = isSensitiveField(element);
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(element.attributes)) {
      attrs[attr.name] = sensitive && attr.name.toLowerCase() === "value" ? "" : cap(attr.value, INFO_TEXT_CAP);
    }
    const dataset: Record<string, string> = {};
    // SAFETY: HTML and SVG elements carry a dataset; anything else (MathML) reads undefined and skips the loop.
    const ds = (element as HTMLElement).dataset;
    if (ds) for (const key of Object.keys(ds)) dataset[key] = cap(ds[key] ?? "", INFO_TEXT_CAP);
    const rect = rectOf(element);
    const info: ElementInfo = {
      handle: handleFor(box, element),
      tag: element.localName,
      id: element.id ?? "",
      // SVG elements expose className as an SVGAnimatedString; the attribute holds the plain text.
      className: isString(element.className) ? element.className : element.getAttribute("class") ?? "",
      text: cap((element.textContent ?? "").trim(), INFO_TEXT_CAP),
      attrs,
      dataset,
      rect,
      visible: isVisible(element, rect),
    };
    if (isFormControl(element)) {
      info.value = valueOf(element, INFO_TEXT_CAP);
      if (isInput(element)) {
        const type = element.type;
        if (type === "checkbox" || type === "radio") info.checked = element.checked;
      }
    }
    return info;
  };

  const select = (root: HandleNode, selector: string): Element | null => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new OpError(`invalid selector: ${selector}`);
    }
  };

  const selectAll = (root: HandleNode, selector: string, limit: number): Element[] => {
    try {
      return Array.from(root.querySelectorAll(selector)).slice(0, limit);
    } catch {
      throw new OpError(`invalid selector: ${selector}`);
    }
  };

  const waitFor = (root: HandleNode, selector: string, timeoutMs: number): Promise<Element | null> =>
    new Promise((resolve) => {
      const first = select(root, selector);
      if (first) {
        resolve(first);
        return;
      }
      const budget = Math.max(0, Math.min(Number(timeoutMs) || 0, WAIT_FOR_MAX_MS));
      let done = false;
      let checkTimer: ReturnType<typeof setTimeout> | undefined;
      const observer = new MutationObserver(() => {
        if (done || checkTimer !== undefined) return;
        checkTimer = setTimeout(check, WAIT_FOR_CHECK_INTERVAL_MS);
      });
      const finish = (element: Element | null): void => {
        if (done) return;
        done = true;
        observer.disconnect();
        if (checkTimer !== undefined) clearTimeout(checkTimer);
        clearTimeout(deadline);
        resolve(element);
      };
      const check = (): void => {
        checkTimer = undefined;
        let found: Element | null = null;
        try {
          found = root.querySelector(selector);
        } catch {
          found = null;
        }
        if (found) finish(found);
      };
      const deadline = setTimeout(() => finish(null), budget);
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    });

  // -------------------------------------------------------------------------
  // Writes

  const must = (decision: PolicyDecision): void => {
    if (decision.kind === "refuse") throw new PolicyRefusal(decision.reason);
  };

  /** must(), for the decision that also carries the value to write: the vetted absolute URL for a src/href, the value as given otherwise. */
  const mustValue = (decision: AttributeDecision): string => {
    if (decision.kind === "refuse") throw new PolicyRefusal(decision.reason);
    return decision.value;
  };

  /**
   * The mark rule's input for a write to `element`: undefined when the box
   * built it (it or an ancestor carries the box's owner stamp, so any
   * attribute or class is fine), otherwise the box whose prefix the mark must
   * carry. Another box's element counts as the page's: its marks are not this
   * box's to write.
   */
  const pageElementFor = (box: BoxState, element: Element): PageElementWrite | undefined =>
    isOwnedBy(element, box.remixletId) ? undefined : { remixletId: box.remixletId };

  const kebab = (prop: string): string => (prop.startsWith("--") ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

  const applyStyle = (element: Element, props: Record<string, string>): void => {
    // SAFETY: HTML, SVG and MathML elements all carry an inline style; anything else reads undefined and is refused below.
    const style = (element as HTMLElement).style;
    if (!style) throw new OpError("this element has no style");
    const entries = Object.entries(props ?? {});
    for (const [prop, value] of entries) must(styleDecision(`${prop}:${String(value)}`));
    for (const [prop, raw] of entries) {
      const name = kebab(String(prop));
      let value = String(raw ?? "").trim();
      let priority = "";
      const important = /\s*!\s*important\s*$/i.exec(value);
      if (important) {
        value = value.slice(0, important.index).trim();
        priority = "important";
      }
      if (value === "") style.removeProperty(name);
      else style.setProperty(name, value, priority);
    }
  };

  const findSetter = (element: Element, prop: string): ((value: string | boolean) => void) | undefined => {
    for (let proto = Object.getPrototypeOf(element); proto; proto = Object.getPrototypeOf(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (descriptor?.set) return descriptor.set;
    }
    return undefined;
  };

  const setValue = (element: Element, value: string | boolean): void => {
    const wantsChecked = isBoolean(value) && isInput(element) && /^(checkbox|radio)$/i.test(element.type);
    const prop = wantsChecked ? "checked" : "value";
    const setter = findSetter(element, prop);
    if (!setter) throw new OpError(`this element has no ${prop}`);
    setter.call(element, wantsChecked ? value : String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /** One node of a create tree after policy vetted it and before anything exists in the page. */
  interface PreparedNode {
    tag: string;
    text: string | undefined;
    attrs: readonly (readonly [string, string])[];
    classes: readonly string[];
    style: Record<string, string>;
    fragment: DocumentFragment | undefined;
    children: (PreparedNode | string)[];
  }

  /**
   * Vet a create spec and its nested children as a whole. Every node passes the
   * same policy as a top-level create; a refusal anywhere rejects the whole tree
   * before a single element exists, so nothing half-built can reach the page.
   */
  const prepareCreate = (box: BoxState, spec: CreateSpec, depth: number, count: { nodes: number }): PreparedNode => {
    if (depth > CREATE_DEPTH_CAP) throw new OpError(`create nests deeper than ${CREATE_DEPTH_CAP} levels`);
    count.nodes += 1;
    if (count.nodes > CREATE_TREE_CAP) throw new OpError(`create builds more than ${CREATE_TREE_CAP} nodes`);
    const tag = String(spec?.tag ?? "").trim().toLowerCase();
    must(createTagDecision(tag));
    // What policy allows is also what gets written: a src/href comes back as
    // the absolute URL vetting resolved, so the value stored on the element is
    // the destination the check approved.
    const attrs = Object.entries(spec.attrs ?? {}).map(([rawName, rawValue]) => {
      const name = String(rawName);
      const value = String(rawValue);
      return [name, mustValue(attributeDecision({ tag, name, value, url: urlContextFor(box) }))] as const;
    });
    const style = spec.style ?? {};
    for (const [prop, value] of Object.entries(style)) must(styleDecision(`${prop}:${String(value)}`));
    let fragment: DocumentFragment | undefined;
    if (spec.html !== undefined) {
      const sanitized = sanitizeHtml(String(spec.html), { document, url: urlContextFor(box) });
      must(sanitized);
      if (sanitized.kind === "allow") fragment = sanitized.fragment;
    }
    const children: (PreparedNode | string)[] = [];
    if (spec.children !== undefined) {
      if (!Array.isArray(spec.children)) throw new OpError("create children must be an array of specs or strings");
      for (const child of spec.children) {
        if (isString(child)) {
          count.nodes += 1;
          if (count.nodes > CREATE_TREE_CAP) throw new OpError(`create builds more than ${CREATE_TREE_CAP} nodes`);
          children.push(child);
        } else if (isRecord(child)) {
          // The wire says CreateSpec; prepareCreate re-reads every field defensively, as it does for the root.
          children.push(prepareCreate(box, child, depth + 1, count));
        } else {
          throw new OpError("create children must be element specs or strings");
        }
      }
    }
    return {
      tag,
      text: spec.text !== undefined ? String(spec.text) : undefined,
      attrs,
      classes: Array.from(spec.classes ?? [], (cls) => String(cls).trim()).filter((name) => name !== ""),
      style,
      fragment,
      children,
    };
  };

  const materialize = (node: PreparedNode): Element => {
    const element = SVG_TAGS.has(node.tag) ? document.createElementNS(SVG_NAMESPACE, node.tag) : document.createElement(node.tag);
    if (node.text !== undefined) element.textContent = node.text;
    // These values are the vetted ones (prepareCreate resolved every URL), so a
    // <base href> the page changes between the decision and this write cannot
    // point the load anywhere else.
    for (const [name, value] of node.attrs) element.setAttribute(name, value);
    for (const name of node.classes) element.classList.add(name);
    if (Object.keys(node.style).length > 0) applyStyle(element, node.style);
    if (node.fragment) element.append(node.fragment);
    for (const child of node.children) element.append(isString(child) ? document.createTextNode(child) : materialize(child));
    return element;
  };

  /** Build the vetted tree and stamp its root with the owner: every node under it is the box's from now on. */
  const create = (box: BoxState, spec: CreateSpec): Element => {
    const element = materialize(prepareCreate(box, spec, 0, { nodes: 0 }));
    stampOwner(element, box.remixletId);
    return element;
  };

  /**
   * A detached deep copy of a host element, vetted by policy.sanitizeClone
   * (refused tags and attributes gone, ids dropped, size bounded), then edited
   * as the options ask: `strip` first, then `text`. The copy touches the page
   * only once the author appends it, through the same placement verbs as a
   * created node, so a failing option leaves nothing behind.
   */
  const clone = (box: BoxState, source: Element, options: CloneOptions = {}): CloneResult => {
    if (!isRecord(options)) throw new OpError("clone options must be an object");
    const sanitized = sanitizeClone(source, { document, url: urlContextFor(box), keepIds: options.keepIds === true });
    must(sanitized);
    if (sanitized.kind !== "allow") throw new OpError("clone failed");
    const copy = sanitized.element;
    // The copy is the box's own element (the sanitiser dropped any owner
    // stamp the host markup carried, so nothing inside it names another owner).
    stampOwner(copy, box.remixletId);
    const within = (selector: string): Element | null => {
      const text = String(selector);
      try {
        return copy.matches(text) ? copy : copy.querySelector(text);
      } catch {
        throw new OpError(`invalid selector: ${text}`);
      }
    };
    if (options.strip !== undefined) {
      if (!Array.isArray(options.strip)) throw new OpError("clone strip must be an array of selectors");
      for (const selector of options.strip) {
        const text = String(selector);
        let matches: Element[];
        try {
          matches = Array.from(copy.querySelectorAll(text));
        } catch {
          throw new OpError(`invalid selector: ${text}`);
        }
        for (const element of matches) element.remove();
      }
    }
    if (isString(options.text)) {
      must(textWriteDecision(copy.localName, options.text));
      copy.textContent = options.text;
    } else if (options.text !== undefined) {
      if (!isRecord(options.text)) throw new OpError("clone text must be a string or an object of selector: text");
      for (const [selector, value] of Object.entries(options.text)) {
        const target = within(selector);
        if (!target) throw new OpError(`clone text: nothing in the clone matches ${selector}`);
        const text = String(value);
        must(textWriteDecision(target.localName, text));
        target.textContent = text;
      }
    }
    return { handle: handleFor(box, copy), notes: sanitized.notes };
  };

  const insert = (
    box: BoxState,
    anchor: Handle,
    subject: Handle,
    place: (anchorElement: Element, subjectElement: Element) => void,
  ): null => {
    const anchorElement = elementFor(box, anchor);
    const subjectElement = elementFor(box, subject);
    try {
      place(anchorElement, subjectElement);
    } catch (error) {
      throw new OpError(`cannot insert there: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  };

  // -------------------------------------------------------------------------
  // Listeners

  const serializeEvent = (box: BoxState, event: Event, target: Element, currentHandle: Handle): SerializedEvent => {
    let targetHandle: Handle;
    try {
      targetHandle = handleFor(box, target);
    } catch {
      targetHandle = currentHandle;
    }
    const out: SerializedEvent = {
      type: event.type,
      target: targetHandle,
      currentTarget: currentHandle,
      defaultPrevented: event.defaultPrevented,
    };
    // SAFETY: a read-only duck-typed view. Keys, modifiers, button and coordinates are copied only after the field
    // holds its expected primitive, so keyboard, mouse and touch events each contribute the fields they carry
    // and a plain Event contributes none.
    const view = event as KeyboardEvent & MouseEvent;
    // A keystroke IS the value when the target is a password field: the keys
    // typed into one are withheld the same way its value is.
    const typedIntoSecret = event.target instanceof Element && isSensitiveField(event.target);
    if (isString(view.key) && !typedIntoSecret) out.key = view.key;
    if (isString(view.code) && !typedIntoSecret) out.code = view.code;
    if (isBoolean(view.altKey)) {
      out.altKey = view.altKey;
      out.ctrlKey = view.ctrlKey;
      out.metaKey = view.metaKey;
      out.shiftKey = view.shiftKey;
    }
    if (isNumber(view.button)) out.button = view.button;
    if (isNumber(view.clientX)) {
      out.clientX = view.clientX;
      out.clientY = view.clientY;
    }
    const raw = event.target;
    if (raw instanceof Element && isFormControl(raw)) {
      out.value = valueOf(raw, INFO_TEXT_CAP);
      if (isInput(raw) && /^(checkbox|radio)$/i.test(raw.type)) out.checked = raw.checked;
    }
    return out;
  };

  /**
   * Where a listener registers: the node a handle names, or for the window
   * pseudo-handle the window itself (visibilitychange fires on the document).
   * `scope` bounds delegation and stands in as the target of a non-node
   * event; the window has none.
   */
  const listenerTargetFor = (box: BoxState, handle: Handle, type: string): ListenerTarget => {
    if (handle !== WINDOW_HANDLE) {
      const node = nodeFor(box, handle);
      return { target: node, scope: node };
    }
    if (!WINDOW_EVENT_TYPES.has(type)) {
      throw new OpError(`the window handle takes only ${[...WINDOW_EVENT_TYPES].join(", ")} events (got ${type})`);
    }
    return { target: type === "visibilitychange" ? document : window, scope: undefined };
  };

  const addListener = (box: BoxState, handle: Handle, type: string, listenerId: number, options: ListenerOptions = {}): null => {
    if (!isString(type) || type === "") throw new OpError("an event type is needed");
    removeListener(box, listenerId);
    const { target, scope } = listenerTargetFor(box, String(handle), type);
    const selector = isString(options.selector) && options.selector !== "" ? options.selector : undefined;
    if (selector !== undefined) {
      try {
        document.createDocumentFragment().querySelector(selector);
      } catch {
        throw new OpError(`invalid selector: ${selector}`);
      }
    }
    const capture = options.capture === true;
    const listener: EventListener = (event) => {
      if (!alive || !box.listeners.has(listenerId)) return;
      const rawTarget = event.target;
      let matched: Element;
      if (selector !== undefined) {
        // A text node's event starts matching at its parent; a non-node target (the window) matches nothing.
        const start = rawTarget instanceof Element ? rawTarget : rawTarget instanceof Node ? rawTarget.parentElement : null;
        const found = start?.closest(selector) ?? null;
        if (!found || (scope !== undefined && !scope.contains(found))) return;
        matched = found;
      } else {
        matched = rawTarget instanceof Element ? rawTarget : scope !== undefined && isElementNode(scope) ? scope : document.documentElement;
      }
      if (options.preventDefault === true && options.passive !== true) event.preventDefault();
      if (options.stopPropagation === true) event.stopPropagation();
      if (options.once === true) removeListener(box, listenerId);
      sendTo(box.remixletId, { kind: "dom.event", listenerId, event: serializeEvent(box, event, matched, String(handle)) });
    };
    target.addEventListener(type, listener, { capture, passive: options.passive === true, once: options.once === true });
    box.listeners.set(listenerId, {
      target,
      type,
      listener,
      capture,
      handle: String(handle),
      node: scope,
      wasConnected: scope !== undefined && scope.isConnected,
    });
    return null;
  };

  const removeListener = (box: BoxState, listenerId: number): null => {
    const state = box.listeners.get(listenerId);
    if (!state) return null;
    state.target.removeEventListener(state.type, state.listener, state.capture);
    box.listeners.delete(listenerId);
    return null;
  };

  /** Remember a handle as stale, bounded; the node itself leaves the table so a fresh query mints a new handle. */
  const markStale = (box: BoxState, handle: Handle, node: HandleNode): void => {
    if (handle === "document" || handle === "body" || handle === "head") return;
    box.handles.delete(handle);
    if (!isDocumentNode(node) && box.reverse.get(node) === handle) box.reverse.delete(node);
    box.stale.add(handle);
    while (box.stale.size > STALE_HANDLES_CAP) {
      const oldest = box.stale.values().next().value;
      if (oldest === undefined) break;
      box.stale.delete(oldest);
    }
  };

  /**
   * Run on every coalesced mutation flush, so it costs one pass over the
   * box's listeners at most ten times a second and never a walk per
   * mutation. A listened node that was in the document and is not any more
   * was redrawn by the page: its listeners are dropped (they would never
   * fire again), the handle is marked stale, and the box hears once per
   * handle, ahead of the `dom.mutated` that follows.
   */
  const checkStaleListeners = (box: BoxState): void => {
    let gone: Map<Handle, { node: HandleNode; listeners: { listenerId: number; type: string }[] }> | undefined;
    for (const [listenerId, state] of box.listeners) {
      const node = state.node;
      if (node === undefined) continue;
      if (!state.wasConnected) {
        if (node.isConnected) state.wasConnected = true;
        continue;
      }
      if (node.isConnected) continue;
      gone ??= new Map();
      const entry = gone.get(state.handle) ?? { node, listeners: [] };
      entry.listeners.push({ listenerId, type: state.type });
      gone.set(state.handle, entry);
    }
    if (!gone) return;
    for (const [handle, entry] of gone) {
      for (const { listenerId } of entry.listeners) removeListener(box, listenerId);
      markStale(box, handle, entry.node);
      sendTo(box.remixletId, { kind: "dom.stale", handle, listeners: entry.listeners });
    }
  };

  // -------------------------------------------------------------------------
  // Observers (budgeted, coalesced; classification copied from the old guard)

  const stopObserver = (state: ObserverState): void => {
    state.observer.disconnect();
    if (state.coalesceTimer !== undefined) clearTimeout(state.coalesceTimer);
    if (state.trailingTimer !== undefined) clearTimeout(state.trailingTimer);
    state.coalesceTimer = undefined;
    state.trailingTimer = undefined;
  };

  const addObserver = (box: BoxState, observerId: number, root: Handle | undefined, options: MutationObserveOptions = {}): null => {
    removeObserver(box, observerId);
    const target = rootFor(box, root);
    const init: MutationObserverInit = {
      childList: options.childList ?? true,
      subtree: options.subtree ?? true,
      attributes: options.attributes ?? true,
      characterData: options.characterData ?? true,
    };
    if (!init.childList && !init.attributes && !init.characterData) throw new OpError("observe needs at least one of childList, attributes, characterData");
    const notice = (level: "warn" | "info", message: string): void =>
      sendTo(box.remixletId, { kind: "dom.notice", level, message: message.slice(0, 500) });
    const flush = (): void => {
      if (state.coalesceTimer !== undefined) clearTimeout(state.coalesceTimer);
      state.coalesceTimer = undefined;
      if (state.pendingDeliveries === 0 || !box.observers.has(observerId)) return;
      const deliveries = state.pendingDeliveries;
      state.pendingDeliveries = 0;
      state.lastFlushAt = Date.now();
      // Stale notices first: a keep evaluating on this notice must already
      // know which of its listeners died.
      checkStaleListeners(box);
      sendTo(box.remixletId, { kind: "dom.mutated", observerId, deliveries });
    };
    // Leading edge, then trailing: a delivery with no flush in the last
    // MUTATION_COALESCE_MS goes out now; either way a trailing flush is armed
    // (a no-op when nothing arrives), so a burst costs one notice now and one
    // at the window's end, never more than one per window.
    const schedule = (now: number): void => {
      if (state.coalesceTimer !== undefined) return;
      if (now - state.lastFlushAt >= MUTATION_COALESCE_MS) flush();
      state.coalesceTimer = setTimeout(flush, MUTATION_COALESCE_MS);
    };
    // Classify once per window, at the moment the budget runs out. Each
    // delivery is one task or microtask, so a self-feeding chain (notice →
    // write → next delivery) burns the budget in a few milliseconds and does
    // so again right after every trailing notice; page-driven churn spreads
    // across the window. Returns whether this saturation was the fast kind.
    const classify = (now: number): boolean => {
      const fastSaturation = now - state.windowStart < FAST_SATURATION_MS;
      if (fastSaturation && state.lastFastSaturationAt !== 0 && now - state.lastFastSaturationAt <= MUTATION_WINDOW_MS * 2) {
        if (!state.warnedLoop) {
          state.warnedLoop = true;
          notice(
            "warn",
            `${MUTATION_OBSERVER_FEEDBACK_LOOP_PREFIX}${MUTATION_BUDGET} times in under ${FAST_SATURATION_MS}ms in consecutive ` +
              `${MUTATION_WINDOW_MS}ms windows — likely a feedback loop (each run's DOM write triggers the next run). ` +
              "Deliveries stay coalesced so the page cannot freeze; make the callback idempotent: only write when the " +
              "value actually changes.",
          );
        }
      } else if (!fastSaturation && !state.warnedLoop && !state.notedThrottle) {
        state.notedThrottle = true;
        notice(
          "info",
          `${MUTATION_OBSERVER_THROTTLE_NOTICE_PREFIX}${MUTATION_BUDGET} per ${MUTATION_WINDOW_MS}ms — this page mutates its ` +
            `own DOM heavily. Deliveries stay coalesced to one notice per ${MUTATION_COALESCE_MS}ms, so reactions to rapid page ` +
            "updates are batched, not delayed. This is throttling on a busy page, not a feedback loop; the callback does not need fixing.",
        );
      }
      state.lastFastSaturationAt = fastSaturation ? now : 0;
      return fastSaturation;
    };
    const state: ObserverState = {
      flush,
      observer: new MutationObserver(() => {
        if (!alive || !box.observers.has(observerId)) return;
        const now = Date.now();
        if (now - state.windowStart >= MUTATION_WINDOW_MS) {
          state.windowStart = now;
          state.calls = 0;
          state.holding = false;
        }
        state.calls += 1;
        state.pendingDeliveries += 1;
        mutationSeq += 1;
        if (state.calls === MUTATION_BUDGET + 1 && classify(now)) {
          // A burst this fast is the remixlet feeding itself. Hold everything
          // for one trailing flush a window from now; the starved loop cannot
          // refill the budget until then, and if it does at once, the next
          // classification names it.
          state.holding = true;
          if (state.trailingTimer === undefined) {
            state.trailingTimer = setTimeout(() => {
              state.trailingTimer = undefined;
              state.windowStart = Date.now();
              state.calls = 1;
              state.holding = false;
              state.observer.takeRecords();
              flush();
            }, MUTATION_WINDOW_MS);
          }
        }
        if (state.holding) return;
        schedule(now);
      }),
      pendingDeliveries: 0,
      coalesceTimer: undefined,
      trailingTimer: undefined,
      holding: false,
      lastFlushAt: 0,
      windowStart: 0,
      calls: 0,
      lastFastSaturationAt: 0,
      warnedLoop: false,
      notedThrottle: false,
    };
    box.observers.set(observerId, state);
    state.observer.observe(target, init);
    return null;
  };

  const removeObserver = (box: BoxState, observerId: number): null => {
    const state = box.observers.get(observerId);
    if (!state) return null;
    box.observers.delete(observerId);
    stopObserver(state);
    return null;
  };

  // -------------------------------------------------------------------------
  // Page facts and scrolling

  const viewportNow = (): Viewport => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  });

  const numberOr = (value: number | undefined, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const scrollBehavior = (value: "auto" | "smooth" | undefined): ScrollBehavior => (value === "smooth" ? "smooth" : "auto");

  const factsNow = (): PageFacts => ({
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: viewportNow(),
  });

  /** One notice for the document; the host fans it out to every box. */
  const postFacts = (): void => {
    if (!alive) return;
    send({ kind: "page.facts", facts: factsNow() });
  };

  /** A readiness or load signal: a navigation notice (which itself posts facts), or fresh facts. */
  const refreshFacts = (): void => {
    if (!navCheck()) postFacts();
  };

  let factsTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleFacts = (): void => {
    if (!alive || factsTimer !== undefined) return;
    factsTimer = setTimeout(() => {
      factsTimer = undefined;
      refreshFacts();
    }, FACTS_THROTTLE_MS);
  };

  // -------------------------------------------------------------------------
  // Dispatch

  type Result<K extends DomOp["op"]> = DomResults[K];

  const execute = (box: BoxState, op: DomOp): DomResultValue | Promise<DomResultValue> => {
    switch (op.op) {
      case "query": {
        const found = select(rootFor(box, op.root), String(op.selector));
        return (found ? handleFor(box, found) : null) satisfies Result<"query">;
      }
      case "queryAll": {
        const limit = Math.max(0, Math.min(Number(op.limit ?? QUERY_ALL_CAP) || 0, QUERY_ALL_CAP));
        return selectAll(rootFor(box, op.root), String(op.selector), limit).map((el) => handleFor(box, el)) satisfies Result<"queryAll">;
      }
      case "waitFor":
        return waitFor(rootFor(box, op.root), String(op.selector), op.timeoutMs).then(
          (found): Result<"waitFor"> => (found && alive && boxes.get(box.remixletId) === box ? handleFor(box, found) : null),
        );
      case "info":
        return infoOf(box, elementFor(box, op.handle)) satisfies Result<"info">;
      case "infoAll":
        return (Array.isArray(op.handles) ? op.handles : []).map((h) => infoOf(box, elementFor(box, h))) satisfies Result<"infoAll">;
      case "text":
        return cap(elementFor(box, op.handle).textContent ?? "", HTML_READ_CAP) satisfies Result<"text">;
      case "html":
        return cap(markupWithoutSecrets(elementFor(box, op.handle), "inner"), HTML_READ_CAP) satisfies Result<"html">;
      case "attr": {
        const element = elementFor(box, op.handle);
        const name = String(op.name);
        if (isSensitiveField(element) && name.toLowerCase() === "value") return "" satisfies Result<"attr">;
        return element.getAttribute(name) satisfies Result<"attr">;
      }
      case "computed": {
        const style = window.getComputedStyle(elementFor(box, op.handle));
        const out: Record<string, string> = {};
        for (const prop of (Array.isArray(op.props) ? op.props : []).slice(0, COMPUTED_PROPS_CAP)) {
          out[prop] = style.getPropertyValue(kebab(String(prop)));
        }
        return out satisfies Result<"computed">;
      }
      case "rect":
        return rectOf(elementFor(box, op.handle)) satisfies Result<"rect">;
      case "value": {
        const element = elementFor(box, op.handle);
        return (isFormControl(element) ? valueOf(element, HTML_READ_CAP) : "") satisfies Result<"value">;
      }
      case "matches": {
        try {
          return elementFor(box, op.handle).matches(String(op.selector)) satisfies Result<"matches">;
        } catch (error) {
          if (error instanceof OpError) throw error;
          throw new OpError(`invalid selector: ${String(op.selector)}`);
        }
      }
      case "closest": {
        const element = elementFor(box, op.handle);
        let found: Element | null;
        try {
          found = element.closest(String(op.selector));
        } catch {
          throw new OpError(`invalid selector: ${String(op.selector)}`);
        }
        return (found ? handleFor(box, found) : null) satisfies Result<"closest">;
      }
      case "parent": {
        const parent = elementFor(box, op.handle).parentElement;
        return (parent ? handleFor(box, parent) : null) satisfies Result<"parent">;
      }
      case "children":
        return Array.from(nodeFor(box, op.handle).children)
          .slice(0, QUERY_ALL_CAP)
          .map((el) => handleFor(box, el)) satisfies Result<"children">;
      case "location": {
        const loc = window.location;
        return {
          href: loc.href,
          origin: loc.origin,
          pathname: loc.pathname,
          search: loc.search,
          hash: loc.hash,
          title: document.title,
        } satisfies Result<"location">;
      }
      case "innerText": {
        const element = elementFor(box, op.handle);
        // SAFETY: innerText is read as a duck-typed property; only HTML elements define it (SVG and MathML read
        // undefined), and the string check below falls back to textContent for those.
        const text = (element as HTMLElement).innerText;
        return cap(isString(text) ? text : element.textContent ?? "", HTML_READ_CAP) satisfies Result<"innerText">;
      }
      case "first":
        return handleOrNull(box, nodeFor(box, op.handle).firstElementChild) satisfies Result<"first">;
      case "last":
        return handleOrNull(box, nodeFor(box, op.handle).lastElementChild) satisfies Result<"last">;
      case "next":
        return handleOrNull(box, elementFor(box, op.handle).nextElementSibling) satisfies Result<"next">;
      case "prev":
        return handleOrNull(box, elementFor(box, op.handle).previousElementSibling) satisfies Result<"prev">;
      case "contains":
        return nodeFor(box, op.handle).contains(nodeFor(box, op.other)) satisfies Result<"contains">;
      case "shadow": {
        // Only an open root is reachable this way; a closed one reads null, exactly as it does for the page's own scripts.
        const root = elementFor(box, op.handle).shadowRoot;
        return (root ? handleFor(box, root) : null) satisfies Result<"shadow">;
      }
      case "isConnected":
        if (box.stale.has(op.handle)) return false satisfies Result<"isConnected">;
        return nodeFor(box, op.handle).isConnected satisfies Result<"isConnected">;
      case "viewport":
        return viewportNow() satisfies Result<"viewport">;
      case "scrollTo": {
        const behavior = scrollBehavior(op.behavior);
        if (op.handle === undefined) {
          window.scrollTo({ left: numberOr(op.x, window.scrollX), top: numberOr(op.y, window.scrollY), behavior });
        } else {
          const element = elementFor(box, op.handle);
          element.scrollTo({ left: numberOr(op.x, element.scrollLeft), top: numberOr(op.y, element.scrollTop), behavior });
        }
        return null satisfies Result<"scrollTo">;
      }
      case "scrollBy": {
        const behavior = scrollBehavior(op.behavior);
        const delta = { left: numberOr(op.x, 0), top: numberOr(op.y, 0), behavior };
        if (op.handle === undefined) window.scrollBy(delta);
        else elementFor(box, op.handle).scrollBy(delta);
        return null satisfies Result<"scrollBy">;
      }
      case "setText": {
        const element = elementFor(box, op.handle);
        const text = String(op.text ?? "");
        must(textWriteDecision(element.localName, text));
        element.textContent = text;
        return null satisfies Result<"setText">;
      }
      case "setHTML": {
        const element = elementFor(box, op.handle);
        if (element.localName === "script") throw new PolicyRefusal("script contents cannot be written");
        const sanitized = sanitizeHtml(String(op.html ?? ""), { document, url: urlContextFor(box) });
        must(sanitized);
        if (sanitized.kind !== "allow") return null;
        if (element.localName === "style") must(textWriteDecision("style", sanitized.fragment.textContent ?? ""));
        // The markup's top-level elements are the box's (their subtrees with
        // them); the element written into keeps whatever it was.
        for (const child of Array.from(sanitized.fragment.children)) stampOwner(child, box.remixletId);
        element.replaceChildren(sanitized.fragment);
        return null satisfies Result<"setHTML">;
      }
      case "setAttr": {
        const element = elementFor(box, op.handle);
        const name = String(op.name);
        const value = String(op.value ?? "");
        // The written value is policy's, not the box's: for src/href it is the
        // absolute URL the check resolved, so a base element the page changes
        // after the decision cannot redirect the load.
        const vetted = mustValue(
          attributeDecision({ tag: element.localName, name, value, url: urlContextFor(box), pageElement: pageElementFor(box, element) }),
        );
        try {
          element.setAttribute(name, vetted);
        } catch {
          throw new OpError(`invalid attribute name: ${name}`);
        }
        return null satisfies Result<"setAttr">;
      }
      case "removeAttr": {
        const element = elementFor(box, op.handle);
        must(removeAttributeDecision(element.localName, String(op.name), pageElementFor(box, element)));
        element.removeAttribute(String(op.name));
        return null satisfies Result<"removeAttr">;
      }
      case "classes": {
        const element = elementFor(box, op.handle);
        const list = element.classList;
        const names = (values: string[] | undefined): string[] =>
          (Array.isArray(values) ? values : []).map((v) => String(v).trim()).filter((v) => v !== "");
        const add = names(op.add);
        const remove = names(op.remove);
        const toggle = names(op.toggle);
        must(classWriteDecision([...add, ...remove, ...toggle], pageElementFor(box, element)));
        try {
          if (add.length > 0) list.add(...add);
          if (remove.length > 0) list.remove(...remove);
          for (const name of toggle) list.toggle(name);
        } catch {
          throw new OpError("class names cannot contain whitespace");
        }
        return Array.from(list) satisfies Result<"classes">;
      }
      case "style":
        applyStyle(elementFor(box, op.handle), op.props ?? {});
        return null satisfies Result<"style">;
      case "setValue":
        setValue(elementFor(box, op.handle), op.value);
        return null satisfies Result<"setValue">;
      case "create":
        return handleFor(box, create(box, op.spec)) satisfies Result<"create">;
      case "clone":
        return clone(box, elementFor(box, op.handle), op.options) satisfies Result<"clone">;
      case "addStyle": {
        const css = String(op.css ?? "");
        if (css.length > HTML_WRITE_CAP) throw new OpError(`stylesheet longer than ${HTML_WRITE_CAP} characters`);
        must(styleDecision(css));
        const style = document.createElement("style");
        style.textContent = css;
        stampOwner(style, box.remixletId);
        const anchor = document.head ?? document.documentElement;
        if (!anchor) throw new OpError("the page has no element to attach a stylesheet to yet");
        anchor.append(style);
        return handleFor(box, style) satisfies Result<"addStyle">;
      }
      case "append":
        return insert(box, op.parent, op.child, (parent, child) => parent.append(child)) satisfies Result<"append">;
      case "prepend":
        return insert(box, op.parent, op.child, (parent, child) => parent.prepend(child)) satisfies Result<"prepend">;
      case "before":
        return insert(box, op.ref, op.node, (ref, node) => ref.before(node)) satisfies Result<"before">;
      case "after":
        return insert(box, op.ref, op.node, (ref, node) => ref.after(node)) satisfies Result<"after">;
      case "remove":
        elementFor(box, op.handle).remove();
        return null satisfies Result<"remove">;
      case "click": {
        const element = elementFor(box, op.handle);
        must(clickDecision(element, urlContextFor(box)));
        // Only HTML elements have click(); SVG and MathML get the synthetic event.
        if (element instanceof HTMLElement) element.click();
        else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
        return null satisfies Result<"click">;
      }
      case "focus": {
        // SAFETY: focus() is read as a duck-typed method (HTML, SVG and MathML all define it); the Function check guards the call.
        const element = elementFor(box, op.handle) as HTMLElement;
        if (element.focus instanceof Function) element.focus();
        return null satisfies Result<"focus">;
      }
      case "blur": {
        // SAFETY: blur() is read as a duck-typed method (HTML, SVG and MathML all define it); the Function check guards the call.
        const element = elementFor(box, op.handle) as HTMLElement;
        if (element.blur instanceof Function) element.blur();
        return null satisfies Result<"blur">;
      }
      case "scrollIntoView":
        elementFor(box, op.handle).scrollIntoView({ block: op.block ?? "nearest" });
        return null satisfies Result<"scrollIntoView">;
      case "on":
        return addListener(box, op.handle, op.type, Number(op.listenerId), op.options) satisfies Result<"on">;
      case "off":
        return removeListener(box, Number(op.listenerId)) satisfies Result<"off">;
      case "observe":
        return addObserver(box, Number(op.observerId), op.root, op.options) satisfies Result<"observe">;
      case "unobserve":
        return removeObserver(box, Number(op.observerId)) satisfies Result<"unobserve">;
      case "release": {
        for (const handle of Array.isArray(op.handles) ? op.handles : []) {
          box.stale.delete(handle);
          const element = box.handles.get(handle);
          if (element) {
            box.handles.delete(handle);
            box.reverse.delete(element);
          }
        }
        return null satisfies Result<"release">;
      }
      default: {
        // Every DomOp member is handled above, so here `op` is never: an op name the box made up.
        const unlisted: { op?: string } = op;
        throw new OpError(`unknown operation ${String(unlisted.op)}`);
      }
    }
  };

  const errorText = (cause: unknown): string => {
    if (cause instanceof PolicyRefusal || cause instanceof OpError) return cause.message;
    const text = cause instanceof Error ? cause.message : String(cause);
    return text.slice(0, 500);
  };

  const handleCall = (box: BoxState, call: DomCall): void => {
    const reply = (ok: boolean, value?: DomResultValue, error?: string): void => {
      if (!alive || boxes.get(box.remixletId) !== box) return;
      sendTo(box.remixletId, ok ? { kind: "dom.result", id: call.id, ok: true, value } : { kind: "dom.result", id: call.id, ok: false, error });
    };
    let outcome: DomResultValue | Promise<DomResultValue>;
    try {
      outcome = execute(box, call.op);
    } catch (error) {
      reply(false, undefined, errorText(error));
      return;
    }
    if (outcome instanceof Promise) {
      outcome.then(
        (value) => reply(true, value),
        (error) => reply(false, undefined, errorText(error)),
      );
      return;
    }
    reply(true, outcome);
  };

  // -------------------------------------------------------------------------
  // Settle (protocol.ts DomSettleMessage). One round: flush every observer's
  // pending notice, remember the mutation count, ask every box, wait for the
  // answers. A box answers only once idle, and a keep the flushed notice woke
  // is part of that; if its writes changed the page again (mutationSeq moved),
  // the next round catches what they woke. A held observer (a fast saturation
  // starving a feedback loop) keeps its hold: the verification gate owns that
  // case, and forcing its notice out would feed the loop it is bounding.

  let nextSettleId = 1;
  const settleWaiters = new Map<number, () => void>();
  const settleBox = (box: BoxState, deadline: number): Promise<boolean> =>
    new Promise((resolve) => {
      const id = nextSettleId++;
      const timer = setTimeout(() => {
        settleWaiters.delete(id);
        resolve(false);
      }, Math.max(0, deadline - Date.now()));
      settleWaiters.set(id, () => {
        clearTimeout(timer);
        settleWaiters.delete(id);
        resolve(true);
      });
      sendTo(box.remixletId, { kind: "dom.settle", id });
    });
  const settle = async (options: SettleOptions = {}): Promise<SettleOutcome> => {
    const deadline = Date.now() + (options.budgetMs ?? SETTLE_BUDGET_MS);
    const maxRounds = options.maxRounds ?? SETTLE_MAX_ROUNDS;
    let rounds = 0;
    while (rounds < maxRounds) {
      if (!alive) return { settled: false, rounds, boxes: 0 };
      rounds += 1;
      const targets = Array.from(boxes.values());
      for (const box of targets) {
        for (const state of box.observers.values()) if (!state.holding) state.flush();
      }
      const seq = mutationSeq;
      const answers = await Promise.all(targets.map((box) => settleBox(box, deadline)));
      if (answers.some((answered) => !answered)) return { settled: false, rounds, boxes: targets.length };
      if (mutationSeq === seq) return { settled: true, rounds, boxes: targets.length };
    }
    return { settled: false, rounds, boxes: boxes.size };
  };

  const onEnvelope = (envelope: HostToAgentEnvelope): void => {
    if (!alive) return;
    // The transport hands over whatever the port carried; check the envelope's shape before trusting its type.
    if (!isRecord(envelope) || !isString(envelope.remixletId)) return;
    const payload = envelope.payload;
    if (!isRecord(payload) || !isString(payload.kind)) return;
    if (payload.kind === "dom.configure") {
      configure(envelope.remixletId, {
        matches: Array.isArray(payload.matches) ? payload.matches.map(String) : [],
        grantedHosts: Array.isArray(payload.grantedHosts) ? payload.grantedHosts.map(String) : [],
        observePatterns: Array.isArray(payload.observePatterns) ? payload.observePatterns.map(String) : [],
      });
      return;
    }
    if (payload.kind === "dom.drop") {
      // The host discarded that box; nothing it registered may outlive it,
      // and a later box under the same id must not inherit its handles.
      const box = boxes.get(envelope.remixletId);
      if (box) dropBox(box);
      return;
    }
    if (payload.kind === "dom.settled") {
      if (isNumber(payload.id)) settleWaiters.get(payload.id)?.();
      return;
    }
    if (payload.kind === "dom.call") {
      // An array op is still an object to execute(), which answers it as an unknown operation.
      if (!isNumber(payload.id) || !(isRecord(payload.op) || Array.isArray(payload.op))) return;
      handleCall(boxFor(envelope.remixletId), payload);
    }
  };

  // -------------------------------------------------------------------------
  // Navigation

  /** Notify on a real URL change (navigation notice, then fresh facts); false when nothing changed. */
  const navCheck = (): boolean => {
    if (!alive) return false;
    const url = window.location.href;
    if (url === currentUrl) return false;
    const previousUrl = currentUrl;
    currentUrl = url;
    send({ kind: "page.navigation", url, previousUrl });
    postFacts();
    // A box whose matches the new URL satisfies for the first time gets the
    // relay's backlog now; the others skip it by seq.
    let opened = false;
    for (const box of relayBoxes()) {
      if (box.observeActive) continue;
      if (observeGateOpen(box)) opened = true;
    }
    if (opened && ensureRelay()) requestRelaySync();
    return true;
  };
  const onPopState = (): void => void navCheck();
  const onHashChange = (): void => void navCheck();
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);
  // The Navigation API sees pushState/replaceState too, in this world, the
  // moment the entry changes: no relay, no worker round trip. Where it is
  // missing (older browsers) the worker's webNavigation hint still arrives.
  const navigationApi = navigationApiOf(window);
  const onEntryChange = (): void => void navCheck();
  navigationApi?.addEventListener("currententrychange", onEntryChange);

  // Readiness and load land as immediate facts; resize and scroll are throttled.
  const onReadiness = (): void => refreshFacts();
  const onViewport = (): void => scheduleFacts();
  document.addEventListener("readystatechange", onReadiness);
  document.addEventListener("DOMContentLoaded", onReadiness);
  window.addEventListener("load", onReadiness);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, { passive: true });

  transport.onMessage(onEnvelope);

  return {
    configure,
    settle,
    noteNavigation() {
      navCheck();
    },
    dropRemixlet(remixletId) {
      const box = boxes.get(remixletId);
      if (box) dropBox(box);
    },
    teardown() {
      if (!alive) return;
      alive = false;
      for (const box of [...boxes.values()]) dropBox(box);
      detachRelay();
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
      navigationApi?.removeEventListener("currententrychange", onEntryChange);
      document.removeEventListener("readystatechange", onReadiness);
      document.removeEventListener("DOMContentLoaded", onReadiness);
      window.removeEventListener("load", onReadiness);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport);
      if (factsTimer !== undefined) clearTimeout(factsTimer);
      factsTimer = undefined;
    },
    handleCount(remixletId) {
      return boxes.get(remixletId)?.handles.size ?? 0;
    },
    relayStats() {
      return { ...relayStats };
    },
  };
}
