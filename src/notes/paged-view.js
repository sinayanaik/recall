// Paged reading: the note laid out as pages you turn, instead of one long scroll.
//
// ── How it works, and why this way ────────────────────────────────────────
//
// #notesView is already a scroll container. Turning it into a book needs no
// wrapper element and no re-render: give it `column-count` with
// `column-fill: auto` and a definite height, and the browser lays the note out
// in full-height columns running left to right. The element's own scrollWidth
// then IS the book, and one page is one clientWidth of it — so paging is
// `scrollLeft = page * clientWidth`, and the page you are on is
// `scrollLeft / clientWidth`.
//
// A wrapper was the obvious alternative and would have been a mistake: the
// incremental renderer's block cache is keyed on `.notes-rendered > *` being the
// note's top-level blocks (see render/block-cache.js), and interposing a div
// would have quietly invalidated every cached block on every render.
//
// Horizontal scrolling is left NATIVE — the page turn is a real swipe with real
// momentum, and a debounced settle snaps to the nearest page afterwards. Driving
// it entirely from JS (transform, touch-action: none) would have meant
// reimplementing momentum and would have broken press-and-hold text selection on
// a phone, which is how highlighting works.
//
// ── What paging costs, and the guard ──────────────────────────────────────
//
// `content-visibility: auto` on the note's blocks — the thing that makes a 400KB
// note open in ~90ms instead of ~9s — CANNOT survive here. Multi-column layout
// has to measure every block to know where the columns break, so the skipping it
// buys is unavailable by construction, and layout containment additionally makes
// a block monolithic, which stops it flowing across a column boundary at all.
// The rules that turn it off live with the paged rules in the stylesheet.
//
// So paged mode pays the full-layout cost the continuous view was carefully
// built to avoid — for whatever it is given. It used to be given the whole note,
// which is why it refused above 250,000 characters with a toast. It is now given
// ONE CHAPTER (see src/notes/chapters.js and the .is-active-chapter rules in the
// stylesheet), so the cost is bounded by chapter length rather than book length
// and the ceiling is gone.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { isProgrammaticNotesScroll, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import { notesTopLevelBlocks, reshapeRenderedChunks } from "../render/block-cache.js?v=__BUILD__";
import { chapterIndexFor } from "./chapters.js?v=__BUILD__";

// How close to a page boundary counts as "on that page". Sub-pixel column
// widths mean scrollLeft is almost never an exact multiple of clientWidth.
const PAGE_EPSILON = 4;

const SETTLE_MS = 140;

// Re-aiming a jump while the columns are still moving. See revealPagedTarget.
const PAGED_AIM_INTERVAL_MS = 120;

// Three, not ten. Each attempt WRITES scrollLeft, so a target that keeps moving
// showed the reader up to ten page jumps over 1.2 seconds — visible as the note
// juddering after any jump, and a large part of the "severe shivering" report.
// Two identical answers in a row (see `settled` below) is the normal exit and
// almost always arrives on the second attempt; the extra seven were only ever
// paying for a reflow that had already stopped.
const PAGED_AIM_MAX_ATTEMPTS = 3;

export let notesReadingMode = "continuous";

let settleTimer = 0;
let pageIndicator = null;
let pageLabel = null;
let refitFrame = 0;

export function isNotesPaged() {
  return notesReadingMode !== "continuous";
}

// Kept only so nothing that imports it breaks; it is always false now. Paged
// mode used to refuse above NOTES_PAGED_MAX_CHARS because multi-column layout
// has to measure everything it is given, and giving it a whole book cost
// seconds of frozen tab. It is now given ONE CHAPTER at a time, so the cost is
// bounded by chapter length rather than book length and there is nothing left
// to refuse. See src/notes/chapters.js.
export function notesPagedTooLarge() {
  return false;
}

