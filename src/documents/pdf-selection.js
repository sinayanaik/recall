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

import { stripInvalidUnicode } from "../core/text.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const TEXT_ITEM_ATTR = "data-item-index";

// Where a span's text starts in its item's str, when that is not 0 — set on a
// span that carries only part of its item (see keptTextItem). Absent means 0.
export const TEXT_CH_START_ATTR = "data-ch-start";

export function spanCharStart(span) {
  return Number(span?.getAttribute?.(TEXT_CH_START_ATTR)) || 0;
}

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
  const startsAt = spanCharStart(span);
  if (gapSpan) {
    return {
      page,
      item: Number(span.dataset.itemIndex) || 0,
      ch: startsAt + (edge === "end" ? (span.textContent || "").length : 0)
    };
  }
  // A boundary placed on the SPAN rather than in its text node reports a child
  // index, not a character offset — 0 means "before the text", anything else
  // means "after it".
  const ch = container?.nodeType === Node.TEXT_NODE
    ? offset
    : (offset > 0 ? (span.textContent || "").length : 0);
  return { page, item: Number(span.dataset.itemIndex) || 0, ch: startsAt + ch };
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
  return captureDocumentRange(selection.getRangeAt(0));
}

// The same snapshot of any Range over the text layer, selected or not. The
// highlighter (src/documents/pdf-smart-highlight.js) builds its Range from a
// drag rather than from the reader's selection — and while ▣ is on the text
// layer takes no pointer events, so there is no selection to read. Nothing
// here needs one: getClientRects is a layout question, not a hit test.
export function captureDocumentRange(range) {
  if (!range || range.collapsed) return null;
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
//
// `span` is the second half of that answer: how TALL the highlight is, in the
// same ratio-of-the-page units, so a jump can centre the marked words rather
// than putting their top edge on the screen's top edge. A phrase running across
// three lines is three quads and one span from the first line's top to the
// last line's bottom.
//
// It is also the flag for "this was actually measured". Every early return
// below reports span 0 — no quads on the page, no viewport to convert against,
// no box that converted — and 0 is the one value a real highlight cannot have,
// so a caller that centres only on `span > 0` never centres on a guess.
export function resolveDocumentAnchor(record) {
  const quads = Array.isArray(record?.quads) ? record.quads : [];
  const page = Number(record?.page || record?.anchor?.page || quads[0]?.page || 0);
  if (!page) return null;
  const onPage = quads.filter((quad) => quad.page === page);
  if (!onPage.length) return { page, ratio: 0, span: 0, quads: [] };
  const viewport = pdfPageViewport(page);
  if (!viewport) {
    // The page has not been laid out yet, so nothing can be measured against
    // it. The page number alone is still a correct answer — the caller scrolls
    // there, which is what makes the page lay out, and can ask again.
    return { page, ratio: 0, span: 0, quads: onPage };
  }
  const boxes = onPage.map(quadToPageBox).filter(Boolean);
  if (!boxes.length) return { page, ratio: 0, span: 0, quads: onPage };
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  const height = viewport.height || 1;
  const onto = (value) => Math.min(1, Math.max(0, value));
  return { page, ratio: onto(top / height), span: onto((bottom - top) / height), quads: onPage };
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
//
// ── pdf.js already wrote the spaces ──────────────────────────────────────────
//
// "A bs tr ac t — Man y app li ca ti ons i n r obo ti cs", copied off a LaTeX
// paper that any other reader copies as "Abstract—Many applications in
// robotics". This used to put a space between every two items on a line that
// did not already have one, on the theory that items are words. They are not:
// pdf.js starts a new item at every font switch, and a paper switches font
// inside a word all the time (small caps, a ligature from another font, an
// italic letter).
//
// The first fix measured the gap between the two items (the next item's x
// against this one's x + width) and added a space when it looked like a word
// gap. That still split words — "spherica l mode ls", "T his", "a re" — on
// real papers, because it trusted item.width, and the width pdf.js reports for
// a run does not always agree with where it puts the next one.
//
// So no width is consulted at all. pdf.js has ALREADY decided where the word
// gaps on a line are, from the glyph positions themselves: it writes a space
// into the item's text, or emits a whitespace item of its own, for every
// advance that is wider than a letter gap (compareWithLastPosition /
// addFakeSpaces in its text extraction). Two items on one baseline with no
// whitespace between them are therefore one word, and are joined with nothing.
//
// What is left for this function is the line break, which pdf.js marks with
// hasEOL — often on an empty item that nothing here writes a span for. So a
// change of baseline is a new line too, and so is a jump back to the left on
// the same baseline: that is another run of text that happens to share it.
// Text that is rotated, vertical or right-to-left has no "left to right along
// a baseline" to compare, and keeps the old answer of a space.
export function textItemGap(previous, next) {
  if (!previous) return "";
  if (previous.hasEOL) return "\n";
  if (/\s$/.test(previous.str || "") || /^\s/.test(next?.str || "")) return "";
  const a = previous.transform;
  const b = next?.transform;
  const horizontal = (t) => Array.isArray(t) && t[0] > 0 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6;
  if (!horizontal(a) || !horizontal(b) || previous.dir === "rtl" || next.dir === "rtl") return " ";
  const size = Math.max(Number(previous.height) || a[3], Number(next.height) || b[3], 0);
  if (!(size > 0)) return " ";
  if (Math.abs(b[5] - a[5]) > size * 0.5) return "\n";
  // Compared start to start, deliberately not against previous.width.
  if (b[4] < a[4] - size) return "\n";
  return "";
}

// ── Text drawn more than once in the same place ─────────────────────────────
//
// "inininininin ducducducduc tivetivetive biasbiasbias in a model" — copied off
// The Little Book of Deep Learning, where every underlined index term came back
// eleven times over, syllable by syllable. The book draws those words several
// times on top of each other (a descender-skipping underline stamps each
// syllable at sub-point offsets before drawing it for real; fake bold does the
// same with two stamps), and pdf.js reports the stamps as text items of their
// own. Each got a span, textItemGap rightly joined same-baseline items with
// nothing, and the clipboard and every highlight got the word N times.
//
// ── Why per character, not per item ─────────────────────────────────────────
//
// pdf.js glues a run onto the item before it when it starts where that one
// ended — and the real "in" ends exactly where the first stamp of "duc"
// starts. So the items are not eleven "in"s and eleven "duc"s but "in" ×10,
// "induc", "duc" ×9, "ductive", "tive" ×9 …: dropping only whole duplicate
// items still copies "ininducducductivetive".
//
// So each character is placed along its item (see characterEdges) and is a
// SHADOW when it lands on a character already read: the same glyph, the same
// size, on the same baseline, at most a quarter of an em away, and part of a
// run that lines up at one offset — stampedCharacters says exactly when. A
// genuine repeat ("ll", "the the", "bal" | "loon") is a whole advance further
// on; a stamp is a fraction of a point from what it copies.
//
// What survives of an item is one contiguous slice of its str, [start, end):
// the whole of it, none of it, or the part a stamped prefix or suffix leaves.
// Shadows scattered through the middle of an item are not something a stamp
// produces, and such an item is kept whole rather than guessed at. Indices and
// character offsets still refer to the UNMODIFIED page.getTextContent().items:
// that is what a stored { item, ch } anchor means.
//
// Only the last TEXT_SHADOW_WINDOW items are compared against. A stamp is drawn
// straight after (or straight before) what it copies, so that is enough, and it
// keeps a dense page linear rather than quadratic: a few milliseconds for a
// page of thousands of items, paid once per page and cached on its item list.
export const TEXT_SHADOW_RADIUS = 0.25;

export const TEXT_SHADOW_WINDOW = 64;

export const TEXT_SHADOW_MIN_OVERLAP = 0.1;

const shadowCache = new WeakMap();

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-6) * 0.02 + 1e-6;
}

