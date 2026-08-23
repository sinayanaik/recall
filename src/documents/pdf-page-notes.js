// A note attached to a PDF highlight, said on the page.
//
// The notes view answers half of this question — src/notes/highlight-badges.js
// puts a numbered badge on every annotated highlight, which says a note is there
// and opens it when pressed — and it opens with the reason: the annotation for a
// sentence on page 3 sits four hundred paragraphs below the sentence, and until
// you touch the highlight there is nothing on screen to say the note exists at
// all.
//
// This is the other half, and the case for it is stronger on a paper than in a
// note. A badge tells you a note is there; it does not let you READ a page's
// worth of them without pressing each one in turn. That is exactly what someone
// re-reading a paper they annotated last week wants, and it is why this mode
// survived the printed-notes mode being taken out of the notes view: it prints
// under a PAGE, not into the text, so it interrupts nothing.
//
// The distance is worse on a paper, not better. A PDF highlight's note lives in the same
// "## Highlight Notes" section of the deck's markdown (see pdf-highlights.js),
// which is a different TAB from the one the reader is looking at.
//
// So the same two layers, in the same two kinds:
//
//   1. ALWAYS ON — an annotated highlight is marked as annotated: a small
//      numbered badge pinned to its first quad. It says "there is something
//      here"; pressing it opens the note, exactly as tapping the highlight does.
//   2. OPT-IN — every note is numbered in reading order and PRINTED under the
//      page it belongs to. Toggled from the document ⋯ menu and remembered
//      across sessions.
//
// ── Why a sibling of the page, and not a margin or an overlay ──────────────
//
// A .pdf-page is a fixed-size box, and every highlight quad on it is a
// coordinate INTO that box (pdf-selection.js converts through the live
// viewport). Anything that changed a page's height would move every anchor on
// it. And a margin rail — the obvious answer on a laptop — has nowhere to go on
// a phone, where fit-width means the page IS the width of the screen.
//
// A block inserted after the page in #documentView costs the page nothing (that
// scroller is already `display: flex; flex-direction: column`), reads the same
// at 360px as at 1440px, and leaves the position tracking correct because
// currentDocumentPage() and isPageNearViewport() both read live offsetTop.
//
// ── Why the numbers come from the records ─────────────────────────────────
//
// Same rule highlight-badges.js states for the same reason: numbering has
// to come from the source, never from DOM order. The document view is
// virtualized — only pages near the viewport carry a canvas at all — so a
// counter that walked what happens to be rendered would hand out 1, 2, 3 for
// whichever pages were on screen and renumber the lot on every scroll.
// documentHighlightsInReadingOrder() is already page-then-down-the-page order,
// which is exactly the order a reader would number them in.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hash32 } from "../core/text.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { readHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import {
  DOCUMENT_NOTE_HANDLERS,
  documentHighlightLabel,
  documentHighlightNote,
  documentHighlightsInReadingOrder
} from "./pdf-highlights.js?v=__BUILD__";
import { quadToPageBox } from "./pdf-selection.js?v=__BUILD__";
import {
  currentDocumentPage,
  currentDocumentRatio,
  pdfPageElement,
  pdfPageViewport,
  scrollToDocumentPage
} from "./pdf-view.js?v=__BUILD__";

export const PDF_PAGE_NOTES_KEY = "recall:pdfPageNotes";

export const BADGE_LAYER_CLASS = "pdf-badge-layer";

export const NOTE_BADGE_CLASS = "pdf-note-badge";

export const PAGE_NOTES_CLASS = "pdf-page-notes";

// How much of a note goes in the badge's tooltip. Enough to recognise which note
// it is without opening it; not so much that the tooltip is the note.
export const BADGE_TITLE_CHARS = 90;

let pageNotesOn = false;

export function isPdfPageNotesOn() {
  return pageNotesOn;
}

