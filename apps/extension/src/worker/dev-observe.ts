// Worker-side store for the development-time observation grant
// (wiki/raw/handoffs/2026-08-10-broad-observe-session-grant.md). The record is the
// MV3-reconstructible truth: the panel's Allow click writes it, every
// reconcileUserScripts pass rebuilds the observer registration from it (so a
// worker restart mid-conversation re-registers), and expiry/removal drops the
// registration on the next reconcile. Enable/disable orchestration (write →
// reconcile → tab reload) lives in worker/index.ts to keep this module free of
// an import cycle with injection.ts, which consumes devObserveRegistrations().

import { devObserveCode } from "../bridge/dev-observe.js";
import { ext } from "../platform/ext.js";
import type { UserScriptRegistration } from "../platform/script-injector.js";
import {
  DEV_OBSERVE_GRANTS_KEY,
  devObserveGrantAuthorizes,
  devObserveGrantExpired,
  type DevObserveGrant,
} from "../shared/dev-observe.js";

/**
 * Registration id for a conversation's observer. "@" cannot occur in a
 * remixlet id (worker/injection.ts MAIN_SCRIPT_SUFFIX invariant), and the
 * conversation id is a UUID (never "main"), so this can collide with neither
 * "rmx-<remixlet id>" nor "rmx-<remixlet id>@main".
 */
export function devObserveScriptId(conversationId: string): string {
  return `rmx-devobs@${conversationId}`;
}

export async function readDevObserveGrants(): Promise<Record<string, DevObserveGrant>> {
  const stored = await ext.storage.local.get(DEV_OBSERVE_GRANTS_KEY);
  // SAFETY: this module is the sole writer for the development observation grants key.
  return (stored[DEV_OBSERVE_GRANTS_KEY] as Record<string, DevObserveGrant> | undefined) ?? {};
}

async function writeDevObserveGrants(grants: Record<string, DevObserveGrant>): Promise<void> {
  await ext.storage.local.set({ [DEV_OBSERVE_GRANTS_KEY]: grants });
}

// Single-writer chain for every read-modify-write of the grant record: record,
// remove, and the TTL prune all race each other from independent message
// handlers, and an unserialized prune could resurrect a grant a concurrent
// disable just removed (lost update). In-flight-only state — a worker death
// drops nothing that storage doesn't already hold.
let grantWriteChain: Promise<unknown> = Promise.resolve();

function chainGrantWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = grantWriteChain.then(operation, operation);
  grantWriteChain = run.catch(() => undefined);
  return run;
}

/** Store the grant (replacing any earlier one for the conversation). */
export function recordDevObserveGrant(grant: DevObserveGrant): Promise<void> {
  return chainGrantWrite(async () => {
    const grants = await readDevObserveGrants();
    await writeDevObserveGrants({ ...grants, [grant.conversationId]: grant });
  });
}

/** Returns true when a record existed (so callers can skip a no-op reconcile). */
export function removeDevObserveGrant(conversationId: string): Promise<boolean> {
  return chainGrantWrite(async () => {
    const grants = await readDevObserveGrants();
    if (!(conversationId in grants)) return false;
    const { [conversationId]: _removed, ...rest } = grants;
    await writeDevObserveGrants(rest);
    return true;
  });
}

/**
 * Unexpired grants, pruning expired records from storage as a side effect —
 * the TTL backstop for a panel that died without a close event. Called from
 * every reconcile pass, so a stale observer outlives its conversation by at
 * most the TTL plus one reconcile. Rides the write chain so the prune's
 * read-modify-write cannot undo a concurrent record/remove.
 */
export function liveDevObserveGrants(now = Date.now()): Promise<DevObserveGrant[]> {
  return chainGrantWrite(async () => {
    const grants = await readDevObserveGrants();
    const live = Object.values(grants).filter((grant) => !devObserveGrantExpired(grant, now));
    if (live.length !== Object.values(grants).length) {
      await writeDevObserveGrants(Object.fromEntries(live.map((grant) => [grant.conversationId, grant])));
    }
    return live;
  });
}

/**
 * The registrations reconcileUserScripts must include for the live grants.
 * MAIN world at document_start (the patch must beat the page's first fetch),
 * matches pinned to the origin recorded at grant time — a cross-origin
 * navigation mid-conversation carries no observation with it.
 */
export async function devObserveRegistrations(now = Date.now()): Promise<UserScriptRegistration[]> {
  const live = await liveDevObserveGrants(now);
  return live.map((grant) => ({
    id: devObserveScriptId(grant.conversationId),
    matches: [`${grant.origin}/*`],
    js: [{ code: devObserveCode({ token: grant.token }) }],
    runAt: "document_start",
    world: "MAIN",
  }));
}

/**
 * The grant authorizing an observe_network_bodies read — the worker-side gate.
 * BOTH must match: the grant's origin (so it only reads the page it was pinned
 * to) AND its conversation (so a lingering or sibling-window grant from a
 * DIFFERENT conversation on the same origin cannot authorize this read — the
 * design's conversation scope, which the panel lifecycle and the card copy
 * both promise). A missing conversationId never matches: fail closed.
 */
export async function devObserveGrantForRead(
  conversationId: string | undefined,
  origin: string,
  now = Date.now(),
): Promise<DevObserveGrant | undefined> {
  if (conversationId === undefined) return undefined;
  const live = await liveDevObserveGrants(now);
  return live.find((grant) => devObserveGrantAuthorizes(grant, conversationId, origin));
}
