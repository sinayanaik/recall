// A region taken out of the app as a file — the mark menu's "Save as image"
// and "Save as PDF" on a box dragged round a figure (see pdf-region.js).
//
// Both carry what the page shows inside the box — the paper, the file's own
// annotations, the reader's highlights, ink and blocks — less the region's own
// frame (see pdf-region-marks.js for that rule and the order things are drawn
// in). They are not one picture in two wrappers:
//
//   image   all of it rendered at print resolution, to a PNG.
//   PDF     the paper's own page, copied out and cropped to the box. The paper
//           is not rasterised — its text is still text and a vector figure is
//           still vector — and the file's own annotations that touch the box
//           come with it as real annotations. The reader's marks are drawn on
//           top as vector graphics too: a highlight is a multiplied rectangle,
//           a pen stroke is the same filled outline the screen paints. Only a
//           typed or picture block is a picture, because it is rendered
//           markdown (mathematics, code, a webfont) that no PDF font can say.
//
// On the Write tab's notebook the paper is blank grid, and what is worth having
// is exactly what is drawn over it — so the PDF is offered there too.
//
// If pdf-lib cannot be had (offline before it was ever cached) or cannot read
// the paper (an encrypted file), the reader still gets the region — as the
// image, and told so.

import { state } from "../core/state.js?v=__BUILD__";
import { ensurePdfLib } from "../core/lib-loader.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { inkPathRecorder } from "../format/ink-svg.js?v=__BUILD__";
import { inkStrokeOutline, resolveInkColor } from "../render/ink-paint.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { affordableCropScale, regionDocumentBlob, regionImageRect, regionPdfPage, regionSource, renderRegionCrop } from "./pdf-region-embed.js?v=__BUILD__";
import { AREA_FILL_ALPHA, blockPdfRect, highlightAlpha, highlightHex, rasteriseRegionBlocks, regionMarksOnPage } from "./pdf-region-marks.js?v=__BUILD__";

// Print resolution: 300 dots per inch of the paper, PDF points being 1/72in.
// affordableCropScale lowers it for a box so large it would not fit the pixel
// budget the zoom already keeps to.
const IMAGE_DPI = 300;

const SOME_BLOCKS_MISSING = " — some text or picture boxes couldn't be included";

function regionPage(record) {
  const page = Number(record?.quads?.[0]?.page || record?.page);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function regionFileName(record, extension) {
  const source = regionSource(record);
  const paper = String(source.pdfMeta?.name || state.deckTitle || "region").replace(/\.pdf$/i, "");
  return `${slugifyFileName(paper, "region")}-p${regionPage(record)}-region.${extension}`;
}

// The object URL is let go a moment after the click rather than at once: a
// phone's browser starts the download asynchronously and a URL revoked under it
// saves nothing.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// The region as a PNG, or null when its paper is not on this device.
// `failed` counts blocks that could not be drawn into it.
export async function regionImageBlob(record) {
  const rect = regionImageRect(record);
  const pageNumber = regionPage(record);
  if (!rect || !pageNumber) return null;
  const source = regionSource(record);
  const page = await regionPdfPage(source, pageNumber);
  if (!page) return null;
  const crop = await renderRegionCrop(page, rect, affordableCropScale(rect, IMAGE_DPI / 72), source, { excludeId: record.id });
  const blob = await new Promise((resolve) => crop.toBlob(resolve, "image/png"));
  return blob ? { blob, failed: crop.failedBlocks || 0 } : null;
}

// ── A colour, as pdf-lib wants it ───────────────────────────────────────────
//
// A pen resolves to whatever CSS colour its theme token holds. A canvas is the
// one parser every browser already has: assigned any CSS colour, its fillStyle
// reads back as "#rrggbb" or "rgba(r, g, b, a)".
let colourProbe = null;

function pdfColour(css) {
  if (!colourProbe) colourProbe = document.createElement("canvas").getContext("2d");
  colourProbe.fillStyle = "#000000";
  colourProbe.fillStyle = String(css || "#000000");
  const value = colourProbe.fillStyle;
  const { rgb } = window.PDFLib;
  if (value.startsWith("#")) {
    return { color: rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255), opacity: 1 };
  }
  const parts = (value.match(/[\d.]+/g) || []).map(Number);
  return { color: rgb((parts[0] || 0) / 255, (parts[1] || 0) / 255, (parts[2] || 0) / 255), opacity: parts.length > 3 ? parts[3] : 1 };
}

