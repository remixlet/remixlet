// Probe engine: run one structured probe in the active tab through the
// scripting seam (platform/script-executor.ts). The templates ship in the
// package as probes.js, injected once per document into the tab's ISOLATED
// world where it installs a runner (runner.ts); a probe is then one function
// call into that runner with the probe's name and the model's params as
// executeScript `args`. That is the security property: model input crosses
// the browser as JSON arguments and reaches the template as a value. It is
// never part of any source text, and there is no source text to be part of,
// since neither form of executeScript takes a code string.
//
// read_page_state's template runs in the page's MAIN world (its purpose is
// the page's own globals) through a second shipped file, page-state.js,
// which the ISOLATED runner reads through a synchronous CustomEvent pair
// (page-state-reader.ts). Every other probe stays in the ISOLATED world.

import { scriptExecutor } from "../../platform/script-executor.js";
import type { ProbeName } from "../../shared/probe-schemas.js";
import type { ProbeEnvelope } from "./envelope.js";
import type { ProbePayload } from "./payload.js";
import type { ProbeRunner } from "./runner.js";
import { PROBE_WORLDS } from "./probes.js";

export type { ProbePayload, ProbePayloadValue } from "./payload.js";

/** The two shipped files, by their build.mjs entry names. */
export const PROBES_FILE = "probes.js";
export const PAGE_STATE_FILE = "page-state.js";

/** Cap on the serialized probe result. */
export const PROBE_RESPONSE_CHAR_CAP = 128 * 1024;

/**
 * The one function the browser serialises (executeScript's func form), so it
 * closes over nothing: the runner's global name is spelled out here rather
 * than imported from runner.ts, and the page-probes suite proves the two
 * meet. It never throws across the injection: a missing runner answers with
 * an error envelope like any probe failure.
 */
export function callProbeRunner(name: string, params: ProbePayload): Promise<string> | string {
  // SAFETY: probes.js installs exactly a ProbeRunner under this name (runner.ts installProbeRunner) or nothing.
  const runner = (globalThis as { __rmxProbes?: ProbeRunner }).__rmxProbes;
  if (runner === undefined) {
    return JSON.stringify({ ok: false, message: "the extension's probes.js is not installed in this document" });
  }
  return runner.run(name, params);
}

/** Bound what a page can push into the model's context in one probe reply. */
export function capProbeValue(value: string): string {
  if (value.length <= PROBE_RESPONSE_CHAR_CAP) return value;
  return JSON.stringify({ truncated: true, totalChars: value.length, prefix: value.slice(0, PROBE_RESPONSE_CHAR_CAP) });
}

export async function runProbe(tabId: number, probe: ProbeName, params: ProbePayload | undefined): Promise<string> {
  return capProbeValue(await runProbeUncapped(tabId, probe, params));
}

/**
 * The same run without the response cap: for the worker's own consumers
 * that rewrite a template's value before the panel sees it (the network
 * probes, worker/network-ids.ts), which cap what they hand on.
 */
export async function runProbeUncapped(tabId: number, probe: ProbeName, params: ProbePayload | undefined): Promise<string> {
  const executor = scriptExecutor();
  if (!executor.available) throw new Error(executor.disabledReason);
  // Both files guard themselves, so injecting on every probe is idempotent
  // per document and needs no record of which documents already have them.
  await executor.runFiles(tabId, [PROBES_FILE]);
  if (PROBE_WORLDS[probe] === "MAIN") await executor.runFiles(tabId, [PAGE_STATE_FILE], "MAIN");
  const raw = await executor.callFunction(tabId, callProbeRunner, [probe, params ?? {}]);
  if (raw === undefined) throw new Error("the page did not answer the probe");
  // SAFETY: the runner serialises exactly the ProbeEnvelope shape (envelope.ts) before the injection returns it.
  const outcome = JSON.parse(String(raw)) as ProbeEnvelope;
  if (!outcome.ok) throw new Error(outcome.message ?? "probe failed");
  return outcome.value ?? "undefined";
}
