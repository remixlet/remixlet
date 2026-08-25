// ChatGPT (Codex) subscription OAuth — the pure half: constants, PKCE,
// id_token decoding, URL building (wiki/handoff.md §6.1). Every constant is mirrored
// verbatim from the open-source Codex CLI; keep them in lockstep with it.
// No extension APIs here — the flow controller lives in src/worker/codex-auth.ts.

import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

/** Public client id from the open-source Codex CLI — there is no secret. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Fixed by OpenAI's client registration; the token endpoint only string-matches it. */
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";

export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_SCOPE = "openid profile email offline_access";
/** Narrower on refresh — copied exactly from the CLI flow. */
export const CODEX_REFRESH_SCOPE = "openid profile email";

/** id_token claim namespace carrying the ChatGPT account id / plan. */
export const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

/** Default base URL for model calls (pi-ai appends /codex/responses). */
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api";

/** Both issuer endpoints derive from one base so tests override it once. */
export interface CodexEndpoints {
  authorize: string;
  token: string;
}

export function codexEndpoints(issuer: string = CODEX_ISSUER): CodexEndpoints {
  const base = issuer.replace(/\/$/, "");
  return { authorize: `${base}/oauth/authorize`, token: `${base}/oauth/token` };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function generatePkce(): Promise<PkcePair> {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
}

export function generateState(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function buildAuthorizeUrl(issuer: string, challenge: string, state: string): string {
  const url = new URL(codexEndpoints(issuer).authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // Codex-specific params the CLI sends — mirror against its source on upgrade.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  }).toString();
  return url.toString();
}

export interface CodexAccount {
  accountId: string;
  email: string;
  planType: string;
}

const JwtPayloadSchema = Type.Object(
  {
    [CODEX_AUTH_CLAIM]: Type.Optional(
      Type.Object({ chatgpt_account_id: Type.Optional(Type.String()), chatgpt_plan_type: Type.Optional(Type.String()) }),
    ),
    email: Type.Optional(Type.String()),
    exp: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);
type JwtPayload = Static<typeof JwtPayloadSchema>;

/**
 * Decode a JWT payload without signature verification — the token arrived
 * over TLS from the issuer and is used as data, not as a third-party assertion.
 */
export function decodeJwtPayload(jwt: string): JwtPayload {
  const payloadPart = jwt.split(".")[1];
  if (payloadPart === undefined) throw new Error("not a JWT");
  const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Parse(JwtPayloadSchema, JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))));
}

export function accountFromIdToken(idToken: string): CodexAccount {
  const payload = decodeJwtPayload(idToken);
  const auth = payload[CODEX_AUTH_CLAIM];
  if (!auth?.chatgpt_account_id) throw new Error("id_token missing chatgpt_account_id claim");
  return {
    accountId: auth.chatgpt_account_id,
    email: payload.email ?? "(no email)",
    planType: auth.chatgpt_plan_type ?? "unknown",
  };
}

/** Expiry (ms since epoch) for an access token: its `exp` claim, else now + fallback. */
export function accessTokenExpiry(accessToken: string, fallbackSeconds: number = 900): number {
  try {
    const exp = decodeJwtPayload(accessToken).exp;
    if (exp !== undefined) return exp * 1000;
  } catch {
    // opaque token — fall through to the fallback window
  }
  return Date.now() + fallbackSeconds * 1000;
}

export type CodexAuthStatus =
  | { state: "signed-out" }
  | { state: "pending" }
  | { state: "signed-in"; email: string; planType: string; accountId: string };

/**
 * Whether a `chatgpt_plan_type` claim carries Codex access. Only "free" is
 * rejected: OpenAI's backend is the final arbiter, and unknown plan strings
 * must pass so future paid tiers keep working (discovery surfaces the real
 * error for those).
 */
export function planIncludesCodex(planType: string): boolean {
  return planType.trim().toLowerCase() !== "free";
}
