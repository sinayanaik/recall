// The deck's highlight notes, in the Notes tab, as notes.
//
// ── The report ──────────────────────────────────────────────────────────────
//
// "The highlighted notes are not visible anywhere as continuous, easily
// editable text. They're on the Highlights panel, but that's not a good place to
// edit — I want this in the notes panel itself, as notes."
//
// Both halves were true, and neither was an oversight — they were two correct
// decisions meeting at a case neither had considered.
//
// A highlight's note is stored in a fenced block at the very end of state.notes
// (src/format/highlight-notes.js). src/format/notes-fence.js then slices that
// block off BOTH surfaces that could show it: readerNotesBody() for the rendered
// view, rawEditorValueFor() for the ✎ editor. Its own header says why — on a
// markdown deck the block is machine-managed text appended under the reader's
// own writing, and showing it in the editor mixed the two with nothing between
// them.
//
// On a PDF deck the body is empty, because the PDF is the document. So slicing
// the block off leaves NOTHING: an empty Notes tab, an empty raw editor, and the
// Highlights panel as the only surface in the app where a note taken on a paper
// can be read or changed. A panel of rows with a ✎ on each is a list of
// annotations; it is not the reader's notes.
//
// ── Why this takes the notes view over rather than rendering into it ────────
//
// The obvious answer — generate a markdown section and let renderNotesView
// render it — cannot carry what this needs. A rendered block has no room for a
// highlight's id, so nothing in the DOM would say which note a click landed on;
// and an id smuggled through as inline HTML still leaves the note BODY as
// ordinary blocks with no boundary between one note and the next.
//
// The other obvious answer — build the section and append it into #notesView
// alongside the rendered blocks — is the one src/notes/inline-highlight-notes.js
// opens by warning about: placeNotesChunks compares a chunk's children against
// the block list it planned, an unplanned top-level sibling breaks that
// comparison for good, and the sweep after it deletes the node anyway.
//
// So for a PDF deck this module owns #notesView outright: renderNotesView hands
// the surface over (through a hook registered in src/main.js, so notes-view.js
// does not import the document subtree) and renderMarkdown is never called on it
// for this deck. The block cache is invalidated on the way in, once, because
// its cache is keyed on (container, source) and a markdown deck whose body
// happens to match the last one would otherwise take the cache-hit fast path and
// leave this DOM on screen.
//
// ── Every highlight, not only the annotated ones ───────────────────────────
//
// The printed page notes (pdf-page-notes.js) list annotated highlights, because
// a page with nothing written on it has nothing to print. Here the opposite is
// right: this is where a note is WRITTEN, so a highlight with no note yet is a
// blank line waiting for one, not something to hide.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hash32 } from "../core/text.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { invalidateRenderedBlockCache } from "../render/block-cache.js?v=__BUILD__";
import { notifyHighlightsChanged } from "../format/highlight-edit.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { NOTE_AUTOSAVE_MS } from "../notes/highlight-note-editor.js?v=__BUILD__";
import {
  documentExcerptLabel,
  documentHighlightLabel,
  documentHighlightNote,
  documentHighlightsInReadingOrder,
  setDocumentHighlightNote
} from "./pdf-highlights.js?v=__BUILD__";

export const DOC_NOTES_CLASS = "doc-notes";

export const DOC_NOTE_CLASS = "doc-note";

// The id of the highlight whose note is open in a textarea, or null. A rebuild
// while one is open would take the words out from under the reader mid-sentence,
// so the rebuild is deferred until the editor closes — see renderDocumentNotes.
let editingId = null;

let noteSaveTimer = 0;

let noteSavedText = "";

// Whether this deck's notes are the document's rather than a markdown body.
export function documentNotesActive() {
  return Boolean(state.meta?.pdf);
}

// ── What is on screen, as one string ──────────────────────────────────────
//
// Same guard, and for the same reason, as pageNotesSignature in
// pdf-page-notes.js: renderNotesViewPinned is called from every path that
// touches a note, and rebuilding a list of every highlight in a paper — one
// markdown render per note — because something unrelated changed is exactly the
// churn the printed notes were just fixed for.
function sectionSignature(records, body) {
  return `${hash32(body)}|${records
    .map((record) => `${record.id}:${record.color || ""}:${hash32(documentHighlightLabel(record))}:${hash32(documentHighlightNote(record.id))}`)
    .join("|")}`;
}

// The anchor a "Go to" needs, in exactly the shape the Highlights panel already
// builds for the same jump (collectDocumentHighlightRows) — scheduleNoteJump's
// document branch reads `pdf` to know it is a document jump and the quads to
// know where on the page to land.
function jumpAnchorFor(record) {
  return {
    pdf: record.anchor || { page: record.page, item: 0, ch: 0 },
    quads: record.quads,
    page: record.page,
    text: documentHighlightLabel(record),
    deckId: state.deckId,
    deckTitle: state.deckTitle
  };
}

