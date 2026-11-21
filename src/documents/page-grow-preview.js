// A Canvas page growing, growShown WHILE something is dragged past its edge.
//
// Every Canvas page grows as needed (src/documents/canvas-extent.js): a Block,
// a shape or several things carried past its right edge or its foot make it
// longer or wider — past it, not merely near it: the page's original size is
// the line (shown dashed on a page that has grown, markCanvasPageGrowth in
// src/documents/pdf-view.js). The page itself is redrawn once they are let go — the new
// paper is a new file (src/documents/notebook.js) — so while they are carried
// the page shows where it will reach: its paper carried on past the old edge,
// to the new one, drawn dashed, "Page grows" at its corner. Let go, and the
// real page takes its place in the same frame it lands in (the outline is
// kept until swapOpenCanvasBytes, src/documents/pdf-view.js, has drawn it).
//
// ── Grow this page, or go to the next? The pointer decides ────────────────
//
// A page that grows downward and the page after it both want what is dragged
// past the foot. The rule is the one the drag already followed
// (src/documents/page-handoff.js): the page under the POINTER is the page it
// lands on. With the pointer still on this page — what is dragged hanging past
// its edge — this page grows. With the pointer over the next page, it goes
// there, and that page is outlined as where it will land; this page's outline
// goes away. Nothing moves the next page while a drag is on, so it can always
// be reached.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { canvasPageBox, sheetFit, sheetSetupForPage } from "./canvas-setup.js?v=__BUILD__";
import { neededPageBox, samePageBox, unionRects } from "./canvas-extent.js?v=__BUILD__";
import { pagesHost, pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const GROW_PREVIEW_CLASS = "canvas-grow-preview";
export const GROWING_PAGE_CLASS = "is-growing";
export const DROP_TARGET_CLASS = "is-drop-target";
// How long an outline left at a drop waits for its page to be redrawn before
// it is taken away regardless (a page that did not grow after all).
const GROW_PREVIEW_HOLD_MS = 3000;

let growShown = new Map(); // page → the box it is growShown reaching
let growTarget = 0;
let holdTimer = 0;
let growSoonHook = () => {};

// What makes the page grow at once when something is let go past its edge —
// scheduleCanvasExtentFit({ soon: true }) in src/documents/notebook.js, handed
// in by src/main.js (that module imports the drag modules this one serves).
export function setPageGrowSoonHook(fn) {
  growSoonHook = typeof fn === "function" ? fn : () => {};
}

function growOnCanvas() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK && Boolean(state.meta?.notebook);
}

function removeOutline(page) {
  const pageEl = pdfPageElement(page);
  pageEl?.querySelectorAll(`:scope > .${GROW_PREVIEW_CLASS}`).forEach((node) => node.remove());
  pageEl?.classList.remove(GROWING_PAGE_CLASS);
  growShown.delete(page);
  if (!growShown.size) pagesHost()?.style.removeProperty("padding-bottom");
}

function markTarget(page) {
  if (growTarget === page) return;
  if (growTarget) pdfPageElement(growTarget)?.classList.remove(DROP_TARGET_CLASS);
  growTarget = page || 0;
  if (growTarget) pdfPageElement(growTarget)?.classList.add(DROP_TARGET_CLASS);
}

// Draw page `page` reaching `box` (its own points), past where it reaches now.
function drawOutline(page, box, now) {
  const pageEl = pdfPageElement(page);
  const viewport = pdfPageViewport(page);
  if (!pageEl || !viewport) return;
  const scale = viewport.scale || 1;
  let outline = pageEl.querySelector(`:scope > .${GROW_PREVIEW_CLASS}`);
  if (!outline) {
    outline = document.createElement("div");
    outline.className = GROW_PREVIEW_CLASS;
    outline.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Page grows";
    outline.appendChild(label);
    // Under everything on the page, over the page's own paper: the page is a
    // stacking context (`contain: layout`), so z-index −1 is just that.
    pageEl.prepend(outline);
  }
  const left = (box[0] - now[0]) * scale;
  const top = (now[3] - box[3]) * scale;
  const width = (box[2] - box[0]) * scale;
  const height = (box[3] - box[1]) * scale;
  outline.style.left = `${Math.round(left)}px`;
  outline.style.top = `${Math.round(top)}px`;
  outline.style.width = `${Math.round(width)}px`;
  outline.style.height = `${Math.round(height)}px`;
  pageEl.classList.add(GROWING_PAGE_CLASS);
  growShown.set(page, box);
  // The last page has nothing under it to scroll onto: room is made under the
  // pages for the outline, so the view can follow a drag past the end.
  const host = pagesHost();
  if (host) {
    const below = Math.max(0, Math.round(top + height - pageEl.offsetHeight));
    const isLast = !pageEl.nextElementSibling?.matches?.(".pdf-page");
    if (isLast && below > 0) host.style.paddingBottom = `${below + 24}px`;
    else if (isLast) host.style.removeProperty("padding-bottom");
  }
}

