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
// So this is what stays behind: a small ☰ on the right edge that expands into
// the seven controls focus mode took away, and puts itself away afterwards.
//
// It was a nine-pixel grip, on the argument that an icon at that size is a guess
// and a grip says "there is something here" without naming it. In use nobody
// found it — "I am not seeing anything in focus mode" — for reasons that are
// specific and are set out in styles/38-reading-rail.css: a 26%-alpha tint has
// no background it reliably contrasts with, right:0 lands it on the scrollbar,
// and top:50% is the one band the eye does not sweep. The grip is a real button
// now, it sits near the top, and refreshReadingRail lights it for a beat as the
// header folds so it is seen at the moment it is wanted.
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
import { toggleDocumentToc } from "../documents/pdf-outline.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { openMyDecksPanel } from "./deck-header.js?v=__BUILD__";
import { hasStudyTextSelection, isFocusModeActive, setFocusMode, toggleImmersiveMode } from "./chrome.js?v=__BUILD__";
import { setViewMode } from "./view-mode.js?v=__BUILD__";
import { toggleNotesToc } from "../notes/toc.js?v=__BUILD__";
import { bookmarkCurrentSpot, goToBookmark } from "../notes/bookmark.js?v=__BUILD__";
import { openStylePanel } from "../cloud/style-sync.js?v=__BUILD__";
import { reconcileAllDecks } from "../sync/reconcile.js?v=__BUILD__";
import { fitDocumentToWidth, togglePdfInvert } from "../documents/pdf-view.js?v=__BUILD__";
import { toggleRegionSelect } from "../documents/pdf-region.js?v=__BUILD__";

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
  // Which rows apply, and which way each mode is set — read at the moment the
  // tray is opened rather than when one of its own rows is pressed, since dark
  // page and region select can equally have been flipped from the document
  // controls before focus mode folded them away.
  refreshReadingRailRows();
  // Only for a coarse pointer. A mouse has pointerleave, which is a better
  // answer than a timer — a rail that folds away while the pointer is still on
  // it reads as a glitch.
  if (!window.matchMedia?.("(pointer: coarse)")?.matches) return;
  idleTimer = setTimeout(() => setReadingRailExpanded(false), RAIL_IDLE_MS);
}

// How long the grip stays lit after focus mode is entered. Long enough to be
// noticed at the moment the header vanishes — which is when the reader is
// actually asking where the tabs went — and short enough that it is a flicker
// on the edge rather than a second piece of furniture.
export const RAIL_HINT_MS = 1500;

let hintTimer = 0;

// WHETHER the rail is on screen is decided in CSS, from two facts the app
// already publishes: body.chrome-collapsed, and whether #viewModeToggle is
// hidden (updateCardControls hides it when no deck is loaded, and a rail of
// view tabs and "contents" means nothing without one). Both are reached with
// :has() from <body>, the same way styles/33-reading-chrome.css reaches the
// appbar from the quiz panel — so there is no second opinion here that could go
// stale, and no import edge from the modules that own those two facts.
//
// Two things are left for JavaScript.
//
//   • Put the tray away. A rail left expanded when the chrome comes back is a
//     column of icons that reappears already open the next time focus mode is
//     entered.
//   • Say it is there. The grip is deliberately quiet, and a quiet control on a
//     screen edge is findable only by someone who already knows about it —
//     which was the whole of the report that produced the ☰ redesign. So
//     entering focus mode brightens it for RAIL_HINT_MS. applyChromeCollapse
//     calls this in the same breath as it toggles the class, so the hint lands
//     on exactly the frame the header folds away on and never on any other.
export function refreshReadingRail() {
  const rail = el.readingRail;
  if (!rail) return;
  clearTimeout(hintTimer);
  hintTimer = 0;
  if (!document.body.classList.contains("chrome-collapsed")) {
    rail.classList.remove("is-hinting");
    setReadingRailExpanded(false);
    return;
  }
  rail.classList.add("is-hinting");
  hintTimer = setTimeout(() => rail.classList.remove("is-hinting"), RAIL_HINT_MS);
}

