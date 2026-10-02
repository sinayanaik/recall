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
import { paintInkStrokes } from "../render/ink-paint.js?v=__BUILD__";
import { recordsForSurface } from "./pdf-multi.js?v=__BUILD__";

// ── The colours, matching the live mark layer ───────────────────────────────
//
// styles/36-document.css and 37-document-chrome.css draw a text highlight as a
// multiplied tint at these strengths and a region as an outline with a faint
// wash. Repeated here as numbers because a canvas and a PDF content stream have
// no stylesheet to ask.
export const HIGHLIGHT_FILL_ALPHA = { yellow: 0.35, green: 0.33, blue: 0.32, pink: 0.3 };

export const AREA_FILL_ALPHA = 0.12;

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
    highlights: kept.filter((record) => record.kind !== "ink"),
    ink: kept.filter((record) => record.kind === "ink" && Number(record.page) === page)
  };
}

// Onto a canvas whose drawing space is `viewport` (an offset viewport for a
// crop is fine — every coordinate goes through it).
export function paintRegionMarks(ctx, viewport, marks) {
  marks.highlights.forEach((record) => {
    const hex = highlightHex(record.color);
    (record.quads || []).forEach((quad) => {
      if (Number(quad?.page) !== marks.page || !Array.isArray(quad.rect)) return;
      const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(quad.rect.map(Number));
      const left = Math.min(vx0, vx1);
      const top = Math.min(vy0, vy1);
      const width = Math.abs(vx1 - vx0);
      const height = Math.abs(vy1 - vy0);
      ctx.save();
      if (record.kind === "area") {
        // Outlined with a faint wash rather than tinted — a filled multiply
        // over a photograph would wash out the figure, the same reason the
        // live page draws a region this way.
        const line = Math.max(1, viewport.scale * 1.5);
        ctx.fillStyle = hexWithAlpha(hex, AREA_FILL_ALPHA);
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = hex;
        ctx.lineWidth = line;
        ctx.strokeRect(left + line / 2, top + line / 2, Math.max(0, width - line), Math.max(0, height - line));
      } else {
        // Multiply, so the words stay readable through the tint.
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = hexWithAlpha(hex, highlightAlpha(record.color));
        ctx.fillRect(left, top, width, height);
      }
      ctx.restore();
    });
  });
  if (!marks.ink.length) return;
  // Strokes are stored in PDF user-space points; paintInkStrokes expects the
  // context to carry that transform, as the live ink layer applies it.
  const t = viewport.transform;
  ctx.save();
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  marks.ink.forEach((record) => paintInkStrokes(ctx, decodeInkStrokes(record.ink?.s), { root: null }));
  ctx.restore();
}

// ── Blocks ──────────────────────────────────────────────────────────────────
//
// Registered rather than imported: pdf-blocks.js renders a block through
// render/enhance.js, which reaches pdf-region-embed.js (and so this module)
// back — the same cycle setPdfRegionGoToHandler exists to avoid. src/main.js
// hands over { blocksForPaper, buildStaticBlock }.
let blockSource = null;

export function setRegionBlockSource(source) {
  blockSource = source && typeof source.blocksForPaper === "function" && typeof source.buildStaticBlock === "function"
    ? source
    : null;
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
  if (!blocks.length) return null;
  const nodes = await Promise.all(blocks.map((block) => blockSource.buildStaticBlock(block, viewport).catch((error) => {
    console.warn("Could not show a block inside a region", error);
    return null;
  })));
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
export async function rasteriseRegionBlocks(page, source, pageNumber, rect, pixelRatio) {
  const blocks = regionBlocksInBox(source, pageNumber, rect);
  if (!blocks.length) return { rasters: [], failed: 0 };
  if (!(await ensureHtmlToImage())) return { rasters: [], failed: blocks.length };
  const viewport = page.getViewport({ scale: 1 });
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(viewport.width)}px;height:${Math.ceil(viewport.height)}px;pointer-events:none;`;
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
  } finally {
    host.remove();
  }
  return { rasters, failed };
}

// The rasterised blocks onto a canvas whose drawing space is `viewport`.
export function drawRegionBlocks(ctx, viewport, rasters) {
  rasters.forEach(({ block, canvas }) => {
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(blockPdfRect(block));
    ctx.drawImage(canvas, Math.min(vx0, vx1), Math.min(vy0, vy1), Math.abs(vx1 - vx0), Math.abs(vy1 - vy0));
  });
}