// Where each character of an item sits is not something pdf.js says: an item
// has one origin and one width. It is shared out among the characters two
// ways, and a stamp only has to line up under one of them — a font whose every
// glyph is the same width (Courier, a typewriter face) is the even split, and
// anything proportional is closer to the widths of a typical text face
// (Helvetica's, per 1000 em, for printable ASCII) scaled to the item's real
// width. Both are anchored at the item's two real ends, so a stamp glued onto
// the end of a long item is placed from that end and not from forty letters
// away. The comparison only ever runs between items that already overlap on
// one baseline, which ordinary text never does, so a generous model costs
// nothing where nothing is stamped.
const GLYPH_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

function glyphWidth(ch) {
  const code = ch.charCodeAt(0);
  return code >= 32 && code <= 126 ? GLYPH_WIDTHS[code - 32] : 556;
}

const EVEN = 0;
const PROPORTIONAL = 1;

// The left edge of every character of an item, and the right edge of the last,
// under one of the two models: length + 1 numbers, along the baseline.
function characterEdges(g, model) {
  if (g.edges[model]) return g.edges[model];
  const n = g.str.length;
  const edges = new Float64Array(n + 1);
  if (model === EVEN) {
    for (let j = 0; j <= n; j += 1) edges[j] = g.t[4] + (g.width * j) / n;
  } else {
    let total = 0;
    for (let j = 0; j < n; j += 1) total += glyphWidth(g.str[j]);
    let run = 0;
    for (let j = 0; j <= n; j += 1) {
      edges[j] = g.t[4] + (g.width * run) / total;
      if (j < n) run += glyphWidth(g.str[j]);
    }
  }
  g.edges[model] = edges;
  return edges;
}