// ── One chapter at a time ────────────────────────────────────────────────
//
// Only the active chapter is displayed (the rest are `display: none`, which
// costs no layout at all while keeping their nodes in the DOM, so the Highlights
// panel's mark count and every querySelectorAll still see the whole note). The
// active one is `display: contents`, so its blocks flow straight into
// #notesView's own multi-column context and the column-pitch invariant is
// untouched — that invariant is what every page turn depends on.
export let activeChapterIndex = 0;

export function notesChapters() {
  return chapterIndexFor(state.notes || "");
}

export function notesChapterCount() {
  return notesChapters().length;
}

// Re-marks the wrappers. Cheap: two class writes, no layout of its own.
export function applyActiveChapter() {
  const view = el.notesView;
  if (!view) return;
  const wrappers = view.querySelectorAll(":scope > .notes-chunk");
  if (!wrappers.length) return;
  const total = wrappers.length;
  activeChapterIndex = Math.max(0, Math.min(activeChapterIndex, total - 1));
  wrappers.forEach((node, i) => node.classList.toggle("is-active-chapter", i === activeChapterIndex));
}

// Show chapter `index`, landing on its first or last page. Returns false when
// there is no such chapter, which is how the page-turn code knows it has
// reached one end of the book.
export function goToNotesChapter(index, { atEnd = false } = {}) {
  const view = el.notesView;
  if (!view || !isNotesPaged()) return false;
  const total = view.querySelectorAll(":scope > .notes-chunk").length;
  if (!total || index < 0 || index >= total) return false;
  activeChapterIndex = index;
  applyActiveChapter();
  // The filler depends on where THIS chapter ends, so it is recomputed before
  // the page count is read.
  updateNotesPagedFiller();
  goToNotesPage(atEnd ? notesPageCount() - 1 : 0, { smooth: false });
  updateNotesPageIndicator();
  return true;
}

// The chapter a node lives in, activated. Everything that reveals something in
// the notes has to go through this first now: a mark, heading or block inside an
// inactive chapter is `display: none`, so it has no box, no page, and scrolling
// to it does nothing at all. That is the "go to in highlights stopped working"
// regression that came with paging by chapter.
//
// Returns false when the node is not in the notes, or is already in view.
export function activateChapterForNode(node) {
  const view = el.notesView;
  if (!view || !node || !isNotesPaged()) return false;
  const wrapper = node.nodeType === 1
    ? node.closest(".notes-chunk")
    : node.parentElement?.closest(".notes-chunk");
  if (!wrapper || wrapper.parentElement !== view) return false;
  if (wrapper.classList.contains("is-active-chapter")) return false;
  const wrappers = [...view.querySelectorAll(":scope > .notes-chunk")];
  const index = wrappers.indexOf(wrapper);
  if (index === -1) return false;
  activeChapterIndex = index;
  applyActiveChapter();
  updateNotesPagedFiller();
  return true;
}

export function notesPagedColumns() {
  return notesReadingMode === "paged-2" ? 2 : 1;
}

// A point that is guaranteed to be INSIDE a column, for anything that probes
// the view with elementFromPoint/caretFromPoint.
//
// The obvious probe — the horizontal middle of the view — is the one x that is
// guaranteed to be WRONG in two-column mode: it lands in the column gap, where
// elementFromPoint returns #notesView itself. Every caller then does
// `closest(".notes-rendered > *")` on a node that IS `.notes-rendered`, gets
// null, and falls through to its worst fallback. The centre of the first column
// is inside real content by construction.
export function notesPagedProbeX(rect) {
  return rect.left + rect.width / (2 * notesPagedColumns());
}

export function notesPageWidth() {
  return Math.max(1, el.notesView?.clientWidth || 1);
}

