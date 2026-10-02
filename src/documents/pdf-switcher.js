// The deck's PDF panel — every multi-PDF operation in the one list.
//
// Opened from the switcher button in the document row (#documentPdfSwitcher,
// painted by renderDocumentPdfSwitcher in pdf-view.js). One row per paper:
// press the name to read it, drag the row to reorder, ✎ to rename it in place,
// × to remove it. "Add another PDF…" closes the list.
//
// This replaced a native <select> plus a separate "Arrange PDFs" sheet with
// Done/Cancel, and Rename/Remove rows in ⋯ that only ever acted on the paper
// already open. Reordering meant: open the dropdown, pick its last row, drag by
// a small grip, press Done. Editing the third paper meant switching to it first.
// Here the list you switch from is the list you arrange, and every row carries
// its own actions.
//
// ── Dragging ────────────────────────────────────────────────────────────────
//
// POINTER events, not HTML5 drag-and-drop, which does nothing at all under a
// finger on a phone. A drag starts:
//   • from the grip, at once, with any pointer — it owns its touches outright
//     (touch-action: none), so a finger on it drags rather than scrolls;
//   • from anywhere else on the row with a mouse or pen, once it has moved a
//     few pixels — a press that does not move is still a click on the name;
//   • from anywhere else on the row with a finger, after a short hold — a
//     finger that moves straight away is scrolling a long list, and keeps doing
//     that.
// The order is committed the moment the row is dropped. There is no Done: the
// list in front of the reader IS the order.
//
// Written through withPdfOrder as one stamped value (see pdf-multi.js) rather
// than by rearranging meta.pdfs, which the sync merge would put back the way it
// found it.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { deckPdfs, withPdfOrder } from "./pdf-multi.js?v=__BUILD__";
import { removePdfFromDeck, renamePdf } from "./pdf-multi-actions.js?v=__BUILD__";
import { renderDocumentPdfSwitcher, setPdfSwitcherPaintedHook, switchToPdf } from "./pdf-view.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showConfirmModal } from "../ui/feedback.js?v=__BUILD__";

const DRAG_START_PX = 4;
const TOUCH_HOLD_MS = 260;
const TOUCH_SLOP_PX = 8;
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_PX = 14;

let pdfPanel = null;
let pdfPanelList = null;
let pdfPanelPainted = null;
let pdfPanelDrag = null;
let pdfPanelRenaming = null;
let pdfPanelClickHushUntil = 0;

export function isPdfPanelOpen() {
  return Boolean(pdfPanel && !pdfPanel.hidden);
}

export function initPdfSwitcher() {
  const trigger = el.documentPdfSwitcher;
  if (!trigger || pdfPanel) return;
  pdfPanel = buildPanel();
  document.body.appendChild(pdfPanel);

  trigger.addEventListener("click", (event) => {
    if (isPdfPanelOpen()) closePdfPanel();
    // A click with no pointer behind it (detail 0) is Enter or Space: put focus
    // in the list for the keyboard. A tap or a mouse press leaves it alone.
    else openPdfPanel({ focusList: event.detail === 0 });
  });
  setPdfSwitcherPaintedHook((info) => {
    pdfPanelPainted = info;
    if (!isPdfPanelOpen()) return;
    if (!info) {
      closePdfPanel();
      return;
    }
    // Never under the reader's hand: a drag or a rename in progress owns the
    // rows until it finishes, and repaints once it has.
    if (!pdfPanelDrag && !pdfPanelRenaming) paintRows();
  });

  // Outside the panel closes it — but not a press in the confirm sheet a
  // removal opens over it, so the list is still there to carry on with.
  document.addEventListener("pointerdown", (event) => {
    if (!isPdfPanelOpen()) return;
    if (event.target.closest("#documentPdfPanel, #documentPdfSwitcher, .confirm-modal")) return;
    closePdfPanel();
  }, { capture: true, passive: true });
  document.addEventListener("keydown", (event) => {
    if (!isPdfPanelOpen() || event.key !== "Escape") return;
    if (el.confirmModal && !el.confirmModal.hidden) return;
    if (pdfPanelRenaming) return;
    event.preventDefault();
    event.stopPropagation();
    closePdfPanel({ focusTrigger: true });
  }, true);
  window.addEventListener("resize", () => { if (isPdfPanelOpen()) placePanel(); });
}

