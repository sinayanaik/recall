// The notes header's overflow menu.
//
// On a phone the Notes view stacked FOUR bars above the first line of text: the
// appbar, the Cards/Notes/Highlights toggle, the notes header, and the
// B/I/U/S/</>/colour strip that styles/10-editor.css:881 promoted onto a
// full-width row of its own below 560px. That promotion was the right call at
// the time: nine controls plus the strip did not fit on one 360px row, and the
// ones that overflowed did not scroll out of reach, they vanished
// (.quiz-panel is overflow:hidden on mobile).
//
// This takes the other half of that trade. Six low-frequency buttons move into
// a popover, at EVERY width — a desktop header carried thirteen controls in one
// row, and having room for them is not a reason to show them. (The formatting
// strip itself is gone from the header entirely now; it rides in the floating
// selection pill, where it can actually be used. See initRenderToolbars.)
//
// They are MOVED, not cloned. Every one of them already has a handler attached
// somewhere else (three by id in main.js, three through the document-level
// [data-render-action] delegation), and a clone would have none of them while
// looking identical. Moving the real node keeps all of it, and keeping the menu
// INSIDE .notes-head keeps the delegation working too: that element carries
// data-render-target="notes", and the delegation resolves the nearest such
// ancestor of whatever was pressed.
//
// The menu is position: absolute against .notes-head rather than fixed. It
// drops downward over the note, which is inside .quiz-panel, so the panel's
// overflow:hidden cannot clip it — and absolute positioning cannot be broken by
// a transform appearing on an ancestor the way a fixed overlay can.

import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

// The controls that move OUT of .notes-stage entirely and up into the
// Cards/Notes/Highlights row, so the notes view has one control row instead of
// two. The TOC button goes before the tabs; the rest after them. Selectors are
// scoped to `.notes-head >` because they must match only while the button is
// still in its original home — see overflowHomes below.
const ROW_LEAD_SELECTORS = [".notes-head > #notesTocBtn"];

const ROW_TRAIL_SELECTORS = [
  ".notes-head > #editNotesBtn",
  ".notes-head > #notesHeadMoreBtn",
  ".notes-head > #notesHeadMoreMenu",
];

// In the order they should appear in the menu, which is the order they used to
// appear in the header. Scoped to .notes-head for the same reason, and because
// `[data-render-action]` values like "cloze" and "quick-note" also exist inside
// the floating selection pill.
const OVERFLOW_SELECTORS = [
  ".notes-head > .cloze-make-icon",
  ".notes-head > #clozeToggleNotesBtn",
  ".notes-head > #clozeReviewBtn",
  ".notes-head > .notes-make-card",
  ".notes-head > .notes-quick-note",
  ".notes-head > #bookmarkSetBtn",
  ".notes-head > #bookmarkGoBtn",
  ".notes-head > #focusModeBtn",
];

let notesHeadMoreBtn = null;
let notesHeadMoreMenu = null;
// The buttons to move, resolved once at init while they are still in the
// header. Kept as a list rather than re-queried because the selectors above
// stop matching the moment the move has happened.
let overflowHomes = [];
let overflowMoved = false;

export function isNotesHeadMoreOpen() {
  return Boolean(notesHeadMoreMenu && !notesHeadMoreMenu.hidden);
}

export function closeNotesHeadMore() {
  if (!notesHeadMoreMenu || notesHeadMoreMenu.hidden) return;
  notesHeadMoreMenu.hidden = true;
  notesHeadMoreBtn?.setAttribute("aria-expanded", "false");
}

export function openNotesHeadMore() {
  if (!notesHeadMoreMenu || !overflowMoved) return;
  notesHeadMoreMenu.hidden = false;
  notesHeadMoreBtn?.setAttribute("aria-expanded", "true");
}

export function toggleNotesHeadMore() {
  if (isNotesHeadMoreOpen()) closeNotesHeadMore();
  else openNotesHeadMore();
}

function moveButtonsIntoMenu() {
  if (overflowMoved || !notesHeadMoreMenu) return;
  overflowHomes.forEach(({ node }) => notesHeadMoreMenu.appendChild(node));
  overflowMoved = true;
  if (notesHeadMoreBtn) notesHeadMoreBtn.hidden = false;
}

