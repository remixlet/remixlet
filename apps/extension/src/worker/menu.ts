// Durable worker-side state for rmx.menu. The worker stores only command
// metadata and pending invocations; callback functions never leave the
// remixlet's box. A box long-polls its own queue, so a
// popup click can wake a fresh MV3 worker and still reach the owning document.

import { ext } from "../platform/ext.js";
import { pageIneligibleReason, runsOn } from "../shared/eligibility.js";
import { matchesPaused, urlPaused } from "../shared/site-key.js";
import { hasCapabilityGrant } from "./activation.js";
import { authenticatedRemixlet, readMirror } from "./injection.js";
import { readPausedSites } from "./site-pause.js";

export interface MenuCommandSummary {
  registrationId: string;
  remixletId: string;
  commandId: string;
  label: string;
}

export interface MenuBridgeMessage {
  kind: "rmx.menu";
  op: "register" | "poll" | "ack";
  remixletId: string;
  bridgeToken: string;
  commandId?: MenuInput;
  label?: MenuInput;
  invocationId?: MenuInput;
}

type MenuInput = string | number | boolean | null | MenuInput[] | { [key: string]: MenuInput };

export type MenuBridgeReply =
  | {
      ok: true;
      registrationId?: string;
      active?: boolean;
      invocation?: { invocationId: string; commandId: string };
    }
  | { ok: false; error: string };

interface StoredCommand extends MenuCommandSummary {
  tabId: number;
  documentId: string;
  url: string;
  registeredAt: number;
}

interface StoredInvocation {
  invocationId: string;
  commandId: string;
  createdAt: number;
}

interface MenuState {
  commands: Record<string, StoredCommand>;
  queues: Record<string, StoredInvocation[]>;
}

interface MenuContext {
  remixletId: string;
  tabId: number;
  documentId: string;
  url: string;
}

const MENU_STATE_KEY = "rmxMenuState";
const POLL_TIMEOUT_MS = 20_000;
const MAX_COMMAND_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 160;
const waiters = new Map<string, Set<() => void>>();
let mutationTail: Promise<void> = Promise.resolve();

export async function handleMenuBridgeMessage(
  message: MenuBridgeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<MenuBridgeReply> {
  try {
    const context = await authenticateContext(message, sender);
    if ("error" in context) return { ok: false, error: context.error };

    if (message.op === "register") {
      const command = boundedString(message.commandId, "id", MAX_COMMAND_ID_LENGTH);
      if ("error" in command) return { ok: false, error: command.error };
      const label = boundedString(message.label, "label", MAX_LABEL_LENGTH);
      if ("error" in label) return { ok: false, error: label.error };
      const registrationId = crypto.randomUUID();
      await mutateState((state) => {
        const existing = Object.values(state.commands).find(
          (command) =>
            command.tabId === context.tabId &&
            command.documentId === context.documentId &&
            command.remixletId === context.remixletId &&
            command.commandId === message.commandId,
        );
        if (existing) {
          delete state.commands[existing.registrationId];
          removeQueuedCommand(state, contextKey(context), existing.commandId);
        }
        state.commands[registrationId] = {
          registrationId,
          remixletId: context.remixletId,
          commandId: command.value,
          label: label.value,
          tabId: context.tabId,
          documentId: context.documentId,
          url: context.url,
          registeredAt: Date.now(),
        };
      });
      wakeContext(contextKey(context));
      return { ok: true, registrationId };
    }

    const key = contextKey(context);
    if (message.op === "ack") {
      if (Object.prototype.toString.call(message.invocationId) !== "[object String]") {
        return { ok: false, error: "missing invocationId" };
      }
      await mutateState((state) => {
        state.queues[key] = (state.queues[key] ?? []).filter(
          (invocation) => invocation.invocationId !== message.invocationId,
        );
        if (state.queues[key].length === 0) delete state.queues[key];
      });
      return { ok: true };
    }

    let state = await readState();
    if (!hasContextCommands(state, context)) return { ok: true, active: false };
    if ((state.queues[key] ?? []).length === 0) {
      await changedOrTimeout(key);
      state = await readState();
    }
    const invocation = state.queues[key]?.[0];
    const reply: Extract<MenuBridgeReply, { ok: true }> = {
      ok: true,
      active: hasContextCommands(state, context),
    };
    if (invocation) reply.invocation = { invocationId: invocation.invocationId, commandId: invocation.commandId };
    return reply;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "rmx menu bridge failure" };
  }
}

