// ── Dragged onto the Canvas ───────────────────────────────────────────────
//
// What is dragged over a Canvas page and let go of there becomes Blocks, at
// the place a preview showed while it was dragged (placeOnCanvas,
// ./canvas-feed.js):
//
//   - a selection, from the Notes (as markdown, maths and code kept) or from a
//     PDF's words (as words, the lines of the page joined);
//   - a highlight, pressed and dragged: a <mark> of the Notes, a text run or a
//     ▣ region of a PDF (a region goes as a live picture of its spot);
//   - a card, by its ⠿ grip — its question, an arrow and its answer, in the
//     card style chosen in the Cards' "To the Canvas" picker;
//   - a whole picture, listing, table, diagram or heading of the Notes, by the
//     ⠿ grip that comes up beside it (./notes-grip.js);
//   - words, a selection or a picture from anywhere else — a web page, another
//     PDF reader, another app — read the same way: a page's HTML as markdown
//     (headings, lists, tables, code and pictures kept), bare words as a PDF's
//     words, a picture file as a picture Block.
//
// Whatever it is, it lands the size the Canvas gives its kind, not the size it
// had where it came from (canvasSizedMarkdown, ./canvas-sizing.js; ◐ Canvas →
// Blocks), in the look of the last Block styled on the Canvas
// (latestCanvasBlockStyle), and where its preview was: the preview IS the
// Block, drawn by the page's own renderer, following the pointer — kept on
// the page and settling onto the edges and middles of the Blocks already there
// (snapMove, src/render/snap-guides.js) — and the browser's own faded picture
// of what is dragged is hidden, so it is the one thing that moves.
//
// The parts beside the Canvas, or the Canvas in focus: a drop on a Canvas page
// is read here either way. HTML5 drag and drop, which a touch screen does not
// do: there, the selection bar and a highlight's menu have "To the Canvas",
// which puts it at the end. An item travels as CANVAS_ITEM_MIME (JSON of the
// item), with text/plain beside it for anything else it is dropped on.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { CANVAS_ITEM_MIME, cardItem, flowItemFor, measureCanvasItems, notesHighlightItemForMark, pdfHighlightItem, placeOnCanvas, renderCanvasPreview } from "./canvas-feed.js?v=__BUILD__";
import { pdfPlainToMarkdown } from "./canvas-sizing.js?v=__BUILD__";
import { canvasBlockMeasurePercent, canvasDropWidthPercent } from "./block-measure.js?v=__BUILD__";
import { clampTopLeft, flowItemExtent, FLOW_PAIR_GAP } from "./canvas-flow.js?v=__BUILD__";
import { blockPageBounds, blocksForPaper } from "./pdf-blocks.js?v=__BUILD__";
import { snapMove } from "../render/snap-guides.js?v=__BUILD__";
import { notebookPageSetup } from "./notebook.js?v=__BUILD__";
import { sheetBox } from "./canvas-setup.js?v=__BUILD__";
import { documentHighlightAtPoint } from "./pdf-highlights.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
import { initNotesGrip, notesElementItem, notesGripTarget } from "./notes-grip.js?v=__BUILD__";
import { isPartShown } from "../ui/split-parts.js?v=__BUILD__";
import { focusPart } from "../ui/view-mode.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { allImageFiles, dragContainsImage } from "../images/paste.js?v=__BUILD__";
import { htmlToMarkdown } from "../import/html-to-markdown.js?v=__BUILD__";
import { ensureTurndown } from "../core/lib-loader.js?v=__BUILD__";
import { headingNumbersOn, stripTypedHeadingNumbersFromMarkdown } from "../notes/heading-numbers.js?v=__BUILD__";
import { currentNotesSelectionMarkdown } from "../notes/selection.js?v=__BUILD__";

// A Canvas page under a point, when the Canvas is on screen, or null.
function canvasDropPageAt(target) {
  const page = target?.closest?.(".pdf-page[data-page-number]");
  if (!page) return null;
  const stage = page.closest("#documentStage, #documentStageAlt");
  return stage && stage.dataset.docSlot === DOC_SLOT_NOTEBOOK ? page : null;
}

