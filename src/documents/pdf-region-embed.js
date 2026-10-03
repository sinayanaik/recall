// A card's answer can hold a REFERENCE to a spot on a PDF page — see
// pdf-region.js for why a dragged region carries a quad and no text — and
// this is what turns that reference into something a reader actually sees:
// a live render of exactly that box, re-drawn from the deck's own already-
// stored PDF each time it's shown, with a real (selectable) text layer over
// it. Not a screenshot: nothing is rasterised and kept. Not text extraction
// either: the box was never a reliable way to say which words belong to it.
//
// The reference travels as an ordinary markdown image whose `src` is never
// meant to be fetched — `![](pdfref:<page>:<x0>,<y0>,<x1>,<y1>)` — the same
// idea as `recall-img:<token>` (src/images/outbox.js) for an image still
// queued for upload: a marker intercepted before the browser tries to load
// it, not a real URL.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { ensurePdfJs } from "../core/lib-loader.js?v=__BUILD__";
import { centerDiagramContent, openDiagramModal } from "../render/diagram-zoom.js?v=__BUILD__";
import { DOC_SLOT_DOC, docSlotMeta, documentStoreKey, recordDocSlot } from "./doc-slot.js?v=__BUILD__";
import { deckPdfById, PDF_PRIMARY_ID, pdfStoreKey, recordPdfId } from "./pdf-multi.js?v=__BUILD__";
import { drawRegionBlocks, mountRegionBlockLayer, paintRegionMarks, rasteriseRegionBlocks, regionAnnotationStamp, regionMarksOnPage } from "./pdf-region-marks.js?v=__BUILD__";
import { getDocument } from "./pdf-store.js?v=__BUILD__";
import { buildTextLayer, canvasOutputScale, clampScale, PDF_MAX_SCALE } from "./pdf-view.js?v=__BUILD__";
import { attachRegionResizeHandle } from "./pdf-region-resize.js?v=__BUILD__";

export const PDFREF_SCHEME = "pdfref:";

// Wide enough to read a figure's fine print on a card face; not so wide that
// it overflows a phone-width answer column before a reader resizes it. A ref
// can override this with its own stored width (see `width` below) once a
// reader has dragged the resize handle on a card — see pdf-region-resize.js.
export const EMBED_TARGET_WIDTH = 420;

// `pdfId` and `width` are both appended only when they differ from the
// implicit default (the primary PDF, EMBED_TARGET_WIDTH), so a card made
// before either existed keeps the exact ref it always had — every existing
// card, and every client that has not seen this change, still parses it
// exactly as before. A width with no pdfId still needs a placeholder in the
// pdfId slot (an empty segment) so position alone tells the two apart:
//
//   page:rect                  — neither set (unchanged)
//   page:rect:pdfB             — pdfId only (unchanged)
//   page:rect::480             — width only, primary PDF
//   page:rect:pdfB:480         — both set
export function pdfRegionRefMarkdown(page, rect, pdfId, width) {
  const idPart = pdfId && pdfId !== PDF_PRIMARY_ID ? pdfId : "";
  const widthPart = width ? String(Math.round(width)) : "";
  const suffix = widthPart ? `:${idPart}:${widthPart}` : (idPart ? `:${idPart}` : "");
  return `![](${PDFREF_SCHEME}${page}:${rect.join(",")}${suffix})`;
}

// The location of ANY document highlight, as a ref — what the mark menu's
// "Copy location" puts on the clipboard, to be pasted into the notes or a card
// and rendered there as a live picture of that spot. A region is the box the
// reader drew, written exactly as makeCard writes it (src/main.js) so the two
// refs for one region are the same string. A text run or ink mark has no box
// of its own, so it gets the bounds of its quads on its page, padded a little
// so the glyphs' edges are not shaved off.
const LOCATION_PAD = 3;

