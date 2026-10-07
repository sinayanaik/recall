// "Adjust" on a paper: the same grips as a note's (src/ui/adjust-handles.js),
// on a highlight of WORDS in a PDF.
//
// A note's Adjust rewrites <mark> tags in markdown; a paper's highlight is a
// record — anchors into the text layer and the quads painted from them
// (src/documents/pdf-highlights.js). So the grips here move along the text
// layer the way the highlighter's own drag does (smartHlCaretAt, geometry
// rather than hit-testing, so it works whatever the layer's pointer-events say),
// the preview is the highlighter's preview band in the record's colour, and
// Apply re-captures the words and updates the record IN PLACE: the same id, so
// its colour, its note and any card made from it all stay with it. It goes on
// the pen's undo ring like every other highlight the highlighter makes.
//
// A region (a box round a figure) and a stroke of ink have no words to run the
// ends along, so the menu does not offer Adjust on them (canAdjust).

import { el } from "../core/dom.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { closeAdjustHandles, openAdjustHandles } from "../ui/adjust-handles.js?v=__BUILD__";
import { documentHighlightById, updateDocumentHighlight } from "./pdf-highlights.js?v=__BUILD__";
import { pageNumberForNode } from "./pdf-selection.js?v=__BUILD__";
import {
  smartHlCapture, smartHlCaretAt, smartHlClearPreview, smartHlGeometry, smartHlPaintPreview,
  smartHlRangeForRecord, smartHlRememberMove, smartHlSpans
} from "./pdf-smart-highlight.js?v=__BUILD__";
import { setDocumentMarksEditing, wakeDocumentPageText } from "./pdf-view.js?v=__BUILD__";

// Registered with the CSS highlight registry and given no style: it paints
// nothing, but a page whose text a registered range crosses is kept awake by
// sleepDocumentTextLayers (src/documents/pdf-view.js) — and a sleeping text
// layer has no boxes for the grips to sit on.
export const PDF_ADJUST_KEEPALIVE = "recall-adjust-pdf";

let pdfAdjustId = null;
// The page last found under a grip, and its spans measured once per scroll
// position rather than on every frame of a drag.
let pdfAdjustPage = 0;
let pdfAdjustSpans = null;

export function canAdjustDocumentHighlight(id) {
  const record = documentHighlightById(id);
  return Boolean(record) && record.kind !== "area" && record.kind !== "ink" && Boolean(record.anchor && record.focus);
}

function pdfAdjustPageUnder(x, y) {
  const hit = document.elementFromPoint(x, y)?.closest?.(".pdf-page");
  if (hit && el.documentView?.contains(hit)) return Number(hit.dataset.pageNumber) || 0;
  // Between two pages, or over something laid on top of one: the nearest page
  // by height, among those on screen.
  let best = 0;
  let bestDistance = Infinity;
  el.documentView?.querySelectorAll(".pdf-page").forEach((page) => {
    const rect = page.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const distance = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
    if (distance < bestDistance) { best = Number(page.dataset.pageNumber) || 0; bestDistance = distance; }
  });
  return best;
}

function pdfAdjustSpansFor(page) {
  const view = el.documentView;
  const key = `${page}:${view?.scrollTop || 0}:${view?.scrollLeft || 0}`;
  if (!pdfAdjustSpans || pdfAdjustSpans.key !== key) pdfAdjustSpans = { key, list: smartHlSpans(page) };
  return pdfAdjustSpans.list;
}

function pdfAdjustPointAt(x, y) {
  const page = pdfAdjustPageUnder(x, y) || pdfAdjustPage;
  if (!page) return null;
  const spans = pdfAdjustSpansFor(page);
  if (!spans.length) return null;
  const at = smartHlCaretAt(page, x, y, { spans });
  if (!at) return null;
  pdfAdjustPage = page;
  return { node: at.node, offset: at.index + (at.after ? 1 : 0) };
}

function pdfAdjustPages(range) {
  const a = pageNumberForNode(range.startContainer);
  const b = pageNumberForNode(range.endContainer);
  return [Math.min(a, b) || a || b, Math.max(a, b)];
}

function pdfAdjustPaint(color, range) {
  smartHlClearPreview();
  if (window.CSS?.highlights && typeof window.Highlight === "function") {
    if (range) CSS.highlights.set(PDF_ADJUST_KEEPALIVE, new window.Highlight(range));
    else CSS.highlights.delete(PDF_ADJUST_KEEPALIVE);
  }
  if (range) smartHlPaintPreview(range, color, pdfAdjustPages(range));
}

// A rule rather than a class on the quads: a page that re-renders while the
// grips are up (a scroll far enough to unload it, a zoom) paints fresh quads,
// and a class on the old ones would not follow them.
let pdfAdjustStyle = null;

// The record's own quads paint nothing while the grips are up — the preview is
// the highlight — so shrinking it visibly shrinks it.
function pdfAdjustSourceMarks(id, on) {
  pdfAdjustStyle?.remove();
  pdfAdjustStyle = null;
  if (!on) return;
  pdfAdjustStyle = document.createElement("style");
  pdfAdjustStyle.textContent = `.pdf-mark[data-highlight-id="${CSS.escape(id)}"] { background: transparent !important; }`;
  document.head.appendChild(pdfAdjustStyle);
}

export function startDocumentHighlightAdjust(id) {
  const record = documentHighlightById(id);
  if (!record || !canAdjustDocumentHighlight(id)) return false;
  // Both ends' pages have to have their words laid out to be measured.
  wakeDocumentPageText(Number(record.anchor.page));
  wakeDocumentPageText(Number(record.focus.page));
  const range = smartHlRangeForRecord(record);
  if (!range) {
    showToast("Scroll the highlight into view, then try Adjust again.", "error");
    return false;
  }
  closeAdjustHandles();
  const color = record.color || "yellow";
  pdfAdjustId = id;
  pdfAdjustPage = Number(record.page) || 0;
  pdfAdjustSpans = null;
  setDocumentMarksEditing(true);
  pdfAdjustSourceMarks(id, true);
  const restore = () => {
    pdfAdjustSourceMarks(id, false);
    pdfAdjustId = null;
    pdfAdjustSpans = null;
    setDocumentMarksEditing(false);
  };
  const opened = openAdjustHandles({
    scroller: el.documentView,
    range,
    color,
    pointAt: pdfAdjustPointAt,
    preview: (next) => pdfAdjustPaint(color, next),
    cancel: restore,
    apply: (next) => {
      const made = smartHlCapture(next);
      restore();
      const live = documentHighlightById(id);
      if (!made?.capture || !live) {
        showToast("Cover at least one word with the highlight, then tap Apply.", "error");
        return false;
      }
      const before = smartHlGeometry(live);
      const after = smartHlGeometry(made.capture);
      if (!updateDocumentHighlight(id, after)) return false;
      smartHlRememberMove(id, before, after);
      return true;
    }
  });
  if (!opened) restore();
  return opened;
}

// Which highlight is being adjusted, for tests.
export function documentHighlightAdjustId() {
  return pdfAdjustId;
}