export function openPdfPanel({ focusList = false } = {}) {
  if (!pdfPanel) return;
  if (!pdfPanelPainted) renderDocumentPdfSwitcher();
  if (!pdfPanelPainted) return;
  // ⋯ shares this row; one open popover at a time.
  if (el.documentMoreMenu && !el.documentMoreMenu.hidden) {
    el.documentMoreMenu.hidden = true;
    el.documentMoreBtn?.setAttribute("aria-expanded", "false");
  }
  paintRows();
  pdfPanel.hidden = false;
  el.documentPdfSwitcher?.setAttribute("aria-expanded", "true");
  placePanel();
  const active = pdfPanelList.querySelector(".pdf-panel-row.is-active");
  active?.scrollIntoView({ block: "nearest" });
  if (focusList) active?.querySelector(".pdf-panel-name")?.focus({ preventScroll: true });
}

export function closePdfPanel({ focusTrigger = false } = {}) {
  if (!pdfPanel || pdfPanel.hidden) return;
  if (pdfPanelDrag) finishDrag(false);
  pdfPanelRenaming = null;
  pdfPanel.hidden = true;
  el.documentPdfSwitcher?.setAttribute("aria-expanded", "false");
  if (focusTrigger) el.documentPdfSwitcher?.focus();
}

// Under the switcher, kept on screen: a fixed box measured from the button, so
// neither the row's overflow nor a narrow phone can clip it.
function placePanel() {
  const trigger = el.documentPdfSwitcher;
  if (!pdfPanel || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const gutter = 12;
  const width = Math.min(pdfPanel.offsetWidth || 352, window.innerWidth - gutter * 2);
  const left = Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter));
  pdfPanel.style.left = `${Math.round(left)}px`;
  pdfPanel.style.top = `${Math.round(rect.bottom + 6)}px`;
  pdfPanel.style.maxHeight = `${Math.max(180, Math.round(window.innerHeight - rect.bottom - 18))}px`;
}

function buildPanel() {
  const node = document.createElement("section");
  node.className = "pdf-panel";
  node.id = "documentPdfPanel";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "This deck's PDFs");
  node.hidden = true;
  node.innerHTML = `
    <div class="pdf-panel-head">
      <span class="pdf-panel-title">PDFs in this deck</span>
      <span class="pdf-panel-hint">Drag to reorder</span>
    </div>
    <ol class="pdf-panel-list" data-pdf-list></ol>
    <button type="button" class="pdf-panel-add" data-pdf-add>
      <span aria-hidden="true">+</span><span>Add another PDF…</span>
    </button>
  `;
  pdfPanelList = node.querySelector("[data-pdf-list]");

  pdfPanelList.addEventListener("click", onListClick, true);
  pdfPanelList.addEventListener("keydown", onListKey);
  pdfPanelList.addEventListener("pointerdown", onListPointerDown);
  // A finger held on a row is a drag in the making, not a request for the
  // browser's own long-press menu or a text selection.
  pdfPanelList.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".pdf-panel-row") && !event.target.closest("input")) event.preventDefault();
  });
  // Once a touch drag has begun, the list must not scroll under it. touch-action
  // cannot be changed mid-gesture, so this is the one way to say so.
  pdfPanelList.addEventListener("touchmove", (event) => {
    if (pdfPanelDrag?.active && event.cancelable) event.preventDefault();
  }, { passive: false });

  node.querySelector("[data-pdf-add]").addEventListener("click", () => {
    closePdfPanel();
    // The ⋯ menu's own picker, so an attach from here takes exactly the path
    // (and the error handling) an attach from there does.
    el.documentAddPdfInput?.click();
  });
  return node;
}

function paintRows() {
  if (!pdfPanelList || !pdfPanelPainted) return;
  pdfPanelList.innerHTML = "";
  pdfPanelPainted.list.forEach((entry) => pdfPanelList.appendChild(buildRow(entry, entry.id === pdfPanelPainted.activeId)));
}

function entryLabel(entry) {
  return entry.label || entry.name || "PDF";
}

