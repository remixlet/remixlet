import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function assertActiveTabResolution() {
  let currentTabs = [];
  let lastFocusedWindow = {};
  let currentError;
  let fallbackCalls = 0;
  let pinnedTab;
  let pinnedCalls = 0;
  let sessionStore = {};

  globalThis.chrome = {
    runtime: {
      getURL: (value) => `chrome-extension://active-tab-contract/${value}`,
    },
    storage: {
      // The drawer nonce lives in session state keyed remixletDrawer:<tabId>.
      session: { get: async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {}) },
    },
    tabs: {
      get: async (tabId) => {
        pinnedCalls += 1;
        return pinnedTab?.id === tabId ? pinnedTab : undefined;
      },
      query: async () => {
        if (currentError) throw currentError;
        return currentTabs;
      },
    },
    windows: {
      getLastFocused: async (options) => {
        fallbackCalls += 1;
        assert.deepEqual(options, { populate: true, windowTypes: ["normal"] });
        return lastFocusedWindow;
      },
    },
  };
  delete globalThis.browser;

  const result = await esbuild.build({
    stdin: {
      contents: 'export { resolveActiveBrowserTab } from "./src/platform/active-tab.ts";',
      resolveDir: repoRoot,
      sourcefile: "active-tab-contract.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: '"chrome"' },
  });
  const source = result.outputFiles[0].text;
  const contract = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

  // An extension popup/side panel normally has no tabId query parameter.
  // The regression converted the missing value with Number(null) => 0, so a
  // real Chrome tab 0 stole the surface from the active SoundCloud page.
  globalThis.location = { protocol: "chrome-extension:", search: "" };
  pinnedTab = { id: 0, url: "https://example.com/", windowId: 1, active: false };
  currentTabs = [{ id: 11, url: "https://soundcloud.com/feed", windowId: 2, active: true }];
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 11,
    url: "https://soundcloud.com/feed",
    windowId: 2,
  });
  assert.equal(pinnedCalls, 0, "a missing tabId never probes Chrome's valid tab 0");
  assert.equal(fallbackCalls, 0, "normal Chrome popup keeps the current-window path");

  currentTabs = [];
  lastFocusedWindow = {
    id: 2,
    type: "normal",
    tabs: [
      { id: 10, url: "https://example.com/", windowId: 2, active: false },
      { id: 11, url: "https://airbnb.com/rooms/1", windowId: 2, active: true },
    ],
  };
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 11,
    url: "https://airbnb.com/rooms/1",
    windowId: 2,
  });
  assert.equal(fallbackCalls, 1, "detached Arc popup falls back to the last-focused normal window");

  currentTabs = [{ id: 12, url: "chrome://extensions/", windowId: 2, active: true }];
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 12,
    url: "chrome://extensions/",
    windowId: 2,
  });
  assert.equal(fallbackCalls, 1, "a real restricted current page is not replaced with a different web tab");

  currentTabs = [{
    id: 20,
    url: "chrome-extension://active-tab-contract/panel/index.html",
    windowId: 9,
    active: true,
  }];
  lastFocusedWindow = {
    id: 2,
    type: "normal",
    tabs: [{ id: 11, url: "https://airbnb.com/rooms/1", windowId: 2, active: true }],
  };
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 11,
    url: "https://airbnb.com/rooms/1",
    windowId: 2,
  });

  // The drawer pins its tab with ?tabId= AND a ?nonce= matching the worker's
  // stored drawer session state — only then is the pinned tab honored (H3).
  globalThis.location = { protocol: "chrome-extension:", search: "?surface=drawer&tabId=21&nonce=n21" };
  pinnedTab = { id: 21, url: "https://airbnb.com/rooms/21", windowId: 4, active: true };
  sessionStore = { "remixletDrawer:21": { windowId: 4, conversationId: "c", nonce: "n21" } };
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 21,
    url: "https://airbnb.com/rooms/21",
    windowId: 4,
  });
  assert.equal(pinnedCalls, 1, "a drawer tabId with a matching nonce uses the pinned-tab path");

  // A hostile frame passing a bare ?tabId= (no nonce, no stored drawer state)
  // is refused: resolution falls through to the active tab, never the tab the
  // page named (Chain C). The pinned-tab path is not even probed.
  globalThis.location = { protocol: "chrome-extension:", search: "?surface=drawer&tabId=99" };
  pinnedTab = { id: 99, url: "https://webmail.example/inbox", windowId: 8, active: true };
  sessionStore = {};
  currentTabs = [{ id: 30, url: "https://the-real-active-page.example/", windowId: 5, active: true }];
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 30,
    url: "https://the-real-active-page.example/",
    windowId: 5,
  });
  assert.equal(pinnedCalls, 1, "a nonceless ?tabId= never probes the pinned tab");
  currentTabs = [];
  delete globalThis.location;

  currentTabs = [];
  lastFocusedWindow = { id: 2, type: "normal", tabs: [] };
  assert.equal(await contract.resolveActiveBrowserTab(), undefined);

  currentError = new Error("no current window");
  lastFocusedWindow = {
    id: 3,
    type: "normal",
    tabs: [{ id: 13, url: "https://airbnb.com/", windowId: 3, active: true }],
  };
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 13,
    url: "https://airbnb.com/",
    windowId: 3,
  });
}