export function pdfRegionRefForRecord(record) {
  const quads = (record?.quads || []).filter((quad) => Array.isArray(quad?.rect) && quad.rect.length === 4
    && quad.rect.every((n) => Number.isFinite(Number(n))));
  if (!quads.length) return null;
  const page = Number(record.page || quads[0].page);
  if (!Number.isInteger(page) || page < 1) return null;
  if (record.kind === "area") return pdfRegionRefMarkdown(page, quads[0].rect, record.pdfId);
  const onPage = quads.filter((quad) => !quad.page || Number(quad.page) === page);
  const boxes = (onPage.length ? onPage : quads).map((quad) => quad.rect.map(Number));
  const round = (n) => Math.round(n * 100) / 100;
  const rect = [
    Math.min(...boxes.map((r) => Math.min(r[0], r[2]))) - LOCATION_PAD,
    Math.min(...boxes.map((r) => Math.min(r[1], r[3]))) - LOCATION_PAD,
    Math.max(...boxes.map((r) => Math.max(r[0], r[2]))) + LOCATION_PAD,
    Math.max(...boxes.map((r) => Math.max(r[1], r[3]))) + LOCATION_PAD
  ].map(round);
  return pdfRegionRefMarkdown(page, rect, record.pdfId);
}

export function parsePdfRef(src) {
  const value = String(src || "");
  if (!value.startsWith(PDFREF_SCHEME)) return null;
  const body = value.slice(PDFREF_SCHEME.length);
  const sep = body.indexOf(":");
  if (sep === -1) return null;
  const page = Number(body.slice(0, sep));
  const rest = body.slice(sep + 1);
  const parts = rest.split(":");
  const rectPart = parts[0];
  const pdfId = parts[1] || null;
  const widthNum = parts[2] ? Number(parts[2]) : null;
  // A malformed width doesn't invalidate the ref — it just falls back to the
  // default render width, the same as a ref written before widths existed.
  const width = Number.isFinite(widthNum) && widthNum > 0 ? widthNum : null;
  const rect = rectPart.split(",").map(Number);
  if (!Number.isInteger(page) || page < 1) return null;
  if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) return null;
  return { page, rect, pdfId, width };
}

// ── One open PDF per deck, independent of the Document surface's own
//    `openPdf` ──────────────────────────────────────────────────────────────
//
// A deck can have many region-embedded cards pointing at the same PDF, shown
// one after another in Study or listed together in All Cards — each asking
// for this again would reopen and re-parse the same file every time. Cached
// for the session, keyed by the deck AND which of its PDFs (a deck can have
// several now — see pdf-multi.js) — deliberately NOT the Document surface's
// own document object, so switching tabs/decks there can't tear an embed down
// out from under a card that's still showing it, and vice versa.
const embedDocs = new Map();

function openEmbedDoc(storeKey, pdfMeta) {
  const key = storeKey || "";
  const cached = embedDocs.get(key);
  if (cached) return cached;
  const promise = (async () => {
    if (!(await ensurePdfJs())) return null;
    const blob = await getDocument(storeKey, pdfMeta);
    if (!blob) return null;
    // A copy of the bytes: pdf.js transfers the buffer it's given to its
    // worker, which detaches it, and the blob in the store must survive —
    // same reasoning as the Document surface's own open (pdf-view.js).
    const data = new Uint8Array(await blob.arrayBuffer());
    return window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  })().catch((error) => {
    console.warn("Could not open the PDF for a region embed", error);
    return null;
  }).then((doc) => {
    // A failure (offline, not yet on this device) is never cached — the next
    // embed asked for gets a fresh attempt, in case connectivity returns
    // later in the same session. Only a real, open document is worth
    // remembering, which is the whole point of caching (see above).
    if (!doc) embedDocs.delete(key);
    return doc;
  });
  embedDocs.set(key, promise);
  return promise;
}

