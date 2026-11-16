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
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { markGeometry, markStyleOf, normalizeMarkHex, paintMarkGeometry } from "../format/mark-styles.js?v=__BUILD__";
import { paintInkLayers } from "../render/ink-paint.js?v=__BUILD__";
import { paintShapeOnCanvas } from "../render/annot-shapes.js?v=__BUILD__";
import { PAPER_WHITE, paintPaperTone, paperRecolor } from "../format/paper-tones.js?v=__BUILD__";

// Printed white, whatever paper the reader wrote on: a colour they picked on
// a dark tone (a pale custom pen, a white text box) would be the colour of the
// page here, so it is drawn as its readable twin — the same rule the screen
// applies to the paper it shows (src/format/paper-tones.js).
const PRINT_RECOLOR = paperRecolor(PAPER_WHITE);
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, activeDocSlot, docSlotMeta } from "./doc-slot.js?v=__BUILD__";
import { activePdfId } from "./pdf-multi.js?v=__BUILD__";
import { exportThemeClass } from "../export/themes.js?v=__BUILD__";
import { annotatedDocumentHighlights, documentHighlightLabel, documentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { currentPaperTone, currentPdfDocument, currentPdfPageCount, currentPdfScale, pdfOpenToken, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { resolvedShape } from "./pdf-shapes.js?v=__BUILD__";
import { regionImageRect, renderRegionImage } from "./pdf-region-embed.js?v=__BUILD__";
import { rasterPlacement, rasterWordSize } from "./pdf-region-download.js?v=__BUILD__";
import { createInvisibleTextLayer } from "./pdf-text-layer.js?v=__BUILD__";
import { drawRegionBlocks, highlightHex, paintRegionMarks, rasteriseRegionBlocks, regionBlocksInBox, regionMarksOnPage, shapeTextRasterIds } from "./pdf-region-marks.js?v=__BUILD__";

// The rendered width of a page in the print document, in device pixels. A4 at
// 14mm margins (installPdfPrintStyle) is ~182mm of content, and the page is
// printed across all of it (styles/39-document-export.css): 1800 pixels over
// 182mm is ~250dpi, which keeps a paper's footnotes and a Canvas's thin pen
// lines legible, without every sheet carrying several megabytes of JPEG.
export const PRINT_PAGE_WIDTH = 1800;

// JPEG, not PNG. A scanned or figure-heavy page as a lossless PNG runs to
// several megabytes, and forty of those is a document the print window cannot
// open. 0.85 is above the threshold where text edges start to ring.
export const PRINT_PAGE_QUALITY = 0.85;

// Below this many pages the export just runs. Above it, the reader is told what
// they are waiting for before the main thread goes away for a while.
export const PRINT_PROGRESS_FROM = 4;

// One page, rasterised at print width with its highlights painted on.
//
// The highlights are drawn HERE rather than as positioned elements over the
// <img> for one reason: a quad is a coordinate in the page's own space, and the
// only place that space is exactly known is the viewport this function just
// built. An overlay in the print document would have to re-derive it from
// whatever width the printer chose to lay the image out at.
async function renderPageForPrint(pageNumber, records) {
  const canvas = await renderPageCanvas(pageNumber, records);
  return canvas ? canvas.toDataURL("image/jpeg", PRINT_PAGE_QUALITY) : null;
}

// The same page as a canvas. The Canvas export draws its pages its own way
// (renderCanvasPageExact, below).
async function renderPageCanvas(pageNumber, records) {
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

  // The typed text and pictures placed on the page (src/documents/
  // pdf-blocks.js) — on a Canvas they are half of what is on it, and the page
  // export used to print the paper and the ink without them. Drawn by the
  // same rasteriser a region's picture uses, over the whole page, at this
  // viewport's scale so the words are as sharp as the page around them; and
  // under the marks, which annotate them as they annotate the paper.
  // In paper colours, whatever the app's theme: the page is printed white, and
  // a block built in a dark theme's tokens printed as a black box.
  const { rasters } = await rasteriseRegionBlocks(page, stagePaperSource(), pageNumber, page.view, viewport.scale, { paper: "light" })
    .catch((error) => {
      console.warn("Could not draw a page's blocks for the export", error);
      return { rasters: [] };
    });
  if (token !== pdfOpenToken) return null;
  drawRegionBlocks(context, viewport, rasters, { only: "block" });
  // The words of a text box that are markdown come back from the same
  // rasteriser (src/documents/pdf-region-marks.js) and go on AFTER the marks,
  // over their own box and fill — the canvas draws the box, not the words.
  const textRasterIds = shapeTextRasterIds(rasters);

  records.forEach((record) => {
    // Ink is drawn as ink. Its quad is a bounding box round handwriting, so
    // filling or outlining it would print a rectangle where the reader wrote —
    // the strokes are the mark, and they go on in PDF user space through this
    // page's own viewport transform, exactly as they are drawn on screen.
    //
    // Saved and restored around, because paintInkLayers leaves a transform and
    // a fill on the context and the highlight loop below runs in page pixels.
    // A shape is drawn as the shape (src/render/annot-shapes.js) — its quad is
    // a bounding box, like ink's — through this page's viewport, at its scale.
    if (record.kind === "shape") {
      if (Number(record.page) !== pageNumber) return;
      paintShapeOnCanvas(context, record.shape, ([x, y]) => viewport.convertToViewportPoint(x, y), viewport.scale, {
        skipText: textRasterIds.has(record.id),
        recolor: PRINT_RECOLOR
      });
      return;
    }
    if (record.kind === "ink") {
      if (Number(record.page) !== pageNumber) return;
      const t = viewport.transform;
      context.save();
      context.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      // On white paper, whatever the app's theme — this is a picture of the PDF,
      // which is printed white — and with any highlighter bands in the mark
      // MULTIPLIED onto the page and laid under its pen strokes, as the screen
      // stacks its two layers. A band from a later mark multiplies over earlier
      // ink, which leaves that ink as dark as it was: multiply cannot cover.
      paintInkLayers(context, decodeInkStrokes(record.ink?.s), { root: null, paper: "light", paperBg: PAPER_WHITE, blend: "multiply" });
      context.restore();
      return;
    }
    const customHex = normalizeMarkHex(record.hex);
    const markHex = customHex || highlightHex(record.color);
    context.fillStyle = markHex;
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
      // would lighten the glyphs as well as the paper. A line, a wave or a box
      // (src/format/mark-styles.js) goes down the same way, in the solid colour.
      context.save();
      context.globalCompositeOperation = "multiply";
      paintMarkGeometry(context, markGeometry(markStyleOf(record), left, top, width, height, 1.5), markHex, markHex);
      context.restore();
    });
  });
  drawRegionBlocks(context, viewport, rasters, { only: "shape-text" });
  return canvas;
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

// A region or ink mark's note is printed beside a picture of what the mark
// holds, not its "Region · page 12" name — the same picture the Highlights pane
// shows (renderRegionImage), awaited before the markup is written so it is in
// the file. The label stays the answer when there is nothing to picture it
// from.
export const PRINT_REGION_WIDTH = 240;

// A region pictured beside its note is shown at its own size on the page, up
// to PRINT_REGION_WIDTH — never blown up past it, which turned a circled word
// into a blurred block — and drawn at twice that so it is sharp on paper.
function printRegionSize(record) {
  const rect = regionImageRect(record);
  const natural = rect ? Math.abs(rect[2] - rect[0]) * 96 / 72 : PRINT_REGION_WIDTH;
  const shown = Math.max(24, Math.min(PRINT_REGION_WIDTH, Math.round(natural)));
  return { shown, render: shown * 2 };
}

async function excerptHtmlFor(record) {
  // On a Canvas the handwriting a note is about is on the page printed just
  // above it, so a second picture of it is the same strokes again, cut out and
  // resized. It is named instead.
  if (record?.kind === "ink" && activeDocSlot() === DOC_SLOT_NOTEBOOK) {
    return `<span class="doc-print-note-excerpt">${escapeHtml(`Handwriting · page ${record.page || record.quads?.[0]?.page || ""}`.trim())}</span>`;
  }
  if (record?.kind === "area" || record?.kind === "ink" || record?.kind === "shape") {
    const size = printRegionSize(record);
    const url = await renderRegionImage(record, { width: size.render }).catch(() => null);
    if (url) {
      const words = String(record.text || "").replace(/\s+/g, " ").trim();
      const caption = words
        ? `<span class="doc-print-note-excerpt">${escapeHtml(words.length > PRINT_EXCERPT_CHARS ? `${words.slice(0, PRINT_EXCERPT_CHARS).trimEnd()}…` : words)}</span>`
        : "";
      return `<img class="doc-print-note-region" src="${escapeHtml(url)}" alt="${escapeHtml(documentHighlightLabel(record))}" style="width:${size.shown}px">${caption}`;
    }
  }
  return `<span class="doc-print-note-excerpt">${escapeHtml(excerptFor(record))}</span>`;
}

async function pageNotesHtml(entries) {
  if (!entries.length) return "";
  const excerpts = await Promise.all(entries.map(({ record }) => excerptHtmlFor(record)));
  // No number: the page no longer wears one (src/documents/pdf-page-notes.js),
  // and each note already opens with the quote it is about.
  const rows = entries.map(({ note }, index) => `
    <li class="doc-print-note">
      <span class="doc-print-note-body">
        ${excerpts[index]}
        ${markdownToSafeHtml(note)}
      </span>
    </li>
  `).join("");
  return `<ol class="doc-print-notes">${rows}</ol>`;
}

// The paper on the stage, as the block and mark lookups name it.
function stagePaperSource() {
  const slot = activeDocSlot();
  return { slot, pdfId: slot === DOC_SLOT_DOC ? activePdfId(state.meta) : null };
}

export function onCanvasSlot() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK;
}

