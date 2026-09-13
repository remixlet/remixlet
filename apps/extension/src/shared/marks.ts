// Remixlet marks: the attributes and classes a remixlet writes on a page, and
// how a later reader tells them from the page's own data
// (wiki/decisions/leftover-marks.md). Pure module, no extension APIs, shared by
// the page agent's policy (box/policy.ts, which refuses an unprefixed mark on a
// page element), the box runtime (`rmx.prefix`), the capture's leftover census
// (panel/tools/capture-page.ts) and the feasibility gate (agent/contracts.ts).
//
// The rule: a remixlet with id `mixes-filter` may mark the page's own elements
// only with attributes named `data-rmx-mixes-filter` or
// `data-rmx-mixes-filter-<anything>` and classes named `rmx-mixes-filter` or
// `rmx-mixes-filter-<anything>`. `rmx-mixes-filter` is its prefix. Elements a
// remixlet creates or clones are stamped `data-rmx-owner="mixes-filter"` by the
// page agent and may carry any attribute or class (matching host styling needs
// the host's class names). So every mark on a page names the remixlet that
// wrote it, and a mark naming no existing remixlet is a leftover: written by a
// remixlet since removed (or by an older build), not page data, gone on the
// next reload. The 2026-09-07 SoundCloud run
// (wiki/design/soundcloud-run-post-mortem-2026-09-07.md) grounded a verdict on
// exactly such marks.

/** The attribute the page agent stamps on every element a remixlet creates or clones. */
export const OWNER_ATTRIBUTE = "data-rmx-owner";

/** Every mark starts with this; the remixlet id follows. */
export const MARK_STEM = "rmx-";

/**
 * The prefix of every mark a remixlet writes: `rmx-<id>`. An id that already
 * starts with `rmx-` is its own prefix, so nothing is ever spelled
 * `rmx-rmx-…`.
 */
export function markPrefix(remixletId: string): string {
  const id = String(remixletId);
  return id.startsWith(MARK_STEM) ? id : `${MARK_STEM}${id}`;
}

/**
 * Whether `rest` (what follows `rmx-` in a mark) names `remixletId`: the id
 * itself or the id plus `-…`. An id that carries the stem is compared without
 * it, since its marks read `rmx-<id>-…`, not `rmx-rmx-<id>-…`.
 */
function restNames(rest: string, remixletId: string): boolean {
  const own = markPrefix(remixletId).slice(MARK_STEM.length);
  return rest === own || rest.startsWith(`${own}-`);
}

/** Whether a class name is a mark (`rmx-…`); the owner attribute is not a class. */
export function isMarkClass(name: string): boolean {
  return name.startsWith(MARK_STEM);
}

/** Whether an attribute name is a mark (`data-rmx-…`), the owner attribute included. */
export function isMarkAttribute(name: string): boolean {
  return name.startsWith(`data-${MARK_STEM}`);
}

/** Whether class `name` is one `remixletId` may write on a page element. */
export function classMarkedBy(name: string, remixletId: string): boolean {
  return isMarkClass(name) && restNames(name.slice(MARK_STEM.length), remixletId);
}

/** Whether attribute `name` is one `remixletId` may write on a page element (never the owner attribute). */
export function attributeMarkedBy(name: string, remixletId: string): boolean {
  if (name === OWNER_ATTRIBUTE) return false;
  return isMarkAttribute(name) && restNames(name.slice(`data-${MARK_STEM}`.length), remixletId);
}

/** Whether any existing remixlet could have written this class or attribute; an owner stamp is judged by its value. */
function markOwned(name: string, kind: "class" | "attribute", ids: readonly string[]): boolean {
  return ids.some((id) => (kind === "class" ? classMarkedBy(name, id) : attributeMarkedBy(name, id)));
}

// ---------------------------------------------------------------------------
// The census

export interface LeftoverMark {
  /** `attribute`: a `data-rmx-*` attribute; `class`: an `rmx-*` class; `owner`: `data-rmx-owner` naming a remixlet that does not exist. */
  kind: "attribute" | "class" | "owner";
  /** The attribute name, the class name, or the owner id. */
  name: string;
  /** Elements carrying it. */
  count: number;
  /** One element, as `tag[attr="value"]`, `tag.class` or `tag`. */
  example: string;
}

export interface LeftoverCensus {
  marks: LeftoverMark[];
  /** Distinct marks beyond `marks` (the list is bounded). */
  more: number;
  /** Elements walked; the walk stops at the cap. */
  elements: number;
  truncated: boolean;
}

export interface CensusCaps {
  /** Elements visited before the walk stops. */
  maxElements: number;
  /** Distinct marks listed; the rest are counted in `more`. */
  maxMarks: number;
}

export const DEFAULT_CENSUS_CAPS: CensusCaps = { maxElements: 30000, maxMarks: 20 };