// ── Ink, as vector paths ────────────────────────────────────────────────────
//
// The screen draws a stroke as a filled variable-width outline
// (inkStrokeOutline, src/render/ink-paint.js), in PDF user space. The SVG
// writer already hands that function a recorder that turns the same calls into
// SVG path data (inkPathRecorder, src/format/ink-svg.js), so the geometry in the
// file is the code on the screen and not a second copy of it. pdf-lib's
// drawSvgPath flips y (SVG runs down the page); drawn inside a matrix that
// flips it back, the path lands in user space exactly where it was.

// ── The reader's marks, onto the cropped page ───────────────────────────────
function drawHighlights(page, marks) {
  const { BlendMode } = window.PDFLib;
  marks.highlights.forEach((record) => {
    const { color } = pdfColour(highlightHex(record.color));
    (record.quads || []).forEach((quad) => {
      if (Number(quad?.page) !== marks.page || !Array.isArray(quad.rect)) return;
      const [a, b, c, e] = quad.rect.map(Number);
      const x = Math.min(a, c);
      const y = Math.min(b, e);
      const width = Math.abs(c - a);
      const height = Math.abs(e - b);
      if (record.kind === "area") {
        // Another region inside this one: its outline and faint wash, as the
        // page draws it.
        const line = 1.5;
        page.drawRectangle({ x, y, width, height, color, opacity: AREA_FILL_ALPHA });
        page.drawRectangle({
          x: x + line / 2, y: y + line / 2, width: Math.max(0, width - line), height: Math.max(0, height - line),
          borderColor: color, borderWidth: line, borderOpacity: 1
        });
      } else {
        page.drawRectangle({ x, y, width, height, color, opacity: highlightAlpha(record.color), blendMode: BlendMode.Multiply });
      }
    });
  });
}

function drawInk(page, marks) {
  if (!marks.ink.length) return;
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix } = window.PDFLib;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, 0));
  marks.ink.forEach((record) => decodeInkStrokes(record.ink?.s).forEach((stroke) => {
    const recorder = inkPathRecorder();
    if (!inkStrokeOutline(recorder.ctx, stroke)) return;
    const { color, opacity } = pdfColour(resolveInkColor(stroke?.c, null));
    page.drawSvgPath(recorder.path(), { x: 0, y: 0, color, opacity });
  }));
  page.pushOperators(popGraphicsState());
}

// A block's picture is placed by its corners: the raster is upright on SCREEN,
// so the bottom-left, bottom-right and top-left of its on-screen box are taken
// back into user space through the page's own viewport, and the image is drawn
// with the matrix those three points make. On an unrotated page that is just
// its x, y, w, h; on a page with /Rotate it is what keeps the words upright.
async function drawBlocks(out, page, pdfPage, rasters) {
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = window.PDFLib;
  const viewport = pdfPage.getViewport({ scale: 1 });
  for (const { block, canvas } of rasters) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) continue;
    // eslint-disable-next-line no-await-in-loop
    const image = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(blockPdfRect(block));
    const left = Math.min(vx0, vx1);
    const right = Math.max(vx0, vx1);
    const top = Math.min(vy0, vy1);
    const bottom = Math.max(vy0, vy1);
    const [p00x, p00y] = viewport.convertToPdfPoint(left, bottom);
    const [p10x, p10y] = viewport.convertToPdfPoint(right, bottom);
    const [p01x, p01y] = viewport.convertToPdfPoint(left, top);
    const name = page.node.newXObject("Image", image.ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(p10x - p00x, p10y - p00y, p01x - p00x, p01y - p00y, p00x, p00y),
      drawObject(name),
      popGraphicsState()
    );
  }
}

// ── The file's own annotations ──────────────────────────────────────────────
//
// A highlight made in Zotero, a Preview comment, an ink annotation from a
// tablet: kept when its rectangle touches the box, with the popup that belongs
// to it. Not kept: a link (its destination is a page that is not in this file),
// a form field (the form it belongs to is not copied), anything wholly outside
// the box (an invisible target a viewer would still let you click), and a popup
// whose annotation went.
const DROPPED_ANNOTATIONS = new Set(["Link", "Widget"]);

function keepAnnotationsInBox(out, page, box) {
  const { PDFArray, PDFDict, PDFName, PDFRef } = window.PDFLib;
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return 0;
  const entries = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const ref = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText?.() || "";
    const rect = dict.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asRectangle?.();
    const parent = dict.get(PDFName.of("Parent"));
    entries.push({ ref, subtype, rect, parent });
  }
  const touches = (rect) => rect
    && rect.x < box.x + box.width && rect.x + rect.width > box.x
    && rect.y < box.y + box.height && rect.y + rect.height > box.y;
  const kept = entries.filter((entry) => entry.subtype !== "Popup" && !DROPPED_ANNOTATIONS.has(entry.subtype) && touches(entry.rect));
  const keptRefs = new Set(kept.map((entry) => entry.ref).filter((ref) => ref instanceof PDFRef).map((ref) => ref.toString()));
  const popups = entries.filter((entry) => entry.subtype === "Popup" && entry.parent instanceof PDFRef && keptRefs.has(entry.parent.toString()));
  const list = [...kept, ...popups].map((entry) => entry.ref);
  if (list.length) page.node.set(PDFName.of("Annots"), out.context.obj(list));
  else page.node.delete(PDFName.of("Annots"));
  return kept.length;
}

