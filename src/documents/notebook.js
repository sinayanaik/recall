// A notebook: the Document surface, with paper this app wrote itself.
//
// ── Why a notebook is a PDF and not a canvas ──────────────────────────────
//
// Because writing on a paper already worked, and a notebook is a paper whose
// words have not been written yet. Everything the Document surface does — pdf.js
// laying out the pages, the pen storing strokes in that document's user space
// (which is what makes them survive a zoom, a rotate, a reload and a second
// device), the pager, dark page, the annotated export, the device store, the
// backup that packs the bytes — is already built and already checked. A notebook
// made of anything else needs a second version of every one of them, and this
// repository has one of those and does not want two.
//
// So the paper is a real file (src/documents/blank-pdf.js), attached to the deck
// exactly as a document is — but in a slot of its own, `meta.notebook`
// (src/documents/doc-slot.js), beside whatever paper the deck already carries in
// `meta.pdf`. The slot is the whole difference. It is what says these bytes were
// generated rather than given to us, which is what makes it safe to REGENERATE
// them when a page is added, torn out, or the paper changed — none of which may
// ever happen to somebody's actual document.
//
// It used to live in `meta.pdf` with a `notebook: true` flag on it, and that is
// what made the app say "This deck already has a PDF — its handwriting goes on
// that" to anybody who wanted to write beside a paper they were reading. One
// shelf, two things that want to be on it. Decks in that state are moved here on
// open (migrateNotebookSlot below).
//
// ── What regenerating costs ────────────────────────────────────────────────
//
// Very little, and deliberately: every page shares one content stream, so sixty
// pages of grid is under ten kilobytes. That is the number that makes "add a
// page" a rewrite of the whole file rather than an incremental edit — the
// simplest thing that could work, and it works because the file is tiny.
//
// The ink does not move. It is stored per page in PDF user space and the page
// box never changes, so adding a page at the end is invisible to every stroke
// already on the others. Tearing one OUT is the only case that touches them, and
// it is a renumbering: see remapDocumentHighlightPages.

import { BLANK_PAPERS, BLANK_PAGE_HEIGHT, BLANK_PAGE_WIDTH, BLANK_PAPER_VERSION, blankPdfFile, normalizeBlankPaper } from "./blank-pdf.js?v=__BUILD__";
import { canvasMeasureBox, canvasPageBox, canvasPageBoxes, canvasSnapGridFor, canvasWideSheetSetup, nearestLegacyPaper, normalizeSheetSetup, remapPageSetups, sameSheet, sheetDrawKey, sheetFit, sheetLegacyKind, sheetPatternDefaults, sheetSetupForPage, validPageBox } from "./canvas-setup.js?v=__BUILD__";
import { canvasDragLimits, neededPageBox, pageContentRects, samePageBox } from "./canvas-extent.js?v=__BUILD__";
import { recordsForSurface } from "./pdf-multi.js?v=__BUILD__";
import { inkPenIsDown } from "../core/gesture.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, docSlotMeta, documentStoreKey } from "./doc-slot.js?v=__BUILD__";
import { hasLegacyNotebook, hasNotebookInPdfSlot, migratedNotebookMeta, movedNotebookSlotMeta, planLegacyNotebookMigration } from "./notebook-migrate.js?v=__BUILD__";
import { documentBlocks, freshDocumentBlockId, remapDocumentBlockPages, writeDocumentBlocks } from "./pdf-blocks.js?v=__BUILD__";
import { applyDocumentRecordChanges, documentHighlights, freshDocumentHighlightId, remapDocumentHighlightPages } from "./pdf-highlights.js?v=__BUILD__";
import { deleteLocalDocument, documentEntryMatches, putDocument, readDocument, sha256, uploadDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentView, swapOpenCanvasBytes } from "./pdf-view.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { storageFolderSlug } from "../images/upload.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { deleteDocumentCopies } from "../storage/document-migration.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export const NOTEBOOK_MAX_PAGES = 300;

// ── One page change at a time ──────────────────────────────────────────────
//
// Every change here renumbers records and rewrites the file: the Blocks, the
// marks and the page setups are moved to the new numbering at once, and the
// file is drawn again from it. A second change started before the first has
// put its file on screen reads a record that is half the old Canvas and half
// the new one, and renumbers everything a second time — which is what "＋ Page
// pressed twice" used to do: Blocks two pages down, a landscape page's setup
// copied onto the portrait page under a Block, and all of it saved and synced.
// The second press's page number also came from the pages about to be
// replaced. So a change asked for while one is running is refused, not
// queued; the ＋ Page pills and the Canvas's pages take no presses meanwhile
// (body.canvas-pages-busy, styles/53-handwriting.css).
let pageChangeRunning = false;

// The fit of a page to what is on it in progress, if one is (see "Pages that
// grow" below): a page change waits for it rather than being refused. Unlike a
// page change it renumbers nothing, so the pages stay pressable throughout —
// the pen is never held up by a page growing under it.
let extentFitRunning = null;

export function notebookPagesBusy() {
  return pageChangeRunning;
}

async function runCanvasPageChange(change) {
  // A page fitting to what is on it finishes first: it renumbers nothing, and
  // the change after it reads the file it wrote.
  if (extentFitRunning) await extentFitRunning.catch(() => {});
  if (pageChangeRunning) {
    showToast("Still making the last page change — one moment", "info");
    return false;
  }
  pageChangeRunning = true;
  document.body?.classList.add("canvas-pages-busy");
  try {
    return await change();
  } finally {
    pageChangeRunning = false;
    document.body?.classList.remove("canvas-pages-busy");
  }
}

export function hasNotebook(meta = state.meta) {
  return Boolean(meta?.notebook);
}

export function notebookPaper(meta = state.meta) {
  return normalizeBlankPaper(meta?.notebook?.paper);
}

export function notebookPageCount(meta = state.meta) {
  return Number(meta?.notebook?.pages) || 0;
}

// Whether each Canvas page shows "k / n" at its foot — on screen and in the
// export, which draws it in the same place. On unless turned off: a missing
// value is on, so every Canvas already made has its numbers without a write.
// Kept on the record rather than in the paper, so turning it off or on makes no
// new bytes (a Canvas's bytes are its identity — see writeNotebookPdf).
export function notebookPageNumbers(meta = state.meta) {
  return meta?.notebook?.pageNumbers !== false;
}

export async function setNotebookPageNumbers(on) {
  if (!hasNotebook()) return false;
  const want = Boolean(on);
  if (notebookPageNumbers() === want) return false;
  const notebook = { ...state.meta.notebook };
  if (want) delete notebook.pageNumbers;
  else notebook.pageNumbers = false;
  state.meta = { ...state.meta, notebook };
  await saveDeckToLibrary({ silent: true });
  return true;
}

