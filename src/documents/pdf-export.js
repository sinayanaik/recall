// The paper, with your notes on it, as one PDF.
//
// The Document surface could already give you the ORIGINAL file back byte for
// byte (saveDocumentCopy, pdf-view.js) and the Highlights tab could already
// give you a list of passages. Neither of those is the thing a reader who has
// spent an afternoon annotating a paper actually wants to hand to someone: the
// pages they read, marked where they marked them, with what they wrote printed
// under each one.
//
// ── Why it prints pages as images ─────────────────────────────────────────
//
// Because the promise of this whole surface is that the page looks exactly as
// its author laid it out, and the only renderer that can keep that promise is
// pdf.js. Re-flowing the text into HTML would produce a different document that
// happens to contain the same words — and the highlight quads, which are
// coordinates INTO the page box, would have nothing left to be coordinates of.
//
// So each page is rasterised the way renderRegionThumbnail already rasterises
// one, its highlights are painted onto the same canvas before the pixels are
// read back, and the result goes into the print document as an <img>. From
// there it is the existing print pipeline — installPdfPrintStyle,
// printPreparedDocument, the same one the notes and Cornell exports use.
//
// ── What it costs, and what is done about it ──────────────────────────────
//
// Rasterising a forty-page paper is the one genuinely slow path in this app's
// exports. Three things keep it honest: pages render SEQUENTIALLY (a Promise.all
// over forty canvases is how you run a tab out of memory), the render width is
// capped at PRINT_PAGE_WIDTH regardless of the reader's zoom, and progress is
// reported per page — an export that looks hung is one people cancel and retry,
// which costs twice as much as waiting.
//
// Every step is guarded on pdfOpenToken, exactly as renderRegionThumbnail is:
// closing the deck mid-export has to abandon the run rather than paste one
// paper's pages into another paper's document.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { paintInkStrokes } from "../render/ink-paint.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot, docSlotMeta } from "./doc-slot.js?v=__BUILD__";
import { annotatedDocumentHighlights, documentHighlightLabel, documentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { currentPdfDocument, currentPdfPageCount, pdfOpenToken } from "./pdf-view.js?v=__BUILD__";

// The rendered width of a page in the print document, in device pixels. A4 at
// 14mm margins (installPdfPrintStyle) is ~182mm of content, which is ~688 CSS
// pixels; this is a shade over 2× that, so the page is crisp at print
// resolution without every sheet carrying a megabyte of JPEG.
export const PRINT_PAGE_WIDTH = 1400;

// JPEG, not PNG. A scanned or figure-heavy page as a lossless PNG runs to
// several megabytes, and forty of those is a document the print window cannot
// open. 0.85 is above the threshold where text edges start to ring.
export const PRINT_PAGE_QUALITY = 0.85;

// Below this many pages the export just runs. Above it, the reader is told what
// they are waiting for before the main thread goes away for a while.
export const PRINT_PROGRESS_FROM = 4;

function highlightHex(color) {
  return MARK_HIGHLIGHT_HEX[color] || MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT];
}

// One page, rasterised at print width with its highlights painted on.
//
// The highlights are drawn HERE rather than as positioned elements over the
// <img> for one reason: a quad is a coordinate in the page's own space, and the
// only place that space is exactly known is the viewport this function just
// built. An overlay in the print document would have to re-derive it from
// whatever width the printer chose to lay the image out at.
async function renderPageForPrint(pageNumber, records) {
  const doc = currentPdfDocument();
  if (!doc) return null;
  const token = pdfOpenToken;
  const page = await doc.getPage(pageNumber);
  if (token !== pdfOpenToken) return null;
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: PRINT_PAGE_WIDTH / unit.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  // White behind the page, always. `alpha: false` starts a canvas BLACK, and a
  // PDF page paints only its own marks — so without this every page of every
  // export would come out as white text on black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  if (token !== pdfOpenToken) return null;

  records.forEach((record) => {
    // Ink is drawn as ink. Its quad is a bounding box round handwriting, so
    // filling or outlining it would print a rectangle where the reader wrote —
    // the strokes are the mark, and they go on in PDF user space through this
    // page's own viewport transform, exactly as they are drawn on screen.
    //
    // Saved and restored around, because paintInkStrokes leaves a transform and
    // a fill on the context and the highlight loop below runs in page pixels.
    if (record.kind === "ink") {
      if (Number(record.page) !== pageNumber) return;
      const t = viewport.transform;
      context.save();
      context.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      paintInkStrokes(context, decodeInkStrokes(record.ink?.s), { root: null });
      context.restore();
      return;
    }
    context.fillStyle = highlightHex(record.color);
    (record.quads || []).forEach((quad) => {
      if (quad.page !== pageNumber) return;
      const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(quad.rect);
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const width = Math.abs(x1 - x0);
      const height = Math.abs(y1 - y0);
      if (record.kind === "area") {
        // A region round a figure is outlined, never filled — the same choice
        // the on-screen mark layer makes, and for the same reason: a tint over
        // a photograph hides the photograph.
        context.save();
        context.strokeStyle = highlightHex(record.color);
        context.lineWidth = 3;
        context.strokeRect(left, top, width, height);
        context.restore();
        return;
      }
      // Multiply, so the words stay readable through the tint. globalAlpha
      // would lighten the glyphs as well as the paper.
      context.save();
      context.globalCompositeOperation = "multiply";
      context.fillRect(left, top, width, height);
      context.restore();
    });
  });
  return canvas.toDataURL("image/jpeg", PRINT_PAGE_QUALITY);
}

