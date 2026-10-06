// ▣ — a one-shot highlighter that knows words from pictures.
//
// The Document surface's selection goes through a transparent text layer: one
// span per pdf.js text item, sitting exactly over its glyphs, so a drag across
// them is a real DOM selection that captureDocumentSelection can turn into
// { page, item, ch } (see pdf-selection.js). That is the right machinery for
// prose and it has nothing to say about the other half of a paper — a figure, a
// plotted result, a scanned table, a display equation typeset as vector art.
// There are no spans over any of those. Half the content of a paper could not
// be highlighted, noted or made into a card at all — which is what the BOX this
// file started as was for:
//
//   { id, color, page, anchor, focus, text, quads: [one quad], kind: "area" }
//
// — an ordinary document highlight, because everything that reads one of those
// already works. Painting, the tap-to-open menu (documentHighlightAtPoint
// hit-tests the quads geometrically, so it never needed text), notes, the
// Highlights panel, the export, the sync merge. A region is a highlight whose
// quad happens not to have come from a run of glyphs.
//
// ── What a drag means now ───────────────────────────────────────────────────
//
// Smart enough to distinguish: where there is actual text, highlight it as
// text; where there is none, only a scanned page, highlight it as a region.
//
//   A drag that STARTS ON WORDS highlights those words, snapped out to whole
//   words, in the reader's highlight colour — at once, with no selection bar to
//   press in between. A live preview shows exactly what will land.
//   A drag that starts anywhere else — the margin, a figure, a page with no
//   words at all (a scan) — draws a box, which becomes a region, as it always
//   did, and opens its menu.
//   To box something that IS words (a table, an equation set as text): start
//   beside it, or hold still a moment before moving, or hold Alt with a mouse.
//
// "On words" is decided geometrically by src/documents/pdf-smart-highlight.js:
// while this mode is on the text layer takes no pointer events, so nothing
// here can ask the browser what is under the pointer.
//
// ── One highlight per press ────────────────────────────────────────────────
//
// It has gone back and forth between staying on and switching off. It stayed
// on for a while, and readers found it rarely used twice in a row — so a
// sticky mode mostly meant remembering to switch it off again before a finger
// could scroll. Now one finished drag — a box that became a region, or words
// highlighted — turns the mode off. A press that made nothing (a tap, which is
// how an existing highlight's menu is reached; a box too small to keep; a drag
// cancelled by a second finger) leaves it armed, so a slip does not cost the
// press.
//
// While it is armed a finger is a highlighter, the same way a pen is a pen, so
// two fingers scroll (and pinch to zoom, as ever), a drag held near the edge of
// the page scrolls it, the pill at the top says what to do, and ▣ or Esc
// cancels. It also goes by itself the moment the reader leaves the paper —
// another tab, another document, or picking up the pen bar's own tools.

