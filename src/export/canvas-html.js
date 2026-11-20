// The Canvas as a web page: ONE .html file that opens anywhere.
//
// The Canvas PDF (src/documents/pdf-export.js) is the page as paper: exact,
// printable, and still. A PDF has no moving pictures — a GIF or an animated
// WebP on a page is its first frame there, in every reader — and it is a
// picture of the page, sharp only to the resolution it was drawn at. So the
// Canvas is also written as the one format every phone, tablet and computer
// opens with nothing installed: a web page, all in one file.
//
//   • the paper, the pen, the shapes and the connectors are SVG — vector, sharp
//     at any zoom (the same drawing the backup's offline viewer makes,
//     canvasPageDrawing in src/backup/viewer-pack.js);
//   • the Blocks are the app's own rendered markdown (createAppViewerRenderer,
//     src/backup/viewer-render.js): real text that selects, copies and finds,
//     with maths, code and diagrams as they are in Recall;
//   • every picture is IN the file, as its original bytes — never redrawn, so
//     a GIF, an animated WebP or an APNG moves exactly as it does on the page;
//   • it lays itself out with no script (container units — see the stylesheet
//     below), so it reads the same in a phone's file preview, an email
//     attachment's preview and a browser; a few lines of script add zoom.
//
// A page that grows, or a Boundless page (src/documents/canvas-extent.js), is
// written at the size it reaches; a Boundless page is cut to what is on it, as
// its PDF page is.

import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { canvasPageDrawing, canvasPageMarkup, collectViewerAppCss, collectViewerKatex } from "../backup/viewer-pack.js?v=__BUILD__";
import { createAppViewerRenderer } from "../backup/viewer-render.js?v=__BUILD__";
import { decodeImageRefEntities, readBackupAssetBlob } from "../backup/backup.js?v=__BUILD__";
import { canvasPageBox, sheetFit, sheetSetupForPage } from "../documents/canvas-setup.js?v=__BUILD__";
import { exportPageBox, pageContentRects } from "../documents/canvas-extent.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK } from "../documents/doc-slot.js?v=__BUILD__";
import { recordsForSurface } from "../documents/pdf-multi.js?v=__BUILD__";
import { sniffImageType } from "../images/compress.js?v=__BUILD__";

