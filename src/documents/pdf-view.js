// The Document surface: the PDF, rendered as its author laid it out.
//
// Nothing is extracted here. There is no markdown behind this view and no
// intermediate representation — the page you are looking at is pdf.js painting
// the original file, which is the entire reason this feature exists. A
// LaTeX-heavy two-column paper loses nothing on the way in, because there is no
// way in.
//
// ── Two layers per page ─────────────────────────────────────────────────────
//
//   <canvas>          the page as pixels
//   .pdf-mark-layer   absolutely-positioned divs, one per highlight quad
//   .pdf-text-layer   absolutely-positioned, transparent spans — one per text
//                     item, carrying data-item-index
//
// The text layer is what makes NATIVE browser selection work over a canvas: the
// spans sit exactly over their glyphs, so dragging across them selects real DOM
// text, which the existing selection pill, the touch-selection controller and
// Ctrl+C all already understand. data-item-index is what turns that selection
// back into a stable anchor (see pdf-selection.js).
//
// ── Virtualized, for the same reason renderNotesLazily is ───────────────────
//
// Every page gets a placeholder sized from its viewport immediately, so the
// scrollbar is honest from the first frame; only pages near the viewport get a
// canvas and a text layer, and anything beyond a small window either side is
// torn back down to its placeholder. Opening a 300-page thesis is therefore one
// screenful of work, not three hundred.

import { PDF_BADGE_LAYER_CLASS, PDF_INK_LAYER_CLASS } from "../core/constants.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { paintInkStrokes } from "../render/ink-paint.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { ensurePdfJs } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { paintDocumentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { buildDocumentOutline, clearDocumentOutline, setDocumentOutlinePage } from "./pdf-outline.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot, docSlotMeta, documentStoreKey, normalizeDocSlot, onDocumentSurface } from "./doc-slot.js?v=__BUILD__";
import { isDarkThemeActive } from "../ui/theme-catalog.js?v=__BUILD__";
import { getDocument, putDocument, sha256 } from "./pdf-store.js?v=__BUILD__";
import { scheduleReadingPositionSave } from "../notes/reading-position.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

// How many pages either side of the visible run keep their canvas. Two is
// enough that a fast flick never shows an empty placeholder for long, and small
// enough that a rendered window of a big paper stays a handful of canvases
// rather than a memory leak with a scrollbar.
export const PDF_RENDER_WINDOW = 2;

// How far outside the scroller a page counts as "coming up", in viewport
// heights. A page is a whole screen tall, so a lead of 1 is one page of runway.
//
// Half that on a touch screen. The lead buys time at the price of rendering
// pages nobody is looking at yet, and a phone pays a great deal more for each of
// those than a laptop does — while also being the device where a flick covers
// less distance. Half a page of runway either side is still most of a page.
//
// ── One number, because two of them cost a black screen ────────────────────
//
// "Is this page coming up?" is asked in two places: the IntersectionObserver's
// rootMargin, and isPageNearViewport's arithmetic. They used to be written out
// separately, and they disagreed — the margin was halved on a touch screen and
// isPageNearViewport was not. So on a phone, and only on a phone, there was a
// band between half a viewport and a whole one where a page counted as near for
// every retry path in this file and was invisible to the observer, which is the
// only thing that ever STARTS a first render. A render invalidated in that band
// had nothing left that would ask for it again. What that looks like is a page
// stuck on its placeholder for good, and a placeholder with dark page on is a
// black rectangle. Both halves are derived from this one constant now.
export const PDF_OBSERVER_LEAD = 1;

export const PDF_OBSERVER_LEAD_COARSE = 0.5;

export function documentObserverLead() {
  return window.matchMedia?.("(pointer: coarse)")?.matches
    ? PDF_OBSERVER_LEAD_COARSE
    : PDF_OBSERVER_LEAD;
}

export function documentObserverMargin() {
  return `${Math.round(documentObserverLead() * 100)}% 0px`;
}

// ── How far out a reader may zoom, and why it is not one number ───────────
//
// This was a flat 0.4, applied to every scale in the file — including the one
// fit-width computes. That is fine for a paper and wrong for anything wider
// than about two and a half phone-widths, which is to say for every slide deck:
// a 1280pt 16:9 slide on a 390px phone wants 0.267 to fit, got floored to 0.4,
// and rendered 512px wide in a 342px scroller. Half as wide again as the screen,
// on open, with no way out — pressing − or pinching in hit the same floor, and
// "Fit to width" was a no-op because openPdf.fitWidth was already true and the
// scale it recomputed was the same clamped 0.4. So the reader got a page they
// could not fit, could not zoom out of, and could only pan around.
//
// The floor exists to stop a reader zooming out until the page is a stamp they
// have lost. Fit-width is by definition not that, so it cannot be the thing the
// floor forbids. Two numbers now:
//
//   PDF_MIN_SCALE      the floor for a DELIBERATE zoom-out, and it still holds
//                      — unless fit-width is lower, in which case fit-width is,
//                      because a reader must always be able to reach the whole
//                      page (see documentMinScale).
//   PDF_ABS_MIN_SCALE  a hard floor under everything, including fit-width. Not
//                      a reading limit: a guard against a measurement going
//                      wrong upstream and sizing every page to nothing.
export const PDF_MIN_SCALE = 0.4;

export const PDF_ABS_MIN_SCALE = 0.05;

export const PDF_MAX_SCALE = 5;

// Fit-width leaves this much room either side, so a page is never flush against
// the scroller's edge (and so the shadow that separates one page from the next
// has somewhere to fall).
//
// A phone gets NONE of it, which is the whole of "the PDF never opens at 100%
// width". 24px each side is 12% of a 390px screen spent on margin around a page
// that is mostly margin already; 8px was still 4% of it, and a page that stops
//4% short of the screen is a page the reader can see is not fitting.
//
// The reason the gutter existed at all — somewhere for the shadow that separates
// one page from the next to fall — is answered by the GAP between pages instead
// (.pdf-pages carries one, 8px on a narrow screen: styles/36-document.css). A
// shadow falls into that gap perfectly well, and nothing about page separation
// needs the sides.
export const PDF_FIT_PADDING = 24;

export const PDF_FIT_PADDING_NARROW = 0;

export const PDF_NARROW_WIDTH = 560;

export function fitPaddingFor(width) {
  return width && width < PDF_NARROW_WIDTH ? PDF_FIT_PADDING_NARROW : PDF_FIT_PADDING;
}

// A canvas is painted at devicePixelRatio so text is sharp, but a phone at
// dpr 3 rendering a 300-dpi page is a lot of pixels for no visible gain.
export const PDF_MAX_CANVAS_SCALE = 2;

// ...and a ceiling on the bitmap itself, because the cap above is a ratio and
// the thing it multiplies grows without limit. A page zoomed to 3x on a 3x
// phone is a ~2300×3300 canvas — 7.7 million pixels, three of them in the
// render window — to show a fifth of the page. Past this the output scale walks
// back toward 1, which costs sharpness exactly where the page is already
// magnified enough not to need it.
export const PDF_MAX_CANVAS_PIXELS = 4_000_000;

// The device pixel ratio to rasterise a page of this size at.
export function canvasOutputScale(width, height) {
  const wanted = Math.min(PDF_MAX_CANVAS_SCALE, window.devicePixelRatio || 1);
  const area = Math.max(1, width * height);
  const affordable = Math.sqrt(PDF_MAX_CANVAS_PIXELS / area);
  return Math.max(1, Math.min(wanted, affordable));
}

export const PDF_DARK_CLASS = "is-pdf-inverted";

export const PDF_DARK_KEY = "recall:pdfInvert";

// ── Two hooks, so this module keeps its one direction of import ────────────
//
// The badges and the printed notes (src/documents/pdf-page-notes.js) have to be
// repainted whenever a page is rendered and rebuilt whenever a document is
// opened — but that module already imports THIS one, for the page elements and
// the position helpers. Importing it back would make the pair a cycle, and the
// notes on src/notes/selection.js are the standing warning about what those cost
// here. So it is registered instead, exactly as setHighlightsChangedHandler is
// registered for the Highlights panel: main.js is the one file that knows about
// both ends.
let onPagePainted = () => {};

let onDocumentOpened = () => {};

// ...and a third, for the same reason and registered the same way. The Document
// tab now opens to an "Attach a PDF" panel on a deck that has none
// (renderAttachDocumentPrompt), and the function that does the attaching is
// attachPdfToOpenDeck in src/import/pdf.js — which already imports
// openDocumentView from HERE, at line 36. Importing it back would close that
// cycle and pull the whole import subtree (epub, my-decks-render, local-library)
// in ahead of a module that view-mode.js evaluates early. main.js imports both
// ends already and is the one file that should.
let onAttachDocument = async () => false;

export function setDocumentPagePaintedHook(fn) {
  onPagePainted = typeof fn === "function" ? fn : () => {};
}

export function setDocumentOpenedHook(fn) {
  onDocumentOpened = typeof fn === "function" ? fn : () => {};
}

export function setDocumentAttachHandler(fn) {
  onAttachDocument = typeof fn === "function" ? fn : async () => false;
}

// ── The open document ───────────────────────────────────────────────────────

// Everything about the PDF currently on screen. Replaced wholesale on a deck
// swap; null when no PDF deck is open.
export let openPdf = null;

// Bumped on every open, so a page render that resolves after the reader has
// moved on is dropped rather than painted into a document that is no longer
// there. Same guard shape as renderSequence in block-cache.js.
export let pdfOpenToken = 0;

export function currentPdfDocument() {
  return openPdf?.doc || null;
}

export function currentPdfPageCount() {
  return openPdf?.pageCount || 0;
}

// The live viewport for one page — what pdf-selection.js and pdf-highlights.js
// convert between client coordinates and PDF user space with. Null for a page
// that has never been laid out (nothing can be measured against it yet).
export function pdfPageViewport(pageNumber) {
  return openPdf?.pages?.get(pageNumber)?.viewport || null;
}

export function pdfPageElement(pageNumber) {
  return openPdf?.pages?.get(pageNumber)?.el || null;
}

export function pdfMarkLayer(pageNumber) {
  return openPdf?.pages?.get(pageNumber)?.markLayer || null;
}

// One page's text content items, as pdf.js handed them over when the text layer
// was built — null for a page that has none on screen. Kept rather than fetched
// because getTextContent() is a round trip to the worker and this page has
// already paid for one; see repairDocumentHighlightText in pdf-highlights.js,
// which is the only reader.
export function pdfPageTextItems(pageNumber) {
  return openPdf?.pages?.get(pageNumber)?.textItems || null;
}

// Whether the Document surface is the one a selection or a jump should act on.
// Either tab that lands on it — the Write tab is this same surface with the
// deck's other paper in it, and a selection there is a selection.
export function isDocumentViewActive() {
  return onDocumentSurface() && Boolean(openPdf);
}

// ── Opening ─────────────────────────────────────────────────────────────────

export function tearDownDocumentView() {
  pdfOpenToken += 1;
  // The crops are of THIS document's pages; a deck swap or a re-attach makes
  // every one of them a picture of something else.
  regionThumbnails.clear();
  if (openPdf?.observer) openPdf.observer.disconnect();
  if (openPdf?.resizeObserver) openPdf.resizeObserver.disconnect();
  clearTimeout(openPdf?.watchdog);
  // Every page's render deadline too. These outlive the document they were
  // armed for otherwise, and fire against an openPdf that is a different paper.
  openPdf?.pages?.forEach((entry) => clearTimeout(entry.deadline));
  if (openPdf?.doc) {
    // Releases the worker's copy of the file. Without this, opening five papers
    // in a session keeps five parsed documents alive in the worker.
    openPdf.doc.destroy().catch(() => {});
  }
  openPdf = null;
  forgetDocumentPageGuess();
  clearDocumentOutline();
  if (el.documentView) el.documentView.innerHTML = "";
  if (el.documentPageIndicator) el.documentPageIndicator.textContent = "";
}

// ── One panel, three things to say ──────────────────────────────────────────
//
// The Document surface has to ask for a file in three situations, and they are
// genuinely different questions: the file was offloaded, the file has not
// downloaded here yet, or this deck has never had one. What they share is the
// whole of the mechanism — a heading, a sentence, a picker, a footnote — so this
// builds that and the callers below supply the words and what to do with the
// file. It replaces two copies that had already started to drift.
// `onFile` builds the picker; `onPress` builds a plain button instead, for the
// one of the four that is not asking for a file at all — a deck with no notebook
// yet has nothing to pick, it just has not been given its first page.
function renderDocumentPickPrompt({ heading, body, pick = "Choose the PDF…", note = "", onFile = null, onPress = null }) {
  const view = el.documentView;
  if (!view) return;
  view.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "pdf-missing";
  const head = document.createElement("h2");
  head.textContent = heading;
  const text = document.createElement("p");
  text.textContent = body;
  let control;
  if (onPress) {
    control = document.createElement("button");
    control.type = "button";
    control.className = "pdf-missing-pick";
    control.textContent = pick;
    control.addEventListener("click", () => { onPress(); });
  } else {
    const label = document.createElement("label");
    label.className = "pdf-missing-pick";
    label.textContent = pick;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.hidden = true;
    label.appendChild(input);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      await onFile(file);
    });
    control = label;
  }
  panel.append(head, text, control);
  if (note) {
    const footnote = document.createElement("p");
    footnote.className = "pdf-missing-note";
    footnote.textContent = note;
    panel.appendChild(footnote);
  }
  view.appendChild(panel);
}

