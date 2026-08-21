// The hardware/browser Back gesture, and the one ordered list of overlays that
// decides what it closes.
//
// OVERLAY_LAYERS is ordered by z-index, so Escape and Back always close the
// TOPMOST thing — a dialog opened from the drawer used to lose its Escape to
// the drawer underneath it. The history sentinel is always armed, because a
// popstate that arrives with nothing pushed exits the app.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { closeStylePanel } from "../cloud/style-sync.js?v=__BUILD__";
import { closeWebDeckExportMenus } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { closeMainMenu, isMainMenuOpen } from "../editor/toolbars.js?v=__BUILD__";
import { closeAllDeckTileMenus } from "../library/folder-tree.js?v=__BUILD__";
import { closeMyDecksMoreMenu } from "../library/my-decks-menu.js?v=__BUILD__";
import { closeHighlightNoteEditor, isHighlightNoteEditorOpen } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { closeNotesHeadMore, isNotesHeadMoreOpen } from "../notes/notes-head-overflow.js?v=__BUILD__";
import { commitNotesEditIfActive, isNotesEditing } from "../notes/notes-view.js?v=__BUILD__";
import { closeNotesToc, isNotesTocOpen } from "../notes/toc.js?v=__BUILD__";
import { closeClozePanel } from "../panels/cloze-panel.js?v=__BUILD__";
import { closeAppInfoModal } from "../pwa/app-info.js?v=__BUILD__";
import { closeQnCatMenu, closeQnCatModal, closeQuickNotesBoard } from "../quick-notes/board.js?v=__BUILD__";
import { closeDiagramModal } from "../render/diagram-zoom.js?v=__BUILD__";
import { closeStoragePanel } from "../storage/storage-panel.js?v=__BUILD__";
import { chromeFocusPinned, isImmersive, setFocusMode, setImmersiveMode } from "./chrome.js?v=__BUILD__";
import { closeImportPanel, closeMyDecksPanel } from "./deck-header.js?v=__BUILD__";
import { showToast } from "./feedback.js?v=__BUILD__";
import { closeHelpModal } from "./help.js?v=__BUILD__";
import { goNavBack } from "./nav-history.js?v=__BUILD__";
import { unlockPageScroll } from "./overlays.js?v=__BUILD__";