import { PDF_BLOCK_CLASS } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { inkPenIsDown, setInkPenDown } from "../core/gesture.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { renderFormatDefaults } from "../format/render-toolbar.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { addDocumentHighlight, DOCUMENT_MARK_HANDLERS, PDF_MARK_CLASS } from "./pdf-highlights.js?v=__BUILD__";
import { pageNumberForRect, rectToPdfQuad } from "./pdf-selection.js?v=__BUILD__";
import {
  SMART_HL_PRESS_SLOP, SMART_HL_PRESS_SLOP_TOUCH, smartHlApply, smartHlCapture, smartHlCaretAt, smartHlClearPreview,
  smartHlPageHasText, smartHlPaintPreview, smartHlRangeBetween, smartHlRememberAdd, smartHlSpans
} from "./pdf-smart-highlight.js?v=__BUILD__";
import { documentPinchEngaged } from "./pdf-view.js?v=__BUILD__";
import { closeMarkMenu, openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";

export const REGION_CLASS = "is-region-select";

export const REGION_MARQUEE_CLASS = "pdf-region-marquee";

// Over words, the pointer says so — a text cursor rather than the crosshair.
export const REGION_TEXT_HOVER_CLASS = "is-smart-hl-text";

// Below this a drag is a tap that wandered, not a box. 12px square is small
// enough to draw a deliberate marquee around an inline symbol and large enough
// that a thumb resting on the page never commits one.
export const REGION_MIN_SIZE = 12;

// Shorter than this, a drag across words is a TAP — which is how an existing
// highlight is opened while the mode is on. Wider for a finger, whose contact
// point wanders as it lands.
const REGION_TEXT_MIN_DRAG = 6;
const REGION_TEXT_MIN_DRAG_TOUCH = 10;

// Held this long without moving, a press on words draws a box instead — the
// way to box a table or an equation that happens to be made of text.
const REGION_HOLD_FOR_BOX_MS = 450;

// The click a finished drag leaves behind lands on the page it ended over (the
// pointer was captured), and on a highlight that would open its menu — the one
// just made, under the pointer. Swallowed for this long after a drag; a tap is
// never swallowed, because a tap is how a highlight's menu is reached.
const REGION_SWALLOW_CLICK_MS = 400;

// A drag held within this distance of the scroller's edge scrolls it, by up to
// this many pixels a frame — the deeper into the edge, the faster.
const REGION_EDGE = 36;
const REGION_EDGE_SPEED = 18;

let regionArmed = false;
let regionDrag = null;
let regionSwallowClickUntil = 0;
let regionPan = null;
let regionHoverFrame = 0;
let regionDocKey = "";
let regionSpanCache = null;

export function isRegionSelectArmed() {
  return regionArmed;
}

function paintRegionButton() {
  el.documentRegionBtn?.setAttribute("aria-pressed", regionArmed ? "true" : "false");
}

export function setRegionSelect(on) {
  regionArmed = Boolean(on);
  el.documentStage?.classList.toggle(REGION_CLASS, regionArmed);
  paintRegionButton();
  if (regionArmed) {
    // A selection left over from before would sit under the first highlight,
    // and its bar over it.
    window.getSelection()?.removeAllRanges();
  } else {
    cancelRegionDrag();
    regionPan = null;
    el.documentStage?.classList.remove(REGION_TEXT_HOVER_CLASS);
  }
}

export function toggleRegionSelect() {
  setRegionSelect(!regionArmed);
  return regionArmed;
}

// Told by src/main.js each time a document is opened on the stage. Another
// document, or the Write tab's notebook, is somewhere the reader went — the
// mode stays behind. The same document opened again (a sync re-reading the
// file, a refit) is not, and keeps it.
export function noteRegionDocumentOpened({ key = "", slot = "doc" } = {}) {
  if (regionArmed && (slot !== "doc" || key !== regionDocKey)) setRegionSelect(false);
  regionDocKey = slot === "doc" ? key : "";
}

// ── Where things are ────────────────────────────────────────────────────────

// The page under a point. The text layer takes no presses in this mode, so
// this lands on the page's canvas, which is what is wanted.
function regionPageUnder(clientX, clientY) {
  return document.elementFromPoint(clientX, clientY)?.closest(".pdf-page") || null;
}

// A page's spans, measured once and again only after a scroll — the boxes are
// client coordinates, and measuring every span at every frame of a drag over a
// dense page is a layout per frame for nothing. Forgotten at every press (a
// zoom or a late --pdf-span-scale can have moved them since), and, between
// presses, after a second: the hover cursor asks often and needs no better.
const REGION_SPAN_CACHE_MS = 1000;

function regionSpans(page) {
  const view = el.documentView;
  const scroll = `${view?.scrollTop || 0}:${view?.scrollLeft || 0}`;
  const cache = regionSpanCache;
  if (cache && cache.page === page && cache.scroll === scroll
      && (regionDrag || Date.now() - cache.at < REGION_SPAN_CACHE_MS)) return cache.list;
  const list = smartHlSpans(page);
  regionSpanCache = { page, scroll, at: Date.now(), list };
  return list;
}

function regionSlop(pointerType) {
  return pointerType === "touch" ? SMART_HL_PRESS_SLOP_TOUCH : SMART_HL_PRESS_SLOP;
}

function regionColor() {
  return renderFormatDefaults.highlight || MARK_HIGHLIGHT_DEFAULT;
}

// ── The box ─────────────────────────────────────────────────────────────────
//
// The marquee is drawn INSIDE the .pdf-page the press landed on, absolutely
// positioned in that page's own coordinate space — the same space the quads
// live in. Its origin is kept in that space too, so a drag that scrolls the
// page under it (the wheel, or the edge scrolling below) keeps its corner on
// the spot it was started from.
function regionBoxFromPoints(pageEl, from, to) {
  const rect = pageEl.getBoundingClientRect();
  const fromX = from.x;
  const fromY = from.y;
  const toX = to.x - rect.left;
  const toY = to.y - rect.top;
  const left = Math.min(fromX, toX);
  const top = Math.min(fromY, toY);
  return {
    left: Math.max(0, Math.min(left, rect.width)),
    top: Math.max(0, Math.min(top, rect.height)),
    width: Math.min(Math.abs(toX - fromX), rect.width),
    height: Math.min(Math.abs(toY - fromY), rect.height)
  };
}

function regionStartBox(drag) {
  const box = document.createElement("div");
  box.className = REGION_MARQUEE_CLASS;
  drag.pageEl.appendChild(box);
  drag.box = box;
  drag.kind = "box";
  updateRegionMarquee();
}

function updateRegionMarquee() {
  const drag = regionDrag;
  if (!drag?.box) return;
  const box = regionBoxFromPoints(drag.pageEl, drag.from, drag.to);
  drag.box.style.left = `${box.left}px`;
  drag.box.style.top = `${box.top}px`;
  drag.box.style.width = `${box.width}px`;
  drag.box.style.height = `${box.height}px`;
}

// The commit. Every conversion below already existed for text highlights, and
// is reused rather than reimplemented — which is what makes a region survive a
// zoom, a rotation and a reload exactly as well as a sentence does, since the
// quad is in PDF user space and nothing else is.
function commitRegionBox(drag) {
  const pageRect = drag.pageEl.getBoundingClientRect();
  const box = regionBoxFromPoints(drag.pageEl, drag.from, drag.to);
  if (box.width < REGION_MIN_SIZE || box.height < REGION_MIN_SIZE) return false;
  const clientRect = {
    left: pageRect.left + box.left,
    top: pageRect.top + box.top,
    right: pageRect.left + box.left + box.width,
    bottom: pageRect.top + box.top + box.height,
    width: box.width,
    height: box.height
  };
  const pageNumber = pageNumberForRect(clientRect, drag.page || 1, drag.page || 1);
  const quad = rectToPdfQuad(clientRect, pageNumber);
  // No viewport for the page means it has never been laid out, which cannot
  // happen for a page the reader just dragged across — but a null quad painted
  // as a highlight would be a record with no position, and those are forever.
  if (!quad) {
    showToast("Could not place that region — try again once the page has finished drawing", "error");
    return false;
  }

  // No text is captured for a region: the box marks a LOCATION, not a run of
  // glyphs, and a dragged box has no reliable idea what belongs to it (a
  // multi-column layout, a table, a figure with a caption underneath all give
  // pdf.js text items in an order and a hit-test that don't agree with what
  // the box visually contains). A card made from this quad renders it live
  // instead of reading words out of it — see mountPdfRegionEmbed in
  // src/documents/pdf-region-embed.js, wired from main.js's makeCard verb.
  // Words are what a drag that starts ON them is for.
  const anchor = { page: pageNumber, item: 0, ch: 0 };
  const record = addDocumentHighlight({
    kind: "area",
    page: pageNumber,
    anchor,
    focus: anchor,
    text: "",
    quads: [quad]
  }, regionColor());
  if (!record) return false;
  smartHlRememberAdd(record);

  // Straight into the highlight's own menu, anchored on what was just drawn: a
  // region is almost always made in order to say something about the figure,
  // and making the reader find the box again to tap it is a step for nothing.
  // A run of words is not — highlighting line after line is the point of a
  // highlighter, and a menu after each would be in the way of the next.
  const mark = el.documentView?.querySelector(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(record.id)}"]`);
  if (mark) openMarkMenuWith(mark, record.id, DOCUMENT_MARK_HANDLERS, record.color);
  return true;
}

// ── The words ───────────────────────────────────────────────────────────────

function updateRegionText() {
  const drag = regionDrag;
  if (!drag || drag.kind !== "text") return;
  const pageEl = regionPageUnder(drag.last.x, drag.last.y);
  const page = Number(pageEl?.dataset.pageNumber) || 0;
  // Off every page (the gap between two, the margin of the scroller): the end
  // stays where it last was, rather than snapping to somewhere surprising.
  if (page && smartHlPageHasText(page) === true) {
    const end = smartHlCaretAt(page, drag.last.x, drag.last.y, { spans: regionSpans(page) });
    if (end) {
      drag.end = end;
      drag.endPage = page;
    }
  }
  drag.range = smartHlRangeBetween(drag.start, drag.end);
  const pages = [Math.min(drag.page, drag.endPage), Math.max(drag.page, drag.endPage)];
  smartHlPaintPreview(drag.range, drag.color, pages);
}

function commitRegionText(drag) {
  const made = drag.range ? smartHlCapture(drag.range) : null;
  if (!made) return false;
  smartHlApply(made, drag.color);
  return true;
}

// ── One drag, from press to whichever way it ends ───────────────────────────

function regionFrame() {
  if (!regionDrag) return;
  regionDrag.frame = 0;
  if (regionDrag.kind === "box") updateRegionMarquee();
  else updateRegionText();
}

function scheduleRegionFrame() {
  if (!regionDrag || regionDrag.frame) return;
  regionDrag.frame = requestAnimationFrame(regionFrame);
}

// The edge of the scroller, while a drag is held in it: scrolled a little every
// frame, and the drag brought up to date, for as long as the pointer stays
// there. Without this a mode with no one-finger scroll could not carry
// a highlight or a box past the bottom of the screen.
function regionEdgeStep() {
  const drag = regionDrag;
  const view = el.documentView;
  if (!drag || !view) return;
  drag.edgeFrame = 0;
  if (drag.travel < REGION_TEXT_MIN_DRAG) return;
  const rect = view.getBoundingClientRect();
  const depth = (distance) => Math.ceil(Math.min(1, (REGION_EDGE - distance) / REGION_EDGE) * REGION_EDGE_SPEED);
  let dy = 0;
  let dx = 0;
  if (drag.last.y < rect.top + REGION_EDGE) dy = -depth(drag.last.y - rect.top);
  else if (drag.last.y > rect.bottom - REGION_EDGE) dy = depth(rect.bottom - drag.last.y);
  if (drag.last.x < rect.left + REGION_EDGE) dx = -depth(drag.last.x - rect.left);
  else if (drag.last.x > rect.right - REGION_EDGE) dx = depth(rect.right - drag.last.x);
  if (!dx && !dy) return;
  const beforeTop = view.scrollTop;
  const beforeLeft = view.scrollLeft;
  view.scrollTop += dy;
  view.scrollLeft += dx;
  if (view.scrollTop === beforeTop && view.scrollLeft === beforeLeft) return;
  regionFrame();
  drag.edgeFrame = requestAnimationFrame(regionEdgeStep);
}

function beginRegionDrag(event) {
  const pageEl = regionPageUnder(event.clientX, event.clientY);
  if (!pageEl) return false;
  const page = Number(pageEl.dataset.pageNumber) || 0;
  const pageRect = pageEl.getBoundingClientRect();
  const at = { x: event.clientX, y: event.clientY };
  regionDrag = {
    kind: "text",
    pointerId: event.pointerId,
    pointerType: event.pointerType || "mouse",
    pageEl,
    page,
    endPage: page,
    from: { x: at.x - pageRect.left, y: at.y - pageRect.top },
    to: at,
    last: at,
    travel: 0,
    color: regionColor(),
    start: null,
    end: null,
    range: null,
    box: null,
    frame: 0,
    edgeFrame: 0,
    holdTimer: 0,
    penDown: false
  };
  regionSpanCache = null;
  const start = !event.altKey && smartHlPageHasText(page) === true
    ? smartHlCaretAt(page, at.x, at.y, { strict: true, slop: regionSlop(event.pointerType), spans: regionSpans(page) })
    : null;
  if (start) {
    regionDrag.start = start;
    regionDrag.end = start;
    // Held still on words: the reader wants a box round them, not their text.
    regionDrag.holdTimer = setTimeout(() => {
      const drag = regionDrag;
      if (!drag || drag.kind !== "text" || drag.travel >= REGION_TEXT_MIN_DRAG) return;
      smartHlClearPreview();
      drag.range = null;
      regionStartBox(drag);
      try { navigator.vibrate?.(8); } catch (_) { /* not everywhere */ }
    }, REGION_HOLD_FOR_BOX_MS);
  } else {
    regionStartBox(regionDrag);
  }
  // Captured so a drag that leaves the page — or leaves the window — still
  // delivers its move and its release here. Without it a marquee dragged off
  // the bottom of the scroller is never committed and never cleaned up.
  try { el.documentView?.setPointerCapture?.(event.pointerId); } catch (_) { /* a synthetic event with no id — the document listeners cover it */ }
  // A pen in contact owns the page: the pinch code and the selection
  // controller both stand down for a palm while this is set.
  if (event.pointerType === "pen") {
    setInkPenDown(true);
    regionDrag.penDown = true;
  }
  return true;
}

function releaseRegionDrag() {
  const drag = regionDrag;
  regionDrag = null;
  if (!drag) return null;
  if (drag.frame) cancelAnimationFrame(drag.frame);
  if (drag.edgeFrame) cancelAnimationFrame(drag.edgeFrame);
  if (drag.holdTimer) clearTimeout(drag.holdTimer);
  drag.box?.remove();
  smartHlClearPreview();
  if (drag.pointerId !== undefined) {
    try { el.documentView?.releasePointerCapture?.(drag.pointerId); } catch (_) { /* already gone */ }
  }
  if (drag.penDown) setInkPenDown(false);
  return drag;
}

// Every way a drag can end without being a drag the reader finished: a
// pointercancel, a lost capture, the window losing focus, the mode being
// turned off, two fingers arriving. Nothing is committed.
function cancelRegionDrag() {
  releaseRegionDrag();
}

function finishRegionDrag(event) {
  if (!regionDrag) return;
  regionDrag.last = { x: event.clientX, y: event.clientY };
  regionDrag.to = regionDrag.last;
  regionFrame();
  const drag = releaseRegionDrag();
  if (!drag) return;
  // One highlight per press of ▣: a drag the reader finished turns the mode
  // off. A box too small to keep, or a tap, made nothing and leaves it armed.
  if (drag.kind === "box") {
    if (commitRegionBox(drag)) {
      regionSwallowClickUntil = Date.now() + REGION_SWALLOW_CLICK_MS;
      setRegionSelect(false);
    }
    return;
  }
  const minimum = drag.pointerType === "touch" ? REGION_TEXT_MIN_DRAG_TOUCH : REGION_TEXT_MIN_DRAG;
  // A tap: nothing made, and the click it is about to raise goes through — on
  // a highlight that opens its menu, which is how one is reached in this mode.
  if (drag.travel < minimum) return;
  regionSwallowClickUntil = Date.now() + REGION_SWALLOW_CLICK_MS;
  commitRegionText(drag);
  setRegionSelect(false);
}

// ── Over words, a text cursor ───────────────────────────────────────────────

function paintRegionHover(event) {
  if (regionHoverFrame) return;
  const x = event.clientX;
  const y = event.clientY;
  regionHoverFrame = requestAnimationFrame(() => {
    regionHoverFrame = 0;
    if (!regionArmed || regionDrag) return;
    const pageEl = regionPageUnder(x, y);
    const page = Number(pageEl?.dataset.pageNumber) || 0;
    const onWords = Boolean(page && smartHlPageHasText(page) === true
      && smartHlCaretAt(page, x, y, { strict: true, slop: SMART_HL_PRESS_SLOP, spans: regionSpans(page) }));
    el.documentStage?.classList.toggle(REGION_TEXT_HOVER_CLASS, onWords);
  });
}

// ── Two fingers scroll ──────────────────────────────────────────────────────
//
// The scroller gives up touch-action while the mode is on (that is what makes
// one finger a highlighter), so the browser will not scroll for two fingers
// either. They move the page here, by how far their midpoint travels — until
// they spread or close, when it is a pinch and src/documents/pdf-view.js
// (initDocumentPinchZoom) owns the gesture from then on.
function regionTouchMidpoint(touches) {
  return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
}

function onRegionPanMove(event) {
  const view = el.documentView;
  if (!regionPan || !view) return;
  if (event.touches.length !== 2 || documentPinchEngaged()) { endRegionPan(); return; }
  const mid = regionTouchMidpoint(event.touches);
  view.scrollTop = regionPan.scrollTop - (mid.y - regionPan.mid.y);
  view.scrollLeft = regionPan.scrollLeft - (mid.x - regionPan.mid.x);
}

function endRegionPan() {
  regionPan = null;
  el.documentView?.removeEventListener("touchmove", onRegionPanMove);
}

export function initDocumentRegionSelect() {
  const view = el.documentView;
  if (!view) return;

  view.addEventListener("pointerdown", (event) => {
    if (!regionArmed || regionDrag) return;
    // Two fingers are a pinch or a pan, and the touch listeners below own those.
    // A secondary mouse button is a context menu.
    if (event.pointerType === "touch" && event.isPrimary === false) return;
    if (event.button !== undefined && event.button !== 0) return;
    // A press on a markdown block belongs to the block — picked up, dragged,
    // edited — exactly as it is with the mode off.
    if (event.target?.closest?.(`.${PDF_BLOCK_CLASS}`)) return;
    // The menu of the last region closes before anything is measured: it sits
    // over the highlight it belongs to, which is where a reader is likely to
    // drag next.
    closeMarkMenu();
    if (!beginRegionDrag(event)) return;
    event.preventDefault();
  });

  view.addEventListener("pointermove", (event) => {
    if (!regionDrag) {
      if (regionArmed && !event.buttons && event.pointerType !== "touch") paintRegionHover(event);
      return;
    }
    if (regionDrag.pointerId !== undefined && event.pointerId !== regionDrag.pointerId) return;
    event.preventDefault();
    const drag = regionDrag;
    drag.last = { x: event.clientX, y: event.clientY };
    drag.to = drag.last;
    const moved = Math.hypot(drag.last.x - (drag.pageEl.getBoundingClientRect().left + drag.from.x),
      drag.last.y - (drag.pageEl.getBoundingClientRect().top + drag.from.y));
    drag.travel = Math.max(drag.travel, moved);
    if (drag.holdTimer && drag.travel >= REGION_TEXT_MIN_DRAG) {
      clearTimeout(drag.holdTimer);
      drag.holdTimer = 0;
    }
    scheduleRegionFrame();
    if (!drag.edgeFrame) drag.edgeFrame = requestAnimationFrame(regionEdgeStep);
  });

  view.addEventListener("pointerup", (event) => {
    if (!regionDrag) return;
    if (regionDrag.pointerId !== undefined && event.pointerId !== regionDrag.pointerId) return;
    finishRegionDrag(event);
  });
  view.addEventListener("pointercancel", (event) => {
    if (!regionDrag) return;
    if (regionDrag.pointerId !== undefined && event.pointerId !== regionDrag.pointerId) return;
    cancelRegionDrag();
  });
  view.addEventListener("lostpointercapture", (event) => {
    if (!regionDrag || event.pointerId !== regionDrag.pointerId) return;
    // A capture lost mid-drag (the page torn down under it by a relayout) is a
    // drag that cannot finish; the release that normally follows a capture's
    // end has already been handled by pointerup above.
    cancelRegionDrag();
  });
  window.addEventListener("blur", () => { if (regionDrag) cancelRegionDrag(); });

  // The click a drag leaves behind — see REGION_SWALLOW_CLICK_MS. Capture, and
  // immediate, so neither the highlight menu's own click listener on this
  // element nor anything under it sees it.
  view.addEventListener("click", (event) => {
    if (Date.now() >= regionSwallowClickUntil) return;
    regionSwallowClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  view.addEventListener("touchstart", (event) => {
    if (!regionArmed || event.touches.length !== 2 || inkPenIsDown()) return;
    // The first finger had started a drag; the second says it was a scroll.
    cancelRegionDrag();
    regionPan = {
      mid: regionTouchMidpoint(event.touches),
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft
    };
    view.addEventListener("touchmove", onRegionPanMove, { passive: true });
  }, { passive: true });
  const onRegionTouchEnd = (event) => {
    if (regionPan && event.touches.length < 2) endRegionPan();
  };
  view.addEventListener("touchend", onRegionTouchEnd, { passive: true });
  view.addEventListener("touchcancel", onRegionTouchEnd, { passive: true });

  // Escape gets out, whether or not a drag is half-made. Registered on the
  // document rather than the view because the view is not focusable, so it
  // never has the key.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !regionArmed) return;
    // Only when this mode is the thing Escape most obviously means. A live drag
    // is unambiguous; without one, the mark menu and the note editor are both
    // closer to the reader's hand and both take Escape themselves.
    if (!regionDrag && document.querySelector(".mark-menu:not([hidden]), .highlight-note-editor:not([hidden])")) return;
    event.preventDefault();
    setRegionSelect(false);
  });
}
