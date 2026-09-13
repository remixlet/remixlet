// Worker glue for the mediated execution runtime (wiki/design/mediated-
// execution.md, "Worker glue" row): brokers the page agent's hello, answers
// the offscreen host's resolve with the mirror's specs (bridge tokens
// included — only the offscreen document may ask), forwards the host's
// rmx.* calls into the existing bridge with the page URL as the sender the
// pause and provenance gate reads, broadcasts refreshes after mirror writes,
// and relays SPA navigation hints to page agents. Stateless: every answer is
// computed from storage (the mirror, the pause list) at the moment it is
// asked, so a worker death between two messages changes nothing.

import { ext } from "../platform/ext.js";
import { ensureOffscreenDocument, offscreenDocumentAvailable, offscreenDocumentUrl } from "../platform/offscreen-document.js";
import type {
  AgentHelloMessage,
  AgentHelloReply,
  AgentNavigationHint,
  AgentSettleReply,
  AgentSettleRequest,
  BoxBridgeMessage,
  BoxBridgePage,
  BoxRefreshMessage,
  BoxRemixletSpec,
  BoxResolveMessage,
  BoxResolveReply,
} from "../box/protocol.js";
import { runsOn } from "../shared/eligibility.js";
import { urlGrantedHostPatterns } from "../shared/fetch-capability.js";
import { originWidePatterns } from "../shared/site-key.js";
import { handleBridgeMessage, isBridgeMessage, type BridgeReply } from "./bridge.js";
import { readMirror, type ActiveRemixlet } from "./injection.js";
import { readPausedSites } from "./site-pause.js";

/**
 * The mirror entries that should run on `url`: boxed code (a remixlet with
 * only styles has no box), matched on ORIGIN-WIDE grounds — the registration
 * was origin-wide for SPA reasons and the box applies the manifest's real
 * matches as the URL changes — and not paused (the pause owns the remixlet
 * across every host it claims, and the page's own site may be paused).
 */
async function boxedRemixletsFor(url: string): Promise<ActiveRemixlet[]> {
  const pausedSites = await readPausedSites();
  return (await readMirror()).filter((remixlet) => {
    if (remixlet.js.length === 0) return false;
    const originWide = { id: remixlet.id, matches: originWidePatterns(remixlet.matches) };
    return runsOn(originWide, url, pausedSites);
  });
}

/**
 * The click rights the typed `click_element` probe runs with on `url`: the
 * union of the `matches` and the `fetch:`-derived granted host patterns of
 * every boxed remixlet that runs on that page. The agent verifying a remixlet
 * gets exactly that remixlet's click rights, no more
 * (wiki/ops/2026-09-12-security-review-plan.md, F3), and a page with no boxed
 * remixlet yields two empty lists, so only same-origin clicks pass. The worker
 * computes this; the model never supplies it (worker/index.ts
 * clickProbeParams).
 */
export async function clickRightsFor(url: string): Promise<{ matches: string[]; grantedHosts: string[] }> {
  const matches: string[] = [];
  const grantedHosts: string[] = [];
  for (const remixlet of await boxedRemixletsFor(url)) {
    for (const pattern of remixlet.matches) if (!matches.includes(pattern)) matches.push(pattern);
    for (const pattern of urlGrantedHostPatterns(remixlet.capabilities ?? [])) {
      if (!grantedHosts.includes(pattern)) grantedHosts.push(pattern);
    }
  }
  return { matches, grantedHosts };
}

/** The page's URL as the browser attests it; the message's own claim is the fallback. */
function pageUrlOf(sender: chrome.runtime.MessageSender, claimed: string): string {
  return sender.url ?? claimed;
}

/**
 * `agent.hello` from a page agent (a content script, so sender.tab is set).
 * Counts what should run, makes sure the host exists, and answers; zero means
 * the agent never opens a port.
 */
export async function handleAgentHello(
  message: AgentHelloMessage,
  sender: chrome.runtime.MessageSender,
): Promise<AgentHelloReply> {
  const quiet: AgentHelloReply = { kind: "agent.ready", remixletCount: 0, observeHosts: [] };
  if (sender.id !== ext.runtime.id || sender.tab?.id === undefined) return quiet;
  const remixlets = await boxedRemixletsFor(pageUrlOf(sender, message.url));
  if (remixlets.length === 0) return quiet;
  try {
    await ensureOffscreenDocument();
  } catch (error) {
    console.warn("[remixlet] box host unavailable", error);
    return quiet;
  }
  const observeHosts: string[] = [];
  for (const remixlet of remixlets) {
    for (const pattern of remixlet.networkObserve ?? []) {
      if (!observeHosts.includes(pattern)) observeHosts.push(pattern);
    }
  }
  return { kind: "agent.ready", remixletCount: remixlets.length, observeHosts };
}

