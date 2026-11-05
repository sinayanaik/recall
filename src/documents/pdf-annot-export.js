// The PDF, saved with your marks in it as real PDF annotations.
//
// The other exports print the pages as pictures with the marks painted on
// (pdf-export.js), which is the right thing to hand to somebody who will read
// it. This is the file to hand to somebody who will go on WORKING on it — in
// Acrobat, Preview, Zotero, a tablet's PDF app: every highlight, underline,
// strike, squiggle, box, region, stroke of ink and shape becomes the annotation
// those readers use for it, so they can select it, move it, recolour it, read
// its note and reply to it. The paper itself is the stored file, byte for byte,
// with the annotations added to it; nothing is re-rendered.
//
//   text highlight          Highlight     (QuadPoints)
//   underline · strike      Underline · StrikeOut
//   squiggly                Squiggly
//   box round words         Square, one per line of the run
//   region                  Square, with its faint wash as the interior colour
//   ink                     Ink           (InkList, one path per stroke)
//   line · arrow            Line          (L, and LE for its heads)
//   rectangle · ellipse     Square · Circle
//   callout                 FreeText /FreeTextCallout (CL, RD)
//   text                    FreeText
//   sticky note             Text          (the note icon)
//   typed box · picture     Stamp         (its rendered picture as the
//                                          appearance, its words as Contents)
//
// A note on a mark is its annotation's Contents, with a Popup to show it in —
// except a callout's or a text box's, whose Contents is the words in the box;
// its note is a reply (a Text annotation, IRT) instead. Every annotation is
// stamped with the record's id (NM), its date (M) and an author (T), and given
// its own appearance stream (AP /N) — Preview and the browsers' viewers draw an
// annotation only from its appearance, and do not invent one from the
// dictionary the way Acrobat does.
//
// The file's OWN annotations — a Zotero highlight imported when the PDF was
// attached — are already in the bytes, and are not written a second time.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensurePdfLib } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { readHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { decodeInkStrokes } from "../format/ink-strokes.js?v=__BUILD__";
import { markGeometry, markStyleOf, normalizeMarkHex } from "../format/mark-styles.js?v=__BUILD__";
import { calloutStart, markdownToPlainText, normalizeShape, rectFromPoints, shapeBounds, shapeDashArray, shapeTextRect, shapeTextRotationMatrix } from "../render/annot-shapes.js?v=__BUILD__";
import { resolveInkPaint } from "../render/ink-paint.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { AREA_FILL_ALPHA, CUSTOM_HIGHLIGHT_ALPHA, blockPdfRect, highlightAlpha, rasteriseRegionBlocks, regionBlocksInBox } from "./pdf-region-marks.js?v=__BUILD__";
import { DOC_SLOT_DOC, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { documentHighlights } from "./pdf-highlights.js?v=__BUILD__";
import { shapeDrawList, shapeTextLines } from "./pdf-lib-shapes.js?v=__BUILD__";
import { activePdfId } from "./pdf-multi.js?v=__BUILD__";
import { currentDocumentBlob, currentPdfDocument, openDocumentPdfId } from "./pdf-view.js?v=__BUILD__";

export const ANNOT_AUTHOR = "Recall";

const LINE_ENDINGS = { none: "None", open: "OpenArrow", filled: "ClosedArrow", dot: "Circle", bar: "Butt" };

function hexRgb(hex) {
  const value = String(hex || "#000000");
  return [1, 3, 5].map((i) => Math.round((parseInt(value.slice(i, i + 2), 16) / 255) * 1000) / 1000);
}

function padAnnotRect(rect, by) {
  return [rect[0] - by, rect[1] - by, rect[2] + by, rect[3] + by];
}

function rectOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function quadRect(quad) {
  const [a, b, c, d] = quad.rect.map(Number);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

// ── Appearance streams ────────────────────────────────────────────────────
//
// Each appearance is a form XObject whose BBox is the annotation's Rect and
// whose matrix is the identity, so it is drawn in the page's own user space —
// the same space every record is stored in. Opacity and the multiply a tint is
// laid down with are graphics states, named per appearance.

function appearanceBuilder(doc) {
  const P = window.PDFLib;
  const ops = [];
  const states = {};
  let fonts = null;
  const stateFor = ({ stroke = 1, fill = 1, multiply = false }) => {
    const key = `G${Math.round(stroke * 100)}_${Math.round(fill * 100)}${multiply ? "m" : ""}`;
    if (!states[key]) {
      states[key] = doc.context.obj({ Type: "ExtGState", CA: stroke, ca: fill, ...(multiply ? { BM: "Multiply" } : {}) });
    }
    return key;
  };
  const path = (pts, closed) => {
    pts.forEach(([x, y], i) => ops.push(i ? P.lineTo(x, y) : P.moveTo(x, y)));
    if (closed) ops.push(P.closePath());
  };
  return {
    // A list of the shape primitives' polys (src/render/annot-shapes.js).
    poly(prim, { multiply = false } = {}) {
      if (!prim.pts?.length) return;
      ops.push(P.pushGraphicsState());
      ops.push(P.setGraphicsState(stateFor({ stroke: prim.opacity ?? 1, fill: prim.fill ? prim.fillOpacity : 1, multiply })));
      if (prim.fill) ops.push(P.setFillingRgbColor(...hexRgb(prim.fill)));
      const stroked = prim.width > 0;
      if (stroked) {
        ops.push(P.setStrokingRgbColor(...hexRgb(prim.stroke)));
        ops.push(P.setLineWidth(prim.width));
        ops.push(P.setLineJoin(P.LineJoinStyle.Round));
        if (prim.dash === "dot") ops.push(P.setLineCap(P.LineCapStyle.Round));
        const dash = shapeDashArray(prim.dash, prim.width);
        if (dash.length) ops.push(P.setDashPattern(dash, 0));
      }
      path(prim.pts, prim.closed);
      if (prim.fill && stroked) ops.push(P.fillAndStroke());
      else if (prim.fill) ops.push(P.fill());
      else ops.push(P.stroke());
      ops.push(P.popGraphicsState());
    },
    rect([x0, y0, x1, y1], hex, alpha, { multiply = false } = {}) {
      ops.push(P.pushGraphicsState());
      ops.push(P.setGraphicsState(stateFor({ fill: alpha, multiply })));
      ops.push(P.setFillingRgbColor(...hexRgb(hex)));
      path([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
      ops.push(P.fill());
      ops.push(P.popGraphicsState());
    },
    async text(prim) {
      if (!prim.text) return;
      if (!fonts) {
        fonts = {
          Helv: await doc.embedFont(P.StandardFonts.Helvetica),
          HeBo: await doc.embedFont(P.StandardFonts.HelveticaBold)
        };
      }
      const name = prim.bold ? "HeBo" : "Helv";
      const font = fonts[name];
      const turn = shapeTextRotationMatrix(prim);
      if (turn) ops.push(P.pushGraphicsState(), P.concatTransformationMatrix(...turn));
      shapeTextLines(prim, font).forEach((line) => {
        ops.push(P.beginText(), P.setFontAndSize(name, line.size), P.setFillingRgbColor(...hexRgb(prim.color)),
          P.moveText(line.x, line.y), P.showText(font.encodeText(line.text)), P.endText());
      });
      if (turn) ops.push(P.popGraphicsState());
    },
    form(rect) {
      const resources = { ExtGState: states };
      if (fonts) resources.Font = { Helv: fonts.Helv.ref, HeBo: fonts.HeBo.ref };
      const stream = doc.context.formXObject(ops, { BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources });
      return doc.context.register(stream);
    }
  };
}

// ── The dictionaries ──────────────────────────────────────────────────────

function baseAnnot(doc, record, subtype, rect, color, note) {
  const { PDFHexString, PDFString } = window.PDFLib;
  const dict = {
    Type: "Annot",
    Subtype: subtype,
    Rect: rect,
    F: 4,
    NM: PDFString.of(String(record.id)),
    M: PDFString.fromDate(new Date(record.at || Date.now())),
    T: PDFHexString.fromText(ANNOT_AUTHOR),
    C: hexRgb(color)
  };
  if (note) dict.Contents = PDFHexString.fromText(note);
  return dict;
}

// Registered, added to the page, and — when it has a note to show — given a
// Popup to show it in.
function addAnnot(doc, page, dict, appearance, { popup = false } = {}) {
  const { PDFName } = window.PDFLib;
  if (appearance) dict.AP = { N: appearance };
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  if (popup) {
    const [, , x1, y1] = dict.Rect;
    const popupRef = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Popup", Parent: ref, Open: false, F: 4,
      Rect: [x1 + 4, y1 - 120, x1 + 204, y1]
    }));
    doc.context.lookup(ref).set(PDFName.of("Popup"), popupRef);
    page.node.addAnnot(popupRef);
  }
  return ref;
}

function quadPointsFor(rects) {
  // Top-left, top-right, bottom-left, bottom-right: the order Acrobat writes.
  return rects.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
}

async function writeTextMark(doc, page, record, note, pageNumber) {
  const rects = (record.quads || []).filter((q) => Number(q?.page || record.page) === pageNumber && Array.isArray(q.rect)).map(quadRect);
  if (!rects.length) return 0;
  const custom = normalizeMarkHex(record.hex);
  const hex = custom || MARK_HIGHLIGHT_HEX[record.color] || MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT];
  const style = markStyleOf(record);
  if (style === "box") {
    // A box round a run of words is a box per line: Square has one rectangle.
    rects.forEach((rect, i) => {
      const app = appearanceBuilder(doc);
      const geometry = markGeometry("box", rect[0], -rect[3], rect[2] - rect[0], rect[3] - rect[1], 0.5);
      const [ox, oy, ow, oh] = geometry.outline;
      app.poly({ pts: [[ox, -oy], [ox + ow, -oy], [ox + ow, -(oy + oh)], [ox, -(oy + oh)]], closed: true, stroke: hex, width: geometry.width, opacity: 1, dash: "solid", fill: null }, { multiply: true });
      const dict = baseAnnot(doc, { ...record, id: i ? `${record.id}-${i}` : record.id }, "Square", rect, hex, i ? null : note);
      dict.BS = { W: geometry.width, S: "S" };
      addAnnot(doc, page, dict, app.form(rect), { popup: Boolean(note) && !i });
    });
    return rects.length;
  }
  const subtype = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut", squiggly: "Squiggly" }[style];
  const app = appearanceBuilder(doc);
  rects.forEach((rect) => {
    // The same geometry the page draws, worked out with y down and flipped back.
    const width = rect[2] - rect[0];
    const height = rect[3] - rect[1];
    const g = markGeometry(style, rect[0], -rect[3], width, height, 0.5);
    if (g.fill) app.rect(rect, hex, custom ? CUSTOM_HIGHLIGHT_ALPHA : highlightAlpha(record.color), { multiply: true });
    (g.bars || []).forEach(([bx, by, bw, bh]) => app.rect([bx, -(by + bh), bx + bw, -by], hex, 1, { multiply: true }));
    if (g.wave) app.poly({ pts: g.wave.map(([x, y]) => [x, -y]), closed: false, stroke: hex, width: g.width, opacity: 1, dash: "solid", fill: null }, { multiply: true });
  });
  const bounds = padAnnotRect(rectOf(rects.flatMap(([x0, y0, x1, y1]) => [[x0, y0], [x1, y1]])), 1);
  const dict = baseAnnot(doc, record, subtype, bounds, hex, note);
  dict.QuadPoints = quadPointsFor(rects);
  if (style === "highlight") dict.CA = custom ? CUSTOM_HIGHLIGHT_ALPHA : highlightAlpha(record.color);
  addAnnot(doc, page, dict, app.form(bounds), { popup: Boolean(note) });
  return 1;
}

