// Test hook: the OAuth harness points the Codex issuer at a mock by writing one
// storage.local key. Only development builds carry this module — `build.mjs
// --release` swaps it for a stub that always answers undefined, so a packaged
// worker has no storage key that could redirect a sign-in or refresh
// (wiki/ops/security-review-2026-09.md N12). tools/package.mjs asserts the key
// name is absent from the shipped worker.

import { ext } from "../platform/ext.js";

const ISSUER_OVERRIDE_KEY = "codexIssuerOverride";

/** The issuer origin the harness stored, or undefined in every build a user runs. */
export async function testIssuerOverride(): Promise<string | undefined> {
  // SAFETY: the OAuth harness is this key's only writer and stores the mock issuer's origin string.
  return (await ext.storage.local.get(ISSUER_OVERRIDE_KEY))[ISSUER_OVERRIDE_KEY] as string | undefined;
}
