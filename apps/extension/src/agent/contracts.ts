import { LEFTOVER_SECTION_HEADING, citesLeftoverMark } from "../shared/marks.js";
import { MANIFEST_FILE, README_FILE } from "../shared/remixlet.js";
import type { AgentToolOutput, AgentToolSpec } from "./types.js";

const CAPTURE = "capture_page";
const ASSESS = "assess_feasibility";
const LIST = "list_remixlets";
const READ = "read_remixlet";
const WRITE = "write_remixlet";
const INSPECT_DESIGN = "inspect_design";
// The look review (wiki/design/look-review.md): after a UI-adding write the
// turn owes look_at_change (cropped side-by-side screenshots of the added
// control and the host exemplar) followed by record_look (the model's verdict,
// read mechanically from params). It replaced the design-parity assertion.
const LOOK = "look_at_change";
const RECORD_LOOK = "record_look";
// The structured probes (src/panel/tools/page-probes.ts) — belt-and-braces
// alongside the provenance-driven #lastUntrustedPageData tracking, and the
// default post-write observation lane.
const PAGE_PROBES = [
  "query_elements",
  "search_elements",
  "inspect_element",
  "inspect_design",
  "read_structured_data",
  "read_page_state",
  "list_network_resources",
  "replay_network_resource",
  "observe_network_bodies",
  "click_element",
  "assert_page_state",
] as const;
// The interaction probe: the both-states obligation below counts its
// post-write runs to know the wired control was actually exercised.
const CLICK = "click_element";
// Only an explicit-assertion run clears the post-write verification gate. A
// capture or bare query proves the page still renders, not that the change
// took effect — the SoundCloud mixes-filter run shipped a no-op exactly that
// way. Requiring the RUN (not a pass) keeps honest failure reporting possible.
const VERIFY = "assert_page_state";
const READ_LOGS = "read_remixlet_logs";
const PAGE_DATA_TOOLS = new Set([CAPTURE, LOOK, ...PAGE_PROBES]);
// Look repairs a turn may spend on "differs" verdicts before the verdict is
// accepted as final and described to the user instead — a backstop on
// perfectionism about visible detail, not a cap on an oracle bug (the oracle
// is the model's eyes, and only pixels can trigger it).
const LOOK_REPAIR_LIMIT = 2;
/** Chars of page-derived tool output retained for the data-grounding lint. */
const OBSERVED_PAGE_TEXT_BUDGET = 2_000_000;

interface WriteTarget {
  id: string;
  capabilities: string[];
}

type ContractValue = string | number | boolean | null | object;

export interface ToolCallInput {}

interface ToolDetails {}

interface ToolAssertion {
  condition?: string;
  selector?: string;
  expected?: string;
}

interface SubmittedFile {
  path: string;
  content: string;
}

interface ToolParams {
  assertions?: ToolAssertion[];
  capabilities?: string[];
  evidence?: string;
  files?: SubmittedFile[];
  activateHeld?: boolean;
  id?: string;
  verdict?: string;
  selector?: string;
  referenceSelector?: string;
  properties?: string[];
  observed?: string;
}

interface WriteDetails {
  jsChanged?: boolean;
}

interface LogDetails {
  count?: number;
}

/** capture_page's details: the leftover mark names its census found (shared/marks.ts). */
interface CaptureDetails {
  leftovers?: string[];
}

/**
 * record_look's tool_end details as the panel reads them: the tool's own
 * verdict and observed text, plus the reference the look compared against
 * (added here — the contract is the only party that knows the default and
 * whether the model overrode it). Details never reach the model.
 */
interface RecordLookDetails {
  verdict?: string;
  observed?: string;
  referenceSelector?: string;
  referenceOverridden: boolean;
  inspectedSelector?: string;
}

/** click_element's outcome: false means the page-side click policy refused it and nothing was dispatched. */
interface ClickDetails {
  clicked?: boolean;
}

interface VerificationDetails {
  verificationBlockedByObserverLoop?: boolean;
  observerFeedbackLoopRemixletIds?: string[];
  verificationSucceeded?: boolean;
  /** Set when the result text carried runtime log lines (the observer-loop block): the count shown. */
  runtimeLogLinesShown?: number;
}

/**
 * An ordering violation: the contract stopped the tool before it ran because a
 * prerequisite step is missing from this turn. Distinct from plain Errors
 * (malformed params, ungranted capability names) so the panel can render the
 * bounce as "held, prerequisites first" rather than as the step failing — the
 * tool itself was never attempted and the loop self-corrects in-turn.
 */
export class ContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolationError";
  }
}

/**
 * Marker prefix on the runtime's self-authored follow-up message, injected
 * when a turn tries to finish with an unmet obligation (an unverified
 * activation). Injecting the obligation back into the loop lets the agent
 * remedy it in the same turn instead of the turn failing after the model has
 * already stopped. The marker exists so the panel can render the persisted
 * message as the extension's own action row, never as something the user
 * typed. It carries no authority — a user typing it changes nothing beyond
 * their own chat rendering.
 */
export const CONTRACT_NUDGE_MARKER = "[contract:finish-check]";

export function contractNudgePrompt(violation: string): string {
  return `${CONTRACT_NUDGE_MARKER} This turn is not finished: ${violation} Do the missing step now, in this same turn, then give your final answer.`;
}

export function isContractNudgePrompt(text: string): boolean {
  return text.startsWith(CONTRACT_NUDGE_MARKER);
}

/**
 * Appended to every write_remixlet contract bounce: the file set was kept, so
 * the remedy is the missing step plus a re-submit, not a regeneration.
 */
export const HELD_WRITE_NOTE =
  "Your file set is held and was not discarded: after the missing step, call write_remixlet again with " +
  '{"activateHeld": true} and your commit message, and NO files, to activate exactly these files without resending ' +
  "them. Sending files again replaces the held set.";

/**
 * The continuation the panel injects when a conversation resumes on top of an
 * unverified activation (the verifying turn died with the runtime — a panel
 * closed or killed right after the activation's reload). It carries the
 * finish-check marker so the panel renders it as an action row, not a user
 * bubble, and it drives the same verify-or-fix loop the in-turn nudge does —
 * here after the reload rather than before the model stopped. Bounded by the
 * panel's per-conversation attempt cap so an unfixable feature surfaces to the
 * user instead of looping forever.
 */
export function resumeVerificationPrompt(): string {
  return (
    `${CONTRACT_NUDGE_MARKER} The last change activated but the page reloaded before it was verified, so this ` +
    "conversation resumed with the verification still owed. Verify the current page now with assert_page_state " +
    "(put timeoutMs on the first assert if the content loads after the reload). If the assertions fail, fix the " +
    "remixlet and re-verify; if they pass, say plainly what you checked."
  );
}

/**
 * First-line prefix of the panel-authored continuation a permission-card click
 * sends. Defined here (not in the panel) because the runtime uses it to tell
 * the click's own continuation turn apart from a later turn that merely still
 * carries the unspent grant. The marker is plain text and forgeable — it only
 * ever affects which turn-state markers survive beginTurn, never authority,
 * and a forged marker without the out-of-band grant changes nothing at all.
 */
export const CAPABILITY_GRANT_MARKER = "[panel:capability-grant]";

/**
 * First-line prefix of the panel-authored continuation a dev-observe card
 * click sends (wiki/raw/handoffs/2026-08-10-broad-observe-session-grant.md). Same
 * trust posture as CAPABILITY_GRANT_MARKER: plain text, forgeable, affects
 * only which turn-state markers survive beginTurn — the observation itself is
 * enabled worker-side by the panel's click, and the buffer-reading probe
 * checks the stored grant, so a forged marker without the grant reads nothing.
 */
export const DEV_OBSERVE_GRANT_MARKER = "[panel:dev-observe-grant]";

/**
 * Deterministic per-turn enforcement for the agent workflow. The prompt still
 * explains why the workflow exists; this state machine makes violating its
 * ordering a tool error and prevents a turn with an unverified activation
 * from completing successfully.
 */
