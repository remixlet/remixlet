// Content script hosting the "Show what changed" highlight overlay: the
// worker injects it (bundled as show-changes-host.js) into the target tab's
// ISOLATED world when the user clicks the button on a "vN applied" divider,
// then sends SHOW_CHANGES_OPEN_MESSAGE carrying the remixlet's stored
// verification assertions (shared/show-changes.ts).
//
// The marks reuse the annotate overlay's visual language (numbered accent
// boxes + chips, overlay-theme.ts) so marks stay one vocabulary: "the spots
// we are talking about" — drawn by the user in annotate mode, earned by the
// remixlet's verification here. Unlike annotate mode this overlay is PASSIVE:
// no scrim, no event layer — the page stays fully interactive and only the
// top pill accepts clicks (Done dismisses; so does Escape).
//
// Honesty rules: selectors are re-resolved against the live DOM at open time.
// A selector that no longer matches anything visible is counted and named in
// the pill ("couldn't be found on this page"), and absence assertions
// (not-exists — the remixlet removed something) are reported as having
// nothing left to point at. Neither is ever silently dropped, so fewer marks
// than expected always comes with the reason.

import {
  SHOW_CHANGES_OPEN_MESSAGE,
  assertionPointable,
  describeAssertion,
  sanitizeVerifiedAssertions,
  type ShowChangesOpenPayload,
  type ShowChangesSummary,
  type VerifiedAssertion,
} from "../shared/show-changes.js";
import {
  ACCENT,
  ACCENT_INK,
  CHECK_PATHS,
  FONT,
  HALO,
  INK,
  MUTED,
  RING,
  SHADOW,
  SURFACE,
  ensureFonts,
  icon,
} from "./overlay-theme.js";

const SHOW_CHANGES_HOST_ID = "remixlet-extension-show-changes";
/** Extension-owned hosts a stored selector must never highlight. */
const EXTENSION_HOST_IDS = [SHOW_CHANGES_HOST_ID, "remixlet-extension-annotate"];
/** Padding (px) added around a matched element's rect, like annotate's snap. */
const PAD_PX = 6;
/** Boxes per mark when a count assertion targets many elements. */
const MAX_ELEMENTS_PER_MARK = 12;

/** One numbered mark: live elements plus the plain-words proof label. */
interface SpotMark {
  elements: Element[];
  label: string;
}

interface ShowChangesHostState {
  open(remixletName: string, assertions: VerifiedAssertion[]): ShowChangesSummary;
  clear(): void;
}

type ShowChangesGlobal = typeof globalThis & {
  __remixletShowChangesHost?: ShowChangesHostState;
};

interface ResolvedSpots {
  marks: SpotMark[];
  missing: number;
  unpointable: number;
}

/**
 * Re-resolve the stored assertions against the live DOM. Assertions sharing a
 * selector collapse into one mark (a control typically carries visible +
 * visible + not-clipped together — two labels, one box).
 */