// The page's own look: the Canvas pages, and a bar with the title and zoom.
// Lengths on a page are in its points through --u, one point of the page on
// screen: the page's width over its width in points, from container units, so
// no script has to measure anything. A browser too old for container units
// gets the page at its own size (4/3 of a pixel to the point) from the
// fallback, and the script below.
export const CANVAS_HTML_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body.cx-body { background: #e6e7ea; color: #16181d; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.cx-head { position: sticky; top: 0; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  padding: 10px 16px; background: rgb(255 255 255 / 0.94); border-bottom: 1px solid #d5d7dc; }
.cx-head h1 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.05rem; overflow-wrap: anywhere; }
.cx-head p { margin: 0; color: #5f6670; font-size: 0.85rem; }
.cx-zoom { display: inline-flex; align-items: center; gap: 4px; }
.cx-zoom button { min-width: 36px; height: 32px; border: 1px solid #c9ccd2; border-radius: 8px; background: #fff; font: inherit; cursor: pointer; }
.cx-zoom output { min-width: 48px; text-align: center; color: #5f6670; font-size: 0.85rem; }
.cx-pages { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 18px 16px 32px; overflow-x: auto; }
.cx-page { position: relative; flex: 0 0 auto; width: min(100%, calc(var(--w) * 1.3333px * var(--zoom, 1)));
  container-type: inline-size; --u: calc(100cqw / var(--w));
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25); overflow: hidden; color: #16181d; }
.cx-pages.is-zoomed { align-items: flex-start; }
.cx-pages.is-zoomed .cx-page { width: calc(var(--w) * 1.3333px * var(--zoom, 1)); }
@supports not (width: 1cqw) { .cx-page { --u: calc(1.3333px * var(--zoom, 1)); } }
.cx-page > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cx-box { position: absolute; overflow: hidden; transform-origin: 50% 50%; display: flex; flex-direction: column; color: #16181d; }
.cx-box.is-card { border: 1px solid rgb(0 0 0 / 0.18); border-radius: calc(var(--u) * 4); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.cx-box.is-outline { border: 1px solid rgb(0 0 0 / 0.45); }
.cx-box.is-shaped { border: 0; box-shadow: none; background: transparent !important; overflow: visible; }
.cx-box.is-shaped > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.cx-box .rendered { position: relative; line-height: 1.35; font-size: inherit; }
.cx-box .rendered > :first-child { margin-top: 0; }
.cx-box .rendered > :last-child { margin-bottom: 0; }
.cx-box .rendered img { max-width: 100%; height: auto; }
.cx-box.is-picture img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cx-words { position: absolute; overflow: visible; line-height: 1.25; transform-origin: 50% 50%; }
.cx-words .rendered p { margin: 0; }
.cx-missing { display: block; padding: 4px; color: #6b7280; font-size: calc(var(--u) * 9); }
.cx-number { position: absolute; left: 0; right: 0; bottom: calc(var(--u) * 14); text-align: center; color: #737477;
  font: calc(var(--u) * 9) / 1 Helvetica, Arial, sans-serif; pointer-events: none; }
.cx-foot { color: #5f6670; font-size: 0.8rem; text-align: center; padding: 0 16px 28px; }
@media print {
  body.cx-body { background: #fff; }
  .cx-head, .cx-foot { display: none; }
  .cx-pages { padding: 0; gap: 0; display: block; }
  .cx-page { width: 100% !important; box-shadow: none; break-after: page; break-inside: avoid; }
}
`;

// Zoom, for a browser that runs scripts: − and + step it, and past 100% the
// pages are their own size and scroll across. Without a script the page
// still reads, at the width of the screen.
const CANVAS_HTML_SCRIPT = `
(function () {
  var pages = document.querySelector(".cx-pages");
  var label = document.querySelector(".cx-zoom output");
  var zoom = 1;
  function paint() {
    pages.style.setProperty("--zoom", String(zoom));
    pages.classList.toggle("is-zoomed", zoom > 1);
    if (label) label.textContent = Math.round(zoom * 100) + "%";
  }
  document.querySelectorAll("[data-cx-zoom]").forEach(function (button) {
    button.addEventListener("click", function () {
      var step = Number(button.getAttribute("data-cx-zoom"));
      zoom = Math.min(4, Math.max(0.25, Math.round((zoom + step) * 100) / 100));
      paint();
    });
  });
  paint();
})();
`;

// A picture's bytes as a data: URL — its own bytes, with its type read from
// them when the store did not say (a GIF must be called a GIF to move).
async function pictureDataUrl(blob) {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const type = sniffImageType(head) || blob.type || "application/octet-stream";
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(typed);
  });
}

// Every picture address in the pages — Picture Blocks and pictures inside
// Blocks' words — mapped to the picture itself. One that cannot be read keeps
// its address, so a picture on a web site still shows while that site does.
async function inlinePictures(pages, { onProgress = null } = {}) {
  const wanted = new Set();
  const IMG_SRC = /<img\b[^>]*?\ssrc="([^"]+)"/gi;
  pages.forEach((page) => page.boxes.forEach((box) => {
    if (box.src) wanted.add(box.src);
    String(box.html || "").replace(IMG_SRC, (_, src) => { wanted.add(src); return ""; });
  }));
  const found = new Map();
  let missing = 0;
  let done = 0;
  for (const src of wanted) {
    done += 1;
    onProgress?.(done, wanted.size);
    if (/^data:/i.test(src)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const blob = await readBackupAssetBlob(decodeImageRefEntities(src));
      // eslint-disable-next-line no-await-in-loop
      if (blob?.size) found.set(src, await pictureDataUrl(blob));
      else missing += 1;
    } catch (error) {
      console.warn("Could not put a picture into the web page", src, error);
      missing += 1;
    }
  }
  const swap = (src) => found.get(src) || src;
  const swapped = pages.map((page) => ({
    ...page,
    boxes: page.boxes.map((box) => ({
      ...box,
      ...(box.src ? { src: swap(box.src) } : {}),
      ...(box.html ? { html: String(box.html).replace(IMG_SRC, (tag, src) => tag.replace(`src="${src}"`, `src="${found.has(src) ? found.get(src) : src}"`)) } : {})
    }))
  }));
  return { pages: swapped, missing, pictures: found.size };
}

// KaTeX's stylesheet with its fonts inside it, for a page with maths on it.
async function inlineKatexCss() {
  const katex = await collectViewerKatex().catch(() => null);
  if (!katex?.css) return "";
  let css = katex.css;
  for (const font of katex.fonts || []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const url = await pictureDataUrl(new Blob([font.blob], { type: "font/woff2" }));
      css = css.split(font.path).join(url.replace(/^data:[^;,]*/, "data:font/woff2"));
    } catch (_) { /* that face falls back to the next in its list */ }
  }
  return css;
}

function canvasHtmlName() {
  const title = state.deckTitle || state.sourceTitle || "Canvas";
  return `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Canvas"} - canvas.html`;
}

// Resolves to { html, name, pages, pictures, missing }, or null when there is
// no Canvas.
export async function buildCanvasHtml({ onProgress = null } = {}) {
  const record = state.meta?.notebook;
  const count = Math.max(0, Math.round(Number(record?.pages) || 0));
  if (!record || !count) return null;
  const marks = recordsForSurface(state.meta?.pdfHighlights, DOC_SLOT_NOTEBOOK, null);
  const blocks = recordsForSurface(state.meta?.pdfBlocks, DOC_SLOT_NOTEBOOK, null).filter((block) => block && block.id);
  const drawn = [];
  for (let n = 1; n <= count; n += 1) {
    const onPage = (rec) => (Number(rec?.page) || 1) === n;
    const pageMarks = marks.filter(onPage);
    const pageBlocks = blocks.filter(onPage).sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
    const setup = sheetSetupForPage(record, n);
    // A Boundless page is cut to what is on it, as its PDF page is.
    const box = sheetFit(setup) === "boundless"
      ? exportPageBox(setup, canvasPageBox(record, n), pageContentRects(pageMarks, pageBlocks))
      : null;
    drawn.push(canvasPageDrawing(record, n, {
      ink: pageMarks.filter((rec) => rec?.kind === "ink"),
      shapes: pageMarks.filter((rec) => rec?.kind === "shape"),
      blocks: pageBlocks,
      box
    }));
  }
  onProgress?.("words");
  // Every Block's words in one pass through the app's own renderer.
  const items = drawn.flatMap((page) => page.boxes.filter((box) => String(box.md || "").trim()).map((box) => ({ key: box.key, md: box.md })));
  let rendered = new Map();
  const renderer = createAppViewerRenderer({ livePictures: true });
  if (renderer && items.length) {
    try {
      rendered = await renderer.render(items);
    } catch (error) {
      console.warn("The web page's Blocks fell back to plain words", error);
    }
  }
  const withWords = drawn.map((page) => ({
    ...page,
    boxes: page.boxes.map(({ md, key, ...box }) => ({ ...box, html: rendered.get(key) ?? (md ? `<p>${escapeHtml(md)}</p>` : "") }))
  }));
  onProgress?.("pictures");
  const { pages, missing, pictures } = await inlinePictures(withWords, {
    onProgress: (done, total) => onProgress?.("pictures", done, total)
  });
  const numbered = record.pageNumbers !== false;
  const body = pages.map((page, i) => canvasPageMarkup(page, {
    number: numbered ? `${i + 1} / ${pages.length}` : "",
    label: `Page ${i + 1} of ${pages.length}`
  })).join("\n");
  const anyMath = /class="katex/.test(body);
  const [appCss, katexCss] = await Promise.all([
    collectViewerAppCss().catch(() => ""),
    anyMath ? inlineKatexCss() : Promise.resolve("")
  ]);
  const title = state.deckTitle || state.sourceTitle || "Canvas";
  const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Recall">
<title>${escapeHtml(title)} — Canvas</title>
<style>
${appCss}
${katexCss}
${CANVAS_HTML_CSS}
</style>
</head>
<body class="cx-body">
<header class="cx-head">
<h1>${escapeHtml(title)}</h1>
<p>Canvas · ${pages.length} page${pages.length === 1 ? "" : "s"} · ${escapeHtml(when)}</p>
<div class="cx-zoom" role="group" aria-label="Zoom"><button type="button" data-cx-zoom="-0.25" aria-label="Zoom out">−</button><output>100%</output><button type="button" data-cx-zoom="0.25" aria-label="Zoom in">+</button></div>
</header>
<main class="cx-pages">
${body}
</main>
<p class="cx-foot">Made with Recall. Everything is in this one file — it opens offline, in any browser.</p>
<script>${CANVAS_HTML_SCRIPT}</script>
</body>
</html>
`;
  return { html, name: canvasHtmlName(), pages: pages.length, pictures, missing };
}