// ── Page setup ─────────────────────────────────────────────────────────────
//
// Each page's size, paper and lines (src/documents/canvas-setup.js). Kept on
// the record beside `paper` and `pages`, because the bytes are drawn from it:
// `setup` for every page without its own, `pageSetups` for the ones set up on
// their own. Both absent is a Canvas that was never set up, drawn exactly as it
// always was.
function notebookSheetState(meta = state.meta) {
  const notebook = meta?.notebook;
  const setup = notebook?.setup && typeof notebook.setup === "object" ? notebook.setup : null;
  const pageSetups = notebook?.pageSetups && typeof notebook.pageSetups === "object" && Object.keys(notebook.pageSetups).length
    ? notebook.pageSetups
    : null;
  const pageBoxes = notebook?.pageBoxes && typeof notebook.pageBoxes === "object" && Object.keys(notebook.pageBoxes).length
    ? notebook.pageBoxes
    : null;
  return { setup, pageSetups, pageBoxes };
}

// The setup page `n` is drawn with, complete — its own, the Canvas's, or the
// paper the Canvas was made on.
export function notebookPageSetup(n, meta = state.meta) {
  return sheetSetupForPage(meta?.notebook, n);
}

// The setup every page without its own is drawn with.
export function notebookCanvasSetup(meta = state.meta) {
  return canvasWideSheetSetup(meta?.notebook);
}

// Whether page `n` is set up on its own rather than following the Canvas.
export function notebookPageHasOwnSetup(n, meta = state.meta) {
  return Boolean(notebookSheetState(meta).pageSetups?.[String(n)]);
}

export function notebookPageBoxes(meta = state.meta) {
  return canvasPageBoxes(meta?.notebook);
}

// Where page `n` reaches now: grown past its size, Boundless, or as set up.
export function notebookPageBox(n, meta = state.meta) {
  return canvasPageBox(meta?.notebook, Number(n) || 1);
}

// The box page `n` is measured by — its size as set up, whatever it has grown
// to (canvas-setup.js, canvasMeasureBox): the widest a Block grows and the
// width a dropped picture lands at stay the page's own.
export function notebookPageMeasureBox(n, meta = state.meta) {
  return canvasMeasureBox(meta?.notebook, Number(n) || 1);
}

// "grow", "set" or "boundless" for page `n`.
export function notebookPageFit(n, meta = state.meta) {
  if (!hasNotebook(meta)) return "set";
  return sheetFit(notebookPageSetup(Number(n) || 1, meta));
}

// How far a drag may carry something on page `n` (canvas-extent.js): the page
// itself, unless the page grows or is Boundless.
export function notebookDragLimits(n, box) {
  return canvasDragLimits(notebookPageFit(n), box);
}

// The squares a box dragged on page `page` settles onto, or null.
export function canvasSnapGrid(page, meta = state.meta) {
  if (!hasNotebook(meta)) return null;
  return canvasSnapGridFor(notebookPageSetup(Number(page) || 1, meta));
}

// The page setups straight onto the record, with no new bytes — for the
// changes that move a setup between pages without changing what any page
// looks like.
function writeNotebookSheetState(setup, pageSetups, pageBoxes = undefined) {
  const notebook = { ...state.meta.notebook };
  if (setup) notebook.setup = setup;
  else delete notebook.setup;
  if (pageSetups && Object.keys(pageSetups).length) notebook.pageSetups = pageSetups;
  else delete notebook.pageSetups;
  if (pageBoxes !== undefined) {
    if (pageBoxes && Object.keys(pageBoxes).length) notebook.pageBoxes = pageBoxes;
    else delete notebook.pageBoxes;
  }
  state.meta = { ...state.meta, notebook };
}

// ── Pages that grow, and Boundless pages ───────────────────────────────────
//
// A page set up to grow as needed, or Boundless, reaches as far as what is on
// it (src/documents/canvas-extent.js). Where it reaches is kept on the record
// as `pageBoxes` ({ "<page>": [x0, y0, x1, y1] }, only for a page that reaches
// past the size it is set up at), because the bytes are drawn from it: a
// device that has the record and not the file draws the same file again.
//
// `boxSha` is the hash of the bytes last drawn with those boxes. A build from
// before pages grew knows nothing of `pageBoxes` and, re-making the file from
// the record, draws every page at its set size under the same record; the
// hash it stamps then differs from `boxSha`, which is how this build knows to
// draw them again (ensureNotebookDocument).

// The Canvas's marks and Blocks, page by page — the Canvas's own, whichever
// part is in focus.
function canvasRecordsByPage() {
  const byPage = new Map();
  const add = (key, record) => {
    const page = Number(record?.page) || 0;
    if (!page) return;
    if (!byPage.has(page)) byPage.set(page, { marks: [], blocks: [] });
    byPage.get(page)[key].push(record);
  };
  recordsForSurface(state.meta?.pdfHighlights, DOC_SLOT_NOTEBOOK, null).forEach((record) => add("marks", record));
  recordsForSurface(state.meta?.pdfBlocks, DOC_SLOT_NOTEBOOK, null).forEach((block) => add("blocks", block));
  return byPage;
}

// Every page's box as what is on it asks, for a record as it stands (or with
// the setups about to be written): only the pages reaching past their size.
// Null when none do. `only` is the pages to fit (a Set of numbers); every
// other page keeps the box it has.
function neededNotebookPageBoxes(record = state.meta?.notebook, { only = null, byPage = canvasRecordsByPage(), past = false } = {}) {
  const pages = Number(record?.pages) || 0;
  if (!pages) return null;
  const held = record?.pageBoxes && typeof record.pageBoxes === "object" ? record.pageBoxes : {};
  const out = {};
  for (let n = 1; n <= pages; n += 1) {
    const setup = sheetSetupForPage(record, n);
    if (sheetFit(setup) === "set") continue;
    const now = validPageBox(held[String(n)]);
    let box;
    if (only && !only.has(n)) box = now;
    else {
      const on = byPage.get(n) || { marks: [], blocks: [] };
      box = neededPageBox(setup, pageContentRects(on.marks, on.blocks), now, { past });
    }
    if (box && !samePageBox(box, canvasMeasureBox(record, n))) out[String(n)] = box;
  }
  return Object.keys(out).length ? out : null;
}

// ── Only the pages something was done to ────────────────────────────────
//
// Every page grows as needed, the pages of every Canvas made before pages
// could grow included — and some of those were written to their very foot.
// Fitting every page after any edit would grow a page nobody touched, on
// opening, on another device, in the middle of reading. So what is on each
// page is remembered as it was when the Canvas was opened (and after each
// fit), and only a page whose things have changed since is fitted.
let fitMemory = { deck: null, pages: new Map() };

function pageSignature(on) {
  if (!on) return "";
  return JSON.stringify(pageContentRects(on.marks, on.blocks).map((rect) => rect.map((v) => Math.round(v))));
}

function rememberCanvasPages(byPage = canvasRecordsByPage()) {
  const pages = new Map();
  byPage.forEach((on, n) => pages.set(n, pageSignature(on)));
  fitMemory = { deck: state.localDeckId || null, pages };
}

