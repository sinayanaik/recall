// Typed blocks on a page you write on by hand.
//
// A page of working usually wants both: a derivation in your own hand, and the
// statement of the problem typed above it. Handwriting is quick and unreadable
// by anything; typed text is slower and readable by everything. So a block is
// markdown, rendered through the same pipeline every other surface in this app
// uses, dropped where you put it and moved and resized with a finger.
//
// ── Why they live in PDF user space ───────────────────────────────────────
//
// For exactly the reason the strokes do (src/documents/pdf-ink.js): a position
// in the DOCUMENT survives a zoom, a refit, a rotation, a reload and a second
// device, and a position in screen pixels survives none of them. A block is a
// rectangle in points on a page, and the viewport pdf.js hands back is what
// turns that into a box on the glass — the same transform, so a block and the
// ink beside it move together and cannot drift apart.
//
// That also means blocks work on ANY paper, not only on a notebook's generated
// pages. Typing a note over a figure in somebody's preprint is the same feature.
//
// ── Pointer mechanics ─────────────────────────────────────────────────────
//
// Modelled on the image resize grip in src/images/surface-controls.js: capture
// the pointer so a fast drag that leaves the element keeps the gesture, throttle
// the move to one style write per frame, and take the document-level listeners
// off again in the up handler — a leaked pointermove listener is the "stray
// element that follows the cursor" bug.
//
// Every press here stops propagating, and pdf-ink.js stands down for anything
// inside a block (PDF_BLOCK_CLASS). Without that pair a pen press meant to move
// a block would also draw a stroke, every time.

import { PDF_BLOCK_CLASS, PDF_BLOCK_LAYER_CLASS } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

// In PDF points. A block narrower than this cannot show a line of text, and one
// shorter cannot be grabbed by its own bar.
export const PDF_BLOCK_MIN_WIDTH = 90;
export const PDF_BLOCK_MIN_HEIGHT = 34;
const PDF_BLOCK_DEFAULT_WIDTH = 240;
const PDF_BLOCK_DEFAULT_HEIGHT = 90;

let editingId = null;
let onBlocksChanged = () => {};

export function setBlocksChangedHandler(fn) {
  onBlocksChanged = typeof fn === "function" ? fn : () => {};
}

export function documentBlocks(pageNumber = null) {
  const list = Array.isArray(state.meta?.pdfBlocks) ? state.meta.pdfBlocks : [];
  const out = list
    .filter((block) => block && typeof block === "object" && block.id)
    .map((block) => ({
      id: String(block.id),
      page: Number(block.page) || 1,
      x: Number(block.x) || 0,
      y: Number(block.y) || 0,
      w: Math.max(PDF_BLOCK_MIN_WIDTH, Number(block.w) || PDF_BLOCK_DEFAULT_WIDTH),
      h: Math.max(PDF_BLOCK_MIN_HEIGHT, Number(block.h) || PDF_BLOCK_DEFAULT_HEIGHT),
      z: Number(block.z) || 0,
      md: typeof block.md === "string" ? block.md : "",
      at: Number(block.at) || 0
    }));
  return pageNumber === null ? out : out.filter((block) => block.page === Number(pageNumber));
}

function writeBlocks(next, { removed = null } = {}) {
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), pdfBlocks: next };
  if (removed) state.meta.deletedBlockIds = recordDeletedMetaId(state.meta, "deletedBlockIds", removed);
  scheduleDeckAutosave();
  onBlocksChanged();
}

