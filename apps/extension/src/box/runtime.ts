// The box runtime: what runs inside the sandboxed box.html page, ahead of a
// remixlet's own files (wiki/design/mediated-execution.md). It installs the
// two globals a remixlet author writes against — `rmx` (the capability API)
// and `dom` (the mediated page API) — and speaks the wire contract in
// protocol.ts over one transport: window.postMessage to the offscreen host.
//
// Pure TypeScript: no chrome.*/browser.*, no platform imports. The transport
// is injected (box-entry.ts wires the real one) so the whole runtime runs in
// a plain test page against a fake host.
//
// Nothing here is authority. The page agent applies policy to every DOM
// write and the worker enforces grants on every rmx.* call; this code is the
// convenience layer that turns those two message streams into an API.
//
// CONTRACT DISCIPLINE. rmx.* is a published add-only contract
// (shared/bridge-version.ts): stored remixlet code was written against these
// names and cannot be regenerated. Add, never rename or remove. A breaking
// change bumps RMX_BRIDGE_VERSION, raises RMX_BRIDGE_MIN_SUPPORTED if old
// remixlets truly cannot run any more, and rides the skew path (the mirror
// build quarantines the artifact as needs-repair instead of running it).

import { markPrefix } from "../shared/marks.js";
import { POLICY_REFUSED_PREFIX, STALE_LISTENER_NOTICE_PREFIX } from "../shared/script-log.js";
import { urlMatchesAny } from "../shared/site-key.js";
import {
  CREATE_DEPTH_CAP,
  CREATE_TREE_CAP,
  HTML_WRITE_CAP,
  type CloneOptions,
  type BoxRunMessage,
  type BoxToHost,
  type CreateSpec,
  type DomEventMessage,
  type DomMutatedMessage,
  type DomOp,
  type DomResult,
  type DomResults,
  type DomStaleMessage,
  type ElementInfo,
  type HostToBox,
  type ListenerOptions,
  type MutationObserveOptions,
  type PageFacts,
  type Rect,
  type RelayMessage,
  type RunAt,
  type SerializedEvent,
  type Viewport,
} from "./protocol.js";

export interface BoxTransport {
  post(message: BoxToHost): void;
  onMessage(handler: (message: HostToBox) => void): void;
}

/** Outstanding dom.call / rmx.call replies the box will hold before refusing new ones. */
export const PENDING_CALL_CAP = 5000;
/** Longest selector the box sends; longer ones are an authoring mistake, not a page. */
export const SELECTOR_CAP = 4096;
/** Console lines forwarded per box (the old in-page bridge's CONSOLE_FORWARD_CAP). */
export const CONSOLE_FORWARD_CAP = 100;
/**
 * Sequenced relay records (the network:observe interceptor's responses) held
 * per topic for listeners that register later, sized like the MAIN-world ring
 * they came from (bridge/relay.ts OBSERVE_BUFFER_MAX / _BYTE_BUDGET). The
 * page agent asks the relay for its replay once, when the box is configured,
 * which is before any remixlet file has run; without this buffer every
 * response from before registration would be lost, and the system prompt
 * promises the opposite ("the buffered responses are replayed the moment your
 * script registers").
 */
export const RELAY_REPLAY_MAX = 250;
export const RELAY_REPLAY_BYTE_BUDGET = 6 * 1024 * 1024;

const KEEP_MAX_FAILED_APPLIES = 3;
const KEEP_NOTICE_APPLIES = 25;
const KEEP_NOTICE_WINDOW_MS = 60000;
const DEFAULT_WAIT_FOR_MS = 10000;

/** What crosses the wire in both directions and what remixlet code hands the rmx.* lanes. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

// ---------------------------------------------------------------------------
// Loading remixlet code

/**
 * Every ambient page-shaped global a remixlet file might reach for, shadowed
 * by a wrapper parameter. Most receive a throwing proxy. `location`,
 * `navigator` and `window` (with its aliases `self`, `globalThis`, `top`,
 * `parent`, `frames`) receive read-only facades built from the page facts the
 * agent pushes (wiki/design/mediated-execution-compatibility.md: stored
 * remixlets read `location.pathname` and `navigator.language` synchronously in
 * route logic and keeps). The animation-frame pair receive setTimeout shims
 * because an offscreen document never paints.
 */
