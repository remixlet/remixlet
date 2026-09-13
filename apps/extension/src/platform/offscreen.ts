// Entry of the extension's one offscreen document (offscreen.html). Two jobs:
//
//   1. The box host (wiki/design/mediated-execution.md): every page agent's
//      runtime.connect port lands here; the host (box/host.ts) asks the worker
//      which remixlets to run, loads each into a sandboxed box.html iframe and
//      relays traffic. The worker's rmx.* lanes are reached over
//      runtime.sendMessage, so the bridge token stays in this document.
//   2. The clipboard backend: plain text from the worker's clipboard
//      capability, written through a textarea + execCommand("copy"), because
//      navigator.clipboard needs page focus an offscreen document never has.
//
// Packaged code only: this document never evaluates or imports remixlet-
// authored code — that runs inside the sandboxed iframes, on a null origin,
// with no handle to this window's extension privileges.

import { createBoxHost, sandboxFrameFactory, type AgentPort } from "../box/host.js";
import {
  AGENT_PORT_NAME,
  BOX_PAGE_PATH,
  type BoxBridgeMessage,
  type BoxHostPongMessage,
  type BoxResolveMessage,
  type BoxResolveReply,
} from "../box/protocol.js";
import { CLIPBOARD_OFFSCREEN_MESSAGE, CLIPBOARD_OFFSCREEN_TARGET } from "./clipboard.js";
import { ext } from "./ext.js";

const host = createBoxHost({
  createIframe: sandboxFrameFactory({
    container: document.body,
    src: ext.runtime.getURL(BOX_PAGE_PATH),
    window,
  }),
  async resolve(tabId, frameId, url) {
    const request: BoxResolveMessage = { kind: "box.resolve", tabId, frameId, url };
    // SAFETY: worker/box.ts answers box.resolve with a BoxResolveReply.
    const reply = (await ext.runtime.sendMessage(request)) as BoxResolveReply | undefined;
    return reply?.kind === "box.resolved" ? reply.remixlets : [];
  },
  async bridge(message: BoxBridgeMessage) {
    // SAFETY: worker/box.ts answers box.bridge with the bridge's BridgeReply.
    const reply = (await ext.runtime.sendMessage(message)) as { ok: boolean; error?: string } | undefined;
    return reply ?? { ok: false, error: "the worker did not answer" };
  },
  onLog: (message) => console.warn(`[remixlet] ${message}`),
});

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== AGENT_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  const url = port.sender?.url;
  const documentId = port.sender?.documentId;
  // Only a page can be an agent: an extension page opening this port name
  // has no document to mediate.
  if (tabId === undefined || frameId === undefined || url === undefined) {
    port.disconnect();
    return;
  }
  const agent: AgentPort = {
    sender: documentId === undefined ? { tabId, frameId, url } : { tabId, frameId, url, documentId },
    post: (message) => port.postMessage(message),
    onMessage: (listener) => port.onMessage.addListener((message) => listener(message)),
    onDisconnect: (listener) => port.onDisconnect.addListener(() => listener()),
  };
  host.acceptPort(agent);
});

interface OffscreenMessage {
  kind?: unknown;
  target?: unknown;
  text?: unknown;
}

function hasClipboardText(message: OffscreenMessage): message is OffscreenMessage & { text: string } {
  return Object.prototype.toString.call(message.text) === "[object String]";
}

ext.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message.kind === "box.host.ping") {
    sendResponse({ kind: "box.host.pong" } satisfies BoxHostPongMessage);
    return false;
  }
  if (message.kind === "box.refresh") {
    void host.refresh();
    return false;
  }
  if (message.kind !== CLIPBOARD_OFFSCREEN_MESSAGE || message.target !== CLIPBOARD_OFFSCREEN_TARGET) return false;
  if (!hasClipboardText(message)) {
    sendResponse({ ok: false, error: "clipboard backend requires text" });
    return false;
  }
  const text = document.querySelector<HTMLTextAreaElement>("#clipboard-text");
  if (!text) {
    sendResponse({ ok: false, error: "clipboard backend is unavailable" });
    return false;
  }
  text.value = message.text;
  text.select();
  const copied = document.execCommand("copy");
  text.value = "";
  sendResponse(copied ? { ok: true } : { ok: false, error: "clipboard write failed" });
  return false;
});
