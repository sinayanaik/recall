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
// This takes the other half of that trade. Ten low-frequency buttons move into
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
// ...and the Document surface's controls, which start life in #documentHead and
// land in the same two slots. A PDF deck used to carry a full-width
// `.document-toolbar` of its own UNDER this row — a third stacked bar, captioned
// "Document" directly beneath a lit tab reading DOCUMENT — while the three notes
// controls above it sat there inert, because a paper has no markdown headings to
// list and no source to edit. Both halves of that are fixed by putting the
// document's controls in the row and letting CSS show whichever set belongs to
// the view (styles/37-document-chrome.css).
//
// Same rule as everything else here: MOVED, never cloned. Every one is wired by
// id in src/main.js.
const ROW_LEAD_SELECTORS = [
  ".notes-head > #notesTocBtn",
  ".document-head > #documentTocBtn"
];

const ROW_TRAIL_SELECTORS = [
  ".notes-head > #editNotesBtn",
  ".notes-head > #notesHeadMoreBtn",
  ".notes-head > #notesHeadMoreMenu",
  ".document-head > #documentDarkBtn",
  ".document-head > #documentRegionBtn",
  // The pen. Missing from this list until now, and .document-head is
  // `display: none` precisely because this function empties it — so the ✎ was
  // in the document and had a handler and a tooltip and could not be seen or
  // pressed by anybody. Since it is the only thing that opens the rail, the
  // consequence was that a stylus drew (which needs no control, by design) and
  // the colours, the nib, the eraser, the lasso and undo did not exist on this
  // surface at all. A mouse could not draw either, because arming the rail is
  // the only way a mouse can say it meant to.
  //
  // tools/pdf-preview-check.mjs now asserts that EVERY control authored in
  // .document-head reaches the row and has a box on screen, rather than
  // asserting this one button, because the fault was the list and not the
  // button.
  ".document-head > #documentInkBtn",
  ".document-head > #documentMoreBtn",
  ".document-head > #documentMoreMenu",
  // ── The notebook's controls ─────────────────────────────────────────────
  //
  // The Write tab is the same #documentStage showing the deck's other document,
  // so its controls belong in the same one row as the document's — lifted the
  // same way, hidden by CSS on the views where they mean nothing, and never
  // cloned, because every one of them is wired by id.
  //
  // They were the header of a full-page overlay until now, which is what made
  // handwriting a place you went rather than a view you were in.
  ".handwriting-head > #handwritingPaperGroup",
  ".handwriting-head > #handwritingTextBtn",
  ".handwriting-head > #handwritingImageBtn",
  ".handwriting-head > #handwritingPageBtn",
  ".handwriting-head > #handwritingTearBtn",
];

// In the order they appear in the menu. This USED to be the order they sat in
// the header, which put the three cloze icons at the top because that is where
// the cloze icons happened to be — and left the two things you reach for while
// actually reading (what the surface looks like, and where you got to) at the
// bottom, below the fold of a phone-height popover.
//
// The order is by what you were doing when you opened it instead: the modes the
// note is in, then the place you are keeping, then the two verbs that need a
// selection, then the cloze list. Scoped to .notes-head because they must match
// only while the button is still in its original home (see overflowHomes), and
// because `[data-render-action]` values like "cloze" and "quick-note" also
// exist inside the floating selection pill.
const OVERFLOW_SELECTORS = [
  ".notes-head > #focusModeBtn",
  ".notes-head > #immersiveModeBtn",
  ".notes-head > #bookmarkGoBtn",
  ".notes-head > .notes-make-card",
  ".notes-head > .notes-quick-note",
  ".notes-head > .cloze-make-icon",
  ".notes-head > #clozeToggleNotesBtn",
  ".notes-head > #clozeReviewBtn",
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

// ── Why the menu is a list of sentences and not a tray of glyphs ──────────
//
// It shipped as ten icon buttons wrapped into a 280px box: a dagger, two
// bookmarks that were the same drawing filled and unfilled, ⤢, ⛶, a pin, a +,
// and three cloze icons. Every one of them says what it does in its `title`,
// which is a tooltip — it does not exist on the phone this menu was built for,
// and on a desktop it costs a hover and a second of waiting per button. So the
// menu asked you to already know.
//
// Each button is a ROW here: icon, then the sentence it carries in .nhm-label,
// then (for the modes) a switch. Two things follow from doing it this way
// rather than by building a menu of fresh items:
//
//   • The rows ARE the buttons. Every handler, every aria-pressed, every title
//     is the one that was already there — the same reason these are moved and
//     never cloned. A toggle painted by some other module (focus mode by
//     applyChromeCollapse, the cloze reveal by setClozeButtonState) keeps
//     painting the same node, and its switch follows aria-pressed in CSS.
//   • A button that has NOT been moved still looks like a plain icon button,
//     because .nhm-label is only displayed inside the menu. Nothing here has to
//     undo itself if a layout ever puts one of them back in the header.
//
// The headings come from data-nhm-group, so a new button joins a group by
// naming it in the markup and needs no list here to be edited in step.
function groupHeading(name) {
  const heading = document.createElement("div");
  heading.className = "nhm-group";
  heading.setAttribute("role", "presentation");
  heading.textContent = name;
  return heading;
}

function moveButtonsIntoMenu() {
  if (overflowMoved || !notesHeadMoreMenu) return;
  let group = null;
  overflowHomes.forEach(({ node }) => {
    const name = node.dataset.nhmGroup || "";
    if (name && name !== group) notesHeadMoreMenu.appendChild(groupHeading(name));
    group = name;
    notesHeadMoreMenu.appendChild(node);
  });
  overflowMoved = true;
  if (notesHeadMoreBtn) notesHeadMoreBtn.hidden = false;
}

export function applyNotesHeadOverflow() {
  if (!overflowHomes.length) return;
  // The overflow menu is NOT phone-only. A desktop notes header carried
  // thirteen controls in one row — ☰, the caption, five format buttons, two
  // split controls, three cloze icons, make-card, pin, the edit pill and focus
  // — and "there is room for it" is not the same as "it belongs on screen".
  // The same ten low-frequency buttons move behind ⋯ at every width, so the two
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
