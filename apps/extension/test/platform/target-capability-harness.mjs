import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function assertTargetCapabilityGates(target) {
  const fake = fakeExtensionApi(target);
  globalThis.chrome = fake;
  delete globalThis.browser;

  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { detectCapabilities, remixletCapabilityDisabledReason } from "./src/platform/capabilities.ts";',
        'export { platformReason } from "./src/platform/capability-reasons.ts";',
        'export { panelSurface } from "./src/platform/panel-surface.ts";',
        'export { validateNetRulesFile } from "./src/worker/netrules.ts";',
        'export { MIN_SCHEDULE_INTERVAL_MINUTES } from "./src/worker/schedule.ts";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: `${target}-runtime-capability-contract.ts`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: JSON.stringify(target) },
  });
  const source = result.outputFiles[0].text;
  const contract = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const capabilities = contract.detectCapabilities();

  assert(capabilities.target === target, `${target}: target identity`);
  if (target === "firefox") {
    assert(capabilities.userScriptsSetup === "permission", "Firefox: userScripts uses a real optional-permission path");
    assertSpecificReason(capabilities.disabledReasons.userScripts, "Firefox: locked userScripts reason");
    assert(capabilities.sidePanel === false && capabilities.panelSurface === "sidebar", "Firefox: sidebar fallback selected");
    assertSpecificReason(capabilities.disabledReasons.sidePanel, "Firefox: side-panel fallback reason");
    assert(capabilities.dnr && capabilities.dnrRegexSubstitution, "Firefox: documented DNR regex redirects enabled");
    assert(capabilities.filterResponseData && capabilities.visibleTabCapture, "Firefox: observation APIs detected");
    assert(capabilities.oauthRedirect === "webNavigation", "Firefox: OAuth fallback selected");
    assertSpecificReason(
      contract.remixletCapabilityDisabledReason("clipboard"),
      "Firefox: unsupported clipboard rejected before approval",
    );
    assert(
      contract.remixletCapabilityDisabledReason("notifications") === undefined,
      "Firefox: notifications remain supported",
    );
    assert(contract.remixletCapabilityDisabledReason("schedule") === undefined, "Firefox: schedules remain supported");
    assert(contract.MIN_SCHEDULE_INTERVAL_MINUTES === 1, "Firefox: one-minute repeating-alarm floor");
    assertRegexRule(contract, true);
    assertMissingApiReasons(contract, fake, target);

    delete fake.sidebarAction;
    assertUnavailablePanel(contract, target);
    return;
  }

  assert(capabilities.userScriptsSetup === "unsupported", "Safari: generated JavaScript is unavailable");
  assertSpecificReason(capabilities.disabledReasons.userScripts, "Safari: JavaScript reason");
  assert(capabilities.sidePanel === false && capabilities.panelSurface === "popup", "Safari: popup fallback selected");
  assertSpecificReason(capabilities.disabledReasons.sidePanel, "Safari: side-panel fallback reason");
  assert(capabilities.dnr && !capabilities.dnrRegexSubstitution, "Safari: fixed DNR only");
  assertSpecificReason(capabilities.disabledReasons.dnrRegexSubstitution, "Safari: regex DNR reason");
  assert(capabilities.filterResponseData === false, "Safari: response-stream capture unavailable");
  assertSpecificReason(capabilities.disabledReasons.filterResponseData, "Safari: response-stream reason");
  assert(capabilities.visibleTabCapture, "Safari: visible screenshot API detected");
  assert(capabilities.oauthRedirect === "webNavigation", "Safari: OAuth fallback selected");
  for (const service of ["clipboard", "notifications", "schedule"]) {
    assertSpecificReason(
      contract.remixletCapabilityDisabledReason(service),
      `Safari: unsupported ${service} rejected before approval`,
    );
  }
  assert(contract.MIN_SCHEDULE_INTERVAL_MINUTES === 1, "Safari: no false sub-minute schedule path");
  assertRegexRule(contract, false);
  assertMissingApiReasons(contract, fake, target);

  delete fake.windows;
  assertUnavailablePanel(contract, target);
}