// The pages whose things changed since they were remembered, or null when
// nothing was remembered for this file (every page is then fitted).
function changedCanvasPages(byPage) {
  if (fitMemory.deck !== (state.localDeckId || null)) return null;
  const changed = new Set();
  const all = new Set([...byPage.keys(), ...fitMemory.pages.keys()]);
  all.forEach((n) => {
    if (pageSignature(byPage.get(n)) !== (fitMemory.pages.get(n) || "")) changed.add(n);
  });
  return changed;
}

function samePageBoxes(a, b) {
  const x = a && typeof a === "object" ? a : {};
  const y = b && typeof b === "object" ? b : {};
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) {
    if (!samePageBox(x[key] || null, y[key] || null)) return false;
  }
  return true;
}

// Whether any page of the Canvas grows or is Boundless — the cheap question
// every edit asks before it asks for more. Every page does, unless set to its
// size.
function canvasHasGrowingPages(record = state.meta?.notebook) {
  if (!record) return false;
  if (sheetFit(record.setup) !== "set") return true;
  return Boolean(record.pageSetups && typeof record.pageSetups === "object"
    && Object.values(record.pageSetups).some((raw) => sheetFit(raw) !== "set"));
}

// Each page brought to the box what is on it asks: one new file for every
// page that changed, shown in place (swapOpenCanvasBytes) — the pages that did
// not change are not touched. Resolves true when a page moved its edges.
async function applyCanvasPageExtents() {
  if (!hasNotebook()) return false;
  const record = state.meta.notebook;
  const byPage = canvasRecordsByPage();
  const only = changedCanvasPages(byPage);
  rememberCanvasPages(byPage);
  if (only && !only.size) return false;
  const next = neededNotebookPageBoxes(record, { only, byPage });
  const held = notebookSheetState().pageBoxes;
  if (samePageBoxes(next, held)) return false;
  return writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), pageBoxes: next, show: "in-place", uploadLater: true });
}

// ── ...asked for after every edit, once the hand is off the page ─────────
//
// A stroke, a Block dropped, typed into or deleted, a shape drawn, an undo:
// each asks, and the asking waits until nothing is being drawn, dragged or
// typed — the page is redrawn under the reader only between gestures. `soon`
// is the end of a gesture (a drop): no reason to wait longer than a frame.
const EXTENT_FIT_DELAY_MS = 450;
let extentFitTimer = 0;
let liveGestureCheck = () => false;

// What counts as the hand still on the page beyond the pen: a Block being
// dragged, resized or typed into. Handed in by src/main.js, which reaches
// src/documents/pdf-blocks.js (that module imports this one).
export function setCanvasGestureCheck(fn) {
  liveGestureCheck = typeof fn === "function" ? fn : () => false;
}

export function scheduleCanvasExtentFit({ soon = false } = {}) {
  if (!canvasHasGrowingPages()) return;
  clearTimeout(extentFitTimer);
  extentFitTimer = setTimeout(runCanvasExtentFit, soon ? 60 : EXTENT_FIT_DELAY_MS);
}

function runCanvasExtentFit() {
  extentFitTimer = 0;
  if (!canvasHasGrowingPages()) return;
  let busy = Boolean(extentFitRunning);
  try {
    busy = busy || inkPenIsDown() || pageChangeRunning || Boolean(liveGestureCheck());
  } catch (_) {
    busy = false;
  }
  if (busy) {
    // Quietly: a fit is not something the reader asked for, so it is simply
    // asked again in a moment.
    extentFitTimer = setTimeout(runCanvasExtentFit, EXTENT_FIT_DELAY_MS);
    return;
  }
  extentFitRunning = applyCanvasPageExtents()
    .catch((error) => console.warn("Could not fit the Canvas's pages to what is on them", error))
    .finally(() => {
      extentFitRunning = null;
    });
}

// What every page looks like, in order — two records with the same answer
// draw the same file.
function notebookDrawnPages(record) {
  const count = Number(record?.pages) || 0;
  const keys = [];
  for (let n = 1; n <= count; n += 1) keys.push(`${sheetDrawKey(sheetSetupForPage(record, n))}@${canvasPageBox(record, n).join(",")}`);
  return keys.join("|");
}

// Set up page `page`, or every page (`all`). A setup that draws exactly as one
// of the first papers is stored as that paper, so a Canvas set back to plain
// grid is the very file it was; a page's own setup that matches the Canvas's
// is dropped rather than kept as a copy. Resolves false when nothing would
// look different.
export async function setNotebookPageSetup(setup, options = {}) {
  if (!hasNotebook()) return false;
  return runCanvasPageChange(() => applyNotebookPageSetup(setup, options));
}

async function applyNotebookPageSetup(setup, { page = null, all = false } = {}) {
  if (!hasNotebook()) return false;
  const pageSheet = normalizeSheetSetup(setup);
  const pages = notebookPageCount();
  const current = notebookSheetState();
  let paper = notebookPaper();
  let nextSetup = current.setup;
  let nextPageSetups = current.pageSetups ? { ...current.pageSetups } : null;
  const n = Math.round(Number(page) || 0);
  if (all || pages < 2 || !(n >= 1 && n <= pages)) {
    // One of the first papers is stored as that paper — unless it is set to
    // its size, which the first papers (every page of which grows) cannot say.
    const legacy = pageSheet.fit === "grow" ? sheetLegacyKind(pageSheet) : null;
    paper = legacy || nearestLegacyPaper(pageSheet.pattern);
    nextSetup = legacy ? null : pageSheet;
    nextPageSetups = null;
  } else {
    const base = canvasWideSheetSetup(state.meta.notebook);
    nextPageSetups = nextPageSetups || {};
    if (sameSheet(pageSheet, base)) delete nextPageSetups[String(n)];
    else nextPageSetups[String(n)] = pageSheet;
    if (!Object.keys(nextPageSetups).length) nextPageSetups = null;
  }
  const after = { ...state.meta.notebook, paper, setup: nextSetup, pageSetups: nextPageSetups };
  // Each page that now grows, or is Boundless, reaches as far as what is past
  // its edge; a page set to its size reaches no further than it.
  after.pageBoxes = neededNotebookPageBoxes(after, { past: true });
  if (notebookDrawnPages(after) === notebookDrawnPages(state.meta.notebook)) {
    // Nothing on screen changes. The record may still be tidier — a page's own
    // setup that now matches the Canvas — and that is saved without new bytes.
    const before = notebookSheetState();
    if (JSON.stringify([before.setup, before.pageSetups]) !== JSON.stringify([nextSetup, nextPageSetups]) && paper === notebookPaper()) {
      writeNotebookSheetState(nextSetup, nextPageSetups);
      await saveDeckToLibrary({ silent: true });
    }
    return false;
  }
  return writeNotebookPdf({ pages, paper, setup: nextSetup, pageSetups: nextPageSetups, pageBoxes: after.pageBoxes });
}

