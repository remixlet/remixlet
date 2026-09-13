// Declarative background scheduling for the `schedule` capability.
//
// This module intentionally stores and executes data only. Remixlet-authored
// JavaScript is never evaluated or imported by the service worker: an alarm
// may show an extension-owned notification, focus/open an in-scope tab, or
// enqueue an opaque hook name for remixlet code to consume on a later page.

import { BROWSER_TARGET, ext } from "../platform/ext.js";
import { Type, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { createOwnedNotification } from "../platform/notifications.js";
import { matchesPaused, urlMatchesAny } from "../shared/site-key.js";
import { hasCapabilityGrant } from "./activation.js";
import { readMirror } from "./injection.js";
import { readPausedSites } from "./site-pause.js";

export type ScheduleAction =
  | { type: "notify"; title: string; message: string }
  | { type: "open"; url: string }
  | { type: "hook"; name: string };

export interface TimedSchedule {
  id: string;
  trigger: "at" | "every";
  at?: number;
  everyMinutes?: number;
  nextRunAt: number;
  action: ScheduleAction;
}

interface ScheduleOwnerState {
  matches: string[];
  timed: Record<string, TimedSchedule>;
  siteOpenHooks: string[];
  queuedHooks: string[];
}

export interface ScheduleState {
  owners: Record<string, ScheduleOwnerState>;
}

interface BrowserAlarmOptions {
  when: number;
  periodInMinutes?: number;
}

const ActionInputSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type ActionInput = Static<typeof ActionInputSchema>;

const ScheduleFieldSchema = Type.Union([Type.String(), Type.Number(), ActionInputSchema]);
type ScheduleField = Static<typeof ScheduleFieldSchema>;
const ScheduleBridgeValueSchema = Type.Unknown();
type ScheduleBridgeValue = Static<typeof ScheduleBridgeValueSchema>;

export interface ScheduleRegistration {
  id?: ScheduleField;
  name?: ScheduleField;
  at?: ScheduleField;
  every?: ScheduleField;
  action?: ScheduleField;
  notify?: ScheduleField;
  open?: ScheduleField;
  hook?: ScheduleField;
}

const STATE_KEY = "remixletSchedules";
const SITE_OPEN_SESSION_KEY = "remixletScheduleSiteOpenSession";
const ALARM_PREFIX = "rmx-schedule:";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_NOTIFICATION_TITLE_LENGTH = 120;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

// Chrome 120+ honors 30-second periods. Firefox still clamps sub-minute
// repeating alarms, so reject them rather than silently changing semantics.
export const MIN_SCHEDULE_INTERVAL_MINUTES = BROWSER_TARGET === "chrome" ? 0.5 : 1;

let mutationTail: Promise<void> = Promise.resolve();
let siteOpenTail: Promise<void> = Promise.resolve();

function emptyState(): ScheduleState {
  return { owners: {} };
}

export async function readScheduleState(): Promise<ScheduleState> {
  const stored = await ext.storage.local.get(STATE_KEY);
  // SAFETY: schedule state is written only by mutateState and restoreScheduleState.
  return (stored[STATE_KEY] as ScheduleState | undefined) ?? emptyState();
}

export async function readScheduleSessionState(): Promise<string[]> {
  const stored = await ext.storage.session.get(SITE_OPEN_SESSION_KEY);
  // SAFETY: session markers are written only by the schedule helpers below as string arrays.
  return [...((stored[SITE_OPEN_SESSION_KEY] as string[] | undefined) ?? [])];
}

export async function restoreScheduleState(state: ScheduleState): Promise<void> {
  await mutateState(() => structuredClone(state));
  await rebuildBrowserAlarms();
}

export async function restoreScheduleSessionState(markers: string[]): Promise<void> {
  await serializeSiteOpen(() => ext.storage.session.set({ [SITE_OPEN_SESSION_KEY]: [...markers] }));
}

export async function registerTimedSchedule(
  ownerId: string,
  matches: string[],
  input: ScheduleRegistration,
): Promise<TimedSchedule> {
  const schedule = normalizeTimedSchedule(input);
  if (schedule.action.type === "open" && !urlMatchesAny(schedule.action.url, matches)) {
    throw new Error("open action URL is outside the remixlet's matches");
  }
  await mutateState((state) => {
    const owner = ensureOwner(state, ownerId, matches);
    owner.timed[schedule.id] = schedule;
    return state;
  });
  await reconcileStoredSchedules();
  return schedule;
}

export async function removeTimedSchedule(ownerId: string, scheduleId: ScheduleBridgeValue): Promise<boolean> {
  const id = validatedName(scheduleId, "schedule id");
  let removed = false;
  await mutateState((state) => {
    const owner = state.owners[ownerId];
    if (owner && owner.timed[id]) {
      delete owner.timed[id];
      removed = true;
      pruneOwner(state, ownerId);
    }
    return state;
  });
  await clearAlarm(alarmName(ownerId, id));
  return removed;
}

export async function registerSiteOpenHook(
  ownerId: string,
  matches: string[],
  hookName: ScheduleBridgeValue,
  senderUrl?: string,
): Promise<string> {
  const name = validatedName(hookName, "hook name");
  await mutateState((state) => {
    const owner = ensureOwner(state, ownerId, matches);
    if (!owner.siteOpenHooks.includes(name)) owner.siteOpenHooks.push(name);
    return state;
  });
  // Registration commonly happens during the first matching page load. The
  // navigation event precedes document_idle, so account for that load here.
  if (senderUrl && urlMatchesAny(senderUrl, matches)) await fireSiteOpenHookOnce(ownerId, name);
  return name;
}

export async function removeSiteOpenHook(ownerId: string, hookName: ScheduleBridgeValue): Promise<boolean> {
  const name = validatedName(hookName, "hook name");
  let removed = false;
  await mutateState((state) => {
    const owner = state.owners[ownerId];
    if (!owner) return state;
    const next = owner.siteOpenHooks.filter((candidate) => candidate !== name);
    removed = next.length !== owner.siteOpenHooks.length;
    owner.siteOpenHooks = next;
    owner.queuedHooks = owner.queuedHooks.filter((candidate) => candidate !== name);
    pruneOwner(state, ownerId);
    return state;
  });
  await removeSiteOpenSessionMarker(ownerId, name);
  return removed;
}

export async function listOwnedSchedules(ownerId: string): Promise<{
  timed: TimedSchedule[];
  onSiteOpen: string[];
}> {
  const owner = (await readScheduleState()).owners[ownerId];
  return {
    timed: Object.values(owner?.timed ?? {}).sort((a, b) => a.id.localeCompare(b.id)),
    onSiteOpen: [...(owner?.siteOpenHooks ?? [])].sort(),
  };
}

export async function consumeQueuedHooks(ownerId: string, senderUrl?: string): Promise<string[]> {
  let hooks: string[] = [];
  await mutateState((state) => {
    const owner = state.owners[ownerId];
    if (!owner) return state;
    if (!senderUrl || !urlMatchesAny(senderUrl, owner.matches)) {
      throw new Error("queued hooks may only be consumed from a matching page");
    }
    hooks = [...owner.queuedHooks];
    owner.queuedHooks = [];
    pruneOwner(state, ownerId);
    return state;
  });
  return hooks;
}

/** Remove definitions, queued hooks, session markers, and browser alarms. */
export async function clearOwnedSchedules(ownerId: string): Promise<void> {
  await mutateState((state) => {
    delete state.owners[ownerId];
    return state;
  });
  await removeSiteOpenSessionMarker(ownerId);
  const alarms = await ext.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => alarm.name.startsWith(ownerAlarmPrefix(ownerId)))
      .map((alarm) => clearAlarm(alarm.name)),
  );
}

