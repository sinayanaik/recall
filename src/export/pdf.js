// Print/PDF export: the Cornell card layout, the flat layout, and the notes
// document — plus the stylesheet each needs inlined, since a print window has
// no access to the app's own.

import { cardStatusLabel } from "../cards/card-status.js?v=__BUILD__";
import { afterPaint } from "../cards/question-fit.js?v=__BUILD__";
import { syncResults, uncategorizedCards } from "../cards/study.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { notesForExport } from "./notes-body.js?v=__BUILD__";
import { ensureMermaid } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { exportBaseName, formatCardList, normalizeCardStatus } from "./markdown.js?v=__BUILD__";
import { installPdfPrintStyle, printPreparedDocument, revealPrintRootClozes } from "./run.js?v=__BUILD__";
import { notesExportBlock } from "../import/parse-cards.js?v=__BUILD__";
import { collectDeckHighlightsForExport } from "../panels/highlights-panel.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { deckSnapshot } from "../storage/deck-snapshot.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";
import { configureMermaid, currentThemeId } from "../ui/theme.js?v=__BUILD__";

export function cardsForScope(scope) {
  syncResults();
  if (scope === "known") return state.results.known;
  if (scope === "review") return state.results.review;
  if (scope === "uncategorized") return uncategorizedCards();
  return state.masterCards.length ? state.masterCards : state.cards;
}

export function exportMarkdown(scope = "all") {
  const cards = cardsForScope(scope);
  const title = scope === "known" ? "Known" : scope === "review" ? "Review" : scope === "uncategorized" ? "Uncategorized" : "All Cards";
  const uncategorized = uncategorizedCards();
  const output = [
    `# ${state.deckTitle || "Flashcard Export"}`,
    "",
    `Category: ${state.deckCategory || defaultDeckCategory}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    formatCardList(title, cards),
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Known", state.results.known) : null,
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Review", state.results.review) : null,
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Uncategorized", uncategorized) : null,
    scope === "all" && notesForExport().trim() ? "" : null,
    scope === "all" && notesForExport().trim() ? notesExportBlock(notesForExport()) : null
  ].filter((line) => line !== null).join("\n");

  const blob = new Blob([output], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportBaseName(scope)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${title.toLowerCase()} as Markdown.`);
}

