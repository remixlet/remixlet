// Resolution core for the annotate-page overlay (annotate-host-content.ts):
// selections and arrow heads in client coordinates → DOM facts (selectors,
// insertion anchors, plain-language readouts). Pure DOM, no extension APIs,
// so the browser test harness can exercise it on a plain page (the annotate
// browser suite).
//
// The v2 flow is selection-first: a mark is created by dragging a box or
// clicking a snap-highlighted element, and an arrow always belongs to a mark
// (its sources are the mark's elements). Guarantees the overlay depends on:
// - An arrow's target never resolves to a marked element itself or anything
//   inside it — the resolver climbs past the sources to what's underneath.
// - A head that lands in empty space away from its reference keeps that fact
//   (HeadPlacement): alignment set by CSS is invisible to a DOM anchor alone.
// - Readout names stay distinguishable: repeated words are collapsed and
//   same-named elements get their selector tail appended.

import {
  describeHeadZone,
  type AnnotatedElement,
  type ElementFeatures,
  type HeadPlacement,
  type InsertionAnchor,
  type InsertPosition,
} from "../shared/annotation.js";
import { identifierDurability } from "../shared/selector-durability.js";
import { stableSelectorWithDurability } from "../shared/stable-selector.js";

/** Elements never resolved to: our own chrome, and the document shell. */
const SKIP_TAGS = new Set(["HTML", "BODY"]);
/** Cap on elements listed per mark; the rest is reported as a count. */
export const BOX_ELEMENT_CAP = 8;
/** A box covers an element when at least this share of it is inside. */
const BOX_COVERAGE = 0.7;
/** Heads at least this far (px) from the reference record their landing spot. */
const HEAD_GAP_PX = 48;
/** Snap labels keep at most this much of the element's text. */
const SNAP_LABEL_TEXT_CAP = 18;

export interface Point {
  x: number;
  y: number;
}

export interface BoxResolution {
  annotation: { elements: AnnotatedElement[]; overflow: number };
  summary: string;
  /** Live resolved elements (listed ones only), for highlights and geometry. */
  elements: Element[];
}

/** The element a click would snap to, for the hover highlight. */
export interface SnapCandidate {
  element: Element;
  /** Short human label for the hover tag ("button · Follow"). */
  label: string;
}

export interface ArrowTargetResolution {
  anchor: InsertionAnchor;
  summary: string;
}

export interface AnnotationResolver {
  /** Smallest annotatable element under the cursor, for hover snapping. */
  snapAt(clientX: number, clientY: number): SnapCandidate | undefined;
  /** A click-snapped selection: the mark is exactly this element. */
  resolveElement(element: Element): BoxResolution;
  resolveBoxStroke(left: number, top: number, width: number, height: number): BoxResolution | undefined;
  /** Where an arrow from a mark's `sources` should land. */
  resolveArrowTarget(head: Point, sources: Element[]): ArrowTargetResolution;
}

