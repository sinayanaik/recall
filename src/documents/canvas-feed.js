// ── To the Canvas ─────────────────────────────────────────────────────────
//
// Blocks made from what the reader has already picked out elsewhere in the
// file: the Notes' highlights, a PDF's highlights (the words of a text
// highlight; a live picture of a ▣ region's spot, which is only a reference
// — a `pdfref:` — nothing copied), and the Cards (a question Block, an arrow,
// an answer Block, grouped). Sized as the Canvas will draw them, stacked down
// the page under whatever is already on the last page, onto new pages when
// that one fills (src/documents/canvas-flow.js), as one undo step.
//
// Two ways in. The ⋯ / Cards buttons put a list of the part's items through
// the picker (src/documents/canvas-feed-dialog.js) and then here, at the end of
// the Canvas; a drag from the part beside onto a Canvas page
// (src/documents/canvas-drop.js) puts one item where it is let go.
//
// Each Block made here carries `from` — "notes:<key>", "pdf:<highlight id>",
// "card:<card id>" (normalizeBlocks, src/documents/pdf-blocks.js) — which is
// how the picker knows what is on the Canvas already. A Block deleted from the
// Canvas takes its `from` with it, and its item is new again.
//
// Code names: the Canvas is the `notebook` slot, the Cards `state.masterCards`.