/** Only the extension's own offscreen document may resolve specs or forward bridge calls. */
function isOffscreenDocument(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === ext.runtime.id && sender.tab === undefined && sender.url === offscreenDocumentUrl();
}

/**
 * `box.resolve` from the host: the full specs, bridge tokens included. The
 * sender check is the whole security of the token: a page (content script)
 * asking gets nothing.
 */
export async function handleBoxResolve(
  message: BoxResolveMessage,
  sender: chrome.runtime.MessageSender,
): Promise<BoxResolveReply> {
  if (!isOffscreenDocument(sender)) return { kind: "box.resolved", remixlets: [] };
  const remixlets = await boxedRemixletsFor(message.url);
  return {
    kind: "box.resolved",
    remixlets: remixlets.map((remixlet): BoxRemixletSpec => {
      return {
        id: remixlet.id,
        matches: remixlet.matches,
        files: remixlet.js.map((script) => ({ name: script.file, code: script.code })),
        capabilities: remixlet.capabilities,
        bridgeToken: remixlet.bridgeToken,
        // `fetch:` grants only: watching a host's responses (network:observe:)
        // is not permission to make new requests to it, so an observe grant
        // reaches the agent as an observePattern and admits no URL.
        grantedHosts: urlGrantedHostPatterns(remixlet.capabilities ?? []),
        // Empty for a remixlet without a network:observe grant: the agent then
        // forwards it nothing from the relay.
        observePatterns: remixlet.networkObserve ?? [],
        // The box runs its files together, so the first file's runAt speaks for all of them.
        runAt: remixlet.js[0]?.runAt ?? "document_idle",
      };
    }),
  };
}

/**
 * `box.bridge` from the host: the box's rmx.* call, re-enveloped for the
 * existing bridge. The synthetic sender carries the page's URL so the pause
 * and provenance gate (worker/bridge.ts) judges the page, not the offscreen
 * document that relayed the call, and the page's tab, frame and document so
 * the lanes bound to a tab document (rmx.menu) see the page the agent's port
 * attested to the host.
 */
