// The user-script lane's two honesty contracts, both measured on real Chrome
// first (wiki/design/spike-c-userscripts.md, Chrome 151):
//
//   1. WHICH unlock the browser is asking for. Chrome 138 introduced the
//      per-extension "Allow user scripts" toggle; before that the API was
//      gated on Developer mode and property access THREW while it was off.
//      Onboarding must name the switch this browser actually draws.
//   2. Presence is not availability. A context born while the toggle was on
//      keeps chrome.userScripts after the user turns it off — every call then
//      throws "not available in this context". The worker is such a context,
//      so a capability report that trusts the namespace claims a working
//      script lane while remixlets have silently stopped running.

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const bundle = await esbuild.build({
  stdin: {
    contents: [
      'export { detectCapabilities, verifiedCapabilities, userScriptsSetupKind, userScriptsSetupReason, userScriptsUnlocked } from "./src/platform/capabilities.ts";',
      'export { scriptInjector } from "./src/platform/script-injector.ts";',
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "user-scripts-gate-contract.ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  define: { __BROWSER_TARGET__: JSON.stringify("chrome") },
});
const source = bundle.outputFiles[0].text;

let instance = 0;
/** A fresh module instance per scenario — the injector's revocation is
    per-context state, exactly like the browser's. */
async function load(chromeApi, userAgent) {
  globalThis.chrome = chromeApi;
  delete globalThis.browser;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent },
    configurable: true,
    writable: true,
  });
  const code = `${source}\n// instance ${(instance += 1)}\n`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function baseApi(extras) {
  return {
    runtime: {
      id: "user-scripts-gate",
      getManifest: () => ({ permissions: ["userScripts", "declarativeNetRequestWithHostAccess"], optional_permissions: [] }),
      getURL: (value) => `chrome-extension://user-scripts-gate/${value}`,
    },
    permissions: { contains: async () => true, request: async () => false },
    scripting: {},
    tabs: { captureVisibleTab: async () => "data:image/png;base64," },
    declarativeNetRequest: {},
    webNavigation: {},
    webRequest: {},
    windows: { getAll: async () => [], update: async (id) => ({ id }), create: async () => ({ id: 1 }) },
    ...extras,
  };
}

const CHROME_151 = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36";
const CHROME_137 = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36";

// 1a. Modern Chrome, toggle off: the namespace is simply absent.
{
  const gate = await load(baseApi({}), CHROME_151);
  assert(gate.userScriptsSetupKind() === "chrome-toggle", "Chrome 138+: onboarding points at the per-extension toggle");
  assert(/Allow user scripts/.test(gate.userScriptsSetupReason()), "Chrome 138+: the reason names the toggle");
  assert(!gate.userScriptsUnlocked(), "Chrome 138+: an absent namespace is locked");
  assert(!gate.detectCapabilities().userScripts, "Chrome 138+: locked lane reported as unavailable");
}

// 1b. Pre-138 with Developer mode off: property access throws. That throw is
// the probe — no version string needed to tell the two lockouts apart.
{
  const api = baseApi({});
  Object.defineProperty(api, "userScripts", {
    get() {
      throw new Error("Cannot read property 'userScripts'");
    },
  });
  const gate = await load(api, CHROME_151);
  assert(gate.userScriptsSetupKind() === "chrome-dev-mode", "a throwing namespace means Developer-mode gating");
  assert(/Developer mode/.test(gate.userScriptsSetupReason()), "dev-mode gating: the reason names Developer mode");
  assert(!gate.userScriptsUnlocked(), "a throwing namespace is locked");
}

// 1c. Pre-138 that merely returns undefined: the version is the fallback.
{
  const gate = await load(baseApi({}), CHROME_137);
  assert(gate.userScriptsSetupKind() === "chrome-dev-mode", "Chrome 137: onboarding points at Developer mode");
}

// 1d. An unreadable version means the modern UI, not a guess at the old one.
{
  const gate = await load(baseApi({}), "Node.js");
  assert(gate.userScriptsSetupKind() === "chrome-toggle", "unknown version: assume the toggle every current Chrome has");
}

// 2a. Revocation: the namespace survives, the calls do not.
{
  const revoked = new Error("'userScripts.getScripts' is not available in this context.");
  const gate = await load(
    baseApi({
      userScripts: {
        getScripts: async () => {
          throw revoked;
        },
        register: async () => {
          throw revoked;
        },
        configureWorld: async () => {},
        unregister: async () => {},
        update: async () => {},
      },
    }),
    CHROME_151,
  );
  assert(gate.userScriptsUnlocked(), "presence alone still reads as unlocked — that is the trap");
  assert(gate.detectCapabilities().userScripts, "the cheap sync read trusts the namespace");
  assert((await gate.scriptInjector().verifyAvailable()) === false, "one real call exposes the revoked lane");
  assert(!gate.scriptInjector().available, "a revoked injector stays revoked for the context's life");
  const verified = await gate.verifiedCapabilities();
  assert(!verified.userScripts, "verified capabilities report the lane as gone");
  assert(
    typeof verified.disabledReasons.userScripts === "string" && verified.disabledReasons.userScripts.length >= 24,
    "a revoked lane carries its user-facing reason",
  );
}

// 2b. A working lane is not collateral damage.
{
  const gate = await load(
    baseApi({ userScripts: { getScripts: async () => [], register: async () => {}, configureWorld: async () => {} } }),
    CHROME_151,
  );
  assert(await gate.scriptInjector().verifyAvailable(), "a live lane verifies");
  assert((await gate.verifiedCapabilities()).userScripts, "a live lane is reported as available");
}

// 2c. An unrelated failure must not revoke the lane — only the browser's own
// "not available in this context" means the grant is gone.
{
  let calls = 0;
  const gate = await load(
    baseApi({
      userScripts: {
        getScripts: async () => {
          if ((calls += 1) === 1) throw new Error("Service worker is starting up.");
          return [];
        },
        register: async () => {},
        configureWorld: async () => {},
      },
    }),
    CHROME_151,
  );
  assert(await gate.scriptInjector().verifyAvailable(), "a transient error leaves the lane intact");
  assert(gate.scriptInjector().available, "a transient error does not revoke");
}

console.log(
  "DONE — user-scripts gate: dev-mode vs toggle unlock detection, revoked-lane verification, transient errors spared",
);

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}