function shadowGeometry(item) {
  const t = item?.transform;
  const str = item?.str;
  if (!str || !Array.isArray(t)) return null;
  const size = Math.hypot(t[2], t[3]) || Number(item.height) || 0;
  if (!(size > 0)) return null;
  const width = Math.abs(Number(item.width) || 0);
  // Character positions are only worked out along an upright, left-to-right
  // run; anything else can still be a whole-item stamp of another.
  const flat = t[0] > 0 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 && item.dir !== "rtl" && width > 0;
  return { t, str, size, width, flat, blank: !/\S/.test(str), edges: [null, null] };
}

// A single letter at the seam between two items — the last kept letter of
// one, the first of the next, or the other way about — measured off the two
// items' real ends rather than off estimated character positions. At a
// genuine seam ("bal" | "loon") the next item starts where the other ends; a
// stamp ("the right a" | "a in a model", the underlined "a" drawn twice, each
// time glued to its neighbour) starts a whole letter before it does.
function loneLetterOverlaps(g, o, letter, c, from, to) {
  const narrowest = Math.min(...[EVEN, PROPORTIONAL].map((m) => {
    const e = characterEdges(g, m);
    return e[letter + 1] - e[letter];
  }));
  if (letter === 0 && c === to - 1) {
    const end = to === o.str.length
      ? o.t[4] + o.width
      : Math.min(characterEdges(o, EVEN)[to], characterEdges(o, PROPORTIONAL)[to]);
    return end - g.t[4] > 0.5 * narrowest;
  }
  if (letter === g.str.length - 1 && c === from) {
    const start = from === 0
      ? o.t[4]
      : Math.max(characterEdges(o, EVEN)[from], characterEdges(o, PROPORTIONAL)[from]);
    return g.t[4] + g.width - start > 0.5 * narrowest;
  }
  return false;
}

