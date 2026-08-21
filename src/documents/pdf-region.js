// Highlighting what is not text.
//
// The Document surface's selection goes through a transparent text layer: one
// span per pdf.js text item, sitting exactly over its glyphs, so a drag across
// them is a real DOM selection that captureDocumentSelection can turn into
// { page, item, ch } (see pdf-selection.js). That is the right machinery for
// prose and it has nothing to say about the other half of a paper — a figure, a
// plotted result, a scanned table, a display equation typeset as vector art.
// There are no spans over any of those, so `boundaryAnchor` returns null, so
// `captureDocumentSelection` returns null, so the floating pill never appears.
// Half the content of a paper could not be highlighted, noted or made into a
// card at all.
//
// So: drag a BOX instead. What comes out the other end is deliberately an
// ordinary document highlight —
//
//   { id, color, page, anchor, focus, text, quads: [one quad], kind: "area" }
//
// — because everything that reads one of those already works. Painting
// (paintDocumentHighlights), the tap-to-open menu (documentHighlightAtPoint
// hit-tests the quads geometrically, so it never needed text), notes
// (setDocumentHighlightNote writes into the same "## Highlight Notes" section),
// the Highlights panel, the export, and the sync merge (mergePdfHighlights is a
// union by id — a new field rides along untouched). No new store, no new table,
// no migration: a region is a highlight whose quad happens not to have come from
// a run of glyphs.
//
// ── Why the mode is one-shot ────────────────────────────────────────────────
//
// While it is armed the text layer stops taking pointer events and the scroller
// gives up `touch-action` (styles/37-document-chrome.css), which is what makes a
// drag a marquee rather than a text selection or a scroll. Both are real
// takeaways — armed and forgotten, the surface is one you cannot select text in
// and, on a phone, cannot scroll. So it disarms itself after one capture, the
// way a shape tool in a drawing app does, and Escape gets out of it at any time.

import { el } from "../core/dom.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { renderFormatDefaults } from "../format/render-toolbar.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { addDocumentHighlight, DOCUMENT_MARK_HANDLERS, PDF_MARK_CLASS } from "./pdf-highlights.js?v=__BUILD__";
import { pageNumberForRect, rectToPdfQuad, TEXT_ITEM_ATTR } from "./pdf-selection.js?v=__BUILD__";
import { openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";

export const REGION_CLASS = "is-region-select";

export const REGION_MARQUEE_CLASS = "pdf-region-marquee";

// Below this a drag is a tap that wandered, not a box. 12px square is small
// enough to draw a deliberate marquee around an inline symbol and large enough
// that a thumb resting on the page never commits one.
export const REGION_MIN_SIZE = 12;

let regionArmed = false;
let regionDrag = null;

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
  if (!regionArmed) clearRegionMarquee();
}

export function toggleRegionSelect() {
  setRegionSelect(!regionArmed);
  return regionArmed;
}

function clearRegionMarquee() {
  regionDrag?.box?.remove();
  regionDrag = null;
}

// ── The drag ────────────────────────────────────────────────────────────────

// The marquee is drawn INSIDE the .pdf-page the press landed on, absolutely
// positioned in that page's own coordinate space — the same space the quads
// live in. Drawing it in the scroller instead would mean converting twice and
// re-converting on every scroll event during the drag.
function regionPageUnder(clientX, clientY) {
  return document.elementFromPoint(clientX, clientY)?.closest(".pdf-page") || null;
}

function regionBoxFromPoints(pageEl, from, to) {
  const rect = pageEl.getBoundingClientRect();
  const left = Math.min(from.x, to.x) - rect.left;
  const top = Math.min(from.y, to.y) - rect.top;
  return {
    left: Math.max(0, Math.min(left, rect.width)),
    top: Math.max(0, Math.min(top, rect.height)),
    width: Math.min(Math.abs(to.x - from.x), rect.width),
    height: Math.min(Math.abs(to.y - from.y), rect.height)
  };
}

// Any text the region happens to cover. A boxed equation, a table rendered as
// text, a figure with a caption inside the box: all of those DO have spans over
// them, and taking their words costs one pass over the page's own text layer.
// A photograph gives "" and is named by its page instead (documentHighlightLabel).
//
// Read off the live text layer rather than through page.getTextContent(),
// because the spans are already laid out and already carry their item index —
// which is also where the anchor comes from, so both halves come out of one walk.
function regionTextUnderBox(pageEl, clientRect) {
  const spans = pageEl.querySelectorAll(`.pdf-text-layer [${TEXT_ITEM_ATTR}]`);
  const parts = [];
  let item = null;
  spans.forEach((span) => {
    const box = span.getBoundingClientRect();
    if (box.right < clientRect.left || box.left > clientRect.right) return;
    if (box.bottom < clientRect.top || box.top > clientRect.bottom) return;
    if (item === null) item = Number(span.dataset.itemIndex) || 0;
    if (span.textContent) parts.push(span.textContent);
  });
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), item: item === null ? 0 : item };
}