export class AgentContract {
  // Monotonic across the contract's lifetime, never reset: grant-continuation
  // turns carry markers (#lastAssess, #lastList, …) across beginTurn, so
  // marker comparisons must stay valid across turn boundaries.
  #sequence = 0;
  // A verification obligation recovered from a resumed conversation's history
  // (session-tail.ts): the last activation was never verified because the turn
  // that would have verified it died with the panel's runtime. Seeded once
  // into the first turn after resume so that turn cannot complete without an
  // assert_page_state, then
  // consumed. Without this the obligation is lost with the dead runtime and the
  // broken build reads as finished.
  #resumedUnverifiedActivation: boolean;
  #resumedObserverRepair: boolean;
  #resumedObserverRepairIds: string[];
  #lastWrite = 0;
  #lastCapture = 0;
  // The sequence value at the latest beginTurn (every kind, grant
  // continuations included): a marker above it belongs to this turn segment.
  // The write gate's capture exemption keys on `#lastWrite > #turnStart` rather
  // than `#lastWrite > 0` because a grant continuation keeps #lastWrite.
  #turnStart = 0;
  // The turn's latest capture named these marks as leftovers: attributes and
  // classes a removed remixlet left on the page (wiki/decisions/leftover-marks.md).
  // A verdict whose evidence cites one is refused, since the mark is known
  // false page state. Set mechanically from the capture's details.
  #leftoverMarks: string[] = [];
  #lastList = 0;
  #listedIds = new Set<string>();
  // Remixlet ids whose current content this turn has seen — via read_remixlet
  // or its own successful write_remixlet. Modifying a listed id requires
  // membership here; the read/list order doesn't matter.
  #knownIds = new Set<string>();
  #readCapabilities = new Map<string, Set<string>>();
  // The turn's out-of-band authority: capability names the user granted by
  // clicking the panel's permission card. The write gate checks manifest
  // capabilities against this set — no conversation text (user-typed,
  // model-authored, or page-injected via history) can widen it, which is what
  // makes the grant deterministic rather than a prompt convention.
  #grantedCapabilities = new Set<string>();
  #lastUntrustedPageData = 0;
  #pendingVerification = false;
  // A runtime observer guard fired after activation. Unlike an ordinary failed
  // visual assertion, this is a known-degraded script: the obligation survives
  // turns until a corrected write clears the stale log and a clean verification
  // proves the replacement did not retrigger the guard.
  #pendingObserverRepair = false;
  #pendingObserverRepairIds = new Set<string>();
  // Set when this turn's write matched the introduces-UI heuristic: the
  // verification that clears the turn must then include the fit-checking
  // assertion kinds (visible + not-clipped on the control), not just any
  // assertion — the SoundCloud session C verified a wrong design with four
  // assertions that could not fail (wiki/raw/handoffs/design-inspection-enforcement.md).
  #pendingLookAssertions = false;
  // Set alongside it: the turn also owes a LOOK — look_at_change after the
  // write (so the crops show the activated control), then record_look. This
  // is where "looks like the host" is judged now; the retired design-parity
  // assertion compared computed-style strings and failed on identical paint
  // (wiki/design/look-parity-review.md). Cleared by a record_look whose
  // look_at_change ran after the latest write.
  #pendingLookReview = false;
  #lastLook = 0;
  // The exemplar this turn inspected first (a digest-mode inspect_design):
  // look_at_change compares against it by default, tying the before-build
  // exemplar to the after-build comparison. An explicit referenceSelector
  // overrides it, and the override is recorded so the panel can say
  // "compared against X".
  #lastInspectDesignSelector: string | undefined;
  #lookReferenceSelector: string | undefined;
  #lookReferenceOverridden = false;
  // "differs" verdicts recorded this turn — the look-repair cycle bound.
  #lookDiffers = 0;
  // record_look said "wrong-kind": the turn cannot finish on this control. A
  // successful write clears it and re-arms the look obligations, so the
  // rebuilt control is looked at afresh.
  #pendingLookRebuild = false;
  // The file set this turn's latest successful write activated (path →
  // content, as submitted). Retained so a post-write assert_page_state can be
  // linted for self-reference: an expected value that also appears in the
  // just-written files proves the code ran, not that the layout is right —
  // the SoundCloud 181px false pass asserted the exact height its own CSS
  // set while the real content was 277px. Cleared every beginTurn.
  #lastWriteFiles = new Map<string, string>();
  // The file set of this turn's last write_remixlet that a contract check
  // bounced. write_remixlet takes the COMPLETE file set every call, so a
  // bounce that discards it costs a full regeneration (~2k output tokens,
  // 35-40 s; the 2026-09-09 SoundCloud session paid it twice and minified its
  // third attempt to save tokens). Kept for the turn: the model does the
  // missing step, then re-submits with activateHeld instead of the files. One
  // at a time — a later write that carries files replaces it, a write that
  // passes the gate consumes it, beginTurn clears it.
  #heldWriteFiles: SubmittedFile[] | undefined;
  // Everything page-derived tools returned this conversation (lowercased,
  // oldest chunks evicted at the budget). The data-grounding lint checks
  // asserted DATA values against it: an expected value found in neither this
  // corpus nor the written files came from nowhere — the Spotify album-label
  // session invented the label "VRS", searched the observed bodies for it,
  // got zero matches, and still asserted href "/search/VRS/albums"
  // (wiki/raw/handoffs/2026-08-19-first-time-pass-observer-and-network-truth.md
  // §5). Never cleared by beginTurn: observations ground later turns too.
  #observedPageText: string[] = [];
  #observedPageChars = 0;
  // Set when this turn's write wired a click handler (writeWiresClickHandler):
  // the turn then owes a BOTH-STATES verification — click_element the control,
  // assert the changed state, click_element again, assert the restored state —
  // before it can complete. The terra airbnb run shipped a sort pill that was
  // a functional no-op, and verification passed because assertions can only
  // check presence/look; only clicking can catch a dead handler.
  #pendingBothStates = false;
  // Post-write progress through the owed sequence: 0 nothing yet, 1 first
  // click, 2 changed-state assert, 3 second click, 4 restored-state assert
  // (obligation met). Advanced mechanically from tool successes, never prose.
  #bothStatesStage = 0;
  // The evidence gate on the rewrite loop (wiki/raw/handoffs/2026-08-19-failure-
  // handling-…): once a post-activation assert_page_state runs whose
  // verificationSucceeded is not true (a timed-out retry window included —
  // the failure lives in the detail, never in a tool error), the next
  // write_remixlet bounces unless the runtime log was read since the
  // activation that check is about (#lastLogsRead > #lastWrite). Since the
  // activation, not since the failure: any read after the activation shows
  // that activation's own output, and a read batched alongside the failing
  // assert (the prompt says to batch independent calls) completes before the
  // assert's retry window lapses — the 2026-09-09 SoundCloud session read the
  // loop warning that way, diagnosed it, and was bounced into a second read
  // that returned byte-identical lines (~40 s, ~2k output tokens for nothing).
  // The Spotify album-label session burned two full rewrites on a wrong theory
  // before the first log read; the single productive step was the one that
  // read evidence. Set/cleared mechanically from tool results, never prose.
  #pendingFailureEvidence = false;
  // Sequence of the latest log read this turn: a read_remixlet_logs success,
  // or an assert_page_state whose result carried the runtime log lines (the
  // observer-loop block does — page-probes.ts). Reset per turn: evidence is
  // read for the turn's own activation.
  #lastLogsRead = 0;
  // That read came back empty: nothing recorded means the script logged
  // nothing, so the next write must at least instrument — "first failure →
  // instrument; fix only with the log in hand". The check is deliberately
  // just "logging calls present in the submitted JS": verifying "gained
  // logging without changing behavior" is unenforceable and invites ritual
  // compliance (the Phase A strict-but-wrong-gate lesson).
  #lastLogsEmpty = false;
  #lastAssess = 0;
  #lastInspectDesign = 0;
  #assessedInfeasible = false;
  // The latest verdict re-scoped the turn to end without a build: the panel is
  // asking the user (feasible-with-capability, needs-network-visibility) or an
  // impossibility report is owed (infeasible). While it holds, a write bounced
  // for an ungranted capability must not doom the turn — stopping for the user
  // IS the clean ending the verdict recorded.
  #assessedTurnEndsWithoutBuild = false;
  // The latest verdict was "needs-network-visibility": rung d's candidates
  // could not be verified (POST or auth-gated replay), so nothing may be built
  // until observed bodies ground a fresh verdict. Survives a grant
  // continuation on purpose — the dev-observe click enables observation, it
  // does not verify a source.
  #assessedNeedsVisibility = false;
  // Violations are sticky until remedied: keyed by the tool that bounced, and
  // cleared when a later call of that SAME tool succeeds — which the state
  // machine only permits once every prerequisite actually holds. A turn that
  // recovers in-flight (bounced write → list/read/assess → clean write)
  // completes cleanly; a turn that never remedies still fails at completion.
  // A violation whose prescribed recovery is a USER decision (an ungranted
  // capability) additionally carries remediedByAskVerdict: recording the ask —
  // an assess_feasibility verdict that ends the turn without a build — is the
  // remediation, since the tool itself cannot succeed until the user's click
  // arrives in a later turn.
  #violations: { tool: string; message: string; remediedByAskVerdict?: boolean }[] = [];

