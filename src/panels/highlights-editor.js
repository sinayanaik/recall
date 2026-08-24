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

import { state } from "../core/state.js?v=__BUILD__";
import { hash32 } from "../core/text.js?v=__BUILD__";
import { notifyHighlightsChanged } from "../format/highlight-edit.js?v=__BUILD__";
import { highlightNoteTextAt, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { installModeKeys } from "../editor/markdown-keys.js?v=__BUILD__";
import { NOTE_AUTOSAVE_MS } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { createNoteEditorKit } from "../notes/note-editor-kit.js?v=__BUILD__";
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

// The editor currently open in the flow, and the entry it belongs to. Held here
// rather than found by querying the DOM on commit: the panel can be rebuilt
// from under a blur, and a stale index into a fresh array is how a note ends up
// written onto a different highlight.
let openNoteKit = null;

let openNoteEntry = null;

// The shortest an in-place editor is, in pixels. Tall enough that a one-line
// note still reads as a box you are writing in rather than as a field.
export const HL_NOTE_EDIT_MIN_PX = 96;

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

// A highlight's identity on this surface, and the value every card carries as
// data-highlight-key. Exported because side-by-side mode
// (src/panels/highlight-cycle.js) has to find the card for a given entry in a
// list this module built — computing the same string over there would be the
// same key written twice, which is how the two come to disagree.
export function highlightEntryKey(entry) {
  return entry.highlightId ? `doc:${entry.highlightId}` : `mark:${entry.markIndex}`;
}

const entryKey = highlightEntryKey;

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

// Roughly how tall an entry will turn out, before anything has been rendered
// into it.
//
// Not accuracy — `contain-intrinsic-size: auto` replaces this with the real
// height the first time the entry is on screen, and keeps it. What this has to
// be is CLOSE ENOUGH that three hundred unpainted entries are spread down a
// scroller of roughly the right length, because that is what makes "which of
// them are near the viewport" a real question instead of "all of them, they are
// all at zero".
//
// Characters over a line's worth of them, plus the head, plus the note's own
// box. Cheap: it is a length, on a string this function already has.
export const HL_ENTRY_LINE_CHARS = 68;

export const HL_ENTRY_LINE_PX = 28;

// The head, the card's own padding and borders, and the rule between the quote
// and the note — everything in an entry that is not a line of text. It went up
// when an entry became a bounded card rather than a paragraph with a rail
// (styles/44-highlights-editor.css): the estimate is what three hundred
// unpainted entries are spread down the scroller by, and one that is short by
// 24px per entry puts the scrollbar out by a screenful over a marked-up book.
export const HL_ENTRY_CHROME_PX = 64;

export function estimateEntryHeight(entry) {
  const quoteLines = Math.max(1, Math.ceil((entry.markdown || "").length / HL_ENTRY_LINE_CHARS));
  const noteLines = entry.note ? Math.max(1, Math.ceil(entry.note.length / HL_ENTRY_LINE_CHARS)) : 1;
  return HL_ENTRY_CHROME_PX + (quoteLines + noteLines) * HL_ENTRY_LINE_PX;
}

function articleFor(entry) {
  const article = document.createElement("article");
  article.className = HL_NOTE_CLASS;
  article.dataset.highlightKey = entryKey(entry);
  article.dataset.color = entry.color || "";
  // The estimate the containment above uses until this entry has been seen
  // once. Written inline rather than left to the stylesheet's flat 180px,
  // because a one-line highlight and a highlight with four paragraphs of notes
  // on it are not the same shape and a scroller built on one figure for both
  // jumps under the reader as it corrects itself.
  const guess = estimateEntryHeight(entry);
  article.dataset.estimate = String(guess);
  article.style.containIntrinsicSize = `auto ${guess}px`;

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
  const kit = openNoteKit;
  const article = kit?.root?.closest(`.${HL_NOTE_CLASS}`) || null;
  const entry = openNoteEntry;
  const text = kit ? kit.textarea.value : null;
  editingKey = null;
  openNoteKit = null;
  openNoteEntry = null;
  if (kit) {
    // Before the node goes: a registration outliving its textarea would leave
    // the floating pill formatting against a note nobody has open.
    kit.detach();
    kit.root.remove();
  }
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

// ── One editor, one container — but it is passed in ─────────────────────────
//
// This surface was the Highlights tab and is now the right-hand pane of
// side-by-side mode (src/panels/highlight-cycle.js), which lists the highlights
// of ONE reading surface beside that surface. The tab is gone; the cards are
// unchanged, because they were always the right cards in the wrong place.
//
// `list` stays an argument rather than reverting to a hard-coded element for two
// reasons: tools/highlight-check.mjs renders into a container of its own to
// measure containment without a deck open, and nothing here needs to know which
// box it is drawing in. The module's state (editingKey, openNoteKit,
// lastEntries) is singleton deliberately — entryKey() is a deck-wide identity,
// not a per-container one.
let lastList = null;

function restampSignature() {
  const root = lastList?.querySelector(`:scope > .${HL_NOTES_CLASS}`);
  if (root) root.dataset.signature = editorSignature(lastEntries);
}

// ── Editing, with the same tools the popup has ──────────────────────────────
//
// This was a bare <textarea> with Ctrl+B bound to it, beside a popup carrying
// the full formatting strip, the syntax-highlight mirror, an undo ring,
// Write/Preview and the in-note image grips — the same note, in the same
// markdown, with a quarter of the tools depending on which way you opened it.
// Both build src/notes/note-editor-kit.js now, so there is nothing left to
// diverge, and selecting a phrase in here raises the floating pill exactly as
// selecting one in the note does.
function openNoteEditor(article, entry) {
  const key = entryKey(entry);
  if (editingKey === key) return;
  commitOpenNote();
  // On screen and pressed, so it has been rendered — unless the reader got here
  // by keyboard through a still-deferred entry, which is exactly the case a
  // "it will have been painted by now" assumption gets wrong.
  paintEntry(article);
  const body = article.querySelector(`.${HL_NOTE_CLASS}-body`);
  if (!body) return;

  let noteUndoTaken = false;
  const kit = createNoteEditorKit({
    onInput: () => {
      fit();
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(() => {
        noteSaveTimer = 0;
        if (kit.textarea.value === noteSavedText) return;
        noteVerbsFor(entry).write(kit.textarea.value, { rerender: false, undo: !noteUndoTaken });
        noteUndoTaken = true;
        noteSavedText = kit.textarea.value;
        entry.note = kit.textarea.value;
      }, NOTE_AUTOSAVE_MS);
    },
    onModeChange: () => fit()
  });
  kit.root.classList.add("hl-note-editor");
  kit.setValue(entry.note || "");
  noteSavedText = kit.textarea.value;
  editingKey = key;
  openNoteKit = kit;
  openNoteEntry = entry;
  article.classList.add("is-editing");
  body.after(kit.root);

  // Sized to what is in it, so a long note is never written through a slot. The
  // height goes on the WRAPPER, not on the textarea: enableSyntaxHighlighting
  // pairs the textarea with a backdrop that paints every visible pixel, and
  // styles/10-editor.css gives both `height: 100% !important` so the two can
  // never disagree about a metric. Measured from `auto` first, so the box can
  // shrink again when text is deleted.
  const fit = () => {
    const wrapper = kit.textareaWrapper;
    if (!wrapper || wrapper.hidden) return;
    wrapper.style.height = "auto";
    wrapper.style.height = `${Math.max(HL_NOTE_EDIT_MIN_PX, kit.textarea.scrollHeight)}px`;
  };

  // ── Committing when the reader actually leaves ───────────────────────────
  //
  // This used to be `blur` on the textarea, which was right when the textarea
  // was the whole editor and is wrong now: pressing a toolbar button, opening
  // the colour menu or switching to Preview all move the focus off it, and each
  // one would have torn the editor down mid-edit. What ends the session is the
  // focus leaving the EDITOR, and that is asked one task later — a focusout
  // reports where the focus is going before it has landed, and for a click on
  // something unfocusable it reports nothing at all.
  kit.root.addEventListener("focusout", () => {
    setTimeout(() => {
      if (editingKey !== key) return;
      if (kit.root.contains(document.activeElement)) return;
      // The floating pill is a fixed overlay outside this subtree, and every one
      // of its buttons is pointerdown + preventDefault precisely so the
      // selection survives — so a press there never moves the focus and never
      // reaches here. Anything that does is the reader leaving.
      commitOpenNote();
    }, 0);
  });
  kit.root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    commitOpenNote();
  });
  // Ctrl+E means the same thing it means everywhere else, "show me the other
  // mode" — which in the flow of a list is the rendered note, so committing puts
  // the editor away and paints it back. Ctrl+Enter is done.
  installModeKeys(kit.root, {
    toggleMode: () => commitOpenNote(),
    done: () => commitOpenNote()
  });
  kit.setMode("write");
  kit.attach();
  fit();
  kit.textarea.focus();
  kit.textarea.setSelectionRange(kit.textarea.value.length, kit.textarea.value.length);
}

