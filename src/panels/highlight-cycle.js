// Side by side: the reading surface, and what you wrote on it.
//
// ── The report ─────────────────────────────────────────────────────────────
//
// "The highlights view section, the numbering — visually they are far detached
// from each other. In the notes and documents panel one has to click the numbers
// then only be able to see it." Which is true and is structural: a highlight
// lives on the page and its note lives in the Highlights tab, and a tab is
// somewhere you go INSTEAD of the page. Working through a paper you have
// annotated therefore meant flipping between the two, once per highlight, with
// nothing on screen ever showing both.
//
// So the panel splits in two. The reading surface keeps its half and the other
// half is the Highlights tab's own surface — every highlight of THIS surface in
// reading order, its note under it, editable where it sits — with a bar that
// walks through them and takes the page along.
//
// ── What this module is not ────────────────────────────────────────────────
//
// It is not a second highlights view. The cards are built by
// src/panels/highlights-editor.js, into this pane instead of into the tab (see
// the `list` argument on renderHighlightsEditor, and the note beside lastList
// there on why that is a container rather than a fork). It is not a fifth view
// mode either: state.viewMode stays "document" or "notes", so every existing
// jump — scheduleNoteJump's setViewMode, the drawer's rows, a card's "Go to
// notes" — lands in the left half with no idea a right half exists.
//
// What is here is the layout, the cycling, and the two things that have to be
// told the reading surface just got narrower.
//
// ── Why the surfaces are not moved ─────────────────────────────────────────
//
// A .pdf-page's offsetParent is .document-stage and pageOffsetTop() measures
// against it, so wrapping that stage in a split container would put every
// highlight on every paper at the wrong offset. The stages stay exactly where
// they are in .quiz-panel's grid; the divider and this pane take the column
// beside them (the ROW beneath them on a phone, where two 190px columns would
// be worse than useless). All of that is styles/46-highlight-cycle.css.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { currentDocumentPage, isDocumentFitWidth, relayoutDocument } from "../documents/pdf-view.js?v=__BUILD__";
import { documentHighlightMarks } from "../documents/pdf-highlights.js?v=__BUILD__";
import { noteMarkNode, scheduleNoteJump, sourceMarkIndexFor } from "../notes/anchors.js?v=__BUILD__";
import { quizPanel } from "../notes/notes-view.js?v=__BUILD__";
import { applyNotesPagedLayout, isNotesPaged } from "../notes/paged-view.js?v=__BUILD__";
import {
  HL_NOTE_CLASS,
  closeHighlightsEditor,
  highlightEntryKey,
  initHighlightsEditor,
  renderHighlightsEditor
} from "./highlights-editor.js?v=__BUILD__";
import { collectHighlightEntries } from "./highlights-panel.js?v=__BUILD__";

// 3:2, which is what was asked for, and which is also about the narrowest a
// fit-width PDF page stays readable at on a laptop.
export const SPLIT_DEFAULT_RATIO = 0.6;

// Neither half is allowed to become a sliver. Below a quarter a PDF page is a
// thumbnail and a note card is one word per line; above four fifths the other
// half is not worth the split.
export const SPLIT_MIN_RATIO = 0.25;

export const SPLIT_MAX_RATIO = 0.8;

// Remembered, like focus mode is (FOCUS_MODE_KEY in src/ui/view-mode.js): a
// reader who widened the notes half meant it, and re-dragging it on every deck
// is the kind of small tax that makes a feature not worth turning on.
export const SPLIT_RATIO_KEY = "recall:splitRatio";

// The one width at which the split turns from two columns into two rows. The
// same 720px boundary the rest of the reading chrome uses — and the value is
// repeated here rather than imported for the reason drawer-highlights.js gives
// about TOC_PUSH_MIN_WIDTH: this module must not pull in the notes subtree to
// ask one media query.
export const SPLIT_STACK_QUERY = "(max-width: 720px)";

// Which reading surface the split is beside, or null when it is closed. This is
// the whole of "is the split open" — there is no second flag to disagree with
// the class on the panel.
let splitSurface = null;

