// The script running inside the packaged clipboard offscreen document — see
// clipboard.ts for why that document exists. It receives plain text from the
// platform backend and writes it via a textarea + execCommand("copy"),
// because navigator.clipboard requires page focus an offscreen document
// never has. Packaged code only: this document never evaluates or imports
// remixlet-authored code.

import { CLIPBOARD_OFFSCREEN_MESSAGE } from "./clipboard.js";

interface ClipboardMessage {
  kind?: unknown;
  target?: unknown;
  text?: unknown;
}

function hasClipboardText(message: ClipboardMessage): message is ClipboardMessage & { text: string } {
  return Object.prototype.toString.call(message.text) === "[object String]";
}

chrome.runtime.onMessage.addListener((message: ClipboardMessage, _sender, sendResponse) => {
  if (message.kind !== CLIPBOARD_OFFSCREEN_MESSAGE || message.target !== "clipboard-offscreen") return false;
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
