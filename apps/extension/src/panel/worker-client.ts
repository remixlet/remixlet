// Typed panel→worker protocol client. The single place the panel sends
// runtime messages, so tool implementations stay declarative.

import { ext } from "../platform/ext.js";
import type { PanelToWorker, WorkerToPanel } from "../shared/protocol.js";
import { requireWorkerReply as requireReply } from "../shared/worker-reply.js";

export async function sendToWorker<K extends WorkerToPanel["kind"]>(
  message: PanelToWorker,
  expect: K,
): Promise<Extract<WorkerToPanel, { kind: K }>> {
  const reply = requireReply(message.kind, await ext.runtime.sendMessage(message));
  if (reply.kind === "remixlet.error") throw new Error(reply.message);
  if (reply.kind !== expect) throw new Error(`unexpected worker reply ${reply.kind} (wanted ${expect})`);
  // SAFETY: requireReply validates the worker envelope and the branch above matches its discriminant.
  return reply as Extract<WorkerToPanel, { kind: K }>;
}

/** Raw send when multiple reply kinds are legitimate. */
export async function sendRaw(message: PanelToWorker): Promise<WorkerToPanel> {
  return requireReply(message.kind, await ext.runtime.sendMessage(message));
}
