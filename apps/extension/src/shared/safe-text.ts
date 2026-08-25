// One place for neutralizing model-authored strings before they reach a human
// surface (H2). A capability rationale and a remixlet name both arrive from a
// model that has just read attacker-controlled page data, so every surface
// that shows one — the activation dialog, the rollback confirm(), the parse
// boundary that stores a name — must strip or reject exactly the same set of
// characters: C0/C1 controls (newlines included, which forge extra dialog
// lines), Unicode bidi overrides and isolates (Trojan-Source visual reordering),
// line/paragraph separators, and zero-width joiners (invisible content).
// Pure module, no extension APIs.

const UNSAFE_TEXT_CLASS =
  "\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff";
const UNSAFE_TEXT_RE = new RegExp(`[${UNSAFE_TEXT_CLASS}]`);
const UNSAFE_TEXT_RE_GLOBAL = new RegExp(`[${UNSAFE_TEXT_CLASS}]`, "g");

/** Whether a string carries any control, bidi, or zero-width character — the
 *  reject test for values validated at a parse/storage boundary. */
export function containsUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_RE.test(value);
}

/** The string with every control, bidi, and zero-width character removed. */
export function stripUnsafeText(value: string): string {
  return value.replace(UNSAFE_TEXT_RE_GLOBAL, "");
}

/**
 * A model-authored string made safe to DISPLAY, subordinate to panel copy:
 * unsafe characters stripped, runs of whitespace collapsed to single spaces,
 * trimmed, and truncated with an ellipsis. Never the sole content of a
 * security surface — always attributed and secondary to the extension's own
 * sentence.
 */
export function sanitizeModelTextForDisplay(value: string, maxLength = 120): string {
  // Collapse whitespace (newlines/tabs included) to single spaces FIRST so word
  // breaks survive, THEN strip the remaining controls/bidi/zero-width.
  const cleaned = stripUnsafeText(value.replace(/\s+/g, " ")).trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}
