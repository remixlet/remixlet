// Wire contract of the mediated execution runtime ("the box") — see
// wiki/design/mediated-execution.md. Pure types and constants, no extension
// APIs, so every side can import it: the box runtime (src/box/runtime.ts,
// inside the sandboxed page), the offscreen host (src/box/host.ts +
// platform/offscreen.ts), the page agent (src/box/page-agent.ts +
// platform/page-agent-content.ts) and the worker (worker/box.ts).
//
// Topology, one document at a time:
//
//   page (tab, ISOLATED world)        offscreen document           sandbox iframe (null origin)
//   ┌──────────────────────┐  port   ┌──────────────────────┐ post ┌──────────────────────────┐
//   │ page agent           │◄───────►│ host                 │◄────►│ box runtime + remixlet   │
//   │ holds the real DOM   │         │ one iframe per       │      │ code; no chrome.*, no    │
//   │ applies policy       │         │ (page, remixlet)     │      │ network, no page handle  │
//   └──────────────────────┘         └──────────┬───────────┘      └──────────────────────────┘
//                                               │ runtime.sendMessage (rmx.* lanes)
//                                               ▼
//                                          service worker (grants, storage, fetch, ...)
//
// Three transports carry three message families:
//   - PageToWorker / WorkerToPage: the agent's hello handshake (runtime.sendMessage).
//   - AgentToHost / HostToAgent: the port between page agent and host, one per
//     document, multiplexing every box for that document by remixletId.
//   - BoxToHost / HostToBox: window.postMessage between host and one iframe;
//     no remixletId needed, the iframe IS the remixlet.
// The host relays `dom.*` traffic between box and agent untouched and turns
// `rmx.call` into the worker's existing authenticated bridge messages
// (worker/bridge.ts) — the bridge token never enters the sandbox.

/** runtime.connect port name the page agent opens towards the host. */
export const AGENT_PORT_NAME = "rmx-page-agent";

/** Offscreen document that hosts every box (and the clipboard backend). */
export const OFFSCREEN_PATH = "offscreen.html";

/** The sandboxed page (manifest `sandbox.pages`) each box iframe loads. */
export const BOX_PAGE_PATH = "box.html";

/**
 * Sandbox CSP the manifest declares for BOX_PAGE_PATH. The measured
 * confinement (mediated-execution-spike.md): network sources are denied, so
 * fetch, beacon, images, styles, frames and forms cannot leave; `blob:`
 * scripts are how stored remixlet code enters; no `unsafe-eval`, so string
 * code is dead inside the box as well. Chromium 151 does not enforce the
 * draft `webrtc` directive, so runtime.ts also removes the native constructor
 * from the real box global before any remixlet file loads.
 */
export const BOX_SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' blob:; worker-src blob:; webrtc 'none'; base-uri 'none'; form-action 'none'";

// ---------------------------------------------------------------------------
// Page agent ⇄ worker (runtime.sendMessage; sender.tab/frameId identify the page)

export interface AgentHelloMessage {
  kind: "agent.hello";
  /** location.href of the document the agent runs in. */
  url: string;
}

/**
 * The worker's answer: how many remixlets the mirror wants on this URL (after
 * pause and origin-wide match filtering). Zero means "do not open a port";
 * otherwise the offscreen host is guaranteed to exist by the time this reply
 * arrives, so the agent connects immediately.
 */
export interface AgentHelloReply {
  kind: "agent.ready";
  remixletCount: number;
  /**
   * The union of the granted network:observe host patterns of the remixlets
   * that should run on this page. The agent announces it to the MAIN-world
   * relay (bridge/relay.ts announceRelayFilter) so the relay buffers only
   * those hosts' bodies; empty when none of them observes.
   */
  observeHosts: string[];
}

/**
 * Worker → page agent (tabs.sendMessage to the frame): a client-side
 * navigation was observed (webNavigation.onHistoryStateUpdated /
 * onReferenceFragmentUpdated). A hint only — the agent re-reads location.href
 * and notifies every box on a real change.
 */
