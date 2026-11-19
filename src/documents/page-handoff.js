// Carrying something from one page onto another.
//
// A Block, a Picture, a Shapes-tool shape and several things picked up together
// used to be held to the page they were pressed on: the drag stopped at the
// page's edge, and the only way onto the next page was Copy, then Paste blocks.
// Now the page a drag is over is the page it drops on. Each drag module
// (src/documents/pdf-blocks.js, pdf-shapes.js, canvas-selection.js) asks the
// same three things on every move, and they are here so the three agree:
//
//   which page is the pointer over       pageUnderPointer
//   where is it, in that page's points   pointOnPage
//   where is a point of one page, in     mapPointBetweenPages — what is being
//   another page's points                carried is still drawn on the page it
//                                        came from until it is let go
//
// A carried thing keeps its offset from the pointer: its place on the page it
// is over is the pointer's point there, less where on the thing it was
// pressed. That is worked out from the pages as they are now, not from how far
// the pointer has travelled on the screen, so the view can scroll mid-drag —
// by a mouse wheel, or by edgeScroller below near the top or bottom of the
// view, which is how a finger reaches a page that is not in view.

import { el } from "../core/dom.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

// A point on the screen, in one page's own points. Null for a page not laid
// out.
export function pointOnPage(page, clientX, clientY) {
  const pageEl = pdfPageElement(page);
  const viewport = pdfPageViewport(page);
  if (!pageEl || !viewport) return null;
  const box = pageEl.getBoundingClientRect();
  return viewport.convertToPdfPoint(clientX - box.left, clientY - box.top);
}

// A point of page `from`, in page `to`'s points — through the screen, so it is
// right whatever the two pages' sizes, origins and gap.
export function mapPointBetweenPages(from, to, point) {
  if (Number(from) === Number(to)) return point;
  const fromEl = pdfPageElement(from);
  const fromViewport = pdfPageViewport(from);
  if (!fromEl || !fromViewport) return point;
  const [vx, vy] = fromViewport.convertToViewportPoint(point[0], point[1]);
  const box = fromEl.getBoundingClientRect();
  return pointOnPage(to, box.left + vx, box.top + vy) || point;
}

// The page under the pointer, among the pages beside `fromPage` (the same
// stage: side by side, the PDFs and the Canvas are two lists of pages, and a
// drag never leaves the part it began in). A page counts when the pointer is
// level with it, so a drag past its left or right edge still means that page
// (and is held to it by the drag's own clamp). In the gap between two pages,
// above the first or below the last, or over a page not laid out yet, it is
// still `current`.
export function pageUnderPointer(fromPage, clientX, clientY, current = fromPage) {
  const home = pdfPageElement(fromPage);
  const list = home?.parentElement;
  if (!list) return current;
  let best = null;
  let bestDistance = Infinity;
  for (const pageEl of list.querySelectorAll(":scope > .pdf-page[data-page-number]")) {
    const page = Number(pageEl.dataset.pageNumber);
    if (!page || pdfPageElement(page) !== pageEl || !pdfPageViewport(page)) continue;
    const box = pageEl.getBoundingClientRect();
    if (!box.height || clientY < box.top || clientY > box.bottom) continue;
    if (clientX >= box.left && clientX <= box.right) return page;
    // Level with it, beside it: the nearest across.
    const distance = clientX < box.left ? box.left - clientX : clientX - box.right;
    if (distance < bestDistance) { best = page; bestDistance = distance; }
  }
  return best || current;
}

// The page a carried thing came from is drawn over the pages after it while
// the thing is past its edge — a page later in the list would otherwise paint
// its paper over the part of the Block that is over it.
export const CARRYING_CLASS = "is-carrying";

export function setCarrying(page, on) {
  const pageEl = pdfPageElement(page);
  if (on) pageEl?.classList.add(CARRYING_CLASS);
  else (el.documentView?.ownerDocument || document).querySelectorAll(`.pdf-page.${CARRYING_CLASS}`).forEach((node) => node.classList.remove(CARRYING_CLASS));
}

// ── Scrolling the view while something is carried to its edge ─────────────
//
// A finger carrying a Block cannot scroll: the drag has its pointer. Held in
// the band along the top or bottom of the view, the view scrolls by itself —
// faster the nearer the edge — and the drag is told (`onScrolled`, with the
// last move it saw) so what is carried stays under the pointer.
//
// Only once the pointer has been out of the band since the drag began: a
// Block pressed in the band — at the foot of the view, say — and nudged where
// it is would otherwise set the pages running under it and be carried pages
// away. It is going to the edge that asks for the scroll.
export const EDGE_SCROLL_BAND_PX = 44;
export const EDGE_SCROLL_MAX_PX = 18;

export function edgeScroller(fromPage, onScrolled) {
  let raf = 0;
  let last = null;
  let scrollArmed = false;
  const scroller = () => pdfPageElement(fromPage)?.closest(".document-scroll") || el.documentView || null;
  const inBand = (y, rect) => y < rect.top + EDGE_SCROLL_BAND_PX || y > rect.bottom - EDGE_SCROLL_BAND_PX;
  const tick = () => {
    raf = 0;
    const scroll = scroller();
    if (!last || !scroll || !scrollArmed) return;
    const rect = scroll.getBoundingClientRect();
    const y = last.clientY;
    let speed = 0;
    if (y < rect.top + EDGE_SCROLL_BAND_PX) {
      speed = -Math.ceil(EDGE_SCROLL_MAX_PX * Math.min(1, (rect.top + EDGE_SCROLL_BAND_PX - y) / EDGE_SCROLL_BAND_PX));
    } else if (y > rect.bottom - EDGE_SCROLL_BAND_PX) {
      speed = Math.ceil(EDGE_SCROLL_MAX_PX * Math.min(1, (y - (rect.bottom - EDGE_SCROLL_BAND_PX)) / EDGE_SCROLL_BAND_PX));
    }
    if (!speed) return;
    const was = scroll.scrollTop;
    scroll.scrollTop = was + speed;
    if (scroll.scrollTop === was) return;
    onScrolled(last);
    raf = requestAnimationFrame(tick);
  };
  return {
    // Every move of the drag: where the pointer is now.
    update(event) {
      last = event;
      const scroll = scroller();
      if (!scrollArmed && scroll && !inBand(event.clientY, scroll.getBoundingClientRect())) scrollArmed = true;
      if (scrollArmed && !raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      last = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