let cycleEntries = [];

let cycleIndex = -1;

// The current highlight's key, not just its index. A rebuild re-collects the
// list and an index into the old one means a different highlight — the same
// reason src/notes/toc-tree.js carries folds by key.
let cycleKey = "";

// The deck the split was opened on. Every deck loader ends with a setViewMode
// call (deck-snapshot.js, web-decks.js), so the hook below sees every swap —
// and a pane still listing the previous deck's highlights beside this deck's
// pages is worse than no pane at all.
let splitDeckId = "";

let cycleScrollFrame = 0;

let splitResizeTimer = 0;

export function isHighlightSplitOpen() {
  return Boolean(splitSurface);
}

export function highlightSplitSurface() {
  return splitSurface;
}

function stageFor(surface) {
  return surface === "document" ? el.documentStage : el.notesStage;
}

function splitStacked() {
  return window.matchMedia(SPLIT_STACK_QUERY).matches;
}

// ── The size of the two halves ──────────────────────────────────────────────

function readSplitRatio() {
  try {
    const stored = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    if (Number.isFinite(stored) && stored >= SPLIT_MIN_RATIO && stored <= SPLIT_MAX_RATIO) return stored;
  } catch (_) { /* private mode, or storage disabled */ }
  return SPLIT_DEFAULT_RATIO;
}

function writeSplitRatio(ratio) {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch (_) { /* nothing to do about it, and nothing depends on it */ }
}

// ── Why the two halves are sized in `fr` and not in per cent ───────────────
//
// A percentage track resolves against the whole grid, and the split does not
// own the whole grid: the tabs row is above it, and stacked on a phone the
// divider is a track of its own between the two halves. So "60%" would be 60%
// of a box that includes ~54px this split has no say over — the two halves came
// out at 65:35 rather than 3:2, and worse, a drag computed against the halves
// then disagreed with a track computed against the panel, so the divider
// drifted away from the finger holding it.
//
// `fr` distributes the FREE space — what is left after the tabs row and the
// divider have taken theirs — which is exactly the quantity being divided.
// 60fr/40fr is 3:2 of the split and nothing else, in either orientation.
function applySplitRatio(ratio) {
  if (!quizPanel) return;
  const clamped = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio));
  quizPanel.style.setProperty("--split-a", `${(clamped * 100).toFixed(2)}fr`);
  quizPanel.style.setProperty("--split-b", `${((1 - clamped) * 100).toFixed(2)}fr`);
  // The same number again, unitless, for the stacked case — see applyStackedSpace.
  quizPanel.style.setProperty("--split-n", clamped.toFixed(4));
  el.splitDivider?.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
}

// ── Why the stacked case cannot use `fr` ───────────────────────────────────
//
// `fr` divides FREE space, and free space only exists if the grid container's
// size in that axis is definite. Across the panel it is: the width comes from
// the viewport. Down it, on a phone, it is not — .quiz-panel is `height: 100%`
// of a scrollable, content-sized .study-layout, so its block size resolves to
// auto. Flexible ROW tracks in an indefinite container are sized to their
// content instead of to their flex factor, and the result was measurable and
// absurd: the paper collapsed to its 22px minimum and the highlights pane took
// 695px of an 844px screen, which is not 3:2 by any reading.
//
// So the stacked rows are lengths, and this is the length they are taken from:
// what is left of the viewport below wherever the reading surface starts. The
// stage's own top is safe to measure — it sits under the tabs row, which is an
// `auto` track above the split and does not depend on how the split is divided.
export const SPLIT_STACK_FLOOR_PX = 240;

function applyStackedSpace() {
  if (!quizPanel) return;
  const stage = stageFor(splitSurface);
  if (!splitSurface || !splitStacked() || !stage) {
    quizPanel.style.removeProperty("--split-space");
    return;
  }
  const top = stage.getBoundingClientRect().top;
  const space = Math.max(SPLIT_STACK_FLOOR_PX, Math.round(window.innerHeight - top - 8));
  quizPanel.style.setProperty("--split-space", `${space}px`);
}

