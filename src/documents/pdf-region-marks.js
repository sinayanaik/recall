// What the reader put on a page, inside a region — for every picture of one.
//
// A region (a box dragged round a figure, see pdf-region.js) is pictured in a
// lot of places away from the page: an embed in the notes or on a card, the
// zoom, the Highlights pane and the other lists, and the image and PDF a region
// is saved as (pdf-region-download.js). Each of those shows what the page shows
// inside the box, drawn in the page's own order —
//
//   the paper        page.render(), which also draws the file's OWN annotations
//                    (a Zotero highlight, a Preview comment) from their
//                    appearance streams, exactly as the live page does
//   highlights       .pdf-mark-layer — a multiplied tint over words, and the
//                    outline-and-wash of any OTHER region
//   ink              .pdf-ink-layer, z-index 2
//   blocks           .pdf-block-layer, z-index 4 — typed text and pictures
//
// — with ONE thing left out: the captured region's own frame. The box is what
// was picked up; drawing its outline round its own picture is a coloured border
// on every copy of the figure, which is what "I don't want them displayed with
// the colour overlay of the highlight" was about. Everything else the reader
// marked inside it stays, because that is the reader's work on the figure.
//
// (The note badges at z-index 3 are app chrome — numbers you press to open a
// note — and are not drawn.)
//
// Records are read for the region's OWN paper (its slot and pdfId), never the
// surface that happens to be open, so a card made from the second PDF of a deck
// shows that paper's marks while the reader has the first one open.

import { state } from "../core/state.js?v=__BUILD__";
import { ensureHtmlToImage } from "../core/lib-loader.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { markGeometry, markStyleOf, normalizeMarkHex, paintMarkGeometry } from "../format/mark-styles.js?v=__BUILD__";
import { paintInkLayers } from "../render/ink-paint.js?v=__BUILD__";
import { paperKeyBg, paperKeyParts, paperRecolor } from "../format/paper-tones.js?v=__BUILD__";
import { normalizeShape, paintShapeOnCanvas, paintShapeTextOnCanvas, shapeTextNeedsRendering, shapeTextRect } from "../render/annot-shapes.js?v=__BUILD__";
import { recordsForSurface } from "./pdf-multi.js?v=__BUILD__";

// ── The colours, matching the live mark layer ───────────────────────────────
//
// styles/36-document.css and 37-document-chrome.css draw a text highlight as a
// multiplied tint at these strengths and a region as an outline with a faint
// wash. Repeated here as numbers because a canvas and a PDF content stream have
// no stylesheet to ask.
export const HIGHLIGHT_FILL_ALPHA = { yellow: 0.35, green: 0.33, blue: 0.32, pink: 0.3 };

export const AREA_FILL_ALPHA = 0.12;

// A tint in a colour of the reader's own (a text record's `hex`), at the
// strength the four sit at on average.
export const CUSTOM_HIGHLIGHT_ALPHA = 0.33;

export function highlightHex(color) {
  return MARK_HIGHLIGHT_HEX[color] || MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT];
}

export function highlightAlpha(color) {
  return HIGHLIGHT_FILL_ALPHA[color] ?? 0.35;
}

function hexWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A bare `pdfref:` (an embed pasted into the notes) carries a page and a box
// but no record id, so the region it was made from is found by its box: an
// area record on that page whose rectangle is this one, to within half a point
// of rounding.
const SAME_RECT_TOLERANCE = 0.5;

function sameRect(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
    && a.every((n, i) => Math.abs(Number(n) - Number(b[i])) <= SAME_RECT_TOLERANCE);
}