/**
 * Startup/lifecycle reconciliation. Only active remixlets with both manifest
 * declaration and durable grant are passed as authorized owners, and
 * snapshotOwnerIds must list the owners that existed when the caller read the
 * facts behind that judgment — take both at the same point. The deletion below
 * runs later, behind the serialized mutation chain, against whatever the state
 * holds by then; judging an owner registered in between by facts that predate
 * it would delete a registration whose page holds a successful reply (the menu
 * reconciler had exactly this bug — wiki/design/menu-reconcile-race.md). An
 * owner missing from the snapshot keeps until the next reconcile, which reads
 * its own facts.
 */
export async function reconcileScheduleOwners(
  authorizedOwnerIds: ReadonlySet<string>,
  snapshotOwnerIds: ReadonlySet<string>,
): Promise<void> {
  const removed: string[] = [];
  await mutateState((state) => {
    for (const ownerId of Object.keys(state.owners)) {
      if (!snapshotOwnerIds.has(ownerId)) continue;
      if (authorizedOwnerIds.has(ownerId)) continue;
      delete state.owners[ownerId];
      removed.push(ownerId);
    }
    return state;
  });
  await Promise.all(removed.map((ownerId) => removeSiteOpenSessionMarker(ownerId)));
  await reconcileStoredSchedules();
}