// The box the two halves and the divider between them occupy, in viewport
// coordinates. Taken from the two ends rather than from the panel's own padding
// box because the same measurement has to work in both orientations, and in the
// stacked one the split starts below the tabs rather than at the panel's edge.
function splitBox() {
  const stage = stageFor(splitSurface);
  if (!stage || !el.highlightCycle) return null;
  const a = stage.getBoundingClientRect();
  const b = el.highlightCycle.getBoundingClientRect();
  return splitStacked()
    ? { start: a.top, end: b.bottom }
    : { start: a.left, end: b.right };
}

// Told to the two things that measure themselves against the width they were
// given. Debounced: a drag fires pointermove continuously, and re-fitting a PDF
// means re-rasterising every page in the render window — which is the same
// reason src/main.js debounces the window resize that does this.
export const SPLIT_RELAYOUT_MS = 160;

function notePaneResized() {
  clearTimeout(splitResizeTimer);
  splitResizeTimer = setTimeout(() => {
    splitResizeTimer = 0;
    if (state.viewMode === "document") {
      if (isDocumentFitWidth()) relayoutDocument({ refit: true });
    } else if (isNotesPaged()) {
      // Paged notes are laid out in columns measured against the stage's width,
      // so a narrower stage is a different number of pages.
      applyNotesPagedLayout();
    }
  }, SPLIT_RELAYOUT_MS);
}

// ── Opening and closing ─────────────────────────────────────────────────────

export function openHighlightSplit(surface) {
  const next = surface === "document" ? "document" : "notes";
  if (!quizPanel || !el.highlightCycle || !el.splitDivider) return;
  // The split is beside a reading surface, so there has to be one on screen.
  if (state.viewMode !== next) return;
  splitSurface = next;
  splitDeckId = state.deckId || "";
  el.highlightCycle.hidden = false;
  el.splitDivider.hidden = false;
  el.splitDivider.setAttribute("aria-orientation", splitStacked() ? "horizontal" : "vertical");
  quizPanel.classList.add("is-split");
  applySplitRatio(readSplitRatio());
  applyStackedSpace();
  refreshHighlightCycle();
  goToCycleIndex(nearestCycleIndex(), { jump: false });
  notePaneResized();
}

export function closeHighlightSplit() {
  if (!splitSurface) return;
  // A note being typed in the pane commits on the way out, exactly as leaving
  // the Highlights tab commits one being typed there.
  closeHighlightsEditor();
  // Nothing on the reading surface should stay tinted for a pane that is gone.
  paintLink(null);
  splitSurface = null;
  cycleEntries = [];
  cycleIndex = -1;
  cycleKey = "";
  quizPanel?.classList.remove("is-split");
  quizPanel?.style.removeProperty("--split-space");
  if (el.highlightCycle) el.highlightCycle.hidden = true;
  if (el.splitDivider) el.splitDivider.hidden = true;
  notePaneResized();
}

export function toggleHighlightSplit(surface) {
  if (isHighlightSplitOpen()) closeHighlightSplit();
  else openHighlightSplit(surface);
}

// Called from setViewMode with the mode being switched TO.
//
// Notes and Document are both reading surfaces, so the split follows rather than
// closing — a reader who has the paper and its highlights side by side and taps
// Notes wants the note and ITS highlights, not the split taken away. Cards and
// the Highlights tab are not reading surfaces and there is nothing to be beside.
export function splitFollowsViewMode(next) {
  if (!splitSurface) return;
  // A different deck is a different set of highlights and a different paper to
  // be beside. Both deck loaders come through here.
  if (splitDeckId !== (state.deckId || "")) {
    closeHighlightSplit();
    return;
  }
  if (next !== "document" && next !== "notes") {
    closeHighlightSplit();
    return;
  }
  if (next === splitSurface) return;
  closeHighlightsEditor();
  splitSurface = next;
  applyStackedSpace();
  refreshHighlightCycle();
  goToCycleIndex(nearestCycleIndex(), { jump: false });
  notePaneResized();
}

