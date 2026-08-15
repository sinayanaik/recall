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
// built to avoid. On an ordinary note that is a few milliseconds. On a very
// large one it is seconds of frozen tab, which is not something to discover by
// switching a setting — hence NOTES_PAGED_MAX_CHARS below, and one toast
// instead of the freeze.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { isProgrammaticNotesScroll, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";

// Above this many characters of markdown, paged mode declines to lay the note
// out and says so once. Measured on the harness: a 250KB note paginates in
// roughly a second on a desktop, and a phone is several times slower again.
export const NOTES_PAGED_MAX_CHARS = 250000;

// How close to a page boundary counts as "on that page". Sub-pixel column
// widths mean scrollLeft is almost never an exact multiple of clientWidth.
const PAGE_EPSILON = 4;

const SETTLE_MS = 140;

export let notesReadingMode = "continuous";

let settleTimer = 0;
let pageIndicator = null;
let pageLabel = null;
let refitFrame = 0;

export function isNotesPaged() {
  return notesReadingMode !== "continuous" && !notesPagedTooLarge();
}

export function notesPagedTooLarge() {
  return (state.notes || "").length > NOTES_PAGED_MAX_CHARS;
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

export function notesPageCount() {
  if (!el.notesView) return 1;
  return Math.max(1, Math.round(el.notesView.scrollWidth / notesPageWidth()));
}

export function notesCurrentPage() {
  if (!el.notesView) return 0;
  return Math.max(0, Math.round(el.notesView.scrollLeft / notesPageWidth()));
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

export function goToNotesPage(page, { smooth = true } = {}) {
  const view = el.notesView;
  if (!view) return;
  const target = Math.max(0, Math.min(notesPageCount() - 1, Math.round(page)));
  markProgrammaticNotesScroll(smooth ? 800 : 220);
  view.scrollTo({ left: target * notesPageWidth(), top: 0, behavior: smooth ? "smooth" : "auto" });
  updateNotesPageIndicator(target);
}

export function turnNotesPage(delta) {
  goToNotesPage(notesCurrentPage() + delta);
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
  return revealPagedTarget(() => (node.isConnected ? notesPageForElement(node) : null));
}

// Same, for a Range — used by every jump that knows the exact text it wants
// (a highlight, a card's source anchor, a note link), where paging by the
// enclosing block would land a column early. See notesPageForRange.
export function revealRangeInPagedNotes(range) {
  if (!range) return false;
  return revealPagedTarget(() => {
    const node = range.startContainer;
    if (!node?.isConnected) return null;
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
    if (!isNotesPaged()) return;
    const page = resolve();
    if (page == null) return;
    goToNotesPage(page, { smooth: false });
  };
  aim();
  requestAnimationFrame(aim);
  setTimeout(aim, 180);
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
  if (pageLabel) pageLabel.textContent = `${Math.min(page + 1, total)} / ${total}`;
  const [back, , forward] = pageIndicator.children;
  if (back) back.disabled = page <= 0;
  if (forward) forward.disabled = page >= total - 1;
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
  view.style.setProperty("--notes-columns", notesReadingMode === "paged-2" ? "2" : "1");
  stage?.classList.toggle("is-paged-reading", paged && !view.hidden);
  if (pageIndicator) pageIndicator.hidden = !paged || view.hidden;

  // Declined, and says so ONCE. This used to be a panel pinned above the note
  // for as long as it was open, which is the wrong shape for the message: it is
  // news the first time and furniture every time after, and it was stealing
  // reading space on exactly the notes that have the most to show.
  if (notesReadingMode !== "continuous" && notesPagedTooLarge()) announcePagedTooLarge();

  if (paged) {
    // Leaving continuous mode, scrollTop is whatever the reader had; it means
    // nothing here and a non-zero value would offset every column.
    view.scrollTop = 0;
    updateNotesPageIndicator();
  } else if (wasPaged) {
    view.scrollLeft = 0;
  }
}

// Which note the notice has already been shown for, by length — enough to tell
// "the reader opened another huge note" from "the same note re-rendered because
// they typed a character", without holding on to a megabyte of markdown.
let pagedTooLargeAnnouncedFor = -1;

function announcePagedTooLarge() {
  const size = (state.notes || "").length;
  if (pagedTooLargeAnnouncedFor === size) return;
  pagedTooLargeAnnouncedFor = size;
  showToast(`Note too long for pages (${Math.round(size / 1000)}KB) — scrolling instead`);
}

// Snap to the nearest page after a free swipe, and keep the indicator honest
// while one is in flight.
export function scheduleNotesPageSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    const view = el.notesView;
    if (!view || !isNotesPaged()) return;
    // A smooth programmatic turn is still in flight. Snapping to "the nearest
    // page" now would snap to whatever page the ANIMATION has reached and
    // abandon the journey — measured as End landing on page 6 of 11. The
    // programmatic window (800ms for a smooth scroll) outlasts the animation,
    // and a real swipe never sets it.
    if (isProgrammaticNotesScroll()) { scheduleNotesPageSettle(); return; }
    const width = notesPageWidth();
    const nearest = Math.round(view.scrollLeft / width);
    if (Math.abs(view.scrollLeft - nearest * width) > PAGE_EPSILON) {
      markProgrammaticNotesScroll(400);
      view.scrollTo({ left: nearest * width, behavior: "smooth" });
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
    if (anchor?.isConnected) goToNotesPage(notesPageForElement(anchor), { smooth: false });
    updateNotesPageIndicator();
  });
}

// The first top-level block whose left edge is at or past the current page's
// left edge — i.e. the first thing the reader can actually see.
export function firstVisibleNotesBlock() {
  const view = el.notesView;
  if (!view) return null;
  const origin = view.getBoundingClientRect().left;
  for (const block of view.children) {
    const rect = block.getBoundingClientRect();
    if (rect.width && rect.left >= origin - PAGE_EPSILON) return block;
  }
  return view.firstElementChild;
}

// Wheel → page turn.
//
// A mouse has no horizontal axis to give a horizontally-scrolling box, so
// without this the whole desktop half of paged mode was two little arrows and
// the keyboard. The wheel's VERTICAL delta drives the page instead, which is
// what every reader app does and what the gesture already means here: "further
// through the document".
//
// Rate-limited rather than accumulated: a trackpad flick delivers dozens of
// events for one physical gesture, and summing them turns a flick into a
// twenty-page jump. One turn per gesture, with a cooldown that any continuing
// momentum keeps resetting — so a long flick still turns one page, and turning
// several means several deliberate flicks.
const WHEEL_COOLDOWN_MS = 420;
const WHEEL_THRESHOLD = 8;
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

  view.addEventListener("scroll", () => {
    if (!isNotesPaged()) return;
    updateNotesPageIndicator();
    scheduleNotesPageSettle();
  }, { passive: true });

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