// Ceil, not round — a partial last page is still a page.
//
// A note whose content stops halfway through the final page leaves scrollWidth a
// FRACTIONAL multiple of clientWidth, and Math.round dropped that page from the
// count entirely. Everything that reads this then agreed the note was one page
// shorter than it is: goToNotesPage clamped the End key one page early,
// updateNotesPageIndicator disabled the ▸ button, notesPageForViewportLeft
// clamped every reveal and TOC jump short of the last page, and
// scheduleNotesPageSettle snapped back off it. The old code only worked at all
// because a two-column layout lands on exactly k + 0.5 and JS rounds .5 up — one
// sub-pixel of fractional clientWidth or em-resolved column gap either way and
// the last column vanished.
//
// The epsilon stops a scrollWidth that is a hair OVER a whole multiple (sub-pixel
// column widths, which is the normal case) from inventing an empty extra page.
export function notesPageCount() {
  if (!el.notesView) return 1;
  return Math.max(1, Math.ceil((el.notesView.scrollWidth - PAGE_EPSILON) / notesPageWidth()));
}

// How far the flow can actually be scrolled. On a note whose content stops
// partway through the final page this is LESS than (pageCount - 1) * pageWidth,
// and every page-turn target has to be clamped to it or the scroller silently
// refuses and the settle logic reads back a position nobody asked for.
//
// Deliberately NOT fixed by padding the flow out to a whole multiple: the column
// pitch invariant (see 18-paged-notes.css) requires the horizontal padding to be
// exactly half a gap, so widening the box there would misalign every page turn
// in the note to fix its last page. The last page overlapping the one before it
// by the unused remainder is what every paged reader does at the end of a book.
// Give the last page its missing column, when it is missing one.
//
// See the .has-page-filler rules. A two-column note ending in the first column
// of its final page leaves the flow half a page short, so the reader can never
// scroll the last page into place and the end of the note shares the screen
// with a column they have already read.
//
// The class has to come OFF before measuring: with the filler in, scrollWidth
// already includes it and the remainder reads as zero, so leaving it on would
// answer "no filler needed" and the two states would alternate. Cheap enough to
// do this way — it runs on a layout change, not on a page turn — and the
// alternative (tracking the filler's own width) is a second source of truth for
// something the box can simply be asked.
export function updateNotesPagedFiller() {
  const view = el.notesView;
  if (!view) return;
  view.classList.remove("has-page-filler");
  // One column IS one page, so the flow is always a whole number of pages and
  // there is never anything to fill.
  if (!isNotesPaged() || notesPagedColumns() < 2) return;
  // ...and NEVER between chapters. The filler exists so a flow that ends half a
  // page short still has a reachable final page — written when the flow was the
  // whole note and there was exactly one such ending. Paging by chapter gives
  // every chapter that ending, so this was appending an empty column at the end
  // of each one: measured at 642px of blank flow per chapter, a whole column of
  // nothing between every pair. That is the gap.
  //
  // Without it a short final page overlaps the one before rather than being
  // padded — the reader sees the tail of the chapter beside a column they have
  // already read, which is how a book ends a chapter anyway. It stays reachable
  // and stable regardless: notesMaxScrollLeft() clamps the target,
  // notesCurrentPage() treats the end of the flow as the last page, and
  // scheduleNotesPageSettle leaves it alone.
  if (view.querySelectorAll(":scope > .notes-chunk").length > 1) return;
  const width = view.clientWidth;
  if (width <= 0) return;
  const remainder = view.scrollWidth % width;
  if (remainder > PAGE_EPSILON && width - remainder > PAGE_EPSILON) view.classList.add("has-page-filler");
}

export function notesMaxScrollLeft() {
  const view = el.notesView;
  if (!view) return 0;
  return Math.max(0, view.scrollWidth - view.clientWidth);
}

export function notesCurrentPage() {
  const view = el.notesView;
  if (!view) return 0;
  // Parked at the end of the flow IS the last page, whatever the arithmetic
  // says. Without this the final (clamped) scroll position rounds back to the
  // second-to-last page, so the indicator claimed there was still a page to turn
  // to and ▸ stayed enabled with nowhere to go.
  const max = notesMaxScrollLeft();
  if (max > 0 && view.scrollLeft >= max - PAGE_EPSILON) return notesPageCount() - 1;
  return Math.max(0, Math.round(view.scrollLeft / notesPageWidth()));
}

