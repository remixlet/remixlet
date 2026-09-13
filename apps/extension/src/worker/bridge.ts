// Worker half of the rmx.* capability bridge: authentication, capability
// enforcement (against the stored manifest, the approval record — see
// hasCapabilityGrant in activation.ts), storage backing, and dispatch into
// privileged platform services (wiki/handoff.md §5). rmx.storage semantics: namespaced per remixlet,
// shared across ALL of that remixlet's matched hosts, invisible to pages,
// survives sites clearing their own storage. Backing: one
// chrome.storage.local key per remixlet holding { rev, data }.

import { ext } from "../platform/ext.js";
import { writeClipboardText } from "../platform/clipboard.js";
import { clearOwnedNotification, createOwnedNotification } from "../platform/notifications.js";
import { privilegedFetch, type PrivilegedFetchRequest, type PrivilegedFetchResult } from "../platform/privileged-fetch.js";
import { fetchHostPattern, urlMatchesFetchHostPattern } from "../shared/fetch-capability.js";
import { pageIneligibleReason } from "../shared/eligibility.js";
import { SCRIPT_LOG_MAX_MESSAGE_LENGTH } from "./script-log.js";
import { hasCapabilityGrant } from "./activation.js";
import { readDeletingMarks } from "./eligibility.js";
import { authenticatedRemixlet, readMirror } from "./injection.js";
import { readPausedSites } from "./site-pause.js";
import { handleMenuBridgeMessage, type MenuBridgeMessage } from "./menu.js";
import { appendScriptLog } from "./script-log.js";
import { recordRemixletRun } from "./usage.js";
import {
  clearOwnedSchedules,
  consumeQueuedHooks,
  listOwnedSchedules,
  registerSiteOpenHook,
  registerTimedSchedule,
  removeSiteOpenHook,
  removeTimedSchedule,
  type ScheduleRegistration,
} from "./schedule.js";

interface AuthenticatedBridgeMessage {
  remixletId: string;
  bridgeToken: string;
}

interface StorageBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.storage";
  op: "get" | "set" | "delete" | "watch";
  key?: string;
  value?: unknown;
  sinceRev?: number;
}

interface FetchBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.fetch";
  request: PrivilegedFetchRequest;
}

interface NotificationsBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.notifications";
  op: "show" | "clear";
  title?: unknown;
  message?: unknown;
  notificationId?: unknown;
}

interface ClipboardBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.clipboard";
  op: "writeText";
  text?: unknown;
}

interface LogBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.log";
  level?: unknown;
  message?: unknown;
}

interface RunBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.run";
}

interface ScheduleBridgeMessage extends AuthenticatedBridgeMessage {
  kind: "rmx.schedule";
  op: "register" | "remove" | "list" | "onSiteOpen" | "removeOnSiteOpen" | "consumeHooks" | "clear";
  definition?: ScheduleRegistration;
  scheduleId?: unknown;
  hookName?: unknown;
}

type BridgeMessage =
  | StorageBridgeMessage
  | FetchBridgeMessage
  | NotificationsBridgeMessage
  | ClipboardBridgeMessage
  | ScheduleBridgeMessage
  | LogBridgeMessage
  | RunBridgeMessage
  | MenuBridgeMessage;

export type BridgeReply =
  | {
      ok: true;
      value?: unknown;
      rev?: number;
      response?: PrivilegedFetchResult;
      notificationId?: string;
      cleared?: boolean;
      registrationId?: string;
      active?: boolean;
      invocation?: { invocationId: string; commandId: string };
      schedule?: unknown;
      schedules?: unknown;
      hooks?: string[];
    }
  | { ok: false; error: string };

type StorageValue = string | number | boolean | null | StorageValue[] | { [key: string]: StorageValue };
type StorageRecord = { [key: string]: StorageValue };

interface RemixletStorageRecord {
  rev: number;
  data: Record<string, StorageValue>;
}

const WATCH_TIMEOUT_MS = 20000;
const MAX_NOTIFICATION_TITLE_LENGTH = 120;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;
const NOTIFICATION_HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// In-memory waiters are fine: a dying worker drops the message channel and
// the bridge re-polls (its designed recovery path).
const waiters = new Map<string, Set<() => void>>();

export function isBridgeMessage<Message>(message: Message): message is Message & BridgeMessage {
  if (!hasBridgeEnvelope(message)) return false;
  const { kind } = message;
  return (
    kind === "rmx.storage" ||
    kind === "rmx.fetch" ||
    kind === "rmx.notifications" ||
    kind === "rmx.clipboard" ||
    kind === "rmx.schedule" ||
    kind === "rmx.log" ||
    kind === "rmx.run" ||
    kind === "rmx.menu"
  );
}

