// The missing rung of the capability ask (wiki/raw/handoffs/network-data-visibility.md
// §3b/§4). A "feasible-with-capability" verdict reached mid-turn cannot become a
// build: the write gate rejects any manifest capability without a user grant
// behind it, so only a fresh, trusted user turn may authorize new authority.
// Until this module existed the agent said exactly that in prose and the turn ended
// with nothing to click — the user had to infer the capability string and retype
// it verbatim, which is what the live SoundCloud run got stuck on.
//
// So: take the capability names the verdict recorded and offer them as a
// one-click authorization that starts the next turn. Two properties matter.
//
//   - Names are validated against the manifest grammar here, never rendered or
//     echoed raw. They come from a model that has just read untrusted page data,
//     so anything unrecognized is dropped rather than shown to the user as
//     something to allow.
//   - No model-authored prose reaches the prompt the click sends. The card shows
//     the extension's own explanation of each capability, so a click cannot
//     launder page text into a trusted user message.
//
// Allowing authorizes the agent to *build with* those capabilities —
// and, because the names are validated and panel-authored, the click also
// answers the activation dialog's question for exactly that set: while the
// clicked grant is UNSPENT, an activation proposal whose ADDED capabilities
// all fall inside it is auto-approved, so the user is not asked to authorize
// the same names twice (the live SoundCloud run showed that double ask reads
// as a bug). A grant stays unspent until a successful build consumes it — it
// survives an interrupted turn and intervening user messages in the same
// conversation, because a second SoundCloud run showed a "why did you stop?"
// question voiding the click and forcing the user to Allow the identical
// access again. Any proposal naming capabilities outside the clicked set
// still gets the dialog.
//
// The click's authority travels OUT OF BAND: the clicked set goes into
// AgentContract.beginTurn (via AgentPromptOptions.grantedCapabilities), and
// the contract's write gate rejects any manifest capability outside it.
// The continuation prompt below is therefore pure narration for the model —
// counterfeiting it (typed by a user, or injected into history via captured
// page text) grants nothing, because nothing anywhere parses chat text for
// authority. Its marker prefix exists only so the chat can render the turn as
// what it was — the user's click, shown as an action row — instead of a
// fabricated user bubble, both live and when a conversation is resumed.

import { CAPABILITY_GRANT_MARKER, DEV_OBSERVE_GRANT_MARKER } from "../agent/contracts.js";
import { capabilityExplanation } from "../shared/capability-copy.js";
import { FETCH_CAPABILITY_PREFIX, fetchHostPattern } from "../shared/fetch-capability.js";
import { NETWORK_OBSERVE_PREFIX, observeHostPattern } from "../shared/observe-capability.js";
import type { CapabilityApprovalProposal } from "../worker/activation.js";
import { matchesCoverAllSites, matchesSpanningPublicSuffix } from "../shared/site-key.js";

export { CAPABILITY_GRANT_MARKER, DEV_OBSERVE_GRANT_MARKER };
export { capabilityExplanation };

/** Capabilities with no argument, as named in the system prompt's Capabilities section. */
const BARE_CAPABILITIES = new Set([
  "storage",
  "menu",
  "clipboard",
  "notifications",
  "netrules",
  "schedule",
]);

/** A single ask can name a handful of capabilities; a hundred is a bug or an attack. */
const MAX_REQUESTED = 6;

export interface PendingCapabilityRequest {
  capabilities: string[];
}

interface CapabilityVerdictDetails {
  verdict?: string;
  capabilities: string[];
}

export interface ScopeExplanation {
  title: string;
  detail: string;
}

export function isKnownCapabilityName(name: string): boolean {
  if (BARE_CAPABILITIES.has(name)) return true;
  if (name.startsWith(FETCH_CAPABILITY_PREFIX)) return fetchHostPattern(name) !== undefined;
  if (name.startsWith(NETWORK_OBSERVE_PREFIX)) return observeHostPattern(name) !== undefined;
  return false;
}

export function sanitizedCapabilityNames<T>(value: T): string[] {
  if (!Array.isArray(value)) return [];
  const known = value.filter(isString).filter(isKnownCapabilityName);
  return [...new Set(known)].slice(0, MAX_REQUESTED);
}

/**
 * The capability ask carried by an assess_feasibility result, if it made one.
 * Any other verdict clears the ask — a later "feasible" verdict in the same turn
 * means the agent found a path that needs no new authority.
 */
export function capabilityRequestFromVerdict<T>(details: T): PendingCapabilityRequest | undefined {
  const recorded = parseCapabilityVerdict(details);
  if (recorded?.verdict !== "feasible-with-capability") return undefined;
  const capabilities = recorded.capabilities;
  return capabilities.length === 0 ? undefined : { capabilities };
}

/**
 * The granted turn's continuation prompt, authored here rather than by the
 * model. Deliberately authority-free: it TELLS the model what the click
 * granted, but the grant itself is enforced by the contract from the
 * out-of-band clicked set — this text could be forged verbatim and still
 * grant nothing.
 */
