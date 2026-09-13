// Render a CaptureBundle as model-readable text (the capture_page tool's
// result). Pure function, no extension APIs. Caps keep a huge DOM from
// blowing the context window; every cap is announced in the text so the
// model knows what it is not seeing.

import type { CaptureBundle, NetworkCensus } from "./capture.js";

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
}

export const DEFAULT_FORMAT_CAPS: FormatCaps = {
  domChars: 40000,
  networkEntries: 40,
  bodyChars: 2000,
  consoleEntries: 40,
  frameEntries: 20,
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

  // The network census (wiki/design/network-probes.md). Unlike frames, an
  // EMPTY census still renders: "this page has fetched no data yet" redirects
  // discovery toward embedded state, so the fact earns its line. Absent
  // field = not collected (the missing[] note says so).
  if (bundle.networkCensus) parts.push("", ...formatNetworkCensus(bundle.networkCensus));

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

/** Bytes as the model reads them: KB with one decimal above a kilobyte, plain bytes below. */
export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * The Data endpoints section: one line per endpoint group, id first, host
 * and path shape, calls, size, content type and statuses. The rows arrive
 * already cut to the largest (shared/capture.ts NETWORK_CENSUS_MAX_ENDPOINTS);
 * the rest are counted with the way to reach them.
 */
export function formatNetworkCensus(census: NetworkCensus): string[] {
  const lines = [
    `## Data endpoints (${census.endpointTotal} endpoint group(s), ${census.requestTotal} data request(s) this page load; ` +
      "fetch/XHR and JSON/XML responses, no URLs or bodies; replay an id with replay_network_resource)",
  ];
  if (census.endpoints.length === 0) {
    lines.push("- (none recorded: the page has made no fetch/XHR data requests yet)");
  }
  for (const row of census.endpoints) {
    const size =
      row.bytes === null ? "size hidden" : `${formatByteSize(row.bytes)}${row.sizeSource === "transfer" ? " on the wire" : ""}`;
    const type = row.contentType === null ? "" : ` ${row.contentType.split(";")[0]?.trim() ?? row.contentType}`;
    const statuses = row.statuses.length > 0 ? ` ${row.statuses.join("/")}` : "";
    const site = row.sameSite ? "" : " (other site)";
    lines.push(`- ${row.id} ${row.host} ${row.path} | ${row.count} call(s), ${size}${type}${statuses}${site}`);
  }
  const rest = census.endpointTotal - census.endpoints.length;
  if (rest > 0) {
    lines.push(
      `- ${rest} more, smaller (list_network_resources: urlFilter narrows by host or path, search finds which response carries a value)`,
    );
  }
  if (census.bufferPossiblySaturated) {
    lines.push("- (the browser's resource-timing buffer is full, so requests made after it filled are missing from this list)");
  }
  return lines;
}
