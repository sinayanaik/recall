// Standalone HTML export: every image inlined as a data: URI, so the file
// still renders with no network and no Supabase project behind it.

import { afterPaint } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { ensureMermaid } from "../core/lib-loader.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { buildExportStyleTag } from "./pdf.js?v=__BUILD__";
import { prepareExportImages, unembeddableImageFallback } from "./images.js?v=__BUILD__";
import { exportThemeClass, loadExportTheme } from "./themes.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";

// Renders off-screen in el.printRoot (same trick exportCardsPdf uses) so
// math/diagrams are baked to static markup, then hands back plain HTML. Every
// picture is inlined by prepareExportImages (src/export/images.js), so a saved
// file keeps working with no connection at all.
export { unembeddableImageFallback };

// Mounts + renders + embeds into el.printRoot and leaves it mounted (unlike
// prepareExportHtml, which serializes it to a string and tears it down).
// The .docx builder needs the live DOM — real <img>/<svg> elements it can
// rasterize with their actual pixel dimensions — not a string it would have
// to re-parse, so it shares this step and calls finishExportRoot() itself
// once it's done reading the DOM.
export async function prepareExportRoot(bodyHtml, { mode = "html" } = {}) {
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
  const failedImageCount = await prepareExportImages(el.printRoot, { mode });
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
//
// The chosen look (src/export/themes.js) is a class on the wrapper, styled by
// styles/82-export-themes.css, which is inlined with everything else.
export async function wrapStandaloneHtmlDocument(bodyHtml, title, { theme = loadExportTheme() } = {}) {
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
<div class="flat-export-document export-root ${exportThemeClass(theme)}">
${bodyHtml}
</div>
</body>
</html>`;
}
