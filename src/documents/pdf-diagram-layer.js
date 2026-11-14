// One layer per page OVER everything on it, for the things a diagram draws
// about itself rather than on the page: a selected box's connect arrows, the
// box a dragged line end is about to be tied to, the frame round several things
// picked up at once, the marquee that picks them, and the guides a drag snaps
// to (src/documents/pdf-connectors.js, canvas-selection.js, pdf-guides.js).
//
// Above the blocks (styles/97-diagram.css), because every one of these is about
// a block as often as about anything else, and takes no pointer events itself:
// only the controls drawn in it do.
//
// Each feature owns a PART of the layer, by name, and replaces its own part
// without touching the others' — the guides of a drag do not wipe the connect
// arrows of the box being dragged.

import { el } from "../core/dom.js?v=__BUILD__";
import { pdfPageElement } from "./pdf-view.js?v=__BUILD__";

export const PDF_DIAGRAM_LAYER_CLASS = "pdf-diagram-layer";

export function diagramLayer(pageNumber, create = true) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return null;
  let layer = pageEl.querySelector(`:scope > .${PDF_DIAGRAM_LAYER_CLASS}`);
  if (!layer && create) {
    layer = document.createElement("div");
    layer.className = PDF_DIAGRAM_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  return layer;
}

// Replace a page's `part` with `nodes`. An empty list clears it, and does not
// make a layer for a page that has none.
export function setDiagramPart(pageNumber, part, nodes = []) {
  const layer = diagramLayer(pageNumber, nodes.length > 0);
  if (!layer) return;
  layer.querySelectorAll(`:scope > [data-diagram-part="${part}"]`).forEach((node) => node.remove());
  nodes.forEach((node) => {
    node.dataset.diagramPart = part;
    layer.appendChild(node);
  });
}

// ...on every page.
export function clearDiagramPart(part) {
  (el.documentView || document).querySelectorAll(`.${PDF_DIAGRAM_LAYER_CLASS} > [data-diagram-part="${part}"]`).forEach((node) => node.remove());
}

const DIAGRAM_SVG_NS = "http://www.w3.org/2000/svg";

// An SVG the size of the page, for outlines and lines drawn in page pixels.
export function diagramSvg(viewport, className) {
  const svg = document.createElementNS(DIAGRAM_SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("width", String(viewport.width));
  svg.setAttribute("height", String(viewport.height));
  svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

export function diagramSvgNode(tag, attributes = {}) {
  const node = document.createElementNS(DIAGRAM_SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

// PDF points onto page pixels, as a path's data.
export function diagramPathData(points, viewport, closed = false) {
  if (!points?.length) return "";
  const body = points.map(([x, y], i) => {
    const [sx, sy] = viewport.convertToViewportPoint(x, y);
    return `${i ? "L" : "M"}${sx.toFixed(1)} ${sy.toFixed(1)}`;
  }).join("");
  return closed ? `${body}Z` : body;
}