function writeRegion(doc, page, record, note) {
  const rect = quadRect(record.quads[0]);
  const hex = MARK_HIGHLIGHT_HEX[record.color] || MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT];
  const app = appearanceBuilder(doc);
  app.rect(rect, hex, AREA_FILL_ALPHA);
  const line = 1.5;
  app.poly({ pts: [[rect[0] + line / 2, rect[1] + line / 2], [rect[2] - line / 2, rect[1] + line / 2], [rect[2] - line / 2, rect[3] - line / 2], [rect[0] + line / 2, rect[3] - line / 2]], closed: true, stroke: hex, width: line, opacity: 1, dash: "solid", fill: null });
  const dict = baseAnnot(doc, record, "Square", rect, hex, note);
  dict.BS = { W: line, S: "S" };
  addAnnot(doc, page, dict, app.form(rect), { popup: Boolean(note) });
  return 1;
}

function writeInk(doc, page, record, note) {
  const strokes = decodeInkStrokes(record.ink?.s);
  if (!strokes.length) return 0;
  const app = appearanceBuilder(doc);
  const lists = [];
  let widest = 0;
  let colour = null;
  strokes.forEach((stroke) => {
    const pts = [];
    for (let i = 0; i + 1 < (stroke.p || []).length; i += 3) pts.push([stroke.p[i], stroke.p[i + 1]]);
    if (!pts.length) return;
    if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
    const paint = resolveInkPaint(stroke.c, { paper: "light" });
    const highlighter = String(stroke.c || "").startsWith("h");
    app.poly({ pts, closed: false, stroke: paint.color, width: stroke.w || 1, opacity: paint.alpha, dash: "solid", fill: null }, { multiply: highlighter });
    lists.push(pts.flat());
    widest = Math.max(widest, stroke.w || 1);
    colour = colour || paint.color;
  });
  const bounds = padAnnotRect(rectOf(lists.flatMap((flat) => {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  })), widest);
  const dict = baseAnnot(doc, record, "Ink", bounds, colour || "#16181d", note);
  dict.InkList = lists;
  dict.BS = { W: widest, S: "S" };
  addAnnot(doc, page, dict, app.form(bounds), { popup: Boolean(note) });
  return 1;
}

