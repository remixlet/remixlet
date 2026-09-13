// The page agent's allow / mediate / refuse table (wiki/design/mediated-execution.md
// §Policy). Every DOM WRITE a box asks for passes through here before it touches
// the real document; reads never do. Pure: nothing here reaches for a DOM
// global at import time — callers pass the document or element in question —
// so the table can be unit-tested and reasoned about as data.
//
// The threat model is a rogue remixlet, not a rogue page: the sandbox already
// keeps remixlet code from fetching, so what this table closes is the DOM as a
// network channel (src/href/action/style-url exfiltration, injected frames and
// scripts, navigation) plus the form-submit route. The page is not the
// attacker, but it does own the document base, so URL vetting resolves the way
// the browser will and hands back the absolute URL the caller must write. Refusals are answered with a
// short plain-words reason that the agent prefixes with "refused: " and the box
// runtime logs once per distinct reason, so the fix loop can read them.

import { CLONE_NOTES_CAP, CREATE_TREE_CAP, HTML_WRITE_CAP } from "./protocol.js";
import { urlMatchesFetchHostPattern } from "../shared/fetch-capability.js";
import { OWNER_ATTRIBUTE, attributeMarkedBy, classMarkedBy, markPrefix } from "../shared/marks.js";
import { originWidePatterns, urlMatchesAny } from "../shared/site-key.js";

/** The refusal half of every decision below, so one `refuse()` serves them all. */
export interface Refusal {
  kind: "refuse";
  reason: string;
}

export type PolicyDecision = { kind: "allow" } | Refusal;

export const ALLOW: PolicyDecision = { kind: "allow" };

export function refuse(reason: string): Refusal {
  return { kind: "refuse", reason };
}

// ---------------------------------------------------------------------------
// Elements

/** Tags a remixlet may create. An allowlist: anything unlisted is refused too. */
export const TAG_ALLOW: ReadonlySet<string> = new Set([
  // Layout and text.
  "div", "span", "p", "a", "button", "input", "select", "option", "optgroup", "textarea", "label",
  "fieldset", "legend", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "article", "header", "footer", "nav", "aside", "main", "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "img", "strong", "em", "b", "i", "u", "s", "small", "code", "pre", "kbd", "abbr", "q", "cite",
  "br", "wbr", "hr", "details", "summary", "dialog", "figure", "figcaption", "time", "mark", "sup", "sub",
  "progress", "meter", "output",
  // Inline SVG drawing.
  "svg", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g", "text", "tspan",
]);

/**
 * Tags refused by name. Everything here is also absent from TAG_ALLOW; the set
 * exists so the reason can say WHY (network, script, navigation) rather than
 * "not on the list".
 */
export const TAG_REFUSE: ReadonlySet<string> = new Set([
  "form", "iframe", "frame", "frameset", "object", "embed", "script", "base", "meta", "link", "style",
  "template", "portal", "fencedframe", "video", "audio", "source", "track", "picture", "use", "math",
  "noscript", "image", "foreignobject", "animate", "set", "animatemotion", "animatetransform",
]);

