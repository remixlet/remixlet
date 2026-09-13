// Clipboard write backend for the worker. MV3 service workers have no DOM
// and therefore no clipboard access; Chrome's offscreen-document API exists
// for exactly this — an invisible, extension-packaged page the worker can
// create for DOM-only work. The backend lives in the extension's one
// offscreen document (offscreen.html / offscreen.ts, shared with the box
// host — offscreen-document.ts owns creating it); this module delegates only
// already-authorized text to it. No remixlet source, callback, or executable
// payload is ever sent across. Chrome-only: Firefox and Safari have no
// supported background clipboard-write backend (see
// remixletCapabilityDisabledReason). Consumer: the worker bridge's clipboard
// capability.

import { ext } from "./ext.js";
import { ensureOffscreenDocument, offscreenDocumentAvailable } from "./offscreen-document.js";

export const CLIPBOARD_OFFSCREEN_MESSAGE = "rmx.platform.clipboard.writeText";
export const CLIPBOARD_OFFSCREEN_TARGET = "clipboard-offscreen";

interface ClipboardReply {
  ok: boolean;
  error?: string;
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!offscreenDocumentAvailable()) {
    throw new Error("clipboard is unavailable on this browser");
  }
  await ensureOffscreenDocument();
  // SAFETY: offscreen.ts replies with this contract for this exact message kind.
  const reply = (await ext.runtime.sendMessage({
    kind: CLIPBOARD_OFFSCREEN_MESSAGE,
    target: CLIPBOARD_OFFSCREEN_TARGET,
    text,
  })) as ClipboardReply | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? "clipboard backend did not respond");
}