// ── What the pane lists ─────────────────────────────────────────────────────
//
// collectHighlightEntries() returns the whole deck in reading order, and a
// document record carries highlightId where a note's <mark> carries markIndex.
// The pane lists the surface it is beside — the same split the contents
// drawer's own Highlights section makes (drawerEntriesFor), and for the same
// reason: what you marked on the thing you are looking at.
function entriesForSurface(surface) {
  return collectHighlightEntries()
    .filter((entry) => (surface === "document" ? Boolean(entry.highlightId) : !entry.highlightId));
}

export function refreshHighlightCycle() {
  if (!splitSurface || !el.highlightCycleBody) return;
  cycleEntries = entriesForSurface(splitSurface);
  // Held by key across the rebuild, so deleting a neighbouring highlight does
  // not walk the reader somewhere else.
  const at = cycleKey ? cycleEntries.findIndex((entry) => highlightEntryKey(entry) === cycleKey) : -1;
  if (at >= 0) cycleIndex = at;
  else if (cycleIndex >= cycleEntries.length) cycleIndex = cycleEntries.length - 1;
  if (el.highlightCycleEmpty) el.highlightCycleEmpty.hidden = cycleEntries.length > 0;
  el.highlightCycleBody.hidden = cycleEntries.length === 0;
  renderHighlightsEditor(cycleEntries, el.highlightCycleBody).then(() => {
    // After the cards exist — the mark and the reveal both need the node.
    paintCurrentCard();
  });
  paintCycleCount();
}

// Where to start. On a paper, at the first highlight on or after the page the
// reader is already looking at: opening the pane at highlight 1 of 300 when
// they are on page 240 is a list they then have to scroll through to get back
// to where they were. A note has no equivalent cheap answer, so it starts at
// the top.
function nearestCycleIndex() {
  if (!cycleEntries.length) return -1;
  if (cycleIndex >= 0 && cycleIndex < cycleEntries.length) return cycleIndex;
  if (splitSurface !== "document") return 0;
  const page = currentDocumentPage();
  if (!page) return 0;
  const at = cycleEntries.findIndex((entry) => (entry.anchor?.page || 0) >= page);
  return at >= 0 ? at : cycleEntries.length - 1;
}

// ── Cycling ─────────────────────────────────────────────────────────────────

export function cycleHighlightBy(step) {
  if (!cycleEntries.length) return;
  const from = cycleIndex >= 0 ? cycleIndex : 0;
  const next = Math.min(cycleEntries.length - 1, Math.max(0, from + step));
  if (next === cycleIndex) return;
  goToCycleIndex(next, { jump: true });
}

// Point the cycle at one particular highlight — what a press on a contents
// drawer row means while the split is open. `locator` is the shape the drawer
// and the Highlights tab both already carry.
export function cycleToLocator(locator) {
  if (!splitSurface || !locator) return;
  const at = cycleEntries.findIndex((entry) => (locator.highlightId
    ? entry.highlightId === locator.highlightId
    : entry.markIndex === locator.markIndex));
  if (at < 0) return;
  // No jump: the caller made it. This is the pane catching up with a move the
  // reader has already asked for somewhere else.
  goToCycleIndex(at, { jump: false });
}

function goToCycleIndex(index, { jump }) {
  if (index < 0 || index >= cycleEntries.length) {
    cycleIndex = -1;
    cycleKey = "";
    paintCycleCount();
    return;
  }
  // Whatever was being typed is written before the surface moves under it.
  closeHighlightsEditor();
  cycleIndex = index;
  const entry = cycleEntries[index];
  cycleKey = highlightEntryKey(entry);
  paintCycleCount();
  paintCurrentCard();
  if (!jump) return;
  // The same call the drawer's rows and the tab's "Go to →" make, so a step
  // through the list lands exactly where those two already land.
  scheduleNoteJump(entry.anchor, { patient: true }, entry.locator);
}