export function applyNotesHeadOverflow() {
  if (!overflowHomes.length) return;
  // The overflow menu is NOT phone-only. A desktop notes header carried
  // thirteen controls in one row — ☰, the caption, five format buttons, two
  // split controls, three cloze icons, make-card, pin, the edit pill and focus
  // — and "there is room for it" is not the same as "it belongs on screen".
  // The same six low-frequency buttons move behind ⋯ at every width, so the two
  // layouts are one design rather than two.
  moveButtonsIntoMenu();
}

// Lift the notes controls into the view-mode row. Done once, at boot, before
// the overflow move below records what it is moving.
//
// Moving the nodes rather than rebuilding them keeps every handler: the TOC
// button and the edit pill are wired by id in main.js, and the ⋯ menu's
// contents route through the [data-render-target] delegation — which is why the
// row carries that attribute too.
function liftNotesControlsIntoRow() {
  const row = document.getElementById("viewModeRow");
  const toggle = document.getElementById("viewModeToggle");
  if (!row || !toggle) return;
  ROW_LEAD_SELECTORS.forEach((selector) => {
    const node = document.querySelector(selector);
    if (node) row.insertBefore(node, toggle);
  });
  ROW_TRAIL_SELECTORS.forEach((selector) => {
    const node = document.querySelector(selector);
    if (node) row.appendChild(node);
  });
}

export function initNotesHeadOverflow() {
  liftNotesControlsIntoRow();
  notesHeadMoreBtn = document.getElementById("notesHeadMoreBtn");
  notesHeadMoreMenu = document.getElementById("notesHeadMoreMenu");
  if (!notesHeadMoreBtn || !notesHeadMoreMenu) return;

  overflowHomes = OVERFLOW_SELECTORS
    .map((selector) => document.querySelector(selector))
    .filter(Boolean)
    .map((node) => ({ node }));

  // preventDefault on pointerdown, for the same reason the floating selection
  // pill does it: three of the buttons in this menu (cloze, make-card, pin)
  // act on the CURRENT text selection, and a press that placed a caret in the
  // note would throw away the very thing they are there to act on. This has to
  // cover the ⋯ button (which is how you reach them) and the menu's own
  // padding, not just the buttons.
  [notesHeadMoreBtn, notesHeadMoreMenu].forEach((node) => {
    ["pointerdown", "mousedown"].forEach((type) => {
      node.addEventListener(type, (event) => { event.preventDefault(); });
    });
  });

  notesHeadMoreBtn.addEventListener("click", () => { toggleNotesHeadMore(); });

  // ── Why the close happens on TWO different events ────────────────────────
  //
  // The buttons in here do not all act on the same one. Anything carrying
  // [data-render-action] is handled by the document-level pointerdown
  // delegation in main.js; everything else (focus mode, reveal-all, the cloze
  // list) is an ordinary click handler.
  //
  // Closing on pointerdown for BOTH is what made ⤢ look dead. `click` is
  // dispatched at the nearest common ancestor of the pointerdown and pointerup
  // targets, so hiding the menu between them means the click never reaches the
  // button at all. Deferring by setTimeout(…, 0) does not help: that fires
  // within a millisecond or two, while a real press holds for 80-150ms. The
  // delegated buttons survived it only because they had already run.
  notesHeadMoreMenu.addEventListener("pointerdown", (event) => {
    const btn = event.target.closest("button");
    // Already acted on by the pointerdown delegation, so there is nothing left
    // for the click to do and the menu can go now.
    if (btn?.matches("[data-render-action], [data-render-color]")) setTimeout(closeNotesHeadMore, 0);
  });

  // Everything else closes once its click has actually been delivered. Bubble
  // phase on the menu still runs before the document-level handler, and that
  // handler's stopPropagation() is on pointerdown, so it cannot suppress this.
  notesHeadMoreMenu.addEventListener("click", (event) => {
    if (event.target.closest("button")) closeNotesHeadMore();
  });

  // A press anywhere else dismisses it. Capture phase, because the delegated
  // formatting handler calls stopPropagation() on the way up.
  document.addEventListener("pointerdown", (event) => {
    if (!isNotesHeadMoreOpen()) return;
    if (event.target.closest("#notesHeadMoreMenu, #notesHeadMoreBtn")) return;
    closeNotesHeadMore();
  }, true);

  styleMobileMedia?.addEventListener?.("change", applyNotesHeadOverflow);
  applyNotesHeadOverflow();
}
