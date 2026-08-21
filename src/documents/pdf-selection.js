// Turning a selection over the PDF into something worth storing, and back.
//
// ── Why this anchor is different from the notes one ─────────────────────────
//
// src/notes/anchors.js opens with "an anchor is a text snippet plus a hint, not
// an offset — the note gets edited and offsets rot". That is exactly right for
// markdown, and exactly wrong here: a PDF never changes. The file is stored
// whole and its sha256 is checked on re-attach, so page 3, text item 41,
// character 12 means the same thing forever.
//
// So the anchor IS an offset:
//
//   { page, item, ch }   page 1-based, item = index into
//                        page.getTextContent().items, ch = char offset in
//                        that item's str
//
// with a quad list alongside it. The quads are a cache, not the truth: they
// paint instantly with no text-content fetch, and they keep working even if a
// future pdf.js were to shift item indexing, in which case the text can still
// be re-located from the stored string. Both halves are stored because either
// alone has a failure mode the other covers.
//
// Coordinates are PDF USER SPACE, unrotated — the space the file itself is
// written in. That is what makes a highlight independent of zoom, of device
// pixel ratio, of window width and of page rotation; every conversion goes
// through the live viewport, which knows about all four.

import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const TEXT_ITEM_ATTR = "data-item-index";

export const PAGE_NUMBER_ATTR = "data-page-number";

// The <span> a selection boundary lands in, whether the boundary is inside the
// span's text node or on the span itself.
export function textSpanForNode(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(`[${TEXT_ITEM_ATTR}]`) || null;
}

export function pageNumberForNode(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const page = element?.closest?.(`[${PAGE_NUMBER_ATTR}]`);
  return page ? Number(page.dataset.pageNumber) || 0 : 0;
}

// { page, item, ch } for one selection boundary, or null when the boundary is
// not over text (the margin, a figure, the gap between pages).
export function boundaryAnchor(container, offset) {
  const span = textSpanForNode(container);
  if (!span) return null;
  const page = pageNumberForNode(span);
  if (!page) return null;
  // A boundary placed on the SPAN rather than in its text node reports a child
  // index, not a character offset — 0 means "before the text", anything else
  // means "after it".
  const ch = container?.nodeType === Node.TEXT_NODE
    ? offset
    : (offset > 0 ? (span.textContent || "").length : 0);
  return { page, item: Number(span.dataset.itemIndex) || 0, ch };
}

// One client rect, in the PDF user space of the page it falls on.
//
// Both corners are converted rather than the top-left plus a scaled size,
// because a rotated page's viewport transform is not a pure scale — converting
// a width would be wrong in a way that only shows up on rotated scans.
export function rectToPdfQuad(rect, pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  const viewport = pdfPageViewport(pageNumber);
  if (!pageEl || !viewport) return null;
  const box = pageEl.getBoundingClientRect();
  const [x0, y0] = viewport.convertToPdfPoint(rect.left - box.left, rect.top - box.top);
  const [x1, y1] = viewport.convertToPdfPoint(rect.right - box.left, rect.bottom - box.top);
  return {
    page: pageNumber,
    rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
  };
}

// The inverse, for painting: a stored quad as { left, top, width, height } in
// the page element's own coordinate space, at whatever zoom is current.
export function quadToPageBox(quad) {
  const viewport = pdfPageViewport(quad.page);
  if (!viewport) return null;
  const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(quad.rect);
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0)
  };
}

// Client rects are per LINE FRAGMENT, and a dense text layer emits one per
// glyph run — a selected sentence in a two-column paper can be forty
// near-identical slivers. Merged here rather than painted as forty divs: the
// overlapping alpha of a colour-mix tint would otherwise show every seam as a
// darker band, which reads as a rendering bug rather than a highlight.
export const QUAD_MERGE_TOLERANCE = 1.5;

export function mergeQuads(quads) {
  const merged = [];
  quads.forEach((quad) => {
    const last = merged[merged.length - 1];
    if (last && last.page === quad.page
        && Math.abs(last.rect[1] - quad.rect[1]) <= QUAD_MERGE_TOLERANCE
        && Math.abs(last.rect[3] - quad.rect[3]) <= QUAD_MERGE_TOLERANCE
        && quad.rect[0] - last.rect[2] <= QUAD_MERGE_TOLERANCE * 4) {
      last.rect[2] = Math.max(last.rect[2], quad.rect[2]);
      last.rect[0] = Math.min(last.rect[0], quad.rect[0]);
      return;
    }
    merged.push({ page: quad.page, rect: quad.rect.slice() });
  });
  return merged;
}