// Whether the Canvas is beside the part a drag starts in.
function canvasIsBeside() {
  return Boolean(state.splitPart) && isPartShown("handwriting") && state.viewMode !== state.splitPart;
}

// A Canvas page's box in its own points and its scale on screen, from the
// page's box on screen and its setup — so the Canvas need not be the live
// paper to ask.
function canvasPageFrame(pageEl) {
  const page = Number(pageEl.dataset.pageNumber) || 1;
  const box = sheetBox(notebookPageSetup(page));
  const rect = pageEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { page, box, rect, scale: rect.width / (box[2] - box[0]) };
}

// A point over a Canvas page, in that page's own points.
function canvasDropPoint(frame, clientX, clientY) {
  const [x0, , , y1] = frame.box;
  return {
    page: frame.page,
    x: x0 + (clientX - frame.rect.left) / frame.scale,
    y: y1 - (clientY - frame.rect.top) / frame.scale
  };
}

// ── What is being dragged ─────────────────────────────────────────────────
//
// A drag that started in this page carries its item from its first moment, and
// is measured for the page it is over while it is dragged, so the preview is
// the Block's own size. One from another app or window can be read only when
// it is let go; until then its preview is the size of its kind, from the
// transfer's types.

let dragItem = null;
// A drag that started on a Canvas page itself (a picture's own drag): not
// something to put on it again.
let dragFromCanvas = false;
// { key: page number, result } — measureCanvasItems' answer for that page.
let dragMeasure = null;
let dragMeasuring = null;

function setDragItem(item) {
  dragItem = item || null;
  dragMeasure = null;
  dragMeasuring = null;
}

function measureDragFor(page) {
  if (!dragItem || dragMeasure?.key === page || dragMeasuring === page) return;
  dragMeasuring = page;
  const item = dragItem;
  measureCanvasItems([item], { page }).then((result) => {
    if (dragItem !== item) return;
    dragMeasure = { key: page, result };
    dragMeasuring = null;
    if (ghostState?.frame?.page === page) paintGhost(ghostState.frame, ghostState.clientX, ghostState.clientY, ghostState.kind);
  }).catch(() => { dragMeasuring = null; });
}

// ── Starting a drag ───────────────────────────────────────────────────────

let canvasDragArmed = null;

function disarmCanvasDrag() {
  if (!canvasDragArmed) return;
  canvasDragArmed.removeAttribute("draggable");
  delete canvasDragArmed.dataset.canvasItem;
  canvasDragArmed = null;
}

function canvasDragSelectionEmpty() {
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed || !String(selection).trim();
}

// A press on a highlight while the Canvas is beside: the highlight is made
// draggable for this one press, carrying its item. Without the Canvas beside
// nothing changes, and a press that starts a text selection still does so
// anywhere but on a highlight.
function onCanvasDragPointerDown(event) {
  disarmCanvasDrag();
  if (event.button !== 0 || event.pointerType === "touch" || !canvasIsBeside() || !canvasDragSelectionEmpty()) return;
  const target = event.target;
  // A <mark> of the Notes, as rendered (not while the Notes are typed in).
  const mark = target?.closest?.("mark");
  if (mark && el.notesView?.contains(mark) && !mark.isContentEditable) {
    const index = [...el.notesView.querySelectorAll("mark")].indexOf(mark);
    const item = index >= 0 ? notesHighlightItemForMark(index) : null;
    if (!item) return;
    mark.setAttribute("draggable", "true");
    mark.dataset.canvasItem = JSON.stringify(item);
    canvasDragArmed = mark;
    return;
  }
  // A PDF's highlight, under the text layer: found by its quads.
  if (state.viewMode === "document" && target?.closest?.("#documentStage, #documentStageAlt")?.dataset.docSlot === "doc") {
    const record = documentHighlightAtPoint(event.clientX, event.clientY, { skipInk: true });
    if (!record || (record.kind !== "text" && record.kind !== "area")) return;
    const item = pdfHighlightItem(record.id);
    const holder = target.closest(".pdf-text-layer span, .pdf-page");
    if (!item || !holder) return;
    holder.setAttribute("draggable", "true");
    holder.dataset.canvasItem = JSON.stringify(item);
    canvasDragArmed = holder;
  }
}