function paintCycleCount() {
  if (el.highlightCycleCount) {
    el.highlightCycleCount.textContent = cycleEntries.length
      ? `${Math.max(0, cycleIndex) + 1} / ${cycleEntries.length}`
      : "0 / 0";
  }
  if (el.highlightCyclePrevBtn) el.highlightCyclePrevBtn.disabled = cycleIndex <= 0;
  if (el.highlightCycleNextBtn) el.highlightCycleNextBtn.disabled = cycleIndex < 0 || cycleIndex >= cycleEntries.length - 1;
}

function cardFor(index) {
  const entry = cycleEntries[index];
  if (!entry || !el.highlightCycleBody) return null;
  return el.highlightCycleBody
    .querySelector(`.${HL_NOTE_CLASS}[data-highlight-key="${CSS.escape(highlightEntryKey(entry))}"]`);
}

function paintCurrentCard() {
  const body = el.highlightCycleBody;
  if (!body) return;
  body.querySelectorAll(`.${HL_NOTE_CLASS}.is-current`).forEach((node) => node.classList.remove("is-current"));
  const card = cardFor(cycleIndex);
  if (!card) return;
  card.classList.add("is-current");
  paintLink(cycleEntries[cycleIndex]);
  revealCard(card);
}

// ── Which mark this card is about ───────────────────────────────────────────
//
// The number in a card's head says which highlight it belongs to, and that is
// the answer for a highlight you can already see. This is the answer for one you
// cannot: point at a card and the words it is about light up on the page or in
// the note, and point at a mark in the note and its card lights up over here.
//
// Held as a list of NODES rather than as a key to look up again. A highlight is
// several painted quads on a paper (a phrase across three lines is three boxes),
// and the nodes can go — a relayout repaints the mark layer, a rebuild replaces
// the card — so what was lit is remembered directly and cleared directly.
let linkedNodes = [];

function surfaceNodesFor(entry) {
  if (!entry) return [];
  if (entry.highlightId) return documentHighlightMarks(entry.highlightId);
  // build: false — see noteMarkNode. Tinting something the reader cannot see is
  // not worth building a span of a book for.
  const node = noteMarkNode(entry.locator, { build: false });
  return node ? [node] : [];
}

export const LINKED_CLASS = "is-linked";

function entryForKey(key) {
  return key ? cycleEntries.find((entry) => highlightEntryKey(entry) === key) || null : null;
}

function paintLink(entry) {
  const next = surfaceNodesFor(entry);
  if (next.length === linkedNodes.length && next.every((node, i) => node === linkedNodes[i])) return;
  linkedNodes.forEach((node) => node.classList.remove(LINKED_CLASS));
  linkedNodes = next;
  linkedNodes.forEach((node) => node.classList.add(LINKED_CLASS));
}

// The other direction: a mark in the note, pointed at, lights its card.
//
// The notes surface only. A paper's marks sit in a layer carrying
// `pointer-events: none` and must keep it — the text layer is above them and
// every pointer event has to reach that or selection stops working over a
// highlight — so they cannot be hovered at all. What answers there is the
// numbered badge, which IS pressable: see the reveal hook in src/main.js.
//
// The mark is resolved to its SOURCE ordinal (sourceMarkIndexFor), which is what
// an entry is keyed on. Comparing DOM nodes instead would mean resolving every
// entry's node to find the one that matched — a walk of the whole list, on the
// pointer's path, that on a lazily-built note cannot even answer for most of it.
function paintCardLinkFor(mark) {
  const body = el.highlightCycleBody;
  if (!body) return;
  body.querySelectorAll(`.${HL_NOTE_CLASS}.${LINKED_CLASS}`).forEach((node) => node.classList.remove(LINKED_CLASS));
  if (!mark) return;
  const index = sourceMarkIndexFor(el.notesView, mark);
  if (index < 0) return;
  const at = cycleEntries.findIndex((entry) => !entry.highlightId && entry.markIndex === index);
  if (at < 0) return;
  cardFor(at)?.classList.add(LINKED_CLASS);
}

