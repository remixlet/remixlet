// Cropping a visible-tab screenshot down to one element in its context, at
// native device pixels (wiki/raw/handoffs/2026-09-03-look-review-crops.md §1
// step 3). Pure web APIs (createImageBitmap, OffscreenCanvas) so the same code
// runs in the MV3 worker and in the browser test harness; no extension API.
//
// Why PNG and native pixels: the whole point of the look review is legibility
// of one-pixel differences — weight, baseline, a 1px border — that a
// viewport JPEG downscaled to a 1568px long edge cannot show.

/** A CSS-pixel rectangle in viewport coordinates, as getBoundingClientRect reports. */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A device-pixel rectangle inside the captured bitmap. */
export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Padding around the context rect, in CSS px. */
export const LOOK_CROP_PADDING_CSS_PX = 8;
/** Per-crop device-pixel cap; larger context rects are centred on the element. */
export const LOOK_CROP_MAX_WIDTH_PX = 1200;
export const LOOK_CROP_MAX_HEIGHT_PX = 600;

/**
 * Where to cut. The context rect (padded) is the crop; when it exceeds the cap
 * on an axis, the crop on that axis is the cap wide and centred on the
 * ELEMENT, so the thing under review is always in frame. Everything is then
 * clamped to the bitmap, and a crop can never be empty.
 */
export function cropGeometry(
  contextRect: CssRect,
  elementRect: CssRect,
  devicePixelRatio: number,
  bitmap: { width: number; height: number },
): DeviceRect {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const pad = LOOK_CROP_PADDING_CSS_PX;
  const padded = {
    x: (contextRect.x - pad) * dpr,
    y: (contextRect.y - pad) * dpr,
    width: (contextRect.width + pad * 2) * dpr,
    height: (contextRect.height + pad * 2) * dpr,
  };
  const elementCentre = {
    x: (elementRect.x + elementRect.width / 2) * dpr,
    y: (elementRect.y + elementRect.height / 2) * dpr,
  };
  const axis = (start: number, size: number, cap: number, centre: number, limit: number): [number, number] => {
    let from = start;
    let extent = size;
    if (extent > cap) {
      extent = cap;
      from = centre - cap / 2;
    }
    // Clamp to the bitmap without losing size where the bitmap allows it.
    if (from < 0) from = 0;
    if (from + extent > limit) from = Math.max(0, limit - extent);
    if (from + extent > limit) extent = limit - from;
    return [Math.round(from), Math.max(1, Math.round(extent))];
  };
  const [x, width] = axis(padded.x, padded.width, LOOK_CROP_MAX_WIDTH_PX, elementCentre.x, bitmap.width);
  const [y, height] = axis(padded.y, padded.height, LOOK_CROP_MAX_HEIGHT_PX, elementCentre.y, bitmap.height);
  return { x, y, width, height };
}

/** Whether `inner` lies entirely inside `outer` (CSS px, 1px slack). */
export function rectContains(outer: CssRect, inner: CssRect): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

export interface CroppedPng {
  /** Raw base64 PNG (no data: prefix) — the shape AgentToolOutput.images takes. */
  data: string;
  /** The same PNG as bytes, for storage. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Cut `region` out of a captured screenshot (a data: URL as captureVisibleTab
 * returns) and re-encode it as PNG. `region` is in device pixels and is
 * clamped to the bitmap once more, so a stale rect cannot throw.
 */
export async function cropScreenshot(dataUrl: string, region: DeviceRect): Promise<CroppedPng> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const x = Math.min(Math.max(0, region.x), Math.max(0, bitmap.width - 1));
    const y = Math.min(Math.max(0, region.y), Math.max(0, bitmap.height - 1));
    const width = Math.max(1, Math.min(region.width, bitmap.width - x));
    const height = Math.max(1, Math.min(region.height, bitmap.height - y));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context for the crop canvas");
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const png = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await png.arrayBuffer());
    return { data: bytesToBase64(bytes), bytes, width, height };
  } finally {
    bitmap.close();
  }
}

/** Dimensions of a captured screenshot, for the geometry clamp. */
export async function screenshotSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
