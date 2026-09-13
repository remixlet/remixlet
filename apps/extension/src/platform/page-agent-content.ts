// Content-script entry for the page agent (wiki/design/mediated-execution.md
// §Parts, step 2 and 3 of the document lifecycle). Registered by the worker
// as ONE dynamic content script over the mirror's origin-wide matches, so it
// loads on every page the mirror might want; the hello handshake decides
// whether this page actually needs a box. Zero remixlets: stay quiet. Otherwise
// open the port to the offscreen host and hand it to src/box/page-agent.ts,
// which does everything else. Nothing here evaluates a string. The marker on
// globalThis makes a second load of the file a no-op, so one document never
// has two agents.
//
// The one thing that must happen synchronously, before the hello round trip:
// claiming the MAIN-world relay's per-document token off <html>
// (bridge/relay.ts claimRelayToken). Both this script and the relay run at
// document_start, ahead of any page script, in whichever order the browser
// picks; the claim handles either.

import {
  AGENT_PORT_NAME,
  type AgentHelloMessage,
  type AgentHelloReply,
  type AgentSettleReply,
  type HostToAgentEnvelope,
} from "../box/protocol.js";
import { createPageAgent, type AgentTransport, type PageAgent, type RelayStats } from "../box/page-agent.js";
import { announceRelayFilter, claimRelayToken, type RelayTokenClaim } from "../bridge/relay.js";
import { ext } from "./ext.js";

/** This world's marker; the relay fields are diagnostics the relay suite reads through CDP. */
interface PageAgentMarker {
  active: boolean;
  relayTokenHow?: ReturnType<RelayTokenClaim["how"]>;
  /** performance.now() when the host filter reached the relay: how long the ring buffered unfiltered. */
  relayFilterAtMs?: number;
  relayStats?: () => RelayStats;
}

interface PageAgentGlobal {
  __remixletPageAgent?: PageAgentMarker;
}

interface Session {
  agent: PageAgent;
  port: chrome.runtime.Port;
}

function isNumber<Value>(value: Value): value is Value & number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

async function start(marker: PageAgentMarker, relayToken: RelayTokenClaim): Promise<void> {
  if (marker.active) return;
  marker.active = true;
  let reply: AgentHelloReply | undefined;
  try {
    // SAFETY: worker/box.ts answers agent.hello with an AgentHelloReply; undefined when nothing answered.
    reply = (await ext.runtime.sendMessage({ kind: "agent.hello", url: location.href } satisfies AgentHelloMessage)) as
      | AgentHelloReply
      | undefined;
  } catch {
    marker.active = false;
    return;
  }
  const count = reply?.kind === "agent.ready" && isNumber(reply.remixletCount) ? reply.remixletCount : 0;
  // The relay buffers every host until told otherwise; tell it now, before
  // anything else, even when nothing runs here (an empty filter clears it).
  const token = relayToken.current();
  if (token !== undefined) {
    const hosts = count > 0 && Array.isArray(reply?.observeHosts) ? reply.observeHosts.map(String) : [];
    announceRelayFilter(document, token, hosts);
    marker.relayFilterAtMs = performance.now();
  }
  if (count === 0) {
    marker.active = false;
    return;
  }
  marker.active = false;
  connect(marker, relayToken);
}

/**
 * Open the port to the host and run the agent on it until the port dies.
 * False when the port could not be opened (no host listening, extension
 * reloading); the agent is then quiet again and a later connect may retry.
 */
function connect(marker: PageAgentMarker, relayToken: RelayTokenClaim): boolean {
  if (marker.active) return true;
  marker.active = true;
  let port: chrome.runtime.Port;
  try {
    port = ext.runtime.connect({ name: AGENT_PORT_NAME });
  } catch {
    marker.active = false;
    return false;
  }
  let handler: ((envelope: HostToAgentEnvelope) => void) | undefined;
  const transport: AgentTransport = {
    send(message) {
      port.postMessage(message);
    },
    onMessage(next) {
      handler = next;
    },
  };
  const agent = createPageAgent({ document, window, pageUrl: location.href, transport, relayToken: () => relayToken.current() });
  const session: Session = { agent, port };
  marker.relayStats = () => agent.relayStats();
  marker.relayTokenHow = relayToken.how();

  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    marker.active = false;
    session.agent.teardown();
    ext.runtime.onMessage.removeListener(onRuntimeMessage);
    window.removeEventListener("pagehide", end);
    try {
      session.port.disconnect();
    } catch {
      // Already gone.
    }
  };
  const onRuntimeMessage = (
    message: { kind?: unknown } | undefined,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: boolean } | AgentSettleReply) => void,
  ): boolean => {
    if (message?.kind === "agent.navigation") {
      session.agent.noteNavigation();
      sendResponse({ ok: true });
    }
    if (message?.kind === "agent.settle") {
      // Answered asynchronously once every box is idle; no session here means
      // no box on this page, and the worker reads the missing answer as that.
      void session.agent.settle().then((outcome) => sendResponse({ kind: "agent.settled", ...outcome }));
      return true;
    }
    return false;
  };

  // The host posts HostToAgentEnvelope shapes; the agent checks each one before acting on it.
  port.onMessage.addListener((message: HostToAgentEnvelope) => {
    if (!ended && handler) handler(message);
  });
  port.onDisconnect.addListener(end);
  ext.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener("pagehide", end);
  return true;
}

// SAFETY: this content script owns the marker and writes only its own session state to it.
const pageAgentGlobal = globalThis as PageAgentGlobal;
if (!pageAgentGlobal.__remixletPageAgent) {
  const marker: PageAgentMarker = { active: false };
  pageAgentGlobal.__remixletPageAgent = marker;
  const relayToken = claimRelayToken(document);
  void start(marker, relayToken);
  // A document restored from the back/forward cache comes back with its port
  // dead (pagehide ended the session); say hello again so the host re-resolves it.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void start(marker, relayToken);
  });
}