// Everything on a page counts as something on it, for every page of a box this
// large: a block anywhere on page n.
const WHOLE_PAGE = [-1e6, -1e6, 1e6, 1e6];

// The pages "only the annotated pages" means. On a paper it is the pages with
// a note — a paper read closely is a handful of those rather than forty. On a
// Canvas the menu says "Pages you wrote on", and a page of handwriting with no
// note on it was left out: there it is any page with a stroke, a highlight or
// a block on it.
function annotatedPages() {
  const pages = new Set();
  annotatedDocumentHighlights().forEach(({ record }) => {
    const page = Number(record.page || record.quads?.[0]?.page || 0);
    if (page) pages.add(page);
  });
  if (!onCanvasSlot()) return pages;
  documentHighlights().forEach((record) => {
    (record.quads || []).forEach((quad) => { if (quad?.page) pages.add(Number(quad.page)); });
  });
  const source = stagePaperSource();
  for (let page = 1; page <= currentPdfPageCount(); page += 1) {
    if (regionBlocksInBox(source, page, WHOLE_PAGE).length) pages.add(page);
  }
  return pages;
}

// What the export calls the thing it prints, in the status line and on the
// cover — a Canvas was announced as "the document" and printed as one.
export function documentExportNoun() {
  return onCanvasSlot() ? "Canvas" : "document";
}

