// A region taken out of the app as a file — the mark menu's "Save as image"
// and "Save as PDF" on a box dragged round a figure (see pdf-region.js).
//
// The two are different things on purpose, not one picture in two wrappers:
//
//   image   exactly what the box shows, rendered at print resolution — the
//           page's own content and any ink written on it. A PNG.
//   PDF     the paper's own page, copied out and cropped to the box. Nothing
//           is rasterised: the text in it is still text (selectable, sharp at
//           any zoom) and a vector figure is still vector, because it is the
//           same content stream the paper has, with the page's boxes moved in.
//
// Neither carries the highlight's colour, for the same reason an embed no
// longer does (see the note above paintInkOnCanvas in pdf-region-embed.js): the
// colour says "I marked this" on the paper, and in a file it is in the way.
//
// The PDF holds the PAPER and nothing the app keeps beside it — ink lives in
// meta, not in the file — so it is offered only on a deck's paper and not on
// the Write tab's notebook, whose page is blank grid (see actionsFor on
// DOCUMENT_MARK_HANDLERS). If pdf-lib cannot be had (offline before it was
// ever cached) or cannot read the paper (an encrypted file), the reader still
// gets the region — as the image, and told so.

import { state } from "../core/state.js?v=__BUILD__";
import { ensurePdfLib } from "../core/lib-loader.js?v=__BUILD__";
import { slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { affordableCropScale, regionDocumentBlob, regionImageRect, regionPdfPage, regionSource, renderRegionCrop } from "./pdf-region-embed.js?v=__BUILD__";

// Print resolution: 300 dots per inch of the paper, PDF points being 1/72in.
// affordableCropScale lowers it for a box so large it would not fit the pixel
// budget the zoom already keeps to.
const IMAGE_DPI = 300;

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

// The region as a PNG blob, or null when its paper is not on this device.
export async function regionImageBlob(record) {
  const rect = regionImageRect(record);
  const pageNumber = regionPage(record);
  if (!rect || !pageNumber) return null;
  const source = regionSource(record);
  const page = await regionPdfPage(source, pageNumber);
  if (!page) return null;
  const crop = await renderRegionCrop(page, rect, affordableCropScale(rect, IMAGE_DPI / 72), source);
  return new Promise((resolve) => crop.toBlob(resolve, "image/png"));
}

// The region as a one-page PDF: the paper's page, every box on it moved in to
// the region. Throws when pdf-lib or the paper cannot be had.
export async function regionPdfBytes(record) {
  const rect = regionImageRect(record);
  const pageNumber = regionPage(record);
  if (!rect || !pageNumber) throw new Error("This highlight has no box to save");
  if (!(await ensurePdfLib())) throw new Error("pdf-lib is not available");
  const blob = await regionDocumentBlob(record);
  if (!blob) throw new Error("The PDF is not on this device");
  const { PDFDocument, PDFName } = window.PDFLib;
  const paper = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
  if (pageNumber > paper.getPageCount()) throw new Error("The page is not in this PDF");
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(paper, [pageNumber - 1]);
  // The rect is in the page's default user space (rectToPdfQuad goes through
  // viewport.convertToPdfPoint), which is the space every one of these boxes is
  // written in — and the page's own /Rotate comes across with the copy, so a
  // landscape figure on a rotated page is still the right way up.
  const x = Math.min(rect[0], rect[2]);
  const y = Math.min(rect[1], rect[3]);
  const width = Math.abs(rect[2] - rect[0]);
  const height = Math.abs(rect[3] - rect[1]);
  page.setMediaBox(x, y, width, height);
  page.setCropBox(x, y, width, height);
  page.setBleedBox(x, y, width, height);
  page.setTrimBox(x, y, width, height);
  page.setArtBox(x, y, width, height);
  // Links and comments belong to the whole page; outside the box they are
  // invisible targets a viewer would still let you click.
  page.node.delete(PDFName.of("Annots"));
  out.addPage(page);
  out.setTitle(`Page ${pageNumber} region`);
  out.setProducer("Recall");
  return out.save();
}

export async function downloadRegionImage(record, { savedMessage = "Region saved as an image" } = {}) {
  const blob = await regionImageBlob(record);
  if (!blob) {
    showToast("Couldn't picture this region — the PDF isn't on this device yet", "error");
    return false;
  }
  saveBlob(blob, regionFileName(record, "png"));
  showToast(savedMessage);
  return true;
}

export async function downloadRegionPdf(record) {
  let bytes = null;
  try {
    bytes = await regionPdfBytes(record);
  } catch (error) {
    console.warn("Could not save a PDF region as a PDF", error);
  }
  if (!bytes) {
    await downloadRegionImage(record, { savedMessage: "Couldn't make a PDF of this region — saved it as an image instead" });
    return false;
  }
  saveBlob(new Blob([bytes], { type: "application/pdf" }), regionFileName(record, "pdf"));
  showToast("Region saved as a PDF");
  return true;
}
