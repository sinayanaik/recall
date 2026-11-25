// The Pages panel: every Canvas page as a small picture, in a column at the
// left of the Canvas — to see the whole Canvas at once, go to a page, pick
// pages, drag them into another order, and export, duplicate or delete just
// the pages picked.
//
// Opened from ▤ in the pager (#canvasPagesBtn), by pressing the "k / n" there,
// or from ⋯ → Canvas pages → Pages panel. Whether it is open is kept on this
// device only (PANEL_KEY), never synced.
//
// The pictures come from src/documents/canvas-page-thumbs.js, shared with the
// Pages tab of the ☰ drawer: drawn one at a time, only for the pages scrolled
// into the panel, and drawn again only for a page whose things changed. Every page change — a move, a delete, a duplicate —
// is one change of src/documents/notebook.js's (moveNotebookPages and the
// others), so the records, the page setups and the cards that show a spot of
// the Canvas all follow, exactly as for ⋯ → Canvas pages.
//
// The panel lives in whichever stage shows the Canvas in focus (el.documentStage
// while the Canvas is the part in focus), and stands down otherwise.

import { el } from "../core/dom.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { pageOrderAfterMove, pagesAfterOrder, isIdentityOrder } from "./canvas-page-list.js?v=__BUILD__";
import { documentPageInFocus, scrollToDocumentPage } from "./pdf-view.js?v=__BUILD__";
import { canvasThumbAspect, canvasThumbFileKey, canvasThumbHeld, copyCanvasThumb, dropCanvasThumbRequests, forgetCanvasThumbs, remapCanvasThumbs, wantCanvasThumb } from "./canvas-page-thumbs.js?v=__BUILD__";
import { deleteNotebookPages, duplicateNotebookPages, hasNotebook, moveNotebookPages, notebookPageCount } from "./notebook.js?v=__BUILD__";
import { closeCanvasPageMenu, openCanvasMenu, openCanvasPageMenu } from "./canvas-page-menu.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

const PAGES_PANEL_PANEL_KEY = "recall:canvas-pages-panel-v1";
// Who the panel's requests for pictures are from (canvas-page-thumbs.js).
const PAGES_PANEL_THUMB_OWNER = "pages-panel";
// A finger or a pen holds this long on a page before it is picked up to drag
// (and picked) — a shorter press is a tap, and a moving one scrolls the panel.
const PAGES_PANEL_HOLD_MS = 380;
// A mouse moves this far before a press is a drag rather than a click.
const PAGES_PANEL_DRAG_SLOP = 6;
// How often an open panel looks for pages whose things changed.
const PAGES_PANEL_WATCH_MS = 1200;

let ppHooks = { onChanged: () => {}, onSetup: () => {} };
let ppPanel = null;
let ppList = null;
let ppBar = null;
let ppSelection = new Set();
let ppAnchorPage = 0;
let ppSelectMode = false;
let ppLastTotal = 0;
let ppLastDeck = "";
let ppObserver = null;
let ppWatchTimer = 0;
let ppDrag = null;

function ppReadOpen() {
  try { return localStorage.getItem(PAGES_PANEL_PANEL_KEY) === "open"; } catch { return false; }
}

function ppWriteOpen(open) {
  try { localStorage.setItem(PAGES_PANEL_PANEL_KEY, open ? "open" : "closed"); } catch { /* no storage: the panel just forgets */ }
}

let ppWantOpen = false;

// The Canvas is the part in focus, and has pages.
function ppCanvasInFocus() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK && hasNotebook() && notebookPageCount() > 0 && Boolean(el.documentStage);
}

export function isCanvasPagesPanelOpen() {
  return Boolean(ppPanel && !ppPanel.hidden);
}