// Nothing under the pointer but the preview: the browser's own picture of
// what is dragged (the selection, the highlight, the element, faded) is
// swapped for an empty one, so over a Canvas page the Block that will be made
// is the one thing that moves. A drag from another app is drawn by that app
// and the system, and cannot be changed from here.
const BLANK_DRAG_IMAGE = typeof Image === "undefined" ? null : Object.assign(new Image(1, 1), {
  src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
});

function hideBrowserDragImage(dt) {
  if (!BLANK_DRAG_IMAGE) return;
  try { dt.setDragImage(BLANK_DRAG_IMAGE, 0, 0); } catch { /* the browser's own */ }
}

function carryCanvasItem(dt, item) {
  dt.setData(CANVAS_ITEM_MIME, JSON.stringify(item));
  dt.setData("text/plain", item.kind === "pair" ? `${item.q}\n\n${item.a}` : item.md || "");
  dt.effectAllowed = "copy";
  setDragItem(item);
  hideBrowserDragImage(dt);
}

function onCanvasDragStart(event) {
  setDragItem(null);
  const dt = event.dataTransfer;
  if (!dt) return;
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  dragFromCanvas = Boolean(canvasDropPageAt(target));
  if (dragFromCanvas) return;
  // A highlight armed by the press above.
  const armedSource = target?.closest?.("[data-canvas-item]");
  if (armedSource) {
    try {
      carryCanvasItem(dt, JSON.parse(armedSource.dataset.canvasItem));
    } catch { /* not an item after all */ }
    return;
  }
  // A card's grip.
  if (target?.closest?.("#cardCanvasGripBtn")) {
    const card = state.cards?.[state.current];
    const item = card ? cardItem(card.id) : null;
    if (!item) { event.preventDefault(); return; }
    carryCanvasItem(dt, item);
    return;
  }
  // The grip beside a whole thing of the Notes.
  if (target?.closest?.(".notes-canvas-grip")) {
    const thing = notesGripTarget();
    const item = thing ? notesElementItem(thing) : null;
    if (!item) { event.preventDefault(); return; }
    carryCanvasItem(dt, item);
    return;
  }
  if (!canvasIsBeside()) return;
  // A picture of the Notes dragged by itself: what the Notes say it is, not
  // the address the browser shows it from.
  if (target?.matches?.("img") && el.notesView?.contains(target) && canvasDragSelectionEmpty()) {
    const item = notesElementItem(target);
    if (item) carryCanvasItem(dt, item);
    return;
  }
  // A selection of the Notes: its markdown, so maths and code survive.
  if (el.notesView?.contains(target) && !canvasDragSelectionEmpty()) {
    const md = String(currentNotesSelectionMarkdown() || "").trim();
    if (md) {
      dt.setData(CANVAS_ITEM_MIME, JSON.stringify({ kind: "text", md, from: "" }));
      setDragItem({ kind: "text", md, from: "" });
      hideBrowserDragImage(dt);
    }
    return;
  }
  // A selection of a PDF's words: the words, the page's line ends joined —
  // as a PDF highlight goes, and as words from another PDF reader do.
  if (target?.closest?.("#documentStage, #documentStageAlt")?.dataset.docSlot === "doc" && !canvasDragSelectionEmpty()) {
    const md = pdfPlainToMarkdown(String(window.getSelection()));
    if (md) {
      dt.setData(CANVAS_ITEM_MIME, JSON.stringify({ kind: "text", md, from: "" }));
      setDragItem({ kind: "text", md, from: "" });
      hideBrowserDragImage(dt);
    }
  }
}

// ── Over a Canvas page ────────────────────────────────────────────────────

let canvasDropOverPage = null;

