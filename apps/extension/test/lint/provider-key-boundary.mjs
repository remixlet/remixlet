// API-key provider credentials belong to the long-lived panel only. This
// static guard prevents future protocol/bridge work from accidentally making
// them available to the service worker or injected page worlds.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const forbidden = ["src/shared/protocol.ts"];
for (const directory of ["src/bridge", "src/worker"]) {
  const entries = await readdir(directory, { recursive: true });
  forbidden.push(...entries.filter((entry) => entry.endsWith(".ts")).map((entry) => path.join(directory, entry)));
}

const leaks = [];
for (const file of forbidden) {
  const source = await readFile(file, "utf8");
  if (/\bapiKey\b|\bproviderSettings\b/.test(source)) leaks.push(file);
}

if (leaks.length > 0) {
  console.error(`Provider API keys must remain panel-local; credential references found in: ${leaks.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("provider key boundary: panel-local only");
}
