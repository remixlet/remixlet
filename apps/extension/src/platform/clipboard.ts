// Clipboard write backend for the worker. MV3 service workers have no DOM
// and therefore no clipboard access; Chrome's offscreen-document API exists
// for exactly this — an invisible, extension-packaged page the worker can
// create for DOM-only work. This module owns creating that document
// (clipboard-offscreen.html/.ts) and delegates only already-authorized text
// to it; no remixlet source, callback, or executable payload is ever sent
// across. Chrome-only: Firefox and Safari have no supported background
// clipboard-write backend (see remixletCapabilityDisabledReason). Consumer:
// the worker bridge's clipboard capability.

import { BROWSER_TARGET, ext } from "./ext.js";

export const CLIPBOARD_OFFSCREEN_PATH = "clipboard-offscreen.html";
export const CLIPBOARD_OFFSCREEN_MESSAGE = "rmx.platform.clipboard.writeText";

interface ClipboardReply {
  ok: boolean;
  error?: string;
}

let creatingOffscreenDocument: Promise<void> | undefined;

export async function writeClipboardText(text: string): Promise<void> {
  if (BROWSER_TARGET !== "chrome" || !clipboardBackendAvailable()) {
    throw new Error("clipboard is unavailable on this browser");
  }
  await ensureOffscreenDocument();
  // SAFETY: clipboard-offscreen.ts replies with this contract for this exact message kind.
  const reply = await ext.runtime.sendMessage({
    kind: CLIPBOARD_OFFSCREEN_MESSAGE,
    target: "clipboard-offscreen",
    text,
  }) as ClipboardReply | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? "clipboard backend did not respond");
}

function clipboardBackendAvailable(): boolean {
  return "offscreen" in ext && ext.offscreen?.createDocument !== undefined && ext.runtime.getContexts !== undefined;
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = ext.runtime.getURL(CLIPBOARD_OFFSCREEN_PATH);
  const existing = await ext.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl],
  });
  if (existing.length > 0) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = ext.offscreen.createDocument({
      url: CLIPBOARD_OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Write text approved through the Remixlet clipboard capability.",
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  await creatingOffscreenDocument;
}
