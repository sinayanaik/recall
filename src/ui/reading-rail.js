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
// ── It is the way IN as well as the way out ────────────────────────────────
//
// It used to exist ONLY while the chrome was collapsed, on the argument that
// outside focus mode every one of these controls is already on screen in the row
// above, so a second permanently-visible copy is a second thing to keep in step
// and a second thing to explain.
//
// That argument holds for the CONTENTS of the tray and does not hold for the
// tray itself, because it leaves the rail unable to be the way in. On a phone
// the routes into focus mode were: scroll down (portrait only — see
// CHROME_MOBILE_QUERY), Ctrl+. (no keyboard), or the ⤢ row inside the notes ⋯
// menu. So on a landscape phone, which is the shape where the app's own header
// costs the largest fraction of the screen, focus mode was three presses deep
// inside a menu and full screen was beside it. "There should be some dedicated
// reliable button for full / focus screen in even mobile screen landscape mode"
// is exactly that.
//
// So the rail is on screen whenever a deck is open — quiet while the chrome is
// up, full strength once it folds (styles/38-reading-rail.css) — and the two
// mode rows are pinned to the bottom of the tray so they never fall below a
// scroll on a short screen.
//
// ── Two rules it still follows ─────────────────────────────────────────────
//
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

export function isReadingRailExpanded() {
  return el.readingRail?.dataset.expanded === "true";
}

export function setReadingRailExpanded(open) {
  const rail = el.readingRail;
  if (!rail) return;
  rail.dataset.expanded = open ? "true" : "false";
  el.readingRailGrip?.setAttribute("aria-expanded", open ? "true" : "false");
}

// ── Why there is no idle timer here any more ───────────────────────────────
//
// There was one: RAIL_IDLE_MS, 3200ms, armed on every touch-open, on the
// argument that a finger has no pointerleave so something has to end it. What
// actually ends it is already covered three ways — pressing a row, pressing
// anywhere else on the page (the capture-phase pointerdown below), and now the ✕
// in the tray's own head. The timer only ever added a fourth way that fires
// while the reader is still looking at the tray, deciding: sixteen labelled rows
// is more than 3.2 seconds of reading, so the common outcome was the menu
// closing itself mid-decision and having to be opened again. That is the
// "not seamlessly changing the modes" half of the report.
function expandRail() {
  setReadingRailExpanded(true);
  // Which rows apply, and which way each mode is set — read at the moment the
  // tray is opened rather than when one of its own rows is pressed, since dark
  // page and region select can equally have been flipped from the document
  // controls before focus mode folded them away.
  refreshReadingRailRows();
}

// How long the grip stays lit after focus mode is entered. Long enough to be
// noticed at the moment the header vanishes — which is when the reader is
// actually asking where the tabs went — and short enough that it is a flicker
// on the edge rather than a second piece of furniture.
export const RAIL_HINT_MS = 1500;

let hintTimer = 0;