export function documentExportEmptyMessage({ annotatedOnly = false } = {}) {
  if (onCanvasSlot()) return annotatedOnly ? "No Canvas page has anything on it yet." : "This Canvas has no pages to export.";
  return annotatedOnly ? "No page of this document has a note on it yet." : "This document has no pages to export.";
}

// The whole document, or with `annotatedOnly` just annotatedPages().
// Marks are painted on every printed page whether or not it carries a note —
// a page in the export that is missing the highlight the facing note refers
// to is worse than no export at all. The surface's own marks only: a deck can
// have two documents and the pages being printed are one of them, so the whole
// array would paint a notebook's strokes onto page 3 of somebody's preprint.
function marksByPageNumber() {
  const marksByPage = new Map();
  documentHighlights().forEach((record) => {
    (record.quads || []).forEach((quad) => {
      if (!quad?.page) return;
      if (!marksByPage.has(quad.page)) marksByPage.set(quad.page, new Set());
      marksByPage.get(quad.page).add(record);
    });
  });
  return marksByPage;
}

// The page numbers an export prints, in order.
function pagesToPrint({ annotatedOnly = false } = {}) {
  const keep = annotatedOnly ? annotatedPages() : null;
  const wanted = [];
  for (let pageNumber = 1; pageNumber <= currentPdfPageCount(); pageNumber++) {
    if (keep && !keep.has(pageNumber)) continue;
    wanted.push(pageNumber);
  }
  return wanted;
}

