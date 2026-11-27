// The Canvas as data, for the web page export (src/export/canvas-html.js).
//
// The web page draws the Canvas faithfully, but a drawing is a poor thing for
// a program to read: an arrow is a path that happens to end at a Block, a text
// box is words in a box with no name, a group is nothing at all. So the page
// also carries the Canvas itself, as JSON, in
//
//   <script type="application/json" id="recall-canvas-data">
//
// for whatever reads the page next — a video tool turning a board into a
// film, a search, an import. It is what is STORED (meta.pdfBlocks and
// meta.pdfHighlights), put in the page's own terms:
//
//   • every length is in points of the page, from its top-left corner, y down
//     — the page's <svg viewBox> — so the JSON and the drawing agree;
//   • every id is the record's own, and is on the page too: a Block's
//     data-pdf-block, a text box's and a connector label's data-shape-id, a
//     shape's <g data-shape-id> in the page's svg;
//   • a picture is NOT copied in again: its Block's <img> in the page is it.
//
//   { format: "recall.canvas", version: 1, title,
//     pages:      [{ n, index, size: [w, h], box: [x0, y0, x1, y1], fit,
//                    paper: { pattern, color } }],
//     blocks:     [{ id, page, kind, x, y, w, h, rot, z, md, alt, picture,
//                    style, group, from }],
//     connectors: [{ id, page, type, from, to, route, heads, label, points,
//                    stroke, dash, group }],
//     shapes:     [{ id, page, type, x, y, w, h, rot, text, stroke, fill,
//                    group }],
//     ink:        [{ id, page, bbox, colors, highlighter, strokes }],
//     groups:     [{ id, members }] }
//
// `rot` is degrees counter-clockwise, as it is stored and as it is seen.
// `page` is the page's number within the export (1, 2, …), `pages[].n` its
// number on the Canvas.
//
// Pure: it imports only leaves, so tools/canvas-data-check.mjs can drive it in
// Node.

import { connectorPath, normalizeShape, shapeTextRect } from "../render/annot-shapes.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { isHighlighterToken } from "../format/ink-colors.js?v=__BUILD__";

export const CANVAS_DATA_FORMAT = "recall.canvas";
export const CANVAS_DATA_VERSION = 1;
export const CANVAS_DATA_ID = "recall-canvas-data";

// The most points a stroke of the pen keeps in the data: enough to tell a
// circle from an underline, not a copy of the hand.
const INK_POINTS_MAX = 48;

const dataRound = (n) => Math.round((Number(n) || 0) * 100) / 100;

function compactEntry(object) {
  const out = {};
  Object.entries(object).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return;
    out[key] = value;
  });
  return out;
}