// The characters of `g` that stamp kept characters of `o` (item k): marks them
// in `flags` and returns { marked: [per model], first } or null.
//
// A stamp copies a RUN of characters, so every character of it lines up with
// the other item's at one and the same offset (c - j). Only the matches that
// agree with the best-supported offset — over both models together — are
// taken: a doubled letter at a seam (the "t" of "fit" beside the "t" of
// "ting") can sit close enough to the wrong one under one model to pass the
// distance test on its own, and is a different offset from the run it is in.
//
// ── One letter is not a stamp ──
//
// How close counts as "on top of" depends on how much agrees. Two or more
// letters in a row at one offset may each be anywhere within a quarter em of
// their twins: two letters are wider than that, so neighbouring text, which
// never overlaps, cannot line up that way. A letter on its own has to be
// within half a character (the glyph's or the item's average, whichever is
// wider) — two genuine "l"s a whole advance apart never are — and even then
// it counts only as the whole of the stamping item (an underlined "a" stamped
// on its own), the whole of what is kept of the item it stamps, or a seam
// where the two items' real ends overlap by most of a letter (see
// loneLetterOverlaps). A word split into items at a doubled letter — "fit" |
// "ting", "bal" | "loon" — is none of those. Whitespace may sit anywhere
// within the quarter em: a doubled space reads as one space anyway.
function stampedCharacters(g, o, k, shadows, flags, reach) {
  // What of the other item can be stamped: what is kept of it — or, when it is
  // itself a stamp, all of it (see the window in textItemShadows).
  const whole = shadows.start[k] >= shadows.end[k];
  const from = whole ? 0 : shadows.start[k];
  const to = whole ? o.str.length : shadows.end[k];
  const average = Math.min(g.width / g.str.length, o.width / o.str.length);
  const pairs = []; // { j, c, model, strict }
  const support = new Map();
  for (const model of [EVEN, PROPORTIONAL]) {
    const eg = characterEdges(g, model);
    const eo = characterEdges(o, model);
    // No overlap with what is kept of the other item, no stamp.
    if (eg[g.str.length] <= eo[from] - reach || eg[0] >= eo[to] + reach) continue;
    for (let j = 0; j < g.str.length; j += 1) {
      const ch = g.str[j];
      const cx = (eg[j] + eg[j + 1]) / 2;
      const cw = eg[j + 1] - eg[j];
      // Only the other item's characters whose middle could be within reach:
      // from the first whose right edge is past cx - reach.
      let lo = from;
      let hi = to;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (eo[mid + 1] < cx - reach) lo = mid + 1;
        else hi = mid;
      }
      for (let c = lo; c < to && eo[c] <= cx + reach; c += 1) {
        if (o.str[c] !== ch) continue;
        const distance = Math.abs((eo[c] + eo[c + 1]) / 2 - cx);
        if (distance > reach) continue;
        const strict = distance <= Math.min(reach, 0.5 * Math.max(Math.min(cw, eo[c + 1] - eo[c]), average));
        pairs.push({ j, c, model, strict });
        if (!/\s/.test(ch)) support.set(c - j, (support.get(c - j) || 0) + 1);
      }
    }
  }
  if (!pairs.length) return null;
  let offset = null;
  let best = 0;
  support.forEach((count, d) => { if (count > best) { best = count; offset = d; } });
  // Whitespace goes with the run's offset when there is one; a stamp that is
  // nothing but a space has none, and its own nearest match is it.
  const along = new Map(); // j → { c, strict }, for the pairs at that offset
  const marked = [0, 0];
  pairs.forEach(({ j, c, model, strict }) => {
    if (offset !== null && c - j !== offset) return;
    marked[model] += 1;
    const seen = along.get(j);
    if (!seen) along.set(j, { c, strict });
    else if (strict) seen.strict = true;
  });
  const solid = (str, j) => !/\s/.test(str[j]);
  const accepted = [];
  const js = Array.from(along.keys()).sort((x, y) => x - y);
  for (let r = 0; r < js.length;) {
    let e = r;
    while (e + 1 < js.length && js[e + 1] === js[e] + 1) e += 1;
    const run = js.slice(r, e + 1);
    r = e + 1;
    const letters = run.filter((j) => solid(g.str, j));
    let ok = letters.length !== 1;
    if (letters.length === 1 && along.get(letters[0]).strict) {
      const j = letters[0];
      const { c } = along.get(j);
      let wholeOfMine = true;
      for (let x = 0; x < g.str.length && wholeOfMine; x += 1) if (solid(g.str, x) && x !== j) wholeOfMine = false;
      let wholeOfTheirs = true;
      for (let x = from; x < to && wholeOfTheirs; x += 1) if (solid(o.str, x) && x !== c) wholeOfTheirs = false;
      // The seam test reads the other item's real ends, and a stamp's ends are
      // off by however far it was stamped — enough to make a genuine doubled
      // letter look overlapped. Only a kept item's ends will do.
      ok = wholeOfMine || wholeOfTheirs || (!whole && loneLetterOverlaps(g, o, j, c, from, to));
    }
    if (!ok) continue;
    accepted.push(...run);
    // A run of letters establishes its offset; the characters either side of
    // it at that same offset are the same stamp if they are the same letter,
    // even where the estimate has drifted — in a long item glued onto the end
    // of a stamp, its last letter can be estimated a quarter em out.
    if (letters.length >= 2 && offset !== null) {
      const fits = (j) => {
        const c = j + offset;
        if (j < 0 || j >= g.str.length || c < from || c >= to || g.str[j] !== o.str[c] || along.has(j)) return false;
        return [EVEN, PROPORTIONAL].some((m) => {
          const eg = characterEdges(g, m);
          const eo = characterEdges(o, m);
          return Math.abs((eo[c] + eo[c + 1]) / 2 - (eg[j] + eg[j + 1]) / 2) <= 2 * reach;
        });
      };
      for (let j = run[0] - 1; fits(j); j -= 1) { along.set(j, { c: j + offset, strict: false }); accepted.push(j); }
      for (let j = run[run.length - 1] + 1; fits(j); j += 1) { along.set(j, { c: j + offset, strict: false }); accepted.push(j); }
    }
  }
  let first = null;
  accepted.forEach((j) => {
    if (flags[j]) return;
    flags[j] = 1;
    const { c } = along.get(j);
    if (!first || j < first.j) first = { j, c };
  });
  return first ? { marked, first } : null;
}