function buildRow(entry, active) {
  const label = entryLabel(entry);
  const row = document.createElement("li");
  row.className = `pdf-panel-row${active ? " is-active" : ""}`;
  row.dataset.pdfId = entry.id;

  const grip = document.createElement("span");
  grip.className = "pdf-panel-grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⠿";

  const name = document.createElement("button");
  name.type = "button";
  name.className = "pdf-panel-name";
  name.dataset.pdfSwitch = "";
  if (active) name.setAttribute("aria-current", "true");
  name.title = entry.label && entry.name && entry.label !== entry.name
    ? `${label} (${entry.name}) — Alt+↑/↓ to move`
    : `${label} — Alt+↑/↓ to move`;
  const text = document.createElement("span");
  text.className = "pdf-panel-label";
  text.textContent = label;
  name.appendChild(text);
  const pages = Number(entry.pages) || 0;
  const detail = [pages ? `${pages} page${pages === 1 ? "" : "s"}` : "", entry.offloaded ? "not in the cloud" : ""]
    .filter(Boolean).join(" · ");
  if (detail) {
    const small = document.createElement("span");
    small.className = "pdf-panel-detail";
    small.textContent = detail;
    name.appendChild(small);
  }

  const rename = iconButton("pdfRename", "✎", `Rename “${label}”`);
  const remove = iconButton("pdfRemove", "×", `Remove “${label}” from this deck`);
  remove.classList.add("is-danger");
  row.append(grip, name, rename, remove);
  return row;
}

function iconButton(key, glyph, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-panel-icon";
  button.dataset[key] = "";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  return button;
}

// ── Clicks: switch, rename, remove ───────────────────────────────────────────

