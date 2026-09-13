// The structured probe templates (wiki/raw/handoffs/structured-page-probes.md).
// They ship as ordinary bundled code: probes.js carries them into the tab's
// ISOLATED world (probes-entry.ts, runner.ts) and page-state.js carries
// read_page_state into the MAIN world (page-state-entry.ts), both injected by
// the worker engine through scripting.executeScript. Model input reaches a
// template only as the `params` VALUE, passed through executeScript's `args`;
// nothing here may build code from a parameter, and the extension CSP these
// worlds run under refuses eval, Function and string timers anyway.
//
// The ISOLATED world is the content-script world, so MAIN-world getters/proxies
// a page defines are not visible here: these structured DOM reads are
// side-effect-free by construction. Keep it that way — e.g. never call
// canvas.getContext() (it can CREATE a context) to sniff canvas type. The
// sanctioned exceptions are click_element, whose entire purpose is the side
// effect (dispatching a click so interactive behavior is verifiable), and
// locate_for_review, which scrolls an off-screen element into view so it can
// be photographed; every other template stays read-only.

import type {
  AssertPageStateParamsType,
  ClickElementParamsType,
  InspectDesignParamsType,
  InspectElementParamsType,
  ListNetworkResourcesParamsType,
  LocateForReviewParamsType,
  ObserveNetworkBodiesParamsType,
  ProbeName,
  QueryElementsParamsType,
  ReadPageStateParamsType,
  ReadStructuredDataParamsType,
  ReplayNetworkResourceParamsType,
  SearchElementsParamsType,
} from "../../shared/probe-schemas.js";
import { currentPageLoadToken } from "../../shared/network-ids.js";
import { isSensitiveField, markupWithoutSecrets } from "../../shared/sensitive-fields.js";
// The box's click rule, shared verbatim with remixlet code's dom.click():
// policy.ts is pure (no chrome.*, no DOM global at import time), so the
// ISOLATED-world probe bundle can carry it.
import { clickDecision, pageResourceUrls, type UrlContext } from "../../box/policy.js";

type ProbePrimitive = string | number | boolean | null | undefined;
type ProbeValue = ProbePrimitive | ProbeObject | ProbeValue[];

interface ProbeObject {
  [key: string]: ProbeValue;
}

type PagePrimitive = ProbePrimitive;
type PageValue = PagePrimitive | PageObject | PageValue[] | Node | Function;
interface PageObject {
  [key: string]: PageValue | undefined;
}

interface SerializedProbeValue {
  value: ProbeValue;
  truncated: boolean;
}

/** What every template answers with: a JSON-shaped record the runner serialises. */
export interface ProbeResult extends ProbeObject {}

interface AssertionOutcome {
  pass: boolean;
  actual: string;
}

interface ObserverReply {
  total?: PageValue;
  matched?: PageValue;
  entries?: PageValue;
  recorded?: PageValue;
}

interface ObserverEntry {
  seq?: PageValue;
  url?: PageValue;
  method?: PageValue;
  status?: PageValue;
  contentType?: PageValue;
  body?: PageValue;
  truncated?: PageValue;
}

interface InlineStateEntry extends ProbeObject {
  kind: "json-script" | "hydration";
  id?: string;
  global?: string;
  data: ProbeValue;
}

/*
 * Chrome's default resource-timing buffer holds 250 entries; WHEN IT FILLS,
 * NEW REQUESTS STOP BEING RECORDED (wiki/raw/handoffs/network-data-visibility.md
 * §Layer 2). There is no API to read the configured limit, so saturation is
 * reported as a >=-default heuristic — enough for the agent to know the list
 * may be incomplete and escalate instead of concluding "no such request".
 */
const RESOURCE_TIMING_DEFAULT_BUFFER = 250;

/**
 * Globals read_page_state never resolves and searchJson never walks: storage
 * and credential roots hold session tokens, not page UI state, and the
 * structured lane needs no approval (C3).
 */
const DENIED_STATE_ROOTS = ["localStorage", "sessionStorage", "cookieStore", "indexedDB", "caches", "credentials"];

export interface ProbeSearchHit extends ProbeObject {
  path: string;
  value: string;
  siblings?: string[];
  /**
   * Scalar values of the matched record's sibling keys. Without these the
   * agent can see that a field EXISTS next to its anchor but never what it
   * says — the Spotify album-label session saw `label` as a sibling name,
   * could not read it, guessed "VRS", and asserted the guess (wiki/raw/handoffs/
   * 2026-08-19-first-time-pass-observer-and-network-truth.md §5).
   */
  siblingValues?: Record<string, string>;
}

export interface ProbeHelpers {
  capString(value: string, max: number): string;
  /** Paths whose leaf values match the needle — see SearchNeedle in probe-schemas. */
  searchJson(root: PageValue, needle: string | number): ProbeSearchHit[];
  /** Depth/size-capped JSON projection of an arbitrary in-page value. */
  serializeCapped(root: PageValue, maxDepth: number, maxBytes: number): SerializedProbeValue;
  /**
   * querySelectorAll that also traverses OPEN shadow roots (light-DOM matches
   * first, then each host's shadow content in tree order). Sites built on web
   * components render real content inside open shadow roots, so without this
   * the agent's probes could not see — or verify — that content at all.
   * Closed roots remain invisible, correctly. Throws on invalid selectors
   * exactly like querySelectorAll (the hostile-param invariant depends on it).
   */
  queryAllDeep(selector: string): Element[];
  /**
   * Best-effort stable selector for one element, scoped to the element's own
   * root (document or open shadow root — a document-level selector cannot
   * reach shadow content, but queryAllDeep evaluates selectors inside every
   * open root, so a root-scoped candidate stays usable by the other probes).
   * Mirrors shared/stable-selector.ts (the annotate overlay's generator) with
   * the same preference order — unique id → semantic attribute → short
   * ancestor path with :nth-of-type tiebreaks — duplicated from the days when
   * probe code crossed into the page as fn.toString() text and could import
   * nothing; merging the two is still open, so keep them in sync. Candidates
   * are re-verified by the agent with query_elements before anything is built
   * on them.
   */
  stableSelectorFor(element: Element): string;
  /**
   * Approximate registrable domain (eTLD+1) of a hostname: "api-v2.soundcloud.com"
   * → "soundcloud.com". Public-suffix awareness is a heuristic (short second
   * label under a 2-letter country TLD counts as suffix, so "www.bbc.co.uk" →
   * "bbc.co.uk"); callers treat the answer as a RANKING signal, never a filter.
   */
  registrableDomain(host: string): string;
  /**
   * Deterministic resource classification for the network probes and the
   * capture's census (wiki/design/network-probes.md): "data" is a JSON or
   * XML response from any initiator, or a fetch/XHR response whose content
   * type is text or not exposed; a fetch/XHR of an image, font, media or
   * script is an "asset" like the tag-loaded kind; HTML and frames are
   * "document"; beacons and pings stay "other". contentType may be ""
   * cross-origin without Timing-Allow-Origin, in which case the initiator
   * decides.
   */
  classifyNetworkResource(url: string, initiatorType: string, contentType: string): "data" | "document" | "asset" | "other";
  /**
   * The token naming this page load (shared/network-ids.ts): minted in this
   * world on first use, the same value the capture's snapshot reads, gone
   * when the document goes. Every network id is recorded against it.
   */
  pageLoadToken(): string;
  /**
   * Host and path shape of a request URL: volatile path segments collapse
   * (digits to :n, UUIDs to :uuid, long digit-bearing tokens to :id) and the
   * query keeps its parameter names only, so repeated calls to one API share
   * a shape and no query value ever reaches the model.
   */
  endpointOf(url: string): NetworkEndpoint;
  /**
   * Compact type outline of a parsed JSON value: field names with value TYPES,
   * arrays merged across sampled elements ("key?" = missing from some). Exists
   * so the agent learns real field names/shapes (duration: number) instead of
   * guessing search strings from rendered text ("59:56" never matches JSON —
   * the soundcloud mix-filter session died on exactly that).
   */
  outlineJson(root: PageValue, maxBytes: number): string;
  /**
   * The labelled item a form control belongs to (wiki/design/inspect-probes.md):
   * for an input/select/textarea inside a <label>, that label; for one named
   * by label[for], the nearest ancestor (within four hops) that holds both the
   * control and its label. null for anything else. The inspect probes read
   * the item in place of the control: the item carries the classes the site's
   * CSS keys its states on and the markup around the control, which a hidden
   * input never does (the SoundCloud toggle case).
   */
  labelledItemOf(element: Element): LabelledItem | null;
}

export interface LabelledItem {
  item: Element;
  control: Element;
  via: "enclosing-label" | "label-for";
}

/** A request URL as the model sees it: host, path pattern with query names, and the pattern alone (the group key). */
export interface NetworkEndpoint {
  host: string;
  path: string;
  pattern: string;
  names: string[];
}

/** A stylesheet the worker fetched for the probe: href from document.styleSheets, body never shown to the model. */
export interface FetchedProbeStylesheet {
  href: string;
  text: string;
}

/**
 * inspect_design's page-side params: the model's schema plus the sheets the
 * worker fetched between rounds (worker/page-probes/stylesheets.ts). The
 * worker always sets fetchedSheets itself, so nothing model-supplied lands
 * here.
 */
export interface InspectDesignProbeParams extends InspectDesignParamsType {
  fetchedSheets?: FetchedProbeStylesheet[];
}

/**
 * Shared page-side utilities, built fresh for each run and passed as the
 * template's second argument. Takes NO model input — the needle/limits arrive
 * through the template's params.
 */
