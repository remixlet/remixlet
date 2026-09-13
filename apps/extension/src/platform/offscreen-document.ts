// The extension's ONE offscreen document (Chrome allows a single one per
// extension): offscreen.html hosts the sandboxed remixlet boxes
// (wiki/design/mediated-execution.md) and the clipboard backend. Both the
// worker's box glue (worker/box.ts) and the clipboard backend (clipboard.ts)
// go through here to make sure it exists before they talk to it.
//
// Lifecycle: created on demand, never closed by us. The document outlives
// service-worker deaths (Chrome keeps it until closeDocument or an extension
// unload), and holds nothing authoritative — its host rebuilds from the
// worker's answers, which come from storage. A fresh worker simply finds the
// document already there through runtime.getContexts, or creates it. Chrome
// only: Firefox and Safari have no offscreen API (see capability copy).

import { BROWSER_TARGET, ext } from "./ext.js";
import { OFFSCREEN_PATH, type BoxHostPingMessage, type BoxHostPongMessage } from "../box/protocol.js";

let creating: Promise<void> | undefined;

export function offscreenDocumentAvailable(): boolean {
  return (
    BROWSER_TARGET === "chrome" &&
    "offscreen" in ext &&
    ext.offscreen?.createDocument !== undefined &&
    ext.runtime.getContexts !== undefined
  );
}

/** The document's full URL — what `sender.url` reads on messages it sends. */
export function offscreenDocumentUrl(): string {
  return ext.runtime.getURL(OFFSCREEN_PATH);
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenDocumentAvailable()) throw new Error("the offscreen document is unavailable on this browser");
  // A create in flight owns the answer: createDocument resolves before
  // offscreen.js runs, so a second caller that checked getContexts in that
  // window (two tabs saying hello back to back) would see the document,
  // answer "ready", and hand its page agent a port that dies against a host
  // not yet listening. Join the create and its listening wait instead.
  if (creating) {
    await creating;
    return;
  }
  const existing = await ext.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenDocumentUrl()],
  });
  if (existing.length > 0) return;
  if (!creating) {
    creating = ext.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.IFRAME_SCRIPTING],
        justification:
          "Hosts sandboxed remixlet code in iframes and the clipboard backend the clipboard capability writes through.",
      })
      .catch((error) => {
        // Two callers can race past the getContexts check (one worker, or a
        // worker that died mid-create); the second create's "already exists"
        // is success, anything else is real.
        if (/single offscreen document|already exists/i.test(String(error))) return;
        throw error;
      })
      .then(awaitHostListening)
      .finally(() => {
        creating = undefined;
      });
  }
  await creating;
}

const HOST_READY_TIMEOUT_MS = 5000;
const HOST_READY_STEP_MS = 25;

/**
 * createDocument resolves once the document exists, not once offscreen.js has
 * run; a page agent told "ready" before the host's onConnect listener is in
 * place connects to nobody, and its port's immediate disconnect ends the
 * page's session for good. So a fresh document counts as created only once
 * it answers the ping.
 */
async function awaitHostListening(): Promise<void> {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  const ping: BoxHostPingMessage = { kind: "box.host.ping" };
  while (Date.now() < deadline) {
    // SAFETY: offscreen.ts answers box.host.ping with BoxHostPongMessage; anything else is "not yet".
    const reply = (await ext.runtime.sendMessage(ping).catch(() => undefined)) as BoxHostPongMessage | undefined;
    if (reply?.kind === "box.host.pong") return;
    await new Promise((resolve) => setTimeout(resolve, HOST_READY_STEP_MS));
  }
  throw new Error("the box host did not start listening");
}
