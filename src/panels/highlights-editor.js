// Every highlight in the deck, with its note, written where it is listed.
//
// ── The report this answers ─────────────────────────────────────────────────
//
// "We need a holistic editor-like panel for all highlighted texts. Strip them
// from the notes panel — no need to render these there, but in the highlights
// panel."
//
// The Highlights tab was a list of rows with a ✎ on each: every note took a
// popup to read and a second one to write, and a reader working down a paper
// they had annotated opened and closed forty windows to do it. It is a
// continuous surface now — the highlight, then its note under it, editable
// where it sits, grouped by page or by chapter — and a note with nothing in it
// yet is a blank line waiting for one rather than something hidden.
//
// ── Where this came from ────────────────────────────────────────────────────
//
// Almost all of it is src/documents/pdf-notes-view.js, moved. That module had
// solved this problem correctly and put the answer in the wrong tab: on a PDF
// deck it took #notesView over and rendered every highlight there, so the Notes
// tab held the reader's annotations instead of the reader's own writing. What
// was wrong with it was its address, not its design, so the design is kept —
// the excerpt that jumps, the note body that becomes a textarea where it
// stands, the autosave, the sticky group heads, the colour rail — and it is
// generalised over WHERE a note is written rather than assuming a PDF record.
//
// ── One surface, two kinds of highlight ─────────────────────────────────────
//
// A <mark> in the markdown and a record in meta.pdfHighlights are the same
// thing here and differ only in the pair of verbs that reads and writes their
// note. That pair already exists, twice, and neither is new: setHighlightNoteAt
// (by <mark> ordinal) and setDocumentHighlightNote (by record id). So an entry
// carries its own { read, write } and everything else is shared — which is the
// same split renderNoteBodyWithImageResize was already making on `highlightId`.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hash32 } from "../core/text.js?v=__BUILD__";
import { notifyHighlightsChanged } from "../format/highlight-edit.js?v=__BUILD__";
import { highlightNoteTextAt, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { installMarkdownKeys } from "../editor/markdown-keys.js?v=__BUILD__";
import { NOTE_AUTOSAVE_MS } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { renderTargetConfig } from "../format/render-toolbar.js?v=__BUILD__";
import { addRegionPreview } from "./highlights-panel.js?v=__BUILD__";
import { documentHighlightNote, setDocumentHighlightNote } from "../documents/pdf-highlights.js?v=__BUILD__";

export const HL_NOTES_CLASS = "hl-notes";

export const HL_NOTE_CLASS = "hl-note";

// The key of the highlight whose note is open in a textarea, or null. A rebuild
// while one is open would take the words out from under the reader mid-sentence,
// so the rebuild is deferred until the editor closes — see renderHighlightsEditor.
//
// null, never -1: a <mark> ordinal of 0 is a real highlight.
let editingKey = null;

let noteSaveTimer = 0;

let noteSavedText = "";

// ── Where a note is written ─────────────────────────────────────────────────
//
// Two verbs per kind, and nothing else differs. `key` is a <mark>'s ordinal in
// state.notes or a document highlight's own id, which is exactly what the mark
// menu, the note popup and the panel already key their actions on.
export function noteVerbsFor(entry) {
  return entry.highlightId
    ? {
      read: () => documentHighlightNote(entry.highlightId) || "",
      write: (text, options) => setDocumentHighlightNote(entry.highlightId, text, options)
    }
    : {
      read: () => highlightNoteTextAt(entry.markIndex) || "",
      write: (text, options) => setHighlightNoteAt(entry.markIndex, text, options)
    };
}

function entryKey(entry) {
  return entry.highlightId ? `doc:${entry.highlightId}` : `mark:${entry.markIndex}`;
}

// ── What is on screen, as one string ────────────────────────────────────────
//
// notifyHighlightsChanged() now fires from an editor that is INSIDE this panel
// — a note being typed here saves on every pause, and every save tells the app a
// highlight changed. Rebuilding forty rendered rows between keystrokes because
// one of them was edited is the churn this guard exists to stop, and it is the
// same guard pdf-notes-view.js and pdf-page-notes.js each keep for the same
// reason.
export function editorSignature(entries) {
  return entries
    .map((entry) => `${entryKey(entry)}:${entry.color || ""}:${hash32(entry.markdown || "")}:${hash32(entry.note || "")}`)
    .join("|");
}

// ── One entry ───────────────────────────────────────────────────────────────

function paintNoteBody(article, entry) {
  const body = article.querySelector(`.${HL_NOTE_CLASS}-body`);
  if (!body) return Promise.resolve();
  const note = entry.note || "";
  body.classList.toggle("is-empty", !note);
  if (!note) {
    body.innerHTML = "<p class=\"hl-note-placeholder\">Write a note on this highlight…</p>";
    return Promise.resolve();
  }
  // renderMarkdown, not the bare markdownToSafeHtml pdf-notes-view.js used: a
  // note holding LaTeX or a still-uploading image rendered as a raw "$…$" or a
  // broken-image icon there, which is the exact bug the Highlights panel had
  // already fixed for itself. It also gives the resize grips below real <img>
  // and diagram elements to attach to.
  return renderMarkdown(body, note).then(() => {
    const verbs = noteVerbsFor(entry);
    // The same corner-drag resize/delete the notes editor gives an image, on a
    // note's own self-contained markdown. Scoping the surface's view to just
    // this body and its source to just this note is what keeps
    // enhanceSurfaceImageControls' shell↔markdown matching valid: a control it
    // attaches here writes back through THIS surface's setSource, so its `view`
    // and its `getSource()` have to describe the same document.
    const surface = {
      view: body,
      getSource: () => entry.note || "",
      setSource: (text) => {
        verbs.write(text, { rerender: false });
        entry.note = text;
      },
      // A write goes through notifyHighlightsChanged, which rebuilds this whole
      // panel — so by the time a rerender() call would run, this body has
      // already been replaced by a freshly rendered one. Deliberately a no-op;
      // the real refresh has happened.
      rerender: () => {}
    };
    enhanceSurfaceImageControls(surface);
    enhanceSurfaceDiagramControls(surface);
  });
}

// The highlighted line itself.
//
// A real image in state.notes gets the same corner-drag resize/delete grip the
// notes editor gives one, committing straight back into state.notes at the
// slice's own [rawStart, rawEnd) — not just a read-only summary. Only when the
// entry resolved to a real line (entry.span, which carries those offsets): the
// no-line fallback markdown is not a literal source slice, so there is nowhere
// well-defined to write a resize back to and the quote is left as a plain
// (Zoom-only) preview.
//
// Scoping BOTH the surface's view (this quote, holding only its own images) and
// its source (the slice, not the whole note) to the same span is what makes the
// shell↔markdown matching inside enhanceSurfaceImageControls valid.
function paintQuote(quote, entry) {
  if (!entry.span) return renderMarkdown(quote, entry.markdown);
  const notesConfig = renderTargetConfig("notes");
  const surface = {
    view: quote,
    getSource: () => entry.markdown,
    setSource: (slice) => {
      const notes = state.notes || "";
      const updated = notes.slice(0, entry.span.rawStart) + slice + notes.slice(entry.span.rawEnd);
      notesConfig.setSource(updated); // pushNotesUndo + state.notes write + raw-editor/history sync
      entry.span.rawEnd = entry.span.rawStart + slice.length;
      entry.markdown = slice;
    },
    rerender: () => {
      notesConfig.rerender(); // keeps the Notes tab in step even while it is off-screen
      paintQuote(quote, entry);
    }
  };
  return renderMarkdown(quote, entry.markdown).then(() => {
    enhanceSurfaceImageControls(surface);
    enhanceSurfaceDiagramControls(surface);
  });
}

function articleFor(entry) {
  const article = document.createElement("article");
  article.className = HL_NOTE_CLASS;
  article.dataset.highlightKey = entryKey(entry);
  article.dataset.color = entry.color || "";

  // The way back to the highlight, in a row of its own above the words.
  //
  // Deliberately NOT the quote itself being pressable: the quote is rendered
  // markdown a reader may well want to select out of — to copy a sentence, or
  // to make a card from it — and a block that navigates on click cannot also be
  // selected from.
  const head = document.createElement("div");
  head.className = "hl-note-head";
  const goto = document.createElement("button");
  goto.type = "button";
  goto.className = "hl-note-goto";
  const label = entry.highlightId ? "Go to this highlight in the document" : "Go to this highlight in the notes";
  goto.title = label;
  goto.setAttribute("aria-label", label);
  goto.textContent = "Go to →";
  goto.addEventListener("click", () => scheduleNoteJump(entry.anchor, { patient: true }, entry.locator));
  head.appendChild(goto);

  const quote = document.createElement("div");
  quote.className = "hl-note-quote rendered";

  const body = document.createElement("div");
  body.className = `${HL_NOTE_CLASS}-body`;
  body.tabIndex = 0;
  body.setAttribute("role", "button");
  body.setAttribute("aria-label", "Edit this note");

  article.append(head, quote, body);
  // A region drawn round a figure is a picture, so it is listed as one —
  // appended above the quote, which for a region is the words the box happened
  // to cover (or "Region · page N" when it covered none).
  if (entry.region) addRegionPreview(quote, entry.region);
  return article;
}

// ── Editing, in place ───────────────────────────────────────────────────────
//
// The same contract as the note popup (src/notes/highlight-note-editor.js), and
// deliberately the same constant for the debounce: one write per typing pause
// with { rerender: false } so nothing on screen is rebuilt mid-sentence, one
// undo step for the whole session, and a single repaint when the editor closes.
// What is different is only where the text is typed.
export function commitOpenNote({ repaint = true } = {}) {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = 0;
  const key = editingKey;
  if (!key) return;
  const list = el.highlightsList;
  const area = list?.querySelector(`.${HL_NOTE_CLASS}[data-highlight-key="${CSS.escape(key)}"] .hl-note-edit`);
  const article = area?.closest(`.${HL_NOTE_CLASS}`);
  const entry = area?.__hlEntry || null;
  const text = area ? area.value : null;
  editingKey = null;
  if (area) area.remove();
  // Written BEFORE the note is painted back, not after: paintNoteBody reads the
  // note off the entry, so repainting first would show the text the reader has
  // just replaced.
  const wrote = text !== null && text !== noteSavedText;
  if (wrote && entry) {
    noteVerbsFor(entry).write(text, { rerender: false });
    entry.note = text;
    noteSavedText = text;
  }
  if (article && entry) {
    article.classList.remove("is-editing");
    paintNoteBody(article, entry);
  }
  // The signature has to move with it, or the very next notifyHighlightsChanged
  // rebuilds a surface that is already correct.
  restampSignature();
  if (!wrote) return;
  // One notify for the whole editing session: the drawers, the page badges and
  // the printed page notes all show this text, and none of them needs to see it
  // a word at a time.
  if (repaint) notifyHighlightsChanged();
}

let lastEntries = [];

function restampSignature() {
  const root = el.highlightsList?.querySelector(`:scope > .${HL_NOTES_CLASS}`);
  if (root) root.dataset.signature = editorSignature(lastEntries);
}

function openNoteEditor(article, entry) {
  const key = entryKey(entry);
  if (editingKey === key) return;
  commitOpenNote();
  const body = article.querySelector(`.${HL_NOTE_CLASS}-body`);
  if (!body) return;
  const area = document.createElement("textarea");
  area.className = "hl-note-edit";
  area.spellcheck = false;
  area.value = entry.note || "";
  // The entry is hung on the node rather than looked up again on commit: the
  // panel can be rebuilt from under a blur, and a stale index into a fresh
  // array is how a note ends up written onto a different highlight.
  area.__hlEntry = entry;
  noteSavedText = area.value;
  editingKey = key;
  let noteUndoTaken = false;
  article.classList.add("is-editing");
  body.after(area);
  // Sized to what is in it, so a long note is never written through a slot.
  // Re-run on input rather than by CSS, which has no way to measure a textarea.
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
      noteVerbsFor(entry).write(area.value, { rerender: false, undo: !noteUndoTaken });
      noteUndoTaken = true;
      noteSavedText = area.value;
      entry.note = area.value;
    }, NOTE_AUTOSAVE_MS);
  });
  area.addEventListener("blur", () => commitOpenNote());
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    commitOpenNote();
  });
  // The same formatting keys the note popup has, on the same terms — this is
  // the other place a highlight's note gets written, and the two should not
  // disagree about what Ctrl+B does. Ctrl+E means the same thing it means
  // everywhere else, "show me the other mode", which here is the rendered note:
  // committing puts the textarea away and paints it back.
  installMarkdownKeys(area, {
    toggleMode: () => commitOpenNote(),
    done: () => commitOpenNote()
  });
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// ── The surface ─────────────────────────────────────────────────────────────

