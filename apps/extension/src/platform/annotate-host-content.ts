// Content script hosting the "annotate page" markup mode (v2 redesign, from
// the Claude Design handoff; history in wiki/design/spike-d-draw-on-page.md).
// The worker injects it on demand (bundled as annotate-host.js) into the
// target tab's ISOLATED world when the user clicks the panel's pencil button,
// then sends ANNOTATE_OPEN_MESSAGE.
//
// The overlay is a closed-shadow-root shell, so the page can neither inspect
// nor restyle it. The flow is selection-first, two steps:
//   1. Select an area — drag a freehand box, or click a snap-highlighted
//      element (hovering outlines the smallest annotatable element).
//   2. Act on it — an action popover on the fresh mark offers "Add note"
//      (inline editor), "Add arrow" (aim, then click to place the endpoint),
//      and remove. Arrows always belong to a mark: they originate on the
//      mark's border and their sources are the mark's elements.
// Marks live in DOCUMENT coordinates so the page can scroll mid-mode.
//
// Every selection and arrow endpoint is resolved against the live DOM at
// creation time (platform/annotate-resolve.ts) into selectors and insertion
// anchors. On Done the payload broadcasts as an ANNOTATION_RESULT_KIND
// runtime message — the panel attaches it to the next prompt — and the
// overlay stays in a passive state
// (marks visible, an idle "Annotate this page" pill for re-entry) until the
// panel consumes or discards the attachment (ANNOTATE_CLEAR_MESSAGE).

import {
  ANNOTATE_CLEAR_MESSAGE,
  ANNOTATE_OPEN_MESSAGE,
  ANNOTATION_REOPEN_KIND,
  ANNOTATION_RESULT_KIND,
  type InsertionAnchor,
  type AnnotatedElement,
  type PageMark,
} from "../shared/annotation.js";
import { createAnnotationResolver, type SnapCandidate } from "./annotate-resolve.js";
import {
  ACCENT,
  ACCENT_INK,
  ARROW_RIGHT_PATHS,
  DISABLED,
  FONT,
  HALO,
  INK,
  INPUT_BG,
  MUTED,
  PENCIL_PATHS,
  RING,
  SHADOW,
  SURFACE,
  SURFACE_2,
  SVG_NS,
  TRASH_PATHS,
  UNDO_PATHS,
  ensureFonts,
  icon,
} from "./overlay-theme.js";

const ANNOTATE_HOST_ID = "remixlet-extension-annotate";
/** Releases that moved less than this (px) count as a click, not a drag. */
const CLICK_MAX_PX = 6;
/** Dragged boxes must exceed this (px) on both axes to commit. */
const MIN_BOX_PX = 14;
/** Padding (px) added around a click-snapped element's rect. */
const SNAP_PAD_PX = 10;

interface Mark {
  id: string;
  /** Geometry in document coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
  /** Arrow endpoint in document coordinates; undefined = no arrow. */
  ax?: number;
  ay?: number;
  /** Resolved arrow target, recorded when the endpoint was placed. */
  arrow?: InsertionAnchor;
  /** Resolved selection facts, recorded when the mark was created. */
  elements: AnnotatedElement[];
  overflow: number;
  /** Live resolved elements — arrow cycle guard and resize re-measure. */
  live: Element[];
  /** Click-snapped marks re-measure their element's rect on resize. */
  snapped: boolean;
}

type Mode = "closed" | "active" | "passive";

interface AnnotateHostState {
  open(): void;
  clear(): void;
}

interface Point {
  x: number;
  y: number;
}

interface AnnotateMessage {
  kind?: string;
}

type AnnotateGlobal = typeof globalThis & {
  __remixletAnnotateHost?: AnnotateHostState;
};

// ---- geometry --------------------------------------------------------------

/** Exit point of an arrow: box edge along the line from center to target, +8px out. */
function edgePoint(mark: Mark, tx: number, ty: number): Point {
  const cx = mark.x + mark.w / 2;
  const cy = mark.y + mark.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: cx, y: cy };
  const t = Math.min(dx ? mark.w / 2 / Math.abs(dx) : 1e9, dy ? mark.h / 2 / Math.abs(dy) : 1e9);
  return { x: cx + dx * t + (dx / len) * 8, y: cy + dy * t + (dy / len) * 8 };
}