  // `resumedUnverifiedActivation` seeds the first turn's verification
  // obligation when the conversation resumes on top of an activation that was
  // never verified (its verifying turn died with the runtime). It is a boolean,
  // not sticky state: the first beginTurn spends it into #pendingVerification.
  constructor(
    {
      resumedUnverifiedActivation = false,
      resumedObserverRepair = false,
      resumedObserverRepairIds = [],
    }: {
      resumedUnverifiedActivation?: boolean;
      resumedObserverRepair?: boolean;
      resumedObserverRepairIds?: readonly string[];
    } = {},
  ) {
    this.#resumedUnverifiedActivation = resumedUnverifiedActivation;
    this.#resumedObserverRepair = resumedObserverRepair;
    this.#resumedObserverRepairIds = [...resumedObserverRepairIds];
  }

  beginTurn(grantedCapabilities?: readonly string[], grantContinuation = false): void {
    // `grantContinuation` marks the continuation the user's Allow click
    // started (the panel's grant prompt, with the grant threaded out-of-band):
    // the same request resuming, not a new one. It keeps the pre-grant turn's
    // feasibility verdict and store knowledge — re-running them is what made
    // the SoundCloud log "check what's possible" AFTER the user had already
    // approved the access. A fresh capture is still required: the page may
    // have changed, and the turn's first write must follow a current look. A
    // grant can also arrive on an ordinary later turn (it stays unspent until
    // a build uses it — the second SoundCloud run lost it to a "why did you
    // stop?" interruption); such turns get the full reset below, just with the
    // granted authority available.
    this.#turnStart = this.#sequence;
    this.#lastCapture = 0;
    this.#leftoverMarks = [];
    // The click IS the plan: the user authorized exactly these names, and they
    // stay available every turn the grant is still unspent — the write gate
    // below is where the set is enforced, on the manifest a build declares.
    this.#grantedCapabilities = new Set(grantedCapabilities ?? []);
    this.#lastUntrustedPageData = 0;
    this.#pendingVerification = this.#pendingObserverRepair;
    this.#pendingLookAssertions = false;
    this.#pendingLookReview = false;
    this.#pendingLookRebuild = false;
    this.#lookDiffers = 0;
    this.#lookReferenceSelector = undefined;
    this.#lookReferenceOverridden = false;
    this.#lastWriteFiles.clear();
    this.#heldWriteFiles = undefined;
    this.#pendingBothStates = false;
    this.#bothStatesStage = 0;
    this.#pendingFailureEvidence = false;
    this.#lastLogsRead = 0;
    this.#lastLogsEmpty = false;
    this.#violations = [];
    // Recovered obligation: a resumed conversation whose last activation was
    // never verified enters its first turn already owing verification, so the
    // turn cannot settle without an assert_page_state. Spent once — a later
    // turn is ordinary. A fresh write this turn simply re-arms the same flag
    // (now owed against the newer activation), so nothing is lost either way.
    if (this.#resumedUnverifiedActivation) {
      this.#pendingVerification = true;
      this.#resumedUnverifiedActivation = false;
    }
    if (this.#resumedObserverRepair) {
      this.#pendingObserverRepair = true;
      this.#pendingObserverRepairIds = new Set(this.#resumedObserverRepairIds);
      this.#pendingVerification = true;
      this.#resumedObserverRepair = false;
      this.#resumedObserverRepairIds = [];
    }
    if (grantContinuation) return;
    this.#lastWrite = 0;
    this.#lastLook = 0;
    this.#lastList = 0;
    this.#listedIds.clear();
    this.#knownIds.clear();
    this.#readCapabilities.clear();
    this.#lastAssess = 0;
    // Like #lastAssess, the design-context marker survives a grant
    // continuation: the exemplar and container were inspected for the same
    // request the grant resumes. (A fresh capture is still required above.)
    this.#lastInspectDesign = 0;
    this.#lastInspectDesignSelector = undefined;
    this.#assessedInfeasible = false;
    this.#assessedNeedsVisibility = false;
    this.#assessedTurnEndsWithoutBuild = false;
  }

  async execute(
    spec: AgentToolSpec<never>,
    params: ToolCallInput,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolOutput> {
    let toolParams = decodeToolParams(params);
    let effectiveParams = params;
    const sequence = ++this.#sequence;
    if (spec.name === ASSESS && this.#lastUntrustedPageData === 0) {
      this.#violate(
        ASSESS,
        "Contract violation: assess_feasibility must run after observing the page (capture_page or a probe like query_elements) so the verdict is grounded in real page data, not assumption.",
      );
    }
    if (spec.name === ASSESS) this.#assertEvidenceNotLeftover(toolParams);
    if (spec.name === WRITE) {
      toolParams = this.#resolveWriteFiles(toolParams);
      // SAFETY: the resolved write params are the decoded call with the held file set substituted, same schema shape.
      effectiveParams = toolParams as ToolCallInput;
      this.#assertWriteAllowedOrHold(toolParams);
    }
    if (spec.name === RECORD_LOOK && this.#lastLook <= this.#lastWrite) {
      // The verdict records what the model SAW in the crops of the activated
      // control; without a look after the latest write there is nothing seen.
      this.#violate(
        RECORD_LOOK,
        "Contract violation: record_look must follow a look_at_change run in this turn after your latest write — the verdict records what you saw in the crops, so look first, then record.",
      );
    }
    // The look's reference defaults to the exemplar inspected this turn: the
    // element inspect_design read BEFORE the build is the thing the build was
    // supposed to match, so the after-build comparison targets it unless the
    // model names another (an override the panel is told about).
    let lookReference: string | undefined;
    let lookReferenceOverridden = false;
    if (spec.name === LOOK) {
      const inspected = this.#lastInspectDesignSelector;
      const given = toolParams.referenceSelector;
      lookReference = given ?? inspected;
      lookReferenceOverridden = given !== undefined && inspected !== undefined && given !== inspected;
      if (given === undefined && inspected !== undefined) {
        // SAFETY: params is the decoded look_at_change object; adding the optional referenceSelector keeps its schema shape.
        effectiveParams = { ...(params as object), referenceSelector: inspected } as ToolCallInput;
      }
    }

