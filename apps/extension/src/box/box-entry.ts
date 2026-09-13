// Entry of the sandboxed box page (box.html). The only thing it knows about
// its surroundings is that the offscreen host is the parent window: messages
// from anywhere else are dropped, and everything the runtime says goes to the
// parent alone. See wiki/design/mediated-execution.md.

import type { BoxToHost, HostToBox } from "./protocol.js";
import { startBoxRuntime } from "./runtime.js";

startBoxRuntime({
  post: (message: BoxToHost) => {
    // The box has a null origin and the host's origin is not known here; the
    // host checks event.source against the iframe it created, so the parent
    // is the only possible recipient regardless of the target origin.
    window.parent.postMessage(message, "*");
  },
  onMessage: (handler: (message: HostToBox) => void) => {
    window.addEventListener("message", (event: MessageEvent<HostToBox | null>) => {
      if (event.source !== window.parent) return;
      // SAFETY: only the offscreen host (the parent) reaches this page, and it posts HostToBox messages alone.
      const message = event.data;
      if (!(message instanceof Object) || !("kind" in message)) return;
      handler(message);
    });
  },
});