// ── A still picture of a highlight's box ────────────────────────────────────
//
// The Highlights pane, the outline drawer, the page notes and the exports all
// list a region (or an ink mark) — a mark with no words in it — and for every
// one of them the only thing worth showing is what the box actually holds.
// This is that picture, as a data URL a plain <img> can carry, rendered from
// the record's OWN paper (its pdfId, or the notebook for a notebook record)
// through openEmbedDoc above — so it does not care whether the Document view
// has that paper open, or is open at all.
//
// Rendered on demand and never stored: a data URL on the record would ride in
// meta, a JSONB column that syncs to every device on every save, and the bytes
// it would be made from are already on the device. Memoised for the session
// instead, keyed by the record's edit stamp as well as its id — an ink mark is
// the same record growing stroke by stroke, and a memo on the id alone would
// show its first stroke for the rest of the session.
export const REGION_IMAGE_WIDTH = 260;

const regionImages = new Map();

// The finished pictures by the same key, for a caller that has to build its
// markup synchronously (the exports) after awaiting preloadRegionImages.
const regionImageUrls = new Map();

function regionImageKey(record, width) {
  const source = regionSource(record);
  const page = record.quads?.[0]?.page || record.page;
  // The page's annotations are in the picture too (pdf-region-marks.js), so a
  // highlight or block added on that page has to make it a different picture.
  return `${source.storeKey}:${source.pdfMeta?.sha256 || ""}:${record.id}:${record.at || 0}:${regionAnnotationStamp(source, page)}:${width}`;
}

export function cachedRegionImage(record, { width = REGION_IMAGE_WIDTH } = {}) {
  if (!record?.id) return null;
  return regionImageUrls.get(regionImageKey(record, width)) || null;
}

export function preloadRegionImages(records, { width = REGION_IMAGE_WIDTH } = {}) {
  return Promise.all((records || []).map((record) => renderRegionImage(record, { width })));
}

export function regionSource(record) {
  const slot = recordDocSlot(record);
  if (slot === DOC_SLOT_DOC) {
    const pdfId = recordPdfId(record);
    return { slot, pdfId, storeKey: pdfStoreKey(state.localDeckId, pdfId), pdfMeta: deckPdfById(state.meta, pdfId) };
  }
  return { slot, pdfId: null, storeKey: documentStoreKey(state.localDeckId, slot), pdfMeta: docSlotMeta(slot) };
}