export interface AgentNavigationHint {
  kind: "agent.navigation";
}

/**
 * Worker → page agent (tabs.sendMessage): wait until every box on the page is
 * idle (the settle handshake, DomSettleMessage below). Sent after a
 * click_element, after an activation's box run and after a navigate, so the
 * model's next read sees the page the remixlet's own code finished with, not
 * the gap before it (wiki/design/mediated-execution.md §The settle handshake).
 */
export interface AgentSettleRequest {
  kind: "agent.settle";
}

export interface AgentSettleReply {
  kind: "agent.settled";
  /** False when a box never answered within the budget, or the page kept changing past the round cap. */
  settled: boolean;
  rounds: number;
  boxes: number;
}

/** JSON as it survives postMessage and runtime messaging; every lane payload is one of these. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One rmx.* lane message: a worker/bridge.ts BridgeMessage minus the remixletId/bridgeToken envelope the host adds. */
export interface BridgeLaneMessage {
  kind: string;
  [field: string]: JsonValue | undefined;
}

/** The worker's BridgeReply as it crosses back to the box. */
export interface BridgeLaneReply {
  ok: boolean;
  error?: string;
  [field: string]: JsonValue | undefined;
}

// ---------------------------------------------------------------------------
// Host ⇄ worker (runtime.sendMessage from the offscreen document)

/** Host asks which remixlets to box for a freshly connected page agent. */
export interface BoxResolveMessage {
  kind: "box.resolve";
  tabId: number;
  frameId: number;
  url: string;
}

export interface BoxRemixletSpec {
  id: string;
  /** Manifest matches (the REAL ones; the registration was origin-wide). */
  matches: string[];
  /** Files in manifest order; every one runs in the box. */
  files: { name: string; code: string }[];
  /** Approved capability names, for the box's own convenience checks only. */
  capabilities: string[];
  /**
   * Secret the host attaches to every rmx.* call it forwards. Stays in the
   * host: never sent to the iframe, never to the page agent.
   */
  bridgeToken: string;
  /**
   * Host patterns from the remixlet's granted `fetch:` capabilities. URL
   * vetting (policy.ts) admits links and images to these hosts: the user
   * approved sending data to them for this remixlet. A `network:observe:`
   * grant does NOT appear here, because permission to watch a host's responses
   * is not permission to make new requests to it
   * (wiki/ops/2026-09-12-security-review-plan.md, F2). It appears only in
   * observePatterns below.
   */
  grantedHosts: string[];
  /**
   * Host patterns from the granted `network:observe:` capabilities alone. The
   * page agent forwards the MAIN-world relay's `network:response` records to
   * this box only for hosts they name (as `relay.message`); empty means the
   * box hears no relay traffic at all.
   */
  observePatterns: string[];
  /** When the files may run: the first script's runAt, document_idle by default. */
  runAt: RunAt;
}

export type RunAt = "document_start" | "document_end" | "document_idle";

export interface BoxResolveReply {
  kind: "box.resolved";
  remixlets: BoxRemixletSpec[];
}

/**
 * Box → worker rmx.* call, forwarded by the host. `message` is exactly one of
 * worker/bridge.ts's BridgeMessage shapes WITHOUT the remixletId/bridgeToken
 * envelope; the host adds those plus the page's identity — its URL for the
 * worker's pause and provenance gate, and the tab, frame and document the
 * agent's port.sender attested, for lanes bound to a tab document (rmx.menu).
 * The worker cannot read any of it off its own sender, which is the offscreen
 * document.
 */
export interface BoxBridgeMessage {
  kind: "box.bridge";
  remixletId: string;
  bridgeToken: string;
  pageUrl: string;
  page: BoxBridgePage;
  message: BridgeLaneMessage;
}

/** The page a box speaks for, as the browser told the host when the agent connected. */
export interface BoxBridgePage {
  tabId: number;
  frameId: number;
  /** Absent where the browser does not stamp ports with a document id. */
  documentId?: string;
}

/**
 * Worker → host broadcast after every mirror write or pause change: the host
 * re-resolves each live page and tears down boxes that are no longer wanted.
 * New boxes are never started mid-document (activation reloads the tab).
 */