// Every move of a drag on the Canvas: `page` is the page it was picked up on,
// `target` the page under the pointer, and `rects` where what is carried is,
// in `target`'s points. On its own page, past an edge the page grows by, the
// page is growShown growing; over another page, that page is outlined instead.
export function previewPageGrowth({ page, target = page, rects = [] } = {}) {
  clearTimeout(holdTimer);
  holdTimer = 0;
  if (!growOnCanvas()) return;
  const source = Number(page) || 0;
  const over = Number(target) || source;
  if (over !== source) {
    // Going to another page: that page is where it lands; this one keeps its
    // size (what pushed it is leaving it).
    if (growShown.has(source)) removeOutline(source);
    markTarget(over);
    return;
  }
  markTarget(0);
  const record = state.meta.notebook;
  const setup = sheetSetupForPage(record, source);
  if (sheetFit(setup) === "set") {
    if (growShown.has(source)) removeOutline(source);
    return;
  }
  const now = canvasPageBox(record, source);
  const carried = unionRects(rects);
  if (!carried) {
    if (growShown.has(source)) removeOutline(source);
    return;
  }
  // Only ever further than the page reaches now, while a drag is on: what was
  // on the page stays on it until it is let go.
  const need = neededPageBox(setup, [carried], now);
  const reach = [Math.min(need[0], now[0]), Math.min(need[1], now[1]), Math.max(need[2], now[2]), Math.max(need[3], now[3])];
  if (samePageBox(reach, now)) {
    if (growShown.has(source)) removeOutline(source);
    return;
  }
  drawOutline(source, reach, now);
}

// The drag is over. Let go over a page that is growShown growing, the outline
// stays until the page is drawn at its new size; any other end takes the
// outlines away. Every drop on the Canvas asks the pages to fit at once — a
// page grows the moment something is let go past its edge, and is its size
// again the moment the last thing past it is taken back inside its original
// size (src/documents/canvas-extent.js); a drop that changes no page's reach
// changes nothing.
export function endPageGrowthPreview({ dropped = true } = {}) {
  markTarget(0);
  if (dropped && growOnCanvas()) {
    try {
      growSoonHook();
    } catch (error) {
      console.warn("Could not ask the page to grow", error);
    }
  }
  if (!growShown.size) return;
  if (!dropped) {
    clearPageGrowthPreview();
    return;
  }
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => clearPageGrowthPreview(), GROW_PREVIEW_HOLD_MS);
}

// Every outline gone — or only page `page`'s, when it has been drawn at its
// new size (swapOpenCanvasBytes).
export function clearPageGrowthPreview(page = null) {
  if (page) {
    removeOutline(Number(page));
    return;
  }
  [...growShown.keys()].forEach((n) => removeOutline(n));
  el.documentView?.querySelectorAll(`.${GROW_PREVIEW_CLASS}`).forEach((node) => node.remove());
  el.documentView?.querySelectorAll(`.pdf-page.${GROWING_PAGE_CLASS}`).forEach((node) => node.classList.remove(GROWING_PAGE_CLASS));
  pagesHost()?.style.removeProperty("padding-bottom");
  markTarget(0);
}

// For the browser check: where each page is growShown reaching.
export function pageGrowthPreviewState() {
  return { growShown: Object.fromEntries([...growShown.entries()].map(([n, box]) => [n, box])), target: growTarget };
}
