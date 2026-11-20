// The app's own Markdown pipeline, for the offline viewer in a backup.
//
// src/backup/viewer-pack.js asks a renderer to turn a file's Notes, card faces,
// highlight notes and Block words into HTML. This is the one the app hands it:
// the same markdownToSafeHtml + enhanceRenderedMarkdown every surface uses, run
// off-screen in #printRoot the way the HTML export runs, so math is KaTeX's
// markup, code is highlighted, diagrams are drawn (when the diagram library can
// be loaded) and clozes and highlights are the app's own markup. The result is
// static HTML that needs none of the app to show.
//
// Pictures are deliberately left at the address the note holds — the canonical
// one, not a signed one the render may swap in — so viewer-pack can point each
// at its copy inside the zip.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensureMermaid } from "../core/lib-loader.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";
import { yieldToPage } from "./zip-lite.js?v=__BUILD__";

// A render that has not finished by then is taken as it stands: a diagram
// library that never loads, or a PDF region that cannot be drawn, must not hold
// the whole backup up.
export const VIEWER_RENDER_TIMEOUT_MS = 45000;

// Pieces rendered per mount. A file of a thousand cards is two thousand faces;
// mounted all at once that is one long frame, so they go in batches.
export const VIEWER_RENDER_BATCH = 120;

const DIAGRAM_FENCE_RE = /^\s*(?:```|~~~)\s*(?:mermaid|nomnoml)\b/m;

function viewerRaceTimeout(promise, ms) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); })
  ]);
}

async function renderBatch(items, { livePictures = false } = {}) {
  const root = el.printRoot;
  const holder = document.createElement("div");
  holder.className = "viewer-render-batch";
  items.forEach((item, i) => {
    const node = document.createElement("div");
    node.className = "rendered";
    node.dataset.viewerItem = String(i);
    node.innerHTML = markdownToSafeHtml(item.md);
    // The address as written, kept aside: the render may swap a picture of
    // ours for a signed, expiring address.
    node.querySelectorAll("img[src]").forEach((img) => { img.dataset.viewerSrc = img.getAttribute("src"); });
    // A live picture of a spot of a PDF or the Canvas (`pdfref:`) is drawn from
    // the file that is OPEN, not the file being written — rendered here it
    // would show the wrong file's page. The viewer says what it was instead.
    // ...unless the file being written IS the open one (the Canvas's web page
    // export): then the render draws each as a still of that spot, the way
    // every export does (mountPdfRegionPicture).
    if (!livePictures) node.querySelectorAll('img[src^="pdfref:"]').forEach((img) => {
      const [, page, , pdfId] = String(img.getAttribute("src")).split(":");
      const label = document.createElement("span");
      label.className = "viewer-missing-picture";
      label.textContent = `[a picture of ${pdfId === "canvas" ? "Canvas" : "PDF"} page ${Number(page) || 1} — shown in Recall]`;
      img.replaceWith(label);
    });
    holder.appendChild(node);
  });
  root.innerHTML = "";
  root.appendChild(holder);
  root.classList.remove("is-preview");
  root.classList.add("is-preparing");
  root.setAttribute("aria-hidden", "true");
  try {
    await viewerRaceTimeout(enhanceRenderedMarkdown(root), VIEWER_RENDER_TIMEOUT_MS);
  } catch (error) {
    console.warn("Offline viewer: part of a render failed", error);
  }
  await settleCodeHighlighting(holder);
  const out = [];
  holder.querySelectorAll("[data-viewer-item]").forEach((node) => {
    node.querySelectorAll("img").forEach((img) => {
      const original = img.dataset.viewerSrc;
      const now = img.getAttribute("src") || "";
      // A PDF region drawn as a still picture is a data: URL — keep that one.
      if (original && !now.startsWith("data:")) img.setAttribute("src", original);
      img.removeAttribute("data-viewer-src");
      img.removeAttribute("data-canonical-src");
      img.removeAttribute("srcset");
    });
    // The zoom pills and resize grips the app adds to diagrams and pictures
    // are controls for the app, and do nothing on a page of their own.
    node.querySelectorAll("button.diagram-zoom, button.code-copy-btn, .image-resize-handle").forEach((control) => control.remove());
    out[Number(node.dataset.viewerItem)] = node.innerHTML;
  });
  root.innerHTML = "";
  root.classList.remove("is-preparing");
  return out;
}

// Prism's autoloader fetches a language's grammar the first time a block in it
// is seen, and highlights the block when it arrives — after this render has
// been serialised, which left every block in a language not yet used here
// flat. So the grammars are waited for, and the blocks highlighted again.
async function settleCodeHighlighting(holder) {
  const prism = globalThis.Prism;
  if (!prism?.highlightElement) return;
  const codes = Array.from(holder.querySelectorAll("pre code[class*='language-']")).filter((code) => !code.querySelector(".token"));
  if (!codes.length) return;
  const languageOf = (code) => (/\blanguage-([\w-]+)/.exec(code.className) || [])[1] || "";
  const missing = [...new Set(codes.map(languageOf).filter((lang) => lang && !prism.languages?.[lang]))];
  const loader = prism.plugins?.autoloader?.loadLanguages;
  if (missing.length && typeof loader === "function") {
    await viewerRaceTimeout(new Promise((resolve) => {
      try { loader(missing, resolve, resolve); } catch (_) { resolve(); }
    }), 8000);
  }
  codes.forEach((code) => {
    if (!prism.languages?.[languageOf(code)]) return;
    try { prism.highlightElement(code); } catch (_) { /* left plain */ }
  });
}

// The renderer viewer-pack.js calls, or null where there is no page to render
// on (the Node check).
//
// `livePictures`: a picture of a spot of a PDF or the Canvas is drawn from the
// file that is open, as a still — only right when that is the file written.
export function createAppViewerRenderer({ livePictures = false } = {}) {
  if (typeof document === "undefined" || !el?.printRoot || typeof markdownToSafeHtml !== "function") return null;
  if (typeof globalThis.marked === "undefined" || typeof globalThis.DOMPurify === "undefined") return null;
  let diagramsReady = null;
  return {
    name: "app",
    async render(items) {
      const result = new Map();
      const list = (items || []).filter((item) => String(item.md || "").trim());
      if (!list.length) return result;
      if (list.some((item) => DIAGRAM_FENCE_RE.test(item.md))) {
        if (!diagramsReady) diagramsReady = viewerRaceTimeout(ensureMermaid().catch(() => false), 15000);
        await diagramsReady;
        // Diagrams on white paper, as the exports draw them; the viewer's
        // pages are paper whatever theme it is read in.
        configureMermaid("print");
      }
      try {
        for (let start = 0; start < list.length; start += VIEWER_RENDER_BATCH) {
          const batch = list.slice(start, start + VIEWER_RENDER_BATCH);
          const html = await renderBatch(batch, { livePictures });
          batch.forEach((item, i) => result.set(item.key, html[i] || ""));
          await yieldToPage();
        }
      } finally {
        configureMermaid(currentThemeId());
      }
      return result;
    }
  };
}
