// Development-time network observation grant (wiki/raw/handoffs/
// 2026-08-10-broad-observe-session-grant.md): one conversation-scoped,
// user-clicked approval that lets the AGENT read the page's own network
// response bodies while it figures out which host actually carries the data —
// so the final remixlet asks for exactly one narrow capability, once.
//
// This is agent-side, session-scoped authority, NOT a manifest capability: it
// never appears in a manifest or durable grant record, is never grantable
// through the permission card, and mints nothing stored remixlet code can run against.

/** Storage record for one conversation's dev-observe grant (worker-owned). */
export interface DevObserveGrant {
  conversationId: string;
  /**
   * The page origin ("https://soundcloud.com") pinned at grant time. The
   * observer's registration matches only this origin, so a cross-origin
   * navigation mid-conversation cannot carry broad observation elsewhere.
   */
  origin: string;
  grantedAt: number;
}

/** conversationId → grant. One grant per conversation; enable replaces. */
export const DEV_OBSERVE_GRANTS_KEY = "devObserveGrants";

/**
 * Backstop expiry for a panel that dies without a close event (killed with
 * the browser window): reconcile drops the registration once the record
 * expires. Long enough for a real build conversation; a stale observer is a
 * hygiene cost (patched fetch + buffer memory), never a data leak — it buffers
 * the page's own responses in the page's own world.
 */
export const DEV_OBSERVE_TTL_MS = 60 * 60 * 1000;

export function devObserveGrantExpired(grant: DevObserveGrant, now: number): boolean {
  return now - grant.grantedAt > DEV_OBSERVE_TTL_MS;
}

/**
 * Whether a grant authorizes an observe read: it must match BOTH the reading
 * conversation and the tab's origin. Conversation scope is a security
 * boundary, not a nicety — without it, a lingering grant from one conversation
 * would let a DIFFERENT conversation on the same origin read the page's
 * response bodies with no approval of its own. A missing conversation id never
 * authorizes: fail closed.
 */
export function devObserveGrantAuthorizes(
  grant: DevObserveGrant,
  conversationId: string | undefined,
  origin: string,
): boolean {
  return conversationId !== undefined && grant.conversationId === conversationId && grant.origin === origin;
}

/**
 * The buffer read's DOM-event contract (the relay-sync pattern): the probe
 * dispatches the request event on `document` with a JSON-string detail
 * `{ urlFilter?: string, limit?: number }`, and the observer answers with the
 * reply event synchronously during that dispatch, detail JSON
 * `{ total, matched, recorded, entries }` where entries are the observer's
 * newest `limit` matching records `{ seq, url, method, status, contentType,
 * body, truncated }`. Constant names: the observer is a shipped file
 * (bridge/dev-observe.ts) and can be handed no per-grant token; the worker
 * still passes both names into the probe as server-injected params, after
 * the grant gate, so the template never re-derives them. The probe runs from
 * the ISOLATED world through probes.js; this pair did not change with it.
 */
export const DEV_OBSERVE_REQUEST_EVENT = "rmx-devobs-req";

export const DEV_OBSERVE_REPLY_EVENT = "rmx-devobs-rep";