// The pages an export takes from the panel: the ones picked, while the panel
// is open on the Canvas in focus and they are fewer than every page. null is
// "every page" — what ⇓ has always exported.
export function canvasExportSelection() {
  if (!isCanvasPagesPanelOpen() || !ppCanvasInFocus()) return null;
  const total = notebookPageCount();
  const picked = [...ppSelection].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  if (!picked.length || picked.length >= total) return null;
  return picked;
}

export function toggleCanvasPagesPanel(force) {
  const open = typeof force === "boolean" ? force : !isCanvasPagesPanelOpen();
  ppWantOpen = open;
  ppWriteOpen(open);
  syncCanvasPagesPanel();
  if (open && isCanvasPagesPanelOpen()) {
    ppRevealPage(documentPageInFocus() || 1);
    ppList?.focus({ preventScroll: true });
  }
}

// ── Building ────────────────────────────────────────────────────────────────

function ppButton(className, label, title, onPress) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.innerHTML = label;
  node.title = title;
  node.setAttribute("aria-label", title);
  node.addEventListener("click", (event) => {
    event.preventDefault();
    onPress(node, event);
  });
  return node;
}

function ppBuildPanel() {
  ppPanel = document.createElement("aside");
  ppPanel.className = "canvas-pages-panel";
  ppPanel.id = "canvasPagesPanel";
  ppPanel.setAttribute("aria-label", "Canvas pages");
  ppPanel.hidden = true;

  const head = document.createElement("div");
  head.className = "cpp-head";
  const title = document.createElement("span");
  title.className = "cpp-title";
  title.textContent = "Pages";
  head.append(
    title,
    ppButton("cpp-close", "&times;", "Close the Pages panel", () => toggleCanvasPagesPanel(false))
  );

  ppBar = document.createElement("div");
  ppBar.className = "cpp-bar";

  ppList = document.createElement("div");
  ppList.className = "cpp-list";
  ppList.tabIndex = 0;
  ppList.setAttribute("role", "listbox");
  ppList.setAttribute("aria-multiselectable", "true");
  ppList.setAttribute("aria-label", "Canvas pages — press to go to one; Ctrl or Shift to pick several; drag to reorder");

  ppPanel.append(head, ppBar, ppList);

  ppList.addEventListener("pointerdown", ppOnItemPointerDown);
  ppList.addEventListener("contextmenu", ppOnItemContextMenu);
  ppList.addEventListener("keydown", ppOnListKey);
  // A finger dragging a page must not scroll the panel under it.
  ppList.addEventListener("touchmove", (event) => { if (ppDrag?.active) event.preventDefault(); }, { passive: false });
  // Nothing pressed in the panel is a press on the paper.
  ppPanel.addEventListener("pointerdown", (event) => event.stopPropagation());

  ppObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const page = Number(entry.target.dataset.page);
        if (page) ppWantThumb(page);
      });
    }, { root: ppList, rootMargin: "200px 0px" })
    : null;
}

function ppPaintBar() {
  if (!ppBar) return;
  const total = notebookPageCount();
  const picked = [...ppSelection].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const readOnly = documentViewOnly(DOC_SLOT_NOTEBOOK);
  ppBar.innerHTML = "";
  const some = picked.length > 0;
  const label = document.createElement("span");
  label.className = "cpp-picked";
  label.textContent = some ? `${picked.length} picked` : `${total} page${total === 1 ? "" : "s"}`;
  ppBar.append(label);
  ppBar.append(ppButton("cpp-btn", "Export&hellip;", some ? `Export the ${picked.length === 1 ? "picked page" : `${picked.length} picked pages`}` : "Export every page", (node) => ppOpenExportMenu(node)));
  if (!readOnly) {
    if (some) {
      ppBar.append(ppButton("cpp-btn", "Duplicate", picked.length === 1 ? `A copy of page ${picked[0]}, right after it` : "A copy of each picked page, right after it", () => ppDuplicatePicked()));
      ppBar.append(ppButton("cpp-btn is-danger", "Delete", picked.length === 1 ? `Delete page ${picked[0]}` : `Delete the ${picked.length} picked pages`, () => ppDeletePicked()));
    } else {
      ppBar.append(ppButton("cpp-btn", "&#43; Page", "Add a page at the end", () => ppAddPageAfter(total)));
    }
  }
  if (some || ppSelectMode) ppBar.append(ppButton("cpp-btn cpp-clear", "Clear", "Pick no pages — ⇓ exports every page again", () => ppClearSelection()));
}