// The highlights and ink on one page of one paper, minus the captured region.
// `stand` is a record that stands in for its stored copy — an ink mark being
// pictured while it is still growing is a stroke ahead of meta.
export function regionMarksOnPage(source, pageNumber, { excludeId = null, excludeRect = null, stand = null } = {}) {
  const page = Number(pageNumber);
  const onPage = recordsForSurface(state.meta?.pdfHighlights, source.slot, source.pdfId).filter((record) => record
    && record.id !== stand?.id
    && (Number(record.page) === page || (record.quads || []).some((quad) => Number(quad?.page) === page)));
  if (stand && Number(stand.page || stand.quads?.[0]?.page) === page) onPage.push(stand);
  const kept = onPage.filter((record) => {
    if (excludeId && record.id === excludeId) return false;
    if (excludeRect && record.kind === "area" && sameRect(record.quads?.[0]?.rect, excludeRect)) return false;
    return true;
  });
  return {
    page,
    highlights: kept.filter((record) => record.kind !== "ink" && record.kind !== "shape"),
    ink: kept.filter((record) => record.kind === "ink" && Number(record.page) === page),
    shapes: kept.filter((record) => record.kind === "shape" && Number(record.page) === page)
  };
}

// Onto a canvas whose drawing space is `viewport` (an offset viewport for a
// crop is fine — every coordinate goes through it).
//
// `paper` is the page the marks go onto: on a dark page (the paper inverted, as
// dark page shows it) a tint is SCREENED rather than multiplied, and the pen
// takes its dark set — the live page's own rules (styles/36-document.css,
// styles/72-ink-paper.css). `areas: false` leaves regions out: a page's kept
// picture (src/documents/pdf-pictures.js) carries the reader's highlights and
// ink, while the regions stay live on the page, where they are pressed.
//
// On a RECORDING context (src/render/canvas-record.js, which has beginLayer) the
// text tints go down as one group, blended once — the way the page's mark layer
// is blended on screen, so two overlapping highlights read as one there and
// here. On a real context each is blended as it is drawn, as it always was.
//
// `skipTextIds` names shapes whose WORDS the caller draws itself, over the
// shape, from rendered markdown (rasteriseRegionBlocks below, or a static DOM
// copy in an embed) — their box, fill and leader are still drawn here; only the
// canvas's plain-text copy of the words is left out, so the two never overlap.
//
// `paper` may also be a paper KEY (src/format/paper-tones.js) — "dark~26282d"
// — for a page shown on a tinted tone: the polarity decides the blend and the
// pen set, and the paper's colour is what a reader's own colours (a custom pen,
// a shape) are kept readable against.
export function paintRegionMarks(ctx, viewport, marks, { paper = "light", areas = true, skipTextIds = null } = {}) {
  const dark = paperKeyParts(paper).dark;
  const paperBg = paperKeyBg(paper);
  const recolor = paperRecolor(paperBg);
  const blend = dark ? "screen" : "multiply";
  const grouped = typeof ctx.beginLayer === "function";
  const quadsOf = (record, paint) => {
    (record.quads || []).forEach((quad) => {
      if (Number(quad?.page) !== marks.page || !Array.isArray(quad.rect)) return;
      const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(quad.rect.map(Number));
      paint(Math.min(vx0, vx1), Math.min(vy0, vy1), Math.abs(vx1 - vx0), Math.abs(vy1 - vy0));
    });
  };
  const paintArea = (record) => {
    const hex = highlightHex(record.color);
    quadsOf(record, (left, top, width, height) => {
      ctx.save();
      // Outlined with a faint wash rather than tinted — a filled multiply over
      // a photograph would wash out the figure, the same reason the live page
      // draws a region this way.
      const line = Math.max(1, viewport.scale * 1.5);
      ctx.fillStyle = hexWithAlpha(hex, AREA_FILL_ALPHA);
      ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = hex;
      ctx.lineWidth = line;
      ctx.strokeRect(left + line / 2, top + line / 2, Math.max(0, width - line), Math.max(0, height - line));
      ctx.restore();
    });
  };
  const paintTint = (record, composite) => {
    const custom = normalizeMarkHex(record.hex);
    const hex = custom || highlightHex(record.color);
    const fill = hexWithAlpha(hex, custom ? CUSTOM_HIGHLIGHT_ALPHA : highlightAlpha(record.color));
    const style = markStyleOf(record);
    const minLine = Math.max(1, viewport.scale * 0.75);
    quadsOf(record, (left, top, width, height) => {
      ctx.save();
      // Multiply (screen on a dark page), so the words stay readable through
      // the tint — and through a line, which is laid down the same way so a
      // stroke through a word does not hide the word's own ink.
      if (composite) ctx.globalCompositeOperation = composite;
      paintMarkGeometry(ctx, markGeometry(style, left, top, width, height, minLine), hex, fill);
      ctx.restore();
    });
  };
  if (grouped) {
    const tints = marks.highlights.filter((record) => record.kind !== "area");
    if (tints.length) {
      ctx.beginLayer();
      tints.forEach((record) => paintTint(record, null));
      ctx.endLayer(blend);
    }
    if (areas) marks.highlights.filter((record) => record.kind === "area").forEach(paintArea);
  } else {
    marks.highlights.forEach((record) => {
      if (record.kind === "area") {
        if (areas) paintArea(record);
      } else paintTint(record, blend);
    });
  }
  // Shapes over the ink, as the page stacks them — but not on a page's kept
  // picture, whose caller leaves them live (they are pressed, like regions).
  const paintShapes = () => {
    if (!areas || !marks.shapes?.length) return;
    marks.shapes.forEach((record) => paintShapeOnCanvas(ctx, record.shape, ([x, y]) => viewport.convertToViewportPoint(x, y), viewport.scale, {
      skipText: Boolean(skipTextIds?.has?.(record.id)),
      recolor
    }));
  };
  if (!marks.ink.length) { paintShapes(); return; }
  // Strokes are stored in PDF user-space points; paintInkLayers expects the
  // context to carry that transform, as the live ink layer applies it.
  const t = viewport.transform;
  ctx.save();
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  // Every mark's strokes in one call, so every highlighter band on the page goes
  // down — multiplied — before any of the pen's ink, which is the order the
  // screen's two layers stack in. On white paper: this is a picture of the PDF.
  const strokes = [];
  marks.ink.forEach((record) => strokes.push(...decodeInkStrokes(record.ink?.s)));
  paintInkLayers(ctx, strokes, { root: null, paper: dark ? "dark" : "light", paperBg, blend });
  ctx.restore();
  paintShapes();
}

