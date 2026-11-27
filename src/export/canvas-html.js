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
//   • the Blocks and the text boxes are the app's own, BUILT by the builders
//     the page and the Canvas PDF use and styled by the app's own rules that
//     reach them (buildPageLayer, below): real text that selects, copies and
//     finds, with maths, code panels, quotes, tables and diagrams exactly as
//     they are on the Canvas;
//   • every picture is IN the file, as its original bytes — never redrawn, so
//     a GIF, an animated WebP or an APNG moves exactly as it does on the page;
//   • it lays itself out with no script (container units — see the stylesheet
//     below), so it reads the same in a phone's file preview, an email
//     attachment's preview and a browser.
//
// A page that grows, or a Boundless page (src/documents/canvas-extent.js), is
// written at the size it reaches; a Boundless page is cut to what is on it, as
// its PDF page is.
//
// ── On the paper it is seen on ────────────────────────────────────────────
//
// The Canvas is shown on a TONE — the theme's own colour, White, Sepia, Dim or
// Black (src/format/paper-tones.js) — and the web page is drawn on the one the
// reader is looking at, as the PDF is: the paper and its lines through the same
// steps the page's pixels go through, the pen set of that paper, and every
// Block a card of the paper with the theme's accents made readable on it — the
// rebinding the page itself uses (styles/94-paper-tones.css, `.paper-tokens`,
// handed the palette src/format/paper-palette.js works out). On a dark paper
// the page round the pages is dark too. It used to be white whatever the
// reader saw.

import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { canvasPageDrawing, canvasPageMarkup, collectViewerAppCss, collectViewerKatex } from "../backup/viewer-pack.js?v=__BUILD__";
import { createAppViewerRenderer } from "../backup/viewer-render.js?v=__BUILD__";
import { decodeImageRefEntities, readBackupAssetBlob } from "../backup/backup.js?v=__BUILD__";
import { canvasPageBox, sheetFit, sheetSetupForPage } from "../documents/canvas-setup.js?v=__BUILD__";
import { exportPageBox, pageContentRects } from "../documents/canvas-extent.js?v=__BUILD__";
import { exportPageList, pageListLabel } from "../documents/canvas-page-list.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK } from "../documents/doc-slot.js?v=__BUILD__";
import { recordsForSurface } from "../documents/pdf-multi.js?v=__BUILD__";
import { sniffImageType } from "../images/compress.js?v=__BUILD__";
import { normalizeShape } from "../render/annot-shapes.js?v=__BUILD__";
import { canvasData, canvasDataScript } from "./canvas-data.js?v=__BUILD__";
import { applyPaperPalette, paperPalette, readThemeTokens } from "../format/paper-palette.js?v=__BUILD__";
import { paperRecolor } from "../format/paper-tones.js?v=__BUILD__";
import { regionBlockBuilders } from "../documents/pdf-region-marks.js?v=__BUILD__";
import { currentPdfScale, pdfPageViewport } from "../documents/pdf-view.js?v=__BUILD__";
import { ensureHtmlToImage } from "../core/lib-loader.js?v=__BUILD__";
import { CANONICAL_SRC_ATTR } from "../cloud/storage-urls.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME } from "../images/outbox.js?v=__BUILD__";