/**
 * Every `data-rmx-*` attribute, `rmx-*` class and `data-rmx-owner` stamp in
 * `root` that no remixlet in `installedIds` (every stored remixlet, in any
 * state) could have written, with counts. Bare marks from before the prefix
 * rule (`data-rmx-mix`) are leftovers too, since no id owns them. Works with an
 * empty inventory: then every mark is a leftover. Pure over the DOM handed in
 * (a live document or a parsed capture).
 */
export function findLeftoverMarks(
  root: ParentNode,
  installedIds: readonly string[],
  caps: CensusCaps = DEFAULT_CENSUS_CAPS,
): LeftoverCensus {
  const ids = installedIds.map(String);
  const found = new Map<string, LeftoverMark>();
  const note = (kind: LeftoverMark["kind"], name: string, example: string): void => {
    const key = `${kind}:${name}`;
    const existing = found.get(key);
    if (existing) existing.count += 1;
    else found.set(key, { kind, name, count: 1, example });
  };
  const all = root.querySelectorAll("*");
  const limit = Math.min(all.length, caps.maxElements);
  for (let index = 0; index < limit; index += 1) {
    const element = all[index]!;
    const tag = element.localName;
    for (const attr of element.getAttributeNames()) {
      if (!isMarkAttribute(attr)) continue;
      const value = element.getAttribute(attr) ?? "";
      if (attr === OWNER_ATTRIBUTE) {
        if (!ids.includes(value)) note("owner", value, tag);
        continue;
      }
      if (!markOwned(attr, "attribute", ids)) note("attribute", attr, `${tag}[${attr}="${value.slice(0, 40)}"]`);
    }
    for (const name of Array.from(element.classList)) {
      if (isMarkClass(name) && !markOwned(name, "class", ids)) note("class", name, `${tag}.${name}`);
    }
  }
  const marks = [...found.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    marks: marks.slice(0, caps.maxMarks),
    more: Math.max(0, marks.length - caps.maxMarks),
    elements: limit,
    truncated: all.length > limit,
  };
}

/** The attribute names a census lists as leftovers (for excluding them from other attribute tallies). */
export function leftoverAttributeNames(census: LeftoverCensus): Set<string> {
  const names = new Set<string>();
  for (const mark of census.marks) {
    if (mark.kind === "attribute") names.add(mark.name);
    if (mark.kind === "owner") names.add(OWNER_ATTRIBUTE);
  }
  return names;
}

/**
 * The names a verdict must not cite: attribute and class names as they appear
 * in selectors and evidence, plus the owner attribute when a stamp is orphaned.
 */
export function leftoverMarkNames(census: LeftoverCensus): string[] {
  const names = new Set<string>();
  for (const mark of census.marks) names.add(mark.kind === "owner" ? OWNER_ATTRIBUTE : mark.name);
  return [...names];
}

/**
 * Whether `text` cites one of `names` as a whole token: `data-rmx-mix` matches
 * `[data-rmx-mix="true"]` and `data-rmx-mix ×107`, never the installed
 * `data-rmx-mixes-filter-mix`. Case-insensitive, since selectors are.
 */
export function citesLeftoverMark(text: string, names: readonly string[]): string | undefined {
  const haystack = String(text).toLowerCase();
  for (const name of names) {
    const needle = name.toLowerCase();
    let from = 0;
    while (from <= haystack.length) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? "" : haystack[at - 1]!;
      const after = haystack[at + needle.length] ?? "";
      if (!isNameChar(before) && !isNameChar(after)) return name;
      from = at + 1;
    }
  }
  return undefined;
}

function isNameChar(char: string): boolean {
  return /^[a-z0-9_-]$/.test(char);
}

// ---------------------------------------------------------------------------
// Model-facing text

/** The capture section's heading; the feasibility refusal and the prompt name it. */
export const LEFTOVER_SECTION_HEADING = "## Leftover marks (not page data)";

/**
 * The capture's leftover section: plain words on what the marks are and what
 * they mean, then one line per mark with its count and an example. Empty
 * string when there is nothing to say, so a clean page carries no section.
 */
export function formatLeftoverMarks(census: LeftoverCensus): string {
  if (census.marks.length === 0) return "";
  const lines = [
    LEFTOVER_SECTION_HEADING,
    "These attributes and classes were written by a remixlet that is no longer installed (or by an older build). They " +
      "are not the page's own data and do not describe what the page does: a reload drops them. Do not build on them, " +
      "do not cite them as evidence, and do not count elements by them.",
  ];
  for (const mark of census.marks) {
    if (mark.kind === "owner") {
      lines.push(`- ${mark.count} element${mark.count === 1 ? "" : "s"} added by removed remixlet "${mark.name}" (e.g. ${mark.example})`);
    } else {
      lines.push(`- ${mark.kind} ${mark.name} ×${mark.count} (e.g. ${mark.example})`);
    }
  }
  if (census.more > 0) lines.push(`- and ${census.more} more leftover mark${census.more === 1 ? "" : "s"}`);
  if (census.truncated) lines.push(`(census stopped after ${census.elements} elements; deeper leftovers not counted)`);
  return lines.join("\n");
}