// ── One note ────────────────────────────────────────────────────────────────

function paintNoteBody(article, record) {
  const body = article.querySelector(`.${DOC_NOTE_CLASS}-body`);
  if (!body) return;
  const note = documentHighlightNote(record.id);
  body.classList.toggle("is-empty", !note);
  body.innerHTML = note
    ? markdownToSafeHtml(note)
    : "<p class=\"doc-note-placeholder\">Write a note on this highlight…</p>";
}

function noteArticleFor(record) {
  const article = document.createElement("article");
  article.className = DOC_NOTE_CLASS;
  article.dataset.highlightId = record.id;
  article.dataset.color = record.color || "";

  // The words the note is about, and the way back to them. A button, because it
  // does something; the excerpt reads as a quotation either way.
  const excerpt = document.createElement("button");
  excerpt.type = "button";
  excerpt.className = "doc-note-excerpt";
  excerpt.textContent = documentExcerptLabel(documentHighlightLabel(record)) || "This highlight";
  excerpt.title = "Go to this highlight in the document";
  excerpt.addEventListener("click", () => scheduleNoteJump(jumpAnchorFor(record), { patient: true }, { highlightId: record.id }));

  const body = document.createElement("div");
  body.className = `${DOC_NOTE_CLASS}-body`;
  body.tabIndex = 0;
  body.setAttribute("role", "button");
  body.setAttribute("aria-label", "Edit this note");

  article.append(excerpt, body);
  paintNoteBody(article, record);
  return article;
}

// ── Editing, in place ───────────────────────────────────────────────────────
//
// The same contract as the note popup (src/notes/highlight-note-editor.js), and
// deliberately the same constant for the debounce: one write per typing pause
// with { rerender: false } so nothing on screen is rebuilt mid-sentence, one
// undo step for the whole session, and a single repaint when the editor closes.
// What is different is only where the text is typed.
function commitOpenNote({ repaint = true } = {}) {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = 0;
  const id = editingId;
  if (!id) return;
  const area = el.notesView?.querySelector(`.${DOC_NOTE_CLASS}[data-highlight-id="${CSS.escape(id)}"] .doc-note-edit`);
  const article = area?.closest(`.${DOC_NOTE_CLASS}`);
  const text = area ? area.value : null;
  editingId = null;
  if (area) area.remove();
  // Written BEFORE the note is painted back, not after: paintNoteBody reads the
  // note out of state.notes, so repainting first shows the text the reader has
  // just replaced.
  const wrote = text !== null && text !== noteSavedText;
  if (wrote) {
    setDocumentHighlightNote(id, text, { rerender: false });
    noteSavedText = text;
  }
  if (article) {
    article.classList.remove("is-editing");
    const record = documentHighlightsInReadingOrder().find((entry) => entry.id === id);
    if (record) paintNoteBody(article, record);
  }
  // The section's signature has to move with it, or the very next
  // renderNotesViewPinned rebuilds a surface that is already correct.
  restampSignature();
  if (!wrote) return;
  // One notify for the whole editing session: the excerpt on the note, the
  // Highlights panel and the printed page notes all show this text, and none of
  // them needs to see it a word at a time.
  if (repaint) notifyHighlightsChanged();
}

function restampSignature() {
  const root = el.notesView?.querySelector(`:scope > .${DOC_NOTES_CLASS}`);
  if (!root) return;
  root.dataset.signature = sectionSignature(documentHighlightsInReadingOrder(), readerNotesBody(state.notes || ""));
}