/** Attach event listeners synchronously during worker evaluation. */
export function installSchedule(): void {
  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      void handleAlarm(alarm.name).catch((error) => console.error("[remixlet] schedule alarm failed", error));
    }
  });
  ext.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0 || !details.url) return;
    void handleMatchingSiteOpen(details.url).catch((error) =>
      console.error("[remixlet] onSiteOpen failed", error),
    );
  });
}

async function handleMatchingSiteOpen(url: string): Promise<void> {
  const state = await readScheduleState();
  for (const [ownerId, owner] of Object.entries(state.owners)) {
    if (!(await ownerHasScheduleAuthority(ownerId))) continue;
    if (!urlMatchesAny(url, owner.matches)) continue;
    for (const hook of owner.siteOpenHooks) await fireSiteOpenHookOnce(ownerId, hook);
  }
}

async function fireSiteOpenHookOnce(ownerId: string, hook: string): Promise<void> {
  let shouldEnqueue = false;
  await serializeSiteOpen(async () => {
    const marker = `${ownerId}\n${hook}`;
    const stored = await ext.storage.session.get(SITE_OPEN_SESSION_KEY);
    // SAFETY: session markers are written only by the schedule helpers below as string arrays.
    const fired = new Set((stored[SITE_OPEN_SESSION_KEY] as string[] | undefined) ?? []);
    if (fired.has(marker)) return;
    fired.add(marker);
    await ext.storage.session.set({ [SITE_OPEN_SESSION_KEY]: [...fired] });
    shouldEnqueue = true;
  });
  if (shouldEnqueue) await enqueueHook(ownerId, hook);
}

async function removeSiteOpenSessionMarker(ownerId: string, hook?: string): Promise<void> {
  await serializeSiteOpen(async () => {
    const stored = await ext.storage.session.get(SITE_OPEN_SESSION_KEY);
    // SAFETY: session markers are written only by the schedule helpers below as string arrays.
    const fired = (stored[SITE_OPEN_SESSION_KEY] as string[] | undefined) ?? [];
    const prefix = `${ownerId}\n`;
    const next = fired.filter((marker) => (hook ? marker !== `${prefix}${hook}` : !marker.startsWith(prefix)));
    if (next.length === fired.length) return;
    await ext.storage.session.set({ [SITE_OPEN_SESSION_KEY]: next });
  });
}

async function handleAlarm(name: string): Promise<void> {
  const parsed = parseAlarmName(name);
  if (!parsed) return;
  let action: ScheduleAction | undefined;
  await mutateState((state) => {
    const owner = state.owners[parsed.ownerId];
    const schedule = owner?.timed[parsed.scheduleId];
    if (!owner || !schedule) return state;
    action = schedule.action;
    if (schedule.trigger === "at") {
      delete owner.timed[parsed.scheduleId];
    } else {
      schedule.nextRunAt = nextFutureRun(schedule.nextRunAt, schedule.everyMinutes!, Date.now());
    }
    return state;
  });
  if (action) await executeAction(parsed.ownerId, action);
  await pruneEmptyOwner(parsed.ownerId);
}

/** Handle missed alarms once, then make chrome.alarms exactly match storage. */
async function reconcileStoredSchedules(): Promise<void> {
  const missed: { ownerId: string; action: ScheduleAction }[] = [];
  await mutateState((state) => {
    const now = Date.now();
    for (const [ownerId, owner] of Object.entries(state.owners)) {
      for (const [id, schedule] of Object.entries(owner.timed)) {
        if (schedule.nextRunAt > now) continue;
        missed.push({ ownerId, action: schedule.action });
        if (schedule.trigger === "at") delete owner.timed[id];
        else schedule.nextRunAt = nextFutureRun(schedule.nextRunAt, schedule.everyMinutes!, now);
      }
    }
    return state;
  });
  for (const item of missed) {
    await executeAction(item.ownerId, item.action).catch((error) =>
      console.error("[remixlet] missed schedule action failed", error),
    );
  }
  for (const ownerId of new Set(missed.map((item) => item.ownerId))) await pruneEmptyOwner(ownerId);
  await rebuildBrowserAlarms();
}