// The page's own look: the Canvas pages, and a bar with the title.
// Lengths on a page are in its points through --u, one point of the page on
// screen: the page's width over its width in points, from container units, so
// no script has to measure anything. A browser too old for container units
// gets the page at its own size (4/3 of a pixel to the point) from the
// fallback.
export const CANVAS_HTML_CSS = `
:root { color-scheme: light; }
:root.cx-dark { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body.cx-body { background: #e6e7ea; color: #16181d; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.cx-head { position: sticky; top: 0; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  padding: 10px 16px; background: rgb(255 255 255 / 0.94); border-bottom: 1px solid #d5d7dc; }
.cx-head h1 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.05rem; overflow-wrap: anywhere; }
.cx-pages { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 18px 16px 32px; overflow-x: auto; }
.cx-page { position: relative; flex: 0 0 auto; width: min(100%, calc(var(--w) * 1.3333px));
  container-type: inline-size; --u: calc(100cqw / var(--w));
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25); overflow: hidden; color: #16181d; color: var(--paper-text, #16181d);
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@supports not (width: 1cqw) { .cx-page { --u: 1.3333px; } }
.cx-page > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cx-box { position: absolute; overflow: hidden; transform-origin: 50% 50%; display: flex; flex-direction: column; color: #16181d; color: var(--paper-text, #16181d); }
.cx-box.is-card { border: 1px solid rgb(0 0 0 / 0.18); border-radius: calc(var(--u) * 4); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.cx-box.is-outline { border: 1px solid rgb(0 0 0 / 0.45); }
.paper-tokens { --cx-edge: color-mix(in srgb, var(--paper-text) 72%, var(--paper-bg)); }
.paper-tokens .cx-box.is-card { border-color: color-mix(in srgb, var(--paper-text) 18%, transparent); }
.paper-tokens .cx-box.is-outline { border-color: color-mix(in srgb, var(--paper-text) 45%, transparent); }
.cx-box.is-shaped { border: 0; box-shadow: none; background: transparent !important; overflow: visible; }
.cx-box.is-shaped > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.cx-box .rendered { position: relative; line-height: 1.35; font-size: inherit; }
.cx-box .rendered > :first-child { margin-top: 0; }
.cx-box .rendered > :last-child { margin-bottom: 0; }
.cx-box .rendered img { max-width: 100%; height: auto; }
.cx-box.is-picture img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cx-words { position: absolute; overflow: visible; line-height: 1.3; transform-origin: 50% 50%;
  font-family: var(--doc-label-font, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif); }
.cx-words .rendered p { margin: 0; }
/* The Blocks and text boxes, as Recall builds them (buildPageLayer): laid out
   at the page's scale on screen (--cx-l, CSS pixels per point) and scaled as
   one to the page's width here. tan(atan2(a, b)) is a / b as a plain number —
   a width in container units over a width in pixels, which calc() alone cannot
   divide — so this needs no script either. */
.cx-layer { position: absolute; left: 0; top: 0; z-index: 1; overflow: visible; transform-origin: 0 0;
  --cx-s: tan(atan2(100cqw, calc(var(--w) * var(--cx-l, 1) * 1px)));
  transform: scale(var(--cx-s)); background: transparent !important; box-shadow: none !important; border: 0 !important; }
@supports not ((width: 1cqw) and (width: calc(1px * tan(atan2(1px, 1px))))) {
  .cx-layer { --cx-s: calc(1.3333 / var(--cx-l, 1)); }
}
/* A Block on the web page is read, not picked up: its words select. */
.cx-layer, .cx-layer * { -webkit-user-select: text !important; user-select: text !important; touch-action: auto !important; cursor: auto; }
.cx-layer :is(.pdf-block, .pdf-shape-text) { pointer-events: auto !important; }
.cx-layer pre .code-copy-btn { cursor: pointer; }
.cx-missing { display: block; padding: 4px; color: #6b7280; font-size: calc(var(--u) * 9); }
.cx-number { position: absolute; left: 0; right: 0; bottom: calc(var(--u) * 14); text-align: center; color: #737477;
  font: calc(var(--u) * 9) / 1 Helvetica, Arial, sans-serif; pointer-events: none; }
body.cx-body.is-dark { background: #101215; color: #e8eaed; }
body.cx-body.is-dark .cx-head { background: rgb(24 26 30 / 0.94); border-bottom-color: #2c3036; }
body.cx-body.is-dark .cx-page { box-shadow: 0 1px 6px rgb(0 0 0 / 0.6); }
@media print {
  body.cx-body { background: #fff; }
  .cx-head { display: none; }
  .cx-pages { padding: 0; gap: 0; display: block; }
  .cx-page { width: 100% !important; box-shadow: none; break-after: page; break-inside: avoid; }
}
`;

// The app's own rebinding of a page's colours to its paper (`.paper-tokens`),
// for a web page drawn on a tone — beside the stylesheets every Block's words
// already take from the offline viewer's list.
export const CANVAS_HTML_PAPER_STYLESHEETS = ["styles/94-paper-tones.css"];