// ── Which rows belong to the view being read ──────────────────────────────
//
// Some of the rail's rows belong to one surface: dark page and select a region
// mean nothing over a markdown note, and the bookmarks mean nothing over a page
// of a PDF — bookmarkCurrentSpot returns without a word unless the notes view
// is the one on screen, and a row that does nothing when pressed is worse than
// no row.
//
// Painted when the tray OPENS rather than from setViewMode, for two reasons:
// the tray is display:none until then, so there is no moment where a wrong
// answer is on screen; and reaching back into this file from view-mode.js would
// close the very import cycle the note at the top of this file exists to avoid
// — reading-rail reaches setViewMode, the bookmarks, the style panel and sync,
// and none of those may be pulled in ahead of view-mode's own evaluation.
export function refreshReadingRailRows() {
  const tray = el.readingRailTray;
  if (!tray) return;
  tray.querySelectorAll("[data-rail-scope]").forEach((node) => {
    node.hidden = node.dataset.railScope !== state.viewMode;
  });
  // "Go to bookmark" only once there is one to go to, exactly as
  // refreshBookmarkButtonUI hides the button this row stands in for.
  const goRow = tray.querySelector('[data-rail-action="bookmark-go"]');
  if (goRow && !goRow.hidden) goRow.hidden = Boolean(el.bookmarkGoBtn?.hidden);
  refreshReadingRailModes();
}

// The rail's modes and one of its labels, read back off the controls that own
// them.
//
// Dark page, region select, full screen and focus mode each
// already publish their state as aria-pressed on their own button
// (togglePdfInvert, toggleRegionSelect, paintInlineNotesButton,
// paintImmersiveButton, applyChromeCollapse), and the
// bookmark button already says whether pressing it will SET a bookmark or MOVE
// the one you have. All of those buttons are in the row focus mode folds away,
// so the rail's copies have to be told. Copying the answer is right and
// deriving it again would not be: two readings of one mode is exactly the
// "second opinion" this file exists to avoid.
export function refreshReadingRailModes() {
  const tray = el.readingRailTray;
  if (!tray) return;
  const row = (action) => tray.querySelector(`[data-rail-action="${action}"]`);
  const mirrorMode = (action, source) => {
    const node = row(action);
    if (!node) return;
    node.setAttribute("aria-pressed", source?.getAttribute("aria-pressed") === "true" ? "true" : "false");
  };
  mirrorMode("dark-page", el.documentDarkBtn);
  mirrorMode("region", el.documentRegionBtn);
  mirrorMode("immersive", el.immersiveModeBtn);
  mirrorMode("focus", el.focusModeBtn);
  const setRow = row("bookmark-set");
  const setLabel = el.bookmarkSetBtn?.querySelector(".nhm-label")?.textContent?.trim();
  const rowLabel = setRow?.querySelector(".rr-label");
  // "Bookmark here" / "Move bookmark here" — a note keeps exactly one, and a
  // reader should not have to lose theirs to find that out.
  if (rowLabel && setLabel) rowLabel.textContent = setLabel.startsWith("Move") ? "Move bookmark here" : "Bookmark here";
  if (setRow && el.bookmarkSetBtn?.title) setRow.title = el.bookmarkSetBtn.title;
}

// The contents of whatever is being read. One button, because "contents" means
// one thing to a reader and the fact that a markdown TOC and a PDF outline are
// built by different modules is not their problem.
function toggleContents() {
  // Each surface's own opener, and neither is a `hidden` flip: both drawers are
  // revealed by an `.is-open` class (styles/12-notes.css:801). This row used to
  // flip `hidden` on the document drawer itself and got a fully transparent
  // panel parked off the left edge for its trouble — see openDocumentToc.
  if (state.viewMode === "document") return toggleDocumentToc();
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
  //
  // Never mid-selection. Dragging a selection out to the right edge of the
  // window is how you extend it to the end of a line, and a tray unfolding over
  // the words being selected is the app taking the gesture away at the moment
  // it is being made.
  rail.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    if (hasStudyTextSelection()) return;
    setReadingRailExpanded(true);
    refreshReadingRailRows();
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
    else if (action === "bookmark-set") bookmarkCurrentSpot();
    else if (action === "bookmark-go") goToBookmark();
    else if (action === "style") openStylePanel();
    else if (action === "sync") reconcileAllDecks({ explicit: true });
    else if (action === "immersive") toggleImmersiveMode();
    else if (action === "fit-width") fitDocumentToWidth();
    else if (action === "dark-page") togglePdfInvert();
    else if (action === "region") toggleRegionSelect();
    // A toggle, not the one-way "Leave focus" this replaced. In the rail it is
    // always on when it is reachable — the rail only exists while the chrome is
    // collapsed — so pressing it does leave focus mode, which is what the old
    // row did. What is different is that the row now SAYS it is on, which is
    // the whole reason it changed: a control that only ever offers to undo
    // itself never tells you what state you are in.
    else if (action === "focus") setFocusMode(!isFocusModeActive());
    setReadingRailExpanded(false);
    // The three modes among these say which way they are set, and the functions
    // that own that state paint their ORIGINAL buttons — which are in the folded
    // row, not here. So the rail reads the answer back off them.
    refreshReadingRailModes();
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
