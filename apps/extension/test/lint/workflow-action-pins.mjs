// Third-party workflow actions execute in CI jobs that may hold repository
// credentials. Require immutable commit references; Dependabot keeps those
// SHAs current while the inline comments retain the readable release tag.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workflowDirectories = [
  { label: ".github/workflows", path: path.join(repoRoot, ".github", "workflows") },
  {
    label: "public overlay workflows",
    path: path.join(repoRoot, "publish", "overlay", ".github", "workflows"),
    optional: true,
  },
];
const immutableAction = /^[^\s/@]+\/[^\s/@]+@[0-9a-f]{40}$/;

export function movableActionReferences(source) {
  const findings = [];
  for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (!reference || reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (!immutableAction.test(reference)) {
      findings.push({ line: source.slice(0, match.index).split("\n").length, reference });
    }
  }
  return findings;
}

assert.deepEqual(movableActionReferences("steps:\n  - uses: actions/checkout@v6\n"), [
  { line: 2, reference: "actions/checkout@v6" },
]);
assert.deepEqual(
  movableActionReferences("steps:\n  - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6\n"),
  [],
);
assert.deepEqual(movableActionReferences("steps:\n  - uses: ./.github/actions/local\n"), []);

const problems = [];
let actionCount = 0;
let workflowCount = 0;
for (const directory of workflowDirectories) {
  const entries = await readdir(directory.path).catch((error) => {
    if (directory.optional && error?.code === "ENOENT") return [];
    throw error;
  });
  const workflowFiles = entries
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
  workflowCount += workflowFiles.length;
  for (const file of workflowFiles) {
    const source = await readFile(path.join(directory.path, file), "utf8");
    actionCount += [...source.matchAll(/^\s*(?:-\s*)?uses:/gm)].length;
    for (const finding of movableActionReferences(source)) {
      problems.push(`${directory.label}/${file}:${finding.line}: ${finding.reference}`);
    }
  }
}

if (problems.length > 0) {
  console.error("Workflow actions must use full 40-character commit SHAs:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`workflow action pins: ${actionCount} immutable reference(s) across ${workflowCount} workflow(s)`);
}