// A code panel's badge copies its code, as it does in Recall, for a browser
// that runs scripts. Without a script the page reads just the same.
const CANVAS_HTML_SCRIPT = `
(function () {
  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest(".code-copy-btn") : null;
    var code = button && button.closest("pre") ? button.closest("pre").querySelector("code") : null;
    if (!code || !navigator.clipboard) return;
    navigator.clipboard.writeText(code.innerText).then(function () {
      button.classList.add("is-copied");
      setTimeout(function () { button.classList.remove("is-copied"); }, 1200);
    }, function () {});
  });
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
  pages.forEach((page) => {
    page.boxes.forEach((box) => {
      if (box.src) wanted.add(box.src);
      String(box.html || "").replace(IMG_SRC, (_, src) => { wanted.add(src); return ""; });
    });
    String(page.layer?.html || "").replace(IMG_SRC, (_, src) => { wanted.add(src); return ""; });
  });
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
  const swapHtml = (html) => String(html).replace(IMG_SRC, (tag, src) => tag.replace(`src="${src}"`, `src="${found.has(src) ? found.get(src) : src}"`));
  const swapped = pages.map((page) => ({
    ...page,
    ...(page.layer?.html ? { layer: { ...page.layer, html: swapHtml(page.layer.html) } } : {}),
    boxes: page.boxes.map((box) => ({
      ...box,
      ...(box.src ? { src: swap(box.src) } : {}),
      ...(box.html ? { html: swapHtml(box.html) } : {})
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

// ── The Blocks as Recall draws them ──────────────────────────────────────
//
// A Block is not redrawn here: it is BUILT, by the very builder the page and
// the Canvas PDF build it with (buildStaticBlock, src/documents/pdf-blocks.js;
// a text box's words by buildStaticShapeText, src/documents/pdf-shape-markdown
// .js), in an off-screen host told it is a Canvas page on this paper — as
// rasteriseRegionBlocks (src/documents/pdf-region-marks.js) does for the PDF —
// and kept as HTML instead of turned into pixels.
//
// They used to be redrawn as a box of their own (canvasPageMarkup's .cx-box)
// with only the offline viewer's stylesheets, and everything a Block's own
// stylesheets say was lost: a code panel in the Notes' 0.9rem, as big as the
// words of a heading against the page and cut off at the Block's edge; no
// ◐ Canvas type, no Block's own code size or code wrap; quotes, tables, list
// leads and code line numbers in the Notes' sizes; a text box's words in a
// face and leading of their own.
//
// Each page is laid out at the scale the reader sees it at (as the Canvas PDF
// is — words wrap a hair differently at every size), and the web page scales
// that whole layer to the width it is shown at (.cx-layer below), so every
// length the builders and the app's stylesheets set — pixels at that scale —
// is right as it is.

// The page's scale on screen, as the Canvas PDF takes it (seenScale,
// src/documents/pdf-export.js).
function pageSeenScale(n) {
  const scale = Number(pdfPageViewport(n)?.scale || currentPdfScale() || 1);
  return Number.isFinite(scale) && scale > 0 ? Math.min(6, Math.max(0.25, scale)) : 1;
}

// A page's own transform, for the part of it that is drawn: CSS pixels at
// `scale` from its top-left corner, as a pdf.js viewport says it.
function pageViewport([x0, y0, x1, y1], scale) {
  return {
    scale,
    viewBox: [x0, y0, x1, y1],
    width: (x1 - x0) * scale,
    height: (y1 - y0) * scale,
    convertToViewportPoint: (x, y) => [(x - x0) * scale, (y1 - y) * scale],
    convertToPdfPoint: (x, y) => [x / scale + x0, y1 - y / scale]
  };
}

// The classes the host — and the page's layer, which stands for it — wears:
// a Canvas page on this paper, or on its own white one.
function layerClasses(tone) {
  if (!tone) return "region-block-host print-tokens";
  return `region-block-host paper-tokens${tone.dark ? " is-dark-paper" : ""}`;
}

function mountBlockHost(tone, width, height) {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.className = layerClasses(tone);
  host.dataset.docSlot = DOC_SLOT_NOTEBOOK;
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(width)}px;height:${Math.ceil(height)}px;pointer-events:none;`;
  if (tone) {
    applyPaperPalette(host, tone, readThemeTokens());
    if (!host.style.getPropertyValue("--paper-bg")) host.style.setProperty("--paper-bg", tone.bg || (tone.dark ? "#030303" : "#ffffff"));
    if (!host.style.getPropertyValue("--paper-text")) host.style.setProperty("--paper-text", tone.dark ? "#e8eaed" : "#16181d");
  }
  document.body.appendChild(host);
  return host;
}

