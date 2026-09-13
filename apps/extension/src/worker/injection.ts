// Script registration for the mirror (wiki/design/mediated-execution.md,
// Lifecycle 1). Remixlet code registers nowhere: it runs inside the box. What
// registers here are extension-authored files, as dynamic content scripts
// (scripting.registerContentScripts, platform/content-script-registry.ts):
// the page agent (ISOLATED world) on every origin a boxed remixlet might run
// on, the network:observe relay (MAIN world, bridge/relay.ts) on every origin
// a remixlet with an observe grant might run on, and the development-time
// observer (MAIN world, bridge/dev-observe.ts) on the origins pinned by live
// dev-observe grants. No registration carries code, and none is per remixlet:
// the per-remixlet configuration (matches, observe patterns) reaches the page
// agent as data over the host port (worker/box.ts). Registrations are rebuilt
// from the storage mirror on every worker boot and reconciled to it after
// every mirror write (measured at M0: registrations do NOT persist for
// unpacked installs; the mirror is the truth). The extension holds no
// user-scripts permission: the probes go through scripting.executeScript
// (worker/page-probes/engine.ts), and no lane runs a model-written code
// string in the tab.

import { devObserveOrigins } from "./dev-observe.js";
import { ext } from "../platform/ext.js";
import { contentScriptRegistry, type ContentScriptRegistration } from "../platform/content-script-registry.js";
import { matchesPaused, originWidePatterns, siteKeyExcludePatterns } from "../shared/site-key.js";
import { broadcastBoxRefresh } from "./box.js";
import { readPausedSites } from "./site-pause.js";

/**
 * Mirror entry: the injectable slice of an ELIGIBLE remixlet. Membership is
 * the artifact-level verdict (worker/eligibility.ts judgeArtifact, applied by
 * the mirror build in activation.ts): enabled, not being deleted, readable
 * from its committed snapshot, valid rules, bridge-compatible. A remixlet
 * absent from the mirror runs nowhere and holds no bridge token.
 */
export interface ActiveRemixlet {
  id: string;
  /** Secret known only to the box host and the worker. */
  bridgeToken: string;
  matches: string[];
  js: {
    code: string;
    /** The stored file name (manifest `scripts[].file`). */
    file: string;
    runAt?: "document_start" | "document_end" | "document_idle";
  }[];
  css: string[];
  /** Manifest capability grants — the worker bridge enforces against these. */
  capabilities: string[];
  /** GRANTED network:observe host patterns — the page agent filters the relay's records against them per box. */
  networkObserve: string[];
}

const MIRROR_KEY = "activeRemixlets";
const BRIDGE_TOKENS_KEY = "remixletBridgeTokens";
/** The page agent's single dynamic content-script registration. */
export const PAGE_AGENT_SCRIPT_ID = "rmx-page-agent";
/** The shipped agent file, registered here. */
export const PAGE_AGENT_FILE = "page-agent.js";
/** The network:observe relay's single registration (MAIN world). */
export const RELAY_SCRIPT_ID = "rmx-relay";
const RELAY_FILE = "relay.js";
/** The development-time observer's single registration (MAIN world). */
export const DEV_OBSERVE_SCRIPT_ID = "rmx-dev-observe";
const DEV_OBSERVE_FILE = "dev-observe.js";

export async function readMirror(): Promise<ActiveRemixlet[]> {
  const stored = await ext.storage.local.get(MIRROR_KEY);
  // SAFETY: the store is written only by writeMirror with ActiveRemixlet entries.
  return (stored[MIRROR_KEY] as ActiveRemixlet[] | undefined) ?? [];
}

export async function writeMirror(remixlets: ActiveRemixlet[]): Promise<void> {
  await ext.storage.local.set({ [MIRROR_KEY]: remixlets });
}