// ── ⋯ → Canvas pages → Pages grow as needed ────────────────────────────────
//
// Every page grows unless set to its size (canvas-extent.js). The switch sets
// every page at once — the Canvas's setup and each page's own — leaving a
// Boundless page Boundless. On, the pages reach as far as what is on them; off,
// each is its size again, and what is past its edge is kept, out of view, until
// it grows again.
export function notebookPagesGrow(meta = state.meta) {
  const record = meta?.notebook;
  if (!record) return false;
  return canvasHasGrowingPages(record);
}

export function setNotebookPagesGrow(on) {
  if (!hasNotebook()) return Promise.resolve(false);
  return runCanvasPageChange(async () => {
    const fit = on ? "grow" : "set";
    const flip = (raw) => {
      const was = normalizeSheetSetup(raw);
      return was.fit === "boundless" ? was : normalizeSheetSetup({ ...was, fit });
    };
    const record = state.meta.notebook;
    const wide = flip(canvasWideSheetSetup(record));
    const legacy = wide.fit === "grow" ? sheetLegacyKind(wide) : null;
    const paper = legacy || (record.setup ? nearestLegacyPaper(wide.pattern) : notebookPaper());
    const setup = legacy ? null : wide;
    let pageSetups = null;
    Object.entries(notebookSheetState().pageSetups || {}).forEach(([key, raw]) => {
      pageSetups = { ...(pageSetups || {}), [key]: flip(raw) };
    });
    const after = { ...record, paper, setup, pageSetups };
    after.pageBoxes = neededNotebookPageBoxes(after, { past: true });
    if (notebookDrawnPages(after) === notebookDrawnPages(record)) {
      writeNotebookSheetState(setup, pageSetups, after.pageBoxes);
      state.meta = { ...state.meta, notebook: { ...state.meta.notebook, paper } };
      await saveDeckToLibrary({ silent: true });
      rememberCanvasPages();
      return true;
    }
    return writeNotebookPdf({ pages: notebookPageCount(), paper, setup, pageSetups, pageBoxes: after.pageBoxes });
  });
}

// Where this deck's notebook bytes are filed on the device. One row per
// document, so a deck with a paper AND a notebook has two.
function notebookStoreKey() {
  return documentStoreKey(state.localDeckId, DOC_SLOT_NOTEBOOK);
}

// Write a freshly generated file over the deck's document.
//
// The order is the one src/import/pdf.js arrived at and for the same reason: the
// device copy is written BEFORE the upload, because it is the copy the reader is
// about to draw on and the one that survives being offline. An upload that fails
// leaves a perfectly usable notebook that syncs later.
//
// `show` is what the reader sees of it: "reopen" puts the new file on screen
// the way opening it does (a page added, moved or torn out moves every page
// after it); "in-place" swaps the bytes under the pages already there and
// redraws only the pages whose size changed (a page growing to what is on it,
// src/documents/pdf-view.js swapOpenCanvasBytes); "none" leaves the screen to
// the caller. `uploadLater` holds the upload back until the pages stop
// growing for a moment, so a hand writing down a page that grows every few
// lines does not send the whole file up each time.
async function writeNotebookPdf({ pages, paper, setup = undefined, pageSetups = undefined, pageBoxes = undefined, reopen = true, show = reopen ? "reopen" : "none", uploadLater = false }) {
  // The page setups the record holds now, unless the caller is changing them —
  // so adding, duplicating or tearing out a page keeps every page's own setup.
  const held = notebookSheetState();
  const sheetSetup = setup === undefined ? held.setup : (setup || null);
  const sheetPageSetups = pageSetups === undefined ? held.pageSetups : (pageSetups && Object.keys(pageSetups).length ? pageSetups : null);
  const sheetPageBoxes = pageBoxes === undefined ? held.pageBoxes : (pageBoxes && Object.keys(pageBoxes).length ? pageBoxes : null);
  const file = blankPdfFile({ pages, paper, setup: sheetSetup, pageSetups: sheetPageSetups, pageBoxes: sheetPageBoxes, name: state.deckTitle || "handwritten-notes" });
  const hash = await sha256(file);
  // Where every page reached on screen before, for the in-place swap: it
  // redraws only the pages whose box is not what it was.
  const boxesBefore = notebookPageBoxes();
  // ── meta first, then the save, then the bytes ────────────────────────────
  //
  // Not an arbitrary order — it is the only one that works, and it is the one
  // attachPdfToOpenDeck arrived at. The device store is keyed by the deck's
  // LOCAL id, a local id is minted by the first save, and a save is a silent
  // no-op for a deck with nothing in it (deckPayloadHasContent). A brand-new
  // notebook has no cards and no note, so its only content is the very document
  // being attached: write meta.notebook first and the deck has something to save,
  // and the save is what hands back the id the bytes are filed under.
  // (deckPayloadHasContent counts a notebook for exactly this reason.)
  // Where the PREVIOUS pages live, captured before the record naming them is
  // overwritten. A notebook is rewritten whole every time a page is added, so
  // without this the file it replaces is simply abandoned in the cloud — which
  // is exactly what used to happen, once per page, for the life of the
  // notebook. Storage had no way to delete it afterwards because nothing
  // remembered it. Drive does, so it gets cleaned up below — and so does the
  // bucket, which this used to leave out: every page added since the move to a
  // bucket left the previous whole notebook sitting in it.
  const previous = {
    driveId: state.meta?.notebook?.driveId || "",
    path: state.meta?.notebook?.path || "",
    s3Key: state.meta?.notebook?.s3Key || "",
    // Which bytes those are, so a cleanup that runs late never deletes the
    // copy of bytes the record has come back round to naming.
    sha256: state.meta?.notebook?.sha256 || ""
  };
  state.meta = {
    ...(state.meta && typeof state.meta === "object" ? state.meta : {}),
    notebook: {
      ...(state.meta?.notebook && typeof state.meta.notebook === "object" ? state.meta.notebook : {}),
      name: file.name,
      size: file.size,
      pages,
      paper,
      notebook: true,
      // What the sheet under the ink looks like — see BLANK_PAPER_VERSION. A
      // notebook drawn at an older one is redrawn on the next open.
      paperV: BLANK_PAPER_VERSION,
      sha256: hash,
      // No locator is kept. They name bytes that no longer exist, and a
      // device that pulled this deck must not be handed the previous page
      // count. The s3Key was the one that used to survive this: an upload
      // that then failed left the new hash beside the OLD key.
      path: null,
      driveId: null,
      s3Key: null,
      // ...and nor is the note that an old location was retired: it was about
      // the previous pages, and these pages were never anywhere but here.
      retiredLocators: null,
      importedAt: state.meta?.notebook?.importedAt || new Date().toISOString()
    }
  };
  // The setups the bytes were drawn from, in the same write as the bytes' hash:
  // a device that has the record and not the file draws it again from these.
  writeNotebookSheetState(sheetSetup, sheetPageSetups, sheetPageBoxes);
  // ...and which bytes were drawn knowing where the pages reach (see the note
  // on pages that grow, above).
  if (sheetPageBoxes) state.meta.notebook.boxSha = hash;
  else delete state.meta.notebook.boxSha;
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this file on your device", "error");
    return false;
  }
  // The device copy before the upload, because it is the one the reader is about
  // to draw on and the one that survives being offline.
  await putDocument({ deckLocalId: notebookStoreKey(), blob: file, sha256: hash, name: file.name, at: Date.now() });

  // ── The new pages on screen BEFORE the upload, not after it ──────────────
  //
  // The records were renumbered above, in the same write as the new page
  // count. Until the view reopens on the new file, the OLD pages are on screen
  // under the NEW numbering: every Block and stroke after the change shown a
  // page away from where it is, on pages laid out from the new record's sizes.
  // Reopening only once the whole file had gone up to the bucket made that a
  // window of seconds on a real connection — long enough to look broken, and
  // long enough for the reader to press ＋ Page again into it. The device copy
  // is already what the record names, so the reopen reads it from here.
  // Pages added, moved or torn out renumber what is on them; that is not
  // something written on them, so the fit starts from here.
  if (show !== "in-place") rememberCanvasPages();
  if (show === "in-place") {
    // In place when the Canvas is the paper on the stage; otherwise the next
    // look at it opens the new file, as any page change does.
    const swapped = await swapOpenCanvasBytes({ blob: file, sha256: hash, before: boxesBefore });
    if (swapped === "reopen") await openDocumentView({ force: true, slot: DOC_SLOT_NOTEBOOK });
  } else if (show === "reopen") {
    await openDocumentView({ force: true, slot: DOC_SLOT_NOTEBOOK });
  }
  if (uploadLater) holdNotebookUpload({ file, hash, previous, deckLocalId: state.localDeckId });
  else {
    const pending = takeHeldNotebookUpload();
    uploadNotebookBytes({ file, hash, previous: carriedPrevious(previous, pending), deckLocalId: state.localDeckId });
  }
  return true;
}