function markCanvasDropPage(page) {
  if (canvasDropOverPage === page) return;
  canvasDropOverPage?.classList.remove("is-canvas-drop-target");
  canvasDropOverPage = page;
  canvasDropOverPage?.classList.add("is-canvas-drop-target");
  if (!page) hideGhost();
}

function canvasDropCarries(dt) {
  const types = Array.from(dt?.types || []);
  return types.includes(CANVAS_ITEM_MIME) || types.includes("text/plain") || types.includes("text/html") || dragContainsImage(dt);
}

// Every drop of words, an item or a picture on a Canvas page is read here —
// the Canvas beside another part or in focus — so each gets the preview and
// the Canvas's sizes. Files that are not pictures are not ours.
function canvasDropIsOurs(dt) {
  if (dragFromCanvas) return false;
  const types = Array.from(dt?.types || []);
  if (types.includes(CANVAS_ITEM_MIME)) return true;
  if (dragContainsImage(dt)) return true;
  if (types.includes("Files")) return false;
  return types.includes("text/plain") || types.includes("text/html") || types.includes("text/uri-list");
}

// What an outside drag looks like it is, from its types alone.
function outsideKind(dt) {
  const types = Array.from(dt?.types || []);
  if (types.includes("Files") || (dragContainsImage(dt) && !types.includes("text/html"))) return "picture";
  return "text";
}

// ── The preview ───────────────────────────────────────────────────────────

let canvasDropGhost = null;
// { frame, clientX, clientY, kind, place: { page, left, top }, item }
let ghostState = null;

function ensureGhost() {
  if (canvasDropGhost) return canvasDropGhost;
  canvasDropGhost = document.createElement("div");
  canvasDropGhost.className = "canvas-drop-ghost";
  canvasDropGhost.setAttribute("aria-hidden", "true");
  canvasDropGhost.dataset.pageChrome = "";
  return canvasDropGhost;
}

function hideGhost() {
  canvasDropGhost?.remove();
  canvasDropGhost?.replaceChildren();
  ghostState = null;
  ghostDrawn = null;
}

// The measured entry for the item being dragged, over this page — or null.
function measuredEntry(frame) {
  return dragItem && dragMeasure?.key === frame.page ? dragMeasure.result?.sized?.[0] || null : null;
}

// The preview's item, in canvas-flow.js's terms: the measured item, or a box
// the size its kind will be.
function ghostFlowItem(frame, kind) {
  const entry = measuredEntry(frame);
  if (entry) return flowItemFor(entry);
  const pageWidth = frame.box[2] - frame.box[0];
  if (dragItem?.kind === "pair") {
    const half = Math.max(80, Math.floor((pageWidth * 0.62 - FLOW_PAIR_GAP) / 2));
    return { pair: [{ w: half, h: 48 }, { w: half, h: 48 }] };
  }
  if (kind === "picture") {
    const w = Math.round(pageWidth * canvasDropWidthPercent("picture") / 100);
    return { w, h: Math.round(w * 0.75) };
  }
  return { w: Math.round(Math.max(160, pageWidth * Math.min(40, canvasBlockMeasurePercent()) / 100)), h: 60 };
}

// Everything already on the page, as boxes — what the preview settles onto.
function boxesOnCanvasPage(page) {
  try {
    return blocksForPaper(DOC_SLOT_NOTEBOOK, null, page).map(blockPageBounds);
  } catch {
    return [];
  }
}

// What the preview is drawn as just now: the measured entry at a scale, so
// it is drawn once and then only moved.
let ghostDrawn = null;

function drawGhostBlock(node, entry, scale, arrowStyle) {
  if (ghostDrawn?.entry === entry && ghostDrawn.scale === scale) return;
  ghostDrawn = { entry, scale };
  node.replaceChildren();
  node.classList.add("is-rendered");
  const drawn = ghostDrawn;
  renderCanvasPreview(entry, scale, node, { arrowStyle }).catch(() => {
    if (ghostDrawn === drawn) node.classList.remove("is-rendered");
  });
}