export async function bridgeTokenFor(remixletId: string): Promise<string> {
  const stored = await ext.storage.local.get(BRIDGE_TOKENS_KEY);
  // SAFETY: the token store is written below as a string-keyed token map.
  const tokens = (stored[BRIDGE_TOKENS_KEY] as Record<string, string> | undefined) ?? {};
  if (tokens[remixletId]) return tokens[remixletId];
  const token = crypto.randomUUID();
  await ext.storage.local.set({ [BRIDGE_TOKENS_KEY]: { ...tokens, [remixletId]: token } });
  return token;
}

/**
 * Forget a remixlet's bridge token (delete-forever). A later install under
 * the same id mints a fresh one, so a host still holding the old token can
 * never authenticate against the new artifact.
 */
export async function clearTokens(remixletId: string): Promise<void> {
  const stored = await ext.storage.local.get(BRIDGE_TOKENS_KEY);
  // SAFETY: see bridgeTokenFor.
  const tokens = (stored[BRIDGE_TOKENS_KEY] as Record<string, string> | undefined) ?? {};
  if (tokens[remixletId] === undefined) return;
  delete tokens[remixletId];
  await ext.storage.local.set({ [BRIDGE_TOKENS_KEY]: tokens });
}

/**
 * The mirror entry a bridge caller speaks for, or undefined when the caller
 * is not authenticated: unknown id, or a token that is missing, empty or
 * different on either side. Both tokens must be present non-empty strings
 * BEFORE the comparison — `undefined === undefined` must never authenticate
 * a tokenless entry or a message with no token.
 */
export async function authenticatedRemixlet(remixletId: string, bridgeToken: string): Promise<ActiveRemixlet | undefined> {
  if (!isNonEmptyString(bridgeToken)) return undefined;
  const remixlet = (await readMirror()).find((candidate) => candidate.id === remixletId);
  if (!remixlet || !isNonEmptyString(remixlet.bridgeToken)) return undefined;
  return remixlet.bridgeToken === bridgeToken ? remixlet : undefined;
}

// The message arrives off the wire and the mirror off storage: neither type
// annotation is a guarantee, so the tokens are checked as values.
function isNonEmptyString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]" && String(value).length > 0;
}

/**
 * Make the registrations match the mirror exactly. Idempotent; run on every
 * worker boot and after every mirror write.
 *
 * Three registrations at most, all of them shipped files. The page agent's
 * matches are the union of every boxed remixlet's origin-wide patterns; the
 * worker decides per page which remixlets actually run (worker/box.ts), so
 * the registration only has to bring the agent to every page that might
 * need it. The relay's matches are the same union over the remixlets that
 * hold a network:observe grant, so wherever the relay runs the agent runs
 * too and can claim its token. The dev-observe observer's matches are the
 * origins of the live grants. Every pass ends by telling the offscreen host
 * to re-resolve its live pages.
 */
export function reconcileRegistrations(): Promise<void> {
  // Serialized: the diff below (getScripts → unregister → register/update) is
  // not atomic, and callers arrive from independent message handlers (the
  // activation path's store lock covers only itself; devObserve.enable/disable
  // call in directly). Two interleaved passes can both see a script as absent
  // and double-register it — a thrown "Duplicate script ID" surfaced as a chat
  // error. In-flight-only state, nothing to reconstruct after a worker death.
  const run = reconcileChain.then(reconcileRegistrationsUnchained, reconcileRegistrationsUnchained);
  reconcileChain = run.catch(() => undefined);
  return run;
}

let reconcileChain: Promise<unknown> = Promise.resolve();