// Shown instead of the pages when the file itself is not here: offloaded from
// the cloud and never downloaded on this device, or downloaded once and since
// cleared. Everything else about the deck — highlights, notes, cards — is
// intact, which is exactly what the message has to say, or "re-attach" reads
// as "start again".
function renderMissingDocumentPrompt(pdfMeta) {
  renderDocumentPickPrompt({
    heading: "Re-attach the PDF to read it",
    body: pdfMeta?.offloaded
      ? `“${pdfMeta.name || "This document"}” was removed from the cloud to save space, and this device doesn't have a copy. Your highlights, notes and cards are all still here — pick the same file to read it again.`
      : `This device doesn't have a copy of “${pdfMeta?.name || "the document"}” yet, and it can't be downloaded right now. Your highlights, notes and cards are all still here.`,
    // Not a formality. A highlight is a coordinate into one exact file; painted
    // over a different edition of the same paper it would sit over the wrong
    // words, silently. Refusing a mismatch is the only honest option.
    note: pdfMeta?.sha256
      ? "It has to be the same file — the highlights are positions in it, and a different copy would put them over the wrong words."
      : "",
    onFile: (file) => reattachDocument(file, pdfMeta)
  });
}

// ── ...and the deck that has never had a document ───────────────────────────
//
// "The attach pdf needs to be inside the panels itself." It was not: attaching a
// paper to an existing deck lived only as a row in the ☰ drawer, because the
// Document surface did not exist until meta.pdf did, so there was no panel to
// put it in. That is a route you have to be told about — the reader is looking
// at the deck they want the paper beside, and the answer is in a drawer behind a
// hamburger, under "Decks", between Import and Sync Now.
//
// So the Document tab is now on every open deck (see refreshDocumentTab) and
// this is what it opens to when there is nothing to read yet. Same panel, same
// picker, and it hands the file to attachPdfToOpenDeck — the identical function
// the drawer row calls, so the two routes cannot drift.
function renderAttachDocumentPrompt() {
  renderDocumentPickPrompt({
    heading: "Attach a PDF to read it here",
    body: "This deck has no document yet. Pick a PDF and it becomes this deck's Document tab — read it, highlight it and make cards from it, with any highlights already in the file imported along with it.",
    pick: "Choose a PDF…",
    note: "Your cards, notes and title are left exactly as they are — this adds a document to the deck, it does not import over it.",
    onFile: (file) => onAttachDocument(file)
  });
}

// ── ...and the deck with no notebook yet ────────────────────────────────────
//
// The Write tab is on every open deck, the same way the Document tab is and for
// the same reason: a surface you have to be told exists is a surface most people
// never find. There is no state of a notebook that is not a page, so the offer is
// a single press rather than a picker — the first page is made when it is asked
// for, not when the deck is.
//
// The handler is REGISTERED rather than imported: src/documents/notebook.js
// imports this module to reopen the surface after it regenerates the paper, and
// importing it back would be a cycle.
let onStartNotebook = null;

export function setNotebookStartHandler(fn) {
  onStartNotebook = typeof fn === "function" ? fn : null;
}

function renderStartNotebookPrompt() {
  renderDocumentPickPrompt({
    heading: "Start a handwritten notebook",
    body: "Blank pages of your own, beside this deck's cards, notes and any PDF it already has. Write on them with a stylus, drop in text blocks and images, and add as many pages as you need.",
    pick: "Start a notebook",
    note: "Grid, ruled or blank — you can change the paper at any time, and what you have written stays where it is.",
    onPress: () => { onStartNotebook?.(); }
  });
}

// Take a picked file as this deck's document again, if it really is the same
// file. Exported because the Document menu offers it too, for a deck whose PDF
// is present but which the reader wants to re-point at a local copy.
export async function reattachDocument(file, pdfMeta) {
  const hash = await sha256(file);
  if (pdfMeta?.sha256 && hash && hash !== pdfMeta.sha256) {
    showToast("That's a different file — the highlights would land in the wrong places", "error");
    return false;
  }
  const deckLocalId = state.localDeckId;
  if (!deckLocalId) {
    showToast("Save this deck before re-attaching its PDF", "error");
    return false;
  }
  await putDocument({ deckLocalId, blob: file, sha256: hash, name: file.name, at: Date.now() });
  showToast("PDF re-attached");
  await openDocumentView({ force: true });
  return true;
}

// Which document is on the surface right now — the deck, and which of its two
// papers. Both halves matter: the deck alone would call a notebook and the paper
// beside it the same document, and the slot alone would call two decks' notebooks
// the same one.
function documentOpenKey(slot) {
  return `${currentDeckKey()}|${normalizeDocSlot(slot)}`;
}

// Which of the deck's documents the surface is currently showing, or null when
// it is showing none. Read by the pen and the paper controls, which have to know
// whether what is under them is a notebook they may regenerate.
export function openDocumentSlot() {
  return openPdf?.slot || null;
}

// Open the PDF for the deck in `state` into #documentView.
//
// Idempotent for the deck already on screen — setViewMode calls this on every
// switch into the Document tab, and re-parsing a 40MB paper because someone
// looked at their cards is not a thing to do. `force` is for the two cases where
// the bytes themselves changed underneath us (a re-attach, a fresh import).
export async function openDocumentView(options = {}) {
  documentOpensInFlight += 1;
  try {
    return await openDocumentViewBody(options);
  } finally {
    documentOpensInFlight -= 1;
  }
}

// How many openDocumentView calls are between their first line and their last.
// supersededOpen() is the only reader: it is what lets a bumped token mean
// "a newer open owns the surface" rather than "the surface was abandoned".
let documentOpensInFlight = 0;

// `slot` says WHICH of the deck's documents to open — its own paper, or the
// notebook beside it (src/documents/doc-slot.js). Defaulted from the view the
// reader is on rather than required, so every existing caller keeps meaning
// what it meant.
async function openDocumentViewBody({ force = false, slot = null } = {}) {
  const view = el.documentView;
  const openSlot = slot ? normalizeDocSlot(slot) : activeDocSlot();
  const pdfMeta = docSlotMeta(openSlot);
  if (!view) return false;
  // ── A deck with no document opens to the offer of one ────────────────────
  //
  // This used to `return false` here, because the Document tab did not exist
  // without meta.pdf so nothing could reach this line — and that is precisely
  // what left "attach a PDF to the deck I am looking at" with no home except a
  // row in the ☰ drawer. The tab is on every open deck now (refreshDocumentTab)
  // and this is what it opens to.
  //
  // Torn down first: the reader can arrive here from a PDF deck (a deck swap,
  // "Remove from cloud" on a deck whose meta.pdf then went away), and leaving
  // the previous paper's pages under an attach panel would be a picture of a
  // document this deck does not have.
  if (!pdfMeta) {
    tearDownDocumentView();
    if (openSlot === DOC_SLOT_NOTEBOOK) renderStartNotebookPrompt();
    else renderAttachDocumentPrompt();
    return false;
  }

  // The slot is part of the key, not beside it. Two documents on one deck are
  // two different files in the same surface, so "is this already open?" has to
  // mean "is THIS one already open?" — without the slot, switching between the
  // Document tab and the Write tab would be a no-op that left the reader
  // looking at the other paper.
  const deckKey = documentOpenKey(openSlot);
  if (!force && openPdf && openPdf.deckKey === deckKey) {
    // Already open: only the layout can have gone stale (a rotate, a resize
    // while the tab was hidden) — and `refit` is what makes that true. A bare
    // relayout re-lays the pages out at the scale they already had, which is
    // the one thing that cannot have gone stale; the window resize handler
    // never heard about the change, because it only listens while the Document
    // view is the one on screen. So a phone rotated in the notes and switched
    // back arrived with the portrait scale still on the page.
    relayoutDocument({ refit: true });
    return true;
  }

  tearDownDocumentView();
  const token = pdfOpenToken;
  view.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "pdf-loading";
  loading.textContent = "Opening the document…";
  view.appendChild(loading);

  if (!(await ensurePdfJs())) {
    showDocumentViewError("The PDF viewer could not load. Reconnect once so it can be cached, and it will work offline after that.");
    return false;
  }
  // ── A superseded open leaves the surface to its successor, and says so if
  //    there is no successor ────────────────────────────────────────────────
  //
  // These three checks used to `return false` bare. That is right when a newer
  // open really is in flight — it owns the view now and will fill it. It is
  // wrong the rest of the time, and the rest of the time happens: the token is
  // also bumped by tearDownDocumentView on a deck swap and a re-attach, and
  // what was left behind was either the "Opening the document…" line for ever
  // or an empty scroller, which on an amoled theme is a black screen with no
  // way to tell it from a page. supersededOpen() draws the distinction.
  if (token !== pdfOpenToken) return supersededOpen();

  const blob = await getDocument(documentStoreKey(state.localDeckId, openSlot), pdfMeta);
  if (token !== pdfOpenToken) return supersededOpen();
  if (!blob) {
    renderMissingDocumentPrompt(pdfMeta);
    return false;
  }

  let doc;
  try {
    // A COPY of the bytes, deliberately: pdf.js transfers the buffer it is
    // given to its worker, which detaches it — and the blob in the store is the
    // one thing that must survive, since it is the only copy on this device.
    const data = new Uint8Array(await blob.arrayBuffer());
    doc = await window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (error) {
    console.error("Could not read the PDF", error);
    showDocumentViewError(`Could not read this PDF — ${error?.message || "unexpected error"}`);
    return false;
  }
  if (token !== pdfOpenToken) {
    doc.destroy().catch(() => {});
    return supersededOpen();
  }

  const first = await doc.getPage(1);
  const baseViewport = first.getViewport({ scale: 1 });

  openPdf = {
    // Re-read HERE, not the `deckKey` captured before the first await.
    //
    // A PDF deck opens on its Document tab, and the loader that does it
    // (src/storage/deck-snapshot.js) sets `state.localDeckId = null` and then
    // calls setViewMode("document") synchronously, which lands here — while the
    // library loader sets the real local id only once the snapshot has been
    // applied. So the key captured up there is the key of a deck with no local
    // id, and it never matches currentDeckKey() again. What that cost was the
    // idempotence this whole function is built around: every later switch into
    // the Document tab saw a mismatch, tore the document down and re-parsed the
    // file. On a 40MB paper on a phone that is seconds of worker time, and one
    // more trip through every path this fix is about, each time the reader
    // glances at their cards.
    deckKey: documentOpenKey(openSlot),
    slot: openSlot,
    doc,
    pageCount: doc.numPages,
    // Every page starts out assumed to be the size of page 1 — which is true
    // for essentially every paper, and self-correcting for the ones where it
    // isn't: a page's real viewport replaces the assumption the moment it is
    // rendered, and the placeholder resizes then.
    baseWidth: baseViewport.width,
    baseHeight: baseViewport.height,
    scale: 1,
    fitWidth: true,
    // The scale at which the whole page fits across, remembered because
    // documentMinScale needs it to know how far out a zoom may go. Written by
    // fitWidthScale on the line below and on every refit after it.
    fitScale: 0,
    pages: new Map(),
    rendered: new Set(),
    observer: null,
    resizeObserver: null,
    watchdog: 0
  };

  view.innerHTML = "";
  openPdf.scale = fitWidthScale();
  buildPagePlaceholders();
  observePages();
  watchDocumentViewSize();
  applyPdfInvert(invertForDocumentSlot(openSlot), { remember: false });
  updatePageIndicator();
  // The pages exist now, so the printed notes have something to be inserted
  // after. Before the outline, which is deliberately off the critical path.
  //
  // Wrapped, which it was not. This reaches src/documents/pdf-page-notes.js and
  // from there into the markdown pipeline for every note on the document; a
  // throw anywhere in it used to reject this function's promise — and nothing
  // awaits it (src/ui/view-mode.js calls openDocumentView() bare) — so the
  // resume scroll and the sweep below were simply skipped, silently, with the
  // pages left wherever the observer had got to.
  try {
    onDocumentOpened();
  } catch (error) {
    console.warn("Could not build the document's page notes", error);
  }
  // Off the critical path: the pages are already on screen and readable, and
  // an outline can need a fetch per entry on a long book.
  buildDocumentOutline(doc).catch((error) => console.warn("Could not read the PDF outline", error));

  const resume = state.meta?.readingPosition;
  if (Number.isFinite(resume?.pdfPage)) scrollToDocumentPage(resume.pdfPage, resume.ratio || 0, { smooth: false });
  // Ask for the pages outright rather than waiting to be told about them. The
  // IntersectionObserver above will usually get there first and this will find
  // every page already asked for — but "usually" is what this whole bug was:
  // the observer fires on a CHANGE in intersection, and on a first open there
  // is no change to notice if the scroller was not laid out when the pages were
  // observed. See renderPagesNearViewport.
  renderPagesNearViewport();
  armDocumentRenderWatchdog(token);
  return true;
}

// ── Two nets under the observer ─────────────────────────────────────────────

// The scroller changing size is a render-relevant event that NOTHING was
// listening for. `window.resize` does not fire for it — folding the header away
// for focus mode, the on-screen keyboard closing, the chrome's own collapse
// transition finishing are all internal layout changes — and the resize handler
// in src/main.js additionally returns early unless the WIDTH changed, because
// re-fitting on a phone's constant height wobble would be its own bug.
//
// So a document opened while the scroller was still 0 or half-height had its
// pages measured against a viewport that was about to change and no way to hear
// that it had. A width change re-fits (which re-lays out and sweeps); a
// height-only change just sweeps, which is cheap and idempotent.
//
// ── ...and why the work is deferred a frame ──────────────────────────────
//
// Both branches below resize the pages INSIDE the observed element, which is
// what "ResizeObserver loop completed with undelivered notifications" is
// reported for. Harmless in itself — the browser simply delivers the rest next
// frame — but it reaches window.onerror, and an app that cries wolf there is one
// whose real errors stop being read. src/handwriting/paper.js defers its own
// observer for exactly this reason and says so at length.
//
// It went unnoticed while the Document tab was the only thing on this stage: the
// scroller's width changed on an open and then stayed put. It is a fourth tab
// and a second document later, and switching between two papers changes the
// controls in the row above the scroller, which changes the scroller.
function watchDocumentViewSize() {
  const view = el.documentView;
  if (!view || typeof ResizeObserver !== "function") return;
  let lastWidth = view.clientWidth;
  let frame = 0;
  openPdf.resizeObserver = new ResizeObserver(() => {
    if (!openPdf || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Re-read here rather than trusting the measurement the callback took: a
      // frame has passed, and the width this acts on has to be the width the
      // pages will actually be laid out against.
      if (!openPdf) return;
      const width = view.clientWidth;
      const widthChanged = width !== lastWidth;
      lastWidth = width;
      if (widthChanged && openPdf.fitWidth) {
        relayoutDocument({ refit: true });
        return;
      }
      renderPagesNearViewport();
    });
  });
  openPdf.resizeObserver.observe(view);
}