/**
 * A policy denial the WORKER decided — missing grant, URL outside the granted
 * patterns — is telemetry as well as an error reply. The remixlet's own catch
 * block usually swallows the error, and then the agent debugs blind: the luna
 * airbnb run burned three rebuild cycles theorizing about "pagination access"
 * while every rmx.fetch was being denied right here for a pattern mismatch the
 * worker never wrote down. Same text in the log as in the reply, so
 * read_remixlet_logs shows exactly what the script saw.
 */
async function deniedReply(remixletId: string, error: string, senderUrl?: string): Promise<BridgeReply> {
  await appendScriptLog(remixletId, "warn", error.slice(0, SCRIPT_LOG_MAX_MESSAGE_LENGTH), senderUrl).catch(() => {});
  return { ok: false, error };
}

async function bridgeActiveGate(
  remixlet: { id: string; matches: string[] },
  senderUrl: string | undefined,
): Promise<string | undefined> {
  return pageIneligibleReason(remixlet, senderUrl, await readPausedSites());
}

export async function handleBridgeMessage(
  message: BridgeMessage,
  sender?: chrome.runtime.MessageSender,
): Promise<BridgeReply> {
  const senderUrl = sender?.url ?? sender?.tab?.url;
  try {
    const remixlet = await authenticatedRemixlet(message.remixletId, message.bridgeToken);
    if (!remixlet) return { ok: false, error: "unauthenticated remixlet bridge caller" };
    if (message.kind === "rmx.log") {
      // Telemetry, not authority: no capability required. Bounded per-remixlet
      // ring; the panel's read_remixlet_logs tool reads it back for the agent.
      // log/info are the bridge's console-capture levels (additive to the
      // original warn/error lane — old remixlets calling rmx.log.warn/error
      // are unaffected).
      if (message.level !== "log" && message.level !== "info" && message.level !== "warn" && message.level !== "error") {
        return { ok: false, error: "level must be log, info, warn, or error" };
      }
      if (!isString(message.message) || message.message.length === 0) {
        return { ok: false, error: "message must be a non-empty string" };
      }
      await appendScriptLog(message.remixletId, message.level, message.message, sender?.url ?? sender?.tab?.url);
      return { ok: true };
    }
    // Pause + provenance gate for every lane but rmx.log (diagnostic — it must
    // record even from a paused or off-site caller): a bridge call is honored
    // only from a page the remixlet actually runs on, and never while the site
    // or the whole remixlet is paused. Pause is a kill switch, so already-live
    // script cannot keep reaching capabilities after the user pauses — the
    // check rmx.menu already made (menu.ts), hoisted to cover every lane.
    const gate = await bridgeActiveGate(remixlet, senderUrl);
    if (gate) return deniedReply(message.remixletId, gate, senderUrl);
    if (message.kind === "rmx.run") {
      // Telemetry, not authority: no capability required. The gate sends one
      // ping per activation; the dashboard reads the per-day aggregate back.
      await recordRemixletRun(message.remixletId);
      return { ok: true };
    }
    if (message.kind === "rmx.menu") {
      if (!sender) return { ok: false, error: "missing menu sender context" };
      return handleMenuBridgeMessage(message, sender);
    } else if (message.kind === "rmx.schedule") {
      if (!remixlet.capabilities.includes("schedule") || !(await hasCapabilityGrant(message.remixletId, "schedule"))) {
        return deniedReply(
          message.remixletId,
          `remixlet "${message.remixletId}" does not have a granted "schedule" capability`,
          senderUrl,
        );
      }
      switch (message.op) {
        case "register": {
          if (!message.definition) return { ok: false, error: "missing schedule definition" };
          const schedule = await registerTimedSchedule(message.remixletId, remixlet.matches, message.definition);
          return { ok: true, schedule };
        }
        case "remove":
          return { ok: true, cleared: await removeTimedSchedule(message.remixletId, message.scheduleId) };
        case "list":
          return { ok: true, schedules: await listOwnedSchedules(message.remixletId) };
        case "onSiteOpen":
          return {
            ok: true,
            value: await registerSiteOpenHook(
              message.remixletId,
              remixlet.matches,
              message.hookName,
              sender?.url ?? sender?.tab?.url,
            ),
          };
        case "removeOnSiteOpen":
          return { ok: true, cleared: await removeSiteOpenHook(message.remixletId, message.hookName) };
        case "consumeHooks":
          return {
            ok: true,
            hooks: await consumeQueuedHooks(message.remixletId, sender?.url ?? sender?.tab?.url),
          };
        case "clear":
          await clearOwnedSchedules(message.remixletId);
          return { ok: true, cleared: true };
      }
    } else if (message.kind === "rmx.clipboard") {
      if (!remixlet.capabilities.includes("clipboard") || !(await hasCapabilityGrant(message.remixletId, "clipboard"))) {
        return deniedReply(
          message.remixletId,
          `remixlet "${message.remixletId}" does not have a granted "clipboard" capability`,
          senderUrl,
        );
      }
      if (!isString(message.text)) return { ok: false, error: "text must be a string" };
      const textBytes = new TextEncoder().encode(message.text).byteLength;
      if (textBytes > MAX_CLIPBOARD_TEXT_BYTES) {
        return { ok: false, error: `text must be at most ${MAX_CLIPBOARD_TEXT_BYTES} UTF-8 bytes` };
      }
      await writeClipboardText(message.text);
      return { ok: true };
    } else if (message.kind === "rmx.notifications") {
      if (!remixlet.capabilities.includes("notifications") || !(await hasCapabilityGrant(message.remixletId, "notifications"))) {
        return deniedReply(
          message.remixletId,
          `remixlet "${message.remixletId}" does not have a granted "notifications" capability`,
          senderUrl,
        );
      }
      if (message.op === "show") {
        const title = parseNotificationText(
          message.title,
          "title",
          MAX_NOTIFICATION_TITLE_LENGTH,
        );
        if ("error" in title) return { ok: false, error: title.error };
        const notificationMessage = parseNotificationText(
          message.message,
          "message",
          MAX_NOTIFICATION_MESSAGE_LENGTH,
        );
        if ("error" in notificationMessage) return { ok: false, error: notificationMessage.error };
        const notificationId = await createOwnedNotification(
          message.remixletId,
          title.text,
          notificationMessage.text,
        );
        return { ok: true, notificationId };
      }
      if (!isString(message.notificationId) || !NOTIFICATION_HANDLE_PATTERN.test(message.notificationId)) {
        return { ok: false, error: "notificationId must be an rmx.notifications handle" };
      }
      return {
        ok: true,
        cleared: await clearOwnedNotification(message.remixletId, message.notificationId),
      };
    } else if (message.kind === "rmx.fetch") {
      const patterns: string[] = [];
      for (const capability of remixlet.capabilities) {
        const pattern = fetchHostPattern(capability);
        if (pattern !== undefined && (await hasCapabilityGrant(message.remixletId, capability))) patterns.push(pattern);
      }
      if (patterns.length === 0) {
        return deniedReply(
          message.remixletId,
          `remixlet "${message.remixletId}" does not have a granted "fetch:<host-pattern>" capability`,
          senderUrl,
        );
      }
      // Pre-check the requested URL so a pattern mismatch is a NAMED denial,
      // not an opaque failure: the message spells out which host was asked
      // for, which patterns are granted, and the exact-vs-wildcard rule that
      // usually explains the gap ("example.com" does not cover
      // "www.example.com"). privilegedFetch keeps its own predicate — it also
      // covers every redirect hop; this is the diagnosable front door.
      let requestedUrl: URL | undefined;
      if (isString(message.request.url)) {
        try {
          requestedUrl = new URL(message.request.url);
        } catch {
          // Unparseable URL — let privilegedFetch produce its own error.
        }
      }
      if (requestedUrl && !patterns.some((pattern) => urlMatchesFetchHostPattern(requestedUrl, pattern))) {
        return deniedReply(
          message.remixletId,
          `rmx.fetch denied: "${requestedUrl.hostname}" is outside the granted pattern(s) ${patterns
            .map((pattern) => `"${pattern}"`)
            .join(", ")} — an exact pattern covers only that exact host ("example.com" does not cover ` +
            `"www.example.com"; "*.example.com" covers both). The manifest needs a pattern covering this host, ` +
            `approved by the user.`,
          senderUrl,
        );
      }
      const response = await privilegedFetch(message.request, (url) =>
        patterns.some((pattern) => urlMatchesFetchHostPattern(url, pattern)),
      );
      return { ok: true, response };
    } else {
      if (!(await hasStorageGrant(message.remixletId))) {
        return deniedReply(
          message.remixletId,
          `remixlet "${message.remixletId}" does not have the "storage" capability`,
          senderUrl,
        );
      }
      if (!isString(message.key)) return { ok: false, error: "missing key" };
      switch (message.op) {
        case "get": {
          const store = await readStore(message.remixletId);
          return { ok: true, value: store.data[message.key], rev: store.rev };
        }
        case "set": {
          const store = await readStore(message.remixletId);
          if (!isStorageValue(message.value)) return { ok: false, error: "storage values must be JSON-compatible" };
          store.data[message.key] = message.value;
          await writeStore(message.remixletId, store);
          return { ok: true, rev: store.rev };
        }
        case "delete": {
          const store = await readStore(message.remixletId);
          delete store.data[message.key];
          await writeStore(message.remixletId, store);
          return { ok: true, rev: store.rev };
        }
        case "watch": {
          let store = await readStore(message.remixletId);
          if (store.rev === message.sinceRev) {
            await changedOrTimeout(message.remixletId);
            store = await readStore(message.remixletId);
          }
          return { ok: true, value: store.data[message.key], rev: store.rev };
        }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "rmx bridge failure" };
  }
}

function parseNotificationText<Value>(value: Value, field: string, maxLength: number): { text: string } | { error: string } {
  if (!isString(value)) return { error: `${field} must be a string` };
  if (value.length === 0) return { error: `${field} must not be empty` };
  if (value.length > maxLength) return { error: `${field} must be at most ${maxLength} characters` };
  return { text: value };
}

async function hasStorageGrant(remixletId: string): Promise<boolean> {
  const remixlet = (await readMirror()).find((r) => r.id === remixletId);
  return remixlet !== undefined && remixlet.capabilities.includes("storage") && hasCapabilityGrant(remixletId, "storage");
}

const storeKey = (remixletId: string) => `rmxstore:${remixletId}`;

// Every write to an rmxstore key goes through this lane, and so does
// delete-forever's removal of the key (clearRemixletStorage). The lane is what
// makes "an in-flight rmx.storage write does not recreate the key" true: a
// write queued before the removal lands first and is erased by it; one queued
// after it re-checks, behind the lane, that the remixlet is neither marked
// deleting nor gone from the mirror, and refuses. In-flight-only state.
let storageLane: Promise<unknown> = Promise.resolve();

function inStorageLane<T>(operation: () => Promise<T>): Promise<T> {
  const run = storageLane.then(operation, operation);
  storageLane = run.catch(() => undefined);
  return run;
}

async function readStore(remixletId: string): Promise<RemixletStorageRecord> {
  const stored = await ext.storage.local.get(storeKey(remixletId));
  return parseStorageRecord(stored[storeKey(remixletId)]);
}

async function writeStore(remixletId: string, store: RemixletStorageRecord): Promise<void> {
  await inStorageLane(async () => {
    if ((await readDeletingMarks()).has(remixletId) || !(await readMirror()).some((r) => r.id === remixletId)) {
      throw new Error(`remixlet "${remixletId}" storage is no longer available`);
    }
    store.rev += 1;
    await ext.storage.local.set({ [storeKey(remixletId)]: store });
  });
  for (const wake of waiters.get(remixletId) ?? []) wake();
  waiters.delete(remixletId);
}

/** Delete-forever's storage step: the remixlet's rmx.storage record, gone for good. */
export async function clearRemixletStorage(remixletId: string): Promise<void> {
  await inStorageLane(() => ext.storage.local.remove(storeKey(remixletId)));
  for (const wake of waiters.get(remixletId) ?? []) wake();
  waiters.delete(remixletId);
}

function hasBridgeEnvelope<Value>(value: Value): value is Value & StorageRecord {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isStorageValue<Value>(value: Value): value is Value & StorageValue {
  return (
    value === null ||
    isString(value) ||
    Object.prototype.toString.call(value) === "[object Number]" ||
    Object.prototype.toString.call(value) === "[object Boolean]" ||
    (Array.isArray(value) && value.every(isStorageValue)) ||
    isStorageRecord(value)
  );
}

function isStorageRecord<Value>(value: Value): value is Value & StorageRecord {
  return hasBridgeEnvelope(value) && Object.values(value).every(isStorageValue);
}

function parseStorageRecord<Value>(value: Value): RemixletStorageRecord {
  if (
    !hasBridgeEnvelope(value) ||
    !isStorageRecord(value.data) ||
    Object.prototype.toString.call(value.rev) !== "[object Number]"
  ) {
    return { rev: 0, data: {} };
  }
  const rev = Number(value.rev);
  if (!Number.isInteger(rev) || rev < 0) {
    return { rev: 0, data: {} };
  }
  return { rev, data: value.data };
}

function changedOrTimeout(remixletId: string): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(remixletId) ?? new Set();
    waiters.set(remixletId, set);
    const wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      set.delete(wake);
      resolve();
    }, WATCH_TIMEOUT_MS);
    set.add(wake);
  });
}