// Scrolled by hand rather than with scrollIntoView, for two reasons: that call
// can scroll ANY ancestor that happens to be scrollable, and it is exactly the
// hazard the app-shell has already been bitten by; and it moves nothing when the
// card is already fully in view, which is what keeps the scroll spy below from
// arguing with a step.
export const CYCLE_CARD_GAP_PX = 8;

function revealCard(card) {
  const body = el.highlightCycleBody;
  if (!body) return;
  const box = body.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  body.scrollTop += rect.top - box.top - CYCLE_CARD_GAP_PX;
}

// ── The counter follows the scrollbar too ───────────────────────────────────
//
// Without this it would start lying the moment the reader scrolled the list
// themselves: "12 / 87" while they are looking at the fortieth. Same shape as
// the contents drawer's own scroll spy — one rAF per burst of scrolling, and the
// answer is "the topmost card still in view".
function cycleScrollSpy() {
  const body = el.highlightCycleBody;
  if (!body || !cycleEntries.length) return;
  const top = body.getBoundingClientRect().top;
  const cards = body.querySelectorAll(`.${HL_NOTE_CLASS}`);
  let found = "";
  for (const card of cards) {
    if (card.getBoundingClientRect().bottom <= top + CYCLE_CARD_GAP_PX) continue;
    found = card.dataset.highlightKey || "";
    break;
  }
  if (!found || found === cycleKey) return;
  const at = cycleEntries.findIndex((entry) => highlightEntryKey(entry) === found);
  if (at < 0) return;
  cycleIndex = at;
  cycleKey = found;
  paintCycleCount();
  body.querySelectorAll(`.${HL_NOTE_CLASS}.is-current`).forEach((node) => node.classList.remove("is-current"));
  cardFor(at)?.classList.add("is-current");
}

// ── The divider ─────────────────────────────────────────────────────────────

// How much one arrow key moves it. Small enough to aim with, large enough that
// holding the key is not a minute's work.
export const SPLIT_KEY_STEP = 0.02;

function installDivider() {
  const divider = el.splitDivider;
  if (!divider) return;
  divider.setAttribute("aria-valuemin", String(Math.round(SPLIT_MIN_RATIO * 100)));
  divider.setAttribute("aria-valuemax", String(Math.round(SPLIT_MAX_RATIO * 100)));

  let dragging = false;
  const move = (event) => {
    if (!dragging) return;
    const box = splitBox();
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
    if (!splitSurface) return;
    dragging = true;
    divider.classList.add("is-dragging");
    // Captured, so a fast drag that outruns the handle keeps sending
    // pointermove here instead of to whatever it passed over. In a try:
    // a synthetic PointerEvent carries a pointerId the browser has no active
    // pointer for and throws, which would take the whole drag down — and a
    // synthetic drag is exactly what tools/pdf-preview-check.mjs makes.
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
    writeSplitRatio(currentRatio());
    notePaneResized();
  };
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);

  // Back to 3:2 — the way out of a drag that went somewhere silly, without
  // having to find the exact pixel again.
  divider.addEventListener("dblclick", () => {
    applySplitRatio(SPLIT_DEFAULT_RATIO);
    writeSplitRatio(SPLIT_DEFAULT_RATIO);
    notePaneResized();
  });

  divider.addEventListener("keydown", (event) => {
    const stacked = splitStacked();
    const less = stacked ? "ArrowUp" : "ArrowLeft";
    const more = stacked ? "ArrowDown" : "ArrowRight";
    let step = 0;
    if (event.key === less) step = -SPLIT_KEY_STEP;
    else if (event.key === more) step = SPLIT_KEY_STEP;
    else if (event.key === "Home") step = SPLIT_DEFAULT_RATIO - currentRatio();
    else return;
    event.preventDefault();
    applySplitRatio(currentRatio() + step);
    writeSplitRatio(currentRatio());
    notePaneResized();
  });
}

function currentRatio() {
  const raw = quizPanel ? parseFloat(quizPanel.style.getPropertyValue("--split-a")) : NaN;
  return Number.isFinite(raw) ? raw / 100 : SPLIT_DEFAULT_RATIO;
}