export async function buildDocumentPrintDocument(title, { annotatedOnly = false, theme } = {}) {
  const annotated = annotatedDocumentHighlights();
  const notesByPage = new Map();
  annotated.forEach((entry) => {
    const page = Number(entry.record.page || entry.record.quads?.[0]?.page || 0);
    if (!page) return;
    if (!notesByPage.has(page)) notesByPage.set(page, []);
    notesByPage.get(page).push(entry);
  });
  const marksByPage = marksByPageNumber();
  const wanted = pagesToPrint({ annotatedOnly });

  const sheets = [];
  for (let i = 0; i < wanted.length; i++) {
    const pageNumber = wanted[i];
    if (wanted.length >= PRINT_PROGRESS_FROM) {
      setStatus(`Preparing the ${documentExportNoun()} PDF — page ${i + 1} of ${wanted.length}…`);
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
        ${await pageNotesHtml(notesByPage.get(pageNumber) || [])}
      </section>
    `);
  }

  const empty = sheets.length
    ? ""
    : `<p class="flat-export-empty">${escapeHtml(documentExportEmptyMessage({ annotatedOnly }))}</p>`;
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document doc-print-document export-root ${exportThemeClass(theme)}">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${onCanvasSlot() ? "Canvas" : "Document &amp; notes"} &middot; ${annotated.length} note${annotated.length === 1 ? "" : "s"} &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      ${empty}
      ${sheets.join("")}
    </div>
  `;
}

// ── The Canvas, exactly as it is ───────────────────────────────────────────
//
// A Canvas page is not an A4 sheet, and printing it as one, with a cover, a
// 14mm margin, a caption under it and a look to wear, squeezed the pages and
// spilled them onto extra sheets. So the Canvas writes its own PDF: one PDF page
// per Canvas page, the same size as the Canvas page, drawn edge to edge, with
// nothing added but its number — "k / n" at the foot of the page, in the very
// place and size the Canvas shows it on screen (styles/53-handwriting.css,
// .pdf-page::after), so the exported page is the page as it was seen. Turned
// off with ⋯ → Canvas pages → Page numbers, it is off in both.
//
// "As it was seen" is the whole promise, and it is kept by drawing each page
// the way the screen stacks it, not the way the PDFs' printed export does:
//
//   - the paper in its tone (paintPaperTone, the screen's own step), not
//     always white, and every colour on it as it is on that paper;
//   - highlights, then ink, then shapes and connectors, then Blocks ON TOP —
//     the z-order of the page's layers (styles/52-ink.css, 88-annotations.css,
//     53-handwriting.css). Blocks drawn first came out scribbled over;
//   - every connector routed as the screen routes it (resolvedShape), not as
//     its stored ends happen to lie;
//   - every Block laid out at the zoom the reader sees it at, so its words
//     wrap where they wrap on screen, then drawn at the export's resolution.
//     Laid out at one point per pixel they wrapped elsewhere and overflowed.

// In PDF points on the Canvas page: the number's size, and its baseline's
// height above the page's bottom edge. The CSS states the same two numbers.
export const CANVAS_NUMBER_SIZE = 9;
export const CANVAS_NUMBER_BASELINE = 16;
// The rendered width of a Canvas page in the file, in pixels: a sheet of A4 at
// ~300dpi, which keeps a thin pen line and a Block's small print sharp.
export const CANVAS_EXPORT_WIDTH = 2480;
// A touch higher than the printed export's: these pages are the whole file.
export const CANVAS_PAGE_QUALITY = 0.92;

function canvasJpegBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("The page could not be encoded")); return; }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/jpeg", CANVAS_PAGE_QUALITY);
  });
}

// The zoom a page is seen at: its own viewport when it has been laid out,
// otherwise the zoom every page is drawn at.
function seenScale(pageNumber) {
  return pdfPageViewport(pageNumber)?.scale || currentPdfScale() || 1;
}

