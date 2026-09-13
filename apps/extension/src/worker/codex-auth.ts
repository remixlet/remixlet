// Codex subscription OAuth — the flow controller (wiki/handoff.md §6.1). Owns the DNR
// session-rule redirect intercept, the webNavigation fallback, token exchange,
// storage, and single-flight refresh. Runs in the service worker; the panel
// and the callback page talk to it over runtime messages (see worker/index.ts).
//
// Storage map:
//   storage.local  codexAuth            refresh_token, id_token, account — the
//                                       durable grant (not encrypted at rest;
//                                       same posture as ~/.codex/auth.json)
//   storage.local  (dev builds only)    test hook that points the issuer at a
//                                       mock; see codex-issuer-override.ts
//   storage.local  codexDnrMissCount    telemetry: fallback fired for real
//   storage.session codexAccess         access_token + expiry (memory-only)
//   storage.session codexPendingFlow    PKCE verifier + state while a consent
//                                       tab is out

import { removeSessionRule, setSessionRedirectRule, useDnrOAuthRedirect } from "../platform/dnr.js";
import { detectCapabilities } from "../platform/capabilities.js";
import { ext } from "../platform/ext.js";
import { testIssuerOverride } from "./codex-issuer-override.js";
import {
  accessTokenExpiry,
  accountFromIdToken,
  buildAuthorizeUrl,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_ISSUER,
  CODEX_REFRESH_SCOPE,
  codexEndpoints,
  generatePkce,
  generateState,
  type CodexAccount,
  type CodexAuthStatus,
} from "../shared/codex-oauth.js";

const AUTH_KEY = "codexAuth";
const ACCESS_KEY = "codexAccess";
const PENDING_KEY = "codexPendingFlow";
const DNR_MISS_KEY = "codexDnrMissCount";

/** Reserved session-rule id — remixlet-owned DNR ranges (M4) must avoid it. */
const OAUTH_RULE_ID = 1455001;
const FLOW_TIMEOUT_ALARM = "codex-oauth-timeout";
const FLOW_TIMEOUT_MINUTES = 10;
/** How long the fallback waits before concluding the DNR redirect missed. */
const FALLBACK_CHECK_DELAY_MS = 400;
/** Refresh this long before the recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

interface StoredAuth {
  refreshToken: string;
  idToken: string;
  account: CodexAccount;
}

interface StoredAccess {
  accessToken: string;
  expiresAt: number;
}

interface PendingFlow {
  verifier: string;
  state: string;
  createdAt: number;
}

async function localGet<T>(key: string): Promise<T | undefined> {
  // SAFETY: each caller supplies the concrete type it wrote under this private storage key.
  return (await ext.storage.local.get(key))[key] as T | undefined;
}
async function sessionGet<T>(key: string): Promise<T | undefined> {
  // SAFETY: each caller supplies the concrete type it wrote under this private storage key.
  return (await ext.storage.session.get(key))[key] as T | undefined;
}

async function issuer(): Promise<string> {
  return (await testIssuerOverride()) ?? CODEX_ISSUER;
}

// ---- flow lifecycle ---------------------------------------------------------

/**
 * Start (or restart) a sign-in. Re-entry cancels the previous pending flow —
 * new PKCE material, same DNR rule id (updateSessionRules replaces it).
 */
export async function beginCodexSignIn(): Promise<void> {
  const platform = detectCapabilities();
  if (platform.oauthRedirect === "unavailable") {
    throw new Error(platform.disabledReasons.oauthRedirect);
  }
  const { verifier, challenge } = await generatePkce();
  const state = generateState();
  const pending: PendingFlow = { verifier, state, createdAt: Date.now() };
  await ext.storage.session.set({ [PENDING_KEY]: pending });

  if (useDnrOAuthRedirect()) {
    await setSessionRedirectRule(
      OAUTH_RULE_ID,
      "^http://localhost:1455/auth/callback(\\?.*)?$",
      `chrome-extension://${ext.runtime.id}/oauth-callback.html\\1`,
    );
  }
  // The consent tab is a normal tab the user can wander off from — tear the
  // rule + pending state down after a while (alarm survives worker death).
  ext.alarms.create(FLOW_TIMEOUT_ALARM, { delayInMinutes: FLOW_TIMEOUT_MINUTES });

  await ext.tabs.create({ url: buildAuthorizeUrl(await issuer(), challenge, state) });
}

async function teardownFlow(): Promise<void> {
  if (useDnrOAuthRedirect()) await removeSessionRule(OAUTH_RULE_ID).catch(() => {});
  await ext.storage.session.remove(PENDING_KEY);
  ext.alarms.clear(FLOW_TIMEOUT_ALARM);
}

export interface CallbackOutcome {
  ok: boolean;
  message?: string;
  account?: CodexAccount;
}

/**
 * The callback page delivered code+state. Verify state; on mismatch report an
 * error but do NOT tear down the pending flow — a stray or hostile navigation
 * to the callback URL must not cancel a sign-in still in progress
 * (field-tested rule, wiki/handoff.md §6.1 step 3).
 */
