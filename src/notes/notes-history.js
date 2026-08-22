// Undo and redo for the open note.
//
// ── Why this has to exist at all ───────────────────────────────────────────
//
// The app used to rely on the browser's own per-keystroke undo inside the raw
// editor, and said so out loud: all-cards-edit.js keeps its snapshot stack
// deliberately scoped to the card ARRAY "because question/answer/notes
// textareas already get native per-keystroke undo from the browser", and
// main.js excludes text fields from Ctrl+Z for the same reason.
//
// That was not true. Every toolbar action, every button on the floating pill,
// every pasted image, every cloze, every highlight and every link insert writes
// `textarea.value = …`, and a programmatic value assignment DISCARDS the
// element's undo transaction outright. Merely reopening raw mode does it
// (enterNotesEditing assigns .value), as does switching view. So the first time
// you used any feature of the editor, Ctrl+Z stopped being able to step back
// past that point — and in the rendered view, where highlights and clozes are
// actually made, `state.notes` is mutated directly and there was never any undo
// at all.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// Snapshots of the whole note, not diffs. A note is one string, the edits are
// arbitrary splices, and the cost that matters is memory rather than time —
// which is capped below. The same choice, for the same reason, as
// snapshotCardsState.
//
// Each entry also carries where the reader WAS, because an undo that restores
// the text but not the position is its own kind of jump: you press Ctrl+Z and
// end up somewhere else in a long note with no idea what changed.

import { state } from "../core/state.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { rawEditorValueFor } from "./notes-edit-split.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
// notes-view.js imports syncNotesHistoryBaseline/clearNotesHistory from here,
// so this pair is a cycle. It is safe because every binding crossing it in
// either direction is a hoisted `function` declaration, initialised before
// either module body runs — unlike the `const` that once aborted the whole of
// app.js from inside a cycle. Nothing here may become a const/let export used
// by notes-view.js without re-checking that.
import { renderNotesViewPinned } from "./notes-view.js?v=__BUILD__";

// Typing is one undo step per burst, not per keystroke. A keystroke landing
// within this long of the previous one continues the current step.
export const NOTES_TYPING_COALESCE_MS = 600;

// Two independent caps. The count keeps an ordinary session's history
// bounded; the character budget is what stops a 4MB note turning eighty
// snapshots into 320MB of retained strings. Whichever bites first wins.
export const NOTES_UNDO_MAX_ENTRIES = 80;

export const NOTES_UNDO_MAX_CHARS = 12_000_000;

let undoStack = [];
let redoStack = [];

// The note's text as of the last input we saw. A keystroke tells us what the
// text became, never what it was, so the value to push when a NEW step begins
// is the one carried over from the previous event.
let lastSeenText = null;
let lastTypingAt = 0;
// Set by pushNotesUndo: the very next input event is that action's own result
// landing, and must not be mistaken for the start of a typing step.
let expectingActionResult = false;

export function notesHistoryDepth() {
  return { undo: undoStack.length, redo: redoStack.length };
}

function trimStack() {
  while (undoStack.length > NOTES_UNDO_MAX_ENTRIES) undoStack.shift();
  let chars = undoStack.reduce((sum, entry) => sum + entry.text.length, 0);
  while (undoStack.length > 1 && chars > NOTES_UNDO_MAX_CHARS) {
    chars -= undoStack.shift().text.length;
  }
}

// Where the reader is, in whichever mode they are in. Captured with the text so
// an undo puts them back rather than merely putting the words back.
export function notesHistoryPosition() {
  const editing = Boolean(el.notesEdit && !el.notesEdit.hidden);
  if (editing) {
    return {
      editing: true,
      caret: el.notesEdit.selectionStart ?? 0,
      caretEnd: el.notesEdit.selectionEnd ?? 0,
      scrollTop: el.notesEdit.scrollTop
    };
  }
  return {
    editing: false,
    scrollTop: el.notesView?.scrollTop ?? 0,
    scrollLeft: el.notesView?.scrollLeft ?? 0
  };
}

function entryFor(text, label) {
  return { text, label: label || "edit", at: notesHistoryPosition() };
}

// Snapshot the note as it is NOW, before the caller changes it.
//
// Every discrete action calls this — a highlight, a cloze, a format, an erase,
// an image paste, a link insert. `label` is what the toast says on undo, so it
// should name the action from the reader's side ("Highlight", not "wrapMark").
export function pushNotesUndo(label) {
  const text = state.notes || "";
  const top = undoStack[undoStack.length - 1];
  // Nothing changed since the last snapshot — usually a caller that pushed and
  // then bailed out (a highlight that could not be located, say). Recording it
  // would make the reader press Ctrl+Z twice for one visible change.
  if (top && top.text === text) {
    expectingActionResult = true;
    return;
  }
  undoStack.push(entryFor(text, label));
  redoStack = [];
  trimStack();
  expectingActionResult = true;
  lastTypingAt = 0;
}