// How long after an open to check that SOMETHING painted. Long enough for a
// page to have rasterised on a slow phone, short enough that a reader who is
// looking at nothing is not looking at it for long.
export const PDF_RENDER_WATCHDOG_MS = 1200;

// The last net, and the one that answers the actual report: "I open a PDF and
// see a black rectangle, and it never comes back."
//
// Every mechanism above is a reason a page might not render. This is the one
// that does not care which of them it was. If, a beat after the document is
// open, not a single page has rasterised, then whatever the arithmetic decided
// was wrong — so page 1 is rendered unconditionally and the sweep is run again.
// If that still leaves nothing, the surface SAYS so instead of staying black:
// an empty page with a message is a bug report; an empty page without one is a
// reader who thinks the app is broken and cannot tell you why.
function armDocumentRenderWatchdog(token) {
  clearTimeout(openPdf?.watchdog);
  openPdf.watchdog = setTimeout(() => {
    if (!openPdf || token !== pdfOpenToken) return;
    if (openPdf.rendered.size) return;
    console.warn("No page rasterised within the watchdog window — forcing page 1");
    // forceRenderPage, not renderPage. If the reason nothing rendered is a
    // first render that never settled, renderPage would be turned away by its
    // own in-flight guard and this net would catch nothing.
    forceRenderPage(1);
    renderPagesNearViewport();
    setTimeout(() => {
      if (!openPdf || token !== pdfOpenToken || openPdf.rendered.size) return;
      showDocumentViewError("This document's pages did not render. Reopen the deck, and if it keeps happening the file may be damaged.");
    }, PDF_RENDER_WATCHDOG_MS);
  }, PDF_RENDER_WATCHDOG_MS);
}

// An open that found its token bumped under it.
//
// Two different things bump pdfOpenToken and they need opposite answers. If
// another openDocumentView is genuinely in flight it owns the surface and this
// one must get out of the way without touching it — anything else would be two
// opens writing to one view. But tearDownDocumentView also bumps the token on a
// deck swap and a re-attach, and then nobody is coming: whatever this open had
// already put on screen ("Opening the document…", or nothing at all) is what
// the reader is left looking at, for ever.
//
// documentOpensInFlight tells the two apart. It is incremented for the whole
// body of openDocumentView, so "greater than one" means a successor exists.
function supersededOpen() {
  if (documentOpensInFlight > 1) return false;
  if (!openPdf) showDocumentViewError("The document was closed while it was opening. Open the deck again.");
  return false;
}

// One place that puts a message where the pages should be, so every failure
// path says something rather than three of them saying nothing.
function showDocumentViewError(message) {
  const view = el.documentView;
  if (!view) return;
  view.innerHTML = "";
  const failed = document.createElement("p");
  failed.className = "pdf-loading is-error";
  failed.textContent = message;
  view.appendChild(failed);
}

// ── Layout ──────────────────────────────────────────────────────────────────

// The scroller width the current fit-width scale was measured against.
//
// The resize handler in src/main.js needs this to tell a width change from the
// height-only ones a phone fires constantly (the URL bar showing and hiding, a
// keyboard opening), and it cannot keep the answer itself: it only hears about
// resizes that happen while the Document view is the one on screen. Rotate the
// phone while reading the notes and come back, and its own memo would still be
// holding the portrait width — the one width at which no refit is needed.
let fittedWidth = 0;

export function documentFittedWidth() {
  return fittedWidth;
}

export function fitWidthScale() {
  const view = el.documentView;
  if (!view || !openPdf?.baseWidth) return 1;
  const width = view.clientWidth;
  // A scroller with no box has not been measured, it has been guessed at, and
  // recording that guess is worse than not answering: fittedWidth is what the
  // resize handler compares live widths against, so a 0 here makes the next
  // real width look like a change that has already been handled. Keep the scale
  // the page has and wait to be measured — the ResizeObserver on the scroller
  // will call back the moment there is something to measure.
  if (!width) return openPdf.scale || 1;
  fittedWidth = width;
  // Never floored at PDF_MIN_SCALE. Whatever it takes to fit the page IS the
  // fit — see the note on that constant for what flooring it cost.
  const available = Math.max(1, width - fitPaddingFor(width) * 2);
  const scale = clampScale(available / openPdf.baseWidth, PDF_ABS_MIN_SCALE);
  openPdf.fitScale = scale;
  return scale;
}

// How far below fit-width a deliberate zoom-out may go. Half again is enough to
// see a spread, or the shape of a page you are looking for, and not so far that
// the page becomes a stamp.
export const PDF_ZOOM_OUT_HEADROOM = 0.5;

// The lowest scale a deliberate zoom-out may reach.
//
// Relative to what fits, not an absolute. A flat floor means the same number is
// generous for a paper and unreachable for a slide — 0.4 let a reader of a
// 612pt page zoom out to two thirds of fit, and stopped a reader of a 1280pt
// slide from reaching fit at all. Every document gets the same headroom now:
// out to half the width that fits, whatever that width happens to be.
//
// PDF_MIN_SCALE survives as a CAP on the floor rather than as the floor: a
// document small enough that half its fit scale is still large does not get to
// keep the reader zoomed in.
export function documentMinScale() {
  const fit = openPdf?.fitScale;
  if (!Number.isFinite(fit) || fit <= 0) return PDF_MIN_SCALE;
  return Math.max(PDF_ABS_MIN_SCALE, Math.min(PDF_MIN_SCALE, fit * PDF_ZOOM_OUT_HEADROOM));
}

// Note the finite check, which is not decoration. Math.max(0.4, NaN) is NaN and
// so is Math.min(5, NaN), so a NaN got through here unchanged — and every page
// is then sized `NaNpx`, which is an invalid declaration the browser discards,
// which leaves every page 0×0 in a flex column: an empty scroller where the
// document was. A blank surface is far too expensive a way to find out that one
// arithmetic went wrong upstream.
export function clampScale(scale, floor = null) {
  if (!Number.isFinite(scale)) return 1;
  const low = Number.isFinite(floor) ? floor : documentMinScale();
  return Math.min(PDF_MAX_SCALE, Math.max(low, scale));
}

// ── The pages live in a box of their own ──────────────────────────────────
//
// #documentView is the scroller and it centres what is in it. That is right
// while the page is narrower than the window and wrong the moment it is not:
// a centred overflow is split between both sides, and scrollLeft cannot go
// below zero — so at any zoom past fit-width the left margin of every page was
// simply unreachable. Half of a zoomed page, gone.
//
// So the pages sit in one box that is `min-width: 100%` (centred as before when
// the page is narrower) and `width: max-content` starting at the left edge when
// it is wider (nothing to reach for; the whole page is scrollable). It is also
// the single element the pinch gesture transforms, which is the other reason it
// exists.
//
// Deliberately UNPOSITIONED: .pdf-page's offsetParent stays .document-stage, so
// every offsetTop reading in this file — the page the reader is on, the resume
// scroll, isPageNearViewport — means exactly what it meant before. Everything
// outside this module reaches pages by descendant query, so none of it notices
// the box at all.
export function pagesHost() {
  const view = el.documentView;
  if (!view) return null;
  let host = view.querySelector(":scope > .pdf-pages");
  if (!host) {
    host = document.createElement("div");
    host.className = "pdf-pages";
    view.appendChild(host);
  }
  return host;
}

function buildPagePlaceholders() {
  const view = pagesHost();
  if (!view) return;
  const frag = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= openPdf.pageCount; pageNumber++) {
    const page = document.createElement("div");
    page.className = "pdf-page";
    page.dataset.pageNumber = String(pageNumber);
    page.style.width = `${Math.round(openPdf.baseWidth * openPdf.scale)}px`;
    page.style.height = `${Math.round(openPdf.baseHeight * openPdf.scale)}px`;
    bumpDocumentLayout();
    if (pageNumber === 1) publishPageWidth(openPdf.baseWidth * openPdf.scale);
    // A page number that is visible even before the page paints, so scrubbing
    // through a long document never looks like a blank screen.
    const label = document.createElement("span");
    label.className = "pdf-page-label";
    label.textContent = String(pageNumber);
    page.appendChild(label);
    openPdf.pages.set(pageNumber, { el: page, viewport: null, markLayer: null, textLayer: null, task: null });
    frag.appendChild(page);
  }
  view.appendChild(frag);
}

function observePages() {
  const view = el.documentView;
  openPdf.observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const pageNumber = Number(entry.target.dataset.pageNumber);
      if (!pageNumber) return;
      if (entry.isIntersecting) renderPage(pageNumber);
    });
    trimRenderedPages();
    updatePageIndicator();
  }, { root: view, rootMargin: documentObserverMargin() });
  openPdf.pages.forEach((entry) => openPdf.observer.observe(entry.el));
}

// How wide the paper currently is, in CSS pixels, published for the ONE thing
// outside this module that has to match it: the notes strip printed under each
// page (styles/37-document-chrome.css). That strip used to be a fixed
// min(760px, 100%) column, which lined up with the page at exactly one zoom
// level and at no other.
//
// On #documentView and never on :root. src/ui/chrome.js sets out at length why
// a custom property written on the document element is expensive — it
// invalidates style for the whole tree — and this one is written on every frame
// of a pinch-zoom, which is precisely the case that argument is about. Written
// once per relayout rather than once per page, since every page of a paper is
// the same width and the first one is as good an answer as any.
function publishPageWidth(width) {
  el.documentView?.style.setProperty("--pdf-page-w", `${Math.round(width)}px`);
}

