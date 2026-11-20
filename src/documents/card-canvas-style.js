// How a card looks when it goes onto the Canvas — its question Block, its
// answer Block and the arrow between — chosen in the Cards' "To the Canvas"
// picker (src/documents/canvas-feed-dialog.js) before Add, and used again by a
// card dragged by its grip. One per device, in localStorage: it is how this
// reader likes their cards laid out, not something about a file.
//
//   q, a     a Block style bag (./block-style.js), stored compact — {} is a
//            Block as every Block has always been
//   arrow    { color, width, dash, head, route } — each empty one follows the
//            connector the Shapes tool would draw (newConnectorBase)
//   layout   "side" (question left, answer right) or "stacked" (question
//            above, answer under it)
//
// Pure apart from the two storage calls, so tools/canvas-feed-check.mjs can
// check the normaliser from Node.

import { compactBlockStyle } from "./block-style.js?v=__BUILD__";
import { INK_PEN_HEX } from "../format/ink-colors.js?v=__BUILD__";
import { SHAPE_DASHES, SHAPE_HEADS } from "../render/annot-shapes.js?v=__BUILD__";

export const CARD_CANVAS_STYLE_STORE = "recall_card_canvas_style_v1";

export const CARD_CANVAS_LAYOUTS = ["side", "stacked"];
export const CARD_ARROW_ROUTES = ["straight", "elbow", "curve"];

export const CARD_CANVAS_STYLE_DEFAULT = Object.freeze({
  q: {},
  a: {},
  arrow: { color: "", width: null, dash: "", head: "", route: "" },
  layout: "side"
});

function arrowWidth(value) {
  const number = parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? Math.min(40, Math.round(number * 10) / 10) : null;
}

export function normalizeCardCanvasStyle(raw) {
  const from = raw && typeof raw === "object" ? raw : {};
  const arrow = from.arrow && typeof from.arrow === "object" ? from.arrow : {};
  return {
    q: compactBlockStyle(from.q),
    a: compactBlockStyle(from.a),
    arrow: {
      color: Object.prototype.hasOwnProperty.call(INK_PEN_HEX, arrow.color) ? arrow.color : "",
      width: arrowWidth(arrow.width),
      dash: SHAPE_DASHES.includes(arrow.dash) ? arrow.dash : "",
      head: SHAPE_HEADS.includes(arrow.head) ? arrow.head : "",
      route: CARD_ARROW_ROUTES.includes(arrow.route) ? arrow.route : ""
    },
    layout: CARD_CANVAS_LAYOUTS.includes(from.layout) ? from.layout : "side"
  };
}

// What the arrow's style changes on a connector the Shapes tool would make
// (`base`, newConnectorBase): only what was chosen.
export function cardArrowShape(base, arrow) {
  const a = normalizeCardCanvasStyle({ arrow }).arrow;
  const out = { ...base };
  if (a.color) out.stroke = INK_PEN_HEX[a.color];
  if (a.width) out.width = a.width;
  if (a.dash) out.dash = a.dash;
  if (a.head) out.heads = ["none", a.head];
  if (a.route === "straight") delete out.route;
  else if (a.route) out.route = a.route;
  return out;
}

export function readCardCanvasStyle() {
  try {
    const raw = localStorage.getItem(CARD_CANVAS_STYLE_STORE);
    return normalizeCardCanvasStyle(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeCardCanvasStyle(null);
  }
}

export function writeCardCanvasStyle(style) {
  const next = normalizeCardCanvasStyle(style);
  try { localStorage.setItem(CARD_CANVAS_STYLE_STORE, JSON.stringify(next)); } catch { /* this session only */ }
  return next;
}