// The global Escape handler. Closes the single frontmost overlay, reusing that
// one's own Cancel/Close control so its cleanup (unbinding onclick handlers,
// releasing the scroll lock) runs exactly as it would from a real click.
//
// The stack, innermost first. This used to be the same list written as a chain
// of `if (…) { close(); return; }` statements; it is a table now because the
// hardware Back key needs to ask "is anything open?" as well as "close one
// thing", and two hand-maintained copies of a twenty-entry list in visual-stack
// order would drift apart the first time a panel was added.
//
// Order is the visual stack: transient popovers, then dialogs (which always sit
// above a panel), then the panels themselves. Each entry closes via that
// overlay's OWN Cancel/Close control wherever one exists, so its cleanup
// (unbinding onclick handlers, releasing the scroll lock) runs exactly as it
// would from a real click.
//
// The two menu-drawer entries are late additions. Both used to carry a private
// `keydown` listener of their own instead of being in this list, which is why
// Escape closed them but nothing else could — and why the hardware Back key
// would have walked straight past an open drawer and exited the app.
export const OVERLAY_LAYERS = [
  // Popovers.
  { isOpen: () => Boolean(document.querySelector(".qn-cat-menu")), close: () => closeQnCatMenu() },
  { isOpen: () => Boolean(el.myDecksMoreMenu && !el.myDecksMoreMenu.hidden), close: () => closeMyDecksMoreMenu() },
  { isOpen: () => Boolean(el.myDecksBody?.querySelector(".deck-tile-overflow-menu:not([hidden])")), close: () => closeAllDeckTileMenus() },
  { isOpen: () => Boolean(document.querySelector(".web-deck-export-menu:not([hidden]), .bulk-export-menu:not([hidden])")), close: () => closeWebDeckExportMenus() },
  { isOpen: () => Boolean(el.exportMenu && !el.exportMenu.hidden), close: () => { el.exportMenu.hidden = true; } },
  { isOpen: () => Boolean(el.exportNotesMenu && !el.exportNotesMenu.hidden), close: () => { el.exportNotesMenu.hidden = true; } },
  // The notes header's phone-only ⋯ menu. A popover like the rest of this
  // group, and it has to be in the list for the same reason they are: on a
  // phone the Back gesture is the primary dismiss, and without an entry here a
  // press aimed at the open menu would fall through to goNavBack() and load
  // another deck underneath it.
  { isOpen: () => isNotesHeadMoreOpen(), close: () => closeNotesHeadMore() },
  { isOpen: () => isHighlightNoteEditorOpen(), close: () => closeHighlightNoteEditor() },

  // The hamburger drawer sits here, above the dialogs, because it genuinely is
  // above them: .toolbar is z-index 500 against the help modal's 240 and the
  // confirm modal's 230. In practice the two rarely coexist — tapping anything
  // in the drawer closes it — but when they do, the thing covering the screen
  // is the thing a Back press means.
  { isOpen: () => isMainMenuOpen(), close: () => closeMainMenu() },

  // Dialogs.
  { isOpen: () => Boolean(el.confirmModal && !el.confirmModal.hidden), close: () => el.confirmModalCancelBtn?.click() },
  { isOpen: () => Boolean(el.promptModal && !el.promptModal.hidden), close: () => el.promptModalCancelBtn?.click() },
  { isOpen: () => Boolean(el.frameCardModal && !el.frameCardModal.hidden), close: () => el.frameCardCancelBtn?.click() },
  { isOpen: () => Boolean(el.exportHighlightsModal && !el.exportHighlightsModal.hidden), close: () => el.exportHighlightsCancelBtn?.click() },
  { isOpen: () => Boolean(el.qnCatModal && !el.qnCatModal.hidden), close: () => closeQnCatModal() },
  // These two are read off the DOM rather than through their `helpModal` /
  // `appInfoModal` bindings, which are top-level `const`s declared thousands of
  // lines further down. This list can be walked during script
  // evaluation (the back-button setup runs near the bottom of the file but
  // still above those declarations), and a `typeof` test does NOT make a
  // let/const safe to touch early — reading one in its temporal dead zone
  // throws from typeof exactly as it would from a plain reference, which would
  // abort the rest of the file and leave half the app unbuilt.
  { isOpen: () => Boolean(document.getElementById("helpModal")?.hidden === false), close: () => closeHelpModal() },
  { isOpen: () => Boolean(document.getElementById("appInfoModal")?.hidden === false), close: () => closeAppInfoModal() },
  { isOpen: () => Boolean(el.syncModal && !el.syncModal.hidden), close: () => { el.syncModal.hidden = true; } },
  { isOpen: () => Boolean(el.diagramModal && !el.diagramModal.hidden), close: () => closeDiagramModal() },

  // Full-surface panels.
  { isOpen: () => Boolean(el.clozePanel && !el.clozePanel.hidden), close: () => closeClozePanel() },
  { isOpen: () => Boolean(el.quickNotesBoard && !el.quickNotesBoard.hidden), close: () => closeQuickNotesBoard() },
  { isOpen: () => Boolean(el.allCardsPanel && !el.allCardsPanel.hidden), close: () => closeAllCardsPanel() },
  { isOpen: () => Boolean(el.stylePanel && !el.stylePanel.hidden), close: () => closeStylePanel() },
  { isOpen: () => Boolean(el.storagePanel && !el.storagePanel.hidden), close: () => closeStoragePanel() },
  { isOpen: () => Boolean(el.myDecksPanel && !el.myDecksPanel.hidden), close: () => closeMyDecksPanel() },
  { isOpen: () => Boolean(el.importPanel && el.importPanel.classList.contains("is-open")), close: () => closeImportPanel() },

  // The notes table-of-contents drawer is LAST, unlike the hamburger drawer
  // above: at z-index 40 it is underneath every panel and dialog here, so any
  // of them opened over it must take the press first.
  { isOpen: () => isNotesTocOpen(), close: () => closeNotesToc() },

  // The raw markdown editor, below even the TOC drawer — it is inline content,
  // not an overlay, so everything above genuinely sits on top of it and takes
  // the press first. It belongs in this list all the same: a Back press with
  // the editor open used to walk straight past it into goNavBack(), loading
  // another deck UNDERNEATH a textarea still showing the note being left. (The
  // deck loaders now discard the editor on their own, so this is no longer the
  // data-loss path it was — but "Back closes the thing on screen" is the right
  // behaviour regardless, and it costs one extra press to leave a note you were
  // editing.) commitNotesEditIfActive writes the textarea back, re-renders and
  // schedules the save, which is exactly what a Back press should mean here.
  { isOpen: () => isNotesEditing(), close: () => commitNotesEditIfActive() }
];

// Closes the single frontmost overlay and reports whether it found one. ONE
// layer per press — the name is the contract. This used to fall through every
// branch and close the lot, so a single Escape aimed at a confirm dialog also
// took My Decks, the style panel, the import panel and the diagram modal with
// it.
export function closeTopmostOverlay() {
  const layer = OVERLAY_LAYERS.find((entry) => entry.isOpen());
  if (layer) {
    layer.close();
    return true;
  }

  // Focus mode last of all, and NOT in OVERLAY_LAYERS above. It isn't an
  // overlay — it's the absence of chrome — so it must never eat the Escape (or
  // the Back press) that was aimed at something drawn on top of it.
  //
  // Reached only once nothing else is open, this is the escape hatch of last
  // resort, and it is the ONLY one in some states: the ⤢ button that turns
  // focus mode on lives in the notes header, which doesn't exist in Cards view,
  // while the pin is remembered across sessions — and a collapsed appbar takes
  // the ☰ menu and the back chevron with it. Launch into Cards view with a
  // remembered pin and this branch is the whole way out. On desktop that's
  // Escape; on a phone (no Escape key) it is the hardware Back / edge swipe,
  // which lands here through handleBackGesture. Do not "tidy" focus mode into
  // OVERLAY_LAYERS — it would then eat a press aimed at a real overlay.
  //
  // Immersive mode is tested FIRST, and is not the same escape. It is focus
  // mode plus the browser's own chrome (see setImmersiveMode), so un-pinning
  // focus alone would bring the app's header back inside a window that is still
  // fullscreen — half out of a mode nobody asked to be half out of. Most
  // browsers eat Escape themselves to leave fullscreen and never dispatch it
  // here, in which case the fullscreenchange listener does this; Firefox does
  // dispatch it, and this is that path.
  if (isImmersive()) { setImmersiveMode(false); return true; }
  if (chromeFocusPinned) { setFocusMode(false); return true; }

  // Nothing left open: make sure a scroll lock didn't outlive its owner.
  unlockPageScroll();
  return false;
}