function thin(points, most) {
  if (points.length <= most) return points;
  const out = [];
  const step = (points.length - 1) / (most - 1);
  for (let i = 0; i < most; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

// `pages`: [{ n, setup, box: [x0, y0, x1, y1] }] in export order — `box` the
// part of the page drawn (PDF space, y up), `setup` its sheet setup
// (sheetSetupForPage, src/documents/canvas-setup.js). `blocks` and `marks`
// are the Canvas's records (every page; those on no exported page are left
// out).
export function canvasData({ title = "", pages = [], blocks = [], marks = [] } = {}) {
  const out = {
    format: CANVAS_DATA_FORMAT,
    version: CANVAS_DATA_VERSION,
    title: String(title || ""),
    pages: [],
    blocks: [],
    connectors: [],
    shapes: [],
    ink: [],
    groups: []
  };
  const where = new Map();
  pages.forEach((page, i) => {
    const [x0, y0, x1, y1] = (Array.isArray(page.box) ? page.box : [0, 0, 595, 842]).map(Number);
    const index = i + 1;
    where.set(Number(page.n) || index, { index, x0, y1 });
    const setup = page.setup && typeof page.setup === "object" ? page.setup : {};
    out.pages.push(compactEntry({
      n: Number(page.n) || index,
      index,
      size: [dataRound(x1 - x0), dataRound(y1 - y0)],
      box: [x0, y0, x1, y1].map(dataRound),
      fit: setup.fit || "",
      paper: compactEntry({ pattern: setup.pattern || "", color: setup.paper || setup.color || "" })
    }));
  });
  const placeOf = (rec) => where.get(Number(rec?.page) || 1) || null;
  // A point of the page (PDF space, y up) in the page's own terms.
  const pt = (place, [x, y]) => [dataRound(x - place.x0), dataRound(place.y1 - y)];
  const groups = new Map();
  const joinGroup = (group, id) => {
    if (typeof group !== "string" || !group) return;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(id);
  };

  blocks.forEach((block) => {
    const place = block && block.id ? placeOf(block) : null;
    if (!place) return;
    const w = Number(block.w) || 0;
    const h = Number(block.h) || 0;
    const image = block.kind === "image";
    out.blocks.push(compactEntry({
      id: String(block.id),
      page: place.index,
      kind: image ? "image" : "text",
      x: dataRound((Number(block.x) || 0) - place.x0),
      y: dataRound(place.y1 - ((Number(block.y) || 0) + h)),
      w: dataRound(w),
      h: dataRound(h),
      rot: dataRound(block.rot) || 0,
      z: Number(block.z) || 0,
      md: image ? "" : String(block.md || ""),
      alt: String(block.alt || ""),
      // The picture is the Block's <img> on the page, not a second copy here.
      picture: image ? `[data-pdf-block="${String(block.id)}"] img` : "",
      style: block.style && typeof block.style === "object" ? { ...block.style } : null,
      group: typeof block.group === "string" ? block.group : "",
      from: typeof block.from === "string" ? block.from : ""
    }));
    joinGroup(block.group, String(block.id));
  });

  marks.forEach((rec) => {
    const place = rec && rec.id ? placeOf(rec) : null;
    if (!place) return;
    if (rec.kind === "ink") {
      const strokes = decodeInkStrokes(rec.ink?.s);
      if (!strokes.length) return;
      let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
      const lines = strokes.map((stroke) => {
        const points = [];
        for (let i = 0; i + 1 < stroke.p.length; i += 3) {
          const p = pt(place, [stroke.p[i], stroke.p[i + 1]]);
          points.push(p);
          minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
        }
        return { width: dataRound(stroke.w), color: String(stroke.c || ""), points: thin(points, INK_POINTS_MAX) };
      });
      out.ink.push(compactEntry({
        id: String(rec.id),
        page: place.index,
        bbox: [minX, minY, maxX, maxY].map(dataRound),
        colors: [...new Set(lines.map((line) => line.color).filter(Boolean))],
        highlighter: strokes.every((stroke) => isHighlighterToken(stroke.c)),
        strokes: lines,
        group: typeof rec.group === "string" ? rec.group : ""
      }));
      joinGroup(rec.group, String(rec.id));
      return;
    }
    if (rec.kind !== "shape") return;
    const shape = normalizeShape(rec.shape);
    if (!shape) return;
    const id = String(rec.id);
    const group = typeof rec.group === "string" ? rec.group : "";
    joinGroup(group, id);
    if (shape.type === "line" || shape.type === "arrow") {
      const end = (i) => {
        const tie = shape.ends?.[i];
        return tie ? compactEntry({ id: tie.id, side: tie.side, at: tie.at || null }) : null;
      };
      // Which way it points: an arrow's head says so; a plain line is
      // undirected (heads none at both ends).
      out.connectors.push(compactEntry({
        id,
        page: place.index,
        type: shape.type,
        from: end(0),
        to: end(1),
        route: shape.route || "straight",
        heads: shape.heads.slice(),
        label: shape.text.trim(),
        points: connectorPath(shape).map((point) => pt(place, point)),
        stroke: shape.stroke,
        dash: shape.dash,
        group
      }));
      return;
    }
    const [rx0, ry0, rx1, ry1] = shapeTextRect(shape);
    const [left, top] = pt(place, [rx0, ry1]);
    const entry = {
      id,
      page: place.index,
      type: shape.type,
      x: left,
      y: top,
      w: dataRound(rx1 - rx0),
      h: dataRound(ry1 - ry0),
      rot: shape.rot || 0,
      text: shape.text.trim() || String(rec.note || rec.text || "").trim(),
      stroke: shape.stroke,
      fill: shape.fill,
      group
    };
    // A callout points at something: where its leader ends.
    if (shape.type === "callout" && shape.p[2]) entry.target = pt(place, shape.p[2]);
    out.shapes.push(compactEntry(entry));
  });

  out.groups = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([id, members]) => ({ id, members }));
  return out;
}

// The data as the text of a <script type="application/json">: nothing in it
// can close the element or start a comment, whatever the Canvas says.
export function canvasDataScript(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/json" id="${CANVAS_DATA_ID}">${json}</script>`;
}