// Which page holds a point `left` pixels into the flow?
export function notesPageForViewportLeft(left) {
  const view = el.notesView;
  if (!view) return 0;
  const flowLeft = left - view.getBoundingClientRect().left + view.scrollLeft;
  return Math.max(0, Math.min(notesPageCount() - 1, Math.floor((flowLeft + PAGE_EPSILON) / notesPageWidth())));
}

// Which page is `node` on? Measured against the view's own scroll origin rather
// than offsetLeft, which would be relative to whichever ancestor happens to be
// positioned — .notes-rendered is not one.
export function notesPageForElement(node) {
  if (!node?.getBoundingClientRect) return 0;
  return notesPageForViewportLeft(node.getBoundingClientRect().left);
}

// Which page is a RANGE on — which is not the same question as which page its
// block is on, and the difference is a bug you can see.
//
// A block fragmented across a column break has a bounding rect that is the
// UNION of its fragments, so its `.left` is the leftmost one. Ask it about a
// <mark> sitting in the tail of a paragraph that began in the previous column
// and it answers with the PREVIOUS page — and the highlight you asked to see is
// off-screen. Not an edge case either: the paged rules deliberately turn
// content-visibility off precisely so that paragraphs DO flow across column
// breaks, and two columns double the number of breaks.
//
// getClientRects() returns one rect per fragment, in document order, so the
// first is the fragment the range actually starts in.
export function notesPageForRange(range) {
  if (!range?.getClientRects) return 0;
  const rects = range.getClientRects();
  const first = rects.length ? rects[0] : range.getBoundingClientRect?.();
  if (!first || (!first.width && !first.height)) return 0;
  return notesPageForViewportLeft(first.left);
}

// How long a page turn takes, and its easing.
//
// The browser's own `behavior: "smooth"` is what this replaced, and it is the
// wrong animation for a page turn: its duration scales with the DISTANCE, so a
// Page changes are a plain, immediate jump — no eased tween. `smooth` is kept
// as a no-op parameter rather than removed from every call site, so callers
// that used to ask for the animated turn don't need touching.
export function cancelNotesPageTween() {}

export function goToNotesPage(page, { smooth = true } = {}) { // eslint-disable-line no-unused-vars
  const view = el.notesView;
  if (!view) return;
  const target = Math.max(0, Math.min(notesPageCount() - 1, Math.round(page)));
  const to = Math.min(target * notesPageWidth(), notesMaxScrollLeft());
  updateNotesPageIndicator(target);
  markProgrammaticNotesScroll(220);
  view.scrollLeft = to;
}

export function turnNotesPage(delta) {
  const target = notesCurrentPage() + delta;
  // Past either end of this chapter, the turn continues into the next one —
  // which is what makes a book of chapters read as one book rather than as a
  // set of documents you have to pick between.
  if (target < 0 && goToNotesChapter(activeChapterIndex - 1, { atEnd: true })) return;
  if (target > notesPageCount() - 1 && goToNotesChapter(activeChapterIndex + 1)) return;
  goToNotesPage(target);
}

// Put `node` on screen, paged-style: turn to its page rather than scrolling it
// to a line. Every "reveal something in the notes" path in the app funnels into
// one of four scroll helpers, and each of them calls this first when paged.
//
// Re-aimed twice afterwards, for the same reason the continuous version has a
// re-aiming loop — except that here the thing that moves is not heights but
// COLUMNS. The commonest case is the table of contents itself: on a phone the
// drawer closes as soon as you tap an entry, which widens #notesView, which
// re-flows every column, so the page the jump landed on now holds different
// text. Measured before this: the heading was off-screen after a TOC jump on a
// 390px viewport, every time.
export function revealInPagedNotes(node) {
  if (!node) return false;
  // Before the aim, and on every re-aim: the target may be in a chapter that is
  // not on screen, and an unactivated chapter has no geometry to aim at.
  return revealPagedTarget(() => {
    if (!node.isConnected) return null;
    activateChapterForNode(node);
    return notesPageForElement(node);
  });
}