function onListClick(event) {
  // The click that ends a drag lands on whatever the row was dropped over; it
  // is the end of the drag, not a request to open that paper.
  if (Date.now() < pdfPanelClickHushUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const row = event.target.closest(".pdf-panel-row");
  if (!row || event.target.closest("input")) return;
  const pdfId = row.dataset.pdfId;
  if (event.target.closest("[data-pdf-rename]")) {
    beginRename(row);
    return;
  }
  if (event.target.closest("[data-pdf-remove]")) {
    confirmRemove(pdfId);
    return;
  }
  if (event.target.closest("[data-pdf-switch]")) {
    closePdfPanel();
    switchToPdf(pdfId);
  }
}

function confirmRemove(pdfId) {
  const entry = deckPdfs(state.meta).find((item) => item.id === pdfId);
  if (!entry) return;
  const count = deckPdfs(state.meta).length;
  const rest = count > 1
    ? "Your other PDFs, notes and cards are untouched."
    : "It is this deck's only PDF, so the deck is left with no document — your notes and cards are untouched, and you can attach another any time.";
  showConfirmModal(
    `“${entryLabel(entry)}” will be removed from this deck, along with its highlights and bookmark. ${rest}`,
    () => removePdfFromDeck(pdfId),
    { confirmLabel: "Remove", danger: true }
  );
}

function beginRename(row) {
  const pdfId = row.dataset.pdfId;
  const entry = deckPdfs(state.meta).find((item) => item.id === pdfId);
  const name = row.querySelector(".pdf-panel-name");
  if (!entry || !name) return;
  pdfPanelRenaming = pdfId;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pdf-panel-input";
  input.value = entry.label || entry.name || "";
  input.placeholder = entry.name || "PDF";
  input.setAttribute("aria-label", "PDF name");
  name.replaceWith(input);
  row.classList.add("is-renaming");
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    pdfPanelRenaming = null;
    if (save && input.value.trim() !== (entry.label || entry.name || "").trim()) {
      renamePdf(pdfId, input.value);
    } else {
      paintRows();
    }
    pdfPanelList.querySelector(`.pdf-panel-row[data-pdf-id="${CSS.escape(pdfId)}"] .pdf-panel-name`)?.focus();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

// ── Keyboard: Alt+↑/↓ moves the focused paper ───────────────────────────────

function onListKey(event) {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  const row = event.target.closest(".pdf-panel-row");
  if (!row || event.target.closest("input")) return;
  event.preventDefault();
  const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  animateReflow(row, () => {
    if (event.key === "ArrowUp") pdfPanelList.insertBefore(row, sibling);
    else pdfPanelList.insertBefore(sibling, row);
  }, true);
  commitOrder();
  row.querySelector(".pdf-panel-name")?.focus();
}

// ── Dragging a row ──────────────────────────────────────────────────────────

function onListPointerDown(event) {
  if (pdfPanelDrag || pdfPanelRenaming) return;
  if (event.button !== undefined && event.button !== 0) return;
  const row = event.target.closest(".pdf-panel-row");
  if (!row || event.target.closest("input, .pdf-panel-icon")) return;
  const onGrip = Boolean(event.target.closest(".pdf-panel-grip"));
  pdfPanelDrag = {
    row,
    pointerId: event.pointerId,
    pointerType: event.pointerType || "mouse",
    startX: event.clientX,
    startY: event.clientY,
    lastY: event.clientY,
    active: false,
    holdTimer: 0,
    scrollRaf: 0,
    startTop: 0,
    startScroll: 0,
    before: ""
  };
  // On the window rather than captured to the row: a captured pointer's click
  // is aimed at the row, and a press that never became a drag has to stay a
  // click on the name it landed on.
  window.addEventListener("pointermove", onDragMove, { passive: false });
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragCancel);
  if (onGrip) {
    event.preventDefault();
    activateDrag();
  } else if (pdfPanelDrag.pointerType === "touch") {
    pdfPanelDrag.holdTimer = setTimeout(() => { if (pdfPanelDrag && !pdfPanelDrag.active) activateDrag(); }, TOUCH_HOLD_MS);
  }
}

function activateDrag() {
  if (!pdfPanelDrag || pdfPanelDrag.active) return;
  clearTimeout(pdfPanelDrag.holdTimer);
  pdfPanelDrag.active = true;
  pdfPanelDrag.startTop = pdfPanelDrag.row.offsetTop;
  pdfPanelDrag.startScroll = pdfPanelList.scrollTop;
  pdfPanelDrag.before = rowOrder().join(",");
  pdfPanelDrag.row.classList.add("is-dragging");
  pdfPanelList.classList.add("is-arranging");
  pdfPanel.classList.add("is-arranging");
  if (pdfPanelDrag.pointerType === "touch") navigator.vibrate?.(8);
  placeDraggedRow();
}

function onDragMove(event) {
  if (!pdfPanelDrag || event.pointerId !== pdfPanelDrag.pointerId) return;
  pdfPanelDrag.lastY = event.clientY;
  if (!pdfPanelDrag.active) {
    const dx = Math.abs(event.clientX - pdfPanelDrag.startX);
    const dy = Math.abs(event.clientY - pdfPanelDrag.startY);
    if (pdfPanelDrag.pointerType === "touch") {
      // Moving before the hold is up is a scroll — let it be one.
      if (dx > TOUCH_SLOP_PX || dy > TOUCH_SLOP_PX) releaseDrag();
      return;
    }
    if (dy < DRAG_START_PX && dx < DRAG_START_PX) return;
    activateDrag();
  }
  event.preventDefault();
  stepDraggedRow();
  placeDraggedRow();
  ensureAutoScroll();
}

function onDragEnd(event) {
  if (!pdfPanelDrag || event.pointerId !== pdfPanelDrag.pointerId) return;
  finishDrag(pdfPanelDrag.active);
}

function onDragCancel(event) {
  if (!pdfPanelDrag || event.pointerId !== pdfPanelDrag.pointerId) return;
  // A cancelled drag still leaves the rows where the reader put them; keep it.
  finishDrag(pdfPanelDrag.active);
}

function finishDrag(commit) {
  if (!pdfPanelDrag) return;
  const { row, active, before } = pdfPanelDrag;
  releaseDrag();
  if (!active) return;
  pdfPanelClickHushUntil = Date.now() + 350;
  row.classList.remove("is-dragging");
  pdfPanelList.classList.remove("is-arranging");
  pdfPanel.classList.remove("is-arranging");
  row.style.transform = "";
  if (commit && rowOrder().join(",") !== before) commitOrder();
}

function releaseDrag() {
  if (!pdfPanelDrag) return;
  clearTimeout(pdfPanelDrag.holdTimer);
  cancelAnimationFrame(pdfPanelDrag.scrollRaf);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragCancel);
  pdfPanelDrag = null;
}