export function probeHelpers(): ProbeHelpers {
  const capString = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
  const typeTag = (value: PageValue): string => Object.prototype.toString.call(value);
  const isText = (value: PageValue): value is string => typeTag(value) === "[object String]";
  const isNumeric = (value: PageValue): value is number => typeTag(value) === "[object Number]";
  const isLogical = (value: PageValue): value is boolean => typeTag(value) === "[object Boolean]";
  const isPlain = (value: PageValue): value is PageObject | PageValue[] =>
    value !== null &&
    value !== undefined &&
    !isText(value) &&
    !isNumeric(value) &&
    !isLogical(value) &&
    !(value instanceof Node) &&
    !(value instanceof Function);
  const leafString = (value: PageValue): string => {
    if (isText(value)) return capString(value, 120);
    if (value instanceof Function) return "[Function]";
    if (value instanceof Node) {
      const tag = value instanceof Element ? value.tagName.toLowerCase() : "node";
      return `[DOM <${tag}>]`;
    }
    try {
      return capString(String(JSON.stringify(value) ?? value), 120);
    } catch {
      return "[unserializable]";
    }
  };
  const isNeedleNumber = (value: string | number): value is number => Object.prototype.toString.call(value) === "[object Number]";
  const matches = (value: PageValue, needle: string | number): boolean => {
    if (isNeedleNumber(needle)) {
      if (isNumeric(value)) {
        // Seconds↔milliseconds tolerance: 623 matches 623000 and vice versa.
        return value === needle || value === needle * 1000 || value * 1000 === needle;
      }
      return isText(value) && value.trim() === String(needle);
    }
    if (isText(value)) return value.toLowerCase().includes(needle.toLowerCase());
    if (isNumeric(value) || isLogical(value)) return String(value) === needle;
    return false;
  };
  const searchJson = (root: PageValue, needle: string | number): ProbeSearchHit[] => {
    // Storage/credential roots are never walked, even when a search reaches one
    // as a nested key (C3).
    const DENIED_KEYS = DENIED_STATE_ROOTS;
    const hits: ProbeSearchHit[] = [];
    const seen = new Set<PageValue>();
    let budget = 50_000;
    const walk = (value: PageValue, path: string, parent: PageValue, depth: number): void => {
      if (hits.length >= 20 || budget-- <= 0 || depth > 12) return;
      if (matches(value, needle)) {
        const hit: ProbeSearchHit = { path: path || "(root)", value: leafString(value) };
        if (isPlain(parent) && !Array.isArray(parent)) {
          const keys = Object.keys(parent).slice(0, 8);
          hit.siblings = keys;
          // Scalar sibling VALUES ride along so the record around the anchor
          // is readable, not just its key names — an agent that can see
          // `label: "Virus Recordings"` next to its anchor never has to guess.
          const siblingValues: Record<string, string> = {};
          for (const key of keys) {
            const sibling = parent[key];
            if (sibling === null || isText(sibling) || isNumeric(sibling) || isLogical(sibling)) {
              siblingValues[key] = leafString(sibling);
            }
          }
          if (Object.keys(siblingValues).length > 0) hit.siblingValues = siblingValues;
        }
        hits.push(hit);
        return;
      }
      if (!isPlain(value) || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 500; index += 1) {
          walk(value[index], `${path}[${index}]`, value, depth + 1);
        }
        return;
      }
      for (const key of Object.keys(value)) {
        if (DENIED_KEYS.includes(key)) continue;
        walk(value[key], path ? `${path}.${key}` : key, value, depth + 1);
      }
    };
    walk(root, "", undefined, 0);
    return hits;
  };
  const serializeCapped = (root: PageValue, maxDepth: number, maxBytes: number): SerializedProbeValue => {
    const seen = new Set<PageValue>();
    let spent = 0;
    let truncated = false;
    const spend = (chars: number): boolean => {
      spent += chars;
      if (spent > maxBytes) {
        truncated = true;
        return false;
      }
      return true;
    };
    const project = (value: PageValue, depth: number): ProbeValue => {
      if (value === null || isNumeric(value) || isLogical(value) || value === undefined) {
        spend(8);
        return value === undefined ? "[undefined]" : value;
      }
      if (isText(value)) {
        const capped = capString(value, 200);
        spend(capped.length);
        return capped;
      }
      if (value instanceof Function) {
        spend(10);
        return "[Function]";
      }
      if (value instanceof Node) {
        spend(10);
        const tag = value instanceof Element ? value.tagName.toLowerCase() : "node";
        return `[DOM <${tag}>]`;
      }
      if (seen.has(value)) return "[Circular]";
      if (depth >= maxDepth) {
        truncated = true;
        return Array.isArray(value) ? `[Array(${value.length})]` : `[Object: ${Object.keys(value).slice(0, 8).join(", ")}]`;
      }
      if (!spend(2)) return "[truncated]";
      seen.add(value);
      if (Array.isArray(value)) {
        const out: ProbeValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (index >= 30 || spent > maxBytes) {
            truncated = true;
            out.push(`[…${value.length - index} more]`);
            break;
          }
          out.push(project(value[index], depth + 1));
        }
        seen.delete(value);
        return out;
      }
      const out: ProbeObject = {};
      const keys = Object.keys(value);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        if (index >= 50 || spent > maxBytes) {
          truncated = true;
          out["…"] = `${keys.length - index} more keys`;
          break;
        }
        spend(key.length);
        out[key] = project(value[key], depth + 1);
      }
      seen.delete(value);
      return out;
    };
    return { value: project(root, 0), truncated };
  };
  const queryAllDeep = (selector: string): Element[] => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      // Invalid selectors must throw here, on the first (document) root — the
      // hostile-param invariant treats that SyntaxError as the probe's answer.
      for (const element of Array.from(root.querySelectorAll(selector))) found.push(element);
      for (const host of Array.from(root.querySelectorAll("*"))) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(document);
    return found;
  };
  const stableSelectorFor = (element: Element): string => {
    // SAFETY: getRootNode always yields a Document or ShadowRoot for an Element.
    const root = element.getRootNode() as Document | ShadowRoot;
    const esc = (value: string): string =>
      globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    const unique = (selector: string): boolean => {
      try {
        const matched = root.querySelectorAll(selector);
        return matched.length === 1 && matched[0] === element;
      } catch {
        return false;
      }
    };
    // Durability tier of a page identifier: 0 human-named, 1 machine-ish,
    // 2 hash/uuid/counter-shaped (won't survive a reload). Self-contained twin
    // of shared/selector-durability.ts — keep the rules in sync.
    const tierOf = (value: string): number => {
      if (value.length === 0) return 2;
      if (/\d{5,}/.test(value)) return 2;
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return 2;
      if (/:/.test(value)) return 2;
      if (/-_|_-/.test(value)) return 2;
      const tokens = value.split(/[-_.:\s]+/);
      const hashy = tokens.some(
        (token) =>
          token.length >= 5 &&
          /\d/.test(token) &&
          /[A-Za-z]/.test(token) &&
          (/[A-Za-z]\d+[A-Za-z]/.test(token) || /^\d/.test(token)),
      );
      if (hashy) return 2;
      if (/\d{3,4}/.test(value)) return 1;
      if (tokens.some((token) => token.length >= 24)) return 1;
      return 0;
    };
    // Preference ladder (mirrors shared/stable-selector.ts): a human-named id
    // or semantic attribute wins outright; lower-tier candidates are kept and
    // only handed out when the class path below can't do better.
    const byId = element.id && unique(`#${esc(element.id)}`) ? `#${esc(element.id)}` : "";
    if (byId && tierOf(element.id) === 0) return byId;
    let fallbackAttr = "";
    let fallbackAttrTier = 3;
    // "title" joins the overlay generator's list: titled iframes are how
    // embedded sections are found (the frame-inventory handoff's case).
    for (const name of ["data-testid", "data-test", "data-qa", "name", "aria-label", "role", "title"]) {
      const value = element.getAttribute(name);
      if (value && value.length <= 64) {
        const byAttr = `${element.tagName.toLowerCase()}[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
        if (unique(byAttr)) {
          const tier = tierOf(value);
          if (tier === 0) return byAttr;
          if (tier < fallbackAttrTier) {
            fallbackAttr = byAttr;
            fallbackAttrTier = tier;
          }
        }
      }
    }
    const stableClass = (name: string): boolean => name.length <= 24 && tierOf(name) === 0;
    const segmentFor = (target: Element) => {
      const tag = target.tagName.toLowerCase();
      const classes = Array.from(target.classList).filter(stableClass).slice(0, 2);
      let segment = tag + classes.map((name) => `.${esc(name)}`).join("");
      const parent = target.parentElement;
      if (!parent) return { segment, tier: 0 };
      let peers: Element[];
      try {
        peers = Array.from(parent.children).filter((sibling) => sibling.matches(segment));
      } catch {
        peers = Array.from(parent.children).filter((sibling) => sibling.tagName === target.tagName);
      }
      if (peers.length > 1) {
        const sameTag = Array.from(parent.children).filter((sibling) => sibling.tagName === target.tagName);
        // Positional segments survive some reloads but not reorders — machine-ish.
        return { segment: `${tag}:nth-of-type(${sameTag.indexOf(target) + 1})`, tier: 1 };
      }
      return { segment, tier: 0 };
    };
    const segments: string[] = [];
    let pathTier = 0;
    let fallbackPath = "";
    let fallbackPathTier = 3;
    let current: Element | null = element;
    while (current && segments.length < 5) {
      const part = segmentFor(current);
      segments.unshift(part.segment);
      pathTier = Math.max(pathTier, part.tier);
      const selector = segments.join(" > ");
      if (unique(selector)) {
        if (pathTier === 0) return selector;
        if (pathTier < fallbackPathTier) {
          fallbackPath = selector;
          fallbackPathTier = pathTier;
        }
      }
      const parent: Element | null = current.parentElement;
      if (parent?.id) {
        const anchored = `#${esc(parent.id)} > ${segments.join(" > ")}`;
        if (unique(anchored)) {
          const anchoredTier = Math.max(pathTier, tierOf(parent.id));
          if (anchoredTier === 0) return anchored;
          if (anchoredTier < fallbackPathTier) {
            fallbackPath = anchored;
            fallbackPathTier = anchoredTier;
          }
        }
      }
      current = parent;
    }
    // Nothing stable matched uniquely: least-volatile unique handle first,
    // then the best-effort (possibly non-unique) path.
    for (let tier = 1; tier <= 2; tier += 1) {
      if (byId && tierOf(element.id) === tier) return byId;
      if (fallbackAttr && fallbackAttrTier === tier) return fallbackAttr;
      if (fallbackPath && fallbackPathTier === tier) return fallbackPath;
    }
    return fallbackPath || segments.join(" > ");
  };
  const registrableDomain = (host: string): string => {
    // IP literals (and IPv6 with colons) have no registrable domain — compare whole.
    if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
    const labels = host.toLowerCase().split(".").filter((label) => label.length > 0);
    if (labels.length <= 2) return labels.join(".");
    const last = labels[labels.length - 1]!;
    const second = labels[labels.length - 2]!;
    // Two-part public-suffix heuristic: "co.uk"-shaped tails (a short generic
    // second label under a 2-letter country TLD) keep three labels.
    const generic = ["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go"];
    const twoPartSuffix = last.length === 2 && second.length <= 3 && generic.includes(second);
    return labels.slice(twoPartSuffix ? -3 : -2).join(".");
  };
  const classifyNetworkResource = (url: string, initiatorType: string, contentType: string): "data" | "document" | "asset" | "other" => {
    if (url.slice(0, 5) === "data:") return "asset";
    const type = contentType.toLowerCase();
    if (type.includes("json") || type.includes("xml")) return "data";
    if (initiatorType === "fetch" || initiatorType === "xmlhttprequest") {
      // The page's own code asked for it. Text, or a type the browser does
      // not expose, is data; a fetched image, font, media file or script is
      // an asset like the tag-loaded kind.
      if (type.length === 0) return "data";
      if (type.slice(0, 5) === "text/" && !type.includes("css") && !type.includes("javascript")) return "data";
      return "asset";
    }
    if (type.includes("html") || initiatorType === "iframe" || initiatorType === "frame") return "document";
    if (type.length > 0) return "asset";
    if (["script", "link", "css", "img", "image", "font", "video", "audio", "track", "embed", "object", "input", "use"].includes(initiatorType)) {
      return "asset";
    }
    return "other";
  };
  const pageLoadToken = (): string => currentPageLoadToken();
  const endpointOf = (rawUrl: string): NetworkEndpoint => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { host: "(unparseable)", path: "(unparseable)", pattern: "(unparseable)", names: [] };
    }
    const pattern = url.pathname
      .split("/")
      .map((segment) => {
        if (/^\d+$/.test(segment)) return ":n";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":uuid";
        if (segment.length >= 16 && /\d/.test(segment) && /^[\w.~%-]+$/.test(segment)) return ":id";
        return segment;
      })
      .join("/");
    const names = Array.from(new Set(Array.from(url.searchParams.keys()))).sort();
    const path = capString(names.length > 0 ? `${pattern}?${names.join(",")}` : pattern, 200);
    return { host: url.hostname, path, pattern, names };
  };
  const outlineJson = (root: PageValue, maxBytes: number): string => {
    let spent = 0;
    const isPlainObject = (value: PageValue): value is PageObject => isPlain(value) && !Array.isArray(value);
    const outline = (value: PageValue, depth: number): string => {
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (isText(value)) return "string";
      if (isNumeric(value)) return "number";
      if (isLogical(value)) return "boolean";
      if (Array.isArray(value)) {
        if (value.length === 0) return "Array(0)";
        if (depth >= 5 || spent > maxBytes) return `Array(${value.length})`;
        const sample = value.slice(0, 8);
        if (sample.every(isPlainObject)) {
          // Merge sampled elements: key union with the first-seen value's
          // outline; "?" marks keys absent from some sampled element.
          const counts = new Map<string, { count: number; first: PageValue }>();
          for (const element of sample) {
            for (const key of Object.keys(element)) {
              const entry = counts.get(key);
              if (entry) entry.count += 1;
              else counts.set(key, { count: 1, first: element[key] });
            }
          }
          const merged: PageObject = {};
          for (const [key, entry] of counts) merged[`${key}${entry.count < sample.length ? "?" : ""}`] = entry.first;
          return `Array(${value.length}) of ${outline(merged, depth + 1)}`;
        }
        const kinds = new Set(sample.map((element) => outline(element, depth + 1)));
        return `Array(${value.length}) of ${kinds.size === 1 ? [...kinds][0] : "mixed"}`;
      }
      if (!isPlainObject(value)) return "unknown";
      const keys = Object.keys(value);
      if (depth >= 5) return `{…${keys.length} keys}`;
      const parts: string[] = [];
      let index = 0;
      for (; index < keys.length; index += 1) {
        if (index >= 24 || spent > maxBytes) break;
        const key = keys[index]!;
        const part = `${key}: ${outline(value[key], depth + 1)}`;
        spent += part.length + 2;
        parts.push(part);
      }
      const rest = keys.length - index;
      return `{${parts.join(", ")}${rest > 0 ? `, …+${rest} more keys` : ""}}`;
    };
    const rendered = outline(root, 0);
    return rendered.length > maxBytes ? `${rendered.slice(0, maxBytes)}…` : rendered;
  };
  const labelledItemOf = (element: Element): LabelledItem | null => {
    if (!element.matches("input, select, textarea")) return null;
    const enclosing = element.closest("label");
    if (enclosing) return { item: enclosing, control: element, via: "enclosing-label" };
    // SAFETY: the matches() guard above admits only input/select/textarea, and all three expose the labels list.
    const labels = (element as HTMLInputElement).labels;
    const label = labels && labels.length > 0 ? labels[0] : null;
    if (!label) return null;
    let ancestor = element.parentElement;
    for (let hops = 0; hops < 4 && ancestor; hops += 1) {
      if (ancestor === document.body || ancestor === document.documentElement) break;
      if (ancestor.contains(label)) return { item: ancestor, control: element, via: "label-for" };
      ancestor = ancestor.parentElement;
    }
    return null;
  };
  return {
    capString,
    searchJson,
    serializeCapped,
    queryAllDeep,
    stableSelectorFor,
    registrableDomain,
    classifyNetworkResource,
    pageLoadToken,
    endpointOf,
    outlineJson,
    labelledItemOf,
  };
}

