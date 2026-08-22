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

// The span a boundary that landed BETWEEN two items belongs to.
//
// buildTextLayer writes a whitespace text node between one item's span and the
// next, so a selection spanning several items reads as prose rather than as one
// welded string (see the long note there). Those separators are real nodes, so a
// drag can end on one — and a boundary on a separator used to make
// textSpanForNode return null, which made captureDocumentSelection return null,
// which is a highlight that silently did not happen.
//
// A boundary at the start of a selection belongs to the item AFTER the gap; one
// at the end belongs to the item BEFORE it. Nothing outside the text layer is
// walked: a drag that began in the page margin still has no anchor, which is
// what pdf-region.js relies on.
function spanAcrossGap(node, edge) {
  const layer = node?.parentElement;
  if (!layer?.classList?.contains("pdf-text-layer")) return null;
  let sibling = edge === "end" ? node.previousSibling : node.nextSibling;
  while (sibling) {
    const span = sibling.nodeType === Node.ELEMENT_NODE && sibling.hasAttribute?.(TEXT_ITEM_ATTR)
      ? sibling
      : null;
    if (span) return span;
    sibling = edge === "end" ? sibling.previousSibling : sibling.nextSibling;
  }
  return null;
}

// { page, item, ch } for one selection boundary, or null when the boundary is
// not over text (the margin, a figure, the gap between pages).
//
// `edge` says which end of the selection this is, and is only consulted for a
// boundary that landed on a separator between two items — see spanAcrossGap.
export function boundaryAnchor(container, offset, edge = "start") {
  const gapSpan = textSpanForNode(container) ? null : spanAcrossGap(container, edge);
  const span = textSpanForNode(container) || gapSpan;
  if (!span) return null;
  const page = pageNumberForNode(span);
  if (!page) return null;
  // A boundary that came off a separator has no character offset of its own:
  // it is the very start of the item after the gap, or the very end of the one
  // before it.
  if (gapSpan) {
    return {
      page,
      item: Number(span.dataset.itemIndex) || 0,
      ch: edge === "end" ? (span.textContent || "").length : 0
    };
  }
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
  const anchor = boundaryAnchor(range.startContainer, range.startOffset, "start");
  const focus = boundaryAnchor(range.endContainer, range.endOffset, "end");
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

// The separator between two adjacent text items, as buildTextLayer writes it
// into the layer. One definition, because the two have to agree: this is what
// makes a repaired highlight's text identical to what a fresh capture over the
// same words produces.
export function textItemGap(previous, next) {
  if (!previous) return "";
  if (previous.hasEOL) return "\n";
  return /\s$/.test(previous.str || "") || /^\s/.test(next?.str || "") ? "" : " ";
}

// The words a stored { item, ch } anchor pair covers, read back off the page's
// own text items.
//
// This is the exact counterpart of range.toString() over the text layer, and it
// exists for repairDocumentHighlightText: a highlight made before the layer had
// separators in it stored its words welded together, and the anchors it stored
// alongside them are enough to say what those words actually were. Character
// exact, so a highlight over half a line is rebuilt as half a line and not as
// the whole of it (which is what textForQuads below would give — right for an
// imported annotation, which has no anchors, and too coarse for this).
//
// "" for anchors that do not describe a run on one page: a highlight across a
// page break has no single item list to read from.
export function textForAnchorRange(items, anchor, focus) {
  if (!Array.isArray(items) || !anchor || !focus) return "";
  if (anchor.page !== focus.page) return "";
  const forwards = anchor.item < focus.item || (anchor.item === focus.item && anchor.ch <= focus.ch);
  const from = forwards ? anchor : focus;
  const to = forwards ? focus : anchor;
  if (!items[from.item] || !items[to.item]) return "";
  if (from.item === to.item) {
    return String(items[from.item].str || "").slice(from.ch, to.ch).replace(/\s+/g, " ").trim();
  }
  let out = String(items[from.item].str || "").slice(from.ch);
  // `previous` is the last item that CONTRIBUTED, not items[i - 1]: an item with
  // an empty str emits no span, so buildTextLayer never writes a separator for
  // it either, and the two have to agree about that as well.
  let previous = items[from.item];
  for (let i = from.item + 1; i <= to.item; i += 1) {
    const item = items[i];
    if (!item || !item.str) continue;
    out += textItemGap(previous, item);
    out += i === to.item ? String(item.str).slice(0, to.ch) : String(item.str);
    previous = item;
  }
  return out.replace(/\s+/g, " ").trim();
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
