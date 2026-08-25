// Render a CaptureBundle as model-readable text (the capture_page tool's
// result). Pure function, no extension APIs. Caps keep a huge DOM from
// blowing the context window; every cap is announced in the text so the
// model knows what it is not seeing.

import type { CaptureBundle } from "./capture.js";

export interface FormatCaps {
  /** Max DOM characters included. */
  domChars: number;
  /** Max network entries listed. */
  networkEntries: number;
  /** Max characters of a network body shown inline. */
  bodyChars: number;
  /** Max console entries listed. */
  consoleEntries: number;
  /** Max frame-inventory entries listed. */
  frameEntries: number;
  /** Max data-request host tallies listed. */
  dataRequestHosts: number;
}

export const DEFAULT_FORMAT_CAPS: FormatCaps = {
  domChars: 40000,
  networkEntries: 40,
  bodyChars: 2000,
  consoleEntries: 40,
  frameEntries: 20,
  dataRequestHosts: 12,
};

export function formatCaptureForModel(bundle: CaptureBundle, caps: FormatCaps = DEFAULT_FORMAT_CAPS): string {
  const parts: string[] = [
    `# Page capture (${bundle.producedBy} backend)`,
    `url: ${bundle.url}`,
    `title: ${bundle.title}`,
    `captured: ${bundle.capturedAt}`,
  ];

  if (bundle.missing.length > 0) {
    parts.push("", "## Not in this capture", ...bundle.missing.map((m) => `- ${m}`));
  }

  // The frame inventory rides ABOVE the (often truncated) DOM section: an
  // embedded section's iframe tag routinely sits past the DOM cap, and this
  // list is how it stays findable anyway. Absent field = not collected (a
  // missing[] note says so); empty list = the page really has no iframes.
  if (bundle.frames && bundle.frames.length > 0) {
    const shown = bundle.frames.slice(0, caps.frameEntries);
    parts.push("", `## Frames (${bundle.frames.length} iframe(s)${overflow(bundle.frames.length, caps.frameEntries)})`);
    for (const frame of shown) {
      parts.push(
        `- "${frame.title}" origin=${frame.origin || "(none)"} box=${frame.rect.width}x${frame.rect.height}@(${frame.rect.x},${frame.rect.y})`,
      );
    }
  }

  // Unlike frames, an EMPTY tally still renders: "this page has fetched no
  // data yet" redirects discovery toward embedded state, so the fact earns
  // its line. Absent field = not collected (the missing[] note says so).
  if (bundle.dataRequests) {
    const shown = bundle.dataRequests.slice(0, caps.dataRequestHosts);
    parts.push(
      "",
      `## Data requests (per-host fetch/XHR tallies — URLs and bodies not included${overflow(bundle.dataRequests.length, caps.dataRequestHosts)})`,
    );
    if (bundle.dataRequests.length === 0) {
      parts.push("- (none recorded — the page has made no fetch/XHR data requests yet)");
    }
    for (const row of shown) {
      parts.push(`- ${row.host} — ${row.count} request(s)${row.jsonCount > 0 ? `, ${row.jsonCount} JSON` : ""}`);
    }
  }

  if (bundle.network) {
    const shown = bundle.network.slice(0, caps.networkEntries);
    parts.push("", `## Network (${bundle.network.length} request(s)${overflow(bundle.network.length, caps.networkEntries)})`);
    for (const entry of shown) {
      parts.push(`- ${entry.method} ${entry.status} ${entry.mimeType} ${entry.url}`);
      if (entry.body !== undefined) {
        const body = entry.body.slice(0, caps.bodyChars);
        const truncated = entry.bodyTruncated || entry.body.length > caps.bodyChars;
        parts.push(`  body${truncated ? " (truncated)" : ""}: ${body}`);
      }
    }
  }

  if (bundle.console) {
    const shown = bundle.console.slice(-caps.consoleEntries);
    parts.push("", `## Console (${bundle.console.length} entr(ies)${overflow(bundle.console.length, caps.consoleEntries)})`);
    for (const entry of shown) parts.push(`- [${entry.level}] ${entry.text}`);
  }

  if (bundle.dom !== undefined) {
    const dom = bundle.dom.slice(0, caps.domChars);
    const truncated = bundle.dom.length > caps.domChars;
    parts.push(
      "",
      `## DOM${truncated ? ` (first ${caps.domChars} of ${bundle.dom.length} chars)` : ""}`,
      "```html",
      dom,
      "```",
    );
    if (truncated) parts.push(`(DOM truncated — ${bundle.dom.length - caps.domChars} chars omitted)`);
  }

  return parts.join("\n");
}

function overflow(total: number, cap: number): string {
  return total > cap ? `, showing ${cap}` : "";
}
