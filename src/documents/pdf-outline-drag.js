// Dragging rows of a PDF's contents: to reorder them, and to put one heading
// inside another.
//
// The gesture is the one the PDF switcher's list already teaches
// (src/documents/pdf-switcher.js, "Dragging a row"), for the same reasons: a
// pointer drag rather than HTML5 drag-and-drop, which a touch screen does not
// do at all; a mouse or a pen picks a row up after a few pixels; a finger has
// to hold still on it first, and moving before the hold is up is a scroll of
// the drawer.
//
// What it adds is depth. A contents is a tree, and the switcher's list is not:
//
//   • drop on the MIDDLE of a row and the dragged row becomes that row's first
//     child — "drag this heading inside that one";
//   • drop on the top or bottom edge of a row and it goes before or after it,
//     at the depth the pointer has been carried sideways to: right is deeper,
//     left is shallower, one level a step, within what the rows around the drop
//     allow (pdf-toc-arrange.js's allowedDepths).
//
// A row always travels with everything under it. The line that shows where
// the drop will land is indented to the depth it will land at.
//
// A finger that holds a row and lets go without moving gets the row's menu
// (rename, move, delete). A mouse and a keyboard reach the same actions
// through the row's keys (F2, Delete, Alt+arrows) in pdf-bookmarks.js.

import { el } from "../core/dom.js?v=__BUILD__";
import { allowedDepths, subtreeEnd } from "./pdf-toc-arrange.js?v=__BUILD__";
import { canEditDocumentOutline, documentOutlineEntries, moveDocumentOutlineEntry, OUTLINE_MAX_DEPTH } from "./pdf-outline.js?v=__BUILD__";

const OUTLINE_DRAG_START_PX = 4;
const OUTLINE_TOUCH_HOLD_MS = 260;
const OUTLINE_TOUCH_SLOP_PX = 8;
const OUTLINE_AUTOSCROLL_EDGE_PX = 36;
const OUTLINE_AUTOSCROLL_MAX_PX = 14;

// How far sideways is one level deeper. A row's own indent is 14px a level
// (styles/45-toc-rows.css); the hand gets a little more room than the eye.
export const OUTLINE_DRAG_DEPTH_PX = 24;
const OUTLINE_INDENT_PX = 14;

// The middle of a row, as a share of its height, means "into it".
const OUTLINE_NEST_ZONE = [0.3, 0.7];

let outlineDrag = null;
let outlineClickHushUntil = 0;
let outlineHoldMenu = null;

// The row menu, handed in by src/documents/pdf-bookmarks.js — which imports
// pdf-outline.js just as this does, and has no reason to import this.
export function setOutlineHoldMenu(fn) {
  outlineHoldMenu = fn;
}

function outlineScroller() {
  return el.documentOutlineList?.parentElement || null;
}

function outlineRowIndex(li) {
  const index = Number(li?.querySelector(".notes-toc-link")?.dataset.outlineIndex);
  return Number.isInteger(index) ? index : -1;
}

function onOutlineRowPointerDown(event) {
  outlineClickHushUntil = 0;
  if (outlineDrag || !canEditDocumentOutline()) return;
  if (event.button !== undefined && event.button !== 0) return;
  if (event.target.closest(".notes-toc-twisty")) return;
  const link = event.target.closest(".notes-toc-link");
  const li = link?.closest(".notes-toc-item");
  const from = outlineRowIndex(li);
  if (from < 0) return;
  outlineDrag = {
    li,
    from,
    pointerId: event.pointerId,
    pointerType: event.pointerType || "mouse",
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moved: false,
    active: false,
    holdTimer: 0,
    scrollRaf: 0,
    end: from + 1,
    target: null,
    ghost: null,
    line: null,
    into: null
  };
  window.addEventListener("pointermove", onOutlineDragMove, { passive: false });
  window.addEventListener("pointerup", onOutlineDragUp);
  window.addEventListener("pointercancel", onOutlineDragCancel);
  if (outlineDrag.pointerType === "touch") {
    outlineDrag.holdTimer = setTimeout(() => { if (outlineDrag && !outlineDrag.active) activateOutlineDrag(); }, OUTLINE_TOUCH_HOLD_MS);
  }
}

function activateOutlineDrag() {
  if (!outlineDrag || outlineDrag.active) return;
  clearTimeout(outlineDrag.holdTimer);
  const entries = documentOutlineEntries();
  if (!entries[outlineDrag.from]) {
    releaseOutlineDrag();
    return;
  }
  outlineDrag.active = true;
  outlineDrag.end = subtreeEnd(entries, outlineDrag.from);
  outlineDrag.depth = entries[outlineDrag.from].depth;
  // The row and its branch go pale where they are: they are what is moving.
  el.documentOutlineList.querySelectorAll(".notes-toc-item").forEach((li) => {
    const index = outlineRowIndex(li);
    if (index >= outlineDrag.from && index < outlineDrag.end) li.classList.add("is-dragging");
  });
  el.documentOutlineList.classList.add("is-arranging");
  const ghost = document.createElement("div");
  ghost.className = "document-toc-ghost";
  const count = outlineDrag.end - outlineDrag.from - 1;
  ghost.textContent = count > 0 ? `${entries[outlineDrag.from].title}  (+${count})` : entries[outlineDrag.from].title;
  const line = document.createElement("div");
  line.className = "document-toc-drop";
  line.hidden = true;
  document.body.append(ghost, line);
  outlineDrag.ghost = ghost;
  outlineDrag.line = line;
  if (outlineDrag.pointerType === "touch") navigator.vibrate?.(8);
  paintOutlineDrag();
}