// Same, for a Range — used by every jump that knows the exact text it wants
// (a highlight, a card's source anchor, a note link), where paging by the
// enclosing block would land a column early. See notesPageForRange.
export function revealRangeInPagedNotes(range) {
  if (!range) return false;
  return revealPagedTarget(() => {
    const node = range.startContainer;
    if (!node?.isConnected) return null;
    activateChapterForNode(node);
    return notesPageForRange(range);
  });
}

// Turn to whatever page `resolve()` names, then again on the next frame and
// once more shortly after — for the same reason the continuous version has a
// re-aiming loop, except that here what moves is not heights but COLUMNS. The
// commonest case is the table of contents: on a phone the drawer closes as soon
// as you tap an entry, which widens #notesView and re-flows every column, so the
// page the jump landed on now holds different text. Measured before this: the
// heading was off-screen after a TOC jump on a 390px viewport, every time.
//
// `resolve` returns null once its target has left the DOM (an incremental
// re-render can replace the block under a jump), which ends the re-aiming
// rather than throwing.
function revealPagedTarget(resolve) {
  if (!isNotesPaged()) return false;
  const aim = () => {
    if (!isNotesPaged()) return null;
    const page = resolve();
    if (page == null) return null;
    goToNotesPage(page, { smooth: false });
    return page;
  };
  aim();
  // Then keep re-asking until the answer stops changing. Three fixed attempts
  // was not enough: a reflow that arrives late — the drawer finishing its close,
  // an image below the fold loading, a font swapping in — re-columns the note
  // after the last aim and leaves the target off-screen with nothing left to
  // correct it. Two identical answers in a row means the columns have settled.
  let settled = 0;
  let last = null;
  let attempts = 0;
  const again = () => {
    if (attempts >= PAGED_AIM_MAX_ATTEMPTS) return;
    // A hidden tab reflows nothing, so re-aiming there is a scroll write against
    // a layout that cannot have changed — and the reader comes back to whatever
    // the last attempt guessed instead of where they left off.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    attempts += 1;
    const page = aim();
    if (page == null) return;
    if (page === last) settled += 1;
    else settled = 0;
    last = page;
    if (settled >= 1) return;
    setTimeout(again, PAGED_AIM_INTERVAL_MS);
  };
  requestAnimationFrame(again);
  return true;
}

// The proportional jump used to centre a text search. There is no scrollHeight
// to take a fraction of here, so it is a fraction of the page count.
export function estimateNotesPageForFraction(fraction) {
  if (!isNotesPaged()) return false;
  goToNotesPage(Math.floor(Math.max(0, Math.min(1, fraction)) * (notesPageCount() - 1)), { smooth: false });
  return true;
}

// ── The indicator ──────────────────────────────────────────────────────────

export function ensureNotesPageIndicator() {
  if (pageIndicator?.isConnected) return pageIndicator;
  const stage = el.notesStage || document.getElementById("notesStage");
  if (!stage) return null;
  pageIndicator = document.createElement("div");
  pageIndicator.className = "notes-page-indicator";
  pageIndicator.hidden = true;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "notes-page-btn";
  back.innerHTML = '<span aria-hidden="true">&#8249;</span>';
  back.title = "Previous page";
  back.setAttribute("aria-label", "Previous page");
  back.addEventListener("click", () => turnNotesPage(-1));
  const forward = document.createElement("button");
  forward.type = "button";
  forward.className = "notes-page-btn";
  forward.innerHTML = '<span aria-hidden="true">&#8250;</span>';
  forward.title = "Next page";
  forward.setAttribute("aria-label", "Next page");
  forward.addEventListener("click", () => turnNotesPage(1));
  pageLabel = document.createElement("span");
  pageLabel.className = "notes-page-label";
  pageLabel.setAttribute("aria-live", "polite");
  pageIndicator.append(back, pageLabel, forward);
  stage.appendChild(pageIndicator);
  return pageIndicator;
}

