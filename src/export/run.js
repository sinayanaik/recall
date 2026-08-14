// The export entry points, and the two ways a PDF actually gets made: the
// browser's own print dialog, or a hidden iframe.
//
// A print window has none of the app's styles, so each document carries its
// own inlined copy — and clozes are revealed before printing, since a masked
// answer on paper is not useful.

import { adjustCornellRows } from "../cards/all-cards.js?v=__BUILD__";
import { afterPaint } from "../cards/question-fit.js?v=__BUILD__";
import { downloadTextFile } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { ensureMermaid } from "../core/lib-loader.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { buildDocxBytes } from "./docx.js?v=__BUILD__";
import { prepareExportHtml, wrapStandaloneHtmlDocument } from "./html.js?v=__BUILD__";
import { exportBaseName, slugifyFileName } from "./markdown.js?v=__BUILD__";
import { buildCornellFlatDocument, buildCornellPrintDocument, buildNotesExportBody, buildNotesPrintDocument, cardsForScope, closePrintPreview, exportJson, exportMarkdown, pdfPrintStyleId, printableCardCount, scopeTitle, setPrintTitleBeforeExport } from "./pdf.js?v=__BUILD__";
import { exportSql } from "./sql.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";

// Appended to the success status when embedImagesAsDataUris couldn't inline
// every image (e.g. a private Drive share or a host that blocks hotlinking),
// so the user knows some images were kept as plain links instead of quietly
// discovering a broken image glyph after opening the file.
export function imageEmbedSuffix(failedImageCount) {
  if (!failedImageCount) return "";
  return ` (${failedImageCount} image${failedImageCount === 1 ? "" : "s"} couldn't be embedded — kept as ${failedImageCount === 1 ? "a link" : "links"})`;
}