// ── The surface ─────────────────────────────────────────────────────────────

function groupHead(label) {
  const head = document.createElement("h3");
  head.className = "hl-notes-group-head";
  head.textContent = label;
  return head;
}

// One entry's two rendered halves, run when it comes near the viewport.
//
// Idempotent by the flag: the observer can hand the same node back (a scroll up
// and down again), and re-rendering an entry the reader may be typing into would
// be worse than wasteful.
function paintEntry(article) {
  if (article.dataset.painted === "true") return Promise.resolve();
  const entry = lastEntries.find((one) => entryKey(one) === article.dataset.highlightKey);
  if (!entry) return Promise.resolve();
  article.dataset.painted = "true";
  return Promise.all([
    paintQuote(article.querySelector(".hl-note-quote"), entry),
    paintNoteBody(article, entry)
  ]);
}

// ── Whether this surface is big enough to be worth containing ─────────────
//
// `content-visibility: auto` per entry is not free and not always a win.
// Skipping an off-screen entry saves painting it; it costs a layout every time
// one crosses the viewport edge. Which way that trade falls depends on how much
// DOM there actually is, and that depends on the CONTENT — 300 highlights of
// prose come to about 7,700 nodes, and 300 whose lines carry inline maths come
// to 21,000, because one $x$ is a KaTeX tree on its own.
//
// Measured at 6x CPU throttle, scrolled after the surface had finished building:
//
//     7,700 nodes    24ms per frame plain,  30ms contained   — containment LOSES
//    21,000 nodes    53ms per frame plain,  31ms contained   — containment WINS
//
// So it is counted rather than guessed, once, after the build — the same gate
// NOTES_CHUNK_MIN_BLOCKS puts on the chunk wrappers next door, and for the same
// reason: an ordinary surface should keep exactly the DOM it always had.
//
// The threshold sits between the two measurements and nearer the losing end,
// because the cost of getting it wrong is not symmetric: below it the surface is
// small and a few milliseconds either way is nothing, while above it the
// unconstrained version degrades without limit.
export const HL_CONTAIN_MIN_NODES = 12000;

