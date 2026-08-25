// Best-effort stable CSS selector generation for the draw-on-page spike
// (wiki/design/spike-d-draw-on-page.md). Runs in the page (called from the
// annotate overlay content script); pure DOM, no extension APIs.
//
// Selection is a preference ladder over durability tiers (see
// shared/selector-durability.ts), not a binary accept/reject: many pages
// only offer generated identifiers, and a volatile selector that matches
// now still beats none. Ladder, best first:
//   1. unique id that reads human-named ("stable")
//   2. semantic attribute with a stable value
//   3. ancestor path from tag + stable classes, no positional segments
//   4. iffy id / attribute / path (positional :nth-of-type counts as iffy)
//   5. volatile id / attribute — last resort, unique today only
//   6. the best path found, even non-unique
// The chosen tier rides along so callers can caveat anything below "stable"
// (the annotate flow tells the model such a selector may not survive a
// reload and hands it durable features to match instead).
//
// A self-contained twin lives in probeHelpers (src/worker/page-probes/
// probes.ts stableSelectorFor): probe code crosses into the page via
// fn.toString() and cannot import this module — keep the preference order in
// sync when changing either.

import { identifierDurability, worstDurability, type Durability } from "./selector-durability.js";

const SEMANTIC_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "name", "aria-label", "role"];

/** Class names longer than this bloat selectors even when they read stable. */
const CLASS_LENGTH_CAP = 24;

export interface SelectorChoice {
  selector: string;
  /** How likely the selector survives a page reload. */
  durability: Durability;
}

function cssEscape(value: string): string {
  const escape = globalThis.CSS?.escape;
  return escape ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function attrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function matchesUniquely(document: Document, selector: string, element: Element): boolean {
  try {
    const matched = document.querySelectorAll(selector);
    return matched.length === 1 && matched[0] === element;
  } catch {
    return false;
  }
}

interface PathSegment {
  segment: string;
  durability: Durability;
}

/** tag + up to two stable classes, plus :nth-of-type when siblings still tie (positional → iffy). */
function segmentFor(element: Element): PathSegment {
  const tag = element.tagName.toLowerCase();
  const classes = [...element.classList]
    .filter((name) => name.length <= CLASS_LENGTH_CAP && identifierDurability(name) === "stable")
    .slice(0, 2);
  let segment = tag + classes.map((name) => `.${cssEscape(name)}`).join("");
  const parent = element.parentElement;
  if (!parent) return { segment, durability: "stable" };
  const peers = [...parent.children].filter((sibling) => {
    try {
      return sibling.matches(segment);
    } catch {
      return sibling.tagName === element.tagName;
    }
  });
  if (peers.length > 1) {
    const sameTag = [...parent.children].filter((sibling) => sibling.tagName === element.tagName);
    segment = `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
    return { segment, durability: "iffy" };
  }
  return { segment, durability: "stable" };
}

interface PathChoice extends SelectorChoice {
  unique: boolean;
}

/** Shortest ancestor path that matches uniquely, tracking the weakest tier used along it. */
function buildPath(element: Element): PathChoice {
  const document = element.ownerDocument;
  const segments: string[] = [];
  let durability: Durability = "stable";
  let fallback: PathChoice | undefined;
  const keepBest = (choice: PathChoice): void => {
    const strictlyBetter =
      fallback !== undefined &&
      fallback.durability !== choice.durability &&
      worstDurability(fallback.durability, choice.durability) === fallback.durability;
    if (!fallback || strictlyBetter) fallback = choice;
  };
  let current: Element | null = element;
  while (current && current !== document.documentElement && segments.length < 6) {
    const { segment, durability: segmentDurability } = segmentFor(current);
    segments.unshift(segment);
    durability = worstDurability(durability, segmentDurability);
    const selector = segments.join(" > ");
    if (matchesUniquely(document, selector, element)) {
      const choice = { selector, durability, unique: true };
      if (durability === "stable") return choice;
      keepBest(choice);
    }
    // An ancestor with a unique id anchors the path without walking further —
    // but the anchor is only as durable as that id.
    const parent: Element | null = current.parentElement;
    if (parent?.id) {
      const anchored = `#${cssEscape(parent.id)} > ${segments.join(" > ")}`;
      if (matchesUniquely(document, anchored, element)) {
        const anchoredDurability = worstDurability(durability, identifierDurability(parent.id));
        const choice = { selector: anchored, durability: anchoredDurability, unique: true };
        if (anchoredDurability === "stable") return choice;
        keepBest(choice);
      }
    }
    current = parent;
  }
  return fallback ?? { selector: segments.join(" > "), durability: worstDurability(durability, "volatile"), unique: false };
}

/**
 * The most durable selector that currently matches exactly `element`, walking
 * the ladder in the module docstring; a non-unique best-effort path only when
 * nothing matched uniquely. Callers surface selectors to the agent, which
 * re-verifies them with probes before relying on them; anything below
 * "stable" deserves a caveat where it is shown.
 */
export function stableSelectorWithDurability(element: Element): SelectorChoice {
  const document = element.ownerDocument;

  const id: SelectorChoice | undefined =
    element.id && matchesUniquely(document, `#${cssEscape(element.id)}`, element)
      ? { selector: `#${cssEscape(element.id)}`, durability: identifierDurability(element.id) }
      : undefined;
  if (id?.durability === "stable") return id;

  let attribute: SelectorChoice | undefined;
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (!value || value.length > 64) continue;
    const byAttr = `${element.tagName.toLowerCase()}[${name}="${attrEscape(value)}"]`;
    if (!matchesUniquely(document, byAttr, element)) continue;
    const durability = identifierDurability(value);
    if (durability === "stable") return { selector: byAttr, durability };
    // Only iffy/volatile reach here; keep the first candidate of the best tier.
    if (!attribute || (attribute.durability === "volatile" && durability === "iffy")) {
      attribute = { selector: byAttr, durability };
    }
  }

  const path = buildPath(element);
  if (path.unique && path.durability === "stable") return path;

  // Nothing stable exists — hand out the least-volatile unique handle.
  for (const tier of ["iffy", "volatile"] as const) {
    if (id?.durability === tier) return id;
    if (attribute?.durability === tier) return attribute;
    if (tier === "iffy" && path.unique && path.durability === "iffy") return path;
  }
  return { selector: path.selector, durability: path.unique ? path.durability : "volatile" };
}

/** The selector alone, for callers that don't surface durability. */
export function stableSelector(element: Element): string {
  return stableSelectorWithDurability(element).selector;
}
