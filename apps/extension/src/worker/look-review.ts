// The look review's privileged half (wiki/design/look-review.md): given the
// selector of a control a remixlet added and the host exemplar it was built
// from, bring both into view, photograph the visible tab ONCE (twice when the
// exemplar is off-screen), and cut out each element in its context at native
// device pixels. The crops go back to the panel's look_at_change tool, which
// attaches them to the model's context; the subject crop is also stored
// beside the remixlet so the manager can show what the model looked at.
//
// Nothing here judges the look. The probe reports rectangles, this module
// cuts pixels, and the model records the verdict through record_look.

import { Type } from "typebox";
import { Check } from "typebox/value";
import { ext } from "../platform/ext.js";
import { ScreenshotIdentityChangedError, withVisibleTabCaptureGuard } from "../platform/observation/snapshot.js";
import {
  cropGeometry,
  cropScreenshot,
  rectContains,
  screenshotSize,
  type CroppedPng,
  type CssRect,
} from "../shared/look-crop.js";
import type { LocateForReviewParamsType } from "../shared/probe-schemas.js";
import { runProbe } from "./page-probes/engine.js";

export interface LookCaptureImage {
  role: "subject" | "reference";
  /** Raw base64 PNG (no data: prefix) — AgentToolOutput.images shape. */
  data: string;
  width: number;
  height: number;
}

export interface LookCaptureSide {
  selector: string;
  tag: string;
  /** The context ancestor the crop framed (or the element itself). */
  contextTag: string;
  /** The probe scrolled this element into view before the capture. */
  scrolled: boolean;
  /** Viewport-clipped CSS-px rect at capture time. */
  rect: CssRect;
}

export interface LookCaptureResult {
  images: LookCaptureImage[];
  subject: LookCaptureSide;
  /** Absent when no reference selector was given. */
  reference?: LookCaptureSide & {
    /** The exemplar lay inside the subject's crop, so one image shows both. */
    withinSubjectCrop: boolean;
  };
  devicePixelRatio: number;
  /** The subject crop was stored beside the remixlet (remixletId was given and the write succeeded). */
  cropStored: boolean;
}

// The probe's reply is PAGE-DERIVED data (the template runs in the tab):
// validated here before any number reaches the crop math.
const RectSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
});
const SideSchema = Type.Object({
  tag: Type.String(),
  rect: RectSchema,
  fullRect: RectSchema,
  contextRect: RectSchema,
  contextTag: Type.String(),
  inViewport: Type.Boolean(),
  visible: Type.Boolean(),
  scrolled: Type.Boolean(),
});
const LocateResultSchema = Type.Object({
  devicePixelRatio: Type.Number(),
  viewport: Type.Object({ width: Type.Number(), height: Type.Number() }),
  subjectTotal: Type.Number(),
  subject: Type.Union([SideSchema, Type.Null()]),
  referenceTotal: Type.Optional(Type.Number()),
  reference: Type.Optional(Type.Union([SideSchema, Type.Null()])),
});

async function locate(tabId: number, params: LocateForReviewParamsType) {
  const raw = await runProbe(tabId, "locate_for_review", params);
  // SAFETY: the value is JSON the probe template serialized; Check below is the trust boundary for its shape.
  const parsed = JSON.parse(raw) as unknown;
  if (!Check(LocateResultSchema, parsed)) throw new Error("the page returned an unreadable location report");
  return parsed;
}

function toSide(selector: string, side: { tag: string; contextTag: string; scrolled: boolean; rect: CssRect }): LookCaptureSide {
  return { selector, tag: side.tag, contextTag: side.contextTag, scrolled: side.scrolled, rect: side.rect };
}

/**
 * Locate, capture, crop. Throws with a specific, non-verdict message on every
 * failure ("selector matched nothing", "element is not visible", "capture
 * failed: …") so the model can fix the selector or the wait — never the
 * remixlet's look — and record not-reviewable when nothing can be shown.
 */