export function updateNotesPageIndicator(pageHint = null) {
  if (!pageIndicator) return;
  const total = notesPageCount();
  const page = pageHint == null ? notesCurrentPage() : pageHint;
  if (pageLabel) {
    const chapters = el.notesView?.querySelectorAll(":scope > .notes-chunk").length || 1;
    pageLabel.textContent = chapters > 1
      ? `Ch ${activeChapterIndex + 1}/${chapters} · ${Math.min(page + 1, total)}/${total}`
      : `${Math.min(page + 1, total)} / ${total}`;
  }
  const [back, , forward] = pageIndicator.children;
  const chapters = el.notesView?.querySelectorAll(":scope > .notes-chunk").length || 1;
  if (back) back.disabled = page <= 0 && activeChapterIndex <= 0;
  if (forward) forward.disabled = page >= total - 1 && activeChapterIndex >= chapters - 1;
}

// ── Applying the mode ──────────────────────────────────────────────────────

export function setNotesReadingMode(mode) {
  notesReadingMode = ["continuous", "paged-1", "paged-2"].includes(mode) ? mode : "continuous";
  applyNotesPagedLayout();
}

// Re-derives everything from the current mode and the current note. Cheap and
// idempotent, so every trigger — the setting changing, the note changing, a
// resize, leaving the raw editor — can just call it.
export function applyNotesPagedLayout() {
  const view = el.notesView;
  const stage = el.notesStage || document.getElementById("notesStage");
  if (!view) return;
  ensureNotesPageIndicator();

  const paged = isNotesPaged();
  const wasPaged = view.classList.contains("is-paged");
  view.classList.toggle("is-paged", paged);
  // Chunk wrappers cannot exist in a columned layout — see
  // shouldChunkRenderedBlocks. The class above is what that gate reads, so this
  // has to follow it, and it moves the existing nodes rather than re-rendering.
  if (paged !== wasPaged) reshapeRenderedChunks(view);
  view.style.setProperty("--notes-columns", notesReadingMode === "paged-2" ? "2" : "1");
  stage?.classList.toggle("is-paged-reading", paged && !view.hidden);
  if (pageIndicator) pageIndicator.hidden = !paged || view.hidden;

  if (paged) {
    // Leaving continuous mode, scrollTop is whatever the reader had; it means
    // nothing here and a non-zero value would offset every column.
    view.scrollTop = 0;
    // Before the filler and the indicator: both read the flow's width, and the
    // flow is only this chapter.
    applyActiveChapter();
    // Before the indicator: the filler changes the page COUNT, and an indicator
    // drawn from the pre-filler width would be one page short of what it is
    // about to become.
    updateNotesPagedFiller();
    updateNotesPageIndicator();
  } else if (wasPaged) {
    view.classList.remove("has-page-filler");
    view.scrollLeft = 0;
  }
}

// Is the reader in the middle of selecting text in the notes?
//
// Deliberately answered here, from the live Selection, rather than by importing
// isSelectionAdjusting() from ./selection.js. notes-view.js already imports BOTH
// this module and that one, and that one imports notes-view.js back — so an
// import in this direction would close a three-module cycle for what is two
// property reads. (The one cycle that does exist here is documented at the top
// of selection.js, along with why it is safe; there is no reason to add a
// second.)
export function notesSelectionIsLive() {
  const view = el.notesView;
  if (!view || view.hidden) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  return view.contains(selection.anchorNode) || view.contains(selection.focusNode);
}

