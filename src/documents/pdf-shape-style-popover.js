// A shape's style, at the shape.
//
// Text typed on a page, an arrow, a box: once one was down, changing how it
// looked meant opening the pen's bar, arming Shapes, tapping the thing to pick
// it up and pressing the chip — four steps, and the mark menu a plain tap
// opened had only a highlight's five colours, which for typed text did not
// even change the words. "Once a text has been written, changing its styling is
// quite difficult."
//
// So the controls come to the shape. Whenever a shape is selected — tapped with
// Shapes or Text armed, picked from its menu's Style row with any tool, or just
// drawn — or its words are open to type in, this popover floats at it with
// the shape panel (src/documents/pdf-shape-panel.js, built a second time, as a
// bar): colour, size, bold and alignment for text; colour, width, line and
// heads for an arrow; a box's fill. Each press goes through setShapeSettings,
// which restyles THAT shape as one undo step (and, while its words are being
// typed, shows the change under the cursor — src/documents/pdf-shape-text.js).
// At the bar's end: Delete, ⋯ for Edit text, its note and its menu, and Done.
//
// ── A bar, not a panel ────────────────────────────────────────────────────
//
// It once opened with the WHOLE panel — nine labelled rows, 320px by 460px,
// sitting on the very page the reader had written on. "The styling options are
// too obtrusive, directly overshadowing the text, and lay out every option at
// once." Then it folded to Aa Style · ✓ and opened the same nine rows from
// there. Now it is one slim row of icons, above the shape:
//
//   text         ● · 11 · B · ≡ · ▢ · ↻ · 🗑 · ⋯ · ✓
//   an arrow     ● · ═ · ↗ · 🗑 · ⋯ · ✓
//   while typing ● · 11 · B · ≡ · ▢ · ↻ · ✓
//
// each icon wearing what it sets, and each opening a small tray of its own —
// on the side away from the shape, so nothing of the bar sits on what it
// styles. One tray at a time; ⋯ is a tray too, with Edit text, Note and the
// shape's menu. A new text still starts from the last style used (src/
// documents/pdf-shapes.js, currentShapeSettings), so while typing the bar is
// there to change it and nothing needs to be opened first.
//
// It follows the selection rather than being opened and shut by hand: ink-rail
// calls syncShapeStylePopover from the shapes' one change hook, so whatever puts
// a shape down — a tap elsewhere, Escape, Delete, undo — takes this with it.

import { el } from "../core/dom.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";
import { DOCUMENT_MARK_HANDLERS, DOCUMENT_NOTE_HANDLERS, documentHighlightNote, documentMarkAnchor, setDocumentShapeStyler } from "./pdf-highlights.js?v=__BUILD__";
import { SHAPE_BAR_ICONS, buildShapePanel, refreshShapePanel, setShapeTray, shapeTray } from "./pdf-shape-panel.js?v=__BUILD__";
import { commitShapeTextEditor, isEditingShapeText, openShapeTextEditor } from "./pdf-shape-text.js?v=__BUILD__";
import { SHAPE_ROTATABLE } from "../render/annot-shapes.js?v=__BUILD__";
import { SHAPE_ROTATE_HANDLE_GAP, deleteShape, editConnectorLabel, editingShapeTextId, selectShape, shapeScreenRect, targetShapeRecord } from "./pdf-shapes.js?v=__BUILD__";

export const SHAPE_STYLE_POPOVER_CLASS = "shape-style-popover";

let shapeStylePop = null;
let shapeStylePlaceFrame = 0;

export function isShapeStylePopoverOpen() {
  return Boolean(shapeStylePop && !shapeStylePop.root.hidden);
}

// An icon at the bar's end: Delete, ⋯ and Done.
function shapeStyleBarButton(action, label, face, { danger = false, tray = false } = {}) {
  const popup = tray ? ' aria-haspopup="true" aria-expanded="false"' : "";
  return `<button type="button" class="shape-bar-btn${danger ? " is-danger" : ""}" data-shape-style-action="${action}" title="${label}" aria-label="${label}"${popup}>${face}</button>`;
}

// A word in the ⋯ tray.
function shapeStyleTrayButton(action, label, word) {
  return `<button type="button" class="shape-pop-seg shape-style-word" data-shape-style-action="${action}" title="${label}" aria-label="${label}">${word}</button>`;
}