// The box a record is pictured by: the rectangle the reader drew for a
// region, the bounds of its strokes (its first quad) for ink.
export function regionImageRect(record) {
  const rect = (record?.quads || [])[0]?.rect;
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const numbers = rect.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

export function renderRegionImage(record, { width = REGION_IMAGE_WIDTH } = {}) {
  const rect = regionImageRect(record);
  const pageNumber = Number(record?.quads?.[0]?.page || record?.page);
  if (!record?.id || !rect || !Number.isInteger(pageNumber) || pageNumber < 1) return Promise.resolve(null);
  const source = regionSource(record);
  const key = regionImageKey(record, width);
  const cached = regionImages.get(key);
  if (cached) return cached;
  const promise = paintRegionImage(record, rect, pageNumber, source, width).catch((error) => {
    console.warn("Could not render a picture of a PDF region", error);
    return null;
  }).then((url) => {
    // A failure (offline, the paper not on this device yet) is not kept, so
    // the next list drawn tries again — the same rule openEmbedDoc keeps.
    if (!url) regionImages.delete(key);
    else regionImageUrls.set(key, url);
    return url;
  });
  regionImages.set(key, promise);
  return promise;
}

async function paintRegionImage(record, rect, pageNumber, source, width) {
  const doc = await openEmbedDoc(source.storeKey, source.pdfMeta);
  if (!doc || pageNumber > doc.numPages) return null;
  const page = await doc.getPage(pageNumber);
  const quadWidth = Math.max(1, Math.abs(rect[2] - rect[0]));
  // Scaled so the CROP comes out at the width asked for, not the page — a
  // fixed page scale makes a figure in the corner of an A4 sheet a few pixels
  // across — and rendered at the screen's density so it stays sharp.
  const scale = clampScale(width / quadWidth, 0.05);
  const viewport = page.getViewport({ scale });
  const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(rect);
  const left = Math.min(vx0, vx1);
  const top = Math.min(vy0, vy1);
  const nativeWidth = Math.max(1, Math.round(Math.abs(vx1 - vx0)));
  const nativeHeight = Math.max(1, Math.round(Math.abs(vy1 - vy0)));
  const outputScale = canvasOutputScale(nativeWidth, nativeHeight);
  // Only the crop is rasterised, through an offset viewport — the same way
  // mountPdfRegionEmbed paints its own.
  const paintViewport = page.getViewport({
    scale: scale * outputScale,
    offsetX: -left * outputScale,
    offsetY: -top * outputScale
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(nativeWidth * outputScale);
  canvas.height = Math.ceil(nativeHeight * outputScale);
  const ctx = canvas.getContext("2d", { alpha: false });
  // White first: an `alpha: false` canvas starts black, and a page paints only
  // its own marks (the same reason renderPageForPrint does this).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: paintViewport }).promise;
  // Everything the reader put on the page inside the box, in the page's own
  // order (see pdf-region-marks.js) — less a region's own frame. An ink mark
  // stands in for its stored copy, which may be a stroke behind it, and is
  // never left out: the page under a margin note is blank paper, and without
  // the mark it would be pictured as an empty white box.
  paintRegionMarks(ctx, paintViewport, regionMarksOnPage(source, pageNumber, {
    excludeId: record.kind === "area" ? record.id : null,
    stand: record.kind === "ink" ? record : null
  }));
  const { rasters } = await rasteriseRegionBlocks(page, source, pageNumber, rect, scale * outputScale);
  drawRegionBlocks(ctx, paintViewport, rasters);
  return canvas.toDataURL("image/jpeg", 0.8);
}

// The picture, put in place of a label wherever a list shows a region or an
// ink mark. Synchronous for its caller: what goes in at once is a box already
// the picture's shape, so a list of forty does not jump as they arrive; the
// image replaces it when it is ready. The "Region · page N" words are the
// ANSWER only when there is no picture to be had (the paper offloaded and not
// on this device, or offline before it ever was) — never a loading state.
export function mountRegionPreview(container, record, { width = REGION_IMAGE_WIDTH, className = "" } = {}) {
  const isInk = record?.kind === "ink";
  const page = record?.page || record?.quads?.[0]?.page || "";
  const words = isInk ? `Ink · page ${page}` : `Region · page ${page}`;
  const box = document.createElement("span");
  box.className = `highlight-region-preview is-loading${className ? ` ${className}` : ""}`;
  box.style.maxWidth = `${width}px`;
  const rect = regionImageRect(record);
  if (rect) {
    const w = Math.max(1, Math.abs(rect[2] - rect[0]));
    const h = Math.max(1, Math.abs(rect[3] - rect[1]));
    box.style.aspectRatio = `${w} / ${h}`;
  }
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", isInk ? `Ink written on page ${page}` : `Region highlighted on page ${page}`);
  container.appendChild(box);
  const fallback = () => {
    box.classList.remove("is-loading");
    box.classList.add("is-fallback");
    box.style.aspectRatio = "";
    // The same glyphs the region-select and pen buttons wear.
    box.textContent = `${isInk ? "✎" : "▣"} ${words}`;
  };
  renderRegionImage(record, { width }).then((url) => {
    if (!url) return fallback();
    const img = document.createElement("img");
    img.className = "highlight-region-thumb";
    img.alt = box.getAttribute("aria-label");
    img.src = url;
    img.draggable = false;
    box.classList.remove("is-loading");
    box.removeAttribute("role");
    box.removeAttribute("aria-label");
    box.replaceChildren(img);
  }).catch(fallback);
  return box;
}

function buildWrapper(parsed, targetWidth) {
  const { rect } = parsed;
  const wrapper = document.createElement("div");
  wrapper.className = "pdf-region-embed is-loading";
  // A region nobody has resized is free to take the whole column on a phone
  // (styles/60-pdf-region-embed.css), the way a picture on a card face does —
  // 420px of a 360px screen was the "too small on mobile" report, since the old
  // fixed height and scale then clipped or shrank it further.
  if (!parsed.width) wrapper.classList.add("is-default-width");
  wrapper.dataset.pdfRef = pdfRegionRefMarkdown(parsed.page, rect, parsed.pdfId, parsed.width);
  wrapper.dataset.pdfPage = String(parsed.page);
  if (parsed.pdfId) wrapper.dataset.pdfId = parsed.pdfId;
  // An immediate aspect-ratio guess from the quad itself (scale-invariant —
  // PDF user-space points, not pixels) so the surrounding text doesn't jump
  // once the real render lands. The HEIGHT is never written: the box is as
  // wide as it is allowed to be (its own width, capped at the column by
  // max-width) and the ratio makes it exactly as tall as that width needs.
  const w = Math.abs(rect[2] - rect[0]) || 1;
  const h = Math.abs(rect[3] - rect[1]) || 1;
  wrapper.style.width = `${targetWidth}px`;
  wrapper.style.aspectRatio = `${w} / ${h}`;
  return wrapper;
}

// ── Fitting the render to whatever width the box actually got ──────────────
//
// The rendered page is a fixed-size group, scaled so the crop exactly fills the
// wrapper. That scale used to be worked out once from the width ASKED for, so
// whenever the box came out narrower — every phone, where max-width: 100% cuts
// 420px down to the column — the crop kept its desktop scale and height and was
// cut off at the right edge. It is now read off the box's real width, and read
// again whenever that width changes: a rotation, the contents drawer pushing
// the column, split view, a card face growing.
const regionLayouts = new WeakMap();

let regionResizeObserver = null;

export function layoutPdfRegionEmbed(wrapper) {
  const info = regionLayouts.get(wrapper);
  if (!info) return;
  const width = wrapper.clientWidth;
  if (!width) return; // not laid out (a hidden face) — the observer will call back
  const k = width / info.nativeWidth;
  info.pageGroup.style.transform = `scale(${k}) translate(${-info.left}px, ${-info.top}px)`;
}

function observeRegionLayout(wrapper, info) {
  regionLayouts.set(wrapper, info);
  wrapper.style.aspectRatio = `${info.nativeWidth} / ${info.nativeHeight}`;
  layoutPdfRegionEmbed(wrapper);
  if (typeof ResizeObserver !== "function") return;
  if (!regionResizeObserver) {
    regionResizeObserver = new ResizeObserver((entries) => {
      entries.forEach(({ target }) => {
        // Taken off the page by a re-render: nothing will show it again, and
        // an observer keeps what it observes alive.
        if (!target.isConnected) {
          regionResizeObserver.unobserve(target);
          return;
        }
        layoutPdfRegionEmbed(target);
      });
    });
  }
  regionResizeObserver.observe(wrapper);
}

// ── Where the region came from, and a closer look at it ────────────────────
//
// Two small buttons on every embed, in every place one is rendered — the notes,
// a card face in Study, an All Cards row, a quick note, a highlight's note:
//
//   "p. N ↗"  opens the PDF at this exact spot. The picture is a REFERENCE to a
//             place in a paper, and a reference you cannot follow back to its
//             source is half of one.
//   "Zoom"    the same full-screen pinch-and-pan view a picture's Zoom pill
//             opens (src/render/diagram-zoom.js), with the crop rendered afresh
//             at a resolution worth zooming into.
//
// The go-to is registered rather than imported: it has to close panels, change
// views and switch between a deck's PDFs, and every module that does those
// things reaches this one back through render/enhance.js — the same reason the
// resize module's notes surface is registered (setRegionResizeNotesSurface).
let goToRegion = null;

export function setPdfRegionGoToHandler(fn) {
  goToRegion = typeof fn === "function" ? fn : null;
}

let zoomObjectUrl = null;

// The pixel budget for a crop rendered to be looked at closely — the zoom, and
// a region saved as an image (pdf-region-download.js). Of the CROP alone,
// which is all that is rasterised (an offset viewport, as mountPdfRegionEmbed
// paints its own).
export const ZOOM_MAX_CROP_PIXELS = 12_000_000;

// The paper a record was drawn on, as the bytes the store keeps — for a region
// saved as a PDF, which copies the page itself rather than a picture of it.
export function regionDocumentBlob(record) {
  const source = regionSource(record);
  return getDocument(source.storeKey, source.pdfMeta);
}

// The pdf.js page a region sits on, opened through the same per-paper cache
// every embed uses. null when the paper is not on this device.
export async function regionPdfPage(source, pageNumber) {
  const doc = await openEmbedDoc(source.storeKey, source.pdfMeta);
  if (!doc || pageNumber > doc.numPages) return null;
  return doc.getPage(pageNumber);
}

// The largest scale at or under `wanted` that keeps a crop of `rect` inside
// ZOOM_MAX_CROP_PIXELS.
export function affordableCropScale(rect, wanted) {
  const quadWidth = Math.max(1, Math.abs(rect[2] - rect[0]));
  const quadHeight = Math.max(1, Math.abs(rect[3] - rect[1]));
  const affordable = Math.sqrt(ZOOM_MAX_CROP_PIXELS / (quadWidth * quadHeight));
  return Math.max(0.5, Math.min(wanted, affordable, PDF_MAX_SCALE * 3));
}

// Exactly the box, as a canvas, at `scale` CSS pixels per PDF point: the page,
// and everything the reader put on it inside the box (pdf-region-marks.js) —
// less the captured region's own frame, named by `excludeId` (a record) or
// `excludeRect` (a bare pdfref:). `failed` counts blocks that could not be
// drawn, for a caller that wants to say so.
export async function renderRegionCrop(page, rect, scale, source, { excludeId = null, excludeRect = null } = {}) {
  const viewport = page.getViewport({ scale });
  const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(rect);
  const left = Math.min(vx0, vx1);
  const top = Math.min(vy0, vy1);
  const cropViewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });
  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(Math.abs(vx1 - vx0)));
  crop.height = Math.max(1, Math.round(Math.abs(vy1 - vy0)));
  const ctx = crop.getContext("2d", { alpha: false });
  // White first: an `alpha: false` canvas starts black, and a page paints only
  // its own marks (the same reason paintRegionImage does this).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, crop.width, crop.height);
  await page.render({ canvasContext: ctx, viewport: cropViewport }).promise;
  paintRegionMarks(ctx, cropViewport, regionMarksOnPage(source, page.pageNumber, { excludeId, excludeRect }));
  const { rasters, failed } = await rasteriseRegionBlocks(page, source, page.pageNumber, rect, scale);
  drawRegionBlocks(ctx, cropViewport, rasters);
  crop.failedBlocks = failed;
  return crop;
}