// A live selection over the text layer, snapshotted.
//
// Returns null for anything that is not a real text selection on this surface,
// which is what every caller treats as "there is nothing to highlight here" —
// including a drag that started in the page margin, and a collapsed caret.
export function captureDocumentSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const anchor = boundaryAnchor(range.startContainer, range.startOffset);
  const focus = boundaryAnchor(range.endContainer, range.endOffset);
  if (!anchor || !focus) return null;
  const text = range.toString().replace(/\s+/g, " ").trim();

  const quads = [];
  Array.from(range.getClientRects()).forEach((rect) => {
    if (rect.width < 0.5 || rect.height < 0.5) return;
    // Which page a rect belongs to has to be resolved geometrically: a
    // selection can run across a page break, and the rects come back as one
    // flat list with nothing on them saying which page they fell on.
    const page = pageNumberForRect(rect, anchor.page, focus.page);
    if (!page) return;
    const quad = rectToPdfQuad(rect, page);
    if (quad) quads.push(quad);
  });
  if (!quads.length) return null;

  return { anchor, focus, text, page: anchor.page, quads: mergeQuads(quads) };
}

// Which of the pages the selection touches contains this rect's centre. Walks
// only the pages between the two endpoints, which is at most a handful even for
// a selection dragged across a chapter.
export function pageNumberForRect(rect, fromPage, toPage) {
  const first = Math.min(fromPage, toPage);
  const last = Math.max(fromPage, toPage);
  const midY = rect.top + rect.height / 2;
  for (let page = first; page <= last; page++) {
    const pageEl = pdfPageElement(page);
    if (!pageEl) continue;
    const box = pageEl.getBoundingClientRect();
    if (midY >= box.top - 1 && midY <= box.bottom + 1) return page;
  }
  return first;
}

// ── Reading an anchor back ──────────────────────────────────────────────────

// A stored record's landing place, for a jump: the page and how far down it the
// highlight starts, as a ratio, so a jump can put the highlight on screen
// rather than the top of the page it happens to be on.
//
// Derived from the QUADS, not from the text index — the quads are already in
// page space and need no text-content fetch, which matters because a jump is
// something the reader is waiting for.
export function resolveDocumentAnchor(record) {
  const quads = Array.isArray(record?.quads) ? record.quads : [];
  const page = Number(record?.page || record?.anchor?.page || quads[0]?.page || 0);
  if (!page) return null;
  const onPage = quads.filter((quad) => quad.page === page);
  if (!onPage.length) return { page, ratio: 0, quads: [] };
  const viewport = pdfPageViewport(page);
  if (!viewport) {
    // The page has not been laid out yet, so nothing can be measured against
    // it. The page number alone is still a correct answer — the caller scrolls
    // there, which is what makes the page lay out, and can ask again.
    return { page, ratio: 0, quads: onPage };
  }
  const boxes = onPage.map(quadToPageBox).filter(Boolean);
  if (!boxes.length) return { page, ratio: 0, quads: onPage };
  const top = Math.min(...boxes.map((box) => box.top));
  const height = viewport.height || 1;
  return { page, ratio: Math.min(1, Math.max(0, top / height)), quads: onPage };
}

// ── Text items, for the importer ────────────────────────────────────────────

// A text item's bounding box in PDF user space. `transform` is the item's own
// matrix: [4] and [5] are the baseline origin, and `width`/`height` come back
// in the same space. Descenders fall below the baseline, so the box is nudged
// down by a fifth of the height — enough that a highlight quad drawn over the
// line still intersects the item, which is the only thing this is used for.
export const TEXT_ITEM_DESCENDER = 0.2;

export function textItemBox(item) {
  const x = item.transform[4];
  const y = item.transform[5];
  const height = item.height || Math.hypot(item.transform[2], item.transform[3]) || 0;
  return {
    x0: x,
    y0: y - height * TEXT_ITEM_DESCENDER,
    x1: x + (item.width || 0),
    y1: y + height * (1 - TEXT_ITEM_DESCENDER)
  };
}

export function boxesIntersect(box, rect) {
  return box.x1 >= rect[0] && box.x0 <= rect[2] && box.y1 >= rect[1] && box.y0 <= rect[3];
}

// The text a set of quads covers, plus the { item, ch } the first of them
// starts at — used to give a highlight imported from the PDF's own annotations
// the same shape as one made in this app. `items` is
// page.getTextContent().items for the quads' page.
export function textForQuads(items, quads) {
  const parts = [];
  let anchorItem = null;
  items.forEach((item, index) => {
    if (!item.str) return;
    const box = textItemBox(item);
    if (!quads.some((quad) => boxesIntersect(box, quad.rect))) return;
    if (anchorItem === null) anchorItem = index;
    parts.push(item.str);
  });
  return {
    text: parts.join(" ").replace(/\s+/g, " ").trim(),
    item: anchorItem === null ? 0 : anchorItem
  };
}
