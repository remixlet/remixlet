import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertActiveTabResolution } from "./active-tab-harness.mjs";
import { assertChromePanelFallback } from "./panel-surface-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildEnv = { ...process.env };
const build = spawnSync(process.execPath, ["build.mjs", "--target=chrome"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: buildEnv,
});
if (build.status !== 0) throw new Error("Chrome extension build failed");

const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/chrome/manifest.json"), "utf8"));
const worker = await readFile(path.join(repoRoot, "dist/chrome/worker.js"), "utf8");
const panel = await readFile(path.join(repoRoot, "dist/chrome/panel/main.js"), "utf8");
const popup = await readFile(path.join(repoRoot, "dist/chrome/popup.js"), "utf8");
const drawerHost = await readFile(path.join(repoRoot, "dist/chrome/drawer-host.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

assert(manifest.permissions.includes("userScripts"), "Chrome declares its install-time userScripts permission");
assert(manifest.permissions.includes("sidePanel"), "Chrome declares sidePanel");
assert(
  !(manifest.optional_permissions ?? []).includes("pageCapture"),
  "pageCapture stays out of the manifest (MHTML slice dropped 2026-08-20 — see wiki/decisions/drop-mhtml-pagecapture.md)",
);
assert(popup.includes("popup-panel-error"), "panel open failure is visible instead of an unhandled rejection");
assert(drawerHost.includes("remixlet-extension-drawer"), "isolated in-page drawer host is bundled");
assert(drawerHost.includes("attachShadow({ mode: \"closed\" })"), "drawer shell uses a closed shadow root");
assert(
  panel.includes('ext.runtime.getURL("manager.html#/settings/providers")') &&
    panel.includes("drawer-open-secure-settings"),
  "provider settings open in a browser-owned extension tab",
);
assert(panel.includes("window.top !== window"), "embedded panels are restricted by framing, not a query string");
assert(
  manifest.web_accessible_resources.some(
    (entry) => entry.resources?.includes("panel/index.html") && entry.matches?.includes("<all_urls>"),
  ),
  "only the extension panel document is exposed for cross-origin drawer framing",
);
assert(
  !manifest.content_scripts?.some((entry) => entry.matches?.some((match) => match.includes("remixlet.com"))),
  "standard build has no sharing-site content script",
);
await assertActiveTabResolution();
await assertChromePanelFallback();

console.log("DONE — Chrome capability gates, Arc fallbacks, and permission affordances OK");