export const SHADOWED_GLOBALS = [
  "document",
  "window",
  "self",
  "top",
  "parent",
  "frames",
  "globalThis",
  "location",
  "navigator",
  "history",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "Image",
  "Worker",
  "SharedWorker",
  "importScripts",
  "MutationObserver",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "open",
  "alert",
  "confirm",
  "prompt",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "Node",
  "Element",
  "HTMLElement",
  "Document",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

const directNetworkPoisons = new Map<string, Poisoned>();

/**
 * WebRTC is a direct network API in Chromium even under `default-src 'none'`.
 * Lock it on the real sandbox global as well as shadowing its lexical name:
 * blob modules and native callback receivers see the real global object.
 */
function lockDirectNetworkGlobals(): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"] as const) {
    let blocked = directNetworkPoisons.get(name);
    if (blocked === undefined) {
      blocked = poison(name);
      directNetworkPoisons.set(name, blocked);
    }
    const current = Object.getOwnPropertyDescriptor(globalThis, name);
    if (current?.configurable === false) {
      if (current.value !== blocked) throw new Error(`cannot disable ${name} inside the remixlet sandbox`);
      continue;
    }
    Object.defineProperty(globalThis, name, {
      value: blocked,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export function poisonMessage(name: string): string {
  if (name === "document") {
    return "document is not available inside a remixlet: the page is reached through the dom API (dom.document, dom.body, dom.query, …), see the authoring notes";
  }
  if (name === "localStorage" || name === "sessionStorage") {
    return `${name} is not available inside a remixlet: persisting data needs the storage capability and rmx.storage`;
  }
  if (name === "navigator.clipboard") {
    return "navigator.clipboard is not available inside a remixlet: use rmx.clipboard.writeText (needs the clipboard capability)";
  }
  return `${name} is not available inside a remixlet: the page is reached through the dom API (dom.query, dom.create, …), see the authoring notes`;
}

/** Thrown by every way of leaving the page through `location`. */
export const NAVIGATION_MESSAGE =
  "navigation is not available inside a remixlet; links the user clicks are the only way to another page";

type Poisoned = () => never;
type FrameScheduler = (callback: (time: number) => void) => number;
type FrameCanceller = (frame: number) => void;
/** What each SHADOWED_GLOBALS parameter receives. */
export type ShadowedGlobal = Poisoned | FrameScheduler | FrameCanceller | LocationFacade | NavigatorFacade | WindowFacade;
type WrappedFile = (...globals: ShadowedGlobal[]) => void;

/** The `location` a remixlet file sees: the page's last known URL, read-only. */
export interface LocationFacade {
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  assign(url: string): never;
  replace(url: string): never;
  reload(): never;
  toString(): string;
  valueOf(): string;
  toJSON(): string;
}

/** The `navigator` a remixlet file sees: the sandbox's own locale and platform facts, nothing that acts. */
export interface NavigatorFacade {
  readonly language: string;
  readonly languages: readonly string[];
  readonly userAgent: string;
  readonly platform: string;
  readonly hardwareConcurrency: number;
  readonly onLine: true;
}

type ScrollBehaviorArg = "auto" | "smooth" | "instant";
/** `scrollTo(x, y, behavior)` or the DOM's `scrollTo({ left, top, behavior })`. */
export type ScrollArg = number | { left?: number; top?: number; behavior?: ScrollBehaviorArg };

/**
 * The `window` a remixlet file sees (also `self`, `globalThis`, `top`,
 * `parent`, `frames`): timers, the JS builtins a file reaches through it, the
 * two facades, the viewport numbers from the page facts, window-level page
 * events and scrolling routed to `dom`, and the two box globals. Every other
 * property throws the poison message.
 */
export interface WindowFacade {
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly setInterval: typeof globalThis.setInterval;
  readonly clearInterval: typeof globalThis.clearInterval;
  readonly requestAnimationFrame: FrameScheduler;
  readonly cancelAnimationFrame: FrameCanceller;
  readonly queueMicrotask: typeof globalThis.queueMicrotask;
  readonly structuredClone: typeof globalThis.structuredClone;
  readonly Intl: typeof Intl;
  readonly JSON: typeof JSON;
  readonly Math: typeof Math;
  readonly Date: typeof Date;
  readonly Promise: typeof Promise;
  readonly console: Console;
  readonly location: LocationFacade;
  readonly navigator: NavigatorFacade;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly pageXOffset: number;
  readonly pageYOffset: number;
  addEventListener(type: string, callback: Callback<DomEvent>, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, callback: Callback<DomEvent>): void;
  scrollTo(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void>;
  scrollBy(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void>;
  readonly rmx: RmxApi;
  readonly dom: DomApi;
}

function isSymbol(value: string | symbol): value is symbol {
  return Object.prototype.toString.call(value) === "[object Symbol]";
}

/**
 * A read-only view over `target`: its own properties (getters read live) and
 * nothing else. A missing property throws `missing(name)`, so a file that
 * reaches for `window.IntersectionObserver` or `navigator.clipboard` learns
 * what to use instead; symbols, `then` and `toJSON` answer undefined so
 * `await`, JSON.stringify and the like treat the facade as a plain object.
 * Every write throws `writeMessage`.
 */
function facade<T extends LocationFacade | NavigatorFacade | WindowFacade>(
  target: T,
  missing: (name: string) => string,
  writeMessage: (name: string) => string,
): T {
  Object.freeze(target);
  const has = (name: string | symbol) => Object.prototype.hasOwnProperty.call(target, name);
  const refuse = (message: string): never => {
    throw new Error(message);
  };
  return new Proxy(target, {
    get: (own, name) => {
      const descriptor = Object.getOwnPropertyDescriptor(own, name);
      if (descriptor) return descriptor.get ? descriptor.get.call(own) : descriptor.value;
      if (isSymbol(name) || name === "then" || name === "toJSON") return undefined;
      return refuse(missing(name));
    },
    set: (_own, name) => refuse(writeMessage(String(name))),
    defineProperty: (_own, name) => refuse(writeMessage(String(name))),
    deleteProperty: (_own, name) => refuse(writeMessage(String(name))),
    has: (_own, name) => has(name),
  });
}

/** `data-` attribute name for a dataset key: `rmxItemId` → `data-rmx-item-id`. */
function dataAttribute(name: string): string {
  return `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** The scroll fields of a scrollTo / scrollBy op. */
interface ScrollFields {
  x?: number;
  y?: number;
  behavior?: "auto" | "smooth";
}

/** Normalises both scroll call shapes onto the wire fields; `instant` is the DOM's other word for `auto`. */
function scrollArgs(x: ScrollArg | undefined, y: number | undefined, behavior: ScrollBehaviorArg | undefined): ScrollFields {
  if (x instanceof Object) return scrollArgs(x.left, x.top, x.behavior);
  const out: ScrollFields = {};
  if (x !== undefined) out.x = Number(x);
  if (y !== undefined) out.y = Number(y);
  if (behavior !== undefined) out.behavior = behavior === "smooth" ? "smooth" : "auto";
  return out;
}

/** A value whose every use throws the plain-words explanation. */
export function poison(name: string): Poisoned {
  const fail = (): never => {
    throw new Error(poisonMessage(name));
  };
  return new Proxy(fail, {
    get: fail,
    set: fail,
    has: fail,
    apply: fail,
    construct: fail,
    deleteProperty: fail,
    defineProperty: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
    setPrototypeOf: fail,
  });
}

/** The source text of one wrapped remixlet file, as loaded from a blob: script. */
export function wrapRemixletFile(loadSeq: number, name: string, code: string): string {
  return (
    `globalThis.__rmxBoxLoad(${loadSeq}, (function (${SHADOWED_GLOBALS.join(", ")}) {\n` +
    `"use strict";\n${code}\n}));\n//# sourceURL=remixlet/${name.replace(/[^\w./-]/g, "_")}`
  );
}

// A wrapped file registers its function through this hook; one per page, shared
// by every runtime that page starts (tests start several).
const loadRegistry = new Map<number, WrappedFile>();
let loadHookInstalled = false;
let loadSeq = 0;
function installLoadHook(): void {
  if (loadHookInstalled) return;
  loadHookInstalled = true;
  Object.defineProperty(globalThis, "__rmxBoxLoad", {
    value: (seq: number, fn: WrappedFile) => {
      if (fn instanceof Function) loadRegistry.set(seq, fn);
    },
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

// ---------------------------------------------------------------------------
// Console capture. Wraps the page's console once; lines go to whichever
// runtime is current. The box page has exactly one runtime, so the
// indirection is only a test convenience, but it keeps the wrap idempotent
// the way the old in-page bridge's __rmxConsoleCapture marker did.

type ConsoleLevel = "log" | "info" | "warn" | "error";
/** What an author passes to console.log, as far as the type system describes it (JS callers pass anything). */
type ConsoleArgument = JsonValue | bigint | symbol | Error | Handle | undefined;
type ConsoleMethod = (...args: ConsoleArgument[]) => void;
type ConsoleForwarder = (level: ConsoleLevel, args: ConsoleArgument[]) => void;

const nativeConsole: Partial<Record<ConsoleLevel, ConsoleMethod>> = {};
let consoleForwarder: ConsoleForwarder | undefined;
let consoleWrapped = false;
function installConsoleCapture(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const method = console[level];
    nativeConsole[level] = (...args) => {
      try {
        method.apply(console, args);
      } catch {}
    };
    console[level] = (...args: ConsoleArgument[]) => {
      nativeConsole[level]?.(...args);
      consoleForwarder?.(level, args);
    };
  }
}

function isStringArgument(value: ConsoleArgument): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function serializeConsoleArg(value: ConsoleArgument): string {
  if (isStringArgument(value)) return value;
  if (value instanceof Error) return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Author-facing types

export interface DomLocation {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  title: string;
}

export interface QueryAllOptions {
  /** Also fetch ElementInfo for every match in the same round trip (fills handle.snapshot). */
  info?: boolean;
  limit?: number;
}

export interface CreateOptions {
  text?: string;
  attrs?: Record<string, string>;
  classes?: string[];
  style?: Record<string, string>;
  html?: string;
  /**
   * Nested elements (a string is a text node), appended after `text` and `html`,
   * so a whole control tree is one round trip: `dom.create("div", { children:
   * [{ tag: "label", text: "Mixes" }, { tag: "input", attrs: { type: "checkbox" } }] })`.
   * Reach a nested element afterwards with `root.query(...)`.
   */
  children?: (CreateChild | string)[];
}

/** A nested element in `CreateOptions.children`: a tag plus the same options. */
export interface CreateChild extends CreateOptions {
  tag: string;
}

export interface WaitForOptions {
  timeoutMs?: number;
}

export interface ObserveOptions extends MutationObserveOptions {
  root?: Handle;
}

export interface MutationNotice {
  deliveries: number;
}

export interface DomEvent extends Omit<SerializedEvent, "target" | "currentTarget"> {
  target: Handle;
  currentTarget: Handle;
}

/** Author callbacks may be async; whatever they resolve to is ignored. */
export type Callback<T> = (value: T) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface DomApi {
  document: Handle;
  body: Handle;
  head: Handle;
  /** Window-level page events only (scroll, resize, keydown, keyup, focus, blur, visibilitychange). */
  window: WindowHandle;
  query(selector: string): Promise<Handle | null>;
  queryAll(selector: string, options?: QueryAllOptions): Promise<Handle[]>;
  waitFor(selector: string, options?: WaitForOptions): Promise<Handle | null>;
  create(tag: string, options?: CreateOptions): Promise<Handle>;
  /** dom.query(selector) then handle.clone(options); null when nothing matches. */
  clone(selector: string, options?: CloneOptions): Promise<Handle | null>;
  addStyle(css: string): Promise<Handle>;
  location(): Promise<DomLocation>;
  /** The viewport as of the last page facts: synchronous, no round trip. */
  viewport(): Viewport;
  /** A fresh viewport read from the page. */
  viewportNow(): Promise<Viewport>;
  scrollTo(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void>;
  scrollBy(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void>;
  /** Coalesced mutation notices for read-only reactions; writes that must hold belong in rmx.keep. */
  observe(callback: Callback<MutationNotice>, options?: ObserveOptions): Unsubscribe;
}

/** What a keep's when/ensure may resolve to; the box tests it for truthiness. */
export type KeepVerdict = JsonValue | Handle | Handle[] | undefined;
export type KeepCheck = () => KeepVerdict | Promise<KeepVerdict>;

export interface KeepSpec {
  when?: KeepCheck;
  ensure: KeepCheck;
  apply: () => void | Promise<void>;
}

export interface NavigationChange {
  url: string;
  previousUrl: string;
}

export interface RmxFetchOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  timeoutMs?: number;
}

export interface RmxResponse {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  headers: Headers;
  body: string;
  text(): Promise<string>;
  json(): Promise<JsonValue>;
}

export interface ScheduleHook {
  name: string;
}

export interface RmxApi {
  /**
   * The prefix of every mark this remixlet writes on the page's own elements:
   * `rmx-<id>`. Code writes `` `data-${rmx.prefix}-mix` `` and never spells
   * the id (shared/marks.ts). Empty until box.run names the remixlet.
   */
  readonly prefix: string;
  log: { warn(message: string): void; error(message: string): void };
  keep(label: string, spec: KeepSpec): Unsubscribe;
  relay: { on(topic: string, callback: Callback<JsonValue>): Unsubscribe };
  navigation: { onChange(callback: Callback<NavigationChange>): Unsubscribe };
  network: { onResponse(pattern: string, callback: Callback<JsonObject>): Unsubscribe };
  fetch(url: string | URL, options?: RmxFetchOptions): Promise<RmxResponse>;
  storage: {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<void>;
    watch(key: string, callback: Callback<JsonValue | undefined>): Unsubscribe;
  };
  notifications: {
    show(title: string, message: string): Promise<string>;
    clear(notificationId: string): Promise<boolean>;
  };
  clipboard: { writeText(text: string): Promise<void> };
  menu: { register(id: string, label: string, callback: () => void | Promise<void>): Promise<string> };
  schedule: {
    register(definition: JsonObject): Promise<JsonValue | undefined>;
    at(id: string, at: JsonValue, action: JsonValue): Promise<JsonValue | undefined>;
    every(id: string, every: JsonValue, action: JsonValue): Promise<JsonValue | undefined>;
    remove(scheduleId: string): Promise<boolean>;
    list(): Promise<JsonValue[]>;
    clear(): Promise<void>;
    onSiteOpen(hookName: string, callback?: Callback<ScheduleHook>): Promise<string | Unsubscribe>;
    removeOnSiteOpen(hookName: string): Promise<boolean>;
    consumeHooks(): Promise<string[]>;
    onHook(hookName: string, callback: Callback<ScheduleHook>): Unsubscribe;
  };
}

export interface BoxRuntime {
  rmx: RmxApi;
  dom: DomApi;
  /** Detach from the transport and the page's error events (tests run several runtimes in one page). */
  stop(): void;
}

/** One rmx.* lane message, the shape worker/bridge.ts reads minus the envelope the host adds. */
interface BridgeMessage {
  kind: string;
  [field: string]: JsonValue | undefined;
}

/** The worker's BridgeReply as the host relays it. */
interface BridgeReply {
  ok: boolean;
  error?: string;
  [field: string]: JsonValue | undefined;
}

/** A type literal, not an interface, so it is comparable with the JsonObject the reply carries. */
type RmxFetchReplyResponse = {
  url: string;
  status: number;
  statusText: string;
  redirected: boolean;
  headers: [string, string][];
  content: string;
};

type DomAnswer = DomResults[keyof DomResults];
type DomPending = { resolve: (value: DomAnswer) => void; reject: (error: Error) => void };
type RmxPending = { resolve: (reply: BridgeReply) => void; reject: (error: Error) => void };
type Level = "info" | "warn" | "error";

/** How the keep machinery learns which listeners exist: registered by `on`, removed by its unsubscribe. */
interface ListenerHooks {
  registered(listenerId: number): void;
  removed(listenerId: number): void;
}

// ---------------------------------------------------------------------------

/** A remote element. The string `id` is the page agent's opaque handle. */
export class Handle {
  /**
   * The last ElementInfo read for this element: filled by info() and, in one
   * round trip for many elements, by queryAll(selector, { info: true }). A
   * snapshot, not a live view.
   */
  snapshot: ElementInfo | undefined = undefined;
  constructor(
    readonly id: string,
    private readonly box: BoxCore,
  ) {}

  async info(): Promise<ElementInfo> {
    const info = await this.box.call({ op: "info", handle: this.id });
    this.snapshot = info;
    return info;
  }
  text(): Promise<string> {
    return this.box.call({ op: "text", handle: this.id });
  }
  /** The rendered text (what the user sees), as opposed to text()'s textContent. */
  innerText(): Promise<string> {
    return this.box.call({ op: "innerText", handle: this.id });
  }
  async setText(text: string): Promise<void> {
    await this.box.call({ op: "setText", handle: this.id, text: capped(String(text), HTML_WRITE_CAP, "text") });
  }
  html(): Promise<string> {
    return this.box.call({ op: "html", handle: this.id });
  }
  async setHTML(html: string): Promise<void> {
    await this.box.call({ op: "setHTML", handle: this.id, html: capped(String(html), HTML_WRITE_CAP, "html") });
  }
  attr(name: string): Promise<string | null> {
    return this.box.call({ op: "attr", handle: this.id, name: String(name) });
  }
  async setAttr(name: string, value: string): Promise<void> {
    await this.box.call({
      op: "setAttr",
      handle: this.id,
      name: String(name),
      value: capped(String(value), HTML_WRITE_CAP, "attribute"),
    });
  }
  async removeAttr(name: string): Promise<void> {
    await this.box.call({ op: "removeAttr", handle: this.id, name: String(name) });
  }
  /** dataset sugar: data("rmxItemId") reads data-rmx-item-id. */
  data(name: string): Promise<string | null> {
    return this.attr(dataAttribute(name));
  }
  setData(name: string, value: string): Promise<void> {
    return this.setAttr(dataAttribute(name), value);
  }
  /** The hidden attribute, as `el.hidden = true/false` did. */
  hide(): Promise<void> {
    return this.setAttr("hidden", "");
  }
  show(): Promise<void> {
    return this.removeAttr("hidden");
  }
  setDisabled(disabled: boolean): Promise<void> {
    return disabled ? this.setAttr("disabled", "") : this.removeAttr("disabled");
  }
  addClass(...names: string[]): Promise<string[]> {
    return this.box.call({ op: "classes", handle: this.id, add: names.flat().map(String) });
  }
  removeClass(...names: string[]): Promise<string[]> {
    return this.box.call({ op: "classes", handle: this.id, remove: names.flat().map(String) });
  }
  /** `toggleClass(...names)` flips each; a trailing boolean is classList's force flag: `toggleClass(name, true)` adds. */
  toggleClass(...names: (string | string[] | boolean)[]): Promise<string[]> {
    const last = names[names.length - 1];
    const force = last === true || last === false ? last : undefined;
    const list = (force === undefined ? names : names.slice(0, -1)).flat().map(String);
    if (force === true) return this.addClass(...list);
    if (force === false) return this.removeClass(...list);
    return this.box.call({ op: "classes", handle: this.id, toggle: list });
  }
  async style(props: Record<string, string>): Promise<void> {
    await this.box.call({ op: "style", handle: this.id, props: stringRecord(props) });
  }
  computed(props: string): Promise<string>;
  computed(props: string[]): Promise<Record<string, string>>;
  async computed(props: string | string[]): Promise<string | Record<string, string>> {
    const list = Array.isArray(props) ? props.map(String) : [String(props)];
    const values = await this.box.call({ op: "computed", handle: this.id, props: list });
    return Array.isArray(props) ? values : (values[list[0]!] ?? "");
  }
  rect(): Promise<Rect> {
    return this.box.call({ op: "rect", handle: this.id });
  }
  async visible(): Promise<boolean> {
    return (await this.info()).visible;
  }
  value(): Promise<string> {
    return this.box.call({ op: "value", handle: this.id });
  }
  async setValue(value: string | boolean): Promise<void> {
    await this.box.call({ op: "setValue", handle: this.id, value: value === true || value === false ? value : String(value) });
  }
  matches(selector: string): Promise<boolean> {
    return this.box.call({ op: "matches", handle: this.id, selector: selectorArg(selector) });
  }
  async closest(selector: string): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "closest", handle: this.id, selector: selectorArg(selector) }));
  }
  async parent(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "parent", handle: this.id }));
  }
  async children(): Promise<Handle[]> {
    return (await this.box.call({ op: "children", handle: this.id })).map((id) => this.box.handle(id));
  }
  /** Element children and siblings (text nodes are skipped, as firstElementChild and kin skip them). */
  async first(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "first", handle: this.id }));
  }
  async last(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "last", handle: this.id }));
  }
  async next(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "next", handle: this.id }));
  }
  async prev(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "prev", handle: this.id }));
  }
  contains(other: Handle | string): Promise<boolean> {
    return this.box.call({ op: "contains", handle: this.id, other: handleId(other) });
  }
  /** The element's open shadow root as a query root, or null when closed or absent. */
  async shadow(): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "shadow", handle: this.id }));
  }
  /**
   * Whether this handle's node is still in the document. False, not an
   * error, once the page redrew the node while a listener was bound to it
   * (every other call on the handle then rejects "stale: …").
   */
  isConnected(): Promise<boolean> {
    return this.box.call({ op: "isConnected", handle: this.id });
  }
  async query(selector: string): Promise<Handle | null> {
    return this.box.handleOrNull(await this.box.call({ op: "query", selector: selectorArg(selector), root: this.id }));
  }
  queryAll(selector: string, options?: QueryAllOptions): Promise<Handle[]> {
    return this.box.queryAll(selector, options, this.id);
  }
  /**
   * A detached deep copy of this element, host classes and attributes
   * included, vetted like a create tree (refused tags and attributes removed,
   * id and for dropped unless keepIds, at most CREATE_TREE_CAP nodes) and
   * edited by `strip` then `text`. Listeners are never copied. Attach it with
   * append/prepend/before/after; what the copy lost is logged once as "clone: …".
   */
  async clone(options?: CloneOptions): Promise<Handle> {
    const op: DomOp = { op: "clone", handle: this.id };
    const wire = cloneOptions(options);
    if (wire !== undefined) op.options = wire;
    const result = await this.box.call(op);
    if (result.notes.length > 0) this.box.report("info", `clone: ${result.notes.join("; ")}`, false);
    return this.box.handle(result.handle);
  }
  async append(child: Handle | string): Promise<void> {
    await this.box.call({ op: "append", parent: this.id, child: handleId(child) });
  }
  async prepend(child: Handle | string): Promise<void> {
    await this.box.call({ op: "prepend", parent: this.id, child: handleId(child) });
  }
  async before(node: Handle | string): Promise<void> {
    await this.box.call({ op: "before", ref: this.id, node: handleId(node) });
  }
  async after(node: Handle | string): Promise<void> {
    await this.box.call({ op: "after", ref: this.id, node: handleId(node) });
  }
  async remove(): Promise<void> {
    await this.box.call({ op: "remove", handle: this.id });
  }
  async click(): Promise<void> {
    await this.box.call({ op: "click", handle: this.id });
  }
  async focus(): Promise<void> {
    await this.box.call({ op: "focus", handle: this.id });
  }
  async blur(): Promise<void> {
    await this.box.call({ op: "blur", handle: this.id });
  }
  async scrollIntoView(block?: "start" | "center" | "end" | "nearest"): Promise<void> {
    const op: DomOp = { op: "scrollIntoView", handle: this.id };
    if (block !== undefined) op.block = block;
    await this.box.call(op);
  }
  /** This element's own scroll position (the window's is dom.scrollTo / dom.scrollBy). */
  async scrollTo(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void> {
    await this.box.call({ op: "scrollTo", handle: this.id, ...scrollArgs(x, y, behavior) });
  }
  async scrollBy(x?: ScrollArg, y?: number, behavior?: ScrollBehaviorArg): Promise<void> {
    const { x: dx = 0, y: dy = 0, ...rest } = scrollArgs(x, y, behavior);
    await this.box.call({ op: "scrollBy", handle: this.id, x: dx, y: dy, ...rest });
  }
  /** Subscribe to a page event on this element; returns an unsubscribe. */
  on(type: string, callback: Callback<DomEvent>, options?: ListenerOptions): Unsubscribe {
    if (!(callback instanceof Function)) throw new TypeError("callback must be a function");
    return this.box.listen(this.id, String(type), callback, options);
  }
  async release(): Promise<void> {
    await this.box.call({ op: "release", handles: [this.id] });
  }
}