function onOutlineDragMove(event) {
  if (!outlineDrag || event.pointerId !== outlineDrag.pointerId) return;
  outlineDrag.lastX = event.clientX;
  outlineDrag.lastY = event.clientY;
  const dx = Math.abs(event.clientX - outlineDrag.startX);
  const dy = Math.abs(event.clientY - outlineDrag.startY);
  if (!outlineDrag.active) {
    if (outlineDrag.pointerType === "touch") {
      // Moving before the hold is up is a scroll of the drawer.
      if (dx > OUTLINE_TOUCH_SLOP_PX || dy > OUTLINE_TOUCH_SLOP_PX) releaseOutlineDrag();
      return;
    }
    if (dx < OUTLINE_DRAG_START_PX && dy < OUTLINE_DRAG_START_PX) return;
    activateOutlineDrag();
  }
  if (dx >= OUTLINE_DRAG_START_PX || dy >= OUTLINE_DRAG_START_PX) outlineDrag.moved = true;
  event.preventDefault();
  paintOutlineDrag();
  autoScrollOutline();
}

function onOutlineDragUp(event) {
  if (!outlineDrag || event.pointerId !== outlineDrag.pointerId) return;
  finishOutlineDrag(true);
}

function onOutlineDragCancel(event) {
  if (!outlineDrag || event.pointerId !== outlineDrag.pointerId) return;
  finishOutlineDrag(false);
}

function finishOutlineDrag(commit) {
  if (!outlineDrag) return;
  const { active, moved, target, from, end, pointerType, lastX, lastY, depth } = outlineDrag;
  clearOutlineDrag();
  releaseOutlineDrag();
  if (!active) return;
  outlineClickHushUntil = Date.now() + 400;
  // Held and let go where it was: the row's menu, which is how a finger asks
  // for what a keyboard gets from F2, Delete and Alt+arrows.
  if (!moved) {
    if (pointerType === "touch") outlineHoldMenu?.(from, lastX, lastY);
    return;
  }
  if (!commit || !target) return;
  // Dropped back where it was.
  if (target.before >= from && target.before <= end && target.depth === depth) return;
  moveDocumentOutlineEntry(from, target.before, target.depth);
}

function clearOutlineDrag() {
  if (!outlineDrag) return;
  outlineDrag.ghost?.remove();
  outlineDrag.line?.remove();
  outlineDrag.into?.classList.remove("is-drop-into");
  el.documentOutlineList?.classList.remove("is-arranging");
  el.documentOutlineList?.querySelectorAll(".is-dragging").forEach((li) => li.classList.remove("is-dragging"));
}

function releaseOutlineDrag() {
  if (!outlineDrag) return;
  clearTimeout(outlineDrag.holdTimer);
  cancelAnimationFrame(outlineDrag.scrollRaf);
  window.removeEventListener("pointermove", onOutlineDragMove);
  window.removeEventListener("pointerup", onOutlineDragUp);
  window.removeEventListener("pointercancel", onOutlineDragCancel);
  outlineDrag = null;
}

// ── Where it would land ────────────────────────────────────────────────────

// The rows a drop can be aimed at: on screen (not folded away) and not part of
// what is being carried.
function outlineTargetRows() {
  const rows = [];
  el.documentOutlineList.querySelectorAll(".notes-toc-item").forEach((li) => {
    if (li.hidden) return;
    const index = outlineRowIndex(li);
    if (index < 0 || (index >= outlineDrag.from && index < outlineDrag.end)) return;
    rows.push({ li, index, rect: li.getBoundingClientRect() });
  });
  return rows;
}