import { state } from "../core/state.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { codeFences, codeHighlightSnippet } from "../format/code-highlight.js?v=__BUILD__";
import { decodeInkStrokes, inkStrokesBounds } from "../format/ink-strokes.js?v=__BUILD__";
import { scanHighlightGroups } from "../panels/highlights-panel.js?v=__BUILD__";
import { noteSectionModel } from "../panels/highlight-sections.js?v=__BUILD__";
import { notesAnchorPlainText } from "../notes/anchor-text.js?v=__BUILD__";
import { activeDocSlot, deckHasHandwrittenPages, DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, recordDocSlot } from "./doc-slot.js?v=__BUILD__";
import { deckPdfs, recordPdfId } from "./pdf-multi.js?v=__BUILD__";
import { parsePdfRef, pdfRegionRefForRecord } from "./pdf-region-embed.js?v=__BUILD__";
import {
  allDocumentBlocks, blockNaturalWidth, blockPageBounds, buildStaticBlock, documentBlocks,
  freshDocumentBlockId, nextBlockZ, PDF_BLOCK_MARKDOWN, runDiagramEdit, writeDocumentBlocks
} from "./pdf-blocks.js?v=__BUILD__";
import { canvasBlockMeasurePercent, canvasBlockWidthMode, canvasDropWidthPercent, CANVAS_BLOCK_WIDTH_BALANCED } from "./block-measure.js?v=__BUILD__";
import { canvasItemKind, canvasSizedMarkdown, escapePlainMarkdown } from "./canvas-sizing.js?v=__BUILD__";
import { cardArrowShape, readCardCanvasStyle } from "./card-canvas-style.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { BLOCK_FILLS, BLOCK_SHAPE_DEFAULT, compactBlockStyle } from "./block-style.js?v=__BUILD__";
import { blockStylePreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { appendNotebookPages, hasNotebook, notebookPageCount, notebookPageSetup } from "./notebook.js?v=__BUILD__";
import { sheetBox } from "./canvas-setup.js?v=__BUILD__";
import { applyDocumentRecordChanges, documentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { newConnectorBase, newShapeRecord } from "./pdf-shapes.js?v=__BUILD__";
import { diagramNodes, resolveConnector } from "./pdf-connectors.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
import { flowContentBox, flowItemExtent, flowOntoCanvas, flowPlaceFromTopLeft, flowWidths, lowestEdge, placeAtPoint } from "./canvas-flow.js?v=__BUILD__";
import { pdfPageElement, scrollToDocumentPage, whenDocumentPageReady } from "./pdf-view.js?v=__BUILD__";
import { focusPart, openSplitPart, setViewMode } from "../ui/view-mode.js?v=__BUILD__";
import { isDocumentPartMode } from "../ui/split-parts.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// The drag-and-drop type an item travels under (src/documents/canvas-drop.js).
export const CANVAS_ITEM_MIME = "application/x-recall-item";

// ── Items ─────────────────────────────────────────────────────────────────
//
// { from, kind: "text" | "ref" | "pair", md, q, a, color, label, preview }
//   from     the key a Block made from it carries
//   label    where it is: a heading of the Notes, "p. 4", "Card 3"
//   preview  one line for the picker

// A short stable hash of a string, for an item with no id of its own.
function feedKeyHash(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function feedPreviewLine(text, max = 120) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// A highlight's colour as a Block's fill, when there is one by that name.
function feedFillFor(color) {
  const name = String(color || "").toLowerCase();
  if (name === "purple") return "violet";
  if (name === "orange") return "yellow";
  return BLOCK_FILLS.includes(name) && name !== "paper" && name !== "clear" ? name : "";
}

// A mark's inner markdown without any <mark> inside it.
function feedUnmark(md) {
  return String(md || "").replace(/<\/?mark\b[^>]*>/gi, "").trim();
}

// The Notes' highlights, in reading order — one item per highlight, however
// many paragraphs it crosses (one <mark> per paragraph: a group).
export function notesHighlightItems() {
  const notes = state.notes || "";
  const source = readerNotesBody(notes);
  const { groups } = scanHighlightGroups(source, notes);
  const sections = noteSectionModel(source);
  const fences = codeFences(source);
  const items = [];
  groups.forEach((group) => {
    const first = group.pieces[0];
    const snippet = fences.length ? codeHighlightSnippet(source, fences, first.start, group.end) : null;
    const md = snippet?.markdown ? feedUnmark(snippet.markdown) : group.pieces.map((piece) => feedUnmark(piece.inner)).filter(Boolean).join("\n\n");
    const text = notesAnchorPlainText(md) || md;
    if (!md.trim()) return;
    const heading = sections.headingAt(group.offset);
    items.push({
      from: `notes:${first.noteRef || feedKeyHash(text)}`,
      kind: "text",
      md,
      color: group.color || first.color || MARK_HIGHLIGHT_DEFAULT,
      label: heading?.title || "",
      preview: feedPreviewLine(text),
      // Which rendered <mark>s are this highlight — its ordinals among the
      // Notes' marks (scanMarks), for a highlight dragged from beside.
      marks: group.pieces.map((piece) => piece.markIndex)
    });
  });
  return items;
}

// The highlight a rendered <mark> of the Notes is part of, by its ordinal.
export function notesHighlightItemForMark(markIndex) {
  return notesHighlightItems().find((item) => item.marks.includes(markIndex)) || null;
}

// A PDF highlight, by its record — what one dragged from beside carries.
export function pdfHighlightItem(recordId) {
  return pdfHighlightItems(null).find((item) => item.from === `pdf:${recordId}`) || null;
}

function feedRecordTop(record) {
  const quad = (record.quads || []).find((q) => Array.isArray(q?.rect));
  return quad ? Math.max(Number(quad.rect[1]) || 0, Number(quad.rect[3]) || 0) : 0;
}

function feedRecordLeft(record) {
  const quad = (record.quads || []).find((q) => Array.isArray(q?.rect));
  return quad ? Math.min(Number(quad.rect[0]) || 0, Number(quad.rect[2]) || 0) : 0;
}

// The PDFs' highlights — a text run's words, a region's spot — of one PDF
// (`pdfId`) or of all of them (null), in the PDFs' order, then page by page,
// down each page. Ink and shapes are not highlights and are left out.
export function pdfHighlightItems(pdfId = null) {
  const pdfs = deckPdfs(state.meta);
  const rank = new Map(pdfs.map((entry, index) => [entry.id, index]));
  const several = pdfs.length > 1;
  const nameOf = (id) => {
    const entry = pdfs.find((pdf) => pdf.id === id);
    return String(entry?.title || entry?.name || "").replace(/\.pdf$/i, "");
  };
  const list = (Array.isArray(state.meta?.pdfHighlights) ? state.meta.pdfHighlights : [])
    .filter((record) => record && recordDocSlot(record) === DOC_SLOT_DOC)
    .filter((record) => record.kind === "text" || record.kind === "area" || !record.kind)
    .filter((record) => !pdfId || recordPdfId(record) === pdfId);
  list.sort((a, b) => (rank.get(recordPdfId(a)) ?? 99) - (rank.get(recordPdfId(b)) ?? 99)
    || (Number(a.page) || 0) - (Number(b.page) || 0)
    || feedRecordTop(b) - feedRecordTop(a)
    || feedRecordLeft(a) - feedRecordLeft(b));
  const items = [];
  list.forEach((record) => {
    const page = Number(record.page) || 1;
    const where = `p. ${page}`;
    const label = several && !pdfId ? `${nameOf(recordPdfId(record))} · ${where}` : where;
    if (record.kind === "area") {
      const md = pdfRegionRefForRecord(record);
      if (!md) return;
      items.push({ from: `pdf:${record.id}`, kind: "ref", md, color: record.color || MARK_HIGHLIGHT_DEFAULT, label, preview: `Region · ${where}` });
      return;
    }
    const text = String(record.text || "").trim();
    if (!text) return;
    items.push({ from: `pdf:${record.id}`, kind: "text", md: escapePlainMarkdown(text), color: record.color || MARK_HIGHLIGHT_DEFAULT, label, preview: feedPreviewLine(text) });
  });
  return items;
}

// The Cards, in their order: each a question and its answer.
export function cardItems() {
  const cards = Array.isArray(state.masterCards) ? state.masterCards : [];
  return cards
    .filter((card) => card && (String(card.question || "").trim() || String(card.answer || "").trim()))
    .map((card, index) => ({
      from: `card:${card.id}`,
      kind: "pair",
      q: String(card.question || "").trim(),
      a: String(card.answer || "").trim(),
      label: `Card ${index + 1}`,
      preview: feedPreviewLine(notesAnchorPlainText(card.question) || card.question)
    }));
}

// One card, by id — what a card dragged from the Cards carries.
export function cardItem(cardId) {
  return cardItems().find((item) => item.from === `card:${cardId}`) || null;
}

// The keys already on the Canvas.
export function keysOnCanvas() {
  const keys = new Set();
  allDocumentBlocks().forEach((block) => {
    if (block?.from && recordDocSlot(block) === DOC_SLOT_NOTEBOOK) keys.add(block.from);
  });
  return keys;
}

// ── The Canvas on screen ──────────────────────────────────────────────────
//
// Everything below writes through the open paper (documentBlocks, the undo
// ring, the page views), so the Canvas is brought up first: beside the part
// the reader is on where there is room for two, in its place where there is
// not, and made the live paper if a PDF is beside it.

const feedPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCanvasLive(pages = 1, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (activeDocSlot() === DOC_SLOT_NOTEBOOK && hasNotebook() && pdfPageElement(Math.max(1, pages))) return true;
    // eslint-disable-next-line no-await-in-loop
    await feedPause(60);
  }
  return false;
}

export async function bringCanvasUp() {
  if (state.viewMode === "handwriting") {
    // already in focus
  } else if (state.splitPart === "handwriting") {
    if (isDocumentPartMode(state.viewMode)) focusPart("handwriting");
  } else if (openSplitPart("handwriting")) {
    // Beside a PDF, the two are papers and only one is live: a paper opened
    // beside hands the focus back to the one the reader was on once it has
    // drawn (openDocumentBeside), so the Canvas takes it here — noted while it
    // opens, and kept when it is done.
    if (isDocumentPartMode(state.splitPart)) focusPart("handwriting");
  } else {
    setViewMode("handwriting");
  }
  if (!deckHasHandwrittenPages()) {
    // No pages yet: the Canvas is started, on this device's last page setup,
    // exactly as its own "Start a Canvas" does.
    const { enterHandwritingView } = await import("../handwriting/board.js?v=__BUILD__");
    await feedPause(0);
    if (!(await enterHandwritingView({ create: true }))) return false;
  }
  return waitForCanvasLive(1);
}

// ── Sizes ─────────────────────────────────────────────────────────────────
//
// Each Block laid out off the page, in ◐ Canvas's type and under the width
// rule the page will then draw it by (blockNaturalWidth), so it goes down as
// big as it will be drawn. A region's picture is sized from its box.

function feedStandInViewport(box) {
  const [x0, y0, x1, y1] = box;
  return {
    scale: 1,
    viewBox: box,
    width: x1 - x0,
    height: y1 - y0,
    convertToViewportPoint: (x, y) => [x - x0, y1 - y],
    convertToPdfPoint: (x, y) => [x + x0, y1 - y]
  };
}

function feedMeasureHost(box) {
  const host = document.createElement("div");
  host.className = "region-block-host canvas-feed-measure";
  host.setAttribute("aria-hidden", "true");
  host.dataset.docSlot = DOC_SLOT_NOTEBOOK;
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(box[2] - box[0])}px;height:${Math.ceil(box[3] - box[1])}px;pointer-events:none;visibility:hidden;`;
  document.body.appendChild(host);
  return host;
}

function feedRefSize(md, cap) {
  const parsed = parsePdfRef(String(md).replace(/^!\[[^\]]*\]\(|\)$/g, ""));
  const rect = parsed?.rect;
  const rw = rect ? Math.abs(rect[2] - rect[0]) : 200;
  const rh = rect ? Math.abs(rect[3] - rect[1]) : 120;
  const w = Math.round(Math.max(120, Math.min(cap, rw)));
  return { w, h: Math.round(Math.max(24, w * (rh / Math.max(1, rw)) + 14)) };
}

// `fixed`: the Block is `cap` wide whatever its words want — a picture, which
// fills the width ◐ Canvas gives pictures. Otherwise as wide as the words want
// under the width rule, up to `cap`; `balanced` false for a listing or a table,
// which keep their lines.
async function measureFeedMarkdown(md, { cap, box, host, style, fixed = false, balanced = true }) {
  if (/^!\[[^\]]*\]\(pdfref:[^)]+\)$/.test(String(md).trim())) return feedRefSize(md, cap);
  const viewport = feedStandInViewport(box);
  const block = { id: "measure", page: 1, x: box[0], y: box[1], w: cap, h: 40, z: 0, kind: PDF_BLOCK_MARKDOWN, md, ...(style ? { style } : {}) };
  let node = null;
  try {
    node = await buildStaticBlock(block, viewport, { mountIn: host });
    let w = Math.round(cap);
    if (!fixed) {
      const code = /^\s*(```|~~~)/m.test(md);
      const balance = balanced && !code && canvasBlockWidthMode() === CANVAS_BLOCK_WIDTH_BALANCED;
      const natural = blockNaturalWidth(node, { scale: 1, cap, balanced: balance });
      w = Math.round(Math.min(cap, natural || cap));
    }
    node.style.width = `${w}px`;
    node.style.height = "auto";
    const body = node.querySelector(".pdf-block-body");
    if (body) { body.style.flex = "none"; body.style.overflow = "visible"; }
    const h = Math.ceil(node.getBoundingClientRect().height + 1);
    return { w, h: Math.max(16, h) };
  } catch (error) {
    console.warn("Could not measure a Block for the Canvas", error);
    return { w: Math.round(cap), h: 60 };
  } finally {
    node?.remove();
  }
}