// Re-lay everything out at the current scale. A page's canvas is never simply
// stretched to the new size and left there — a canvas scaled in CSS is a blurry
// canvas, and the promise of this surface is that the page looks the way it was
// laid out — but it is not thrown away before its replacement exists either.
// See stalePageForRelayout: the old pixels stay, stretched, for the few frames
// the fresh render takes, because the alternative on screen is not a crisp page,
// it is a grey placeholder.
export function relayoutDocument({ refit = false, afterLayout = null } = {}) {
  if (!openPdf) return;
  // Any pinch transform still on the page host is dropped first, unconditionally.
  //
  // A pinch paints a CSS transform on .pdf-pages and the commit takes it off
  // again — but the commit runs from touchend, and a touchend is not something
  // to rely on: iOS hands a two-finger gesture to its own page zoom part way
  // through, an element can be re-parented under the fingers, a tab can be
  // backgrounded mid-gesture. What is left then is a scaled, translated box
  // whose LAYOUT is unchanged, so the scroll extents do not cover where the
  // content now appears: a page that looks zoomed in, sits half off screen, and
  // cannot be panned to. Every relayout is a fresh statement of where the pages
  // are, so it is also the right moment to be sure nothing is transforming them.
  clearPinchPaint();
  if (refit && openPdf.fitWidth) openPdf.scale = fitWidthScale();
  // Sized in one pass, then re-rendered in a second, because isPageNearViewport
  // reads offsetTop and every page has to have its new height before the first
  // of those answers are worth anything.
  const near = new Set();
  openPdf.pages.forEach((entry, pageNumber) => {
    const width = (entry.viewport ? entry.viewport.width / (entry.renderScale || 1) : openPdf.baseWidth) * openPdf.scale;
    const height = (entry.viewport ? entry.viewport.height / (entry.renderScale || 1) : openPdf.baseHeight) * openPdf.scale;
    entry.el.style.width = `${Math.round(width)}px`;
    entry.el.style.height = `${Math.round(height)}px`;
    bumpDocumentLayout();
    if (pageNumber === 1) publishPageWidth(width);
    if (openPdf.rendered.has(pageNumber)) entry.pendingSize = { width, height };
  });
  // Between the two passes, deliberately. A zoom moves the scroll offsets so the
  // point the reader was looking at stays where it was (restorePageAnchor), and
  // the second pass below decides which pages to render from those offsets — so
  // doing it after would render the pages the reader was about to leave and
  // leave the ones they land on to a second round through the observer.
  if (afterLayout) afterLayout();
  openPdf.pages.forEach((entry, pageNumber) => {
    if (!entry.pendingSize) return;
    const { width, height } = entry.pendingSize;
    entry.pendingSize = null;
    // Only a page that is about to be re-rendered keeps its old pixels. One
    // that is not is dropped outright: a stale canvas is not in openPdf.rendered
    // any more, so trimRenderedPages would never come back for it and every zoom
    // would leave another few megabytes of bitmap behind.
    if (isPageNearViewport(pageNumber)) {
      near.add(pageNumber);
      stalePageForRelayout(pageNumber, width, height);
    } else {
      unrenderPage(pageNumber);
    }
  });
  near.forEach((pageNumber) => renderPage(pageNumber));
  // The second half of this used to be the only thing asking for the pages that
  // had NOT been rendered before, and it is renderPagesNearViewport's job now —
  // same question, one definition, and a floor under it. Called after the two
  // passes above so every page has its new height first.
  renderPagesNearViewport();
  updatePageIndicator();
}

export function setDocumentScale(scale, { fitWidth = false, afterLayout = null } = {}) {
  if (!openPdf) return;
  openPdf.fitWidth = fitWidth;
  openPdf.scale = clampScale(scale);
  relayoutDocument({ afterLayout });
}

export function zoomDocument(step) {
  if (!openPdf) return;
  // Anchored, exactly as a pinch is. An unanchored zoom keeps scrollTop where
  // it was while everything under it grows, so pressing + walks the reader
  // steadily backwards through the document.
  const focal = viewportFocal();
  const anchor = focal && pageAnchorAt(focal);
  setDocumentScale(openPdf.scale * step, {
    afterLayout: anchor ? () => restorePageAnchor(anchor, focal) : null
  });
}

export function fitDocumentToWidth() {
  if (!openPdf) return;
  openPdf.fitWidth = true;
  openPdf.scale = fitWidthScale();
  relayoutDocument();
}

// Is the page still tracking the width of the window, or has the reader set a
// zoom of their own? The window resize handler in src/main.js is the caller:
// re-fitting a page somebody deliberately zoomed is not a re-fit, it is
// throwing their zoom away.
export function isDocumentFitWidth() {
  return Boolean(openPdf?.fitWidth);
}

// Where a page sits in the SCROLLER's own coordinates.
//
// A .pdf-page's offsetParent is .document-stage — deliberately, see pagesHost()
// — and the stage's first child is #documentHead, the control row. So a raw
// offsetTop is measured from the top of that row while every scrollTop it gets
// compared against is measured from the scroller's content origin, and the two
// differ by the row's height plus the scroller's own padding. The bias is
// constant, so nothing was badly wrong; it is why a resume to page 1 landed
// forty-odd pixels into the page instead of at its top. Subtracted once, here,
// rather than at four call sites that would each have to remember.
export function pageOffsetTop(entryEl) {
  const view = el.documentView;
  if (!entryEl) return 0;
  return entryEl.offsetTop - (view?.offsetTop || 0);
}

// Is this page on screen, or close enough to be worth rasterising now?
//
// The lead is documentObserverLead() — the SAME number the observer's
// rootMargin is built from, so "near" means one thing on every device. See the
// note on that constant for what having two answers cost.
export function isPageNearViewport(pageNumber) {
  const view = el.documentView;
  const entry = openPdf?.pages.get(pageNumber);
  if (!view || !entry) return false;
  const top = pageOffsetTop(entry.el);
  const bottom = top + entry.el.offsetHeight;
  // A scroller that has not been laid out yet (height 0) would otherwise say
  // "nothing is near" about a document that is entirely on screen — which is
  // one of the ways a freshly opened PDF ended up with no rendered page at all.
  // A zero-height viewport is not an answer, so fall back to the window's.
  const lead = documentObserverLead() * Math.max(view.clientHeight, window.innerHeight || 0, 1);
  const from = view.scrollTop - lead;
  const to = view.scrollTop + Math.max(view.clientHeight, 1) + lead;
  return bottom >= from && top <= to;
}

// ── The sweep ───────────────────────────────────────────────────────────────
//
// Render everything that is near the viewport, right now, without waiting to be
// told. This is the fix for the whole class of "the page never came back":
// renderPage was only ever reached from the IntersectionObserver, and an
// IntersectionObserver fires on a CHANGE in intersection — so once a render was
// invalidated (a scale that moved under it, a trim, a throw) with the page's
// intersection unchanged, nothing was left to ask again. Nothing re-observed
// either. On a first open with no scroll to make, that is a document that is
// simply never drawn.
//
// So every moment that can invalidate a render, or reveal that one never
// happened, ends by calling this: the open itself, a relayout, the scroller
// changing size, the chrome folding away. It is idempotent and cheap — a page
// already in openPdf.rendered returns from renderPage's first line, and a page
// with a render in flight records a re-request rather than starting a second.
//
// Page 1 is a floor, not a courtesy. If the arithmetic above is ever wrong
// again, the failure should be a page that is drawn when it did not need to be,
// not a reader looking at nothing.
export function renderPagesNearViewport() {
  if (!openPdf) return 0;
  let asked = 0;
  openPdf.pages.forEach((entry, pageNumber) => {
    if (!isPageNearViewport(pageNumber)) return;
    asked += 1;
    renderPage(pageNumber);
  });
  if (!asked && openPdf.pages.size) {
    renderPage(1);
    asked = 1;
  }
  return asked;
}

// ── Rendering one page ──────────────────────────────────────────────────────

async function renderPage(pageNumber) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry || openPdf.rendered.has(pageNumber)) return;
  // ── A render asked for while one is in flight is REMEMBERED, not dropped ──
  //
  // This used to `return` here and that was a page that never came back. The
  // sequence is two relayouts close together — a pinch commit and the refit
  // behind it, two zoom presses, the debounced resize landing on a phone while
  // the first pages of a freshly opened document are still rasterising — and it
  // goes: relayout at scale A starts a render; relayout at scale B calls this
  // for the same page and is turned away; the scale-A render finishes, sees
  // `openPdf.scale !== scale` and correctly throws its own canvas away. Nothing
  // is left to start a scale-B render. The IntersectionObserver does not help:
  // the page's intersection has not CHANGED, so it never fires again.
  //
  // What that looks like is the whole of this bug. A page that had rendered
  // before keeps the stretched stale canvas forever, with no text layer and no
  // highlights. A page that had not — every page of a document being opened for
  // the first time — keeps its placeholder forever, which on a phone with dark
  // page on is a black rectangle where the paper should be. There is nowhere to
  // scroll to from the top of page 1, so nothing shakes it loose either.
  //
  // So the request is recorded and re-issued the moment the in-flight render
  // settles. One retry per request, never a loop: a render that fails on its
  // own sets nothing.
  //
  // ── ...and "the moment it settles" is a promise, so it needs a deadline ──
  //
  // The guard above is right until the in-flight render never finishes, and
  // then it is a dead end — the dead end this whole bug turned out to be. A
  // pdf.js render is a round trip to a worker, and a worker on a phone is a
  // thing the OS can kill under memory pressure without telling anyone: the
  // promise neither resolves nor rejects, entry.task stays truthy for the rest
  // of the session, and every later request is turned away right here. The
  // observer on a scroll, a pinch commit, leaving the tab and coming back —
  // all three of the things a reader tries — reach this line and return. The
  // rerender flag they set is only ever read from inside the .finally() that
  // is never going to run.
  //
  // That is exactly "it never comes back", as a matter of control flow rather
  // than of probability, and it is why the previous fix for this symptom did
  // not land: that change altered what happens UNDER this guard and left the
  // guard, so the case where a render settles was fixed and the case where one
  // does not was untouched. forceRenderPage below is the way out, and
  // entry.deadline is what calls it without waiting for the reader.
  if (entry.task) {
    entry.rerender = true;
    return;
  }
  const token = pdfOpenToken;
  const scale = openPdf.scale;
  // Every await below re-checks this. A render is several async hops — get the
  // page, rasterise it, fetch its text content — and in that time the reader
  // can have scrolled far enough that trimRenderedPages decides this page
  // should not be on screen at all. Without a generation to compare against,
  // the finished canvas is appended to a placeholder that was just torn back
  // down, which leaves a page that LOOKS rendered while openPdf.rendered says
  // it is not: it is never re-rendered at the next zoom, and never trimmed
  // again either.
  const generation = (entry.generation = (entry.generation || 0) + 1);
  const stale = () => token !== pdfOpenToken || openPdf?.scale !== scale || entry.generation !== generation;
  let task;
  task = (async () => {
    const page = await openPdf.doc.getPage(pageNumber);
    if (stale()) return;
    const viewport = page.getViewport({ scale });
    // The placeholder was sized from page 1's dimensions; this is where a page
    // that is genuinely a different size (a landscape figure, an appendix)
    // corrects itself.
    entry.el.style.width = `${Math.round(viewport.width)}px`;
    entry.el.style.height = `${Math.round(viewport.height)}px`;
    bumpDocumentLayout();
    entry.viewport = viewport;
    entry.renderScale = scale;

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    const outputScale = canvasOutputScale(viewport.width, viewport.height);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d", { alpha: false });
    const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
    await page.render({ canvasContext: context, viewport, transform }).promise;
    if (stale()) return;

    entry.el.querySelector(".pdf-page-label")?.remove();
    // ...and the previous scale's canvas, which stalePageForRelayout left in
    // place precisely so there was something to look at until this moment.
    entry.el.querySelector(".pdf-canvas.is-stale")?.remove();
    entry.el.append(canvas);
    openPdf.rendered.add(pageNumber);
    // A page that drew has no failed attempts behind it any more. Without this
    // a page that needed two goes would carry that count into every later
    // re-render — a zoom, a rotate — and hit the ceiling early.
    entry.attempts = 0;
    // ── The page is on screen; the layers follow ──────────────────────────
    //
    // The pixels used to wait for the text layer, which is one absolutely
    // positioned span per text item — several thousand of them on a dense
    // two-column page, plus a getTextContent round trip to the worker. On a
    // phone that is the difference between the page appearing when it is drawn
    // and the page appearing when it is drawn AND made selectable, for every
    // page in the render window and again at every zoom.
    //
    // So the canvas is appended the moment it is rasterised and the two layers
    // are built on the next idle moment. Selection and highlights land a beat
    // after the words are readable, which is the right way round: nobody
    // selects text they have not read yet. Anything that must have them —
    // tools/pdf-preview-check.mjs, a highlight measuring against a text item —
    // goes through whenDocumentPageReady, which awaits this too.
    entry.layerTask = buildPageLayers(pageNumber, entry, page, viewport, stale)
      .catch((error) => console.warn(`Could not build the layers for page ${pageNumber}`, error))
      .finally(() => { if (entry.layerTask) entry.layerTask = null; });
  })()
    .catch((error) => {
      // A cancellation is the system working — a scale moved, a page was
      // trimmed — and says nothing to the reader.
      if (error?.name === "RenderingCancelledException") return;
      console.warn(`Could not render page ${pageNumber}`, error);
      // Everything else does. A page that threw keeps its placeholder, and a
      // placeholder with dark page on is a black rectangle: exactly the thing
      // that cannot be told apart from a page that simply has not painted yet.
      // So it says which it is, on the page itself, where the reader is looking.
      if (!stale()) showPageRenderFailure(pageNumber, error?.message || "unexpected error");
    })
    .finally(() => {
      if (!entry) return;
      clearTimeout(entry.deadline);
      entry.deadline = 0;
      // Only the render the entry is actually WAITING ON clears its handle.
      // Two renders can be alive for one page at once — stalePageForRelayout
      // bumps the generation and a fresh renderPage starts while the old one is
      // still awaiting getTextContent, and forceRenderPage below creates that
      // situation deliberately. The loser landing second must not null out the
      // winner's task, or the next request finds nothing in flight and starts a
      // third render of a page that is already being drawn.
      if (entry.task !== task) return;
      entry.task = null;
      // The request that arrived while this one was in flight (see the guard at
      // the top). Re-checked rather than trusted: the page can have been trimmed
      // or scrolled away from in the meantime, and this render may itself have
      // been the one that satisfied it.
      if (!entry.rerender) return;
      entry.rerender = false;
      if (!openPdf?.rendered.has(pageNumber) && isPageNearViewport(pageNumber)) renderPage(pageNumber);
    });
  entry.task = task;
  entry.attempts = (entry.attempts || 0) + 1;
  // The deadline, and the reason this page can come back at all.
  //
  // Nothing is cancelled here — there is nothing to cancel, the worker is what
  // is not answering. The ENTRY is released instead, so the next request is
  // allowed to start a fresh render rather than being turned away by the
  // in-flight guard at the top of this function for the rest of the session.
  // Bumping the generation (in forceRenderPage) is what makes that safe: if the
  // abandoned render ever does land, stale() is true for it and it drops its
  // own canvas, exactly as a render superseded by a zoom already does.
  entry.deadline = setTimeout(() => {
    entry.deadline = 0;
    if (token !== pdfOpenToken || entry.task !== task) return;
    if (entry.attempts >= PDF_RENDER_ATTEMPTS) {
      entry.task = null;
      showPageRenderFailure(pageNumber, "the page renderer stopped answering");
      return;
    }
    console.warn(`Page ${pageNumber} did not answer in ${PDF_RENDER_DEADLINE_MS}ms — starting again`);
    forceRenderPage(pageNumber);
  }, PDF_RENDER_DEADLINE_MS);
}

