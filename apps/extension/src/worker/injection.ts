// userScripts registration: the sanctioned lane for remixlet JS (wiki/handoff.md §5).
// Scripts are registered from code strings held in the storage mirror — the
// worker re-registers from the mirror on every boot and reconciles drift
// (measured at M0: registrations do NOT persist for unpacked installs; the
// mirror is the truth).

import { mainWorldCode } from "../bridge/relay.js";
import { bridgeCode, gatedUserScriptCode } from "../bridge/rmx.js";
import { devObserveRegistrations } from "./dev-observe.js";
import { ext } from "../platform/ext.js";
import {
  scriptInjector,
  type UserScriptRegistration,
  type UserScriptWorld,
} from "../platform/script-injector.js";
import {
  matchesPaused,
  originWidePatterns,
  siteKeyExcludePatterns,
  siteKeyForMatches,
} from "../shared/site-key.js";
import { readPausedSites } from "./site-pause.js";

/** Mirror entry: the injectable slice of an enabled remixlet. */
export interface ActiveRemixlet {
  id: string;
  /**
   * Why this remixlet's builtWith stamp falls outside the bridge's supported
   * range (shared/bridge-version.ts), set by the mirror build. A skewed
   * remixlet KEEPS its mirror entry, but none of its code runs: no script
   * registration, no CSS.
   */
  skew?: string;
  /** Secret known only to this remixlet's isolated world and the worker. */
  bridgeToken: string;
  /**
   * Token naming the MAIN↔USER_SCRIPT relay's DOM events. Deliberately a
   * SEPARATE secret: it is embedded in MAIN-world code (page-shared world)
   * and must never be the capability-bearing bridgeToken.
   */
  relayToken: string;
  matches: string[];
  js: { code: string; world?: "USER_SCRIPT" | "MAIN"; runAt?: "document_start" | "document_end" | "document_idle" }[];
  css: string[];
  /** Manifest capability grants — the worker bridge enforces against these. */
  capabilities: string[];
  /** GRANTED network:observe host patterns — drives the MAIN-world interceptor. */
  networkObserve: string[];
}

interface MainWorldFile {
  code: string;
  runAt?: "document_start" | "document_end" | "document_idle";
}

const MIRROR_KEY = "activeRemixlets";
const BRIDGE_TOKENS_KEY = "remixletBridgeTokens";
const RELAY_TOKENS_KEY = "remixletRelayTokens";
const SCRIPT_PREFIX = "rmx-";
/** "@" cannot occur in a remixlet id, so this suffix can never collide. */
const MAIN_SCRIPT_SUFFIX = "@main";
const WORLD_PREFIX = "rmx-";

// @types/chrome currently trails Chrome 133's worldId fields. Keep the
// compatibility shape local until the package catches up.
export async function readMirror(): Promise<ActiveRemixlet[]> {
  const stored = await ext.storage.local.get(MIRROR_KEY);
  // SAFETY: the store is written only by writeMirror with ActiveRemixlet entries.
  return (stored[MIRROR_KEY] as ActiveRemixlet[] | undefined) ?? [];
}

export async function writeMirror(remixlets: ActiveRemixlet[]): Promise<void> {
  await ext.storage.local.set({ [MIRROR_KEY]: remixlets });
}

export async function bridgeTokenFor(remixletId: string): Promise<string> {
  return tokenFor(BRIDGE_TOKENS_KEY, remixletId);
}

export async function relayTokenFor(remixletId: string): Promise<string> {
  return tokenFor(RELAY_TOKENS_KEY, remixletId);
}

async function tokenFor(storageKey: string, remixletId: string): Promise<string> {
  const stored = await ext.storage.local.get(storageKey);
  // SAFETY: each token store is written below as a string-keyed token map.
  const tokens = (stored[storageKey] as Record<string, string> | undefined) ?? {};
  if (tokens[remixletId]) return tokens[remixletId];
  const token = crypto.randomUUID();
  await ext.storage.local.set({ [storageKey]: { ...tokens, [remixletId]: token } });
  return token;
}

/**
 * Make registered user scripts match the mirror exactly. Idempotent; run on
 * every worker boot and after every mirror write. USER_SCRIPT world with
 * messaging enabled is the capability-bridge transport.
 *
 * Each injectable remixlet gets up to TWO registrations: one USER_SCRIPT
 * entry (bridge + gated sandboxed files, per-remixlet worldId) and one MAIN
 * entry (relay + SPA navigation watcher + network:observe interceptor when
 * granted + the remixlet's gated MAIN files). MAIN-world code never receives
 * the rmx.* bridge — only the relay.
 */
export function reconcileUserScripts(): Promise<void> {
  // Serialized: the diff below (getScripts → unregister → register/update) is
  // not atomic, and callers arrive from independent message handlers (the
  // activation path's store lock covers only itself; devObserve.enable/disable
  // call in directly). Two interleaved passes can both see a script as absent
  // and double-register it — a thrown "Duplicate script ID" surfaced as a chat
  // error. In-flight-only state, nothing to reconstruct after a worker death.
  const run = reconcileChain.then(reconcileUserScriptsUnchained, reconcileUserScriptsUnchained);
  reconcileChain = run.catch(() => undefined);
  return run;
}

let reconcileChain: Promise<unknown> = Promise.resolve();