// ── Blocks ──────────────────────────────────────────────────────────────────
//
// Registered rather than imported: pdf-blocks.js renders a block through
// render/enhance.js, which reaches pdf-region-embed.js (and so this module)
// back — the same cycle setPdfRegionGoToHandler exists to avoid. src/main.js
// hands over { blocksForPaper, buildStaticBlock, buildStaticShapeText } — the
// last from src/documents/pdf-shape-markdown.js, for the typed words of a text
// box or a callout, which are markdown and are pictured the way a block is.
let blockSource = null;

export function setRegionBlockSource(source) {
  blockSource = source && typeof source.blocksForPaper === "function" && typeof source.buildStaticBlock === "function"
    ? source
    : null;
}

// ── Typed text that is markdown ─────────────────────────────────────────────
//
// A text box's or a callout's words are markdown (src/documents/
// pdf-shape-markdown.js). A canvas can only draw them as plain text, so where
// the words actually need the renderer (shapeTextNeedsRendering) they are
// pictured like a block — built as a static node and rasterised — and laid OVER
// the shape's own box and fill, which the canvas still draws. Plain words stay
// on the canvas exactly as before, at no cost.
//
// Each returns { record, rect } with `rect` the text box in PDF points.
export function regionRichShapeTexts(source, pageNumber, rect = null) {
  if (typeof blockSource?.buildStaticShapeText !== "function") return [];
  const page = Number(pageNumber);
  const box = rect ? [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])] : null;
  return recordsForSurface(state.meta?.pdfHighlights, source.slot, source.pdfId)
    .filter((record) => record?.kind === "shape" && Number(record.page) === page)
    .map((record) => ({ record, shape: normalizeShape(record.shape) }))
    .filter(({ shape }) => shape && (shape.type === "text" || shape.type === "callout") && shapeTextNeedsRendering(shape.text))
    .map(({ record, shape }) => ({ record, rect: shapeTextRect(shape) }))
    .filter(({ rect: r }) => !box || (r[0] < box[2] && r[2] > box[0] && r[1] < box[3] && r[3] > box[1]));
}