async function openRegionZoom(parsed) {
  const pdfId = parsed.pdfId || PDF_PRIMARY_ID;
  const source = { slot: DOC_SLOT_DOC, pdfId, storeKey: pdfStoreKey(state.localDeckId, pdfId), pdfMeta: deckPdfById(state.meta, pdfId) };
  const page = await regionPdfPage(source, parsed.page);
  if (!page) return;
  const quadWidth = Math.max(1, Math.abs(parsed.rect[2] - parsed.rect[0]));
  // Wide enough to still be sharp a couple of pinches in on this screen.
  const wanted = (Math.max(window.innerWidth || 0, 800) * 2.5) / quadWidth;
  const crop = await renderRegionCrop(page, parsed.rect, affordableCropScale(parsed.rect, wanted), source, { excludeRect: parsed.rect });
  const blob = await new Promise((resolve) => crop.toBlob(resolve, "image/png"));
  if (!blob) return;
  if (zoomObjectUrl) URL.revokeObjectURL(zoomObjectUrl);
  zoomObjectUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.alt = `Region · page ${parsed.page}`;
  img.src = zoomObjectUrl;
  try { await img.decode(); } catch (_) { /* still shown; the modal re-centres on load */ }
  openDiagramModal(img);
  const shown = el.diagramModalBody?.querySelector("img");
  if (shown && !shown.complete) shown.addEventListener("load", () => centerDiagramContent(shown), { once: true });
}