async function rebuildBrowserAlarms(): Promise<void> {
  const state = await readScheduleState();
  const alarms = await ext.alarms.getAll();
  await Promise.all(
    alarms.filter((alarm) => alarm.name.startsWith(ALARM_PREFIX)).map((alarm) => clearAlarm(alarm.name)),
  );
  for (const [ownerId, owner] of Object.entries(state.owners)) {
    for (const schedule of Object.values(owner.timed)) {
      const alarm: BrowserAlarmOptions = { when: schedule.nextRunAt };
      if (schedule.trigger === "every") alarm.periodInMinutes = schedule.everyMinutes;
      await ext.alarms.create(alarmName(ownerId, schedule.id), alarm);
    }
  }
}

async function executeAction(ownerId: string, action: ScheduleAction): Promise<void> {
  if (!(await ownerHasScheduleAuthority(ownerId))) return;
  const owner = (await readScheduleState()).owners[ownerId];
  if (!owner) return;
  // Pause is a kill switch, schedules included: a pause owns the whole remixlet
  // (site-pause.ts), so an owner whose matches claim any paused host stops
  // firing entirely — no notifications, hooks, or tab-opening — until resumed.
  if (matchesPaused(owner.matches, await readPausedSites())) return;
  if (action.type === "notify") {
    await createOwnedNotification(ownerId, action.title, action.message);
    return;
  }
  if (action.type === "hook") {
    await enqueueHook(ownerId, action.name);
    return;
  }
  if (!urlMatchesAny(action.url, owner.matches)) return;
  const matching = (await ext.tabs.query({})).find(
    (tab) => tab.id !== undefined && tab.url === action.url,
  );
  if (matching?.id !== undefined) {
    await ext.tabs.update(matching.id, { active: true });
    if (matching.windowId !== undefined) await ext.windows.update(matching.windowId, { focused: true });
  } else {
    await ext.tabs.create({ url: action.url });
  }
}

async function ownerHasScheduleAuthority(ownerId: string): Promise<boolean> {
  const remixlet = (await readMirror()).find((candidate) => candidate.id === ownerId);
  if (!remixlet?.capabilities.includes("schedule")) return false;
  // Re-check against the stored artifact itself — the approval record — not
  // just the derived mirror (activation.ts, hasCapabilityGrant).
  return hasCapabilityGrant(ownerId, "schedule");
}

async function enqueueHook(ownerId: string, hook: string): Promise<void> {
  await mutateState((state) => {
    const owner = state.owners[ownerId];
    if (owner) owner.queuedHooks.push(hook);
    return state;
  });
}

async function pruneEmptyOwner(ownerId: string): Promise<void> {
  await mutateState((state) => {
    pruneOwner(state, ownerId);
    return state;
  });
}

function normalizeTimedSchedule(input: ScheduleRegistration): TimedSchedule {
  const id = validatedName(input.id ?? input.name, "schedule id");
  const hasAt = input.at !== undefined;
  const hasEvery = input.every !== undefined;
  if (hasAt === hasEvery) throw new Error('schedule must specify exactly one of "at" or "every"');
  const action = normalizeAction(input);
  if (hasAt) {
    const at = Check(Type.String(), input.at) ? Date.parse(input.at) : Parse(Type.Number(), input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new Error('"at" must be an epoch-millisecond number or an ISO date string');
    }
    return { id, trigger: "at", at, nextRunAt: at, action };
  }
  const every = Parse(Type.Number(), input.every);
  if (!Number.isFinite(every) || every < MIN_SCHEDULE_INTERVAL_MINUTES) {
    throw new Error(`"every" must be at least ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes in this browser`);
  }
  return {
    id,
    trigger: "every",
    everyMinutes: every,
    nextRunAt: Date.now() + every * 60_000,
    action,
  };
}

