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
import { applyShapeTextTurn } from "./pdf-shape-markdown.js?v=__BUILD__";
import { deleteShape, paintDocumentShapes, selectShape, setEditingShapeId, setShapePaintedHook, setShapeTextEditHandler, untransformedClientRect, updateShape } from "./pdf-shapes.js?v=__BUILD__";
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
  if (shape.fit) {
    // The typewriter: as wide as what is typed, a line per Enter, never past
    // the page's right edge.
    node.dataset.fit = "";
    node.style.width = "auto";
    node.style.minWidth = `${shape.font.size * scale * 1.5}px`;
    node.style.maxWidth = `${Math.max(40, viewport.width - Math.min(ax, bx))}px`;
  } else {
    // Wrapping at the box's width (Wrap, or a box given a width by hand).
    delete node.dataset.fit;
    node.style.minWidth = "";
    node.style.maxWidth = "";
    node.style.width = `${Math.abs(bx - ax)}px`;
  }
  node.style.minHeight = `${Math.abs(by - ay)}px`;
  node.style.padding = `${SHAPE_TEXT_PAD * scale}px`;
  node.style.fontSize = `${shape.font.size * scale}px`;
  node.style.fontWeight = shape.font.bold ? "700" : "400";
  node.style.textAlign = shape.font.align;
  node.style.color = shape.font.color || (shape.type === "text" ? shape.stroke : "#16181d");
  // Typed in turned, as it will be shown.
  applyShapeTextTurn(node, shape.rot || 0);
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
  node.addEventListener("blur", (event) => {
    if (shapeEditor?.node !== node) return;
    // A press on a BUTTON of the style popover (A+, bold, a swatch) restyles
    // these words as they are typed (setShapeSettings acts on the shape being
    // edited) — so typing carries on, rather than the words being put down.
    // The popover keeps focus off itself for a mouse; this is the backstop.
    const to = event.relatedTarget;
    if (to?.closest?.(".shape-style-popover") && to.matches?.("button")) {
      requestAnimationFrame(() => { if (shapeEditor?.node === node) node.focus({ preventScroll: true }); });
      return;
    }
    // Anywhere else — the rail's panel, a slider, the page — commits, which is
    // what lets a press on the rail's panel restyle the box it was about.
    commitShapeTextEditor({ to });
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

// Told after every commit, whether the words were kept or (empty) dropped —
// src/ui/ink-rail.js puts the Text tool away here, so one press of T is one
// box and nobody has to press Done after every line. A hook rather than an
// import because ink-rail.js already imports this module's neighbours.
let shapeTextCommittedHook = () => {};

export function setShapeTextCommittedHandler(fn) {
  shapeTextCommittedHook = typeof fn === "function" ? fn : () => {};
}

// The words typed, and the box grown to hold them — one undo step.
// `to` is where the focus went when a blur committed it, so the hook can tell
// "finished" from "went to restyle these words on the pen's bar".
export function commitShapeTextEditor({ to = null } = {}) {
  if (!shapeEditor) return;
  putShapeTextDown();
  shapeTextCommittedHook({ to });
}

function putShapeTextDown() {
  const editor = shapeEditor;
  if (!editor) return;
  shapeEditor = null;
  setEditingShapeId(null);
  const record = documentHighlightById(editor.id);
  const text = String(editor.node.innerText ?? editor.node.textContent ?? "").replace(/\r/g, "").replace(/\n+$/, "");
  const viewport = pdfPageViewport(editor.page);
  const pageEl = editor.node.closest(".pdf-page");
  const measured = untransformedClientRect(editor.node, pageEl);
  const pageBox = pageEl?.getBoundingClientRect() || null;
  const height = measured.height;
  editor.node.remove();
  if (!record) { paintDocumentShapes(editor.page); return; }
  const shape = normalizeShape(record.shape);
  if (shape.type === "text" && !text.trim()) {
    deleteShape(record.id);
    return;
  }
  // Typewriter text is boxed to exactly what was typed: its top-left stays
  // where the reader tapped, and the box ends where the words do.
  if (shape.fit && viewport && pageBox && measured.width > 0) {
    const [ax, ay] = viewport.convertToPdfPoint(measured.left - pageBox.left, measured.top - pageBox.top);
    const [bx, by] = viewport.convertToPdfPoint(measured.right - pageBox.left, measured.bottom - pageBox.top);
    const fitted = [[Math.min(ax, bx), Math.min(ay, by)], [Math.max(ax, bx), Math.max(ay, by)]];
    const changedFit = updateShape(record.id, { ...shape, text, p: fitted });
    if (!changedFit) paintDocumentShapes(editor.page);
    selectShape(record.id);
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
// ...and laid over the shape as it is NOW, so a restyle while typing (bigger,
// bold, another colour, from the style popover) shows under the cursor at once.
setShapePaintedHook((pageNumber, layer) => {
  if (!shapeEditor || shapeEditor.page !== pageNumber) return;
  if (!shapeEditor.node.isConnected) layer.appendChild(shapeEditor.node);
  const shape = normalizeShape(documentHighlightById(shapeEditor.id)?.shape);
  const viewport = pdfPageViewport(pageNumber);
  if (shape && viewport) placeShapeEditor(shapeEditor.node, viewport, shape);
  hideStaticText(layer, shapeEditor.id);
});

setShapeTextEditHandler((record) => openShapeTextEditor(record));
