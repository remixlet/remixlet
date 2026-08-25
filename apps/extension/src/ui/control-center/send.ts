// Worker round-trip helper shared by the control-center pages: send a panel
// message and require one specific reply kind, surfacing remixlet.error as a
// thrown Error.

import { ext } from "../../platform/ext.js";
import type { PanelToWorker, WorkerToPanel } from "../../shared/protocol.js";
import { requireWorkerReply } from "../../shared/worker-reply.js";
import { sanitizeModelTextForDisplay } from "../../shared/safe-text.js";

export async function send<K extends WorkerToPanel["kind"]>(
  message: PanelToWorker,
  expect: K,
): Promise<Extract<WorkerToPanel, { kind: K }>> {
  const reply = requireWorkerReply(message.kind, await ext.runtime.sendMessage(message));
  if (reply.kind === "remixlet.error") throw new Error(reply.message);
  if (reply.kind !== expect) throw new Error(`unexpected worker reply ${reply.kind}`);
  // SAFETY: the preceding discriminant comparison restricts reply to the requested kind.
  return reply as Extract<WorkerToPanel, { kind: K }>;
}

export async function rollbackWithApproval(id: string, sha: string): Promise<void> {
  const rollback = { kind: "remixlet.rollback", id, sha, reloadMatching: true } satisfies PanelToWorker;
  const reply = requireWorkerReply(rollback.kind, await ext.runtime.sendMessage(rollback));
  if (reply.kind === "remixlet.error") throw new Error(reply.message);
  if (reply.kind === "remixlet.entry") return;
  if (reply.kind !== "remixlet.rollbackApprovalRequired") {
    throw new Error(`unexpected worker reply ${reply.kind}`);
  }
  // The rationale is model prose interpolated into a native confirm(): strip
  // control characters and newlines first, or a rationale forges extra dialog
  // lines (H2). The capability name is structured/validated and safe as-is.
  const explanation = reply.proposal.added
    .map((capability) => `${capability}: ${sanitizeModelTextForDisplay(reply.proposal.rationales[capability] ?? "")}`)
    .join("\n");
  const approved = globalThis.confirm(
    `This rollback restores additional capabilities:\n\n${explanation}\n\nAllow this authority and roll back?`,
  );
  const resolve = {
    kind: "remixlet.resolveRollbackCapabilityApproval",
    proposalId: reply.proposal.proposalId,
    approved,
    id,
    sha,
    reloadMatching: true,
  } satisfies PanelToWorker;
  const resolved = requireWorkerReply(resolve.kind, await ext.runtime.sendMessage(resolve));
  if (resolved.kind === "remixlet.error") throw new Error(resolved.message);
  if (approved && resolved.kind !== "remixlet.entry") {
    throw new Error(`unexpected worker reply ${resolved.kind}`);
  }
  if (!approved && resolved.kind !== "remixlet.capabilityDenied") {
    throw new Error(`unexpected worker reply ${resolved.kind}`);
  }
}
