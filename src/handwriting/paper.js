// A stack of pages you can write on, and the engine over it.
//
// The one piece of machinery the drawing sheet and the notebook actually share.
// Both are a scroller of A4-shaped pages with one ink host each; what differs is
// where the pages come from and what happens to them afterwards, and neither of
// those is in here.
//
// ── Why the page is scaled and the strokes are not ─────────────────────────
//
// The engine is handed a MATRIX per host, and it maps model coordinates onto
// that host. So a page is laid out at whatever size the screen has room for and
// the matrix is a plain scale — which means the strokes stored are in the page's
// own 794x1123 units on every device, at every zoom, in either orientation. The
// same decision pdf-ink.js makes when it stores in PDF user space, for the same
// reason: a coordinate that only works on the device that made it is a
// coordinate that has to be re-guessed on the next one.
//
// This is also the whole of the fix for the sheet's old faults. It drew in the
// CSS pixels of whatever box it was laid out at, so a drawing made on a phone
// re-opened tiny on a laptop, a window resized mid-drawing left the ink where
// the pixels had been, and a drawing bigger than the current box was silently
// cut off by `overflow: hidden` — there was nothing else that could be done
// with it.

import { HW_PAGE_HEIGHT, HW_PAGE_WIDTH, handwritingPageStrokes } from "./pages.js?v=__BUILD__";
import { createInkEngine } from "../render/ink-engine.js?v=__BUILD__";

// How large a page is allowed to get relative to its own units. A page fills the
// width it is given, but on a wide desktop "the width" is 1400px of A4, which is
// a page nobody is writing on with a mouse. Past this the page is centred in the
// space instead.
const HW_MAX_FIT = 1.25;
// ...and the range the reader's own zoom can take it to from there.
export const HW_ZOOM_MIN = 0.5;
export const HW_ZOOM_MAX = 3;
export const HW_ZOOM_STEP = 1.25;

export function handwritingPageElement(scroller, id) {
  return scroller?.querySelector(`.hw-page[data-hw-page="${id}"]`) || null;
}

// One page's box. The ink host is a child rather than the page itself so the
// paper's own background (the grid, the rule) is painted under the canvases
// rather than by them — a canvas would have to redraw it on every repaint and at
// device resolution.
function pageControlButton(action, label, glyph, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `hw-page-btn${danger ? " is-danger" : ""}`;
  button.dataset.hwPageAction = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = glyph;
  return button;
}

// `controls` is false for the drawing sheet and true for the notebook, and the
// difference is not cosmetic: a sheet's pages are transient — they exist to be
// drawn on and then become pictures in a note — so there is nothing to reorder
// and "tear out page 2" means nothing when the whole stack is discarded on
// Cancel. A notebook's pages are the document.
function buildPageElement(page, controls) {
  const el = document.createElement("div");
  el.className = "hw-page";
  el.dataset.hwPage = page.id;
  el.dataset.hwPaper = page.paper;
  const ink = document.createElement("div");
  ink.className = "hw-page-ink";
  const number = document.createElement("span");
  number.className = "hw-page-number";
  number.setAttribute("aria-hidden", "true");
  el.append(ink, number);
  if (controls) {
    const bar = document.createElement("div");
    bar.className = "hw-page-controls";
    bar.append(
      pageControlButton("up", "Move this page up", "&#8593;"),
      pageControlButton("down", "Move this page down", "&#8595;"),
      pageControlButton("delete", "Tear out this page", "&#128465;", true)
    );
    el.appendChild(bar);
  }
  return el;
}