export async function listMenuCommands(tabId: number): Promise<MenuCommandSummary[]> {
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || !/^https?:/.test(tab.url) || urlPaused(tab.url, await readPausedSites())) return [];
  await reconcileMenuCommands();
  return Object.values((await readState()).commands)
    .filter((command) => command.tabId === tabId && command.url === tab.url)
    .sort((a, b) => a.registeredAt - b.registeredAt || a.label.localeCompare(b.label))
    .map(({ registrationId, remixletId, commandId, label }) => ({ registrationId, remixletId, commandId, label }));
}

export async function enqueueMenuInvocation(tabId: number, registrationId: string): Promise<boolean> {
  let queued = false;
  let key: string | undefined;
  await mutateState(async (state) => {
    const command = state.commands[registrationId];
    if (!command || command.tabId !== tabId) return;
    const tab = await ext.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url || tab.url !== command.url) {
      delete state.commands[registrationId];
      return;
    }
    key = contextKey(command);
    state.queues[key] = [
      ...(state.queues[key] ?? []),
      { invocationId: crypto.randomUUID(), commandId: command.commandId, createdAt: Date.now() },
    ];
    queued = true;
  });
  if (key) wakeContext(key);
  return queued;
}

export async function clearMenuCommandsForRemixlet(remixletId: string): Promise<void> {
  await clearCommands((command) => command.remixletId === remixletId);
}

export async function clearMenuCommandsForTab(tabId: number): Promise<void> {
  await clearCommands((command) => command.tabId === tabId);
}

/**
 * Drop the commands a pause silences: those registered on a paused site's
 * pages, plus every command of a remixlet the pause owns outright — that
 * remixlet's commands on its OTHER hosts die with it.
 */
export async function clearMenuCommandsForPausedSites(pausedSiteKeys: readonly string[]): Promise<void> {
  const live = new Map((await readMirror()).map((remixlet) => [remixlet.id, remixlet]));
  await clearCommands((command) => {
    const owner = live.get(command.remixletId);
    return (
      urlPaused(command.url, pausedSiteKeys) ||
      (owner !== undefined && matchesPaused(owner.matches, pausedSiteKeys))
    );
  });
}

/** Remove registrations whose owning live remixlet/tab/site no longer exists. */
export async function reconcileMenuCommands(): Promise<void> {
  const [mirror, pausedSites, state] = await Promise.all([readMirror(), readPausedSites(), readState()]);
  // The facts gathered here (which tabs exist, which grants are live) describe
  // THIS snapshot's commands, and clearCommands' verdict runs later, behind
  // the serialized mutation chain, against whatever the state holds by then. A
  // command registered in between is absent from these maps, and absence reads
  // as "tab closed" / "grant revoked" — so judging it here deleted brand-new
  // registrations moments after they stored (the menu harness suite caught
  // this racing its menu.list polling against page-load registration; nothing
  // re-announces, so the command stayed lost for the document's life —
  // wiki/design/menu-reconcile-race.md). Judge only the commands this snapshot
  // actually gathered facts for; anything newer keeps until the next
  // reconcile, which will have gathered its own.
  const snapshotIds = new Set(Object.keys(state.commands));
  const live = new Map(mirror.map((remixlet) => [remixlet.id, remixlet]));
  const tabIds = [...new Set(Object.values(state.commands).map((command) => command.tabId))];
  const tabs = new Map(
    await Promise.all(
      tabIds.map(async (tabId) => [tabId, await ext.tabs.get(tabId).catch(() => undefined)] as const),
    ),
  );
  const granted = new Map(
    await Promise.all(
      [...new Set(Object.values(state.commands).map((command) => command.remixletId))].map(
        async (id) => [id, await hasCapabilityGrant(id, "menu")] as const,
      ),
    ),
  );
  await clearCommands((command) => {
    if (!snapshotIds.has(command.registrationId)) return false;
    const owner = live.get(command.remixletId);
    const tab = tabs.get(command.tabId);
    return (
      !owner ||
      !owner.capabilities.includes("menu") ||
      !granted.get(command.remixletId) ||
      !tab?.url ||
      tab.url !== command.url ||
      !runsOn(owner, command.url, pausedSites)
    );
  });
}