/**
 * `dom.window`: the page's window as an event source and nothing more. One
 * subscription per (type, callback) pair, as addEventListener dedups, so the
 * `window.addEventListener` / `removeEventListener` facade pair can route here.
 */
export class WindowHandle {
  readonly id = "window";
  private readonly subscriptions = new Map<string, Map<Callback<DomEvent>, Unsubscribe>>();
  constructor(private readonly box: BoxCore) {}

  on(type: string, callback: Callback<DomEvent>, options?: ListenerOptions): Unsubscribe {
    if (!(callback instanceof Function)) throw new TypeError("callback must be a function");
    const key = String(type);
    const byCallback = this.subscriptions.get(key) ?? new Map<Callback<DomEvent>, Unsubscribe>();
    this.subscriptions.set(key, byCallback);
    const existing = byCallback.get(callback);
    if (existing) return existing;
    const stop = this.box.listen(this.id, key, callback, options);
    const off = () => {
      if (byCallback.get(callback) !== off) return;
      byCallback.delete(callback);
      stop();
    };
    byCallback.set(callback, off);
    return off;
  }
  off(type: string, callback: Callback<DomEvent>): void {
    this.subscriptions.get(String(type))?.get(callback)?.();
  }
}

/** addEventListener's third argument, as ListenerOptions. */
function listenerOptions(options: boolean | AddEventListenerOptions | undefined): ListenerOptions | undefined {
  if (options === undefined) return undefined;
  if (options === true || options === false) return { capture: options };
  const out: ListenerOptions = {};
  if (options.capture !== undefined) out.capture = options.capture;
  if (options.once !== undefined) out.once = options.once;
  if (options.passive !== undefined) out.passive = options.passive;
  return out;
}

