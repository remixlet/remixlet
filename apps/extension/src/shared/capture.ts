// Capture bundle: what an ObservationBackend hands the agent. Lives in
// shared/ so panel and worker agree on the wire shape. The full serialization
// story (OPFS captures/<site-key>/ layout) is the wider M1
// deliverable; this is the in-memory shape every backend produces today.

export interface ConsoleEntry {
  /** Console API level: "log" | "warning" | "error" | … */
  level: string;
  text: string;
  /** ms since epoch. */
  timestamp: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  /** Response body (text), when retrievable; capped — see bodyTruncated. */
  body?: string;
  bodyTruncated?: boolean;
}

/**
 * One top-document iframe in the capture's frame inventory
 * (wiki/raw/handoffs/2026-08-10-early-scoping-and-frame-inventory.md): enough to
 * locate an embedded section in one step instead of by selector guessing —
 * the iframe ELEMENT is readable from the top document even when the frame's
 * CONTENT is cross-origin and excluded.
 */
export interface FrameEntry {
  /** The iframe's title attribute ("" when absent), capped at collection. */
  title: string;
  /**
   * Origin of the frame's src only — never the path or query, which would
   * echo tracking parameters into model context. "" when src is empty,
   * opaque (about:blank), or unparseable.
   */
  origin: string;
  /** Approximate box: rounded viewport coordinates at snapshot time. */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Per-host tally of the page's data requests (fetch/XHR calls and JSON/XML
 * responses) read from the performance resource timeline at snapshot time.
 * Hostname and counts only — never paths or query strings, which would echo
 * tracking parameters into model context (the FrameEntry.origin rule).
 */
export interface DataRequestHostSummary {
  host: string;
  /** Data requests to this host recorded in the resource timeline. */
  count: number;
  /**
   * How many of count carried a JSON content type. 0 also where the browser
   * does not expose contentType on resource timing (pre-130 Chrome, Firefox).
   */
  jsonCount: number;
}

export interface CaptureBundle {
  url: string;
  title: string;
  /** ISO 8601. */
  capturedAt: string;
  /**
   * Which backend produced this. The agent must never treat a snapshot as
   * authoritative about things it cannot see (e.g. "this page makes no XHR
   * calls" is not a conclusion a snapshot bundle supports).
   */
  producedBy: "snapshot" | "firefox" | "safari";
  /** Honest gaps: human/agent-readable notes on what this bundle does NOT contain and why. */
  missing: string[];
  dom?: string;
  /**
   * Top-document iframe inventory, collected with the DOM snapshot. Absent
   * when the backend could not collect it — which then carries a missing[]
   * note, so "no section" and "none found" stay distinguishable.
   */
  frames?: FrameEntry[];
  /**
   * Per-host data-request tallies, collected with the DOM snapshot (URL-level
   * visibility only — no bodies). Absent when the backend could not collect
   * it; empty means the timeline really recorded no data requests.
   */
  dataRequests?: DataRequestHostSummary[];
  screenshot?: { dataUrl: string; coverage: "visible" | "full" };
  network?: NetworkEntry[];
  console?: ConsoleEntry[];
}
