// Canvas pages that grow as needed, and Boundless pages: the numbers and the
// bytes (src/documents/canvas-extent.js, canvas-setup.js, blank-pdf.js). Pure
// Node — pdf-lib from disk, no browser; growing on screen, in place, and the
// exports are tools/canvas-extent-browser-check.mjs.
//
//   node tools/canvas-extent-check.mjs
//
// What has to hold, and why each is asked:
//
//   • a page that grows is never smaller than it was set up at, grows right and
//     down only, by just enough room past what is on it, in whole steps, and
//     shrinks back when what pushed it is gone — so an undo takes the room back;
//   • it does not change at every stroke: once grown it holds until what is on
//     it comes within the smaller room of its edge again;
//   • a Boundless page grows every way, and no page reaches past EXTENT_MAX;
//   • a Boundless page's PDF is cut to what is on it, turned Blocks included;
//   • a drag may go past the edges a page grows by, and only those;
//   • pages that grow draw their paper on the same lattice, from their outer
//     edges, dots as a line a row, and a fixed page's bytes are what they were;
//   • a grown page's box is in the file, and a page's box follows it when pages
//     are renumbered (the rule its setup already follows).

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdflibSource } from "./pdflib-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-extent.js")).href);
const setup = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-setup.js")).href);
const blank = await import(pathToFileURL(path.join(ROOT, "src/documents/blank-pdf.js")).href);
const flow = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-flow.js")).href);

let PDFDocument = null;
try {
  const cjs = { exports: {} };
  new Function("module", "exports", pdflibSource())(cjs, cjs.exports);
  PDFDocument = cjs.exports.PDFDocument || null;
} catch (error) {
  console.log(`canvas-extent-check: no pdf-lib (${error?.message || error}) — the case that loads the file will be skipped.`);
}