// How long a page's render may go unanswered before it is started again.
// Generous on purpose: a dense two-column page on a throttled phone is honestly
// seconds of work, and abandoning a render that was going to land costs a
// wasted canvas and a visible flash. What this is for is the render that was
// never going to land at all.
export const PDF_RENDER_DEADLINE_MS = 15000;

// ...and how many times to try before saying so out loud. A worker the OS has
// killed does not come back on its own, and a retry loop with no end is a phone
// with its CPU on for a page that is never going to draw.
export const PDF_RENDER_ATTEMPTS = 3;

// renderPage, for a page that MUST come back.
//
// The in-flight guard at the top of renderPage is the right default and a dead
// end when the render it is waiting for never settles (see the long note there).
// This is the only thing that steps over it, and it is deliberately not
// something the ordinary render paths can reach: only the deadline above and the
// open watchdog call it.
function forceRenderPage(pageNumber) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry) return;
  clearTimeout(entry.deadline);
  entry.deadline = 0;
  // The abandoned render is now stale by generation, so if it ever lands it
  // discards its own canvas instead of painting into a page that has moved on.
  entry.generation = (entry.generation || 0) + 1;
  entry.task = null;
  entry.rerender = false;
  openPdf.rendered.delete(pageNumber);
  renderPage(pageNumber);
}

// A page that could not be drawn says so, ON the page.
//
// Every render failure in this file used to be a console.warn and nothing else,
// which on a dark theme with dark page on is a black rectangle and no
// explanation — the same picture as a page that simply has not painted yet. A
// message on the placeholder rather than a toast, because it is a fact about ONE
// page of a document whose other pages are fine, and a toast about page 47 is
// long gone by the time the reader scrolls to it.
function showPageRenderFailure(pageNumber, reason) {
  const entry = openPdf?.pages.get(pageNumber);
  const label = entry?.el?.querySelector(".pdf-page-label");
  if (!label) return;
  label.classList.add("is-error");
  label.textContent = `Page ${pageNumber} could not be drawn — ${reason}`;
}

// The mark and text layers, off the critical path. See the comment at the call
// site for why they are not part of the render that puts the page on screen.
async function buildPageLayers(pageNumber, entry, page, viewport, stale) {
  await whenIdle();
  if (stale()) return;
  const markLayer = document.createElement("div");
  markLayer.className = "pdf-mark-layer";
  const { layer: textLayer, items } = await buildTextLayer(page, viewport);
  if (stale()) return;
  entry.el.append(markLayer, textLayer);
  entry.markLayer = markLayer;
  entry.textLayer = textLayer;
  entry.textItems = items;
  // Painted as part of the layer build rather than on a later pass, so a
  // highlight is never briefly missing from a page the reader can already see
  // the marks of.
  paintDocumentHighlights(pageNumber);
  // ...and the note badges with them, for the same reason: a highlight that has
  // a note has to say so from the first frame it is on screen.
  onPagePainted(pageNumber);
}

// requestIdleCallback where there is one, a frame where there is not. The
// timeout is the backstop: a page that is being scrolled past fast enough that
// the browser never goes idle still gets its text layer promptly, because the
// alternative is a page that cannot be selected until the reader stops.
function whenIdle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: PDF_LAYER_IDLE_MS });
    else requestAnimationFrame(() => resolve());
  });
}

export const PDF_LAYER_IDLE_MS = 200;

// Await whatever render is in flight for a page, and make sure one has been
// STARTED if the page is near the viewport and has none. The virtualized view
// is driven by an IntersectionObserver, which fires on the browser's own
// schedule — so "scroll there and wait a bit" is a race, and this is the
// non-racy form of it. Used by tools/pdf-preview-check.mjs, and by anything
// that needs a page's text layer to exist before it can measure against it.
export async function whenDocumentPageReady(pageNumber) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry) return false;
  if (!openPdf.rendered.has(pageNumber) && !entry.task) renderPage(pageNumber);
  // A loop, not a single await: renderPage clears entry.task in a `finally`,
  // and a render that was superseded mid-flight leaves the page unrendered with
  // a new task already queued behind it.
  for (let i = 0; i < 200; i++) {
    if (entry.task) await entry.task;
    if (openPdf?.rendered.has(pageNumber)) {
      // ...and the layers, which the render deliberately does not wait for.
      // "Ready" here has always meant "there is a text layer to measure
      // against", and that is what every caller of this uses it for.
      if (entry.layerTask) await entry.layerTask;
      return Boolean(entry.textLayer);
    }
    if (!entry.task) {
      renderPage(pageNumber);
      if (!entry.task) return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// The relayout half of unrenderPage: same invalidation, but the canvas is kept.
//
// relayoutDocument used to call unrenderPage on every rendered page, so every
// zoom step — and on a phone that meant ten steps a second through a pinch —
// flashed each visible page to a grey page number and back. What is left behind
// here is the previous canvas, stretched in CSS to the page's new box: soft for
// the few frames the re-render takes, and replaced by real pixels the moment it
// lands (renderPage drops `.is-stale` along with the placeholder label).
//
// The text and mark layers are NOT kept. Their coordinates are in the old
// scale, so a stretched text layer would put the selectable boxes off the
// glyphs and a stretched mark layer would paint highlights over the wrong
// words. Missing for a few frames is right; wrong is not.
//
// ── ...and the badge layer is one of them, which it was not ───────────────
//
// Every numbered badge is pinned to a corner of a quad by quadToPageBox, which
// converts through the LIVE viewport — so a badge belongs to the scale it was
// painted at exactly as a mark does. This function used to leave the layer
// standing, and src/documents/pdf-page-notes.js said why: the class name lived
// over there and importing that module back would close a cycle through the
// document surface. The name lives in core/constants.js now, so there is no
// cycle and no reason to treat this layer differently from the two beside it.
//
// Two things were wrong while it stayed. The badges sat at the old scale's
// coordinates over the stretched canvas until the re-render landed — visibly
// misplaced rather than briefly missing. And, worse, the layer was left as the
// page's FIRST child: renderPage drops the stale canvas and appends a fresh
// one, and the layer build appends the mark and text layers after that, so a
// layer that survived came out underneath all three. Under the text layer it
// stops receiving the press that opens its note; and under a canvas wearing
// `filter: invert(1)` (dark page, styles/36-document.css) it stops being VISIBLE
// at all, because a filtered element paints as a z-index:0 stacking context —
// in tree order with its positioned siblings — and that canvas is opaque.
// That is "the numbered indicators are gone as soon as I go to side by side":
// opening the split re-fits the paper, and the re-fit is a relayout.
//
// The layer is rebuilt with the page, by the same call that built it the first
// time (buildPageLayers → onPagePainted → paintPageNoteBadges).
function stalePageForRelayout(pageNumber, width, height) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry) return;
  const canvas = entry.el.querySelector(".pdf-canvas");
  if (!canvas) {
    unrenderPage(pageNumber);
    return;
  }
  entry.generation = (entry.generation || 0) + 1;
  openPdf.rendered.delete(pageNumber);
  entry.markLayer?.remove();
  entry.textLayer?.remove();
  entry.el.querySelector(`.${PDF_BADGE_LAYER_CLASS}`)?.remove();
  // ...and the ink, for the third time the same reason. Its canvas holds a
  // picture of the page's strokes drawn through the viewport transform of the
  // scale that has just been left behind; stretched with the page it is ink in
  // the wrong place, which on a paper someone has annotated reads as their
  // handwriting having moved. It comes back with the page, repainted from the
  // strokes themselves at the new scale — see src/documents/pdf-ink.js.
  entry.el.querySelector(`.${PDF_INK_LAYER_CLASS}`)?.remove();
  entry.markLayer = null;
  entry.textLayer = null;
  canvas.classList.add("is-stale");
  canvas.style.width = `${Math.round(width)}px`;
  canvas.style.height = `${Math.round(height)}px`;
}

function unrenderPage(pageNumber) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry) return;
  // Invalidates any render still in flight for this page, so its canvas is
  // dropped rather than appended into the placeholder this is about to rebuild.
  entry.generation = (entry.generation || 0) + 1;
  // ...and its deadline goes with it. The page is a placeholder again by
  // intent, so a timer firing later to complain that it never drew would be
  // reporting this function's own work as a failure.
  clearTimeout(entry.deadline);
  entry.deadline = 0;
  entry.attempts = 0;
  openPdf.rendered.delete(pageNumber);
  entry.el.innerHTML = "";
  entry.markLayer = null;
  entry.textLayer = null;
  // The items belong to the layer that is being dropped. Keeping them would be
  // a page of text content held for a page that is a grey rectangle again.
  entry.textItems = null;
  const label = document.createElement("span");
  label.className = "pdf-page-label";
  label.textContent = String(pageNumber);
  entry.el.appendChild(label);
}

// Anything more than PDF_RENDER_WINDOW pages outside the visible run goes back
// to being a placeholder. A canvas is several megabytes of bitmap; a hundred of
// them is the difference between a reader and a memory profile.
function trimRenderedPages() {
  if (!openPdf) return;
  const current = currentDocumentPage();
  // Snapshotted, because unrenderPage deletes from the very Set being walked.
  [...openPdf.rendered].forEach((pageNumber) => {
    if (Math.abs(pageNumber - current) > PDF_RENDER_WINDOW + 1) unrenderPage(pageNumber);
  });
}