// What makes a built node a thing on a page rather than a thing in the app:
// no handles, nothing that refuses the pointer (so its words select), every
// drawing on a <canvas> as a picture (a canvas is written out empty), and every
// picture at the address it is stored under, so its own bytes can be put in.
const PAGE_CONTROLS = ".pdf-block-edge, .pdf-block-grip, [data-pdf-block-action], button.diagram-zoom, .image-resize-handle, .notes-img-resize-handle";

function readyForPage(node) {
  node.querySelectorAll(PAGE_CONTROLS).forEach((control) => control.remove());
  [node, ...node.querySelectorAll("[style*='pointer-events']")].forEach((element) => element.style.removeProperty("pointer-events"));
  node.querySelectorAll("canvas").forEach((canvas) => {
    try {
      const rect = canvas.getBoundingClientRect();
      const img = document.createElement("img");
      img.setAttribute("src", canvas.toDataURL("image/png"));
      img.setAttribute("alt", canvas.getAttribute("aria-label") || "");
      if (canvas.className) img.className = canvas.className;
      const style = canvas.getAttribute("style");
      if (style) img.setAttribute("style", style);
      const display = getComputedStyle(canvas).display;
      img.style.display = display === "inline" ? "inline-block" : display;
      img.style.width = `${rect.width}px`;
      img.style.height = `${rect.height}px`;
      canvas.replaceWith(img);
    } catch (_) { /* a canvas that cannot be read stays empty */ }
  });
  node.querySelectorAll("img").forEach((img) => {
    const now = img.getAttribute("src") || "";
    const token = img.dataset.localToken;
    const canonical = img.getAttribute(CANONICAL_SRC_ATTR);
    const original = token ? `${LOCAL_IMAGE_SCHEME}${token}` : (canonical || now);
    if (original && !/^data:/i.test(now)) img.setAttribute("src", original);
    ["srcset", CANONICAL_SRC_ATTR, "data-local-token", "data-pending-upload", "data-viewer-src", "title"].forEach((name) => img.removeAttribute(name));
  });
  return node;
}

// ── Only the rules that are used ─────────────────────────────────────────
//
// The app's stylesheets that reach a built Block — the Block, its type, its
// code panels, quotes, tables, lists, diagrams and pictures, the ◐ Canvas
// settings, the paper — are a dozen files and grow; a list of them here would
// drift the day one more is added. So, while the built nodes are still in the
// document, every rule of every stylesheet the app has loaded is asked whether
// it reaches one of them, and only those are written. A rule for a state —
// :hover, :focus, ::before — is asked without the state, so a Block's corner
// tint or a code badge's hover come along.
//
// Left out: KaTeX's own (written whole, with its fonts, by inlineKatexCss),
// @font-face (the faces used are put in as their own bytes, fontEmbedCss), and
// the app's print rules, which are for its own print pages.
const STATE_PSEUDO = /::?(?:before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|hover|focus-visible|focus-within|focus|active|visited|target|-webkit-[\w-]+|-moz-[\w-]+)\b(?:\([^()]*\))?/gi;

