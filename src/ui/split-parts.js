// Side by side parts: which parts of the open file are on screen.
//
// A file has four parts — Cards, Notes, PDFs and Canvas — and the reader can
// have any two of them up at once, side by side (styles/99-split-parts.css).
// Two facts describe that, and both live on `state`:
//
//   state.viewMode   the FOCUSED part: the one the tab row's tools, the ⇓ and ◐
//                    buttons, the keyboard, the time log and "open on this tab
//                    next time" all follow. Exactly what it always meant.
//   state.splitPart  the part shown BESIDE it, or null when only one is up.
//                    Never the same as state.viewMode.
//
// So there are two different questions a module can ask, and they must not be
// confused: "is the reader working in the notes?" is `state.viewMode ===
// "notes"`, and "can the reader see the notes?" is isPartShown("notes"). A
// keyboard shortcut asks the first; a scroll listener, a teleprompter, a
// reading-position save or a repaint after a sync asks the second.
//
// A LEAF in all but state — it imports nothing else — so that every module that
// has to ask the second question can, without joining an import cycle. The
// switching itself (open, close, focus) is src/ui/view-mode.js's, which is
// where the stages are shown and hidden.

import { state } from "../core/state.js?v=__BUILD__";

// The view modes that are parts, in tab order. "document" is the PDFs tab and
// "handwriting" the Canvas tab (NOMENCLATURE.md: the stored names stay).
export const SPLIT_PART_MODES = ["cards", "notes", "document", "handwriting"];

export function isDocumentPartMode(mode) {
  return mode === "document" || mode === "handwriting";
}

export function isPartsSplitOpen() {
  return Boolean(state.splitPart);
}

export function isPartShown(mode) {
  return state.viewMode === mode || state.splitPart === mode;
}

export function isNotesShown() {
  return isPartShown("notes");
}

export function isCardsShown() {
  return isPartShown("cards");
}

// The PDFs or the Canvas, or (side by side) both.
export function isDocumentPartShown() {
  return isDocumentPartMode(state.viewMode) || isDocumentPartMode(state.splitPart);
}

// The document part the stage tools act on: the focused one when a document is
// focused, otherwise the one beside. Null when neither part is a document.
export function documentPartInFocus() {
  if (isDocumentPartMode(state.viewMode)) return state.viewMode;
  if (isDocumentPartMode(state.splitPart)) return state.splitPart;
  return null;
}
