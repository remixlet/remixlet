// How likely a page-supplied identifier — an id, a class name, or an
// attribute value — is to survive a page reload. Sites that render with
// frameworks mint fresh ids per render (`#CardInstanceyn8eQh-_xNUm_XTikL1dDw`
// on amazon.co.uk was the failure that motivated this): such an id matches
// uniquely today and matches nothing after the next reload, so anything
// persisted against it dies silently. This is a preference scale, not a
// yes/no: some pages offer nothing better, and a volatile identifier that
// matches now still beats no selector at all — callers pick the best tier
// available and caveat the rest.
//
// The tiers:
// - "stable":   reads like something a human named (nav-main, desktop-grid-3,
//               stream__filter). Expected to survive reloads.
// - "iffy":     has machine-ish traits (3-4 digit runs, very long tokens) but
//               is not clearly generated. May survive.
// - "volatile": hash/uuid/counter-shaped. Assume it will not survive.
//
// Known limit: pure-letter hashes (styled-components' `sc-bdVaJa`) are
// indistinguishable from human camelCase without misfiring on real names,
// so they score "stable". Digit-bearing generators — the common case —
// are caught.
//
// A self-contained twin of these rules lives in probeHelpers
// (src/worker/page-probes/probes.ts): probe code crosses into the page via
// fn.toString() and cannot import this module — keep the rules in sync.

export type Durability = "stable" | "iffy" | "volatile";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Splits an identifier the way a human reads it: on separators, keeping BEM's `__` intact as a plain separator. */
const TOKEN_SEPARATORS = /[-_.:\s]+/;

/** A token whose letters and digits interleave (yn8eQh, XTikL1dDw, 3xyz2) — the shape of generated hashes. */
function looksHashLike(token: string): boolean {
  if (token.length < 5) return false;
  if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) return false;
  // Digits embedded between letters, or leading digits followed by letters —
  // human names put their digits at the end (grid3, col2, mp4).
  return /[A-Za-z]\d+[A-Za-z]/.test(token) || /^\d/.test(token);
}

export function identifierDurability(value: string): Durability {
  if (value.length === 0) return "volatile";
  if (/\d{5,}/.test(value)) return "volatile"; // counters, timestamps
  if (UUID.test(value)) return "volatile";
  if (/:/.test(value)) return "volatile"; // React useId / Radix (:r5:)
  if (/-_|_-/.test(value)) return "volatile"; // base64url separator junction
  const tokens = value.split(TOKEN_SEPARATORS);
  if (tokens.some(looksHashLike)) return "volatile";
  if (/\d{3,4}/.test(value)) return "iffy"; // looks indexed (item234)
  if (tokens.some((token) => token.length >= 24)) return "iffy";
  return "stable";
}

const RANK = { stable: 0, iffy: 1, volatile: 2 } satisfies Record<Durability, number>;

/** The weakest tier among the given ones — a selector is only as durable as its worst part. */
export function worstDurability(...tiers: Durability[]): Durability {
  return tiers.reduce((worst, tier) => (RANK[tier] > RANK[worst] ? tier : worst), "stable");
}