function handleId(value: Handle | string): string {
  const id = value instanceof Handle ? value.id : String(value);
  if (id === "") throw new TypeError("expected a dom handle");
  return id;
}

function selectorArg(selector: string): string {
  const text = String(selector);
  if (text === "") throw new TypeError("selector must be a non-empty string");
  return capped(text, SELECTOR_CAP, "selector");
}

function capped(text: string, cap: number, what: string): string {
  if (text.length > cap) throw new Error(`${what} is too long (${text.length} characters, the limit is ${cap})`);
  return text;
}

/**
 * An author's create options as the wire spec, nested children included. Caps
 * are the agent's (it enforces them again); failing here names the author's
 * mistake before a message crosses.
 */
function createSpec(tag: string, options: CreateOptions, depth: number, count: { nodes: number }): CreateSpec {
  if (depth > CREATE_DEPTH_CAP) throw new TypeError(`create nests deeper than ${CREATE_DEPTH_CAP} levels`);
  count.nodes += 1;
  if (count.nodes > CREATE_TREE_CAP) throw new TypeError(`create builds more than ${CREATE_TREE_CAP} nodes`);
  if (!(options instanceof Object)) throw new TypeError("create options must be an object");
  const spec: CreateSpec = { tag: String(tag) };
  if (spec.tag === "") throw new TypeError("create needs a tag name");
  if (options.text !== undefined) spec.text = capped(String(options.text), HTML_WRITE_CAP, "text");
  if (options.attrs !== undefined) spec.attrs = stringRecord(options.attrs);
  if (options.classes !== undefined) spec.classes = Array.from(options.classes, String);
  if (options.style !== undefined) spec.style = stringRecord(options.style);
  if (options.html !== undefined) spec.html = capped(String(options.html), HTML_WRITE_CAP, "html");
  if (options.children !== undefined) {
    if (!Array.isArray(options.children)) throw new TypeError("create children must be an array of { tag, ... } specs or strings");
    spec.children = options.children.map((child) => {
      if (isTextChild(child)) {
        count.nodes += 1;
        if (count.nodes > CREATE_TREE_CAP) throw new TypeError(`create builds more than ${CREATE_TREE_CAP} nodes`);
        return capped(child, HTML_WRITE_CAP, "text");
      }
      if (!(child instanceof Object) || !isTextChild(child.tag)) throw new TypeError("each create child needs a tag (or is a string for text)");
      return createSpec(child.tag, child, depth + 1, count);
    });
  }
  return spec;
}

