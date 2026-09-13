// The one field neither a remixlet nor a typed probe ever reads back: a
// password input. Pure DOM predicate, no extension APIs, so both readers can
// import it — the page agent (src/box/page-agent.ts, the box's `dom` reads and
// its event payloads) and the structured probes (src/worker/page-probes/
// probes.ts, which ship into the tab's isolated world).
//
// A read is not harmless just because it stays out of the box: a remixlet can
// put what it read into an image or link URL, and the URL rule lets that URL
// reach the page's own site and any host a `fetch:` grant names
// (wiki/design/mediated-execution.md, "The promise"). So the value of the one
// field whose whole purpose is a secret never leaves the page.
//
// Static by design: `<input type="password">` and nothing else. Payment and
// one-time-code fields have no reliable marker, and guessing at them would
// promise a protection this cannot keep (wiki/ops/2026-09-12-security-review-plan.md,
// F2).

/** Selector form of isSensitiveField, for scans that need one (`querySelectorAll`, clone redaction). */
export const SENSITIVE_FIELD_SELECTOR = 'input[type="password" i]';

/** Whether this element's value is a secret the extension must not report. */
export function isSensitiveField(element: Element): boolean {
  return element.localName === "input" && (element.getAttribute("type") ?? "").trim().toLowerCase() === "password";
}

/**
 * Markup of an element that may contain a password field, with those fields'
 * `value` attributes emptied — the markup readers (`dom.html()`, the probes'
 * outerHTML) would otherwise hand back a server-rendered password the value
 * readers above withhold. Serialised from a copy made in an INERT document, so
 * the page is never mutated and the copy loads nothing while it is scrubbed.
 */
export function markupWithoutSecrets(element: Element, kind: "inner" | "outer"): string {
  const source = kind === "outer" ? element.outerHTML : element.innerHTML;
  if (!isSensitiveField(element) && element.querySelector(SENSITIVE_FIELD_SELECTOR) === null) return source;
  const inert = element.ownerDocument.implementation.createHTMLDocument("");
  const copy = inert.importNode(element, true);
  for (const field of [copy, ...Array.from(copy.querySelectorAll(SENSITIVE_FIELD_SELECTOR))]) {
    if (isSensitiveField(field)) field.setAttribute("value", "");
  }
  return kind === "outer" ? copy.outerHTML : copy.innerHTML;
}