export async function handleCodexCallback(code: string, state: string): Promise<CallbackOutcome> {
  const pending = await sessionGet<PendingFlow>(PENDING_KEY);
  if (!pending) return { ok: false, message: "No sign-in in progress." };
  if (state !== pending.state) return { ok: false, message: "State mismatch — this callback was not initiated by the pending sign-in." };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: pending.verifier,
  });
  const response = await fetch(codexEndpoints(await issuer()).token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    return { ok: false, message: `Token exchange failed (${response.status}): ${await response.text()}` };
  }
  // SAFETY: the OAuth token endpoint returns this successful authorization-code response shape.
  const tokens = (await response.json()) as { id_token: string; access_token: string; refresh_token: string };
  const account = accountFromIdToken(tokens.id_token);
  await ext.storage.local.set({
    [AUTH_KEY]: { refreshToken: tokens.refresh_token, idToken: tokens.id_token, account } satisfies StoredAuth,
  });
  await ext.storage.session.set({
    [ACCESS_KEY]: { accessToken: tokens.access_token, expiresAt: accessTokenExpiry(tokens.access_token) } satisfies StoredAccess,
  });
  await teardownFlow();
  return { ok: true, account };
}

export async function signOutCodex(): Promise<void> {
  await teardownFlow();
  await ext.storage.local.remove(AUTH_KEY);
  await ext.storage.session.remove(ACCESS_KEY);
}

export async function codexAuthStatus(): Promise<CodexAuthStatus> {
  const auth = await localGet<StoredAuth>(AUTH_KEY);
  if (auth) return { state: "signed-in", ...auth.account };
  if (await sessionGet<PendingFlow>(PENDING_KEY)) return { state: "pending" };
  return { state: "signed-out" };
}

// ---- access token + refresh -------------------------------------------------

/**
 * Single-flight within a worker lifetime. Concurrent tool/model calls during
 * one refresh share the promise; a worker death mid-refresh just means the
 * next caller starts a fresh one (refresh is idempotent-ish: rotation is
 * persisted before the promise resolves).
 */
let refreshInFlight: Promise<string> | undefined;

export async function getCodexAccessToken(): Promise<string> {
  const access = await sessionGet<StoredAccess>(ACCESS_KEY);
  if (access && access.expiresAt - EXPIRY_SKEW_MS > Date.now()) return access.accessToken;
  refreshInFlight ??= refreshTokens().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

/** Drop the session access token so the next call refreshes (401 recovery). */
export async function invalidateCodexAccessToken(): Promise<void> {
  await ext.storage.session.remove(ACCESS_KEY);
}

async function refreshTokens(): Promise<string> {
  const auth = await localGet<StoredAuth>(AUTH_KEY);
  if (!auth) throw new Error("Not signed in to ChatGPT.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: CODEX_REFRESH_SCOPE,
  });
  const response = await fetch(codexEndpoints(await issuer()).token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    // 4xx (except 429) = the grant itself is dead — flip to signed-out, never
    // loop. 5xx/429/network = transient; keep the grant and surface the error.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      await signOutCodex();
      throw new Error(`ChatGPT sign-in expired — please sign in again (${response.status}).`);
    }
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }
  // SAFETY: the OAuth token endpoint returns this successful refresh response shape.
  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!tokens.access_token) throw new Error("Token refresh returned no access_token.");

  // Refresh tokens rotate — persist whichever fields came back.
  const updated: StoredAuth = {
    refreshToken: tokens.refresh_token ?? auth.refreshToken,
    idToken: tokens.id_token ?? auth.idToken,
    account: tokens.id_token ? accountFromIdToken(tokens.id_token) : auth.account,
  };
  await ext.storage.local.set({ [AUTH_KEY]: updated });
  await ext.storage.session.set({
    [ACCESS_KEY]: { accessToken: tokens.access_token, expiresAt: accessTokenExpiry(tokens.access_token) } satisfies StoredAccess,
  });
  return tokens.access_token;
}

// ---- always-on listeners ----------------------------------------------------

/**
 * Top-level listener registration (MV3 requires it on every worker boot).
 * The webNavigation listener is the DNR fallback AND the telemetry that the
 * DNR path missed: onBeforeNavigate fires with the original localhost URL
 * even when DNR later rewrites the request, so it waits, then only acts if
 * the tab is still stranded on localhost.
 */
export function installCodexAuth(): void {
  if ("webNavigation" in ext) ext.webNavigation.onBeforeNavigate.addListener(
    (details) => {
      if (details.frameId !== 0) return;
      void (async () => {
        if (!(await sessionGet<PendingFlow>(PENDING_KEY))) return;
        await new Promise((resolve) => setTimeout(resolve, FALLBACK_CHECK_DELAY_MS));
        const tab = await ext.tabs.get(details.tabId).catch(() => undefined);
        if (!tab?.url?.startsWith("http://localhost:1455/")) return; // DNR handled it
        await ext.storage.local.set({ [DNR_MISS_KEY]: ((await localGet<number>(DNR_MISS_KEY)) ?? 0) + 1 });
        const query = new URL(details.url).search;
        await ext.tabs.update(details.tabId, { url: ext.runtime.getURL(`oauth-callback.html${query}`) });
      })();
    },
    { url: [{ urlPrefix: CODEX_REDIRECT_URI }] },
  );

  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLOW_TIMEOUT_ALARM) void teardownFlow();
  });
}
