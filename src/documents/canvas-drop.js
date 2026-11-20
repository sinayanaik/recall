// ── Dragged onto the Canvas from beside ───────────────────────────────────
//
// With the Canvas side by side with the Notes, a PDF or the Cards, what is
// dragged across and let go of over a Canvas page becomes Blocks there, its
// top-left corner where it was let go (placeOnCanvas, ./canvas-feed.js):
//
//   - a selection, from the Notes (as markdown, maths and code kept) or from a
//     PDF's words — the browser's own drag of a selection;
//   - a highlight, pressed and dragged: a <mark> of the Notes, a text run or a
//     ▣ region of a PDF (a region goes as a live picture of its spot);
//   - a card, by its ⠿ grip — its question, an arrow and its answer;
//   - words or a picture from anywhere else (another app, a web page).
//
// HTML5 drag and drop, which a touch screen does not do: there, the selection
// bar and a highlight's menu have "To the Canvas", which puts it at the end.
// The data travels as CANVAS_ITEM_MIME (JSON of the item), with text/plain
// beside it for anything else it is dropped on.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { CANVAS_ITEM_MIME, cardItem, notesHighlightItemForMark, pdfHighlightItem, placeOnCanvas } from "./canvas-feed.js?v=__BUILD__";
import { notebookPageSetup } from "./notebook.js?v=__BUILD__";
import { sheetBox } from "./canvas-setup.js?v=__BUILD__";
import { documentHighlightAtPoint } from "./pdf-highlights.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
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

// A point over a Canvas page, in that page's own points — from the page's box
// on screen and its setup, so the Canvas need not be the live paper to ask.
function canvasDropPoint(pageEl, clientX, clientY) {
  const page = Number(pageEl.dataset.pageNumber) || 1;
  const [x0, y0, x1, y1] = sheetBox(notebookPageSetup(page));
  const rect = pageEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    page,
    x: x0 + ((clientX - rect.left) / rect.width) * (x1 - x0),
    y: y1 - ((clientY - rect.top) / rect.height) * (y1 - y0)
  };
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

function onCanvasDragStart(event) {
  const dt = event.dataTransfer;
  if (!dt) return;
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  // A highlight armedSource by the press above, or a card's grip.
  const armedSource = target?.closest?.("[data-canvas-item]");
  if (armedSource) {
    dt.setData(CANVAS_ITEM_MIME, armedSource.dataset.canvasItem);
    try {
      const item = JSON.parse(armedSource.dataset.canvasItem);
      dt.setData("text/plain", item.kind === "pair" ? `${item.q}\n\n${item.a}` : item.md || "");
    } catch { /* the item alone */ }
    dt.effectAllowed = "copy";
    return;
  }
  const grip = target?.closest?.("#cardCanvasGripBtn");
  if (grip) {
    const card = state.cards?.[state.current];
    const item = card ? cardItem(card.id) : null;
    if (!item) { event.preventDefault(); return; }
    dt.setData(CANVAS_ITEM_MIME, JSON.stringify(item));
    dt.setData("text/plain", `${item.q}\n\n${item.a}`);
    dt.effectAllowed = "copy";
    return;
  }
  // A selection of the Notes: its markdown, so maths and code survive.
  if (el.notesView?.contains(target) && !canvasDragSelectionEmpty()) {
    const md = String(currentNotesSelectionMarkdown() || "").trim();
    if (md) dt.setData(CANVAS_ITEM_MIME, JSON.stringify({ kind: "text", md, from: "" }));
  }
}

// ── Over a Canvas page ────────────────────────────────────────────────────

let canvasDropOverPage = null;

function markCanvasDropPage(page) {
  if (canvasDropOverPage === page) return;
  canvasDropOverPage?.classList.remove("is-canvas-drop-target");
  canvasDropOverPage = page;
  canvasDropOverPage?.classList.add("is-canvas-drop-target");
}

function canvasDropCarries(dt) {
  const types = Array.from(dt?.types || []);
  return types.includes(CANVAS_ITEM_MIME) || types.includes("text/plain") || types.includes("text/html") || dragContainsImage(dt);
}

// Only a drop the Canvas is not the part in focus for, or one carrying an
// item or words: a picture dropped onto the Canvas in focus is the page's own
// (src/main.js, handwritingImageDrop), as it always was.
function canvasDropIsOurs(dt) {
  const types = Array.from(dt?.types || []);
  if (types.includes(CANVAS_ITEM_MIME) || types.includes("text/plain") || types.includes("text/html")) return !types.includes("Files") || types.includes(CANVAS_ITEM_MIME);
  return dragContainsImage(dt) && state.viewMode !== "handwriting";
}

function onCanvasDragOver(event) {
  const page = canvasDropPageAt(event.target);
  if (!page || !canvasDropCarries(event.dataTransfer) || !canvasDropIsOurs(event.dataTransfer)) { markCanvasDropPage(null); return; }
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  markCanvasDropPage(page);
}

function onCanvasDragLeave(event) {
  if (canvasDropOverPage && !canvasDropOverPage.contains(event.relatedTarget)) markCanvasDropPage(null);
}

function canvasItemFromTransfer(dt) {
  const own = dt.getData(CANVAS_ITEM_MIME);
  if (own) {
    try { return JSON.parse(own); } catch { /* fall through to the words */ }
  }
  const plain = dt.getData("text/plain") || "";
  const html = Array.from(dt.types || []).includes("text/html") ? dt.getData("text/html") : "";
  let md = "";
  if (html && typeof TurndownService !== "undefined") md = htmlToMarkdown(html);
  else if (html) ensureTurndown();
  if (!md.trim()) md = plain;
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
  markCanvasDropPage(null);
  disarmCanvasDrag();
  const dt = event.dataTransfer;
  if (!page || !dt || !canvasDropIsOurs(dt)) return;
  event.preventDefault();
  event.stopPropagation();
  if (documentViewOnly(DOC_SLOT_NOTEBOOK)) {
    showToast("View only — press ✎ to add to the page", "info");
    return;
  }
  // Read everything off the drag before anything awaits: the transfer is
  // emptied once the event is over.
  const at = canvasDropPoint(page, event.clientX, event.clientY);
  const files = dragContainsImage(dt) && !Array.from(dt.types || []).includes(CANVAS_ITEM_MIME) ? Array.from(allImageFiles(dt) || []) : [];
  const item = files.length ? null : canvasItemFromTransfer(dt);
  if (!at || (!item && !files.length)) return;
  if (!(await makeCanvasLiveForDrop())) return;
  if (files.length) {
    const { addHandwritingImages } = await import("../handwriting/board.js?v=__BUILD__");
    addHandwritingImages(files, at);
    return;
  }
  await placeOnCanvas([item], { at });
}

let canvasDropWired = false;

export function initCanvasDrop() {
  if (canvasDropWired) return;
  canvasDropWired = true;
  // Capture, ahead of the document's own image drop (src/main.js), which
  // stands aside for a page of a Canvas that is not in focus.
  document.addEventListener("pointerdown", onCanvasDragPointerDown, true);
  document.addEventListener("dragstart", onCanvasDragStart, true);
  document.addEventListener("dragover", onCanvasDragOver, true);
  document.addEventListener("dragleave", onCanvasDragLeave, true);
  document.addEventListener("drop", onCanvasDrop, true);
  document.addEventListener("dragend", () => { markCanvasDropPage(null); disarmCanvasDrag(); }, true);
  document.addEventListener("pointerup", () => { if (canvasDragArmed) setTimeout(disarmCanvasDrag, 0); }, true);
}