// The Canvas page things are measured for: the page dropped on, or the last.
export function canvasPageGeometry(page = Math.max(1, notebookPageCount())) {
  const setup = notebookPageSetup(page);
  return { page, box: sheetBox(setup), margins: setup?.margins || {} };
}

// Each item measured for Canvas page `page` as it will be drawn there:
//
//   { item, md, style, kind, w, h, keepWidth }        a Block
//   { item, pair: [{ md, style, w, h }, ×2], stacked } a card
//
// Its sizes from where it came are taken off first (canvasSizedMarkdown), and
// its width comes from ◐ Canvas by its kind: words the measure, a picture
// "Pictures land at", a table, a listing or a diagram "Tables and code land
// at". Each takes the look of the last Block styled on the Canvas (`base`,
// latestCanvasBlockStyle); a card's halves then what was chosen in the Cards'
// picker's Style. `colours` (the picker's "Keep highlight colours") puts a
// highlight's colour over the fill.
export async function measureCanvasItems(items, { page, colours = false, cardStyle = readCardCanvasStyle(), base = latestCanvasBlockStyle() } = {}) {
  const list = (items || []).filter(Boolean);
  const geometry = canvasPageGeometry(page);
  const content = flowContentBox(geometry.box, geometry.margins);
  const widths = flowWidths(content);
  const pageWidth = geometry.box[2] - geometry.box[0];
  const share = (kind) => Math.max(80, Math.floor(pageWidth * canvasDropWidthPercent(kind) / 100));
  const single = Math.min(widths.single, Math.max(120, Math.floor(pageWidth * canvasBlockMeasurePercent() / 100)));
  const host = feedMeasureHost(geometry.box);
  const sized = [];
  try {
    for (const item of list) {
      if (item.kind === "pair") {
        const stacked = cardStyle.layout === "stacked";
        const cap = stacked ? single : widths.half;
        const halves = [];
        for (const [text, style] of [[item.q, cardStyle.q], [item.a, cardStyle.a]]) {
          const md = canvasSizedMarkdown(text || " ");
          const merged = { ...base, ...(style || {}) };
          const bag = Object.keys(merged).length ? merged : null;
          // eslint-disable-next-line no-await-in-loop
          const size = await measureFeedMarkdown(md, { cap, box: geometry.box, host, style: bag });
          halves.push({ md, style: bag, ...size });
        }
        sized.push({ item, pair: halves, stacked });
        continue;
      }
      const fill = colours ? feedFillFor(item.color) : "";
      const md = item.kind === "ref" ? item.md : canvasSizedMarkdown(item.md);
      const kind = item.kind === "ref" ? "ref" : canvasItemKind(md);
      const style = { ...base, ...(fill ? { fill } : {}), ...(kind === "picture" ? { imageWidth: 100 } : {}) };
      const bag = Object.keys(style).length ? style : null;
      let size;
      if (kind === "picture") {
        // eslint-disable-next-line no-await-in-loop
        size = await measureFeedMarkdown(md, { cap: Math.min(widths.single, share("picture")), box: geometry.box, host, style: bag, fixed: true });
      } else if (kind === "code" || kind === "table" || kind === "diagram") {
        // eslint-disable-next-line no-await-in-loop
        size = await measureFeedMarkdown(md, { cap: Math.min(widths.single, share(kind)), box: geometry.box, host, style: bag, balanced: false });
      } else {
        // eslint-disable-next-line no-await-in-loop
        size = await measureFeedMarkdown(md, { cap: single, box: geometry.box, host, style: bag });
      }
      // A picture, a region's picture, a listing, a table and a diagram keep
      // the width they were laid out at; words follow their words.
      sized.push({ item, md, style: bag, kind, keepWidth: kind !== "text", ...size });
    }
  } finally {
    host.remove();
  }
  return { page: geometry.page, box: geometry.box, sized, cardStyle };
}

