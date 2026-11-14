// Where the mouse is over a page — and the three things that use it.
//
// A page on a PDF or a Canvas used to take everything from the bar above it:
// + Add → Block dropped a Block in the middle of the view, Text needed its
// button and then a tap, and a pasted picture had no coordinates at all, so it
// landed in the middle too and had to be dragged to where it was wanted. On a
// desktop the mouse is already pointing at that place. So:
//
//   Ctrl+V   a picture pastes with its top-left corner at the mouse, on the page
//            under it (pagePointAtPointer, read by src/main.js's paste path)
//   T        a Block at the mouse, as B — it was Text (textAtPointer)
//   B        a Block at the mouse, its editor open (blockAtPointer)
//   double-click on bare paper, with a MOUSE: a Block there
//
// The double-click is a mouse's only. It once made a Block for any pointer and
// was taken out (src/main.js says why): handwriting is full of quick taps close
// together, and the browser's dblclick cannot tell two dots on an "i" from two
// deliberate clicks, so the Block editor popped open under the nib. A pen and a
// finger therefore never make one here — the pointerType of the press is read,
// not guessed from the event.
//
// The pointer is tracked only from a mouse or a hovering pen; a finger has no
// position until it presses, and its press is a scroll.

import { el } from "../core/dom.js?v=__BUILD__";
import { PDF_PICKUP_SELECTOR } from "../core/constants.js?v=__BUILD__";
import { onDocumentSurface } from "./doc-slot.js?v=__BUILD__";
import { pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { isEditingBlock } from "./pdf-blocks.js?v=__BUILD__";
import { editingShapeTextId, isShapeToolArmed, shapeAtPoint } from "./pdf-shapes.js?v=__BUILD__";
import { inkTool, isInkArmed } from "./pdf-ink.js?v=__BUILD__";
import { isRegionSelectArmed } from "./pdf-region.js?v=__BUILD__";
import { anyModalOpen } from "../ui/overlays.js?v=__BUILD__";
import { onDocumentScrollers } from "./doc-scrollers.js?v=__BUILD__";

let pagePointer = null;
let pagePressType = "";
let pagePointerActions = { textAtPointer: () => {}, blockAtPointer: () => {} };

// ── Where the mouse is, in a page's own points ────────────────────────────
//
// { page, x, y }, or null when the mouse is not over a page that can be seen —
// off the window, over the pen's bar or a dialog, or over the gap between two
// pages. Worked out when asked rather than when the mouse last moved, so a
// page scrolled under a still mouse is the page that counts.
export function pagePointAtPointer() {
  if (!pagePointer) return null;
  const view = el.documentView;
  if (!view || el.documentStage?.hidden) return null;
  const { x, y } = pagePointer;
  const top = document.elementFromPoint(x, y);
  if (!top || !view.contains(top)) return null;
  for (const pageEl of view.querySelectorAll(".pdf-page[data-page-number]")) {
    const box = pageEl.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
    const page = Number(pageEl.dataset.pageNumber);
    const viewport = pdfPageViewport(page);
    if (!page || !viewport || !box.width || !box.height) return null;
    const [px, py] = viewport.convertToPdfPoint(x - box.left, y - box.top);
    return { page, x: px, y: py };
  }
  return null;
}

function trackPagePointer(event) {
  if (event.pointerType === "touch") return;
  pagePointer = { x: event.clientX, y: event.clientY };
}

// ── Shared guards ──────────────────────────────────────────────────────────
const PLACE_TYPING_FIELD = "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";

function pageIsFreeToPlace() {
  if (!onDocumentSurface() || el.documentStage?.hidden) return false;
  if (isEditingBlock() || editingShapeTextId()) return false;
  if (anyModalOpen() || document.querySelector(".image-compress-modal, .pdf-block-editor:not([hidden])")) return false;
  return true;
}

// ── T and B ────────────────────────────────────────────────────────────────
function onPlaceKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return;
  const key = String(event.key || "").toLowerCase();
  if (key !== "t" && key !== "b") return;
  if (event.target?.closest?.(PLACE_TYPING_FIELD)) return;
  if (!pageIsFreeToPlace()) return;
  event.preventDefault();
  event.stopPropagation();
  const at = pagePointAtPointer();
  if (key === "t") pagePointerActions.textAtPointer(at);
  else pagePointerActions.blockAtPointer(at);
}

// ── A mouse double-click on bare paper ─────────────────────────────────────
//
// Not on anything that answers a press or a double-click of its own: a Block
// (opens it), typed Text, a shape, a note badge — and not on a PDF's words,
// where a double-click selects the word to highlight it.
const DOUBLE_CLICK_TAKEN = `button, a[href], input, textarea, select, label, [contenteditable], .pdf-note-badge, .pdf-shape-editor, .pdf-text-layer span, .ink-rail-popover, ${PDF_PICKUP_SELECTOR}`;

function onPageDoubleClick(event) {
  if (pagePressType !== "mouse" || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (!el.documentView?.contains(event.target) || event.target.closest?.(DOUBLE_CLICK_TAKEN)) return;
  if (!pageIsFreeToPlace()) return;
  // A click with Text or a shape armed makes one of those; the eraser and the
  // region tool own the press too.
  if (isShapeToolArmed() || isRegionSelectArmed() || (isInkArmed() && inkTool() === "eraser")) return;
  const words = window.getSelection?.();
  if (words && !words.isCollapsed && String(words).trim()) return;
  pagePointer = { x: event.clientX, y: event.clientY };
  const at = pagePointAtPointer();
  if (!at) return;
  if (shapeAtPoint(at.page, at.x, at.y)) return;
  event.preventDefault();
  pagePointerActions.blockAtPointer(at);
}

// `textAtPointer(at)` and `blockAtPointer(at)` come from src/main.js, which can reach
// the Text tool and the Canvas's controls; `at` may be null (no page under the
// mouse), and each then does what its button does.
export function initPagePointer({ textAtPointer, blockAtPointer } = {}) {
  if (typeof textAtPointer === "function") pagePointerActions.textAtPointer = textAtPointer;
  if (typeof blockAtPointer === "function") pagePointerActions.blockAtPointer = blockAtPointer;
  // On the window, capturing: ahead of the page's own listeners, some of which
  // stop a press from going further. Passive — this only looks.
  window.addEventListener("pointermove", trackPagePointer, { capture: true, passive: true });
  window.addEventListener("pointerdown", (event) => { pagePressType = event.pointerType || ""; trackPagePointer(event); }, { capture: true, passive: true });
  // The mouse left the window: there is no "where" any more.
  document.addEventListener("pointerout", (event) => { if (!event.relatedTarget && event.pointerType !== "touch") pagePointer = null; });
  document.addEventListener("keydown", onPlaceKey, true);
  onDocumentScrollers("dblclick", onPageDoubleClick);
}
