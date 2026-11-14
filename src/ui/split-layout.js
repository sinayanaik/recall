// The one split layout: two panes of .quiz-panel's grid, the divider between
// them, and the ratio they share.
//
// Two features put something beside the reading surface, and they take turns
// with the same column, the same divider and the same remembered ratio:
//
//   • the Highlights pane (src/panels/highlight-cycle.js), the surface's
//     highlights beside the surface;
//   • side by side parts (src/ui/split-parts.js), two parts of one file —
//     Cards, Notes, PDFs, Canvas — next to each other.
//
// Neither owns the divider. Whichever is open says so with setSplitLayoutOwner,
// handing over the one thing that differs between them — the box the two halves
// and the divider occupy — and the drag, the keyboard, the double-press and the
// stored ratio are this file's, once.
//
// ── Why the halves are sized in `fr` and not in per cent ───────────────────
//
// A percentage track resolves against the whole grid, and a split does not own
// the whole grid: the tabs row is above it, and stacked on a phone the divider
// is a track of its own between the two halves. So "60%" would be 60% of a box
// that includes ~54px the split has no say over — the two halves came out at
// 65:35 rather than 3:2, and a drag computed against the halves disagreed with
// a track computed against the panel, so the divider drifted from the finger.
// `fr` distributes the FREE space — what is left after the tabs row and the
// divider have taken theirs — which is exactly the quantity being divided.

import { el } from "../core/dom.js?v=__BUILD__";
import { quizPanel } from "../notes/notes-view.js?v=__BUILD__";
import { applyNotesPagedLayout, isNotesPaged } from "../notes/paged-view.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { forEachDocumentViewer, isDocumentFitWidth, relayoutDocumentHoldingReader } from "../documents/pdf-view.js?v=__BUILD__";

// 3:2, which is what was asked for, and which is also about the narrowest a
// fit-width PDF page stays readable at on a laptop.
export const SPLIT_DEFAULT_RATIO = 0.6;

// Neither half is allowed to become a sliver. Below a quarter a PDF page is a
// thumbnail and a note card is one word per line; above four fifths the other
// half is not worth the split.
export const SPLIT_MIN_RATIO = 0.25;

export const SPLIT_MAX_RATIO = 0.8;

// Remembered, like focus mode is: a reader who widened one half meant it, and
// re-dragging it on every file is the kind of small tax that makes a feature
// not worth turning on.
export const SPLIT_RATIO_KEY = "recall:splitRatio";

// The one width at which a split turns from two columns into two rows (the
// Highlights pane) or is not offered at all (side by side parts). The same
// 720px boundary the rest of the reading chrome uses.
export const SPLIT_STACK_QUERY = "(max-width: 720px)";

// How much one arrow key moves the divider. Small enough to aim with, large
// enough that holding the key is not a minute's work.
export const SPLIT_KEY_STEP = 0.02;

// Told to the surfaces that measure themselves against the width they were
// given. Debounced: a drag fires pointermove continuously, and re-fitting a PDF
// means re-rasterising every page in the render window — which is the same
// reason src/main.js debounces the window resize that does this.
export const SPLIT_RELAYOUT_MS = 160;

let splitLayoutOwner = null;

let splitRelayoutTimer = 0;

// `owner` is { box(), release() }: the two ends of what the divider divides, in
// viewport coordinates, and how to close. Taking the layout from another owner
// closes that one first — the two splits share one column, one divider and one
// set of grid variables, so they are never both open.
export function setSplitLayoutOwner(owner) {
  if (splitLayoutOwner && splitLayoutOwner !== owner) {
    const previous = splitLayoutOwner;
    splitLayoutOwner = null;
    previous.release();
  }
  splitLayoutOwner = owner;
}

// Called by an owner as it closes. Only clears the slot if it is still that
// owner's, so a close that runs because another split took over cannot clear
// the newcomer.
export function releaseSplitLayout(owner) {
  if (splitLayoutOwner === owner) splitLayoutOwner = null;
}

export function splitStacked() {
  return window.matchMedia(SPLIT_STACK_QUERY).matches;
}

export function readSplitRatio() {
  try {
    const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    if (Number.isFinite(stored) && stored >= SPLIT_MIN_RATIO && stored <= SPLIT_MAX_RATIO) return stored;
  } catch (_) { /* private mode, or storage disabled */ }
  return SPLIT_DEFAULT_RATIO;
}

export function writeSplitRatio(ratio) {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch (_) { /* nothing to do about it, and nothing depends on it */ }
}

export function applySplitRatio(ratio) {
  if (!quizPanel) return;
  const clamped = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio));
  quizPanel.style.setProperty("--split-a", `${(clamped * 100).toFixed(2)}fr`);
  quizPanel.style.setProperty("--split-b", `${((1 - clamped) * 100).toFixed(2)}fr`);
  // The same number again, unitless, for the stacked case — see
  // applyStackedSpace in src/panels/highlight-cycle.js.
  quizPanel.style.setProperty("--split-n", clamped.toFixed(4));
  el.splitDivider?.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
}

