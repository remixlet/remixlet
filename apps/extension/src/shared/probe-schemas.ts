// Structured page-probe parameter schemas, shared by the panel tool specs and
// the worker dispatcher. The worker REVALIDATES against these at the trust
// boundary (it must not trust the panel's validation), so this module is the
// single authority on what may cross into a probe template as data.
//
// Security invariant (wiki/raw/handoffs/structured-page-probes.md): probe
// parameters reach the page exclusively as JSON values interpolated by one
// JSON.stringify call — never as code. These schemas bound what those values
// can be.

import { Type, type Static, type TSchema } from "typebox";
import { Settings } from "typebox/system";
import { Errors, Value } from "typebox/value";

// Enumerations are written as literal tuples so typebox infers the exact
// string-literal unions (a mapped Type.Literal[] array degrades to never).
const QueryElementField = Type.Union([
  Type.Literal("tag"),
  Type.Literal("text"),
  Type.Literal("attributes"),
  Type.Literal("dataset"),
  Type.Literal("rect"),
  Type.Literal("visible"),
]);
export type QueryElementField = Static<typeof QueryElementField>;

const AssertConditionSchema = Type.Union([
  Type.Literal("exists"),
  Type.Literal("not-exists"),
  Type.Literal("count-at-least"),
  Type.Literal("count-equals"),
  Type.Literal("text-contains"),
  Type.Literal("attr-equals"),
  Type.Literal("style-equals"),
  Type.Literal("style-parity"),
  Type.Literal("design-parity"),
  Type.Literal("visible"),
  Type.Literal("not-clipped"),
]);
export type AssertCondition = Static<typeof AssertConditionSchema>;

const Selector = Type.String({ minLength: 1, description: "A CSS selector. It is data — an invalid selector is a probe error, never code." });

/**
 * The "where did it come from" primitive (wiki/raw/handoffs/network-data-visibility.md
 * §Layer 1): a value the agent can SEE rendered (a duration, a price, a count)
 * becomes a needle, and the probe returns the JSON paths holding it instead of
 * dumping the whole tree. Needles are data — same injection invariant.
 */
const SearchNeedle = Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Number()], {
  description:
    "A value to locate instead of dumping the tree: returns the JSON paths whose values match it " +
    "(exact, substring, or numeric with seconds↔milliseconds tolerance).",
});

export const QueryElementsParams = Type.Object({
  selector: Selector,
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 5000,
      description:
        "Matches to skip before returning results (default 0) — combine with limit to page through a large " +
        "collection. The live DOM can change between calls, so consecutive pages may skip or repeat entries; " +
        "total is reported on every call.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "Max elements to return (default 10, cap 50)." }),
  ),
  fields: Type.Optional(
    Type.Array(QueryElementField, {
      minItems: 1,
      uniqueItems: true,
      description: "Per-element fields to include (default tag, text, attributes).",
    }),
  ),
});
export type QueryElementsParamsType = Static<typeof QueryElementsParams>;

export const SearchElementsParams = Type.Object({
  text: Type.String({
    minLength: 1,
    maxLength: 200,
    description:
      "The text to locate (case-insensitive substring), matched against every element's own text and attribute " +
      "values (id, class, aria-*, title, data-*, …). It is data — a needle, never code.",
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "Max matches to return (default 10, cap 20)." }),
  ),
});
export type SearchElementsParamsType = Static<typeof SearchElementsParams>;

export const InspectElementParams = Type.Object({
  selector: Selector,
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Which match to inspect (default 0)." })),
});
export type InspectElementParamsType = Static<typeof InspectElementParams>;

export const InspectDesignParams = Type.Object({
  selector: Selector,
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Which match to inspect (default 0)." })),
  ancestors: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 5, description: "How many ancestor layout digests to include (default 2)." }),
  ),
  properties: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 50,
      description:
        'CSS property names to read exactly, e.g. "background-color". When present the probe returns just those ' +
        "computed values (the targeted verification read) instead of the curated design digest.",
    }),
  ),
  pseudoElement: Type.Optional(
    Type.Union([Type.Literal("::before"), Type.Literal("::after")], {
      description: "Read the properties from this pseudo-element of the matched element instead of the element itself.",
    }),
  ),
});
export type InspectDesignParamsType = Static<typeof InspectDesignParams>;

export const ReadStructuredDataParams = Type.Object({
  search: Type.Optional(SearchNeedle),
});
export type ReadStructuredDataParamsType = Static<typeof ReadStructuredDataParams>;