let ran = 0;
let failed = 0;
async function must(label, fn) {
  ran += 1;
  let result;
  try {
    result = await fn();
  } catch (error) {
    result = `threw ${error?.stack || error}`;
  }
  if (result === true) console.log(`  ok    ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${label}  ${typeof result === "string" ? result : JSON.stringify(result)}`);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const GROW = { pattern: "grid", fit: "grow" };
const FREE = { pattern: "dots", fit: "boundless" };
const A4 = [0, 0, 595, 842];
const { EXTENT_ROOM, EXTENT_ROOM_MIN, EXTENT_STEP, EXTENT_MAX, BOUNDLESS_ROOM, EXPORT_PAD } = ext;

await must("a fixed page is its size, whatever is on it", () => {
  const box = ext.neededPageBox({ pattern: "grid" }, [[-500, -500, 4000, 4000]]);
  return same(box, A4) || box;
});

await must("a page that grows, with nothing near its edges, is its size", () => {
  const empty = ext.neededPageBox(GROW, []);
  const middle = ext.neededPageBox(GROW, [[100, 300, 400, 500]]);
  return (same(empty, A4) && same(middle, A4)) || { empty, middle };
});

await must("past its foot it grows down, by just enough, in whole steps; its top-left stays", () => {
  const box = ext.neededPageBox(GROW, [[100, -40, 300, 20]]);
  const depth = 842 - box[1];
  const wanted = Math.ceil((842 + 40 + EXTENT_ROOM) / EXTENT_STEP) * EXTENT_STEP;
  return (box[0] === 0 && box[3] === 842 && box[2] === 595 && depth === wanted) || { box, wanted };
});

await must("past its right edge it grows wider; never left or up", () => {
  const box = ext.neededPageBox(GROW, [[-300, 700, 640, 1200]]);
  return (box[0] === 0 && box[3] === 842 && box[2] === Math.ceil((640 + EXTENT_ROOM) / EXTENT_STEP) * EXTENT_STEP && box[1] === 0) || box;
});

await must("within the room of its edge it grows; just clear of it, it does not", () => {
  const near = ext.neededPageBox(GROW, [[100, EXTENT_ROOM_MIN - 2, 200, 300]]);
  const clear = ext.neededPageBox(GROW, [[100, EXTENT_ROOM_MIN + 2, 200, 300]]);
  return (near[1] < 0 && same(clear, A4)) || { near, clear };
});

await must("once grown it holds while what is on it moves a little, not at every stroke", () => {
  const grown = ext.neededPageBox(GROW, [[100, -40, 300, 20]]);
  const nudged = ext.neededPageBox(GROW, [[100, -60, 300, 20]], grown);
  const wrote = ext.neededPageBox(GROW, [[100, grown[1] + EXTENT_ROOM_MIN - 4, 300, 20]], grown);
  return (same(nudged, grown) && wrote[1] < grown[1]) || { grown, nudged, wrote };
});

await must("what pushed it gone, it shrinks back to its size — an undo takes the room back", () => {
  const grown = ext.neededPageBox(GROW, [[100, -400, 700, 20]]);
  const back = ext.neededPageBox(GROW, [[100, 300, 300, 500]], grown);
  const empty = ext.neededPageBox(GROW, [], grown);
  return (same(back, A4) && same(empty, A4)) || { grown, back, empty };
});

await must("a Boundless page grows every way, from where it starts", () => {
  const box = ext.neededPageBox(FREE, [[-500, -300, 900, 1300]]);
  const step = (v) => Math.ceil(v / EXTENT_STEP) * EXTENT_STEP;
  const wanted = [-step(500 + BOUNDLESS_ROOM), 842 - step(842 + 300 + BOUNDLESS_ROOM), step(900 + BOUNDLESS_ROOM), 842 + step(1300 - 842 + BOUNDLESS_ROOM)];
  return same(box, wanted) || { box, wanted };
});

await must("no page reaches past EXTENT_MAX across or down", () => {
  const grow = ext.neededPageBox(GROW, [[0, -90000, 90000, 100]]);
  const free = ext.neededPageBox(FREE, [[-90000, -90000, 90000, 90000]]);
  const ok = grow[2] - grow[0] <= EXTENT_MAX && grow[3] - grow[1] <= EXTENT_MAX
    && free[2] - free[0] <= EXTENT_MAX && free[3] - free[1] <= EXTENT_MAX;
  return ok || { grow, free };
});

await must("a turned Block's box is its turned corners'", () => {
  const box = ext.blockBounds({ x: 0, y: 0, w: 100, h: 20, rot: 90 });
  return same(box.map(Math.round), [40, -40, 60, 60]) || box;
});

await must("a Boundless page's PDF is cut to what is on it, with a little room", () => {
  const page = ext.neededPageBox(FREE, [[-500, 900, 0, 1000]]);
  const rects = ext.pageContentRects([{ kind: "ink", quads: [{ page: 1, rect: [-500, 900, -400, 1000] }] }], [{ x: -100, y: 920, w: 100, h: 40, rot: 0 }]);
  const cut = ext.exportPageBox(FREE, page, rects);
  const wanted = [-500 - EXPORT_PAD, 900 - EXPORT_PAD, 0 + EXPORT_PAD, 1000 + EXPORT_PAD];
  const blank2 = ext.exportPageBox(FREE, page, []);
  const grown = ext.exportPageBox(GROW, [0, -300, 595, 842], rects);
  return (same(cut, wanted) && same(blank2, A4) && same(grown, [0, -300, 595, 842])) || { cut, wanted, blank2, grown };
});

await must("a drag goes past only the edges a page grows by", () => {
  const fixed = ext.canvasDragLimits("fixed", A4);
  const grow = ext.canvasDragLimits("grow", A4);
  const free = ext.canvasDragLimits("boundless", A4);
  const ok = same(fixed, A4)
    && grow[0] === 0 && grow[3] === 842 && grow[2] > 595 && grow[1] < 0
    && free[0] < 0 && free[3] > 842 && free[2] > 595 && free[1] < 0;
  const record = { pages: 2, setup: { pattern: "grid" }, pageSetups: { 2: GROW } };
  const byPage = ext.pageDragLimits(record, 1, A4);
  const byPage2 = ext.pageDragLimits(record, 2, A4);
  return (ok && same(byPage, A4) && byPage2[2] > 595) || { fixed, grow, free, byPage, byPage2 };
});

await must("fit survives normalisation, is in the draw key, and a Boundless page has no margins or Cornell", () => {
  const g = setup.normalizeSheetSetup(GROW);
  const b = setup.normalizeSheetSetup({ pattern: "cornell", fit: "boundless", margins: { top: 40, left: 40, right: 0, bottom: 0 } });
  const fixedKey = setup.sheetDrawKey({ pattern: "grid" });
  const growKey = setup.sheetDrawKey(GROW);
  const ok = g.fit === "grow" && b.fit === "boundless" && b.pattern === "ruled"
    && Object.values(b.margins).every((v) => v === 0)
    && fixedKey !== growKey && !/fixed/.test(fixedKey)
    && setup.sheetLegacyKind(GROW) === null && setup.sheetLegacyKind({ pattern: "grid" }) === "grid";
  return ok || { g, b, fixedKey, growKey };
});

await must("a grown page's lines are the same lattice, from its outer edges", () => {
  const base = setup.sheetOps({ pattern: "ruled", fit: "grow" });
  const grown = setup.sheetOps({ pattern: "ruled", fit: "grow" }, [0, -842, 595, 842]);
  const ys = (ops) => new Set(ops.groups[0].segs.map((seg) => seg[1]));
  const baseYs = ys(base);
  const grownYs = ys(grown);
  const kept = [...baseYs].every((y) => grownYs.has(y));
  const top = Math.max(...grownYs);
  // Ruled paper's top margin is one rule: the first rule under it, as on the page it grew from.
  return (kept && grownYs.size > baseYs.size && top === Math.max(...baseYs) && Math.min(...grownYs) < 0) || { kept, top, base: baseYs.size, grown: grownYs.size };
});

await must("dots on a page that grows are a line a row, so a poster is not a megabyte of dots", () => {
  const small = setup.sheetPdfStream(FREE);
  const big = setup.sheetPdfStream(FREE, [-4000, -4000, 4000, 4000]);
  const fixed = setup.sheetPdfStream({ pattern: "dots" });
  const rows = (big.match(/ l\b/g) || []).length;
  const pitch = setup.normalizeSheetSetup(FREE).pitch;
  const ok = big.length < 120000 && rows <= Math.ceil(8000 / pitch) + 2 && /\[0\.01 /.test(big)
    && (fixed.match(/ l\b/g) || []).length > 1000 && small.length < fixed.length;
  return ok || { big: big.length, rows, fixed: fixed.length, small: small.length };
});

await must("a Canvas whose pages are all fixed is byte-for-byte what it was", () => {
  const before = blank.buildBlankPdf({ pages: 3, paper: "grid", setup: { ...setup.legacySheetSetup("grid"), line: "#1f5fd1" } });
  const withBoxes = blank.buildBlankPdf({ pages: 3, paper: "grid", setup: { ...setup.legacySheetSetup("grid"), line: "#1f5fd1" }, pageBoxes: { 2: [0, -400, 700, 842] } });
  return Buffer.compare(Buffer.from(before), Buffer.from(withBoxes)) === 0 || "a stored box changed a fixed page's bytes";
});

await must("a grown page's box is in the file; pages drawn alike still share a stream", async () => {
  if (!PDFDocument) return true;
  const bytes = blank.buildBlankPdf({ pages: 3, paper: "grid", setup: GROW, pageBoxes: { 2: [0, -400, 700, 842] } });
  const doc = await PDFDocument.load(bytes);
  const boxes = doc.getPages().map((p) => { const b = p.getMediaBox(); return [b.x, b.y, b.x + b.width, b.y + b.height].map(Math.round); });
  const text = Buffer.from(bytes).toString("latin1");
  const streams = (text.match(/\/Length \d+ >>\nstream/g) || []).length;
  return (same(boxes, [A4, [0, -400, 700, 842], A4]) && streams === 2) || { boxes, streams };
});

await must("a record's page box is read only for a page that grows", () => {
  const record = { pages: 2, setup: { pattern: "grid" }, pageSetups: { 2: GROW }, pageBoxes: { 1: [0, -400, 595, 842], 2: [0, -400, 595, 842] } };
  const boxes = setup.canvasPageBoxes(record);
  const measure = setup.canvasMeasureBox(record, 2);
  return (same(boxes, [A4, [0, -400, 595, 842]]) && same(measure, A4)) || { boxes, measure };
});

await must("a page's box follows it when pages are renumbered", () => {
  const moved = setup.remapPageSetups({ 2: [0, -400, 595, 842], 4: [0, -100, 595, 842] }, (record) => {
    const on = record.page;
    if (on === 2) return null;
    return on > 2 ? on - 1 : on;
  });
  return same(moved, { 3: [0, -100, 595, 842] }) || moved;
});

await must("To the Canvas stacks down a last page that grows, rather than adding pages", () => {
  const items = Array.from({ length: 12 }, () => ({ w: 200, h: 120 }));
  const fixed = flow.flowOntoCanvas({ pages: [{ page: 1, box: A4, margins: {} }], items });
  const grows = flow.flowOntoCanvas({ pages: [{ page: 1, box: A4, margins: {}, reach: EXTENT_MAX }], items });
  const lowest = Math.min(...grows.places.map((place) => place.y));
  return (fixed.newPages > 0 && grows.newPages === 0 && grows.places.every((p) => p.page === 1) && lowest < 0) || { fixed: fixed.newPages, grows: grows.newPages, lowest };
});

console.log(`\ncanvas-extent-check: ${ran - failed}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