async function reconcileRegistrationsUnchained(): Promise<void> {
  // Pause rides on excludeMatches: registrations stay (a resume is one
  // reconcile away, and a restart rebuilds them from the store either way),
  // the paused pages just stop matching. Always pass the list — an empty array
  // on update is what CLEARS a lifted pause.
  const pausedSites = await readPausedSites();
  const excludeMatches = pausedSites.flatMap(siteKeyExcludePatterns);

  // The mirror holds only eligible remixlets (see ActiveRemixlet). A remixlet
  // with only styles has no box, so it wants neither the agent nor the relay.
  const boxed = (await readMirror()).filter((r) => r.js.length > 0);
  const observing = boxed.filter((r) => (r.networkObserve ?? []).length > 0);

  const wanted = new Map<string, ContentScriptRegistration>();
  const agentMatches = registrationMatches(boxed, pausedSites);
  if (agentMatches.length > 0) {
    wanted.set(PAGE_AGENT_SCRIPT_ID, {
      id: PAGE_AGENT_SCRIPT_ID,
      matches: agentMatches,
      excludeMatches,
      js: [PAGE_AGENT_FILE],
      // document_start: the agent reports readyState as it changes (page.facts)
      // and each box waits for its own runAt, so a document_start remixlet sees
      // the page before its scripts run; and it must run before any page
      // script to claim the relay's token.
      runAt: "document_start",
      world: "ISOLATED",
      // Top frame only: the runtime mediates one document per tab.
      allFrames: false,
      // The boot reconcile rebuilds it from the mirror, like every registration.
      persistAcrossSessions: false,
    });
  }
  const relayMatches = registrationMatches(observing, pausedSites);
  if (relayMatches.length > 0) {
    wanted.set(RELAY_SCRIPT_ID, {
      id: RELAY_SCRIPT_ID,
      matches: relayMatches,
      excludeMatches,
      js: [RELAY_FILE],
      // document_start: fetch must be wrapped before the page's first request,
      // and the token must be on <html> before any page script could read it.
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
      persistAcrossSessions: false,
    });
  }
  const devObserved = await devObserveOrigins();
  if (devObserved.length > 0) {
    wanted.set(DEV_OBSERVE_SCRIPT_ID, {
      id: DEV_OBSERVE_SCRIPT_ID,
      // Pinned to the origins recorded at grant time: a cross-origin
      // navigation mid-conversation carries no observation with it.
      matches: devObserved.map((origin) => `${origin}/*`),
      js: [DEV_OBSERVE_FILE],
      // The patch must beat the page's first fetch.
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
      persistAcrossSessions: false,
    });
  }

  try {
    await applyRegistrations(wanted);
  } finally {
    await broadcastBoxRefresh();
  }
}

/**
 * The origin-wide union of the given remixlets' matches, minus the ones a
 * pause owns. Registration is ORIGIN-WIDE because the browser evaluates
 * `matches` only at document creation, so path-scoped patterns would miss
 * every client-side route arrival; the manifest's real matches are applied
 * at runtime (the box for its files, the agent for the relay's records). A
 * pause OWNS the remixlet, not just the site it was authored on: once any
 * host this remixlet claims is paused, it contributes no host at all, so a
 * remixlet spanning several hosts stops on all of them instead of quietly
 * living on at its other one. (An <all_urls> remixlet claims no host, so it
 * is never owned this way; the paused-site excludes still stop it exactly
 * where the pause was made.)
 */
function registrationMatches(remixlets: ActiveRemixlet[], pausedSites: string[]): string[] {
  const matches: string[] = [];
  for (const remixlet of remixlets) {
    if (matchesPaused(remixlet.matches, pausedSites)) continue;
    for (const pattern of originWidePatterns(remixlet.matches)) {
      if (!matches.includes(pattern)) matches.push(pattern);
    }
  }
  return matches;
}

/**
 * The id-keyed diff: whatever is registered and not wanted is unregistered
 * (so a registration an older build owned, or one whose grant expired, never
 * lingers), the rest is registered or updated in place.
 */
async function applyRegistrations(wanted: Map<string, ContentScriptRegistration>): Promise<void> {
  const registry = contentScriptRegistry();
  if (!registry.available) {
    if (wanted.size > 0) throw new Error("The browser cannot register the extension's content scripts here.");
    return;
  }
  const have = new Set((await registry.getScripts()).map((script) => script.id));
  await registry.unregister([...have].filter((id) => !wanted.has(id)));
  const toRegister: ContentScriptRegistration[] = [];
  const toUpdate: ContentScriptRegistration[] = [];
  for (const [id, registration] of wanted) (have.has(id) ? toUpdate : toRegister).push(registration);
  await registry.register(toRegister);
  await registry.update(toUpdate);
}
