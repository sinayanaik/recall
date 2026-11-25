// The ☰ drawer's Pages tab, on the Canvas: every page as a small picture, two
// to a row, the page in view lit. Press one to go to it.
//
// The drawer's first tab lists a PDF's contents. A Canvas has none to list —
// its pages are drawn, not typed, so there are no headings to read — and the
// tab used to be empty there every time. On the Canvas it is Pages instead
// (pdf-outline.js names the tab and calls in here through
// setCanvasOutlineHooks), and the Highlights tab beside it is unchanged.
//
// The pictures are the Pages panel's (src/documents/canvas-page-thumbs.js):
// one cache, so a page drawn for either is on screen in both. Only pages
// scrolled into the drawer are drawn, and only while it is open on this tab.
// Picking, moving and exporting pages stay in the Pages panel; this is for
// seeing the Canvas at a glance and going somewhere in it.

import { el } from "../core/dom.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { documentPageInFocus, scrollToDocumentPage } from "./pdf-view.js?v=__BUILD__";
import { closeDocumentToc, setCanvasOutlineHooks } from "./pdf-outline.js?v=__BUILD__";
import { canvasThumbAspect, canvasThumbFileKey, canvasThumbHeld, copyCanvasThumb, dropCanvasThumbRequests, wantCanvasThumb } from "./canvas-page-thumbs.js?v=__BUILD__";
import { hasNotebook, notebookPageCount } from "./notebook.js?v=__BUILD__";

// Who the drawer's requests for pictures are from (canvas-page-thumbs.js).
const DRAWER_PAGES_THUMB_OWNER = "drawer-pages";
// How often an open drawer looks for pages whose things changed, or a page
// added or deleted while it was open.
const DRAWER_PAGES_WATCH_MS = 1500;
// How far past the drawer's edge a page is drawn ahead of being scrolled to.
const DRAWER_PAGES_MARGIN = 240;

let cdpGrid = null;
let cdpObserver = null;
let cdpTotal = -1;
let cdpFile = "";
let cdpCurrent = 0;
let cdpWatchTimer = 0;

function cdpOnCanvas() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK && hasNotebook();
}

function cdpScroller() {
  return cdpGrid?.parentElement || null;
}

// Open, on the Canvas, with the Pages tab showing.
function cdpShowing() {
  const drawer = el.documentOutlineDrawer;
  const scroll = cdpScroller();
  return Boolean(drawer?.classList.contains("is-open") && cdpGrid && !cdpGrid.hidden && scroll && !scroll.hidden);
}

function cdpItemOf(page) {
  return cdpGrid?.querySelector(`.cdp-item[data-page="${page}"]`) || null;
}

function cdpEnsureGrid() {
  if (cdpGrid) return cdpGrid;
  const list = el.documentOutlineList;
  const scroll = list?.parentElement;
  if (!list || !scroll) return null;
  cdpGrid = document.createElement("div");
  cdpGrid.className = "canvas-drawer-pages";
  cdpGrid.setAttribute("role", "group");
  cdpGrid.setAttribute("aria-label", "Canvas pages — press one to go to it");
  cdpGrid.hidden = true;
  list.after(cdpGrid);
  cdpGrid.addEventListener("click", (event) => {
    const item = event.target.closest(".cdp-item");
    if (!item) return;
    event.preventDefault();
    cdpGoTo(Number(item.dataset.page));
  });
  cdpGrid.addEventListener("keydown", cdpOnKey);
  cdpObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      if (!cdpShowing()) return;
      entries.forEach((entry) => {
        if (entry.isIntersecting) cdpWantThumb(Number(entry.target.dataset.page));
      });
    }, { root: scroll, rootMargin: `${DRAWER_PAGES_MARGIN}px 0px` })
    : null;
  return cdpGrid;
}

function cdpBuild() {
  const total = notebookPageCount();
  cdpObserver?.disconnect();
  cdpGrid.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let page = 1; page <= total; page += 1) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cdp-item";
    item.dataset.page = String(page);
    item.title = `Page ${page}`;
    item.setAttribute("aria-label", `Page ${page} of ${total}`);
    const frame = document.createElement("span");
    frame.className = "cdp-thumb";
    frame.style.aspectRatio = canvasThumbAspect(page);
    const held = canvasThumbHeld(page);
    if (held) frame.append(copyCanvasThumb(held));
    const num = document.createElement("span");
    num.className = "cdp-num";
    num.textContent = String(page);
    item.append(frame, num);
    frag.append(item);
  }
  cdpGrid.append(frag);
  cdpGrid.querySelectorAll(".cdp-item").forEach((item) => cdpObserver?.observe(item));
  cdpTotal = total;
  cdpFile = canvasThumbFileKey();
  cdpCurrent = 0;
  cdpPaintCurrent(documentPageInFocus() || 1);
}

