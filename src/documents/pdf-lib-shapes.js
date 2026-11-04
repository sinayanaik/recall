// Shapes into a PDF file, as vector paths and real text — for a region saved
// "as PDF" (pdf-region-download.js) and for the appearance of a native
// annotation (pdf-annot-export.js).
//
// The geometry is src/render/annot-shapes.js, the same primitives the page and
// the canvas painters draw, so what is in the file is what was on the glass.
// Paths are drawn the way pdf-region-download.js draws ink: inside a matrix
// that flips y, so the path data can be written in PDF user space directly
// (drawSvgPath flips it back). Text is drawn outside that matrix, upright in
// user space, in Helvetica — a standard font every reader has, so nothing is
// embedded — and wrapped to its box by the same rule the screen wraps by.

import { SHAPE_TEXT_PAD, polyPathData, shapeDashArray, shapePrimitives, stickyIconPolys, wrapShapeText } from "../render/annot-shapes.js?v=__BUILD__";

export function pdfLibColour(hex) {
  const { rgb } = window.PDFLib;
  const value = String(hex || "#000000");
  return rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
}

// Helvetica speaks WinAnsi and nothing else; a character it cannot encode
// would throw out of drawText and lose the whole file. Each one is asked once.
const pdfFontEncodable = new WeakMap();

export function encodableText(font, text) {
  let known = pdfFontEncodable.get(font);
  if (!known) { known = new Map(); pdfFontEncodable.set(font, known); }
  let out = "";
  for (const ch of String(text || "")) {
    if (!known.has(ch)) {
      try { font.encodeText(ch); known.set(ch, true); } catch (_) { known.set(ch, false); }
    }
    out += known.get(ch) ? ch : "?";
  }
  return out;
}

// Every primitive of every shape, flattened: a sticky note's icon becomes the
// polys it is drawn as.
export function shapeDrawList(shape) {
  const list = [];
  shapePrimitives(shape).forEach((prim) => {
    if (prim.kind === "sticky") list.push(...stickyIconPolys(prim.rect, prim.color));
    else list.push(prim);
  });
  return list;
}

// The lines of a text primitive, laid out in user space (y UP): each with the
// x of its baseline start and its y.
export function shapeTextLines(prim, font) {
  const size = prim.size;
  const [x0, , x1, y1] = prim.rect;
  const inner = Math.max(1, (x1 - x0) - SHAPE_TEXT_PAD * 2);
  const text = encodableText(font, prim.text);
  const lines = wrapShapeText(text, inner, (t) => font.widthOfTextAtSize(t, size));
  const lineHeight = size * 1.3;
  return lines.map((line, i) => {
    const width = font.widthOfTextAtSize(line, size);
    let x = x0 + SHAPE_TEXT_PAD;
    if (prim.align === "center") x = (x0 + x1) / 2 - width / 2;
    else if (prim.align === "right") x = x1 - SHAPE_TEXT_PAD - width;
    // The top padding, then the line's ascent: Helvetica's is about 0.77 em,
    // which with a 1.3 line puts the baseline where a browser puts it.
    const y = y1 - SHAPE_TEXT_PAD - (lineHeight - size) / 2 - size * 0.8 - i * lineHeight;
    return { text: line, x, y, size };
  });
}

// Every shape record onto a pdf-lib page.
export async function drawShapesWithPdfLib(out, page, records) {
  if (!records?.length) return;
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, StandardFonts, LineCapStyle } = window.PDFLib;
  const lists = records.map((record) => shapeDrawList(record.shape));
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, 0));
  lists.forEach((list) => list.forEach((prim) => {
    if (prim.kind !== "poly") return;
    const path = polyPathData(prim, (point) => point);
    if (!path) return;
    const options = { x: 0, y: 0 };
    if (prim.fill) {
      options.color = pdfLibColour(prim.fill);
      options.opacity = prim.fillOpacity;
    }
    if (prim.width > 0) {
      options.borderColor = pdfLibColour(prim.stroke);
      options.borderWidth = prim.width;
      options.borderOpacity = prim.opacity;
      const dash = shapeDashArray(prim.dash, prim.width);
      if (dash.length) options.borderDashArray = dash;
      if (prim.dash === "dot" && LineCapStyle) options.borderLineCap = LineCapStyle.Round;
    }
    page.drawSvgPath(path, options);
  }));
  page.pushOperators(popGraphicsState());
  const texts = lists.flat().filter((prim) => prim.kind === "text" && prim.text);
  if (!texts.length) return;
  const regular = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  texts.forEach((prim) => {
    const font = prim.bold ? bold : regular;
    shapeTextLines(prim, font).forEach((line) => {
      page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font, color: pdfLibColour(prim.color) });
    });
  });
}
