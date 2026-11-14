// Typing into a callout or a text box, where it is on the page.
//
// Plain text, typed in place: the words appear in the box on the paper, at the
// size and in the colour they will be shown in, and the box grows downward as
// the lines run out. Markdown, maths and pictures are what a block is for
// (src/documents/pdf-blocks.js); this is the quick label — "see Fig. 3", "sign
// error here" — and it is quick because there is nothing between the reader and
// the box: no sheet, no Done button.
//
// The editor is a contenteditable laid exactly over the shape's own text box
// (its size, padding and font are the ones paintDocumentShapes gives that box),
// in the shape layer, the one element there that takes pointer events. It
// commits when it loses focus or on Escape, as one undo step: the words, and
// the box's new size. A text box left empty is taken away again — an empty
// one is a thing on the page nobody can see.
//
// A box that wraps (Wrap, or one given a width by hand) carries two grips while
// it is typed in — its right edge and its bottom-right corner — so it can be
// made wider, narrower or taller without putting the words down first. A drag
// moves only the editor; the size it leaves is written with the words, in the
// same undo step.

import { el } from "../core/dom.js?v=__BUILD__";
import { SHAPE_TEXT_PAD, TEXT_BOX_DEFAULT, moveShapeHandle, normalizeShape, shapeHandles, shapeTextNeedsRendering } from "../render/annot-shapes.js?v=__BUILD__";
import { documentHighlightById } from "./pdf-highlights.js?v=__BUILD__";
import { applyShapeTextTurn } from "./pdf-shape-markdown.js?v=__BUILD__";
import { deleteShape, paintDocumentShapes, selectShape, setEditingShapeId, setShapePaintedHook, setShapeTextEditHandler, untransformedClientRect, updateShape } from "./pdf-shapes.js?v=__BUILD__";
import { pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { inkPaperBg } from "./pdf-ink.js?v=__BUILD__";
import { paperRecolor } from "../format/paper-tones.js?v=__BUILD__";
import { attachShapeTextFormatBar, detachShapeTextFormatBar, SHAPE_TEXT_FORMAT_BAR_CLASS } from "./pdf-shape-text-format.js?v=__BUILD__";
import { closeMarkMenu } from "../notes/mark-menu.js?v=__BUILD__";

export const PDF_SHAPE_EDITOR_CLASS = "pdf-shape-editor";
export const PDF_SHAPE_EDITOR_GRIP_CLASS = "pdf-shape-editor-grip";

// The handles of src/render/annot-shapes.js shapeHandles a grip stands for.
const EDITOR_GRIPS = ["e", "se"];

let shapeEditor = null;
// A grip being dragged: the editor must not take the focus going for a blur.
let gripDrag = null;

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
  // Recoloured for the paper exactly as the painted words are (pdf-shapes.js
  // paints through paperRecolor too). Black chosen on a black page was drawn
  // light once put down and typed in black — invisible — while open.
  const colour = shape.font.color || (shape.type === "text" ? shape.stroke : "#16181d");
  const recolor = paperRecolor(inkPaperBg());
  node.style.color = recolor ? recolor(colour) : colour;
  // Typed in turned, as it will be shown.
  applyShapeTextTurn(node, shape.rot || 0);
}

// The shape the editor is showing: the record's, at the size a grip has
// dragged it to (nothing is written until the words are put down).
function editorShape(editor, shape) {
  return editor?.geometry && shape && !shape.fit ? { ...shape, p: editor.geometry } : shape;
}

// ── The grips ───────────────────────────────────────────────────────────────

// Up on a box that wraps, gone from one that grows with its words — and laid on
// the editor as it is laid out NOW (its words may have made it taller than the
// record), turned with it about its middle.
function placeEditorGrips(editor, shape) {
  const { node } = editor;
  const layer = node.parentNode;
  if (!shape || shape.fit || !layer) {
    removeEditorGrips(editor);
    return;
  }
  if (!editor.grips) {
    editor.grips = EDITOR_GRIPS.map((id) => makeEditorGrip(id));
  }
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const cx = (parseFloat(node.style.left) || 0) + width / 2;
  const cy = (parseFloat(node.style.top) || 0) + height / 2;
  const turn = -(shape.rot || 0);
  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  editor.grips.forEach((grip) => {
    if (grip.parentNode !== layer) layer.appendChild(grip);
    const lx = width / 2;
    const ly = grip.dataset.grip === "se" ? height / 2 : 0;
    grip.style.left = `${cx + lx * cos - ly * sin}px`;
    grip.style.top = `${cy + lx * sin + ly * cos}px`;
    grip.style.setProperty("--grip-turn", `${turn}deg`);
  });
}

function removeEditorGrips(editor) {
  editor?.grips?.forEach((grip) => grip.remove());
  if (editor) editor.grips = null;
}

