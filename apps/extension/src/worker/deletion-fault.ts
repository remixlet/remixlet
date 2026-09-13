// Test hook: the lifecycle harness makes delete-forever fail after a named
// durable step by writing one storage.local key, then relaunches the browser
// to prove the boot resume finishes the job. Only development builds carry
// this module — `build.mjs --release` swaps it for a stub that always answers
// undefined, so a packaged worker has no storage key that could interrupt a
// deletion; tools/package.mjs asserts the key name is absent from the
// shipped worker (same pattern as codex-issuer-override.ts).

import { ext } from "../platform/ext.js";

const DELETION_FAULT_KEY = "remixletDeletionFault";

/** The step name the harness stored, or undefined in every build a user runs. */
export async function testDeletionFault(): Promise<string | undefined> {
  // SAFETY: the lifecycle harness is this key's only writer and stores a step name.
  return (await ext.storage.local.get(DELETION_FAULT_KEY))[DELETION_FAULT_KEY] as string | undefined;
}