export interface BoxRefreshMessage {
  kind: "box.refresh";
}

/**
 * Worker → host readiness probe, answered `box.host.pong` once offscreen.ts
 * has installed its listeners. createDocument resolves before the document's
 * script has necessarily run, and an agent told "ready" in that window would
 * connect to nobody and give the page up for good.
 */
export interface BoxHostPingMessage {
  kind: "box.host.ping";
}

export interface BoxHostPongMessage {
  kind: "box.host.pong";
}

// ---------------------------------------------------------------------------
// Page agent ⇄ host (the port). Everything is scoped by remixletId.

export interface AgentToHostEnvelope {
  remixletId: string;
  payload: AgentToBox;
}

export interface HostToAgentEnvelope {
  remixletId: string;
  payload: HostToAgentPayload;
}

/** Agent → host, not scoped to one box. */
export interface AgentNavigationNotice {
  kind: "page.navigation";
  url: string;
  previousUrl: string;
}

/**
 * Agent → host, not scoped to one box: facts about the document every box of
 * this page reads synchronously (the `location`, `navigator` and `window`
 * facades inside the box). The host fans it out to every iframe of the port
 * as `page.facts`. Sent once after configuration, on navigation, on every
 * readyState change, and on resize/scroll (throttled).
 */
export interface PageFactsNotice {
  kind: "page.facts";
  facts: PageFacts;
}

export interface PageFacts {
  url: string;
  title: string;
  readyState: "loading" | "interactive" | "complete";
  viewport: Viewport;
}

export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export type AgentPortMessage = AgentToHostEnvelope | AgentNavigationNotice | PageFactsNotice;

// ---------------------------------------------------------------------------
// Box ⇄ host (postMessage) and, relayed, box ⇄ agent

/** Box runtime finished loading; the host answers with `box.run`. */
export interface BoxReadyMessage {
  kind: "box.ready";
}

export interface BoxRunMessage {
  kind: "box.run";
  remixletId: string;
  /** Files wait for the page to reach this readiness (page.facts.readyState) before the URL gate runs them. */
  runAt: RunAt;
  matches: string[];
  capabilities: string[];
  files: { name: string; code: string }[];
  /** location.href of the page at box start. */
  url: string;
}

/** Box → host → worker, and back as `rmx.result`. */
export interface BoxRmxCall {
  kind: "rmx.call";
  id: number;
  message: BridgeLaneMessage;
}

export interface BoxRmxResult {
  kind: "rmx.result";
  id: number;
  /** The worker's BridgeReply verbatim ({ ok, error?, ...fields }). */
  reply: BridgeLaneReply;
}

/** Box → agent DOM operation; answered by exactly one `dom.result`. */
export interface DomCall {
  kind: "dom.call";
  id: number;
  op: DomOp;
}

export interface DomResult {
  kind: "dom.result";
  id: number;
  ok: boolean;
  /** JSON value on success. */
  value?: unknown;
  /** Plain-words failure; policy refusals start with "refused: ". */
  error?: string;
}

/** Agent → box: a listener registered with `on` fired. */
export interface DomEventMessage {
  kind: "dom.event";
  listenerId: number;
  event: SerializedEvent;
}

/** Agent → box: a coalesced batch of page mutations for one observer. */
export interface DomMutatedMessage {
  kind: "dom.mutated";
  observerId: number;
  /** How many raw MutationObserver deliveries were folded into this notice. */
  deliveries: number;
}

/** Agent → box: MAIN-world relay traffic (network:response, navigation:change). */
export interface RelayMessage {
  kind: "relay.message";
  topic: string;
  data: unknown;
}

export interface PageNavigationMessage {
  kind: "page.navigation";
  url: string;
  previousUrl: string;
}

/**
 * Host → agent, once per box before any dom.call: what the agent needs to
 * apply policy (the manifest matches for URL vetting) and to filter the
 * MAIN-world relay's traffic for this remixlet (empty observePatterns = none).
 */