function freshBlockId(taken) {
  for (;;) {
    const id = `bk-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}

// ── Painting ───────────────────────────────────────────────────────────────

function blockLayer(pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return null;
  let layer = pageEl.querySelector(`.${PDF_BLOCK_LAYER_CLASS}`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = PDF_BLOCK_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  return layer;
}

// A rectangle in points onto a box on the glass. Both corners are converted
// because the two coordinate systems disagree about which way y runs, so the
// answer has to be normalised rather than assumed.
function blockBox(viewport, block) {
  const [ax, ay] = viewport.convertToViewportPoint(block.x, block.y);
  const [bx, by] = viewport.convertToViewportPoint(block.x + block.w, block.y + block.h);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  };
}

function placeBlock(node, viewport, block) {
  const box = blockBox(viewport, block);
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
  // The type scales with the page, or a block that fitted at one zoom overflows
  // at the next. `scale` is the viewport's own, so this follows a pinch exactly.
  node.style.setProperty("--pdf-block-scale", String(viewport.scale || 1));
  node.style.zIndex = String(1 + (Number(block.z) || 0));
}

function buildBlock(block) {
  const node = document.createElement("div");
  node.className = PDF_BLOCK_CLASS;
  node.dataset.pdfBlock = block.id;

  const bar = document.createElement("div");
  bar.className = "pdf-block-bar";
  bar.dataset.pdfBlockAction = "drag";
  bar.title = "Drag to move";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "pdf-block-btn";
  edit.dataset.pdfBlockAction = "edit";
  edit.title = "Edit this text";
  edit.setAttribute("aria-label", "Edit this text");
  edit.innerHTML = "&#9998;";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pdf-block-btn is-danger";
  remove.dataset.pdfBlockAction = "delete";
  remove.title = "Delete this block";
  remove.setAttribute("aria-label", "Delete this block");
  remove.innerHTML = "&#128465;";
  bar.append(edit, remove);

  const body = document.createElement("div");
  body.className = "pdf-block-body rendered";

  const area = document.createElement("textarea");
  area.className = "pdf-block-edit";
  area.hidden = true;
  area.setAttribute("aria-label", "Block markdown");

  const grip = document.createElement("span");
  grip.className = "pdf-block-grip";
  grip.dataset.pdfBlockAction = "resize";
  grip.title = "Drag to resize";

  node.append(bar, body, area, grip);
  return node;
}

function paintBlock(node, block) {
  const body = node.querySelector(".pdf-block-body");
  const area = node.querySelector(".pdf-block-edit");
  if (editingId === block.id) {
    area.hidden = false;
    body.hidden = true;
    return;
  }
  area.hidden = true;
  body.hidden = false;
  // An empty block says so. A transparent rectangle you cannot find again is
  // exactly what one added and not yet typed into would otherwise be.
  body.innerHTML = block.md.trim()
    ? markdownToSafeHtml(block.md)
    : '<p class="pdf-block-empty">Empty — press &#9998; to write</p>';
}

// Called as each page finishes painting, through the same hook the ink and the
// note badges take — pdf-view.js must not import this module back.
export function paintDocumentBlocks(pageNumber) {
  const viewport = pdfPageViewport(pageNumber);
  const blocks = documentBlocks(pageNumber);
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl || !viewport) return;
  // A page with no blocks and no layer is left alone, exactly as a page with no
  // ink is: a div per page of a three-hundred-page paper is a real cost for
  // nothing.
  if (!blocks.length && !pageEl.querySelector(`.${PDF_BLOCK_LAYER_CLASS}`)) return;
  const layer = blockLayer(pageNumber);
  if (!layer) return;
  const wanted = new Set(blocks.map((block) => block.id));
  [...layer.children].forEach((node) => {
    if (!wanted.has(node.dataset.pdfBlock)) node.remove();
  });
  blocks.forEach((block) => {
    let node = layer.querySelector(`[data-pdf-block="${block.id}"]`);
    if (!node) { node = buildBlock(block); layer.appendChild(node); }
    placeBlock(node, viewport, block);
    paintBlock(node, block);
  });
}

export function repaintDocumentBlocks() {
  const view = el.documentView;
  if (!view) return;
  view.querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (pageNumber) paintDocumentBlocks(pageNumber);
  });
}

// ── Adding one ─────────────────────────────────────────────────────────────

// Placed at a point on a page, clamped so a block added while scrolled to the
// foot of one is not created off it.
export function addDocumentBlock(pageNumber, at = null) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return null;
  const [pageWidth, pageHeight] = [viewport.viewBox[2] - viewport.viewBox[0], viewport.viewBox[3] - viewport.viewBox[1]];
  const blocks = documentBlocks();
  const wanted = at || { x: pageWidth / 2, y: pageHeight / 2 };
  const block = {
    id: freshBlockId(new Set(blocks.map((b) => b.id))),
    page: Number(pageNumber),
    x: Math.round(Math.max(12, Math.min(pageWidth - PDF_BLOCK_DEFAULT_WIDTH - 12, wanted.x - (PDF_BLOCK_DEFAULT_WIDTH / 2)))),
    y: Math.round(Math.max(12, Math.min(pageHeight - PDF_BLOCK_DEFAULT_HEIGHT - 12, wanted.y - (PDF_BLOCK_DEFAULT_HEIGHT / 2)))),
    w: PDF_BLOCK_DEFAULT_WIDTH,
    h: PDF_BLOCK_DEFAULT_HEIGHT,
    z: blocks.length,
    md: "",
    at: Date.now()
  };
  writeBlocks([...blocks, block]);
  paintDocumentBlocks(pageNumber);
  beginBlockEdit(block.id);
  return block;
}

// ── Editing ────────────────────────────────────────────────────────────────

export function isEditingBlock() {
  return Boolean(editingId);
}

function beginBlockEdit(id) {
  commitBlockEdit();
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  editingId = id;
  repaintDocumentBlocks();
  const area = document.querySelector(`[data-pdf-block="${id}"] .pdf-block-edit`);
  if (!area) return;
  area.value = block.md;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

export function commitBlockEdit() {
  if (!editingId) return false;
  const id = editingId;
  const area = document.querySelector(`[data-pdf-block="${id}"] .pdf-block-edit`);
  const next = area ? area.value : null;
  editingId = null;
  const blocks = documentBlocks();
  const block = blocks.find((entry) => entry.id === id);
  if (next !== null && block && block.md !== next) {
    writeBlocks(blocks.map((entry) => (entry.id === id ? { ...entry, md: next, at: Date.now() } : entry)));
  }
  repaintDocumentBlocks();
  return true;
}

// ── Dragging and resizing ──────────────────────────────────────────────────

function beginGesture(event, node, mode) {
  const id = node.dataset.pdfBlock;
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return;
  const viewport = pdfPageViewport(block.page);
  if (!viewport) return;
  // Points per CSS pixel, read once. The viewport's own scale, so a drag is the
  // same distance on the page at every zoom.
  const perPixel = 1 / (viewport.scale || 1);
  const start = { x: event.clientX, y: event.clientY };
  let live = { ...block };
  let frame = 0;

  const apply = () => { frame = 0; placeBlock(node, viewport, live); };

  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.x) * perPixel;
    // PDF y runs UP the page and the screen's runs down, so a downward drag is a
    // decreasing y. Getting this backwards is the classic way a box drifts the
    // wrong way under a finger.
    const dy = -(moveEvent.clientY - start.y) * perPixel;
    if (mode === "drag") {
      live = { ...block, x: Math.round(block.x + dx), y: Math.round(block.y + dy) };
    } else {
      // The grip is the bottom-right on screen, which is the bottom-right in
      // points too — so it grows the width and moves the origin DOWN.
      const w = Math.max(PDF_BLOCK_MIN_WIDTH, block.w + dx);
      const h = Math.max(PDF_BLOCK_MIN_HEIGHT, block.h - dy);
      live = { ...block, w: Math.round(w), h: Math.round(h), y: Math.round(block.y + (block.h - h)) };
    }
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const finish = () => {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    try { node.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    placeBlock(node, viewport, live);
    // A press that ended where it started must not cost an autosave and a push.
    if (live.x === block.x && live.y === block.y && live.w === block.w && live.h === block.h) return;
    writeBlocks(documentBlocks().map((entry) => (entry.id === id ? { ...entry, ...live, at: Date.now() } : entry)));
  };

  try { node.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

// One delegated listener, bound by src/main.js on the scroller. Returns true
// when the press belonged to a block, so the caller knows the paper did not get
// it — which is what stops a pen press meant to move a block from also drawing.
export function handleBlockPointerDown(event) {
  const node = event.target.closest?.(`.${PDF_BLOCK_CLASS}`);
  if (!node) {
    // A press anywhere else finishes an edit in progress, which is how every
    // other editor in this app commits.
    if (editingId) commitBlockEdit();
    return false;
  }
  const action = event.target.closest("[data-pdf-block-action]")?.dataset.pdfBlockAction;
  // A press inside the text of a block being edited belongs to the textarea.
  if (!action && editingId === node.dataset.pdfBlock) { event.stopPropagation(); return true; }
  event.preventDefault();
  event.stopPropagation();
  const id = node.dataset.pdfBlock;
  if (action === "edit") beginBlockEdit(id);
  else if (action === "delete") {
    writeBlocks(documentBlocks().filter((entry) => entry.id !== id), { removed: id });
    repaintDocumentBlocks();
  } else if (action === "drag" || action === "resize") {
    commitBlockEdit();
    beginGesture(event, node, action);
  }
  return true;
}