// The Block records (and, for a card, the arrow's two ends) one measured entry
// becomes at `place` — what placeOnCanvas writes, and what the drop preview
// draws before it is let go.
export function canvasEntryRecords(entry, place, { newId = freshDocumentBlockId } = {}) {
  const { item } = entry;
  if (entry.pair) {
    const group = freshFeedGroupId();
    const qId = newId();
    const aId = newId();
    const [q, a] = entry.pair;
    return {
      blocks: [
        feedBlockRecord({ id: qId, page: place.page, ...place.parts[0], w: q.w, h: q.h, md: q.md, style: q.style, from: item.from, group, keepWidth: true }),
        feedBlockRecord({ id: aId, page: place.page, ...place.parts[1], w: a.w, h: a.h, md: a.md, style: a.style, from: item.from, group, keepWidth: true })
      ],
      arrow: { page: place.page, q: qId, a: aId, group, stacked: entry.stacked }
    };
  }
  const id = newId();
  return {
    blocks: [feedBlockRecord({ id, page: place.page, x: place.x, y: place.y, w: entry.w, h: entry.h, md: entry.md, style: entry.style, from: item.from, keepWidth: entry.keepWidth })],
    arrow: null
  };
}

// The drop preview's own drawing of an entry: its Blocks as the page will draw
// them — the same records, the same renderer (buildStaticBlock) — at the page's
// scale, into `host`, its top-left corner at the host's. A card's arrow is a
// straight stand-in for the connector the drop makes, in its colour, thickness
// and dashes. Resolves to the host.
export async function renderCanvasPreview(entry, scale, host, { arrowStyle = null } = {}) {
  const item = flowItemFor(entry);
  const { w, h } = flowItemExtent(item);
  const place = flowPlaceFromTopLeft(item, 1, 0, h);
  let n = 0;
  const { blocks, arrow } = canvasEntryRecords(entry, place, { newId: () => `preview-${n += 1}` });
  const viewport = {
    scale,
    viewBox: [0, 0, w, h],
    width: w * scale,
    height: h * scale,
    convertToViewportPoint: (x, y) => [x * scale, (h - y) * scale],
    convertToPdfPoint: (x, y) => [x / scale, h - y / scale]
  };
  host.replaceChildren();
  for (const block of blocks) {
    // eslint-disable-next-line no-await-in-loop
    await buildStaticBlock(block, viewport, { mountIn: host });
  }
  if (arrow) {
    const [q, a] = blocks;
    const shape = cardArrowShape(newConnectorBase(), arrowStyle);
    const from = entry.stacked ? [q.x + q.w / 2, q.y] : [q.x + q.w, q.y + q.h / 2];
    const to = entry.stacked ? [a.x + a.w / 2, a.y + a.h] : [a.x, a.y + a.h / 2];
    const [x1, y1] = viewport.convertToViewportPoint(...from);
    const [x2, y2] = viewport.convertToViewportPoint(...to);
    const width = Math.max(1, (Number(shape.width) || 1.6) * scale);
    const dash = shape.dash === "dash" ? `${width * 3} ${width * 2}` : shape.dash === "dot" ? `${width} ${width * 1.6}` : "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "canvas-drop-ghost-arrow");
    svg.setAttribute("width", String(w * scale));
    svg.setAttribute("height", String(h * scale));
    svg.innerHTML = `<defs><marker id="cdg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${shape.stroke}"/></marker></defs>`
      + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${shape.stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}${(shape.heads || [])[1] && shape.heads[1] !== "none" ? ' marker-end="url(#cdg-head)"' : ""}/>`;
    host.appendChild(svg);
  }
  return host;
}

// The look of the last Block styled on this device (blockStylePreference,
// src/storage/ink-prefs.js) — what a Block made from + Add or typed onto the
// page starts with, and so what everything put on the Canvas from elsewhere
// starts with too. Only what differs from a plain Block; its shape never
// (a diagram's box is not a Block's look).
export function latestCanvasBlockStyle() {
  const bag = compactBlockStyle(blockStylePreference("text"));
  delete bag.fit;
  if (bag.shape && bag.shape !== BLOCK_SHAPE_DEFAULT) delete bag.shape;
  return bag;
}

// What canvas-flow.js lays out for a measured entry.
export function flowItemFor(entry) {
  return entry.pair ? { pair: entry.pair, stacked: entry.stacked } : { w: entry.w, h: entry.h };
}

// ── Putting them down ─────────────────────────────────────────────────────

// Everything on Canvas page `page`, as boxes: Blocks, ink, shapes, typed words.
function canvasThingsOnPage(page) {
  const rects = documentBlocks(page).map(blockPageBounds);
  documentHighlights().forEach((record) => {
    if (Number(record?.page) !== page) return;
    const quads = (record.quads || []).filter((quad) => Array.isArray(quad?.rect) && (!quad.page || Number(quad.page) === page));
    if (quads.length) { quads.forEach((quad) => rects.push(quad.rect.map(Number))); return; }
    const bounds = record.ink?.s ? inkStrokesBounds(decodeInkStrokes(record.ink.s)) : null;
    if (bounds) rects.push([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);
  });
  return rects;
}

// `fit`: the width is the words' and follows them as the page draws them; a
// card's halves are laid out side by side at the widths measured here, so their
// widths are kept (`wHand`) and only their heights follow the words.
function feedBlockRecord({ id, page, x, y, w, h, md, from, style = null, group = null, fit = true, keepWidth = false }) {
  return {
    id, page, x, y, w, h,
    z: nextBlockZ(),
    kind: PDF_BLOCK_MARKDOWN,
    md,
    at: Date.now(),
    ...(style && Object.keys(style).length ? { style: { ...style } } : {}),
    ...(fit && !keepWidth ? { wFit: true, wBal: true } : {}),
    ...(keepWidth ? { wHand: true } : {}),
    ...(from ? { from } : {}),
    ...(group ? { group } : {})
  };
}

function freshFeedGroupId() {
  return `gp-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

// Put `items` on the Canvas. With `at` ({ page, x, y }, a drop — the top-left
// corner the drop's preview showed) the one item goes there; without, every
// item goes at the end. Each takes the last Block's look; `colours` (the
// picker's "Keep highlight colours") puts each highlight's colour over its fill. `measured` is measureCanvasItems' answer when the caller has one
// already (a drop measured while it was dragged). Resolves to the ids made, or
// null.
export async function placeOnCanvas(items, { at = null, colours = false, quiet = false, measured = null } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  if (!at && !(await bringCanvasUp())) {
    showToast("Could not open the Canvas", "error");
    return null;
  }
  if (documentViewOnly(DOC_SLOT_NOTEBOOK)) {
    showToast("The Canvas is View only — turn ✎ on to add Blocks", "info");
    return null;
  }
  const lastPage = Math.max(1, notebookPageCount());
  const targetPage = at ? Number(at.page) || 1 : lastPage;
  const sizes = measured && measured.page === targetPage && measured.sized?.length === list.length
    ? measured
    : await measureCanvasItems(list, { page: targetPage, colours });
  const { sized, box, cardStyle } = sizes;
  const geometry = canvasPageGeometry(targetPage);
  let places;
  if (at) {
    places = [placeAtPoint({ box: box || geometry.box, at, item: flowItemFor(sized[0]) })];
  } else {
    const flow = flowOntoCanvas({
      pages: [geometry],
      lowest: lowestEdge(canvasThingsOnPage(lastPage)),
      items: sized.map(flowItemFor)
    });
    places = flow.places;
    if (flow.newPages) {
      if (!(await appendNotebookPages(flow.newPages))) return null;
      if (!(await waitForCanvasLive(lastPage + flow.newPages))) {
        showToast("Could not open the Canvas's new pages", "error");
        return null;
      }
    }
  }
  // Everything below writes through the live paper. Never onto a PDF.
  if (activeDocSlot() !== DOC_SLOT_NOTEBOOK && !(await waitForCanvasLive(1, 3000))) {
    showToast("Could not open the Canvas", "error");
    return null;
  }
  const madeBlocks = [];
  const madeArrows = [];
  runDiagramEdit(() => {
    const blocks = [];
    sized.forEach((entry, index) => {
      const place = places[index];
      if (!place) return;
      const made = canvasEntryRecords(entry, place);
      blocks.push(...made.blocks);
      madeBlocks.push(...made.blocks.map((block) => block.id));
      if (made.arrow) madeArrows.push(made.arrow);
    });
    writeDocumentBlocks([...documentBlocks(), ...blocks]);
    const arrows = madeArrows.map(({ page, q, a, group, stacked }) => {
      const shape = resolveConnector({
        ...cardArrowShape(newConnectorBase(), cardStyle?.arrow), type: "arrow", p: [[0, 0], [1, 1]],
        ends: stacked ? [{ id: q, side: "bottom" }, { id: a, side: "top" }] : [{ id: q, side: "right" }, { id: a, side: "left" }]
      }, diagramNodes(page));
      const record = shape ? newShapeRecord(page, shape) : null;
      return record ? { ...record, group } : null;
    }).filter(Boolean);
    if (arrows.length) applyDocumentRecordChanges({ put: arrows });
    madeArrows.splice(0, madeArrows.length, ...arrows.map((record) => record.id));
  });
  if (!madeBlocks.length) return null;
  const firstPage = places[0]?.page || lastPage;
  if (!at) {
    whenDocumentPageReady(firstPage).catch(() => {});
    scrollToDocumentPage(firstPage, 0, { smooth: true });
  }
  // A drop is its own answer: the Block is where it was let go, and Ctrl+Z
  // takes it back. The end of the Canvas may be out of view, so that says so.
  if (!quiet && !at) {
    const pagesUsed = [...new Set(places.map((place) => place.page))];
    const where = pagesUsed.length > 1 ? `pages ${pagesUsed[0]}–${pagesUsed[pagesUsed.length - 1]}` : `page ${pagesUsed[0]}`;
    const count = madeBlocks.length;
    const ids = new Set(madeBlocks);
    const arrowIds = [...madeArrows];
    const message = `${count} Block${count === 1 ? "" : "s"} on the Canvas, ${where}`;
    // A toast with these very words already up is an earlier batch's, and
    // showToast would only renew it — with ITS Undo. That one goes first.
    document.querySelectorAll(".toast").forEach((node) => {
      if (node.dataset.message === message) node.dispatchEvent(new CustomEvent("toast-dismiss"));
    });
    showToast(message, "success", {
      action: { label: "Undo", onClick: () => takeBackFromCanvas(ids, arrowIds) }
    });
  }
  return { blocks: madeBlocks, arrows: madeArrows };
}

// The toast's Undo: the Blocks and arrows just made, gone again (and back with
// Ctrl+Y, being one step of the Canvas's own undo).
async function takeBackFromCanvas(ids, arrowIds) {
  if (activeDocSlot() !== DOC_SLOT_NOTEBOOK && !(await bringCanvasUp())) return;
  runDiagramEdit(() => {
    writeDocumentBlocks(documentBlocks().filter((block) => !ids.has(block.id)), { removed: [...ids] });
    if (arrowIds.length) applyDocumentRecordChanges({ remove: arrowIds });
  });
}