async function writeShape(doc, page, record, note) {
  const { PDFHexString } = window.PDFLib;
  const s = normalizeShape(record.shape);
  if (!s) return 0;
  const bounds = shapeBounds(s);
  const app = appearanceBuilder(doc);
  const list = shapeDrawList(s);
  for (const prim of list) {
    if (prim.kind === "poly") app.poly(prim);
    else if (prim.kind === "text") await app.text(prim); // eslint-disable-line no-await-in-loop
  }
  const border = { W: s.width, S: s.dash === "solid" ? "S" : "D" };
  if (s.dash !== "solid") border.D = shapeDashArray(s.dash, s.width);
  let dict;
  let popup = Boolean(note);
  let reply = null;
  if (s.type === "line" || s.type === "arrow") {
    dict = baseAnnot(doc, record, "Line", bounds, s.stroke, note);
    dict.L = [...s.p[0], ...s.p[1]];
    dict.LE = s.heads.map((h) => LINE_ENDINGS[h] || "None");
    dict.BS = border;
    dict.CA = s.opacity;
  } else if ((s.type === "rect" || s.type === "ellipse") && s.rot) {
    // A turned box: a Square or a Circle can only be upright, so it is the
    // polygon it is drawn as, which any reader draws turned.
    const outline = list.find((prim) => prim.kind === "poly" && prim.closed);
    dict = baseAnnot(doc, record, "Polygon", bounds, s.stroke, note);
    dict.Vertices = (outline?.pts || []).flat().map((n) => Math.round(n * 100) / 100);
    dict.BS = border;
    dict.CA = s.opacity;
    if (s.fill) dict.IC = hexRgb(s.fill);
  } else if (s.type === "rect" || s.type === "ellipse") {
    dict = baseAnnot(doc, record, s.type === "rect" ? "Square" : "Circle", bounds, s.stroke, note);
    dict.BS = border;
    dict.CA = s.opacity;
    if (s.fill) dict.IC = hexRgb(s.fill);
    // The shape's own box (out by half its line), inside the Rect.
    const inner = padAnnotRect(rectFromPoints(s.p[0], s.p[1]), s.width / 2);
    dict.RD = [inner[0] - bounds[0], inner[1] - bounds[1], bounds[2] - inner[2], bounds[3] - inner[3]].map((n) => Math.max(0, Math.round(n * 100) / 100));
  } else if (s.type === "sticky") {
    dict = baseAnnot(doc, record, "Text", bounds, s.stroke, note || "");
    dict.Name = "Comment";
    dict.Open = false;
  } else {
    // Callout and text: Contents is the words in the box. The note, if any,
    // is a reply to it.
    dict = baseAnnot(doc, record, "FreeText", bounds, s.stroke, null);
    // The words with their markdown syntax taken off: another PDF reader
    // shows Contents as plain text, and "**bold**" there is four asterisks.
    dict.Contents = PDFHexString.fromText(markdownToPlainText(s.text || ""));
    const colour = hexRgb(s.font.color || (s.type === "text" ? s.stroke : "#16181d"));
    dict.DA = window.PDFLib.PDFString.of(`/${s.font.bold ? "HeBo" : "Helv"} ${s.font.size} Tf ${colour.join(" ")} rg`);
    dict.Q = { left: 0, center: 1, right: 2 }[s.font.align] ?? 0;
    dict.BS = s.type === "text" && !s.border ? { W: 0 } : border;
    if (s.fill) dict.IC = hexRgb(s.fill);
    const box = shapeTextRect(s);
    dict.RD = [box[0] - bounds[0], box[1] - bounds[1], bounds[2] - box[2], bounds[3] - box[3]].map((n) => Math.max(0, Math.round(n * 100) / 100));
    if (s.type === "callout") {
      dict.IT = "FreeTextCallout";
      const target = s.p[2];
      const knee = s.p[3] || null;
      const start = calloutStart(s);
      dict.CL = knee ? [...target, ...knee, ...start] : [...target, ...start];
      dict.LE = LINE_ENDINGS[s.heads[1]] || "None";
    }
    popup = false;
    if (note) reply = note;
  }
  const ref = addAnnot(doc, page, dict, app.form(bounds), { popup });
  if (reply) {
    const [, , x1, y1] = bounds;
    const replyDict = baseAnnot(doc, { ...record, id: `${record.id}-note` }, "Text", [x1 - 20, y1 - 20, x1, y1], s.stroke, reply);
    replyDict.IRT = ref;
    replyDict.Name = "Comment";
    replyDict.Open = false;
    addAnnot(doc, page, replyDict, null);
  }
  return 1;
}

