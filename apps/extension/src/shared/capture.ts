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
 * One data endpoint group of the current page load in the capture's census
 * (wiki/design/network-probes.md): host and path shape, never a URL, with
 * the id the model replays it by. Read from the resource timeline through
 * the list_network_resources template in census mode and registered by the
 * worker, so the id here is the same one a later listing shows.
 */
export interface NetworkEndpointSummary {
  id: string;
  host: string;
  /** Path shape plus query parameter names (/tracks/:n?client_id,limit). */
  path: string;
  /** Calls to this endpoint in the timeline. */
  count: number;
  /** Bytes across those calls, or null when the browser exposed no size. */
  bytes: number | null;
  /** decoded: body bytes as parsed; transfer: bytes on the wire where the body size is hidden; hidden: neither. */
  sizeSource: "decoded" | "transfer" | "hidden";
  contentType: string | null;
  statuses: number[];
  sameSite: boolean;
}

/** Endpoint groups the census keeps, largest by size; the rest are counted. */
export const NETWORK_CENSUS_MAX_ENDPOINTS = 30;

/** Stable reason shared by the worker capture and the sidebar activity row. */
export const SCREENSHOT_IDENTITY_CHANGED_MESSAGE =
  "Screenshot skipped because the active tab or page changed while it was being taken.";

export interface NetworkCensus {
  endpoints: NetworkEndpointSummary[];
  /** Groups in the timeline, shown or not. */
  endpointTotal: number;
  /** Data requests in the timeline. */
  requestTotal: number;
  /** The browser's resource-timing buffer is full, so later requests are missing (250 entries by default). */
  bufferPossiblySaturated: boolean;
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
   * The data endpoints of the current page load, with ids (no URLs, no
   * bodies). Absent when the census could not be read; an empty endpoint
   * list means the timeline really recorded no data requests.
   */
  networkCensus?: NetworkCensus;
  screenshot?: { dataUrl: string; coverage: "visible" | "full" };
  network?: NetworkEntry[];
  console?: ConsoleEntry[];
}
