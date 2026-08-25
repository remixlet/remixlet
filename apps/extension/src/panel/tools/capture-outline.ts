// Orientation-first capture formatting (wiki/raw/handoffs/
// 2026-08-20-capture-first-send-retrieval-spike.md): when a page's DOM
// saturates the 40K first-send cap, the model used to receive an arbitrary
// prefix of the page — structurally blind to anything past the cap. This
// module renders a compact structure outline over the FULL DOM instead:
// landmarks, headings, repeated-item containers, forms, and data-attribute
// hotspots, each with a selector the model can hand to the live probes
// (query_elements / search_elements).
//
// PANEL-ONLY: the outline is built with DOMParser, which does not exist in
// the MV3 service worker. The worker's digest path keeps digesting the full
// formatCaptureForModel output (shared/capture-digest.ts), which stays a pure
// function of the bundle — equal digests still imply equal outlines.
//
// Everything here is decided in code, deterministically (the prefer-static
// rule): whether a capture ships whole or outlined is a fixed threshold, and
// what the outline contains never depends on model choice.

import type { CaptureBundle } from "../../shared/capture.js";
import { DEFAULT_FORMAT_CAPS, formatCaptureForModel } from "../../shared/capture-format.js";

/**
 * DOMs at or under this many chars ship whole, exactly as before — an outline
 * of a page that already fits the cap is pure overhead. Above it, the
 * orientation view replaces the truncated dump. Equal to the classic cap so
 * "outlined" and "would have been truncated" are the same set of pages.
 */
export const ORIENTATION_DOM_THRESHOLD = DEFAULT_FORMAT_CAPS.domChars;

interface OutlineCaps {
  /** Max outline body lines before honest truncation. */
  maxLines: number;
  /** Max outline body chars before honest truncation. */
  maxChars: number;
  /** Max elements visited by the walk (pathological pages stay bounded). */
  maxElements: number;
  /** Chars of an element's text sample. */
  textSample: number;
  /** Children sharing a signature before they collapse to one "×N" line. */
  repeatMin: number;
  /** Max forms itemized, and max controls listed per form. */
  maxForms: number;
  maxControlsPerForm: number;
  /** Max data-* attribute names listed in the hotspot table. */
  maxDataAttrs: number;
}

export const DEFAULT_OUTLINE_CAPS: OutlineCaps = {
  maxLines: 350,
  maxChars: 12000,
  maxElements: 30000,
  textSample: 80,
  repeatMin: 4,
  maxForms: 10,
  maxControlsPerForm: 15,
  maxDataAttrs: 15,
};