export function exportJson() {
  if (!state.masterCards.length && !notesForExport().trim()) {
    setStatus("No cards to export.", "error");
    return;
  }

  const blob = new Blob([`${JSON.stringify(deckSnapshot(), null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportBaseName("all")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported all cards and markers as JSON.");
}


export function scopeTitle(scope = "all") {
  if (scope === "known") return "Known Cards";
  if (scope === "review") return "Review Cards";
  if (scope === "uncategorized") return "Uncategorized Cards";
  return "All Cards";
}

export function closePrintPreview() {
  printPreviewOpen = false;
  el.printRoot.classList.remove("is-preparing", "is-preview");
  el.printRoot.innerHTML = "";
  el.printRoot.setAttribute("aria-hidden", "true");
  document.querySelector(`#${pdfPrintStyleId}`)?.remove();
  if (printTitleBeforeExport) document.title = printTitleBeforeExport;
  setPrintTitleBeforeExport("");
  unlockPageScroll();
}

export function cardOrdinalLabel(index) {
  return `Q${index + 1}`;
}

export function isPrintDeckDivider(entry) {
  return entry?.type === "deck-divider";
}

export function printableCardCount(entries = []) {
  return entries.filter((entry) => !isPrintDeckDivider(entry)).length;
}

export function cornellDeckDividerHtml(entry) {
  return `
    <article class="cornell-print-deck-divider">
      <span>Deck</span>
      <h2>${escapeHtml(entry.title || "Untitled")}</h2>
      <p>Category: ${escapeHtml(normalizeDeckCategory(entry.category))}</p>
    </article>
  `;
}

export function cornellCardHtml(card, index, { answerVisible = false, print = false, statusById = state.statusById } = {}) {
  const status = normalizeCardStatus(statusById[card.id] || card.status);
  const statusLabel = cardStatusLabel(status);
  const rowClass = print ? "cornell-print-row" : "all-card cornell-card";
  const openClass = answerVisible ? " is-flipped" : "";
  const idAttr = print ? "" : ` data-card-id="${escapeHtml(card.id)}" data-status="${escapeHtml(status)}" data-answer-rendered="${answerVisible ? "true" : "false"}"`;
  const draggableAttr = print ? "" : ` tabindex="0" draggable="true"`;
  const answerHtml = answerVisible ? markdownToSafeHtml(card.answer) : "";
  // Use clean class names for print — strip interactive all-card-* classes that have display:none rules
  const questionClass = print ? "cornell-question-rail" : "cornell-question-rail all-card-question";
  const answerClass = print ? "cornell-answer-cell" : "cornell-answer-cell all-card-answer";

  return `
    <article class="${rowClass}${openClass}"${idAttr}${draggableAttr}>
      <aside class="${questionClass}">
        <span class="cornell-row-number">${cardOrdinalLabel(index)}</span>
        <div class="rendered">${markdownToSafeHtml(card.question)}</div>
      </aside>
      <section class="${answerClass}">
        <div class="cornell-row-head">
          ${print ? "" : `<span class="all-card-status-label cornell-status" data-all-status-label data-status="${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>`}
          ${print ? "" : `
            <div class="all-card-actions" aria-label="Card controls">
              <button class="all-card-goto" type="button" data-all-goto title="Go to card in main view" aria-label="Go to card in main view">&#128065;</button>
              <button class="all-card-add" type="button" data-all-add-after title="Insert card after this one" aria-label="Insert card after this one">+</button>
              <button class="all-card-edit" type="button" data-all-edit-current title="Edit question" aria-label="Edit question">&#9998;</button>
              <button class="all-card-review" type="button" data-all-status="review">Review</button>
              <button class="all-card-known" type="button" data-all-status="known">Known</button>
              <button class="all-card-delete" type="button" data-all-delete title="Delete card" aria-label="Delete card">&#128465;</button>
            </div>
          `}
        </div>
        <div class="cornell-answer-body rendered">${answerHtml}</div>
        ${print ? "" : `<div class="cornell-answer-cue">Tap row to ${answerVisible ? "hide" : "show"} answer</div>`}
      </section>
    </article>
  `;
}

export function buildCornellPrintDocument(title, cards, scope, options = {}) {
  const total = printableCardCount(cards);
  const sourceTitle = options.sourceTitle || state.deckTitle || state.sourceTitle || "Recall";
  const statusById = options.statusById || state.statusById;
  let cardIndex = 0;
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(sourceTitle)}</h1>
          <p>${total} ${total === 1 ? "card" : "cards"} · ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section class="cornell-print-table" aria-label="${escapeHtml(title)} Cornell notes">
        ${cards.map((entry) => {
          if (isPrintDeckDivider(entry)) return cornellDeckDividerHtml(entry);
          const html = cornellCardHtml(entry, cardIndex, { answerVisible: true, print: true, statusById });
          cardIndex += 1;
          return html;
        }).join("\n")}
      </section>
    </div>
  `;
}

// ── Standalone HTML export ──────────────────────────────────────────────
// A Cornell layout built from <table> (not flex/grid) so the same markup
// reads fine both as a self-contained HTML file and — for the .docx export
// further below, which shares this same rendering step — inside a real
// Word document. Math/Mermaid/Nomnoml are baked to static markup by
// rendering off-screen in el.printRoot first, same as the Cornell PDF flow,
// so the exported file needs no JS to display right.
export let cachedExportStylesheetCss = null;

export async function fetchExportStylesheetCss() {
  if (cachedExportStylesheetCss != null) return cachedExportStylesheetCss;
  const hrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).map((link) => link.href);
  const chunks = await Promise.all(hrefs.map(async (href) => {
    try {
      const response = await fetch(href);
      if (!response.ok) return "";
      return await response.text();
    } catch (error) {
      console.warn("Could not inline stylesheet for standalone export:", href, error);
      return "";
    }
  }));
  cachedExportStylesheetCss = chunks.join("\n");
  return cachedExportStylesheetCss;
}

// Only feeds the standalone HTML export (the .docx export builds its own
// WordprocessingML further below and never touches this CSS) — a real
// browser resolves var(...) fine, so this stays var()-based rather than
// baking in literal colors.
export function exportExtraCss() {
  return `
    html, body { margin: 0; background: var(--bg, #eef2f2); color: var(--text, #17201c); }
    body { padding: 24px; font-family: var(--app-font-family, Arial, Helvetica, sans-serif); }
    .flat-export-document { max-width: 900px; margin: 0 auto; }
    .flat-export-cover { margin-bottom: 24px; border-bottom: 2px solid var(--line, #b9c9c5); padding-bottom: 12px; }
    .flat-export-cover h1 { margin: 0 0 6px; font-size: 1.6em; }
    .flat-export-cover p { margin: 0; color: var(--muted, #56645f); }
    .flat-export-notes { padding-top: 4px; }
    .flat-export-divider { margin: 20px 0; }
    .flat-export-divider td {
      border: 1px dashed var(--line, #b9c9c5);
      border-radius: 10px;
      padding: 10px 14px;
      text-align: center;
    }
    .flat-export-divider span { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted, #56645f); }
    .flat-export-divider h2 { margin: 4px 0; }

    /* Cornell-style two-column card, built as a <table> (not flex/grid) so
       Word's HTML filter — which drops modern layout CSS — still renders the
       question/answer columns side by side instead of stacking them. */
    table.cornell-flat-row {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      margin-bottom: 18px;
      border: 2px solid var(--line, #b9c9c5);
      page-break-inside: avoid;
    }
    .cornell-flat-question, .cornell-flat-answer { padding: 14px 16px; vertical-align: top; }
    .cornell-flat-question {
      width: 34%;
      background: var(--panel-2, #f0eee7);
      border-right: 2px solid var(--line, #b9c9c5);
      font-weight: 700;
    }
    .cornell-flat-answer { background: var(--card, #ffffff); }
    .cornell-flat-row-number {
      display: inline-block;
      min-width: 20px;
      padding: 2px 7px;
      margin-bottom: 8px;
      border: 1px solid var(--accent, #16796c);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      color: var(--accent-strong, #0d5e53);
    }
    .flat-export-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
      color: var(--muted, #56645f);
      margin-bottom: 6px;
    }

    /* Rendered markdown prose (questions/answers/notes). */
    .rendered { color: var(--text, #17201c); }
    /* Headings are NOT flattened here. This block is appended after the whole
       inlined styles.css, so it wins — and it used to force every level to
       --text with one margin, which erased the colour/weight/underline ladder
       that tells h1 from h5 (see the .rendered heading block in styles.css).
       The theme variables the ladder reads are inlined into the export too, so
       there is nothing left for this to fix; only the fallback colour for a
       viewer whose CSS variables somehow did not come through is restated, and
       only where styles.css itself uses --text. */
    .rendered h2, .rendered h4 { color: var(--text, #17201c); }
    .rendered p { margin: 0 0 0.6em; }
    .rendered ul, .rendered ol { margin: 0 0 0.6em; padding-left: 1.4em; }
    /* Kept in step with .rendered blockquote in styles.css — a quote reads as a
       tinted container, not as emphasised text. */
    .rendered blockquote { margin: 0 0 0.6em; padding: 0.6em 12px; border-left: 3px solid var(--accent, #16796c); border-radius: 0 6px 6px 0; background: color-mix(in srgb, var(--accent, #16796c) 6%, transparent); color: var(--muted, #56645f); }
    .rendered a { color: var(--accent-strong, #0d5e53); }
    .rendered code { background: var(--panel-2, #f0eee7); padding: 1px 5px; border-radius: 4px; font-family: "Courier New", monospace; }
    .rendered pre { background: var(--panel-2, #f0eee7); border: 1px solid var(--line, #b9c9c5); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
    .rendered pre code { background: none; padding: 0; }
    .rendered table { border-collapse: collapse; width: 100%; margin: 0 0 0.6em; }
    .rendered th, .rendered td { border: 1px solid var(--line, #b9c9c5); padding: 6px 8px; }
    img { max-width: 100%; }
    .export-image-fallback {
      display: inline-block;
      padding: 3px 10px;
      border: 1px dashed var(--line, #b9c9c5);
      border-radius: 6px;
      color: var(--accent-strong, #0d5e53);
      text-decoration: none;
    }
  `;
}

export async function buildExportStyleTag() {
  const css = await fetchExportStylesheetCss();
  return `<style>${css}\n${exportExtraCss()}</style>`;
}

// Table-based Cornell layout for HTML/Word export — a real <table> (not the
// flex .cornell-question-rail/.cornell-answer-cell the app and PDF print use)
// so the question/answer columns still sit side by side once Word's HTML
// filter strips out anything it doesn't understand.
export function cornellFlatCardHtml(card, index, { statusById = state.statusById } = {}) {
  const status = normalizeCardStatus(statusById[card.id] || card.status);
  const statusLabel = cardStatusLabel(status);
  return `
    <table class="cornell-flat-row" cellspacing="0" cellpadding="0">
      <tr>
        <td class="cornell-flat-question">
          <span class="cornell-flat-row-number">${cardOrdinalLabel(index)}</span>
          <div class="rendered">${markdownToSafeHtml(card.question)}</div>
        </td>
        <td class="cornell-flat-answer">
          <span class="flat-export-label">${escapeHtml(statusLabel)}</span>
          <div class="rendered">${markdownToSafeHtml(card.answer)}</div>
        </td>
      </tr>
    </table>
  `;
}

export function cornellFlatDeckDividerHtml(entry) {
  return `
    <table class="flat-export-divider" cellspacing="0" cellpadding="0" width="100%">
      <tr><td>
        <span>Deck</span>
        <h2>${escapeHtml(entry.title || "Untitled")}</h2>
        <p>Category: ${escapeHtml(normalizeDeckCategory(entry.category))}</p>
      </td></tr>
    </table>
  `;
}

export function buildCornellFlatDocument(title, cards, options = {}) {
  const total = printableCardCount(cards);
  const sourceTitle = options.sourceTitle || state.deckTitle || state.sourceTitle || "Recall";
  const statusById = options.statusById || state.statusById;
  let cardIndex = 0;
  const cardsHtml = cards.map((entry) => {
    if (isPrintDeckDivider(entry)) return cornellFlatDeckDividerHtml(entry);
    const html = cornellFlatCardHtml(entry, cardIndex, { statusById });
    cardIndex += 1;
    return html;
  }).join("\n");
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(sourceTitle)}</h1>
      <p>${escapeHtml(title)} &middot; ${total} ${total === 1 ? "card" : "cards"} &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="cornell-flat-cards" aria-label="${escapeHtml(title)} cards">
      ${cardsHtml}
    </section>
  `;
}

export function buildNotesExportBody(title, notesMarkdown) {
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(title)}</h1>
      <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="flat-export-notes rendered">
      ${markdownToSafeHtml(notesMarkdown)}
    </section>
  `;
}