function groupHead(label) {
  const head = document.createElement("h3");
  head.className = "hl-notes-group-head";
  head.textContent = label;
  return head;
}

// Rendered into el.highlightsList. `entries` is one flat list in reading order,
// each carrying the group it belongs to — a page for a document highlight, a
// chapter for a <mark> — so the grouping is a single pass rather than two
// shapes of input.
export function renderHighlightsEditor(entries) {
  const list = el.highlightsList;
  if (!list) return Promise.resolve();
  // A rebuild while somebody is typing would take the words out from under
  // them. Nothing is lost by waiting: the editor writes as you type, and
  // closing it repaints.
  if (editingKey) return Promise.resolve();
  lastEntries = entries;
  const signature = editorSignature(entries);
  const existing = list.querySelector(`:scope > .${HL_NOTES_CLASS}`);
  if (existing && existing.dataset.signature === signature) return Promise.resolve();

  const scrollTop = list.scrollTop;
  const root = document.createElement("div");
  root.className = HL_NOTES_CLASS;
  root.dataset.signature = signature;
  const painted = [];
  let section = null;
  let group = null;
  entries.forEach((entry) => {
    const label = entry.group || "";
    if (!section || group !== label) {
      group = label;
      section = document.createElement("section");
      section.className = "hl-notes-group";
      if (label) section.appendChild(groupHead(label));
      root.appendChild(section);
    }
    const article = articleFor(entry);
    section.appendChild(article);
    painted.push([article, entry]);
  });
  if (existing) existing.replaceWith(root);
  else list.replaceChildren(root);
  list.scrollTop = scrollTop;
  // Bodies are rendered AFTER the whole surface is in the document, not inline
  // as each is built: a mermaid diagram inside a note needs real layout to size
  // itself against, which a still-detached node does not have.
  return Promise.all(painted.flatMap(([article, entry]) => [
    paintQuote(article.querySelector(".hl-note-quote"), entry),
    paintNoteBody(article, entry)
  ]));
}

// One delegated listener for the whole surface, installed once. A listener per
// note would be one more thing every rebuild has to re-attach.
export function initHighlightsEditor() {
  const list = el.highlightsList;
  if (!list) return;
  const open = (target) => {
    const body = target.closest?.(`.${HL_NOTE_CLASS}-body`);
    if (!body || !list.contains(body)) return false;
    const article = body.closest(`.${HL_NOTE_CLASS}`);
    const entry = lastEntries.find((one) => entryKey(one) === article?.dataset.highlightKey);
    if (!entry) return false;
    openNoteEditor(article, entry);
    return true;
  };
  list.addEventListener("click", (event) => { open(event.target); });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (open(event.target)) event.preventDefault();
  });
  // The tab going away is the one exit no blur is guaranteed for — a phone
  // backgrounding the browser mid-sentence. The same net the note popup keeps.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") closeHighlightsEditor();
  });
}

// Every way out of the Highlights tab — a view change, a deck swap — has to
// flush, for the reason the note popup's own close does: text typed and not yet
// committed is text the reader believes they have written.
export function closeHighlightsEditor() {
  if (editingKey) commitOpenNote();
}