export function currentSplitRatioForCheck() {
  return currentRatio();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export function initHighlightCycle() {
  if (!el.highlightCycle) return;
  // The pane is a second container for the Highlights tab's editor, so it needs
  // that editor's delegated open-the-note listener on it too.
  initHighlightsEditor(el.highlightCycleBody);
  installDivider();

  el.highlightCyclePrevBtn?.addEventListener("click", () => cycleHighlightBy(-1));
  el.highlightCycleNextBtn?.addEventListener("click", () => cycleHighlightBy(1));
  el.highlightCycleCloseBtn?.addEventListener("click", () => closeHighlightSplit());

  // A press on a card's own "Go to →" is a move like any other, so the counter
  // and the lit card follow it. The jump itself is that button's business —
  // this only listens.
  el.highlightCycleBody?.addEventListener("click", (event) => {
    const card = event.target.closest?.(`.${HL_NOTE_CLASS}`);
    if (!card || !el.highlightCycleBody.contains(card)) return;
    const key = card.dataset.highlightKey || "";
    if (!key || key === cycleKey) return;
    const at = cycleEntries.findIndex((entry) => highlightEntryKey(entry) === key);
    if (at < 0) return;
    cycleIndex = at;
    cycleKey = key;
    paintCycleCount();
    paintCurrentCard();
  });

  // Point at a card, light its highlight; take the pointer off the list, and the
  // current card's own highlight is what stays lit. pointerover/pointerout
  // rather than mouseenter on each card: one pair of listeners on the container
  // survives every rebuild, and a card is rebuilt often.
  el.highlightCycleBody?.addEventListener("pointerover", (event) => {
    const card = event.target.closest?.(`.${HL_NOTE_CLASS}`);
    if (!card || !el.highlightCycleBody.contains(card)) return;
    paintLink(entryForKey(card.dataset.highlightKey || ""));
  });
  el.highlightCycleBody?.addEventListener("pointerleave", () => {
    paintLink(cycleEntries[cycleIndex]);
  });

  // ...and the way back. A <mark> in the note is an ordinary element that takes
  // pointer events, so hovering one lights its card over here.
  el.notesView?.addEventListener("pointerover", (event) => {
    if (!splitSurface || splitSurface !== "notes") return;
    paintCardLinkFor(event.target.closest?.("mark") || null);
  });
  el.notesView?.addEventListener("pointerleave", () => {
    if (!splitSurface) return;
    paintCardLinkFor(null);
  });

  el.highlightCycleBody?.addEventListener("scroll", () => {
    if (cycleScrollFrame) return;
    cycleScrollFrame = requestAnimationFrame(() => {
      cycleScrollFrame = 0;
      cycleScrollSpy();
    });
  }, { passive: true });

  // ← and → step through the highlights, but only while the pane itself has the
  // focus and only when nothing is being typed into it OR selected in it: those
  // two keys move the caret inside a note, and they also collapse and extend a
  // selection in rendered text. The rendered halves are named as well as the
  // textarea, because a note's body is something you select a phrase out of to
  // format now (registerCardTarget in highlights-editor.js) — taking ← and →
  // there would make the pill's own selection impossible to adjust.
  el.highlightCycle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target.closest("textarea, input, [contenteditable='true'], .split-divider")) return;
    if (event.target.closest(".hl-note-body, .hl-note-editor, .note-editor-rendered")) return;
    event.preventDefault();
    cycleHighlightBy(event.key === "ArrowRight" ? 1 : -1);
  });

  el.highlightCycle.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeHighlightSplit();
  });

  // Turning the phone sideways swaps which axis the divider works in, and the
  // ratio itself carries over unchanged — 3:2 of the height is the same
  // proportion as 3:2 of the width.
  window.addEventListener("resize", () => {
    if (!splitSurface) return;
    el.splitDivider?.setAttribute("aria-orientation", splitStacked() ? "horizontal" : "vertical");
    // Turning the phone sideways changes both which axis the split runs in and
    // how much room is below the chrome, so the measured length is retaken.
    applyStackedSpace();
    notePaneResized();
  });
}