function ppBuildItems() {
  const total = notebookPageCount();
  ppObserver?.disconnect();
  ppList.innerHTML = "";
  const indicator = document.createElement("div");
  indicator.className = "cpp-drop-line";
  indicator.hidden = true;
  ppList.append(indicator);
  for (let page = 1; page <= total; page += 1) {
    const item = document.createElement("div");
    item.className = "cpp-item";
    item.dataset.page = String(page);
    item.setAttribute("role", "option");
    item.title = `Page ${page} — press to go there; Ctrl or Shift to pick several; drag to move; right-click for more`;
    const frame = document.createElement("div");
    frame.className = "cpp-thumb";
    frame.style.aspectRatio = canvasThumbAspect(page);
    const held = canvasThumbHeld(page);
    if (held) frame.append(copyCanvasThumb(held));
    const num = document.createElement("span");
    num.className = "cpp-num";
    num.textContent = String(page);
    const check = document.createElement("span");
    check.className = "cpp-check";
    check.setAttribute("aria-hidden", "true");
    item.append(frame, num, check);
    ppList.append(item);
    ppObserver?.observe(item);
  }
  ppLastTotal = total;
  ppPaintSelection();
}

function ppItemOf(page) {
  return ppList?.querySelector(`.cpp-item[data-page="${page}"]`) || null;
}

function ppPaintSelection() {
  if (!ppList) return;
  const current = Number(documentPageInFocus()) || 0;
  ppList.classList.toggle("is-select-mode", ppSelectMode);
  ppList.querySelectorAll(".cpp-item").forEach((item) => {
    const page = Number(item.dataset.page);
    const picked = ppSelection.has(page);
    item.classList.toggle("is-picked", picked);
    item.classList.toggle("is-current", page === current);
    item.setAttribute("aria-selected", picked ? "true" : "false");
  });
  ppPaintBar();
}

function ppRevealPage(page) {
  const item = ppItemOf(page);
  if (!item || !ppList) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < ppList.scrollTop || bottom > ppList.scrollTop + ppList.clientHeight) {
    ppList.scrollTop = Math.max(0, top - (ppList.clientHeight - item.offsetHeight) / 2);
  }
}

// ── The pictures ────────────────────────────────────────────────────────────

function ppWantThumb(page) {
  wantCanvasThumb(page, PAGES_PANEL_THUMB_OWNER, (drawn, canvas) => {
    if (!isCanvasPagesPanelOpen()) return;
    const frame = ppItemOf(drawn)?.querySelector(".cpp-thumb");
    if (frame) frame.replaceChildren(copyCanvasThumb(canvas));
  });
}

function ppVisiblePages() {
  if (!ppList) return [];
  const top = ppList.scrollTop - 200;
  const bottom = ppList.scrollTop + ppList.clientHeight + 200;
  return [...ppList.querySelectorAll(".cpp-item")]
    .filter((item) => item.offsetTop + item.offsetHeight >= top && item.offsetTop <= bottom)
    .map((item) => Number(item.dataset.page));
}

function ppWatchPages() {
  clearTimeout(ppWatchTimer);
  if (!isCanvasPagesPanelOpen()) return;
  if (document.visibilityState !== "hidden" && !ppDrag) ppVisiblePages().forEach(ppWantThumb);
  ppWatchTimer = setTimeout(ppWatchPages, PAGES_PANEL_WATCH_MS);
}

// ── Keeping up with the Canvas ──────────────────────────────────────────────

