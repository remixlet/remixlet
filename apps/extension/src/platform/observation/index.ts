// Backend selection: one observation backend per browser target, all behind
// the shared ObservationBackend interface. Requests for data a target cannot
// produce degrade honestly inside the backend (missing[] notes) instead of
// failing the capture.

import { BROWSER_TARGET } from "../ext.js";
import { FirefoxObservationBackend } from "./firefox.js";
import { SnapshotBackend } from "./snapshot.js";
import { SafariObservationBackend } from "./safari.js";
import type { CaptureRequest, CaptureResult } from "./types.js";

export type * from "./types.js";
export { SnapshotBackend } from "./snapshot.js";
export { FirefoxObservationBackend } from "./firefox.js";
export { SafariObservationBackend } from "./safari.js";

export async function capturePage(req: CaptureRequest): Promise<CaptureResult> {
  if (BROWSER_TARGET === "firefox") {
    return new FirefoxObservationBackend().capture(req);
  }
  if (BROWSER_TARGET === "safari") {
    return new SafariObservationBackend().capture(req);
  }

  const result = await new SnapshotBackend().capture({
    ...req,
    needScreenshot: req.needScreenshot === "full" ? "visible" : req.needScreenshot,
  });
  if (!result.ok) return result;

  if (req.needScreenshot === "full") {
    result.bundle.missing.push("screenshot: full-page capture is not supported in Chrome — visible viewport only");
  }
  return result;
}
