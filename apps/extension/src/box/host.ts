// The box host: the offscreen document's half of the mediated execution
// runtime (wiki/design/mediated-execution.md, "Host" row and Lifecycle 3-6).
// One page agent port per document, one sandbox iframe per (document,
// remixlet); the host relays `dom.*` traffic between the two untouched and
// turns the box's `rmx.call` into the worker's authenticated bridge message,
// attaching the bridge token it alone holds. Pure logic over injected seams
// (createIframe, resolve, bridge) so tests can drive it with fakes; the real
// wiring is platform/offscreen.ts, and the DOM
// iframe factory below is the only piece that touches a document.
//
// Nothing here is authoritative: the mirror (storage) decides what runs, the
// worker answers every resolve from it, and a port disconnect or a
// `box.refresh` rebuilds this host's picture from those answers. The offscreen
// document may die and be recreated without losing anything a page cannot
// re-establish by reconnecting.

import {
  type AgentPortMessage,
  type BoxBridgeMessage,
  type BoxRemixletSpec,
  type BoxRmxResult,
  type BoxRunMessage,
  type BoxToHost,
  type DomConfigureMessage,
  type HostToAgentEnvelope,
  type HostToBox,
} from "./protocol.js";

/** The worker's BridgeReply as the box sees it. */
export type BoxBridgeReply = BoxRmxResult["reply"];

/** What runtime.connect's port.sender told the host about the page. */
export interface AgentPortSender {
  tabId: number;
  frameId: number;
  url: string;
  documentId?: string;
}

/** The page agent's port, abstracted from chrome.runtime.Port. */
export interface AgentPort {
  sender: AgentPortSender;
  post(message: HostToAgentEnvelope): void;
  onMessage(listener: (message: AgentPortMessage) => void): void;
  onDisconnect(listener: () => void): void;
}

/** One sandbox iframe, abstracted: post into it, hear from it, remove it. */
export interface BoxFrame {
  post(message: HostToBox): void;
  /** Delivers messages from THIS frame only (the factory checks the source). */
  onMessage(listener: (message: BoxToHost) => void): void;
  remove(): void;
}

export interface BoxHostDependencies {
  createIframe(remixletId: string): BoxFrame;
  /** The worker's `box.resolve` answer for a page (empty when nothing should run). */
  resolve(tabId: number, frameId: number, url: string): Promise<BoxRemixletSpec[]>;
  /** The worker's `box.bridge` lane; resolves with its BridgeReply verbatim. */
  bridge(message: BoxBridgeMessage): Promise<BoxBridgeReply>;
  onLog?(message: string): void;
}

export interface BoxHost {
  /** A page agent connected; resolve its remixlets and start their boxes. */
  acceptPort(port: AgentPort): void;
  /** The worker's `box.refresh`: re-resolve every live page, drop unwanted boxes. */
  refresh(): Promise<void>;
  /** Live (document, remixlet) pairs, for tests and diagnostics. */
  liveBoxes(): { tabId: number; frameId: number; remixletId: string }[];
}

interface LiveBox {
  spec: BoxRemixletSpec;
  frame: BoxFrame;
  started: boolean;
}

interface LiveDocument {
  port: AgentPort;
  /** Follows page.navigation notices, so later rmx.* calls carry the current page. */
  url: string;
  boxes: Map<string, LiveBox>;
  closed: boolean;
  /** Serialises the initial resolve and refreshes for this document. */
  chain: Promise<void>;
}