function resolveSpots(assertions: VerifiedAssertion[]): ResolvedSpots {
  const groups = new Map<string, VerifiedAssertion[]>();
  for (const assertion of assertions) {
    const group = groups.get(assertion.selector) ?? [];
    group.push(assertion);
    groups.set(assertion.selector, group);
  }
  const marks: SpotMark[] = [];
  let missing = 0;
  let unpointable = 0;
  for (const [selector, group] of groups) {
    const pointable = group.filter(assertionPointable);
    if (pointable.length === 0) {
      unpointable += 1;
      continue;
    }
    let matched: Element[] = [];
    try {
      matched = [...document.querySelectorAll(selector)];
    } catch {
      // A selector the current page rejects counts as a miss below.
    }
    const visible = matched.filter((element) => {
      if (!element.isConnected) return false;
      if (EXTENSION_HOST_IDS.some((id) => element.closest(`#${id}`))) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const wantsAll = pointable.some(
      (assertion) => assertion.condition === "count-at-least" || assertion.condition === "count-equals",
    );
    const chosen = visible.slice(0, wantsAll ? MAX_ELEMENTS_PER_MARK : 1);
    if (chosen.length === 0) {
      missing += 1;
      continue;
    }
    const labels = [...new Set(pointable.map(describeAssertion))];
    marks.push({ elements: chosen, label: labels.join(" · ") });
  }
  return { marks, missing, unpointable };
}

function installShowChangesHost(): ShowChangesHostState {
  let host: HTMLDivElement | undefined;
  let observer: MutationObserver | undefined;
  let docLayer!: HTMLDivElement;
  let marksLayer!: HTMLDivElement;
  let marks: SpotMark[] = [];

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function syncScroll(): void {
    docLayer.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
  }

  /** Boxes measure their live elements — a reflow or scroll re-fits them. */
  function renderMarks(): void {
    marksLayer.replaceChildren();
    marks.forEach((mark, index) => {
      mark.elements.forEach((live, elementIndex) => {
        if (!live.isConnected) return;
        const rect = live.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = rect.left + scrollX - PAD_PX;
        const y = rect.top + scrollY - PAD_PX;
        const box = element("div", "mark-box");
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${rect.width + 2 * PAD_PX}px`;
        box.style.height = `${rect.height + 2 * PAD_PX}px`;
        marksLayer.append(box);
        if (elementIndex === 0) {
          const chip = element("div", "mark-chip");
          chip.style.left = `${x - 4}px`;
          chip.style.top = `${y - 13}px`;
          const number = element("span", "chip-number");
          number.textContent = String(index + 1);
          const note = element("span", "chip-note");
          note.textContent = mark.label;
          chip.append(number, note);
          marksLayer.append(chip);
        }
      });
    });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    teardown();
  }

  function onScroll(): void {
    syncScroll();
  }

  function onResize(): void {
    renderMarks();
  }

  function teardown(): void {
    observer?.disconnect();
    observer = undefined;
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("resize", onResize);
    host?.remove();
    host = undefined;
    marks = [];
  }

  function attach(): void {
    if (host && !host.isConnected) document.documentElement.append(host);
  }

  function create(remixletName: string, resolved: ResolvedSpots): void {
    ensureFonts();
    host = document.createElement("div");
    host.id = SHOW_CHANGES_HOST_ID;
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        display: block !important;
        pointer-events: none !important;
        color-scheme: dark !important;
      }
      * { box-sizing: border-box; }
      button { all: unset; box-sizing: border-box; cursor: pointer; font-family: ${FONT}; }
      .doc-layer {
        position: fixed; left: 0; top: 0; width: 0; height: 0;
        pointer-events: none;
        z-index: 50;
      }
      .doc-layer > * { pointer-events: none; }
      .marks-layer { position: absolute; left: 0; top: 0; }
      .mark-box {
        position: absolute; z-index: 51; pointer-events: none;
        border: 2px solid ${ACCENT};
        border-radius: 10px;
        background: rgba(62,201,143,.06);
        box-shadow: 0 0 0 1px ${HALO}, inset 0 0 0 1px rgba(8,10,9,.4);
      }
      .mark-chip {
        position: absolute; z-index: 56; pointer-events: none;
        display: flex; align-items: center; gap: 6px;
        background: ${SURFACE};
        border-radius: 99px;
        padding: 3px;
        box-shadow: ${RING}, 0 6px 16px -8px rgba(0,0,0,.6);
        font-family: ${FONT};
      }
      .chip-number {
        width: 18px; height: 18px; border-radius: 99px;
        background: ${ACCENT}; color: ${ACCENT_INK};
        font-size: 11px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        flex: none;
      }
      .chip-note {
        font-size: 12px; color: ${INK};
        padding-right: 8px; max-width: 260px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pill-stack {
        position: fixed; left: 50%; transform: translateX(-50%);
        top: 14px; z-index: 90;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        font-family: ${FONT};
        pointer-events: none;
      }
      .pill {
        display: flex; align-items: center; gap: 6px;
        background: ${SURFACE};
        border-radius: 12px;
        padding: 6px;
        box-shadow: ${SHADOW}, ${RING};
        color: ${INK};
        pointer-events: auto;
      }
      .pill-logo { display: flex; align-items: center; padding: 0 4px 0 6px; }
      .pill-logo span {
        width: 18px; height: 18px; border-radius: 99px;
        background: ${ACCENT};
        flex: none;
        display: flex; align-items: center; justify-content: center;
      }
      .pill-title {
        font-size: 12.5px; font-weight: 500;
        padding: 0 4px;
        max-width: 300px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pill-count { font-size: 12px; color: ${MUTED}; padding: 0 4px; white-space: nowrap; }
      .pill-divider { width: 1px; height: 18px; background: rgba(233,230,219,.09); }
      .pill-done {
        height: 28px; padding: 0 12px; border-radius: 8px;
        display: flex; align-items: center;
        background: ${ACCENT};
        font-size: 12.5px; font-weight: 600;
        color: ${ACCENT_INK};
      }
      .pill-done:hover { background: #4bd69c; }
      .hint-chip {
        background: rgba(19,21,20,.88);
        border-radius: 99px;
        padding: 6px 13px;
        font-size: 12px;
        color: ${MUTED};
        box-shadow: 0 0 0 1px rgba(233,230,219,.1);
      }
    `;

    docLayer = element("div", "doc-layer");
    marksLayer = element("div", "marks-layer");
    docLayer.append(marksLayer);

    const pillStack = element("div", "pill-stack");
    const pill = element("div", "pill");
    const logo = element("div", "pill-logo");
    const logoDot = document.createElement("span");
    logoDot.append(icon(CHECK_PATHS, 11, ACCENT_INK, 2.4));
    logo.append(logoDot);
    const title = element("span", "pill-title");
    title.textContent = `Where “${remixletName}” changed things`;
    const count = element("span", "pill-count");
    const n = resolved.marks.length;
    count.textContent = n === 1 ? "1 spot" : `${n} spots`;
    const doneButton = element("button", "pill-done");
    doneButton.textContent = "Done";
    doneButton.addEventListener("click", () => teardown());
    pill.append(logo, title, element("div", "pill-divider"), count, doneButton);
    pillStack.append(pill);
    if (resolved.missing > 0) {
      const hint = element("div", "hint-chip");
      hint.textContent =
        `${resolved.missing === 1 ? "1 spot" : `${resolved.missing} spots`} couldn't be found on this page — ` +
        "the page may have changed since it was checked.";
      pillStack.append(hint);
    }
    if (resolved.unpointable > 0) {
      const hint = element("div", "hint-chip");
      hint.textContent =
        `${resolved.unpointable === 1 ? "1 change" : `${resolved.unpointable} changes`} removed something, ` +
        "so there's nothing left to point at.";
      pillStack.append(hint);
    }

    shadow.append(style, docLayer, pillStack);
    syncScroll();
    renderMarks();
    attach();

    addEventListener("keydown", onKeyDown, true);
    // Marks live in document coordinates: a scroll only shifts the doc layer.
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    observer = new MutationObserver(attach);
    observer.observe(document, { childList: true, subtree: true });
  }

  return {
    open(remixletName, assertions): ShowChangesSummary {
      // Re-open replaces: a second click shows the current state fresh.
      teardown();
      const resolved = resolveSpots(assertions);
      marks = resolved.marks;
      create(remixletName, resolved);
      return {
        highlighted: resolved.marks.length,
        missing: resolved.missing,
        unpointable: resolved.unpointable,
      };
    },
    clear(): void {
      teardown();
    },
  };
}

// SAFETY: this isolated content-script world owns the only __remixletShowChangesHost global.
const showChangesGlobal = globalThis as ShowChangesGlobal;
if (!showChangesGlobal.__remixletShowChangesHost) {
  showChangesGlobal.__remixletShowChangesHost = installShowChangesHost();
  chrome.runtime.onMessage.addListener((message: ShowChangesOpenPayload, _sender, sendResponse) => {
    if (message.kind === SHOW_CHANGES_OPEN_MESSAGE) {
      try {
        const summary = showChangesGlobal.__remixletShowChangesHost!.open(
          message.remixletName.length > 0 ? message.remixletName : "this remixlet",
          sanitizeVerifiedAssertions(message.assertions),
        );
        sendResponse({ ok: true, summary });
      } catch (error) {
        sendResponse({ ok: false, message: String(error) });
      }
      return false;
    }
    return false;
  });
}