// ── An upload held back while a page grows ─────────────────────────────────
//
// Only the latest file goes up. The copy it replaces in the cloud is the one
// the FIRST held upload was replacing — the files between were never uploaded
// — so that one is carried forward, or it would be left in the bucket for good.
const HELD_UPLOAD_MS = 4000;
let heldUpload = null;
let heldUploadTimer = 0;

const hasLocator = (where) => Boolean(where && (where.driveId || where.path || where.s3Key));

function carriedPrevious(previous, pending) {
  if (hasLocator(previous) || !pending || !hasLocator(pending.previous)) return previous;
  return pending.previous;
}

function takeHeldNotebookUpload() {
  clearTimeout(heldUploadTimer);
  heldUploadTimer = 0;
  const pending = heldUpload;
  heldUpload = null;
  return pending;
}

function holdNotebookUpload(upload) {
  const pending = takeHeldNotebookUpload();
  const same = pending && pending.deckLocalId === upload.deckLocalId;
  heldUpload = { ...upload, previous: same ? carriedPrevious(upload.previous, pending) : upload.previous };
  // A held upload for another file goes up now, as it would have.
  if (pending && !same) uploadNotebookBytes(pending);
  heldUploadTimer = setTimeout(flushHeldNotebookUpload, HELD_UPLOAD_MS);
}

export function flushHeldNotebookUpload() {
  const pending = takeHeldNotebookUpload();
  if (pending) uploadNotebookBytes(pending);
}

if (typeof document !== "undefined") {
  // Leaving the app is the last chance to send it before the next sync would.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHeldNotebookUpload();
  });
}

// The upload, behind the reader rather than in front of them. Nothing waits
// for it: the pages are on this device, drawable, and get to the bucket here or
// at the next sync that can reach it (the backfill in
// src/storage/document-migration.js).
//
// ── ...and it lands only on the record it was made for ───────────────────
//
// A Canvas is rewritten whole by every page change, so by the time an upload
// finishes the record may name other bytes — a page added during it — or
// another file may be open. Its locator stamped onto that record paired the new
// hash with the OLD file's key, and a device that pulled the record downloaded
// the old pages and kept them under the new hash: the wrong page count and the
// wrong sizes under every Block, for good. So a superseded upload writes
// nothing. Its object is deleted instead, since nothing will ever name it — the
// change that superseded it captured `previous` before this upload had set a
// locator. Keys are content-addressed (s3DocumentKey), so a key equal to the
// record's own is these very bytes, and is left alone.
async function uploadNotebookBytes({ file, hash, previous, deckLocalId }) {
  const stillCurrent = () => Boolean(deckLocalId)
    && state.localDeckId === deckLocalId
    && state.meta?.notebook?.sha256 === hash;
  try {
    const locator = await uploadDocument(file, {
      name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook"),
      pdfId: DOC_SLOT_NOTEBOOK,
      sha256: hash
    });
    if (!stillCurrent()) {
      // Another file opened meanwhile: this Canvas's saved record still names
      // these bytes, so its object stays for the backfill to find; nothing is
      // written onto the file that is open now.
      if (state.localDeckId !== deckLocalId) return false;
      const current = state.meta?.notebook || null;
      const named = (key, sha) => Boolean(current) && ((key && key === current.s3Key) || (sha && sha === current.sha256));
      const where = { deckLocalId, slot: DOC_SLOT_NOTEBOOK, pdfId: DOC_SLOT_NOTEBOOK };
      if (locator?.s3Key && !named(locator.s3Key, hash)) {
        deleteDocumentCopies({ s3Key: locator.s3Key }, where).catch(() => {});
      }
      // ...and the copy this upload was replacing, which it would have deleted
      // on landing and which the newer change never knew about.
      if ((previous.driveId || previous.path || previous.s3Key) && !named(previous.s3Key, previous.sha256)) {
        deleteDocumentCopies({ driveId: previous.driveId, path: previous.path, s3Key: previous.s3Key }, where).catch(() => {});
      }
      return false;
    }
    state.meta = { ...state.meta, notebook: { ...state.meta.notebook, ...locator } };
    await saveDeckToLibrary({ silent: true });
    // Only once the replacement is safely up. Deleting first would open a
    // window where a device that has neither copy has no pages at all. An
    // unchanged key (the same pages written again) is the object just
    // uploaded, and is left alone.
    const stale = { driveId: previous.driveId, path: previous.path, s3Key: previous.s3Key && previous.s3Key !== locator?.s3Key ? previous.s3Key : "" };
    if (stale.driveId || stale.path || stale.s3Key) {
      deleteDocumentCopies(stale, { deckLocalId, slot: DOC_SLOT_NOTEBOOK, pdfId: DOC_SLOT_NOTEBOOK }).catch(() => {});
    }
    return true;
  } catch (error) {
    // Not fatal and not silent — while these are still the pages. The pages
    // are on this device and drawable; what is not true yet is that they are
    // anywhere else, and they get there by themselves at the next sync.
    console.warn("Could not upload the Canvas", error);
    if (stillCurrent()) showToast("Pages saved here — they upload at the next sync", "info");
    return false;
  }
}