// Called whenever the page in view, the open file or the Canvas's pages may
// have changed (src/main.js: the page indicator's hook, a document opening,
// marks changing). Cheap when nothing did.
export function syncCanvasPagesPanel() {
  if (!ppPanel) return;
  const show = ppWantOpen && ppCanvasInFocus();
  if (!show) {
    if (!ppPanel.hidden) {
      ppPanel.hidden = true;
      ppPanel.parentElement?.classList.remove("has-pages-panel");
      dropCanvasThumbRequests(PAGES_PANEL_THUMB_OWNER);
      closeCanvasPageMenu();
    }
    ppPaintPagerButton();
    return;
  }
  const stage = el.documentStage;
  if (ppPanel.parentElement !== stage) {
    ppPanel.parentElement?.classList.remove("has-pages-panel");
    stage.appendChild(ppPanel);
  }
  const deck = canvasThumbFileKey();
  if (deck !== ppLastDeck) {
    ppLastDeck = deck;
    ppSelection = new Set();
    ppAnchorPage = 0;
    ppSelectMode = false;
    ppLastTotal = -1;
  }
  const opening = ppPanel.hidden;
  ppPanel.hidden = false;
  stage.classList.add("has-pages-panel");
  // Level with the top of the pages: the pen's bar and the tab row above them
  // stay where they are.
  const top = `${Math.max(0, el.documentView?.offsetTop || 0)}px`;
  if (ppPanel.style.top !== top) ppPanel.style.top = top;
  if (ppLastTotal !== notebookPageCount() || !ppList.childElementCount) {
    const total = notebookPageCount();
    ppSelection = new Set([...ppSelection].filter((page) => page <= total));
    ppBuildItems();
  } else {
    ppPaintSelection();
  }
  if (opening) {
    ppWatchPages();
    ppRevealPage(documentPageInFocus() || 1);
  }
  ppPaintPagerButton();
}

function ppPaintPagerButton() {
  const open = isCanvasPagesPanelOpen();
  const btn = document.getElementById("canvasPagesBtn");
  if (btn) {
    btn.classList.toggle("is-active", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
  }
}

// After a page change: the pictures follow their pages (`order` is the new
// order, as old page numbers), and the panel is rebuilt for the new count.
function ppAfterPageChange({ order = null, select = null, scrollTo = 0 } = {}) {
  remapCanvasThumbs(order);
  if (select) {
    ppSelection = new Set(select);
    ppAnchorPage = select[0] || 0;
  }
  ppLastTotal = -1;
  ppHooks.onChanged?.();
  syncCanvasPagesPanel();
  if (scrollTo) {
    ppRevealPage(scrollTo);
    setTimeout(() => scrollToDocumentPage(scrollTo, 0, { smooth: true }), 60);
  }
}

// ── Picking ─────────────────────────────────────────────────────────────────

function ppClearSelection() {
  ppSelection = new Set();
  ppSelectMode = false;
  ppPaintSelection();
}

function ppPickRange(from, to) {
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let page = a; page <= b; page += 1) ppSelection.add(page);
}

function ppPressPage(page, event) {
  const additive = event && (event.ctrlKey || event.metaKey);
  const range = event && event.shiftKey && ppAnchorPage;
  if (range) {
    if (!additive) ppSelection = new Set();
    ppPickRange(ppAnchorPage, page);
  } else if (additive || ppSelectMode) {
    if (ppSelection.has(page)) ppSelection.delete(page);
    else ppSelection.add(page);
    ppAnchorPage = page;
  } else {
    // A plain press goes to the page and picks nothing: picking is what ⇓
    // exports, so it is never done by a press made only to get somewhere.
    // Ctrl or Shift (or a hold, on a touch screen) picks.
    ppSelection = new Set();
    ppAnchorPage = page;
    scrollToDocumentPage(page, 0, { smooth: true });
  }
  if (!ppSelection.size && ppSelectMode) ppSelectMode = false;
  ppPaintSelection();
}