export function textItemShadows(items) {
  const list = Array.isArray(items) ? items : [];
  const cached = shadowCache.get(list);
  if (cached && cached.start.length === list.length) return cached;
  const n = list.length;
  const shadows = {
    start: new Int32Array(n),
    end: new Int32Array(n),
    origin: new Int32Array(n),
    originCh: new Int32Array(n),
    model: new Uint8Array(n)
  };
  const { start, end, origin, originCh, model } = shadows;
  // The most recent items, { index, g } — stamps included. Stamps are drawn
  // around the true position, and two on opposite sides of it are twice as far
  // from each other as either is from the truth; comparing each new stamp with
  // the ones before it as well as with the first keeps a ring of them linked.
  const window = [];
  for (let i = 0; i < n; i += 1) {
    const item = list[i];
    const str = typeof item?.str === "string" ? item.str : "";
    start[i] = 0;
    end[i] = str.length;
    origin[i] = i;
    const g = shadowGeometry(item);
    if (!g) continue;
    const reach = g.size * TEXT_SHADOW_RADIUS;
    const flags = new Uint8Array(str.length);
    let firstHit = -1;
    let hitItem = -1;
    let hitCh = 0;
    const byModel = [0, 0];
    for (let w = window.length - 1; w >= 0; w -= 1) {
      const { index: k, g: o } = window[w];
      // Cheapest first: almost every item in the window is on another line.
      if (g.flat && o.flat && Math.abs(g.t[5] - o.t[5]) > reach) continue;
      if (!nearlyEqual(o.t[0], g.t[0]) || !nearlyEqual(o.t[1], g.t[1])
        || !nearlyEqual(o.t[2], g.t[2]) || !nearlyEqual(o.t[3], g.t[3])) continue;
      if ((list[k].dir || "ltr") !== (item.dir || "ltr")) continue;
      if (!g.flat || !o.flat) {
        // Not upright text: only a whole-item stamp of a wholly kept item.
        if (o.str === str && (start[k] >= end[k] || (start[k] === 0 && end[k] === o.str.length))
          && Math.hypot(g.t[4] - o.t[4], g.t[5] - o.t[5]) <= Math.min(reach, g.width > 0 ? g.width * 0.5 : reach)) {
          flags.fill(1);
          firstHit = 0; hitItem = k; hitCh = 0;
          break;
        }
        continue;
      }
      if (Math.abs(g.t[5] - o.t[5]) > reach) continue;
      // Neighbouring text meets end to start; a stamp sits on top of what it
      // copies. Less than a tenth of an em of overlap between the two items'
      // real extents is never a stamp — the narrowest letter a lone-letter
      // stamp is accepted on overlaps by more (see loneLetterOverlaps) — and
      // ruling it out here is what keeps a dense page fast. A stamped space is
      // too narrow to overlap that much and is one character to check, so it
      // only has to be within reach.
      const overlap = Math.min(g.t[4] + g.width, o.t[4] + o.width) - Math.max(g.t[4], o.t[4]);
      if (overlap <= (g.blank ? -reach : g.size * TEXT_SHADOW_MIN_OVERLAP)) continue;
      const hit = stampedCharacters(g, o, k, shadows, flags, reach);
      if (!hit) continue;
      byModel[EVEN] += hit.marked[EVEN];
      byModel[PROPORTIONAL] += hit.marked[PROPORTIONAL];
      if (firstHit < 0 || hit.first.j < firstHit) {
        firstHit = hit.first.j;
        hitItem = k;
        hitCh = hit.first.c;
      }
    }
    if (firstHit >= 0) {
      model[i] = byModel[PROPORTIONAL] > byModel[EVEN] ? PROPORTIONAL : EVEN;
      // Stamped characters at either end are trimmed; what is left between
      // them is kept, a space beside a stamp included. All of it stamped is a
      // stamp of text already read.
      let lead = 0;
      while (lead < str.length && flags[lead]) lead += 1;
      let tail = str.length;
      while (tail > lead && flags[tail - 1]) tail -= 1;
      if (lead >= tail) {
        start[i] = 0;
        end[i] = 0;
        // A stamp of a stamp is a stamp of what that one stamps.
        const via = start[hitItem] >= end[hitItem];
        origin[i] = via ? origin[hitItem] : hitItem;
        originCh[i] = (via ? originCh[hitItem] : 0) + hitCh - firstHit;
        window.push({ index: i, g });
        if (window.length > TEXT_SHADOW_WINDOW) window.shift();
        continue;
      }
      // A stamped letter between two kept ones is not what a stamp produces,
      // and the item is kept whole rather than guessed at.
      let middle = false;
      for (let j = lead; j < tail; j += 1) if (flags[j] && !/\s/.test(str[j])) { middle = true; break; }
      if (!middle) {
        start[i] = lead;
        end[i] = tail;
      }
    }
    window.push({ index: i, g });
    if (window.length > TEXT_SHADOW_WINDOW) window.shift();
  }
  shadowCache.set(list, shadows);
  return shadows;
}

