import { MANIFEST_FILE, README_FILE } from "../shared/remixlet.js";
import type { AgentToolOutput, AgentToolSpec } from "./types.js";

const CAPTURE = "capture_page";
const ASSESS = "assess_feasibility";
const LIST = "list_remixlets";
const READ = "read_remixlet";
const WRITE = "write_remixlet";
const INSPECT_DESIGN = "inspect_design";
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
const PAGE_DATA_TOOLS = new Set([CAPTURE, "evaluate_js", ...PAGE_PROBES]);
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
  files?: SubmittedFile[];
  id?: string;
  verdict?: string;
}

interface WriteDetails {
  jsChanged?: boolean;
}

interface LogDetails {
  count?: number;
}

interface VerificationDetails {
  verificationBlockedByObserverLoop?: boolean;
  observerFeedbackLoopRemixletIds?: string[];
  verificationSucceeded?: boolean;
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
 * The continuation the panel injects when a conversation resumes on top of an
 * unverified activation (the verifying turn died with the runtime — on the
 * drawer surface the activation's own tab reload destroys it). It carries the
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
  // that would have verified it died — on the drawer surface, the activation's
  // own tab reload destroys the runtime. Seeded once into the first turn after
  // resume so that turn cannot complete without an assert_page_state, then
  // consumed. Without this the obligation is lost with the dead runtime and the
  // broken build reads as finished.
  #resumedUnverifiedActivation: boolean;
  #resumedObserverRepair: boolean;
  #resumedObserverRepairIds: string[];
  #lastWrite = 0;
  #lastCapture = 0;
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
  // verification that clears the turn must then include the look-checking
  // assertion kinds (design-parity + not-clipped), not just any assertion —
  // the SoundCloud session C verified a wrong design with four assertions
  // that could not fail (wiki/raw/handoffs/design-inspection-enforcement.md).
  #pendingDesignAssertions = false;
  // The file set this turn's latest successful write activated (path →
  // content, as submitted). Retained so a post-write assert_page_state can be
  // linted for self-reference: an expected value that also appears in the
  // just-written files proves the code ran, not that the layout is right —
  // the SoundCloud 181px false pass asserted the exact height its own CSS
  // set while the real content was 277px. Cleared every beginTurn.
  #lastWriteFiles = new Map<string, string>();
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
  // write_remixlet bounces unless read_remixlet_logs ran after that failure.
  // The Spotify album-label session burned two full rewrites on a wrong theory
  // before the first log read; the single productive step was the one that
  // read evidence. Set/cleared mechanically from tool results, never prose.
  #pendingFailureEvidence = false;
  #failureLogsRead = false;
  // The post-failure log read came back empty: nothing recorded means the
  // script logged nothing, so the next write must at least instrument —
  // "first failure → instrument; fix only with the log in hand". The check is
  // deliberately just "logging calls present in the submitted JS": verifying
  // "gained logging without changing behavior" is unenforceable and invites
  // ritual compliance (the Phase A strict-but-wrong-gate lesson).
  #failureLogsEmpty = false;
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
    // have changed, and every write must follow a current look. A grant can
    // also arrive on an ordinary later turn (it stays unspent until a build
    // uses it — the second SoundCloud run lost it to a "why did you stop?"
    // interruption); such turns get the full reset below, just with the
    // granted authority available.
    this.#lastCapture = 0;
    // The click IS the plan: the user authorized exactly these names, and they
    // stay available every turn the grant is still unspent — the write gate
    // below is where the set is enforced, on the manifest a build declares.
    this.#grantedCapabilities = new Set(grantedCapabilities ?? []);
    this.#lastUntrustedPageData = 0;
    this.#pendingVerification = this.#pendingObserverRepair;
    this.#pendingDesignAssertions = false;
    this.#lastWriteFiles.clear();
    this.#pendingBothStates = false;
    this.#bothStatesStage = 0;
    this.#pendingFailureEvidence = false;
    this.#failureLogsRead = false;
    this.#failureLogsEmpty = false;
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
    this.#lastList = 0;
    this.#listedIds.clear();
    this.#knownIds.clear();
    this.#readCapabilities.clear();
    this.#lastAssess = 0;
    // Like #lastAssess, the design-context marker survives a grant
    // continuation: the exemplar and container were inspected for the same
    // request the grant resumes. (A fresh capture is still required above.)
    this.#lastInspectDesign = 0;
    this.#assessedInfeasible = false;
    this.#assessedNeedsVisibility = false;
    this.#assessedTurnEndsWithoutBuild = false;
  }

