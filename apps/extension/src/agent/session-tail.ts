// Reading a resumed conversation's tail for the ONE obligation the in-memory
// contract cannot carry across a runtime death: a write_remixlet that
// activated (reloading the tab) but was never verified. If the panel dies
// right after the activation's tool result is persisted — closed by the user,
// killed with the browser — the model is never re-invoked to run
// assert_page_state. #pendingVerification lives only in memory, so it dies
// too, and the resumed conversation would otherwise treat the broken
// activation as finished. This detector recovers the obligation from the
// persisted history so the contract can re-arm it and the panel can drive the
// verify-or-fix continuation. (The Instagram v1 spinner was exactly such a
// severed turn, on the since-removed in-page drawer surface whose host-tab
// reload killed the panel itself.)

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";

const WRITE = "write_remixlet";
const VERIFY = "assert_page_state";

function toolResultName(message: AgentMessage): string | undefined {
  return message.role === "toolResult" ? message.toolName : undefined;
}

/**
 * True when the conversation's most recent activation was never followed by a
 * verification run. An ordinary assert_page_state run clears the obligation,
 * pass or fail — an honest failure report is still a completed verification.
 * The exception is the runtime's observer-loop flag: that result explicitly
 * keeps the activation unverified until a corrected write passes cleanly.
 * Failed writes (isError) never activate, so they raise no obligation.
 */
const ActivationDetails = Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) });
const VerificationDetails = Type.Object({
  verificationBlockedByObserverLoop: Type.Optional(Type.Boolean()),
  observerFeedbackLoopRemixletIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

interface PendingActivationState {
  verification: boolean;
  observerRepair: boolean;
  observerRepairIds: string[];
  entry?: { id: string; name: string };
}

function pendingActivationState(messages: readonly AgentMessage[]): PendingActivationState {
  let pending = false;
  let observerRepairUnknown = false;
  let entry: { id: string; name: string } | undefined;
  const observerRepairIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const name = toolResultName(message);
    if (name === WRITE && !message.isError) {
      pending = true;
      const details = Check(ActivationDetails, message.details) ? Parse(ActivationDetails, message.details) : undefined;
      if (details?.id !== undefined) {
        const id = details.id;
        observerRepairIds.delete(id);
        entry = { id, name: details.name ?? id };
      }
    }
    else if (name === VERIFY && !message.isError) {
      const details = Check(VerificationDetails, message.details) ? Parse(VerificationDetails, message.details) : undefined;
      if (details?.verificationBlockedByObserverLoop === true) {
        pending = true;
        const ids = details.observerFeedbackLoopRemixletIds ?? [];
        if (ids.length === 0) observerRepairUnknown = true;
        else {
          observerRepairUnknown = false;
          for (const id of ids) observerRepairIds.add(id);
        }
      } else if (!observerRepairUnknown && observerRepairIds.size === 0) {
        pending = false;
      }
    }
  }
  const state: PendingActivationState = {
    verification: pending,
    observerRepair: observerRepairUnknown || observerRepairIds.size > 0,
    observerRepairIds: [...observerRepairIds],
  };
  if (entry !== undefined) state.entry = entry;
  return state;
}

export function endsWithUnverifiedActivation(messages: readonly AgentMessage[]): boolean {
  return pendingActivationState(messages).verification;
}

/**
 * The remixlet the unverified tail activation wrote (its id/name from the
 * write's own details), for the failed-exit cleanup when the auto-resume
 * attempt cap exhausts. undefined when the tail owes no verification.
 */
export function unverifiedActivationEntryAtEnd(
  messages: readonly AgentMessage[],
): { id: string; name: string } | undefined {
  const state = pendingActivationState(messages);
  return state.verification ? state.entry : undefined;
}

/** True when verification found a loop and no successful corrective write followed it. */
export function endsWithObserverRepairRequired(messages: readonly AgentMessage[]): boolean {
  return pendingActivationState(messages).observerRepair;
}

/** IDs whose loop warnings have not been followed by a successful rewrite. */
export function observerRepairIdsAtEnd(messages: readonly AgentMessage[]): string[] {
  return pendingActivationState(messages).observerRepairIds;
}
