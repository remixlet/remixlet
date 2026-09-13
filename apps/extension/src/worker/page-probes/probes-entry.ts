// Entry of the probe bundle (probes.js): injected by the worker engine into
// the ISOLATED world of the tab a probe reads, once per document, through
// scripting.executeScript. Installs the runner and nothing else; the engine
// then calls it by name with the probe's params as arguments (runner.ts).

import { installProbeRunner } from "./runner.js";

installProbeRunner(globalThis);
