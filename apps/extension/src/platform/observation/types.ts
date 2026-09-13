// ObservationBackend — the agent's eyes, behind one interface so per-browser
// privilege differences never leak into product code (wiki/plan.md §1).
// Chrome uses SnapshotBackend (content-script DOM snapshot + visible
// screenshot); Firefox layers response-stream network capture on top of the
// same snapshot; Safari is snapshot-only. Whatever a target cannot produce is
// reported honestly in the bundle's missing[] notes.

import type { CaptureBundle } from "../../shared/capture.js";

/** Capabilities a backend can produce. Drives backend selection. */
export interface ObservationProvides {
  /** DOM snapshot. */
  dom: boolean;
  screenshot: "none" | "visible" | "full";
  /** Network requests w/ bodies (Firefox response-stream capture). */
  network: boolean;
  /** Console logs. */
  console: boolean;
  /** Run an expression in-page and read the result. */
  evaluate: boolean;
}

/** What a given capture needs. The agent's capture_page tool fills this. */
export interface CaptureRequest {
  tabId: number;
  /** Default true. */
  needDom?: boolean;
  /** Default "visible". */
  needScreenshot?: "none" | "visible" | "full";
  needNetwork?: boolean;
  needConsole?: boolean;
}

export type CaptureResult =
  /** pageLoad: the document's page-load token read with the DOM snapshot (shared/network-ids.ts), when the backend collected one. */
  | { ok: true; bundle: CaptureBundle; pageLoad?: string }
  | { ok: false; reason: "failed"; message: string };

export interface ObservationBackend {
  readonly kind: "snapshot" | "firefox" | "safari";
  readonly provides: ObservationProvides;
  capture(req: CaptureRequest): Promise<CaptureResult>;
}