function openNoteEditor(article, record) {
  if (editingId === record.id) return;
  commitOpenNote();
  const body = article.querySelector(`.${DOC_NOTE_CLASS}-body`);
  if (!body) return;
  const area = document.createElement("textarea");
  area.className = "doc-note-edit";
  area.spellcheck = false;
  area.value = documentHighlightNote(record.id);
  noteSavedText = area.value;
  editingId = record.id;
  let noteUndoTaken = false;
  article.classList.add("is-editing");
  body.after(area);
  // Sized to what is in it, so a long note is not written through a slot. Re-run
  // on input rather than by CSS, which has no way to measure a textarea.
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${Math.max(72, area.scrollHeight)}px`;
  };
  area.addEventListener("input", () => {
    fit();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      noteSaveTimer = 0;
      if (area.value === noteSavedText) return;
      setDocumentHighlightNote(record.id, area.value, { rerender: false, undo: !noteUndoTaken });
      noteUndoTaken = true;
      noteSavedText = area.value;
    }, NOTE_AUTOSAVE_MS);
  });
  area.addEventListener("blur", () => commitOpenNote());
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    commitOpenNote();
  });
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// ── The surface ─────────────────────────────────────────────────────────────

function pageSectionFor(pageNumber) {
  const section = document.createElement("section");
  section.className = "doc-notes-page";
  section.dataset.pageNumber = String(pageNumber);
  const head = document.createElement("h3");
  head.className = "doc-notes-page-head";
  head.textContent = `Page ${pageNumber}`;
  section.appendChild(head);
  return section;
}

function buildSection(records, body) {
  const root = document.createElement("div");
  root.className = DOC_NOTES_CLASS;
  if (body.trim()) {
    // The reader's own writing, if this deck has any, above the highlights it
    // belongs with. Rendered straight rather than through the block cache: a
    // PDF deck's body is a side note by construction — the paper is the
    // document — so there is no book-sized string here to chunk.
    const own = document.createElement("div");
    own.className = "doc-notes-own";
    own.innerHTML = markdownToSafeHtml(body);
    root.appendChild(own);
  }
  const title = document.createElement("h2");
  title.className = "doc-notes-title";
  title.textContent = "Highlight notes";
  root.appendChild(title);
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "doc-notes-empty";
    empty.textContent = "Nothing highlighted in this document yet. Select some words on the Document tab and press Highlight, and the note you write on it will be here.";
    root.appendChild(empty);
    return root;
  }
  let section = null;
  records.forEach((record) => {
    const pageNumber = Number(record.page || record.quads?.[0]?.page || 0) || 1;
    if (!section || Number(section.dataset.pageNumber) !== pageNumber) {
      section = pageSectionFor(pageNumber);
      root.appendChild(section);
    }
    section.appendChild(noteArticleFor(record));
  });
  return root;
}

// Rendered into #notesView, or null when this is not a document deck — which is
// what tells renderNotesView to do its own render instead.
export function renderDocumentNotes() {
  const view = el.notesView;
  if (!view) return null;
  if (!documentNotesActive()) {
    // Handing the surface BACK. renderMarkdown's lazy path builds its chunks
    // into the container rather than replacing its contents, so a .doc-notes
    // left behind by the deck before this one would sit above the note that is
    // about to be rendered — and would then be found by the takeover test on
    // the way back in, which is what decides whether the block cache needs
    // invalidating. Cleaned up here, in the module that knows the class, rather
    // than in notes-view.js, which should not have to.
    view.querySelector(`:scope > .${DOC_NOTES_CLASS}`)?.remove();
    return null;
  }
  // A rebuild while somebody is typing would take the words out from under
  // them. Nothing is lost by waiting: the editor writes as you type, and
  // closing it repaints.
  if (editingId) return Promise.resolve();
  const records = documentHighlightsInReadingOrder();
  const body = readerNotesBody(state.notes || "");
  const signature = sectionSignature(records, body);
  const existing = view.querySelector(`:scope > .${DOC_NOTES_CLASS}`);
  if (existing && existing.dataset.signature === signature) return Promise.resolve();
  if (!existing) {
    // Taking the surface over. renderedBlockCache is keyed on (container,
    // source), so a later markdown deck whose body happens to equal the last one
    // rendered here would hit that cache and keep THIS dom. Once, on the way in.
    invalidateRenderedBlockCache();
  }
  const scrollTop = view.scrollTop;
  const root = buildSection(records, body);
  root.dataset.signature = signature;
  if (existing) existing.replaceWith(root);
  else view.replaceChildren(root);
  view.scrollTop = scrollTop;
  return Promise.resolve();
}

// One delegated listener for the whole surface, installed once. A listener per
// note would be one more thing every rebuild has to re-attach.
export function initDocumentNotesEditing() {
  const view = el.notesView;
  if (!view) return;
  view.addEventListener("click", (event) => {
    const body = event.target.closest?.(`.${DOC_NOTE_CLASS}-body`);
    if (!body || !view.contains(body)) return;
    const article = body.closest(`.${DOC_NOTE_CLASS}`);
    const id = article?.dataset.highlightId;
    const record = id && documentHighlightsInReadingOrder().find((entry) => entry.id === id);
    if (record) openNoteEditor(article, record);
  });
  // The tab going away is the one exit no blur is guaranteed for — a phone
  // backgrounding the browser mid-sentence. Same net the note popup keeps.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") closeDocumentNoteEditor();
  });
  view.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const body = event.target.closest?.(`.${DOC_NOTE_CLASS}-body`);
    if (!body || !view.contains(body)) return;
    event.preventDefault();
    const article = body.closest(`.${DOC_NOTE_CLASS}`);
    const id = article?.dataset.highlightId;
    const record = id && documentHighlightsInReadingOrder().find((entry) => entry.id === id);
    if (record) openNoteEditor(article, record);
  });
}

// Every way out of the Notes tab — a view change, a deck swap — has to flush,
// for the reason the note popup's own close does: text typed and not yet
// committed is text the reader believes they have written.
export function closeDocumentNoteEditor() {
  if (editingId) commitOpenNote();
}