export const ListNetworkResourcesParams = Type.Object({
  urlFilter: Type.Optional(Type.String({ description: "Substring filter applied to resource URLs." })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: "Max endpoints (or rows with flat) to return (default 50)." }),
  ),
  flat: Type.Optional(
    Type.Boolean({
      description:
        "List every data request as its own row (url, contentType, status) instead of the default endpoint " +
        "grouping. Reach for it only when individual requests matter — e.g. comparing repeated calls to one endpoint.",
    }),
  ),
  includeAssets: Type.Optional(
    Type.Boolean({
      description:
        "Also list asset/document/other resources individually (scripts, styles, images, fonts, frames). By default " +
        "they are collapsed into per-origin counts so data requests stay visible.",
    }),
  ),
});
export type ListNetworkResourcesParamsType = Static<typeof ListNetworkResourcesParams>;

export const ReadPageStateParams = Type.Object({
  path: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 12,
      description:
        'Property names walked from window, e.g. ["__NEXT_DATA__", "props"]. Omit (or pass []) to list the ' +
        "window's own top-level keys and discover candidate state globals.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 6, description: "How deep to serialize below the resolved path (default 3)." }),
  ),
  maxBytes: Type.Optional(
    Type.Integer({ minimum: 256, maximum: 32_768, description: "Serialized-output budget in characters (default 8192)." }),
  ),
  search: Type.Optional(SearchNeedle),
});
export type ReadPageStateParamsType = Static<typeof ReadPageStateParams>;

export const ClickElementParams = Type.Object({
  selector: Selector,
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Which match to click (default 0)." })),
});
export type ClickElementParamsType = Static<typeof ClickElementParams>;

export const ReplayNetworkResourceParams = Type.Object({
  url: Type.String({
    minLength: 1,
    maxLength: 2000,
    description:
      "The exact URL to re-request. It executes ONLY if this exact URL already appears in the page's own " +
      "resource timeline (checked in-page at execution time) — the probe can re-issue a GET the page already " +
      "made, never a fabricated one.",
  }),
  maxBytes: Type.Optional(
    Type.Integer({ minimum: 256, maximum: 65_536, description: "Response-body budget in characters (default 16384)." }),
  ),
  search: Type.Optional(SearchNeedle),
});
export type ReplayNetworkResourceParamsType = Static<typeof ReplayNetworkResourceParams>;

export const ObserveNetworkBodiesParams = Type.Object({
  urlFilter: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 500,
      description: "Substring filter applied to observed response URLs — pass the candidate host or path.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "Max observed responses to return, newest last (default 5)." }),
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      minimum: 256,
      maximum: 32_768,
      description: "Per-response body budget in characters (default 4096). Prefer \"search\" over raising this.",
    }),
  ),
  search: Type.Optional(SearchNeedle),
});
export type ObserveNetworkBodiesParamsType = Static<typeof ObserveNetworkBodiesParams>;

export const PageAssertion = Type.Object({
  selector: Selector,
  condition: AssertConditionSchema,
  name: Type.Optional(
    Type.String({ minLength: 1, description: "Attribute name (attr-equals) or CSS property name (style-equals/style-parity)." }),
  ),
  expected: Type.Optional(
    Type.Union([Type.String(), Type.Number()], {
      description: "Expected value: a number for count-*, a string for text-contains/attr-equals/style-equals.",
    }),
  ),
  otherSelector: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Second selector for style-parity/design-parity: the reference element to compare against (e.g. the host's own control).",
    }),
  ),
});
export type PageAssertionType = Static<typeof PageAssertion>;

export const AssertPageStateParams = Type.Object({
  assertions: Type.Array(PageAssertion, { minItems: 1, maxItems: 20 }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 10_000,
      description:
        'Retry window in milliseconds (cap 10000): "assert within N ms" — all assertions are re-evaluated together ' +
        'until every one passes or the window lapses, and the final per-assertion results are returned either way. ' +
        'Omit for "assert now". Use it on the first assert after a reload when content loads late.',
    }),
  ),
});
export type AssertPageStateParamsType = Static<typeof AssertPageStateParams>;

export const PROBE_SCHEMAS = {
  query_elements: QueryElementsParams,
  search_elements: SearchElementsParams,
  inspect_element: InspectElementParams,
  inspect_design: InspectDesignParams,
  read_structured_data: ReadStructuredDataParams,
  read_page_state: ReadPageStateParams,
  list_network_resources: ListNetworkResourcesParams,
  replay_network_resource: ReplayNetworkResourceParams,
  observe_network_bodies: ObserveNetworkBodiesParams,
  click_element: ClickElementParams,
  assert_page_state: AssertPageStateParams,
} satisfies Record<string, TSchema>;

export type ProbeName = keyof typeof PROBE_SCHEMAS;

type ProbeValue = string | number | boolean | null | ProbeValue[] | ProbeObject;
interface ProbeObject {
  [key: string]: ProbeValue;
}

const ProbeString = Type.String();