export async function exportCardsFlat(scope, format) {
  const cards = cardsForScope(scope);
  const title = scopeTitle(scope);
  if (!printableCardCount(cards)) {
    setStatus(`No ${scope === "review" ? "review" : scope} cards to export.`, "error");
    return;
  }
  const formatLabel = format === "doc" ? "Word" : "standalone HTML";
  setStatus(`Preparing ${title.toLowerCase()} ${formatLabel} export...`);
  el.exportBtn.disabled = true;
  try {
    const docTitle = exportBaseName(scope);
    const rawBodyHtml = buildCornellFlatDocument(title, cards, { sourceTitle: state.deckTitle || state.sourceTitle });
    let failedImageCount;
    if (format === "doc") {
      const result = await buildDocxBytes(rawBodyHtml, docTitle);
      failedImageCount = result.failedImageCount;
      downloadTextFile(result.bytes, `${docTitle}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      const { html: bodyHtml, failedImageCount: htmlFailed } = await prepareExportHtml(rawBodyHtml);
      failedImageCount = htmlFailed;
      const html = await wrapStandaloneHtmlDocument(bodyHtml, docTitle);
      downloadTextFile(html, `${docTitle}.html`, "text/html;charset=utf-8");
    }
    setStatus(`Exported ${title.toLowerCase()} as ${format === "doc" ? "Word (.docx)" : formatLabel}.${imageEmbedSuffix(failedImageCount)}`);
  } catch (error) {
    console.error("Cards export failed", error);
    setStatus("Could not prepare the export.", "error");
  } finally {
    el.exportBtn.disabled = false;
  }
}

export function notesExportBaseName() {
  return `${slugifyFileName(state.deckTitle || state.sourceTitle || "recall")} - notes`;
}

export async function exportNotesFlat(format) {
  const notes = state.notes || "";
  if (!notes.trim()) {
    setStatus("No notes to export.", "error");
    return;
  }
  const title = state.deckTitle || "Notes";
  const docTitle = notesExportBaseName();

  if (format === "markdown") {
    downloadTextFile(`# ${title}\n\n${notes.trim()}\n`, `${docTitle}.md`, "text/markdown;charset=utf-8");
    setStatus("Exported notes as Markdown.");
    return;
  }

  const formatLabel = format === "doc" ? "Word" : "standalone HTML";
  setStatus(`Preparing notes ${formatLabel} export...`);
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = true;
  try {
    const rawBodyHtml = buildNotesExportBody(title, notes);
    let failedImageCount;
    if (format === "doc") {
      const result = await buildDocxBytes(rawBodyHtml, docTitle);
      failedImageCount = result.failedImageCount;
      downloadTextFile(result.bytes, `${docTitle}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      const { html: bodyHtml, failedImageCount: htmlFailed } = await prepareExportHtml(rawBodyHtml);
      failedImageCount = htmlFailed;
      const html = await wrapStandaloneHtmlDocument(bodyHtml, docTitle);
      downloadTextFile(html, `${docTitle}.html`, "text/html;charset=utf-8");
    }
    setStatus(`Exported notes as ${format === "doc" ? "Word (.docx)" : formatLabel}.${imageEmbedSuffix(failedImageCount)}`);
  } catch (error) {
    console.error("Notes export failed", error);
    setStatus("Could not prepare the notes export.", "error");
  } finally {
    if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  }
}

export function markOversizePrintRows() {
  const a4PortraitContentHeightMm = 277;
  const pageHeight = Math.round(a4PortraitContentHeightMm * 96 / 25.4);
  el.printRoot.querySelectorAll(".cornell-print-row").forEach((row) => {
    row.classList.toggle("is-oversize", row.scrollHeight > pageHeight);
  });
}

export function installPdfPrintStyle() {
  let style = document.querySelector(`#${pdfPrintStyleId}`);
  if (!style) {
    style = document.createElement("style");
    style.id = pdfPrintStyleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    @media print {
      @page { size: A4 portrait; margin: 14mm; }

      /* Card layout */
      .cornell-print-document { width: auto !important; border: none !important; box-shadow: none !important; }
      .cornell-print-table { padding: 7mm 0 0 !important; }
      .cornell-print-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        border: 1.5px solid #bbb !important;
        border-radius: 8px !important;
        margin-bottom: 7mm !important;
        overflow: hidden !important;
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .cornell-print-row .cornell-question-rail {
        flex: 0 0 45mm !important;
        width: 45mm !important;
        min-width: 45mm !important;
        border-right: 1.5px solid #bbb !important;
        padding: 5mm !important;
      }
      .cornell-print-row .cornell-answer-cell {
        flex: 1 1 0 !important;
        min-width: 0 !important;
        padding: 5mm 6mm !important;
      }
      .cornell-print-row .rendered { line-height: 1.42 !important; }
      .cornell-print-row .rendered p { margin: 0 0 0.55em !important; }
      .cornell-print-row .rendered p:last-child { margin-bottom: 0 !important; }

      /* Cover header spacing */
      .cornell-print-cover { padding: 0 0 5mm !important; margin-bottom: 3mm !important; }

      /* Clozes: always shown filled-in (never blank) in the exported PDF.
         Bold in the strong accent colour — no italics, no serif switch — so
         the answers stand out clearly without looking faint. */
      .cornell-print-document .cloze,
      .cornell-print-document .cloze.is-revealed {
        color: var(--print-accent-strong) !important;
        font-family: inherit !important;
        font-style: normal !important;
        font-weight: 700 !important;
        background: transparent !important;
        box-shadow: none !important;
        padding: 0 !important;
      }
      .cornell-print-document .cloze * {
        visibility: visible !important;
        color: inherit !important;
        font-weight: 700 !important;
      }
      /* Oversized cards (taller than a page): let them fragment but start on new page */
      .cornell-print-row.is-oversize {
        break-inside: auto !important;
        page-break-inside: auto !important;
        break-before: page;
        page-break-before: always;
      }

      /* Code block light theme for print */
      .cornell-print-row pre,
      .cornell-print-row pre[class*="language-"] {
        background: #f6f8fa !important;
        border: 1px solid #d0d0d0 !important;
        color: #24292e !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }
      .cornell-print-row pre code,
      .cornell-print-row pre code[class*="language-"] {
        color: #24292e !important;
        background: transparent !important;
      }
      .cornell-print-row .token.comment,
      .cornell-print-row .token.prolog,
      .cornell-print-row .token.doctype,
      .cornell-print-row .token.cdata { color: #6a737d !important; font-style: italic !important; }
      .cornell-print-row .token.keyword,
      .cornell-print-row .token.atrule { color: #d73a49 !important; font-weight: bold !important; }
      .cornell-print-row .token.function { color: #6f42c1 !important; }
      .cornell-print-row .token.string,
      .cornell-print-row .token.char,
      .cornell-print-row .token.attr-value { color: #032f62 !important; }
      .cornell-print-row .token.number,
      .cornell-print-row .token.boolean { color: #005cc5 !important; }
      .cornell-print-row .token.operator { color: #d73a49 !important; }
      .cornell-print-row .token.punctuation { color: #24292e !important; }
      .cornell-print-row .token.tag,
      .cornell-print-row .token.selector { color: #22863a !important; }
      .cornell-print-row .token.variable { color: #e36209 !important; }

      /* Tables */
      .cornell-print-row table {
        width: 100% !important;
        border-collapse: collapse !important;
        font-size: 8.5pt !important;
      }
      .cornell-print-row th { background: #f0f0f0 !important; font-weight: bold !important; color: #222 !important; }
      .cornell-print-row th,
      .cornell-print-row td { border: 1px solid #bbb !important; padding: 3px 6px !important; }

      /* Images */
      .cornell-print-row img {
        max-width: 100% !important;
        max-height: 50mm !important;
        object-fit: contain !important;
      }
    }
  `;
}

export function standalonePrintStyles() {
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((link) => `<link rel="stylesheet" href="${escapeHtml(link.href)}">`)
    .join("\n");
  const pdfPrintStyle = document.querySelector(`#${pdfPrintStyleId}`)?.textContent || "";
  return `
    ${links}
    <style>
      html,
      body {
        margin: 0;
        background: var(--print-bg);
        color: var(--print-text);
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      body {
        padding: 0;
      }
      .print-root,
      .print-root.is-preview,
      .print-root.is-preparing {
        position: static !important;
        display: block !important;
        width: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        background: var(--print-bg) !important;
        color: var(--print-text) !important;
        padding: 0 !important;
        box-shadow: none !important;
        print-color-adjust: exact !important;
        -webkit-print-color-adjust: exact !important;
      }
      .cornell-print-document {
        width: auto !important;
        margin: 0 !important;
        box-shadow: none !important;
      }
      .print-preview-actions,
      [data-print-ui] {
        display: none !important;
      }
      @media screen {
        body {
          padding: 10px;
        }
      }
      ${pdfPrintStyle}
    </style>
  `;
}

export function standalonePrintDocumentHtml() {
  const documentNode = el.printRoot.querySelector(".cornell-print-document");
  if (!documentNode) return "";
  return `<!doctype html>
    <html lang="en" data-theme="${escapeHtml(currentThemeId())}">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <base href="${escapeHtml(document.baseURI)}">
        <title>${escapeHtml(document.title || "Recall PDF")}</title>
        ${standalonePrintStyles()}
      </head>
      <body>
        <section class="print-root is-preview" aria-label="Cornell PDF export">
          ${documentNode.outerHTML}
        </section>
        <script>
          (() => {
            const printWhenReady = () => {
              const waitForImages = Promise.all(Array.from(document.images).map((img) => {
                if (img.complete) return Promise.resolve();
                return new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                });
              }));
              Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), waitForImages])
                .then(() => setTimeout(() => window.print(), 250));
            };
            if (document.readyState === "complete") {
              printWhenReady();
            } else {
              window.addEventListener("load", printWhenReady, { once: true });
            }
          })();
        <\/script>
      </body>
    </html>`;
}

export async function generatePdfDirectly() {
  const documentNode = el.printRoot.querySelector(".cornell-print-document");
  if (!documentNode) {
    setStatus("PDF preview is not ready yet.", "error");
    return;
  }

  // Use fast standalone print window — browser print is instant and uses @media print CSS
  openStandalonePrintDocument();
}

export function openStandalonePrintDocument() {
  const html = standalonePrintDocumentHtml();
  if (!html) {
    setStatus("PDF preview is not ready yet.", "error");
    return;
  }

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setStatus("Could not open the print page. Allow pop-ups, then try Print / Save PDF again.", "error");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  setStatus("Opened a dedicated print page. Choose Save as PDF there.");
}

// One-click PDF: print the prepared document through a hidden same-origin iframe
// instead of a pop-up window. The iframe needs no user gesture (so it survives
// the async render step that a pop-up blocker would otherwise kill) and prints
// only its own document. The embedded auto-print script fires window.print()
// once fonts and images settle; we tear the frame down on afterprint.
export function printViaHiddenIframe(html) {
  document.querySelector("#recallPrintFrame")?.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "recallPrintFrame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed; right:0; bottom:0; width:0; height:0; border:0; opacity:0; pointer-events:none;";
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return false;
  }

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    window.setTimeout(() => iframe.remove(), 1000);
  };
  win.addEventListener("afterprint", cleanup, { once: true });
  // Safety net in case afterprint never arrives (some mobile browsers).
  window.setTimeout(cleanup, 120000);

  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

// Serialize the freshly rendered print root and send it straight to the browser
// print dialog — the one-click path shared by every PDF export. Returns false
// when the root isn't ready yet.
export function printPreparedDocument() {
  const html = standalonePrintDocumentHtml();
  if (!html) {
    setStatus("Could not prepare the PDF export.", "error");
    return false;
  }
  return printViaHiddenIframe(html);
}

// Reveal every {{cloze}} in the print root so the exported PDF shows the answers
// filled in rather than as blank redaction bars. Run before measuring rows so
// the revealed text is accounted for in the page layout.
export function revealPrintRootClozes() {
  el.printRoot.querySelectorAll(".cloze").forEach((node) => node.classList.add("is-revealed"));
}

export async function exportCardsPdf(sourceTitle, cards, options = {}) {
  const title = options.title || "All Cards";
  const statusById = options.statusById || {};
  const fileBaseName = slugifyFileName(options.fileBaseName || sourceTitle || "recall");
  const cardCount = printableCardCount(cards);

  if (!cardCount) {
    setStatus("No cards to export as PDF.", "error");
    return;
  }

  setStatus(`Preparing ${sourceTitle} Cornell PDF...`);
  el.exportBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = fileBaseName;

  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, "all", { sourceTitle, statusById });
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
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    markOversizePrintRows();
    const opened = printPreparedDocument();
    setStatus(opened
      ? `Opening ${sourceTitle} Cornell PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("PDF export failed", error);
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
    closePrintPreview();
    el.exportBtn.disabled = false;
  }
}

export async function exportPdf(scope = "all") {
  const cards = cardsForScope(scope);
  const title = scopeTitle(scope);
  if (!cards.length) {
    setStatus(`No ${scope === "review" ? "review" : scope} cards to export.`, "error");
    return;
  }

  setStatus(`Preparing ${title.toLowerCase()} Cornell PDF...`);
  el.exportBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = exportBaseName(scope);
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, scope);
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
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    markOversizePrintRows();
    const opened = printPreparedDocument();
    setStatus(opened
      ? `Opening ${title} Cornell PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("PDF export failed", error);
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
    closePrintPreview();
    el.exportBtn.disabled = false;
  }
}

export function handleExportAction(format, scope) {
  el.exportMenu.hidden = true;
  if (format === "pdf") {
    setStatus("Opening PDF export...");
    window.setTimeout(() => exportPdf(scope), 0);
    return;
  }
  if (format === "json") {
    exportJson();
    return;
  }
  if (format === "sql") {
    exportSql(scope);
    return;
  }
  if (format === "html" || format === "doc") {
    exportCardsFlat(scope, format);
    return;
  }
  exportMarkdown(scope);
}

export async function exportNotesPdf() {
  const notes = state.notes || "";
  if (!notes.trim()) {
    setStatus("No notes to export as PDF.", "error");
    return;
  }
  const title = state.deckTitle || "Notes";

  setStatus("Preparing notes PDF...");
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = notesExportBaseName();
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesPrintDocument(title, notes);
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
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    installPdfPrintStyle();
    const opened = printPreparedDocument();
    setStatus(opened
      ? "Opening notes PDF — choose Save as PDF in the dialog."
      : "Could not prepare the notes PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("Notes PDF export failed", error);
    setStatus("Could not prepare the notes PDF export.", "error");
  } finally {
    closePrintPreview();
    if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  }
}

export function handleExportNotesAction(format) {
  if (el.exportNotesMenu) el.exportNotesMenu.hidden = true;
  if (format === "pdf") {
    setStatus("Opening notes PDF export...");
    window.setTimeout(() => exportNotesPdf(), 0);
    return;
  }
  exportNotesFlat(format);
}
