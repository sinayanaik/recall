// The rail focus mode gives back.
//
// `body.chrome-collapsed` folds the appbar and the whole view-mode row away
// (styles/12-notes.css:1255, styles/16-mobile-reading.css:338). That is the
// point of focus mode — src/ui/chrome.js opens with the measurement: ~130px of
// deck title, category, card score and sync countdown that nobody reading a
// paper is reading. It is also its one real cost, because the table of contents,
// the four view tabs and the way back to My Decks all live in those two bars.
// Reading a paper and then wanting its contents meant leaving focus mode,
// pressing the thing, and entering focus mode again — which is not a mode, it is
// a chore, and it is why people stop using focus mode.
//
// So this is what stays behind: a nine-pixel grip on the right edge that expands
// into the seven controls focus mode took away, and puts itself away afterwards.
//
// ── Three rules it follows ─────────────────────────────────────────────────
//
//   • It exists ONLY while the chrome is collapsed. Outside focus mode every one
//     of these controls is already on screen in the row above, and a second
//     permanently-visible copy of a visible control is a second thing to keep in
//     step and a second thing to explain.
//   • Its buttons are NEW nodes, not moved ones. The notes and document controls
//     are moved into the view-mode row precisely because they carry handlers
//     (see notes-head-overflow.js); these carry none — every one calls a
//     function that already exists — so there is nothing to lose by building
//     them, and building them is what lets both copies exist at once.
//   • It never becomes a second opinion about where the reader is. setViewMode
//     paints `is-active` onto the rail's buttons in the same pass it paints the
//     tabs, and refreshDocumentTab hides the Document icon on a deck with no PDF
//     in the same pass it hides the Document tab.
//
// ── The right edge, deliberately ───────────────────────────────────────────
//
// The left edge belongs to the app's own back gesture (src/ui/back-gesture.js),
// and the text belongs to the touch-selection controller's handles. The right
// edge is where a scrollbar already trains the eye to reach and where neither of
// those two is listening.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { openMyDecksPanel } from "./deck-header.js?v=__BUILD__";
import { setFocusMode } from "./chrome.js?v=__BUILD__";
import { setViewMode } from "./view-mode.js?v=__BUILD__";
import { toggleNotesToc } from "../notes/toc.js?v=__BUILD__";

// How long an expanded rail waits before folding itself back up after a touch.
// There is no pointerleave on a finger, so something has to end it — and long
// enough that reading the icons and deciding is not a race.
export const RAIL_IDLE_MS = 3200;

let idleTimer = 0;

export function isReadingRailExpanded() {
  return el.readingRail?.dataset.expanded === "true";
}

export function setReadingRailExpanded(open) {
  const rail = el.readingRail;
  if (!rail) return;
  rail.dataset.expanded = open ? "true" : "false";
  el.readingRailGrip?.setAttribute("aria-expanded", open ? "true" : "false");
  clearTimeout(idleTimer);
  idleTimer = 0;
}

function expandWithIdleTimeout() {
  setReadingRailExpanded(true);
  // Only for a coarse pointer. A mouse has pointerleave, which is a better
  // answer than a timer — a rail that folds away while the pointer is still on
  // it reads as a glitch.
  if (!window.matchMedia?.("(pointer: coarse)")?.matches) return;
  idleTimer = setTimeout(() => setReadingRailExpanded(false), RAIL_IDLE_MS);
}

// WHETHER the rail is on screen is decided in CSS, from two facts the app
// already publishes: body.chrome-collapsed, and whether #viewModeToggle is
// hidden (updateCardControls hides it when no deck is loaded, and a rail of
// view tabs and "contents" means nothing without one). Both are reached with
// :has() from <body>, the same way styles/33-reading-chrome.css reaches the
// appbar from the quiz panel — so there is no second opinion here that could go
// stale, and no import edge from the modules that own those two facts.
//
// What is left for JavaScript is the one thing CSS cannot do: put the tray away.
// A rail left expanded when the chrome comes back is a column of icons that
// reappears already open the next time focus mode is entered.
export function refreshReadingRail() {
  if (!el.readingRail) return;
  if (!document.body.classList.contains("chrome-collapsed")) setReadingRailExpanded(false);
}

// The contents of whatever is being read. One button, because "contents" means
// one thing to a reader and the fact that a markdown TOC and a PDF outline are
// built by different modules is not their problem.
function toggleContents() {
  if (state.viewMode === "document") {
    const drawer = el.documentOutlineDrawer;
    if (!drawer) return;
    const open = drawer.hidden;
    drawer.hidden = !open;
    el.documentTocBtn?.setAttribute("aria-expanded", String(open));
    return;
  }
  toggleNotesToc();
}

export function initReadingRail() {
  const rail = el.readingRail;
  if (!rail) return;

  el.readingRailGrip?.addEventListener("click", () => {
    if (isReadingRailExpanded()) setReadingRailExpanded(false);
    else expandWithIdleTimeout();
  });

  // Hover opens it on a pointer, which is what makes the grip cost one gesture
  // rather than two. `pointerenter` and not `mouseenter` so a stylus counts.
  rail.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    setReadingRailExpanded(true);
  });

  rail.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "touch") return;
    setReadingRailExpanded(false);
  });

  rail.addEventListener("click", (event) => {
    const view = event.target.closest("[data-view-mode]");
    if (view) {
      setViewMode(view.dataset.viewMode, { deferRender: true });
      setReadingRailExpanded(false);
      return;
    }
    const button = event.target.closest("[data-rail-action]");
    if (!button) return;
    const action = button.dataset.railAction;
    if (action === "decks") openMyDecksPanel();
    else if (action === "contents") toggleContents();
    else if (action === "leave-focus") setFocusMode(false);
    setReadingRailExpanded(false);
  });

  // A press anywhere else folds it back up — the rail overlays the page, and one
  // left open is a column of icons sitting on top of what is being read.
  document.addEventListener("pointerdown", (event) => {
    if (!isReadingRailExpanded()) return;
    if (event.target.closest("#readingRail")) return;
    setReadingRailExpanded(false);
  }, true);

  refreshReadingRail();
}