// Exported under a name that says what it is for: tools/highlight-check.mjs
// drives the decision directly, because a threshold nothing checks is a
// threshold that gets moved.
export function applyContainmentForCheck(articles, samples, list) {
  return applyContainment(articles, samples, list || lastList);
}

function applyContainment(articles, samples, list) {
  const root = list?.querySelector(`:scope > .${HL_NOTES_CLASS}`);
  if (!root) return;
  // One query, once, at the end of the build. querySelectorAll("*") over a
  // surface this size is a few milliseconds and it is the only honest answer —
  // an entry count cannot tell prose from a page of equations.
  const contain = list.querySelectorAll("*").length >= HL_CONTAIN_MIN_NODES;
  root.classList.toggle("is-contained", contain);
  // The estimates only matter once something is being skipped: they are what an
  // unreached entry contributes to the scroll height. Calibrating them costs a
  // layout of the whole surface, so it is not paid on a surface that will never
  // skip anything.
  if (contain) calibrateEntryEstimates(articles, samples);
}

// ── ...and the estimate, measured rather than guessed ─────────────────────
//
// estimateEntryHeight is a guess off a character count, and a guess is what the
// scroll height of the whole tab is built from: an entry the reader has not
// reached yet contributes its estimate and nothing else. Measured, that guess
// was about a third too tall — and being wrong is not a cosmetic problem. Every
// entry that comes into view swaps its estimate for its real height, which
// changes the height of everything below it, which is a layout. Fifty-one of
// them over one scroll, at ~26ms each on a throttled phone, and THAT is what was
// left of the jank once the paint was contained.
//
// So the first few are measured while they are unambiguously on screen — the
// tab has just been built and is scrolled to the top — and the ratio between
// what they really are and what they were guessed to be is applied to the rest.
// The same move measureNotesBlockEstimate makes next door, for the same reason:
// one number taken from the actual thing beats a constant taken from a fixture.
export const HL_ESTIMATE_SAMPLE = 8;

