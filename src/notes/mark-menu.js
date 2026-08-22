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

let menuEl = null;
// A <mark>'s ordinal for a note, a highlight id for a document — see the
// handler sets below. null, never -1, means "nothing open": a key of 0 is a
// real mark.
let openForIndex = null;
let openForMark = null;

// ── Whose highlight is this? ────────────────────────────────────────────────
//
// The menu itself is the same three controls wherever it opens: four colours, a
// note and a remove. What differs is what "recolour" MEANS — splicing a
// <mark>'s open tag in the markdown, or rewriting a record in
// meta.pdfHighlights — so the menu is handed a set of verbs rather than
// reaching for state.notes itself.
//
// The default set is the notes one, so every existing caller is unchanged.
const NOTES_MARK_HANDLERS = {
  recolour: (index, color) => recolourHighlightAt(index, color),
  remove: (index) => removeHighlightAt(index),
  noteText: (index) => highlightNoteTextAt(index),
  openNote: (index, rect) => openHighlightNoteEditor(index, rect, highlightNoteTextAt(index))
};

let markHandlers = NOTES_MARK_HANDLERS;

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

  MARK_HIGHLIGHT_COLORS.forEach((colour) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "mark-menu-swatch";
    swatch.style.setProperty("--sw", colour.swatch);
    swatch.title = colour.name;
    swatch.setAttribute("aria-label", `Recolour to ${colour.name}`);
    swatch.dataset.markColor = colour.value;
    menuEl.appendChild(swatch);
  });

  // A note is Kindle-style commentary attached to the highlight (see
  // format/highlight-notes.js) — a "written" glyph rather than a colour, so
  // it doesn't read as an eighth swatch.
  const note = document.createElement("button");
  note.type = "button";
  note.className = "mark-menu-note";
  note.title = "Add or edit a note on this highlight";
  note.setAttribute("aria-label", "Add or edit a note on this highlight");
  note.dataset.markColor = "note";
  note.innerHTML = "&#9998;";
  menuEl.appendChild(note);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mark-menu-remove";
  remove.title = "Remove this highlight";
  remove.setAttribute("aria-label", "Remove this highlight");
  remove.dataset.markColor = "remove";
  remove.innerHTML = "&#10005;";
  menuEl.appendChild(remove);

  // pointerdown + preventDefault, like every control on the floating pill: a
  // click would first place a caret in the note, which collapses the very thing
  // being acted on and (on touch) dismisses the menu before the handler runs.
  menuEl.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-mark-color]");
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
    closeMarkMenu();
    if (index == null) return;
    if (button.dataset.markColor === "remove") set.remove(index);
    else set.recolour(index, button.dataset.markColor);
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
  const marks = [...view.querySelectorAll("mark")];
  const index = marks.indexOf(mark);
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
  menu.querySelectorAll("[data-mark-color]").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.markColor === current);
    // Resolved through the section rather than trusting the attribute: an id
    // whose entry was deleted by hand is not a note, and must not light up.
    if (button.dataset.markColor === "note") button.classList.toggle("has-note", Boolean(markHandlers.noteText(index)));
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
