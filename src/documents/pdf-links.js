// The links inside a PDF: a "see §3", a citation number, the paper's own
// printed contents, a DOI, a URL in a footnote.
//
// A page here is a canvas (or a kept picture) under a text layer this app builds
// by hand (buildTextLayer in pdf-view.js), and nothing read the page's link
// annotations — so every link in every paper was flat paint. Pressing a
// citation did nothing; pressing a URL did nothing.
//
// ── Why there is no layer of <a> elements ──────────────────────────────────
//
// pdf.js's own viewer puts an absolutely-positioned <a> over every link. Here
// that would sit on top of the text layer, and a link's words are exactly the
// words a reader wants to select and highlight — a reference, a section
// title. An <a> over them means a drag that starts on one is a link drag, the
// touch selection controller's long-press hit-tests the anchor instead of the
// span under it, and the region, pen-text and ink tools would each need a rule
// to stand it down. So the links are kept as rectangles in PDF user space and
// a press is hit-tested against them AFTER everything else on the page has had
// its say (a click on the stage, in the bubble phase, that nothing has
// prevented). Text selection, highlights, the pen and the region tool keep
// working exactly as they did, and a plain click on a link follows it.
//
// The rectangles are in PDF space, so a zoom moves nothing: the click is
// converted through the page's live viewport at the moment it happens.

import { el } from "../core/dom.js?v=__BUILD__";
import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import { resolvePdfDestination } from "./pdf-dest.js?v=__BUILD__";
import {
  currentDocumentPage,
  currentDocumentResidual,
  currentPdfDocument,
  isDocumentViewActive,
  openDocumentSlot,
  pdfPageViewport,
  scrollToDocumentPage
} from "./pdf-view.js?v=__BUILD__";

// Web links are opened; anything else a PDF can carry as a URI (javascript:,
// file:, a launch of another program) is not.
const SAFE_URL = /^(https?:|mailto:)/i;

// How long the "back" chip stays after a jump. Long enough to read the
// reference that was jumped to; not so long it is still there an hour later.
export const LINK_BACK_MS = 20000;

// A link's rectangle is grown by this much (PDF points) for the hit-test: link
// boxes are drawn tight round a superscript citation number, which is a few
// points wide, and a fingertip is not.
const LINK_SLOP = 1.5;

// Per document, per page: a promise of the page's links. Keyed by the pdf.js
// document object, so a different PDF (or the same one reopened) starts clean
// and an old one's cache goes with it.
const linkCache = new WeakMap();

function pageLinksFor(doc) {
  let pages = linkCache.get(doc);
  if (!pages) {
    pages = new Map();
    linkCache.set(doc, pages);
  }
  return pages;
}

// One annotation → what this module keeps of it, or null for anything that is
// not a link we can follow.
export function linkFromAnnotation(annotation) {
  if (!annotation || annotation.subtype !== "Link") return null;
  const rect = annotation.rect;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const box = [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3])
  ];
  // pdf.js puts a URL it judged safe in `url` and the raw one in `unsafeUrl`;
  // the raw one is still worth reading for a relative link, and the scheme test
  // below is what decides.
  const url = annotation.url || annotation.unsafeUrl || "";
  if (url) return SAFE_URL.test(url) ? { box, url } : null;
  if (annotation.dest) return { box, dest: annotation.dest };
  if (annotation.action) return { box, action: annotation.action };
  return null;
}

// The links on one page, fetched once per document. Called from the page-painted
// hook in src/main.js so they are in hand before anything is pressed — a web
// link has to be opened inside the click's user activation, and a fetch inside
// the click would spend some of it.
export function documentPageLinks(pageNumber, doc = currentPdfDocument()) {
  if (!doc || !pageNumber) return Promise.resolve([]);
  const pages = pageLinksFor(doc);
  let slot = pages.get(pageNumber);
  if (!slot) {
    // `ready` is the answer once it is in, for the synchronous readers below.
    slot = { ready: null, promise: null };
    slot.promise = doc.getPage(pageNumber)
      .then((page) => page.getAnnotations({ intent: "display" }))
      .then((annotations) => (annotations || []).map(linkFromAnnotation).filter(Boolean))
      .catch(() => [])
      .then((list) => (slot.ready = list));
    pages.set(pageNumber, slot);
  }
  return slot.promise;
}

export function prefetchDocumentPageLinks(pageNumber) {
  if (openDocumentSlot() !== DOC_SLOT_DOC) return;
  documentPageLinks(pageNumber);
}

// The page under a point, and the point in that page's PDF user space.
function pagePointAt(target, clientX, clientY) {
  const pageEl = target?.closest?.(".pdf-page[data-page-number]");
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page) return null;
  const viewport = pdfPageViewport(page);
  const box = pageEl.getBoundingClientRect();
  if (!viewport || !box.width || !box.height) return null;
  // Through the box's own size rather than the viewport's: mid-zoom the box is
  // already the new size while the viewport is still the old scale.
  const x = (clientX - box.left) * (viewport.width / box.width);
  const y = (clientY - box.top) * (viewport.height / box.height);
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { page, x: px, y: py };
}

export function linkAtPoint(links, x, y) {
  if (!links?.length) return null;
  // Last first: a link drawn later sits on top, as it does on paper.
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const [x1, y1, x2, y2] = links[index].box;
    if (x >= x1 - LINK_SLOP && x <= x2 + LINK_SLOP && y >= y1 - LINK_SLOP && y <= y2 + LINK_SLOP) return links[index];
  }
  return null;
}