function buildShapeStylePopover() {
  const root = document.createElement("div");
  root.className = SHAPE_STYLE_POPOVER_CLASS;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Style");
  root.hidden = true;
  const section = buildShapePanel(root, { floating: true });
  const bar = section.querySelector(".shape-bar");
  const trayBox = section.querySelector(".shape-sheet");
  section.querySelector("[data-shape-bar-end]").innerHTML = [
    shapeStyleBarButton("delete", "Delete", SHAPE_BAR_ICONS.trash, { danger: true }),
    shapeStyleBarButton("more", "More — edit the text, a note, the menu", "&#8943;", { tray: true }),
    shapeStyleBarButton("done", "Done", SHAPE_BAR_ICONS.done)
  ].join("");
  const actions = document.createElement("div");
  actions.className = "shape-pop-row";
  actions.dataset.shapeRow = "actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "More");
  actions.innerHTML = [
    shapeStyleTrayButton("edit-text", "Edit the text", "Edit text"),
    shapeStyleTrayButton("note", "Add or edit a note", "Note"),
    shapeStyleTrayButton("menu", "Menu — a card, copy, the Highlights pane", "Menu")
  ].join("");
  trayBox.appendChild(actions);
  document.body.appendChild(root);

  // A press here must not take focus from the words being typed — A+ halfway
  // through a sentence restyles it and the typing goes on. Not for the inputs:
  // a slider and the colour picker need the focus to work at all.
  root.addEventListener("mousedown", (event) => {
    if (event.target.closest("input, label")) return;
    event.preventDefault();
  });
  // ...and nothing here is a press on the page underneath. (The panel's own
  // controls stop their press where they are; the actions come on to here.)
  root.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    const button = event.target.closest("[data-shape-style-action]");
    if (!button) return;
    event.preventDefault();
    pressShapeStyle(button.dataset.shapeStyleAction);
  });
  // The keyboard's own press — a click with no pointer behind it.
  root.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const button = event.target.closest("[data-shape-style-action]");
    if (button) pressShapeStyle(button.dataset.shapeStyleAction);
  });
  // Escape shuts an open tray first, and only then puts the shape down.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (shapeTray(section)) { setShapeTray(section, null); syncShapeStylePopover(); return; }
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
  });
  const reposition = () => {
    if (shapeStylePlaceFrame) return;
    shapeStylePlaceFrame = requestAnimationFrame(() => { shapeStylePlaceFrame = 0; placeShapeStylePopover(); });
  };
  window.addEventListener("resize", reposition);
  // Capture: what moves the page is the document's scroller, and a scroll
  // event does not bubble. Input: typed text grows, and this sits at it.
  document.addEventListener("scroll", reposition, true);
  document.addEventListener("input", reposition, true);
  // A tray opening or shutting changes the popover's height, and its bar must
  // stay where it was, against the shape.
  if (typeof ResizeObserver === "function") new ResizeObserver(reposition).observe(root);
  // Leaving the PDFs or Canvas tab hides the stage, not the selection: the
  // popover goes with the stage, and comes back with it.
  if (el.documentStage && typeof MutationObserver === "function") {
    new MutationObserver(() => syncShapeStylePopover()).observe(el.documentStage, { attributes: true, attributeFilter: ["hidden"] });
  }
  shapeStylePop = { root, section, bar, trayBox, id: null, trayFor: null, side: "above", sideFor: null, clear: 0 };
  return shapeStylePop;
}

function pressShapeStyle(action) {
  const record = targetShapeRecord();
  if (!record) return;
  const id = record.id;
  if (action === "more") {
    setShapeTray(shapeStylePop.section, shapeTray(shapeStylePop.section) === "more" ? null : "more");
    syncShapeStylePopover();
    return;
  }
  if (action === "edit-text") {
    setShapeTray(shapeStylePop.section, null);
    // A line's words are its label, typed in an editor of their own.
    if (!openShapeTextEditor(id)) editConnectorLabel(id);
  } else if (action === "note") {
    const rect = shapeScreenRect(record);
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
    openHighlightNoteEditor(id, rect, documentHighlightNote(id), DOCUMENT_NOTE_HANDLERS);
  } else if (action === "delete") {
    if (isEditingShapeText()) commitShapeTextEditor();
    deleteShape(id);
  } else if (action === "menu") {
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
    const anchor = documentMarkAnchor(el.documentView, id);
    if (anchor) openMarkMenuWith(anchor, id, DOCUMENT_MARK_HANDLERS, record.color || MARK_HIGHLIGHT_DEFAULT);
  } else if (action === "done") {
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
  }
}