export interface DomConfigureMessage {
  kind: "dom.configure";
  matches: string[];
  /** See BoxRemixletSpec.grantedHosts. */
  grantedHosts: string[];
  /** See BoxRemixletSpec.observePatterns. */
  observePatterns: string[];
}

/**
 * Host → agent: the box named by the envelope is gone; forget its handles,
 * listeners and observers, so nothing it registered outlives it and a later
 * box under the same id starts clean. Sent by the host's dropBox
 * (box/host.ts); the page agent's dropBox handles it.
 */
export interface DomDropMessage {
  kind: "dom.drop";
}

/**
 * Agent → box: something the agent decided that the remixlet's script log
 * should record (observer budget saturation warnings and notices). The box
 * runtime forwards it as rmx.log at the given level.
 */
export interface DomNoticeMessage {
  kind: "dom.notice";
  level: "info" | "warn" | "error";
  message: string;
}

/**
 * Agent → box: the node behind a listened handle left the document (the page
 * redrew it), so the listeners named here were dropped and the handle now
 * rejects every op as stale. Sent once per handle, from the coalesced
 * mutation path, ahead of that flush's `dom.mutated`. The runtime logs it
 * and re-runs the apply of the keep that bound the listeners.
 */
export interface DomStaleMessage {
  kind: "dom.stale";
  handle: Handle;
  listeners: { listenerId: number; type: string }[];
}

/**
 * Agent → box: answer `dom.settled` with the same id once nothing is in
 * flight: no event or observer callback running, no dom or rmx call waiting
 * for its answer, no keep pass running or owed, and the files' top-level code
 * finished. The page agent sends it behind the events it already delivered
 * (the port keeps order), so a click_element that waits on the answer returns
 * only after the handler that click fired has done its work.
 */
export interface DomSettleMessage {
  kind: "dom.settle";
  id: number;
}

/** Box → agent: the box is idle; answers one `dom.settle`. */
export interface DomSettledMessage {
  kind: "dom.settled";
  id: number;
}

export type BoxToAgent = DomCall | DomSettledMessage;
export type HostToAgentPayload = BoxToAgent | DomConfigureMessage | DomDropMessage;
export type AgentToBox =
  | DomResult
  | DomEventMessage
  | DomMutatedMessage
  | RelayMessage
  | DomNoticeMessage
  | DomStaleMessage
  | DomSettleMessage;
export type BoxToHost = BoxReadyMessage | BoxRmxCall | DomCall | DomSettledMessage;
export type HostToBox = BoxRunMessage | BoxRmxResult | AgentToBox | PageNavigationMessage | PageFactsNotice;

// ---------------------------------------------------------------------------
// DOM operations. Handles are opaque strings minted by the page agent
// ("h1", "h2", …); "document", "body", "head" and "window" (on/off only, for
// scroll, resize, keydown, keyup, focus, blur and visibilitychange) are always
// valid. A handle from `shadow` names an open shadow root: a query root, but
// not an element. A handle whose node left the document while a listener was
// bound to it is stale: the agent drops the listeners, sends `dom.stale`, and
// every later op on it (except `isConnected`, which answers false, and
// `release`) errors "stale: …". Every op answers with the JSON value
// documented on it, or an error.

export type Handle = string;