// ── The text layer ──────────────────────────────────────────────────────────
//
// pdf.js's own fallback when a font reports no usable metrics — and ours, for
// the same reason: it is close enough that a box built on it still encloses the
// glyphs, and a wrong ascent is what put the highlight band above them.
export const PDF_DEFAULT_FONT_ASCENT = 0.8;

// How much of a text item's BOX sits above the baseline.
//
// Not the font's ascent. The box is exactly one em tall (`font-size` is the em
// size and `.pdf-text-layer` sets `line-height: 1`), while a font's ascender
// and descender together come to rather more than one em — around 1.12 for the
// families a paper is typically set in. So there is no split that contains both
// outright, and the question is where to spend the shortfall.
//
// pdf.js answers it by normalising: ascent / (ascent + |descent|), which puts
// the baseline at the same fraction of the box that it sits at in the font. A
// paragraph's ascenders and descenders then overhang by a fraction of a pixel
// each rather than one of them being cut off wholesale — which is what the old
// "the ascent is a whole em" did to every descender on the page.
//
// The metrics come from the PDF's own font (page.getTextContent() reports them
// per fontName) rather than from measuring the substituted DOM font as pdf.js
// does. The reason is that nothing visible here depends on the DOM font: the
// span's text is transparent, and the two things that ARE seen — the selection
// the browser paints, and the quads captureDocumentSelection takes off
// range.getClientRects() — are both the BOX. The box has to cover the glyphs
// painted on the canvas underneath it, and those were drawn with the file's
// font, so the file's metrics are the ones that describe them.
export function fontAscentRatio(style) {
  const ascent = Number(style?.ascent);
  // A descent is reported as a negative fraction of the em; a font that gives
  // both is the common case and the one worth normalising.
  const descent = Number(style?.descent);
  if (Number.isFinite(ascent) && ascent > 0 && Number.isFinite(descent) && descent < 0) {
    const ratio = ascent / (ascent - descent);
    if (ratio > 0 && ratio < 1) return ratio;
  }
  // Only one of the two. Either alone still says where the baseline sits
  // relative to a one-em box, just with nothing to normalise against.
  if (Number.isFinite(ascent) && ascent > 0 && ascent < 1) return ascent;
  if (Number.isFinite(descent) && descent < 0 && descent > -1) return 1 + descent;
  return PDF_DEFAULT_FONT_ASCENT;
}

