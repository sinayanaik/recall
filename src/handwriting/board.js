// The Handwritten Notes surface: a notebook that is a deck.
//
// ── Why it is a deck and not a new kind of thing ───────────────────────────
//
// Everything in this app is a deck. A PDF paper is a deck with meta.pdf; the
// Quick Notes board is a deck; a folder opened as one document is several decks
// read together. Nothing has ever been added as a table of its own, and the
// reason is not tidiness — it is that a deck already has a local snapshot, a
// cloud row, a per-key meta merge, folders, search, [[links]], an export, a
// backup entry and offline handling, and every one of those would have to be
// written again and checked again for a second entity. A notebook is a deck
// whose meta carries `pages`, and it inherited all of it on the day it existed.
//
// What that costs is written down in one place — src/sync/document-sync.js —
// and it is the same cost the highlights pay: meta is a JSONB column re-sent
// whole on every push, so the ink is encoded (a 30-page notebook of ordinary
// writing is about 350KB, measured in tools/ink-check.mjs) and the pages merge
// by id rather than last-write-wins.
//
// ── What is on the page ───────────────────────────────────────────────────
//
// Ink, through the shared engine, on the shared paper (src/handwriting/
// paper.js — the same stack the drawing sheet uses). And markdown text boxes,
// which are this file's own (src/handwriting/text-boxes.js), because a page of
// working usually wants both a derivation in your own hand and the statement of
// the problem typed above it.

import { HW_PAPERS, HW_PAGE_HEIGHT, HW_PAGE_WIDTH, addHandwritingPage, handwritingPageWithStrokes, makeHandwritingPage, moveHandwritingPage, normalizeHandwritingPaper, readHandwritingBoxes, readHandwritingPages, removeHandwritingPage } from "./pages.js?v=__BUILD__";
import { HW_ZOOM_STEP, createHandwritingPaper } from "./paper.js?v=__BUILD__";
import { buildInkNibs, buildInkPenSwatches, paintInkRailPressed, readInkRailPress } from "./rail.js?v=__BUILD__";
import { createHandwritingBoxes, makeHandwritingBox } from "./text-boxes.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let boardPaper = null;
let boardBoxes = null;
let boardOpen = false;
let boardRelayoutFrame = 0;

// ── Reading and writing the deck ───────────────────────────────────────────
//
// state.meta is replaced rather than mutated on every write, which is the rule
// every other writer of it keeps (see setDocumentInkForPage): the bag is spread
// into a new object so nothing downstream is holding the one that changed.

function boardPages() {
  return readHandwritingPages(state.meta);
}

function boardBoxList() {
  return readHandwritingBoxes(state.meta);
}

function writeMeta(patch) {
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), ...patch };
  scheduleDeckAutosave();
}

export function deckIsNotebook(meta = state.meta) {
  return readHandwritingPages(meta).length > 0;
}

export function notebookPageCount(meta) {
  return readHandwritingPages(meta).length;
}

// ── The panel ──────────────────────────────────────────────────────────────

function buildRail(rail) {
  // Guarded on the swatches themselves, not on the rail being empty: the rail
  // is NOT empty — the tools, the undo trio, the papers and the zoom pair are
  // written in index.html because they are fixed. Only the colours and the nibs
  // are built, because those come from the palette leaf. A childElementCount
  // check here meant they were never built at all.
  if (rail.querySelector("[data-ink-pen]")) return;
  const pens = document.createElement("div");
  pens.className = "ink-rail-group";
  pens.setAttribute("role", "group");
  pens.setAttribute("aria-label", "Pen colour");
  buildInkPenSwatches(pens);

  const widths = document.createElement("div");
  widths.className = "ink-rail-group";
  widths.setAttribute("role", "group");
  widths.setAttribute("aria-label", "Nib");
  buildInkNibs(widths);

  // Prepended, so the colours and the nibs read first — the order every other
  // rail in the app puts them in.
  rail.prepend(pens, widths);
}