function splitSelectors(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

function selectorReaches(selector, roots) {
  const relaxed = selector.replace(STATE_PSEUDO, "").replace(/:(?:not|is|where|has)\(\s*\)/g, "").trim() || "*";
  for (const candidate of relaxed === selector ? [selector] : [relaxed, selector]) {
    try {
      return roots.some((root) => root.matches(candidate) || Boolean(root.querySelector(candidate)));
    } catch (_) { /* not a selector this browser reads — try the next */ }
  }
  return false;
}

function cssRuleHead(rule) {
  const text = String(rule.cssText || "");
  const brace = text.indexOf("{");
  return brace > 0 ? text.slice(0, brace).trim() : "";
}

// Every style rule of the document's stylesheets, in cascade order, with the
// @media / @supports / @layer / @container it sits in.
function documentStyleRules() {
  const rules = [];
  const keyframes = [];
  const walk = (list, wrappers, base) => {
    for (const rule of Array.from(list || [])) {
      if (rule.type === 1 /* CSSStyleRule */) {
        rules.push({ rule, wrappers, base, selectors: splitSelectors(rule.selectorText || "") });
      } else if (rule.type === 3 /* CSSImportRule */) {
        const media = rule.media?.mediaText || "";
        if (/^\s*print\s*$/i.test(media)) continue;
        try { walk(rule.styleSheet?.cssRules, media && media !== "all" ? [...wrappers, `@media ${media}`] : wrappers, rule.styleSheet?.href || base); } catch (_) { /* cross-origin */ }
      } else if (rule.type === 7 /* CSSKeyframesRule */) {
        keyframes.push({ name: rule.name, text: rule.cssText, wrappers });
      } else if (rule.type === 5 /* CSSFontFaceRule */) {
        continue;
      } else if (rule.cssRules) {
        if (rule.type === 4 /* CSSMediaRule */ && /^\s*print\s*$/i.test(rule.media?.mediaText || "")) continue;
        const head = cssRuleHead(rule);
        if (head) walk(rule.cssRules, [...wrappers, head], base);
      } else if (/^@layer\b/.test(rule.cssText || "")) {
        // A statement of the layers' order: kept, so their order is the app's.
        rules.push({ rule, wrappers, base, selectors: null });
      }
    }
  };
  for (const styleSheet of Array.from(document.styleSheets || [])) {
    const href = styleSheet.href || "";
    if (/katex/i.test(href)) continue;
    if (/^\s*print\s*$/i.test(styleSheet.media?.mediaText || "")) continue;
    let list = null;
    try { list = styleSheet.cssRules; } catch (_) { continue; /* another site's, unreadable */ }
    walk(list, [], href || document.baseURI);
  }
  return { rules, keyframes };
}

// A collector the pages are put through one by one, each while its nodes are
// mounted; `text()` is the stylesheet for all of them.
function usedCssCollector() {
  const { rules, keyframes } = documentStyleRules();
  const kept = new Set();
  return {
    setting: null,
    keptText() {
      return rules.filter((_, i) => kept.has(i)).map((entry) => String(entry.rule.cssText || "")).join("\n");
    },
    scan(roots) {
      const list = roots.filter(Boolean);
      if (!list.length) return;
      rules.forEach((entry, i) => {
        if (kept.has(i)) return;
        if (!entry.selectors) { kept.add(i); return; }
        if (entry.selectors.some((selector) => selectorReaches(selector, list))) kept.add(i);
      });
    },
    async text() {
      const out = [];
      rules.forEach((entry, i) => {
        if (!kept.has(i)) return;
        let css = String(entry.rule.cssText || "");
        css = absoluteUrls(css, entry.base);
        out.push(entry.wrappers.reduceRight((inner, head) => `${head} { ${inner} }`, css));
      });
      let text = out.join("\n");
      const names = keyframes.filter((frame) => frame.name && new RegExp(`\\b${frame.name.replace(/[^\w-]/g, "")}\\b`).test(text));
      if (names.length) text += `\n${names.map((frame) => frame.wrappers.reduceRight((inner, head) => `${head} { ${inner} }`, frame.text)).join("\n")}`;
      return inlineCssUrls(text);
    }
  };
}

function absoluteUrls(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, url) => {
    if (/^(data:|#)/i.test(url)) return whole;
    try { return `url("${new URL(url, base).href}")`; } catch (_) { return whole; }
  });
}

// A picture a rule draws (an icon, a mask) is put in as its own bytes, so the
// page needs nothing from Recall's site; one too big or unreadable is left
// out, and the rule draws nothing there.
const CSS_URL_MAX_BYTES = 256 * 1024;

async function inlineCssUrls(css) {
  const urls = [...new Set([...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]).filter((url) => /^https?:/i.test(url)))];
  const found = new Map();
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url);
      // eslint-disable-next-line no-await-in-loop
      const blob = response.ok ? await response.blob() : null;
      // eslint-disable-next-line no-await-in-loop
      found.set(url, blob && blob.size <= CSS_URL_MAX_BYTES ? await pictureDataUrl(blob) : "");
    } catch (_) {
      found.set(url, "");
    }
  }
  return css.replace(/url\("([^"]+)"\)/g, (whole, url) => {
    if (!found.has(url)) return whole;
    const data = found.get(url);
    return data ? `url("${data}")` : "none";
  });
}

