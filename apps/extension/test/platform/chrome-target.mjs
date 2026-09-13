import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertActiveTabResolution } from "./active-tab-harness.mjs";
import { assertScreenshotIdentityGuard } from "./screenshot-identity-harness.mjs";
import { assertPageAssetFetchBoundary } from "./page-asset-fetch-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildEnv = { ...process.env };
const build = spawnSync(process.execPath, ["build.mjs", "--target=chrome", "--release"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: buildEnv,
});
if (build.status !== 0) throw new Error("Chrome extension build failed");

const manifest = JSON.parse(await readFile(path.join(repoRoot, "dist/chrome/manifest.json"), "utf8"));
const panel = await readFile(path.join(repoRoot, "dist/chrome/panel/main.js"), "utf8");
const popup = await readFile(path.join(repoRoot, "dist/chrome/popup.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

const expectedPermissions = new Set([
  "alarms",
  "clipboardWrite",
  "declarativeNetRequestWithHostAccess",
  "notifications",
  "offscreen",
  "scripting",
  "sidePanel",
  "storage",
  "tabs",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
]);
assert(
  manifest.permissions.length === expectedPermissions.size &&
    manifest.permissions.every((permission) => expectedPermissions.has(permission)),
  "Chrome permissions match the audited allowlist",
);
assert(!("optional_permissions" in manifest), "Chrome requests no optional permissions");
assert(!manifest.permissions.includes("userScripts") && !(manifest.optional_permissions ?? []).includes("userScripts"),
  "Chrome declares no userScripts permission: nothing runs in that lane any more (wiki/design/mediated-execution.md)");
assert(manifest.permissions.includes("sidePanel"), "Chrome declares sidePanel");
assert(
  manifest.permissions.includes("declarativeNetRequestWithHostAccess") &&
    !manifest.permissions.includes("declarativeNetRequest"),
  'Chrome uses the WithHostAccess DNR variant — same capabilities under <all_urls>, without the standalone "Block content on any page" install warning (wiki/ops/chrome-store-submission.md §3.1)',
);
assert(
  manifest.minimum_chrome_version === "138",
  "Chrome floor stays 138, the floor 0.1.1 shipped with; the box itself needs less (wiki/design/mediated-execution.md, \"The user-scripts permission\")",
);
assert(
  !(manifest.optional_permissions ?? []).includes("pageCapture"),
  "pageCapture stays out of the manifest (MHTML slice dropped 2026-08-20 — see wiki/decisions/drop-mhtml-pagecapture.md)",
);
assert(popup.includes("popup-panel-error"), "panel open failure is visible instead of an unhandled rejection");
assert(
  panel.includes('ext.runtime.getURL("manager.html#/settings/providers")') &&
    panel.includes("open-secure-settings"),
  "provider settings open in a browser-owned extension tab",
);
assert(
  !manifest.web_accessible_resources.some((entry) => entry.resources?.includes("panel/index.html")),
  "the panel document is not web-accessible — no page can frame it (drawer surface removed, " +
    "wiki/decisions/drop-drawer-panel-fallback.md)",
);
assert(
  !manifest.content_scripts?.some((entry) => entry.matches?.some((match) => match.includes("remixlet.com"))),
  "standard build has no sharing-site content script",
);
// The mediated runtime (wiki/design/mediated-execution.md): one offscreen
// document hosts every box AND the clipboard backend (Chrome allows a single
// offscreen document per extension), and the page agent is a packaged content
// script the worker registers dynamically — never a code string.
assert(manifest.permissions.includes("offscreen"), "Chrome declares the offscreen permission for the box host");
assert(manifest.permissions.includes("scripting"), "Chrome declares scripting for the page agent registration");
const exists = (file) => access(path.join(repoRoot, "dist/chrome", file)).then(() => true, () => false);
for (const variant of ["dark", "light"]) {
  const filename = `remixlet-icon-${variant}.svg`;
  const canonical = await readFile(path.resolve(repoRoot, "../../assets/brand", filename));
  const packaged = await readFile(path.join(repoRoot, "dist/chrome/icons", filename));
  assert(packaged.equals(canonical), `the packaged ${variant} UI icon matches the canonical brand SVG`);
  for (const entry of ["popup", "manager", "welcome"]) {
    const bundle = await readFile(path.join(repoRoot, `dist/chrome/${entry}.js`), "utf8");
    assert(bundle.includes(`/icons/${filename}`), `${entry} uses the packaged ${variant} icon`);
  }
}
for (const size of [16, 32, 48, 128]) {
  const filename = `icon-${size}.png`;
  const generated = await readFile(path.join(repoRoot, "assets/icons", filename));
  const packaged = await readFile(path.join(repoRoot, "dist/chrome/icons", filename));
  assert(packaged.equals(generated), `the packaged ${size}px toolbar icon matches the generated asset`);
}
assert(await exists("offscreen.html"), "the offscreen document ships");
assert(await exists("offscreen.js"), "the offscreen entry ships");
assert(await exists("page-agent.js"), "the page agent content script ships");
assert(!(await exists("clipboard-offscreen.html")), "the standalone clipboard offscreen document is gone (merged into offscreen.html)");
const offscreenHtml = await readFile(path.join(repoRoot, "dist/chrome/offscreen.html"), "utf8");
assert(offscreenHtml.includes('id="clipboard-text"'), "the clipboard textarea lives in the shared offscreen document");
const offscreen = await readFile(path.join(repoRoot, "dist/chrome/offscreen.js"), "utf8");
assert(offscreen.includes("rmx.platform.clipboard.writeText"), "the offscreen entry answers the clipboard backend message");
assert(offscreen.includes('"allow-scripts"'), "box iframes carry the sandbox attribute as well as the manifest CSP");
const worker = await readFile(path.join(repoRoot, "dist/chrome/worker.js"), "utf8");
assert(worker.includes('"rmx-page-agent"') && worker.includes('"page-agent.js"'), "the worker registers the page agent by packaged file");
assert(
  !worker.includes("gatedUserScriptCode") && !worker.includes("function bridgeCode"),
  "the worker no longer generates USER_SCRIPT-world remixlet code (the old bridge/rmx.ts is out of the bundle)",
);
for (const [file, source] of Object.entries({ "worker.js": worker, "panel/main.js": panel, "popup.js": popup })) {
  assert(!/\buserScripts\b/.test(source), `${file} still names the userScripts API somewhere`);
}
assert(await exists("welcome.html") && !(await exists("probe.html")), "the welcome page ships without the toggle probe iframe");
await assertActiveTabResolution();
await assertScreenshotIdentityGuard();
await assertPageAssetFetchBoundary();

console.log("DONE — Chrome capability gates and permission affordances OK");