function cdpPaintCurrent(page) {
  const next = Number(page) || 0;
  if (!cdpGrid || next === cdpCurrent) return;
  cdpItemOf(cdpCurrent)?.classList.remove("is-current");
  cdpItemOf(cdpCurrent)?.removeAttribute("aria-current");
  cdpCurrent = next;
  const item = cdpItemOf(next);
  if (!item) return;
  item.classList.add("is-current");
  item.setAttribute("aria-current", "page");
}

function cdpRevealCurrent() {
  const item = cdpItemOf(cdpCurrent);
  const scroll = cdpScroller();
  if (!item || !scroll) return;
  const top = item.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  const bottom = top + item.offsetHeight;
  if (top < scroll.scrollTop || bottom > scroll.scrollTop + scroll.clientHeight) {
    scroll.scrollTop = Math.max(0, top - (scroll.clientHeight - item.offsetHeight) / 2);
  }
}

function cdpWantThumb(page) {
  if (!page) return;
  wantCanvasThumb(page, DRAWER_PAGES_THUMB_OWNER, (drawn, canvas) => {
    const frame = cdpItemOf(drawn)?.querySelector(".cdp-thumb");
    if (frame) frame.replaceChildren(copyCanvasThumb(canvas));
  });
}

function cdpVisiblePages() {
  const scroll = cdpScroller();
  if (!scroll || !cdpGrid) return [];
  const box = scroll.getBoundingClientRect();
  const top = box.top - DRAWER_PAGES_MARGIN;
  const bottom = box.bottom + DRAWER_PAGES_MARGIN;
  return [...cdpGrid.querySelectorAll(".cdp-item")]
    .filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.bottom >= top && rect.top <= bottom;
    })
    .map((item) => Number(item.dataset.page));
}

// Brings the grid up to date with the Canvas: rebuilt for another file or
// another number of pages, the page in view lit, and the pictures in view
// asked for again (each is drawn only if its page changed).
function cdpSync() {
  if (!cdpEnsureGrid()) return;
  const onCanvas = cdpOnCanvas();
  cdpGrid.hidden = !onCanvas;
  if (!onCanvas) {
    dropCanvasThumbRequests(DRAWER_PAGES_THUMB_OWNER);
    return;
  }
  if (cdpFile !== canvasThumbFileKey() || cdpTotal !== notebookPageCount()) cdpBuild();
  else cdpPaintCurrent(documentPageInFocus() || 1);
  if (cdpShowing()) cdpVisiblePages().forEach(cdpWantThumb);
}

function cdpWatch() {
  clearTimeout(cdpWatchTimer);
  cdpWatchTimer = 0;
  if (!el.documentOutlineDrawer?.classList.contains("is-open")) return;
  if (document.visibilityState !== "hidden") cdpSync();
  cdpWatchTimer = setTimeout(cdpWatch, DRAWER_PAGES_WATCH_MS);
}

function cdpGoTo(page) {
  if (!page) return;
  scrollToDocumentPage(page, 0);
  // The drawer covers the page it just took you to (see goToOutlineEntry in
  // src/main.js), so it closes, as a Contents row does.
  closeDocumentToc();
}

// Arrows move between pages — across a row with ← →, down a column with ↑ ↓ —
// and Home / End go to the first and last. Enter and Space are the button's own.
function cdpOnKey(event) {
  const item = event.target.closest?.(".cdp-item");
  if (!item) return;
  const items = [...cdpGrid.querySelectorAll(".cdp-item")];
  const at = items.indexOf(item);
  const columns = Math.max(1, items.filter((other) => other.offsetTop === items[0].offsetTop).length);
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  let next = -1;
  if (event.key in steps) next = at + steps[event.key];
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  const target = items[Math.min(items.length - 1, Math.max(0, next))];
  target?.focus();
  target?.scrollIntoView({ block: "nearest" });
}

export function initCanvasDrawerPages() {
  if (cdpGrid) return;
  setCanvasOutlineHooks({
    render: () => {
      cdpSync();
    },
    setPage: (page) => {
      if (cdpGrid && !cdpGrid.hidden) cdpPaintCurrent(page);
    },
    opened: () => {
      cdpSync();
      if (cdpGrid && !cdpGrid.hidden) {
        cdpPaintCurrent(documentPageInFocus() || 1);
        cdpRevealCurrent();
      }
      cdpWatch();
    },
    closed: () => {
      clearTimeout(cdpWatchTimer);
      cdpWatchTimer = 0;
      dropCanvasThumbRequests(DRAWER_PAGES_THUMB_OWNER);
    }
  });
  // The Pages tab, chosen while the drawer is open: the pictures in view now.
  el.documentOutlineDrawer?.addEventListener("click", (event) => {
    if (!event.target.closest?.('[data-drawer-tab="contents"]')) return;
    requestAnimationFrame(() => {
      if (!cdpShowing()) return;
      cdpRevealCurrent();
      cdpVisiblePages().forEach(cdpWantThumb);
    });
  });
  cdpEnsureGrid();
  cdpSync();
}
