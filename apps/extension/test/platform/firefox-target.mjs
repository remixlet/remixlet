import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTargetCapabilityGates } from "./target-capability-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const build = spawnSync(process.execPath, ["build.mjs", "--target=firefox"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("Firefox extension build failed");

const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/firefox/manifest.json"), "utf8"));
const worker = await readFile(path.join(repoRoot, "dist/firefox/worker.js"), "utf8");
const panel = await readFile(path.join(repoRoot, "dist/firefox/panel/main.js"), "utf8");
const popup = await readFile(path.join(repoRoot, "dist/firefox/popup.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

const permissions = new Set(manifest.permissions ?? []);
const optionalPermissions = new Set(manifest.optional_permissions ?? []);

assert(manifest.manifest_version === 3, "Firefox remains an MV3 target");
assert(manifest.background?.scripts?.includes("worker.js"), "Firefox uses its supported background scripts path");
assert(manifest.background?.service_worker === undefined, "Firefox manifest does not claim service-worker support");
assert(manifest.background?.type === "module", "Firefox background script is loaded as a module");
assert(manifest.sidebar_action?.default_panel === "panel/index.html", "shared panel is exposed as a Firefox sidebar");
assert(manifest.side_panel === undefined, "Chrome side_panel key is absent");
assert(optionalPermissions.has("userScripts"), "Firefox requests userScripts as an optional permission");
assert(!permissions.has("userScripts"), "Firefox does not install-grant userScripts");
assert(
  permissions.has("declarativeNetRequest") && !permissions.has("declarativeNetRequestWithHostAccess"),
  "Firefox keeps plain declarativeNetRequest: its host permissions are optional-by-default, so the WithHostAccess variant would leave netrules and the OAuth redirect inert until the user opts in per site",
);
assert(!permissions.has("clipboardWrite"), "unsupported clipboard authority is absent");
assert(permissions.has("webRequestBlocking"), "response stream interception has its Firefox permission");
assert(permissions.has("webRequestFilterResponse"), "MV3 response filtering has its Firefox permission");
assert(!optionalPermissions.has("pageCapture"), "Chrome MHTML escalation is absent");
assert(worker.includes("firefox-user-scripts"), "Firefox ScriptInjector backend is bundled");
assert(worker.includes("Firefox capture is limited to the visible viewport"), "Firefox capture degradation is explicit");
assert(worker.includes('BROWSER_TARGET === "chrome"'), "DNR OAuth redirect remains Chrome-selected");
assert(worker.includes("clipboard is unavailable because Firefox"), "unsupported clipboard activation is explicit");
assert(
  worker.includes('BROWSER_TARGET = "firefox"') &&
    worker.includes('MIN_SCHEDULE_INTERVAL_MINUTES = BROWSER_TARGET === "chrome" ? 0.5 : 1'),
  "Firefox rejects repeating schedules below its one-minute alarm floor",
);
assert(panel.includes("userScriptsSetup"), "panel distinguishes Firefox setup from target-unavailable mode");
assert(popup.includes("popup-panel-error"), "sidebar open failures render visibly");
await assertTargetCapabilityGates("firefox");

console.log("DONE — Firefox target manifest, backend, and executable capability-gate contracts OK");