// { before, depth, lineY, into } for the pointer as it is, or null.
function outlineDropTarget() {
  const entries = documentOutlineEntries();
  const rows = outlineTargetRows();
  if (!rows.length) return null;
  const y = outlineDrag.lastY;
  let before;
  let lineY;
  let into = null;
  let nestDepth = null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (y < first.rect.top) {
    before = first.index;
    lineY = first.rect.top;
  } else if (y > last.rect.bottom) {
    before = entries.length;
    lineY = last.rect.bottom;
  } else {
    const row = rows.find((candidate) => y >= candidate.rect.top && y <= candidate.rect.bottom)
      || rows.reduce((best, candidate) => (Math.abs(candidate.rect.top - y) < Math.abs(best.rect.top - y) ? candidate : best));
    const share = (y - row.rect.top) / Math.max(1, row.rect.height);
    if (share < OUTLINE_NEST_ZONE[0]) {
      before = row.index;
      lineY = row.rect.top;
    } else if (share <= OUTLINE_NEST_ZONE[1]) {
      before = row.index + 1;
      lineY = row.rect.bottom;
      into = row.li;
      nestDepth = entries[row.index].depth + 1;
    } else {
      // After the row — after its whole branch when that branch is folded
      // away, or the drop would land somewhere nobody can see.
      before = row.li.dataset.tocCollapsed === "true" ? subtreeEnd(entries, row.index) : row.index + 1;
      lineY = row.rect.bottom;
    }
  }
  // Inside the branch being carried is not a place it can go.
  if (before > outlineDrag.from && before < outlineDrag.end) return null;
  const length = outlineDrag.end - outlineDrag.from;
  const rest = entries.slice(0, outlineDrag.from).concat(entries.slice(outlineDrag.end));
  const at = before > outlineDrag.from ? before - length : before;
  const { min, max } = allowedDepths(rest, at, OUTLINE_MAX_DEPTH);
  const wanted = nestDepth ?? outlineDrag.depth + Math.round((outlineDrag.lastX - outlineDrag.startX) / OUTLINE_DRAG_DEPTH_PX);
  const depth = Math.max(min, Math.min(max, wanted));
  return { before, depth, lineY, into: nestDepth !== null && depth === nestDepth ? into : null };
}

function paintOutlineDrag() {
  if (!outlineDrag?.active) return;
  outlineDrag.ghost.style.transform = `translate(${Math.round(outlineDrag.lastX + 12)}px, ${Math.round(outlineDrag.lastY + 8)}px)`;
  const target = outlineDropTarget();
  outlineDrag.target = target;
  if (outlineDrag.into && outlineDrag.into !== target?.into) outlineDrag.into.classList.remove("is-drop-into");
  outlineDrag.into = target?.into || null;
  outlineDrag.into?.classList.add("is-drop-into");
  if (!target) {
    outlineDrag.line.hidden = true;
    return;
  }
  const box = el.documentOutlineList.getBoundingClientRect();
  const left = box.left + 8 + target.depth * OUTLINE_INDENT_PX;
  outlineDrag.line.hidden = false;
  outlineDrag.line.style.top = `${Math.round(target.lineY - 1)}px`;
  outlineDrag.line.style.left = `${Math.round(left)}px`;
  outlineDrag.line.style.width = `${Math.max(24, Math.round(box.right - 8 - left))}px`;
}

// Near the top or bottom of the drawer, scroll it, and keep the drop line with
// the pointer while it does.
function autoScrollOutline() {
  const scroll = outlineScroller();
  if (!outlineDrag?.active || outlineDrag.scrollRaf || !scroll) return;
  const tick = () => {
    if (!outlineDrag?.active) return;
    outlineDrag.scrollRaf = 0;
    const rect = scroll.getBoundingClientRect();
    const y = outlineDrag.lastY;
    let speed = 0;
    if (y < rect.top + OUTLINE_AUTOSCROLL_EDGE_PX) speed = -Math.ceil(OUTLINE_AUTOSCROLL_MAX_PX * Math.min(1, (rect.top + OUTLINE_AUTOSCROLL_EDGE_PX - y) / OUTLINE_AUTOSCROLL_EDGE_PX));
    else if (y > rect.bottom - OUTLINE_AUTOSCROLL_EDGE_PX) speed = Math.ceil(OUTLINE_AUTOSCROLL_MAX_PX * Math.min(1, (y - (rect.bottom - OUTLINE_AUTOSCROLL_EDGE_PX)) / OUTLINE_AUTOSCROLL_EDGE_PX));
    if (!speed) return;
    const was = scroll.scrollTop;
    scroll.scrollTop = was + speed;
    if (scroll.scrollTop === was) return;
    paintOutlineDrag();
    outlineDrag.scrollRaf = requestAnimationFrame(tick);
  };
  outlineDrag.scrollRaf = requestAnimationFrame(tick);
}

export function initDocumentOutlineDrag() {
  const list = el.documentOutlineList;
  if (!list) return;
  list.addEventListener("pointerdown", onOutlineRowPointerDown);
  // The click that ends a drag is not a press on the row it ended over.
  list.addEventListener("click", (event) => {
    if (Date.now() > outlineClickHushUntil) return;
    outlineClickHushUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // A finger held on a row is a drag (or its menu) in the making, not the
  // browser's own long-press menu.
  list.addEventListener("contextmenu", (event) => {
    if (outlineDrag && outlineDrag.pointerType !== "mouse") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  // Once a touch drag has begun the drawer must not scroll under it; this is
  // the one way to say so mid-gesture.
  list.addEventListener("touchmove", (event) => {
    if (outlineDrag?.active && event.cancelable) event.preventDefault();
  }, { passive: false });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !outlineDrag?.active) return;
    event.preventDefault();
    event.stopPropagation();
    clearOutlineDrag();
    releaseOutlineDrag();
    outlineClickHushUntil = Date.now() + 400;
  }, true);
}