export function createHandwritingPaper({
  scroller,
  getPages,
  onCommit = () => {},
  onSelectionChange = () => {},
  onToolChange = () => {},
  pageControls = false
}) {
  let zoom = 1;
  let scale = 1;
  // Measured when the layout changes rather than per sample, which is the rule
  // every pointer path in this app keeps: a getBoundingClientRect inside a
  // pointermove is a forced layout at digitiser rate.
  const rects = new Map();

  function measure() {
    if (!scroller) return;
    const style = getComputedStyle(scroller);
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const room = Math.max(80, scroller.clientWidth - pad);
    scale = Math.min(HW_MAX_FIT, room / HW_PAGE_WIDTH) * zoom;
  }

  function applySize() {
    getPages().forEach((page) => {
      const el = handwritingPageElement(scroller, page.id);
      if (!el) return;
      el.style.width = `${Math.round((page.w || HW_PAGE_WIDTH) * scale)}px`;
      el.style.height = `${Math.round((page.h || HW_PAGE_HEIGHT) * scale)}px`;
      // The paper's own rules are drawn in CSS at model pitch times the scale,
      // so a grid stays a grid rather than becoming a different grid at each
      // zoom step.
      el.style.setProperty("--hw-scale", String(scale));
    });
    cacheRects();
  }

  function cacheRects() {
    rects.clear();
    getPages().forEach((page) => {
      const el = handwritingPageElement(scroller, page.id);
      if (el) rects.set(page.id, el.getBoundingClientRect());
    });
  }

  const inkEngine = createInkEngine({
    getMatrix: () => [scale, 0, 0, scale, 0, 0],
    getHostSize: (id) => {
      const page = getPages().find((p) => p.id === id);
      if (!page) return null;
      return { width: (page.w || HW_PAGE_WIDTH) * scale, height: (page.h || HW_PAGE_HEIGHT) * scale };
    },
    toModel: (id, clientX, clientY) => {
      const rect = rects.get(id);
      if (!rect || !scale) return null;
      return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    },
    onCommit: (id, strokes, meta) => onCommit(id, strokes, meta),
    onSelectionChange,
    onToolChange,
    className: "hw-page-canvas"
  });

  // Rebuild the scroller to match the pages, keeping the elements that are
  // already right. A wholesale innerHTML rebuild would take every canvas with it
  // and make adding a page cost a re-decode of the whole notebook.
  function render() {
    if (!scroller) return;
    const pages = getPages();
    const wanted = new Set(pages.map((page) => page.id));
    [...scroller.querySelectorAll(".hw-page")].forEach((el) => {
      if (!wanted.has(el.dataset.hwPage)) {
        // Forgotten rather than detached: a page that is no longer in the stack
        // has been deleted or belongs to a sheet that has closed, and neither is
        // coming back to want its ink again.
        inkEngine.forgetHost(el.dataset.hwPage);
        el.remove();
      }
    });
    let previous = null;
    pages.forEach((page, index) => {
      let el = handwritingPageElement(scroller, page.id);
      if (!el) {
        el = buildPageElement(page, pageControls);
        scroller.insertBefore(el, previous ? previous.nextSibling : scroller.firstChild);
      } else if (previous ? el.previousElementSibling !== previous : el !== scroller.firstChild) {
        scroller.insertBefore(el, previous ? previous.nextSibling : scroller.firstChild);
      }
      el.dataset.hwPaper = page.paper;
      el.querySelector(".hw-page-number").textContent = String(index + 1);
      previous = el;
    });
    measure();
    applySize();
    pages.forEach((page) => {
      const el = handwritingPageElement(scroller, page.id);
      const host = el?.querySelector(".hw-page-ink");
      if (!host) return;
      const had = inkEngine.attachHost(page.id, host);
      // Seeded from the record only when the engine is not already holding this
      // page's ink. The strokes in hand are the ones the nib actually reported;
      // re-reading them from the encoding would replace what is on screen with
      // its own simplified round trip every time a page was added elsewhere in
      // the stack.
      if (!had?.strokes?.length) inkEngine.setStrokes(page.id, handwritingPageStrokes(page));
    });
    cacheRects();
  }

  function relayout() {
    measure();
    applySize();
    inkEngine.repaintAll();
  }

  // Force every page's ink back to what its record says, discarding whatever the
  // engine happens to be holding. render() deliberately does NOT do this — see
  // the comment there — so this is the call for the two moments when the records
  // are the truth and the engine is not: opening a notebook, and a sync pull
  // landing under one that is already open.
  function seed() {
    getPages().forEach((page) => inkEngine.setStrokes(page.id, handwritingPageStrokes(page)));
  }

  return {
    engine: inkEngine,
    render,
    relayout,
    seed,
    cacheRects,
    pageElement: (id) => handwritingPageElement(scroller, id),
    // Which page a point is over — the notebook needs it to know where a text
    // box was dropped, and both surfaces need it to know which page a stroke
    // began on.
    pageAt: (clientX, clientY) => {
      for (const [id, rect] of rects) {
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return id;
      }
      return null;
    },
    toModel: (id, clientX, clientY) => {
      const rect = rects.get(id);
      if (!rect || !scale) return null;
      return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    },
    scale: () => scale,
    zoom: () => zoom,
    setZoom: (next) => {
      const clamped = Math.max(HW_ZOOM_MIN, Math.min(HW_ZOOM_MAX, next));
      if (clamped === zoom) return false;
      zoom = clamped;
      relayout();
      return true;
    },
    destroy: () => { inkEngine.destroy(); rects.clear(); }
  };
}
