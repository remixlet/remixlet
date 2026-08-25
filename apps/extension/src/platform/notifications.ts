// Backend over the WebExtensions notifications API — OS-level toast
// notifications created and cleared by string id. Ids are namespaced with an
// owner prefix so each remixlet can only address its own notifications: the
// worker bridge supplies the authenticated owner, and remixlet code never
// chooses ids, icons, buttons, URLs, or any other browser-specific options.
// Consumers: the worker bridge's notify capability and the schedule and
// activation services.

import { ext } from "./ext.js";

const NOTIFICATION_PREFIX = "rmx-notification:";
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