/** Tags that always earn an outline line, independent of id/role. */
const STRUCTURAL_TAGS = new Set([
  "header",
  "nav",
  "main",
  "aside",
  "footer",
  "section",
  "article",
  "form",
  "table",
  "dialog",
  "details",
  "iframe",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** Containers whose contents never help orientation. */
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);

interface SelectorInfo {
  selector: string;
  /** How many elements the selector hits in this document (0 = not computable). */
  matches: number;
}

function cssEscape(value: string): string {
  // CSS.escape exists in every document context this module runs in; the
  // fallback keeps a bare test environment from crashing on exotic ids.
  return CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** A short, probe-ready selector: #id when present, else tag + up to two classes. */
function selectorFor(element: Element, doc: Document): SelectorInfo {
  const id = element.getAttribute("id");
  let selector: string;
  if (id) {
    selector = `#${cssEscape(id)}`;
  } else {
    const classes = (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((cls) => `.${cssEscape(cls)}`)
      .join("");
    selector = `${element.tagName.toLowerCase()}${classes}`;
  }
  let matches = 0;
  try {
    matches = doc.querySelectorAll(selector).length;
  } catch {
    matches = 0;
  }
  return { selector, matches };
}

function textSample(element: Element, cap: number): string {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** tag + sorted classes: the grouping signature for repeated-item detection. */
function childSignature(element: Element): string {
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).sort().slice(0, 3).join(".");
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
}

interface OutlineState {
  lines: string[];
  chars: number;
  visited: number;
  truncated: boolean;
  doc: Document;
  caps: OutlineCaps;
}

function pushLine(state: OutlineState, line: string): boolean {
  if (state.lines.length >= state.caps.maxLines || state.chars + line.length > state.caps.maxChars) {
    state.truncated = true;
    return false;
  }
  state.lines.push(line);
  state.chars += line.length + 1;
  return true;
}

function describeLine(state: OutlineState, element: Element, depth: number, suffix: string): string {
  const { selector, matches } = selectorFor(element, state.doc);
  const ambiguity = matches > 1 ? ` (selector matches ${matches})` : "";
  const sample = textSample(element, state.caps.textSample);
  const sampleNote = sample ? ` "${sample}"` : "";
  return `${"  ".repeat(depth)}- ${selector}${ambiguity}${sampleNote}${suffix}`;
}

function outlineWorthy(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (STRUCTURAL_TAGS.has(tag)) return true;
  if (element.hasAttribute("role")) return true;
  return false;
}

function walk(state: OutlineState, element: Element, depth: number): void {
  if (state.truncated) return;
  const children = Array.from(element.children).filter((child) => !SKIP_TAGS.has(child.tagName.toLowerCase()));
  state.visited += children.length;
  if (state.visited > state.caps.maxElements) {
    state.truncated = true;
    return;
  }

  // Repeated-item detection: N same-signature siblings collapse into one
  // "×N" line — the compression that keeps feed pages describable. Only the
  // first item of a run is descended into, so its inner structure appears once.
  const groups = new Map<string, Element[]>();
  for (const child of children) {
    const signature = childSignature(child);
    const group = groups.get(signature);
    if (group) group.push(child);
    else groups.set(signature, [child]);
  }

  const collapsed = new Set<Element>();
  for (const group of groups.values()) {
    if (group.length >= state.caps.repeatMin) {
      const first = group[0]!;
      if (!pushLine(state, describeLine(state, first, depth, ` ×${group.length} (repeated item)`))) return;
      walk(state, first, depth + 1);
      for (const member of group) collapsed.add(member);
    }
  }

  for (const child of children) {
    if (collapsed.has(child)) continue;
    if (outlineWorthy(child)) {
      const descendants = child.querySelectorAll("*").length;
      const countNote = descendants > 0 ? ` (${descendants} elements)` : "";
      if (!pushLine(state, describeLine(state, child, depth, countNote))) return;
      walk(state, child, depth + 1);
    } else {
      // Not itself outline-worthy — but structure below it still is.
      walk(state, child, depth);
    }
  }
}

function formsSection(doc: Document, caps: OutlineCaps): string[] {
  const forms = Array.from(doc.querySelectorAll("form"));
  if (forms.length === 0) return [];
  const lines = [
    "",
    `### Forms (${forms.length}${forms.length > caps.maxForms ? `, showing ${caps.maxForms}` : ""})`,
  ];
  for (const form of forms.slice(0, caps.maxForms)) {
    const { selector } = selectorFor(form, doc);
    lines.push(`- ${selector}`);
    const controls = Array.from(form.querySelectorAll("input, select, textarea, button"));
    for (const control of controls.slice(0, caps.maxControlsPerForm)) {
      const tag = control.tagName.toLowerCase();
      const type = control.getAttribute("type");
      const name = control.getAttribute("name");
      const placeholder = control.getAttribute("placeholder");
      const bits = [
        tag,
        type ? `type=${type}` : "",
        name ? `name=${name}` : "",
        placeholder ? `placeholder="${placeholder.slice(0, 40)}"` : "",
      ].filter(Boolean);
      lines.push(`  - ${bits.join(" ")}`);
    }
    if (controls.length > caps.maxControlsPerForm) {
      lines.push(`  - (${controls.length - caps.maxControlsPerForm} more controls not listed)`);
    }
  }
  return lines;
}

function dataAttrSection(doc: Document, caps: OutlineCaps): string[] {
  // Frequency table of data-* attribute NAMES — pages that key their content
  // on data-testid/data-id expose their query surface here in a few lines.
  const counts = new Map<string, { count: number; example: string }>();
  const all = doc.querySelectorAll("*");
  const limit = Math.min(all.length, caps.maxElements);
  for (let index = 0; index < limit; index += 1) {
    const element = all[index]!;
    for (const attr of element.getAttributeNames()) {
      if (!attr.startsWith("data-")) continue;
      const existing = counts.get(attr);
      if (existing) {
        existing.count += 1;
      } else {
        const value = (element.getAttribute(attr) ?? "").slice(0, 40);
        counts.set(attr, { count: 1, example: `${element.tagName.toLowerCase()}[${attr}="${value}"]` });
      }
    }
  }
  if (counts.size === 0) return [];
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, caps.maxDataAttrs);
  const lines = ["", `### Data-attribute hotspots (${counts.size} distinct data-* names)`];
  for (const [name, { count, example }] of top) {
    lines.push(`- ${name} ×${count} — e.g. ${example}`);
  }
  return lines;
}

/**
 * The structure outline over a full (uncapped) DOM string. Pure given the
 * string; uses DOMParser, so document contexts only — never the worker.
 */
export function buildDomOutline(dom: string, caps: OutlineCaps = DEFAULT_OUTLINE_CAPS): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(dom, "text/html");
  } catch {
    return "(outline unavailable: the captured DOM could not be parsed)";
  }
  const root = doc.body ?? doc.documentElement;
  if (!root) return "(outline unavailable: the captured DOM has no body)";

  const state: OutlineState = { lines: [], chars: 0, visited: 0, truncated: false, doc, caps };
  walk(state, root, 0);
  const totalElements = doc.querySelectorAll("*").length;

  const parts: string[] = [
    `Full DOM: ${dom.length} chars, ${totalElements} elements. Outline of landmarks, headings, and repeated items` +
      ` (selectors are probe-ready; "×N" = N same-shaped siblings, itemized once):`,
    ...(state.lines.length > 0 ? state.lines : ["(no landmark/heading structure found)"]),
  ];
  if (state.truncated) {
    parts.push(`(outline truncated at ${state.lines.length} lines — deeper structure not shown)`);
  }
  parts.push(...formsSection(doc, caps));
  parts.push(...dataAttrSection(doc, caps));
  return parts.join("\n");
}

/**
 * The orientation-first capture text: every section formatCaptureForModel
 * renders (header, missing[], frames, network, console) except the raw DOM,
 * which is replaced by the structure outline plus honest size facts and
 * drill-down directions.
 */
export function formatCaptureOrientationForModel(bundle: CaptureBundle): string {
  const { dom, ...rest } = bundle;
  const base = formatCaptureForModel(rest);
  if (dom === undefined) return base;
  return [
    base,
    "",
    "## DOM (outline — raw DOM not included)",
    buildDomOutline(dom),
    "",
    `The raw DOM (${dom.length} chars) was not sent. To reach any part of it, probe the LIVE page: ` +
      `search_elements finds where text lives when you have no selector yet; query_elements/inspect_element ` +
      `drill into the selectors above.`,
  ].join("\n");
}