function paintGhost(frame, clientX, clientY, kind) {
  const item = ghostFlowItem(frame, kind);
  const { w, h } = flowItemExtent(item);
  const at = canvasDropPoint(frame, clientX, clientY);
  let { left, top } = clampTopLeft({ box: frame.box, at, item });
  // Onto the edges and middles of the Blocks there, within 6 pixels on screen.
  const snap = snapMove([left, top - h, left + w, top], boxesOnCanvasPage(frame.page), { threshold: 6 / frame.scale });
  left += snap.dx;
  top += snap.dy;
  ({ left, top } = clampTopLeft({ box: frame.box, at: { x: left, y: top }, item }));
  ghostState = { frame, clientX, clientY, kind, place: { page: frame.page, x: left, y: top }, item };
  const node = ensureGhost();
  const pageEl = canvasDropOverPage;
  if (!pageEl) return;
  if (node.parentNode !== pageEl) pageEl.appendChild(node);
  const [x0, , , y1] = frame.box;
  const px = (v) => `${Math.round(v * frame.scale)}px`;
  node.style.left = px(left - x0);
  node.style.top = px(y1 - top);
  node.style.width = px(w);
  node.style.height = px(h);
  const entry = measuredEntry(frame);
  if (entry) {
    // The Block itself, as the page will draw it, in the look it will have.
    node.classList.remove("is-guess", "is-outline");
    drawGhostBlock(node, entry, frame.scale, dragMeasure.result.cardStyle?.arrow);
    return;
  }
  ghostDrawn = null;
  node.classList.remove("is-rendered");
  if (dragItem) {
    // Being measured: its outline only, for the moment that takes.
    node.classList.add("is-outline");
    node.classList.remove("is-guess");
    node.replaceChildren();
    return;
  }
  // From another app, which says what it is only when it is let go.
  node.classList.add("is-guess");
  node.classList.remove("is-outline");
  node.textContent = kind === "picture" ? "Picture" : "Words";
}

function onCanvasDragOver(event) {
  const page = canvasDropPageAt(event.target);
  if (!page || !canvasDropCarries(event.dataTransfer) || !canvasDropIsOurs(event.dataTransfer)) { markCanvasDropPage(null); return; }
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  markCanvasDropPage(page);
  const frame = canvasPageFrame(page);
  if (!frame) return;
  measureDragFor(frame.page);
  paintGhost(frame, event.clientX, event.clientY, dragItem ? "item" : outsideKind(event.dataTransfer));
}

function onCanvasDragLeave(event) {
  if (canvasDropOverPage && !canvasDropOverPage.contains(event.relatedTarget)) markCanvasDropPage(null);
}

// ── Reading what was let go ───────────────────────────────────────────────
//
// Everything is read off the transfer before anything awaits: it is emptied
// once the event is over. The reading itself (HTML to markdown) may wait for
// its converter, which is loaded on first use.

function transferStrings(dt) {
  const types = Array.from(dt.types || []);
  return {
    own: types.includes(CANVAS_ITEM_MIME) ? dt.getData(CANVAS_ITEM_MIME) : "",
    html: types.includes("text/html") ? dt.getData("text/html") : "",
    plain: types.includes("text/plain") ? dt.getData("text/plain") : "",
    uri: types.includes("text/uri-list") ? dt.getData("text/uri-list") : ""
  };
}

const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?$/i;

// A web page's HTML with nothing in it but markup round its words: what is
// left once the tags are gone. A selection copied off a page carries a
// <meta charset> and an empty <span> or two even when it is only words.
function htmlHasStructure(html) {
  return /<(?:h[1-6]|ul|ol|li|table|pre|code|img|blockquote|strong|b|em|i|a|br|p|div)\b/i.test(html);
}