/** A string entry in `children` is a text node (and a string `text` in clone options is the whole text); anything else must be a spec. */
function isTextChild(value: CreateChild | Record<string, string> | string | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** An author's clone options as the wire shape; author mistakes fail here, before a message crosses. */
function cloneOptions(options: CloneOptions | undefined): CloneOptions | undefined {
  if (options === undefined) return undefined;
  if (!(options instanceof Object)) throw new TypeError("clone options must be an object");
  const out: CloneOptions = {};
  if (options.text !== undefined) {
    const text = options.text;
    if (isTextChild(text)) out.text = capped(text, HTML_WRITE_CAP, "text");
    else if (text instanceof Object) {
      const map: Record<string, string> = {};
      for (const [selector, value] of Object.entries(text)) map[selectorArg(selector)] = capped(String(value), HTML_WRITE_CAP, "text");
      out.text = map;
    } else throw new TypeError("clone text must be a string or an object of selector: text");
  }
  if (options.strip !== undefined) {
    if (!Array.isArray(options.strip)) throw new TypeError("clone strip must be an array of selectors");
    out.strip = options.strip.map((selector) => selectorArg(String(selector)));
  }
  if (options.keepIds !== undefined) out.keepIds = options.keepIds === true;
  return out;
}

/** Author-supplied property maps, coerced to strings for the wire. */
function stringRecord(value: Record<string, string>) {
  if (!(value instanceof Object)) throw new TypeError("expected an object of string values");
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = String(entry);
  return out;
}

function truthy(value: KeepVerdict): boolean {
  return Boolean(value);
}

// ---------------------------------------------------------------------------

/** The transport-facing half: pending calls, listeners, observers, reporting. */
class BoxCore {
  private nextId = 1;
  private readonly pendingDom = new Map<number, DomPending>();
  private readonly pendingRmx = new Map<number, RmxPending>();
  private readonly listeners = new Map<number, { callback: Callback<DomEvent>; once: boolean }>();
  private readonly observers = new Map<number, Callback<MutationNotice>>();
  private readonly refusalsLogged = new Set<string>();
  stopped = false;
  listenerHooks: ListenerHooks | undefined = undefined;
  /** Author callbacks (event, observer) still running. */
  inFlight = 0;

  /** Anything this core is waiting on: an unanswered call or a running callback. */
  busy(): boolean {
    return this.pendingDom.size > 0 || this.pendingRmx.size > 0 || this.inFlight > 0;
  }

  constructor(private readonly transport: BoxTransport) {}

  allocateId(): number {
    return this.nextId++;
  }

  handle(id: string): Handle {
    return new Handle(id, this);
  }

  handleOrNull(id: string | null): Handle | null {
    return id === null ? null : this.handle(id);
  }

  /** One dom.call, answered by exactly one dom.result carrying that op's DomResults value. */
  call<K extends DomOp["op"]>(op: Extract<DomOp, { op: K }>): Promise<DomResults[K]> {
    if (this.stopped) return Promise.reject(new Error("the remixlet is no longer running"));
    if (this.pendingDom.size >= PENDING_CALL_CAP) {
      return Promise.reject(new Error(`too many dom calls in flight (${PENDING_CALL_CAP}); await earlier ones first`));
    }
    const id = this.allocateId();
    // SAFETY: the page agent answers each op with the DomResults value documented for that op (protocol.ts).
    return new Promise((resolve: (value: DomAnswer) => void, reject) => {
      this.pendingDom.set(id, { resolve, reject });
      try {
        this.transport.post({ kind: "dom.call", id, op });
      } catch (cause: unknown) {
        this.pendingDom.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }) as Promise<DomResults[K]>;
  }

  send(message: BridgeMessage): Promise<BridgeReply> {
    if (this.stopped) return Promise.reject(new Error("the remixlet is no longer running"));
    if (this.pendingRmx.size >= PENDING_CALL_CAP) {
      return Promise.reject(new Error(`too many rmx calls in flight (${PENDING_CALL_CAP}); await earlier ones first`));
    }
    const id = this.allocateId();
    return new Promise((resolve, reject) => {
      this.pendingRmx.set(id, { resolve, reject });
      try {
        this.transport.post({ kind: "rmx.call", id, message });
      } catch (cause: unknown) {
        this.pendingRmx.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async queryAll(selector: string, options: QueryAllOptions | undefined, root?: string): Promise<Handle[]> {
    const op: DomOp = { op: "queryAll", selector: selectorArg(selector) };
    if (root !== undefined) op.root = root;
    if (options?.limit !== undefined) op.limit = Number(options.limit);
    const ids = await this.call(op);
    const handles = ids.map((id) => this.handle(id));
    if (options?.info && ids.length > 0) {
      const infos = await this.call({ op: "infoAll", handles: ids });
      const byHandle = new Map(infos.map((info) => [info.handle, info]));
      for (const handle of handles) handle.snapshot = byHandle.get(handle.id);
    }
    return handles;
  }

  listen(handle: string, type: string, callback: Callback<DomEvent>, options?: ListenerOptions): Unsubscribe {
    const listenerId = this.allocateId();
    this.listeners.set(listenerId, { callback, once: options?.once === true });
    this.listenerHooks?.registered(listenerId);
    const op: DomOp = { op: "on", handle, type, listenerId };
    if (options) op.options = options;
    void this.call(op).catch((cause: unknown) => {
      this.listeners.delete(listenerId);
      this.listenerHooks?.removed(listenerId);
      this.report("error", `dom.on(${JSON.stringify(type)}) failed: ${String(cause)}`);
    });
    return () => {
      if (!this.listeners.delete(listenerId)) return;
      this.listenerHooks?.removed(listenerId);
      void this.call({ op: "off", listenerId }).catch(() => {});
    };
  }

  /**
   * The agent dropped these listeners (their node left the document). Forget
   * the ones this box still knew and answer them, so the caller can tell a
   * live drop from one the author had already unsubscribed.
   */
  handleStale(message: DomStaleMessage): { listenerId: number; type: string }[] {
    const known: { listenerId: number; type: string }[] = [];
    for (const entry of Array.isArray(message.listeners) ? message.listeners : []) {
      if (!this.listeners.delete(entry.listenerId)) continue;
      known.push({ listenerId: entry.listenerId, type: String(entry.type) });
    }
    return known;
  }

  observe(callback: Callback<MutationNotice>, options?: ObserveOptions): Unsubscribe {
    if (!(callback instanceof Function)) throw new TypeError("callback must be a function");
    const observerId = this.allocateId();
    this.observers.set(observerId, callback);
    const { root, ...rest } = options ?? {};
    const mutationOptions: MutationObserveOptions =
      Object.keys(rest).length === 0 ? { childList: true, subtree: true, attributes: true, characterData: true } : rest;
    const op: DomOp = { op: "observe", observerId, options: mutationOptions };
    if (root !== undefined) op.root = handleId(root);
    void this.call(op).catch((cause: unknown) => {
      this.observers.delete(observerId);
      this.report("error", `dom.observe failed: ${String(cause)}`);
    });
    return () => {
      if (!this.observers.delete(observerId)) return;
      void this.call({ op: "unobserve", observerId }).catch(() => {});
    };
  }

  /**
   * Fire-and-forget reporting through the rmx.log lane (the worker keeps the
   * bounded per-remixlet ring the panel's read_remixlet_logs reads). Mirrors
   * to the native console for humans; a caller may suppress that duplicate
   * for a contained, actionable notice. Telemetry, not authority.
   */
  report(level: Level, message: string, mirrorToConsole = true): void {
    const text = String(message).slice(0, 500);
    if (mirrorToConsole) nativeConsole[level === "warn" ? "warn" : "error"]?.(`[remixlet] ${text}`);
    try {
      void this.send({ kind: "rmx.log", level, message: text }).catch(() => {});
    } catch {}
  }

  handleDomResult(result: DomResult): void {
    const pending = this.pendingDom.get(result.id);
    if (!pending) return;
    this.pendingDom.delete(result.id);
    if (result.ok) {
      // SAFETY: a successful dom.result carries the DomResults value for the op it answers (protocol.ts).
      pending.resolve(result.value as DomAnswer);
      return;
    }
    const text = result.error !== undefined && result.error !== "" ? result.error : "dom call failed";
    if (text.startsWith("refused: ") && !this.refusalsLogged.has(text)) {
      this.refusalsLogged.add(text);
      this.report("warn", `${POLICY_REFUSED_PREFIX}${text.slice("refused: ".length)}`);
    }
    pending.reject(new Error(text));
  }

  handleRmxResult(id: number, reply: BridgeReply): void {
    const pending = this.pendingRmx.get(id);
    if (!pending) return;
    this.pendingRmx.delete(id);
    pending.resolve(reply);
  }

  handleDomEvent(message: DomEventMessage): void {
    const entry = this.listeners.get(message.listenerId);
    if (!entry) return;
    if (entry.once) this.listeners.delete(message.listenerId);
    const event = message.event;
    const domEvent: DomEvent = {
      ...event,
      target: this.handle(event.target),
      currentTarget: this.handle(event.currentTarget),
    };
    this.inFlight += 1;
    void (async () => {
      try {
        await entry.callback(domEvent);
      } catch (cause: unknown) {
        this.report("error", `event listener for ${JSON.stringify(event.type)} failed: ${String(cause)}`);
      } finally {
        this.inFlight -= 1;
      }
    })();
  }

  handleMutated(message: DomMutatedMessage): void {
    const callback = this.observers.get(message.observerId);
    if (!callback) return;
    this.inFlight += 1;
    void (async () => {
      try {
        await callback({ deliveries: message.deliveries });
      } catch (cause: unknown) {
        this.report("error", `dom.observe callback failed: ${String(cause)}`);
      } finally {
        this.inFlight -= 1;
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    const gone = new Error("the remixlet is no longer running");
    for (const pending of this.pendingDom.values()) pending.reject(gone);
    for (const pending of this.pendingRmx.values()) pending.reject(gone);
    this.pendingDom.clear();
    this.pendingRmx.clear();
    this.listeners.clear();
    this.observers.clear();
  }
}

// ---------------------------------------------------------------------------

/**
 * Start the runtime on a transport. Posts `box.ready`, installs `rmx` and
 * `dom` on globalThis, then waits for `box.run`. Returns the two APIs (for
 * tests and for the entry) and a stop().
 */
export function startBoxRuntime(transport: BoxTransport): BoxRuntime {
  lockDirectNetworkGlobals();
  installLoadHook();
  installConsoleCapture();
  const core = new BoxCore(transport);

  const unwrap = async (promise: Promise<BridgeReply>): Promise<BridgeReply> => {
    const reply = await promise;
    if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || "rmx bridge failure");
    return reply;
  };
  const send = (message: BridgeMessage) => core.send(message);
  const report = (level: Level, message: string, mirrorToConsole = true) => core.report(level, message, mirrorToConsole);

  // Console capture: bounded twice — 500 chars per line and CONSOLE_FORWARD_CAP
  // lines per box, the last slot naming the cutoff. "[remixlet] " lines are the
  // runtime's own prints, each already sent through report().
  let consoleForwarded = 0;
  consoleForwarder = (level, args) => {
    if (core.stopped) return;
    let text: string;
    try {
      text = args.map(serializeConsoleArg).join(" ").slice(0, 500);
    } catch {
      text = "[unserializable console arguments]";
    }
    if (text.lastIndexOf("[remixlet] ", 0) === 0) return;
    if (consoleForwarded >= CONSOLE_FORWARD_CAP) return;
    consoleForwarded += 1;
    if (consoleForwarded === CONSOLE_FORWARD_CAP) {
      report(
        "warn",
        `console capture stopped: more than ${CONSOLE_FORWARD_CAP} console lines this page load — further console output is not recorded`,
      );
      return;
    }
    try {
      void send({ kind: "rmx.log", level, message: text }).catch(() => {});
    } catch {}
  };

  // --- page facts --------------------------------------------------------------
  // The agent's per-document snapshot (URL, title, readyState, viewport), fanned
  // out to every box of the page: what the synchronous facades and dom.viewport()
  // read, and what the runAt gate waits on. Until the first one arrives the box
  // knows only the URL box.run carried, a page still loading and a zero viewport.

  const placeholderFacts = (url: string): PageFacts => ({
    url,
    title: "",
    readyState: "loading",
    viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
  });
  let facts = placeholderFacts("");
  let factsReceived = false;

  // --- dom -----------------------------------------------------------------

  const dom: DomApi = {
    document: core.handle("document"),
    body: core.handle("body"),
    head: core.handle("head"),
    window: new WindowHandle(core),
    viewport: () => ({ ...facts.viewport }),
    viewportNow: () => core.call({ op: "viewport" }),
    scrollTo: async (x, y, behavior) => {
      await core.call({ op: "scrollTo", ...scrollArgs(x, y, behavior) });
    },
    scrollBy: async (x, y, behavior) => {
      const { x: dx = 0, y: dy = 0, ...rest } = scrollArgs(x, y, behavior);
      await core.call({ op: "scrollBy", x: dx, y: dy, ...rest });
    },
    query: async (selector) => core.handleOrNull(await core.call({ op: "query", selector: selectorArg(selector) })),
    queryAll: (selector, options) => core.queryAll(selector, options),
    waitFor: async (selector, options) => {
      const timeoutMs = Number(options?.timeoutMs ?? DEFAULT_WAIT_FOR_MS);
      return core.handleOrNull(await core.call({ op: "waitFor", selector: selectorArg(selector), timeoutMs }));
    },
    create: async (tag, options = {}) => core.handle(await core.call({ op: "create", spec: createSpec(tag, options, 0, { nodes: 0 }) })),
    clone: async (selector, options) => {
      const source = await dom.query(selector);
      return source ? source.clone(options) : null;
    },
    addStyle: async (css) => core.handle(await core.call({ op: "addStyle", css: capped(String(css), HTML_WRITE_CAP, "css") })),
    location: () => core.call({ op: "location" }),
    observe: (callback, options) => core.observe(callback, options),
  };

  // --- relay (MAIN-world traffic the page agent forwards) -------------------

  const relayListeners = new Map<string, Set<Callback<JsonValue>>>();
  // Replay buffer: records carrying a numeric seq (listeners dedup on it, as
  // rmx.network.onResponse does) are kept, oldest evicted first, and handed
  // to every later listener on the same topic. Unsequenced messages
  // (navigation hints, ad hoc posts) are live-only.
  const relayReplay = new Map<string, { data: JsonValue; bytes: number }[]>();
  let relayReplayBytes = 0;
  const remember = (topic: string, data: JsonValue): void => {
    if (!isJsonObject(data) || !isNumber(data.seq)) return;
    const entry = { data, bytes: JSON.stringify(data).length };
    const list = relayReplay.get(topic) ?? [];
    list.push(entry);
    relayReplay.set(topic, list);
    relayReplayBytes += entry.bytes;
    while (list.length > RELAY_REPLAY_MAX || (relayReplayBytes > RELAY_REPLAY_BYTE_BUDGET && list.length > 0)) {
      relayReplayBytes -= list.shift()!.bytes;
    }
  };
  const deliver = (listener: Callback<JsonValue>, data: JsonValue): void => {
    try {
      void Promise.resolve(listener(data)).catch((cause: unknown) => report("error", `relay callback failed: ${String(cause)}`));
    } catch (cause: unknown) {
      report("error", `relay callback failed: ${String(cause)}`);
    }
  };
  const relayOn = (topic: string, callback: Callback<JsonValue>): Unsubscribe => {
    if (!(callback instanceof Function)) throw new TypeError("callback must be a function");
    const set = relayListeners.get(topic) ?? new Set();
    set.add(callback);
    relayListeners.set(topic, set);
    // Replayed synchronously, as the old bridge's sync event was, so a record
    // arriving right after registration is never seen before the backlog.
    for (const entry of Array.from(relayReplay.get(topic) ?? [])) deliver(callback, entry.data);
    return () => set.delete(callback);
  };
  const dispatchRelay = (message: RelayMessage): void => {
    // SAFETY: relay payloads are the page agent's JSON.parse output of the MAIN-world relay event.
    const data = message.data as JsonValue;
    remember(message.topic, data);
    const set = relayListeners.get(message.topic);
    if (!set) return;
    for (const listener of Array.from(set)) deliver(listener, data);
  };

  // --- navigation hub --------------------------------------------------------
  // page.navigation notices are hints: the hub compares against the last URL
  // it knew and notifies only on a real change. The activation gate registers
  // first so files run before author listeners see the change.

  const navListeners = new Set<Callback<NavigationChange>>();
  let navUrl = "";
  const navCheck = (url: string): void => {
    if (url === navUrl) return;
    const previousUrl = navUrl;
    navUrl = url;
    // Whichever notice arrives first (page.navigation or page.facts) moves
    // `location`; the other finds the URL already known and fires nothing.
    if (facts.url !== url) facts = { ...facts, url };
    for (const listener of Array.from(navListeners)) {
      try {
        void Promise.resolve(listener({ url, previousUrl })).catch((cause: unknown) =>
          report("error", `navigation callback failed: ${String(cause)}`),
        );
      } catch (cause: unknown) {
        report("error", `navigation callback failed: ${String(cause)}`);
      }
    }
  };

  // --- rmx.keep --------------------------------------------------------------
  // Same contract as the old in-page bridge, evaluated asynchronously and serialized:
  // callbacks may return promises (when/ensure are truthy-tested on the
  // resolved value). A mutation notice or navigation arriving mid-evaluation
  // marks the pass dirty and it re-runs once.
  //
  // Listeners bound during a keep's apply belong to that keep. When the page
  // redraws the node one of them was bound to (the agent's `dom.stale`), a
  // keep whose ensure() checks presence would still pass on the look-alike, so
  // the next evaluation treats ensure() as failed once and apply() runs to
  // bind afresh. Only a listener from the keep's latest listener-binding apply
  // counts: one from an earlier apply died because a later apply already
  // replaced it, and re-applying on that would loop an apply that rebuilds
  // its control every time. A rebind apply that leaves ensure() true resets
  // the failure count like any other, so a page that redraws every second
  // costs one apply a second and never a halt.

  interface Keep {
    label: string;
    when: KeepCheck | undefined;
    ensure: KeepCheck;
    apply: () => void | Promise<void>;
    failedApplies: number;
    appliesInWindow: number;
    applyWindowStart: number;
    notedFrequentReapply: boolean;
    halted: boolean;
    /** Count of applies so far; a listener records the value it was bound under. */
    applySeq: number;
    /** applySeq of the latest apply that bound a listener; 0 when none has. */
    lastListenSeq: number;
    /** Set by a stale notice for a listener of the latest binding apply: the next evaluation applies regardless of ensure(). */
    rebind: boolean;
  }
  const keeps = new Set<Keep>();
  let keepObserverStop: Unsubscribe | undefined;
  let keepPassRunning = false;
  let keepPassDirty = false;
  /** The keep whose apply() is running, so listeners bound meanwhile are attributed to it. */
  let applyingKeep: Keep | undefined;
  const listenerOwners = new Map<number, { keep: Keep; applySeq: number }>();
  core.listenerHooks = {
    registered: (listenerId) => {
      if (!applyingKeep) return;
      listenerOwners.set(listenerId, { keep: applyingKeep, applySeq: applyingKeep.applySeq });
      applyingKeep.lastListenSeq = applyingKeep.applySeq;
    },
    removed: (listenerId) => {
      listenerOwners.delete(listenerId);
    },
  };

  const evaluateKeep = async (keep: Keep): Promise<void> => {
    if (keep.halted || !keeps.has(keep)) return;
    try {
      if (keep.when && !truthy(await keep.when())) {
        keep.failedApplies = 0;
        return;
      }
      const rebinding = keep.rebind;
      keep.rebind = false;
      if (!rebinding && truthy(await keep.ensure())) {
        keep.failedApplies = 0;
        return;
      }
      const now = Date.now();
      if (now - keep.applyWindowStart > KEEP_NOTICE_WINDOW_MS) {
        keep.applyWindowStart = now;
        keep.appliesInWindow = 0;
      }
      keep.appliesInWindow += 1;
      keep.applySeq += 1;
      applyingKeep = keep;
      try {
        await keep.apply();
      } finally {
        applyingKeep = undefined;
      }
      // A stale notice that landed mid-apply asked for what this apply just did.
      if (keep.lastListenSeq === keep.applySeq) keep.rebind = false;
      if (truthy(await keep.ensure())) {
        keep.failedApplies = 0;
        if (keep.appliesInWindow >= KEEP_NOTICE_APPLIES && !keep.notedFrequentReapply) {
          keep.notedFrequentReapply = true;
          report(
            "info",
            `keep "${keep.label}": reapplied ${keep.appliesInWindow} times in the last minute — the page redraws this area often. Reapplying is normal; informational only.`,
            false,
          );
        }
        return;
      }
      keep.failedApplies += 1;
      if (keep.failedApplies >= KEEP_MAX_FAILED_APPLIES) {
        keep.halted = true;
        report(
          "error",
          `keep "${keep.label}" halted: apply() ran ${KEEP_MAX_FAILED_APPLIES} consecutive times without making ensure() true.` +
            " Make one apply() establish exactly the state ensure() checks, or add when() so the keep idles until the page piece it needs exists.",
        );
      }
    } catch (cause: unknown) {
      keep.failedApplies += 1;
      if (keep.failedApplies >= KEEP_MAX_FAILED_APPLIES) {
        keep.halted = true;
        report("error", `keep "${keep.label}" halted: callbacks threw ${KEEP_MAX_FAILED_APPLIES} consecutive times — ${String(cause)}`);
      } else {
        report("error", `keep "${keep.label}" callback threw: ${String(cause)}`);
      }
    }
  };
  const evaluateKeeps = (): void => {
    if (keepPassRunning) {
      keepPassDirty = true;
      return;
    }
    keepPassRunning = true;
    void (async () => {
      try {
        do {
          keepPassDirty = false;
          for (const keep of Array.from(keeps)) await evaluateKeep(keep);
        } while (keepPassDirty && !core.stopped);
      } finally {
        keepPassRunning = false;
      }
    })();
  };
  const registerKeep = (label: string, spec: KeepSpec): Unsubscribe => {
    const text = String(label);
    if (text.trim() === "") {
      throw new TypeError("keep label must be a short plain-words description of the condition");
    }
    if (!(spec instanceof Object) || !(spec.ensure instanceof Function) || !(spec.apply instanceof Function)) {
      throw new TypeError("keep needs { ensure, apply } functions (plus optional when)");
    }
    if (spec.when !== undefined && !(spec.when instanceof Function)) {
      throw new TypeError("keep when must be a function when given");
    }
    const keep: Keep = {
      label: text.trim().slice(0, 120),
      when: spec.when,
      ensure: spec.ensure,
      apply: spec.apply,
      failedApplies: 0,
      appliesInWindow: 0,
      applyWindowStart: 0,
      notedFrequentReapply: false,
      halted: false,
      applySeq: 0,
      lastListenSeq: 0,
      rebind: false,
    };
    keeps.add(keep);
    if (!keepObserverStop) {
      keepObserverStop = core.observe(() => evaluateKeeps(), {
        root: dom.document,
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      navListeners.add(evaluateKeeps);
    }
    evaluateKeeps();
    return () => {
      keeps.delete(keep);
      if (keeps.size === 0 && keepObserverStop) {
        keepObserverStop();
        keepObserverStop = undefined;
        navListeners.delete(evaluateKeeps);
      }
    };
  };

  /**
   * The agent dropped listeners whose node left the document. Log it once per
   * handle, and when one of them was bound by a keep's latest binding apply,
   * flag that keep to apply again and evaluate now rather than waiting for
   * the next mutation notice (this flush's own `dom.mutated` may already have
   * been consumed by a pass that saw ensure() true).
   */
  const onStale = (message: DomStaleMessage): void => {
    const known = core.handleStale(message);
    if (known.length === 0) return;
    let owner: Keep | undefined;
    let superseded: Keep | undefined;
    for (const { listenerId } of known) {
      const bound = listenerOwners.get(listenerId);
      listenerOwners.delete(listenerId);
      if (!bound || !keeps.has(bound.keep) || bound.keep.halted) continue;
      if (bound.applySeq < bound.keep.lastListenSeq) {
        superseded = bound.keep;
        continue;
      }
      bound.keep.rebind = true;
      owner = bound.keep;
    }
    const types = [...new Set(known.map((entry) => JSON.stringify(entry.type)))].join(", ");
    const remedy = owner
      ? `keep "${owner.label}" re-applies and binds a fresh one`
      : superseded
        ? `keep "${superseded.label}" already bound a fresh one`
        : "bind listeners inside a keep's apply so a redraw re-binds them";
    report("warn", `${STALE_LISTENER_NOTICE_PREFIX}${types} on handle ${String(message.handle)}: the node it was bound to left the document (the page redrew it); ${remedy}`, false);
    if (owner) evaluateKeeps();
  };

  // --- rmx.* lanes over rmx.call ---------------------------------------------

  const storageCall = (op: string, payload: JsonObject) => send({ kind: "rmx.storage", op, ...payload });
  const notificationsCall = (op: string, payload: JsonObject) => send({ kind: "rmx.notifications", op, ...payload });
  const clipboardCall = (payload: JsonObject) => send({ kind: "rmx.clipboard", op: "writeText", ...payload });
  const menuCall = (op: string, payload: JsonObject = {}) => send({ kind: "rmx.menu", op, ...payload });
  const scheduleCall = (op: string, payload: JsonObject = {}) => send({ kind: "rmx.schedule", op, ...payload });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const requireFunction = <T extends Function>(callback: T): T => {
    if (!(callback instanceof Function)) throw new TypeError("callback must be a function");
    return callback;
  };

  // Named by box.run, ahead of the files it runs.
  let remixletId = "";
  const rmx: RmxApi = {
    get prefix() {
      return remixletId === "" ? "" : markPrefix(remixletId);
    },
    log: {
      warn: (message) => report("warn", String(message)),
      error: (message) => report("error", String(message)),
    },
    keep: registerKeep,
    relay: { on: relayOn },
    navigation: {
      onChange: (callback) => {
        navListeners.add(requireFunction(callback));
        return () => navListeners.delete(callback);
      },
    },
    network: {
      onResponse: (pattern, callback) => {
        requireFunction(callback);
        const wanted = String(pattern || "").toLowerCase();
        const seen = new Set<number>();
        return relayOn("network:response", (data) => {
          try {
            if (!isJsonObject(data) || !isString(data.url)) return;
            const url = data.url;
            if (isNumber(data.seq)) {
              if (seen.has(data.seq)) return;
              seen.add(data.seq);
            }
            let hostname = "";
            try {
              hostname = new URL(url).hostname.toLowerCase();
            } catch {}
            const matches =
              wanted === "" ||
              (wanted.startsWith("*.")
                ? hostname === wanted.slice(2) || hostname.endsWith(`.${wanted.slice(2)}`)
                : hostname === wanted || url.toLowerCase().includes(wanted));
            if (matches) void callback(data);
          } catch (cause: unknown) {
            report("error", `network observer callback failed: ${String(cause)}`);
          }
        });
      },
    },
    fetch: async (url, options = {}) => {
      const headers = options.headers === undefined ? [] : Array.from(new Headers(options.headers).entries());
      const requestOptions: JsonObject = { headers };
      if (options.method !== undefined) requestOptions.method = String(options.method);
      if (options.body !== undefined) requestOptions.body = String(options.body);
      if (options.timeoutMs !== undefined) requestOptions.timeoutMs = Number(options.timeoutMs);
      const request: JsonObject = { url: url instanceof URL ? url.href : String(url), options: requestOptions };
      const reply = await unwrap(send({ kind: "rmx.fetch", request }));
      // SAFETY: the worker's rmx.fetch success reply carries its serialized response under `response` (worker/bridge.ts).
      const response = reply.response as RmxFetchReplyResponse;
      const content = response.content;
      return Object.freeze({
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        ok: response.status >= 200 && response.status < 300,
        redirected: response.redirected,
        headers: new Headers(response.headers),
        body: content,
        text: async () => content,
        json: async (): Promise<JsonValue> => {
          // SAFETY: JSON.parse yields only JSON values.
          return JSON.parse(content) as JsonValue;
        },
      });
    },
    storage: {
      get: async (key) => (await unwrap(storageCall("get", { key }))).value,
      set: async (key, value) => {
        await unwrap(storageCall("set", { key, value }));
      },
      delete: async (key) => {
        await unwrap(storageCall("delete", { key }));
      },
      watch: (key, callback) => {
        let stopped = false;
        let rev: JsonValue | undefined = -1;
        void (async () => {
          while (!stopped && !core.stopped) {
            try {
              const reply = await unwrap(storageCall("watch", { key, sinceRev: rev ?? null }));
              if (stopped) break;
              if (rev !== -1 && reply.rev !== rev) void callback(reply.value);
              rev = reply.rev;
            } catch {
              await sleep(1000);
            }
          }
        })();
        return () => {
          stopped = true;
        };
      },
    },
    notifications: {
      show: async (title, message) => String((await unwrap(notificationsCall("show", { title, message }))).notificationId),
      clear: async (notificationId) => (await unwrap(notificationsCall("clear", { notificationId }))).cleared === true,
    },
    clipboard: {
      writeText: async (text) => {
        await unwrap(clipboardCall({ text }));
      },
    },
    menu: (() => {
      const callbacks = new Map<string, () => void | Promise<void>>();
      let polling = false;
      const poll = async () => {
        while (polling && !core.stopped) {
          try {
            const reply = await unwrap(menuCall("poll"));
            if (reply.active === false) {
              polling = false;
              break;
            }
            const invocation = reply.invocation;
            if (!isJsonObject(invocation)) continue;
            const invocationId = String(invocation.invocationId);
            const callback = callbacks.get(String(invocation.commandId));
            try {
              if (callback) await callback();
            } catch (cause: unknown) {
              report("error", `menu command failed: ${String(cause)}`);
            } finally {
              await unwrap(menuCall("ack", { invocationId }));
            }
          } catch {
            await sleep(1000);
          }
        }
      };
      return {
        register: async (id, label, callback) => {
          requireFunction(callback);
          const reply = await unwrap(menuCall("register", { commandId: id, label }));
          callbacks.set(id, callback);
          if (!polling) {
            polling = true;
            void poll();
          }
          return String(reply.registrationId);
        },
      };
    })(),
    schedule: (() => {
      let consumedHooks: Promise<string[]> | undefined;
      const callbacks = new Map<string, Set<Callback<ScheduleHook>>>();
      const deliveredCallbacks = new WeakSet<Callback<ScheduleHook>>();
      const consume = async (): Promise<string[]> => {
        if (!consumedHooks) {
          consumedHooks = unwrap(scheduleCall("consumeHooks")).then((reply) =>
            Array.isArray(reply.hooks) ? reply.hooks.filter(isString) : [],
          );
        }
        return consumedHooks;
      };
      const deliver = async () => {
        const hooks = await consume();
        for (const [name, registered] of callbacks) {
          for (const callback of registered) {
            if (deliveredCallbacks.has(callback)) continue;
            for (const hook of hooks) if (hook === name) await callback({ name });
            deliveredCallbacks.add(callback);
          }
        }
      };
      const listen = (hookName: string, callback: Callback<ScheduleHook>): Unsubscribe => {
        const set = callbacks.get(hookName) ?? new Set();
        set.add(callback);
        callbacks.set(hookName, set);
        return () => set.delete(callback);
      };
      return {
        register: async (definition) => (await unwrap(scheduleCall("register", { definition }))).schedule,
        at: async (id, at, action) => (await unwrap(scheduleCall("register", { definition: { id, at, action } }))).schedule,
        every: async (id, every, action) =>
          (await unwrap(scheduleCall("register", { definition: { id, every, action } }))).schedule,
        remove: async (scheduleId) => (await unwrap(scheduleCall("remove", { scheduleId }))).cleared === true,
        list: async () => {
          const schedules = (await unwrap(scheduleCall("list"))).schedules;
          return Array.isArray(schedules) ? schedules : [];
        },
        clear: async () => {
          await unwrap(scheduleCall("clear"));
          consumedHooks = Promise.resolve([]);
        },
        onSiteOpen: async (hookName, callback) => {
          await unwrap(scheduleCall("onSiteOpen", { hookName }));
          if (callback !== undefined) {
            const off = listen(hookName, requireFunction(callback));
            await deliver();
            return off;
          }
          return hookName;
        },
        removeOnSiteOpen: async (hookName) => (await unwrap(scheduleCall("removeOnSiteOpen", { hookName }))).cleared === true,
        consumeHooks: async () => [...(await consume())],
        onHook: (hookName, callback) => {
          const off = listen(hookName, requireFunction(callback));
          void deliver().catch((cause: unknown) => report("error", `scheduled hook failed: ${String(cause)}`));
          return off;
        },
      };
    })(),
  };

  Object.defineProperty(globalThis, "rmx", { value: rmx, configurable: true, enumerable: false, writable: false });
  Object.defineProperty(globalThis, "dom", { value: dom, configurable: true, enumerable: false, writable: false });

  // --- the facades: location, navigator, window ---------------------------------

  // Parsed once per URL; every getter reads through it.
  let parsedFor: string | undefined;
  let parsed: URL | null = null;
  const parsedUrl = (): URL | null => {
    if (parsedFor !== facts.url) {
      parsedFor = facts.url;
      try {
        parsed = new URL(facts.url);
      } catch {
        parsed = null;
      }
    }
    return parsed;
  };
  const navigate = (): never => {
    throw new Error(NAVIGATION_MESSAGE);
  };
  const location: LocationFacade = facade<LocationFacade>(
    {
      get href() {
        return parsedUrl()?.href ?? facts.url;
      },
      get origin() {
        return parsedUrl()?.origin ?? "";
      },
      get protocol() {
        return parsedUrl()?.protocol ?? "";
      },
      get host() {
        return parsedUrl()?.host ?? "";
      },
      get hostname() {
        return parsedUrl()?.hostname ?? "";
      },
      get port() {
        return parsedUrl()?.port ?? "";
      },
      get pathname() {
        return parsedUrl()?.pathname ?? "";
      },
      get search() {
        return parsedUrl()?.search ?? "";
      },
      get hash() {
        return parsedUrl()?.hash ?? "";
      },
      assign: navigate,
      replace: navigate,
      reload: navigate,
      toString: () => location.href,
      valueOf: () => location.href,
      toJSON: () => location.href,
    },
    (name) => poisonMessage(`location.${name}`),
    () => NAVIGATION_MESSAGE,
  );

  const own = globalThis.navigator;
  const navigator = facade<NavigatorFacade>(
    {
      language: own.language,
      languages: Object.freeze([...own.languages]),
      userAgent: own.userAgent,
      platform: own.platform,
      hardwareConcurrency: own.hardwareConcurrency,
      onLine: true,
    },
    (name) => poisonMessage(`navigator.${name}`),
    (name) => poisonMessage(`navigator.${name}`),
  );

  const frameScheduler: FrameScheduler = (callback) => window.setTimeout(() => callback(performance.now()), 16);
  const frameCanceller: FrameCanceller = (frame) => window.clearTimeout(frame);
  const windowFacade = facade<WindowFacade>(
    {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      requestAnimationFrame: frameScheduler,
      cancelAnimationFrame: frameCanceller,
      queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
      structuredClone: globalThis.structuredClone.bind(globalThis),
      Intl,
      JSON,
      Math,
      Date,
      Promise,
      console,
      location,
      navigator,
      get innerWidth() {
        return facts.viewport.width;
      },
      get innerHeight() {
        return facts.viewport.height;
      },
      get scrollX() {
        return facts.viewport.scrollX;
      },
      get scrollY() {
        return facts.viewport.scrollY;
      },
      get pageXOffset() {
        return facts.viewport.scrollX;
      },
      get pageYOffset() {
        return facts.viewport.scrollY;
      },
      addEventListener: (type, callback, options) => {
        dom.window.on(type, callback, listenerOptions(options));
      },
      removeEventListener: (type, callback) => dom.window.off(type, callback),
      scrollTo: (x, y, behavior) => dom.scrollTo(x, y, behavior),
      scrollBy: (x, y, behavior) => dom.scrollBy(x, y, behavior),
      rmx,
      dom,
    },
    (name) => poisonMessage(`window.${name}`),
    (name) => poisonMessage(`window.${name}`),
  );

  // --- loading, the readiness wait and the URL gate --------------------------------

  const poisons = new Map<string, Poisoned>();
  const shadowArgs = (): ShadowedGlobal[] =>
    SHADOWED_GLOBALS.map((name) => {
      switch (name) {
        case "requestAnimationFrame":
          return frameScheduler;
        case "cancelAnimationFrame":
          return frameCanceller;
        case "location":
          return location;
        case "navigator":
          return navigator;
        case "window":
        case "self":
        case "globalThis":
        case "top":
        case "parent":
        case "frames":
          return windowFacade;
        default: {
          let value = poisons.get(name);
          if (value === undefined) {
            value = poison(name);
            poisons.set(name, value);
          }
          return value;
        }
      }
    });

  // The most recent uncaught error text, read back when a file's script
  // element loads without registering a function (a parse error surfaces on
  // window, not on the element).
  let lastUncaught = "";
  const onError = (event: ErrorEvent) => {
    lastUncaught = event.message ? String(event.message) : String(event.error ?? "unknown error");
    if (!core.stopped) report("error", `uncaught error: ${lastUncaught}`);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!core.stopped) report("error", `unhandled rejection: ${String(event.reason)}`);
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onRejection);

  const loadFile = (name: string, code: string): Promise<WrappedFile> =>
    new Promise((resolve, reject) => {
      const seq = (loadSeq += 1);
      const source = wrapRemixletFile(seq, name, code);
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const script = document.createElement("script");
      lastUncaught = "";
      const finish = () => {
        URL.revokeObjectURL(url);
        script.remove();
        const fn = loadRegistry.get(seq);
        loadRegistry.delete(seq);
        if (fn) resolve(fn);
        else reject(new Error(lastUncaught ? `${name} did not load: ${lastUncaught}` : `${name} did not load`));
      };
      script.addEventListener("load", finish);
      script.addEventListener("error", finish);
      script.src = url;
      (document.head ?? document.documentElement).append(script);
    });

  let run: BoxRunMessage | undefined;
  let activated = false;
  let filesRunning = false;
  const runFiles = async (): Promise<void> => {
    filesRunning = true;
    try {
      await runFilesUnguarded();
    } finally {
      filesRunning = false;
    }
  };
  const runFilesUnguarded = async (): Promise<void> => {
    if (!run) return;
    // Usage telemetry: one fire-and-forget ping per activation.
    try {
      void send({ kind: "rmx.run" }).catch(() => {});
    } catch {}
    for (const file of run.files) {
      if (core.stopped) return;
      try {
        const fn = await loadFile(file.name, file.code);
        fn.call(undefined, ...shadowArgs());
      } catch (cause: unknown) {
        report("error", `script failed: ${String(cause)}`);
      }
    }
  };
  // --- settle (protocol.ts DomSettleMessage) -----------------------------------
  // Idle means nothing the box could still do on its own: no file running its
  // top-level code, no keep pass running or owed, no callback in flight and no
  // call unanswered. Judged on two consecutive macrotasks, so work a callback
  // queued (a microtask, a call resolving) counts before the answer goes out.
  // Timers the author set are invisible here by design: they are the
  // remixlet's own choice to act later, and the log shows what they do.
  const idle = (): boolean => !filesRunning && !keepPassRunning && !keepPassDirty && !core.busy();
  const settle = async (id: number): Promise<void> => {
    let quiet = 0;
    while (quiet < 2) {
      if (core.stopped) return;
      quiet = idle() ? quiet + 1 : 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!core.stopped) transport.post({ kind: "dom.settled", id });
  };

  // runAt, honoured from the facts' readyState: document_start runs at once,
  // document_end once the DOM is parsed (interactive), document_idle once the
  // page has loaded plus one macrotask, which is when Chrome would have
  // injected an idle content script. The URL gate applies after that.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  const readyFor = (runAt: RunAt): boolean => {
    switch (runAt) {
      case "document_start":
        return true;
      case "document_end":
        return facts.readyState !== "loading";
      case "document_idle":
        return facts.readyState === "complete";
    }
  };
  const tryActivate = (): void => {
    if (activated || !run) return;
    if (!readyFor(run.runAt)) return;
    if (run.runAt === "document_idle" && !idled) {
      if (idleTimer === undefined) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          idled = true;
          tryActivate();
        }, 0);
      }
      return;
    }
    if (!urlMatchesAny(navUrl, run.matches)) return;
    activated = true;
    void runFiles();
  };
  navListeners.add(() => tryActivate());

  // --- inbound -------------------------------------------------------------------

  transport.onMessage((message) => {
    if (core.stopped) return;
    switch (message.kind) {
      case "box.run":
        if (run) {
          report("warn", "box.run received twice; the second is ignored", false);
          return;
        }
        run = message;
        remixletId = String(message.remixletId);
        if (navUrl === "") navUrl = message.url;
        if (!factsReceived) facts = placeholderFacts(navUrl);
        tryActivate();
        return;
      case "rmx.result":
        // SAFETY: the reply is the worker's BridgeReply, JSON that crossed runtime messaging and the host.
        core.handleRmxResult(message.id, message.reply as BridgeReply);
        return;
      case "dom.result":
        core.handleDomResult(message);
        return;
      case "dom.event":
        core.handleDomEvent(message);
        return;
      case "dom.mutated":
        core.handleMutated(message);
        return;
      case "dom.stale":
        onStale(message);
        return;
      case "dom.notice":
        // The agent's observer-budget verdicts (feedback loop, busy-page
        // throttle) go to the script log at the agent's level, where the
        // verification gate and read_remixlet_logs find them.
        core.report(message.level, message.message, message.level !== "info");
        return;
      case "dom.settle":
        void settle(message.id);
        return;
      case "relay.message":
        dispatchRelay(message);
        return;
      case "page.navigation":
        navCheck(message.url);
        return;
      case "page.facts":
        facts = message.facts;
        factsReceived = true;
        navCheck(message.facts.url);
        tryActivate();
        return;
    }
  });

  transport.post({ kind: "box.ready" });

  return {
    rmx,
    dom,
    stop: () => {
      core.stop();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      globalThis.removeEventListener("error", onError);
      globalThis.removeEventListener("unhandledrejection", onRejection);
    },
  };
}
