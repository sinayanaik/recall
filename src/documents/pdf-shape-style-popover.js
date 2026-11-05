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
// drawn — or its words are open to type in, this popover floats under it with
// the shape panel (src/documents/pdf-shape-panel.js, built a second time):
// colour, size, bold and alignment for text; colour, width, line and heads for
// an arrow; a box's fill. Each press goes through setShapeSettings, which
// restyles THAT shape as one undo step (and, while its words are being typed,
// shows the change under the cursor — src/documents/pdf-shape-text.js).
// Underneath: Edit text, its note, Delete, and ⋯ for the rest of its menu.
//
// It follows the selection rather than being opened and shut by hand: ink-rail
// calls syncShapeStylePopover from the shapes' one change hook, so whatever puts
// a shape down — a tap elsewhere, Escape, Delete, undo — takes this with it.

import { el } from "../core/dom.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";
import { DOCUMENT_MARK_HANDLERS, DOCUMENT_NOTE_HANDLERS, documentHighlightNote, setDocumentShapeStyler } from "./pdf-highlights.js?v=__BUILD__";
import { buildShapePanel, refreshShapePanel } from "./pdf-shape-panel.js?v=__BUILD__";
import { commitShapeTextEditor, isEditingShapeText, openShapeTextEditor } from "./pdf-shape-text.js?v=__BUILD__";
import { deleteShape, selectShape, shapeScreenRect, targetShapeRecord } from "./pdf-shapes.js?v=__BUILD__";

export const SHAPE_STYLE_POPOVER_CLASS = "shape-style-popover";

let shapeStylePop = null;
let shapeStylePlaceFrame = 0;

export function isShapeStylePopoverOpen() {
  return Boolean(shapeStylePop && !shapeStylePop.root.hidden);
}

function shapeStyleFootButton(action, label, { word = label, danger = false } = {}) {
  return `<button type="button" class="tool-button shape-style-btn${danger ? " is-danger" : ""}" data-shape-style-action="${action}" title="${label}" aria-label="${label}">${word}</button>`;
}

function buildShapeStylePopover() {
  const root = document.createElement("div");
  root.className = SHAPE_STYLE_POPOVER_CLASS;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Style");
  root.hidden = true;
  const section = buildShapePanel(root, { floating: true });
  const footer = document.createElement("div");
  footer.className = "shape-style-foot";
  footer.innerHTML = [
    shapeStyleFootButton("edit-text", "Edit the text", { word: "Edit text" }),
    shapeStyleFootButton("note", "Add or edit a note", { word: "Note" }),
    shapeStyleFootButton("delete", "Delete", { danger: true }),
    shapeStyleFootButton("more", "More — a card, copy, the Highlights pane", { word: "&#8943;" }),
    shapeStyleFootButton("done", "Done", { word: "&#10003;" })
  ].join("");
  root.appendChild(footer);
  document.body.appendChild(root);

  // A press here must not take focus from the words being typed — A+ halfway
  // through a sentence restyles it and the typing goes on. Not for the inputs:
  // a slider and the colour picker need the focus to work at all.
  root.addEventListener("mousedown", (event) => {
    if (event.target.closest("input, label")) return;
    event.preventDefault();
  });
  // ...and nothing here is a press on the page underneath.
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
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
  });
  const reposition = () => {
    if (shapeStylePlaceFrame) return;
    shapeStylePlaceFrame = requestAnimationFrame(() => { shapeStylePlaceFrame = 0; placeShapeStylePopover(); });
  };
  window.addEventListener("resize", reposition);
  // Capture: what moves the page is the document's scroller, and a scroll
  // event does not bubble. Input: typed text grows, and this sits under it.
  document.addEventListener("scroll", reposition, true);
  document.addEventListener("input", reposition, true);
  // Leaving the PDFs or Canvas tab hides the stage, not the selection: the
  // popover goes with the stage, and comes back with it.
  if (el.documentStage && typeof MutationObserver === "function") {
    new MutationObserver(() => syncShapeStylePopover()).observe(el.documentStage, { attributes: true, attributeFilter: ["hidden"] });
  }
  shapeStylePop = { root, section, footer, id: null };
  return shapeStylePop;
}

function pressShapeStyle(action) {
  const record = targetShapeRecord();
  if (!record) return;
  const id = record.id;
  if (action === "edit-text") {
    openShapeTextEditor(id);
  } else if (action === "note") {
    const rect = shapeScreenRect(record);
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
    openHighlightNoteEditor(id, rect, documentHighlightNote(id), DOCUMENT_NOTE_HANDLERS);
  } else if (action === "delete") {
    if (isEditingShapeText()) commitShapeTextEditor();
    deleteShape(id);
  } else if (action === "more") {
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
    const anchor = el.documentView?.querySelector(`.pdf-shape[data-highlight-id="${CSS.escape(id)}"]`)
      || el.documentView?.querySelector(`.pdf-shape-text[data-highlight-id="${CSS.escape(id)}"]`);
    if (anchor) openMarkMenuWith(anchor, id, DOCUMENT_MARK_HANDLERS, record.color || MARK_HIGHLIGHT_DEFAULT);
  } else if (action === "done") {
    if (isEditingShapeText()) commitShapeTextEditor();
    selectShape(null);
  }
}

// Under the shape if there is room, over it if not, clamped to the screen —
// openBlockStylePopover's rule. While its words are being typed, under the
// editor, which grows as they are.
function placeShapeStylePopover() {
  if (!shapeStylePop || shapeStylePop.root.hidden) return;
  const record = targetShapeRecord();
  if (!record || el.documentStage?.hidden) { shapeStylePop.root.hidden = true; return; }
  const editor = el.documentView?.querySelector(`.pdf-shape-editor[data-highlight-id="${CSS.escape(record.id)}"]`);
  const box = editor?.getBoundingClientRect() || shapeScreenRect(record);
  if (!box) return;
  const root = shapeStylePop.root;
  const size = root.getBoundingClientRect();
  const margin = 8;
  const below = box.bottom + margin;
  const top = below + size.height > window.innerHeight - margin
    ? Math.max(margin, box.top - size.height - margin)
    : below;
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
    if (shapeStylePop) { shapeStylePop.root.hidden = true; shapeStylePop.id = null; }
    return;
  }
  const pop = shapeStylePop || buildShapeStylePopover();
  const type = record.shape?.type;
  pop.id = record.id;
  pop.root.dataset.shapeType = type || "";
  refreshShapePanel(pop.section);
  const editText = pop.footer.querySelector('[data-shape-style-action="edit-text"]');
  editText.hidden = !(type === "text" || type === "callout") || isEditingShapeText();
  pop.root.hidden = false;
  placeShapeStylePopover();
}

export function initShapeStylePopover() {
  // A shape's menu has a Style row (src/notes/mark-menu.js): this is it — the
  // shape picked up, so its popover comes up at it, with any tool armed.
  setDocumentShapeStyler((id) => {
    selectShape(id);
    syncShapeStylePopover();
  });
}