    // SAFETY: pi has decoded params against this tool's TypeBox schema before invoking the contract.
    const output = await spec.execute(effectiveParams as never, signal);
    this.#recordSuccess(spec.name, toolParams, output, sequence);
    if (spec.name === LOOK) {
      this.#lookReferenceSelector = lookReference;
      this.#lookReferenceOverridden = lookReferenceOverridden;
      const note =
        lookReference === undefined
          ? ""
          : lookReferenceOverridden
            ? ` Note from the extension: you compared against ${JSON.stringify(lookReference)}, not the exemplar you ` +
              `inspected this turn (${JSON.stringify(this.#lastInspectDesignSelector)}); the recorded verdict will say so. ` +
              "If the inspected element WAS the right exemplar, look again without a referenceSelector."
            : toolParams.referenceSelector === undefined
              ? ` Reference: the exemplar you inspected this turn, ${JSON.stringify(lookReference)}.`
              : "";
      return note === "" ? output : { ...output, text: `${output.text}${note}` };
    }
    if (spec.name === RECORD_LOOK) return this.#recordLookResult(toolParams, output);
    if (spec.name === ASSESS) {
      // Whether this turn builds or stops is deterministic contract state, so
      // the instruction is authored here, not left to the model. A
      // feasible-with-capability verdict naming only capabilities already
      // authorized (granted by the user's click, or held by a read remixlet's
      // approved manifest) must not park the turn on another ask — the second
      // SoundCloud run stalled and re-asked on this. Any other
      // feasible-with-capability verdict ends the turn on the panel's
      // permission card: the write gate would bounce a build, and the first
      // SoundCloud feed-filter run showed the old copy's leading "proceed
      // with a normal build" walking straight into that bounce.
      const correction = this.#verdictCapabilitiesAllAvailable(toolParams)
        ? " Correction from the extension: every capability this verdict names is already granted — by the user's " +
          "Allow click in this conversation, or as part of an existing remixlet's approved access read this turn. " +
          "Do not stop, do not ask again, and do not expect another permission card: they are available to this " +
          "turn's build, so continue and build with them now."
        : toolParams.verdict === "feasible-with-capability"
          ? " Not all of these capabilities are granted yet, so this turn ends without a build: say plainly, in one " +
            "or two short sentences, what the extra access is for, then stop — the panel is already showing the " +
            "user a one-click card for exactly the capabilities named here, and their click starts the turn that " +
            "builds."
          : "";
      // Text only: the panel reads assess details for the capability card and
      // conversation assertions read details.verdict, so details stay as the
      // tool produced them.
      return { ...output, text: `${output.text}${correction} ${this.#writeStatusLine()}` };
    }
    // Grounding lint, warning-only: a post-write assert whose expected value
    // is a literal the just-written files also contain has verified the
    // remixlet's own constant, not the page. Warning is the ceiling — the same
    // shape is sometimes the legitimate "my CSS applied to the right elements"
    // check, which a static comparison cannot tell apart from the 181px false
    // pass; allPassed / verificationSucceeded / the durable badge are
    // untouched. Same output-rewrite mechanism as the ASSESS correction above.
    if (spec.name === VERIFY && this.#lastWriteFiles.size > 0) {
      const warnings: string[] = [];
      const flagged = this.#selfReferentialAssertions(toolParams);
      if (flagged.length > 0) {
        warnings.push(
          `Grounding warning from the extension: ${flagged.join("; ")}. Each flagged expected ` +
            "value is a constant your own just-written code set, so a match proves the code ran — not that the " +
            "layout is right. Measure the host side instead (the host element's own measured geometry, a pre-change " +
            "measurement, or a host exemplar's computed style) and assert against that.",
        );
      }
      const ungrounded = this.#ungroundedDataAssertions(toolParams);
      if (ungrounded.length > 0) {
        warnings.push(
          `Grounding warning from the extension: ${ungrounded.join("; ")}. Each flagged part appears in nothing ` +
            "observed this conversation — no capture, probe result, or observed response body — and not in the " +
            "files you wrote either, so the expectation is a guess. Read the real value first (search the observed " +
            "bodies or the page for it) and assert what you actually saw.",
        );
      }
      if (warnings.length > 0) return { ...output, text: `${output.text}\n\n${warnings.join("\n\n")}` };
    }
    // Construction lint, warning-only (wiki/design/look-review.md §Layer 0):
    // a UI-adding write whose style.css hardcodes typography or colour on
    // its own selectors is building a lookalike instead of inheriting the
    // host's cascade — the one real typography divergence in 37 sessions
    // came from exactly this, and it would have matched by construction had
    // the text inherited. Warning is the ceiling: a control outside any text
    // flow legitimately needs values.
    if (spec.name === WRITE && writeIntroducesUi(toolParams)) {
      const literals = hardcodedTypography(toolParams);
      if (literals.length > 0) {
        return {
          ...output,
          text:
            `${output.text}\n\nDesign warning from the extension: ${literals.join("; ")}. Text you add inside a host text ` +
            "container should set no font-*, color or line-height at all and inherit the host's; a control should reuse " +
            "the host's own class when inspect_design showed it stable, else its tokens (var(--…)). Hardcoded literals " +
            "are how added text ends up a weight off from the host's. A control outside any text flow may legitimately " +
            "need values — then keep them, and look_at_change will show whether they read right.",
        };
      }
    }
    return output;
  }

  /**
   * record_look's outcome, read mechanically from the verdict param: the
   * obligations it clears, the repair budget it spends, and the text that
   * tells the model what the extension will do with it. Details gain the
   * reference the look compared against (details never reach the model; the
   * panel stores them with the verdict).
   */
  #recordLookResult(params: ToolParams, output: AgentToolOutput): AgentToolOutput {
    const verdict = lookVerdict(params);
    // SAFETY: tool details are JSON data returned by the extension-owned record_look implementation.
    const produced = output.details instanceof Object ? (output.details as ToolDetails) : undefined;
    const details: RecordLookDetails = { referenceOverridden: this.#lookReferenceOverridden };
    const recordedVerdict = produced ? readStringProperty(produced, "verdict") : undefined;
    if (recordedVerdict !== undefined) details.verdict = recordedVerdict;
    const observed = produced ? readStringProperty(produced, "observed") : undefined;
    if (observed !== undefined) details.observed = observed;
    if (this.#lookReferenceSelector !== undefined) details.referenceSelector = this.#lookReferenceSelector;
    if (this.#lastInspectDesignSelector !== undefined) details.inspectedSelector = this.#lastInspectDesignSelector;
    let note = "";
    if (verdict === "differs") {
      note =
        this.#lookDiffers <= LOOK_REPAIR_LIMIT
          ? ` If you can point at the pixels that differ, fix them with ONE styles-only write, then look_at_change and ` +
            `record_look again (look repairs left this turn: ${LOOK_REPAIR_LIMIT - this.#lookDiffers + 1}). A difference ` +
            "you cannot see does not exist — do not rewrite for one."
          : " This is the final look verdict for this turn: do not write again for the look. Describe what you see to " +
            "the user in your closing note; it is recorded as the remixlet's \"Visual review\" in the control center.";
    }
    return { ...output, text: `${output.text}${note}`, details };
  }

  /**
   * The [contract:status] line appended to every assess_feasibility result:
   * the live write preconditions, from contract state, at the last
   * deterministic step before the model decides to generate a write. The
   * system prompt already states the per-turn rules, and the SoundCloud
   * session ignored them twice at ~20-40s of regeneration per bounce
   * (wiki/raw/handoffs/2026-08-10-pre-write-contract-preflight.md) — live state at
   * the exact decision point is the stronger signal, and it covers any future
   * precondition added to the write gate.
   */
  #writeStatusLine(): string {
    if (this.#assessedInfeasible) {
      return (
        '[contract:status] This verdict was "infeasible", so write_remixlet is blocked for this request: report ' +
        "what is impossible and why, propose the nearest feasible alternative, and let a new user turn re-scope."
      );
    }
    const parts: string[] = [];
    parts.push(this.#captureOwedForWrite() ? "capture_page still needed before write_remixlet" : "capture done");
    if (this.#lastList === 0) {
      parts.push("inventory NOT recorded — list_remixlets has not succeeded this turn");
    } else if (this.#listedIds.size === 0) {
      parts.push("inventory recorded: no remixlets exist");
    } else {
      parts.push(
        `inventory recorded: ${this.#listedIds.size} remixlet${this.#listedIds.size === 1 ? "" : "s"} ` +
          `(${[...this.#listedIds].join(", ")}) — modifying one of these also requires read_remixlet this turn`,
      );
    }
    parts.push(
      this.#lastInspectDesign > 0
        ? "inspect_design ran this turn"
        : "inspect_design has NOT run this turn — required if your write builds page elements",
    );
    return `[contract:status] Before write_remixlet this turn: ${parts.join("; ")}.`;
  }

  // The grounding lint's scan: style-equals/attr-equals assertions whose
  // string "expected" is specific enough to be someone's constant AND appears
  // verbatim in a just-written file. Read mechanically from the params, the
  // way includesLookAssertions reads conditions — never from prose.
  #selfReferentialAssertions(params: ToolParams): string[] {
    const assertions = params.assertions ?? [];
    const flagged: string[] = [];
    for (const { condition, selector, expected } of assertions) {
      if (condition !== "style-equals" && condition !== "attr-equals") continue;
      if (expected === undefined || !specificExpectedValue(expected)) continue;
      for (const [path, content] of this.#lastWriteFiles) {
        if (containsStandalone(content, expected)) {
          flagged.push(
            `${condition} on ${JSON.stringify(selector ?? "")} expects ` +
              `${JSON.stringify(expected)}, which appears in ${path}`,
          );
          break;
        }
      }
    }
    return flagged;
  }

  // Retain a page-derived tool output for the data-grounding lint. Lowercased
  // once here so every later containment check is a plain includes.
  #recordObservation(output: AgentToolOutput): void {
    let chunk = output.text;
    if (output.details !== undefined) {
      try {
        chunk += `\n${JSON.stringify(output.details)}`;
      } catch {
        // Unserializable details still leave the text half recorded.
      }
    }
    if (chunk.length === 0) return;
    this.#observedPageText.push(chunk.toLowerCase());
    this.#observedPageChars += chunk.length;
    while (this.#observedPageChars > OBSERVED_PAGE_TEXT_BUDGET && this.#observedPageText.length > 1) {
      this.#observedPageChars -= this.#observedPageText.shift()!.length;
    }
  }

  // The data-value grounding lint: attr-equals/text-contains expectations are
  // claims about page DATA, so every meaningful part of the expected value
  // must have been SEEN somewhere — a page observation (host-grounded) or the
  // just-written files (self-set marker; the self-reference lint's territory).
  // A part found in neither corpus was invented. Parts are alphanumeric runs
  // (percent-decoded first, so URL-encoded observed values still ground their
  // href), because expected values are routinely CONSTRUCTED around observed
  // data — "/search/Virus%20Recordings/albums" is honest when "Virus" and
  // "Recordings" were observed even though the full href never was.
  #ungroundedDataAssertions(params: ToolParams): string[] {
    const assertions = params.assertions ?? [];
    const flagged: string[] = [];
    for (const { condition, selector, expected } of assertions) {
      if (condition !== "attr-equals" && condition !== "text-contains") continue;
      if (expected === undefined) continue;
      const unobserved = this.#unobservedSegments(expected);
      if (unobserved.length > 0) {
        flagged.push(
          `${condition} on ${JSON.stringify(selector ?? "")} expects ` +
            `${JSON.stringify(expected)}, but ${unobserved.map((segment) => JSON.stringify(segment)).join(", ")} ` +
            "appeared in no observation and no written file",
        );
      }
    }
    return flagged;
  }

  #unobservedSegments(expected: string): string[] {
    let decoded = expected;
    try {
      decoded = decodeURIComponent(expected);
    } catch {
      // Not percent-encoded text; check it as written.
    }
    // Runs shorter than 3 characters ("a", "of", separators' debris) prove
    // nothing either way and would drown the warning in trivia.
    const segments = [...new Set(decoded.split(/[^0-9A-Za-z]+/u).filter((segment) => segment.length >= 3))];
    return segments.filter((segment) => {
      const needle = segment.toLowerCase();
      if (this.#observedPageText.some((chunk) => chunk.includes(needle))) return false;
      for (const content of this.#lastWriteFiles.values()) {
        if (content.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }

  // "Available" means a build could declare all named capabilities this turn:
  // each is granted, or one single read remixlet's manifest holds the rest —
  // the write gate checks per-target, so capabilities scattered across two
  // remixlets do NOT count (no one write may declare both without a card).
  #verdictCapabilitiesAllAvailable(params: ToolParams): boolean {
    const named = params.capabilities;
    if (params.verdict !== "feasible-with-capability" || named === undefined || named.length === 0) return false;
    const coveredBy = (manifest: Set<string>) =>
      named.every((capability) => manifest.has(capability) || this.#grantedCapabilities.has(capability));
    return coveredBy(new Set()) || [...this.#readCapabilities.values()].some(coveredBy);
  }

  assertCanComplete(): void {
    if (this.#pendingObserverRepair) {
      this.#violate(
        VERIFY,
        "Contract violation: verification detected a MutationObserver feedback loop. Read the remixlet logs, fix the observer so every reachable DOM write is idempotent, activate the corrected script, and run assert_page_state again before completing.",
      );
    }
    if (this.#pendingVerification) {
      // Keyed to the verify tool: a later assert_page_state run is exactly
      // what remedies an unverified activation.
      this.#violate(
        VERIFY,
        "Contract violation: write_remixlet activated a change, but no assert_page_state ran afterward. Verify the user-visible effect with explicit assertions (visible, style-equals, counts) before completing.",
      );
    }
    if (this.#pendingLookAssertions) {
      this.#violate(
        VERIFY,
        "Contract violation: this turn's write added UI, but the verification did not check that the control is present and fits. Run assert_page_state again including a visible assertion and a not-clipped assertion on your control.",
      );
    }
    if (this.#pendingLookRebuild) {
      this.#violate(
        WRITE,
        "Contract violation: record_look said the control is the wrong kind. Rebuild it as the host's own kind of control (write_remixlet), verify it, then look_at_change and record_look again before completing.",
      );
    }
    if (this.#pendingBothStates) {
      this.#violate(
        VERIFY,
        "Contract violation: this turn's write wires a click handler, but the control's behavior was never exercised — presence and look assertions cannot catch a handler that does nothing. Verify both states now: click_element the control, assert_page_state the changed state, click_element it again, and assert_page_state that the original state is restored.",
      );
    }
    // Last on purpose: a click-wired build hears about its unexercised handler
    // before its unlooked-at look, so the finish-check (one violation per
    // nudge) asks for the behaviour first and the look second.
    if (this.#pendingLookReview) {
      this.#violate(
        RECORD_LOOK,
        "Contract violation: this turn's write added UI, but nobody looked at it. Run look_at_change on your control and the host exemplar it was built from, look at the two crops as a designer would, then record_look with what you see.",
      );
    }
    if (this.#violations.length > 0) throw new Error(this.violations.join(" "));
  }

  get violations(): readonly string[] {
    return this.#violations.map((violation) => violation.message);
  }

  /** Whether streamed/final assistant text is safe to expose as completion. */
  get allowsAssistantOutput(): boolean {
    return (
      this.#violations.length === 0 &&
      !this.#pendingObserverRepair &&
      !this.#pendingVerification &&
      !this.#pendingLookAssertions &&
      !this.#pendingLookReview &&
      !this.#pendingLookRebuild &&
      !this.#pendingBothStates
    );
  }

  // The turn's first write owes a capture_page; a follow-up write after a
  // successful write in this turn segment does not (see #assertWriteAllowed).
  #captureOwedForWrite(): boolean {
    return this.#lastCapture === 0 && this.#lastWrite <= this.#turnStart;
  }

  /**
   * Which file set this write_remixlet call means. Files sent explicitly are
   * the payload (and supersede anything held); `activateHeld` substitutes the
   * file set a contract check bounced earlier this turn. A call with neither
   * is an invalid payload: a plain Error, never a bounce, and nothing is held
   * from it.
   */
  #resolveWriteFiles(params: ToolParams): ToolParams {
    if (params.files !== undefined) {
      this.#heldWriteFiles = undefined;
      return params;
    }
    const held = this.#heldWriteFiles;
    if (params.activateHeld === true) {
      if (held === undefined) {
        throw new Error(
          "write_remixlet: activateHeld was set but no file set is held — nothing this turn bounced off a contract " +
            "check, or a later write already consumed or replaced it. Send the complete file set in files.",
        );
      }
      return { ...params, files: held };
    }
    throw new Error(
      held === undefined
        ? "write_remixlet: files are missing. Send the complete file set in files."
        : "write_remixlet: files are missing. The file set from this turn's bounced write is still held: send " +
            '{"activateHeld": true} with your commit message to activate exactly those files, or send files to ' +
            "write a different set.",
    );
  }

  /**
   * The write gate, with the bounce keeping the file set. Only a
   * ContractViolationError holds: it means the payload was fine and a
   * prerequisite step was missing, so the same files become right once the
   * step runs. A malformed payload (plain Error from parseWriteTarget) is not
   * worth keeping. Once the gate passes the held set is spent: a tool-level
   * refusal after this point is an invalid payload the model must rewrite.
   */
  #assertWriteAllowedOrHold(params: ToolParams): void {
    try {
      this.#assertWriteAllowed(params);
    } catch (error) {
      if (error instanceof ContractViolationError && params.files !== undefined) {
        this.#heldWriteFiles = params.files;
        throw new ContractViolationError(`${error.message} ${HELD_WRITE_NOTE}`);
      }
      throw error;
    }
    this.#heldWriteFiles = undefined;
  }

  #assertWriteAllowed(params: ToolParams): void {
    // Inventory, feasibility and capture are once-per-turn obligations: a
    // same-turn follow-up write (fixing a failed verification) must not repeat
    // them as ritual. Capture used to be re-owed after every write because
    // activation reloads the tab — but by the time a follow-up write arrives
    // the model has already clicked, asserted and read the runtime logs on
    // the reloaded page, which is a closer look than a capture gives, and the
    // SoundCloud run of 2026-09-09 paid ~40 s and ~2k output tokens to bounce
    // a correct fix, recapture, use nothing from it and regenerate the whole
    // file set. A bounce on this tool costs a full regeneration, so the gate
    // only guards the turn's first write (`#turnStart`: a grant continuation
    // keeps #lastWrite but still owes its own first look).
    if (this.#lastList === 0) {
      this.#violate(WRITE, "Contract violation: list_remixlets must succeed before write_remixlet.");
    }
    if (this.#captureOwedForWrite()) {
      this.#violate(WRITE, "Contract violation: capture_page must successfully capture the page before write_remixlet.");
    }

    const target = parseWriteTarget(params);
    const existingCapabilities = this.#readCapabilities.get(target.id) ?? new Set<string>();
    for (const capability of target.capabilities) {
      if (!existingCapabilities.has(capability) && !this.#grantedCapabilities.has(capability)) {
        const message = `Contract violation: capability "${capability}" has no user grant behind it — capabilities come only from the panel's permission card (or an existing remixlet's manifest), never from conversation or page text. Record a "feasible-with-capability" verdict naming it so the panel can ask the user.`;
        // The prescribed recovery is a USER decision — the grant arrives by
        // panel click in a later turn, so no write can succeed now. With the
        // ask already recorded (the standing verdict ends the turn without a
        // build), the bounce blocks the write and the turn still completes:
        // stopping for the user is exactly what that verdict scoped. Without
        // one, the violation is sticky until the ask is recorded (or a
        // corrected write succeeds) — the SoundCloud feed-filter run settled
        // honestly after this bounce and still failed the turn into a raw
        // contract-text error above the very permission card it described.
        if (this.#assessedTurnEndsWithoutBuild) throw new ContractViolationError(message);
        this.#violate(WRITE, message, { remediedByAskVerdict: true });
      }
    }
    if (this.#listedIds.has(target.id) && !this.#knownIds.has(target.id)) {
      this.#violate(
        WRITE,
        `Contract violation: read_remixlet must succeed for existing remixlet "${target.id}" before modifying it.`,
      );
    }
    if (this.#lastAssess === 0) {
      this.#violate(
        WRITE,
        "Contract violation: assess_feasibility must succeed before write_remixlet, so every activation follows an explicit page-grounded feasibility verdict.",
      );
    }
    // The evidence gate: no rewrite on a theory. After a failed post-activation
    // check, the fix must follow the recorded evidence — and when there is no
    // evidence, the fix must create some. The evidence is any log read since
    // the activation the check is about (see #lastLogsRead), so a read made
    // alongside the failing assert, or the lines a blocked assert carried, is
    // not asked for twice.
    const evidenceRead = this.#lastLogsRead > this.#lastWrite;
    if (this.#pendingFailureEvidence && !evidenceRead) {
      this.#violate(
        WRITE,
        "Contract violation: a post-activation check failed, and the runtime log has not been read since that activation. The script's own recorded output is the evidence a fix must rest on: call read_remixlet_logs now (a read made alongside the failing check would have counted, as would the log lines a blocked assert_page_state carries), then write the corrected version in this same turn.",
      );
    }
    if (this.#pendingFailureEvidence && evidenceRead && this.#lastLogsEmpty && !writeCarriesLogging(params)) {
      this.#violate(
        WRITE,
        "Contract violation: the log since the activation is empty — the script recorded nothing about its own run, so there is no evidence to fix against. Make this write instrument first: add console.log/info calls at the script's key decisions (data arrived or didn't, mount attempted or skipped and why, element found or not), activate it, and read the logs before the next fix.",
      );
    }
    if (this.#lastInspectDesign === 0 && writeIntroducesUi(params)) {
      this.#violate(
        WRITE,
        "Contract violation: this write adds UI, but no inspect_design ran this turn. Design before you build: inspect the host's own control of the same kind (the exemplar whose look and kind your control must match) and the insertion container, then write.",
      );
    }
    if (this.#assessedInfeasible) {
      this.#violate(
        WRITE,
        'Contract violation: the latest assess_feasibility verdict was "infeasible" — do not activate an approximation. Tell the user what is impossible and why, propose the nearest feasible alternative, and let a new user turn re-scope the request.',
      );
    }
    if (this.#assessedNeedsVisibility) {
      this.#violate(
        WRITE,
        'Contract violation: the latest assess_feasibility verdict was "needs-network-visibility" — the data-bearing host is not verified yet, so do not build against a guess. After the user allows observation, read the observed responses (observe_network_bodies), then record a fresh verdict grounded in what they actually contain.',
      );
    }
  }

  #recordSuccess(name: string, params: ToolParams, output: AgentToolOutput, sequence: number): void {
    // Remediation: a success of the bounced tool clears its violations — the
    // state machine only let it through once every prerequisite held, so the
    // earlier bounce has been made good and must not fail the turn.
    this.#violations = this.#violations.filter((violation) => violation.tool !== name);
    if (output.provenance === "untrusted-page" || PAGE_DATA_TOOLS.has(name)) {
      this.#lastUntrustedPageData = sequence;
      this.#recordObservation(output);
    }
    if (name === ASSESS) {
      this.#lastAssess = sequence;
      const verdict = assessedVerdict(params);
      this.#assessedInfeasible = verdict === "infeasible";
      this.#assessedNeedsVisibility = verdict === "needs-network-visibility";
      // A feasible-with-capability verdict counts only while its capabilities
      // are NOT all available: with everything already authorized the
      // appended correction says build, and that turn keeps capability
      // bounces sticky like any other build turn.
      this.#assessedTurnEndsWithoutBuild =
        verdict === "needs-network-visibility" ||
        verdict === "infeasible" ||
        (verdict === "feasible-with-capability" && !this.#verdictCapabilitiesAllAvailable(params));
      // Recording the ask is the remediation the capability-bounce message
      // prescribes, so it clears the violations waiting on exactly that.
      if (this.#assessedTurnEndsWithoutBuild) {
        this.#violations = this.#violations.filter((violation) => violation.remediedByAskVerdict !== true);
      }
      return;
    }
    if (name === INSPECT_DESIGN) {
      this.#lastInspectDesign = sequence;
      // The FIRST digest-mode read of the turn is the exemplar (the prompt's
      // order: the host's control first, the insertion container second);
      // targeted property reads are checks, not exemplar choices.
      if (this.#lastInspectDesignSelector === undefined && params.properties === undefined && params.selector) {
        this.#lastInspectDesignSelector = params.selector;
      }
      return;
    }
    if (name === LOOK) {
      this.#lastLook = sequence;
      return;
    }
    if (name === RECORD_LOOK) {
      const verdict = lookVerdict(params);
      // Every verdict is a recorded look, so the review obligation is paid;
      // "wrong-kind" additionally owes a rebuild and a fresh look at it.
      this.#pendingLookReview = false;
      this.#pendingLookRebuild = verdict === "wrong-kind";
      if (verdict === "differs") this.#lookDiffers += 1;
      return;
    }
    if (name === CAPTURE) {
      this.#lastCapture = sequence;
      // SAFETY: tool details are JSON data returned by extension-owned tool implementations.
      const details = output.details instanceof Object ? decodeCaptureDetails(output.details) : undefined;
      this.#leftoverMarks = details?.leftovers ?? [];
      return;
    }
    if (name === LIST) {
      this.#lastList = sequence;
      // SAFETY: tool details are JSON data returned by extension-owned tool implementations.
      this.#listedIds = listedIds(output.details instanceof Object ? (output.details as ToolDetails) : undefined);
      return;
    }
    if (name === READ) {
      // SAFETY: tool details are JSON data returned by extension-owned tool implementations.
      const details = output.details instanceof Object ? (output.details as ToolDetails) : undefined;
      const id = readId(params, details);
      if (id) {
        this.#knownIds.add(id);
        this.#readCapabilities.set(id, capabilitiesFromDetails(details));
      }
      return;
    }
    if (name === WRITE) {
      this.#lastWrite = sequence;
      this.#pendingVerification = true;
      // A successful write is a fresh activation: the evidence debt was paid
      // (the gate let it through), and a new failure re-arms it afresh. Any
      // earlier log read now sits before #lastWrite, so it no longer counts.
      this.#pendingFailureEvidence = false;
      // The agent authored the complete file set it just activated, so it now
      // holds current knowledge of this id — a follow-up write in the same
      // turn (e.g. fixing a failed verification) needs no ritual re-read.
      const target = parseWriteTarget(params);
      if (this.#pendingObserverRepairIds.delete(target.id) && this.#pendingObserverRepairIds.size === 0) {
        this.#pendingObserverRepair = false;
      }
      this.#knownIds.add(target.id);
      this.#readCapabilities.set(target.id, new Set(target.capabilities));
      // A UI-adding write owes the fit assertions and a look; so does the
      // rebuild after a wrong-kind verdict, whatever its file pattern — the
      // point of the rebuild is a control someone then looks at.
      if (writeIntroducesUi(params) || this.#pendingLookRebuild) {
        this.#pendingLookAssertions = true;
        this.#pendingLookReview = true;
      }
      this.#pendingLookRebuild = false;
      this.#lastWriteFiles = writtenFiles(params);
      // Every write re-evaluates the both-states obligation from its complete
      // file set: a click-wired script owes the click → assert → click →
      // assert sequence afresh (a follow-up fix-write restarts it), and a
      // write that dropped the handler owes nothing. The store's jsChanged
      // verdict scopes it further: a CSS-only diff resubmits the unchanged
      // .js files, and re-owing the full click cycle there is pure waste — a
      // CSS breakage the cycle could catch does not exist, because
      // click_element dispatches synthetically without hit-testing. An absent
      // field is treated as changed — the safe default for details authored
      // by an older tool/worker build that does not report the diff.
      const details = output.details instanceof Object ? decodeWriteDetails(output.details) : undefined;
      this.#pendingBothStates = writeWiresClickHandler(params) && details?.jsChanged !== false;
      this.#bothStatesStage = 0;
      return;
    }
    if (name === READ_LOGS) {
      // Every read is recorded, failure pending or not: whether it counts as
      // evidence is decided at the write gate by its order against the
      // activation. details.count is the recorded-entry count the tool
      // reports; 0 means the script logged nothing, which arms the
      // instrument-first branch.
      this.#recordLogsRead(
        sequence,
        (output.details instanceof Object ? decodeLogDetails(output.details) : undefined)?.count,
      );
      return;
    }
    if (name === CLICK && sequence > this.#lastWrite && this.#pendingBothStates) {
      // A click advances the sequence only from "not yet clicked" states; the
      // asserts in between are what make each click's effect count. A click
      // the page-side policy refused (off-site link, off-site form submit;
      // wiki/ops/2026-09-12-security-review-plan.md F3) dispatched nothing, so
      // it exercised no control and advances nothing: the tool succeeded, the
      // click did not happen.
      // SAFETY: tool details are JSON data returned by extension-owned tool implementations.
      const details = output.details instanceof Object ? decodeClickDetails(output.details) : undefined;
      if (details?.clicked === false) return;
      if (this.#bothStatesStage === 0 || this.#bothStatesStage === 2) this.#bothStatesStage += 1;
      return;
    }
    if (name === VERIFY && sequence > this.#lastWrite) {
      const details = output.details instanceof Object ? decodeVerificationDetails(output.details) : undefined;
      // The evidence gate reads this run's verdict mechanically. Only a
      // post-activation run counts (a write this turn, or the resumed/sticky
      // obligation): a failing assert while probing an unmodified page is
      // information, not a failed check of the agent's own change.
      if (this.#lastWrite > 0 || this.#pendingVerification) {
        this.#pendingFailureEvidence = details?.verificationSucceeded !== true;
      }
      // An assert whose result carried the runtime log lines (the observer-
      // loop block appends the affected remixlets' newest entries) IS the log
      // read: the model has the evidence in hand, and asking for a
      // read_remixlet_logs that returns the same lines would be ritual.
      if (details?.runtimeLogLinesShown !== undefined) {
        this.#recordLogsRead(sequence, details.runtimeLogLinesShown);
      }
      if (details?.verificationBlockedByObserverLoop === true) {
        this.#pendingObserverRepair = true;
        const ids = details.observerFeedbackLoopRemixletIds;
        if (ids) for (const id of ids) if (id.length > 0) this.#pendingObserverRepairIds.add(id);
        this.#pendingVerification = true;
        return;
      }
      // Once a loop is known, another probe of the same activation cannot
      // establish a repair. Only a successful write clears this state; that
      // write then owes its own clean verification.
      if (this.#pendingObserverRepair) {
        this.#pendingVerification = true;
        return;
      }
      this.#pendingObserverRepair = false;
      this.#pendingVerification = false;
      if (includesLookAssertions(params)) this.#pendingLookAssertions = false;
      if (this.#bothStatesStage === 1) {
        this.#bothStatesStage = 2;
      } else if (this.#bothStatesStage === 3) {
        this.#bothStatesStage = 4;
        this.#pendingBothStates = false;
      }
    }
  }

  #recordLogsRead(sequence: number, count: number | undefined): void {
    this.#lastLogsRead = sequence;
    this.#lastLogsEmpty = count === 0;
  }

  /**
   * A verdict built on a leftover mark is refused: the capture already said
   * the mark is not page data and will not survive a reload, so any evidence
   * citing it describes a page that does not exist. The refusal names the
   * mark and what to do instead; the model re-checks the rungs without it.
   */
  #assertEvidenceNotLeftover(params: ToolParams): void {
    if (this.#leftoverMarks.length === 0) return;
    const cited = citesLeftoverMark(params.evidence ?? "", this.#leftoverMarks);
    if (cited === undefined) return;
    this.#violate(
      ASSESS,
      `Refused: the evidence cites ${cited}, a mark a remixlet that is no longer installed left on this page (the ` +
        `capture's "${LEFTOVER_SECTION_HEADING.replace(/^## /, "")}" section lists it). It is not page data and a reload ` +
        "drops it. Re-check the rungs without it (element attributes and text, embedded state, page state, network) and " +
        "record a verdict on what the page itself carries.",
    );
  }

  #violate(tool: string, message: string, options?: { remediedByAskVerdict?: boolean }): never {
    if (!this.#violations.some((violation) => violation.message === message)) {
      this.#violations.push({ tool, message, remediedByAskVerdict: options?.remediedByAskVerdict === true });
    }
    throw new ContractViolationError(message);
  }
}