// Snap to the nearest page after a free swipe, and keep the indicator honest
// while one is in flight.
export function scheduleNotesPageSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    const view = el.notesView;
    if (!view || !isNotesPaged()) return;
    // The reader is selecting. Extending a selection past the edge of the page
    // is done by dragging a handle there and letting the view auto-scroll —
    // which arrives here as an ordinary scroll event, 140ms before this snaps
    // the flow back to the nearest column. The reader's finger does not move
    // with it, so the selection end lands a page away from where they aimed.
    //
    // Unlike the isProgrammaticNotesScroll() case below, this does NOT
    // re-schedule: a selection can sit on screen for as long as the reader
    // likes, and re-arming would leave a 140ms timer running for all of it. The
    // selectionchange listener in initPagedNotes settles once, when the
    // selection collapses.
    if (notesSelectionIsLive()) return;
    // A smooth programmatic turn is still in flight. Snapping to "the nearest
    // page" now would snap to whatever page the ANIMATION has reached and
    // abandon the journey — measured as End landing on page 6 of 11. The
    // programmatic window (800ms for a smooth scroll) outlasts the animation,
    // and a real swipe never sets it.
    if (isProgrammaticNotesScroll()) { scheduleNotesPageSettle(); return; }
    const width = notesPageWidth();
    const max = notesMaxScrollLeft();
    // Already at the end of the flow: this is the last page and there is nothing
    // to snap to. Snapping anyway is what pulled the reader off the final page
    // every time they swiped to it.
    if (max > 0 && view.scrollLeft >= max - PAGE_EPSILON) {
      updateNotesPageIndicator(notesPageCount() - 1);
      return;
    }
    const nearest = Math.round(view.scrollLeft / width);
    const to = Math.min(nearest * width, max);
    if (Math.abs(view.scrollLeft - to) > PAGE_EPSILON) {
      markProgrammaticNotesScroll(400);
      view.scrollTo({ left: to, behavior: "smooth" });
    }
    updateNotesPageIndicator(nearest);
  }, SETTLE_MS);
}

// A resize, a rotate or a font change re-flows every column, so the page the
// reader was on no longer holds the same text. The page NUMBER is therefore
// worthless; the block that was on screen is not.
export function repaginateNotesPreservingPlace() {
  const view = el.notesView;
  if (!view || !isNotesPaged()) return;
  const anchor = firstVisibleNotesBlock();
  cancelAnimationFrame(refitFrame);
  refitFrame = requestAnimationFrame(() => {
    refitFrame = 0;
    // A resize re-flows every column, so whether the last page is short has
    // changed too — measured before the page is aimed, since the filler moves
    // the page boundaries the aim is computed against.
    updateNotesPagedFiller();
    if (anchor?.isConnected) goToNotesPage(notesPageForElement(anchor), { smooth: false });
    updateNotesPageIndicator();
  });
}

// The first top-level block whose left edge is at or past the current page's
// left edge — i.e. the first thing the reader can actually see.
// Binary search, not a sweep. Document order runs along X in a columned layout,
// so a block's `left` is monotonic across the list — and this is called from
// every re-aim, every repagination and (via blockAtNotesReadingLine) every pin,
// where a linear walk forced a getBoundingClientRect on every block in the note
// before finding one near the front. On a long note that is thousands of forced
// layouts per page turn.
//
// `left` is the union of a fragmented block's rects, i.e. its FIRST fragment,
// which is the right key here: a paragraph flowing across a column break belongs
// to the column it starts in.
export function firstVisibleNotesBlock() {
  const view = el.notesView;
  if (!view) return null;
  // Only the active chapter is laid out in paged mode; every other block
  // reports a zero rect, which the search below cannot order. Scoping to the
  // chapter on screen is also simply the right answer to "what is the reader
  // looking at".
  const active = view.querySelector(":scope > .notes-chunk.is-active-chapter");
  const blocks = active && isNotesPaged()
    ? [...active.children].filter((n) => n.nodeType === 1)
    : notesTopLevelBlocks(view);
  if (!blocks.length) return null;
  const origin = view.getBoundingClientRect().left;
  let low = 0;
  let high = blocks.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rect = blocks[mid].getBoundingClientRect();
    // A zero-width block (an empty or fully-collapsed one) has no position to
    // compare; treat it as "before" so the search keeps moving forward rather
    // than converging on it.
    if (!rect.width || rect.left < origin - PAGE_EPSILON) {
      low = mid + 1;
    } else {
      found = blocks[mid];
      high = mid - 1;
    }
  }
  return found || blocks[0];
}

