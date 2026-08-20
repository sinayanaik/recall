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
let openForIndex = -1;
let openForMark = null;

export function isMarkMenuOpen() {
  return Boolean(menuEl && !menuEl.hidden);
}

export function closeMarkMenu() {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  openForIndex = -1;
  openForMark = null;
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
    if (button.dataset.markColor === "note") {
      // Keep the menu's own popup replaced by the note editor's, not both —
      // close before opening so they don't stack.
      const rect = mark?.getBoundingClientRect();
      closeMarkMenu();
      if (index < 0 || !rect) return;
      // The attribute only points at the note now (its text lives in the
      // "Highlight Notes" section at the end of the note) — resolved from
      // state.notes by ordinal rather than from the DOM attribute.
      openHighlightNoteEditor(index, rect, highlightNoteTextAt(index));
      return;
    }
    closeMarkMenu();
    if (index < 0) return;
    if (button.dataset.markColor === "remove") removeHighlightAt(index);
    else recolourHighlightAt(index, button.dataset.markColor);
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

  const menu = ensureMarkMenu();
  openForIndex = index;
  openForMark = mark;
  menu.hidden = false;
  // Mark the colour it already is, so six identical circles say which one is
  // current rather than making you press one to find out.
  const current = mark.dataset.color || "yellow";
  menu.querySelectorAll("[data-mark-color]").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.markColor === current);
    // Resolved through the section rather than trusting the attribute: an id
    // whose entry was deleted by hand is not a note, and must not light up.
    if (button.dataset.markColor === "note") button.classList.toggle("has-note", Boolean(highlightNoteTextAt(index)));
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
    if (event.target.closest("a, button, .cloze, .notes-img-controls")) return;
    const mark = event.target.closest("mark");
    if (!mark || !view.contains(mark)) {
      closeMarkMenu();
      return;
    }
    // A real text selection means the reader is selecting, not tapping a
    // highlight — the floating pill is the right surface for that.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
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