function makeEditorGrip(id) {
  const grip = document.createElement("div");
  grip.className = PDF_SHAPE_EDITOR_GRIP_CLASS;
  grip.dataset.grip = id;
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("pointerdown", onGripDown);
  grip.addEventListener("pointermove", onGripMove);
  grip.addEventListener("pointerup", onGripUp);
  grip.addEventListener("pointercancel", onGripUp);
  grip.addEventListener("lostpointercapture", onGripUp);
  // Neither the focus nor the page's own press: the words stay open.
  for (const type of ["mousedown", "touchstart"]) {
    grip.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
  }
  for (const type of ["click", "dblclick"]) {
    grip.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation(); });
  }
  return grip;
}

// A point on the page, in PDF space — as src/documents/pdf-shapes.js reads one.
function gripPdfPoint(editor, clientX, clientY) {
  const viewport = pdfPageViewport(editor.page);
  const pageEl = editor.node.closest(".pdf-page");
  if (!viewport || !pageEl) return null;
  const box = pageEl.getBoundingClientRect();
  return viewport.convertToPdfPoint(clientX - box.left, clientY - box.top);
}

function onGripDown(event) {
  const editor = shapeEditor;
  const grip = event.currentTarget;
  event.preventDefault();
  event.stopPropagation();
  if (!editor || (event.button !== undefined && event.button > 0)) return;
  const record = documentHighlightById(editor.id);
  const viewport = pdfPageViewport(editor.page);
  let base = editorShape(editor, normalizeShape(record?.shape));
  const from = gripPdfPoint(editor, event.clientX, event.clientY);
  if (!base || base.fit || !viewport || !from) return;
  // Words that have made the box taller than the record: the drag starts from
  // the box as it is on screen, so the corner does not jump up to the record's.
  const handles = shapeHandles(base);
  const n = handles.find((h) => h.id === "n");
  const s = handles.find((h) => h.id === "s");
  const stored = n && s ? Math.hypot(s.x - n.x, s.y - n.y) : 0;
  const shown = editor.node.offsetHeight / (viewport.scale || 1);
  if (stored > 0 && shown > stored + 0.5) {
    const k = shown / stored;
    base = moveShapeHandle(base, "s", n.x + (s.x - n.x) * k, n.y + (s.y - n.y) * k);
  }
  const start = shapeHandles(base).find((h) => h.id === grip.dataset.grip);
  if (!start) return;
  gripDrag = { pointerId: event.pointerId, grip, id: grip.dataset.grip, base, from, start };
  grip.classList.add("is-dragging");
  try { grip.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
}

function onGripMove(event) {
  const drag = gripDrag;
  const editor = shapeEditor;
  if (!drag || event.pointerId !== drag.pointerId || !editor) return;
  event.preventDefault();
  event.stopPropagation();
  const at = gripPdfPoint(editor, event.clientX, event.clientY);
  const viewport = pdfPageViewport(editor.page);
  if (!at || !viewport) return;
  const next = moveShapeHandle(drag.base, drag.id,
    drag.start.x + (at[0] - drag.from[0]), drag.start.y + (at[1] - drag.from[1]));
  // Never narrower than a couple of letters, nor turned inside out.
  const size = drag.base.font.size;
  const wide = next.p[1][0] - next.p[0][0];
  const tall = next.p[1][1] - next.p[0][1];
  if (wide < size * 2 || tall < size * 1.3 + SHAPE_TEXT_PAD * 2 - 0.5) return;
  editor.geometry = next.p.map((point) => point.slice());
  placeShapeEditor(editor.node, viewport, next);
  placeEditorGrips(editor, next);
}

function onGripUp(event) {
  const drag = gripDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  gripDrag = null;
  drag.grip.classList.remove("is-dragging");
  try { drag.grip.releasePointerCapture(event.pointerId); } catch (_) { /* gone */ }
  const editor = shapeEditor;
  if (editor && document.activeElement !== editor.node) editor.node.focus({ preventScroll: true });
}

// Open the editor over a callout's or a text box's words.
export function openShapeTextEditor(recordOrId) {
  const record = typeof recordOrId === "string" ? documentHighlightById(recordOrId) : recordOrId;
  const shape = normalizeShape(record?.shape);
  if (!record || !shape || (shape.type !== "callout" && shape.type !== "text")) return false;
  if (shapeEditor) commitShapeTextEditor();
  // A highlight menu left open is about something else now.
  closeMarkMenu();
  const page = Number(record.page);
  const viewport = pdfPageViewport(page);
  if (!viewport) return false;
  setEditingShapeId(record.id);
  selectShape(null);
  paintDocumentShapes(page);
  const layer = (el.documentView || document).querySelector(`.pdf-page[data-page-number="${page}"] > .pdf-shape-layer`);
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
  shapeEditor = { node, id: record.id, page, before: shape, geometry: null, grips: null, resize: null };
  hideStaticText(layer, record.id);
  // The grips follow the box as its words make it taller.
  placeEditorGrips(shapeEditor, shape);
  if (typeof ResizeObserver === "function") {
    const editor = shapeEditor;
    editor.resize = new ResizeObserver(() => {
      if (shapeEditor !== editor) return;
      placeEditorGrips(editor, editorShape(editor, normalizeShape(documentHighlightById(editor.id)?.shape)));
    });
    editor.resize.observe(node);
  }

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
    const to = event.relatedTarget;
    // A grip being dragged is resizing this box, not finishing it.
    if (gripDrag || to?.closest?.(`.${PDF_SHAPE_EDITOR_GRIP_CLASS}`)) {
      requestAnimationFrame(() => { if (shapeEditor?.node === node) node.focus({ preventScroll: true }); });
      return;
    }
    // A press on a BUTTON of the style popover (A+, bold, a swatch) restyles
    // these words as they are typed (setShapeSettings acts on the shape being
    // edited) — so typing carries on, rather than the words being put down.
    // The popover keeps focus off itself for a mouse; this is the backstop.
    // ...and the same for the bar over the picked words (B, I, a colour).
    if ((to?.closest?.(".shape-style-popover") && to.matches?.("button")) || to?.closest?.(`.${SHAPE_TEXT_FORMAT_BAR_CLASS}`)) {
      requestAnimationFrame(() => { if (shapeEditor?.node === node) node.focus({ preventScroll: true }); });
      return;
    }
    // Anywhere else — the rail's panel, a slider, the page — commits, which is
    // what lets a press on the rail's panel restyle the box it was about.
    commitShapeTextEditor({ to });
  });
  // A press inside the box is the box's — placing the caret, picking words.
  // `click` too: let through, the page's tap handler hit-tested the box's own
  // record and opened its highlight menu over the words being typed (pinned to
  // the window's corner, and recolouring the whole box from there).
  for (const type of ["pointerdown", "touchstart", "mousedown", "click", "dblclick"]) {
    node.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  }
  // B, I and colours for words picked in the box (src/documents/pdf-shape-
  // text-format.js) — up only while there is a selection here.
  attachShapeTextFormatBar(node);
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
  gripDrag = null;
  editor.resize?.disconnect();
  removeEditorGrips(editor);
  detachShapeTextFormatBar();
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
  // The box's top edge is where the reader put it, and its width is the one
  // the grips left it. Its height is the words' — but only PLAIN words are
  // shown here as they will be on the page. Markdown is typed as its source,
  // and a mermaid fence, a table or a list of `**…**` is far taller as source
  // than rendered: sizing the box to the editor gave it the source's height,
  // an empty tail under the words. For those the fitter (fitShapeTextBoxes in
  // pdf-shapes.js) sets the height from the rendered words once they are in.
  const p = editorShape(editor, shape).p.map((point) => point.slice());
  if (viewport && height > 0 && !shapeTextNeedsRendering(text)) {
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
  const editor = shapeEditor;
  const shape = normalizeShape(documentHighlightById(editor.id)?.shape);
  const viewport = pdfPageViewport(pageNumber);
  if (shape && viewport) {
    // Wrap turned on while typing in text that grew with its words: its record
    // is still the box the first tap made (a couple of letters wide), so it
    // wraps from the box on screen instead — no narrower than a new text box.
    if (!shape.fit && editor.node.hasAttribute("data-fit") && !editor.geometry) {
      editor.geometry = wrapFromTypewriter(editor, shape, viewport);
    }
    if (shape.fit) editor.geometry = null;
    const shown = editorShape(editor, shape);
    placeShapeEditor(editor.node, viewport, shown);
    placeEditorGrips(editor, shown);
  }
  hideStaticText(layer, editor.id);
});

// The box the typewriter editor is showing, as a box that wraps: its top-left
// where it is, as wide as its longest line or a new text box, whichever is
// wider (but not past the page's right edge), and as tall as it is.
function wrapFromTypewriter(editor, shape, viewport) {
  const scale = viewport.scale || 1;
  const left = parseFloat(editor.node.style.left) || 0;
  const top = parseFloat(editor.node.style.top) || 0;
  const room = Math.max(0, viewport.width - left);
  const width = Math.min(room, Math.max(editor.node.offsetWidth, TEXT_BOX_DEFAULT.width * scale));
  const height = editor.node.offsetHeight;
  if (!(width > 0) || !(height > 0)) return null;
  const [ax, ay] = viewport.convertToPdfPoint(left, top);
  const [bx, by] = viewport.convertToPdfPoint(left + width, top + height);
  return [[Math.min(ax, bx), Math.min(ay, by)], [Math.max(ax, bx), Math.max(ay, by)], ...shape.p.slice(2)];
}

setShapeTextEditHandler((record) => openShapeTextEditor(record));