// One Canvas page as the screen shows it, at CANVAS_EXPORT_WIDTH.
async function renderCanvasPageExact(pageNumber) {
  const doc = currentPdfDocument();
  if (!doc) return null;
  const token = pdfOpenToken;
  const page = await doc.getPage(pageNumber);
  if (token !== pdfOpenToken) return null;
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: CANVAS_EXPORT_WIDTH / unit.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  // White first: `alpha: false` starts a canvas black, and the page paints
  // only its own lines. The tone goes on after, as it does on screen.
  context.fillStyle = PAPER_WHITE;
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  if (token !== pdfOpenToken) return null;
  const tone = currentPaperTone();
  paintPaperTone(context, canvas, { dark: Boolean(tone?.dark), tint: tone?.tint || null });

  const source = stagePaperSource();
  // Rasterised before any marks go down, so the shape-text ids are known; laid
  // out at the page's on-screen zoom and drawn at this viewport's scale. Every
  // word on each is measured as it goes (`words`), for the text layer the
  // file lays over the page.
  const { rasters } = await rasteriseRegionBlocks(page, source, pageNumber, page.view, viewport.scale, {
    paper: "theme",
    layoutScale: seenScale(pageNumber),
    words: true
  }).catch((error) => {
    console.warn("Could not draw a page's blocks for the export", error);
    return { rasters: [] };
  });
  if (token !== pdfOpenToken) return null;

  const marks = regionMarksOnPage(source, pageNumber);
  marks.shapes = marks.shapes.map((record) => ({ ...record, shape: resolvedShape(record) || record.shape }));
  paintRegionMarks(context, viewport, marks, {
    paper: tone?.key || "light",
    skipTextIds: shapeTextRasterIds(rasters)
  });
  drawRegionBlocks(context, viewport, rasters, { only: "block" });
  drawRegionBlocks(context, viewport, rasters, { only: "shape-text" });
  // The words without the pixels: all the text layer needs, and small enough
  // to keep until every page is drawn.
  const words = rasters
    .filter((raster) => raster.words?.length)
    .map((raster) => ({ block: raster.block, words: raster.words, wordScale: raster.wordScale }));
  return { canvas, tone, words };
}

// ── The words, selectable ───────────────────────────────────────────────────
//
// A page of the file is one picture, so a Block's words were pixels: nothing to
// select, copy or search. Each Block's words are laid over its pixels as
// INVISIBLE text (src/documents/pdf-text-layer.js), the way a scanned page is
// made searchable and the way "With annotations" and a region's PDF already
// carry theirs: nothing drawn, so the page looks exactly as it did, and every
// viewer selects, copies and finds them where the picture shows them. Placed
// by the same matrices the region PDF draws a block's picture with
// (rasterPlacement), turned blocks included. A formula copies as its TeX.
async function writeCanvasWords(out, wordsByPage) {
  if (!wordsByPage.length) return;
  try {
    const layer = createInvisibleTextLayer(out);
    await layer.prepare(wordsByPage.flatMap(({ words }) => words.flatMap((entry) => entry.words)));
    for (const { page, pdfPage, words } of wordsByPage) {
      for (const entry of words) {
        // eslint-disable-next-line no-await-in-loop
        await layer.writeWords(page, entry.words, { ...rasterPlacement(pdfPage, entry.block), size: rasterWordSize(entry) });
      }
    }
  } catch (error) {
    // The pages are still the pages; only the words would not select.
    console.warn("Could not lay the Canvas's words over its pages", error);
  }
}