// Seeded by main.js at startup, the same shape as FOCUS_MODE_KEY: an imported
// binding is read-only, so the flag needs a setter of its own.
export function setPdfPageNotesFlag(value) {
  pageNotesOn = Boolean(value);
}

export function readPdfPageNotesPreference() {
  try {
    return localStorage.getItem(PDF_PAGE_NOTES_KEY) === "1";
  } catch (_) {
    return false;
  }
}

// ── The index ───────────────────────────────────────────────────────────────

// Every annotated highlight, in reading order, with the number it is shown as.
// Rebuilt on demand rather than memoized: it is one pass over an array that is
// tens of entries long even for a heavily marked-up paper, and the note text it
// reads comes from state.notes, which any edit anywhere can replace.
export function annotatedDocumentHighlights() {
  // ONE parse for the whole list, not one per record — the same hoist
  // collectHighlightEntries and documentHighlightEntries already make, and the
  // note on both of them says why: documentHighlightNote(id) re-reads the fenced
  // block out of state.notes on every call, so asking it per record is quadratic
  // in how many highlights a paper has.
  //
  // This one mattered most and was the one missed. It runs from the page-painted
  // hook by way of paintPageNoteBadges, so the cost was paid again for every
  // page the reader scrolled past: measured on a 4-page paper at 3.9ms per four
  // pages with 25 annotated highlights and 312ms with 300, which is what
  // "rendering and scrolling became hella slow" is made of.
  const notes = readHighlightNotes(state.notes || "");
  const out = [];
  documentHighlightsInReadingOrder().forEach((record) => {
    const note = notes.get(record.id) || "";
    if (!note) return;
    out.push({ record, note, n: out.length + 1 });
  });
  return out;
}

// ── What a page's notes currently ARE, as one short string ────────────────
//
// Both painters below rebuild their DOM from scratch, and both are called for
// every page in the document on every highlight change. That was affordable
// when a highlight change meant a highlight being made or deleted; it is not
// when it means a keystroke pause in the note editor, which is what
// notifyHighlightsChanged had become (see setDocumentHighlightNote). Tearing
// down and re-creating every printed page of notes while somebody is typing
// into one of them is "the whole PDF rendering gets refreshed", and it moves the
// reader every time it happens.
//
// So each painter records what it drew and skips a page whose answer has not
// moved. The signature has to cover everything that is rendered: which
// highlights, in what order, with what NUMBER (a note added on page 2 renumbers
// every note after it), and what the note says.
function pageNotesSignature(entries) {
  return entries
    .map(({ record, note, n }) => `${n}:${record.id}:${record.color || ""}:${hash32(documentHighlightLabel(record))}:${hash32(note)}`)
    .join("|");
}

function openNoteFor(record, anchorEl) {
  const rect = anchorEl?.getBoundingClientRect?.() || null;
  openHighlightNoteEditor(record.id, rect, documentHighlightNote(record.id), DOCUMENT_NOTE_HANDLERS);
}

