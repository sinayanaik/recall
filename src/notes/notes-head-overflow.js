// The notes header's phone-only overflow menu.
//
// On a phone the Notes view stacked FOUR bars above the first line of text: the
// appbar, the Cards/Notes/Highlights toggle, the notes header, and — because
// styles/10-editor.css:881 deliberately promotes #notesRenderToolbar onto a
// full-width row of its own below 560px — the B/I/U/S/</>/colour strip. That
// promotion was the right call at the time: nine controls plus the strip did
// not fit on one 360px row, and the ones that overflowed did not scroll out of
// reach, they vanished (.quiz-panel is overflow:hidden on mobile).
//
// This takes the other half of that trade. Six low-frequency buttons move into
// a popover, which leaves the header as ☰ · [format strip] · ✎|👁 · ⋯ — one row,
// with room to spare at 320px.
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
import { refreshNotesHeadHeight } from "./notes-head-fold.js?v=__BUILD__";

// In the order they should appear in the menu, which is the order they appear
// in the header on desktop. Scoped to .notes-head: `[data-render-action]` values
// like "cloze" and "quick-note" also exist inside the render toolbar itself.
const OVERFLOW_SELECTORS = [
  ".notes-head > .cloze-make-icon",
  ".notes-head > #clozeToggleNotesBtn",
  ".notes-head > #clozeReviewBtn",
  ".notes-head > .notes-make-card",
  ".notes-head > .notes-quick-note",
  ".notes-head > #focusModeBtn",
];

let notesHeadMoreBtn = null;
let notesHeadMoreMenu = null;
let notesFormatToggleBtn = null;
// { node, parent, nextSibling } per moved button, recorded once at init while
// the header is still in its desktop shape. Restoring walks this in REVERSE:
// a button's recorded nextSibling is often another moved button, and going
// backwards guarantees that one is already back in place.
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

// The formatting strip's phone-only disclosure. Six buttons behind ⋯ was not on
// its own enough to fit one row: measured at 390px the strip alone is 224px of
// the 336px the header has, and ☰ + strip + ✎|👁 + ⋯ came to 354px — so the ⋯
// wrapped onto a second line and the header was two rows again, just with
// different things on them.
//
// The strip is the right thing to fold away. It formats a selection, and there
// is nothing selected while you read; the floating selection pill already
// offers highlight, cloze, make-card and pin the moment there IS a selection.
// Collapsed the row is ☰ + A + ✎|👁 + ⋯ ≈ 156px, which fits a 320px phone with
// room to spare.
//
// Read mode only. The raw editor's own toolbar keeps the full-width row it has
// at styles/10-editor.css:932 — you are there on purpose, and its thirteen
// buttons are the reason you went.
export function isNotesFormatStripOpen() {
  return Boolean(document.querySelector("#notesStage .notes-head")?.classList.contains("is-format-open"));
}

export function setNotesFormatStripOpen(open) {
  const head = document.querySelector("#notesStage .notes-head");
  if (!head) return;
  head.classList.toggle("is-format-open", Boolean(open));
  notesFormatToggleBtn?.setAttribute("aria-pressed", open ? "true" : "false");
  notesFormatToggleBtn?.setAttribute("aria-label", open ? "Hide text formatting" : "Show text formatting");
  // The header's max-height is pinned to its last measured height, so without
  // this the second row would spill over the note instead of pushing it down.
  refreshNotesHeadHeight();
}

export function toggleNotesFormatStrip() {
  setNotesFormatStripOpen(!isNotesFormatStripOpen());
}

function moveButtonsIntoMenu() {
  if (overflowMoved || !notesHeadMoreMenu) return;
  overflowHomes.forEach(({ node }) => notesHeadMoreMenu.appendChild(node));
  overflowMoved = true;
  if (notesHeadMoreBtn) notesHeadMoreBtn.hidden = false;
  if (notesFormatToggleBtn) notesFormatToggleBtn.hidden = false;
  document.querySelector("#notesStage .notes-head")?.classList.add("is-format-collapsible");
}

function moveButtonsBackToHeader() {
  if (!overflowMoved) return;
  closeNotesHeadMore();
  for (let i = overflowHomes.length - 1; i >= 0; i -= 1) {
    const { node, parent, nextSibling } = overflowHomes[i];
    parent.insertBefore(node, nextSibling && nextSibling.parentNode === parent ? nextSibling : null);
  }
  overflowMoved = false;
  if (notesHeadMoreBtn) notesHeadMoreBtn.hidden = true;
  if (notesFormatToggleBtn) notesFormatToggleBtn.hidden = true;
  const head = document.querySelector("#notesStage .notes-head");
  head?.classList.remove("is-format-collapsible");
  // Cleared rather than left set: the class is what hides the strip, and a
  // window dragged back over 720px with it off would hide the strip on a
  // desktop, where nothing shows the ⋯/A buttons that could bring it back.
  head?.classList.remove("is-format-open");
}

export function applyNotesHeadOverflow() {
  if (!overflowHomes.length) return;
  if (styleMobileMedia?.matches) moveButtonsIntoMenu();
  else moveButtonsBackToHeader();
  refreshNotesHeadHeight();
}

export function initNotesHeadOverflow() {
  notesHeadMoreBtn = document.getElementById("notesHeadMoreBtn");
  notesHeadMoreMenu = document.getElementById("notesHeadMoreMenu");
  notesFormatToggleBtn = document.getElementById("notesFormatToggleBtn");
  if (!notesHeadMoreBtn || !notesHeadMoreMenu) return;

  // Recorded AFTER the ⋯ button and the menu are already in the markup, so
  // #focusModeBtn's "home" is the ⋯ button rather than the end of the row.
  overflowHomes = OVERFLOW_SELECTORS
    .map((selector) => document.querySelector(selector))
    .filter(Boolean)
    .map((node) => ({ node, parent: node.parentNode, nextSibling: node.nextSibling }));

  // preventDefault on pointerdown, for the same reason the floating selection
  // pill does it: three of the buttons in this menu (cloze, make-card, pin)
  // act on the CURRENT text selection, and a press that placed a caret in the
  // note would throw away the very thing they are there to act on. This has to
  // cover the ⋯ button (which is how you reach them) and the menu's own
  // padding, not just the buttons.
  [notesHeadMoreBtn, notesHeadMoreMenu, notesFormatToggleBtn].filter(Boolean).forEach((node) => {
    ["pointerdown", "mousedown"].forEach((type) => {
      node.addEventListener(type, (event) => { event.preventDefault(); });
    });
  });

  notesHeadMoreBtn.addEventListener("click", () => { toggleNotesHeadMore(); });
  notesFormatToggleBtn?.addEventListener("click", () => { toggleNotesFormatStrip(); });

  // Bubble phase on the menu, so it runs BEFORE the document-level
  // [data-render-action] handler (which stops propagation once it has matched).
  // Deferred by a task rather than closing inline: the click-driven buttons in
  // here (reveal-all, the cloze list, focus mode) fire after pointerdown, and
  // hiding their ancestor first would cancel the click.
  notesHeadMoreMenu.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("button")) return;
    setTimeout(closeNotesHeadMore, 0);
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