// The part of item `index` that reads as text, as an item of its own: the item
// itself when all of it does, null when it is all a stamp of something already
// read, and otherwise a copy carrying only the kept slice — its str, and its
// origin and width moved to where that slice sits — so textItemGap and
// textItemBox see the characters that are actually being read.
export function keptTextItem(items, index, shadows = textItemShadows(items)) {
  const item = items?.[index];
  if (!item || !item.str) return item || null;
  const from = shadows.start[index];
  const to = shadows.end[index];
  if (from === 0 && to === item.str.length) return item;
  if (from >= to) return null;
  const g = shadowGeometry(item);
  const edges = g ? characterEdges(g, shadows.model[index]) : null;
  const t = item.transform.slice();
  const x0 = edges ? edges[from] : t[4];
  const x1 = edges ? edges[to] : t[4];
  t[4] = x0;
  return { ...item, str: item.str.slice(from, to), transform: t, width: x1 - x0, keptFrom: from };
}

// An anchor that sits on a stamp, read as the character it stamps; one in the
// stamped part of a partly kept item, moved to the edge of what is kept.
export function settleTextAnchor(items, point, shadows = textItemShadows(items)) {
  if (!point || !(point.item >= 0) || point.item >= shadows.start.length) return point;
  const i = point.item;
  const from = shadows.start[i];
  const to = shadows.end[i];
  const ch = Number(point.ch) || 0;
  if (from >= to && items[i]?.str) {
    const k = shadows.origin[i];
    const mapped = shadows.originCh[i] + ch;
    return { ...point, item: k, ch: Math.max(shadows.start[k], Math.min(shadows.end[k], mapped)) };
  }
  if (ch < from || ch > to) return { ...point, ch: Math.max(from, Math.min(to, ch)) };
  return point;
}