function ppOnListKey(event) {
  const total = notebookPageCount();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    ppSelection = new Set(Array.from({ length: total }, (_, i) => i + 1));
    ppPaintSelection();
    return;
  }
  if (event.key === "Escape") {
    if (ppSelection.size) { event.preventDefault(); event.stopPropagation(); ppClearSelection(); }
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const step = event.key === "ArrowUp" ? -1 : 1;
    if (event.altKey && ppSelection.size && !documentViewOnly(DOC_SLOT_NOTEBOOK)) {
      const picked = [...ppSelection].sort((a, b) => a - b);
      const before = step < 0 ? picked[0] - 1 : picked[picked.length - 1] + 2;
      if (before >= 1 && before <= total + 1) ppMovePages(picked, before);
      return;
    }
    const from = ppAnchorPage || Number(documentPageInFocus()) || 1;
    const to = Math.min(total, Math.max(1, from + step));
    ppPressPage(to, event.shiftKey ? { shiftKey: true } : null);
    ppRevealPage(to);
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && ppSelection.size && !documentViewOnly(DOC_SLOT_NOTEBOOK)) {
    event.preventDefault();
    ppDeletePicked();
  }
}

// ── Dragging pages into another order ───────────────────────────────────────

function ppOnItemPointerDown(event) {
  const item = event.target.closest?.(".cpp-item");
  if (!item || event.button > 0) return;
  closeCanvasPageMenu();
  const page = Number(item.dataset.page);
  const touch = event.pointerType === "touch" || event.pointerType === "pen";
  ppDrag = {
    id: event.pointerId,
    page,
    item,
    x: event.clientX,
    y: event.clientY,
    touch,
    active: false,
    held: false,
    before: 0,
    timer: 0,
    event
  };
  if (touch) {
    ppDrag.timer = setTimeout(() => {
      if (!ppDrag || ppDrag.active) return;
      ppDrag.held = true;
      // A hold picks the page (and, with nothing else picked, starts picking
      // by taps), and lifts it to be dragged.
      if (!ppSelection.has(page)) {
        if (!ppSelectMode) ppSelection = new Set();
        ppSelection.add(page);
        ppAnchorPage = page;
      }
      ppSelectMode = true;
      ppPaintSelection();
      if (!documentViewOnly(DOC_SLOT_NOTEBOOK)) ppStartDrag();
      navigator.vibrate?.(10);
    }, PAGES_PANEL_HOLD_MS);
  }
  window.addEventListener("pointermove", ppOnDragMove, true);
  window.addEventListener("pointerup", ppOnDragEnd, true);
  window.addEventListener("pointercancel", ppOnDragCancel, true);
}

function ppStartDrag() {
  if (!ppDrag || ppDrag.active) return;
  ppDrag.active = true;
  try { ppList.setPointerCapture?.(ppDrag.id); } catch { /* not capturable: the window listeners still see it */ }
  // A picked page carries every picked page with it; any other is dragged on
  // its own, and is not left picked once it lands.
  ppDrag.carried = ppSelection.has(ppDrag.page) ? [...ppSelection].sort((a, b) => a - b) : [ppDrag.page];
  ppDrag.carried.forEach((page) => ppItemOf(page)?.classList.add("is-carried"));
  ppList.classList.add("is-dragging");
  ppPaintSelection();
}

function ppOnDragMove(event) {
  if (!ppDrag || event.pointerId !== ppDrag.id) return;
  if (!ppDrag.active) {
    const far = Math.hypot(event.clientX - ppDrag.x, event.clientY - ppDrag.y) > PAGES_PANEL_DRAG_SLOP;
    if (!far) return;
    // A finger that moves before its hold is up is scrolling the panel.
    if (ppDrag.touch) { ppEndDrag(); return; }
    if (documentViewOnly(DOC_SLOT_NOTEBOOK)) return;
    ppStartDrag();
  }
  event.preventDefault();
  ppPlaceDropLine(event.clientY);
  // Near the top or the foot of the panel, it scrolls.
  const box = ppList.getBoundingClientRect();
  if (event.clientY < box.top + 32) ppList.scrollTop -= 12;
  else if (event.clientY > box.bottom - 32) ppList.scrollTop += 12;
}

