// Page-scroll locking while an overlay is up, and knowing whether one is.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { isHighlightNoteEditorOpen } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { appInfoModal } from "../pwa/app-info.js?v=__BUILD__";
import { helpModal } from "./help.js?v=__BUILD__";

// ── Is there anything to lock? ─────────────────────────────────────────────
//
// The lock is not a class toggle that happens to change two colours. It puts
// `overflow: hidden` on <html> and `position: fixed; inset: 0` on <body>, and
// each of those makes the root element a different kind of scrolling box — so
// the browser re-lays out and re-paints the whole document, including whatever
// note is open behind the overlay.
//
// Measured on a 2.5MB / 19,380-block book at a 6x CPU throttle (a mid-range
// phone), with tools/mobile-menu-check.mjs:
//
//     html.style.overflow = "hidden"            ~700ms
//     the modal-scroll-lock class pair          ~600ms to take, ~600ms to release
//     body.style.overflow = "hidden"             ~75ms
//     asking whether the page can scroll           0ms
//
// Every overlay in the app takes this lock — My Decks, Import, All Cards, the
// Style panel, Help, App Info, the cloze panel, every confirm and prompt, the
// diagram zoom. So on a phone with a book open, roughly 1.2 seconds of layout
// was the price of opening and closing ANY of them. That is the "the app UI
// becomes very very laggy, I press a button and it answers seconds later"
// report, and it is browser work rather than ours, which is why five rounds of
// profiling our own JavaScript never found it.
//
// And in the overwhelmingly common case there is nothing to lock. `.app-shell`
// is a fixed-height grid (`height: var(--app-height); overflow: hidden` —
// styles/02-shell.css:4), so the document itself does not scroll: measured
// behind an open drawer with the book loaded, scrollHeight and clientHeight are
// both exactly the viewport height. The lock still matters when the reader has
// set App height above 100% in the Style panel (appHeightPercent is free text),
// which is why this asks rather than assumes.
//
// scrollHeight is a layout read, but a free one here: it is taken at the moment
// an overlay opens, when nothing has been written yet and layout is clean.
export function pageCanScroll() {
  const root = document.documentElement;
  // +1 for sub-pixel: a scrollHeight that rounds a hair above clientHeight is
  // not a page anyone can scroll.
  return root.scrollHeight > root.clientHeight + 1;
}

export function lockPageScroll() {
  if (document.documentElement.classList.contains("modal-scroll-lock")) return;
  // Nothing to lock. unlockPageScroll keys off the class, so it stays a no-op
  // to match, and neither side has to remember what the other decided.
  if (!pageCanScroll()) return;
  state.stylePanelScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${state.stylePanelScrollY}px`;
  document.documentElement.classList.add("modal-scroll-lock");
  document.body.classList.add("modal-scroll-lock");
}

export function unlockPageScroll() {
  if (!document.documentElement.classList.contains("modal-scroll-lock")) return;
  // Something else is STILL on screen (a rename prompt opened from My Decks, a
  // delete confirm over the style panel, …). lockPageScroll is a no-op when the
  // lock is already held, so the inner overlay never took a lock of its own —
  // releasing one here would hand the page back its scroll (and jump it to the
  // pre-lock offset) while the outer panel is still covering it. Leave the
  // release to whichever overlay closes last. Every close path hides its own
  // element BEFORE calling this, so anyModalOpen() never sees the caller.
  if (anyModalOpen()) return;
  const scrollY = state.stylePanelScrollY || 0;
  document.documentElement.classList.remove("modal-scroll-lock");
  document.body.classList.remove("modal-scroll-lock");
  document.body.style.top = "";
  window.scrollTo(0, scrollY);
}

// True while any modal/panel/overlay is on screen — used to keep the global
// keydown handler's card shortcuts (Space/Enter/arrows/K/R) from silently
// acting on the card underneath an open dialog.
export function anyModalOpen() {
  return Boolean(
    (el.confirmModal && !el.confirmModal.hidden) ||
    (el.promptModal && !el.promptModal.hidden) ||
    (el.frameCardModal && !el.frameCardModal.hidden) ||
    (el.exportHighlightsModal && !el.exportHighlightsModal.hidden) ||
    isHighlightNoteEditorOpen() ||
    (el.myDecksPanel && !el.myDecksPanel.hidden) ||
    (typeof helpModal !== "undefined" && helpModal && !helpModal.hidden) ||
    (typeof appInfoModal !== "undefined" && appInfoModal && !appInfoModal.hidden) ||
    (el.stylePanel && !el.stylePanel.hidden) ||
    (el.storagePanel && !el.storagePanel.hidden) ||
    (el.diagramModal && !el.diagramModal.hidden) ||
    (el.syncModal && !el.syncModal.hidden) ||
    (el.allCardsPanel && !el.allCardsPanel.hidden) ||
    (el.quickNotesBoard && !el.quickNotesBoard.hidden) ||
    (el.qnCatModal && !el.qnCatModal.hidden) ||
    // The drawing sheet. Read off the DOM rather than through isInkSheetOpen()
    // for the same reason helpModal and appInfoModal are below — except that
    // here it is not a declaration-order problem but an import one:
    // src/notes/ink-sheet.js takes its scroll lock from THIS module, so the
    // arrow between them only points one way. It is built lazily and appended
    // to the body, hence the id rather than an `el` binding.
    //
    // Without this entry a full-surface modal that had taken a scroll lock was
    // invisible to unlockPageScroll's owner test, and the card shortcuts
    // (Space/Enter/arrows/K/R) still acted on the card behind a drawing.
    Boolean(document.querySelector("#inkSheet:not([hidden])")) ||
    (el.hwBoard && !el.hwBoard.hidden) ||
    // The Cloze Review panel takes a scroll lock like the rest, so it has to be
    // listed here too — unlockPageScroll consults this to decide whether the
    // lock still has an owner.
    (el.clozePanel && !el.clozePanel.hidden) ||
    (el.importPanel && el.importPanel.classList.contains("is-open"))
  );
}