export function queryElementsProbe(params: QueryElementsParamsType, helpers: ProbeHelpers): ProbeResult {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  // Pagination over a LIVE collection: the DOM can mutate between calls, so
  // pages may skip or repeat entries — total rides on every reply so the
  // model can see the collection shift.
  const offset = Math.min(Math.max(params.offset ?? 0, 0), 5000);
  const fields = params.fields ?? ["tag", "text", "attributes"];
  const cap = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
  const matches = helpers.queryAllDeep(params.selector);
  const elements = matches.slice(offset, offset + limit).map((element) => {
    const out: ProbeObject = {};
    if (fields.includes("tag")) out.tag = element.tagName.toLowerCase();
    if (fields.includes("text")) out.text = cap((element.textContent ?? "").replace(/\s+/g, " ").trim(), 500);
    if (fields.includes("attributes")) {
      // A password field's value never reaches the model (shared/sensitive-fields.ts).
      const secret = isSensitiveField(element);
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        attributes[attribute.name] = secret && attribute.name.toLowerCase() === "value" ? "" : cap(attribute.value, 200);
      }
      out.attributes = attributes;
    }
    if (fields.includes("dataset")) {
      const dataset: Record<string, string> = {};
      const source = element instanceof HTMLElement ? element.dataset : {};
      for (const key of Object.keys(source)) dataset[key] = cap(source[key] ?? "", 200);
      out.dataset = dataset;
    }
    if (fields.includes("rect")) {
      const rect = element.getBoundingClientRect();
      out.rect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }
    if (fields.includes("visible")) {
      if (element.checkVisibility) {
        out.visible = element.checkVisibility();
      } else {
        const rect = element.getBoundingClientRect();
        out.visible = rect.width > 0 && rect.height > 0;
      }
    }
    return out;
  });
  return { total: matches.length, offset, elements, truncated: matches.length > offset + limit };
}

/**
 * The text→selector direction the other probes lack: query_elements answers
 * "what matches this selector", this answers "WHERE does this text live" when
 * the agent has no selector yet. The capture's DOM slice is capped
 * (shared/capture-format.ts DEFAULT_FORMAT_CAPS), so on large pages the
 * target routinely sits past the cut and the failure mode is serial selector
 * guessing (wiki/raw/handoffs/2026-08-10-early-scoping-and-frame-inventory.md:
 * nine probe rounds to find a titled iframe). One needle search replaces that.
 *
 * Matching: every attribute value, plus each element's OWN text nodes — the
 * deepest holder of the text, so ancestors of a match do not drown the list.
 * Text split across inline children is not matched (the attribute channel
 * usually covers those targets); script/style text is read_structured_data's
 * lane. Needles are data — same injection invariant as every template.
 */