// ── Typed boxes and pictures ──────────────────────────────────────────────
//
// A block (src/documents/pdf-blocks.js) is markdown — headings, lists, maths,
// code — or a picture, and no PDF annotation can carry either as such. So each
// is rendered exactly as the page shows it (rasteriseRegionBlocks, the same
// picture "Save as PDF" on a region uses) and written as a Stamp: the picture is
// its appearance, its words are its Contents so a reader can still search and
// copy them, and it is still an annotation another app can move or delete.
// This is what makes writing typed into a page's margin
// (src/documents/pdf-margins.js) come out in the file.

// Everywhere on a page, for the region helpers that take a box.
const STAMP_WHOLE_PAGE = [-1e7, -1e7, 1e7, 1e7];

async function writeBlockStamp(doc, page, pdfPage, block, canvas) {
  const P = window.PDFLib;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return 0;
  const image = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  // Placed through the page's viewport, as the region PDF's drawBlocks places
  // it: the picture is upright as the reader saw it, on a turned page too.
  const viewport = pdfPage.getViewport({ scale: 1 });
  const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(blockPdfRect(block));
  const left = Math.min(vx0, vx1);
  const right = Math.max(vx0, vx1);
  const top = Math.min(vy0, vy1);
  const bottom = Math.max(vy0, vy1);
  const [p00x, p00y] = viewport.convertToPdfPoint(left, bottom);
  const [p10x, p10y] = viewport.convertToPdfPoint(right, bottom);
  const [p01x, p01y] = viewport.convertToPdfPoint(left, top);
  const place = [p10x - p00x, p10y - p00y, p01x - p00x, p01y - p00y, p00x, p00y];
  const [bx0, by0, bx1, by1] = blockPdfRect(block);
  const turn = block.rot ? shapeTextRotationMatrix({ rot: block.rot, centre: [(bx0 + bx1) / 2, (by0 + by1) / 2] }) : null;
  // The annotation's Rect is the box's corners after both, so a turned box is
  // not clipped by its own appearance.
  const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map((pt) => {
    const placed = apply(place, pt);
    return turn ? apply(turn, placed) : placed;
  });
  const rect = padAnnotRect(rectOf(corners), 0.5);
  const ops = [
    P.pushGraphicsState(),
    ...(turn ? [P.concatTransformationMatrix(...turn)] : []),
    P.concatTransformationMatrix(...place),
    P.drawObject("Im"),
    P.popGraphicsState()
  ];
  const appearance = doc.context.register(doc.context.formXObject(ops, {
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { XObject: { Im: image.ref } }
  }));
  const words = block.kind === "image" ? String(block.alt || "") : markdownToPlainText(String(block.md || ""));
  const dict = baseAnnot(doc, block, "Stamp", rect, "#000000", words.trim() || null);
  delete dict.C;
  dict.Name = "Recall";
  addAnnot(doc, page, dict, appearance);
  return 1;
}

