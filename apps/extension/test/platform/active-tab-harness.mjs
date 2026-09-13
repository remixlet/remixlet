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

  globalThis.chrome = {
    runtime: {
      getURL: (value) => `chrome-extension://active-tab-contract/${value}`,
    },
    tabs: {
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

  currentTabs = [{ id: 11, url: "https://soundcloud.com/feed", windowId: 2, active: true }];
  assert.deepEqual(await contract.resolveActiveBrowserTab(), {
    id: 11,
    url: "https://soundcloud.com/feed",
    windowId: 2,
  });
  assert.equal(fallbackCalls, 0, "normal popup keeps the current-window path");

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
  assert.equal(fallbackCalls, 1, "a detached popup falls back to the last-focused normal window");

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
