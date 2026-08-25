import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = await esbuild.build({
  stdin: {
    contents: 'export { PLATFORM_REASON_COPY } from "./src/platform/capability-reasons.ts";',
    resolveDir: repoRoot,
    sourcefile: "capability-contract-entry.ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const source = result.outputFiles[0].text;
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const reasons = module.PLATFORM_REASON_COPY;

const targets = ["chrome", "firefox", "safari"];
const features = [
  "userScripts",
  "sidePanel",
  "panelSurface",
  "dnr",
  "dnrRegexSubstitution",
  "filterResponseData",
  "visibleTabCapture",
  "oauthRedirect",
];

for (const target of targets) {
  const keys = Object.keys(reasons[target] ?? {}).sort();
  if (keys.join(",") !== [...features].sort().join(",")) {
    throw new Error(`${target}: reason keys are incomplete (${keys.join(", ")})`);
  }
  for (const feature of features) {
    const reason = reasons[target][feature];
    if (typeof reason !== "string" || reason.length < 24) {
      throw new Error(`${target}.${feature}: missing specific disabled reason`);
    }
  }
}

const ruleManifest = { id: "capability-contract", netRules: "rules.json" };
const ruleFiles = {
  "rules.json": JSON.stringify([
    {
      id: 1,
      action: { type: "redirect", redirect: { regexSubstitution: "https://example.com/\\1" } },
      condition: { regexFilter: "^https://old.example/(.*)$" },
    },
  ]),
};

for (const target of targets) {
  globalThis.chrome = { declarativeNetRequest: {} };
  const contractBuild = await esbuild.build({
    stdin: {
      contents:
        'export { dnrRegexSubstitutionAvailable } from "./src/platform/capabilities.ts"; export { validateNetRulesFile } from "./src/worker/netrules.ts";',
      resolveDir: repoRoot,
      sourcefile: `${target}-capability-entry.ts`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: JSON.stringify(target) },
  });
  const contractSource = contractBuild.outputFiles[0].text;
  const contract = await import(`data:text/javascript;base64,${Buffer.from(contractSource).toString("base64")}`);
  const expected = target !== "safari";
  if (contract.dnrRegexSubstitutionAvailable() !== expected) {
    throw new Error(`${target}: incorrect regex-substitution capability`);
  }
  try {
    contract.validateNetRulesFile(ruleManifest, ruleFiles);
    if (!expected) throw new Error("Safari accepted an unverified regex-substitution redirect");
  } catch (error) {
    if (expected || !String(error).includes(reasons.safari.dnrRegexSubstitution)) throw error;
  }
  delete globalThis.chrome.declarativeNetRequest;
  if (contract.dnrRegexSubstitutionAvailable()) {
    throw new Error(`${target}: regex substitution remained enabled without DNR`);
  }
}

console.log("DONE — every platform capability has target-specific disabled reason copy");