// Below this the guess was close enough that rewriting 300 inline styles — a
// layout of the whole surface — costs more than it saves.
export const HL_ESTIMATE_TOLERANCE = 0.12;

function calibrateEntryEstimates(articles, samples) {
  if (samples.length < 2) return;
  const ratios = samples.map(([real, guess]) => real / guess).sort((a, b) => a - b);
  // The median, not the mean: one entry carrying an image is not evidence about
  // the other 299.
  const ratio = ratios[Math.floor(ratios.length / 2)];
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  if (Math.abs(ratio - 1) < HL_ESTIMATE_TOLERANCE) return;
  articles.forEach((article) => {
    const guess = Number(article.dataset.estimate) || 0;
    if (!guess) return;
    article.style.containIntrinsicSize = `auto ${Math.round(guess * ratio)}px`;
  });
}

// Every entry, then the one measurement that decides whether this surface is
// contained and what an unreached entry is worth.
//
// Deliberately NOT paced across frames and NOT driven by the viewport, and both
// were tried. Painting entries as they are scrolled to (runNearViewportAndDefer,
// which is what the notes view does for its tables and diagrams) puts a markdown
// parse and a KaTeX pass ON the scroll, and its drain runs on an idle callback
// whose 250ms backstop is what actually fires while a reader keeps scrolling:
// measured at 6x CPU throttle, 31ms per frame painting everything up front
// against 71ms rendering it as it was reached. Work done ahead of the reader is
// free; the same work done under them is not.
function paintEntries(articles, list) {
  return Promise.all(articles.map((article) => paintEntry(article))).then(() => {
    // After a frame, so the heights being read are the laid-out ones.
    requestAnimationFrame(() => measureAndContain(articles, list));
  });
}

// The sample is taken from the entries at the TOP, which are the ones on screen
// when a tab that has just been opened is still scrolled to the beginning — and
// an entry the engine is allowed to skip reports its ESTIMATE as its height,
// which would make this measure its own guess.
function measureAndContain(articles, list) {
  const samples = [];
  for (const article of articles) {
    if (samples.length >= HL_ESTIMATE_SAMPLE) break;
    if (article.getBoundingClientRect().top > window.innerHeight) break;
    const guess = Number(article.dataset.estimate) || 0;
    const real = article.offsetHeight;
    if (guess > 0 && real > 0) samples.push([real, guess]);
  }
  applyContainment(articles, samples, list);
}

// Rendered into `list` — #highlightCycleBody in side-by-side mode, and whatever
// container tools/highlight-check.mjs hands it. `entries` is one flat list in
// reading order, each carrying the group it belongs to — a page for a document
// highlight, a chapter for a <mark> — so the grouping is a single pass rather
// than two shapes of input.
export function renderHighlightsEditor(entries, list) {
  if (!list) return Promise.resolve();
  // A rebuild while somebody is typing would take the words out from under
  // them. Nothing is lost by waiting: the editor writes as you type, and
  // closing it repaints.
  if (editingKey) return Promise.resolve();
  lastEntries = entries;
  lastList = list;
  const signature = editorSignature(entries);
  const existing = list.querySelector(`:scope > .${HL_NOTES_CLASS}`);
  if (existing && existing.dataset.signature === signature) return Promise.resolve();
  // ...asked of THIS container. The guard is "what is already on screen here",
  // and the other container holding an identical signature says nothing about
  // this one — which is empty until the first render into it.

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
  // Painted AFTER the surface is in the document, not inline as each article is
  // built: a mermaid diagram inside a note needs real layout to size itself
  // against, which a still-detached node does not have.
  return paintEntries(painted.map(([article]) => article), list);
}

// One delegated listener for the whole surface, installed once per container. A
// listener per note would be one more thing every rebuild has to re-attach.
export function initHighlightsEditor(list) {
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
  //
  // On the DOCUMENT, so it is installed once however many containers this is
  // called for: two registrations would commit the same note twice, and the
  // second commit runs against an editingKey the first already cleared.
  if (visibilityNetInstalled) return;
  visibilityNetInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") closeHighlightsEditor();
  });
}

let visibilityNetInstalled = false;

// Every way out of the Highlights tab — a view change, a deck swap — has to
// flush, for the reason the note popup's own close does: text typed and not yet
// committed is text the reader believes they have written.
export function closeHighlightsEditor() {
  if (editingKey) commitOpenNote();
}