// Where a drop at `clientY` puts the pages: before the first page whose middle
// is below the pointer.
function ppPlaceDropLine(clientY) {
  const items = [...ppList.querySelectorAll(".cpp-item")];
  const line = ppList.querySelector(".cpp-drop-line");
  let before = items.length + 1;
  for (const item of items) {
    const box = item.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) { before = Number(item.dataset.page); break; }
  }
  ppDrag.before = before;
  if (!line) return;
  const target = ppItemOf(before);
  const last = items[items.length - 1];
  const y = target ? target.offsetTop - 5 : (last ? last.offsetTop + last.offsetHeight + 3 : 0);
  line.style.top = `${y}px`;
  line.hidden = false;
}

function ppOnDragEnd(event) {
  if (!ppDrag || event.pointerId !== ppDrag.id) return;
  const was = ppDrag;
  ppEndDrag();
  if (was.active) {
    if (was.before) ppMovePages(was.carried || [was.page], was.before);
    return;
  }
  if (was.held) return; // the hold already picked it
  ppPressPage(was.page, was.event);
}

function ppOnDragCancel(event) {
  if (!ppDrag || event.pointerId !== ppDrag.id) return;
  ppEndDrag();
}

function ppEndDrag() {
  if (!ppDrag) return;
  clearTimeout(ppDrag.timer);
  try { ppList.releasePointerCapture?.(ppDrag.id); } catch { /* already let go */ }
  ppDrag = null;
  ppList?.classList.remove("is-dragging");
  ppList?.querySelectorAll(".cpp-item.is-carried").forEach((item) => item.classList.remove("is-carried"));
  const line = ppList?.querySelector(".cpp-drop-line");
  if (line) line.hidden = true;
  window.removeEventListener("pointermove", ppOnDragMove, true);
  window.removeEventListener("pointerup", ppOnDragEnd, true);
  window.removeEventListener("pointercancel", ppOnDragCancel, true);
}

// ── What the panel does to pages ────────────────────────────────────────────

async function ppMovePages(pages, before) {
  const total = notebookPageCount();
  const order = pageOrderAfterMove(total, pages, before);
  if (isIdentityOrder(order)) return;
  if (!(await moveNotebookPages(pages, before))) return;
  const landed = pagesAfterOrder(pages, order);
  // What was picked stays picked, wherever its page went; a page dragged
  // without being picked is not picked by it.
  const picked = pagesAfterOrder([...ppSelection], order);
  ppAfterPageChange({ order, select: picked, scrollTo: landed[0] });
}

async function ppDuplicatePicked() {
  const picked = [...ppSelection].sort((a, b) => a - b);
  if (!picked.length) return;
  if (!(await duplicateNotebookPages(picked))) return;
  // Each copy is straight after its page, so page p (the k-th picked, from 0)
  // is now p + k, and its copy p + k + 1. The copies are picked.
  const copies = picked.map((page, k) => page + k + 1);
  forgetCanvasThumbs();
  ppAfterPageChange({ select: copies, scrollTo: copies[0] });
}

function ppDeletePicked() {
  const picked = [...ppSelection].sort((a, b) => a - b);
  const total = notebookPageCount();
  if (!picked.length) return;
  if (picked.length >= total) {
    showToast("A canvas keeps at least one page", "info");
    return;
  }
  const question = picked.length === 1
    ? `Delete page ${picked[0]} of ${total}? Everything on it goes with it.`
    : `Delete ${picked.length} pages of ${total}? Everything on them goes with them.`;
  showConfirmModal(question, async () => {
    if (!(await deleteNotebookPages(picked))) return;
    forgetCanvasThumbs();
    ppAfterPageChange({ select: [] });
  }, { confirmLabel: picked.length === 1 ? "Delete page" : `Delete ${picked.length} pages`, danger: true });
}

