import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class FakeEvent {
  listeners = new Set();
  addListener(listener) {
    this.listeners.add(listener);
  }
  removeListener(listener) {
    this.listeners.delete(listener);
  }
  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

export async function assertScreenshotIdentityGuard() {
  const events = {
    activated: new FakeEvent(),
    attached: new FakeEvent(),
    detached: new FakeEvent(),
    removed: new FakeEvent(),
    updated: new FakeEvent(),
    beforeNavigate: new FakeEvent(),
    committed: new FakeEvent(),
    history: new FakeEvent(),
    fragment: new FakeEvent(),
  };
  let tab = { id: 1, windowId: 7, active: true, url: "https://one.example/" };
  let activeTabId = 1;
  let documentId = "document-one";
  let capture = async () => "data:image/png;base64,T05F";

  globalThis.chrome = {
    runtime: {
      getURL: (value) => `chrome-extension://screenshot-contract/${value}`,
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab, id: activeTabId, active: true }],
      captureVisibleTab: (...args) => capture(...args),
      onActivated: events.activated,
      onAttached: events.attached,
      onDetached: events.detached,
      onRemoved: events.removed,
      onUpdated: events.updated,
    },
    webNavigation: {
      getFrame: async () => ({
        url: tab.url,
        documentId,
        documentLifecycle: "active",
      }),
      onBeforeNavigate: events.beforeNavigate,
      onCommitted: events.committed,
      onHistoryStateUpdated: events.history,
      onReferenceFragmentUpdated: events.fragment,
    },
  };
  delete globalThis.browser;

  const result = await esbuild.build({
    stdin: {
      contents:
        'export { captureVisibleTabForTab, withVisibleTabCaptureGuard, SCREENSHOT_IDENTITY_CHANGED_MESSAGE } from "./src/platform/observation/snapshot.ts";',
      resolveDir: repoRoot,
      sourcefile: "screenshot-identity-contract.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define: { __BROWSER_TARGET__: '"chrome"' },
  });
  const source = result.outputFiles[0].text;
  const contract = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

  async function rejectsChanged(run, label) {
    await assert.rejects(
      run,
      (error) => {
        assert.equal(error.message, contract.SCREENSHOT_IDENTITY_CHANGED_MESSAGE, `${label}: exact visible reason`);
        return true;
      },
      label,
    );
  }

  capture = async () => {
    activeTabId = 2;
    events.activated.emit({ tabId: 2, windowId: 7 });
    return "data:image/png;base64,VFdP";
  };
  await rejectsChanged(() => contract.captureVisibleTabForTab(1), "switch during first capture");

  activeTabId = 1;
  let attempts = 0;
  capture = async () => {
    attempts += 1;
    if (attempts === 1) {
      activeTabId = 2;
      events.activated.emit({ tabId: 2, windowId: 7 });
      activeTabId = 1;
      events.activated.emit({ tabId: 1, windowId: 7 });
      throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND");
    }
    return "data:image/png;base64,V1JPTkc=";
  };
  await rejectsChanged(() => contract.captureVisibleTabForTab(1), "away and back before quota retry");
  assert.equal(attempts, 1, "a tainted quota attempt is never retried");

  activeTabId = 1;
  attempts = 0;
  capture = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND");
    return "data:image/png;base64,V1JPTkc=";
  };
  const duringWait = contract.captureVisibleTabForTab(1);
  setTimeout(() => {
    activeTabId = 2;
    events.activated.emit({ tabId: 2, windowId: 7 });
    activeTabId = 1;
    events.activated.emit({ tabId: 1, windowId: 7 });
  }, 20);
  await rejectsChanged(() => duringWait, "away and back during quota wait");
  assert.equal(attempts, 1, "an activation during quota backoff prevents the retry");

  capture = async () => {
    documentId = "document-two";
    events.committed.emit({ tabId: 1, frameId: 0, url: tab.url, documentId });
    return "data:image/png;base64,V1JPTkc=";
  };
  await rejectsChanged(() => contract.captureVisibleTabForTab(1), "same-url document replacement during capture");

  documentId = "document-three";
  capture = async () => {
    tab = { ...tab, windowId: 8 };
    events.detached.emit(1, { oldWindowId: 7, oldPosition: 0 });
    events.attached.emit(1, { newWindowId: 8, newPosition: 0 });
    return "data:image/png;base64,V1JPTkc=";
  };
  await rejectsChanged(() => contract.captureVisibleTabForTab(1), "tab moved to another window during capture");

  tab = { ...tab, windowId: 7 };
  activeTabId = 1;
  documentId = "document-four";
  attempts = 0;
  capture = async () => {
    attempts += 1;
    return "data:image/png;base64,T05F";
  };
  await rejectsChanged(
    () =>
      contract.withVisibleTabCaptureGuard(1, async (guard) => {
        await guard.capture();
        activeTabId = 2;
        events.activated.emit({ tabId: 2, windowId: 7 });
        activeTabId = 1;
        events.activated.emit({ tabId: 1, windowId: 7 });
        return guard.capture();
      }),
    "away and back between look-review captures",
  );
  assert.equal(attempts, 1, "look review never takes its second image after an intervening switch");
}
