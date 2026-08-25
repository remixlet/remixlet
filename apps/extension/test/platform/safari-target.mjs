import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTargetCapabilityGates } from "./target-capability-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const build = spawnSync(process.execPath, ["build.mjs", "--target=safari"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("Safari extension build failed");

const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/safari/manifest.json"), "utf8"));
const worker = await readFile(path.join(repoRoot, "dist/safari/worker.js"), "utf8");
const panel = await readFile(path.join(repoRoot, "dist/safari/panel/main.js"), "utf8");
const popup = await readFile(path.join(repoRoot, "dist/safari/popup.js"), "utf8");
const manager = await readFile(path.join(repoRoot, "dist/safari/manager.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

const permissions = new Set(manifest.permissions ?? []);
const optionalPermissions = new Set(manifest.optional_permissions ?? []);

assert(manifest.manifest_version === 3, "Safari remains an MV3 target");
assert(manifest.background?.service_worker === "worker.js", "Safari uses the generated background worker");
assert(manifest.background?.type === undefined, "Safari-unsupported background type key is absent");
assert(manifest.side_panel === undefined && manifest.sidebar_action === undefined, "unsupported sidebar keys are absent");
assert(!permissions.has("userScripts") && !optionalPermissions.has("userScripts"), "generated JS has no false grant");
assert(permissions.has("scripting"), "CSS injection remains available");
assert(permissions.has("declarativeNetRequest"), "supported DNR rules remain available");
assert(!permissions.has("notifications"), "Safari-unsupported notifications permission is absent");
assert(!optionalPermissions.has("pageCapture"), "Chrome MHTML escalation is absent");
assert(worker.includes("JavaScript remixlets are unavailable in Safari"), "JS activation has an explicit disabled reason");
assert(worker.includes("Safari limited mode"), "Safari boots the CSS/DNR mirror in limited mode");
assert(worker.includes("Safari capture is limited to the visible viewport"), "capture degradation is explicit");
assert(worker.includes("panel/index.html"), "popup PanelSurface includes the shared panel");
assert(worker.includes("targetWindowId: existing.id"), "existing Safari panel popup reports its actual window");
assert(worker.includes("targetWindowId: created.id"), "new Safari panel popup reports its created window");
assert(worker.includes("Safari did not return the panel popup window"), "missing popup identity fails closed");
assert(
  worker.includes("Safari's DNR implementation has not been runtime-verified"),
  "regex-substitution redirects fail with a specific Safari reason",
);
assert(panel.includes("JavaScript remixlets aren"), "panel explains Safari's limited mode");
assert(popup.includes("popup-panel-error"), "popup panel failures render visibly");
assert(
  manager.includes("manager-platform-limitations") &&
    manager.includes("Safari") &&
    manager.includes("limited mode") &&
    manager.includes("Why some features are unavailable"),
  "manager exposes Safari's target-specific disabled reasons in a compact limited-mode summary",
);
await assertTargetCapabilityGates("safari");

console.log("DONE — Safari limited-scope manifest, backend, and executable capability-gate contracts OK");
