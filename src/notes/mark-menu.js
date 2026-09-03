// Tap a highlight in the note to recolour or remove it.
//
// This is where a wrong colour is actually noticed — reading the note, not
// scrolling a list of highlights in another tab. Putting the controls on the
// mark means the thing you are looking at is the thing you act on, and there is
// no matching step in between: the mark's position among #notesView's marks IS
// its position among the <mark>s in the source, so the edit cannot land on a
// different copy of the same words.
//
// Deliberately a click, not a selection: selecting a highlight to change it
// would go through the source search, which is exactly what cannot reliably
// find a span that already has tags around it.

import { el } from "../core/dom.js?v=__BUILD__";
import { MARK_HIGHLIGHT_COLORS } from "../format/highlight-colors.js?v=__BUILD__";
import { recolourHighlightAt, removeHighlightAt } from "../format/highlight-edit.js?v=__BUILD__";
import { highlightNoteTextAt } from "../format/highlight-notes.js?v=__BUILD__";
import { openHighlightNoteEditor } from "./highlight-note-editor.js?v=__BUILD__";
import { sourceMarkIndexFor } from "./anchors.js?v=__BUILD__";

let menuEl = null;
// A <mark>'s ordinal for a note, a highlight id for a document — see the
// handler sets below. null, never -1, means "nothing open": a key of 0 is a
// real mark.
let openForIndex = null;
let openForMark = null;

// ── Whose highlight is this? ────────────────────────────────────────────────
//
// What differs between a note's <mark> and a paper's record is what "recolour"
// MEANS — splicing a <mark>'s open tag in the markdown, or rewriting a record in
// meta.pdfHighlights — so the menu is handed a set of verbs rather than
// reaching for state.notes itself.
//
// `surface` and `actions` are what the second row below is built from: the
// surface picks which highlight the shared resolvers are asked about, and the
// list says which of the verbs make sense HERE. A row whose id is not in the
// list is not built, which is how the Document surface drops "Pin to Quick
// Notes" without a second appearance rule anywhere — see the note on
// DOCUMENT_MARK_HANDLERS in src/documents/pdf-highlights.js for why that one
// does not survive the crossing.
//
// The default set is the notes one, so every existing caller is unchanged.
const NOTES_MARK_HANDLERS = {
  surface: "notes",
  actions: ["card", "pin", "highlights", "copy", "share", "search"],
  recolour: (index, color) => recolourHighlightAt(index, color),
  remove: (index) => removeHighlightAt(index),
  noteText: (index) => highlightNoteTextAt(index),
  openNote: (index, rect) => openHighlightNoteEditor(index, rect, highlightNoteTextAt(index))
};

let markHandlers = NOTES_MARK_HANDLERS;

// ── ...and what the app can DO with one ────────────────────────────────────
//
// "After a highlight is done, when I'm clicking that, there's not much options
// showing for it." There were three: four colours, a pencil and an ✕. Everything
// else you might want to do with a passage you had marked — copy it, make a card
// of it, pin it, go and read what you wrote about it — needed you to select the
// words again, which is the one gesture that cannot reliably re-find a span with
// tags already round it (see the header of this file).
//
// The verbs themselves all exist. What did not exist was a way to reach them
// from here, and it has to be a registration rather than an import: this module
// is reached FROM src/documents/pdf-highlights.js, which src/panels/highlight-
// index.js imports through highlights-panel.js — so importing the index back to
// look a highlight up would close a cycle straight through the document surface.
// Same reason setDrawerSideBySideHandler and setDocumentAttachHandler exist:
// src/main.js is the one file that already knows both ends.
//
//   resolveHighlightEntry(surface, key)
//                           the highlight as the drawer and the panel already
//                           describe it — { text, anchor, locator, ... }
//   copy(text)              to the clipboard
//   makeCard(text, anchor)  a flashcard framed from it
//   pin(text, anchor)       a Quick Note
//   showInHighlights(surface, locator)
//                           the side-by-side pane, opened on this one
//   share(text)             the platform share sheet
//   search(text)            the web, for these words
//
// The last two are the pill's own verbs, which a highlight could not reach.
// One of them does not exist everywhere — there is no share sheet on most
// desktops — and that needs no rule of its own here: src/main.js registers a
// verb only where the browser has it, and a row whose verb is missing is not
// built (see openMarkMenuWith).
let markActions = {};

export function setMarkMenuActions(actions) {
  markActions = actions && typeof actions === "object" ? actions : {};
}