// The words' setting where the nodes were built: every custom property — the
// theme's tokens, the paper's, ◐ Canvas's type — as it resolved there, and the
// type the host inherited from the app's page. Written on the page's layer, in
// place of the app's own :root and body rules, which would bring the app's
// whole frame with them.
const INHERITED_TYPE = [
  "color", "font-family", "font-size", "font-style", "font-weight", "font-stretch", "line-height", "letter-spacing", "word-spacing",
  "font-feature-settings", "font-variation-settings", "font-variant-ligatures", "font-kerning", "text-rendering", "-webkit-font-smoothing",
  "tab-size", "overflow-wrap", "word-break", "hyphens", "text-align", "text-transform"
];

function hostSetting(host, css) {
  const computed = getComputedStyle(host);
  const names = new Set();
  for (let i = 0; i < computed.length; i += 1) {
    const name = computed[i];
    if (name.startsWith("--")) names.add(name);
  }
  for (const match of css.matchAll(/(--[\w-]+)/g)) names.add(match[1]);
  const tokens = [];
  names.forEach((name) => {
    const value = computed.getPropertyValue(name).trim();
    if (value && !/[{};<]/.test(value)) tokens.push(`${name}: ${value};`);
  });
  const type = INHERITED_TYPE
    .map((name) => [name, computed.getPropertyValue(name).trim()])
    .filter(([, value]) => value && !/[{};<]/.test(value))
    .map(([name, value]) => `${name}: ${value};`);
  return { tokens: tokens.join(" "), type: type.join(" ") };
}

// The faces the Blocks are set in (◐ Canvas, a Block's own), as their own
// bytes — as the Canvas PDF embeds them (fontEmbedFor in pdf-region-marks.js).
const FONT_EMBED_TIMEOUT_MS = 20000;

async function fontEmbedCss(node) {
  try {
    if (!(await ensureHtmlToImage())) return "";
    let timer = 0;
    const css = await Promise.race([
      window.htmlToImage.getFontEmbedCSS(node),
      new Promise((resolve) => { timer = setTimeout(() => resolve(""), FONT_EMBED_TIMEOUT_MS); })
    ]).finally(() => clearTimeout(timer));
    return typeof css === "string" ? css : "";
  } catch (error) {
    console.warn("The web page's fonts fell back to the system's", error);
    return "";
  }
}

// The Blocks and text boxes of one page, built and made ready; resolves to
// { html, built:Set of box keys it drew }, or null where there is no app to
// build them with (the Node checks), and the page keeps its plain boxes.
async function buildPageLayer({ blocks, shapes, crop, scale, tone, css, fonts }) {
  const builders = regionBlockBuilders();
  if (!builders || typeof document === "undefined") return null;
  if (!blocks.length && !shapes.length) return { html: "", built: new Set() };
  const viewport = pageViewport(crop, scale);
  const host = mountBlockHost(tone, viewport.width, viewport.height);
  const built = new Set();
  const nodes = [];
  try {
    for (const block of blocks) {
      // eslint-disable-next-line no-await-in-loop
      const node = await builders.buildStaticBlock(block, viewport, { mountIn: host }).catch((error) => {
        console.warn("Could not build a Block for the web page", error);
        return null;
      });
      if (!node) continue;
      if (node.parentNode !== host) host.appendChild(node);
      nodes.push(node);
      built.add(`block:${block.id}`);
    }
    if (typeof builders.buildStaticShapeText === "function") {
      const recolor = paperRecolor(tone ? (host.style.getPropertyValue("--paper-bg").trim() || "#ffffff") : "#ffffff");
      for (const record of shapes) {
        // eslint-disable-next-line no-await-in-loop
        const node = await builders.buildStaticShapeText(record, viewport, { mountIn: host, recolor }).catch((error) => {
          console.warn("Could not build a text box for the web page", error);
          return null;
        });
        if (!node) continue;
        if (node.parentNode !== host) host.appendChild(node);
        // Its name, as the page's data has it (src/export/canvas-data.js).
        node.setAttribute("data-shape-id", String(record.id));
        nodes.push(node);
        built.add(`shape:${record.id}`);
      }
    }
    nodes.forEach(readyForPage);
    css.scan([host]);
    if (!css.setting) css.setting = hostSetting(host, css.keptText());
    if (nodes.length) fonts.push(await fontEmbedCss(host));
    return { html: nodes.map((node) => node.outerHTML).join(""), built };
  } finally {
    host.remove();
  }
}