export function createBoxHost(deps: BoxHostDependencies): BoxHost {
  const documents = new Set<LiveDocument>();
  const log = deps.onLog ?? (() => {});

  function acceptPort(port: AgentPort): void {
    const doc: LiveDocument = {
      port,
      url: port.sender.url,
      boxes: new Map(),
      closed: false,
      chain: Promise.resolve(),
    };
    documents.add(doc);
    port.onMessage((message) => routeAgentMessage(doc, message));
    port.onDisconnect(() => closeDocument(doc));
    enqueue(doc, async () => {
      const specs = await resolveFor(doc);
      if (doc.closed) return;
      for (const spec of specs) {
        if (!doc.boxes.has(spec.id)) startBox(doc, spec);
      }
    });
  }

  async function refresh(): Promise<void> {
    await Promise.all(
      [...documents].map((doc) =>
        enqueue(doc, async () => {
          const specs = await resolveFor(doc);
          if (doc.closed) return;
          const wanted = new Map(specs.map((spec) => [spec.id, spec]));
          for (const [remixletId, box] of doc.boxes) {
            const next = wanted.get(remixletId);
            if (next && sameSpec(box.spec, next)) continue;
            // New boxes do not start in an existing document, but every box
            // that stopped being current must revoke its page-agent state.
            // This covers disable, pause, removal, replacement and a failed
            // mirror rebuild without relying on a tab reload.
            dropBox(doc, box);
          }
        }),
      ),
    );
  }

  function enqueue(doc: LiveDocument, work: () => Promise<void>): Promise<void> {
    doc.chain = doc.chain.then(work, work).catch((error) => log(`box host: ${String(error)}`));
    return doc.chain;
  }

  async function resolveFor(doc: LiveDocument): Promise<BoxRemixletSpec[]> {
    try {
      return await deps.resolve(doc.port.sender.tabId, doc.port.sender.frameId, doc.url);
    } catch (error) {
      log(`box host: resolve failed for ${doc.url}: ${String(error)}`);
      return [];
    }
  }

  function startBox(doc: LiveDocument, spec: BoxRemixletSpec): LiveBox {
    const frame = deps.createIframe(spec.id);
    const box: LiveBox = { spec, frame, started: false };
    doc.boxes.set(spec.id, box);
    frame.onMessage((message) => routeBoxMessage(doc, box, message));
    return box;
  }

  /**
   * Remove one box and, while the document is still there, send the agent
   * `dom.drop` so it forgets the box's handles, listeners and observers. A
   * closed document needs no notice: its agent port is gone with it.
   */
  function dropBox(doc: LiveDocument, box: LiveBox): void {
    if (doc.boxes.get(box.spec.id) !== box) return;
    doc.boxes.delete(box.spec.id);
    box.frame.remove();
    if (!doc.closed) {
      try {
        doc.port.post({ remixletId: box.spec.id, payload: { kind: "dom.drop" } });
      } catch (error) {
        log(`box host: cleanup notice failed for ${box.spec.id}: ${String(error)}`);
      }
    }
  }

  function routeBoxMessage(doc: LiveDocument, box: LiveBox, message: BoxToHost): void {
    if (doc.closed || doc.boxes.get(box.spec.id) !== box) return;
    switch (message.kind) {
      case "box.ready": {
        // Configure the agent BEFORE the box runs, so the first dom.call finds
        // its policy (matches) and relay filter (observe patterns) in place. A second ready from
        // the same frame (a reload inside the sandbox) does not rerun.
        if (box.started) return;
        box.started = true;
        const configure: DomConfigureMessage = {
          kind: "dom.configure",
          matches: box.spec.matches,
          grantedHosts: box.spec.grantedHosts,
          observePatterns: box.spec.observePatterns,
        };
        try {
          doc.port.post({ remixletId: box.spec.id, payload: configure });
          const run: BoxRunMessage = {
            kind: "box.run",
            remixletId: box.spec.id,
            runAt: box.spec.runAt,
            matches: box.spec.matches,
            capabilities: box.spec.capabilities,
            files: box.spec.files,
            url: doc.url,
          };
          box.frame.post(run);
        } catch (error) {
          log(`box host: start failed for ${box.spec.id}: ${String(error)}`);
          dropBox(doc, box);
        }
        return;
      }
      case "dom.call":
      case "dom.settled":
        doc.port.post({ remixletId: box.spec.id, payload: message });
        return;
      case "rmx.call": {
        // The one place the bridge token is attached; it rides only towards
        // the worker, never back into the iframe or out to the agent.
        const { tabId, frameId, documentId } = doc.port.sender;
        const request: BoxBridgeMessage = {
          kind: "box.bridge",
          remixletId: box.spec.id,
          bridgeToken: box.spec.bridgeToken,
          pageUrl: doc.url,
          page: documentId === undefined ? { tabId, frameId } : { tabId, frameId, documentId },
          message: message.message,
        };
        void deps
          .bridge(request)
          .then(
            (reply) => reply ?? { ok: false, error: "the worker did not answer" },
            (error) => ({ ok: false, error: String(error) }),
          )
          .then((reply) => {
            if (doc.closed || doc.boxes.get(box.spec.id) !== box) return;
            box.frame.post({ kind: "rmx.result", id: message.id, reply });
          });
        return;
      }
    }
  }

  function routeAgentMessage(doc: LiveDocument, message: AgentPortMessage): void {
    if (doc.closed) return;
    // Page-level notices (no remixletId) fan out to every running box of the document.
    if ("kind" in message && (message.kind === "page.navigation" || message.kind === "page.facts")) {
      if (message.kind === "page.navigation") doc.url = message.url;
      for (const box of doc.boxes.values()) {
        if (box.started) box.frame.post(message);
      }
      return;
    }
    if (!("remixletId" in message)) return;
    const box = doc.boxes.get(message.remixletId);
    if (!box) return;
    box.frame.post(message.payload);
  }

  function closeDocument(doc: LiveDocument): void {
    if (doc.closed) return;
    doc.closed = true;
    documents.delete(doc);
    for (const box of Array.from(doc.boxes.values())) dropBox(doc, box);
    doc.boxes.clear();
  }

  function liveBoxes(): { tabId: number; frameId: number; remixletId: string }[] {
    const live: { tabId: number; frameId: number; remixletId: string }[] = [];
    for (const doc of documents) {
      for (const remixletId of doc.boxes.keys()) {
        live.push({ tabId: doc.port.sender.tabId, frameId: doc.port.sender.frameId, remixletId });
      }
    }
    return live;
  }

  return { acceptPort, refresh, liveBoxes };
}