function regionButton(label, title, onPress) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-region-embed-btn";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  // A card face and a note both listen for presses on what they contain (a
  // flip, a selection, a swipe); this press is only ever the button's.
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPress();
  });
  return button;
}

function attachRegionTools(wrapper, parsed, { zoom = true } = {}) {
  // Nothing to press on paper: an export or a print gets the picture alone.
  if (wrapper.closest("#printRoot, .print-root")) return;
  const tools = document.createElement("div");
  tools.className = "pdf-region-embed-tools";
  tools.appendChild(regionButton(`p. ${parsed.page} \u2197`, `Open page ${parsed.page} of the PDF at this spot`, () => {
    if (goToRegion) goToRegion({ page: parsed.page, rect: parsed.rect, pdfId: parsed.pdfId || null });
  }));
  if (zoom) {
    tools.appendChild(regionButton("Zoom", "Zoom into this region", () => {
      openRegionZoom(parsed).catch((error) => console.warn("Could not zoom into a PDF region", error));
    }));
  }
  wrapper.appendChild(tools);
}

function showFallback(wrapper, parsed) {
  const page = parsed?.page;
  wrapper.classList.remove("is-loading");
  wrapper.classList.add("is-fallback");
  wrapper.replaceChildren();
  const note = document.createElement("div");
  note.className = "pdf-region-embed-fallback";
  note.textContent = page ? `Region · page ${page}` : "Region";
  wrapper.appendChild(note);
  // Nothing to zoom into, but the page is still somewhere the PDF can be
  // opened at — once it is on this device, the Document tab says so itself.
  if (parsed) attachRegionTools(wrapper, parsed, { zoom: false });
}

