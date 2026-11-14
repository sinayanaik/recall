// Putting a Block on the page: one press to say "a block", one tap to say where.
//
// There used to be two things to add that did one job. Text (the T button, and
// + Add → Text) was a tap and a cursor; a Block (+ Add → Block) was a box of
// markdown dropped in the middle of the view with a window over it to write
// in. "I could not really understand the difference between insert text and
// insert block — I want every insert as a block, and adding one should be as
// lightweight as adding text." So there is one: the Block button (where the
// Text button was) and + Add → Block both arm this, a tap on a PDF's or a
// Canvas's page — with a pen, a mouse or a finger — puts a block there with its
// top-left corner at the tap, and it opens in place to type in
// (src/documents/pdf-block-inline.js). One block per press; Escape or a second
// press of the button puts it away unplaced.
//
// The press is taken on the WINDOW, in the capture phase, so it reaches here
// before the page's own listeners (the pen, the shapes, the blocks — capture
// listeners on #documentView — and the connect arrows and the Select tool's
// box, capture listeners on the document) and none of them sees it: a pen
// tap that places a block must not also leave a dot of ink. A finger is
// different only in that it may be scrolling — it places nothing unless it
// lifts where it landed.

import { el } from "../core/dom.js?v=__BUILD__";
import { addDocumentBlock, pdfPointAt } from "./pdf-blocks.js?v=__BUILD__";
import { currentDocumentPage, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// How far a press may travel and still be a tap, in CSS pixels.
const PLACE_TAP_SLOP_PX = 10;

// null, or what the next tap puts down: `options` goes to addDocumentBlock
// (a diagram's shape and size), `anchor` says which point of the block lands
// on the tap.
let placeArmed = null;
let placePress = null;
let placeSwallowClickUntil = 0;
let onPlacementChanged = () => {};

export function setBlockPlacementChangedHandler(fn) {
  onPlacementChanged = typeof fn === "function" ? fn : () => {};
}

export function isBlockPlacementArmed() {
  return Boolean(placeArmed);
}

export function armBlockPlacement(on = true, { options = null, anchor = "top-left", toast = true } = {}) {
  const next = on ? { options: options || {}, anchor } : null;
  const was = Boolean(placeArmed);
  placeArmed = next;
  placePress = null;
  if (next && toast) showToast("Tap where the block goes", "info");
  if (was !== Boolean(next) || next) onPlacementChanged(Boolean(next));
  return Boolean(next);
}

export function toggleBlockPlacement(opts = {}) {
  return armBlockPlacement(!placeArmed, opts);
}

// The middle of what the reader is looking at, in the page's own points —
// converted from the scroller's centre rather than assumed, so a block lands
// where they are rather than in the middle of a page they have scrolled past.
export function viewDropPoint(page) {
  const viewport = pdfPageViewport(page);
  if (!viewport) return null;
  const view = el.documentView?.getBoundingClientRect();
  const pageEl = document.querySelector(`.pdf-page[data-page-number="${page}"]`);
  const box = pageEl?.getBoundingClientRect();
  if (!view || !box) return null;
  const cx = Math.min(Math.max(view.left + (view.width / 2), box.left), box.right) - box.left;
  const cy = Math.min(Math.max(view.top + (view.height / 2), box.top), box.bottom) - box.top;
  const [x, y] = viewport.convertToPdfPoint(cx, cy);
  return { x, y };
}

// A block put down straight away, with no tap: what the keyboard's press of
// the button does (it has no point to tap with), in the middle of the view.
export function placeBlockInView({ options = null, anchor = "center" } = {}) {
  armBlockPlacement(false, { toast: false });
  const page = currentDocumentPage();
  if (!pdfPageViewport(page)) return null;
  return addDocumentBlock(page, viewDropPoint(page), { ...(options || {}), anchor, discardIfEmpty: true });
}

// ── The tap ───────────────────────────────────────────────────────────────

// Presses that are not on the paper: the bars over it, a menu, a dialog. Those
// keep working while a block is waiting to be placed — the reader may be
// choosing the pen's colour first, or pressing the button again to cancel.
const NOT_THE_PAGE = ".document-ink-rail, .document-head, .ink-rail-popover, .shape-style-popover, "
  + ".pdf-block-actions-pop, .pdf-block-style-pop, .selection-bar, [role=dialog], [role=menu]";

function onPlacePressDown(event) {
  if (!placeArmed) return;
  if (event.button !== undefined && event.button > 0) return;
  if (event.isPrimary === false) return;
  if (!el.documentView?.contains(event.target)) return;
  if (event.target.closest?.(NOT_THE_PAGE)) return;
  const at = pdfPointAt(event.clientX, event.clientY);
  if (!at) return;
  // Nobody else hears this press: not the pen (a dot of ink), not the blocks
  // (a press on one already there would pick it up), not the shapes.
  event.stopPropagation();
  // A finger is left free to scroll; a pen and a mouse are not scrolling.
  if (event.pointerType !== "touch") event.preventDefault();
  placePress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at };
}

function onPlacePressMove(event) {
  if (!placePress || event.pointerId !== placePress.pointerId) return;
  event.stopPropagation();
  if (Math.hypot(event.clientX - placePress.x, event.clientY - placePress.y) > PLACE_TAP_SLOP_PX) placePress = null;
}

function onPlacePressUp(event) {
  if (!placePress || event.pointerId !== placePress.pointerId) return;
  event.stopPropagation();
  const { at } = placePress;
  placePress = null;
  if (!placeArmed) return;
  const { options, anchor } = placeArmed;
  placeArmed = null;
  onPlacementChanged(false);
  // The click this press is about to fire lands on the block just made — on
  // its words — and must not be read as a press on it.
  placeSwallowClickUntil = Date.now() + 400;
  addDocumentBlock(at.page, { x: at.x, y: at.y }, { ...options, anchor, discardIfEmpty: true });
}

function onPlacePressCancel(event) {
  if (placePress && event.pointerId === placePress.pointerId) placePress = null;
}

function onPlaceClick(event) {
  if (Date.now() > placeSwallowClickUntil) return;
  placeSwallowClickUntil = 0;
  if (!el.documentView?.contains(event.target)) return;
  event.stopPropagation();
  event.preventDefault();
}

function onPlacementKey(event) {
  if (!placeArmed || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  armBlockPlacement(false);
}

let placementWired = false;

export function initBlockPlacement() {
  if (placementWired) return;
  placementWired = true;
  window.addEventListener("pointerdown", onPlacePressDown, true);
  window.addEventListener("pointermove", onPlacePressMove, true);
  window.addEventListener("pointerup", onPlacePressUp, true);
  window.addEventListener("pointercancel", onPlacePressCancel, true);
  window.addEventListener("click", onPlaceClick, true);
  window.addEventListener("keydown", onPlacementKey, true);
}