function refreshRail() {
  const rail = el.hwRail;
  if (!rail || !boardPaper) return;
  const pen = boardPaper.engine;
  paintInkRailPressed(rail, { pen: pen.getPen(), width: pen.getWidth(), tool: pen.getTool() });
  el.hwBoard?.querySelectorAll("[data-ink-action]").forEach((node) => {
    const action = node.dataset.inkAction;
    if (action === "undo") node.toggleAttribute("disabled", !pen.canUndo());
    if (action === "redo") node.toggleAttribute("disabled", !pen.canRedo());
    if (action === "delete") node.toggleAttribute("disabled", !pen.hasSelection());
  });
  el.hwBoard?.querySelectorAll("[data-hw-paper-kind]").forEach((node) => {
    node.setAttribute("aria-pressed", node.dataset.hwPaperKind === currentPaperKind() ? "true" : "false");
  });
  paintSummary();
}

// The paper of the LAST page, which is what a new page will inherit and what
// the reader most recently chose. A notebook can hold three kinds at once —
// a page of ruled writing followed by a blank page for a diagram is the
// ordinary case, not an edge one.
function currentPaperKind() {
  const pages = boardPages();
  return pages.length ? pages[pages.length - 1].paper : normalizeHandwritingPaper(null);
}

function paintSummary() {
  if (!el.hwSummary) return;
  const pages = boardPages().length;
  const boxes = boardBoxList().length;
  el.hwSummary.textContent = pages
    ? `${pages} page${pages === 1 ? "" : "s"}${boxes ? ` · ${boxes} text box${boxes === 1 ? "" : "es"}` : ""}`
    : "No pages yet";
  if (el.hwTitle) el.hwTitle.textContent = state.deckTitle || "Handwritten notes";
}

// ── Ink ────────────────────────────────────────────────────────────────────

function onInkCommit(pageId, strokes) {
  const pages = boardPages();
  const next = pages.map((page) => (page.id === pageId ? handwritingPageWithStrokes(page, strokes) : page));
  writeMeta({ pages: next });
  refreshRail();
}

// ── Pages ──────────────────────────────────────────────────────────────────

