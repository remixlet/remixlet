import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function assertChromePanelFallback() {
  let localStore = {};
  let sessionStore = {};
  const storageListeners = [];
  let popupCreates = 0;
  let sidePanelOpens = 0;
  let drawerInjections = 0;
  let drawerOpenMessages = 0;
  let drawerCloseMessages = 0;
  // What THIS fake browser does when asked for a side panel: "announce" is real
  // Chrome (a panel document boots and says hello), "silent" is Arc (open()
  // resolves, nothing ever appears), "reject" is an out-of-gesture call.
  let openBehavior = "announce";
  let contract;

  globalThis.chrome = {
    runtime: {
      getURL: (value) => `chrome-extension://panel-contract/${value}`,
    },
    sidePanel: {
      open: async ({ windowId }) => {
        assert.equal(windowId, 7);
        sidePanelOpens += 1;
        if (openBehavior === "reject") throw new Error("may only be called in response to a user gesture");
        // The panel document's own announcement, routed through the worker.
        if (openBehavior === "announce") await contract.confirmSidePanelSurface(true);
      },
    },
    storage: {
      onChanged: {
        addListener: (listener) => storageListeners.push(listener),
        removeListener: (listener) => {
          const at = storageListeners.indexOf(listener);
          if (at >= 0) storageListeners.splice(at, 1);
        },
      },
      local: {
        get: async (key) => (key in localStore ? { [key]: localStore[key] } : {}),
        set: async (values) => {
          Object.assign(localStore, values);
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }]));
          for (const listener of [...storageListeners]) listener(changes, "local");
        },
        remove: async (key) => {
          delete localStore[key];
        },
      },
      session: {
        get: async (key) => {
          if (key === null) return { ...sessionStore };
          return key in sessionStore ? { [key]: sessionStore[key] } : {};
        },
        set: async (values) => {
          Object.assign(sessionStore, values);
        },
        remove: async (key) => {
          delete sessionStore[key];
        },
      },
    },
    scripting: {
      executeScript: async (options) => {
        drawerInjections += 1;
        assert.deepEqual(options, {
          target: { tabId: 4 },
          files: ["drawer-host.js"],
          world: "ISOLATED",
        });
        return [];
      },
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://airbnb.com/rooms/1" }),
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 4);
        if (message.kind === "remixlet.drawer.close") {
          drawerCloseMessages += 1;
          return { ok: true };
        }
        drawerOpenMessages += 1;
        assert.match(
          message.panelUrl,
          /^chrome-extension:\/\/panel-contract\/panel\/index\.html\?surface=drawer&tabId=4&conversationId=/,
        );
        return { ok: true };
      },
    },
    windows: {
      getAll: async () => [],
      update: async (id) => ({ id }),
      create: async (options) => {
        popupCreates += 1;
        assert.deepEqual(options, {
          url: "chrome-extension://panel-contract/panel/index.html",
          type: "popup",
          width: 420,
          height: 720,
          focused: true,
        });
        return { id: 19 };
      },
    },
  };
  delete globalThis.browser;

  // The grace period is a real wall-clock wait in the browser; collapse it here
  // so the miss paths do not cost the suite seconds. Nothing else in this
  // bundle schedules a timer.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);

  const result = await esbuild.build({
    stdin: {
      contents: 'export { panelSurface, confirmSidePanelSurface } from "./src/platform/panel-surface.ts";',
      resolveDir: repoRoot,
      sourcefile: "panel-surface-contract.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: '"chrome"' },
  });
  const source = result.outputFiles[0].text;
  contract = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const surface = contract.panelSurface();

  try {
    // Real Chrome from a clean slate: the panel announces itself, the verdict is
    // recorded, and any stray drawer on the tab is dismissed so the two can
    // never show together.
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(sidePanelOpens, 1);
    assert.equal(popupCreates, 0, "working Chrome side panel does not create a popup");
    assert.equal(drawerInjections, 0, "working Chrome side panel does not inject a drawer");
    assert.equal(localStore.remixletSidePanelWorks, true, "a confirmed side panel records its verdict");
    assert.equal(drawerCloseMessages, 1, "a confirmed side panel dismisses any stray drawer");

    // The flake that opened BOTH surfaces: nothing announces itself on a browser
    // already confirmed to have a real side panel. The cached verdict must keep
    // the drawer out.
    openBehavior = "silent";
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(sidePanelOpens, 2);
    assert.equal(drawerInjections, 0, "a confirmed side panel NEVER falls back to the drawer");
    assert.equal(drawerOpenMessages, 0, "a confirmed side panel never opens the drawer panel");

    // Arc from a clean slate: open() resolves but no panel ever announces
    // itself. The drawer is the surface, and that verdict is recorded too.
    localStore = {};
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(sidePanelOpens, 3);
    assert.equal(drawerInjections, 1);
    assert.equal(drawerOpenMessages, 1);
    assert.equal(popupCreates, 0, "Arc's silent side-panel no-op uses the isolated drawer, not a popup");
    assert.equal(localStore.remixletSidePanelWorks, false, "a silent no-op side panel records its verdict");

    // Arc thereafter: still asks (the ask is free and keeps the verdict
    // correctable), still lands on the drawer.
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(sidePanelOpens, 4);
    assert.equal(drawerInjections, 2);

    // A wrong `false` — the bug this file exists for — heals on the very next
    // open: the panel announces itself inside the grace period, so no drawer is
    // injected and the drawer left behind by the mistake is dismissed.
    openBehavior = "announce";
    sessionStore["remixletDrawer:4"] = { windowId: 7, conversationId: "left-over" };
    const drawerInjectionsBefore = drawerInjections;
    const closesBefore = drawerCloseMessages;
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(localStore.remixletSidePanelWorks, true, "a live panel overrules a stale no-op verdict");
    assert.equal(drawerInjections, drawerInjectionsBefore, "a healed verdict injects no drawer");
    assert.ok(drawerCloseMessages > closesBefore, "healing dismisses the drawer the wrong verdict left behind");
    assert.equal(sessionStore["remixletDrawer:4"], undefined, "healing clears the leftover drawer state");

    // An out-of-gesture rejection (the manager's "+" path awaits tabs.create
    // first) is ambiguous: fall back for this click, but never record a verdict
    // from it.
    localStore = {};
    openBehavior = "reject";
    assert.deepEqual(await surface.open(7, 4), { targetWindowId: 7 });
    assert.equal(drawerInjections, drawerInjectionsBefore + 1);
    assert.equal(
      localStore.remixletSidePanelWorks,
      undefined,
      "a rejected open() says nothing about the browser and records nothing",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}
