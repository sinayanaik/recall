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

import { el } from "../core/dom.js?v=__BUILD__";
import { ensurePdfJs } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { paintDocumentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { buildDocumentOutline, clearDocumentOutline } from "./pdf-outline.js?v=__BUILD__";
import { getDocument, putDocument, sha256 } from "./pdf-store.js?v=__BUILD__";
import { scheduleReadingPositionSave } from "../notes/reading-position.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

// How many pages either side of the visible run keep their canvas. Two is
// enough that a fast flick never shows an empty placeholder for long, and small
// enough that a rendered window of a big paper stays a handful of canvases
// rather than a memory leak with a scrollbar.
export const PDF_RENDER_WINDOW = 2;

// How far outside the scroller a page counts as "coming up". A page is a whole
// screen tall, so a margin of one viewport height is one page of lead time.
//
// Half that on a touch screen. The margin buys lead time at the price of
// rendering pages nobody is looking at yet, and a phone pays a great deal more
// for each of those than a laptop does — while also being the device where a
// flick covers less distance. One page of runway either side is still one page.
export const PDF_OBSERVER_MARGIN = "100% 0px";

export const PDF_OBSERVER_MARGIN_COARSE = "50% 0px";

export function documentObserverMargin() {
  return window.matchMedia?.("(pointer: coarse)")?.matches
    ? PDF_OBSERVER_MARGIN_COARSE
    : PDF_OBSERVER_MARGIN;
}

export const PDF_MIN_SCALE = 0.4;

export const PDF_MAX_SCALE = 5;

// Fit-width leaves this much room either side, so a page is never flush against
// the scroller's edge (and so the shadow that separates one page from the next
// has somewhere to fall).
export const PDF_FIT_PADDING = 24;

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

export function setDocumentPagePaintedHook(fn) {
  onPagePainted = typeof fn === "function" ? fn : () => {};
}

export function setDocumentOpenedHook(fn) {
  onDocumentOpened = typeof fn === "function" ? fn : () => {};
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

// Whether the Document surface is the one a selection or a jump should act on.
export function isDocumentViewActive() {
  return state.viewMode === "document" && Boolean(openPdf);
}

// ── Opening ─────────────────────────────────────────────────────────────────

export function tearDownDocumentView() {
  pdfOpenToken += 1;
  // The crops are of THIS document's pages; a deck swap or a re-attach makes
  // every one of them a picture of something else.
  regionThumbnails.clear();
  if (openPdf?.observer) openPdf.observer.disconnect();
  if (openPdf?.doc) {
    // Releases the worker's copy of the file. Without this, opening five papers
    // in a session keeps five parsed documents alive in the worker.
    openPdf.doc.destroy().catch(() => {});
  }
  openPdf = null;
  clearDocumentOutline();
  if (el.documentView) el.documentView.innerHTML = "";
  if (el.documentPageIndicator) el.documentPageIndicator.textContent = "";
}

// Shown instead of the pages when the file itself is not here: offloaded from
// the cloud and never downloaded on this device, or downloaded once and since
// cleared. Everything else about the deck — highlights, notes, cards — is
// intact, which is exactly what the message has to say, or "re-attach" reads
// as "start again".
function renderMissingDocumentPrompt(pdfMeta) {
  const view = el.documentView;
  if (!view) return;
  view.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "pdf-missing";
  const heading = document.createElement("h2");
  heading.textContent = "Re-attach the PDF to read it";
  const body = document.createElement("p");
  body.textContent = pdfMeta?.offloaded
    ? `“${pdfMeta.name || "This document"}” was removed from the cloud to save space, and this device doesn't have a copy. Your highlights, notes and cards are all still here — pick the same file to read it again.`
    : `This device doesn't have a copy of “${pdfMeta?.name || "the document"}” yet, and it can't be downloaded right now. Your highlights, notes and cards are all still here.`;
  const pick = document.createElement("label");
  pick.className = "pdf-missing-pick";
  pick.textContent = "Choose the PDF…";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.hidden = true;
  pick.appendChild(input);
  const note = document.createElement("p");
  note.className = "pdf-missing-note";
  // Not a formality. A highlight is a coordinate into one exact file; painted
  // over a different edition of the same paper it would sit over the wrong
  // words, silently. Refusing a mismatch is the only honest option.
  note.textContent = pdfMeta?.sha256
    ? "It has to be the same file — the highlights are positions in it, and a different copy would put them over the wrong words."
    : "";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await reattachDocument(file, pdfMeta);
  });
  panel.append(heading, body, pick);
  if (note.textContent) panel.appendChild(note);
  view.appendChild(panel);
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

// Open the PDF for the deck in `state` into #documentView.
//
// Idempotent for the deck already on screen — setViewMode calls this on every
// switch into the Document tab, and re-parsing a 40MB paper because someone
// looked at their cards is not a thing to do. `force` is for the two cases where
// the bytes themselves changed underneath us (a re-attach, a fresh import).
export async function openDocumentView({ force = false } = {}) {
  const view = el.documentView;
  const pdfMeta = state.meta?.pdf;
  if (!view || !pdfMeta) return false;

  const deckKey = currentDeckKey();
  if (!force && openPdf && openPdf.deckKey === deckKey) {
    // Already open: only the layout can have gone stale (a rotate, a resize
    // while the tab was hidden).
    relayoutDocument();
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
    view.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "pdf-loading is-error";
    failed.textContent = "The PDF viewer could not load. Reconnect once so it can be cached, and it will work offline after that.";
    view.appendChild(failed);
    return false;
  }
  if (token !== pdfOpenToken) return false;

  const blob = await getDocument(state.localDeckId, pdfMeta);
  if (token !== pdfOpenToken) return false;
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
    view.innerHTML = "";
    const failed = document.createElement("p");
    failed.className = "pdf-loading is-error";
    failed.textContent = `Could not read this PDF — ${error?.message || "unexpected error"}`;
    view.appendChild(failed);
    return false;
  }
  if (token !== pdfOpenToken) {
    doc.destroy().catch(() => {});
    return false;
  }

  const first = await doc.getPage(1);
  const baseViewport = first.getViewport({ scale: 1 });

  openPdf = {
    deckKey,
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
    pages: new Map(),
    rendered: new Set(),
    observer: null
  };

  view.innerHTML = "";
  openPdf.scale = fitWidthScale();
  buildPagePlaceholders();
  observePages();
  applyPdfInvert(readPdfInvertPreference());
  updatePageIndicator();
  // The pages exist now, so the printed notes have something to be inserted
  // after. Before the outline, which is deliberately off the critical path.
  onDocumentOpened();
  // Off the critical path: the pages are already on screen and readable, and
  // an outline can need a fetch per entry on a long book.
  buildDocumentOutline(doc).catch((error) => console.warn("Could not read the PDF outline", error));

  const resume = state.meta?.readingPosition;
  if (Number.isFinite(resume?.pdfPage)) scrollToDocumentPage(resume.pdfPage, resume.ratio || 0, { smooth: false });
  return true;
}

