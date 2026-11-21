// The offline viewer that rides inside every backup: an index.html you can open
// on any computer, with no Recall, no sign-in and no network.
//
// ── Why it exists ─────────────────────────────────────────────────────────
//
// A backup used to be a zip of JSON. Everything was in it, and nothing in it
// could be read without the app — and the moment a backup matters is often the
// moment the app is not there (a new machine, a project gone, a friend without
// an account). So every package now carries a page that shows what is in it:
// the folders, each file's Cards, Notes, PDFs and Canvas, with the pictures and
// PDFs out of the zip itself.
//
// ── Why the data is JavaScript, not JSON ──────────────────────────────────
//
// A page opened from a folder on disk (a file:// address) may not fetch() the
// files next to it — Chrome refuses outright. It may still load them as
// <script src>. So the library list is `viewer/library.js` and each file is
// `viewer/files/0001.js`, each calling one function the viewer defines; a file
// is loaded the first time it is opened, so a library of hundreds opens at once.
// Pictures and PDFs are referenced by their relative paths in the zip
// (`assets/…`, `documents/…`), which <img> and <iframe> may load from disk.
//
// ── What is worked out here, and what the app's renderer adds ──────────────
//
// This module is pure: the backup check runs it in Node. It turns a file into
// the viewer's data: the Canvas pages drawn as SVG (paper, pen, shapes,
// connectors) from the same pure modules the app draws them with, the Blocks
// and typed words placed on them, the PDFs listed with their highlights, and
// every picture pointed at the copy packed in the zip.
//
// Markdown is turned into HTML by a RENDERER the caller passes in. In the app
// that is src/backup/viewer-render.js — the app's own pipeline, so math, code,
// diagrams, clozes and highlights look exactly as they do in Recall. Anywhere
// it is not available (the Node check, or a render that fails) a plain one
// stands in, so a backup never fails because of its viewer.