// The rows of the second half, in the order they are built. `id` is what a
// handler set names in its `actions` list; `verb` is the key in the registry
// above, and a row whose verb has not been registered is not built either — so
// a half-wired app degrades to the menu it always had rather than to a row that
// does nothing.
// The pin is DRAWN, and the rest are text glyphs on purpose. 📌 is a colour-font
// emoji: it ignores `color`, so it paints its own red beside five glyphs that
// take the row's ink — the same fault the selection bar's 📌 / 📋 / 🔍 were
// replaced for, and the same one this app's own comments record for the old 🔴
// highlight button. ⧉ + ☰ ✕ ✎ are ordinary text and take currentColor as they
// are, so they stay as they are.
//
// Drawn for the same reason the pin is: 🔍 is a colour-font emoji that ignores
// `color`, and this menu's icons take the row's ink.
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.7 15.7 4.6 4.6"/></svg>';

const PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15"><path d="M9.5 3.5h5l-.7 5.2 3.4 3.1v1.7H6.8v-1.7l3.4-3.1z"/><path d="M12 13.5v7"/></svg>';

// ── ...and the order they come in ──────────────────────────────────────────
//
// Two runs, because six rows in one column is a list rather than a menu, and
// the reader is choosing between kinds of thing before they choose a thing:
//
//   keep    what stays in the app and belongs to this deck
//   send    what leaves — the clipboard, a voice, another app, the web
//
// (The note sits above both, because it ADDS to the highlight rather than
// taking it anywhere, and Remove sits below both because it is the only row
// that destroys what you marked. Neither is in this table; both are built by
// hand, either side of it.)
//
// `run` is what draws the hairline: the first row of a run that is not the
// first run gets one. Computed at build time from this list rather than
// hard-coded in the stylesheet, so a row moving between runs moves its rule
// with it — and a run whose every row is hidden on this surface cannot leave a
// stray line behind, because the rule belongs to a row and hidden rows are
// display:none.
const MARK_MENU_ACTIONS = [
  { id: "card", verb: "makeCard", label: "Make a flashcard", icon: "&#43;", run: "keep" },
  { id: "pin", verb: "pin", label: "Pin to Quick Notes", icon: PIN_ICON, run: "keep" },
  { id: "highlights", verb: "showInHighlights", label: "Show in Highlights", icon: "&#9776;", run: "keep" },
  { id: "copy", verb: "copy", label: "Copy", icon: "&#10697;", run: "send" },
  { id: "share", verb: "share", label: "Share", icon: "&#8599;", run: "send" },
  { id: "search", verb: "search", label: "Search the web", icon: SEARCH_ICON, run: "send" }
];

export function isMarkMenuOpen() {
  return Boolean(menuEl && !menuEl.hidden);
}

export function closeMarkMenu() {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  openForIndex = null;
  openForMark = null;
  markHandlers = NOTES_MARK_HANDLERS;
}