function normalizeAction(input: ScheduleRegistration): ScheduleAction {
  const shorthandCount = [input.notify, input.open, input.hook].filter((value) => value !== undefined).length;
  if (input.action !== undefined && shorthandCount > 0) throw new Error("schedule action is ambiguous");
  let raw = input.action;
  if (raw === undefined && input.notify !== undefined) raw = { type: "notify", ...asActionInput(input.notify, "notify") };
  if (raw === undefined && input.open !== undefined) {
    raw = Check(Type.String(), input.open)
      ? { type: "open", url: input.open }
      : { type: "open", ...asActionInput(input.open, "open") };
  }
  if (raw === undefined && input.hook !== undefined) raw = { type: "hook", name: validatedName(input.hook, "hook name") };
  const action = asActionInput(raw, "action");
  if (action.type === "notify") {
    const title = validatedText(action.title, "notification title", MAX_NOTIFICATION_TITLE_LENGTH);
    const message = validatedText(action.message, "notification message", MAX_NOTIFICATION_MESSAGE_LENGTH);
    return { type: "notify", title, message };
  }
  if (action.type === "open") {
    const actionUrl = Parse(Type.String(), action.url);
    let url: URL;
    try {
      url = new URL(actionUrl);
    } catch {
      throw new Error("open action url must be an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("open action url must use http or https");
    return { type: "open", url: url.href };
  }
  if (action.type === "hook") return { type: "hook", name: validatedName(action.name, "hook name") };
  throw new Error('action type must be "notify", "open", or "hook"');
}

function asActionInput(value: ScheduleField | undefined, field: string): ActionInput {
  if (!Check(ActionInputSchema, value)) throw new Error(`${field} must be an object`);
  return Parse(ActionInputSchema, value);
}

function validatedName(value: ScheduleBridgeValue, field: string): string {
  if (!Check(Type.String(), value) || !NAME_PATTERN.test(value)) {
    throw new Error(`${field} must match ${NAME_PATTERN}`);
  }
  return value;
}

function validatedText(value: string | undefined, field: string, maxLength: number): string {
  if (!value || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function ensureOwner(state: ScheduleState, ownerId: string, matches: string[]): ScheduleOwnerState {
  const owner = state.owners[ownerId] ?? {
    matches: [...matches],
    timed: {},
    siteOpenHooks: [],
    queuedHooks: [],
  };
  owner.matches = [...matches];
  state.owners[ownerId] = owner;
  return owner;
}

function pruneOwner(state: ScheduleState, ownerId: string): void {
  const owner = state.owners[ownerId];
  if (
    owner &&
    Object.keys(owner.timed).length === 0 &&
    owner.siteOpenHooks.length === 0 &&
    owner.queuedHooks.length === 0
  ) {
    delete state.owners[ownerId];
  }
}

async function mutateState(mutator: (state: ScheduleState) => ScheduleState): Promise<void> {
  let resolveCurrent!: () => void;
  const previous = mutationTail;
  mutationTail = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  await previous;
  try {
    const next = mutator(await readScheduleState());
    await ext.storage.local.set({ [STATE_KEY]: next });
  } finally {
    resolveCurrent();
  }
}

async function serializeSiteOpen(action: () => Promise<void>): Promise<void> {
  let resolveCurrent!: () => void;
  const previous = siteOpenTail;
  siteOpenTail = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  await previous;
  try {
    await action();
  } finally {
    resolveCurrent();
  }
}

function alarmName(ownerId: string, scheduleId: string): string {
  return `${ALARM_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(scheduleId)}`;
}

function ownerAlarmPrefix(ownerId: string): string {
  return `${ALARM_PREFIX}${encodeURIComponent(ownerId)}:`;
}

function parseAlarmName(name: string): { ownerId: string; scheduleId: string } | undefined {
  if (!name.startsWith(ALARM_PREFIX)) return undefined;
  const encoded = name.slice(ALARM_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator < 1) return undefined;
  try {
    return {
      ownerId: decodeURIComponent(encoded.slice(0, separator)),
      scheduleId: decodeURIComponent(encoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
}

function nextFutureRun(previous: number, everyMinutes: number, now: number): number {
  const period = everyMinutes * 60_000;
  return previous + Math.max(1, Math.floor((now - previous) / period) + 1) * period;
}

function clearAlarm(name: string): Promise<boolean> {
  return ext.alarms.clear(name);
}