// The ids of the shapes a set of rasters drew the words of — what
// paintRegionMarks is told to leave the words of alone.
export function shapeTextRasterIds(rasters) {
  return new Set((rasters || []).filter((raster) => raster.kind === "shape-text").map((raster) => raster.block.id));
}

// A text box as a pseudo-block: the rectangle drawRegionBlocks and the region
// PDF's drawBlocks place a raster into, by the same blockPdfRect as a block.
// A turned box carries its turn: the raster is made upright, and turned about
// the middle of its rectangle where it is drawn (drawRegionBlocks, and the
// region PDF's drawBlocks).
function shapeTextBlock({ record, rect }) {
  const rot = normalizeShape(record.shape)?.rot || 0;
  return { id: record.id, x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1], z: Infinity, ...(rot ? { rot } : {}) };
}

// The words drawn as PLAIN text onto a canvas of their own — the fallback when
// the rendered picture could not be made (no html-to-image, a tainted canvas),
// so a failure costs the formatting and never the words.
function plainShapeTextRaster(item, pixelRatio) {
  const [x0, , x1, y1] = item.rect;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil((x1 - x0) * pixelRatio));
  canvas.height = Math.max(1, Math.ceil((item.rect[3] - item.rect[1]) * pixelRatio));
  const ctx = canvas.getContext("2d");
  paintShapeTextOnCanvas(ctx, item.record.shape, ([x, y]) => [(x - x0) * pixelRatio, (y1 - y) * pixelRatio], pixelRatio, { ignoreRotation: true });
  return { block: shapeTextBlock(item), canvas, kind: "shape-text", plain: true };
}

// The blocks on that page whose box overlaps the region, bottom first.
export function regionBlocksInBox(source, pageNumber, rect) {
  if (!blockSource) return [];
  const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  return blockSource.blocksForPaper(source.slot, source.pdfId, pageNumber)
    .filter((block) => block.x < rx1 && block.x + block.w > rx0 && block.y < ry1 && block.y + block.h > ry0)
    .sort((a, b) => (a.z || 0) - (b.z || 0));
}

export function blockPdfRect(block) {
  return [block.x, block.y, block.x + block.w, block.y + block.h];
}

// A cheap fingerprint of everything that could change a picture of this page
// besides the paper itself: how many marks and blocks it has and when the last
// of them changed. Part of a memoised picture's key, so a highlight added on
// the page is in the Highlights pane's picture the next time it is drawn.
export function regionAnnotationStamp(source, pageNumber) {
  const page = Number(pageNumber);
  const marks = recordsForSurface(state.meta?.pdfHighlights, source.slot, source.pdfId)
    .filter((record) => Number(record?.page) === page);
  const blocks = blockSource ? blockSource.blocksForPaper(source.slot, source.pdfId, page) : [];
  const latest = Math.max(0, ...marks.map((record) => Number(record.at) || 0), ...blocks.map((block) => Number(block.at) || 0));
  return `${marks.length}.${blocks.length}.${latest}`;
}