async function ppAddPageAfter(after) {
  const { addNotebookPage } = await import("./notebook.js?v=__BUILD__");
  if (!(await addNotebookPage({ after }))) return;
  ppAfterPageChange({ select: [after + 1], scrollTo: after + 1 });
}

async function ppExportPages(format, pages) {
  const { exportCanvasHtml, exportCanvasPdf } = await import("../export/run.js?v=__BUILD__");
  if (format === "html") exportCanvasHtml({ pages });
  else exportCanvasPdf({ pages });
}

function ppOpenExportMenu(anchor) {
  const total = notebookPageCount();
  const picked = [...ppSelection].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const pages = picked.length && picked.length < total ? picked : null;
  const which = !pages ? `Every page (${total})` : (pages.length === 1 ? `Page ${pages[0]}` : `${pages.length} picked pages`);
  openCanvasMenu({
    anchor,
    heading: `Export — ${which}`,
    items: [
      ["pdf", "PDF", { title: `${which}, exactly as it looks` }],
      ["html", "Web page (.html)", { title: `${which}, in one file that opens in any browser — moving pictures play` }]
    ],
    onChoose: (action) => ppExportPages(action, pages)
  });
}

function ppOnItemContextMenu(event) {
  const item = event.target.closest?.(".cpp-item");
  if (!item) return;
  event.preventDefault();
  ppEndDrag();
  const page = Number(item.dataset.page);
  const total = notebookPageCount();
  if (documentViewOnly(DOC_SLOT_NOTEBOOK)) {
    openCanvasMenu({
      anchor: item,
      heading: `Page ${page} of ${total}`,
      items: [
        ["pdf", "Export this page as PDF", { title: `Page ${page} alone, as a PDF` }],
        ["html", "Export this page as a web page", { title: `Page ${page} alone, as one file that opens in any browser` }]
      ],
      onChoose: (action) => ppExportPages(action, [page])
    });
    return;
  }
  openCanvasPageMenu({
    anchor: item,
    page,
    total,
    onPageUp: () => ppMovePages([page], page - 1),
    onPageDown: () => ppMovePages([page], page + 2),
    onDuplicate: async () => {
      if (!(await duplicateNotebookPages([page]))) return;
      forgetCanvasThumbs();
      ppAfterPageChange({ select: [page + 1], scrollTo: page + 1 });
    },
    onSetup: () => ppHooks.onSetup?.(page, () => { forgetCanvasThumbs([page]); ppAfterPageChange(); }),
    onDelete: () => { ppSelection = new Set([page]); ppDeletePicked(); },
    onExportPdf: () => ppExportPages("pdf", [page]),
    onExportHtml: () => ppExportPages("html", [page])
  });
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// `onChanged`: repaint the Canvas's own controls after a page change
// (paintHandwritingControls, src/handwriting/board.js). `onSetup(page, done)`:
// open Page setup… for a page.
export function initCanvasPagesPanel(options = {}) {
  ppHooks = { ...ppHooks, ...options };
  if (ppPanel) return;
  ppBuildPanel();
  ppWantOpen = ppReadOpen();
  document.getElementById("canvasPagesBtn")?.addEventListener("click", () => toggleCanvasPagesPanel());
  // The "k / n" in the pager opens it too, on the Canvas.
  el.documentPageIndicator?.addEventListener("click", () => {
    if (activeDocSlot() === DOC_SLOT_NOTEBOOK && hasNotebook()) toggleCanvasPagesPanel();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ppWatchPages(); });
  syncCanvasPagesPanel();
}