// Above the shape if there is room, under it if not, clamped to the screen —
// the bar against the shape and an open tray on its far side, so neither sits
// on what it styles. While its words are being typed, at the editor, which
// grows as they are. The side is chosen for the bar alone and kept while a tray
// is open, so opening one never makes the bar jump across the shape.
function placeShapeStylePopover() {
  if (!shapeStylePop || shapeStylePop.root.hidden) return;
  const pop = shapeStylePop;
  const record = targetShapeRecord();
  if (!record || el.documentStage?.hidden) { pop.root.hidden = true; return; }
  const editor = el.documentView?.querySelector(`.pdf-shape-editor[data-highlight-id="${CSS.escape(record.id)}"]`);
  const box = editor?.getBoundingClientRect() || shapeScreenRect(record);
  if (!box) return;
  const { root, trayBox } = pop;
  const margin = 8;
  const viewH = window.innerHeight;
  const sheetHeight = () => (trayBox.hidden ? 0 : trayBox.getBoundingClientRect().height);
  const barBlock = root.getBoundingClientRect().height - sheetHeight();
  // A box that can be turned has its turning handle just outside it — above
  // when upright, wherever the turn puts it otherwise — and this must not sit
  // on top of it. Covering the words is worse than covering the handle, so
  // where there is no room for both the clearance goes first.
  const clear = !editor && SHAPE_ROTATABLE.includes(record.shape?.type) ? SHAPE_ROTATE_HANDLE_GAP + 10 : 0;
  if (!(pop.sideFor === record.id && shapeTray(pop.section))) {
    const fits = ([side, c]) => (side === "above"
      ? box.top - c - margin - barBlock >= margin
      : box.bottom + c + margin + barBlock <= viewH - margin);
    const choice = [["above", clear], ["below", clear], ["above", 0], ["below", 0]].find(fits)
      || [box.top >= viewH - box.bottom ? "above" : "below", 0];
    [pop.side, pop.clear] = choice;
    pop.sideFor = record.id;
  }
  const above = pop.side === "above";
  root.classList.toggle("is-above", above);
  // An open tray takes the room on its side and no more: past that it scrolls.
  const room = above ? box.top - pop.clear - margin * 2 - barBlock : viewH - box.bottom - pop.clear - margin * 2 - barBlock;
  trayBox.style.maxHeight = `${Math.max(120, Math.floor(room))}px`;
  const size = root.getBoundingClientRect();
  const top = above
    ? Math.max(margin, box.top - pop.clear - margin - size.height)
    : Math.min(box.bottom + pop.clear + margin, Math.max(margin, viewH - margin - size.height));
  const left = Math.min(Math.max(margin, box.left), Math.max(margin, window.innerWidth - size.width - margin));
  root.style.top = `${Math.round(top)}px`;
  root.style.left = `${Math.round(left)}px`;
}

// Up for the selected shape (or the one being typed in), down when there is
// none. Called on every change to the shapes' settings or the selection.
export function syncShapeStylePopover() {
  const record = targetShapeRecord();
  // The pen bar's own panel, open on the same controls, is one too many.
  const railPanel = document.querySelector('#inkRailPopover:not([hidden]) [data-ink-panel="shape"]:not([hidden])');
  if (!record || el.documentStage?.hidden || railPanel) {
    if (shapeStylePop) {
      shapeStylePop.root.hidden = true;
      shapeStylePop.id = null;
      shapeStylePop.trayFor = null;
      shapeStylePop.sideFor = null;
    }
    return;
  }
  const pop = shapeStylePop || buildShapeStylePopover();
  const type = record.shape?.type;
  // A different shape shuts the tray — it was opened for that one.
  if (pop.trayFor !== record.id) {
    delete pop.section.dataset.shapeTray;
    pop.trayFor = record.id;
  }
  // Asked of pdf-shapes.js as well as of the editor: the editor says which
  // shape it is opening for (setEditingShapeId) a moment BEFORE it is up, and
  // that announcement is what brings this popover here — so at that instant
  // isEditingShapeText() is still false.
  const typing = isEditingShapeText() || editingShapeTextId() === record.id;
  // While typing, the words are what the reader is doing: the style, and Done.
  if (typing && shapeTray(pop.section) === "more") delete pop.section.dataset.shapeTray;
  pop.id = record.id;
  pop.root.dataset.shapeType = type || "";
  refreshShapePanel(pop.section);
  pop.root.querySelectorAll("[data-shape-style-action]").forEach((button) => {
    const action = button.dataset.shapeStyleAction;
    if (action === "done") { button.hidden = false; return; }
    if (action === "edit-text") { button.hidden = typing || !(type === "text" || type === "callout"); return; }
    button.hidden = typing;
  });
  pop.root.querySelector('[data-shape-style-action="more"]')?.setAttribute("aria-expanded", String(shapeTray(pop.section) === "more"));
  pop.root.hidden = false;
  placeShapeStylePopover();
}

// The bar up for this shape with its colours open — for the mark menu's Style
// row, which is the reader asking for the style by name.
export function expandShapeStylePopover(id) {
  const pop = shapeStylePop || buildShapeStylePopover();
  if (id) {
    pop.trayFor = id;
    pop.section.dataset.shapeTray = "colour";
  }
  syncShapeStylePopover();
}

// A tray open under (or over) the bar.
export function isShapeStylePanelExpanded() {
  return Boolean(shapeStylePop && !shapeStylePop.root.hidden && shapeTray(shapeStylePop.section));
}

export function initShapeStylePopover() {
  // A shape's menu has a Style row (src/notes/mark-menu.js): this is it — the
  // shape picked up, so its popover comes up at it, with any tool armed.
  setDocumentShapeStyler((id) => {
    selectShape(id);
    expandShapeStylePopover(id);
  });
}