export async function canvasItemFromStrings({ own, html, plain, uri }) {
  if (own) {
    try { return JSON.parse(own); } catch { /* fall through to the words */ }
  }
  let md = "";
  if (html && htmlHasStructure(html)) {
    if (typeof TurndownService === "undefined") await ensureTurndown();
    if (typeof TurndownService !== "undefined") md = htmlToMarkdown(html);
  }
  if (!md.trim() && plain.trim()) md = pdfPlainToMarkdown(plain);
  if (!md.trim()) {
    const link = String(uri || "").split(/\r?\n/).find((line) => line && !line.startsWith("#"));
    if (link && IMAGE_URL_RE.test(link.trim())) md = `![](${link.trim()})`;
    else if (link) md = `<${link.trim()}>`;
  }
  if (!md.trim()) return null;
  if (headingNumbersOn()) md = stripTypedHeadingNumbersFromMarkdown(md);
  return { kind: "text", md: md.trim(), from: "" };
}

// The Canvas made the live paper, so what is written goes onto it.
async function makeCanvasLiveForDrop() {
  if (activeDocSlot() === DOC_SLOT_NOTEBOOK) return true;
  if (state.splitPart === "handwriting") focusPart("handwriting");
  for (let i = 0; i < 40 && activeDocSlot() !== DOC_SLOT_NOTEBOOK; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return activeDocSlot() === DOC_SLOT_NOTEBOOK;
}

async function onCanvasDrop(event) {
  const page = canvasDropPageAt(event.target);
  const dt = event.dataTransfer;
  if (!page || !dt || !canvasDropIsOurs(dt)) { markCanvasDropPage(null); return; }
  event.preventDefault();
  event.stopPropagation();
  // Where the preview was — painted for this very point, if it was not yet.
  const frame = canvasPageFrame(page);
  if (frame && canvasDropOverPage !== page) markCanvasDropPage(page);
  if (frame) paintGhost(frame, event.clientX, event.clientY, dragItem ? "item" : outsideKind(dt));
  const place = ghostState?.place || null;
  const ghostItem = ghostState?.item || null;
  const measured = dragItem && dragMeasure?.key === frame?.page ? dragMeasure.result : null;
  const ownItem = dragItem;
  markCanvasDropPage(null);
  disarmCanvasDrag();
  setDragItem(null);
  if (documentViewOnly(DOC_SLOT_NOTEBOOK)) {
    showToast("View only — press ✎ to add to the page", "info");
    return;
  }
  if (!place || !frame) return;
  const types = Array.from(dt.types || []);
  const files = !types.includes(CANVAS_ITEM_MIME) && dragContainsImage(dt) ? Array.from(allImageFiles(dt) || []) : [];
  const strings = files.length ? null : transferStrings(dt);
  if (!(await makeCanvasLiveForDrop())) return;
  if (files.length) {
    const { addHandwritingImages } = await import("../handwriting/board.js?v=__BUILD__");
    const width = ghostItem && !ghostItem.pair ? ghostItem.w : (frame.box[2] - frame.box[0]) * canvasDropWidthPercent("picture") / 100;
    addHandwritingImages(files, { page: place.page, x: place.x, y: place.y }, { width });
    return;
  }
  const item = ownItem && strings.own ? ownItem : await canvasItemFromStrings(strings);
  if (!item) return;
  await placeOnCanvas([item], { at: place, measured: item === ownItem ? measured : null });
}

let canvasDropWired = false;

export function initCanvasDrop() {
  if (canvasDropWired) return;
  canvasDropWired = true;
  initNotesGrip();
  // Capture, ahead of the document's own picture drop (src/main.js), which a
  // drop on a Canvas page never reaches.
  document.addEventListener("pointerdown", onCanvasDragPointerDown, true);
  document.addEventListener("dragstart", onCanvasDragStart, true);
  document.addEventListener("dragover", onCanvasDragOver, true);
  document.addEventListener("dragleave", onCanvasDragLeave, true);
  document.addEventListener("drop", onCanvasDrop, true);
  document.addEventListener("dragend", () => { markCanvasDropPage(null); disarmCanvasDrag(); setDragItem(null); dragFromCanvas = false; }, true);
  document.addEventListener("pointerup", () => { if (canvasDragArmed) setTimeout(disarmCanvasDrag, 0); }, true);
}
