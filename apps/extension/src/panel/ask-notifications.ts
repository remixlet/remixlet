// The ask notification: when the agent stops to wait for the user's answer
// on a permission (the activation access dialog, the script approval, the
// one-click capability grant card, the closer-look card) and the chat is not
// in view, the panel raises one system notification so the user is drawn
// back to the tab. Nothing is raised while the panel is visible in a focused
// window: the user is already looking at the ask.
//
// Copy is panel-authored end to end. An OS toast reads as the system speaking,
// so no remixlet name, rationale, or other model-controlled string reaches it;
// the only variable is the bound tab's host, which comes from the tab's URL.
//
// The preference lives in chatPreferences.askNotifications (Settings >
// General > Permission alerts); the click is handled in the worker
// (platform/notifications.ts, installAskNotificationClicks) so it works after
// the panel that raised the toast has gone.

import { ext } from "../platform/ext.js";

export type PendingAskKind = "capability-approval" | "capability-request" | "dev-observe-request";

export interface AskNotificationCopy {
  title: string;
  message: string;
}

export const ASK_NOTIFICATION_TITLE = "Remixlet is waiting for you";

const CLICK_HINT = "Click to go back and decide.";

export function askNotificationCopy(kind: PendingAskKind, host: string): AskNotificationCopy {
  const where = host.length > 0 ? `on ${host}` : "on the page";
  let what: string;
  switch (kind) {
    case "capability-approval":
      what = `A remixlet is asking for more access ${where}.`;
      break;
    case "capability-request":
      what = `The assistant needs permission before it can continue ${where}.`;
      break;
    case "dev-observe-request":
      what = `The assistant needs a closer look at the page ${where} before it can continue.`;
      break;
  }
  return { title: ASK_NOTIFICATION_TITLE, message: `${what} ${CLICK_HINT}` };
}

/**
 * The decision, kept pure so it can be checked without a browser: notify only
 * when the feature is on and the panel is out of view, which means its
 * document is hidden (another tab is in front of it) or its window is not the
 * focused one (the user is in another app or another browser window).
 */
export function shouldNotifyForAsk(facts: { enabled: boolean; hidden: boolean; windowFocused: boolean }): boolean {
  return facts.enabled && (facts.hidden || !facts.windowFocused);
}

/** The two view facts shouldNotifyForAsk needs, read from the live panel document and its window. */
export async function panelViewFacts(): Promise<{ hidden: boolean; windowFocused: boolean }> {
  const hidden = document.visibilityState === "hidden";
  // A browser without windows.getCurrent (or one that rejects) counts as
  // focused: the hidden check alone still catches the switched-tab case.
  const windowFocused = await ext.windows
    .getCurrent()
    .then((window) => window.focused)
    .catch(() => true);
  return { hidden, windowFocused };
}