// Adopt `text` as the current state without recording anything. For every path
// that replaces the note wholesale but is not an edit the reader made: opening
// the editor, loading a deck, a sync pull, an undo of our own.
export function syncNotesHistoryBaseline(text) {
  lastSeenText = text == null ? null : String(text);
  lastTypingAt = 0;
  expectingActionResult = false;
}

// The raw editor's input path. Called after state.notes has already been
// updated, which is why the value pushed is the PREVIOUS one.
export function recordNotesTyping(text) {
  const next = String(text ?? "");
  if (expectingActionResult) {
    // This input event is the result of an action that already pushed its own
    // snapshot. Adopt the new text so the next real keystroke has something to
    // push, and start the coalescing window fresh so that keystroke opens a
    // step of its own rather than being folded into the action.
    expectingActionResult = false;
    lastSeenText = next;
    lastTypingAt = 0;
    return;
  }
  const now = performance.now();
  const startsNewStep = now - lastTypingAt > NOTES_TYPING_COALESCE_MS;
  if (startsNewStep && lastSeenText != null && lastSeenText !== next) {
    undoStack.push(entryFor(lastSeenText, "typing"));
    redoStack = [];
    trimStack();
  }
  lastTypingAt = now;
  lastSeenText = next;
}

// ── Applying a step ────────────────────────────────────────────────────────

// Put the note back to `entry`, and the reader back where they were.
//
// The two modes need different treatment and neither is optional. In raw mode
// the textarea is the document, so it has to be written AND its mirror repainted
// — the mirror is the only thing painting visible text, so skipping it leaves
// the reader looking at the text they just undid. In the rendered view the
// repaint goes through renderNotesViewPinned, the same in-place path every other
// edit uses, and then the scroll is restored explicitly because the note may
// have changed height by more than the pin is willing to correct.
function applyNotesHistoryEntry(entry) {
  state.notes = entry.text;
  const editing = Boolean(el.notesEdit && !el.notesEdit.hidden);
  syncNotesHistoryBaseline(entry.text);

  if (editing) {
    // The snapshot is the whole source; the editor only ever shows the body, and
    // the caret offsets in `entry.at` were recorded against that body. Clamped
    // to the value actually written, not to the snapshot's length, or an undo
    // taken at the very end of a note would put the caret past the end of the
    // textarea.
    const editorValue = rawEditorValueFor(entry.text);
    el.notesEdit.value = editorValue;
    const caret = Math.min(entry.at.editing ? entry.at.caret : 0, editorValue.length);
    const caretEnd = Math.min(entry.at.editing ? entry.at.caretEnd : caret, editorValue.length);
    el.notesEdit.setSelectionRange(caret, caretEnd);
    // Not a dispatched "input": that would re-enter recordNotesTyping and, worse,
    // run every other input listener (the note-link picker, the autosave) as
    // though the reader had typed. Persist directly instead.
    refreshHighlightBackdrop(el.notesEdit);
    if (entry.at.editing) el.notesEdit.scrollTop = entry.at.scrollTop;
    el.notesEdit.focus();
    scheduleDeckAutosave();
    return Promise.resolve();
  }

  return renderNotesViewPinned().then(() => {
    if (!el.notesView || entry.at.editing) return;
    // The pin holds the reader's CURRENT anchor still; this puts them back where
    // the snapshot was taken, which is a different question and the right one
    // for an undo.
    el.notesView.scrollTop = entry.at.scrollTop;
    if (entry.at.scrollLeft != null) el.notesView.scrollLeft = entry.at.scrollLeft;
  }).then(() => scheduleDeckAutosave());
}

export function undoNotes() {
  if (!undoStack.length) {
    showToast("Nothing to undo", "info");
    return Promise.resolve(false);
  }
  const entry = undoStack.pop();
  // The state being left becomes the redo target. Captured here rather than in
  // the caller so a redo lands on exactly what undo moved away from.
  redoStack.push(entryFor(state.notes || "", entry.label));
  return applyNotesHistoryEntry(entry).then(() => {
    showToast(entry.label === "typing" ? "Undid typing" : `Undid ${entry.label.toLowerCase()}`);
    return true;
  });
}

export function redoNotes() {
  if (!redoStack.length) {
    showToast("Nothing to redo", "info");
    return Promise.resolve(false);
  }
  const entry = redoStack.pop();
  undoStack.push(entryFor(state.notes || "", entry.label));
  trimStack();
  return applyNotesHistoryEntry(entry).then(() => {
    showToast(entry.label === "typing" ? "Redid typing" : `Redid ${entry.label.toLowerCase()}`);
    return true;
  });
}

export function clearNotesHistory() {
  undoStack = [];
  redoStack = [];
  lastSeenText = null;
  lastTypingAt = 0;
  expectingActionResult = false;
}