export function searchElementsProbe(params: SearchElementsParamsType, helpers: ProbeHelpers): ProbeResult {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);
  const needle = params.text.toLowerCase();
  const BUDGET = 50_000;
  const hits: ProbeObject[] = [];
  let total = 0;
  let visited = 0;
  let budgetExhausted = false;
  const ancestryOf = (element: Element): string => {
    const parts: string[] = [];
    let current = element.parentElement;
    while (current && current !== document.documentElement && parts.length < 4) {
      const id = current.id ? `#${current.id}` : "";
      const firstClass = Array.from(current.classList)[0];
      const cls = !id && firstClass !== undefined ? `.${firstClass}` : "";
      parts.unshift(`${current.tagName.toLowerCase()}${id}${cls}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const record = (element: Element, matchedOn: string, value: string): void => {
    total += 1;
    if (hits.length >= limit) return;
    const rect = element.getBoundingClientRect();
    let visible: boolean;
    if (element.checkVisibility) {
      visible = element.checkVisibility();
    } else {
      visible = rect.width > 0 && rect.height > 0;
    }
    const selector = helpers.stableSelectorFor(element);
    // SAFETY: getRootNode always yields a Document or ShadowRoot for an Element.
    const root = element.getRootNode() as Document | ShadowRoot;
    let selectorMatches = 0;
    try {
      selectorMatches = root.querySelectorAll(selector).length;
    } catch {
      selectorMatches = 0;
    }
    const hit: ProbeObject = {
      tag: element.tagName.toLowerCase(),
      matchedOn,
      value: helpers.capString(value.replace(/\s+/g, " ").trim(), 120),
      selector,
      selectorMatches,
      visible,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      ancestry: ancestryOf(element),
    };
    const isShadow = root instanceof ShadowRoot;
    if (isShadow) {
      hit.inShadowRoot = true;
      hit.hostSelector = helpers.stableSelectorFor(root.host);
    }
    hits.push(hit);
  };
  const walk = (element: Element): void => {
    visited += 1;
    if (visited > BUDGET) {
      budgetExhausted = true;
      return;
    }
    let recorded = false;
    // A password field's value is never searched or reported, so a needle
    // cannot be used to read one back a character at a time.
    const secret = isSensitiveField(element);
    for (const attribute of Array.from(element.attributes)) {
      if (secret && attribute.name.toLowerCase() === "value") continue;
      if (attribute.value.toLowerCase().includes(needle)) {
        record(element, `attribute:${attribute.name}`, attribute.value);
        recorded = true;
        break;
      }
    }
    const tag = element.tagName;
    if (!recorded && tag !== "SCRIPT" && tag !== "STYLE" && tag !== "NOSCRIPT") {
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === 3 && (node.nodeValue ?? "").toLowerCase().includes(needle)) {
          record(element, "text", element.textContent ?? "");
          break;
        }
      }
    }
    for (const child of Array.from(element.children)) {
      if (budgetExhausted) return;
      walk(child);
    }
    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.children)) {
        if (budgetExhausted) return;
        walk(child);
      }
    }
  };
  walk(document.documentElement);
  const result: ProbeObject = {
    total,
    returned: hits.length,
    truncated: total > hits.length,
    searchedElements: visited,
    matches: hits,
  };
  if (budgetExhausted) result.budgetExhausted = true;
  return result;
}

export function inspectElementProbe(params: InspectElementParamsType, helpers: ProbeHelpers): ProbeResult {
  const index = params.index ?? 0;
  const matches = helpers.queryAllDeep(params.selector);
  const matched = matches[index];
  if (!matched) return { found: false, total: matches.length };
  // A form control inside its label is read as the label's item: the item
  // carries the classes and the neighbouring markup the control lacks.
  const labelled = helpers.labelledItemOf(matched);
  const element = labelled ? labelled.item : matched;
  const describe = (target: Element): ProbeObject => {
    const summary: ProbeObject = { tag: target.tagName.toLowerCase(), classes: Array.from(target.classList) };
    if (target.id) summary.id = target.id;
    return summary;
  };
  const capHtml = (html: string): [string, boolean] => [html.length > 8192 ? `${html.slice(0, 8192)}…` : html, html.length > 8192];
  const rect = element.getBoundingClientRect();
  const outerHtml = markupWithoutSecrets(element, "outer");
  const isIframe = element instanceof HTMLIFrameElement;
  // Cross-origin frame content is unreachable: contentDocument is null (or
  // access throws in some engines). Either way the flag reads true.
  let crossOriginFrame = false;
  if (isIframe) {
    try {
      crossOriginFrame = element.contentDocument === null;
    } catch {
      crossOriginFrame = true;
    }
  }
  const [cappedHtml, htmlTruncated] = capHtml(outerHtml);
  const result: ProbeResult = {
    found: true,
    total: matches.length,
    tag: element.tagName.toLowerCase(),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    // A CLOSED shadow root is indistinguishable from none from out here; the
    // tool description documents that missing expected children in
    // query_elements remains the tell.
    shadowRoot: element.shadowRoot ? "open" : "none",
    isCanvas: element instanceof HTMLCanvasElement,
    isIframe,
    crossOriginFrame,
    outerHtml: cappedHtml,
    outerHtmlTruncated: htmlTruncated,
  };
  if (labelled) {
    result.redirected = {
      from: describe(labelled.control),
      to: describe(element),
      reason:
        labelled.via === "enclosing-label"
          ? "the matched control sits inside this label; the label is the item the page styles and the exemplar to copy"
          : "the matched control is named by a label[for]; this is the nearest element holding both, the item to copy",
    };
    // The item's siblings inside the nearest container: the text label next
    // to a switch, its spacing classes, the wrapper the site lays them out in.
    const container = element.parentElement;
    if (container && container !== document.body && container !== document.documentElement) {
      const [containerHtml, containerTruncated] = capHtml(markupWithoutSecrets(container, "outer"));
      result.container = { ...describe(container), outerHtml: containerHtml, outerHtmlTruncated: containerTruncated };
    }
  }
  return result;
}

/**
 * The design-context read behind the prompt's "design before you build" step:
 * one call answers both "what does this page's own control look like" (curated
 * computed-style digest + the design tokens in scope) and "does my control
 * have room here" (element/parent/sibling geometry).
 *
 * With "properties" it is instead the targeted verification read (the job the
 * retired get_computed_style tool did): exactly those computed values, from
 * the element or its ::before/::after pseudo-element, no digest work.
 */
export function inspectDesignProbe(params: InspectDesignProbeParams, helpers: ProbeHelpers): ProbeResult {
  const index = params.index ?? 0;
  const ancestorCount = Math.min(Math.max(params.ancestors ?? 2, 0), 5);
  const cap = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
  const roundRect = (rect: DOMRect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  const matches = helpers.queryAllDeep(params.selector);
  const matched = matches[index];
  if (!matched) return { found: false, total: matches.length };
  if (params.properties) {
    // The targeted read is exact by design: it reads the element asked for,
    // never a redirected one.
    const style = getComputedStyle(matched, params.pseudoElement ?? null);
    const values: Record<string, string> = {};
    for (const property of params.properties.slice(0, 50)) values[property] = style.getPropertyValue(property);
    const targeted: ProbeResult = { found: true, total: matches.length, tag: matched.tagName.toLowerCase(), values };
    if (params.pseudoElement) targeted.pseudoElement = params.pseudoElement;
    return targeted;
  }
  // The digest reads the labelled item, not the control inside it: the item
  // is what the page paints and what its state classes land on.
  const labelled = helpers.labelledItemOf(matched);
  const element = labelled ? labelled.item : matched;
  // Values at their initial defaults carry no design information; omitting
  // them keeps the digest dense enough to read at a glance.
  const isTrivial = (value: string): boolean => {
    if (value === "" || value === "none" || value === "normal" || value === "auto" || value === "0px") return true;
    if (value === "rgba(0, 0, 0, 0)") return true;
    if (/\b0px\b/.test(value) && /\bnone\b/.test(value)) return true;
    if (/^(all|none) 0s ease(-in-out)? 0s$/.test(value)) return true;
    return false;
  };
  const digestOf = (target: Element, properties: string[]) => {
    const style = getComputedStyle(target);
    const digest: Record<string, string> = {};
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (!isTrivial(value)) digest[property] = cap(value, 120);
    }
    return digest;
  };
  const lookProperties = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "color",
    "background-color",
    "background-image",
    "border",
    "border-radius",
    "box-shadow",
    "outline",
    "padding",
    "margin",
    "gap",
    "display",
    "flex-direction",
    "align-items",
    "justify-content",
    "width",
    "height",
    "cursor",
    "opacity",
    "transition",
    "appearance",
  ];
  const layoutProperties = [
    "display",
    "flex-direction",
    "flex-wrap",
    "gap",
    "align-items",
    "justify-content",
    "padding",
    "overflow",
    "width",
  ];
  // Every class, uncapped: a state class is often the fourth one on the
  // element (SoundCloud's label carried sc-toggle-on after three others).
  const summarize = (target: Element) => ({
    tag: target.tagName.toLowerCase(),
    classes: Array.from(target.classList),
    rect: roundRect(target.getBoundingClientRect()),
  });
  const ancestors: ProbeObject[] = [];
  let ancestor = element.parentElement;
  for (let depth = 0; depth < ancestorCount && ancestor; depth += 1) {
    ancestors.push({ ...summarize(ancestor), layout: digestOf(ancestor, layoutProperties) });
    ancestor = ancestor.parentElement;
  }
  // CSS custom properties (design tokens) in scope. Chrome enumerates used
  // custom properties through the computed style; engines that do not simply
  // yield none — the note keeps the model from reading that as "no tokens".
  const style = getComputedStyle(element);
  const customProperties: Record<string, string> = {};
  let customPropertyCount = 0;
  let customPropertiesTruncated = false;
  for (let position = 0; position < style.length; position += 1) {
    const name = style.item(position);
    if (!name.startsWith("--")) continue;
    if (customPropertyCount >= 40) {
      customPropertiesTruncated = true;
      break;
    }
    customProperties[name] = cap(style.getPropertyValue(name).trim(), 80);
    customPropertyCount += 1;
  }
  const parent = element.parentElement;
  let geometry: ProbeObject | null = null;
  if (parent) {
    const siblings = Array.from(parent.children);
    const gapPx = Number.parseFloat(getComputedStyle(parent).getPropertyValue("column-gap")) || 0;
    let usedWidth = 0;
    let visibleCount = 0;
    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        usedWidth += rect.width;
        visibleCount += 1;
      }
    }
    geometry = {
      parent: {
        ...summarize(parent),
        clientWidth: parent.clientWidth,
        scrollWidth: parent.scrollWidth,
      },
      siblings: siblings.slice(0, 12).map((sibling) => ({
        ...summarize(sibling),
        visible: sibling.getBoundingClientRect().width > 0 && sibling.getBoundingClientRect().height > 0,
        self: sibling === element,
      })),
      siblingsTruncated: siblings.length > 12,
      // Coarse "room left in this row" estimate — clientWidth minus visible
      // children and flex gaps. A hint for placement judgment, not a measurement.
      parentRowRemainingPxEstimate: Math.round(parent.clientWidth - usedWidth - gapPx * Math.max(visibleCount - 1, 0)),
    };
  }
  // State-rule census: the computed digest above is ONE point of a function
  // of state — an exemplar inspected while checked/hovered/expanded reveals
  // nothing about its other states. The stylesheet rules that repaint this
  // element's class family under state gates (:checked, :hover, or a state
  // class the site's JS adds, like -on/-off) are the static evidence for
  // every other point, readable without touching any control. The SoundCloud
  // mixes toggle shipped with an orange off-track because every observed
  // exemplar was on and the off look was assumed instead of read from here.
  const stateRules = (() => {
    const presentClasses = new Set<string>();
    const stems: string[] = [];
    const addStem = (name: string) => {
      presentClasses.add(name);
      if (stems.length < 24 && !stems.includes(name)) stems.push(name);
    };
    // Stems seed the family: the item's own classes, its labelled control's,
    // and those of descendants that carry a state gate (a checked/expanded
    // attribute). Every other descendant class is present context, not a
    // stem: seeding from all of them let utility classes like
    // sc-visuallyhidden pull unrelated rules into the family.
    const stateGateAttribute =
      /^(?:checked|selected|disabled|open|aria-(?:checked|pressed|selected|expanded|disabled|current|invalid|busy)|data-(?:state|checked|selected|active|open|expanded|pressed|on|toggled))$/;
    const carriesStateGate = (node: Element): boolean =>
      Array.from(node.attributes).some((attribute) => stateGateAttribute.test(attribute.name));
    for (const name of Array.from(element.classList)) addStem(name);
    if (labelled) for (const name of Array.from(labelled.control.classList)) addStem(name);
    for (const node of Array.from(element.querySelectorAll("*")).slice(0, 200)) {
      if (carriesStateGate(node)) {
        for (const name of Array.from(node.classList)) addStem(name);
      } else {
        for (const name of Array.from(node.classList)) presentClasses.add(name);
      }
    }
    // Ancestor classes are context a matching selector may legitimately name
    // (".stream__filter .sc-toggle") — present, but not family stems.
    let contextAncestor = element.parentElement;
    for (let depth = 0; depth < 8 && contextAncestor; depth += 1) {
      for (const name of Array.from(contextAncestor.classList)) presentClasses.add(name);
      contextAncestor = contextAncestor.parentElement;
    }
    if (stems.length === 0) return null;
    // A selector belongs to the family when one of the class tokens in its
    // SUBJECT compound (the last compound of a complex selector, the element
    // the rule paints) is a stem or a separator-suffixed extension of one
    // ("sc-toggle" claims ".sc-toggle-on" and ".sc-toggle__handle", not
    // ".sc-toggler"). A family token in an ancestor position
    // (".sc-toggle .badge") paints something else and is left out.
    const classTokenPattern = /\.((?:[-\w]|\\.)+)/g;
    const classTokensOf = (selectorText: string): string[] => {
      const tokens: string[] = [];
      for (let match = classTokenPattern.exec(selectorText); match; match = classTokenPattern.exec(selectorText)) {
        const token = match[1];
        if (token !== undefined) tokens.push(token.replace(/\\(.)/g, "$1"));
      }
      return tokens;
    };
    const subjectCompoundsOf = (selectorText: string): string[] => {
      const compounds: string[] = [];
      let subjectStart = 0;
      let parenDepth = 0;
      let inAttribute = false;
      let quote = "";
      for (let position = 0; position < selectorText.length; position += 1) {
        const char = selectorText[position];
        if (quote) {
          if (char === "\\") position += 1;
          else if (char === quote) quote = "";
          continue;
        }
        if (char === "\\") {
          position += 1;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (inAttribute) {
          if (char === "]") inAttribute = false;
          continue;
        }
        if (char === "[") {
          inAttribute = true;
          continue;
        }
        if (char === "(") {
          parenDepth += 1;
          continue;
        }
        if (char === ")") {
          parenDepth = Math.max(parenDepth - 1, 0);
          continue;
        }
        if (parenDepth > 0) continue;
        if (char === ",") {
          compounds.push(selectorText.slice(subjectStart, position));
          subjectStart = position + 1;
          continue;
        }
        if (char === " " || char === "\t" || char === "\n" || char === ">" || char === "+" || char === "~") {
          subjectStart = position + 1;
        }
      }
      compounds.push(selectorText.slice(subjectStart));
      return compounds;
    };
    const inFamily = (token: string): boolean =>
      stems.some((stem) => token === stem || token.startsWith(`${stem}-`) || token.startsWith(`${stem}_`));
    const paintsFamily = (selectorText: string): boolean =>
      subjectCompoundsOf(selectorText).some((compound) => classTokensOf(compound).some(inFamily));
    const paintPattern = /^(background|border|outline|box-shadow|color|opacity|transform|fill|stroke|content|filter|visibility|display|left|right|top|bottom|width|height)/;
    const statePseudoPattern = /:(?:focus-visible|focus-within|placeholder-shown|indeterminate|checked|hover|active|focus|disabled|enabled|open|target)/g;
    const stateAttributePattern = /\[[^\]]*(?:aria-|data-|checked|disabled|selected|pressed|expanded|open)[^\]]*\]/g;
    interface StateRuleRow extends ProbeObject {
      selector: string;
      gatedBy: string[];
      paint: Record<string, string>;
      media?: string;
    }
    const collected: StateRuleRow[] = [];
    let visited = 0;
    let unreadableSheets = 0;
    let scanTruncated = false;
    // Sheets the page world cannot read (cross-origin: cssRules throws) are
    // reported by href so the worker can fetch them and run this scan again
    // with their text (wiki/design/inspect-probes.md). The text arrives as
    // params.fetchedSheets, is parsed into a constructed stylesheet whose
    // rules are readable by definition, and never leaves this scan.
    const fetchedByHref = new Map<string, string>();
    for (const sheet of params.fetchedSheets ?? []) fetchedByHref.set(sheet.href, sheet.text);
    const unreadableSheetHrefs: string[] = [];
    const fetchedSheetHrefs: string[] = [];
    const resolveHref = (href: string | null | undefined, base: string | null | undefined): string | null => {
      if (!href) return null;
      try {
        return new URL(href, base ?? document.baseURI).href;
      } catch {
        return null;
      }
    };
    const recordUnreadable = (href: string | null) => {
      if (href === null || !/^https?:/.test(href)) return;
      if (unreadableSheetHrefs.length < 16 && !unreadableSheetHrefs.includes(href)) unreadableSheetHrefs.push(href);
    };
    // @import inside a fetched sheet: replaceSync drops import rules, so the
    // targets are read from the text and go through the same path (scanned
    // when their text was fetched, reported for one more round when not).
    const importPattern = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')/g;
    const scannedHrefs = new Set<string>();
    function scanFetched(href: string, text: string): void {
      if (scannedHrefs.has(href)) return;
      scannedHrefs.add(href);
      let constructed: CSSStyleSheet;
      try {
        constructed = new CSSStyleSheet();
        constructed.replaceSync(text);
      } catch {
        unreadableSheets += 1;
        return;
      }
      fetchedSheetHrefs.push(href);
      visit(constructed.cssRules, null, 0);
      for (const match of text.matchAll(importPattern)) {
        const target = resolveHref(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], href);
        if (target !== null && !scannedHrefs.has(target)) scanUnreadable(target);
      }
    }
    // A sheet whose rules cannot be read: scan its fetched text when the
    // worker supplied it, otherwise count it and ask for it by href.
    function scanUnreadable(href: string | null): void {
      const text = href === null ? undefined : fetchedByHref.get(href);
      if (href !== null && text !== undefined) {
        scanFetched(href, text);
        return;
      }
      unreadableSheets += 1;
      recordUnreadable(href);
    }
    function visit(ruleList: CSSRuleList, media: string | null, depth: number): void {
      if (depth > 4 || scanTruncated) return;
      for (const rule of Array.from(ruleList)) {
        visited += 1;
        if (visited > 20000 || collected.length >= 120) {
          scanTruncated = true;
          return;
        }
        if (rule instanceof CSSMediaRule) {
          visit(rule.cssRules, rule.conditionText, depth + 1);
          continue;
        }
        if (rule instanceof CSSImportRule) {
          let imported: CSSRuleList | undefined;
          try {
            imported = rule.styleSheet?.cssRules;
          } catch {
            imported = undefined;
          }
          if (imported) visit(imported, rule.media.mediaText || media, depth + 1);
          else scanUnreadable(rule.styleSheet?.href ?? resolveHref(rule.href, rule.parentStyleSheet?.href));
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) {
          if (rule instanceof CSSGroupingRule) visit(rule.cssRules, media, depth + 1);
          continue;
        }
        const selectorText = rule.selectorText ?? "";
        const tokens = classTokensOf(selectorText);
        if (paintsFamily(selectorText)) {
          const paint: Record<string, string> = {};
          let paintCount = 0;
          for (let position = 0; position < rule.style.length && paintCount < 10; position += 1) {
            const name = rule.style.item(position);
            if (!paintPattern.test(name)) continue;
            paint[name] = cap(rule.style.getPropertyValue(name), 80);
            paintCount += 1;
          }
          if (paintCount > 0 && !collected.some((row) => row.selector === selectorText && row.media === (media ?? undefined))) {
            const gatedBy: string[] = [];
            for (const pseudo of selectorText.match(statePseudoPattern) ?? []) {
              if (!gatedBy.includes(pseudo)) gatedBy.push(pseudo);
            }
            for (const attribute of (selectorText.match(stateAttributePattern) ?? []).slice(0, 4)) {
              if (!gatedBy.includes(attribute)) gatedBy.push(cap(attribute, 60));
            }
            // Class tokens the live subtree does not currently carry are the
            // state classes the site's JS toggles — the vocabulary the agent
            // must reproduce instead of invent.
            for (const token of tokens) {
              if (!presentClasses.has(token) && gatedBy.length < 8 && !gatedBy.includes(`.${token}`)) gatedBy.push(`.${token}`);
            }
            const row: StateRuleRow = { selector: cap(selectorText, 160), gatedBy, paint };
            if (media !== null) row.media = cap(media, 80);
            collected.push(row);
          }
        }
        // Modern engines expose nested rules on CSSStyleRule too.
        if (rule.cssRules.length > 0) visit(rule.cssRules, media, depth + 1);
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      let ruleList: CSSRuleList;
      try {
        ruleList = sheet.cssRules;
      } catch {
        // Cross-origin stylesheet: unreadable from the page world. Counted
        // (so "no rule found" is never read as "no rule exists") and named
        // by href so the worker can fetch it for the next round.
        scanUnreadable(sheet.href);
        continue;
      }
      visit(ruleList, null, 0);
      if (scanTruncated) break;
    }
    // Gated rules are the state grammar — they survive the cap first; base
    // (ungated) family rules give the resting look. Document order kept
    // within each group so cascade reasoning stays possible.
    const gated = collected.filter((row) => row.gatedBy.length > 0);
    const ungated = collected.filter((row) => row.gatedBy.length === 0);
    const reported = [...gated.slice(0, 20), ...ungated.slice(0, 10)];
    const summary: ProbeObject = {
      stems: stems.slice(0, 12),
      rules: reported.map((row) => ({ ...row })),
    };
    if (reported.length < collected.length) summary.rulesTruncated = true;
    if (scanTruncated) summary.scanTruncated = true;
    if (unreadableSheets > 0) summary.unreadableSheets = unreadableSheets;
    // Hrefs only, both ways: what was fetched and scanned, and what is still
    // unreadable (the worker's fetch list; whatever remains after its rounds
    // is what no fetch could read).
    if (fetchedSheetHrefs.length > 0) summary.fetchedSheets = fetchedSheetHrefs;
    if (unreadableSheetHrefs.length > 0) summary.unreadableSheetHrefs = unreadableSheetHrefs;
    if (gated.length === 0) {
      summary.note =
        "no state-gated paint rules found for this class family — absence is not proof" +
        (unreadableSheets > 0 ? ` (${unreadableSheets} stylesheet(s) unreadable)` : "") +
        "; if this control has states, find an exemplar in each state before assuming any state's look";
    }
    return summary;
  })();
  const result: ProbeObject = {
    found: true,
    total: matches.length,
    tag: element.tagName.toLowerCase(),
    classes: Array.from(element.classList),
    rect: roundRect(element.getBoundingClientRect()),
    style: digestOf(element, lookProperties),
    ancestors,
    customProperties,
    geometry,
  };
  if (labelled) {
    const describe = (target: Element): ProbeObject => {
      const summary: ProbeObject = { tag: target.tagName.toLowerCase(), classes: Array.from(target.classList) };
      if (target.id) summary.id = target.id;
      return summary;
    };
    result.redirected = {
      from: describe(labelled.control),
      to: describe(element),
      reason:
        labelled.via === "enclosing-label"
          ? "the matched control sits inside this label; the label is the item the page styles, so its look and state rules are reported"
          : "the matched control is named by a label[for]; this is the nearest element holding both, so its look and state rules are reported",
    };
  }
  if (stateRules) result.stateRules = stateRules;
  if (customPropertyCount === 0) result.customPropertiesNote = "none enumerable";
  if (customPropertiesTruncated) result.customPropertiesTruncated = true;
  return result;
}

export function readStructuredDataProbe(params: ReadStructuredDataParamsType, helpers: ProbeHelpers): ProbeResult {
  const cap = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);
  const jsonLd: ProbeValue[] = [];
  let jsonLdErrors = 0;
  let jsonLdSkipped = 0;
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
    const source = script.textContent ?? "";
    if (source.length > 20000) {
      jsonLdSkipped += 1;
      continue;
    }
    try {
      jsonLd.push(JSON.parse(source));
    } catch {
      jsonLdErrors += 1;
    }
  }
  const meta: Record<string, string> = {};
  for (const tag of Array.from(document.querySelectorAll("meta[name], meta[property]")).slice(0, 100)) {
    const key = tag.getAttribute("name") ?? tag.getAttribute("property") ?? "";
    const content = tag.getAttribute("content");
    if (key && content !== null && !(key in meta)) meta[key] = cap(content, 300);
  }
  // Inline state scripts (network-data-visibility §Layer 1): hydration blobs
  // are DOM text, readable right here. JSON-typed scripts parse directly;
  // `window.__X = {...}` assignments parse when the right-hand side is strict
  // JSON, and otherwise still surface the global NAME so the agent knows what
  // to hand read_page_state next.
  const stateGlobals: string[] = [];
  const inlineState: InlineStateEntry[] = [];
  let inlineStateSkipped = 0;
  for (const script of Array.from(document.querySelectorAll("script:not([src])")).slice(0, 60)) {
    const type = (script.getAttribute("type") ?? "").toLowerCase();
    if (type === "application/ld+json") continue;
    const source = script.textContent ?? "";
    if (source.length === 0) continue;
    if (type.includes("json")) {
      if (source.length > 20000 || inlineState.length >= 10) {
        inlineStateSkipped += 1;
        continue;
      }
      try {
        const entry: InlineStateEntry = { kind: "json-script", data: JSON.parse(source) };
        if (script.id) entry.id = script.id;
        inlineState.push(entry);
      } catch {
        inlineStateSkipped += 1;
      }
      continue;
    }
    const assignment = /(?:window|self|globalThis)\s*\.\s*(__[A-Za-z0-9_$]+)\s*=\s*/.exec(source);
    if (!assignment) continue;
    const global = assignment[1];
    if (!global) continue;
    if (!stateGlobals.includes(global) && stateGlobals.length < 20) stateGlobals.push(global);
    const rhs = source.slice((assignment.index ?? 0) + assignment[0].length).trim().replace(/;\s*$/, "");
    if ((rhs.startsWith("{") || rhs.startsWith("[")) && rhs.length <= 20000 && inlineState.length < 10) {
      try {
        inlineState.push({ kind: "hydration", global, data: JSON.parse(rhs) });
      } catch {
        // Not strict JSON — the global name above is still the useful signal.
      }
    }
  }
  const result: ProbeObject = {
    title: cap(document.title, 300),
    url: location.href,
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    meta,
    jsonLd,
    jsonLdErrors,
    jsonLdSkipped,
    stateGlobals,
    inlineState,
    inlineStateSkipped,
  };
  if (params.search !== undefined) {
    return { ...result, inlineState: undefined, jsonLd: undefined, matches: helpers.searchJson({ jsonLd, meta, inlineState }, params.search) };
  }
  return result;
}

/**
 * How many endpoint groups a `search` replays in one call: enough to cover
 * the data endpoints of a typical page load, few enough that a page-wide
 * search stays a handful of GETs the page already made itself.
 */
export const NETWORK_SEARCH_REPLAY_LIMIT = 8;

/** Matches reported per endpoint by a `search`. */
const NETWORK_SEARCH_MATCH_CAP = 10;

/**
 * The listing's page-side params: the model's schema plus the worker's own
 * census switch (the capture asks for every data endpoint group, sized, with
 * no filter; the model cannot, since the capture already carries that list).
 */
export interface ListNetworkResourcesProbeParams extends ListNetworkResourcesParamsType {
  census?: boolean;
}

/**
 * One request as the timeline recorded it, classified. Built once per
 * listing; the endpoint groups and the flat calls both derive from it.
 */
interface RecordedResource {
  url: string;
  startTime: number;
  initiatorType: string;
  contentType: string;
  status: number;
  bytes: number | null;
  sizeSource: "decoded" | "transfer" | "hidden";
  kind: "data" | "document" | "asset" | "other";
  sameSite: boolean;
  host: string;
  path: string;
  pattern: string;
}

/**
 * Probe #7 (wiki/design/network-probes.md): what the page fetched, from the
 * performance resource timeline. The result is the WORKER's view, not the
 * model's: every endpoint group and call carries its verbatim URL so the
 * worker can register an id for it, and the worker strips the URLs before
 * the reply reaches the panel. Three modes, one of which must be chosen
 * (the no-argument list is the capture's job now):
 *
 * - `census` (worker-only) or `urlFilter` or `includeAssets`: endpoint groups
 *   (host + path shape, newest call first) with counts and sizes.
 * - `flat`: the individual calls, each its own id.
 * - `search`: replay the newest call of up to NETWORK_SEARCH_REPLAY_LIMIT
 *   groups (GET, same anchor rule as replay_network_resource) and report
 *   which response bodies carry the needle.
 */
export async function listNetworkResourcesProbe(
  params: ListNetworkResourcesProbeParams,
  helpers: ProbeHelpers,
): Promise<ProbeResult> {
  const filter = params.urlFilter;
  const hasMode =
    params.census === true || filter !== undefined || params.search !== undefined || params.flat === true || params.includeAssets === true;
  if (!hasMode) {
    throw new Error(
      "list_network_resources lists nothing on its own: the capture's Data endpoints section already lists every data " +
        "endpoint of this page load with its id. Pass urlFilter to narrow by host or path, search to find which " +
        "endpoint's response carries a value, or flat to see individual calls.",
    );
  }
  // Default sized for orientation, not inventory: the top slice answers
  // "which endpoints carry data here" in ~1/4 the tokens a 50-row dump did;
  // an explicit limit (cap 200) is the exhaustive path. The census has no
  // limit here: the worker keeps the largest and counts the rest.
  const limit = params.census === true ? 1000 : Math.min(Math.max(params.limit ?? 15, 1), 200);
  const cap = helpers.capString;
  const all = performance.getEntriesByType("resource");
  const pageSite = helpers.registrableDomain(location.hostname);
  // Page-boundary parses (same tag-check idiom as the other probes): entries
  // come from the page's performance API, whose newer fields
  // (contentType/responseStatus, recent Chrome) may be absent, and are ""/0
  // cross-origin without Timing-Allow-Origin, so each is parsed here and the
  // classifier falls back to the initiator when they carry nothing.
  const asText = (value: PageValue): value is string => Object.prototype.toString.call(value) === "[object String]";
  const asNumber = (value: PageValue): value is number => Object.prototype.toString.call(value) === "[object Number]";
  const rows: RecordedResource[] = all.map((entry) => {
    // SAFETY: structural view over a PerformanceEntry; every field is read
    // behind the tag checks above and never written.
    const timing = entry as PerformanceEntry & {
      initiatorType?: PageValue;
      contentType?: PageValue;
      responseStatus?: PageValue;
      decodedBodySize?: PageValue;
      transferSize?: PageValue;
    };
    const initiatorType = asText(timing.initiatorType) ? timing.initiatorType : "unknown";
    const contentType = asText(timing.contentType) ? timing.contentType : "";
    const status = asNumber(timing.responseStatus) ? timing.responseStatus : 0;
    // Size: the decoded body (what the page parsed) when the browser exposes
    // it; the transfer size (headers included, and 0 on a cache hit) when only
    // that is known; hidden when neither is, which is what a cross-origin
    // response without Timing-Allow-Origin reports.
    const decoded = asNumber(timing.decodedBodySize) ? timing.decodedBodySize : 0;
    const transfer = asNumber(timing.transferSize) ? timing.transferSize : 0;
    const size: Pick<RecordedResource, "bytes" | "sizeSource"> =
      decoded > 0 ? { bytes: decoded, sizeSource: "decoded" } : transfer > 0 ? { bytes: transfer, sizeSource: "transfer" } : { bytes: null, sizeSource: "hidden" };
    const endpoint = helpers.endpointOf(entry.name);
    return {
      url: entry.name,
      startTime: entry.startTime,
      initiatorType,
      contentType,
      status,
      ...size,
      kind: helpers.classifyNetworkResource(entry.name, initiatorType, contentType),
      sameSite: endpoint.host !== "(unparseable)" && helpers.registrableDomain(endpoint.host) === pageSite,
      host: endpoint.host,
      path: endpoint.path,
      pattern: endpoint.pattern,
    };
  });
  // The filter matches the verbatim URL and the host + shape the model saw,
  // so a substring copied from a listing row works even where the shape
  // replaced an id.
  const filtered = rows.filter(
    (row) => filter === undefined || row.url.includes(filter) || `${row.host}${row.path}`.includes(filter),
  );
  // Data requests are the discovery target, ranked same-site first (a RANKING:
  // cross-site APIs are real, so nothing is dropped; Array.prototype.sort is
  // stable, request order is kept otherwise).
  const dataRows = filtered.filter((row) => row.kind === "data").sort((a, b) => Number(b.sameSite) - Number(a.sameSite));
  const nonDataRows = filtered.filter((row) => row.kind !== "data");
  const originCounts = new Map<string, number>();
  for (const row of nonDataRows) {
    let origin = "data:";
    try {
      origin = new URL(row.url).host || "data:";
    } catch {}
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);
  }
  const result: ProbeResult = {
    pageLoad: helpers.pageLoadToken(),
    pageUrl: location.href,
    total: filtered.length,
    dataTotal: dataRows.length,
    // Everything that is not a data request is collapsed to per-origin counts:
    // present (never silently dropped) but not in the way. includeAssets
    // expands them into individual rows.
    otherByOrigin: Array.from(originCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([origin, count]) => ({ origin: cap(origin, 120), count })),
    otherTotal: nonDataRows.length,
    // Saturated buffer = requests silently missing from this list. 250 is
    // Chrome's default limit; there is no API to read the configured one.
    entryCount: all.length,
    bufferPossiblySaturated: all.length >= RESOURCE_TIMING_DEFAULT_BUFFER,
  };
  const sizeOf = (row: RecordedResource): ProbeObject => ({
    bytes: row.bytes,
    sizeSource: row.sizeSource,
    contentType: row.contentType.length > 0 ? cap(row.contentType, 100) : null,
    status: row.status > 0 ? row.status : null,
    sameSite: row.sameSite,
  });
  if (params.flat === true) {
    result.calls = dataRows.slice(0, limit).map((row) => ({
      url: row.url,
      startTime: Math.round(row.startTime),
      host: row.host,
      path: row.path,
      pattern: row.pattern,
      initiatorType: row.initiatorType,
      ...sizeOf(row),
    }));
    result.callTotal = dataRows.length;
    result.callsTruncated = dataRows.length > limit;
  } else {
    // One row per endpoint. dataRows is sameSite-ranked but stable within a
    // host, so each group's last-seen row is its most recent request: that
    // URL is the one the group's id replays.
    interface EndpointGroup {
      host: string;
      path: string;
      pattern: string;
      count: number;
      statuses: number[];
      contentType: string;
      sameSite: boolean;
      url: string;
      bytes: number;
      sized: number;
      decoded: number;
    }
    const groups = new Map<string, EndpointGroup>();
    for (const row of dataRows) {
      const key = `${row.host} ${row.pattern}`;
      const group = groups.get(key) ?? {
        host: row.host,
        path: row.path,
        pattern: row.pattern,
        count: 0,
        statuses: [],
        contentType: "",
        sameSite: row.sameSite,
        url: "",
        bytes: 0,
        sized: 0,
        decoded: 0,
      };
      group.count += 1;
      // The newest call's query names describe the group; a parameter that
      // appears mid-session (offset on page two) must not split the endpoint.
      group.path = row.path;
      if (row.status > 0 && !group.statuses.includes(row.status) && group.statuses.length < 5) group.statuses.push(row.status);
      if (row.contentType.length > 0) group.contentType = row.contentType;
      if (row.bytes !== null) {
        group.bytes += row.bytes;
        group.sized += 1;
        if (row.sizeSource === "decoded") group.decoded += 1;
      }
      group.url = row.url;
      groups.set(key, group);
    }
    const ranked = Array.from(groups.values()).sort(
      (a, b) => Number(b.sameSite) - Number(a.sameSite) || b.bytes - a.bytes || b.count - a.count,
    );
    const describe = (group: EndpointGroup): ProbeObject => ({
      url: group.url,
      host: group.host,
      path: group.path,
      pattern: group.pattern,
      count: group.count,
      bytes: group.sized > 0 ? group.bytes : null,
      sizeSource: group.sized === 0 ? "hidden" : group.decoded === group.sized ? "decoded" : "transfer",
      statuses: group.statuses,
      contentType: group.contentType.length > 0 ? cap(group.contentType, 100) : null,
      sameSite: group.sameSite,
    });
    if (params.search !== undefined) {
      // Which endpoint's response carries the value: replay the newest call
      // of the best-ranked groups (GETs the page already made, its cookies,
      // its CORS rules) and search each body. Same-site groups and bigger
      // bodies first, since that is where a feed lives.
      const needle = params.search;
      const candidates = ranked.slice(0, NETWORK_SEARCH_REPLAY_LIMIT);
      const searched = await Promise.all(
        candidates.map(async (group): Promise<ProbeObject> => {
          const row = describe(group);
          try {
            const response = await fetch(group.url, { method: "GET" });
            const text = await response.text();
            row.searchStatus = response.status;
            try {
              row.matches = helpers.searchJson(JSON.parse(text), needle).slice(0, NETWORK_SEARCH_MATCH_CAP);
            } catch {
              row.matches = [];
              row.searchError = "response body is not JSON";
            }
          } catch (error) {
            row.searchError = `fetch failed: ${String(error)}`;
          }
          return row;
        }),
      );
      // Endpoints with a hit first; the rest stay listed so the model sees what was searched.
      result.endpoints = searched.sort((a, b) => hitCount(b) - hitCount(a));
      result.endpointTotal = groups.size;
      result.searched = candidates.length;
      result.searchSkipped = groups.size - candidates.length;
    } else {
      result.endpoints = ranked.slice(0, limit).map(describe);
      result.endpointTotal = groups.size;
      result.endpointsTruncated = groups.size > limit;
    }
  }
  if (params.includeAssets === true) {
    result.other = nonDataRows.slice(0, limit).map((row) => ({
      host: row.host,
      path: row.path,
      initiatorType: row.initiatorType,
      kind: row.kind,
      contentType: row.contentType.length > 0 ? cap(row.contentType, 100) : null,
    }));
    result.otherTruncated = nonDataRows.length > limit;
  }
  return result;
}

function hitCount(row: ProbeObject): number {
  return Array.isArray(row.matches) ? row.matches.length : 0;
}

/**
 * Probe #8 — the one genuinely new primitive: a structured, data-only read of
 * MAIN-world state (the app's in-memory store). Runs in the MAIN world (see
 * PROBE_WORLDS); walks own properties only and never invokes functions.
 * CAVEAT, deliberate and documented: MAIN-world property GETTERS can run page
 * code on read — this probe is "low side effect", not "side-effect-free by
 * construction" like the isolated-world probes. Keep that distinction here
 * rather than weakening the other templates' guarantee.
 */
export function readPageStateProbe(params: ReadPageStateParamsType, helpers: ProbeHelpers): ProbeResult {
  // Storage and credential roots hold session tokens, not page UI state, and
  // read_page_state is the no-approval lane (C3) — so they are off-limits here.
  const path = params.path ?? [];
  if (path.length > 0 && DENIED_STATE_ROOTS.includes(path[0]!)) {
    return {
      found: false,
      blocked: true,
      reason: `read_page_state does not expose "${path[0]}" — it holds storage or credential data, not page UI state.`,
    };
  }
  // Built-in browser APIs (navigator, document, location, …) are own ACCESSOR
  // properties of window; the root copy below reads descriptor.value, which for
  // an accessor is undefined. Refuse those roots explicitly: a silent undefined
  // reads as "API not present" — an agent verdict this probe cannot support
  // either way, since reading the getter would run page code.
  if (path.length > 0) {
    const rootDescriptor = Object.getOwnPropertyDescriptor(globalThis, path[0]!);
    if (rootDescriptor !== undefined && (rootDescriptor.get !== undefined || rootDescriptor.set !== undefined)) {
      return {
        found: false,
        unreadable: true,
        reason:
          `"${path[0]}" is an accessor-backed global (a getter, like most built-in browser APIs) — ` +
          "read_page_state reads plain data properties only. This says nothing about whether the API " +
          "exists or what it holds; do not feature-detect browser APIs with this probe.",
      };
    }
  }
  const maxDepth = Math.min(Math.max(params.maxDepth ?? 3, 1), 6);
  const maxBytes = Math.min(Math.max(params.maxBytes ?? 8192, 256), 32_768);
  const isPageObject = (value: PageValue): value is PageObject =>
    value !== null && value !== undefined && !Array.isArray(value) && !(value instanceof Node) && !(value instanceof Function);
  // Copy own global properties into the plain-object representation the probe
  // can traverse. The window itself contains host objects beyond PageValue.
  // SAFETY: the copied own-property values are immediately treated as page data and serialized with the same caps as nested state.
  const root = Object.fromEntries(Object.keys(globalThis).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)?.value])) as PageObject;
  let current: PageValue = root;
  const resolved: string[] = [];
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return {
          found: false,
          resolvedPath: resolved,
          missingSegment: segment,
          availableKeys: Object.keys(current).slice(0, 100),
        };
      }
      current = current[Number(segment)];
      resolved.push(segment);
      continue;
    }
    if (!isPageObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return {
        found: false,
        resolvedPath: resolved,
        missingSegment: segment,
        availableKeys: isPageObject(current) ? Object.keys(current).slice(0, 100) : [],
      };
    }
    current = current[segment];
    resolved.push(segment);
  }
  // Above the search branch: a root-level search (empty path) must never grep
  // the whole `window` graph — where the denied storage roots live — so it is
  // answered with the key listing instead.
  if (path.length === 0) {
    // Serializing all of window is never useful — report its own key names so
    // the agent can pick a state global (a scoped search still works from a path).
    return { found: true, path: [], keys: Object.keys(globalThis).slice(0, 400) };
  }
  if (params.search !== undefined) {
    return { found: true, path: resolved, matches: helpers.searchJson(current, params.search) };
  }
  const serialized = helpers.serializeCapped(current, maxDepth, maxBytes);
  return { found: true, path: resolved, value: serialized.value, truncated: serialized.truncated };
}

/**
 * replay_network_resource's page-side params: the model names an id; the
 * worker resolves it to the recorded URL and page-load token and sets both
 * itself (worker-authored, spread last), so nothing model-supplied can name
 * a URL. Without them the template refuses without fetching.
 */
export interface ReplayNetworkResourceProbeParams extends ReplayNetworkResourceParamsType {
  url?: string;
  pageLoad?: string;
}

/**
 * Probe #9: feasibility-phase replay with two structural, data-only bounds.
 * The worker resolved the id to a URL it recorded from this tab, and the URL
 * executes ONLY if the page-load token it was recorded against is this
 * document's and the exact URL still appears in the page's resource timeline,
 * both checked in-page at execution time. The model cannot fabricate a
 * request and cannot get a body from a page other than the one it listed.
 * No custom headers; capped body. Honesty caveats live in the tool
 * description: a prior page fetch is not proof of side-effect-freedom, and a
 * cookie-bearing replay returns personalized data (untrusted, like every
 * page-data channel).
 */
export async function replayNetworkResourceProbe(
  params: ReplayNetworkResourceProbeParams,
  helpers: ProbeHelpers,
): Promise<ProbeResult> {
  const maxBytes = Math.min(Math.max(params.maxBytes ?? 16_384, 256), 65_536);
  if (params.url === undefined || params.pageLoad === undefined) {
    return {
      replayed: false,
      reason: "not-prepared",
      detail: "the extension resolves an id to its recorded URL before this probe runs; nothing was fetched",
    };
  }
  if (params.pageLoad !== helpers.pageLoadToken()) {
    // A different document from the one that listed this id: refuse before
    // any request, so a body never comes from a page the model did not list.
    return { replayed: false, reason: "stale-id" };
  }
  const entries = performance.getEntriesByType("resource");
  if (!entries.some((entry) => entry.name === params.url)) {
    return {
      replayed: false,
      reason: "url-not-recorded",
      entryCount: entries.length,
      bufferPossiblySaturated: entries.length >= RESOURCE_TIMING_DEFAULT_BUFFER,
    };
  }
  let response: Response;
  let text: string;
  try {
    response = await fetch(params.url, { method: "GET" });
    text = await response.text();
  } catch (error) {
    return { replayed: false, reason: "fetch-failed", message: String(error) };
  }
  const endpoint = helpers.endpointOf(params.url);
  const result: ProbeObject = {
    replayed: true,
    host: endpoint.host,
    path: endpoint.path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    totalChars: text.length,
    truncated: text.length > maxBytes,
  };
  // Deterministic shape summary of a JSON body: the agent reads real field
  // names and value types (duration: number) before choosing search values,
  // instead of guessing display strings that cannot exist in the JSON.
  try {
    result.outline = helpers.outlineJson(JSON.parse(text), 600);
  } catch {}
  if (params.search !== undefined) {
    try {
      result.matches = helpers.searchJson(JSON.parse(text), params.search);
      return result;
    } catch {
      result.searchError = "response body is not JSON; returning the capped body instead";
    }
  }
  result.body = helpers.capString(text, maxBytes);
  return result;
}

/**
 * Read the development-time observer's ring buffer (wiki/raw/handoffs/
 * 2026-08-10-broad-observe-session-grant.md): the page's own fetch/XHR
 * response bodies, buffered by the extension-owned MAIN-world observer a
 * dev-observe grant registers. The handshake is a synchronous CustomEvent
 * pair — dispatchEvent runs the MAIN-world listener during the dispatch, so
 * the reply has landed before this function returns. requestEvent/replyEvent
 * are WORKER-injected after schema validation (they carry the grant token);
 * the model neither sees nor controls them — the worker spreads its values
 * last, so a model-supplied field of the same name cannot shadow them.
 * Bodies are untrusted page data; search/caps mirror replay_network_resource.
 */
export function observeNetworkBodiesProbe(
  params: ObserveNetworkBodiesParamsType & { requestEvent?: string; replyEvent?: string },
  helpers: ProbeHelpers,
): ProbeResult {
  if (!params.requestEvent || !params.replyEvent) {
    return {
      observed: false,
      reason: "not-enabled",
      detail: "no dev-observe grant was attached to this probe by the extension",
    };
  }
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
  const maxBytes = Math.min(Math.max(params.maxBytes ?? 4096, 256), 32_768);
  let raw: string | undefined;
  const onReply = (event: Event): void => {
    raw = event instanceof CustomEvent ? String(event.detail) : undefined;
  };
  document.addEventListener(params.replyEvent, onReply, { once: true });
  document.dispatchEvent(
    new CustomEvent(params.requestEvent, { detail: JSON.stringify({ urlFilter: params.urlFilter, limit }) }),
  );
  document.removeEventListener(params.replyEvent, onReply);
  if (raw === undefined) {
    return {
      observed: false,
      reason: "observer-not-running",
      detail:
        "the observer starts at page load — if observation was enabled just now the tab already reloaded; " +
        "otherwise reload the tab, let it finish loading, then read again",
    };
  }
  const isPageObject = (value: PageValue): value is PageObject =>
    value !== null && !Array.isArray(value) && !(value instanceof Node) && !(value instanceof Function);
  const isPageText = (value: PageValue): value is string => Object.prototype.toString.call(value) === "[object String]";
  const isPageNumber = (value: PageValue): value is number => Object.prototype.toString.call(value) === "[object Number]";
  const parseReply = (value: PageValue): ObserverReply => {
    if (!isPageObject(value)) return {};
    return { total: value.total, matched: value.matched, entries: value.entries, recorded: value.recorded };
  };
  let reply: ObserverReply;
  try {
    reply = parseReply(JSON.parse(raw));
  } catch {
    return { observed: false, reason: "malformed-reply" };
  }
  const entries = Array.isArray(reply.entries) ? reply.entries : [];
  const results = entries.map((item) => {
    const entry: ObserverEntry = isPageObject(item)
      ? {
          seq: item.seq,
          url: item.url,
          method: item.method,
          status: item.status,
          contentType: item.contentType,
          body: item.body,
          truncated: item.truncated,
        }
      : {};
    const body = isPageText(entry.body) ? entry.body : "";
    // The two cut causes are reported SEPARATELY, with a plain-words note. A
    // merged `truncated` flag read as "the data is incomplete" sent the
    // Spotify album-label session into a phantom theory ("the site shortens
    // the response") and a wrong-record regex — the stored body was complete
    // the whole time; only the 4KB viewing window was cut (wiki/raw/handoffs/
    // 2026-08-19-first-time-pass-observer-and-network-truth.md §4).
    const storedTruncated = entry.truncated === true;
    const viewTruncated = body.length > maxBytes;
    const result: ProbeObject = {
      seq: helpers.serializeCapped(entry.seq ?? null, 1, 100).value,
      url: helpers.capString(isPageText(entry.url) ? entry.url : "", 500),
      method: helpers.serializeCapped(entry.method ?? null, 1, 100).value,
      status: helpers.serializeCapped(entry.status ?? null, 1, 100).value,
      contentType: helpers.serializeCapped(entry.contentType ?? null, 1, 100).value,
      totalChars: body.length,
      storedTruncated,
      viewTruncated,
      note: storedTruncated
        ? "the stored copy was cut at the extension's 512KB per-response cap; the tail beyond it is gone"
        : viewTruncated
          ? `body is stored — and delivered to remixlets — in full (${body.length} chars); only this view is cut at maxBytes=${maxBytes}. Use search, or raise maxBytes, to see more`
          : "body is stored and shown in full",
    };
    // Deterministic shape summary of a JSON body: real field names and value
    // types up front, so search values are chosen from what the JSON actually
    // holds (duration: number) rather than from rendered text ("59:56").
    try {
      result.outline = helpers.outlineJson(JSON.parse(body), 600);
    } catch {}
    if (params.search !== undefined) {
      try {
        result.matches = helpers.searchJson(JSON.parse(body), params.search);
        return result;
      } catch {
        result.searchError = "response body is not JSON; returning the capped body instead";
      }
    }
    result.body = helpers.capString(body, maxBytes);
    return result;
  });
  const totalObserved = isPageNumber(reply.total) ? reply.total : entries.length;
  const outcome: ProbeResult = {
    observed: true,
    totalObserved,
    matchedFilter: isPageNumber(reply.matched) ? reply.matched : entries.length,
    returned: results.length,
    entries: results,
  };
  // Eviction honesty: recorded counts every response the observer ever saw,
  // totalObserved only what the ring still holds. A gap means early responses
  // (typically the page-load data fetches) are GONE — the soundcloud feed body
  // was evicted exactly this way and read as "the page never fetched it".
  if (isPageNumber(reply.recorded) && reply.recorded > totalObserved) {
    outcome.totalRecorded = reply.recorded;
    outcome.evictionNote =
      `${reply.recorded - totalObserved} earlier responses are no longer held (replaced by a newer response to ` +
      "the same URL, or evicted once the buffer filled) — if a load-time response seems missing, reload the tab " +
      "and read again promptly";
  }
  return outcome;
}

/**
 * click_element's page-side params: the model names a selector; the WORKER
 * adds the click rights (worker/index.ts clickProbeParams over worker/box.ts
 * clickRightsFor) after schema validation, spread last, so nothing
 * model-supplied can shadow them and the model-facing schema
 * (shared/probe-schemas.ts) declares neither. Without them only same-origin
 * clicks pass, which is the right answer for a page with no boxed remixlet.
 */
export interface ClickElementProbeParams extends ClickElementParamsType {
  /** The `matches` of every boxed remixlet running on this page. */
  matches?: string[];
  /** Their `fetch:`-derived granted host patterns. */
  grantedHosts?: string[];
}

/**
 * Probe #11 — the ONE deliberately state-changing probe: dispatch a click on a
 * matched element, so a control's interactive behavior can be exercised
 * through the structured lane (click → assert changed state → click → assert
 * restored). The terra airbnb run
 * shipped a sort pill whose handler was a functional no-op precisely because
 * no sanctioned interaction existed — presence/look assertions cannot catch a
 * dead handler. Same injection invariant as every template: the selector
 * arrives as JSON data, never code, and an invalid selector throws like
 * querySelectorAll. The click is synthetic (isTrusted: false) — a remixlet's
 * own handlers never check that, but a host control might ignore it.
 *
 * The click goes through the SAME rule remixlet code's `dom.click()` obeys
 * (`clickDecision` in src/box/policy.ts, judged by what the click activates):
 * a click that would navigate off-site or submit an off-site form is refused
 * before it is dispatched, and the refusal comes back as a result rather than
 * an error, so the model reads what happened and moves on. There is no
 * ownership limit: verifying that a remixlet changed what a site's own button
 * does means clicking the site's own button
 * (wiki/ops/2026-09-12-security-review-plan.md, F3).
 *
 * `matches` and `grantedHosts` are WORKER-injected after schema validation
 * (worker/index.ts clickProbeParams): they are the matches and `fetch:` grants
 * of the boxed remixlets running on this page, so the agent clicks with the
 * rights the remixlet it is verifying has. The model neither sees nor controls
 * them: the model-facing schema does not declare them, and the worker spreads
 * its values last, so a model-supplied field of the same name cannot shadow
 * them. With no boxed remixlet on the page both are empty and only same-origin
 * clicks pass.
 */
export function clickElementProbe(params: ClickElementProbeParams, helpers: ProbeHelpers): ProbeResult {
  const index = params.index ?? 0;
  const matches = helpers.queryAllDeep(params.selector);
  const element = matches[index];
  if (!element) return { found: false, total: matches.length, clicked: false };
  let visible: boolean;
  if (element.checkVisibility) {
    visible = element.checkVisibility();
  } else {
    const rect = element.getBoundingClientRect();
    visible = rect.width > 0 && rect.height > 0;
  }
  const decision = clickDecision(element, clickUrlContext(params));
  const tag = element.tagName.toLowerCase();
  if (decision.kind === "refuse") {
    return { found: true, total: matches.length, clicked: false, refused: decision.reason, tag, visible };
  }
  // HTMLElement.click() runs the element's activation behavior (checkbox
  // toggling, label forwarding) as well as listeners; the MouseEvent fallback
  // covers SVG and other non-HTML elements.
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }
  return { found: true, total: matches.length, clicked: true, tag, visible };
}

/**
 * The vetting context for one click: this document's own URL and base, the
 * worker's rights, and the page's own resource URLs read lazily (only an
 * off-site, un-granted destination pays for the collection) and once per
 * click, since the two checks can both ask for it.
 */
function clickUrlContext(params: ClickElementProbeParams): UrlContext {
  let pageUrls: ReadonlySet<string> | undefined;
  return {
    pageUrl: location.href,
    baseUrl: document.baseURI,
    matches: Array.isArray(params.matches) ? params.matches : [],
    grantedHosts: Array.isArray(params.grantedHosts) ? params.grantedHosts : [],
    pageUrls: () => (pageUrls ??= pageResourceUrls(document, window)),
  };
}

/**
 * The page-side half of look_at_change (wiki/design/look-review.md): bring the
 * added element into view, and report the rectangles the worker crops from
 * one captureVisibleTab — the element, its context ancestor, and (when given)
 * the host exemplar with its own context. It scrolls (the one sanctioned
 * side effect besides click_element: a crop of something off-screen is
 * impossible) and reads geometry; it never judges the look. Two animation
 * frames after a scroll let sticky headers and lazy paint settle.
 *
 * Context ancestor: "row" is the nearest ancestor at least three times as
 * wide as the element (capped at 5 levels), "container" the nearest ancestor
 * that paints a background or border, "element" the element itself. Context
 * rects are clipped to the viewport — the capture cannot see further.
 */
export async function locateForReviewProbe(params: LocateForReviewParamsType, helpers: ProbeHelpers): Promise<ProbeResult> {
  const context = params.context ?? "row";
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const roundRect = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  const clipToViewport = (rect: DOMRect) => {
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(viewport.width, rect.right);
    const bottom = Math.min(viewport.height, rect.bottom);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  };
  const inViewport = (rect: DOMRect): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= viewport.height &&
    rect.right <= viewport.width;
  const isVisible = (element: Element): boolean => {
    if (element.checkVisibility) return element.checkVisibility();
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const paintsSurface = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const background = style.getPropertyValue("background-color");
    if (background !== "" && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") return true;
    if (style.getPropertyValue("background-image") !== "none") return true;
    for (const side of ["top", "right", "bottom", "left"]) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
      const lineStyle = style.getPropertyValue(`border-${side}-style`);
      if (width > 0 && lineStyle !== "none" && lineStyle !== "hidden") return true;
    }
    return false;
  };
  const contextAncestor = (element: Element): Element => {
    if (context === "element") return element;
    const own = element.getBoundingClientRect();
    let ancestor = element.parentElement;
    for (let depth = 0; depth < (context === "row" ? 5 : 8) && ancestor && ancestor !== document.body; depth += 1) {
      const rect = ancestor.getBoundingClientRect();
      if (context === "row") {
        if (rect.width >= own.width * 3 && rect.height > 0) return ancestor;
      } else if (paintsSurface(ancestor)) {
        return ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    return element;
  };
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const describe = (element: Element, scrolled: boolean) => {
    const rect = element.getBoundingClientRect();
    const ancestor = contextAncestor(element);
    const contextRect = clipToViewport(ancestor.getBoundingClientRect());
    return {
      tag: element.tagName.toLowerCase(),
      rect: roundRect(clipToViewport(rect)),
      fullRect: roundRect(rect),
      contextRect: roundRect(contextRect.width > 0 && contextRect.height > 0 ? contextRect : clipToViewport(rect)),
      contextTag: ancestor.tagName.toLowerCase(),
      inViewport: inViewport(rect),
      visible: isVisible(element),
      scrolled,
    };
  };

  const subjects = helpers.queryAllDeep(params.selector);
  const subject = subjects[0];
  const result: ProbeResult = {
    devicePixelRatio: window.devicePixelRatio || 1,
    viewport,
    context,
    subjectTotal: subjects.length,
  };
  if (!subject) {
    result.subject = null;
    return result;
  }
  let reference: Element | undefined;
  if (params.referenceSelector !== undefined) {
    const references = helpers.queryAllDeep(params.referenceSelector);
    reference = references[0];
    result.referenceTotal = references.length;
    if (!reference) result.reference = null;
  }
  let scrolledSubject = false;
  if (isVisible(subject) && !inViewport(subject.getBoundingClientRect())) {
    subject.scrollIntoView({ block: "center", inline: "nearest" });
    scrolledSubject = true;
    await settle();
  }
  result.subject = describe(subject, scrolledSubject);
  if (reference) result.reference = describe(reference, false);
  return result;
}

export async function assertPageStateProbe(params: AssertPageStateParamsType, helpers: ProbeHelpers): Promise<ProbeResult> {
  const evaluateAll = () => params.assertions.map((assertion) => {
    const isText = (value: string | number | undefined): value is string =>
      Object.prototype.toString.call(value) === "[object String]";
    const evaluate = (): AssertionOutcome => {
      let matches: Element[];
      try {
        matches = helpers.queryAllDeep(assertion.selector);
      } catch (error) {
        return { pass: false, actual: `invalid selector: ${String(error)}` };
      }
      const first = matches[0];
      switch (assertion.condition) {
        case "exists":
          return { pass: matches.length > 0, actual: `${matches.length} match(es)` };
        case "not-exists":
          return { pass: matches.length === 0, actual: `${matches.length} match(es)` };
        case "count-at-least":
        case "count-equals": {
          const expected = Number(assertion.expected);
          if (!Number.isFinite(expected)) {
            return { pass: false, actual: `${assertion.condition} requires a numeric "expected"` };
          }
          const pass = assertion.condition === "count-at-least" ? matches.length >= expected : matches.length === expected;
          return { pass, actual: `${matches.length} match(es)` };
        }
        case "text-contains": {
          if (!first) return { pass: false, actual: "no match" };
          if (!isText(assertion.expected)) {
            return { pass: false, actual: 'text-contains requires a string "expected"' };
          }
          const text = (first.textContent ?? "").replace(/\s+/g, " ").trim();
          return { pass: text.includes(assertion.expected), actual: text.length > 200 ? `${text.slice(0, 200)}…` : text };
        }
        case "attr-equals": {
          if (!first) return { pass: false, actual: "no match" };
          if (!assertion.name) return { pass: false, actual: 'attr-equals requires "name" (the attribute)' };
          const actual = isSensitiveField(first) && assertion.name.toLowerCase() === "value" ? "" : first.getAttribute(assertion.name);
          return { pass: actual === String(assertion.expected ?? ""), actual: actual === null ? "(absent)" : actual };
        }
        case "style-equals": {
          if (!first) return { pass: false, actual: "no match" };
          if (!assertion.name) return { pass: false, actual: 'style-equals requires "name" (the CSS property)' };
          const actual = getComputedStyle(first).getPropertyValue(assertion.name);
          return { pass: actual === String(assertion.expected ?? ""), actual };
        }
        case "visible": {
          if (!first) return { pass: false, actual: "no match" };
          if (first.checkVisibility) {
            return { pass: first.checkVisibility(), actual: first.checkVisibility() ? "visible" : "not visible" };
          }
          const rect = first.getBoundingClientRect();
          const pass = rect.width > 0 && rect.height > 0;
          return { pass, actual: pass ? "visible" : "not visible" };
        }
        case "style-parity": {
          if (!first) return { pass: false, actual: "no match" };
          if (!assertion.name) return { pass: false, actual: 'style-parity requires "name" (the CSS property)' };
          if (!assertion.otherSelector) {
            return { pass: false, actual: 'style-parity requires "otherSelector" (the reference element)' };
          }
          let other: Element | undefined;
          try {
            other = helpers.queryAllDeep(assertion.otherSelector)[0];
          } catch (error) {
            return { pass: false, actual: `invalid otherSelector: ${String(error)}` };
          }
          if (!other) return { pass: false, actual: "no match for otherSelector" };
          const mine = getComputedStyle(first).getPropertyValue(assertion.name);
          const reference = getComputedStyle(other).getPropertyValue(assertion.name);
          return { pass: mine === reference, actual: `${mine} vs ${reference}` };
        }
        case "not-clipped": {
          if (!first) return { pass: false, actual: "no match" };
          const rect = first.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return { pass: false, actual: "zero-size (not rendered)" };
          if (first.clientWidth > 0 && first.scrollWidth > first.clientWidth + 1) {
            return {
              pass: false,
              actual: `content overflows (scrollWidth ${first.scrollWidth} > clientWidth ${first.clientWidth})`,
            };
          }
          // Per-axis: hidden/clip ancestors cut content at the visible box;
          // auto/scroll ancestors only "clip" what lies beyond the SCROLLABLE
          // extent — content the user can scroll to is reachable, not clipped.
          const clipAxis = (ancestor: Element): string | null => {
            const style = getComputedStyle(ancestor);
            const box = ancestor.getBoundingClientRect();
            const overflowX = style.overflowX;
            if (overflowX === "hidden" || overflowX === "clip") {
              if (rect.left < box.left - 1 || rect.right > box.left + (ancestor.clientWidth || box.width) + 1) return "x";
            } else if (overflowX === "auto" || overflowX === "scroll") {
              const leftInScroll = rect.left - box.left + ancestor.scrollLeft;
              if (leftInScroll < -1 || leftInScroll + rect.width > ancestor.scrollWidth + 1) return "x";
            }
            const overflowY = style.overflowY;
            if (overflowY === "hidden" || overflowY === "clip") {
              if (rect.top < box.top - 1 || rect.bottom > box.top + (ancestor.clientHeight || box.height) + 1) return "y";
            } else if (overflowY === "auto" || overflowY === "scroll") {
              const topInScroll = rect.top - box.top + ancestor.scrollTop;
              if (topInScroll < -1 || topInScroll + rect.height > ancestor.scrollHeight + 1) return "y";
            }
            return null;
          };
          let ancestor = first.parentElement;
          while (ancestor) {
            const axis = clipAxis(ancestor);
            if (axis) {
              const classes = Array.from(ancestor.classList).slice(0, 2).join(".");
              return {
                pass: false,
                actual: `clipped (${axis}) by <${ancestor.tagName.toLowerCase()}${classes ? `.${classes}` : ""}>`,
              };
            }
            ancestor = ancestor.parentElement;
          }
          return { pass: true, actual: "not clipped" };
        }
        default:
          return { pass: false, actual: `unknown condition ${String(assertion.condition)}` };
      }
    };
    const outcome = evaluate();
    return { selector: assertion.selector, condition: assertion.condition, pass: outcome.pass, actual: outcome.actual };
  });
  // The per-call retry window: "assert now" when timeoutMs is omitted, "assert
  // within N ms" when present — ALL assertions re-evaluate together until every
  // one passes or the window lapses, and the final results are returned either
  // way (a lapsed window reports the last evaluation's failures honestly).
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 0, 0), 10000);
  const started = Date.now();
  let results = evaluateAll();
  let allPassed = results.length > 0 && results.every((result) => result.pass);
  while (!allPassed && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    results = evaluateAll();
    allPassed = results.length > 0 && results.every((result) => result.pass);
  }
  const outcome: ProbeResult = { allPassed, results };
  if (params.timeoutMs !== undefined) outcome.waitedMs = Date.now() - started;
  return outcome;
}

/** One template per probe name; the worker dispatcher resolves through this. */
export const PROBE_TEMPLATES = {
  query_elements: queryElementsProbe,
  search_elements: searchElementsProbe,
  inspect_element: inspectElementProbe,
  inspect_design: inspectDesignProbe,
  read_structured_data: readStructuredDataProbe,
  read_page_state: readPageStateProbe,
  list_network_resources: listNetworkResourcesProbe,
  replay_network_resource: replayNetworkResourceProbe,
  observe_network_bodies: observeNetworkBodiesProbe,
  click_element: clickElementProbe,
  assert_page_state: assertPageStateProbe,
  locate_for_review: locateForReviewProbe,
} satisfies Record<ProbeName, (params: never, helpers: ProbeHelpers) => ProbeResult | Promise<ProbeResult>>;

/**
 * Execution world per probe. Everything runs in the extension's ISOLATED
 * world EXCEPT read_page_state, whose whole purpose is the MAIN-world store —
 * that difference is why it carries the getter caveat above, and why the
 * engine injects page-state.js before it (page-state-reader.ts).
 */
export const PROBE_WORLDS = {
  query_elements: "ISOLATED",
  search_elements: "ISOLATED",
  inspect_element: "ISOLATED",
  inspect_design: "ISOLATED",
  read_structured_data: "ISOLATED",
  read_page_state: "MAIN",
  list_network_resources: "ISOLATED",
  replay_network_resource: "ISOLATED",
  // The buffer lives in a MAIN-world closure, but CustomEvents cross worlds
  // (the relay's own pattern), so the read runs isolated like the rest.
  observe_network_bodies: "ISOLATED",
  click_element: "ISOLATED",
  assert_page_state: "ISOLATED",
  locate_for_review: "ISOLATED",
} satisfies Record<ProbeName, "ISOLATED" | "MAIN">;