/** Whether a live frame still represents the worker's current mirror entry. */
function sameSpec(left: BoxRemixletSpec, right: BoxRemixletSpec): boolean {
  return (
    left.id === right.id &&
    left.bridgeToken === right.bridgeToken &&
    left.runAt === right.runAt &&
    sameStrings(left.matches, right.matches) &&
    sameStrings(left.capabilities, right.capabilities) &&
    sameStrings(left.grantedHosts, right.grantedHosts) &&
    sameStrings(left.observePatterns, right.observePatterns) &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file.name === right.files[index]?.name && file.code === right.files[index]?.code)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------------------
// The real iframe factory (DOM only, no extension APIs).

export interface SandboxFrameFactoryOptions {
  /** Where the iframes are appended (the offscreen document's body). */
  container: HTMLElement;
  /** URL of the sandboxed page (BOX_PAGE_PATH, resolved by the caller). */
  src: string;
  /** The window whose `message` events carry the frames' posts. */
  window: Window;
}

/**
 * Builds sandbox iframes for createBoxHost. `sandbox="allow-scripts"` on the
 * element is belt and braces over the manifest's sandbox CSP: either alone
 * confines the frame to a null origin with no page handle. Each frame's
 * messages are recognised by `event.source === iframe.contentWindow` — the
 * only identity a null-origin frame has — so one box can never speak for
 * another.
 */
export function sandboxFrameFactory(options: SandboxFrameFactoryOptions): (remixletId: string) => BoxFrame {
  return (remixletId) => {
    const iframe = options.container.ownerDocument.createElement("iframe");
    // Order matters: the sandbox flags must be set before the navigation starts.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.dataset["remixletId"] = remixletId;
    iframe.hidden = true;
    iframe.src = options.src;
    const listeners: ((message: BoxToHost) => void)[] = [];
    const onMessage = (event: MessageEvent): void => {
      if (iframe.contentWindow === null || event.source !== iframe.contentWindow) return;
      // Source-checked above: only the box runtime in this frame can post
      // here, and it posts BoxToHost shapes; a stray non-message is dropped.
      const message: BoxToHost = event.data;
      if (!isRecord(message) || !isString(message.kind)) return;
      for (const listener of listeners) listener(message);
    };
    options.window.addEventListener("message", onMessage);
    options.container.appendChild(iframe);
    return {
      post(message) {
        // "*": the frame's origin is opaque, so no concrete origin can name it.
        iframe.contentWindow?.postMessage(message, "*");
      },
      onMessage(listener) {
        listeners.push(listener);
      },
      remove() {
        options.window.removeEventListener("message", onMessage);
        listeners.length = 0;
        iframe.remove();
      },
    };
  };
}

function isRecord<Value>(value: Value): value is Value & object {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString<Value>(value: Value): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]";
}