function textPreview(element: Element): string {
  const words = (element.textContent ?? "").replace(/\s+/g, " ").trim().split(" ");
  // Consecutive duplicate words are DOM noise (a visually-hidden label
  // repeating its toggle's text) — collapse them so previews read cleanly.
  return words.filter((word, index) => word !== words[index - 1]).join(" ").slice(0, 40);
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
/** data-* values longer than this are payloads (serialized state), not names. */
const FEATURE_VALUE_CAP = 40;
const FEATURE_ATTRIBUTE_CAP = 3;

/**
 * Durable recognition features read off the element now, so a later turn can
 * re-find it after its selector rots (generated ids change every reload).
 */
function collectFeatures(element: Element): ElementFeatures | undefined {
  const features: ElementFeatures = {};
  const headingElement = element.matches(HEADING_SELECTOR) ? element : element.querySelector(HEADING_SELECTOR);
  const heading = headingElement ? textPreview(headingElement) : "";
  if (heading.length > 0) features.heading = heading;
  const label = element.getAttribute("aria-label") ?? element.getAttribute("title");
  if (label && label.trim().length > 0) features.label = label.trim().slice(0, 60);
  const role = element.getAttribute("role");
  if (role) features.role = role;
  const link = element.matches("a[href]") ? element : element.querySelector("a[href]");
  const href = link?.getAttribute("href") ?? "";
  if (href.length > 0 && !href.startsWith("javascript:")) features.href = href.slice(0, 80);
  const attributes: string[] = [];
  for (const attribute of element.attributes) {
    if (!attribute.name.startsWith("data-")) continue;
    if (attribute.value.length === 0 || attribute.value.length > FEATURE_VALUE_CAP) continue;
    // Only human-named pairs qualify — a hashed value is the rot being escaped.
    if (identifierDurability(attribute.name) !== "stable" || identifierDurability(attribute.value) !== "stable") continue;
    attributes.push(`${attribute.name}="${attribute.value}"`);
    if (attributes.length === FEATURE_ATTRIBUTE_CAP) break;
  }
  if (attributes.length > 0) features.attributes = attributes;
  return Object.keys(features).length > 0 ? features : undefined;
}

function describe(element: Element): AnnotatedElement {
  const { selector, durability } = stableSelectorWithDurability(element);
  const described: AnnotatedElement = {
    selector,
    durability,
    tag: element.tagName.toLowerCase(),
    textPreview: textPreview(element),
  };
  const features = collectFeatures(element);
  if (features) described.features = features;
  return described;
}

/** Short human name for the readout line ("button “Follow”"). */
function humanName(element: AnnotatedElement): string {
  return element.textPreview.length > 0 ? `${element.tag} “${element.textPreview}”` : element.tag;
}

function selectorTail(selector: string): string {
  const segments = selector.split(" > ");
  return segments[segments.length - 1] ?? selector;
}

/**
 * Readout names for elements shown together in one line: when two resolve to
 * the same name (nested containers sharing text), each gets its selector tail
 * so "which one" stays answerable.
 */
function distinctNames(elements: (AnnotatedElement | undefined)[]): (string | undefined)[] {
  const names = elements.map((element) => (element ? humanName(element) : undefined));
  return names.map((name, index) => {
    if (name === undefined) return undefined;
    if (!names.some((other, j) => j !== index && other === name)) return name;
    return `${name} (${selectorTail(elements[index]!.selector)})`;
  });
}

export function createAnnotationResolver(skipIds: string[]): AnnotationResolver {
  const skipSelector = skipIds.map((id) => `#${id}`).join(", ");

  function elementsAtPoint(clientX: number, clientY: number): Element[] {
    return document.elementsFromPoint(clientX, clientY).filter((element) => {
      if (SKIP_TAGS.has(element.tagName)) return false;
      if (skipIds.includes(element.id)) return false;
      return skipSelector.length === 0 || !element.closest(skipSelector);
    });
  }

  function topElementAt(clientX: number, clientY: number, exclude: Element[] = []): Element | undefined {
    return elementsAtPoint(clientX, clientY).find(
      (element) => !exclude.some((source) => source === element || source.contains(element)),
    );
  }

  function snapAt(clientX: number, clientY: number): SnapCandidate | undefined {
    const element = topElementAt(clientX, clientY);
    if (!element) return undefined;
    const described = describe(element);
    const text = described.textPreview.slice(0, SNAP_LABEL_TEXT_CAP);
    return { element, label: text.length > 0 ? `${described.tag} · ${text}` : described.tag };
  }

  /**
   * Elements a box selects: everything mostly inside it, reduced to the
   * highest ancestors (a box over a card means the card, not its 12 children).
   * An empty hit falls back to the element under the box center, so a box
   * drawn smaller than its target still selects it.
   */
  function resolveBox(clientLeft: number, clientTop: number, width: number, height: number): Element[] {
    const candidates = new Set<Element>();
    const STEPS = 6;
    for (let ix = 0; ix <= STEPS; ix += 1) {
      for (let iy = 0; iy <= STEPS; iy += 1) {
        for (const element of elementsAtPoint(clientLeft + (width * ix) / STEPS, clientTop + (height * iy) / STEPS)) {
          candidates.add(element);
        }
      }
    }
    const right = clientLeft + width;
    const bottom = clientTop + height;
    const covered = [...candidates].filter((element) => {
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area <= 0) return false;
      const ix = Math.max(0, Math.min(right, rect.right) - Math.max(clientLeft, rect.left));
      const iy = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(clientTop, rect.top));
      return (ix * iy) / area >= BOX_COVERAGE;
    });
    const topmost = covered.filter(
      (element) => !covered.some((other) => other !== element && other.contains(element)),
    );
    if (topmost.length === 0) {
      const fallback = topElementAt(clientLeft + width / 2, clientTop + height / 2);
      return fallback ? [fallback] : [];
    }
    return topmost.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  /** Whether `container` lays its children out top-to-bottom (vs in a row). */
  function stacksVertically(container: Element, reference: Element): boolean {
    const style = getComputedStyle(container);
    if (style.display.includes("flex")) return style.flexDirection.startsWith("column");
    const siblings = [...container.children];
    const at = siblings.indexOf(reference);
    const neighbor = siblings[at + 1] ?? siblings[at - 1];
    if (neighbor) {
      const a = reference.getBoundingClientRect();
      const b = neighbor.getBoundingClientRect();
      if (Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) >= 2) return false;
    }
    return true;
  }

  function positionRelativeTo(container: Element, reference: Element, clientX: number, clientY: number): InsertPosition {
    const rect = reference.getBoundingClientRect();
    return stacksVertically(container, reference)
      ? clientY < rect.top + rect.height / 2
        ? "before"
        : "after"
      : clientX < rect.left + rect.width / 2
        ? "before"
        : "after";
  }

  function gapToElement(element: Element, point: Point): number {
    const rect = element.getBoundingClientRect();
    const gapX = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
    const gapY = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
    return Math.round(Math.hypot(gapX, gapY));
  }

  /**
   * The head's landing spot inside the container, kept only when it landed in
   * empty space: away from the reference when the anchor has one, else away
   * from the marked elements being moved (a head on the anchor element itself
   * needs no note — the DOM anchor already says everything).
   */
  function headPlacement(
    container: Element,
    reference: Element | undefined,
    head: Point,
    sources: Element[],
  ): HeadPlacement | undefined {
    const referenceGapPx = reference ? gapToElement(reference, head) : undefined;
    const sourceGapPx = sources.length > 0 ? Math.min(...sources.map((source) => gapToElement(source, head))) : undefined;
    const inEmptySpace = referenceGapPx !== undefined ? referenceGapPx >= HEAD_GAP_PX : (sourceGapPx ?? 0) >= HEAD_GAP_PX;
    if (!inEmptySpace) return undefined;
    const rect = container.getBoundingClientRect();
    const fx = rect.width > 0 ? (head.x - rect.left) / rect.width : 0.5;
    const fy = rect.height > 0 ? (head.y - rect.top) / rect.height : 0.5;
    const placement: HeadPlacement = {
      zoneX: fx < 1 / 3 ? "left" : fx > 2 / 3 ? "right" : "center",
      zoneY: fy < 1 / 3 ? "top" : fy > 2 / 3 ? "bottom" : "middle",
    };
    if (referenceGapPx !== undefined) placement.referenceGapPx = referenceGapPx;
    if (sourceGapPx !== undefined) placement.sourceGapPx = sourceGapPx;
    return placement;
  }

  /**
   * Where an arrow head points, as a DOM insertion anchor. Landing on an
   * element anchors before/after it among its real siblings (climbing out of
   * single-child wrappers first); landing in a container's own padding or gap
   * anchors relative to its nearest child. The marked elements themselves are
   * never a valid landing: hits on or inside `exclude` fall through to what
   * is underneath, so "move X into X" cannot resolve.
   */
  function resolveInsertion(head: Point, exclude: Element[]): InsertionAnchor {
    const excluded = (element: Element): boolean =>
      exclude.some((source) => source === element || source.contains(element));
    const withHead = (container: Element, reference: Element | undefined, position: InsertPosition): InsertionAnchor => {
      const placement = headPlacement(container, reference, head, exclude);
      const anchor: InsertionAnchor = {
        container: describe(container),
        position,
      };
      if (reference) anchor.reference = describe(reference);
      if (placement) anchor.head = placement;
      return anchor;
    };

    let hit = topElementAt(head.x, head.y, exclude);
    if (!hit) return { container: describe(document.body), position: "inside-end" };
    if (hit.childElementCount > 0) {
      let nearest: Element | undefined;
      let nearestDistance = Infinity;
      for (const child of hit.children) {
        if (excluded(child)) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) continue;
        const dx = head.x - (rect.left + rect.width / 2);
        const dy = head.y - (rect.top + rect.height / 2);
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = child;
        }
      }
      // No eligible child (e.g. every child is being moved): the head still
      // landed somewhere in this container — keep that spot.
      if (!nearest) return withHead(hit, undefined, "inside-end");
      return withHead(hit, nearest, positionRelativeTo(hit, nearest, head.x, head.y));
    }
    while (hit.parentElement && hit.parentElement !== document.body && hit.parentElement.childElementCount === 1) {
      hit = hit.parentElement;
    }
    const container = hit.parentElement ?? document.body;
    return withHead(container, hit, positionRelativeTo(container, hit, head.x, head.y));
  }

  /** "the left end of <container> (before <reference>)" — readout phrasing. */
  function anchorPhrase(anchor: InsertionAnchor, containerName: string, referenceName: string | undefined): string {
    const hasReference = anchor.reference !== undefined && anchor.position !== "inside-end" && referenceName !== undefined;
    if (anchor.head) {
      const spot = `the ${describeHeadZone(anchor.head)} of ${containerName}`;
      return hasReference ? `${spot} (${anchor.position} ${referenceName})` : spot;
    }
    return hasReference ? `${anchor.position} ${referenceName} in ${containerName}` : `at the end of ${containerName}`;
  }

  function summarizeSelection(annotation: BoxResolution["annotation"], total: number): string {
    // SAFETY: distinctNames returns names for the described selected elements.
    const names = distinctNames(annotation.elements) as string[];
    return total === 1
      ? `Selected ${names[0]}`
      : `Selected ${total} elements: ${names.slice(0, 3).join(", ")}${total > 3 ? ", …" : ""}`;
  }

  function resolveElement(element: Element): BoxResolution {
    const annotation = { elements: [describe(element)], overflow: 0 };
    return { annotation, summary: summarizeSelection(annotation, 1), elements: [element] };
  }

  function resolveBoxStroke(left: number, top: number, width: number, height: number): BoxResolution | undefined {
    const elements = resolveBox(left, top, width, height);
    if (elements.length === 0) return undefined;
    const listed = elements.slice(0, BOX_ELEMENT_CAP);
    const annotation = { elements: listed.map(describe), overflow: elements.length - listed.length };
    return { annotation, summary: summarizeSelection(annotation, elements.length), elements: listed };
  }

  function resolveArrowTarget(head: Point, sources: Element[]): ArrowTargetResolution {
    const anchor = resolveInsertion(head, sources);
    const [containerName, referenceName] = distinctNames([anchor.container, anchor.reference]);
    const summary = `Arrow → ${anchorPhrase(anchor, containerName!, referenceName)}`;
    return { anchor, summary };
  }

  return { snapAt, resolveElement, resolveBoxStroke, resolveArrowTarget };
}