async function captureLookReviewImages(
  tabId: number,
  params: LocateForReviewParamsType,
  captureGuard: { capture(): Promise<string>; assertCurrent(): Promise<void> },
): Promise<{ result: LookCaptureResult; subjectCrop: CroppedPng }> {
  const located = await locate(tabId, params);
  if (located.subject === null) throw new Error(`selector matched nothing (${JSON.stringify(params.selector)})`);
  if (params.referenceSelector !== undefined && located.reference === null) {
    throw new Error(`reference matched nothing (${JSON.stringify(params.referenceSelector)})`);
  }
  if (!located.subject.visible || located.subject.rect.width === 0 || located.subject.rect.height === 0) {
    throw new Error("element is not visible (checkVisibility false or zero-size) — nothing to look at");
  }
  if (!(ext.tabs?.captureVisibleTab instanceof Function)) throw new Error("capture failed: this browser cannot take tab screenshots");

  let shot: string;
  try {
    shot = await captureGuard.capture();
  } catch (error) {
    if (error instanceof ScreenshotIdentityChangedError) throw error;
    throw new Error(`capture failed: ${String(error)}`);
  }
  const dpr = located.devicePixelRatio > 0 ? located.devicePixelRatio : 1;
  const size = await screenshotSize(shot);
  const subjectRegion = cropGeometry(located.subject.contextRect, located.subject.rect, dpr, size);
  const subjectCrop = await cropScreenshot(shot, subjectRegion);
  const images: LookCaptureImage[] = [{ role: "subject", ...subjectCrop }];
  const result: LookCaptureResult = {
    images,
    subject: toSide(params.selector, located.subject),
    devicePixelRatio: dpr,
    cropStored: false,
  };

  if (params.referenceSelector !== undefined && located.reference) {
    const reference = located.reference;
    // The region actually cropped, back in CSS px: when the exemplar sits
    // inside it, one image already shows both and a second would repeat it.
    const croppedCss: CssRect = {
      x: subjectRegion.x / dpr,
      y: subjectRegion.y / dpr,
      width: subjectRegion.width / dpr,
      height: subjectRegion.height / dpr,
    };
    const within = reference.inViewport && reference.visible && rectContains(croppedCss, reference.fullRect);
    if (within) {
      result.reference = { ...toSide(params.referenceSelector, reference), withinSubjectCrop: true };
    } else if (reference.inViewport && reference.visible) {
      const region = cropGeometry(reference.contextRect, reference.rect, dpr, size);
      images.push({ role: "reference", ...(await cropScreenshot(shot, region)) });
      result.reference = { ...toSide(params.referenceSelector, reference), withinSubjectCrop: false };
    } else {
      // Off-screen exemplar: a second locate scrolls IT into view, then a
      // second capture. Same quota back-off, same crop path.
      const second = await locate(tabId, { selector: params.referenceSelector, context: params.context });
      if (second.subject === null) throw new Error(`reference matched nothing (${JSON.stringify(params.referenceSelector)})`);
      if (!second.subject.visible || second.subject.rect.width === 0 || second.subject.rect.height === 0) {
        throw new Error("reference is not visible (checkVisibility false or zero-size) — pick an exemplar the page shows");
      }
      let secondShot: string;
      try {
        secondShot = await captureGuard.capture();
      } catch (error) {
        if (error instanceof ScreenshotIdentityChangedError) throw error;
        throw new Error(`capture failed: ${String(error)}`);
      }
      const secondSize = await screenshotSize(secondShot);
      const region = cropGeometry(second.subject.contextRect, second.subject.rect, dpr, secondSize);
      images.push({ role: "reference", ...(await cropScreenshot(secondShot, region)) });
      result.reference = { ...toSide(params.referenceSelector, second.subject), scrolled: true, withinSubjectCrop: false };
    }
  }

  await captureGuard.assertCurrent();
  return { result, subjectCrop };
}

export async function captureLookReview(
  tabId: number,
  params: LocateForReviewParamsType,
  storeCrop?: (png: CroppedPng) => Promise<void>,
): Promise<LookCaptureResult> {
  const captured = await withVisibleTabCaptureGuard(tabId, (guard) => captureLookReviewImages(tabId, params, guard));
  if (storeCrop) {
    try {
      await storeCrop(captured.subjectCrop);
      captured.result.cropStored = true;
    } catch {
      // The crop is nice, the verdict is required: a storage problem must
      // never fail the look itself.
    }
  }
  return captured.result;
}
