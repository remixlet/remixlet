// "Show what it changed": after a completed build, the durable verification
// record carries the assert_page_state assertions that ALL passed
// (VerifiedAssertion, stored beside lastVerifiedAt in the registry —
// store/remixlet-store.ts), and the worker can replay them as numbered
// highlights on the live page through the show-changes overlay
// (platform/show-changes-host-content.ts). The panel's entry point is the
// "Show what changed" button on the current version's "vN applied" divider.
//
// Trust framing: the assertions are AGENT-authored probe params that passed
// against the live page at verification time — page-grounded facts about
// where the remixlet's effect is visible, not model prose and not
// page-derived data. At show time each selector is re-resolved against the
// live DOM; one that no longer matches is reported as a miss in the overlay's
// summary, never silently dropped.

import type { AssertCondition } from "./probe-schemas.js";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

/** Tab message the worker sends the injected overlay to show the highlights. */
export const SHOW_CHANGES_OPEN_MESSAGE = "remixlet.showChanges.open";

export interface VerifiedAssertion {
  selector: string;
  condition: AssertCondition;
  /** Attribute name (attr-equals) or CSS property (style-equals/style-parity). */
  name?: string;
  /** Expected value: a number for count-*, a string otherwise. */
  expected?: string | number;
  /** Reference element for style-parity/design-parity. */
  otherSelector?: string;
}

export interface ShowChangesOpenPayload {
  kind: typeof SHOW_CHANGES_OPEN_MESSAGE;
  remixletName: string;
  assertions: VerifiedAssertion[];
}

/** What the overlay actually did with the assertions — reported honestly. */
export interface ShowChangesSummary {
  /** Numbered marks drawn on the live page. */
  highlighted: number;
  /** Spots whose selector no longer matches anything visible on this page. */
  missing: number;
  /** Absence assertions (not-exists) — nothing left to point at. */
  unpointable: number;
}

// Storage caps. The probe schema already caps a run at 20 assertions; string
// clamps keep a hostile/degenerate record from bloating the registry file the
// popup and manager read on every open.
const MAX_ASSERTIONS = 20;
const MAX_SELECTOR_LENGTH = 500;
const MAX_NAME_LENGTH = 200;
const MAX_EXPECTED_LENGTH = 500;

// Record<AssertCondition, true> so adding a condition to probe-schemas.ts
// fails compilation here until sanitize and describeAssertion learn it.
const KNOWN_CONDITIONS = {
  exists: true,
  "not-exists": true,
  "count-at-least": true,
  "count-equals": true,
  "text-contains": true,
  "attr-equals": true,
  "style-equals": true,
  "style-parity": true,
  "design-parity": true,
  visible: true,
  "not-clipped": true,
};

const VerifiedAssertionInputSchema = Type.Object({
  selector: Type.String(),
  condition: Type.String(),
  name: Type.Optional(Type.String()),
  expected: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  otherSelector: Type.Optional(Type.String()),
});
type VerifiedAssertionInput = Static<typeof VerifiedAssertionInputSchema>;
const StoredAssertionPayloadSchema = Type.Unknown();
type StoredAssertionPayload = Static<typeof StoredAssertionPayloadSchema>;

function isKnownCondition(value: string): value is AssertCondition {
  return Object.prototype.hasOwnProperty.call(KNOWN_CONDITIONS, value);
}

/**
 * Shape-check a would-be assertion list at every boundary it crosses (tool
 * details → verification record → store → overlay payload). Entries with an
 * unknown condition or a non-string selector are dropped, strings are
 * clamped, and the list is capped — never a throw: a malformed entry loses
 * itself, not the record it rides in.
 */
export function sanitizeVerifiedAssertions(value: StoredAssertionPayload): VerifiedAssertion[] {
  if (!Array.isArray(value)) return [];
  const sanitized: VerifiedAssertion[] = [];
  for (const entry of value) {
    if (sanitized.length >= MAX_ASSERTIONS) break;
    if (!Check(VerifiedAssertionInputSchema, entry)) continue;
    const parsed: VerifiedAssertionInput = Parse(VerifiedAssertionInputSchema, entry);
    if (parsed.selector.length === 0 || !isKnownCondition(parsed.condition)) continue;
    const assertion: VerifiedAssertion = { selector: parsed.selector.slice(0, MAX_SELECTOR_LENGTH), condition: parsed.condition };
    if (parsed.name) assertion.name = parsed.name.slice(0, MAX_NAME_LENGTH);
    if (parsed.expected !== undefined && Check(Type.String(), parsed.expected)) {
      assertion.expected = parsed.expected.slice(0, MAX_EXPECTED_LENGTH);
    } else if (parsed.expected !== undefined && Number.isFinite(parsed.expected)) {
      assertion.expected = parsed.expected;
    }
    if (parsed.otherSelector) assertion.otherSelector = parsed.otherSelector.slice(0, MAX_SELECTOR_LENGTH);
    sanitized.push(assertion);
  }
  return sanitized;
}

/** An assertion the overlay can draw a mark for; not-exists proved an absence. */
export function assertionPointable(assertion: VerifiedAssertion): boolean {
  return assertion.condition !== "not-exists";
}

function quoted(value: string | number): string {
  const text = String(value);
  return `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;
}

/**
 * Plain-words chip label for one verified assertion — what the verification
 * proved about the marked spot, in the user's language, no selector jargon.
 */
export function describeAssertion(assertion: VerifiedAssertion): string {
  switch (assertion.condition) {
    case "exists":
      return "present";
    case "visible":
      return "visible";
    case "not-clipped":
      return "not cut off";
    case "not-exists":
      return "removed";
    case "count-at-least":
      return assertion.expected !== undefined ? `at least ${String(assertion.expected)} of these` : "several of these";
    case "count-equals":
      return assertion.expected !== undefined ? `${String(assertion.expected)} of these` : "counted";
    case "text-contains":
      return assertion.expected !== undefined ? `says ${quoted(assertion.expected)}` : "has the expected text";
    case "attr-equals":
      return assertion.name !== undefined && assertion.expected !== undefined
        ? `${assertion.name} is ${quoted(assertion.expected)}`
        : "has the expected attribute";
    case "style-equals":
      return assertion.name !== undefined && assertion.expected !== undefined
        ? `${assertion.name}: ${String(assertion.expected)}`
        : "has the expected style";
    case "style-parity":
      return assertion.name !== undefined
        ? `${assertion.name} matches the page's own`
        : "matches the page's own style";
    case "design-parity":
      return "styled like the page's own controls";
  }
}
