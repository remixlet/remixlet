// Guard for every runtime.sendMessage reply, shared by the panel and the
// full-page UIs (manager, popup). It names the two shapes of page↔worker
// version skew — a page carrying a rebuilt bundle talking to a service worker
// the browser has not restarted onto the new code (an unpacked rebuild
// without an extension reload; Chrome re-fetches page scripts on navigation
// but keeps the registered worker):
//
//   - `undefined` reply: NO handler matched the message kind, because
//     runtime.sendMessage resolves undefined when no listener responds — the
//     stale worker predates the message itself.
//   - build-stamp mismatch: the stale worker DOES handle the kind but answers
//     with shapes from its own build (the Instagram following-feed run: an
//     old worker's capability proposals lacked `removed`, and the fresh
//     panel crashed on `removed.length` three activations in a row).
//
// Turning both into these messages here is the difference between a diagnosis
// and a "Cannot read properties of undefined" at some call site; it also
// tells the AGENT the tool is broken rather than its parameters wrong, so it
// escalates instead of re-guessing.

import { BUILD_ID } from "./build-id.js";
import type { PanelToWorker, WorkerToPanel } from "./protocol.js";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Both skew shapes throw this subclass so UI surfaces can recognize "the
 * extension is mid-update" and render a plain-words recovery (the popup shows
 * a Reload-extension action) instead of the diagnostic text, which stays the
 * message for consoles, the agent, and logs.
 */
export class WorkerSkewError extends Error {}

export function isWorkerSkewError(cause: unknown): cause is WorkerSkewError {
  return cause instanceof WorkerSkewError;
}

const WorkerReplyEnvelope = Type.Object({ kind: Type.String(), buildId: Type.Optional(Type.String()) }, { additionalProperties: true });
type WorkerReplyEnvelope = Static<typeof WorkerReplyEnvelope>;
interface WorkerReplyCandidate {
  readonly kind?: string;
  readonly buildId?: string;
}

export function requireWorkerReply(kind: PanelToWorker["kind"], reply: WorkerReplyCandidate | undefined): WorkerToPanel {
  if (!reply || !Value.Check(WorkerReplyEnvelope, reply)) {
    throw new WorkerSkewError(
      `the extension worker did not handle "${kind}" (no reply) — the background worker may be running ` +
        "older code than this page; reload the extension. This is not a problem with the request itself.",
    );
  }
  const stamp = reply.buildId;
  if (stamp !== BUILD_ID) {
    throw new WorkerSkewError(
      `the extension worker answered "${kind}" from a different build than this page ` +
        `(worker ${JSON.stringify(stamp ?? "unstamped")}, page ${JSON.stringify(BUILD_ID)}), so its replies may not ` +
        "have the shape this page expects; reload the extension. This is not a problem with the request itself.",
    );
  }
  // SAFETY: the worker envelope and current build stamp were validated above.
  return reply as WorkerToPanel;
}