export async function handleBoxBridge(
  message: BoxBridgeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<BridgeReply> {
  if (!isOffscreenDocument(sender)) return { ok: false, error: "box bridge calls are accepted only from the box host" };
  const enveloped = { ...message.message, remixletId: message.remixletId, bridgeToken: message.bridgeToken };
  if (!isBridgeMessage(enveloped)) return { ok: false, error: `unknown rmx bridge call ${String(message.message.kind)}` };
  if (enveloped.kind === "rmx.run" && isBoxBridgePage(message.page)) noteBoxRun(message.remixletId, message.page.tabId);
  return handleBridgeMessage(enveloped, pageSenderFor(message));
}

// ---------------------------------------------------------------------------
// "Has the box run yet?" — what an activation's tab reload waits on.
//
// A remixlet's code starts some time after the reloaded page's document_idle
// (agent hello, host connect, iframe load), so "the tab reloaded with it
// live" would be false for a moment, and a verification fired right after
// the write would judge a page the remixlet had not touched yet. The run ping
// every box sends once per activation (box/runtime.ts) is the moment it went
// live; noted here per (remixlet, tab), in memory: a worker death between the
// reload and the ping only makes the wait time out, and the reply it was for
// died with the worker anyway.

const boxRuns = new Map<string, number>();
const boxRunWaiters = new Set<() => void>();

function boxRunKey(remixletId: string, tabId: number): string {
  return `${tabId}\n${remixletId}`;
}

function noteBoxRun(remixletId: string, tabId: number): void {
  boxRuns.set(boxRunKey(remixletId, tabId), Date.now());
  for (const wake of Array.from(boxRunWaiters)) wake();
}

/**
 * Wait until every box on the tab's top document is idle (protocol.ts
 * AgentSettleRequest; wiki/design/mediated-execution.md §The settle
 * handshake). Undefined when no page agent answered: nothing runs there, so
 * there is nothing to wait for. Bounded by the agent's own budget.
 */
export async function settleTab(tabId: number): Promise<AgentSettleReply | undefined> {
  const request: AgentSettleRequest = { kind: "agent.settle" };
  // SAFETY: page-agent-content.ts answers agent.settle with an AgentSettleReply; undefined when no agent listened.
  const reply = (await ext.tabs.sendMessage(tabId, request, { frameId: 0 }).catch(() => undefined)) as AgentSettleReply | undefined;
  return reply?.kind === "agent.settled" ? reply : undefined;
}

/**
 * Resolve once the remixlet's box has pinged its run from `tabId` at or after
 * `since` (a Date.now() taken before the reload), or after `timeoutMs`: true
 * when the run was seen, false on the timeout.
 */
export function waitForBoxRun(remixletId: string, tabId: number, since: number, timeoutMs: number): Promise<boolean> {
  const key = boxRunKey(remixletId, tabId);
  const ran = (): boolean => (boxRuns.get(key) ?? 0) >= since;
  if (ran()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (outcome: boolean): void => {
      clearTimeout(timer);
      boxRunWaiters.delete(wake);
      resolve(outcome);
    };
    const wake = (): void => {
      if (ran()) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    boxRunWaiters.add(wake);
  });
}

/**
 * The synthetic sender for a box's bridge call: the page's URL, plus its tab
 * document when the host supplied one (a call missing it, which no host
 * sends, still reaches the URL-only lanes and is refused by the tab-bound
 * ones exactly as an extension page's call would be).
 */
function pageSenderFor(message: BoxBridgeMessage): chrome.runtime.MessageSender {
  const page = isBoxBridgePage(message.page) ? message.page : undefined;
  if (page === undefined) {
    // SAFETY: the bridge reads only url (and tab.url) off a tabless sender; the page's URL is what it must judge.
    return { url: message.pageUrl } as chrome.runtime.MessageSender;
  }
  // SAFETY: the bridge reads only id and url off the sender's tab; both are the page's, as the host
  // copied them from the agent port's browser-attested sender.
  const tab = { id: page.tabId, url: message.pageUrl } as chrome.tabs.Tab;
  const sender: chrome.runtime.MessageSender = { url: message.pageUrl, tab, frameId: page.frameId };
  if (page.documentId !== undefined) sender.documentId = page.documentId;
  return sender;
}

function isBoxBridgePage(value: BoxBridgeMessage["page"] | undefined): value is BoxBridgePage {
  return (
    value instanceof Object &&
    Number.isInteger(value.tabId) &&
    Number.isInteger(value.frameId) &&
    (value.documentId === undefined || Object.prototype.toString.call(value.documentId) === "[object String]")
  );
}

/** The three message kinds this module answers on the worker's runtime.onMessage. */
export type BoxWorkerMessage = AgentHelloMessage | BoxResolveMessage | BoxBridgeMessage;
export type BoxWorkerReply = AgentHelloReply | BoxResolveReply | BridgeReply;

export function isBoxWorkerMessage<Message extends { kind?: unknown }>(message: Message): message is Message & BoxWorkerMessage {
  return message.kind === "agent.hello" || message.kind === "box.resolve" || message.kind === "box.bridge";
}

/** Dispatch for worker/index.ts; every reply is unstamped (no panel is listening). */
export function handleBoxWorkerMessage(message: BoxWorkerMessage, sender: chrome.runtime.MessageSender): Promise<BoxWorkerReply> {
  switch (message.kind) {
    case "agent.hello":
      return handleAgentHello(message, sender);
    case "box.resolve":
      return handleBoxResolve(message, sender);
    case "box.bridge":
      return handleBoxBridge(message, sender);
  }
}

/**
 * After every mirror write or pause change: the host re-resolves each live
 * page and tears down boxes no longer wanted. No host (no offscreen document
 * yet, or no listener) is not an error.
 */
export async function broadcastBoxRefresh(): Promise<void> {
  if (!offscreenDocumentAvailable()) return;
  const message: BoxRefreshMessage = { kind: "box.refresh" };
  await ext.runtime.sendMessage(message).catch(() => {});
}

/**
 * Client-side navigations (history.pushState, hash changes) never re-run a
 * content script; the page agent is told so it can re-read location.href and
 * notify its boxes. A frame with no agent simply has no listener.
 */
export function installNavigationHints(): void {
  const hint = (details: { tabId: number; frameId: number }): void => {
    const message: AgentNavigationHint = { kind: "agent.navigation" };
    void ext.tabs.sendMessage(details.tabId, message, { frameId: details.frameId }).catch(() => {});
  };
  ext.webNavigation.onHistoryStateUpdated.addListener(hint);
  ext.webNavigation.onReferenceFragmentUpdated.addListener(hint);
}