// The link under a pointer, from what is already fetched — synchronous, so it
// can answer inside a click or a pointermove.
function readyLinkAt(target, clientX, clientY) {
  const doc = currentPdfDocument();
  if (!doc) return null;
  const point = pagePointAt(target, clientX, clientY);
  if (!point) return null;
  const links = pageLinksFor(doc).get(point.page)?.ready;
  const link = linkAtPoint(links, point.x, point.y);
  return link ? { link, page: point.page } : null;
}

// Is something else using the press? The tools that own a press stop or
// prevent its click themselves; these are the ones that own a mode.
function linksStandDown(event) {
  if (openDocumentSlot() !== DOC_SLOT_DOC) return true;
  const stage = el.documentStage;
  if (stage?.classList.contains("is-region-select") || stage?.classList.contains("is-pen-text")) return true;
  if (event.target?.closest?.(".pdf-block, .pdf-badge-layer > *, button, a, input, textarea, select, [contenteditable='true']")) return true;
  // A drag that selected words ends in a click too; that click is the end of a
  // selection, not a press on a link.
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed && String(selection).trim()) return true;
  return false;
}

// ── Going there, and coming back ───────────────────────────────────────────

let backTo = null;
let backTimer = 0;

function hideBackChip() {
  backTo = null;
  clearTimeout(backTimer);
  backTimer = 0;
  const button = document.getElementById("documentLinkBackBtn");
  if (button) button.hidden = true;
}

function showBackChip(from) {
  const button = document.getElementById("documentLinkBackBtn");
  backTo = from;
  clearTimeout(backTimer);
  backTimer = setTimeout(hideBackChip, LINK_BACK_MS);
  if (!button) return;
  button.textContent = `↩ p. ${from.page}`;
  button.title = `Back to page ${from.page} (Alt+←)`;
  button.setAttribute("aria-label", `Back to page ${from.page}`);
  button.hidden = false;
}

export function goBackFromLink() {
  const from = backTo;
  hideBackChip();
  if (!from || from.doc !== currentPdfDocument()) return false;
  return scrollToDocumentPage(from.page, from.ratio);
}

// Jump to a place in the open PDF, leaving a way back to where the reader was.
export function jumpWithinDocument(page, ratio = 0) {
  const doc = currentPdfDocument();
  if (!doc || !page) return false;
  const from = { doc, page: currentDocumentPage(), ratio: currentDocumentResidual() };
  const moved = scrollToDocumentPage(page, ratio);
  if (moved && from.page && from.page !== page) showBackChip(from);
  return moved;
}

async function followLink(link, fromPage) {
  const doc = currentPdfDocument();
  if (!doc) return;
  if (link.url) {
    window.open(link.url, "_blank", "noopener,noreferrer");
    return;
  }
  if (link.action) {
    const count = doc.numPages;
    const target = {
      NextPage: Math.min(count, fromPage + 1),
      PrevPage: Math.max(1, fromPage - 1),
      FirstPage: 1,
      LastPage: count
    }[link.action];
    if (link.action === "GoBack") goBackFromLink();
    else if (target) jumpWithinDocument(target, 0);
    return;
  }
  const { page, ratio } = await resolvePdfDestination(doc, link.dest, pdfPageViewport);
  // The document changed while the destination was being looked up.
  if (doc !== currentPdfDocument() || !page) return;
  jumpWithinDocument(page, ratio);
}

function onStageClick(event) {
  if (event.defaultPrevented || event.button > 0) return;
  if (!event.target?.closest?.(".pdf-page")) return;
  if (linksStandDown(event)) return;
  const hit = readyLinkAt(event.target, event.clientX, event.clientY);
  if (!hit) return;
  event.preventDefault();
  followLink(hit.link, hit.page);
}

// ── The pointer says it is a link ──────────────────────────────────────────
//
// A mouse only: a hover has no meaning for a finger or a pen. One hit-test per
// frame at most, against links already fetched.
let hoverFrame = 0;
let hoverEvent = null;
let hoverTitled = false;

function paintHover() {
  hoverFrame = 0;
  const event = hoverEvent;
  hoverEvent = null;
  const view = el.documentView;
  if (!view || !event) return;
  const hit = linksStandDown(event) ? null : readyLinkAt(event.target, event.clientX, event.clientY);
  view.classList.toggle("is-over-pdf-link", Boolean(hit));
  if (hit) {
    view.title = hit.link.url || "Go to the linked place in this PDF";
    hoverTitled = true;
  } else if (hoverTitled) {
    view.removeAttribute("title");
    hoverTitled = false;
  }
}

function onViewPointerMove(event) {
  if (event.pointerType !== "mouse" || event.buttons) return;
  hoverEvent = event;
  if (!hoverFrame) hoverFrame = requestAnimationFrame(paintHover);
}

function onViewPointerLeave() {
  hoverEvent = null;
  el.documentView?.classList.remove("is-over-pdf-link");
  if (hoverTitled) el.documentView?.removeAttribute("title");
  hoverTitled = false;
}

function linkKeyInField(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

export function initDocumentLinks() {
  el.documentStage?.addEventListener("click", onStageClick);
  el.documentView?.addEventListener("pointermove", onViewPointerMove, { passive: true });
  el.documentView?.addEventListener("pointerleave", onViewPointerLeave);
  document.getElementById("documentLinkBackBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    goBackFromLink();
  });
  document.addEventListener("keydown", (event) => {
    if (!backTo || !event.altKey || event.key !== "ArrowLeft") return;
    if (!isDocumentViewActive() || linkKeyInField(event.target)) return;
    event.preventDefault();
    goBackFromLink();
  });
}

// A new document: the way back belonged to the old one. The link cache is
// keyed by document already, and pages of this one may have been fetched
// before this runs, so it is left alone.
export function resetDocumentLinks() {
  hideBackChip();
  onViewPointerLeave();
}