// Built by hand rather than through pdf.js's own renderTextLayer, for one
// reason: every span has to carry the INDEX of the text item it came from.
// That index is half of a highlight's anchor (see pdf-selection.js), so it has
// to be exact and it has to survive a re-render — which means owning the loop
// that creates the spans rather than inferring indices from someone else's DOM
// afterwards.
export async function buildTextLayer(page, viewport) {
  const layer = document.createElement("div");
  layer.className = "pdf-text-layer";
  layer.style.width = `${Math.floor(viewport.width)}px`;
  layer.style.height = `${Math.floor(viewport.height)}px`;
  const content = await page.getTextContent();
  const frag = document.createDocumentFragment();
  let previous = null;
  content.items.forEach((item, index) => {
    if (!item.str) return;
    // ── The separator between one text item and the next ──────────────────
    //
    // This is what "I'm seeing garbage value most of the time when I'm
    // highlighting something and then try to write a note for it" was.
    //
    // A highlight's text comes from range.toString() over this layer
    // (captureDocumentSelection), and Range.toString() concatenates TEXT DATA:
    // it walks text nodes and ignores everything else. With one bare <span> per
    // item and nothing between them, a selection spanning two items came back
    // welded together — "DURRANT-WHYTE" and "Simultaneous Localization…", two
    // separate lines of a title page, arriving as "DURRANT-WHYTESimultaneous…".
    // That string is then the excerpt on the highlight's note, in the panel, in
    // the printed page notes and in every export, and there is no way to fix it
    // from any of them.
    //
    // A real whitespace TEXT NODE, therefore, and not a <br>: pdf.js's own text
    // layer uses <br> for its line breaks, which reads correctly and is
    // invisible to toString() — the one thing this has to be visible to. The
    // spans are absolutely positioned, so an extra text node in the flow costs
    // no layout and moves nothing.
    //
    // hasEOL is pdf.js saying "this item ended a line". Between items on the
    // SAME line a space is added only when neither side already has one: an
    // item is very often a fragment of a word (kerning, a ligature, a font
    // switch mid-word), and a space inserted there would break the word instead
    // of the join.
    if (previous) {
      const gap = previous.hasEOL ? "\n"
        : (/\s$/.test(previous.str) || /^\s/.test(item.str) ? "" : " ");
      if (gap) frag.appendChild(document.createTextNode(gap));
    }
    previous = item;
    const span = document.createElement("span");
    span.dataset.itemIndex = String(index);
    span.textContent = item.str;
    // pdf.js's own transform maths, kept verbatim in spirit: the item transform
    // composed with the viewport transform gives the glyph run's baseline
    // origin and its scale, and the span is placed and stretched to match so a
    // selection over it selects the words that are actually painted there.
    const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    // What the file says about the font this run was set in — its metrics, its
    // family and whether it runs down the page instead of across it. Read once:
    // the placement below, the CSS family and the rotation all have to be
    // talking about the same font or they describe a box no glyph is in.
    const style = content.styles?.[item.fontName];
    // A vertically-set run (CJK) is turned a further quarter turn, which is what
    // makes the offset below run along its own up-direction rather than the
    // page's. pdf.js's text layer does the same, and this loop used to ignore it
    // — so a vertical column's boxes were placed sideways from its glyphs.
    const angle = Math.atan2(tx[1], tx[0]) + (style?.vertical ? Math.PI / 2 : 0);
    // ── Where the top of the box goes, and why it is not the baseline minus an em
    //
    // tx[4]/tx[5] are the glyph run's BASELINE origin. A box whose top is
    // `baseline - fontHeight` treats the font's ascent as a full em, which no
    // font has: the box then starts about a fifth of an em above the tallest
    // glyph and STOPS AT THE BASELINE, leaving every descender outside it.
    //
    // That is invisible until something measures the box, and two things do.
    // The browser paints the selection on it — so a drag over a line of the
    // paper highlights a band sitting high, clipping the tails off g, y and p.
    // And captureDocumentSelection (src/documents/pdf-selection.js) takes
    // range.getClientRects() off these very boxes, converts them to quads and
    // stores them: so the highlight PAINTED back onto the page afterwards is
    // high by the same amount, forever. This is the "the highlighted ribbon is
    // not properly enclosing the text but rendering at an offset" report, and
    // it was never a painting bug — the quads were captured that way.
    //
    // pdf.js's own text layer has always put the ascent here rather than a whole
    // em; see fontAscentRatio for where the number comes from and why the
    // shortfall is split the way it is.
    const ascentPx = fontHeight * fontAscentRatio(style);
    // Rotated text needs the offset taken along the run's own up-direction
    // rather than straight up the page — the same decomposition pdf.js uses.
    span.style.left = `${angle ? tx[4] + ascentPx * Math.sin(angle) : tx[4]}px`;
    span.style.top = `${angle ? tx[5] - ascentPx * Math.cos(angle) : tx[5] - ascentPx}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = style?.fontFamily || "sans-serif";
    // Horizontal scale, so the invisible text is exactly as wide as the visible
    // glyphs. Without it a selection highlight drifts further from the words the
    // further along the line it goes — which is the difference between "this
    // works" and "this nearly works".
    const expected = item.width * viewport.scale;
    const transforms = [];
    if (angle) transforms.push(`rotate(${angle}rad)`);
    if (expected > 0 && fontHeight > 0) {
      span.dataset.expectedWidth = String(expected);
      transforms.push("scaleX(var(--pdf-span-scale, 1))");
    }
    if (transforms.length) span.style.transform = transforms.join(" ");
    frag.appendChild(span);
  });
  layer.appendChild(frag);
  // Measured in one pass AFTER the whole layer is in the document: reading
  // offsetWidth per span while still appending would be a forced layout per
  // text item, which on a dense two-column page is hundreds of them.
  requestAnimationFrame(() => {
    if (!layer.isConnected) return;
    layer.querySelectorAll("span[data-expected-width]").forEach((span) => {
      const actual = span.offsetWidth;
      if (!actual) return;
      span.style.setProperty("--pdf-span-scale", String(Number(span.dataset.expectedWidth) / actual));
    });
  });
  // The items go back with the layer, so the one caller can keep them on the
  // page's entry. textForQuads() needs them to name a highlight from its quads
  // (see repairDocumentHighlightText in pdf-highlights.js), and a second
  // getTextContent() for that would be a round trip to the worker for something
  // this function has already paid for.
  return { layer, items: content.items };
}

// ── Position ────────────────────────────────────────────────────────────────

// The page the reader is actually on: the first one whose bottom is still below
// the top of the scroller. Deliberately not "the most visible page" — on a
// two-page-tall window the answer flickers between two pages as you scroll,
// and a page indicator that flickers is worse than one that is slightly eager.
//
// ── Why this is not a loop from page 1 any more ───────────────────────────
//
// It was, and it was the single most expensive thing the app did while a paper
// was being scrolled: measured on a 40-page paper under a real wheel scroll,
// 359ms of a 4.6s scroll, the top JS frame by an order of magnitude with
// everything else in the noise.
//
// The cost is NOT the length of the walk, which was the first guess and was
// wrong — shortening it to a step or two moved the number by 7%. It is that
// both terms in the test are LAYOUT reads (pageOffsetTop reads offsetTop,
// and offsetHeight is offsetHeight), and a layout read taken while the scroller
// is dirty forces the browser to flush style and layout there and then. One
// flush costs about the same whether it is followed by one property read or
// forty, so what matters is how many times per frame something asks — and this
// is asked four times per scroll event: updatePageIndicator asks,
// scheduleDocumentPositionSave asks and asks again through currentDocumentRatio,
// and pdf-page-notes asks twice more.
//
// So the geometry is read ONCE into a table and every question after that is
// answered out of the table with no layout read at all — and the answer for one
// scroll position is computed once however many callers ask for it.
//
// The table is rebuilt when the pages actually move (bumpDocumentLayout, called
// from the four places that write a page element's box) and, as a net under
// that, whenever it is more than a frame old. The net is what makes this safe to
// reason about: a bump that somebody forgets to add later costs one frame of
// staleness in a page number, not a wrong answer that persists.
let pageBottoms = null;
let pageBottomsGeneration = -1;
let pageBottomsAt = 0;
let documentLayoutGeneration = 0;

// The pages have moved. Called from every place that writes a .pdf-page's box.
export function bumpDocumentLayout() {
  documentLayoutGeneration += 1;
  lastPageTop = -1;
  lastPageAnswer = 0;
  lastPageGeneration = -1;
}

// How long a geometry table may be trusted without a bump. One frame: long
// enough that a burst of scroll events shares one flush, short enough that
// nothing the reader can see is ever a frame behind where the pages are.
const PAGE_GEOMETRY_MAX_AGE_MS = 16;

// Every page's bottom edge, in scroller coordinates — or null when the document
// is not fully built, which is the one case the table cannot describe (a page
// with no entry is SKIPPED by the scan this replaces, and "skip" is not
// something a sorted array of bottoms can express). The caller falls back to the
// scan for that, so the answer is identical either way.
function documentPageGeometry() {
  const now = performance.now();
  if (pageBottoms
      && pageBottomsGeneration === documentLayoutGeneration
      && now - pageBottomsAt < PAGE_GEOMETRY_MAX_AGE_MS) {
    return pageBottoms;
  }
  const count = openPdf.pageCount;
  const tops = new Float64Array(count);
  const heights = new Float64Array(count);
  const bottoms = new Float64Array(count);
  for (let n = 1; n <= count; n += 1) {
    const entry = openPdf.pages.get(n);
    if (!entry) return null;
    const top = pageOffsetTop(entry.el);
    const height = entry.el.offsetHeight;
    tops[n - 1] = top;
    heights[n - 1] = height;
    bottoms[n - 1] = top + height;
  }
  pageBottoms = { tops, heights, bottoms };
  pageBottomsGeneration = documentLayoutGeneration;
  pageBottomsAt = now;
  return pageBottoms;
}

let lastPageTop = -1;
let lastPageAnswer = 0;

// The generation and the timestamp the memoised answer was computed against.
//
// Without these the memo defeated the very net the table above it is built on.
// The comment on documentPageBottoms calls the one-frame ceiling "a net under
// that, so a bump nobody adds later costs a frame of staleness rather than a
// wrong answer that persists" — and the `top === lastPageTop` return happened
// BEFORE the table was consulted, so neither the generation check nor the age
// check applied to it. A layout change that moved the pages without calling
// bumpDocumentLayout, at a scroll position the reader was not moving, left the
// answer wrong for as long as they sat there. That answer is the page indicator
// AND the saved reading position.
//
// It also kept currentDocumentRatio honest, which matters more: that function
// asks for the page and then for the geometry, and a memoised page paired with
// a table rebuilt underneath it is a ratio measured against a different page's
// box.
let lastPageGeneration = -1;
let lastPageAt = 0;

export function currentDocumentPage() {
  const view = el.documentView;
  if (!view || !openPdf) return 1;
  // scrollTop alone, and deliberately: it is a scroll offset rather than a
  // geometric one, so reading it forces nothing. An earlier version of this memo
  // keyed on scrollHeight as well, to notice a relayout — and that read forced
  // the very flush the memo existed to avoid, on every call, which is why it
  // bought almost nothing.
  const top = view.scrollTop;
  if (top === lastPageTop && lastPageAnswer
      && lastPageGeneration === documentLayoutGeneration
      && performance.now() - lastPageAt < PAGE_GEOMETRY_MAX_AGE_MS) {
    return lastPageAnswer;
  }

  const count = openPdf.pageCount;
  const geometry = documentPageGeometry();
  const bottoms = geometry?.bottoms;
  let answer = count;
  if (bottoms) {
    // The first page whose bottom is past the top of the scroller. Bottoms only
    // increase with the page number, so this is a binary search for the first
    // true of a monotonic predicate — the same page the scan from 1 returned.
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bottoms[mid] > top + 4) { answer = mid + 1; hi = mid - 1; } else { lo = mid + 1; }
    }
  } else {
    // A document still being built: fall back to the original scan, which knows
    // how to step over a page that has no entry yet.
    answer = count;
    for (let n = 1; n <= count; n += 1) {
      const entry = openPdf.pages.get(n);
      if (entry && pageOffsetTop(entry.el) + entry.el.offsetHeight > top + 4) { answer = n; break; }
    }
  }
  lastPageTop = top;
  lastPageAnswer = answer;
  lastPageGeneration = documentLayoutGeneration;
  lastPageAt = performance.now();
  return answer;
}

// Dropped when the document is torn down: the next paper's page 1 is not this
// one's, and the memo would otherwise hand back a page number for a document
// that is gone.
export function forgetDocumentPageGuess() {
  pageBottoms = null;
  pageBottomsGeneration = -1;
  lastPageTop = -1;
  lastPageAnswer = 0;
  lastPageGeneration = -1;
}

// How far into the current page the reader is, 0..1 — the second half of a
// resumable position. A page is a whole screen on a phone, so "page 12" alone
// would put someone back at the top of a page they were three quarters through.
export function currentDocumentRatio() {
  const view = el.documentView;
  if (!view || !openPdf) return 0;
  const page = currentDocumentPage();
  // Off the same table currentDocumentPage just used, so asking for the page and
  // then for the position within it costs ONE reading of the geometry rather
  // than two. These two are asked together every time — see
  // scheduleDocumentPositionSave, which is the only caller of this.
  const geometry = documentPageGeometry();
  if (geometry) {
    const height = geometry.heights[page - 1];
    if (!height) return 0;
    return Math.min(1, Math.max(0, (view.scrollTop - geometry.tops[page - 1]) / height));
  }
  const entry = openPdf.pages.get(page);
  if (!entry?.el.offsetHeight) return 0;
  return Math.min(1, Math.max(0, (view.scrollTop - pageOffsetTop(entry.el)) / entry.el.offsetHeight));
}

// ── Where on the screen the thing being scrolled to ends up ────────────────
//
// `align: "top"` puts the point `ratio` names on the top edge of the viewport,
// which is what a page number means: "show me page 47" is the top of page 47.
//
// `align: "center"` puts it in the middle instead, and that is what a jump to a
// HIGHLIGHT means. Aimed at the top edge, the marked words sat flush against the
// top of the screen with the whole page below them and nothing above — "I am
// being correctly taken to that specific location, but that is almost at the
// start of the page". `span` is how tall the target is as a ratio of the page
// (resolveDocumentAnchor), so what is centred is the whole marked phrase rather
// than its first line.
//
// The notes half of the split has always done this — see noteRangeCenterResidual
// in src/notes/anchors.js, whose arithmetic this is — and the two surfaces
// should not answer "go to this highlight" differently.
//
// ── ...but never above the page the highlight is ON ────────────────────────
//
// A note is one continuous scroll and can be centred on anything. A paper is
// not: it is a stack of numbered pages, and "which page am I on" is answered by
// whatever sits at the TOP of the viewport (currentDocumentPage). So centring a
// highlight near the top of page 32 puts the tail of page 31 above it and the
// indicator, the contents scroll-spy and the saved reading position all start
// saying 31 — about a jump the reader made to page 32. Measured on the fixture:
// a drawer row for a highlight on page 2 landed the reader on page 1.
//
// The clamp is therefore part of what centring MEANS here: centre it wherever
// the page has room above it, and land on the page's own top where it does not.
// That is no worse than the behaviour being replaced (which was always the
// page-top answer) and it costs nothing in the case the report is about — a
// highlight partway down a page, which is where centring has all its room.
export function scrollToDocumentPage(pageNumber, ratio = 0, { smooth = true, align = "top", span = 0 } = {}) {
  const view = el.documentView;
  const entry = openPdf?.pages.get(Math.min(Math.max(1, Math.round(pageNumber)), openPdf?.pageCount || 1));
  if (!view || !entry) return false;
  const height = entry.el.offsetHeight;
  const pageTop = pageOffsetTop(entry.el);
  let top = pageTop + height * (Number.isFinite(ratio) ? ratio : 0);
  if (align === "center") {
    // max(0, …) on the lead for a highlight taller than the screen: centring one
    // of those would push its start off the top, and the start is the part being
    // read. Same fallback, same reason, as the notes residual.
    const tall = height * (Number.isFinite(span) ? Math.max(0, span) : 0);
    top = Math.max(pageTop, top - Math.max(0, (view.clientHeight - tall) / 2));
  }
  view.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  updatePageIndicator();
  return true;
}

export function updatePageIndicator() {
  if (!openPdf) return;
  const page = currentDocumentPage();
  // Only when it actually changed. Assigning textContent replaces the text node
  // whether or not the string differs, which dirties the control row's layout —
  // and the control row is a flex sibling of the scroller, so the invalidation
  // does not stay local to it. This runs once a frame for the whole of a scroll
  // and the page number changes perhaps once a second, so almost every one of
  // those writes was for a string that was already there.
  const label = `${page} / ${openPdf.pageCount}`;
  if (el.documentPageIndicator && el.documentPageIndicator.textContent !== label) {
    el.documentPageIndicator.textContent = label;
  }
  // The contents drawer's scroll-spy rides on this rather than on a scroll
  // listener of its own: this already runs on every scroll settle and on every
  // page render, and two answers to "which page is the reader on" is exactly the
  // kind of second opinion that goes stale. The call is a compare on a number
  // when the page has not changed.
  setDocumentOutlinePage(page);
}

// Written through exactly the plumbing the notes view uses — same store, same
// debounce, same flush-on-leave — so a PDF deck resumes where you left it on
// this device and, through meta.readingPosition, on the next one.
//
// `offset` carries the page number, not because anything reads it as a
// character index but because writeStoredReadingPosition requires a finite
// `offset` to accept the entry at all; `pdfPage`/`ratio` are what the document
// branch of scheduleNoteJump actually uses.
export function scheduleDocumentPositionSave() {
  if (!openPdf) return;
  const page = currentDocumentPage();
  const position = { offset: page, pdfPage: page, ratio: currentDocumentRatio(), at: Date.now() };
  scheduleReadingPositionSave(currentDeckKey(), position);
  // ...and into the deck's own meta, which is what travels between devices.
  //
  // deckSnapshot picks meta.readingPosition up from scroll-anchor.js's
  // in-memory tracker, and that tracker only ever watches #notesView — a
  // surface a PDF deck's reader never touches. So without this line the local
  // store above would resume correctly on this device and nothing would ever
  // reach the phone. Written straight onto meta rather than scheduling a save:
  // it rides along on whichever save happens next, which is the same
  // deliberately simple strategy the notes position uses.
  if (state.meta && typeof state.meta === "object") state.meta.readingPosition = position;
}

// ── Dark themes ─────────────────────────────────────────────────────────────
//
// A CSS filter on the canvas alone, never on the text or mark layers: inverting
// the whole page would invert the highlight colours too and turn a yellow
// highlight into a blue one. Off by default, because a paper with photographs
// or coloured figures in it looks wrong inverted and only the reader knows
// which kind of document this is.
//
// ── ...except on paper this app wrote itself ──────────────────────────────
//
// The argument above is entirely about somebody else's document. A notebook's
// page has nothing on it but what the reader put there, and the pen resolves per
// theme — near-white on a dark theme, near-black on a light one — so a notebook
// left permanently white means that on seven of this app's ten themes you write
// in white ink on white paper and see nothing at all. Not a theme-switching bug:
// the very first stroke is invisible.
//
// So the notebook's paper follows the theme, and the reader's saved preference
// is left to the documents it was made about. A manual ◐ on a notebook still
// works for the session — it is the class that moves, not the preference — and
// the next theme change puts the paper back in step, which is what "follows the
// theme" has to mean.
export function invertForDocumentSlot(slot) {
  return normalizeDocSlot(slot) === DOC_SLOT_NOTEBOOK ? isDarkThemeActive() : readPdfInvertPreference();
}

// Re-assert the paper for whatever is on the surface now. Called on a theme
// change; a no-op when what is open is a document, whose paper is the reader's
// to decide.
export function refreshDocumentPaperForTheme() {
  if (openPdf?.slot !== DOC_SLOT_NOTEBOOK) return;
  applyPdfInvert(isDarkThemeActive(), { remember: false });
}

export function readPdfInvertPreference() {
  try {
    return localStorage.getItem(PDF_DARK_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function applyPdfInvert(on, { remember = true } = {}) {
  el.documentStage?.classList.toggle(PDF_DARK_CLASS, Boolean(on));
  // The button says which way the mode is set without being pressed — the same
  // rule every other toggle in this app's chrome follows, and the reason this
  // moved out of the ⋯ menu in the first place: a mode nobody can see the state
  // of reads as a mode that is not there.
  el.documentDarkBtn?.setAttribute("aria-pressed", on ? "true" : "false");
  // `remember: false` is the notebook, whose paper is decided by the theme. A
  // dark theme would otherwise write "dark page: on" into the preference and
  // hand it to the next PDF the reader opened, which is a document they never
  // asked to have inverted.
  if (!remember) return;
  try {
    localStorage.setItem(PDF_DARK_KEY, on ? "1" : "0");
  } catch (_) { /* private mode — the preference just doesn't persist */ }
}

export function togglePdfInvert() {
  const next = !el.documentStage?.classList.contains(PDF_DARK_CLASS);
  applyPdfInvert(next, { remember: openPdf?.slot !== DOC_SLOT_NOTEBOOK });
  return next;
}

// ── A picture of a region ───────────────────────────────────────────────────
//
// A region highlight round a photograph has no text in it, so in the Highlights
// panel it would be a row saying "Region · page 12" — which is not something
// anyone recognises a figure by. This renders the crop instead.
//
// Rendered on demand and NEVER stored. The obvious alternative — keeping a data
// URL on the record — would put a few kilobytes per region into meta, which is a
// JSONB column that syncs to every device on every save; a closely-read paper
// would carry a gallery around with it forever. The bytes are already on the
// device (that is the whole premise of this feature), so the picture can always
// be made again.
//
// Memoized per record id for the session, because the panel re-renders on every
// highlight change and a page render is not free.
const regionThumbnails = new Map();

// Wide enough to read a small plot's axis labels on a laptop, small enough that
// twenty of them in a list are not a scroll.
export const REGION_THUMB_WIDTH = 260;

export async function renderRegionThumbnail(record) {
  const id = record?.id;
  const quad = (record?.quads || [])[0];
  if (!id || !quad || !openPdf?.doc) return null;
  // Keyed by the record's own edit stamp as well as its id. A region never
  // changes once drawn, which is why the id alone was enough — but an ink mark
  // grows: every stroke added to the one you are still writing is the same
  // record with more in it, and a memo keyed on the id alone would show the
  // first stroke of a margin note for the rest of the session.
  const key = `${id}:${record.at || 0}`;
  if (regionThumbnails.has(key)) return regionThumbnails.get(key);
  const token = pdfOpenToken;
  try {
    const page = await openPdf.doc.getPage(quad.page);
    if (token !== pdfOpenToken) return null;
    // Scale chosen so the CROP comes out at the target width, not the page — a
    // fixed page scale would give a thumbnail of a figure in a corner of an A4
    // sheet a few pixels across.
    const [x0, y0, x1, y1] = quad.rect;
    const quadWidth = Math.max(1, Math.abs(x1 - x0));
    const scale = clampScale(REGION_THUMB_WIDTH / quadWidth);
    const viewport = page.getViewport({ scale });
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(quad.rect);
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    const width = Math.max(1, Math.round(Math.abs(vx1 - vx0)));
    const height = Math.max(1, Math.round(Math.abs(vy1 - vy0)));

    // The whole page is rasterised and then cropped, rather than rendered
    // through an offset transform: pdf.js renders a page, and a transform that
    // moved the origin would also move anything the page draws outside its own
    // media box. One page at a modest scale is a few milliseconds.
    const full = document.createElement("canvas");
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    const fullCtx = full.getContext("2d", { alpha: false });
    await page.render({ canvasContext: fullCtx, viewport }).promise;
    if (token !== pdfOpenToken) return null;

    // An ink mark's thumbnail has to have the ink IN it. The crop is a picture
    // of the page underneath, and the page underneath a margin note is blank
    // paper — so without this the Highlights pane lists handwriting as an empty
    // white rectangle, which is indistinguishable from a bug.
    //
    // Painted through the same viewport transform the strokes are stored
    // against, before the crop, so it lands wherever the reader put it.
    if (record.kind === "ink") {
      const t = viewport.transform;
      fullCtx.save();
      fullCtx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      paintInkStrokes(fullCtx, decodeInkStrokes(record.ink?.s), { root: null });
      fullCtx.restore();
    }

    const crop = document.createElement("canvas");
    crop.width = width;
    crop.height = height;
    crop.getContext("2d").drawImage(full, Math.round(left), Math.round(top), width, height, 0, 0, width, height);
    const url = crop.toDataURL("image/jpeg", 0.72);
    regionThumbnails.set(key, url);
    return url;
  } catch (error) {
    console.warn("Could not render a region thumbnail", error);
    return null;
  }
}

// ── Save a copy ─────────────────────────────────────────────────────────────

// The original bytes, straight to disk. Not a re-export and not a print: the
// point of keeping the PDF as the document is that you still have the PDF.
export async function saveDocumentCopy() {
  // The surface's own document, so "the original PDF" on the Write tab hands
  // back the notebook's paper rather than a paper it is not showing.
  const slot = activeDocSlot();
  const pdfMeta = docSlotMeta(slot);
  if (!pdfMeta) return false;
  const blob = await getDocument(documentStoreKey(state.localDeckId, slot), pdfMeta);
  if (!blob) {
    setStatus("This device doesn't have a copy of the PDF to save.", "error");
    return false;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pdfMeta.name || `${state.deckTitle || "document"}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast("Saved a copy");
  return true;
}

// ── Pinch to zoom ───────────────────────────────────────────────────────────
//
// Two fingers change the scale directly, rather than letting the browser's own
// page zoom take over — which on a document surface is the wrong gesture: it
// scales the toolbar and the tabs along with the page, and it leaves the reader
// panning a viewport instead of reading a column.
//
// ── Why this is a transform now, when it deliberately was not ─────────────
//
// It used to commit a REAL re-render every PINCH_COMMIT_MS, on the argument
// that a scaled canvas is a blurry canvas and "the page looks the way its
// author laid it out" is the promise this surface exists to keep. The argument
// is right about the resting state and wrong about the gesture, for a reason
// that is only visible on a phone: relayoutDocument drops every rendered page
// back to a PLACEHOLDER before re-rendering it, and a re-render is several
// async hops. So what a pinch actually showed was not a crisp page — it was the
// grey page-number placeholder, ten times a second, while the phone
// re-rasterised three canvases and rebuilt two thousand text spans per page for
// each one of those ten frames. That is most of "the PDF viewer is very slow on
// mobile".
//
// So: the gesture is a transform on .pdf-pages (one composited element, no
// layout, no rasterising, tracks the fingers at 60fps) and the re-render
// happens ONCE, when the fingers lift. The promise is kept where it is
// checkable — at rest, at every zoom level, the page is rendered at that zoom —
// and what the soft frames replace is a placeholder, not a page.
//
// Below this ratio the gesture is a two-finger scroll, not a pinch. Without it
// the small distance drift in a two-finger pan reads as a zoom and the page
// creeps.
export const PINCH_MIN_RATIO = 0.02;

let pinch = null;

function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function touchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

// ── Keeping the point under the fingers under the fingers ─────────────────
//
// Anchored to a PAGE and a fraction of it, not to a scaled coordinate in the
// scroller. The obvious version — "every content coordinate multiplies by the
// zoom ratio" — is wrong here in a way that only shows up a long way into a
// document: the gaps between pages are a fixed 16px and do not scale with them,
// so by page 100 a 1.5x zoom would have accumulated 99 gaps' worth of error and
// landed the reader eight hundred pixels from where they were looking.
//
// A page and two fractions has no such assumption in it. Whatever the new
// layout is, the anchored point is re-found in it exactly.
function pageAnchorAt(focal) {
  const view = el.documentView;
  if (!view || !openPdf) return null;
  // elementFromPoint rather than a walk over every page: a 300-page document
  // would otherwise cost 300 forced layouts to answer one question. It can miss
  // — the fingers can be over the pager, or in the gap between two pages — and
  // the page the reader is on is the right answer when it does.
  const hit = document.elementFromPoint(focal.x, focal.y)?.closest?.(".pdf-page");
  const pageNumber = Number(hit?.dataset.pageNumber) || currentDocumentPage();
  const pageEl = openPdf.pages.get(pageNumber)?.el;
  if (!pageEl) return null;
  const rect = pageEl.getBoundingClientRect();
  return {
    pageNumber,
    fx: rect.width ? (focal.x - rect.left) / rect.width : 0.5,
    fy: rect.height ? (focal.y - rect.top) / rect.height : 0
  };
}

// ...and put it back there, after the relayout has changed every page's size.
// Reading the page's rect here forces the pending layout, which is what makes
// the arithmetic below describe the document as it now is.
function restorePageAnchor(anchor, focal) {
  const view = el.documentView;
  const entry = anchor && openPdf?.pages.get(anchor.pageNumber);
  if (!view || !entry) return;
  const viewRect = view.getBoundingClientRect();
  const pageRect = entry.el.getBoundingClientRect();
  // The anchored point, in the scroller's own content coordinates.
  const contentX = pageRect.left - viewRect.left + view.scrollLeft + pageRect.width * anchor.fx;
  const contentY = pageRect.top - viewRect.top + view.scrollTop + pageRect.height * anchor.fy;
  view.scrollLeft = contentX - (focal.x - viewRect.left);
  view.scrollTop = contentY - (focal.y - viewRect.top);
}

// The centre of the scroller, for the zoom controls: a button press has no
// finger position to anchor on, and the middle of what you are looking at is
// the next best answer — and a great deal better than the top of the page,
// which is where an unanchored zoom leaves you.
function viewportFocal() {
  const view = el.documentView;
  if (!view) return null;
  const rect = view.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// The live half. `origin` is the focal point in the pages box's own
// coordinates, measured once before anything is transformed — transform-origin
// is read in that same pre-transform space, so measuring it again mid-gesture
// would compound.
function paintPinch(origin, ratio) {
  const host = pagesHost();
  if (!host) return;
  host.classList.add("is-pinching");
  host.style.willChange = "transform";
  host.style.transformOrigin = `${origin.x}px ${origin.y}px`;
  host.style.transform = `scale(${ratio})`;
}

function clearPinchPaint() {
  const host = pagesHost();
  if (!host) return;
  host.classList.remove("is-pinching");
  host.style.transform = "";
  host.style.transformOrigin = "";
  host.style.willChange = "";
}

export function initDocumentPinchZoom() {
  const view = el.documentView;
  if (!view) return;

  view.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2 || !openPdf) return;
    const host = pagesHost();
    if (!host) return;
    const focal = touchMidpoint(event.touches);
    const hostRect = host.getBoundingClientRect();
    pinch = {
      startDistance: touchDistance(event.touches),
      startScale: openPdf.scale,
      // Fixed at the midpoint the gesture STARTED from, and not re-read as the
      // fingers move: transform-origin is in pre-transform coordinates, so a
      // moving origin would compound with the scale already applied. It is also
      // the point the commit anchors on, so the two halves agree by
      // construction.
      focal,
      origin: { x: focal.x - hostRect.left, y: focal.y - hostRect.top },
      ratio: 1
    };
  }, { passive: true });

  view.addEventListener("touchmove", (event) => {
    // A gesture that stops being two fingers is over, and it has to be ENDED
    // rather than merely ignored: returning here left the transform painted and
    // the pinch object live, so the next touchend committed a scale from a
    // gesture the reader had already abandoned — or, if no touchend arrived at
    // all, left the page transformed for good.
    if (pinch && event.touches.length !== 2) { endPinch(); return; }
    if (!pinch || event.touches.length !== 2 || !openPdf) return;
    const distance = touchDistance(event.touches);
    if (!pinch.startDistance) return;
    const ratio = distance / pinch.startDistance;
    if (Math.abs(ratio - 1) < PINCH_MIN_RATIO && pinch.ratio === 1) return;
    // preventDefault only once this really is a pinch, so a two-finger scroll
    // still scrolls. The listener is therefore NOT passive — which is the whole
    // reason this one differs from the two around it.
    event.preventDefault();
    // Clamped against the same limits the commit will apply, so the page does
    // not stretch to a size it is about to snap back from.
    pinch.ratio = clampScale(pinch.startScale * ratio) / pinch.startScale;
    paintPinch(pinch.origin, pinch.ratio);
  }, { passive: false });

  // One commit, when the fingers lift. `touchend` fires per finger, so this
  // runs on the first of the two leaving — which is right: the gesture is over
  // as soon as it stops being two fingers.
  const endPinch = () => {
    const gesture = pinch;
    pinch = null;
    if (!gesture || !openPdf) { clearPinchPaint(); return; }
    // Paint dropped FIRST: pageAnchorAt measures with getBoundingClientRect,
    // and a box that is still scaled reports where the transform put it rather
    // than where the layout has it. Dropping the transform cannot move the
    // scroll offsets — nothing scrolls during a pinch, so they were never past
    // the untransformed maximum.
    clearPinchPaint();
    if (gesture.ratio === 1) return;
    const anchor = pageAnchorAt(gesture.focal);
    setDocumentScale(gesture.startScale * gesture.ratio, {
      afterLayout: anchor ? () => restorePageAnchor(anchor, gesture.focal) : null
    });
  };
  view.addEventListener("touchend", endPinch, { passive: true });
  view.addEventListener("touchcancel", endPinch, { passive: true });

  // ── iOS, which does not always let the touch path finish ─────────────────
  //
  // Safari on iOS raises its own gesturestart/gesturechange/gestureend for a
  // two-finger pinch, and it can take the gesture over from the touch events
  // part way through — at which point the touchend this file is waiting for
  // never comes and the transform painted above stays on the page for the rest
  // of the session. That is the "zoomed in, will not pan, will not zoom out"
  // shape exactly, and it is why relayoutDocument now clears the paint
  // unconditionally as well.
  //
  // These three are the belt to that braces. gesturechange carries an absolute
  // `scale` relative to the start of the gesture, which is the same number the
  // touch path derives from the finger distance, so the two agree by
  // construction and either can drive the same commit.
  view.addEventListener("gesturestart", (event) => {
    if (!openPdf) return;
    event.preventDefault();
    const host = pagesHost();
    if (!host) return;
    const focal = { x: event.clientX, y: event.clientY };
    const hostRect = host.getBoundingClientRect();
    pinch = {
      startDistance: 0,
      startScale: openPdf.scale,
      focal,
      origin: { x: focal.x - hostRect.left, y: focal.y - hostRect.top },
      ratio: 1
    };
  });

  view.addEventListener("gesturechange", (event) => {
    if (!pinch || !openPdf) return;
    event.preventDefault();
    const wanted = Number(event.scale);
    if (!Number.isFinite(wanted) || wanted <= 0) return;
    pinch.ratio = clampScale(pinch.startScale * wanted) / pinch.startScale;
    paintPinch(pinch.origin, pinch.ratio);
  });

  view.addEventListener("gestureend", (event) => {
    if (pinch) event.preventDefault();
    endPinch();
  });
}