async function reconcileUserScriptsUnchained(): Promise<void> {
  // Pause rides on excludeMatches: registrations stay (a resume is one
  // reconcile away, and a restart rebuilds them from the store either way),
  // the paused pages just stop matching. Always pass the list — an empty array
  // on update is what CLEARS a lifted pause.
  const pausedSites = await readPausedSites();
  const excludeMatches = pausedSites.flatMap(siteKeyExcludePatterns);

  // Skewed remixlets register NOTHING: code written against a different rmx
  // contract fails in undefined ways mid-run, so it must not start at all —
  // the script log carries the needs-repair reason instead.
  const injectable = (await readMirror()).filter(
    (r) => r.skew === undefined && (r.js.length > 0 || (r.networkObserve ?? []).length > 0),
  );
  const backend = scriptInjector();
  if (!backend.available) {
    if (injectable.length > 0) throw new Error(backend.disabledReason);
    return;
  }

  const wanted = new Map<string, UserScriptRegistration>();
  for (const remixlet of injectable) {
    const usFiles = remixlet.js.filter((script) => (script.world ?? "USER_SCRIPT") !== "MAIN");
    const mainFiles = remixlet.js.filter((script) => script.world === "MAIN");
    const observePatterns = remixlet.networkObserve ?? [];
    // SPA-aware injection: register ORIGIN-WIDE (the browser evaluates
    // `matches` only at document creation, so path-scoped patterns would miss
    // every client-side route arrival) and enforce the manifest's real
    // matches at runtime — the gate wrapping the remixlet's files runs them
    // when the URL first satisfies the matches, at load or on a later
    // history.pushState navigation.
    const registrationMatches = originWidePatterns(remixlet.matches);
    // A pause OWNS the remixlet, not just the site it was authored on: once any
    // host this remixlet claims is paused, exclude EVERY host it claims, so a
    // remixlet spanning several hosts stops on all of them instead of quietly
    // living on at its other one. (An <all_urls> remixlet claims no host, so it
    // is never owned this way — the paused-site excludes above still stop it
    // exactly where the pause was made.)
    const remixletExcludes = matchesPaused(remixlet.matches, pausedSites)
      ? [...new Set([...excludeMatches, ...siteKeyExcludePatterns(siteKeyForMatches(remixlet.matches))])]
      : excludeMatches;
    if (usFiles.length > 0) {
      const worldId = WORLD_PREFIX + remixlet.id;
      await backend.configureWorld(worldId);
      const scriptId = SCRIPT_PREFIX + remixlet.id;
      wanted.set(scriptId, {
        id: scriptId,
        matches: registrationMatches,
        excludeMatches: remixletExcludes,
        // The rmx.* bridge rides ahead of the remixlet's own code, which is
        // wrapped in the URL gate as one generated entry.
        js: [
          { code: bridgeCode(remixlet.id, remixlet.bridgeToken, remixlet.relayToken ?? "") },
          {
            code: gatedUserScriptCode({
              remixletId: remixlet.id,
              bridgeToken: remixlet.bridgeToken,
              matches: remixlet.matches,
              files: usFiles.map((script) => ({ code: script.code })),
            }),
          },
        ],
        // Per-registration runAt: first sandboxed file's choice wins.
        runAt: usFiles[0]?.runAt ?? "document_idle",
        world: "USER_SCRIPT" satisfies UserScriptWorld,
        worldId,
      });
    }
    // Every injectable remixlet gets a MAIN registration: the SPA navigation
    // watcher lives there (only the page's own world sees history.pushState
    // calls) and feeds the USER_SCRIPT gate over the relay. Pinned to
    // document_start so the history patch beats the page's router (and, when
    // granted, the interceptor is listening before the page's first fetch);
    // mainWorldCode defers DOM-phase files internally.
    {
      const mainFilesForRegistration: MainWorldFile[] = mainFiles.map((script) => {
        const registrationFile: MainWorldFile = { code: script.code };
        if (script.runAt) registrationFile.runAt = script.runAt;
        return registrationFile;
      });
      const registrationRunAt = "document_start" as const;
      const scriptId = SCRIPT_PREFIX + remixlet.id + MAIN_SCRIPT_SUFFIX;
      wanted.set(scriptId, {
        id: scriptId,
        matches: registrationMatches,
        excludeMatches: remixletExcludes,
        js: [
          {
            code: mainWorldCode({
              relayToken: remixlet.relayToken ?? "",
              matches: remixlet.matches,
              observePatterns,
              files: mainFilesForRegistration,
              registrationRunAt,
            }),
          },
        ],
        runAt: registrationRunAt,
        world: "MAIN" satisfies UserScriptWorld,
      });
    }
  }

  // The dev-observe observers ride the same reconcile (the id-keyed diff below
  // unregisters ANYTHING not in `wanted`, so a registration owned elsewhere
  // would be torn down here): live grants contribute registrations, expired or
  // removed grants simply stop contributing and the diff drops their scripts.
  for (const registration of await devObserveRegistrations()) {
    wanted.set(registration.id, registration);
  }

  const registered = await backend.getScripts();
  const have = new Map(registered.map((s) => [s.id, s]));
  const toUnregister = [...have.keys()].filter((id) => !wanted.has(id));
  await backend.unregister(toUnregister);

  const toRegister: UserScriptRegistration[] = [];
  const toUpdate: UserScriptRegistration[] = [];
  for (const [scriptId, spec] of wanted) (have.has(scriptId) ? toUpdate : toRegister).push(spec);
  if (toRegister.length > 0) await backend.register(toRegister);
  if (toUpdate.length > 0) await backend.update(toUpdate);
}