async function authenticateContext(
  message: MenuBridgeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<MenuContext | { error: string }> {
  const remixlet = await authenticatedRemixlet(message.remixletId, message.bridgeToken);
  if (!remixlet) return { error: "unauthenticated remixlet bridge caller" };
  if (!remixlet.capabilities.includes("menu") || !(await hasCapabilityGrant(message.remixletId, "menu"))) {
    return { error: `remixlet "${message.remixletId}" does not have a granted "menu" capability` };
  }
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  const url = sender.url ?? sender.tab?.url;
  if (tabId === undefined || !documentId || !url || sender.frameId !== 0) {
    return { error: "rmx.menu is available only in a top-level authenticated tab document" };
  }
  if (pageIneligibleReason(remixlet, url, await readPausedSites()) !== undefined) {
    return { error: "rmx.menu caller is not active on this site" };
  }
  return { remixletId: message.remixletId, tabId, documentId, url };
}

function boundedString(value: MenuInput | undefined, field: string, maxLength: number): { value: string } | { error: string } {
  if (Object.prototype.toString.call(value) !== "[object String]") return { error: `${field} must be a string` };
  const text = String(value);
  if (text.length === 0) return { error: `${field} must not be empty` };
  if (text.length > maxLength) return { error: `${field} must be at most ${maxLength} characters` };
  return { value: text };
}

function contextKey(context: Pick<MenuContext, "tabId" | "documentId" | "remixletId">): string {
  return JSON.stringify([context.tabId, context.documentId, context.remixletId]);
}

function hasContextCommands(state: MenuState, context: MenuContext): boolean {
  return Object.values(state.commands).some(
    (command) =>
      command.tabId === context.tabId &&
      command.documentId === context.documentId &&
      command.remixletId === context.remixletId,
  );
}

function removeQueuedCommand(state: MenuState, key: string, commandId: string): void {
  state.queues[key] = (state.queues[key] ?? []).filter((invocation) => invocation.commandId !== commandId);
  if (state.queues[key].length === 0) delete state.queues[key];
}

async function readState(): Promise<MenuState> {
  const stored = await ext.storage.session.get(MENU_STATE_KEY);
  // SAFETY: this worker is the sole writer of MENU_STATE_KEY and always stores MenuState.
  return (stored[MENU_STATE_KEY] as MenuState | undefined) ?? { commands: {}, queues: {} };
}

async function mutateState(mutator: (state: MenuState) => void | Promise<void>): Promise<void> {
  const operation = mutationTail.then(async () => {
    const state = await readState();
    await mutator(state);
    await ext.storage.session.set({ [MENU_STATE_KEY]: state });
  });
  mutationTail = operation.catch(() => {});
  await operation;
}

async function clearCommands(predicate: (command: StoredCommand) => boolean): Promise<void> {
  const wake = new Set<string>();
  await mutateState((state) => {
    for (const command of Object.values(state.commands)) {
      if (!predicate(command)) continue;
      const key = contextKey(command);
      wake.add(key);
      delete state.commands[command.registrationId];
    }
    const activeContexts = new Set(Object.values(state.commands).map(contextKey));
    for (const key of Object.keys(state.queues)) {
      if (!activeContexts.has(key)) delete state.queues[key];
    }
  });
  for (const key of wake) wakeContext(key);
}

function changedOrTimeout(key: string): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(key) ?? new Set();
    waiters.set(key, set);
    const wake = (): void => {
      clearTimeout(timer);
      set.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, POLL_TIMEOUT_MS);
    set.add(wake);
  });
}

function wakeContext(key: string): void {
  for (const wake of waiters.get(key) ?? []) wake();
  waiters.delete(key);
}
