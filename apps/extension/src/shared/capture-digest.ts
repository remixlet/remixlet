// The content digest behind the unchanged-page capture short-circuit
// (wiki/raw/handoffs/2026-08-10-capture-context-diet.md). Digested over the full
// formatCaptureForModel output, minus the one line that changes on every
// capture — the `captured:` timestamp. The model-facing text may be a derived
// view of the bundle instead (the orientation outline for oversized DOMs —
// panel/tools/capture-outline.ts), but every such view is a pure function of
// the bundle, so equal digests still mean the model would receive identical
// text and resending the second capture is pure cost.
//
// The digest carries NO safety weight. Freshness after page-mutating events
// (a write's activation reload, navigation, clicks) is enforced by clearing
// the stored digest record at those events (worker/capture-freshness.ts),
// never by hoping the digest differs — a collision can only ever cost an
// unnecessary full capture, not a stale one.

/** The formatted capture text with per-capture stamp lines removed. */
export function stableCaptureText(formattedCapture: string): string {
  return formattedCapture
    .split("\n")
    .filter((line) => !line.startsWith("captured: "))
    .join("\n");
}

/** SHA-256 hex over stableCaptureText. Requires WebCrypto (workers and pages both have it). */
export async function captureContentDigest(formattedCapture: string): Promise<string> {
  const bytes = new TextEncoder().encode(stableCaptureText(formattedCapture));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