export function capabilityGrantPrompt(capabilities: string[]): string {
  return (
    `${CAPABILITY_GRANT_MARKER} ${capabilities.join(", ")}\n` +
    "Panel note: the user clicked Allow for the capabilities named above, for the request already in this " +
    "conversation. This note itself grants nothing — the extension enforces the granted set at write and " +
    "activation, rejecting names outside it. These capabilities are available to build with now: build, activate, " +
    "and verify the remixlet. Your pre-grant findings carry over — the feasibility verdict, inventory, and design " +
    "inspection all still count (only capture_page must be fresh), so go straight from the capture to the write " +
    "instead of re-probing elements or styles you already inspected: every re-probe costs the user real seconds."
  );
}

/**
 * The exact-host trap (the luna airbnb run): a fetch:/network:observe host
 * pattern without "*." covers ONLY that exact host, so "fetch:airbnb.com.sg"
 * on a page at www.airbnb.com.sg denies every fetch of the site's own pages —
 * and the model that names such a pattern usually means the whole site.
 * Returns extension-authored steering naming each capability whose exact
 * pattern is a strict ancestor of the current page's host (the one shape
 * where "I meant this site" and "this pattern excludes this site" collide);
 * empty string when nothing is trap-shaped. Steering only — silently widening
 * the pattern would change what the user is asked to grant.
 */
export function capabilityPageHostWarning(capabilities: readonly string[], pageHost: string): string {
  const host = pageHost.toLowerCase();
  if (host.length === 0) return "";
  const traps: string[] = [];
  for (const capability of capabilities) {
    let prefix: string | undefined;
    let pattern: string | undefined;
    if (capability.startsWith(FETCH_CAPABILITY_PREFIX)) {
      prefix = FETCH_CAPABILITY_PREFIX;
      pattern = fetchHostPattern(capability);
    } else if (capability.startsWith(NETWORK_OBSERVE_PREFIX)) {
      prefix = NETWORK_OBSERVE_PREFIX;
      pattern = observeHostPattern(capability);
    }
    if (prefix === undefined || pattern === undefined || pattern.startsWith("*.")) continue;
    if (host !== pattern && host.endsWith(`.${pattern}`)) {
      traps.push(
        `${prefix}${pattern} covers only "${pattern}" exactly, and this page is on "${host}" — requests to this ` +
          `site's own pages would be denied; name ${prefix}*.${pattern} instead if the feature reaches this site itself`,
      );
    }
  }
  if (traps.length === 0) return "";
  return ` Check from the extension: ${traps.join("; ")}.`;
}

// The extension's own plain-language account of a capability lives in
// shared/capability-copy.ts (imported and re-exported at the top of this file)
// so the control-center bundle can use it too, without importing panel code.

/**
 * The extension's own plain-language account of a remixlet's SCOPE — which
 * sites its code runs on — for the scope card above the capability list. Panel-
 * authored like capabilityExplanation and for the same reason (the H2
 * invariant): the manifest's `matches` come from a model that just read
 * untrusted page data, so the wording here is the extension's, never the
 * model's. `title` is the reach in one line; `detail` is what it means.
 */
export function scopeExplanation(matches: readonly string[], siteKey: string): ScopeExplanation {
  if (matchesCoverAllSites(matches)) {
    return {
      title: "Runs on every site you visit",
      detail: "It can read and change every page you open.",
    };
  }
  // A wildcard over a shared domain (`*.appspot.com`, `*.co.il`): the write
  // gate refuses these today, so this is the stored-artifact case (item 8),
  // and the card must say what such a pattern reaches rather than list the
  // suffix as if it were one site.
  const spanned = matchesSpanningPublicSuffix(matches);
  if (spanned.length > 0) {
    const list = spanned.length === 1 ? spanned[0]! : `${spanned.slice(0, -1).join(", ")} and ${spanned.at(-1)}`;
    return {
      title: `Runs on every site under ${list}`,
      detail: `People host their own sites on ${spanned.length === 1 ? "this domain" : "these domains"}, you must be aware your remixlet will apply to all of them.`,
    };
  }
  const hosts = siteKey.split("+").filter((part) => part.length > 0 && part !== "*");
  if (hosts.length === 0) {
    return {
      title: "Runs on the sites it names",
      detail: "It can read and change pages on those sites and nothing else.",
    };
  }
  const list = hosts.length === 1 ? hosts[0]! : `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`;
  return {
    title: `Runs on ${list}`,
    detail: "It can read and change pages there, subdomains included, and nothing else.",
  };
}

/**
 * The activation dialog's title: the one question this proposal asks. The
 * dialog never opens for the everyday grant (the chat card covers that and
 * activation auto-approves it), only for what the card never covered — an
 * all-sites or shared-domain scope, a version that widens its site list, a
 * changed network-rules file, or code that would run outside the site this
 * chat is bound to. Each is a different question, so the title asks it; only
 * when several apply at once does the generic title stand in.
 */