function addPage() {
  const { pages, page } = addHandwritingPage(boardPages(), {});
  writeMeta({ pages });
  boardPaper.render();
  boardBoxes.render();
  boardPaper.pageElement(page.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  refreshRail();
}

function deletePage(pageId) {
  const pages = boardPages();
  if (pages.length < 2) {
    // Not an error, and not a control to disable either: "why is this greyed
    // out" is a worse question than a sentence answering it.
    showToast("A notebook keeps at least one page", "info");
    return;
  }
  const index = pages.findIndex((entry) => entry.id === pageId);
  if (index < 0) return;
  showConfirmModal(
    `Tear out page ${index + 1}? Everything written on it goes with it.`,
    () => {
      // Re-read rather than closing over `pages`: a confirm dialog is a wait,
      // and a sync landing during it would make the list in hand stale.
      const next = removeHandwritingPage(boardPages(), pageId);
      if (!next) return;
      // The boxes on the page go with it, and every id gets a tombstone — the
      // page's and each box's. Without them the next sync from the other device
      // sees records this one merely no longer has, and puts them all back.
      // Same rule and same shape as a deleted highlight's.
      const boxes = boardBoxList();
      const orphaned = boxes.filter((box) => box.page === pageId);
      const patch = {
        pages: next,
        deletedPageIds: recordDeletedMetaId(state.meta, "deletedPageIds", pageId)
      };
      if (orphaned.length) {
        patch.textBoxes = boxes.filter((box) => box.page !== pageId);
        patch.deletedTextBoxIds = orphaned.reduce(
          (bag, box) => recordDeletedMetaId({ deletedTextBoxIds: bag }, "deletedTextBoxIds", box.id),
          state.meta?.deletedTextBoxIds
        );
      }
      writeMeta(patch);
      boardPaper.render();
      boardBoxes.render();
      refreshRail();
    },
    { confirmLabel: "Tear it out", danger: true }
  );
}

function movePage(pageId, delta) {
  const next = moveHandwritingPage(boardPages(), pageId, delta);
  if (!next) return;
  writeMeta({ pages: next });
  boardPaper.render();
  boardBoxes.render();
  boardPaper.pageElement(pageId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  refreshRail();
}

function setPaperKind(kind) {
  const pages = boardPages();
  const next = pages.map((page) => ({ ...page, paper: normalizeHandwritingPaper(kind), at: Date.now() }));
  writeMeta({ pages: next });
  boardPaper.render();
  refreshRail();
}

// ── Text boxes ─────────────────────────────────────────────────────────────

function addBoxToPageInView() {
  const pages = boardPages();
  if (!pages.length) return;
  // Whichever page is nearest the middle of the scroller — the same question
  // the PDF pager asks, answered the same way, so "the page" always means the
  // page you are looking at.
  const middle = el.hwScroll.getBoundingClientRect();
  const centreY = middle.top + (middle.height / 2);
  const pageId = boardPaper.pageAt(middle.left + (middle.width / 2), centreY) || pages[0].id;
  const point = boardPaper.toModel(pageId, middle.left + (middle.width / 2), centreY) || { x: 80, y: 80 };
  const boxes = boardBoxList();
  const box = makeHandwritingBox({
    page: pageId,
    // Placed from its own top-left rather than centred on the point, and clamped
    // so a box added while scrolled to the foot of a page is not created off it.
    x: Math.max(16, Math.min(HW_PAGE_WIDTH - 316, point.x - 150)),
    y: Math.max(16, Math.min(HW_PAGE_HEIGHT - 136, point.y - 60)),
    taken: new Set(boxes.map((entry) => entry.id))
  });
  writeMeta({ textBoxes: [...boxes, box] });
  boardBoxes.render();
  refreshRail();
}

function onBoxesChanged(next, { removed = null } = {}) {
  const patch = { textBoxes: next };
  if (removed) patch.deletedTextBoxIds = recordDeletedMetaId(state.meta, "deletedTextBoxIds", removed);
  writeMeta(patch);
  boardBoxes.render();
  refreshRail();
}

// ── Input ──────────────────────────────────────────────────────────────────

function bindPointer(scroller) {
  let active = null;
  scroller.addEventListener("pointerdown", (event) => {
    if (!boardOpen || active) return;
    // A press on a text box belongs to the text box. Handled first and in the
    // same listener rather than in one of its own, so there is exactly one
    // answer to "what did this press mean".
    if (boardBoxes.onPointerDown(event) === false) return;
    if (event.button !== undefined && event.button > 0 && event.button !== 5) return;
    const page = boardPaper.pageAt(event.clientX, event.clientY);
    if (!page) return;
    // A press anywhere that is not a box also finishes an edit in progress:
    // clicking away from a textarea is how every other editor in this app
    // commits.
    boardBoxes.commitEdit();
    event.preventDefault();
    active = event.pointerId;
    try { scroller.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
    if (!boardPaper.engine.begin(page, [event], event)) active = null;
  });
  scroller.addEventListener("pointermove", (event) => {
    if (active === null || event.pointerId !== active) return;
    event.preventDefault();
    boardPaper.engine.move(event);
  });
  const finish = (event, cancelled) => {
    if (active === null || event.pointerId !== active) return;
    active = null;
    try { scroller.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    if (cancelled) boardPaper.engine.cancel();
    else { boardPaper.engine.move(event); boardPaper.engine.end(); }
    refreshRail();
  };
  scroller.addEventListener("pointerup", (event) => finish(event, false));
  scroller.addEventListener("pointercancel", (event) => finish(event, true));
  scroller.addEventListener("touchmove", (event) => { if (active !== null) event.preventDefault(); }, { passive: false });
}

function onBoardAction(event) {
  const button = readInkRailPress(event);
  if (!button || !boardPaper) return;
  const pen = boardPaper.engine;
  const data = button.dataset;
  if (data.inkPen) pen.setPen(data.inkPen);
  else if (data.inkWidth) pen.setWidth(Number(data.inkWidth));
  else if (data.inkTool) pen.setTool(data.inkTool);
  else if (data.inkAction === "undo") pen.undo();
  else if (data.inkAction === "redo") pen.redo();
  else if (data.inkAction === "delete") pen.deleteSelection();
  if (data.inkPen || data.inkWidth || data.inkTool) {
    writeInkPreferences({ pen: pen.getPen(), width: pen.getWidth(), tool: pen.getTool() });
  }
  refreshRail();
}

// ── Opening and closing ────────────────────────────────────────────────────

export function isHandwritingBoardOpen() {
  return boardOpen;
}

export function closeHandwritingBoard() {
  if (!boardOpen) return false;
  boardBoxes?.commitEdit();
  boardPaper?.engine.clearSelection();
  boardOpen = false;
  if (el.hwBoard) el.hwBoard.hidden = true;
  unlockPageScroll();
  return true;
}

function ensureBoard() {
  if (boardPaper) return true;
  if (!el.hwBoard || !el.hwScroll) return false;
  buildRail(el.hwRail);
  boardPaper = createHandwritingPaper({
    scroller: el.hwScroll,
    getPages: boardPages,
    onCommit: onInkCommit,
    onSelectionChange: () => refreshRail(),
    pageControls: true
  });
  boardBoxes = createHandwritingBoxes({
    paper: boardPaper,
    getBoxes: boardBoxList,
    onChange: onBoxesChanged
  });
  bindPointer(el.hwScroll);
  el.hwBoard.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-ink-pen], [data-ink-width], [data-ink-tool], [data-ink-action]")) onBoardAction(event);
  });
  el.hwBoard.addEventListener("click", (event) => {
    // The paper first, and not after an early return on [data-hw-action] — the
    // three paper buttons carry an attribute of their own, so a guard that bailed
    // when there was no hw-action made every one of them do nothing.
    const kind = event.target.closest("[data-hw-paper-kind]")?.dataset.hwPaperKind;
    if (kind && HW_PAPERS.includes(kind)) { setPaperKind(kind); return; }
    const action = event.target.closest("[data-hw-action]")?.dataset.hwAction;
    if (!action) return;
    if (action === "close") closeHandwritingBoard();
    else if (action === "add-page") addPage();
    else if (action === "add-box") addBoxToPageInView();
    else if (action === "zoom-in") { boardPaper.setZoom(boardPaper.zoom() * HW_ZOOM_STEP); boardBoxes.reposition(); }
    else if (action === "zoom-out") { boardPaper.setZoom(boardPaper.zoom() / HW_ZOOM_STEP); boardBoxes.reposition(); }
  });
  // Page controls live on the page, because "which page" is a question a
  // toolbar cannot answer for a scroller.
  el.hwScroll.addEventListener("click", (event) => {
    const control = event.target.closest("[data-hw-page-action]");
    if (!control) return;
    event.stopPropagation();
    const pageId = control.closest(".hw-page")?.dataset.hwPage;
    if (!pageId) return;
    const action = control.dataset.hwPageAction;
    if (action === "delete") deletePage(pageId);
    else if (action === "up") movePage(pageId, -1);
    else if (action === "down") movePage(pageId, 1);
  });
  window.addEventListener("resize", () => {
    if (!boardOpen || boardRelayoutFrame) return;
    boardRelayoutFrame = requestAnimationFrame(() => {
      boardRelayoutFrame = 0;
      boardPaper.relayout();
      boardBoxes.reposition();
    });
  });
  return true;
}

export function openHandwritingBoard() {
  if (!ensureBoard()) return false;
  // A deck with no pages gets its first one here rather than being shown an
  // empty scroller with a button in it. Handwriting is the thing this surface
  // is for; there is no state of it that is not a page.
  if (!boardPages().length) {
    writeMeta({ pages: [makeHandwritingPage({})] });
  }
  boardOpen = true;
  el.hwBoard.hidden = false;
  lockPageScroll();
  const saved = inkPreferences();
  boardPaper.engine.setPen(saved.pen);
  boardPaper.engine.setWidth(saved.width);
  boardPaper.engine.setTool(saved.tool);
  boardPaper.render();
  // Seeded explicitly: the records are the truth on open, whatever the engine
  // was left holding by the last notebook (see createHandwritingPaper.seed).
  boardPaper.seed();
  boardBoxes.render();
  el.hwScroll.scrollTop = 0;
  refreshRail();
  return true;
}

// No reset hook, and that is worth a line rather than a silence: the hosts the
// engine holds are keyed by PAGE ID, and render() forgets every host whose page
// is not in the stack it is rendering. So the first render after a different
// deck is opened forgets the last notebook's pages by itself. There is no key
// two notebooks can share — ids are minted per deck and checked against the ids
// that deck already holds — so there is nothing a stale entry could be mistaken
// for.
