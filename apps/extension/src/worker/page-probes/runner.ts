// The page side of the probe lane: what probes.js installs in the ISOLATED
// world of a tab the agent is reading. One entry, run(name, params): resolve
// the template by name from the template table's own keys, hand it the
// params VALUE plus a helpers instance, and answer with the envelope the
// worker engine parses (envelope.ts). read_page_state alone is forwarded to
// the MAIN-world reader (page-state-reader.ts). Nothing here turns a string
// into code, and nothing here can: this bundle runs under the extension's
// content-script CSP, which refuses eval, Function and string timers.

import { envelopeOfAsync, errorEnvelope } from "./envelope.js";
import { readPageStateThroughReader } from "./page-state-reader.js";
import type { ProbePayload } from "./payload.js";
import { PROBE_TEMPLATES, probeHelpers } from "./probes.js";
import type { ProbeName } from "../../shared/probe-schemas.js";

/** The ISOLATED-world global probes.js installs; engine.ts calls through it by this exact name. */
export const PROBE_RUNNER_GLOBAL = "__rmxProbes";

export interface ProbeRunner {
  run(name: string, params: ProbePayload): Promise<string>;
}

interface ProbeRunnerHost {
  __rmxProbes?: ProbeRunner;
}

export function runProbeInPage(name: string, params: ProbePayload): Promise<string> {
  if (!Object.prototype.hasOwnProperty.call(PROBE_TEMPLATES, name)) {
    return Promise.resolve(errorEnvelope(`unknown probe "${name}"`));
  }
  // SAFETY: PROBE_TEMPLATES's own keys are exactly the ProbeName union, and the name was just checked against them.
  const probe = name as ProbeName;
  if (probe === "read_page_state") return Promise.resolve(readPageStateThroughReader(document, params));
  // SAFETY: the worker validated params against this probe's schema before sending them.
  return envelopeOfAsync(() => PROBE_TEMPLATES[probe](params as never, probeHelpers()));
}

/** Install the runner on a world's global once; a second injection of probes.js finds it and leaves it. */
export function installProbeRunner(host: typeof globalThis): ProbeRunner {
  // SAFETY: the runner owns this one property of the world's global; nothing else in the ISOLATED world writes it.
  const global = host as ProbeRunnerHost;
  if (global.__rmxProbes === undefined) global.__rmxProbes = { run: runProbeInPage };
  return global.__rmxProbes;
}