// The deck's first page. Called when the Handwritten Notes surface opens on a
// deck that has no document of its own — which is every deck, until it does.
//
// Answers one of three things, and the caller needs all three: `false` (there is
// no paper and this deck is not getting any), "kept" (the paper that was already
// there is the paper to use), or "wrote" (these bytes are NEW). The last one
// matters because openDocumentView with `force: false` is a no-op for a document
// it believes is already open, and it decides that by deck — not by the bytes.
// Regenerate a notebook's paper under a view that is already showing that same
// deck and the reader is left looking at the previous file: the page that was
// just re-made, or the pages that were just converted, are not on the screen and
// nothing says why. So "wrote" is the caller's instruction to force the reopen.
export async function ensureNotebookDocument({ paper = null, setup = null } = {}) {
  // Decks whose notebook is still in the document slot are moved first, so every
  // branch below is asking about the same key on every deck. Idempotent, and a
  // no-op for every deck that has never had a notebook.
  if (hasNotebookInPdfSlot(state.meta)) await migrateNotebookSlot();
  if (hasNotebook()) {
    // A notebook whose bytes have gone — a device that pulled the deck but never
    // the file, a store cleared to reclaim space. The paper is GENERATED, so it
    // can simply be made again from the record of what it was; that is a property
    // no real document has and it would be a waste not to use it.
    if (!(await notebookBytesPresent())) {
      showToast("Re-making this canvas's paper on this device…", "info");
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    // ...and the same property, used for the same reason one step further on: a
    // sheet drawn by an older build is redrawn to the current one. Silent,
    // because nothing about the deck changes — same page box, same page count,
    // same ink in the same places — only the paper under it. Here rather than on
    // deck load, so it is the reader arriving at the surface that pays for it.
    if (Number(state.meta.notebook.paperV || 1) < BLANK_PAPER_VERSION) {
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    // Pages that reach past their size, in bytes drawn by a build that did not
    // know they do (see the note on pages that grow): drawn again, reaching.
    if (notebookSheetState().pageBoxes && state.meta.notebook.boxSha !== state.meta.notebook.sha256) {
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    // What is on each page now, so only a page written to from here is fitted
    // (see "Only the pages something was done to").
    rememberCanvasPages();
    return "kept";
  }
  // ── There is no refusal here any more ────────────────────────────────────
  //
  // This used to stop dead on a deck that already had a PDF — "This deck already
  // has a PDF, its handwriting goes on that" — because there was one document
  // slot and the paper was in it. There are two now, so a deck that is reading
  // somebody's preprint can have blank pages of its own beside it, which is what
  // anybody pressing this on such a deck meant in the first place.
  if (hasLegacyNotebook(state.meta)) return (await migrateLegacyNotebook()) && "wrote";
  // A new Canvas on the page setup this device last chose, when it chose one
  // that is not simply one of the first papers.
  const pageSheet = setup ? normalizeSheetSetup(setup) : null;
  const legacy = pageSheet && pageSheet.fit === "grow" ? sheetLegacyKind(pageSheet) : null;
  if (pageSheet && !legacy) {
    return (await writeNotebookPdf({ pages: 1, paper: nearestLegacyPaper(pageSheet.pattern), setup: pageSheet, pageSetups: null, reopen: false })) && "wrote";
  }
  return (await writeNotebookPdf({ pages: 1, paper: normalizeBlankPaper(legacy || paper), setup: null, pageSetups: null, reopen: false })) && "wrote";
}

// Are the notebook's bytes on this device, AND are they the bytes the record
// describes?
//
// The second half is not pedantry. This paper is REGENERATED — every added
// page, every tear-out and every change of rule mints new bytes and a new hash
// under the same store key (writeNotebookPdf) — so a device that pulls the
// deck holds a file that used to be right. Asking only "is there a blob" is
// what left a page torn out on the tablet still sitting in the phone's
// notebook: the hit never falls through to a download, so nothing ever
// corrected it.
//
// A mismatch is cheap to answer here in a way it is nowhere else in this app:
// the caller's next move is to draw the paper again from the record, which
// needs no network and cannot be wrong, because the record IS what the paper is
// made of.
async function notebookBytesPresent() {
  if (!state.localDeckId) return false;
  try {
    const entry = await readDocument(notebookStoreKey());
    if (!entry?.blob) return false;
    return documentEntryMatches(entry, docSlotMeta(DOC_SLOT_NOTEBOOK));
  } catch (_) {
    // An unreadable store is not the same as an absent file, and re-generating
    // over one would be writing on a guess. Treated as present so nothing is
    // overwritten; the ordinary "could not open" path reports it.
    return true;
  }
}

// ── Older notebooks ────────────────────────────────────────────────────────
//
// The conversion itself is pure and lives in ./notebook-migrate.js so a Node
// check can drive it. What is here is the writing, and the order of it is the
// whole of the safety:
//
//   • the plan is computed first and touches nothing;
//   • the bytes are made and hashed, still touching nothing;
//   • ONE write then swaps the legacy keys for the records they became, so
//     there is no moment at which the strokes live nowhere;
//   • the save is the commit point. Everything after it — storing the bytes,
//     uploading them — can fail without losing anything, because a generated
//     paper can always be made again (see notebookBytesPresent above).
//
// A failure before the save leaves the deck exactly as it was, legacy keys
// included, and the next open tries again.
export async function migrateLegacyNotebook() {
  const plan = planLegacyNotebookMigration(state.meta, { mintId: freshDocumentHighlightId });
  const file = blankPdfFile({ pages: plan.pages, paper: plan.paper, name: state.deckTitle || "handwritten-notes" });
  const hash = await sha256(file);

  state.meta = migratedNotebookMeta(state.meta, plan, {
    name: file.name,
    size: file.size,
    pages: plan.pages,
    paper: plan.paper,
    notebook: true,
    sha256: hash,
    path: null,
    importedAt: new Date().toISOString()
  });

  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this file on your device — your pages were left as they were", "error");
    return false;
  }

  await putDocument({ deckLocalId: notebookStoreKey(), blob: file, sha256: hash, name: file.name, at: Date.now() });
  try {
    const locator = await uploadDocument(file, {
      name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook"),
      pdfId: DOC_SLOT_NOTEBOOK,
      sha256: hash
    });
    state.meta = { ...state.meta, notebook: { ...state.meta.notebook, ...locator } };
    await saveDeckToLibrary({ silent: true });
  } catch (error) {
    console.warn("Could not upload the migrated notebook", error);
  }

  const marks = plan.ink.length;
  const blocks = plan.blocks.length;
  const lost = plan.orphans
    ? ` ${plan.orphans} text box${plan.orphans === 1 ? "" : "es"} had no page to sit on and were left out.`
    : "";
  showToast(
    `Your Canvas pages are on real paper now — ${plan.pages} page${plan.pages === 1 ? "" : "s"}`
    + `${marks ? `, ${marks} with writing on` : ""}${blocks ? `, ${blocks} block${blocks === 1 ? "" : "s"}` : ""}.${lost}`
  );
  return true;
}

// ── The move out of the document slot ──────────────────────────────────────
//
// The first real-paper notebooks put their generated PDF in `meta.pdf`, because
// that was the only slot there was — which is exactly what made a deck able to
// have a notebook or a paper and never both. This moves such a deck onto
// `meta.notebook`, and the order is the same one every other write in this file
// keeps, for the same reason:
//
//   • the meta is computed by a pure function that touches nothing
//     (movedNotebookSlotMeta), so a failure before the save leaves the deck
//     exactly as it was and the next open tries again;
//   • ONE write swaps the slot and stamps the records in the same breath, so
//     there is no moment at which the strokes belong to no paper;
//   • the save is the commit point;
//   • the bytes are moved after it, and a failure there costs nothing — the
//     paper is GENERATED, so notebookBytesPresent will simply make it again.
//
// The old row is deleted only once the new one is written. A crash between the
// two leaves the file under both keys, which is a few kilobytes, not a loss.
export async function migrateNotebookSlot() {
  if (!hasNotebookInPdfSlot(state.meta)) return false;
  const wasLocalId = state.localDeckId;
  state.meta = movedNotebookSlotMeta(state.meta);
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this file on your device — your pages were left as they were", "error");
    return false;
  }
  if (!wasLocalId) return true;
  try {
    const existing = await readDocument(wasLocalId);
    if (existing?.blob) {
      await putDocument({ ...existing, deckLocalId: notebookStoreKey() });
      await deleteLocalDocument(wasLocalId);
    }
  } catch (error) {
    console.warn("Could not move the notebook's paper on this device", error);
  }
  return true;
}

function roomForAnotherPage() {
  if (notebookPageCount() < NOTEBOOK_MAX_PAGES) return true;
  showToast(`A canvas stops at ${NOTEBOOK_MAX_PAGES} pages — start another one`, "info");
  return false;
}

// Every record on the pages that `move` renumbers, both kinds at once — the
// rule deleteNotebookPage states below, for a page coming in rather than going.
//
// ...and every card and note that shows a spot of the Canvas (a `pdfref:` to
// the Canvas, src/documents/pdf-region-embed.js) names a page by number too, so
// it is told the same rule. Handed in by src/main.js, which reaches the cards
// and the notes surface; this module does not.
let canvasPagesRemapped = null;

export function setCanvasPagesRemappedHook(fn) {
  canvasPagesRemapped = typeof fn === "function" ? fn : null;
}

function remapNotebookPages(move) {
  remapDocumentHighlightPages(move);
  remapDocumentBlockPages(move);
  // ...and the pages' own setups, by the same rule: a page set up on its own
  // keeps its setup wherever it goes, and a page torn out takes it with it.
  const sheets = notebookSheetState();
  if (sheets.pageSetups) writeNotebookSheetState(sheets.setup, remapPageSetups(sheets.pageSetups, move));
  // ...and where each page reaches, by the same rule: a page that has grown
  // keeps its size wherever it goes.
  if (sheets.pageBoxes) writeNotebookSheetState(notebookSheetState().setup, notebookSheetState().pageSetups, remapPageSetups(sheets.pageBoxes, move));
  try {
    canvasPagesRemapped?.(move);
  } catch (error) {
    console.warn("Could not move the Canvas pictures in the cards and notes with their pages", error);
  }
}

// A blank page at the end, or straight after page `after` — everything below
// it moves down one to make the room, in the same write as the new page.
async function insertNotebookPage({ after = null } = {}) {
  if (!hasNotebook() || !roomForAnotherPage()) return false;
  const pages = notebookPageCount();
  const at = after === null ? pages : Math.max(0, Math.min(pages, Math.round(Number(after) || 0)));
  if (at < pages) {
    remapNotebookPages((record) => {
      const on = Number(record?.page) || 0;
      return on > at ? on + 1 : on;
    });
  }
  // The new page is set up as the page before it is — a landscape page of dots
  // in a ruled Canvas gets another like it — or, put before page 1, as page 1.
  copyNotebookPageSetup(at >= 1 ? at : 2, at + 1);
  return writeNotebookPdf({ pages: pages + 1, paper: notebookPaper() });
}

// Page `to` set up as page `from` is, after the renumbering that made room.
function copyNotebookPageSetup(from, to) {
  const sheets = notebookSheetState();
  const own = sheets.pageSetups?.[String(from)];
  if (!own) return;
  writeNotebookSheetState(sheets.setup, { ...sheets.pageSetups, [String(to)]: own });
}

// A record copied onto another page, under a new id. The quads carry their
// own page (see remapDocumentHighlightPages), so they move with it.
function recordOnPage(record, page, id) {
  return {
    ...record,
    id,
    page,
    quads: Array.isArray(record.quads)
      ? record.quads.map((quad) => (quad && typeof quad === "object" ? { ...quad, page } : quad))
      : record.quads,
    at: Date.now()
  };
}

// Page `n` again, straight after it: its ink, its shapes and its blocks, each
// under a new id. A connector on the copy is tied to the COPIES of what it
// joined, and a group on the copy is a group of its own — the two pages are
// not one diagram.
async function copyNotebookPage(pageNumber) {
  if (!hasNotebook() || !roomForAnotherPage()) return false;
  const pages = notebookPageCount();
  const n = Number(pageNumber);
  if (!(n >= 1 && n <= pages)) return false;
  const marks = documentHighlights().filter((record) => Number(record?.page) === n);
  const blocks = documentBlocks().filter((block) => Number(block?.page) === n);
  remapNotebookPages((record) => {
    const on = Number(record?.page) || 0;
    return on > n ? on + 1 : on;
  });
  copyNotebookPageSetup(n, n + 1);
  // The copy reaches as far as the page it copies: the same things are on it.
  const grown = notebookSheetState().pageBoxes?.[String(n)];
  if (grown) {
    const sheets = notebookSheetState();
    writeNotebookSheetState(sheets.setup, sheets.pageSetups, { ...sheets.pageBoxes, [String(n + 1)]: grown });
  }
  const ids = new Map();
  const groups = new Map();
  const copyGroupId = (group) => {
    if (!group) return group;
    if (!groups.has(group)) groups.set(group, `${group}-${Math.random().toString(36).slice(2, 6)}`);
    return groups.get(group);
  };
  const blockCopies = [];
  const used = new Set();
  blocks.forEach((block) => {
    // freshDocumentBlockId asks the deck's blocks, and the copies are not in
    // it yet: a second block on the page must not be handed the same id.
    let id = freshDocumentBlockId();
    while (used.has(id)) id = freshDocumentBlockId();
    used.add(id);
    ids.set(block.id, id);
    const copy = { ...block, id, page: n + 1, at: Date.now() };
    if (block.group) copy.group = copyGroupId(block.group);
    blockCopies.push(copy);
  });
  if (blockCopies.length) writeDocumentBlocks([...documentBlocks(), ...blockCopies]);
  marks.forEach((record) => {
    let id = freshDocumentHighlightId();
    while (used.has(id)) id = freshDocumentHighlightId();
    used.add(id);
    ids.set(record.id, id);
  });
  const markCopies = marks.map((record) => {
    const copy = recordOnPage(record, n + 1, ids.get(record.id));
    if (record.group) copy.group = copyGroupId(record.group);
    else delete copy.group;
    const ends = record.shape?.ends;
    if (Array.isArray(ends)) {
      copy.shape = { ...record.shape, ends: ends.map((end) => (end && ids.has(end.id) ? { ...end, id: ids.get(end.id) } : (end ? null : end))) };
    }
    return copy;
  });
  if (markCopies.length) applyDocumentRecordChanges({ put: markCopies });
  return writeNotebookPdf({ pages: pages + 1, paper: notebookPaper() });
}

// Page `n` swapped with the one `delta` away (one up is -1). Two pages set up
// alike are the same sheet, so no bytes change — only which records are on
// which page. Two set up differently swap their setups with them, and that is
// new bytes: the page that moved keeps its own size and paper.
async function swapNotebookPage(pageNumber, delta) {
  if (!hasNotebook()) return false;
  const pages = notebookPageCount();
  const n = Number(pageNumber);
  const to = n + Math.sign(Number(delta) || 0);
  if (!(n >= 1 && n <= pages) || !(to >= 1 && to <= pages) || to === n) return false;
  const differ = !sameSheet(notebookPageSetup(n), notebookPageSetup(to))
    || !samePageBox(notebookPageBox(n), notebookPageBox(to));
  const before = JSON.stringify(notebookSheetState().pageSetups || null);
  remapNotebookPages((record) => {
    const on = Number(record?.page) || 0;
    if (on === n) return to;
    if (on === to) return n;
    return on;
  });
  if (differ) return writeNotebookPdf({ pages, paper: notebookPaper() });
  if (JSON.stringify(notebookSheetState().pageSetups || null) !== before) await saveDeckToLibrary({ silent: true });
  return true;
}

// Tear out one page.
//
// The renumbering is the whole of it. Every stroke and every highlight after the
// gap is describing a page that has just moved down by one, and a record naming
// page 7 of a six-page document can never be painted or jumped to again. The
// records on the torn-out page are buried in the SAME write, or a sync landing
// between two writes would carry one half of the change.
//
// ── ...and there are TWO kinds of record on a page ────────────────────────
//
// This called the highlights half and stopped, which was true of the surface on
// the day it was written and stopped being true when pages grew text and image
// blocks (src/documents/pdf-blocks.js). A block is a rectangle on a numbered
// page exactly as a mark is, so every word of the paragraph above applied to it
// and nothing was doing it: a block on the torn-out page survived onto whichever
// page inherited its number, and the blocks below the gap stayed one page too
// far down. Both arrays are remapped by the same rule, stated once here and
// applied twice, so the two can never answer the tear-out differently.
async function tearOutNotebookPage(pageNumber) {
  if (!hasNotebook()) return false;
  const pages = notebookPageCount();
  const n = Number(pageNumber);
  if (!(n >= 1 && n <= pages)) return false;
  if (pages < 2) {
    showToast("A canvas keeps at least one page", "info");
    return false;
  }
  const afterTearOut = (record) => {
    const on = Number(record?.page) || 0;
    if (on === n) return null;
    return on > n ? on - 1 : on;
  };
  remapNotebookPages(afterTearOut);
  return writeNotebookPdf({ pages: pages - 1, paper: notebookPaper() });
}

async function applyNotebookPaper(kind) {
  if (!hasNotebook()) return false;
  const paper = normalizeBlankPaper(kind);
  const sheets = notebookSheetState();
  if (!sheets.setup && !sheets.pageSetups) {
    if (paper === notebookPaper()) return false;
    // Only the paper under the ink changes. The page box is identical, so nothing
    // already written moves — which is why this is a regeneration and not a
    // migration.
    return writeNotebookPdf({ pages: notebookPageCount(), paper });
  }
  // A Canvas with page setups: every page to this paper at its own size and
  // paper colour, with the paper's own lines.
  const onto = (raw) => {
    const was = normalizeSheetSetup(raw);
    const next = normalizeSheetSetup({ ...sheetPatternDefaults(paper), w: was.w, h: was.h, paper: was.paper, fit: was.fit });
    return next.fit === "grow" && sheetLegacyKind(next) ? null : next;
  };
  const setup = onto(canvasWideSheetSetup(state.meta.notebook));
  let pageSetups = null;
  Object.entries(sheets.pageSetups || {}).forEach(([key, raw]) => {
    const next = onto(raw) || normalizeSheetSetup(sheetPatternDefaults(paper));
    if (sameSheet(next, setup || sheetPatternDefaults(paper))) return;
    pageSetups = { ...(pageSetups || {}), [key]: next };
  });
  const after = { ...state.meta.notebook, paper, setup, pageSetups };
  if (notebookDrawnPages(after) === notebookDrawnPages(state.meta.notebook)) return false;
  return writeNotebookPdf({ pages: notebookPageCount(), paper, setup, pageSetups });
}

// What the rest of the app calls: each one a page change of its own, refused
// while another is running (runCanvasPageChange, at the top of this file).
export function addNotebookPage(options = {}) {
  return runCanvasPageChange(() => insertNotebookPage(options));
}

// `count` blank pages at the end in ONE rewrite of the paper — for Blocks put
// on the Canvas from the Notes, a PDF or the Cards (src/documents/canvas-feed.js),
// which can run over several pages at once. Each is set up as the last page
// is. Refused, as a whole, past NOTEBOOK_MAX_PAGES.
export function appendNotebookPages(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return Promise.resolve(true);
  return runCanvasPageChange(async () => {
    if (!hasNotebook()) return false;
    const pages = notebookPageCount();
    if (pages + n > NOTEBOOK_MAX_PAGES) {
      showToast(`A canvas stops at ${NOTEBOOK_MAX_PAGES} pages — start another one`, "info");
      return false;
    }
    for (let k = 1; k <= n; k += 1) copyNotebookPageSetup(pages, pages + k);
    return writeNotebookPdf({ pages: pages + n, paper: notebookPaper() });
  });
}

export function duplicateNotebookPage(pageNumber) {
  return runCanvasPageChange(() => copyNotebookPage(pageNumber));
}

export function moveNotebookPage(pageNumber, delta) {
  return runCanvasPageChange(() => swapNotebookPage(pageNumber, delta));
}

export function deleteNotebookPage(pageNumber) {
  return runCanvasPageChange(() => tearOutNotebookPage(pageNumber));
}

export function setNotebookPaper(kind) {
  return runCanvasPageChange(() => applyNotebookPaper(kind));
}

export { BLANK_PAPERS, BLANK_PAGE_WIDTH, BLANK_PAGE_HEIGHT };
