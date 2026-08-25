// Content script hosting the in-page "drawer" — the panel fallback for
// Chromium browsers (notably Arc) whose sidePanel.open silently no-ops.
// panel-surface.ts injects it (bundled as drawer-host.js) into the target
// tab's ISOLATED world. The host owns only layout chrome: a
// closed-shadow-root shell whose MutationObservers re-attach and re-repair
// it if the page removes or restyles it. All application state lives in a
// cross-origin chrome-extension iframe the page cannot inspect or style.

const DRAWER_MESSAGE = "remixlet.drawer.open";
const DRAWER_VISIBILITY_MESSAGE = "remixlet.drawer.visibility";
const DRAWER_CLOSE_MESSAGE = "remixlet.drawer.close";
const DRAWER_HOST_ID = "remixlet-extension-drawer";

interface DrawerHostState {
  open(panelUrl: string): void;
  setVisible(visible: boolean): void;
  close(): void;
}

type DrawerGlobal = typeof globalThis & {
  __remixletDrawerHost?: DrawerHostState;
};

function installDrawerHost(): DrawerHostState {
  let host: HTMLDivElement | undefined;
  let iframe: HTMLIFrameElement | undefined;
  let observer: MutationObserver | undefined;
  let hostObserver: MutationObserver | undefined;
  let open = false;
  let visible = true;

  function repairHost(): void {
    if (!host) return;
    const styles = {
      all: "initial",
      position: "fixed",
      inset: "8px 8px 8px auto",
      width: "min(420px, calc(100vw - 16px))",
      height: "calc(100vh - 16px)",
      "z-index": "2147483647",
      display: "block",
      isolation: "isolate",
      contain: "layout style paint",
      "color-scheme": "light dark",
      "--remixlet-drawer-visibility": visible ? "visible" : "hidden",
      "--remixlet-drawer-pointer-events": visible ? "auto" : "none",
    };
    for (const [property, value] of Object.entries(styles)) {
      if (host.style.getPropertyValue(property) !== value || host.style.getPropertyPriority(property) !== "important") {
        host.style.setProperty(property, value, "important");
      }
    }
    if (host.id !== DRAWER_HOST_ID) host.id = DRAWER_HOST_ID;
    host.hidden = false;
    host.removeAttribute("inert");
    host.removeAttribute("aria-hidden");
  }

  function repairObservedHost(): void {
    hostObserver?.disconnect();
    repairHost();
    if (open && host && hostObserver) {
      hostObserver.observe(host, {
        attributes: true,
        attributeFilter: ["id", "style", "hidden", "inert", "aria-hidden"],
      });
    }
  }

  function attach(): void {
    if (!open || !host) return;
    repairObservedHost();
    if (!host.isConnected) document.documentElement.append(host);
  }

  function close(): void {
    open = false;
    observer?.disconnect();
    observer = undefined;
    hostObserver?.disconnect();
    hostObserver = undefined;
    host?.remove();
    void chrome.runtime.sendMessage({ kind: "drawer.closed" }).catch(() => {});
  }

  function create(panelUrl: string): void {
    host = document.createElement("div");
    host.id = DRAWER_HOST_ID;
    host.dataset.remixletDrawer = "loading";
    repairHost();

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        inset: 8px 8px 8px auto !important;
        width: min(420px, calc(100vw - 16px)) !important;
        height: calc(100vh - 16px) !important;
        z-index: 2147483647 !important;
        display: block !important;
        isolation: isolate !important;
        contain: layout style paint !important;
        color-scheme: light dark !important;
        visibility: var(--remixlet-drawer-visibility, visible) !important;
        pointer-events: var(--remixlet-drawer-pointer-events, auto) !important;
      }
      .shell {
        box-sizing: border-box;
        display: grid;
        grid-template-rows: minmax(0, 1fr);
        width: 100%;
        height: 100%;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
        border-radius: 14px;
        background: Canvas;
        box-shadow: 0 18px 55px rgb(0 0 0 / 28%);
      }
      iframe {
        all: unset;
        box-sizing: border-box;
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
    `;

    const shell = document.createElement("section");
    shell.className = "shell";
    shell.setAttribute("aria-label", "Remixlet drawer");

    iframe = document.createElement("iframe");
    iframe.title = "Remixlet chat";
    iframe.referrerPolicy = "no-referrer";
    iframe.addEventListener("load", () => {
      if (host) host.dataset.remixletDrawer = "ready";
    });
    iframe.src = panelUrl;

    shell.append(iframe);
    shadow.append(style, shell);
    open = true;
    attach();

    observer?.disconnect();
    observer = new MutationObserver(attach);
    observer.observe(document, { childList: true, subtree: true });
    hostObserver = new MutationObserver(repairObservedHost);
    repairObservedHost();
  }

  // The close control lives in the panel's own header; the cross-origin
  // iframe can only reach this host via postMessage. The page cannot forge
  // the request: it has no reference to the iframe's contentWindow (closed
  // shadow root) and cannot post from the extension origin.
  window.addEventListener("message", (event) => {
    if (!open || !iframe || event.source !== iframe.contentWindow) return;
    if (event.origin !== new URL(chrome.runtime.getURL("")).origin) return;
    // SAFETY: the source and origin checks above restrict this message to the panel iframe.
    if ((event.data as { kind?: unknown } | null)?.kind !== DRAWER_CLOSE_MESSAGE) return;
    close();
  });

  return {
    open(panelUrl: string): void {
      if (host && iframe) {
        open = true;
        if (iframe.src !== panelUrl) {
          host.dataset.remixletDrawer = "loading";
          iframe.src = panelUrl;
        }
        attach();
        return;
      }
      create(panelUrl);
    },
    setVisible(nextVisible: boolean): void {
      visible = nextVisible;
      repairObservedHost();
    },
    close,
  };
}

// SAFETY: this isolated content-script global owns the optional drawer host slot.
const drawerGlobal = globalThis as DrawerGlobal;
if (!drawerGlobal.__remixletDrawerHost) {
  drawerGlobal.__remixletDrawerHost = installDrawerHost();
  chrome.runtime.onMessage.addListener((message: DrawerMessage, _sender, sendResponse) => {
    const candidate = message;
    if (candidate?.kind === DRAWER_VISIBILITY_MESSAGE) {
      drawerGlobal.__remixletDrawerHost!.setVisible(message.visible !== false);
      sendResponse({ ok: true });
      return false;
    }
    // The worker sends this when the browser's real side panel takes over —
    // the drawer must never stay on screen next to it.
    if (candidate?.kind === DRAWER_CLOSE_MESSAGE) {
      drawerGlobal.__remixletDrawerHost!.close();
      sendResponse({ ok: true });
      return false;
    }
    // The panel WAR entry uses use_dynamic_url, so its framed URL carries a
    // rotating GUID host, not the static extension id — validate the resource
    // by parsing it (chrome-extension: scheme, the panel path, a query string)
    // rather than matching a static root. The message itself is same-extension
    // and worker-authored; this is a shape guard.
    let parsed: URL | undefined;
    try {
      parsed = isDrawerOpenMessage(candidate) ? new URL(candidate.panelUrl) : undefined;
    } catch {
      parsed = undefined;
    }
    if (
      !isDrawerOpenMessage(candidate) ||
      parsed === undefined ||
      parsed.protocol !== "chrome-extension:" ||
      parsed.pathname !== "/panel/index.html" ||
      parsed.search === ""
    ) return false;
    drawerGlobal.__remixletDrawerHost!.open(candidate.panelUrl);
    sendResponse({ ok: true });
    return false;
  });
}

interface DrawerMessage {
  kind?: string;
  panelUrl?: string;
  visible?: boolean;
}

function isDrawerOpenMessage(message: DrawerMessage): message is DrawerMessage & { kind: typeof DRAWER_MESSAGE; panelUrl: string } {
  return message.kind === DRAWER_MESSAGE && Object.prototype.toString.call(message.panelUrl) === "[object String]";
}