function parseWriteTarget(params: ToolParams): WriteTarget {
  const files = params.files;
  if (files === undefined) throw new Error("Contract violation: write_remixlet files are missing.");
  const fileNamed = (path: string) =>
    files.find((file) => file.path === path);
  const manifestFile = fileNamed(MANIFEST_FILE);
  if (!manifestFile) throw new Error(`Contract violation: write_remixlet must include ${MANIFEST_FILE}.`);
  // The plain-English record of intent travels with the code: without it, a
  // future fix turn has only selectors to guess the feature's purpose from.
  if ((fileNamed(README_FILE)?.content.trim() ?? "") === "") {
    throw new Error(
      `Contract violation: write_remixlet must include a non-empty ${README_FILE} — the remixlet's plain-English ` +
        "record of what it is supposed to do (intent, behavior, page assumptions, decisions), kept current with " +
        "every write.",
    );
  }
  let manifest: object;
  try {
    manifest = JSON.parse(manifestFile.content);
  } catch {
    throw new Error("Contract violation: write_remixlet remixlet.json is not valid JSON.");
  }
  const id = readStringProperty(manifest, "id");
  if (id === undefined || id.length === 0) {
    throw new Error("Contract violation: write_remixlet remixlet.json has no id.");
  }
  const capabilities = readStringArrayProperty(manifest, "capabilities");
  if (hasProperty(manifest, "capabilities") && capabilities === undefined) {
    throw new Error("Contract violation: write_remixlet capabilities must be an array of strings.");
  }
  return { id, capabilities: capabilities ?? [] };
}