import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { canvasPageBox, sheetFit, sheetOps, sheetSetupForPage, sheetSvg } from "../documents/canvas-setup.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK } from "../documents/doc-slot.js?v=__BUILD__";
import { PDF_PRIMARY_ID, deckPdfs, recordsForSurface } from "../documents/pdf-multi.js?v=__BUILD__";
import { normalizeBlockStyle, BLOCK_FILL_HEX } from "../documents/block-style.js?v=__BUILD__";
import { parseHighlightNoteEntries } from "../format/highlight-notes-merge.js?v=__BUILD__";
import { MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { inkPathRecorder } from "../format/ink-svg.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { isHighlighterToken } from "../format/ink-colors.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { paperNumberColor } from "../format/paper-palette.js?v=__BUILD__";
import { paperRecolor, paperToneColor } from "../format/paper-tones.js?v=__BUILD__";
import { inkCentrelinePath, inkHighlighterWidth, inkStrokeOutline, resolveInkPaint } from "../render/ink-paint.js?v=__BUILD__";
import { SHAPE_TEXT_PAD, normalizeShape, polyPathData, shapeDashArray, shapePrimitives, stickyIconPolys } from "../render/annot-shapes.js?v=__BUILD__";
import { outlineSvgPaths } from "../render/node-outlines.js?v=__BUILD__";
import { themeCatalog } from "../ui/theme-catalog.js?v=__BUILD__";
import { VIEWER_INDEX_HTML, VIEWER_SCRIPT_JS, VIEWER_STYLE_CSS } from "./viewer-shell.js?v=__BUILD__";

export const VIEWER_INDEX = "index.html";
export const VIEWER_DIR = "viewer";
export const VIEWER_SCRIPT = `${VIEWER_DIR}/recall-viewer.js`;
export const VIEWER_STYLE = `${VIEWER_DIR}/recall-viewer.css`;
export const VIEWER_APP_STYLE = `${VIEWER_DIR}/recall-content.css`;
export const VIEWER_LIBRARY = `${VIEWER_DIR}/library.js`;
export const VIEWER_FILES_DIR = `${VIEWER_DIR}/files`;
export const VIEWER_KATEX_DIR = `${VIEWER_DIR}/katex`;
export const VIEWER_SCHEMA = "recall-backup-viewer";
export const VIEWER_VERSION = 1;

// The two functions the data files call. Named here and in the viewer script
// (src/backup/viewer-shell.js) — a check holds the two to each other.
export const VIEWER_LIBRARY_CALL = "RecallViewerLibrary";
export const VIEWER_FILE_CALL = "RecallViewerFile";

// The words searched from the home page, per file. A book's notes are megabytes;
// the search is for finding the file, and the file's own find is for the rest.
export const VIEWER_SEARCH_CHARS = 120000;

// ── Small pieces ──────────────────────────────────────────────────────────

const svgNum = (value) => {
  const n = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(n) ? String(n) : "0";
};

export function viewerFileId(index) {
  return String(index + 1).padStart(4, "0");
}

// `window.Fn(…json…)` as a script. U+2028/9 are legal in JSON and were not in
// a JavaScript string before 2019; escaped, an older browser still reads it.
// `</` is escaped too, so the same text could be inlined into a page.
export function viewerScriptCall(fn, ...args) {
  const body = args.map((arg) => JSON.stringify(arg)
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/<\//g, "<\\/")).join(",");
  return `/* Recall offline viewer data — opened by ../index.html */\nwindow.${fn} && window.${fn}(${body});\n`;
}

// Markdown to plain words, for the home page's search. Rough on purpose: it is
// matched against, never shown.
export function viewerPlainText(markdown) {
  return String(markdown || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|{}$\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The plain renderer: what the viewer shows when the app's renderer is not
// there. Words as written, paragraphs kept, pictures still pictures.
export function plainMarkdownHtml(markdown) {
  const text = String(markdown || "");
  if (!text.trim()) return "";
  const pictures = [];
  const held = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s<>"']+)[^)]*\)/g, (_, alt, src) => {
    pictures.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`);
    return `\u0000${pictures.length - 1}\u0000`;
  });
  return `<div class="viewer-plain">${held.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para)
    .replace(/\u0000(\d+)\u0000/g, (_, i) => pictures[Number(i)])
    .replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
}

export const plainViewerRenderer = {
  name: "plain",
  async render(items) {
    const out = new Map();
    items.forEach((item) => out.set(item.key, plainMarkdownHtml(item.md)));
    return out;
  }
};

// Every picture pointed at its copy in the zip. `assetByUrl` maps the
// reference a note holds to the packed file; a picture that was not packed
// keeps its own address, which still shows wherever that site is reachable.
// The canonical address is preferred over a signed one the render may have
// swapped in — a signed URL is a credential, and it expires.
export function pointPicturesAtZip(html, assetByUrl) {
  return String(html || "").replace(/<img\b[^>]*>/gi, (tag) => {
    const canonical = /\sdata-canonical-src="([^"]*)"/i.exec(tag)?.[1];
    const srcMatch = /\ssrc="([^"]*)"/i.exec(tag);
    const raw = (canonical || srcMatch?.[1] || "").replace(/&amp;/g, "&");
    let next = tag.replace(/\sdata-canonical-src="[^"]*"/i, "").replace(/\sloading="[^"]*"/i, "");
    const packed = assetByUrl.get(raw);
    const safe = packed || (/^(https?:|data:image\/)/i.test(raw) ? raw : "");
    if (!safe) {
      // A placeholder for a picture waiting to upload, a blob: url, a pdfref:
      // marker: nothing a file on disk can show.
      return `<span class="viewer-missing-picture">[picture not in this backup]</span>`;
    }
    const attr = ` src="${escapeHtml(safe)}"`;
    next = srcMatch ? next.replace(/\ssrc="[^"]*"/i, attr) : next.replace(/^<img/i, `<img${attr}`);
    return next.replace(/^<img/i, '<img loading="lazy"');
  });
}