// The blocks as live DOM inside an embed's page group — crisp at any width
// and in the theme's own colours, like the text layer beside them. `viewport`
// is the CSS-pixel viewport the page group is laid out in.
export async function mountRegionBlockLayer(pageGroup, viewport, source, pageNumber, rect) {
  // A block can hold a pdfref: of its own — even one of the very region it
  // sits in — and that embed would mount this block again, inside itself, for
  // ever. One level: an embed already inside a pictured block shows the paper
  // and its marks, not the blocks.
  if (pageGroup.closest(".pdf-block.is-static, .pdf-region-embed-blocks")) return null;
  const blocks = regionBlocksInBox(source, pageNumber, rect);
  const texts = regionRichShapeTexts(source, pageNumber, rect);
  if (!blocks.length && !texts.length) return null;
  const nodes = await Promise.all([
    ...blocks.map((block) => blockSource.buildStaticBlock(block, viewport).catch((error) => {
      console.warn("Could not show a block inside a region", error);
      return null;
    })),
    // Over the blocks, as the shape layer's words are over nothing but ink.
    ...texts.map(({ record }) => blockSource.buildStaticShapeText(record, viewport).catch((error) => {
      console.warn("Could not show a text box's words inside a region", error);
      return null;
    }))
  ]);
  const layer = document.createElement("div");
  layer.className = "pdf-block-layer pdf-region-embed-blocks";
  nodes.forEach((node) => { if (node) layer.appendChild(node); });
  if (!layer.childElementCount) return null;
  pageGroup.appendChild(layer);
  return layer;
}