// Every block on the open PDF, as Stamps. Resolves { count, missed } — missed
// being the ones that could not be pictured (no html-to-image offline, a
// picture that would not draw), which the toast owns up to.
async function writeBlockStamps(doc, pages) {
  const pdfDoc = currentPdfDocument();
  if (!pdfDoc) return { count: 0, missed: 0 };
  const slot = activeDocSlot();
  const source = { slot, pdfId: slot === DOC_SLOT_DOC ? (openDocumentPdfId() || activePdfId(state.meta)) : null };
  let count = 0;
  let missed = 0;
  for (let n = 1; n <= pages.length; n += 1) {
    if (!regionBlocksInBox(source, n, STAMP_WHOLE_PAGE).length) continue;
    try {
      const pdfPage = await pdfDoc.getPage(n); // eslint-disable-line no-await-in-loop
      // Light paper, as every export is: the words are dark on the page they
      // are printed on, whatever theme the app happens to be in.
      const { rasters, failed } = await rasteriseRegionBlocks(pdfPage, source, n, STAMP_WHOLE_PAGE, 2, { paper: "light" }); // eslint-disable-line no-await-in-loop
      missed += failed;
      for (const { block, canvas, kind } of rasters) {
        // A text box's or a callout's words are already in its FreeText.
        if (kind === "shape-text") continue;
        count += await writeBlockStamp(doc, pages[n - 1], pdfPage, block, canvas); // eslint-disable-line no-await-in-loop
      }
    } catch (error) {
      console.warn("Could not write the typed boxes on page", n, error);
      missed += 1;
    }
  }
  return { count, missed };
}