// The row follows the pointer with a transform, measured from where the row
// now sits in the list's own layout (offsetTop, which a sibling's animation
// transform does not move), so a row that has just changed places in the DOM
// stays under the finger instead of jumping a whole row's height.
function placeDraggedRow() {
  if (!pdfPanelDrag?.active) return;
  const { row, startY, lastY, startTop, startScroll } = pdfPanelDrag;
  const offset = (lastY - startY) + (pdfPanelList.scrollTop - startScroll) - (row.offsetTop - startTop);
  row.style.transform = `translateY(${offset}px)`;
}

// Past the middle of a neighbour, swap with it. Several steps in one move are
// possible (a fast flick past two rows), so keep stepping until neither
// neighbour's midpoint has been crossed.
function stepDraggedRow() {
  if (!pdfPanelDrag?.active) return;
  const { row } = pdfPanelDrag;
  const y = pdfPanelDrag.lastY;
  for (let guard = 0; guard < pdfPanelList.children.length; guard += 1) {
    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    if (prev && y < layoutMidpoint(prev)) animateReflow(row, () => pdfPanelList.insertBefore(row, prev));
    else if (next && y > layoutMidpoint(next)) animateReflow(row, () => pdfPanelList.insertBefore(next, row));
    else break;
  }
}

// Where a row's middle is in the viewport by LAYOUT, not by its painted box:
// a neighbour still sliding into place must not be measured mid-slide, or two
// rows can trade places back and forth under a pointer that is not moving.
function layoutMidpoint(node) {
  const top = pdfPanelList.getBoundingClientRect().top + pdfPanelList.clientTop - pdfPanelList.scrollTop + node.offsetTop;
  return top + node.offsetHeight / 2;
}

// FLIP: measure every other row, move the DOM, then slide each one from where
// it was to where it now is — so the list visibly makes room for the row being
// carried instead of snapping.
function animateReflow(dragged, mutate, includeDragged = false) {
  const before = new Map();
  [...pdfPanelList.children].forEach((node) => {
    if (node !== dragged || includeDragged) before.set(node, node.getBoundingClientRect().top);
  });
  mutate();
  before.forEach((top, node) => {
    const delta = top - node.getBoundingClientRect().top;
    if (!delta) return;
    node.style.transition = "none";
    node.style.transform = `translateY(${delta}px)`;
    void node.offsetHeight;
    node.style.transition = "";
    node.style.transform = "";
  });
}

// Near the top or bottom edge of a long list, scroll it, and keep carrying the
// row while it does — a reader should not have to drop a paper halfway and pick
// it up again to move it past the fold.
function ensureAutoScroll() {
  if (!pdfPanelDrag?.active || pdfPanelDrag.scrollRaf) return;
  const tick = () => {
    if (!pdfPanelDrag?.active) return;
    pdfPanelDrag.scrollRaf = 0;
    const rect = pdfPanelList.getBoundingClientRect();
    const y = pdfPanelDrag.lastY;
    let speed = 0;
    if (y < rect.top + AUTOSCROLL_EDGE_PX) speed = -Math.ceil(AUTOSCROLL_MAX_PX * Math.min(1, (rect.top + AUTOSCROLL_EDGE_PX - y) / AUTOSCROLL_EDGE_PX));
    else if (y > rect.bottom - AUTOSCROLL_EDGE_PX) speed = Math.ceil(AUTOSCROLL_MAX_PX * Math.min(1, (y - (rect.bottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX));
    if (!speed) return;
    const was = pdfPanelList.scrollTop;
    pdfPanelList.scrollTop = was + speed;
    if (pdfPanelList.scrollTop === was) return;
    stepDraggedRow();
    placeDraggedRow();
    pdfPanelDrag.scrollRaf = requestAnimationFrame(tick);
  };
  pdfPanelDrag.scrollRaf = requestAnimationFrame(tick);
}

function rowOrder() {
  return [...pdfPanelList.children].map((row) => row.dataset.pdfId);
}

function commitOrder() {
  const ids = rowOrder();
  const current = deckPdfs(state.meta).map((entry) => entry.id);
  if (ids.length === current.length && ids.every((id, index) => id === current[index])) return;
  state.meta = withPdfOrder(state.meta, ids);
  scheduleDeckAutosave();
  renderDocumentPdfSwitcher();
}