/** Tags created in the SVG namespace so they render (createElement would make an HTMLUnknownElement). */
export const SVG_TAGS: ReadonlySet<string> = new Set([
  "svg", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "g", "text", "tspan",
]);

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createTagDecision(tag: string): PolicyDecision {
  const name = String(tag).trim().toLowerCase();
  if (name === "") return refuse("an element needs a tag name");
  if (TAG_REFUSE.has(name)) return refuse(`<${name}> elements cannot be created by a remixlet`);
  if (!TAG_ALLOW.has(name)) return refuse(`<${name}> is not an element a remixlet can create`);
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Attributes

/**
 * Attribute names refused outright (after lowercasing), plus every `on*`
 * handler. `href` on a/area and `src` on img are the two mediated exceptions:
 * allowed when urlDecision passes, and written as the URL it resolved.
 */
export const ATTR_REFUSE: ReadonlySet<string> = new Set([
  "src", "href", "action", "srcdoc", "srcset", "formaction", "ping", "poster", "target", "http-equiv",
  "xlink:href", "data", "codebase", "background", "style", "is", "form", "rel", "download", "sandbox",
  "allow", "formmethod", "formtarget", "formenctype", "method", "enctype", "manifest", "usemap",
  "longdesc", "profile", "archive", "classid", "xml:base", "nonce", "integrity", "referrerpolicy",
  "crossorigin", "shadowrootmode", "shadowrootdelegatesfocus",
]);

/**
 * Set on a write to one of the page's own elements (not created or cloned by
 * the box, see isOwnedBy): the marks written there must carry this box's
 * prefix. Absent for owned elements and for markup the sanitiser vets.
 */
export interface PageElementWrite {
  remixletId: string;
}

const OWNER_ATTRIBUTE_REASON = `${OWNER_ATTRIBUTE} is written by the extension and cannot be set or removed by a remixlet`;

export interface AttributeInput {
  tag: string;
  name: string;
  value: string;
  url: UrlContext;
  pageElement?: PageElementWrite;
}

/** Whether (tag, attr) is one of the two mediated URL attributes. */
export function isMediatedUrlAttribute(tag: string, name: string): boolean {
  const t = tag.toLowerCase();
  const n = name.toLowerCase();
  return (n === "href" && (t === "a" || t === "area")) || (n === "src" && t === "img");
}

/**
 * Writes onto an EXISTING page element whose tag a remixlet could not have
 * created: a page's own <meta http-equiv=refresh>, <base>, <form>, <iframe>,
 * <link>, <script>… Changing (or removing) any attribute on one of those is a
 * navigation, resource load or submit target change in disguise — a meta
 * refresh re-runs when its content attribute changes — so the whole element
 * is off limits, whichever attribute is named.
 */
export function existingElementWriteDecision(tag: string): PolicyDecision {
  const name = String(tag).trim().toLowerCase();
  return TAG_REFUSE.has(name) ? refuse(`attributes of a page's <${name}> element cannot be changed by a remixlet`) : ALLOW;
}

/**
 * What to write, once the table has allowed it: the value the caller passed,
 * except for a mediated URL attribute, where it is the absolute URL vetting
 * resolved. Writing that value rather than the raw string is what keeps the
 * check and the browser's own resolution from disagreeing (see urlDecision).
 */
export type AttributeDecision = { kind: "allow"; value: string } | Refusal;

export function attributeDecision(input: AttributeInput): AttributeDecision {
  const name = String(input.name).trim().toLowerCase();
  if (name === "") return refuse("an attribute needs a name");
  const element = existingElementWriteDecision(input.tag);
  if (element.kind === "refuse") return element;
  if (name.startsWith("on")) return refuse(`${name} handlers cannot be set; use on() instead`);
  if (name === OWNER_ATTRIBUTE) return refuse(OWNER_ATTRIBUTE_REASON);
  let value = String(input.value);
  if (isMediatedUrlAttribute(input.tag, name)) {
    const url = urlDecision(input.value, input.url);
    if (url.kind === "refuse") return refuse(`${name} ${url.reason}`);
    value = url.href;
  } else if (name === "style") {
    return refuse("the style attribute cannot be set; use style() instead");
  } else if (ATTR_REFUSE.has(name)) {
    return refuse(`the ${name} attribute cannot be set by a remixlet`);
  }
  if (input.pageElement) {
    const mark = pageAttributeDecision(name, input.pageElement.remixletId);
    if (mark.kind === "refuse") return mark;
  }
  return { kind: "allow", value };
}

// ---------------------------------------------------------------------------
// Marks (shared/marks.ts): what a remixlet may write on the page's own elements

/**
 * An attribute set or removed on one of the page's own elements must be a
 * mark carrying the box's prefix: `data-<prefix>` or `data-<prefix>-…`. This
 * covers `hidden`, `disabled`, `id`, `data-*` and every other name alike:
 * a remixlet hides host content with a prefixed class and a CSS rule, never
 * with an attribute the page could have written itself.
 */
export function pageAttributeDecision(name: string, remixletId: string): PolicyDecision {
  if (attributeMarkedBy(name, remixletId)) return ALLOW;
  const prefix = markPrefix(remixletId);
  return refuse(
    `${name} cannot be written on the page's own element: attributes a remixlet writes there must be named ` +
      `data-${prefix} or data-${prefix}-<name> (rmx.prefix is "${prefix}"); elements the remixlet created or cloned take any attribute`,
  );
}

/** removeAttr: the same element and mark rules as setAttr, minus the value checks. */
export function removeAttributeDecision(tag: string, name: string, pageElement: PageElementWrite | undefined): PolicyDecision {
  const attribute = String(name).trim().toLowerCase();
  if (attribute === "") return refuse("an attribute needs a name");
  const element = existingElementWriteDecision(tag);
  if (element.kind === "refuse") return element;
  if (attribute === OWNER_ATTRIBUTE) return refuse(OWNER_ATTRIBUTE_REASON);
  return pageElement ? pageAttributeDecision(attribute, pageElement.remixletId) : ALLOW;
}

/** Classes added, removed or toggled on one of the page's own elements must all carry the box's prefix. */
export function classWriteDecision(names: readonly string[], pageElement: PageElementWrite | undefined): PolicyDecision {
  if (!pageElement) return ALLOW;
  for (const name of names) {
    if (classMarkedBy(name, pageElement.remixletId)) continue;
    const prefix = markPrefix(pageElement.remixletId);
    return refuse(
      `class "${name}" cannot be written on the page's own element: classes a remixlet writes there must be named ` +
        `${prefix} or ${prefix}-<name> (rmx.prefix is "${prefix}"); elements the remixlet created or cloned take any class`,
    );
  }
  return ALLOW;
}

/** Whether `element` is one the box created or cloned (it or an ancestor carries the box's owner stamp). */
export function isOwnedBy(element: Element, remixletId: string): boolean {
  return element.closest(`[${OWNER_ATTRIBUTE}="${remixletId}"]`) !== null;
}

/** Stamp an element the box built; every mark it then carries names its owner. */
export function stampOwner(element: Element, remixletId: string): void {
  element.setAttribute(OWNER_ATTRIBUTE, remixletId);
}

function describeUrl(raw: string): string {
  const text = String(raw).trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text || "an empty value";
}

// ---------------------------------------------------------------------------
// URLs

const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i;

/**
 * What URL vetting judges a URL against. The agent builds one per decision:
 * the page's current URL, the document's base URL at that moment, the box's
 * manifest matches and granted host patterns, and the page's own resource
 * hosts read lazily (only an off-site, un-granted URL pays for the collection).
 */
export interface UrlContext {
  pageUrl: string;
  /**
   * `document.baseURI` when the decision is made: what the BROWSER resolves a
   * relative URL against, which a page's `<base href>` can point at another
   * origin. Vetting resolves the same way, so the check and the load agree.
   */
  baseUrl: string;
  matches: readonly string[];
  /**
   * Host patterns from granted `fetch:` capabilities alone
   * (BoxRemixletSpec.grantedHosts). A `network:observe:` grant is absent on
   * purpose: permission to watch a host's responses is not permission to make
   * new requests to it.
   */
  grantedHosts: readonly string[];
  /** The exact absolute URLs the page itself already loads, fragment removed; see pageResourceUrls. */
  pageUrls: () => ReadonlySet<string>;
}

/** An allowed URL carries the absolute form to write; the raw string is never what reaches the DOM. */
export type UrlDecision = { kind: "allow"; href: string } | Refusal;

const URL_RULE =
  "must point at this site, a site in the remixlet's matches, a host a fetch: grant names, a URL the page " +
  "already loads exactly as written, or a data:image URL; for a new URL on another host, request a fetch: " +
  "capability for that host";

/**
 * A URL a remixlet may point the page at, and the absolute form of it the
 * caller must write. Resolution follows the browser: a relative URL is
 * resolved against the DOCUMENT BASE (`document.baseURI`), which a page's
 * `<base href>` can aim at another origin, not against the page URL. The
 * result must then be same-origin with the PAGE (the page's own origin is what
 * "this site" means, so a hostile base cannot make an off-origin URL count as
 * same-origin), fall under the manifest matches' hosts (origin-wide, so a
 * path-limited match still admits the host's other pages), satisfy a granted
 * `fetch:` host pattern (the user approved sending data to that host for this
 * remixlet), be a URL the page already loads EXACTLY as written (the page
 * shows it already, so pointing at it again tells nobody anything new;
 * see pageResourceUrls), or be a data:image/* URL. Only http(s) resolves at
 * all: javascript:, blob:, file: and friends are refused by construction. See
 * wiki/design/mediated-execution-compatibility.md for the history of the last
 * two rules.
 *
 * Callers write `href`, never the string they were handed: a protocol-relative
 * `//host/x` and a relative `/x` are both judged and stored as the one URL the
 * browser would have loaded, so a base element that changes after the decision
 * changes nothing.
 */
export function urlDecision(raw: string, ctx: UrlContext): UrlDecision {
  const text = String(raw).trim();
  const no = (): Refusal => refuse(`${URL_RULE} (got ${describeUrl(raw)})`);
  if (text === "") return no();
  // A data:image value is its own destination: no resolution, written as given.
  if (/^data:/i.test(text)) return DATA_IMAGE_RE.test(text) ? { kind: "allow", href: text } : no();
  let page: URL;
  let resolved: URL;
  try {
    page = new URL(ctx.pageUrl);
    resolved = new URL(text, baseUrlOf(ctx, page));
  } catch {
    return no();
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return no();
  if (resolved.origin === page.origin) return { kind: "allow", href: resolved.href };
  if (urlMatchesAny(resolved.href, originWidePatterns(ctx.matches))) return { kind: "allow", href: resolved.href };
  if (ctx.grantedHosts.some((pattern) => urlMatchesFetchHostPattern(resolved, pattern))) return { kind: "allow", href: resolved.href };
  return ctx.pageUrls().has(pageUrlKey(resolved)) ? { kind: "allow", href: resolved.href } : no();
}

/** The document base when there is a usable one, else the page URL (a document without a base resolves against its own URL). */
function baseUrlOf(ctx: UrlContext, page: URL): URL {
  try {
    return new URL(ctx.baseUrl);
  } catch {
    return page;
  }
}

/** urlDecision as a predicate, for callers that judge a URL without writing one (clicks, tests). */
export function urlAllowed(raw: string, ctx: UrlContext): boolean {
  return urlDecision(raw, ctx).kind === "allow";
}

/**
 * How a URL is compared against the page's own: the whole absolute URL, minus
 * the fragment (which never reaches the network, so two URLs differing only
 * there are one request). Scheme, host, port, path and query all count: a
 * different path, or one extra query parameter, is a different request, which
 * is the point of the rule.
 */
function pageUrlKey(url: URL): string {
  const bare = new URL(url.href);
  bare.hash = "";
  return bare.href;
}

/** Elements whose URL attribute names a resource the page loads (attribute per tag: href on link, src elsewhere). */
const PAGE_RESOURCE_SELECTOR = 'img[src], source[src], link[rel~="stylesheet"][href], script[src], video[src], iframe[src]';

/**
 * The exact URLs the page itself already loads: every resource timing entry
 * plus the URL attribute of every current `img`, `source`, stylesheet `link`,
 * `script`, `video` and `iframe`, http(s) only, keyed by pageUrlKey. A live
 * read; the agent caches it briefly.
 *
 * This was once a set of ORIGINS, which assumed a host the page loads from is
 * a host the attacker does not control. That is false on any site showing
 * user-supplied images from outside hosts (forums, chats, blogs with hotlinked
 * images): one posted image would make its whole host a destination for page
 * data. Exact URLs keep the case the rule exists for, showing a thumbnail the
 * site already shows, while refusing a constructed URL that carries page data
 * (wiki/ops/2026-09-12-security-review-plan.md, F2).
 *
 * Attribute values resolve against the page's own URL, NOT `document.baseURI`:
 * this set is an allowance, and a page that points `<base href>` at another
 * origin would otherwise mint URLs here out of its own relative ones, handing
 * back what urlDecision just refused. A resource the page really did load
 * through such a base is recorded by resource timing, which carries the
 * absolute URL of the request that actually happened.
 */
export function pageResourceUrls(document: Document, window: Window): Set<string> {
  const urls = new Set<string>();
  const add = (raw: string): void => {
    let url: URL;
    try {
      url = new URL(raw, document.URL);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    urls.add(pageUrlKey(url));
  };
  for (const entry of window.performance.getEntriesByType("resource")) add(entry.name);
  for (const element of Array.from(document.querySelectorAll(PAGE_RESOURCE_SELECTOR))) {
    add(element.getAttribute(element.localName === "link" ? "href" : "src") ?? "");
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Styles

const STYLE_REFUSED_TOKENS = ["url(", "image-set(", "@import", "expression(", "src(", "behavior:", "-moz-binding:"];

/**
 * Fold the spellings CSS accepts for one token into one: comments removed,
 * backslash escapes decoded (`\75 rl(` is `url(`), whitespace before `(` and
 * `:` dropped, lowercased. Anything the page would parse as `url(` reads as
 * `url(` here.
 */
export function normalizeCss(value: string): string {
  return String(value)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\([\s\S])/g, "$1")
    .replace(/\0/g, "")
    .replace(/\s+\(/g, "(")
    .replace(/\s+:/g, ":")
    .toLowerCase();
}

/** A style value (or `prop:value` pair) that reaches no network. */
export function styleValueAllowed(value: string): boolean {
  const normalized = normalizeCss(value);
  return !STYLE_REFUSED_TOKENS.some((token) => normalized.includes(token));
}

/** Same test for a whole stylesheet; caller caps the length. */
export function cssTextAllowed(css: string): boolean {
  return styleValueAllowed(css);
}

export function styleDecision(value: string): PolicyDecision {
  return styleValueAllowed(value)
    ? ALLOW
    : refuse("styles cannot load resources: no url(), image-set(), @import, src() or expression()");
}

// ---------------------------------------------------------------------------
// Text writes into existing elements

/**
 * setText/setHTML target a live element; two tags make text itself active.
 * Script contents are never written (they would not run, but a page could
 * clone them into life); style contents pass the stylesheet test.
 */
export function textWriteDecision(tag: string, text: string): PolicyDecision {
  const name = tag.toLowerCase();
  if (name === "script") return refuse("script contents cannot be written");
  if (name === "style") return styleDecision(text);
  return ALLOW;
}

// ---------------------------------------------------------------------------
// HTML

export interface SanitizeContext {
  /** The document the fragment is imported into (the page's). */
  document: Document;
  url: UrlContext;
}

export type SanitizeResult = { kind: "allow"; fragment: DocumentFragment } | { kind: "refuse"; reason: string };

/**
 * Parse untrusted markup in an inert document, keep only allowed tags and
 * attributes, vet URL and style attributes, then import the survivors into
 * the page's document. Refused tags are dropped with their subtree; refused
 * attributes are stripped. The nodes are imported, never re-serialized, so
 * the page parses nothing a second time.
 */
export function sanitizeHtml(html: string, ctx: SanitizeContext): SanitizeResult {
  const text = String(html);
  if (text.length > HTML_WRITE_CAP) return { kind: "refuse", reason: `HTML longer than ${HTML_WRITE_CAP} characters` };
  const inert = ctx.document.implementation.createHTMLDocument("");
  inert.body.innerHTML = text;
  sanitizeChildren(inert.body, ctx, noNotes);
  const fragment = ctx.document.createDocumentFragment();
  for (const child of Array.from(inert.body.childNodes)) fragment.append(ctx.document.importNode(child, true));
  return { kind: "allow", fragment };
}

/** Where the sanitiser reports each thing it removed; setHTML has no reader for that, clone does. */
type Note = (line: string) => void;
const noNotes: Note = () => {};

function sanitizeChildren(parent: Node, ctx: SanitizeContext, note: Note): void {
  for (const child of Array.from(parent.childNodes)) {
    if (isElementNode(child)) {
      if (createTagDecision(child.localName).kind === "refuse") {
        note(`dropped <${child.localName}> and everything inside it`);
        child.remove();
        continue;
      }
      sanitizeAttributes(child, ctx, note);
      sanitizeChildren(child, ctx, note);
    } else if (child.nodeType !== 3) {
      // Comments, processing instructions, CDATA: nothing a remixlet needs to write.
      child.parentNode?.removeChild(child);
    }
  }
}

/** nodeType 1 is ELEMENT_NODE. */
function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function sanitizeAttributes(element: Element, ctx: SanitizeContext, note: Note): void {
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (name === "style") {
      if (!styleValueAllowed(attr.value)) {
        note(`removed the style attribute from <${element.localName}> (it loads a resource)`);
        element.removeAttribute(attr.name);
      }
      continue;
    }
    const decision = attributeDecision({ tag: element.localName, name, value: attr.value, url: ctx.url });
    if (decision.kind === "refuse") {
      note(`removed ${name} from <${element.localName}> (${describeUrl(attr.value)})`);
      element.removeAttribute(attr.name);
      continue;
    }
    // The vetted value, not the markup's own: a src/href in written or cloned
    // markup is stored absolute, so the page's base element cannot redirect it
    // between this decision and the load.
    if (decision.value !== attr.value) element.setAttribute(attr.name, decision.value);
  }
}

// ---------------------------------------------------------------------------
// Clones

export interface CloneContext extends SanitizeContext {
  /** Keep `id` and `for`; off by default because a duplicate id breaks the host's own labels. */
  keepIds: boolean;
}

export type CloneSanitizeResult = { kind: "allow"; element: Element; notes: string[] } | { kind: "refuse"; reason: string };

/**
 * A deep copy of a host element that a remixlet could have built itself: the
 * root's tag must be one `create` allows (a copy of the page's own <form> is
 * still a form), the subtree is bounded by CREATE_TREE_CAP, and the copy is
 * made in an inert document (no image loads, no custom-element upgrades while
 * it is vetted), sanitised exactly as setHTML markup is, then imported into the
 * page detached. cloneNode never copies listeners, so neither does this. Every
 * removal is answered as a note so the author can see what the copy lost.
 */
export function sanitizeClone(source: Element, ctx: CloneContext): CloneSanitizeResult {
  const tag = source.localName;
  const decision = createTagDecision(tag);
  if (decision.kind === "refuse") return { kind: "refuse", reason: `cannot clone a <${tag}>: ${decision.reason}` };
  const size = 1 + source.querySelectorAll("*").length;
  if (size > CREATE_TREE_CAP) return { kind: "refuse", reason: `clone would copy ${size} nodes; the limit is ${CREATE_TREE_CAP}` };
  const notes: string[] = [];
  let overflow = 0;
  const note: Note = (line) => {
    if (notes.length < CLONE_NOTES_CAP) notes.push(line);
    else overflow += 1;
  };
  const inert = ctx.document.implementation.createHTMLDocument("");
  const copy = inert.importNode(source, true);
  sanitizeAttributes(copy, ctx, note);
  sanitizeChildren(copy, ctx, note);
  if (!ctx.keepIds) {
    for (const element of [copy, ...Array.from(copy.querySelectorAll("[id], [for]"))]) {
      for (const name of ["id", "for"]) {
        const value = element.getAttribute(name);
        if (value === null) continue;
        note(`dropped ${name}="${describeUrl(value)}" from <${element.localName}>`);
        element.removeAttribute(name);
      }
    }
  }
  if (overflow > 0) notes.push(`and ${overflow} more`);
  return { kind: "allow", element: ctx.document.importNode(copy, true), notes };
}

// ---------------------------------------------------------------------------
// Clicks

/** The controls a click's activation lands on when the clicked element is not one itself. */
const ACTIVATION_SELECTOR = 'button, input[type="submit" i], input[type="image" i]';

/**
 * A synthetic click is a navigation or a submit when the page wires it as
 * one, so a click is judged by WHAT IT ACTIVATES, not by the element the
 * caller named. A click on a `<span>` inside a submit button activates that
 * button, and a click inside a `<label>` is forwarded to the label's control,
 * both of which used to walk past the form check and submit an off-site form
 * whose submit button a direct click was refused on
 * (wiki/ops/2026-09-12-security-review-plan.md, F3). So the activation target
 * is resolved first, and the three checks below run against the clicked
 * element AND that target: either one under an off-site link, carrying
 * formaction, or acting as the submit control of an off-site form refuses the
 * whole click.
 *
 * The href and the action are judged the way the browser would resolve them
 * at this moment: the caller builds the context per click, so a relative
 * target is measured against the document's current base, not the page URL.
 * Same-origin clicks, clicks inside the remixlet's matches, clicks on a host
 * a `fetch:` grant names and a submit of a form with no action all stay
 * allowed: the off-site check is the whole boundary, and a site's own button
 * is the site's own business.
 */
export function clickDecision(element: Element, url: UrlContext): PolicyDecision {
  for (const target of clickTargets(element)) {
    const decision = activationDecision(target, url);
    if (decision.kind === "refuse") return decision;
  }
  return ALLOW;
}

/**
 * The clicked element plus every control its activation can reach: the
 * control of an enclosing `<label>` (`label.control` answers both the `for=`
 * form and a nested control, and that control can live anywhere in the
 * document, so its own ancestry is judged too) and the nearest enclosing
 * button or submit input.
 */
function clickTargets(element: Element): Element[] {
  const targets: Element[] = [element];
  const add = (candidate: Element | null | undefined): void => {
    if (candidate && !targets.includes(candidate)) targets.push(candidate);
  };
  add(element.closest("label")?.control);
  add(element.closest(ACTIVATION_SELECTOR));
  return targets;
}

/** The three destination checks, run against one element the click activates. */
function activationDecision(element: Element, url: UrlContext): PolicyDecision {
  if (element.closest("[formaction]")) return refuse("clicking an element with formaction would submit a form elsewhere");
  const link = element.closest("a[href], area[href]");
  if (link) {
    const href = link.getAttribute("href") ?? "";
    if (!urlAllowed(href, url)) {
      return refuse(`clicking this would navigate off-site (${describeUrl(href)})`);
    }
  }
  if (isSubmitControl(element)) {
    const form = element.form ?? element.closest("form");
    const action = form?.getAttribute("action");
    if (form && action !== null && action !== undefined && action.trim() !== "" && !urlAllowed(action, url)) {
      return refuse(`clicking this would submit a form off-site (${describeUrl(action)})`);
    }
  }
  return ALLOW;
}

function isSubmitControl(element: Element): element is HTMLButtonElement | HTMLInputElement {
  const tag = element.localName;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  if (tag === "button") return type === "" || type === "submit";
  if (tag === "input") return type === "submit" || type === "image";
  return false;
}