// The cropped page, everything drawn on it. Pure in its inputs, so the check
// can hand it a paper of its own (one with annotations in it).
export async function cropPdfToRegion(paperBytes, pageNumber, rect, { marks = null, rasters = [], pdfPage = null } = {}) {
  if (!(await ensurePdfLib())) throw new Error("pdf-lib is not available");
  const { PDFDocument } = window.PDFLib;
  const paper = await PDFDocument.load(paperBytes, { ignoreEncryption: true, updateMetadata: false });
  if (pageNumber > paper.getPageCount()) throw new Error("The page is not in this PDF");
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(paper, [pageNumber - 1]);
  // The rect is in the page's default user space (rectToPdfQuad goes through
  // viewport.convertToPdfPoint), which is the space every one of these boxes is
  // written in — and the page's own /Rotate comes across with the copy, so a
  // landscape figure on a rotated page is still the right way up.
  const box = {
    x: Math.min(rect[0], rect[2]),
    y: Math.min(rect[1], rect[3]),
    width: Math.abs(rect[2] - rect[0]),
    height: Math.abs(rect[3] - rect[1])
  };
  page.setMediaBox(box.x, box.y, box.width, box.height);
  page.setCropBox(box.x, box.y, box.width, box.height);
  page.setBleedBox(box.x, box.y, box.width, box.height);
  page.setTrimBox(box.x, box.y, box.width, box.height);
  page.setArtBox(box.x, box.y, box.width, box.height);
  keepAnnotationsInBox(out, page, box);
  out.addPage(page);
  // The copied content is wrapped in q … Q before anything is drawn after it
  // (pdf-lib's normalize), so a page that leaves its graphics state changed
  // cannot move the marks drawn over it.
  page.node.normalize();
  // The page's order: highlights, then ink, then blocks.
  if (marks) {
    drawHighlights(page, marks);
    drawInk(page, marks);
  }
  if (rasters.length && pdfPage) await drawBlocks(out, page, pdfPage, rasters);
  out.setTitle(`Page ${pageNumber} region`);
  out.setProducer("Recall");
  return out.save();
}

// The region as a one-page PDF. Throws when pdf-lib or the paper cannot be had.
export async function regionPdfBytes(record) {
  const rect = regionImageRect(record);
  const pageNumber = regionPage(record);
  if (!rect || !pageNumber) throw new Error("This highlight has no box to save");
  if (!(await ensurePdfLib())) throw new Error("pdf-lib is not available");
  const source = regionSource(record);
  const blob = await regionDocumentBlob(record);
  if (!blob) throw new Error("The PDF is not on this device");
  const pdfPage = await regionPdfPage(source, pageNumber);
  const marks = regionMarksOnPage(source, pageNumber, { excludeId: record.id });
  const { rasters, failed } = pdfPage
    ? await rasteriseRegionBlocks(pdfPage, source, pageNumber, rect, IMAGE_DPI / 72)
    : { rasters: [], failed: 0 };
  const bytes = await cropPdfToRegion(new Uint8Array(await blob.arrayBuffer()), pageNumber, rect, { marks, rasters, pdfPage });
  return { bytes, failed };
}

export async function downloadRegionImage(record, { savedMessage = "Region saved as an image" } = {}) {
  const made = await regionImageBlob(record);
  if (!made) {
    showToast("Couldn't picture this region — the PDF isn't on this device yet", "error");
    return false;
  }
  saveBlob(made.blob, regionFileName(record, "png"));
  showToast(made.failed ? `${savedMessage}${SOME_BLOCKS_MISSING}` : savedMessage, made.failed ? "error" : "success");
  return true;
}

export async function downloadRegionPdf(record) {
  let made = null;
  try {
    made = await regionPdfBytes(record);
  } catch (error) {
    console.warn("Could not save a PDF region as a PDF", error);
  }
  if (!made) {
    await downloadRegionImage(record, { savedMessage: "Couldn't make a PDF of this region — saved it as an image instead" });
    return false;
  }
  saveBlob(new Blob([made.bytes], { type: "application/pdf" }), regionFileName(record, "pdf"));
  showToast(made.failed ? `Region saved as a PDF${SOME_BLOCKS_MISSING}` : "Region saved as a PDF", made.failed ? "error" : "success");
  return true;
}