// The app's own switches on its root (◐ Canvas → Code look, Heading ink, the
// theme), so the rules that read them read the same on the web page.
function rootAttributes() {
  if (typeof document === "undefined") return "";
  return Array.from(document.documentElement?.attributes || [])
    .filter((attr) => /^data-[\w-]+$/.test(attr.name))
    .map((attr) => ` ${attr.name}="${escapeHtml(attr.value)}"`)
    .join("");
}

// Nothing in a stylesheet may end the <style> it is written in.
function safeStyleText(css) {
  return String(css || "").replace(/<\/(style)/gi, "<\\/$1");
}

function canvasHtmlName(suffix = "") {
  const title = state.deckTitle || state.sourceTitle || "Canvas";
  return `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Canvas"} - canvas${suffix}.html`;
}

// The paper's palette as inline custom properties, for the element that holds
// the pages. Only hexes are written, so nothing in it can close the attribute.
function paletteStyle(tone) {
  if (!tone) return "";
  const palette = paperPalette(tone, readThemeTokens());
  return Object.entries(palette)
    .filter(([property, value]) => /^--[\w-]+$/.test(property) && /^#[0-9a-f]{3,8}$/i.test(String(value || "")))
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

// Resolves to { html, name, pages, pictures, missing }, or null when there is
// no Canvas. `tone` is the paper the Canvas is seen on (currentPaperTone,
// src/documents/pdf-view.js); none is the pages on their own paper.
//
// `pages`: the Canvas pages to put in it (the Pages panel's selection), in
// page order; none is every page. Numbered within the export, as the PDF is.
export async function buildCanvasHtml({ onProgress = null, tone = null, pages: only = null } = {}) {
  const record = state.meta?.notebook;
  const count = Math.max(0, Math.round(Number(record?.pages) || 0));
  if (!record || !count) return null;
  const wanted = exportPageList(only, count);
  const whole = wanted.length === count;
  const marks = recordsForSurface(state.meta?.pdfHighlights, DOC_SLOT_NOTEBOOK, null);
  const blocks = recordsForSurface(state.meta?.pdfBlocks, DOC_SLOT_NOTEBOOK, null).filter((block) => block && block.id);
  const drawn = [];
  const layers = [];
  const dataPages = [];
  const css = typeof document === "undefined" ? null : usedCssCollector();
  const fonts = [];
  for (const [index, n] of wanted.entries()) {
    const onPage = (rec) => (Number(rec?.page) || 1) === n;
    const pageMarks = marks.filter(onPage);
    const pageBlocks = blocks.filter(onPage).sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
    const setup = sheetSetupForPage(record, n);
    // A Boundless page is cut to what is on it, as its PDF page is.
    const box = sheetFit(setup) === "boundless"
      ? exportPageBox(setup, canvasPageBox(record, n), pageContentRects(pageMarks, pageBlocks))
      : null;
    const shapes = pageMarks.filter((rec) => rec?.kind === "shape");
    dataPages.push({ n, setup, box: Array.isArray(box) && box.length === 4 ? box.map(Number) : canvasPageBox(record, n) });
    drawn.push(canvasPageDrawing(record, n, {
      ink: pageMarks.filter((rec) => rec?.kind === "ink"),
      shapes,
      blocks: pageBlocks,
      box,
      tone
    }));
    // The Blocks and the text boxes' words, built as Recall builds them.
    const scale = pageSeenScale(n);
    const crop = Array.isArray(box) && box.length === 4 ? box.map(Number) : canvasPageBox(record, n);
    const pageTextBoxes = shapes.filter((rec) => {
      const shape = normalizeShape(rec.shape);
      return shape && (shape.type === "text" || shape.type === "callout") && String(shape.text || "").trim();
    });
    onProgress?.("blocks", index + 1, wanted.length);
    let layer = null;
    if (css) {
      try {
        // eslint-disable-next-line no-await-in-loop
        layer = await buildPageLayer({ blocks: pageBlocks, shapes: pageTextBoxes, crop, scale, tone, css, fonts });
      } catch (error) {
        console.warn("The web page drew a page's Blocks plainly", error);
      }
    }
    layers.push(layer ? { ...layer, scale } : null);
  }
  onProgress?.("words");
  // The words of whatever was not built above — a connector's label, and every
  // Block where there is no app to build it with — in one pass through the
  // app's own renderer.
  const plain = drawn.map((page, i) => ({
    ...page,
    boxes: page.boxes.filter((box) => !layers[i]?.built.has(box.key))
  }));
  const items = plain.flatMap((page) => page.boxes.filter((box) => String(box.md || "").trim()).map((box) => ({ key: box.key, md: box.md })));
  let rendered = new Map();
  const renderer = items.length ? createAppViewerRenderer({ livePictures: true }) : null;
  if (renderer) {
    try {
      rendered = await renderer.render(items);
    } catch (error) {
      console.warn("The web page's Blocks fell back to plain words", error);
    }
  }
  const withWords = plain.map((page, i) => ({
    ...page,
    layer: layers[i]?.html ? { html: layers[i].html, scale: layers[i].scale, className: layerClasses(tone) } : null,
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
  const anyPlain = pages.some((page) => page.boxes.length);
  const [appCss, katexCss, usedCss] = await Promise.all([
    // The offline viewer's stylesheets, for what is drawn plainly.
    anyPlain || !css ? collectViewerAppCss({ extra: tone ? CANVAS_HTML_PAPER_STYLESHEETS : [] }).catch(() => "") : Promise.resolve(""),
    anyMath ? inlineKatexCss() : Promise.resolve(""),
    css ? css.text().catch(() => "") : Promise.resolve("")
  ]);
  const setting = css?.setting;
  const layerCss = usedCss || setting ? `${usedCss}
${[...new Set(fonts.filter(Boolean))].join("\n")}
${setting ? `.cx-pages.cx-tokens { ${setting.tokens} }\n.cx-pages .cx-layer { ${setting.type} }` : ""}` : "";
  const title = state.deckTitle || state.sourceTitle || "Canvas";
  // The Canvas itself, for whatever reads the page next (src/export/canvas-data.js).
  let data = "";
  try {
    data = canvasDataScript(canvasData({ title, pages: dataPages, blocks, marks }));
  } catch (error) {
    console.warn("The web page went without the Canvas's data", error);
  }
  const dark = Boolean(tone?.dark);
  const palette = paletteStyle(tone);
  const pagesClass = `${tone ? ` paper-tokens${dark ? " is-dark-paper" : ""}` : ""}${setting ? " cx-tokens" : ""}`;
  const html = `<!doctype html>
<html lang="en"${dark ? ' class="cx-dark"' : ""}${rootAttributes()}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Recall">${data ? `\n<meta name="recall-canvas-data" content="1">` : ""}
<title>${escapeHtml(title)} — Canvas</title>
<style>
${safeStyleText(appCss)}
${safeStyleText(layerCss)}
${katexCss}
${CANVAS_HTML_CSS}
</style>
</head>
<body class="cx-body${dark ? " is-dark" : ""}">
<header class="cx-head">
<h1>${escapeHtml(title)}</h1></header>
<main class="cx-pages${pagesClass}"${palette ? ` style="${palette}"` : ""}>
${body}
</main>${data ? `\n${data}` : ""}
<script>${CANVAS_HTML_SCRIPT}</script>
</body>
</html>
`;
  return { html, name: canvasHtmlName(whole ? "" : ` (pages ${pageListLabel(wanted)})`), pages: pages.length, pictures, missing };
}