function isProbeIndexable(value: ProbeValue): value is ProbeObject | ProbeValue[] {
  return value !== null && Object(value) === value;
}

const probeNames = Object.keys(PROBE_SCHEMAS);
// SAFETY: PROBE_SCHEMAS is the owner object whose keys define ProbeName.
const PROBE_NAMES = probeNames as ProbeName[];
export { PROBE_NAMES };

export function isProbeName(value: string): value is ProbeName {
  return Value.Check(ProbeString, value) && Object.prototype.hasOwnProperty.call(PROBE_SCHEMAS, value);
}

/**
 * The page.probe boundary's build-agreement check. A stale running worker
 * whose schemas predate the panel's tool specs rejects params the panel was
 * told are valid, and without this check that surfaces as an opaque schema
 * error the agent can only retry against (the soundcloud-mix-filter session:
 * 13 identical assert_page_state rejections because the worker predated
 * "design-parity"). Returns the failure message when the two bundles carry
 * different build stamps — a MISSING stamp is a mismatch too, fail closed —
 * and undefined when they agree.
 */
export function probeBuildSkewMessage<TPanelBuildId>(panelBuildId: TPanelBuildId, workerBuildId: string): string | undefined {
  if (panelBuildId === workerBuildId) return undefined;
  return (
    `extension build mismatch — this panel (build ${JSON.stringify(panelBuildId ?? "unknown")}) and the extension's ` +
    `background service worker (build ${JSON.stringify(workerBuildId)}) come from different builds, so they may ` +
    "disagree about probe parameters. Reload the extension, then retry."
  );
}

const REPORTED_PATH_CAP = 4;
const REPORTED_VALUE_CAP = 120;

function shortJson<TValue>(value: TValue): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > REPORTED_VALUE_CAP ? `${json.slice(0, REPORTED_VALUE_CAP)}…` : json;
}

/** Resolve a typebox instancePath (a JSON pointer, "/assertions/0/condition") within the rejected params. */
function valueAtPointer<TValue>(root: TValue, pointer: string): ProbeValue | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(root);
  } catch {
    return undefined;
  }
  if (!serialized) return undefined;
  const parsed: ProbeValue = JSON.parse(serialized);
  if (pointer === "") return parsed;
  let current: ProbeValue | undefined = parsed;
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === undefined || !isProbeIndexable(current)) return undefined;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

/**
 * Detail for a params value Check() rejected: one line per offending location
 * with the schema's complaint and the offending value. A failed union of
 * literals (e.g. an assert_page_state condition this build does not know)
 * lists every accepted value, taken from THIS side's live schema — the reader
 * can see exactly which condition was refused and what would be accepted.
 * Never throws: the worker's fail-closed error reply must survive any input.
 */
export function describeProbeParamsError<TParams>(probe: ProbeName, params: TParams): string {
  // typebox buffers at most Settings maxErrors diagnostics (default 8), which
  // would truncate an 11-branch union's accepted-value list mid-way. Raise it
  // for this one collection pass; restored in the finally below.
  const defaultMaxErrors = Settings.Get().maxErrors;
  Settings.Set({ maxErrors: 64 });
  try {
    // Union failures arrive flat: one "const" error per branch plus an
    // "anyOf", all at the same instancePath. Fold each path's errors into a
    // single line, turning const branches into an accepted-value list.
    const grouped = new Map<string, { messages: string[]; allowed: unknown[] }>();
    for (const error of Errors(PROBE_SCHEMAS[probe], params)) {
      let group = grouped.get(error.instancePath);
      if (!group) grouped.set(error.instancePath, (group = { messages: [], allowed: [] }));
      if (error.keyword === "const") {
        // SAFETY: TypeBox const errors expose the rejected literal as allowedValue.
        group.allowed.push((error.params as { allowedValue?: unknown }).allowedValue);
      } else if (error.keyword !== "anyOf" && !group.messages.includes(error.message)) {
        group.messages.push(error.message);
      }
    }
    const lines = [...grouped].slice(0, REPORTED_PATH_CAP).map(([pointer, group]) => {
      const complaint =
        group.allowed.length > 0
          ? `must be one of ${group.allowed.map((value) => JSON.stringify(value)).join(", ")}`
          : group.messages.join(" or ");
      const value = valueAtPointer(params, pointer);
      return `${pointer === "" ? "params" : pointer} ${complaint} (got ${value === undefined ? "nothing" : shortJson(value)})`;
    });
    if (grouped.size > lines.length) lines.push(`…and ${grouped.size - lines.length} more`);
    return lines.length > 0 ? lines.join("; ") : "params did not match the probe's schema";
  } catch (error) {
    return `params did not match the probe's schema (${String(error)})`;
  } finally {
    Settings.Set({ maxErrors: defaultMaxErrors });
  }
}