// Notes have no Cornell table (no fixed question/answer columns), so unlike
// the card PDF they just flow as regular paragraphs — the layout that was
// splitting oddly across pages for cards was the fixed-height Cornell rows,
// which don't apply here.
export function buildNotesPrintDocument(title, notesMarkdown) {
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section class="rendered" aria-label="${escapeHtml(title)} notes">
        ${markdownToSafeHtml(notesMarkdown)}
      </section>
    </div>
  `;
}

// One highlight's export markup: its own `contextLines` of surrounding
// source (see collectDeckHighlightsForExport), the highlighted line itself
// (mark colours intact), and its note if it has one. Shared by the Markdown/
// HTML body and the print document — the two differ only in the wrapper
// around a list of these.
//
// `data-color` carries the highlight's own colour through to a left-border
// accent (styles/28-export-highlights.css) — the main "no segregation
// between highlights" complaint: a flat wall of unstyled paragraphs read as
// one undifferentiated block, with nothing marking where one highlight ends
// and the next begins.
function highlightExportEntryHtml(item, groupedByPage = false) {
  const context = (units) => units.map((u) => `<p class="highlight-export-context">${markdownToSafeHtml(u)}</p>`).join("");
  const note = item.note
    ? `<div class="highlight-export-note"><p class="highlight-export-note-label">Note</p>${markdownToSafeHtml(item.note)}</div>`
    : "";
  // A page number, for a highlight that came off a PDF's Document surface.
  // Its equivalent of the chapter heading above — the difference being that a
  // page is per-highlight rather than per-run, so it rides on the entry itself
  // rather than being drawn once when it changes.
  // ...unless the list is already GROUPED by page, in which case a page number
  // on every entry under a "Page 8" heading is the noisy, un-toggleable
  // repetition the chapter heading above exists to avoid.
  const page = item.page && !groupedByPage
    ? `<p class="highlight-export-page">p. ${escapeHtml(String(item.page))}</p>`
    : "";
  return `
    <div class="highlight-export-entry" data-color="${escapeHtml(item.color)}">
      ${page}
      ${context(item.before)}
      <div class="highlight-export-mark rendered">${markdownToSafeHtml(item.markdown)}</div>
      ${context(item.after)}
      ${note}
    </div>
  `;
}

// A chapter/section heading (see notes/chapters.js headingForOffset) drawn
// once, the first time a highlight from under it appears — not repeated per
// highlight, which would be exactly the noisy, un-toggleable version the
// user didn't want. Only inserted when `item.chapter` is truthy: null means
// either the "include chapter" toggle is off (collectDeckHighlightsForExport
// then returns chapter: null for everything) or this highlight sits before
// the note's first heading — both cases correctly render as "no heading
// here" rather than a misleading "Untitled section" filler.
//
// `groupByPage` is the same rule one axis along, for a PDF deck: a "Page 8"
// heading drawn once, the first time a highlight from page 8 appears. The items
// already arrive in documentHighlightsInReadingOrder() order — page, then down
// the page — so there is nothing to sort, and it is what turns a flat list of
// passages into something shaped like the paper it came out of.
function highlightsExportBodyHtml(items, { groupByPage = false, emptyLabel = "No highlights in this deck." } = {}) {
  if (!items.length) return `<p class="flat-export-empty">${escapeHtml(emptyLabel)}</p>`;
  let lastChapter = null;
  let lastPage = null;
  return items.map((item) => {
    let headingHtml = "";
    if (groupByPage && item.page && item.page !== lastPage) {
      lastPage = item.page;
      headingHtml = `<h2 class="highlight-export-page-heading">Page ${escapeHtml(String(item.page))}</h2>`;
    }
    if (item.chapter && item.chapter !== lastChapter) {
      lastChapter = item.chapter;
      headingHtml += `<h2 class="highlight-export-chapter-heading">${escapeHtml(item.chapter)}</h2>`;
    }
    return headingHtml + highlightExportEntryHtml(item, groupByPage);
  }).join("");
}

// `options`: { contextLines, includeChapter, includeNotes } — the export
// dialog's own keep-or-drop toggles (src/export/run.js), threaded straight
// through to collectDeckHighlightsForExport.
// Wrapped in .highlights-export-page — unlike the flat notes/Cornell export
// bodies (which deliberately carry the theme active at export time, straight
// through exportExtraCss's live-theme tokens), this content is styled with
// the fixed --print-* palette throughout (styles/28-export-highlights.css /
// 29-print-safe-rendered.css) so it looks the same whether it lands in the
// PDF/print path (already print-safe end to end via .cornell-print-document)
// or the standalone HTML/docx path (which otherwise inlines the LIVE theme
// for everything around it) — without this wrapper, the highlight cards'
// fixed light styling would sit on a page background that could be dark.
export function buildHighlightsExportBody(title, options = {}) {
  const items = collectDeckHighlightsForExport(options);
  return `
    <div class="highlights-export-page">
      <header class="flat-export-cover">
        <h1>${escapeHtml(title)}</h1>
        <p>Highlights &middot; ${new Date().toLocaleString()}</p>
      </header>
      <section class="flat-export-notes rendered highlights-export-body">
        ${highlightsExportBodyHtml(items, options)}
      </section>
    </div>
  `;
}

// Plain markdown, not an HTML fragment — the highlight's own markdown (mark
// tags and all, same as how "Export Notes" markdown carries state.notes'
// own <mark> tags unwrapped) plus its context/note as ordinary lines,
// entries separated by a thematic break. A chapter/section change gets its
// own `## Heading` — same "draw it once, not per entry" rule as the HTML
// path above, using ## rather than # so it nests under the document's own
// # title instead of competing with it.
export function buildHighlightsExportMarkdown(title, options = {}) {
  const items = collectDeckHighlightsForExport(options);
  if (!items.length) return `# ${title}\n\nNo highlights in this deck.\n`;
  const blocks = [];
  let lastChapter = null;
  let lastPage = null;
  items.forEach((item) => {
    if (options.groupByPage && item.page && item.page !== lastPage) {
      lastPage = item.page;
      blocks.push(`## Page ${item.page}`);
    }
    if (item.chapter && item.chapter !== lastChapter) {
      lastChapter = item.chapter;
      blocks.push(`## ${item.chapter}`);
    }
    const lines = [...item.before, item.markdown, ...item.after];
    if (item.page && !options.groupByPage) lines.unshift(`*p. ${item.page}*`);
    if (item.note) lines.push(`> **Note:** ${item.note.replace(/\n/g, "\n> ")}`);
    blocks.push(lines.join("\n\n"));
  });
  return `# ${title}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

export function buildHighlightsPrintDocument(title, options = {}) {
  const items = collectDeckHighlightsForExport(options);
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Highlights &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section class="rendered highlights-export-body" aria-label="${escapeHtml(title)} highlights">
        ${highlightsExportBodyHtml(items, options)}
      </section>
    </div>
  `;
}

// The bulk (multi-deck) counterpart of buildNotesExportBody/buildNotesPrintDocument
// — used when a bulk export picks "Notes". `sections` is [{ title, category, notes }];
// a single section renders exactly like the single-deck body, multiple sections get
// the same deck-divider treatment the cards PDF already uses between decks.
export function notesFlatSectionsHtml(sections) {
  if (sections.length === 1) {
    return `<div class="rendered">${markdownToSafeHtml(sections[0].notes || "*No notes for this deck.*")}</div>`;
  }
  return sections.map((section) => `
    ${cornellDeckDividerHtml({ title: section.title, category: section.category })}
    <div class="rendered">${markdownToSafeHtml(section.notes || "*No notes for this deck.*")}</div>
  `).join("");
}

export function buildNotesFlatDocument(title, sections) {
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(title)}</h1>
      <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="flat-export-notes">
      ${notesFlatSectionsHtml(sections)}
    </section>
  `;
}

export function buildNotesFlatPrintDocument(title, sections) {
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section aria-label="${escapeHtml(title)} notes">
        ${notesFlatSectionsHtml(sections)}
      </section>
    </div>
  `;
}

export let printTitleBeforeExport = "";

// Setter: an imported binding is read-only, and the export entry points in main.js stash the deck title around a print.
export function setPrintTitleBeforeExport(value) {
  printTitleBeforeExport = value;
}

export let printPreviewOpen = false;

export const pdfPrintStyleId = "pdfPrintStyle";

// Bulk counterpart of exportNotesPdf() — combines every selected deck's notes
// into one print-preview document instead of the single active deck's own.
export async function exportNotesFlatPdf(payloads, { fileBaseName, title }) {
  const sections = payloads.map((payload) => ({
    title: payload.deck.title || "Untitled",
    category: payload.deck.category,
    notes: payload.deck.notes || ""
  }));
  if (!sections.some((section) => section.notes.trim())) {
    setStatus("No notes to export as PDF.", "error");
    return;
  }

  setStatus(`Preparing ${title} notes PDF...`);
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = fileBaseName;
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesFlatPrintDocument(title, sections);
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
      ? `Opening ${title} notes PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the notes PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("Notes PDF export failed", error);
    setStatus("Could not prepare the notes PDF export.", "error");
  } finally {
    closePrintPreview();
  }
}
