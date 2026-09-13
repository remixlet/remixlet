// The look review: after a UI-adding write, the agent looks at cropped
// side-by-side screenshots of its control and the host exemplar and records
// a verdict (wiki/raw/handoffs/2026-09-03-look-review-crops.md, design page
// wiki/design/look-review.md). This module is the verdict's shared shape —
// the record_look tool's params, the contract's mechanical read, the store's
// durable field, and the plain-words line the manager and popup show.
//
// Trust framing: the verdict is MODEL-authored judgement about pixels the
// model saw, recorded as data the panel reads from params — never from prose.
// The user sees the same crops the model saw and can overrule in one glance.

import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";

export const LOOK_VERDICTS = ["matches", "differs", "wrong-kind", "not-reviewable"] as const;
export type LookVerdict = (typeof LOOK_VERDICTS)[number];

export function isLookVerdict(value: string): value is LookVerdict {
  return LOOK_VERDICTS.some((verdict) => verdict === value);
}

/**
 * The durable record stored beside the verification marker
 * (store/remixlet-store.ts RegistryEntry.lookReview). Optional on read:
 * entries written by 0.1.x carry none, and a fresh activation carries the
 * previous one forward with its version/headSha saying which version it
 * describes (same staleness rule as lastVerifiedAssertions).
 */
export interface LookReview {
  verdict: LookVerdict;
  /** One or two sentences, in visual terms, of what the crops showed. */
  observed: string;
  /** The host exemplar the control was compared against. */
  referenceSelector?: string;
  /** The added control the crops framed. */
  selector?: string;
  /** UTC ISO date-time the verdict was recorded. */
  reviewedAt: string;
  /** The version the verdict describes. */
  version?: number;
  headSha?: string;
  /** True when a subject crop is stored for this review (readable via remixlet.readLookCrop). */
  hasCrop?: boolean;
}

const MAX_OBSERVED_LENGTH = 500;
const MAX_SELECTOR_LENGTH = 500;

// The unparsed payload a review arrives as at each boundary (tool details, a
// worker message, a registry field) — named, like show-changes' stored
// payload, so the sanitizer is the one place its shape is decided.
const LookReviewPayloadSchema = Type.Unknown();
type LookReviewPayload = Static<typeof LookReviewPayloadSchema>;

const LookReviewInputSchema = Type.Object({
  verdict: Type.String(),
  observed: Type.String(),
  referenceSelector: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  reviewedAt: Type.String(),
  version: Type.Optional(Type.Number()),
  headSha: Type.Optional(Type.String()),
  hasCrop: Type.Optional(Type.Boolean()),
});

/**
 * Shape-check a would-be review at every boundary it crosses (tool details →
 * panel → worker → registry → UI). Returns undefined for anything malformed —
 * a bad review loses itself, never the entry it rides in.
 */
export function sanitizeLookReview(value: LookReviewPayload): LookReview | undefined {
  if (!Check(LookReviewInputSchema, value)) return undefined;
  const parsed = Parse(LookReviewInputSchema, value);
  if (!isLookVerdict(parsed.verdict)) return undefined;
  const review: LookReview = {
    verdict: parsed.verdict,
    observed: parsed.observed.trim().slice(0, MAX_OBSERVED_LENGTH),
    reviewedAt: parsed.reviewedAt,
  };
  if (parsed.referenceSelector) review.referenceSelector = parsed.referenceSelector.slice(0, MAX_SELECTOR_LENGTH);
  if (parsed.selector) review.selector = parsed.selector.slice(0, MAX_SELECTOR_LENGTH);
  if (parsed.version !== undefined && Number.isFinite(parsed.version)) review.version = parsed.version;
  if (parsed.headSha) review.headSha = parsed.headSha;
  if (parsed.hasCrop === true) review.hasCrop = true;
  return review;
}

/**
 * The sentence the manager shows as the remixlet's "Visual review" — the
 * model's own observation when it recorded one, in visual terms, never a
 * selector or a verdict token. Without one, a plain fallback per verdict.
 */
export function describeLookReview(review: LookReview): string {
  switch (review.verdict) {
    case "matches":
      return review.observed || "The control reads as the page's own.";
    case "differs":
      return review.observed || "The control looks slightly different from the page's own.";
    case "wrong-kind":
      return review.observed || "The control is a different kind from the page's own.";
    case "not-reviewable":
      return review.observed ? `Not reviewed visually (${review.observed})` : "Not reviewed visually";
  }
}