function ensureMarkMenu() {
  if (menuEl?.isConnected) return menuEl;
  menuEl = document.createElement("div");
  menuEl.className = "mark-menu";
  menuEl.hidden = true;
  menuEl.setAttribute("role", "toolbar");
  menuEl.setAttribute("aria-label", "Highlight");

  // ── Row one: the colours ────────────────────────────────────────────────
  //
  // Its own box now that there is a second row under it, and NOT because the
  // swatches changed: every class and every data-mark-color below is the one
  // that was there before, because tools/paged-check.mjs asks the menu for
  // .mark-menu-swatch.is-current and [data-mark-color=green] by name and both
  // are descendant lookups that a wrapper does not disturb.
  const colours = document.createElement("div");
  colours.className = "mark-menu-colors";
  MARK_HIGHLIGHT_COLORS.forEach((colour) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "mark-menu-swatch";
    swatch.style.setProperty("--sw", colour.swatch);
    swatch.title = colour.name;
    swatch.setAttribute("aria-label", `Recolour to ${colour.name}`);
    swatch.dataset.markColor = colour.value;
    colours.appendChild(swatch);
  });
  menuEl.appendChild(colours);

  // ── Row two: what you can do with the passage ───────────────────────────
  //
  // Rows with words on them, not a second run of glyphs. Six unlabelled circles
  // is the legibility problem the selection bar was already carrying, and this
  // menu opens over the sentence it is about — there is room for a sentence.
  const actions = document.createElement("div");
  actions.className = "mark-menu-actions";

  // A note is Kindle-style commentary attached to the highlight (see
  // format/highlight-notes.js). First, because it is the one thing here that
  // adds to the highlight rather than taking from it or taking it elsewhere.
  const note = document.createElement("button");
  note.type = "button";
  note.className = "mark-menu-item mark-menu-note";
  note.title = "Add or edit a note on this highlight";
  note.dataset.markColor = "note";
  note.innerHTML = '<span class="mmi-ico" aria-hidden="true">&#9998;</span><span class="mmi-label">Add a note</span>';
  actions.appendChild(note);

  MARK_MENU_ACTIONS.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mark-menu-item mark-menu-${row.id}`;
    button.dataset.markAction = row.id;
    button.title = row.label;
    button.innerHTML = `<span class="mmi-ico" aria-hidden="true">${row.icon}</span><span class="mmi-label">${row.label}</span>`;
    actions.appendChild(button);
  });

  // Last, and alone, for the same reason the selection bar's eraser is: it is
  // the only row that destroys what you marked.
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mark-menu-item mark-menu-remove";
  remove.title = "Remove this highlight";
  remove.dataset.markColor = "remove";
  remove.innerHTML = '<span class="mmi-ico" aria-hidden="true">&#10005;</span><span class="mmi-label">Remove the highlight</span>';
  actions.appendChild(remove);

  menuEl.appendChild(actions);

  // pointerdown + preventDefault, like every control on the floating pill: a
  // click would first place a caret in the note, which collapses the very thing
  // being acted on and (on touch) dismisses the menu before the handler runs.
  menuEl.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-mark-color], [data-mark-action]");
    if (!button) {
      // A press on the menu's own padding still must not reach the note.
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const index = openForIndex;
    const mark = openForMark;
    const set = markHandlers;

    // The verbs that act on the highlight ITSELF — its colour, its note, its
    // existence. Unchanged, including closing before acting.
    if (button.dataset.markColor === "note") {
      // Keep the menu's own popup replaced by the note editor's, not both —
      // close before opening so they don't stack.
      const rect = mark?.getBoundingClientRect();
      closeMarkMenu();
      if (index == null || !rect) return;
      // The attribute only points at the note now (its text lives in the
      // "Highlight Notes" section at the end of the note) — resolved from
      // state.notes by ordinal rather than from the DOM attribute.
      set.openNote(index, rect);
      return;
    }
    if (button.dataset.markColor) {
      closeMarkMenu();
      if (index == null) return;
      if (button.dataset.markColor === "remove") set.remove(index);
      else set.recolour(index, button.dataset.markColor);
      return;
    }

    // ...and the verbs that take the passage somewhere else. Every one of them
    // needs the WORDS, which the menu does not hold — it holds an ordinal or a
    // record id. They come from the same index the contents drawer builds its
    // rows from, asked once, here, on a press: it is a scan of the source, and a
    // tap is not a scroll frame.
    const action = button.dataset.markAction;
    const surface = set.surface || "notes";
    closeMarkMenu();
    if (index == null) return;
    const entry = markActions.resolveHighlightEntry?.(surface, index);
    if (!entry) return;
    if (action === "copy") markActions.copy?.(entry.text);
    // The entry rides along with the card verb, and only that one. A card is
    // the single verb whose answer is not always the WORDS: an ink mark has
    // none, and what it should hold is the drawing. Copy, share and search are
    // still handed the passage and nothing else, because there is nothing about
    // which mark this was for any of them to do anything with.
    else if (action === "card") markActions.makeCard?.(entry.text, entry.anchor, entry);
    else if (action === "pin") markActions.pin?.(entry.text, entry.anchor, button);
    else if (action === "highlights") markActions.showInHighlights?.(surface, entry.locator);
    // The two that take the words out of the app entirely. Each is handed the
    // passage and nothing else — neither has any business with an anchor, a
    // locator or which surface this was.
    else if (action === "share") markActions.share?.(entry.text);
    else if (action === "search") markActions.search?.(entry.text);
  });

  document.body.appendChild(menuEl);
  return menuEl;
}

// Anchored above the mark, falling below only when there is no room — the same
// preference the selection pill uses, and for the same reason: reading runs
// downward, so the space already used is the safer half to cover.
export function openMarkMenuFor(mark) {
  const view = el.notesView;
  if (!view || !mark) return;
  // The mark's ordinal in the SOURCE, not its index among the nodes on screen.
  // Every verb in NOTES_MARK_HANDLERS counts <mark> opens in state.notes, and
  // the two numbers are only the same while the DOM holds every mark the note
  // has — which stops being true on any note long enough to be built as it is
  // read. Below that threshold nothing changes; above it, this is the
  // difference between removing the highlight that was tapped and removing a
  // different one. See sourceMarkIndexFor.
  const index = sourceMarkIndexFor(view, mark);
  if (index === -1) return;
  openMarkMenuWith(mark, index, NOTES_MARK_HANDLERS);
}

// The general form: any element to anchor against, any key the handler set
// understands (a <mark>'s ordinal in the note, or a document highlight's id),
// and the verbs that key means. Used by src/documents/pdf-highlights.js's tap
// handler as well as by the notes path above.
export function openMarkMenuWith(mark, key, handlerSet, currentColor = null) {
  const menu = ensureMarkMenu();
  markHandlers = handlerSet || NOTES_MARK_HANDLERS;
  const index = key;
  openForIndex = index;
  openForMark = mark;
  menu.hidden = false;
  // Mark the colour it already is, so six identical circles say which one is
  // current rather than making you press one to find out.
  const current = currentColor || mark.dataset.color || "yellow";
  const hasNote = Boolean(markHandlers.noteText(index));
  menu.querySelectorAll("[data-mark-color]").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.markColor === current);
    // Resolved through the section rather than trusting the attribute: an id
    // whose entry was deleted by hand is not a note, and must not light up.
    if (button.dataset.markColor === "note") button.classList.toggle("has-note", hasNote);
  });
  // ...and the row says which of the two things pressing it will do. "Add a
  // note" over a highlight that already has one is a row that lies about what
  // is behind it — the same fault the bookmark buttons were fixed for.
  const noteLabel = menu.querySelector(".mark-menu-note .mmi-label");
  if (noteLabel) noteLabel.textContent = hasNote ? "Edit the note" : "Add a note";

  // Which of the four take-it-elsewhere rows this surface can honour. Hidden
  // rather than disabled: a row that is there and refuses is worse than one that
  // is not there, and the set that knows is the one that was handed in.
  const allowed = Array.isArray(markHandlers.actions) ? markHandlers.actions : [];
  let lastRun = null;
  menu.querySelectorAll("[data-mark-action]").forEach((button) => {
    const row = MARK_MENU_ACTIONS.find((r) => r.id === button.dataset.markAction);
    // Both halves have to hold: this surface offers it, AND main.js has wired
    // the verb behind it.
    button.hidden = !allowed.includes(button.dataset.markAction)
      || typeof markActions[row?.verb] !== "function"
      || typeof markActions.resolveHighlightEntry !== "function";
    // The hairline goes on the first VISIBLE row of each run after the first,
    // which is why it is decided here and not in the stylesheet: which row that
    // is depends on what this surface offers and on what the browser can do,
    // and both are only known now. A run nobody can see draws no line.
    const startsRun = !button.hidden && lastRun !== null && row?.run !== lastRun;
    button.classList.toggle("starts-run", startsRun);
    if (!button.hidden) lastRun = row?.run ?? null;
  });

  const rect = mark.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const margin = 8;
  let top = rect.top - box.height - margin;
  if (top < margin) top = Math.min(rect.bottom + margin, window.innerHeight - box.height - margin);
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - box.width / 2),
    Math.max(margin, window.innerWidth - box.width - margin)
  );
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.left = `${left}px`;
}

export function initMarkMenu() {
  const view = el.notesView;
  if (!view) return;

  view.addEventListener("click", (event) => {
    // Never steal a click meant for something else that happens to sit inside a
    // highlight — a note link, a cloze, an image control.
    //
    // `.notes-img-controls` is the name of a control box that no longer exists
    // (surface-controls.js removes it only as legacy), so for as long as it was
    // the only image name here the guard covered nothing: the delete button is
    // a <button> and was caught by that, but the resize grip is a bare <div>
    // and tapping the corner of an image inside a highlight opened this menu
    // instead of starting the drag. Named the way src/cards/swipe.js already
    // names it for the same reason.
    if (event.target.closest("a, button, .cloze, .notes-img-controls, .notes-img-resize-handle, .notes-img-size-badge")) return;
    const mark = event.target.closest("mark");
    if (!mark || !view.contains(mark)) {
      closeMarkMenu();
      return;
    }
    // A real text selection means the reader is selecting, not tapping a
    // highlight — the floating pill is the right surface for that.
    //
    // Read through the RANGE, not Selection.toString(). Once the touch
    // controller is armed the reading surfaces carry `user-select: none`
    // (styles/32-touch-select.css), and Chrome answers Selection.toString()
    // with "" over unselectable content — measured — while every Range
    // operation on the very same selection stays correct. This was the one
    // place in the app that asked the selection instead of its range, so on a
    // phone every tap inside a live selection also opened the mark menu behind
    // the pill.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount
        && selection.getRangeAt(0).toString().trim()) return;
    event.preventDefault();
    openMarkMenuFor(mark);
  });

  // Anything else dismisses it. Capture, because the note's own handlers
  // stopPropagation in places.
  document.addEventListener("pointerdown", (event) => {
    if (!isMarkMenuOpen()) return;
    if (event.target.closest(".mark-menu")) return;
    closeMarkMenu();
  }, { capture: true, passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMarkMenu();
  });

  // The menu is positioned against a rect that scrolling invalidates, and a
  // paged note moves sideways under it.
  view.addEventListener("scroll", closeMarkMenu, { passive: true });
}