export function approvalDialogTitle(proposal: CapabilityApprovalProposal): string {
  const questions: string[] = [];
  if (proposal.coversAllSites) questions.push("Run on every site?");
  else if (proposal.broadScope) questions.push("Run on more sites?");
  if (proposal.netRulesChanged) questions.push("Apply its changed network rules?");
  if (proposal.offSite) questions.push("Run on other sites too?");
  return questions.length === 1 ? questions[0]! : "Allow more access?";
}

/**
 * How the chat renders a grant turn: the user's click as an action row, not a
 * message bubble. Text only — the row's icon is chosen where it renders.
 */
export function capabilityGrantActionLabel(capabilities: string[]): string {
  return `You allowed: ${capabilities.map((capability) => capabilityExplanation(capability).title.toLowerCase()).join("; ")}`;
}

/**
 * The replacement half of an activation that swaps one capability for another:
 * what the new version stops using. A dropped capability is durably gone (the
 * stored manifest is the approval record, and the new version's manifest no
 * longer names it), and telling the user is what makes the ask read as a
 * replacement rather than ever-growing access — the SoundCloud run's "one
 * more access" wording left the user believing both grants stayed live.
 */
export function capabilityRemovalNote(removed: readonly string[]): string | undefined {
  if (removed.length === 0) return undefined;
  return `No longer used: ${removed.map((capability) => capabilityExplanation(capability).title.toLowerCase()).join("; ")}`;
}

/**
 * The validated capability names of a grant continuation, or undefined for
 * ordinary user text. Used only for RENDERING (action row instead of a user
 * bubble); a hand-typed marker line changes how a message looks, never what
 * is granted.
 */
export function capabilityGrantFromPrompt(text: string): string[] | undefined {
  if (!text.startsWith(CAPABILITY_GRANT_MARKER)) return undefined;
  const firstLine = text.slice(CAPABILITY_GRANT_MARKER.length).split("\n", 1)[0] ?? "";
  const capabilities = sanitizedCapabilityNames(firstLine.split(",").map((name) => name.trim()));
  return capabilities.length > 0 ? capabilities : undefined;
}

// ---------------------------------------------------------------------------
// The development-time observation ask (wiki/raw/handoffs/
// 2026-08-10-broad-observe-session-grant.md). Deliberately NOT a capability
// name: it is agent-side, conversation-scoped authority that must never be
// plannable, manifest-declarable, or part of any durable grant record — so it
// travels on its own channel with the same shape as the capability ask
// (verdict → panel-authored card → click → panel-authored continuation), and
// the same trust posture (the click is the grant; the prompt is narration).
// ---------------------------------------------------------------------------

/** Whether an assess_feasibility result asked for development-time observation. */
export function devObserveRequestFromVerdict<T>(details: T): boolean {
  return parseCapabilityVerdict(details)?.verdict === "needs-network-visibility";
}

function parseCapabilityVerdict<T>(details: T): CapabilityVerdictDetails | undefined {
  if (Object.prototype.toString.call(details) !== "[object Object]") return undefined;
  const source = Object(details);
  const verdict = source.verdict;
  const capabilities = source.capabilities;
  return { verdict: isString(verdict) ? verdict : undefined, capabilities: sanitizedCapabilityNames(capabilities) };
}

function isString<T>(value: T): value is T & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/**
 * The dev-observe card's plain-language copy — panel-authored like every
 * capability surface: the title is the thing being allowed, the detail says
 * what it means for the person deciding, in everyday words.
 */
export const DEV_OBSERVE_EXPLANATION = {
  title: "See what this page loads, for this chat",
  detail: "It reads the data the site already fetches, and the page reloads once.",
} as const;

/** The action row the chat shows for the click, live and on resume. */
export const DEV_OBSERVE_GRANT_ACTION_LABEL =
  "You allowed: watching what this page loads, for this chat";

/**
 * The granted continuation the dev-observe click sends. Panel-authored and
 * authority-free like capabilityGrantPrompt: the observation was enabled by
 * the worker on the click, and the buffer-reading probe checks the stored
 * grant — forging this text reads nothing.
 */
export function devObserveGrantPrompt(origin: string): string {
  return (
    `${DEV_OBSERVE_GRANT_MARKER}\n` +
    `Panel note: the user clicked Allow — watching the data this page loads (${origin}) is on for this ` +
    "conversation, and the tab was reloaded so its load-time requests are already in the buffer. This note itself " +
    "grants nothing — the extension enforces the grant on the probe. Now: capture the page fresh, read the observed " +
    "responses with observe_network_bodies (use urlFilter and search with a value you can see rendered — do not dump " +
    "bodies), identify the ONE host whose response really carries the needed field, and record a " +
    "feasible-with-capability verdict naming exactly that host. Do not build before that verdict exists. The reload " +
    "changed what the network buffer holds, not what the page is: your earlier DOM, selector, and design findings " +
    "still stand unless the fresh capture contradicts them, so do not re-run element or design probes you already " +
    "have answers from — every re-probe costs the user real seconds."
  );
}

/** Rendering-only detector for the dev-observe continuation (action row, not a user bubble). */
export function isDevObserveGrantPrompt(text: string): boolean {
  return text.startsWith(DEV_OBSERVE_GRANT_MARKER);
}