// ── The file ──────────────────────────────────────────────────────────────

// The open document's bytes with every mark on it written as an annotation.
// Resolves { bytes, count, name } — or null when there is no copy of the PDF
// on this device to start from.
export async function annotatedPdfBytes() {
  const source = await currentDocumentBlob();
  if (!source?.blob) return null;
  await ensurePdfLib();
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.load(await source.blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
  const notes = readHighlightNotes(state.notes || "");
  const pages = doc.getPages();
  let count = 0;
  for (const record of documentHighlights()) {
    // The file's own annotations are already in it.
    if (record?.imported) continue;
    const pageNumber = Number(record?.page || record?.quads?.[0]?.page || 0);
    const page = pages[pageNumber - 1];
    if (!page) continue;
    const note = notes.get(record.id) || null;
    try {
      if (record.kind === "shape") count += await writeShape(doc, page, record, note); // eslint-disable-line no-await-in-loop
      else if (record.kind === "ink") count += writeInk(doc, page, record, note);
      else if (record.kind === "area") count += writeRegion(doc, page, record, note);
      else count += await writeTextMark(doc, page, record, note, pageNumber); // eslint-disable-line no-await-in-loop
    } catch (error) {
      // One mark the writer cannot express is not a reason to lose the others.
      console.warn("Could not write an annotation", record?.id, error);
    }
  }
  const blocks = await writeBlockStamps(doc, pages);
  count += blocks.count;
  doc.setProducer("Recall");
  const bytes = await doc.save();
  const base = String(source.name || state.deckTitle || "document").replace(/\.pdf$/i, "");
  return { bytes, count, missed: blocks.missed, name: `${base} (annotated).pdf` };
}

// The menu row: build it and hand it over as a download.
export async function saveAnnotatedPdf() {
  let result = null;
  try {
    result = await annotatedPdfBytes();
  } catch (error) {
    console.warn("Could not save the PDF with its annotations", error);
    showToast(navigator.onLine === false
      ? "Saving with annotations needs to be online once, to fetch the PDF writer. The printed export works offline."
      : "Could not save the PDF with its annotations.", "error");
    return false;
  }
  if (!result) {
    showToast("This device doesn't have a copy of the PDF to save.", "error");
    return false;
  }
  const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.name;
  (el.app || document.body).appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const missed = result.missed ? ` — ${result.missed} typed box${result.missed === 1 ? "" : "es"} could not be drawn` : "";
  showToast(result.count ? `Saved with ${result.count} annotation${result.count === 1 ? "" : "s"}${missed}` : `Saved — there were no marks to add${missed}`, missed ? "info" : undefined);
  return true;
}