export function currentSplitRatio() {
  const raw = quizPanel ? parseFloat(quizPanel.style.getPropertyValue("--split-a")) : NaN;
  return Number.isFinite(raw) ? raw / 100 : SPLIT_DEFAULT_RATIO;
}

// ── Re-fitting what got narrower ────────────────────────────────────────────
//
// Whatever is on screen, rather than whatever the caller thinks is: a split can
// have a PDF on one side and a Canvas on the other, a note beside a card, or a
// single surface beside the Highlights pane — and the question for each is the
// same ("am I shown, and do I measure my width?"). A hidden surface is skipped
// by its own test, so a relayout never wakes something nobody can see.
export function scheduleSplitRelayout() {
  clearTimeout(splitRelayoutTimer);
  splitRelayoutTimer = setTimeout(() => {
    splitRelayoutTimer = 0;
    forEachDocumentViewer(() => {
      if (isDocumentFitWidth()) relayoutDocumentHoldingReader({ refit: true });
    });
    // Paged notes are laid out in columns measured against the stage's width,
    // so a narrower stage is a different number of pages.
    if (el.notesStage && !el.notesStage.hidden && isNotesPaged()) applyNotesPagedLayout();
    // A card's question is fitted to the face it is on.
    if (el.card && !el.card.hidden && el.card.getClientRects().length) scheduleLiveQuestionFit();
  }, SPLIT_RELAYOUT_MS);
}

// ── The divider ─────────────────────────────────────────────────────────────
//
// A real element rather than `resize: horizontal`, because it has to work in
// one axis at one width and the other axis at another, and to be reachable by
// keyboard (← → or ↑ ↓, Home for 3:2). Installed once; it divides whichever
// split currently owns it.
export function installSplitDivider() {
  const divider = el.splitDivider;
  if (!divider || divider.dataset.splitInstalled) return;
  divider.dataset.splitInstalled = "";
  divider.setAttribute("aria-valuemin", String(Math.round(SPLIT_MIN_RATIO * 100)));
  divider.setAttribute("aria-valuemax", String(Math.round(SPLIT_MAX_RATIO * 100)));

  let dragging = false;
  const move = (event) => {
    if (!dragging || !splitLayoutOwner) return;
    const box = splitLayoutOwner.box();
    if (!box) return;
    const stacked = splitStacked();
    const grip = divider.getBoundingClientRect();
    // The divider's own thickness is an `auto` track and takes no part in the
    // fr split, so it comes off the total before the ratio is taken — otherwise
    // the handle sits a few pixels off the pointer and the error grows toward
    // the ends of the travel.
    const total = (box.end - box.start) - (stacked ? grip.height : grip.width);
    if (total <= 0) return;
    const at = stacked ? event.clientY : event.clientX;
    applySplitRatio((at - box.start) / total);
  };

  divider.addEventListener("pointerdown", (event) => {
    if (!splitLayoutOwner) return;
    dragging = true;
    divider.classList.add("is-dragging");
    // Captured, so a fast drag that outruns the handle keeps sending
    // pointermove here instead of to whatever it passed over. In a try: a
    // synthetic PointerEvent carries a pointerId the browser has no active
    // pointer for and throws, which would take the whole drag down — and a
    // synthetic drag is exactly what the browser checks make.
    try {
      divider.setPointerCapture(event.pointerId);
    } catch (_) { /* not a real pointer; the listeners below still work */ }
    event.preventDefault();
  });
  divider.addEventListener("pointermove", move);
  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("is-dragging");
    try {
      if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    } catch (_) { /* see the capture above */ }
    writeSplitRatio(currentSplitRatio());
    scheduleSplitRelayout();
  };
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);

  // Back to 3:2 — the way out of a drag that went somewhere silly, without
  // having to find the exact pixel again.
  divider.addEventListener("dblclick", () => {
    if (!splitLayoutOwner) return;
    applySplitRatio(SPLIT_DEFAULT_RATIO);
    writeSplitRatio(SPLIT_DEFAULT_RATIO);
    scheduleSplitRelayout();
  });

  divider.addEventListener("keydown", (event) => {
    if (!splitLayoutOwner) return;
    const stacked = splitStacked();
    const less = stacked ? "ArrowUp" : "ArrowLeft";
    const more = stacked ? "ArrowDown" : "ArrowRight";
    let step = 0;
    if (event.key === less) step = -SPLIT_KEY_STEP;
    else if (event.key === more) step = SPLIT_KEY_STEP;
    else if (event.key === "Home") step = SPLIT_DEFAULT_RATIO - currentSplitRatio();
    else return;
    event.preventDefault();
    applySplitRatio(currentSplitRatio() + step);
    writeSplitRatio(currentSplitRatio());
    scheduleSplitRelayout();
  });
}