// How much of the highlighted passage is printed beside its note. Long enough to
// find the sentence on the page above; short enough that the label is not taller
// than the note it labels.
export const PRINT_EXCERPT_CHARS = 80;

function excerptFor(record) {
  // documentHighlightLabel, not record.text: a region drawn round a photograph
  // has no words in it at all, and a blank line above a note is
  // indistinguishable from a bug. That names it "Region · page 12" instead.
  const flat = String(documentHighlightLabel(record) || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > PRINT_EXCERPT_CHARS ? `${flat.slice(0, PRINT_EXCERPT_CHARS).trimEnd()}…` : flat;
}

function pageNotesHtml(entries) {
  if (!entries.length) return "";
  const rows = entries.map(({ record, note, n }) => `
    <li class="doc-print-note">
      <span class="doc-print-note-num">${n}</span>
      <span class="doc-print-note-body">
        <span class="doc-print-note-excerpt">${escapeHtml(excerptFor(record))}</span>
        ${markdownToSafeHtml(note)}
      </span>
    </li>
  `).join("");
  return `<ol class="doc-print-notes">${rows}</ol>`;
}

// The whole document. `annotatedOnly` prints only the pages that carry a note —
// which for a paper read closely is a handful of sheets rather than forty, and
// is what most people mean by "my notes on this".
export async function buildDocumentPrintDocument(title, { annotatedOnly = false } = {}) {
  const pageCount = currentPdfPageCount();
  const annotated = annotatedDocumentHighlights();
  const notesByPage = new Map();
  annotated.forEach((entry) => {
    const page = Number(entry.record.page || entry.record.quads?.[0]?.page || 0);
    if (!page) return;
    if (!notesByPage.has(page)) notesByPage.set(page, []);
    notesByPage.get(page).push(entry);
  });
  // Marks are painted on every printed page whether or not it carries a note —
  // a page in the export that is missing the highlight the facing note refers
  // to is worse than no export at all.
  const marksByPage = new Map();
  // The surface's own marks. A deck can have two documents and the pages being
  // printed are one of them, so the whole array would paint a notebook's strokes
  // onto page 3 of somebody's preprint.
  documentHighlights().forEach((record) => {
    (record.quads || []).forEach((quad) => {
      if (!quad?.page) return;
      if (!marksByPage.has(quad.page)) marksByPage.set(quad.page, new Set());
      marksByPage.get(quad.page).add(record);
    });
  });

  const wanted = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    if (annotatedOnly && !notesByPage.has(pageNumber)) continue;
    wanted.push(pageNumber);
  }

  const sheets = [];
  for (let i = 0; i < wanted.length; i++) {
    const pageNumber = wanted[i];
    if (wanted.length >= PRINT_PROGRESS_FROM) {
      setStatus(`Preparing the document PDF — page ${i + 1} of ${wanted.length}…`);
    }
    // Sequential on purpose: see the header. `await` inside the loop is the
    // point of it, not an oversight.
    // eslint-disable-next-line no-await-in-loop
    const image = await renderPageForPrint(pageNumber, [...(marksByPage.get(pageNumber) || [])]);
    if (image === null) return null; // the deck was closed under us
    sheets.push(`
      <section class="doc-print-sheet">
        <figure class="doc-print-page">
          <img src="${image}" alt="Page ${pageNumber}">
          <figcaption>Page ${pageNumber}</figcaption>
        </figure>
        ${pageNotesHtml(notesByPage.get(pageNumber) || [])}
      </section>
    `);
  }

  const empty = sheets.length
    ? ""
    : `<p class="flat-export-empty">No page of this document has a note on it yet.</p>`;
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document doc-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Document &amp; notes &middot; ${annotated.length} note${annotated.length === 1 ? "" : "s"} &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      ${empty}
      ${sheets.join("")}
    </div>
  `;
}

export function documentExportBaseName() {
  const title = state.deckTitle || state.sourceTitle || "document";
  return `${title.replace(/[\\/:*?"<>|]+/g, "-").trim()} - document and notes`;
}

export function documentHasPagesToPrint({ annotatedOnly = false } = {}) {
  if (!docSlotMeta(activeDocSlot()) || !currentPdfDocument()) return false;
  return annotatedOnly ? annotatedDocumentHighlights().length > 0 : currentPdfPageCount() > 0;
}

// Whether the surface even has a document open to export. The ⋯ row is painted
// from this, so pressing it can never reach the "nothing happened" branch.
export function documentPrintPageCount({ annotatedOnly = false } = {}) {
  if (!docSlotMeta(activeDocSlot())) return 0;
  if (!annotatedOnly) return currentPdfPageCount();
  const pages = new Set();
  annotatedDocumentHighlights().forEach(({ record }) => {
    const page = Number(record.page || record.quads?.[0]?.page || 0);
    if (page) pages.add(page);
  });
  return pages.size;
}

// A guard for the caller, so el.documentView is not the thing that decides.
export function documentExportUnavailableReason() {
  const slot = activeDocSlot();
  if (!docSlotMeta(slot)) {
    return slot === DOC_SLOT_NOTEBOOK
      ? "This deck has no handwritten pages to export."
      : "This deck has no PDF to export.";
  }
  if (!currentPdfDocument()) return "Open the document first — its pages aren't loaded yet.";
  if (!el.printRoot) return "This build has nowhere to print to.";
  return "";
}