function assertMissingApiReasons(contract, fake, target) {
  delete fake.declarativeNetRequest;
  let capabilities = contract.detectCapabilities();
  assert(!capabilities.dnr, `${target}: missing DNR detected`);
  assertSpecificReason(capabilities.disabledReasons.dnr, `${target}: missing DNR reason`);

  delete fake.tabs.captureVisibleTab;
  capabilities = contract.detectCapabilities();
  assert(!capabilities.visibleTabCapture, `${target}: missing visible screenshot API detected`);
  assertSpecificReason(capabilities.disabledReasons.visibleTabCapture, `${target}: missing screenshot reason`);

  delete fake.webNavigation;
  capabilities = contract.detectCapabilities();
  assert(capabilities.oauthRedirect === "unavailable", `${target}: missing OAuth callback backend detected`);
  assertSpecificReason(capabilities.disabledReasons.oauthRedirect, `${target}: missing OAuth callback reason`);
}

function fakeExtensionApi(target) {
  const common = {
    runtime: {
      id: "capability-contract",
      getManifest: () => ({
        permissions: ["declarativeNetRequest", "webNavigation", "tabs", "alarms"],
        optional_permissions: target === "firefox" ? ["userScripts"] : [],
      }),
      getURL: (value) => `chrome-extension://capability-contract/${value}`,
    },
    permissions: {
      contains: async () => false,
      request: async () => false,
    },
    scripting: {},
    tabs: {
      captureVisibleTab: async () => "data:image/png;base64,",
    },
    declarativeNetRequest: {},
    webNavigation: {},
  };
  if (target === "firefox") {
    return {
      ...common,
      sidebarAction: { open: async () => {} },
      webRequest: { filterResponseData: () => ({}) },
      notifications: { create: async () => "notification" },
      alarms: { create: async () => {} },
    };
  }
  return {
    ...common,
    webRequest: {},
    windows: {
      getAll: async () => [],
      update: async (id) => ({ id }),
      create: async () => ({ id: 1 }),
    },
  };
}

function assertRegexRule(contract, expected) {
  const manifest = { id: "target-contract", netRules: "rules.json" };
  const fixed = {
    "rules.json": JSON.stringify([
      {
        id: 1,
        action: { type: "redirect", redirect: { url: "https://example.com/fixed" } },
        condition: { urlFilter: "old.example" },
      },
    ]),
  };
  contract.validateNetRulesFile(manifest, fixed);

  const regex = {
    "rules.json": JSON.stringify([
      {
        id: 1,
        action: { type: "redirect", redirect: { regexSubstitution: "https://example.com/\\1" } },
        condition: { regexFilter: "^https://old.example/(.*)$" },
      },
    ]),
  };
  try {
    contract.validateNetRulesFile(manifest, regex);
    assert(expected, "Safari accepted an unverified regex-substitution redirect");
  } catch (error) {
    assert(!expected && String(error).includes("Use a fixed URL redirect"), `unexpected regex gate: ${String(error)}`);
  }
}

async function assertUnavailablePanel(contract, target) {
  const surface = contract.panelSurface();
  assert(surface.kind === "unavailable" && surface.available === false, `${target}: missing window surface detected`);
  const expected = contract.platformReason(target, "panelSurface");
  assert(surface.disabledReason === expected, `${target}: panel reason is target-specific`);
  try {
    await surface.open();
    throw new Error(`${target}: unavailable panel opened`);
  } catch (error) {
    assert(String(error).includes(expected), `${target}: unavailable panel throws its visible reason`);
  }
  const capabilities = contract.detectCapabilities();
  assert(capabilities.panelSurface === "unavailable", `${target}: capability object reports unavailable panel`);
  assert(capabilities.disabledReasons.panelSurface === expected, `${target}: capability object carries panel reason`);
}

function assertSpecificReason(value, message) {
  assert(typeof value === "string" && value.length >= 24, message);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}