// ── The hardware / browser Back key ─────────────────────────────────────────
//
// Until this existed the app had no history integration at all: Back closed the
// tab, or dropped straight out of the installed PWA, even with a modal open on
// top of a deck you'd navigated three levels into. Everything the ← button
// knows how to do was unreachable from the gesture people actually use.
//
// A popstate cannot be cancelled — by the time it fires the entry is already
// gone — so "handle Back myself" has to be done by keeping a spare entry on the
// stack to spend. That's the sentinel: whenever there is anything in the app
// that Back should dismiss or step through, one extra entry sits above the real
// one. Back consumes it, we do the work, and we push a fresh one if there is
// still more to handle. When there is nothing left we don't re-push, and the
// next press leaves for real.
//
// Deliberately NOT modelled as one history entry per overlay. Overlays open and
// close from twenty different places, several of them async, and a stack that
// has to stay numerically in step with the DOM would desynchronise the first
// time something closed without going through Back — leaving phantom entries
// that swallow presses. ONE sentinel, always armed, plus "ask the app what's
// open at the moment of the press" cannot drift: nothing is remembered between
// presses that could be wrong.
//
// Always armed, rather than only while something is open. An earlier version
// armed on demand and had a hole in it: once the last overlay closed the guard
// was dropped, so the very next press escaped unhandled and dumped the user out
// of the app with no warning — the exact thing this is here to prevent.
export const BACK_STATE = "recall-guard";

export let backSentinelPushed = false;

// Timestamp of the "are you sure" press, so the second one within the window
// is let through. 0 when not armed.
export let backExitArmed = 0;

export function syncBackSentinel() {
  if (backSentinelPushed) return;
  try {
    history.pushState({ [BACK_STATE]: true }, "");
    backSentinelPushed = true;
  } catch (error) {
    // Sandboxed contexts can refuse pushState. Back then behaves exactly as it
    // did before any of this existed; nothing else breaks.
    console.warn("Could not arm the back-button guard", error);
  }
}

export async function handleBackGesture() {
  // Whatever we had armed is what the press just consumed.
  backSentinelPushed = false;

  // 1. Anything on screen gets dismissed first, one layer per press.
  if (closeTopmostOverlay()) {
    backExitArmed = 0;
    syncBackSentinel();
    return;
  }
  // 2. Then step back through where the user has been. Awaited because it may
  //    have to load a deck out of IndexedDB or the cloud; re-arming before the
  //    await would arm against the location being left, not the one landed on.
  if (await goNavBack()) {
    backExitArmed = 0;
    syncBackSentinel();
    return;
  }

  // 3. Nothing left to dismiss or step back to. Rather than dropping out of the
  //    app on one stray edge-swipe — easy to do on a phone, and it takes
  //    whatever was on screen with it — the first press asks and only a second
  //    one within the window is allowed through.
  const now = Date.now();
  if (backExitArmed && now - backExitArmed < BACK_EXIT_WINDOW_MS) {
    backExitArmed = 0;
    // Nothing re-armed above, so this lands on whatever preceded the app.
    history.back();
    return;
  }
  backExitArmed = now;
  showToast("Press back again to leave Recall");
  syncBackSentinel();
}

export const BACK_EXIT_WINDOW_MS = 2500;

export function initBackGesture() {
  // A base entry of our own, so the sentinel always has something beneath it
  // and the first Back has somewhere to land.
  try {
    history.replaceState({ recall: "root" }, "");
  } catch (error) {
    console.warn("Could not initialise history", error);
  }
  window.addEventListener("popstate", () => { handleBackGesture(); });
  // Re-arming is otherwise driven entirely by popstate; this is a cheap safety
  // net (one boolean test per click) in case the initial push was refused or a
  // bfcache restore dropped it.
  document.addEventListener("click", () => syncBackSentinel(), true);
  // Scheduled, never synchronous: initBackGesture runs during script
  // evaluation, well above the point where much of the app is declared.
  requestAnimationFrame(() => syncBackSentinel());
}