export function isShadowTextItem(items, index) {
  const shadows = textItemShadows(items);
  return index >= 0 && index < shadows.start.length && Boolean(items[index]?.str) && shadows.start[index] >= shadows.end[index];
}

// The one cleanup every reader of a pdf.js text item goes through: collapse the
// whitespace, and drop what a database column cannot store. A glyph whose cmap
// maps to 0 puts a U+0000 straight into item.str, and one of those anywhere in
// a deck fails that deck's entire sync (see stripInvalidUnicode) — invisibly,
// because it renders as nothing at all.
export function cleanPdfItemText(value) {
  return stripInvalidUnicode(String(value ?? "")).replace(/\s+/g, " ").trim();
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
//
// Overprinted copies (textItemShadows) are left out, exactly as the text layer
// leaves out their spans, and an anchor that sits on one is read from the item
// it copies. `{ shadows: "keep" }` reads them in, which is what the layer did
// before it knew about them — repairDocumentHighlightText uses that to
// recognise a highlight stored with every underlined word eleven times over.
export function textForAnchorRange(items, anchor, focus, { shadows = "drop" } = {}) {
  if (!Array.isArray(items) || !anchor || !focus) return "";
  if (anchor.page !== focus.page) return "";
  const sh = shadows === "keep" ? null : textItemShadows(items);
  const a = sh ? settleTextAnchor(items, anchor, sh) : anchor;
  const f = sh ? settleTextAnchor(items, focus, sh) : focus;
  const forwards = a.item < f.item || (a.item === f.item && a.ch <= f.ch);
  const from = forwards ? a : f;
  const to = forwards ? f : a;
  if (!items[from.item] || !items[to.item]) return "";
  // [first, last) of item i's str that reads as text, in the item's own
  // character offsets — which is what an anchor's ch counts in.
  const first = (i) => (sh ? sh.start[i] : 0);
  const last = (i) => (sh ? sh.end[i] : String(items[i].str || "").length);
  if (from.item === to.item) {
    return cleanPdfItemText(String(items[from.item].str || "").slice(Math.max(from.ch, first(from.item)), Math.min(to.ch, last(from.item))));
  }
  let out = String(items[from.item].str || "").slice(Math.max(from.ch, first(from.item)), last(from.item));
  // `previous` is the last item that CONTRIBUTED, not items[i - 1]: an item with
  // an empty str emits no span, so buildTextLayer never writes a separator for
  // it either, and the two have to agree about that as well.
  let previous = sh ? keptTextItem(items, from.item, sh) || items[from.item] : items[from.item];
  for (let i = from.item + 1; i <= to.item; i += 1) {
    const item = items[i];
    if (!item || !item.str) continue;
    const kept = sh ? keptTextItem(items, i, sh) : item;
    if (!kept) {
      // As the text layer does: a stamp that ends a line still ends it.
      if (item.hasEOL) previous = item;
      continue;
    }
    out += textItemGap(previous, kept);
    out += String(item.str).slice(first(i), i === to.item ? Math.min(to.ch, last(i)) : last(i));
    previous = kept;
  }
  return cleanPdfItemText(out);
}

// The text a set of quads covers, plus the { item, ch } the first of them
// starts at — used to give a highlight imported from the PDF's own annotations
// the same shape as one made in this app. `items` is
// page.getTextContent().items for the quads' page.
export function textForQuads(items, quads) {
  let out = "";
  let previous = null;
  let anchorItem = null;
  const sh = textItemShadows(items);
  items.forEach((item, index) => {
    if (!item.str) return;
    const kept = keptTextItem(items, index, sh);
    if (!kept) {
      if (item.hasEOL && previous) previous = item;
      return;
    }
    const box = textItemBox(kept);
    if (!quads.some((quad) => boxesIntersect(box, quad.rect))) return;
    if (anchorItem === null) anchorItem = index;
    // The same join as the text layer, so an imported highlight over a word
    // set in two fonts reads as one word, as a highlight made here does.
    out += textItemGap(previous, kept) + kept.str;
    previous = kept;
  });
  return {
    text: cleanPdfItemText(out),
    item: anchorItem === null ? 0 : anchorItem
  };
}