// Resolves to { bytes, name, pages }, or null when the deck was closed while
// its pages were rendering. Needs window.PDFLib (ensurePdfLib) loaded first.
export async function buildCanvasPdfBytes() {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const source = currentPdfDocument();
  if (!source) return null;
  const token = pdfOpenToken;
  const wanted = pagesToPrint();
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  // Read off the record as src/documents/notebook.js does (notebookPageNumbers,
  // notebookPageCount) — not imported, since that module reaches the whole
  // page surface and this one is reached from the renderers.
  const numbered = state.meta?.notebook?.pageNumbers !== false;
  const total = Number(state.meta?.notebook?.pages) || source.numPages || wanted.length;
  // Each page's Block words, laid over it once every page is drawn — so the
  // text layer loads its fonts once, for every word in the file.
  const wordsByPage = [];
  const drawnPages = [];
  for (let i = 0; i < wanted.length; i++) {
    const pageNumber = wanted[i];
    if (wanted.length >= PRINT_PROGRESS_FROM) {
      setStatus(`Preparing the Canvas PDF — page ${i + 1} of ${wanted.length}…`);
    }
    // Sequential on purpose, as buildDocumentPrintDocument is.
    /* eslint-disable no-await-in-loop */
    const pdfPage = await source.getPage(pageNumber);
    if (token !== pdfOpenToken) return null;
    // The page's own size in points, turned as it is shown.
    const { width, height } = pdfPage.getViewport({ scale: 1 });
    const drawn = await renderCanvasPageExact(pageNumber);
    if (!drawn || token !== pdfOpenToken) return null;
    const image = await out.embedJpg(await canvasJpegBytes(drawn.canvas));
    /* eslint-enable no-await-in-loop */
    drawn.canvas.width = 0; // let the pixels go before the next page renders
    const page = out.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    drawnPages.push({ page, pdfPage, pageNumber, width, dark: Boolean(drawn.tone?.dark) });
    if (drawn.words.length) wordsByPage.push({ page, pdfPage, words: drawn.words });
  }
  await writeCanvasWords(out, wordsByPage);
  if (token !== pdfOpenToken) return null;
  // The numbers after the words, so copying a page gives what is written on
  // it first and its number last, the order it is read in.
  if (numbered) {
    drawnPages.forEach(({ page, pageNumber, width, dark }) => {
      // Of every page in the Canvas: "3 / 12", as it is on screen. In the
      // screen's colours for it (styles/53-handwriting.css): grey 115 on a
      // light paper, white at half strength on a dark one.
      const label = `${pageNumber} / ${total}`;
      const labelWidth = font.widthOfTextAtSize(label, CANVAS_NUMBER_SIZE);
      page.drawText(label, {
        x: (width - labelWidth) / 2,
        y: CANVAS_NUMBER_BASELINE,
        size: CANVAS_NUMBER_SIZE,
        font,
        color: dark ? rgb(1, 1, 1) : rgb(115 / 255, 115 / 255, 115 / 255),
        opacity: dark ? 0.5 : 1
      });
    });
  }
  out.setTitle(state.deckTitle || state.sourceTitle || "Canvas");
  out.setProducer("Recall");
  const bytes = await out.save();
  return { bytes, name: `${documentExportBaseName()}.pdf`, pages: wanted.length };
}

export function documentExportBaseName() {
  const title = state.deckTitle || state.sourceTitle || "document";
  return `${title.replace(/[\\/:*?"<>|]+/g, "-").trim()} - ${onCanvasSlot() ? "canvas" : "document and notes"}`;
}

export function documentHasPagesToPrint({ annotatedOnly = false } = {}) {
  if (!docSlotMeta(activeDocSlot()) || !currentPdfDocument()) return false;
  return annotatedOnly ? annotatedPages().size > 0 : currentPdfPageCount() > 0;
}

// Whether the surface even has a document open to export. The ⋯ row is painted
// from this, so pressing it can never reach the "nothing happened" branch.
export function documentPrintPageCount({ annotatedOnly = false } = {}) {
  if (!docSlotMeta(activeDocSlot())) return 0;
  if (!annotatedOnly) return currentPdfPageCount();
  return annotatedPages().size;
}

// A guard for the caller, so el.documentView is not the thing that decides.
export function documentExportUnavailableReason() {
  const slot = activeDocSlot();
  if (!docSlotMeta(slot)) {
    return slot === DOC_SLOT_NOTEBOOK
      ? "This file has no Canvas pages to export."
      : "This file has no PDF to export.";
  }
  if (!currentPdfDocument()) return "Open the document first — its pages aren't loaded yet.";
  if (!el.printRoot) return "This build has nowhere to print to.";
  return "";
}
