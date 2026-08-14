// Page-scroll locking while an overlay is up, and knowing whether one is.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { appInfoModal } from "../pwa/app-info.js?v=__BUILD__";
import { helpModal } from "./help.js?v=__BUILD__";

export function lockPageScroll() {
  if (document.documentElement.classList.contains("modal-scroll-lock")) return;
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
    // The Cloze Review panel takes a scroll lock like the rest, so it has to be
    // listed here too — unlockPageScroll consults this to decide whether the
    // lock still has an owner.
    (el.clozePanel && !el.clozePanel.hidden) ||
    (el.importPanel && el.importPanel.classList.contains("is-open"))
  );
}