// ── Layer 1: the badges ─────────────────────────────────────────────────────
//
// Its own layer, above the text layer rather than in the mark layer. The mark
// layer carries `pointer-events: none` and must keep it — the text layer sits
// over it and every pointer event has to reach that, or selection stops working
// over a highlight (see pdf-highlights.js). A badge has to be pressable, so it
// goes in a layer of its own, which is also `pointer-events: none` except for
// the badges themselves: ~16px per annotated highlight is the entire cost to
// selection on the page.
export function paintPageNoteBadges(pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return;
  let layer = pageEl.querySelector(`.${BADGE_LAYER_CLASS}`);
  const annotated = annotatedDocumentHighlights()
    .filter(({ record }) => (record.quads || []).some((quad) => quad.page === pageNumber));
  if (!annotated.length) {
    layer?.remove();
    return;
  }
  // Only once the page has actually rendered: a placeholder has no viewport, so
  // quadToPageBox has nothing to convert against and every badge would land at
  // the origin. renderPage calls back in here once it does.
  if (!pageEl.querySelector(".pdf-text-layer")) {
    layer?.remove();
    return;
  }
  // The SCALE is part of the signature, and it has to be. A badge is placed by
  // quadToPageBox, which converts through the live viewport — so every badge on
  // the page belongs to the zoom it was painted at. stalePageForRelayout drops
  // the mark and text layers on a zoom precisely because their coordinates are
  // in the old scale; the badge layer is not its to drop (that constant lives
  // here, and pdf-view.js importing this module back would close a cycle), so
  // the layer survives a relayout and the guard would happily skip repainting it
  // at the new one. Naming the scale is what makes "nothing has changed" true.
  const signature = `${pdfPageViewport(pageNumber)?.scale || 0}#${pageNotesSignature(annotated)}`;
  if (layer && layer.dataset.signature === signature) return;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = BADGE_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  layer.dataset.signature = signature;
  layer.innerHTML = "";
  const frag = document.createDocumentFragment();
  annotated.forEach(({ record, note, n }) => {
    const quad = (record.quads || []).find((entry) => entry.page === pageNumber);
    const box = quad ? quadToPageBox(quad) : null;
    if (!box) return;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = NOTE_BADGE_CLASS;
    badge.dataset.highlightId = record.id;
    badge.textContent = String(n);
    const flat = note.replace(/\s+/g, " ").trim();
    badge.title = flat.length > BADGE_TITLE_CHARS ? `${flat.slice(0, BADGE_TITLE_CHARS)}…` : flat;
    badge.setAttribute("aria-label", `Note ${n} on this highlight`);
    // Pinned just outside the highlight's top-right corner, so it never covers
    // the words it is about. Clamped to 0 on the left because a highlight that
    // starts in the page's left margin would otherwise put its badge outside the
    // page.
    badge.style.left = `${Math.max(0, box.left + box.width - 8)}px`;
    badge.style.top = `${Math.max(0, box.top - 8)}px`;
    badge.addEventListener("click", (event) => {
      // The document view's own click handler opens the MARK menu for whatever
      // highlight is under the pointer; the badge is a shortcut past that menu
      // straight to the note, so it must not do both.
      event.stopPropagation();
      openNoteFor(record, badge);
    });
    frag.appendChild(badge);
  });
  layer.appendChild(frag);
}

// ── Layer 2: the printed notes ──────────────────────────────────────────────

// The most columns a page's notes are ever packed into. Past four, a note is a
// column of two-word lines and the packing is costing more than it saves.
export const PAGE_NOTES_MAX_COLUMNS = 4;

function noteBlockFor(pageNumber, entries) {
  const block = document.createElement("div");
  block.className = PAGE_NOTES_CLASS;
  block.dataset.pageNumber = String(pageNumber);
  // How many columns this page's notes are ALLOWED, which is not the same
  // question as how many fit.
  //
  // `column-width` alone answers "how many fit", and on a wide page that is four
  // — including for a page with ONE note on it, where multicol cannot split an
  // unbreakable item (break-inside: avoid, and it has to be, or a note's number
  // badge ends up in a different column from its text). The single note would
  // sit in a 260px column with three empty ones beside it: narrower than the
  // full-width row this replaced, which is the opposite of the point.
  //
  // So the count is capped at the number of notes there are to pack. One note
  // gets the whole strip; five get four columns; and the width floor in CSS
  // still collapses that to fewer on a narrow page, with no media query.
  block.style.setProperty("--pdf-note-cols", String(Math.min(entries.length, PAGE_NOTES_MAX_COLUMNS)));
  const head = document.createElement("div");
  head.className = "pdf-page-notes-head";
  head.textContent = `Notes · page ${pageNumber}`;
  block.appendChild(head);
  entries.forEach(({ record, note, n }) => {
    // A button, because the note is EDITABLE from here — the same round trip the
    // badge and the mark menu make. Read-only text would be a third place a note
    // appears and the only one you cannot fix a typo in.
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pdf-page-note";
    row.dataset.highlightId = record.id;
    const number = document.createElement("span");
    number.className = "pdf-page-note-num";
    number.textContent = String(n);
    const body = document.createElement("span");
    body.className = "pdf-page-note-body";
    const excerpt = document.createElement("span");
    excerpt.className = "pdf-page-note-excerpt";
    excerpt.textContent = shortLabel(documentHighlightLabel(record));
    const text = document.createElement("span");
    text.innerHTML = markdownToSafeHtml(note);
    body.append(excerpt, text);
    row.append(number, body);
    row.addEventListener("click", () => openNoteFor(record, row));
    block.appendChild(row);
  });
  return block;
}

