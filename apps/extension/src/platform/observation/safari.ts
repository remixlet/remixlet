// Safari's honest baseline: DOM plus visible-tab screenshot. There is no
// response-stream API, so richer requests degrade explicitly in the
// resulting bundle rather than presenting impossible permission prompts.

import { SnapshotBackend } from "./snapshot.js";
import type { CaptureRequest, CaptureResult, ObservationBackend, ObservationProvides } from "./types.js";

export class SafariObservationBackend implements ObservationBackend {
  readonly kind = "safari";
  readonly provides: ObservationProvides = {
    dom: true,
    screenshot: "visible",
    network: false,
    console: false,
    evaluate: false,
  };

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const snapshot = await new SnapshotBackend().capture({
      ...req,
      needScreenshot: req.needScreenshot === "full" ? "visible" : req.needScreenshot,
      needNetwork: false,
      needConsole: false,
    });
    if (!snapshot.ok) return snapshot;

    snapshot.bundle.producedBy = "safari";
    snapshot.bundle.missing = snapshot.bundle.missing.filter(
      (message) => !message.startsWith("network:") && !message.startsWith("console:"),
    );
    if (req.needNetwork) {
      snapshot.bundle.missing.push("network: Safari WebExtensions do not expose response-body observation");
    } else {
      snapshot.bundle.missing.push("network: not requested");
    }
    if (req.needConsole) {
      snapshot.bundle.missing.push("console: Safari WebExtensions do not expose page console history");
    }
    if (req.needScreenshot === "full") {
      snapshot.bundle.missing.push("screenshot: Safari capture is limited to the visible viewport");
    }
    return snapshot;
  }
}