// Wheel → page turn.
//
// A mouse has no horizontal axis to give a horizontally-scrolling box, so
// without this the whole desktop half of paged mode was two little arrows and
// the keyboard. The wheel's VERTICAL delta drives the page instead, which is
// what every reader app does and what the gesture already means here: "further
// through the document".
//
// One clean page turn per gesture — deliberately NOT continuous. A wheel
// tick fires the same eased tween goToNotesPage() already gives keyboard and
// button turns, so it reads as a page flipping, not content being dragged.
//
// Rate-limited rather than accumulated: a trackpad flick delivers dozens of
// wheel events for one physical gesture, and turning a page per event would
// turn one flick into a many-page jump. The FIRST event of a gesture turns
// the page immediately (low effort — a light nudge is enough, no need to
// build up distance), and the cooldown below just swallows the rest of that
// same gesture's tail so it doesn't fire again. Kept short (250ms, was
// 420ms) so it only debounces one gesture's own momentum rather than also
// eating a second, deliberate scroll right after — that's what read as
// "resistance"/unresponsive before.
const WHEEL_COOLDOWN_MS = 250;
const WHEEL_THRESHOLD = 4;
let wheelReadyAt = 0;

export function handleNotesWheel(event) {
  if (!isNotesPaged() || el.notesView?.hidden) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (Math.abs(delta) < WHEEL_THRESHOLD) return;
  // The box scrolls horizontally, so a vertical wheel would otherwise do
  // nothing at all and the page behind it would scroll instead.
  event.preventDefault();
  const now = performance.now();
  if (now < wheelReadyAt) {
    // Still inside the cooldown: this is the tail of the same gesture. Push the
    // window out so the momentum cannot spill into a second turn.
    wheelReadyAt = now + WHEEL_COOLDOWN_MS;
    return;
  }
  wheelReadyAt = now + WHEEL_COOLDOWN_MS;
  turnNotesPage(delta > 0 ? 1 : -1);
}

export function initPagedNotes() {
  const view = el.notesView;
  if (!view) return;
  ensureNotesPageIndicator();

  // Not passive: paging has to preventDefault, or a vertical wheel over a
  // horizontally-scrolling box scrolls the page behind it instead.
  view.addEventListener("wheel", handleNotesWheel, { passive: false });

  // A touch that lands mid-tween takes over: the reader is doing something more
  // recent than the animation, and leaving the tween running would drag the page
  // back out from under their finger.
  view.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") cancelNotesPageTween();
  }, { passive: true });

  view.addEventListener("scroll", () => {
    if (!isNotesPaged()) return;
    updateNotesPageIndicator();
    scheduleNotesPageSettle();
  }, { passive: true });

  // The other half of the selection guard in scheduleNotesPageSettle. That
  // guard returns WITHOUT re-arming, so nothing would ever snap the columns
  // back if the reader's last scroll happened during a selection — which is the
  // normal case, since extending a selection to the page edge is what scrolled
  // the view in the first place. Collapsing the selection (a tap, an Escape,
  // acting on the pill) is the moment that becomes safe, and it fires exactly
  // one selectionchange.
  document.addEventListener("selectionchange", () => {
    if (!isNotesPaged() || state.viewMode !== "notes") return;
    if (notesSelectionIsLive()) return;
    scheduleNotesPageSettle();
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => repaginateNotesPreservingPlace()).observe(view);
  }

  // Arrow / PageUp / PageDown turn pages. Registered here rather than in the
  // app's main keydown handler so the whole feature stays in one file; guarded
  // on paged mode and on not being in a text field, so it can never shadow the
  // card-navigation arrows or the raw editor's own caret movement.
  document.addEventListener("keydown", (event) => {
    if (!isNotesPaged() || state.viewMode !== "notes" || view.hidden) return;
    if (event.target?.matches?.("input, textarea")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); turnNotesPage(1); }
    else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); turnNotesPage(-1); }
    else if (event.key === "Home") { event.preventDefault(); goToNotesPage(0); }
    else if (event.key === "End") { event.preventDefault(); goToNotesPage(notesPageCount() - 1); }
  });
}
