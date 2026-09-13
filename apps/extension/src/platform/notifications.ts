// Backend over the WebExtensions notifications API — OS-level toast
// notifications created and cleared by string id. Ids are namespaced with an
// owner prefix so each remixlet can only address its own notifications: the
// worker bridge supplies the authenticated owner, and remixlet code never
// chooses ids, icons, buttons, URLs, or any other browser-specific options.
// Consumers: the worker bridge's notify capability and the schedule and
// activation services.
//
// A second, extension-owned family lives here too: the "ask" notification the
// panel raises when the agent is waiting for the user to allow something and
// the chat is out of view (panel/ask-notifications.ts). Its id carries the
// bound tab, so the worker's click handler can bring that tab forward with
// no state of its own to lose.

import { ext } from "./ext.js";

const NOTIFICATION_PREFIX = "rmx-notification:";
// Distinct from the remixlet-owned prefix above, so a remixlet's clear() can
// never address the panel's own notification.
const ASK_PREFIX = "rmx-ask:";
// Fixed, extension-owned 1×1 PNG. v1 deliberately exposes no icon surface.
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function notificationCall<Result>(invoke: (done: (result: Result) => void) => void): Promise<Result> {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const error = ext.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

const notifications = {
  create: (id: string, options: chrome.notifications.NotificationOptions<true>): Promise<string> =>
    notificationCall((done) => ext.notifications.create(id, options, done)),
  clear: (id: string): Promise<boolean> => notificationCall((done) => ext.notifications.clear(id, done)),
  getAll: (): Promise<Record<string, boolean>> =>
    notificationCall<object>((done) => ext.notifications.getAll(done)).then((all) => {
      const live: Record<string, boolean> = {};
      for (const [id, shown] of Object.entries(all)) {
        if (shown === true || shown === false) live[id] = shown;
      }
      return live;
    }),
};

export async function createOwnedNotification(ownerId: string, title: string, message: string): Promise<string> {
  const handle = crypto.randomUUID();
  const id = `${ownerPrefix(ownerId)}${handle}`;
  await notifications.create(id, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
  });
  return handle;
}

export async function clearOwnedNotification(ownerId: string, handle: string): Promise<boolean> {
  return notifications.clear(`${ownerPrefix(ownerId)}${handle}`);
}

/** Remove every live notification owned by one remixlet. Idempotent. */
export async function clearOwnedNotifications(ownerId: string): Promise<void> {
  const live = await notifications.getAll();
  const ownedIds = Object.keys(live).filter((id) => id.startsWith(ownerPrefix(ownerId)));
  await Promise.all(ownedIds.map((id) => notifications.clear(id)));
}

function ownerPrefix(ownerId: string): string {
  return `${NOTIFICATION_PREFIX}${encodeURIComponent(ownerId)}:`;
}

/** Safari ships no notifications API; every ask-notification call is a no-op there. */
function notificationsAvailable(): boolean {
  return "notifications" in ext && ext.notifications !== undefined && "create" in ext.notifications;
}

function askNotificationId(tabId: number): string {
  return `${ASK_PREFIX}${tabId}`;
}

/** The tab an ask notification points at, or undefined for any other notification id. */
export function askNotificationTabId(id: string): number | undefined {
  if (!id.startsWith(ASK_PREFIX)) return undefined;
  const tabId = Number(id.slice(ASK_PREFIX.length));
  return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

/**
 * Raise (or replace) the ask notification for one tab. One per tab: a turn is
 * serial, so a panel has at most one ask pending, and creating again with the
 * same id replaces the toast rather than stacking a second one.
 */
export async function showAskNotification(tabId: number, title: string, message: string): Promise<void> {
  if (!notificationsAvailable()) return;
  await notifications.create(askNotificationId(tabId), {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
  });
}

/** Take the ask notification for one tab down. Idempotent; no-op when none is showing. */
export async function clearAskNotification(tabId: number): Promise<void> {
  if (!notificationsAvailable()) return;
  await notifications.clear(askNotificationId(tabId));
}

/**
 * Worker side: a click on an ask notification brings its tab forward, which
 * is where the waiting panel is. Ids are the only state, so this survives the
 * worker being killed and restarted between the show and the click. A tab
 * closed in between is a silent no-op.
 */
export function installAskNotificationClicks(): void {
  if (!notificationsAvailable() || !ext.notifications.onClicked) return;
  ext.notifications.onClicked.addListener((id) => {
    const tabId = askNotificationTabId(id);
    if (tabId === undefined) return;
    void (async () => {
      await notifications.clear(id).catch(() => {});
      const tab = await ext.tabs.get(tabId).catch(() => undefined);
      if (tab?.id === undefined) return;
      await ext.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true });
    })().catch(() => {});
  });
}
