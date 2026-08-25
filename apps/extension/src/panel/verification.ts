import type { AgentRuntimeEvent } from "../agent/types.js";
import { sanitizeVerifiedAssertions, type VerifiedAssertion } from "../shared/show-changes.js";
import type { RegistryEntry } from "../store/remixlet-store.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface ExplicitVerificationRecord {
  id: string;
  result: {
    ok: true;
    url: string;
    verifiedAt: string;
    version: number;
    headSha: string;
    /** The passing run's assertions — the "Show what changed" spots. */
    assertions?: VerifiedAssertion[];
  };
}

const VerificationDetails = Type.Object(
  { url: Type.String(), verificationSucceeded: Type.Literal(true) },
  { additionalProperties: true },
);

/**
 * Durable "last verified" metadata is stronger than agent-loop completion.
 * The loop's post-write gate requires an assert_page_state RUN (contracts.ts);
 * only a run whose assertions ALL passed can make this durable claim.
 * evaluate_js deliberately cannot: a human-approved freeform script must not
 * silently mint verification records — assertions are the explicit lane.
 */
export function explicitVerificationRecord(
  event: AgentRuntimeEvent,
  pending: RegistryEntry | undefined,
  verifiedAt: string,
): ExplicitVerificationRecord | undefined {
  if (event.kind !== "tool_end" || !event.ok || event.toolName !== "assert_page_state" || !pending) return undefined;
  const details = event.details;
  if (!Value.Check(VerificationDetails, details)) return undefined;
  // Everything in the run passed, so its assertion params are, collectively,
  // where the effect was proved on the live page — persisted so the user can
  // ask "show me" long after this conversation is gone.
  const rawAssertions = details instanceof Object && "assertions" in details ? details.assertions : undefined;
  const assertions = rawAssertions instanceof Object ? sanitizeVerifiedAssertions(rawAssertions) : [];
  const result: ExplicitVerificationRecord = {
    id: pending.id,
    result: {
      ok: true,
      url: details.url,
      verifiedAt,
      version: pending.version,
      headSha: pending.headSha,
    },
  };
  if (assertions.length > 0) result.result.assertions = assertions;
  return result;
}