/** Slightly curved arrow path: quadratic bézier, control point offset
 * perpendicular to the line by 18% of the delta. */
function arrowPath(sx: number, sy: number, ex: number, ey: number): string {
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const dx = ex - sx;
  const dy = ey - sy;
  return `M ${sx} ${sy} Q ${mx - dy * 0.18} ${my + dx * 0.18} ${ex} ${ey}`;
}

function installAnnotateHost(): AnnotateHostState {
  let mode: Mode = "closed";
  let marks: Mark[] = [];
  let drawing: { x0: number; y0: number; x1: number; y1: number } | undefined;
  let hover: SnapCandidate | undefined;
  let menuId: string | undefined;
  let editingId: string | undefined;
  let aimingId: string | undefined;
  /** Aim cursor position, document coordinates; undefined until first move. */
  let aim: { x: number; y: number } | undefined;
  /** Last pointer position (client), to re-run hover snapping on scroll. */
  let lastPointer: { x: number; y: number } | undefined;
  let markSerial = 0;

  const resolver = createAnnotationResolver([ANNOTATE_HOST_ID]);

  // ---- shell ---------------------------------------------------------------

  let host: HTMLDivElement | undefined;
  let observer: MutationObserver | undefined;
  let scrim!: HTMLDivElement;
  let eventLayer!: HTMLDivElement;
  let hoverBox!: HTMLDivElement;
  let hoverTag!: HTMLDivElement;
  let docLayer!: HTMLDivElement;
  let arrowSvg!: SVGSVGElement;
  let arrowsGroup!: SVGGElement;
  let aimPathEl!: SVGPathElement;
  let marksLayer!: HTMLDivElement;
  let draftBox!: HTMLDivElement;
  let popover!: HTMLDivElement;
  let popoverNoteButton!: HTMLButtonElement;
  let popoverArrowButton!: HTMLButtonElement;
  let editor!: HTMLDivElement;
  let editorInput!: HTMLInputElement;
  let toolbar!: HTMLDivElement;
  let countText!: HTMLSpanElement;
  let undoButton!: HTMLButtonElement;
  let doneButton!: HTMLButtonElement;
  let hintChip!: HTMLDivElement;
  let idlePill!: HTMLButtonElement;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // ---- state → DOM ---------------------------------------------------------

  function markById(id: string | undefined): Mark | undefined {
    return id === undefined ? undefined : marks.find((mark) => mark.id === id);
  }

  function syncMode(): void {
    const active = mode === "active";
    scrim.style.display = active ? "block" : "none";
    eventLayer.style.display = active ? "block" : "none";
    toolbar.style.display = active ? "flex" : "none";
    idlePill.style.display = mode === "passive" ? "flex" : "none";
    marksLayer.style.pointerEvents = active ? "auto" : "none";
    if (!active) {
      hoverBox.style.display = "none";
      hoverTag.style.display = "none";
      draftBox.style.display = "none";
      aimPathEl.style.display = "none";
      popover.style.display = "none";
      editor.style.display = "none";
    }
  }

  function syncScroll(): void {
    docLayer.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
  }

  function renderHover(): void {
    if (!hover || drawing || aimingId || menuId || editingId || mode !== "active") {
      hoverBox.style.display = "none";
      hoverTag.style.display = "none";
      return;
    }
    const rect = hover.element.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = `${rect.left - 6}px`;
    hoverBox.style.top = `${rect.top - 6}px`;
    hoverBox.style.width = `${rect.width + 12}px`;
    hoverBox.style.height = `${rect.height + 12}px`;
    hoverTag.style.display = "block";
    hoverTag.style.left = `${rect.left - 6}px`;
    hoverTag.style.top = `${rect.top - 30}px`;
    hoverTag.textContent = hover.label;
  }

  function renderDraft(): void {
    if (!drawing) {
      draftBox.style.display = "none";
      return;
    }
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    if (w <= 3 || h <= 3) {
      draftBox.style.display = "none";
      return;
    }
    draftBox.style.display = "block";
    draftBox.style.left = `${Math.min(drawing.x0, drawing.x1)}px`;
    draftBox.style.top = `${Math.min(drawing.y0, drawing.y1)}px`;
    draftBox.style.width = `${w}px`;
    draftBox.style.height = `${h}px`;
  }

  function renderAim(): void {
    const mark = markById(aimingId);
    if (!mark || !aim) {
      aimPathEl.style.display = "none";
      return;
    }
    const from = edgePoint(mark, aim.x, aim.y);
    aimPathEl.style.display = "";
    aimPathEl.setAttribute("d", arrowPath(from.x, from.y, aim.x, aim.y));
  }

  function renderMarks(): void {
    marksLayer.replaceChildren();
    arrowsGroup.replaceChildren();
    marks.forEach((mark, index) => {
      const box = element("div", "mark-box");
      box.style.left = `${mark.x}px`;
      box.style.top = `${mark.y}px`;
      box.style.width = `${mark.w}px`;
      box.style.height = `${mark.h}px`;

      const chip = element("div", "mark-chip");
      chip.title = "Annotation actions";
      chip.style.left = `${mark.x - 4}px`;
      chip.style.top = `${mark.y - 13}px`;
      const number = element("span", "chip-number");
      number.textContent = String(index + 1);
      chip.append(number);
      if (mark.note.length > 0) {
        const note = element("span", "chip-note");
        note.textContent = mark.note;
        chip.append(note);
      }
      chip.addEventListener("pointerdown", (event) => event.stopPropagation());
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (mode !== "active") return;
        menuId = mark.id;
        editingId = undefined;
        aimingId = undefined;
        aim = undefined;
        renderOverlayState();
      });

      marksLayer.append(box, chip);

      if (mark.ax !== undefined && mark.ay !== undefined) {
        const from = edgePoint(mark, mark.ax, mark.ay);
        const d = arrowPath(from.x, from.y, mark.ax, mark.ay);
        const halo = document.createElementNS(SVG_NS, "path");
        halo.setAttribute("d", d);
        halo.setAttribute("fill", "none");
        halo.setAttribute("stroke", HALO);
        halo.setAttribute("stroke-width", "5");
        halo.setAttribute("stroke-linecap", "round");
        const line = document.createElementNS(SVG_NS, "path");
        line.setAttribute("d", d);
        line.setAttribute("fill", "none");
        line.setAttribute("stroke", ACCENT);
        line.setAttribute("stroke-width", "2.25");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("marker-end", "url(#remixlet-arrowhead)");
        arrowsGroup.append(halo, line);
      }
    });
  }

  /** Anchor the popover/editor below the mark's top-left, clamped on screen. */
  function anchorBelow(mark: Mark, node: HTMLElement, bottomInset: number): void {
    const clientX = mark.x - scrollX;
    const clientBottom = mark.y + mark.h - scrollY;
    node.style.left = `${Math.max(8, Math.min(clientX, innerWidth - 280))}px`;
    node.style.top = `${Math.max(8, Math.min(clientBottom + 8, innerHeight - bottomInset))}px`;
  }

  function renderMenu(): void {
    const mark = markById(menuId);
    if (!mark || mode !== "active") {
      popover.style.display = "none";
      return;
    }
    popover.style.display = "flex";
    anchorBelow(mark, popover, 44);
    popoverNoteButton.lastChild!.textContent = mark.note.length > 0 ? "Edit note" : "Add note";
    popoverArrowButton.lastChild!.textContent = mark.ax !== undefined ? "Move arrow" : "Add arrow";
  }

  function renderEditor(): void {
    const mark = markById(editingId);
    if (!mark || mode !== "active") {
      editor.style.display = "none";
      return;
    }
    editor.style.display = "block";
    anchorBelow(mark, editor, 56);
  }

  function renderToolbar(): void {
    const n = marks.length;
    countText.textContent = n === 1 ? "1 annotation" : `${n} annotations`;
    undoButton.style.color = n > 0 ? MUTED : DISABLED;
    doneButton.style.opacity = n > 0 ? "1" : "0.45";
    hintChip.textContent = aimingId
      ? "Click where it should go"
      : "Drag a box or click an element, then add a note or arrow";
  }

  /** Everything that depends on mark/menu/editor/aiming state. */
  function renderOverlayState(): void {
    renderMarks();
    renderMenu();
    renderEditor();
    renderToolbar();
    renderHover();
    renderAim();
    if (editingId) {
      const mark = markById(editingId);
      editorInput.value = mark?.note ?? "";
      editorInput.focus();
    }
  }

  // ---- mark creation & actions ---------------------------------------------

  function addMark(partial: Omit<Mark, "id" | "note">): void {
    markSerial += 1;
    const mark: Mark = { id: `m${markSerial}`, note: "", ...partial };
    marks.push(mark);
    menuId = mark.id;
    editingId = undefined;
    aimingId = undefined;
    aim = undefined;
    renderOverlayState();
  }

  function snapMarkAt(clientX: number, clientY: number): void {
    // Resolve fresh at the click point — the hover candidate can be stale.
    const candidate = resolver.snapAt(clientX, clientY);
    if (!candidate) return;
    const resolution = resolver.resolveElement(candidate.element);
    const rect = candidate.element.getBoundingClientRect();
    addMark({
      x: rect.left + scrollX - SNAP_PAD_PX,
      y: rect.top + scrollY - SNAP_PAD_PX,
      w: rect.width + 2 * SNAP_PAD_PX,
      h: rect.height + 2 * SNAP_PAD_PX,
      elements: resolution.annotation.elements,
      overflow: resolution.annotation.overflow,
      live: resolution.elements,
      snapped: true,
    });
  }

  function boxMark(x0: number, y0: number, x1: number, y1: number): void {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w <= MIN_BOX_PX || h <= MIN_BOX_PX) return;
    const resolution = resolver.resolveBoxStroke(x - scrollX, y - scrollY, w, h);
    if (!resolution) return;
    addMark({
      x,
      y,
      w,
      h,
      elements: resolution.annotation.elements,
      overflow: resolution.annotation.overflow,
      live: resolution.elements,
      snapped: false,
    });
  }

  function placeArrow(clientX: number, clientY: number): void {
    const mark = markById(aimingId);
    aimingId = undefined;
    aim = undefined;
    if (mark) {
      const { anchor } = resolver.resolveArrowTarget({ x: clientX, y: clientY }, mark.live);
      mark.ax = clientX + scrollX;
      mark.ay = clientY + scrollY;
      mark.arrow = anchor;
    }
    renderOverlayState();
  }

  function undo(): void {
    marks.pop();
    menuId = undefined;
    editingId = undefined;
    aimingId = undefined;
    aim = undefined;
    renderOverlayState();
  }

  function commitNote(): void {
    const mark = markById(editingId);
    editingId = undefined;
    if (mark) mark.note = editorInput.value.trim();
    renderOverlayState();
  }

  // ---- finish / lifecycle --------------------------------------------------

  function payloadMarks(): PageMark[] {
    return marks.map((mark) => {
      const payload: PageMark = {
        elements: mark.elements,
        overflow: mark.overflow,
        note: mark.note,
      };
      if (mark.arrow) payload.arrow = mark.arrow;
      return payload;
    });
  }

  function broadcast(cancelled: boolean): void {
    void chrome.runtime
      .sendMessage({
        kind: ANNOTATION_RESULT_KIND,
        cancelled,
        url: location.href,
        marks: cancelled ? [] : payloadMarks(),
      })
      .catch(() => {});
  }

  function cancel(): void {
    teardown();
    broadcast(true);
  }

  function done(): void {
    if (marks.length === 0) return;
    mode = "passive";
    menuId = undefined;
    editingId = undefined;
    aimingId = undefined;
    aim = undefined;
    drawing = undefined;
    hover = undefined;
    syncMode();
    renderOverlayState();
    broadcast(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (mode !== "active" || editingId) return;
    const key = event.key.toLowerCase();
    if (key === "u" || ((event.metaKey || event.ctrlKey) && key === "z")) {
      event.preventDefault();
      undo();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (aimingId) {
        aimingId = undefined;
        aim = undefined;
        renderOverlayState();
      } else if (menuId) {
        menuId = undefined;
        renderOverlayState();
      } else {
        cancel();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      done();
    }
  }

  function onScroll(): void {
    syncScroll();
    renderMenu();
    renderEditor();
    if (lastPointer && mode === "active" && !drawing && !aimingId) {
      hover = resolver.snapAt(lastPointer.x, lastPointer.y);
      renderHover();
    }
  }

  function onResize(): void {
    // Element rects come from live DOM measurement — snapped marks follow
    // their element when the layout reflows; drawn boxes keep their spot.
    for (const mark of marks) {
      const live = mark.live[0];
      if (!mark.snapped || !live || !live.isConnected) continue;
      const rect = live.getBoundingClientRect();
      mark.x = rect.left + scrollX - SNAP_PAD_PX;
      mark.y = rect.top + scrollY - SNAP_PAD_PX;
      mark.w = rect.width + 2 * SNAP_PAD_PX;
      mark.h = rect.height + 2 * SNAP_PAD_PX;
    }
    renderOverlayState();
  }

  function teardown(): void {
    mode = "closed";
    observer?.disconnect();
    observer = undefined;
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("resize", onResize);
    host?.remove();
    host = undefined;
    marks = [];
    drawing = undefined;
    hover = undefined;
    menuId = undefined;
    editingId = undefined;
    aimingId = undefined;
    aim = undefined;
    lastPointer = undefined;
  }

  function attach(): void {
    if (mode === "closed" || !host) return;
    if (!host.isConnected) document.documentElement.append(host);
  }

  // ---- construction --------------------------------------------------------

  function create(): void {
    ensureFonts();
    host = document.createElement("div");
    host.id = ANNOTATE_HOST_ID;
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
      .scrim {
        position: fixed; inset: 0; z-index: 40;
        background: rgba(10,12,11,.32);
        pointer-events: none;
      }
      .event-layer {
        position: fixed; inset: 0; z-index: 44;
        pointer-events: auto;
        cursor: crosshair;
        touch-action: none;
      }
      .hover-box {
        position: fixed; z-index: 46; pointer-events: none;
        border: 1.5px dashed rgba(62,201,143,.85);
        border-radius: 10px;
        background: rgba(62,201,143,.05);
      }
      .hover-tag {
        position: fixed; z-index: 46; pointer-events: none;
        background: ${SURFACE};
        border-radius: 6px;
        padding: 3px 8px;
        font-family: ${FONT};
        font-size: 10px; font-weight: 600;
        letter-spacing: .08em; text-transform: uppercase;
        color: ${ACCENT};
        box-shadow: 0 0 0 1px rgba(233,230,219,.12);
        white-space: nowrap;
      }
      .doc-layer {
        position: fixed; left: 0; top: 0; width: 0; height: 0;
        pointer-events: none;
        z-index: 50;
      }
      .doc-layer > * { pointer-events: none; }
      .arrow-svg { position: absolute; left: 0; top: 0; overflow: visible; z-index: 52; }
      .marks-layer { position: absolute; left: 0; top: 0; }
      .mark-box {
        position: absolute; z-index: 51; pointer-events: none;
        border: 2px solid ${ACCENT};
        border-radius: 10px;
        background: rgba(62,201,143,.06);
        box-shadow: 0 0 0 1px ${HALO}, inset 0 0 0 1px rgba(8,10,9,.4);
      }
      .mark-chip {
        position: absolute; z-index: 56;
        display: flex; align-items: center; gap: 6px;
        background: ${SURFACE};
        border-radius: 99px;
        padding: 3px;
        box-shadow: ${RING}, 0 6px 16px -8px rgba(0,0,0,.6);
        cursor: pointer;
        pointer-events: inherit;
        font-family: ${FONT};
      }
      .mark-chip:hover { box-shadow: 0 0 0 1px ${ACCENT}, 0 6px 16px -8px rgba(0,0,0,.6); }
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
      .draft-box {
        position: absolute; z-index: 52; pointer-events: none;
        border: 2px dashed ${ACCENT};
        border-radius: 10px;
        background: rgba(62,201,143,.05);
      }
      .popover {
        position: fixed; z-index: 70;
        display: flex; align-items: center; gap: 3px;
        background: ${SURFACE};
        border-radius: 10px;
        padding: 4px;
        box-shadow: ${RING}, ${SHADOW};
        font-family: ${FONT};
        color: ${INK};
        pointer-events: auto;
      }
      .popover-button {
        display: flex; align-items: center; gap: 6px;
        height: 26px; padding: 0 10px;
        border-radius: 7px;
        color: ${INK};
        font-size: 12.5px; font-weight: 500;
      }
      .popover-button:hover { background: ${SURFACE_2}; }
      .popover-divider { width: 1px; height: 16px; background: rgba(233,230,219,.09); }
      .popover-delete {
        display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px;
        border-radius: 7px;
        color: ${MUTED};
      }
      .popover-delete:hover { background: ${SURFACE_2}; color: ${INK}; }
      .editor {
        position: fixed; z-index: 70;
        background: ${SURFACE};
        border-radius: 10px;
        padding: 6px;
        box-shadow: ${RING}, ${SHADOW};
        font-family: ${FONT};
        pointer-events: auto;
      }
      .editor input {
        all: unset; box-sizing: border-box;
        width: 230px;
        background: ${INPUT_BG};
        color: ${INK};
        font-family: ${FONT};
        font-size: 12.5px;
        border-radius: 6px;
        padding: 7px 9px;
        box-shadow: inset 0 0 0 1px rgba(233,230,219,.14);
      }
      .editor input::placeholder { color: ${MUTED}; }
      .toolbar {
        position: fixed; left: 50%; transform: translateX(-50%);
        top: 14px; z-index: 90;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        font-family: ${FONT};
        pointer-events: auto;
      }
      .toolbar-pill {
        display: flex; align-items: center; gap: 6px;
        background: ${SURFACE};
        border-radius: 12px;
        padding: 6px;
        box-shadow: ${SHADOW}, ${RING};
        color: ${INK};
      }
      .toolbar-logo { display: flex; align-items: center; padding: 0 4px 0 6px; }
      .toolbar-logo span {
        width: 18px; height: 18px; border-radius: 99px;
        background: ${ACCENT};
        flex: none;
        display: flex; align-items: center; justify-content: center;
      }
      .toolbar-divider { width: 1px; height: 18px; background: rgba(233,230,219,.09); }
      .toolbar-count {
        font-size: 12px; color: ${MUTED};
        padding: 0 4px; min-width: 54px; text-align: center;
      }
      .toolbar-undo {
        width: 28px; height: 28px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
      }
      .toolbar-undo:hover { background: ${SURFACE_2}; }
      .toolbar-cancel {
        height: 28px; padding: 0 10px; border-radius: 8px;
        display: flex; align-items: center;
        font-size: 12.5px; font-weight: 500;
        color: ${MUTED};
      }
      .toolbar-cancel:hover { color: ${INK}; background: ${SURFACE_2}; }
      .toolbar-done {
        height: 28px; padding: 0 12px; border-radius: 8px;
        display: flex; align-items: center; gap: 6px;
        background: ${ACCENT};
        font-size: 12.5px; font-weight: 600;
        color: ${ACCENT_INK};
      }
      .hint-chip {
        background: rgba(19,21,20,.88);
        border-radius: 99px;
        padding: 6px 13px;
        font-size: 12px;
        color: ${MUTED};
        box-shadow: 0 0 0 1px rgba(233,230,219,.1);
      }
      .idle-pill {
        position: fixed; left: 50%; transform: translateX(-50%);
        top: 14px; z-index: 90;
        height: 36px; padding: 0 16px;
        border-radius: 99px;
        background: ${SURFACE};
        color: ${INK};
        font-family: ${FONT};
        font-size: 13px; font-weight: 500;
        display: flex; align-items: center; gap: 8px;
        box-shadow: ${SHADOW}, ${RING};
        pointer-events: auto;
      }
      .idle-pill:hover { background: ${SURFACE_2}; }
      .idle-dot { width: 6px; height: 6px; border-radius: 99px; background: ${ACCENT}; }
    `;

    scrim = element("div", "scrim");

    eventLayer = element("div", "event-layer");
    eventLayer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (editingId) {
        // Click-away commits the note: let the input's blur handler do the
        // work (preventDefault here would suppress the focus change).
        editorInput.blur();
        return;
      }
      event.preventDefault();
      if (aimingId) {
        placeArrow(event.clientX, event.clientY);
        return;
      }
      eventLayer.setPointerCapture(event.pointerId);
      const x = event.clientX + scrollX;
      const y = event.clientY + scrollY;
      drawing = { x0: x, y0: y, x1: x, y1: y };
      if (menuId) {
        menuId = undefined;
        renderMenu();
      }
      renderHover();
    });
    eventLayer.addEventListener("pointermove", (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      if (aimingId) {
        aim = { x: event.clientX + scrollX, y: event.clientY + scrollY };
        hover = undefined;
        renderHover();
        renderAim();
        return;
      }
      if (drawing) {
        drawing.x1 = event.clientX + scrollX;
        drawing.y1 = event.clientY + scrollY;
        renderDraft();
        return;
      }
      const next = resolver.snapAt(event.clientX, event.clientY);
      if (next?.element !== hover?.element) {
        hover = next;
        renderHover();
      }
    });
    eventLayer.addEventListener("pointerup", (_event) => {
      if (!drawing) return;
      const { x0, y0, x1, y1 } = drawing;
      drawing = undefined;
      renderDraft();
      // A click snaps at the pointer-DOWN spot (document → client at release).
      if (Math.hypot(x1 - x0, y1 - y0) < CLICK_MAX_PX) snapMarkAt(x0 - scrollX, y0 - scrollY);
      else boxMark(x0, y0, x1, y1);
    });

    hoverBox = element("div", "hover-box");
    hoverTag = element("div", "hover-tag");

    docLayer = element("div", "doc-layer");
    arrowSvg = document.createElementNS(SVG_NS, "svg");
    arrowSvg.setAttribute("class", "arrow-svg");
    arrowSvg.setAttribute("width", "1");
    arrowSvg.setAttribute("height", "1");
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "remixlet-arrowhead");
    marker.setAttribute("markerWidth", "9");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "6.5");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const markerPath = document.createElementNS(SVG_NS, "path");
    markerPath.setAttribute("d", "M0 0 L8 4 L0 8 Z");
    markerPath.setAttribute("fill", ACCENT);
    marker.append(markerPath);
    defs.append(marker);
    arrowsGroup = document.createElementNS(SVG_NS, "g");
    aimPathEl = document.createElementNS(SVG_NS, "path");
    aimPathEl.setAttribute("fill", "none");
    aimPathEl.setAttribute("stroke", ACCENT);
    aimPathEl.setAttribute("stroke-width", "2.25");
    aimPathEl.setAttribute("stroke-linecap", "round");
    aimPathEl.setAttribute("stroke-dasharray", "6 5");
    aimPathEl.setAttribute("marker-end", "url(#remixlet-arrowhead)");
    aimPathEl.style.display = "none";
    arrowSvg.append(defs, arrowsGroup, aimPathEl);
    marksLayer = element("div", "marks-layer");
    draftBox = element("div", "draft-box");
    draftBox.style.display = "none";
    docLayer.append(arrowSvg, marksLayer, draftBox);

    // Action popover: Add/Edit note · Add/Move arrow · | · remove.
    popover = element("div", "popover");
    popover.addEventListener("pointerdown", (event) => event.stopPropagation());
    popoverNoteButton = element("button", "popover-button");
    popoverNoteButton.append(icon(PENCIL_PATHS, 12), document.createTextNode("Add note"));
    popoverNoteButton.addEventListener("click", () => {
      editingId = menuId;
      menuId = undefined;
      renderOverlayState();
    });
    popoverArrowButton = element("button", "popover-button");
    popoverArrowButton.append(icon(ARROW_RIGHT_PATHS, 12), document.createTextNode("Add arrow"));
    popoverArrowButton.addEventListener("click", () => {
      aimingId = menuId;
      menuId = undefined;
      aim = undefined;
      renderOverlayState();
    });
    const popoverDivider = element("div", "popover-divider");
    const popoverDelete = element("button", "popover-delete");
    popoverDelete.title = "Remove annotation";
    popoverDelete.append(icon(TRASH_PATHS, 12));
    popoverDelete.addEventListener("click", () => {
      marks = marks.filter((mark) => mark.id !== menuId);
      menuId = undefined;
      renderOverlayState();
    });
    popover.append(popoverNoteButton, popoverArrowButton, popoverDivider, popoverDelete);

    editor = element("div", "editor");
    editor.addEventListener("pointerdown", (event) => event.stopPropagation());
    editorInput = document.createElement("input");
    editorInput.placeholder = "Add a note — Enter to save";
    editorInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === "Escape") editorInput.blur();
    });
    editorInput.addEventListener("blur", () => {
      if (editingId) commitNote();
    });
    editor.append(editorInput);

    // Toolbar pill + hint chip.
    toolbar = element("div", "toolbar");
    const pill = element("div", "toolbar-pill");
    const logo = element("div", "toolbar-logo");
    const logoDot = document.createElement("span");
    logoDot.append(icon(PENCIL_PATHS, 11, ACCENT_INK, 2.4));
    logo.append(logoDot);
    countText = element("span", "toolbar-count");
    undoButton = element("button", "toolbar-undo");
    undoButton.title = "Undo (U)";
    undoButton.append(icon(UNDO_PATHS, 14));
    undoButton.addEventListener("click", undo);
    const cancelButton = element("button", "toolbar-cancel");
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", cancel);
    doneButton = element("button", "toolbar-done");
    doneButton.append(document.createTextNode("Done"), icon(ARROW_RIGHT_PATHS, 12, "currentColor", 2.2));
    doneButton.addEventListener("click", done);
    pill.append(
      logo,
      element("div", "toolbar-divider"),
      countText,
      undoButton,
      element("div", "toolbar-divider"),
      cancelButton,
      doneButton,
    );
    hintChip = element("div", "hint-chip");
    toolbar.append(pill, hintChip);

    idlePill = element("button", "idle-pill");
    idlePill.append(element("span", "idle-dot"), document.createTextNode("Annotate this page"));
    idlePill.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ kind: ANNOTATION_REOPEN_KIND }).catch(() => {});
    });

    shadow.append(style, scrim, eventLayer, hoverBox, hoverTag, docLayer, popover, editor, toolbar, idlePill);
    mode = "active";
    syncMode();
    syncScroll();
    renderOverlayState();
    attach();

    addEventListener("keydown", onKeyDown, true);
    // Marks live in document coordinates: a scroll only shifts the doc layer
    // and re-anchors the viewport-clamped popover/editor.
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    observer = new MutationObserver(attach);
    observer.observe(document, { childList: true, subtree: true });
  }

  return {
    open(): void {
      if (mode === "active") return;
      if (mode === "passive") {
        // Re-entry from the idle pill or the panel: a fresh markup session.
        marks = [];
        menuId = undefined;
        editingId = undefined;
        aimingId = undefined;
        aim = undefined;
        mode = "active";
        syncMode();
        renderOverlayState();
        return;
      }
      create();
    },
    clear(): void {
      teardown();
    },
  };
}

// SAFETY: this content script owns the global marker and writes only AnnotateHostState values to it.
const annotateGlobal = globalThis as AnnotateGlobal;
if (!annotateGlobal.__remixletAnnotateHost) {
  annotateGlobal.__remixletAnnotateHost = installAnnotateHost();
  chrome.runtime.onMessage.addListener((message: AnnotateMessage, _sender, sendResponse) => {
    const kind = message?.kind;
    if (kind === ANNOTATE_OPEN_MESSAGE) {
      annotateGlobal.__remixletAnnotateHost!.open();
      sendResponse({ ok: true });
      return false;
    }
    if (kind === ANNOTATE_CLEAR_MESSAGE) {
      annotateGlobal.__remixletAnnotateHost!.clear();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}