function beginRegionDrag(event) {
  const pageEl = regionPageUnder(event.clientX, event.clientY);
  if (!pageEl) return;
  const box = document.createElement("div");
  box.className = REGION_MARQUEE_CLASS;
  pageEl.appendChild(box);
  regionDrag = { pageEl, box, from: { x: event.clientX, y: event.clientY }, to: { x: event.clientX, y: event.clientY } };
  updateRegionMarquee();
  // Captured so a drag that leaves the page — or leaves the window — still
  // delivers its move and its release here. Without it a marquee dragged off
  // the bottom of the scroller is never committed and never cleaned up.
  try {
    el.documentView?.setPointerCapture?.(event.pointerId);
    regionDrag.pointerId = event.pointerId;
  } catch (_) { /* a synthetic event with no id — the document listeners cover it */ }
}

function updateRegionMarquee() {
  if (!regionDrag) return;
  const box = regionBoxFromPoints(regionDrag.pageEl, regionDrag.from, regionDrag.to);
  regionDrag.box.style.left = `${box.left}px`;
  regionDrag.box.style.top = `${box.top}px`;
  regionDrag.box.style.width = `${box.width}px`;
  regionDrag.box.style.height = `${box.height}px`;
}

// The commit. Every conversion below already existed for text highlights, and
// is reused rather than reimplemented — which is what makes a region survive a
// zoom, a rotation and a reload exactly as well as a sentence does, since the
// quad is in PDF user space and nothing else is.
function endRegionDrag() {
  if (!regionDrag) return;
  const { pageEl, from, to } = regionDrag;
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  clearRegionMarquee();
  if (width < REGION_MIN_SIZE || height < REGION_MIN_SIZE) {
    // Not a box. Leave the mode ARMED — a slipped press should not cost the
    // reader the mode they deliberately turned on.
    return;
  }

  const clientRect = {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    right: Math.max(from.x, to.x),
    bottom: Math.max(from.y, to.y),
    width,
    height
  };
  const pageNumber = pageNumberForRect(clientRect, Number(pageEl.dataset.pageNumber) || 1, Number(pageEl.dataset.pageNumber) || 1);
  const quad = rectToPdfQuad(clientRect, pageNumber);
  // No viewport for the page means it has never been laid out, which cannot
  // happen for a page the reader just dragged across — but a null quad painted
  // as a highlight would be a record with no position, and those are forever.
  if (!quad) {
    setRegionSelect(false);
    showToast("Could not place that region — try again once the page has finished drawing", "error");
    return;
  }

  const { text, item } = regionTextUnderBox(pageEl, clientRect);
  const anchor = { page: pageNumber, item, ch: 0 };
  const record = addDocumentHighlight({
    kind: "area",
    page: pageNumber,
    anchor,
    focus: anchor,
    text,
    quads: [quad]
  }, renderFormatDefaults.highlight || MARK_HIGHLIGHT_DEFAULT);

  setRegionSelect(false);
  if (!record) return;

  // Straight into the highlight's own menu, anchored on what was just drawn: a
  // region is almost always made in order to say something about the figure, and
  // making the reader find the box again to tap it is a step for nothing.
  const mark = el.documentView?.querySelector(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(record.id)}"]`);
  if (mark) openMarkMenuWith(mark, record.id, DOCUMENT_MARK_HANDLERS, record.color);
}

export function initDocumentRegionSelect() {
  const view = el.documentView;
  if (!view) return;

  view.addEventListener("pointerdown", (event) => {
    if (!regionArmed || regionDrag) return;
    // Two fingers are a pinch, and initDocumentPinchZoom owns that gesture at
    // every moment including this one. A secondary mouse button is a context
    // menu.
    if (event.pointerType === "touch" && event.isPrimary === false) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    beginRegionDrag(event);
  });

  view.addEventListener("pointermove", (event) => {
    if (!regionDrag) return;
    event.preventDefault();
    regionDrag.to = { x: event.clientX, y: event.clientY };
    updateRegionMarquee();
  });

  ["pointerup", "pointercancel"].forEach((type) => {
    view.addEventListener(type, (event) => {
      if (!regionDrag) return;
      if (regionDrag.pointerId !== undefined) {
        try { view.releasePointerCapture(regionDrag.pointerId); } catch (_) { /* already gone */ }
      }
      if (type === "pointercancel") {
        clearRegionMarquee();
        return;
      }
      regionDrag.to = { x: event.clientX, y: event.clientY };
      endRegionDrag();
    });
  });

  // Escape gets out, whether or not a box is half-drawn. Registered on the
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