function rgbHex(rgb) {
  return `#${(rgb || [1, 1, 1]).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function svgInner(svg) {
  return String(svg || "").replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

// ── A Canvas page, drawn ─────────────────────────────────────────────────

// Everything on page `n` of the Canvas: the paper, the pen, the shapes and the
// connectors as one SVG, and the Blocks and typed words as boxes to lay over it.
// Coordinates are the page's own points, from its top-left corner.
//
// The page is where it reaches — grown past its size, or Boundless
// (src/documents/canvas-extent.js) — and `box`, when given, is the part of it
// to draw: a Boundless page cut to what is on it, for the web page export.
//
// `tone` (a tone from resolvePaperTone, src/format/paper-tones.js) is the paper
// the page is SEEN on, for the web page export: the paper and its lines go
// through the very steps the page's pixels go through on screen
// (paperToneColor), the pen is the pen set of that paper, the shapes and the
// pen's own colours are kept readable on it, and a Block's fill is the paper's
// (the page's stylesheet rebinds --block-fill-* to it, styles/94-paper-tones.css).
// None — the backup's offline viewer — is the page on its own paper, as it
// always was.
export function canvasPageDrawing(record, n, { ink = [], shapes = [], blocks = [], box = null, tone = null } = {}) {
  const setup = sheetSetupForPage(record, n);
  const reach = canvasPageBox(record, n);
  const [x0, y0, x1, y1] = Array.isArray(box) && box.length === 4 ? box.map(Number) : reach;
  const w = x1 - x0;
  const h = y1 - y0;
  const sheetPaperHex = rgbHex(sheetOps(setup).paper);
  const toned = Boolean(tone && typeof tone === "object");
  const toneOf = toned ? { dark: Boolean(tone.dark), tint: tone.tint || null } : null;
  const paperHex = toned ? paperToneColor(sheetPaperHex, toneOf) : sheetPaperHex;
  // What a colour is kept readable against, and the pen set: the tone's paper,
  // as the screen paints the marks (paintRegionMarks), or the sheet's own.
  const markBg = toned ? (tone.bg || paperHex) : sheetPaperHex;
  const penPaper = toned && tone.dark ? "dark" : "light";
  const sheetRecolor = toned
    ? (c) => {
      const hex = paperToneColor(rgbHex(c), toneOf);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return [r, g, b];
    }
    : null;
  const toPoint = ([x, y]) => [x - x0, y1 - y];
  const parts = [`<svg class="viewer-page-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNum(w)} ${svgNum(h)}" preserveAspectRatio="none">`];
  parts.push(`<g class="viewer-paper">${svgInner(sheetSvg(setup, { box: reach, crop: [x0, y0, x1, y1], recolor: sheetRecolor }))}</g>`);

  const recolor = paperRecolor(markBg);
  const boxes = [];
  // Shapes first, then the pen over them, as the page paints them.
  shapes.forEach((rec) => {
    const shape = normalizeShape(rec.shape);
    if (!shape) return;
    shapePrimitives(shape, { recolor }).forEach((prim) => {
      if (prim.kind === "poly") parts.push(shapePathSvg(prim, toPoint));
      else if (prim.kind === "sticky") stickyIconPolys(prim.rect, prim.color).forEach((poly) => parts.push(shapePathSvg(poly, toPoint)));
      else if (prim.kind === "text" && String(prim.text || "").trim()) {
        const [rx0, ry0, rx1, ry1] = prim.rect;
        boxes.push({
          kind: "words",
          key: `shape:${rec.id}`,
          md: prim.text,
          x: rx0 - x0, y: y1 - ry1, w: rx1 - rx0, h: ry1 - ry0,
          rot: prim.rot || 0,
          size: prim.size, bold: Boolean(prim.bold), align: prim.align || "left", color: prim.color || ""
        });
      }
    });
  });

  const inkParts = [];
  const bands = [];
  ink.forEach((rec) => {
    decodeInkStrokes(rec.ink?.s).forEach((stroke) => {
      if (!stroke?.p?.length) return;
      const paint = resolveInkPaint(stroke.c, { paper: penPaper, paperBg: markBg });
      const recorder = inkPathRecorder();
      if (isHighlighterToken(stroke.c)) {
        if (!inkCentrelinePath(recorder.ctx, stroke)) return;
        const d = recorder.path();
        if (d) bands.push(`<path d="${d}" fill="none" stroke="${paint.color}" stroke-opacity="${svgNum(paint.alpha < 1 ? paint.alpha : 0.4)}" stroke-width="${svgNum(inkHighlighterWidth(stroke))}" stroke-linecap="round" stroke-linejoin="round"/>`);
        return;
      }
      if (!inkStrokeOutline(recorder.ctx, stroke)) return;
      const d = recorder.path();
      if (d) inkParts.push(`<path d="${d}" fill="${paint.color}"${paint.alpha < 1 ? ` fill-opacity="${svgNum(paint.alpha)}"` : ""}/>`);
    });
  });
  if (bands.length || inkParts.length) {
    // The pen's points are in the page's user space, whose y runs up.
    parts.push(`<g class="viewer-ink" transform="matrix(1 0 0 -1 ${svgNum(-x0)} ${svgNum(y1)})">${bands.join("")}${inkParts.join("")}</g>`);
  }

  blocks.forEach((block) => {
    const bw = Number(block.w) || 0;
    const bh = Number(block.h) || 0;
    const style = normalizeBlockStyle(block.style);
    const left = (Number(block.x) || 0) - x0;
    const top = y1 - ((Number(block.y) || 0) + bh);
    // A diagram Block (a diamond, a pill, a cylinder) is drawn by its outline;
    // a plain one is a card the viewer's stylesheet draws.
    const outline = style.shape && style.shape !== "rect" ? outlineSvgPaths(style.shape, bw, bh, 0.5) : null;
    boxes.push({
      kind: block.kind === "image" ? "picture" : "block",
      key: `block:${block.id}`,
      md: block.kind === "image" ? "" : (block.md || ""),
      src: block.kind === "image" ? (block.src || "") : "",
      alt: block.alt || "",
      x: left, y: top, w: bw, h: bh,
      rot: Number(block.rot) || 0,
      z: Number(block.z) || 0,
      // On a tone, the paper's own fill for it (--block-fill-*, rebound to the
      // paper by the page's stylesheet); else the fill's colour on white.
      fill: toned ? (Object.hasOwn(BLOCK_FILL_HEX, style.fill) ? `var(--block-fill-${style.fill})` : "") : (BLOCK_FILL_HEX[style.fill] || ""),
      size: style.size,
      align: style.align,
      valign: style.valign,
      frame: style.frame,
      pad: [style.padTop, style.padRight, style.padBottom, style.padLeft],
      outline: outline ? { edge: outline.edge, marks: outline.marks || "" } : null
    });
  });

  parts.push("</svg>");
  const out = { w, h, svg: parts.join(""), boxes, paper: paperHex, boundless: sheetFit(setup) === "boundless" };
  // The page number in the paper's own words at 60%, as the screen draws it.
  if (toned) out.numberColor = paperNumberColor({ ...tone, bg: paperHex });
  return out;
}

// ── A Canvas page as HTML, for the web page export ───────────────────────
//
// The page drawn above (with each box's markdown already rendered to `html`
// and each picture's `src` the picture itself), as one <section> that lays
// itself out with no script: every length is in points of the page through
// `--u`, one point of the page on screen, which the export's stylesheet
// (src/export/canvas-html.js) makes the page's own width over its width in
// points with container units. Opened in a browser, in a phone's file preview
// or printed, the page is its own size or the screen's, and everything on it
// where it was.
const MARKUP_SAFE_CSS = /^[#\w(),.%\s-]{1,64}$/;

function markupAttr(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function markupCss(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text && MARKUP_SAFE_CSS.test(text) ? text : fallback;
}

export function canvasPageMarkup(page, { number = "", label = "" } = {}) {
  const w = Number(page?.w) || 595;
  const h = Number(page?.h) || 842;
  const pct = (v, of) => `${svgNum(((Number(v) || 0) / of) * 100)}%`;
  const pt = (v) => `calc(var(--u) * ${svgNum(Number(v) || 0)})`;
  const out = [`<section class="cx-page" aria-label="${markupAttr(label)}" style="--w:${svgNum(w)};aspect-ratio:${svgNum(w)} / ${svgNum(h)};background:${markupCss(page?.paper, "#ffffff")}">`, String(page?.svg || "")];
  // The Blocks and text boxes as Recall built them, at `scale` CSS pixels to
  // the point, in one layer the export's stylesheet scales to the page.
  if (page?.layer?.html) {
    const scale = Number(page.layer.scale) > 0 ? Number(page.layer.scale) : 1;
    const classes = String(page.layer.className || "").split(/\s+/).filter((name) => /^[\w-]+$/.test(name)).join(" ");
    out.push(`<div class="cx-layer${classes ? ` ${classes}` : ""}" data-doc-slot="notebook" style="--cx-l:${svgNum(scale)};width:${svgNum(w * scale)}px;height:${svgNum(h * scale)}px">${page.layer.html}</div>`);
  }
  (page?.boxes || []).forEach((box) => {
    const rot = box.rot ? `transform:rotate(${svgNum(-Number(box.rot))}deg);` : "";
    const place = `left:${pct(box.x, w)};top:${pct(box.y, h)};width:${pct(box.w, w)};height:${pct(box.h, h)};${rot}`;
    const align = ["left", "center", "right", "justify"].includes(box.align) ? box.align : "left";
    if (box.kind === "words") {
      // As the page paints a shape's plain words (paintShapeText,
      // src/render/annot-shapes.js): its padding, a leading of 1.3, and the
      // ◐ Canvas Labels face (the export's stylesheet).
      const color = markupCss(box.color);
      out.push(`<div class="cx-words" style="${place}padding:${pt(SHAPE_TEXT_PAD)};font-size:${pt(box.size || 12)};text-align:${align};${box.bold ? "font-weight:700;" : ""}${color ? `color:${color};` : ""}"><div class="rendered">${box.html || ""}</div></div>`);
      return;
    }
    const z = `z-index:${2 + (Number(box.z) || 0)};`;
    if (box.kind === "picture") {
      out.push(`<div class="cx-box is-picture" style="${place}${z}">${box.src
        ? `<img src="${markupAttr(box.src)}" alt="${markupAttr(box.alt || "")}" decoding="async">`
        : "<span class=\"cx-missing\">[a picture that could not be found]</span>"}</div>`);
      return;
    }
    // A side with no padding of its own has the app's default.
    const pad = [6, 8, 6, 8].map((fallback, i) => {
      const v = box.pad && box.pad[i];
      return pt(v === null || v === undefined || v === "" ? fallback : v);
    }).join(" ");
    const frame = box.outline ? " is-shaped" : box.frame === "none" ? "" : box.frame === "outline" ? " is-outline" : " is-card";
    const fill = markupCss(box.fill);
    const valign = box.valign === "middle" || box.valign === "center" ? "center" : box.valign === "bottom" ? "flex-end" : "flex-start";
    const style = `${place}${z}${fill && !box.outline ? `background:${fill};` : ""}padding:${pad};font-size:${pt(box.size || 11)};text-align:${align};justify-content:${valign};`;
    let outline = "";
    if (box.outline) {
      const paint = fill && fill !== "transparent" ? fill : "none";
      // In style, not attributes: a fill on a paper is a var() (canvasPageDrawing),
      // which an SVG attribute cannot hold. The edge is --cx-edge where the
      // page's stylesheet gives the paper one (src/export/canvas-html.js).
      const edge = "stroke:var(--cx-edge, #4b5563)";
      outline = `<svg viewBox="0 0 ${svgNum(box.w)} ${svgNum(box.h)}" preserveAspectRatio="none" aria-hidden="true"><path d="${markupAttr(box.outline.edge)}" style="fill:${paint};${edge}" stroke-width="1" vector-effect="non-scaling-stroke"/>${box.outline.marks ? `<path d="${markupAttr(box.outline.marks)}" style="fill:none;${edge}" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ""}</svg>`;
    }
    out.push(`<div class="cx-box${frame}" style="${style}">${outline}<div class="rendered">${box.html || ""}</div></div>`);
  });
  if (number && !page?.boundless) {
    const colour = markupCss(page?.numberColor);
    out.push(`<div class="cx-number"${colour ? ` style="color:${colour}"` : ""}>${escapeHtml(number)}</div>`);
  }
  out.push("</section>");
  return out.join("");
}

function shapePathSvg(prim, toPoint) {
  const attrs = [`d="${polyPathData(prim, toPoint)}"`, `fill="${prim.fill || "none"}"`];
  if (prim.fill) attrs.push(`fill-opacity="${svgNum(prim.fillOpacity)}"`);
  if (prim.width > 0) {
    attrs.push(`stroke="${prim.stroke}"`, `stroke-width="${svgNum(Math.max(0.5, prim.width))}"`, `stroke-opacity="${svgNum(prim.opacity)}"`,
      'stroke-linejoin="round"', `stroke-linecap="${prim.dash === "dot" ? "round" : "butt"}"`);
    const dash = shapeDashArray(prim.dash, prim.width, 1);
    if (dash.length) attrs.push(`stroke-dasharray="${dash.map(svgNum).join(" ")}"`);
  } else {
    attrs.push('stroke="none"');
  }
  return `<path ${attrs.join(" ")}/>`;
}

// ── One file ─────────────────────────────────────────────────────────────

const MARK_LABEL = { text: "Highlight", area: "Area", ink: "Pen", shape: "Shape" };

// What a PDF's marks say, page by page, for the list beside it. The marks are
// coordinates into the PDF; the browser's own PDF viewer draws the file, and
// this list is how the reader finds what they marked in it.
function pdfMarkList(records) {
  return records
    .filter((rec) => rec && typeof rec === "object")
    .map((rec) => {
      const kind = rec.kind || "text";
      const shapeWords = kind === "shape" ? String(rec.shape?.text || rec.text || "") : "";
      return {
        page: Number(rec.page) || 1,
        kind,
        label: MARK_LABEL[kind] || "Mark",
        color: MARK_HIGHLIGHT_HEX[rec.color] || (typeof rec.hex === "string" ? rec.hex : ""),
        text: kind === "ink" ? "" : String(shapeWords || rec.text || "").slice(0, 2000),
        note: typeof rec.note === "string" ? rec.note.slice(0, 4000) : ""
      };
    })
    .sort((a, b) => a.page - b.page);
}

// The markdown a file holds, keyed, for one pass through the renderer.
export function viewerRenderItems(snapshot, canvasPages) {
  const items = [];
  const source = String(snapshot?.notes || "");
  const body = readerNotesBody(source);
  if (body.trim()) items.push({ key: "notes", md: body });
  parseHighlightNoteEntries(source).forEach((entry) => {
    if (String(entry.text || "").trim()) items.push({ key: `hn:${entry.id}`, md: entry.text });
  });
  (snapshot?.cards || []).forEach((card, i) => {
    items.push({ key: `q:${i}`, md: String(card.question || "") });
    items.push({ key: `a:${i}`, md: String(card.answer || "") });
  });
  (canvasPages || []).forEach((page) => page.boxes.forEach((box) => {
    if (box.md && String(box.md).trim()) items.push({ key: box.key, md: box.md, block: true });
  }));
  return items;
}

// The whole of one file, as the viewer reads it.
export async function buildViewerFile(entry, {
  index, renderer = plainViewerRenderer, assetByUrl = new Map(), documentsByDeck = new Map()
} = {}) {
  const snapshot = entry.snapshot || {};
  const meta = snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  const id = viewerFileId(index);
  const papers = documentsByDeck.get(entry.deckFile) || [];

  // The Canvas, page by page.
  let canvas = null;
  const notebook = meta.notebook && typeof meta.notebook === "object" ? meta.notebook : null;
  if (notebook) {
    const marks = recordsForSurface(meta.pdfHighlights, DOC_SLOT_NOTEBOOK, null);
    const blocks = recordsForSurface(meta.pdfBlocks, DOC_SLOT_NOTEBOOK, null).filter((block) => block && block.id);
    const count = Math.max(0, Math.round(Number(notebook.pages) || 0));
    const pages = [];
    for (let n = 1; n <= count; n += 1) {
      const onPage = (rec) => (Number(rec?.page) || 1) === n;
      pages.push(canvasPageDrawing(notebook, n, {
        ink: marks.filter((rec) => rec?.kind === "ink" && onPage(rec)),
        shapes: marks.filter((rec) => rec?.kind === "shape" && onPage(rec)),
        blocks: blocks.filter(onPage).sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0))
      }));
    }
    const paper = papers.find((doc) => doc.slot === DOC_SLOT_NOTEBOOK);
    canvas = { pages, numbers: notebook.pageNumbers !== false, file: paper?.file || "", name: notebook.name || "Canvas" };
  }

  // Render every piece of markdown the file holds in one pass.
  const items = viewerRenderItems(snapshot, canvas?.pages);
  let rendered = new Map();
  try {
    rendered = await renderer.render(items);
  } catch (error) {
    console.warn("Offline viewer: rendering fell back to plain text", error);
    rendered = await plainViewerRenderer.render(items);
  }
  const html = (key, fallbackMd = "") => pointPicturesAtZip(rendered.get(key) ?? plainMarkdownHtml(fallbackMd), assetByUrl);

  if (canvas) {
    canvas.pages = canvas.pages.map((page, i) => ({
      n: i + 1,
      w: page.w,
      h: page.h,
      paper: page.paper,
      svg: page.svg,
      boxes: page.boxes.map(({ md, key, ...box }) => {
        if (box.kind === "picture") {
          const src = assetByUrl.get(box.src) || (/^(https?:|data:image\/)/i.test(box.src) ? box.src : "");
          return { ...box, src };
        }
        return { ...box, html: html(key, md) };
      })
    }));
  }

  const source = String(snapshot.notes || "");
  const notesBody = readerNotesBody(source);
  const highlightNotes = {};
  parseHighlightNoteEntries(source).forEach((entry) => {
    if (String(entry.text || "").trim()) highlightNotes[entry.id] = html(`hn:${entry.id}`, entry.text);
  });

  const cards = (snapshot.cards || []).map((card, i) => ({
    q: html(`q:${i}`, card.question),
    a: html(`a:${i}`, card.answer),
    status: card.status || ""
  }));

  const pdfs = deckPdfs(meta).map((pdf) => {
    const packedPaper = papers.find((doc) => doc.slot === DOC_SLOT_DOC && (doc.pdfId || PDF_PRIMARY_ID) === (pdf.id || PDF_PRIMARY_ID));
    return {
      name: String(pdf.label || pdf.name || "PDF"),
      pages: Number(pdf.pages) || Number(packedPaper?.pages) || 0,
      file: packedPaper?.file || "",
      marks: pdfMarkList(recordsForSurface(meta.pdfHighlights, DOC_SLOT_DOC, pdf.id || PDF_PRIMARY_ID)),
      blocks: recordsForSurface(meta.pdfBlocks, DOC_SLOT_DOC, pdf.id || PDF_PRIMARY_ID).length
    };
  });

  const data = {
    id,
    title: entry.title || snapshot.deckTitle || "Untitled file",
    folder: String(snapshot.deckCategory || ""),
    updatedAt: snapshot.updatedAt || "",
    source: entry.deckFile || "",
    notes: notesBody.trim() ? html("notes", notesBody) : "",
    highlightNotes,
    cards,
    pdfs,
    canvas
  };

  const search = [data.title, viewerPlainText(notesBody), ...(snapshot.cards || []).flatMap((card) => [viewerPlainText(card.question), viewerPlainText(card.answer)])]
    .join(" ").toLowerCase().slice(0, VIEWER_SEARCH_CHARS);
  const summary = {
    id,
    title: data.title,
    folder: data.folder,
    updatedAt: data.updatedAt,
    cards: cards.length,
    known: cards.filter((card) => card.status === "known").length,
    hasNotes: Boolean(data.notes),
    pdfs: pdfs.length,
    canvasPages: canvas ? canvas.pages.length : 0,
    search
  };
  return { id, data, summary };
}

// The library list — the home page.
export function buildViewerLibrary({ title = "", kind = "library", exportedAt = "", build = "", summaries = [], folders = [], missing = {} } = {}) {
  return {
    schema: VIEWER_SCHEMA,
    version: VIEWER_VERSION,
    title,
    kind,
    exportedAt,
    build,
    folders: [...new Set(folders.filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    files: summaries,
    missing,
    themes: themeCatalog.map(({ id, label, mode }) => ({ id, label, mode }))
  };
}

// ── Writing it into the package ──────────────────────────────────────────

// The stylesheets the rendered notes are drawn with in the app, copied in so
// the viewer looks like Recall: the theme tokens, the rendered-markdown rules,
// section lines and diagrams. Fetched from this site when there is one (the
// service worker holds them, so a backup made offline still has them); empty
// in Node, where the viewer's own stylesheet carries the look.
export const VIEWER_APP_STYLESHEETS = [
  "prismjs-1.30.0/prism-tomorrow.min.css",
  "styles/01-tokens.css", "styles/06-rendered.css", "styles/a5-section-lines.css", "styles/97-diagram.css", "styles/27-highlight-notes.css"
];

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// `extra` are more of the app's stylesheets, after those — the Canvas's web
// page adds the paper's (src/export/canvas-html.js).
export async function collectViewerAppCss({ extra = [] } = {}) {
  if (typeof document === "undefined" || typeof fetch !== "function") return "";
  const links = Array.from(document.querySelectorAll?.('link[rel="stylesheet"][href]') || []);
  const out = [];
  for (const name of [...VIEWER_APP_STYLESHEETS, ...(extra || [])]) {
    const link = links.find((node) => String(node.getAttribute("href") || "").includes(name));
    if (!link) continue;
    try {
      out.push(`/* ${name} */\n${await fetchText(link.href)}`);
    } catch (error) {
      console.warn(`Offline viewer: could not copy ${name}`, error);
    }
  }
  return out.join("\n\n");
}

// KaTeX's stylesheet and fonts, only when a file has math in it.
export async function collectViewerKatex() {
  if (typeof document === "undefined" || typeof fetch !== "function") return null;
  const link = Array.from(document.querySelectorAll?.('link[rel="stylesheet"][href]') || [])
    .find((node) => /katex[^/]*\/katex(\.min)?\.css/.test(String(node.getAttribute("href") || "")));
  const cssUrl = link?.href || new URL("vendor/katex-0.16.11/katex.min.css", document.baseURI).href;
  try {
    const css = await fetchText(cssUrl);
    const fonts = [...new Set([...css.matchAll(/url\((?:'|")?(fonts\/[^)'"]+\.woff2)(?:'|")?\)/g)].map((m) => m[1]))];
    const files = [];
    for (const font of fonts) {
      try {
        const response = await fetch(new URL(font, cssUrl).href);
        if (response.ok) files.push({ path: font, blob: await response.blob() });
      } catch (_) { /* a missing font falls back to the next in the list */ }
    }
    return { css, fonts: files };
  } catch (error) {
    console.warn("Offline viewer: could not copy KaTeX", error);
    return null;
  }
}

// Write the viewer into `zip`. `addText(path, text)` writes and records a text
// file (backup.js's own, so every file is in the manifest's inventory with its
// size and hash); `addBlob(path, blob)` does the same for bytes.
//
//   entries     the package's decks, as writeRecallPackage builds them
//   packed      the images pass's result ({ assets, missing, missingExternal })
//   documents   the PDFs pass's result ({ documents, missing })
export async function packOfflineViewer({
  entries = [], packed = null, documents = null, addText, addBlob,
  renderer = null, title = "", kind = "library", exportedAt = "", build = "", folders = [],
  onProgress = null, isCancelled = () => false, appCss = null, katex = null
} = {}) {
  const assetByUrl = new Map((packed?.assets || []).map((asset) => [asset.url, asset.file]));
  const documentsByDeck = new Map();
  (documents?.documents || []).forEach((doc) => {
    if (!documentsByDeck.has(doc.deckFile)) documentsByDeck.set(doc.deckFile, []);
    documentsByDeck.get(doc.deckFile).push(doc);
  });
  const use = renderer && typeof renderer.render === "function" ? renderer : plainViewerRenderer;
  const summaries = [];
  let anyMath = false;
  for (let i = 0; i < entries.length; i += 1) {
    if (isCancelled()) return { ok: false, cancelled: true };
    const built = await buildViewerFile(entries[i], { index: i, renderer: use, assetByUrl, documentsByDeck });
    const text = viewerScriptCall(VIEWER_FILE_CALL, built.id, built.data);
    if (!anyMath && /class=\\?"katex/.test(text)) anyMath = true;
    await addText(`${VIEWER_FILES_DIR}/${built.id}.js`, text);
    summaries.push(built.summary);
    onProgress?.(i + 1, entries.length, built.data.title);
  }

  const library = buildViewerLibrary({
    title, kind, exportedAt, build, summaries, folders,
    missing: {
      images: packed?.missing?.length || 0,
      webImages: (packed?.missingExternal || []).slice(0, 200),
      pdfs: (documents?.missing || []).map((doc) => doc.deckTitle || doc.name || "").filter(Boolean).slice(0, 200)
    }
  });
  await addText(VIEWER_LIBRARY, viewerScriptCall(VIEWER_LIBRARY_CALL, library));

  const css = typeof appCss === "string" ? appCss : await collectViewerAppCss();
  if (css) await addText(VIEWER_APP_STYLE, css);
  let katexFiles = 0;
  if (anyMath) {
    const kx = katex === null ? await collectViewerKatex() : katex;
    if (kx?.css) {
      await addText(`${VIEWER_KATEX_DIR}/katex.min.css`, kx.css);
      for (const font of kx.fonts || []) {
        if (typeof addBlob === "function") {
          await addBlob(`${VIEWER_KATEX_DIR}/${font.path}`, font.blob);
          katexFiles += 1;
        }
      }
    }
  }
  await addText(VIEWER_STYLE, VIEWER_STYLE_CSS);
  await addText(VIEWER_SCRIPT, VIEWER_SCRIPT_JS);
  await addText(VIEWER_INDEX, VIEWER_INDEX_HTML);
  return { ok: true, files: summaries.length, renderer: use.name || "app", math: anyMath, katexFiles, appCss: Boolean(css) };
}