// Replaces `img` in place with a live-rendered crop of the PDF location it
// points at. Fire-and-forget: called from enhanceRenderedMarkdown for every
// `img[src^="pdfref:"]` a render pass finds. `resizable` is true only on the
// interactive card surfaces enhanceRenderedMarkdown allows it for (Study,
// All Cards) — see the allow-list there — and adds a drag-corner handle that
// persists a new width back into the card via pdf-region-resize.js.
export async function mountPdfRegionEmbed(img, { resizable = false } = {}) {
  const parsed = parsePdfRef(img.getAttribute("src"));
  if (!parsed) return;
  const targetWidth = parsed.width || EMBED_TARGET_WIDTH;
  const wrapper = buildWrapper(parsed, targetWidth);
  img.replaceWith(wrapper);

  try {
    const pdfId = parsed.pdfId || PDF_PRIMARY_ID;
    const pdfMeta = deckPdfById(state.meta, pdfId);
    const storeKey = pdfStoreKey(state.localDeckId, pdfId);
    const doc = await openEmbedDoc(storeKey, pdfMeta);
    if (!doc || parsed.page > doc.numPages) return showFallback(wrapper, parsed);
    const page = await doc.getPage(parsed.page);
    const [x0, y0, x1, y1] = parsed.rect;
    const quadWidth = Math.max(1, Math.abs(x1 - x0));
    // Rendered for whichever is wider: the width asked for, or the width the
    // box actually has on this screen (a phone's default fills the column, and
    // that can be more than the 420px default) — crisp either way, right up to
    // clampScale's PDF_MAX_SCALE ceiling. Anything past that is made up by
    // layoutPdfRegionEmbed scaling the rendered group, below.
    const renderWidth = Math.max(targetWidth, wrapper.clientWidth || 0);
    const scale = clampScale(renderWidth / quadWidth);
    const viewport = page.getViewport({ scale });
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(parsed.rect);
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    // The crop's NATIVE rendered size in CSS pixels. What is shown is this,
    // scaled to the box's real width (layoutPdfRegionEmbed).
    const nativeWidth = Math.max(1, Math.round(Math.abs(vx1 - vx0)));
    const nativeHeight = Math.max(1, Math.round(Math.abs(vy1 - vy0)));

    // ── Only the crop is rasterised, at the screen's pixel density ────────
    //
    // This used to paint the WHOLE page at the crop's scale and let the
    // wrapper clip it — for a small figure that is a page several thousand
    // pixels across to show a few hundred, and it had to be painted at 1x to
    // stay affordable, which is what made a figure's small print a blur on a
    // phone. pdf.js can render any window of a page through an offset viewport,
    // so the canvas is now exactly the crop, at canvasOutputScale's density
    // (the same cap the Document surface paints its own pages with), placed at
    // the crop's corner inside the full-size page group so the text layer over
    // it still lines up with the CSS-pixel viewport it was built from.
    const outputScale = canvasOutputScale(nativeWidth, nativeHeight);
    const paintViewport = page.getViewport({
      scale: scale * outputScale,
      offsetX: -left * outputScale,
      offsetY: -top * outputScale
    });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas pdf-region-embed-canvas";
    canvas.width = Math.ceil(nativeWidth * outputScale);
    canvas.height = Math.ceil(nativeHeight * outputScale);
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${nativeWidth}px`;
    canvas.style.height = `${nativeHeight}px`;
    // willReadFrequently keeps the bitmap off the GPU, so a lost GPU context
    // cannot clear it to black — see createPageCanvas in pdf-view.js.
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: paintViewport }).promise;
    // What the reader put on the page inside the box — highlights and ink —
    // composited onto the same canvas the PDF itself just rendered to, less the
    // frame of the region this embed was made from (see pdf-region-marks.js).
    const source = { slot: DOC_SLOT_DOC, pdfId, storeKey, pdfMeta };
    paintRegionMarks(ctx, paintViewport, regionMarksOnPage(source, parsed.page, { excludeRect: parsed.rect }));

    // Real, positioned, selectable text — the exact function the Document
    // surface itself renders every page's text layer with. Nothing here is
    // re-measured or re-derived: the whole page's spans are correct as they
    // are, and clipping a correctly-positioned thing to a window is free.
    const { layer: textLayer } = await buildTextLayer(page, viewport);

    const pageGroup = document.createElement("div");
    pageGroup.className = "pdf-region-embed-page";
    pageGroup.style.width = `${viewport.width}px`;
    pageGroup.style.height = `${viewport.height}px`;
    pageGroup.append(canvas, textLayer);

    wrapper.classList.remove("is-loading");
    wrapper.style.width = `${Math.round(targetWidth)}px`;
    wrapper.replaceChildren(pageGroup);
    const renderInfo = { pageGroup, nativeWidth, nativeHeight, left, top };
    observeRegionLayout(wrapper, renderInfo);
    attachRegionTools(wrapper, parsed);
    // The typed and picture blocks inside the box, as live DOM over the page
    // like the text layer — after the picture is up, so a block with mathematics
    // in it never holds the figure back.
    mountRegionBlockLayer(pageGroup, viewport, source, parsed.page, parsed.rect)
      .catch((error) => console.warn("Could not show the blocks inside a PDF region", error));

    if (resizable) {
      attachRegionResizeHandle(wrapper, pageGroup, parsed, renderInfo);
    }
  } catch (error) {
    console.warn("Could not render a PDF region embed", error);
    showFallback(wrapper, parsed);
  }
}