/**
 * The "introduces UI" heuristic: a static pattern over the write's submitted
 * JS file contents. Any of these DOM-building calls means the write mounts
 * something new on the page, so the design-inspection, fit-assertion and
 * look-review obligations attach. A false positive costs one cheap inspect_design that is
 * beneficial anyway; pure-CSS restyles and dataset-tagging scripts never match
 * (wiki/raw/handoffs/design-inspection-enforcement.md).
 */
// Both spellings: the box's dom API (dom.create, clone, setHTML, append/
// prepend/before/after, addStyle) and the raw DOM names, which still catch a
// script that was written against the old world before the write is refused.
const UI_WRITE_PATTERN =
  /dom\.create\(|dom\.clone\(|\.clone\(|dom\.addStyle\(|\.setHTML\(|\.append\(|\.prepend\(|\.before\(|\.after\(|createElement|insertAdjacentHTML|appendChild|innerHTML/;

function submittedFiles(params: { files?: unknown }): SubmittedFile[] {
  if (!Array.isArray(params.files)) return [];
  return params.files.filter(
    (file): file is SubmittedFile =>
      file instanceof Object &&
      Object.prototype.toString.call(Object.getOwnPropertyDescriptor(file, "path")?.value) === "[object String]" &&
      Object.prototype.toString.call(Object.getOwnPropertyDescriptor(file, "content")?.value) === "[object String]",
  );
}

function jsFilesMatch(params: { files?: unknown }, pattern: RegExp): boolean {
  return submittedFiles(params).some((file) => file.path.endsWith(".js") && pattern.test(file.content));
}

export function writeIntroducesUi(params: { files?: unknown }): boolean {
  return jsFilesMatch(params, UI_WRITE_PATTERN);
}

/**
 * The "wires a click handler" heuristic — the interactive sibling of
 * writeIntroducesUi, same static-pattern shape over the write's submitted JS
 * files. A registered click listener (or onclick assignment) means the write
 * ships behavior only a click can exercise, so the both-states verification
 * obligation attaches. A false positive costs one click_element round trip
 * that is beneficial anyway; reads and pure restyles never match.
 */
const CLICK_HANDLER_PATTERN = /\.on\(\s*["'`]click["'`]|addEventListener\(\s*["'`]click["'`]|\.onclick\s*=/;

export function writeWiresClickHandler(params: { files?: unknown }): boolean {
  return jsFilesMatch(params, CLICK_HANDLER_PATTERN);
}

/**
 * The instrument-first check's whole test: at least one logging call in the
 * submitted JS. Deliberately this shallow — "gained logging WITHOUT changing
 * behavior" is unenforceable and invites ritual compliance, and a write that
 * already carries logging must sail through (the known-good fixture).
 */
const LOGGING_CALL_PATTERN = /console\.(log|info|warn|error|debug)\s*\(|rmx\.log/;

export function writeCarriesLogging(params: { files?: unknown }): boolean {
  return jsFilesMatch(params, LOGGING_CALL_PATTERN);
}

/**
 * The write's CODE files as a path → content map, for the grounding lint.
 * Only .js/.css count: a value quoted in README.md prose or the manifest is a
 * record of an observation, not a constant the code sets — scanning those made
 * the warning claim something false about correctly host-grounded asserts.
 */
function writtenFiles(params: ToolParams): Map<string, string> {
  const files = params.files ?? [];
  const map = new Map<string, string>();
  for (const file of files) {
    if (/\.(js|css)$/.test(file.path)) map.set(file.path, file.content);
  }
  return map;
}

/**
 * Whole-value containment: the literal must not sit inside a longer run of
 * word characters, so a host-measured "20px" is never flagged because the
 * written CSS happens to contain "120px".
 */
function containsStandalone(content: string, value: string): boolean {
  if (value.length === 0) return false;
  const wordChar = /[0-9A-Za-z]/;
  for (let from = content.indexOf(value); from !== -1; from = content.indexOf(value, from + 1)) {
    const before = content[from - 1];
    const after = content[from + value.length];
    if ((before === undefined || !wordChar.test(before)) && (after === undefined || !wordChar.test(after))) {
      return true;
    }
  }
  return false;
}

/**
 * CSS keywords common enough that finding one in the written files proves
 * nothing: "none" appears verbatim in every declarative-hide style.css the
 * prompt mandates, and asserting it after a hide is the product's single most
 * common legitimate check. Compared lowercased.
 */
const COMMON_CSS_KEYWORDS = new Set([
  "absolute", "baseline", "block", "bold", "border-box", "capitalize", "center", "collapse", "column",
  "content-box", "dashed", "default", "dotted", "ellipsis", "fixed", "flex", "flex-end", "flex-start", "grid",
  "hidden", "inherit", "initial", "inline", "inline-block", "inline-flex", "italic", "lowercase", "middle",
  "normal", "nowrap", "pointer", "relative", "revert", "row-reverse", "solid", "space-around", "space-between",
  "static", "sticky", "transparent", "underline", "unset", "uppercase", "visible",
]);

/**
 * "Specific enough to be someone's constant": contains a digit (dimensions
 * like 181px, hex colors, z-indexes) — a bare single character such as "0" is
 * still too generic — or a non-keyword string long enough not to be a stock
 * CSS value. Without this threshold the warning drowns in legitimate short
 * values (none, auto, true, 0) that also sit in the written files.
 */
function specificExpectedValue(value: string): boolean {
  if (/\d/.test(value)) return value.length >= 2;
  return value.length >= 6 && !COMMON_CSS_KEYWORDS.has(value.toLowerCase());
}

/**
 * Whether an assert_page_state call carries the fit-checking assertion kinds
 * a UI-adding turn owes: a visible and a not-clipped assertion (on the added
 * control — the selector is the model's to choose). Read mechanically from
 * the params, the way assessedVerdict reads the verdict — never from prose.
 * Whether the control LOOKS right is the look review's question, not an
 * assertion's (wiki/design/look-review.md).
 */
function includesLookAssertions(params: ToolParams): boolean {
  const conditions = new Set((params.assertions ?? []).flatMap((assertion) => (assertion.condition ? [assertion.condition] : [])));
  return conditions.has("visible") && conditions.has("not-clipped");
}

const LOOK_VERDICTS = new Set(["matches", "differs", "wrong-kind", "not-reviewable"]);

function lookVerdict(params: ToolParams): string {
  const verdict = params.verdict;
  if (verdict === undefined || !LOOK_VERDICTS.has(verdict)) {
    throw new Error('Contract violation: record_look verdict must be "matches", "differs", "wrong-kind", or "not-reviewable".');
  }
  return verdict;
}

/**
 * The construction lint's scan: declarations in the write's CSS files that
 * set typography or colour to a LITERAL (not inherit/unset/currentColor, not
 * a var(--token)) inside a rule whose selector targets the remixlet's own
 * elements (the rmx- prefix the prompt mandates for added ids and classes).
 * Rules on host elements are left alone — restyling the host is a legitimate
 * feature; a lookalike built from literals is the smell. Comments are
 * stripped first; nested at-rules are read through their outer braces.
 */
const TYPOGRAPHY_PROPERTIES = new Set(["font", "font-family", "font-size", "font-weight", "color", "line-height"]);

export function hardcodedTypography(params: { files?: unknown }): string[] {
  const findings: string[] = [];
  for (const file of submittedFiles(params)) {
    if (!file.path.endsWith(".css")) continue;
    const css = file.content.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (let match = rule.exec(css); match !== null; match = rule.exec(css)) {
      const selector = (match[1] ?? "").trim().split("}").pop()?.trim() ?? "";
      if (!/rmx/i.test(selector) || selector.startsWith("@")) continue;
      for (const declaration of (match[2] ?? "").split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1) continue;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim().replace(/\s*!important$/i, "");
        if (!TYPOGRAPHY_PROPERTIES.has(property) || value.length === 0) continue;
        if (/^(inherit|unset|initial|revert(-layer)?|currentcolor)$/i.test(value) || /^var\(/i.test(value)) continue;
        if (findings.length < 6) findings.push(`${file.path} sets ${property}: ${value} on ${JSON.stringify(selector.slice(0, 80))}`);
      }
    }
  }
  return findings;
}

const ASSESS_VERDICTS = new Set([
  "feasible",
  "feasible-with-capability",
  "needs-network-visibility",
  "partial",
  "infeasible",
]);

function assessedVerdict(params: ToolParams): string {
  const verdict = params.verdict;
  if (verdict === undefined || !ASSESS_VERDICTS.has(verdict)) {
    throw new Error(
      'Contract violation: assess_feasibility verdict must be "feasible", "feasible-with-capability", "needs-network-visibility", "partial", or "infeasible".',
    );
  }
  return verdict;
}

function capabilitiesFromDetails(details: ToolDetails | undefined): Set<string> {
  return new Set(details ? readStringArrayProperty(details, "capabilities") ?? [] : []);
}

function listedIds(details: ToolDetails | undefined): Set<string> {
  if (!Array.isArray(details)) return new Set();
  return new Set(
    details
      .flatMap((entry) => (entry instanceof Object ? [readStringProperty(entry, "id")] : []))
      .filter((id): id is string => id !== undefined),
  );
}

function readId(params: ToolParams, details: ToolDetails | undefined): string | undefined {
  return (details ? readStringProperty(details, "id") : undefined) ?? params.id;
}

function decodeToolParams(input: ToolCallInput): ToolParams {
  // SAFETY: pi decoded the call against the exact TypeBox schema registered for this tool before invoking the contract.
  return input as ToolParams;
}

function readProperty(source: ToolDetails, property: string): ContractValue | undefined {
  return Object.getOwnPropertyDescriptor(source, property)?.value;
}

function hasProperty(source: ToolDetails, property: string): boolean {
  return Object.hasOwn(source, property);
}

function readStringProperty(source: ToolDetails, property: string): string | undefined {
  const value = readProperty(source, property);
  if (String(value) !== value) return undefined;
  // SAFETY: String(value) equals value only when this parsed property is a primitive string.
  return value as string;
}

function readStringArrayProperty(source: ToolDetails, property: string): string[] | undefined {
  const value = readProperty(source, property);
  if (!Array.isArray(value) || !value.every((entry) => String(entry) === entry)) return undefined;
  // SAFETY: every array entry passed the primitive-string check immediately above.
  return value as string[];
}

function readBooleanProperty(source: ToolDetails, property: string): boolean | undefined {
  const value = readProperty(source, property);
  if (value !== true && value !== false) return undefined;
  // SAFETY: the branch admits only boolean literals.
  return value as boolean;
}

function decodeWriteDetails(details: ToolDetails): WriteDetails {
  return { jsChanged: readBooleanProperty(details, "jsChanged") };
}

function decodeCaptureDetails(details: ToolDetails): CaptureDetails {
  return { leftovers: readStringArrayProperty(details, "leftovers") };
}

function decodeLogDetails(details: ToolDetails): LogDetails {
  const count = readProperty(details, "count");
  return { count: Number.isFinite(count) ? Number(count) : undefined };
}

function decodeClickDetails(details: ToolDetails): ClickDetails {
  return { clicked: readBooleanProperty(details, "clicked") };
}

function decodeVerificationDetails(details: ToolDetails): VerificationDetails {
  const runtimeLogLinesShown = readProperty(details, "runtimeLogLinesShown");
  return {
    verificationBlockedByObserverLoop: readBooleanProperty(details, "verificationBlockedByObserverLoop"),
    observerFeedbackLoopRemixletIds: readStringArrayProperty(details, "observerFeedbackLoopRemixletIds"),
    verificationSucceeded: readBooleanProperty(details, "verificationSucceeded"),
    runtimeLogLinesShown: Number.isFinite(runtimeLogLinesShown) ? Number(runtimeLogLinesShown) : undefined,
  };
}
