// Failure classes for tool errors that are NOT breakage, so the chat can
// render each honestly instead of a one-size-fits-all red "Couldn't …" row
// (the Spotify record-label session showed its own safety-gate bounces as
// failures, which read as the user having broken something):
//
// - a contract bounce (ContractViolationError, contracts.ts): the extension
//   held the step until prerequisites ran — harness↔model choreography the
//   model remedies within seconds; the user never needed to see it.
// - a safety-gate rejection (SafetyGateError): a pre-activation review sent
//   the draft back; nothing was saved and the model writes a new version.
// - a user decline (UserDeclinedError): the user chose not to allow the step;
//   their own decision must never render as something going wrong.
//
// Everything else remains a real failure and keeps the red row.

/** A write bounced by a pre-activation review — nothing saved or activated. */
export class SafetyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyGateError";
  }
}

/** The user declined an approval this step asked for. */
export class UserDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserDeclinedError";
  }
}

export type ToolFailureKind = "bounced" | "gate" | "declined" | "error";

/**
 * Classify a STORED tool failure from its recorded result text — resumes and
 * the control center's replay have only the text, not the live error object.
 * The needles are the stable phrases the throwing sites already use; classify
 * conservatively ("error") when none match, so a real failure never renders
 * as something softer.
 */
export function classifyToolFailure(text: string): ToolFailureKind {
  if (text.includes("Contract violation:") || text.includes("has not been granted by the user")) return "bounced";
  if (text.includes("nothing was saved or activated") || text.includes("(nothing was saved)")) return "gate";
  if (text.includes("The user declined")) return "declined";
  return "error";
}