// WHETHER the rail is on screen is decided in CSS, from one fact the app already
// publishes: whether #viewModeToggle is hidden (updateCardControls hides it when
// no deck is loaded, and a rail of view tabs and "contents" means nothing
// without one). It is reached with :has() from <body>, the same way
// styles/33-reading-chrome.css reaches the appbar from the quiz panel — so there
// is no second opinion here that could go stale, and no import edge from the
// module that owns that fact.
//
// body.chrome-collapsed no longer decides whether the rail EXISTS, only how loud
// it is. See the note at the top of this file.
//
// One thing is left for JavaScript: say the rail is there. The grip is
// deliberately quiet, and a quiet control on a screen edge is findable only by
// someone who already knows about it — which was the whole of the report that
// produced the ☰ redesign. So entering focus mode brightens it for
// RAIL_HINT_MS. applyChromeCollapse calls this in the same breath as it toggles
// the class, so the hint lands on exactly the frame the header folds away on and
// never on any other.
//
// ── It no longer closes the tray ──────────────────────────────────────────
//
// It used to, whenever the chrome came back: a tray left expanded was a column
// of icons that would reappear already open the next time focus mode was
// entered. That was true while the rail vanished with the chrome, and it is the
// wrong behaviour now — because the tray is where focus mode is turned OFF, and
// this ran as a consequence of turning it off. Press Focus mode, watch the thing
// you pressed it in disappear, and the switch you were looking at is gone before
// it has finished moving. For the two rows this redesign is about that is the
// difference between a switch and a trapdoor.
//
// The tray still closes three ways, all of them the reader's: the ✕ in its head,
// a press anywhere else on the page, and pressing a row that goes somewhere.
export function refreshReadingRail() {
  const rail = el.readingRail;
  if (!rail) return;
  clearTimeout(hintTimer);
  hintTimer = 0;
  if (!document.body.classList.contains("chrome-collapsed")) {
    rail.classList.remove("is-hinting");
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
  // The Document view is now reachable on a deck with no PDF, where it shows the
  // offer of one — so "the Document view is on screen" stopped being the same
  // question as "there is a document". Fit to width, dark page and select a
  // region all act on pages that do not exist there.
  const hasDocument = Boolean(state.meta?.pdf);
  tray.querySelectorAll("[data-rail-scope]").forEach((node) => {
    const scope = node.dataset.railScope;
    node.hidden = scope !== state.viewMode || (scope === "document" && !hasDocument);
  });
  // Contents belongs to both reading surfaces, so it carries no scope — but on
  // the Document view with nothing attached it would open the PDF outline drawer
  // to "No contents in this PDF", which is a true sentence about a file that is
  // not there.
  const contentsRow = tray.querySelector('[data-rail-action="contents"]');
  if (contentsRow) contentsRow.hidden = state.viewMode === "document" && !hasDocument;
  // "Go to bookmark" only once there is one to go to, exactly as
  // refreshBookmarkButtonUI hides the button this row stands in for.
  const goRow = tray.querySelector('[data-rail-action="bookmark-go"]');
  if (goRow && !goRow.hidden) goRow.hidden = Boolean(el.bookmarkGoBtn?.hidden);
  // Says where the reader is, at the top of the tray. The tray is a list of
  // places to go and things to do TO SOMETHING, and naming the something is what
  // makes "Contents" and "Bookmark here" unambiguous when three of the four
  // views could plausibly own them.
  if (el.readingRailViewName) el.readingRailViewName.textContent = VIEW_NAMES[state.viewMode] || "Reading";
  refreshRailGroupHeadings();
  refreshReadingRailModes();
}

const VIEW_NAMES = {
  cards: "Cards",
  notes: "Notes",
  document: "Document"
};

// A heading with nothing under it is worse than no heading — "This page" over an
// empty gap is a row that failed to render as far as the reader is concerned.
// Every heading knows its own group name, so this is a walk of the headings
// rather than of the rows.
function refreshRailGroupHeadings() {
  const tray = el.readingRailTray;
  if (!tray) return;
  tray.querySelectorAll(".rr-group").forEach((heading) => {
    const name = heading.dataset.railGroup || "";
    const rows = tray.querySelectorAll(`.reading-rail-btn[data-rail-group="${CSS.escape(name)}"]`);
    heading.hidden = ![...rows].some((row) => !row.hidden);
  });
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
  // The edit pill says which way it is set with a CLASS, not aria-pressed
  // (enterNotesEditing/resetNotesEditingUI toggle `is-editing` on it), so this
  // one cannot go through mirrorMode. Same principle though: the answer is read
  // off the control that owns it, never derived a second time. Its label follows
  // too — the pill's title is already the sentence for whichever way it is set.
  const editRow = row("edit-notes");
  if (editRow) {
    const editing = Boolean(el.editNotesBtn?.classList.contains("is-editing"));
    editRow.setAttribute("aria-pressed", editing ? "true" : "false");
    const editLabel = editRow.querySelector(".rr-label");
    if (editLabel) editLabel.textContent = editing ? "Back to preview" : "Edit notes";
    const editIcon = editRow.querySelector(".rr-ico");
    if (editIcon) editIcon.textContent = editing ? "\u{1F441}" : "✎";
    if (el.editNotesBtn?.title) editRow.title = el.editNotesBtn.title;
  }
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

// One heading per run of rows carrying the same data-rail-group, inserted
// before the first of them. Exactly the shape moveButtonsIntoMenu uses for the
// notes ⋯ menu's data-nhm-group: the markup names the group and nothing in here
// holds a list that has to be edited when a row is added.
//
// The heading carries the group name back on its own dataset so
// refreshRailGroupHeadings can hide it when every row under it is hidden.
function buildRailGroupHeadings(tray) {
  let group = null;
  [...tray.querySelectorAll(".reading-rail-btn[data-rail-group]")].forEach((node) => {
    const name = node.dataset.railGroup || "";
    if (!name || name === group) {
      group = name;
      return;
    }
    group = name;
    const heading = document.createElement("div");
    heading.className = "rr-group";
    heading.dataset.railGroup = name;
    heading.setAttribute("role", "presentation");
    heading.textContent = name;
    node.parentNode.insertBefore(heading, node);
  });
}

export function initReadingRail() {
  const rail = el.readingRail;
  if (!rail) return;

  if (el.readingRailTray) buildRailGroupHeadings(el.readingRailTray);

  el.readingRailGrip?.addEventListener("click", () => {
    if (isReadingRailExpanded()) setReadingRailExpanded(false);
    else expandRail();
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
    // The tray's own ✕, checked before anything else so it can never be read as
    // a row. Its whole job is to be the way out that a finger can find — the
    // idle timer this replaced was the way out that found the reader instead.
    if (event.target.closest("#readingRailCloseBtn")) {
      setReadingRailExpanded(false);
      return;
    }
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
    // The pill's own click, not a copy of what it does. Everything else in this
    // tray calls an exported function; the edit toggle's behaviour lives in an
    // anonymous listener in src/main.js and has no name to import, and giving it
    // one here would mean two readings of "is the editor open" that could drift.
    // A programmatic click reaches the button even though the row it sits in is
    // pointer-events:none while the chrome is folded — click() dispatches at the
    // element, it does not hit-test.
    else if (action === "edit-notes") el.editNotesBtn?.click();
    // A toggle, not the one-way "Leave focus" this replaced — and now genuinely
    // two-way, because the rail is on screen whether or not focus mode is on. It
    // says which way it is set, which is the whole reason it changed: a control
    // that only ever offers to undo itself never tells you what state you are in.
    else if (action === "focus") setFocusMode(!isFocusModeActive());
    // ── The mode rows leave the tray open; everything else closes it ────────
    //
    // Every row here used to close the tray, which is right for the ones that GO
    // somewhere (a view, My Decks, the contents) and wrong for a toggle: pressing
    // Focus mode made the thing you pressed it in disappear, so you could not see
    // the switch move and could not press it again without re-opening the tray.
    // For the two rows this whole redesign is about — "some dedicated reliable
    // button for full / focus screen" — that is the difference between a switch
    // and a trapdoor.
    if (action !== "focus" && action !== "immersive") setReadingRailExpanded(false);
    // The modes among these say which way they are set, and the functions that
    // own that state paint their ORIGINAL buttons — which are in the folded row,
    // not here. So the rail reads the answer back off them.
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