export interface ElementInfo {
  handle: Handle;
  tag: string;
  id: string;
  className: string;
  /** textContent, trimmed and capped at INFO_TEXT_CAP characters. */
  text: string;
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  /** Form controls only. */
  value?: string;
  checked?: boolean;
  rect: Rect;
  /** Laid out, non-zero size, not visibility:hidden/display:none. */
  visible: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface CreateSpec {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  classes?: string[];
  style?: Record<string, string>;
  /** Sanitised HTML children (same policy as setHTML). */
  html?: string;
  /**
   * Nested element specs (a string is a text node), appended after `text` and
   * `html`, so a whole control tree is one round trip. Every node passes the
   * same policy as a top-level create, the tree is vetted as a whole before any
   * node exists, and it is bounded by CREATE_TREE_CAP and CREATE_DEPTH_CAP.
   */
  children?: (CreateSpec | string)[];
}

/**
 * How `clone` edits its deep copy of a host element before answering. The
 * copy itself is sanitised exactly like `create { html }` (refused tags dropped
 * with their subtrees, refused attributes stripped, URLs and styles vetted),
 * so these options only shape what survives.
 */
export interface CloneOptions {
  /**
   * Replace text. A string replaces the clone's whole content with that text;
   * a map sets the text of the first node in the clone matching each selector
   * (the clone itself when it matches). A selector nothing matches is an error.
   */
  text?: string | Record<string, string>;
  /** Selectors whose matches inside the clone are removed, before `text` applies. */
  strip?: string[];
  /** Keep `id` and `for` attributes. Off by default: a duplicate id breaks the host's own labels. */
  keepIds?: boolean;
}

/** What `clone` answers: the detached copy, and what the copy lost on the way. */
export interface CloneResult {
  handle: Handle;
  /** Plain-words lines, one per dropped tag, stripped attribute or removed id/for; capped at CLONE_NOTES_CAP. */
  notes: string[];
}

export interface ListenerOptions {
  /** Delegate: fire only when event.target.closest(selector) matches; that element becomes `target`. */
  selector?: string;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  once?: boolean;
  capture?: boolean;
  passive?: boolean;
}

export interface SerializedEvent {
  type: string;
  /** Element the listener fired on (or the delegated match). */
  target: Handle;
  currentTarget: Handle;
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
  /** For input/change events: the control's value and checked state. */
  value?: string;
  checked?: boolean;
  /** For keys and clicks on the page's own controls, whether the default was prevented. */
  defaultPrevented: boolean;
}

export interface MutationObserveOptions {
  childList?: boolean;
  subtree?: boolean;
  attributes?: boolean;
  characterData?: boolean;
}

export type DomOp =
  // Queries — reads never need policy.
  | { op: "query"; selector: string; root?: Handle }
  | { op: "queryAll"; selector: string; root?: Handle; limit?: number }
  | { op: "waitFor"; selector: string; root?: Handle; timeoutMs: number }
  | { op: "info"; handle: Handle }
  | { op: "infoAll"; handles: Handle[] }
  | { op: "text"; handle: Handle }
  | { op: "html"; handle: Handle }
  | { op: "attr"; handle: Handle; name: string }
  | { op: "computed"; handle: Handle; props: string[] }
  | { op: "rect"; handle: Handle }
  | { op: "value"; handle: Handle }
  | { op: "matches"; handle: Handle; selector: string }
  | { op: "closest"; handle: Handle; selector: string }
  | { op: "parent"; handle: Handle }
  | { op: "children"; handle: Handle }
  | { op: "location" }
  | { op: "innerText"; handle: Handle }
  | { op: "first"; handle: Handle }
  | { op: "last"; handle: Handle }
  | { op: "next"; handle: Handle }
  | { op: "prev"; handle: Handle }
  | { op: "contains"; handle: Handle; other: Handle }
  | { op: "shadow"; handle: Handle }
  /** Whether the handle's node is still in the document; false (not an error) for a handle the agent marked stale. */
  | { op: "isConnected"; handle: Handle }
  | { op: "viewport" }
  // Writes — each passes src/box/policy.ts before touching the page.
  | { op: "setText"; handle: Handle; text: string }
  | { op: "setHTML"; handle: Handle; html: string }
  | { op: "setAttr"; handle: Handle; name: string; value: string }
  | { op: "removeAttr"; handle: Handle; name: string }
  | { op: "classes"; handle: Handle; add?: string[]; remove?: string[]; toggle?: string[] }
  | { op: "style"; handle: Handle; props: Record<string, string> }
  | { op: "setValue"; handle: Handle; value: string | boolean }
  | { op: "create"; spec: CreateSpec }
  /** A detached deep copy of a host element, vetted like a create tree; listeners are never copied. */
  | { op: "clone"; handle: Handle; options?: CloneOptions }
  | { op: "addStyle"; css: string }
  | { op: "append"; parent: Handle; child: Handle }
  | { op: "prepend"; parent: Handle; child: Handle }
  | { op: "before"; ref: Handle; node: Handle }
  | { op: "after"; ref: Handle; node: Handle }
  | { op: "remove"; handle: Handle }
  | { op: "click"; handle: Handle }
  | { op: "focus"; handle: Handle }
  | { op: "blur"; handle: Handle }
  | { op: "scrollIntoView"; handle: Handle; block?: "start" | "center" | "end" | "nearest" }
  /** Window scroll when `handle` is absent; the element's own scroll otherwise. */
  | { op: "scrollTo"; handle?: Handle; x?: number; y?: number; behavior?: "auto" | "smooth" }
  | { op: "scrollBy"; handle?: Handle; x: number; y: number; behavior?: "auto" | "smooth" }
  // Subscriptions.
  | { op: "on"; handle: Handle; type: string; listenerId: number; options?: ListenerOptions }
  | { op: "off"; listenerId: number }
  | { op: "observe"; observerId: number; root?: Handle; options?: MutationObserveOptions }
  | { op: "unobserve"; observerId: number }
  // Bookkeeping.
  | { op: "release"; handles: Handle[] };

/** Result shapes, by op (documented here; enforced by the runtime's typed wrappers). */
export interface DomResults {
  query: Handle | null;
  queryAll: Handle[];
  waitFor: Handle | null;
  info: ElementInfo;
  infoAll: ElementInfo[];
  text: string;
  html: string;
  attr: string | null;
  computed: Record<string, string>;
  rect: Rect;
  value: string;
  matches: boolean;
  closest: Handle | null;
  parent: Handle | null;
  children: Handle[];
  location: { href: string; origin: string; pathname: string; search: string; hash: string; title: string };
  innerText: string;
  first: Handle | null;
  last: Handle | null;
  next: Handle | null;
  prev: Handle | null;
  contains: boolean;
  /** An OPEN shadow root, usable as a query root; null when closed or absent. */
  shadow: Handle | null;
  isConnected: boolean;
  viewport: Viewport;
  scrollTo: null;
  scrollBy: null;
  setText: null;
  setHTML: null;
  setAttr: null;
  removeAttr: null;
  classes: string[];
  style: null;
  setValue: null;
  create: Handle;
  clone: CloneResult;
  addStyle: Handle;
  append: null;
  prepend: null;
  before: null;
  after: null;
  remove: null;
  click: null;
  focus: null;
  blur: null;
  scrollIntoView: null;
  on: null;
  off: null;
  observe: null;
  unobserve: null;
  release: null;
}

/** Bounds the page agent enforces regardless of what the box asks. */
export const QUERY_ALL_CAP = 500;
export const INFO_TEXT_CAP = 2000;
export const HTML_READ_CAP = 64 * 1024;
export const HTML_WRITE_CAP = 256 * 1024;
export const HANDLE_TABLE_CAP = 20000;
/** Nodes one `create` may build, counting the root and every nested child. */
export const CREATE_TREE_CAP = 1000;
/** How deep `children` may nest in one `create`. */
export const CREATE_DEPTH_CAP = 32;
/** Lines a `clone` answer may carry about what the copy lost; the rest fold into one "and N more". */
export const CLONE_NOTES_CAP = 20;
/**
 * Mutation notices per observer: the first delivery after a quiet spell goes
 * out at once (leading edge), and whatever follows within this window folds
 * into one trailing notice, so a keep reacts immediately and never more than
 * once per window.
 */
export const MUTATION_COALESCE_MS = 100;
/**
 * Raw MutationObserver deliveries per window that the guard classifies at: a
 * budget spent within FAST_SATURATION_MS (page-agent.ts) of the window's start is a burst the
 * remixlet's own writes fed back (deliveries are then held until the window's
 * trailing notice); a budget spent slowly is a page that churns on its own,
 * and its notices stay coalesced at MUTATION_COALESCE_MS.
 */
export const MUTATION_BUDGET = 40;
export const MUTATION_WINDOW_MS = 1000;
