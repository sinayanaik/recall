// Typing into a callout or a text box, where it is on the page.
//
// Plain text, typed in place: the words appear in the box on the paper, at the
// size and in the colour they will be shown in, and the box grows downward as
// the lines run out. Markdown, maths and pictures are what a text block is for
// (src/documents/pdf-blocks.js); this is the quick label — "see Fig. 3", "sign
// error here" — and it is quick because there is nothing between the reader and
// the box: no sheet, no Done button.
//
// The editor is a contenteditable laid exactly over the shape's own text box
// (its size, padding and font are the ones paintDocumentShapes gives that box),
// in the shape layer, the one element there that takes pointer events. It
// commits when it loses focus or on Escape, as one undo step: the words, and
// the box's new height. A text box left empty is taken away again — an empty
// one is a thing on the page nobody can see.

import { SHAPE_TEXT_PAD, normalizeShape } from "../render/annot-shapes.js?v=__BUILD__";
import { documentHighlightById } from "./pdf-highlights.js?v=__BUILD__";
import { deleteShape, paintDocumentShapes, selectShape, setEditingShapeId, setShapePaintedHook, setShapeTextEditHandler, updateShape } from "./pdf-shapes.js?v=__BUILD__";
import { pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const PDF_SHAPE_EDITOR_CLASS = "pdf-shape-editor";

let shapeEditor = null;

export function isEditingShapeText() {
  return Boolean(shapeEditor);
}

function placeShapeEditor(node, viewport, shape) {
  const scale = viewport.scale || 1;
  const [x0, y0, x1, y1] = shape.type === "sticky" ? [0, 0, 0, 0] : [
    Math.min(shape.p[0][0], shape.p[1][0]), Math.min(shape.p[0][1], shape.p[1][1]),
    Math.max(shape.p[0][0], shape.p[1][0]), Math.max(shape.p[0][1], shape.p[1][1])
  ];
  const [ax, ay] = viewport.convertToViewportPoint(x0, y1);
  const [bx, by] = viewport.convertToViewportPoint(x1, y0);
  node.style.left = `${Math.min(ax, bx)}px`;
  node.style.top = `${Math.min(ay, by)}px`;
  node.style.width = `${Math.abs(bx - ax)}px`;
  node.style.minHeight = `${Math.abs(by - ay)}px`;
  node.style.padding = `${SHAPE_TEXT_PAD * scale}px`;
  node.style.fontSize = `${shape.font.size * scale}px`;
  node.style.fontWeight = shape.font.bold ? "700" : "400";
  node.style.textAlign = shape.font.align;
  node.style.color = shape.font.color || (shape.type === "text" ? shape.stroke : "#16181d");
}

// Open the editor over a callout's or a text box's words.
export function openShapeTextEditor(recordOrId) {
  const record = typeof recordOrId === "string" ? documentHighlightById(recordOrId) : recordOrId;
  const shape = normalizeShape(record?.shape);
  if (!record || !shape || (shape.type !== "callout" && shape.type !== "text")) return false;
  if (shapeEditor) commitShapeTextEditor();
  const page = Number(record.page);
  const viewport = pdfPageViewport(page);
  if (!viewport) return false;
  setEditingShapeId(record.id);
  selectShape(null);
  paintDocumentShapes(page);
  const layer = document.querySelector(`.pdf-page[data-page-number="${page}"] > .pdf-shape-layer`);
  if (!layer) { setEditingShapeId(null); return false; }
  const node = document.createElement("div");
  node.className = PDF_SHAPE_EDITOR_CLASS;
  node.dataset.highlightId = record.id;
  node.setAttribute("role", "textbox");
  node.setAttribute("aria-multiline", "true");
  node.setAttribute("aria-label", shape.type === "callout" ? "Callout text" : "Text");
  node.spellcheck = true;
  node.contentEditable = "plaintext-only";
  if (node.contentEditable !== "plaintext-only") node.contentEditable = "true";
  node.textContent = shape.text;
  placeShapeEditor(node, viewport, shape);
  layer.appendChild(node);
  shapeEditor = { node, id: record.id, page, before: shape };
  hideStaticText(layer, record.id);

  node.addEventListener("keydown", (event) => {
    // Inside the box, keys are the box's: nothing here is a shortcut for the
    // page, the deck or the pen.
    event.stopPropagation();
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      commitShapeTextEditor();
    }
  });
  // Plain text only, even where contenteditable is not plaintext-only.
  node.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  });
  node.addEventListener("blur", () => {
    // A press on the rail's panel (the text size, bold) blurs the editor first;
    // committing then is what lets that press restyle the box it was about.
    if (shapeEditor?.node === node) commitShapeTextEditor();
  });
  for (const type of ["pointerdown", "touchstart", "mousedown"]) {
    node.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }
  requestAnimationFrame(() => {
    node.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  return true;
}

function hideStaticText(layer, id) {
  layer.querySelectorAll(`.pdf-shape-text[data-highlight-id="${CSS.escape(id)}"]`).forEach((box) => { box.style.visibility = "hidden"; });
}

// The words typed, and the box grown to hold them — one undo step.
export function commitShapeTextEditor() {
  const editor = shapeEditor;
  if (!editor) return;
  shapeEditor = null;
  setEditingShapeId(null);
  const record = documentHighlightById(editor.id);
  const text = String(editor.node.innerText ?? editor.node.textContent ?? "").replace(/\r/g, "").replace(/\n+$/, "");
  const viewport = pdfPageViewport(editor.page);
  const height = editor.node.getBoundingClientRect().height;
  editor.node.remove();
  if (!record) { paintDocumentShapes(editor.page); return; }
  const shape = normalizeShape(record.shape);
  if (shape.type === "text" && !text.trim()) {
    deleteShape(record.id);
    return;
  }
  // Down, never up: the box's top edge is where the reader put it.
  const p = shape.p.map((point) => point.slice());
  if (viewport && height > 0) {
    const top = Math.max(p[0][1], p[1][1]);
    const bottom = Math.min(p[0][1], p[1][1]);
    const needed = height / (viewport.scale || 1);
    if (top - bottom < needed - 0.5) {
      const lowIndex = p[0][1] <= p[1][1] ? 0 : 1;
      p[lowIndex][1] = top - needed;
    }
  }
  const changed = updateShape(record.id, { ...shape, text, p });
  if (!changed) paintDocumentShapes(editor.page);
  selectShape(record.id);
}

// A repaint of the page clears its layer; the editor is kept, and the static
// copy of the words it is standing over is hidden again.
setShapePaintedHook((pageNumber, layer) => {
  if (!shapeEditor || shapeEditor.page !== pageNumber) return;
  if (!shapeEditor.node.isConnected) layer.appendChild(shapeEditor.node);
  hideStaticText(layer, shapeEditor.id);
});

setShapeTextEditHandler((record) => openShapeTextEditor(record));