function shortLabel(label) {
  const flat = String(label || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 80 ? `“${flat.slice(0, 80).trimEnd()}…”` : `“${flat}”`;
}

// Rebuild every printed block. Cheap by construction: one small block per page
// that has an annotated highlight, which is a handful even for a paper that has
// been read closely — so unlike the pages themselves these are not virtualized,
// and a note is on screen the moment its page is scrolled to rather than a frame
// later.
export function refreshPdfPageNotes() {
  const view = el.documentView;
  if (!view) return;
  const existing = new Map();
  view.querySelectorAll(`.${PAGE_NOTES_CLASS}`).forEach((node) => existing.set(node.dataset.pageNumber, node));
  if (!pageNotesOn || !state.meta?.pdf) {
    existing.forEach((node) => node.remove());
    return;
  }
  const byPage = new Map();
  annotatedDocumentHighlights().forEach((entry) => {
    const page = Number(entry.record.page || entry.record.quads?.[0]?.page || 0);
    if (!page) return;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(entry);
  });
  // ── Only the pages whose notes actually moved ────────────────────────────
  //
  // This used to remove every block and build them all again, which is a
  // markdown render per note and a re-layout of the whole document — on every
  // call, and this is called from notifyHighlightsChanged, which the note editor
  // reaches on every typing pause. That is the visible half of "the whole PDF
  // rendering gets refreshed": the paper below the note you are writing jumping
  // as its blocks are taken out and put back.
  //
  // setDocumentHighlightNote no longer notifies per keystroke (see there), so
  // most of those calls are gone. This is the other half, for the ones that are
  // left: a highlight made or deleted anywhere renumbers the notes after it and
  // so has to reach every page, and almost every page's answer is unchanged.
  let changed = false;
  const anchorPage = currentDocumentPage();
  const anchorRatio = currentDocumentRatio();
  byPage.forEach((entries, pageNumber) => {
    const key = String(pageNumber);
    const previous = existing.get(key);
    existing.delete(key);
    const signature = pageNotesSignature(entries);
    if (previous && previous.dataset.signature === signature) return;
    const pageEl = pdfPageElement(pageNumber);
    if (!pageEl) {
      previous?.remove();
      return;
    }
    const block = noteBlockFor(pageNumber, entries);
    block.dataset.signature = signature;
    changed = true;
    if (previous) previous.replaceWith(block);
    else pageEl.after(block);
  });
  // Whatever is left over is a page that has no annotated highlight any more.
  existing.forEach((node) => {
    node.remove();
    changed = true;
  });
  // A block that changed height moved everything below it, and the reader may be
  // looking at any of that. Same correction applyPdfPageNotes makes around its
  // own rebuild, made here so every caller gets it — and skipped entirely when
  // nothing was rebuilt, which is now the common case.
  if (changed && anchorPage) scrollToDocumentPage(anchorPage, anchorRatio, { smooth: false });
}

// Every page currently on screen, plus the printed blocks. The counterpart of
// repaintDocumentHighlights, and called from the same places — any CRUD on a
// highlight or its note can change a NUMBER, and a number changing means every
// badge after it changes too.
export function repaintPdfPageNotes() {
  const view = el.documentView;
  if (!view) return;
  view.querySelectorAll(".pdf-page[data-page-number]").forEach((page) => {
    const pageNumber = Number(page.dataset.pageNumber);
    if (pageNumber) paintPageNoteBadges(pageNumber);
  });
  refreshPdfPageNotes();
}

// ── The toggle ──────────────────────────────────────────────────────────────

// What the ⋯ menu's row says about this mode — three facts, exactly as
// paintInlineNotesButton publishes them for the notes view's own toggle:
// aria-pressed drives the On/Off switch in CSS, the title is the sentence, and
// the hint is how many notes there are to print (pressing a toggle and seeing
// nothing change is a puzzle; ".is-empty" dims the row rather than disabling it,
// so pressing it still works and still says why nothing happened).
export function paintPdfPageNotesButton() {
  const button = el.documentMoreMenu?.querySelector('[data-document-action="page-notes"]');
  if (!button) return;
  button.setAttribute("aria-pressed", pageNotesOn ? "true" : "false");
  button.title = pageNotesOn
    ? "Hide the notes under the pages — read them from the highlight instead"
    : "Print every highlight's note under the page it is on, numbered";
  const total = state.meta?.pdf ? annotatedDocumentHighlights().length : 0;
  button.classList.toggle("is-empty", total === 0);
  const hint = button.querySelector(".nhm-hint");
  if (!hint) return;
  hint.textContent = total === 0
    ? "No highlight in this document has a note on it yet"
    : `${total} highlight note${total === 1 ? "" : "s"} in this document`;
}

// One path for both ways in, so the button, the stored preference and the DOM
// can never disagree about what "on" means.
//
// The reading position is captured and put back around the rebuild for the
// obvious reason: printing a block under every annotated page moves everything
// below it, and a reader who pressed a toggle should still be looking at the
// page they were looking at.
export function applyPdfPageNotes() {
  paintPdfPageNotesButton();
  // The reading-position correction that used to be spelled out here lives
  // inside refreshPdfPageNotes now, so every caller gets it and not just this
  // one — and so it is skipped on the calls that rebuild nothing.
  refreshPdfPageNotes();
}

export function togglePdfPageNotes() {
  pageNotesOn = !pageNotesOn;
  try {
    localStorage.setItem(PDF_PAGE_NOTES_KEY, pageNotesOn ? "1" : "0");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
  applyPdfPageNotes();
  announcePdfPageNotes();
  return pageNotesOn;
}

// ── Say what the press did ─────────────────────────────────────────────────
//
// "The show inline note button in the PDF is essentially dead."
//
// Half of that was the switch on the row being invisible (see the rule for it
// in styles/37-document-chrome.css); this is the other half. The sheets print
// under the pages that HAVE an annotated highlight, and on a paper being read
// from the front those are usually nowhere near the page on screen — so the
// mode came on, worked perfectly, and changed nothing the reader could see.
//
// So it reports, and when there is something to show that is off screen it goes
// there. Turning the mode OFF says nothing: the sheets vanishing from under the
// page is its own answer, and a toast for it would be noise on every press.
export function announcePdfPageNotes() {
  if (!pageNotesOn) return;
  const annotated = annotatedDocumentHighlights();
  if (!annotated.length) {
    showToast("No highlight in this paper has a note on it yet — write one and it prints under its page");
    return;
  }
  const pages = new Set();
  annotated.forEach(({ record }) => {
    const page = Number(record.page || record.quads?.[0]?.page || 0);
    if (page) pages.add(page);
  });
  const count = annotated.length;
  showToast(`${count} note${count === 1 ? "" : "s"} printed under ${pages.size} page${pages.size === 1 ? "" : "s"}`);
  // Already looking at one? Then the reader has just watched it appear and
  // moving them would be the rude thing to do.
  const here = currentDocumentPage();
  if (pages.has(here)) return;
  const nearest = [...pages].sort((a, b) => Math.abs(a - here) - Math.abs(b - here))[0];
  if (nearest) scrollToDocumentPage(nearest, 0);
}