  async execute(
    spec: AgentToolSpec<never>,
    params: ToolCallInput,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolOutput> {
    const toolParams = decodeToolParams(params);
    const sequence = ++this.#sequence;
    if (spec.name === ASSESS && this.#lastUntrustedPageData === 0) {
      this.#violate(
        ASSESS,
        "Contract violation: assess_feasibility must run after observing the page (capture_page or a probe like query_elements) so the verdict is grounded in real page data, not assumption.",
      );
    }
    if (spec.name === WRITE) this.#assertWriteAllowed(toolParams);

    // SAFETY: pi has decoded params against this tool's TypeBox schema before invoking the contract.
    const output = await spec.execute(params as never, signal);
    this.#recordSuccess(spec.name, toolParams, output, sequence);
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
    return output;
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
    parts.push(
      this.#lastCapture > this.#lastWrite ? "capture done" : "capture_page still needed before write_remixlet",
    );
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
  // way includesDesignAssertions reads conditions — never from prose.
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
    if (this.#pendingDesignAssertions) {
      this.#violate(
        VERIFY,
        "Contract violation: this turn's write added UI, but the verification did not check its look. Run assert_page_state again including at least one design-parity assertion comparing your control against the host's own control of the same kind, and one not-clipped assertion on your control.",
      );
    }
    if (this.#pendingBothStates) {
      this.#violate(
        VERIFY,
        "Contract violation: this turn's write wires a click handler, but the control's behavior was never exercised — presence and look assertions cannot catch a handler that does nothing. Verify both states now: click_element the control, assert_page_state the changed state, click_element it again, and assert_page_state that the original state is restored.",
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
      !this.#pendingDesignAssertions &&
      !this.#pendingBothStates
    );
  }

  #assertWriteAllowed(params: ToolParams): void {
    // Inventory and feasibility are once-per-turn obligations: neither changes
    // when the agent's own write activates, so a same-turn follow-up write
    // (fixing a failed verification) must not repeat them as ritual. Capture
    // is different — activation reloads the tab, so EVERY write needs a look
    // at the page as it is now, hence the after-last-write comparison.
    if (this.#lastList === 0) {
      this.#violate(WRITE, "Contract violation: list_remixlets must succeed before write_remixlet.");
    }
    if (this.#lastCapture <= this.#lastWrite) {
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
    // evidence, the fix must create some.
    if (this.#pendingFailureEvidence && !this.#failureLogsRead) {
      this.#violate(
        WRITE,
        "Contract violation: a post-activation check failed, but read_remixlet_logs has not run since that failure. Read the runtime logs now — the script's own recorded output is the evidence a fix must rest on — then write the corrected version in this same turn.",
      );
    }
    if (this.#pendingFailureEvidence && this.#failureLogsRead && this.#failureLogsEmpty && !writeCarriesLogging(params)) {
      this.#violate(
        WRITE,
        "Contract violation: the logs since the failure are empty — the script recorded nothing about its own run, so there is no evidence to fix against. Make this write instrument first: add console.log/info calls at the script's key decisions (data arrived or didn't, mount attempted or skipped and why, element found or not), activate it, and read the logs before the next fix.",
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
      return;
    }
    if (name === CAPTURE) {
      this.#lastCapture = sequence;
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
      // (the gate let it through), and a new failure re-arms it afresh.
      this.#pendingFailureEvidence = false;
      this.#failureLogsRead = false;
      this.#failureLogsEmpty = false;
      // The agent authored the complete file set it just activated, so it now
      // holds current knowledge of this id — a follow-up write in the same
      // turn (e.g. fixing a failed verification) needs no ritual re-read.
      const target = parseWriteTarget(params);
      if (this.#pendingObserverRepairIds.delete(target.id) && this.#pendingObserverRepairIds.size === 0) {
        this.#pendingObserverRepair = false;
      }
      this.#knownIds.add(target.id);
      this.#readCapabilities.set(target.id, new Set(target.capabilities));
      if (writeIntroducesUi(params)) this.#pendingDesignAssertions = true;
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
      // Reading the evidence after a failure is exactly what the gate demands.
      // details.count is the recorded-entry count the tool reports; 0 means
      // the script logged nothing, which arms the instrument-first branch.
      if (this.#pendingFailureEvidence) {
        this.#failureLogsRead = true;
        this.#failureLogsEmpty =
          (output.details instanceof Object ? decodeLogDetails(output.details) : undefined)?.count === 0;
      }
      return;
    }
    if (name === CLICK && sequence > this.#lastWrite && this.#pendingBothStates) {
      // A click advances the sequence only from "not yet clicked" states; the
      // asserts in between are what make each click's effect count.
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
        if (details?.verificationSucceeded === true) {
          this.#pendingFailureEvidence = false;
          this.#failureLogsRead = false;
          this.#failureLogsEmpty = false;
        } else {
          this.#pendingFailureEvidence = true;
          this.#failureLogsRead = false;
        }
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
      if (includesDesignAssertions(params)) this.#pendingDesignAssertions = false;
      if (this.#bothStatesStage === 1) {
        this.#bothStatesStage = 2;
      } else if (this.#bothStatesStage === 3) {
        this.#bothStatesStage = 4;
        this.#pendingBothStates = false;
      }
    }
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
 * something new on the page, so the design-inspection and design-verification
 * obligations attach. A false positive costs one cheap inspect_design that is
 * beneficial anyway; pure-CSS restyles and dataset-tagging scripts never match
 * (wiki/raw/handoffs/design-inspection-enforcement.md).
 */
const UI_WRITE_PATTERN = /createElement|insertAdjacentHTML|appendChild|prepend\(|innerHTML/;

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
const CLICK_HANDLER_PATTERN = /addEventListener\(\s*["'`]click["'`]|\.onclick\s*=/;

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
 * Whether an assert_page_state call carries the look-verifying assertion kinds
 * a UI-adding turn owes: at least one design-parity (the whole-look comparison
 * against a reference control) and one not-clipped. Read mechanically from the
 * params, the way assessedVerdict reads the verdict — never from prose.
 */
function includesDesignAssertions(params: ToolParams): boolean {
  const conditions = new Set((params.assertions ?? []).flatMap((assertion) => (assertion.condition ? [assertion.condition] : [])));
  return conditions.has("design-parity") && conditions.has("not-clipped");
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

function decodeLogDetails(details: ToolDetails): LogDetails {
  const count = readProperty(details, "count");
  return { count: Number.isFinite(count) ? Number(count) : undefined };
}

function decodeVerificationDetails(details: ToolDetails): VerificationDetails {
  return {
    verificationBlockedByObserverLoop: readBooleanProperty(details, "verificationBlockedByObserverLoop"),
    observerFeedbackLoopRemixletIds: readStringArrayProperty(details, "observerFeedbackLoopRemixletIds"),
    verificationSucceeded: readBooleanProperty(details, "verificationSucceeded"),
  };
}