// ── Layout ──────────────────────────────────────────────────────────────────

export function fitWidthScale() {
  const view = el.documentView;
  if (!view || !openPdf?.baseWidth) return 1;
  const available = Math.max(200, view.clientWidth - PDF_FIT_PADDING * 2);
  return clampScale(available / openPdf.baseWidth);
}

export function clampScale(scale) {
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
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
export function relayoutDocument({ refit = false } = {}) {
  if (!openPdf) return;
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
    if (pageNumber === 1) publishPageWidth(width);
    if (openPdf.rendered.has(pageNumber)) entry.pendingSize = { width, height };
  });
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
  openPdf.pages.forEach((entry, pageNumber) => {
    if (!near.has(pageNumber) && isPageNearViewport(pageNumber)) renderPage(pageNumber);
  });
  updatePageIndicator();
}

export function setDocumentScale(scale, { fitWidth = false } = {}) {
  if (!openPdf) return;
  openPdf.fitWidth = fitWidth;
  openPdf.scale = clampScale(scale);
  relayoutDocument();
}

export function zoomDocument(step) {
  if (!openPdf) return;
  setDocumentScale(openPdf.scale * step);
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

function isPageNearViewport(pageNumber) {
  const view = el.documentView;
  const entry = openPdf?.pages.get(pageNumber);
  if (!view || !entry) return false;
  const top = entry.el.offsetTop;
  const bottom = top + entry.el.offsetHeight;
  const from = view.scrollTop - view.clientHeight;
  const to = view.scrollTop + view.clientHeight * 2;
  return bottom >= from && top <= to;
}

// ── Rendering one page ──────────────────────────────────────────────────────

async function renderPage(pageNumber) {
  const entry = openPdf?.pages.get(pageNumber);
  if (!entry || entry.task || openPdf.rendered.has(pageNumber)) return;
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
  entry.task = (async () => {
    const page = await openPdf.doc.getPage(pageNumber);
    if (stale()) return;
    const viewport = page.getViewport({ scale });
    // The placeholder was sized from page 1's dimensions; this is where a page
    // that is genuinely a different size (a landscape figure, an appendix)
    // corrects itself.
    entry.el.style.width = `${Math.round(viewport.width)}px`;
    entry.el.style.height = `${Math.round(viewport.height)}px`;
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
      if (error?.name !== "RenderingCancelledException") console.warn(`Could not render page ${pageNumber}`, error);
    })
    .finally(() => { if (entry) entry.task = null; });
}

// The mark and text layers, off the critical path. See the comment at the call
// site for why they are not part of the render that puts the page on screen.
async function buildPageLayers(pageNumber, entry, page, viewport, stale) {
  await whenIdle();
  if (stale()) return;
  const markLayer = document.createElement("div");
  markLayer.className = "pdf-mark-layer";
  const textLayer = await buildTextLayer(page, viewport);
  if (stale()) return;
  entry.el.append(markLayer, textLayer);
  entry.markLayer = markLayer;
  entry.textLayer = textLayer;
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
  openPdf.rendered.delete(pageNumber);
  entry.el.innerHTML = "";
  entry.markLayer = null;
  entry.textLayer = null;
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
  content.items.forEach((item, index) => {
    if (!item.str) return;
    const span = document.createElement("span");
    span.dataset.itemIndex = String(index);
    span.textContent = item.str;
    // pdf.js's own transform maths, kept verbatim in spirit: the item transform
    // composed with the viewport transform gives the glyph run's baseline
    // origin and its scale, and the span is placed and stretched to match so a
    // selection over it selects the words that are actually painted there.
    const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = content.styles?.[item.fontName]?.fontFamily || "sans-serif";
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
  return layer;
}

// ── Position ────────────────────────────────────────────────────────────────

// The page the reader is actually on: the first one whose bottom is still below
// the top of the scroller. Deliberately not "the most visible page" — on a
// two-page-tall window the answer flickers between two pages as you scroll,
// and a page indicator that flickers is worse than one that is slightly eager.
export function currentDocumentPage() {
  const view = el.documentView;
  if (!view || !openPdf) return 1;
  const top = view.scrollTop;
  for (let pageNumber = 1; pageNumber <= openPdf.pageCount; pageNumber++) {
    const entry = openPdf.pages.get(pageNumber);
    if (entry && entry.el.offsetTop + entry.el.offsetHeight > top + 4) return pageNumber;
  }
  return openPdf.pageCount;
}

// How far into the current page the reader is, 0..1 — the second half of a
// resumable position. A page is a whole screen on a phone, so "page 12" alone
// would put someone back at the top of a page they were three quarters through.
export function currentDocumentRatio() {
  const view = el.documentView;
  const entry = openPdf?.pages.get(currentDocumentPage());
  if (!view || !entry?.el.offsetHeight) return 0;
  return Math.min(1, Math.max(0, (view.scrollTop - entry.el.offsetTop) / entry.el.offsetHeight));
}

export function scrollToDocumentPage(pageNumber, ratio = 0, { smooth = true } = {}) {
  const view = el.documentView;
  const entry = openPdf?.pages.get(Math.min(Math.max(1, Math.round(pageNumber)), openPdf?.pageCount || 1));
  if (!view || !entry) return false;
  view.scrollTo({
    top: entry.el.offsetTop + entry.el.offsetHeight * (Number.isFinite(ratio) ? ratio : 0),
    behavior: smooth ? "smooth" : "auto"
  });
  updatePageIndicator();
  return true;
}

export function updatePageIndicator() {
  if (!el.documentPageIndicator || !openPdf) return;
  el.documentPageIndicator.textContent = `${currentDocumentPage()} / ${openPdf.pageCount}`;
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
export function readPdfInvertPreference() {
  try {
    return localStorage.getItem(PDF_DARK_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function applyPdfInvert(on) {
  el.documentStage?.classList.toggle(PDF_DARK_CLASS, Boolean(on));
  // The button says which way the mode is set without being pressed — the same
  // rule every other toggle in this app's chrome follows, and the reason this
  // moved out of the ⋯ menu in the first place: a mode nobody can see the state
  // of reads as a mode that is not there.
  el.documentDarkBtn?.setAttribute("aria-pressed", on ? "true" : "false");
  try {
    localStorage.setItem(PDF_DARK_KEY, on ? "1" : "0");
  } catch (_) { /* private mode — the preference just doesn't persist */ }
}

export function togglePdfInvert() {
  const next = !el.documentStage?.classList.contains(PDF_DARK_CLASS);
  applyPdfInvert(next);
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
  if (regionThumbnails.has(id)) return regionThumbnails.get(id);
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
    await page.render({ canvasContext: full.getContext("2d", { alpha: false }), viewport }).promise;
    if (token !== pdfOpenToken) return null;

    const crop = document.createElement("canvas");
    crop.width = width;
    crop.height = height;
    crop.getContext("2d").drawImage(full, Math.round(left), Math.round(top), width, height, 0, 0, width, height);
    const url = crop.toDataURL("image/jpeg", 0.72);
    regionThumbnails.set(id, url);
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
  const pdfMeta = state.meta?.pdf;
  if (!pdfMeta) return false;
  const blob = await getDocument(state.localDeckId, pdfMeta);
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

// Where the pages box sits inside the scroller's CONTENT, which is not zero:
// .document-scroll has 16px of top padding. Both numbers survive a relayout
// (padding does not change with the zoom), so reading them before the commit
// and using them after it is sound.
function pagesContentOffset() {
  const view = el.documentView;
  const host = pagesHost();
  if (!view || !host) return { left: 0, top: 0 };
  const viewRect = view.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return {
    left: hostRect.left - viewRect.left + view.scrollLeft,
    top: hostRect.top - viewRect.top + view.scrollTop
  };
}

// Keep the point under the fingers under the fingers.
//
// A point at `p` in the pages box's own coordinates is at `offset + p - scroll`
// on screen, and re-rendering at `ratio` moves it to `p * ratio`. Solving for
// the scroll that leaves it where it was is the whole of this. The same
// arithmetic zoomDiagramTo does for the diagram modal — written out here rather
// than shared because that one owns a transform and this one owns a scroller.
function anchorDocumentZoom(focal, ratio, before) {
  const view = el.documentView;
  if (!view || !Number.isFinite(ratio) || ratio === 1) return;
  const rect = view.getBoundingClientRect();
  const x = focal.x - rect.left;
  const y = focal.y - rect.top;
  view.scrollLeft = before.offset.left + (x + before.left - before.offset.left) * ratio - x;
  view.scrollTop = before.offset.top + (y + before.top - before.offset.top) * ratio - y;
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
  const end = () => {
    const gesture = pinch;
    pinch = null;
    if (!gesture || !openPdf) { clearPinchPaint(); return; }
    // Paint dropped FIRST: pagesContentOffset measures the box with
    // getBoundingClientRect, and a box that is still scaled reports where the
    // transform put it rather than where the layout has it. Dropping the
    // transform cannot move the scroll offsets — nothing scrolls during a pinch,
    // so they were never past the untransformed maximum.
    clearPinchPaint();
    if (gesture.ratio === 1) return;
    const before = {
      left: view.scrollLeft,
      top: view.scrollTop,
      offset: pagesContentOffset()
    };
    const from = openPdf.scale;
    setDocumentScale(gesture.startScale * gesture.ratio);
    // Against the scale that was actually applied, not the one asked for: at
    // either end of the range the clamp means those are different numbers.
    anchorDocumentZoom(gesture.focal, openPdf.scale / from, before);
  };
  view.addEventListener("touchend", end, { passive: true });
  view.addEventListener("touchcancel", end, { passive: true });
}
