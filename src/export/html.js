// Standalone HTML export: every image inlined as a data: URI, so the file
// still renders with no network and no Supabase project behind it.

import { afterPaint } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { ensureMermaid } from "../core/lib-loader.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { buildExportStyleTag } from "./pdf.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";

// Renders off-screen in el.printRoot (same trick exportCardsPdf uses) so
// math/diagrams are baked to static markup, then hands back plain HTML.
// Word only ever sees the file we hand it (no live network fetch the way a
// browser does while printing), and a saved standalone HTML file is meant to
// keep working with no connection at all — so every <img src> pointing at a
// remote URL gets pulled down once here and turned into a data: URI.
//
// Some remote hosts (private Drive shares, hotlink protection, rate limits)
// respond 200 with an HTML sign-in/error page instead of image bytes, or
// reject the cross-origin fetch outright. Embedding that response verbatim
// produces an unreadable image (Word shows this as a broken "Read Error"
// tile), so any src that doesn't resolve to real image bytes is swapped for
// a plain link instead — broken but honest, rather than silently corrupt.
export function unembeddableImageFallback(img, src) {
  const link = document.createElement("a");
  link.className = "export-image-fallback";
  link.href = src;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = img.getAttribute("alt")?.trim() || "View image";
  return link;
}

export async function embedImagesAsDataUris(container) {
  const images = Array.from(container.querySelectorAll("img[src]"));
  let failedCount = 0;
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) return;
    try {
      const response = await fetch(src, { mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`Not image bytes (got ${blob.type || "unknown"})`);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", dataUrl);
    } catch (error) {
      console.warn("Could not embed image for export, linking to original instead:", src, error);
      failedCount += 1;
      img.replaceWith(unembeddableImageFallback(img, src));
    }
  }));
  return failedCount;
}

// Mounts + renders + embeds into el.printRoot and leaves it mounted (unlike
// prepareExportHtml, which serializes it to a string and tears it down).
// The .docx builder needs the live DOM — real <img>/<svg> elements it can
// rasterize with their actual pixel dimensions — not a string it would have
// to re-parse, so it shares this step and calls finishExportRoot() itself
// once it's done reading the DOM.
export async function prepareExportRoot(bodyHtml) {
  el.printRoot.innerHTML = bodyHtml;
  el.printRoot.classList.remove("is-preview");
  el.printRoot.classList.add("is-preparing");
  el.printRoot.setAttribute("aria-hidden", "true");
  // Must precede configureMermaid("print"): with mermaid loaded on demand,
  // an unloaded library makes that call a silent no-op, and the
  // enhanceRenderedMarkdown below would then load mermaid itself and
  // configure it with the SCREEN theme — exporting every diagram in the
  // dark palette onto white paper.
  await ensureMermaid();
  configureMermaid("print");
  try {
    await enhanceRenderedMarkdown(el.printRoot);
  } finally {
    configureMermaid(currentThemeId());
  }
  const failedImageCount = await embedImagesAsDataUris(el.printRoot);
  await (document.fonts?.ready || Promise.resolve());
  await afterPaint();
  return failedImageCount;
}

export function finishExportRoot() {
  el.printRoot.innerHTML = "";
  el.printRoot.classList.remove("is-preparing");
  el.printRoot.setAttribute("aria-hidden", "true");
}

export async function prepareExportHtml(bodyHtml) {
  const failedImageCount = await prepareExportRoot(bodyHtml);
  const html = el.printRoot.innerHTML;
  finishExportRoot();
  return { html, failedImageCount };
}

// A real browser (unlike Word) resolves var() fine, so the standalone HTML
// export embeds the actual stylesheet plus the live inline custom-property
// overrides from the style settings panel (fonts, sizes, widths, theme) —
// opening the file reproduces the exact look of the app when it was
// exported, not just its default theme.
export async function wrapStandaloneHtmlDocument(bodyHtml, title) {
  const styleTag = await buildExportStyleTag();
  const liveStyle = document.documentElement.getAttribute("style") || "";
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(currentThemeId())}" style="${escapeHtml(liveStyle)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styleTag}
</head>
<body>
<div class="flat-export-document">
${bodyHtml}
</div>
</body>
</html>`;
}