// ── Blocks as pixels ────────────────────────────────────────────────────────
//
// A canvas (the zoom, a list picture, a saved image) and a PDF page have no DOM
// to put a block in, so each block is turned into pixels: built as a static
// node at scale 1 (one CSS pixel per PDF point, see placeBlock), attached
// off-screen so its fonts and computed styles are real, and rasterised by
// html-to-image at `pixelRatio`. Only loaded when a page actually has a block
// inside the box. A block that cannot be drawn (a picture whose host refuses a
// cross-origin read) is skipped and counted; the rest still are.
//
// `paper: "light"` draws them in paper colours whatever the app's theme — for a
// page that is printed white (src/documents/pdf-export.js). The host then wears
// `print-tokens`, which rebinds the theme's tokens and the block fills to the
// print palette (styles/82-export-themes.css). Otherwise a block is drawn as
// the reader sees it, which is what the zoom and the pane's pictures want.
//
// The typed words of a text box or a callout that are markdown come back here
// too, as rasters with `kind: "shape-text"` placed by the same rectangle rule
// (see regionRichShapeTexts) — after the blocks, so they are drawn on top. A
// caller hands shapeTextRasterIds(rasters) to paintRegionMarks so the canvas
// does not also print the words plain. One that cannot be rendered comes back
// as a plain-text raster rather than as nothing.
export async function rasteriseRegionBlocks(page, source, pageNumber, rect, pixelRatio, { paper = "theme" } = {}) {
  const blocks = regionBlocksInBox(source, pageNumber, rect);
  const texts = regionRichShapeTexts(source, pageNumber, rect);
  if (!blocks.length && !texts.length) return { rasters: [], failed: 0 };
  if (!(await ensureHtmlToImage())) {
    return { rasters: texts.map((item) => plainShapeTextRaster(item, pixelRatio)), failed: blocks.length };
  }
  const viewport = page.getViewport({ scale: 1 });
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(viewport.width)}px;height:${Math.ceil(viewport.height)}px;pointer-events:none;`;
  if (paper === "light") host.className = "print-tokens";
  else {
    // As the reader sees it: a block on the page takes its colours from the
    // paper it is on (styles/94-paper-tones.css), not from the theme, so the
    // copy drawn here is told the same paper.
    const stage = document.getElementById("documentStage");
    const dark = Boolean(stage?.classList.contains("is-pdf-inverted"));
    host.className = dark ? "paper-tokens is-dark-paper" : "paper-tokens";
    host.style.setProperty("--paper-bg", stage?.dataset.paperBg || (dark ? "#030303" : "#ffffff"));
    host.style.setProperty("--paper-text", dark ? "#e8eaed" : "#16181d");
  }
  document.body.appendChild(host);
  const rasters = [];
  let failed = 0;
  let fontEmbedCSS;
  try {
    for (const block of blocks) {
      // Sequential: each is a full clone-and-serialise of a subtree, and a page
      // of them at once is a spike nobody asked for.
      // eslint-disable-next-line no-await-in-loop
      const node = await blockSource.buildStaticBlock(block, viewport).catch(() => null);
      if (!node) { failed += 1; continue; }
      // Drawn at its own origin: html-to-image clones the node with its
      // computed position, so one left where it sits on the page is drawn that
      // far outside its own canvas. This node is ours and off-screen anyway.
      node.style.left = "0px";
      node.style.top = "0px";
      host.appendChild(node);
      const width = parseFloat(node.style.width) || 1;
      const height = parseFloat(node.style.height) || 1;
      try {
        // The fonts are worked out once and handed to every block after.
        // eslint-disable-next-line no-await-in-loop
        if (fontEmbedCSS === undefined) fontEmbedCSS = await window.htmlToImage.getFontEmbedCSS(node).catch(() => "");
        // eslint-disable-next-line no-await-in-loop
        const canvas = await window.htmlToImage.toCanvas(node, {
          pixelRatio,
          width,
          height,
          fontEmbedCSS,
          // A picture that will not load must not cost the block its words.
          imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
        });
        // A browser that treats a foreignObject drawing as cross-origin hands
        // back a tainted canvas, and one tainted block would make the whole
        // picture it is drawn into unreadable — no saved image, no zoom. Asked
        // here, per block, so that costs only this block.
        canvas.getContext("2d").getImageData(0, 0, 1, 1);
        rasters.push({ block, canvas });
      } catch (error) {
        console.warn("Could not draw a block inside a region", error);
        failed += 1;
      }
      node.remove();
    }
    for (const item of texts) {
      // eslint-disable-next-line no-await-in-loop
      const node = await blockSource.buildStaticShapeText(item.record, viewport).catch((error) => {
        console.warn("Could not render a text box's words for a picture", error);
        return null;
      });
      if (!node) { rasters.push(plainShapeTextRaster(item, pixelRatio)); continue; }
      node.style.left = "0px";
      node.style.top = "0px";
      // Pictured upright; turned where the picture is drawn.
      node.style.transform = "";
      host.appendChild(node);
      const block = shapeTextBlock(item);
      try {
        // eslint-disable-next-line no-await-in-loop
        if (fontEmbedCSS === undefined) fontEmbedCSS = await window.htmlToImage.getFontEmbedCSS(node).catch(() => "");
        // eslint-disable-next-line no-await-in-loop
        const canvas = await window.htmlToImage.toCanvas(node, {
          pixelRatio,
          width: Math.max(1, block.w),
          height: Math.max(1, block.h),
          fontEmbedCSS,
          imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
        });
        canvas.getContext("2d").getImageData(0, 0, 1, 1);
        rasters.push({ block, canvas, kind: "shape-text" });
      } catch (error) {
        console.warn("Could not picture a text box's words; drawing them plain", error);
        rasters.push(plainShapeTextRaster(item, pixelRatio));
      }
      node.remove();
    }
  } finally {
    host.remove();
  }
  return { rasters, failed };
}

// The rasterised blocks onto a canvas whose drawing space is `viewport`.
// `only` draws one kind — "block" or "shape-text" — for a caller that has to
// put something between the two (the page export draws the marks there).
export function drawRegionBlocks(ctx, viewport, rasters, { only = null } = {}) {
  rasters.forEach(({ block, canvas, kind = "block" }) => {
    if (only && kind !== only) return;
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(blockPdfRect(block));
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    const width = Math.abs(vx1 - vx0);
    const height = Math.abs(vy1 - vy0);
    if (!block.rot) { ctx.drawImage(canvas, left, top, width, height); return; }
    // Counter-clockwise on the page is a negative turn on a canvas (y DOWN).
    ctx.save();
    ctx.translate(left + width / 2, top + height / 2);
    ctx.rotate((-block.rot * Math.PI) / 180);
    ctx.drawImage(canvas, -width / 2, -height / 2, width, height);
    ctx.restore();
  });
}
