// A card of an AREA of a page — what was circled with the lasso, a Block picked
// up, several things picked up together — on a Canvas or a PDF.
//
// The card's answer is the same live picture a region drawn with ▣ gives
// (src/documents/pdf-region-embed.js): `pdfref:<page>:<box>`, naming the open
// PDF or, on a Canvas, CANVAS_REF_ID. Nothing is uploaded and nothing is baked:
// the picture is drawn from the page each time the card is shown, ink, shapes
// and blocks and all.
//
// The card panel itself (src/notes/frame-card.js) is handed in by src/main.js
// rather than imported — frame-card.js reaches the render pipeline, which
// reaches the document surface these buttons live on, so an import from here
// would close a cycle (the same reason setMarkMenuActions is registered).

import { state } from "../core/state.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { activePdfId } from "./pdf-multi.js?v=__BUILD__";
import { CANVAS_REF_ID, pdfRegionRefMarkdown } from "./pdf-region-embed.js?v=__BUILD__";

// The glyphs' and strokes' edges, kept — the pad pdfRegionRefForRecord gives a
// mark's bounds.
const AREA_PAD = 3;

let cardMaker = null;

export function setPageAreaCardMaker(fn) {
  cardMaker = typeof fn === "function" ? fn : null;
}

// The box as a ref and an anchor, or null for a box that is not one. Exported
// for tools/canvas-cards-check.mjs.
export function pageAreaCard({ page, rect, slot = activeDocSlot(), pdfId = null } = {}) {
  const pageNumber = Number(page);
  const box = Array.isArray(rect) ? rect.map(Number) : [];
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const round = (n) => Math.round(n * 100) / 100;
  const padded = [
    Math.min(box[0], box[2]) - AREA_PAD,
    Math.min(box[1], box[3]) - AREA_PAD,
    Math.max(box[0], box[2]) + AREA_PAD,
    Math.max(box[1], box[3]) + AREA_PAD
  ].map(round);
  const onCanvas = slot === DOC_SLOT_NOTEBOOK;
  const ref = pdfRegionRefMarkdown(pageNumber, padded, onCanvas ? CANVAS_REF_ID : (pdfId || activePdfId(state.meta)));
  const anchor = {
    pdf: { page: pageNumber, item: 0, ch: 0 },
    quads: [{ page: pageNumber, rect: padded }],
    page: pageNumber,
    ...(onCanvas ? { doc: DOC_SLOT_NOTEBOOK } : {}),
    text: `${onCanvas ? "Canvas" : "Region"} · page ${pageNumber}`,
    deckId: state.deckId,
    deckTitle: state.deckTitle
  };
  return { ref, anchor };
}

// Opens a "Make a card" panel whose answer is a live picture of the box, with
// `words` (a Block's own, say) under it. False when there was nothing to make
// a card of.
export function makeCardFromPageArea({ page, rect, slot, pdfId = null, words = "" } = {}) {
  const made = pageAreaCard({ page, rect, slot: slot || activeDocSlot(), pdfId });
  if (!made || !cardMaker) return false;
  const text = String(words || "").trim();
  cardMaker(text ? `${made.ref}\n\n${text}` : made.ref, made.anchor);
  return true;
}
