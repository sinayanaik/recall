// A Canvas page's setup: the numbers and the bytes (src/documents/canvas-setup.js,
// src/documents/blank-pdf.js). Pure Node — pdf-lib from disk, no browser; the
// dialog and the pages on screen are tools/canvas-setup-browser-check.mjs.
//
//   node tools/canvas-setup-check.mjs
//
// What has to hold, and why each is asked:
//
//   • a Canvas never set up is byte-for-byte the file it always was — its
//     sha256 is how every device knows which pages it holds, so a stream that
//     changed by one space would re-make every Canvas in every library;
//   • the default grid and ruled setups draw their lines at exactly the first
//     papers' coordinates, so changing a line's colour never moves a line out
//     from under the words written on it;
//   • a page of any size keeps its top-left corner at (0, 842), and its lines
//     are the same lattice — so a page resized keeps everything written on it
//     where it was, lines included;
//   • pages share a content stream when they are drawn alike, and each gets
//     the box of its own size;
//   • a page's setup follows it when pages are added, duplicated, moved or torn
//     out (remapPageSetups, the rule the Canvas's records are renumbered by);
//   • every number written is finite and every byte ASCII, or the file's byte
//     offsets stop pointing at its objects.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdflibSource } from "./pdflib-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = await import(pathToFileURL(path.join(ROOT, "src/documents/canvas-setup.js")).href);
const blank = await import(pathToFileURL(path.join(ROOT, "src/documents/blank-pdf.js")).href);

// As tools/pdf-margins-check.mjs loads it: the UMD build, as CommonJS.
let PDFDocument = null;
try {
  const cjs = { exports: {} };
  new Function("module", "exports", pdflibSource())(cjs, cjs.exports);
  PDFDocument = cjs.exports.PDFDocument || null;
} catch (error) {
  console.log(`canvas-setup-check: no pdf-lib (${error?.message || error}) — the cases that load the file will be skipped.`);
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

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

// Every `x y m x y l` in a content stream, as [x1, y1, x2, y2] strings, sorted.
function segmentsOf(stream) {
  const out = [];
  const re = /(-?[\d.]+) (-?[\d.]+) m (-?[\d.]+) (-?[\d.]+) l/g;
  let m;
  while ((m = re.exec(stream))) out.push([m[1], m[2], m[3], m[4]].map(Number).join(","));
  return out.sort();
}

await must("a Canvas never set up is byte-for-byte what it was (pinned hashes)", () => {
  // The same pins tools/pdf-margins-check.mjs holds the first papers to.
  const pinned = {
    grid: "44bd1c8ac1bfa89c91e3d3bddc758db6f633b93be2df831ea2ae9d2a7db78f68",
    ruled: "9916ca57ba18e328e39a947fdbe5c88c1dffebe6843b1455d4aaddab46ffb8fb",
    blank: "223a35bd659d5bdbf283b93e4ac029979d9cd032184515b24f5ea314b65af3b7"
  };
  const wrong = Object.keys(pinned).filter((paper) => sha(blank.buildBlankPdf({ pages: 2, paper })) !== pinned[paper]);
  return !wrong.length || `changed: ${wrong.join(", ")}`;
});

await must("...and so is one whose setups all draw as a first paper", () => {
  const plain = sha(blank.buildBlankPdf({ pages: 3, paper: "ruled" }));
  const viaSetup = sha(blank.buildBlankPdf({ pages: 3, paper: "grid", setup: setup.legacySheetSetup("ruled") }));
  const viaPages = sha(blank.buildBlankPdf({
    pages: 3,
    paper: "ruled",
    pageSetups: { 2: { ...setup.legacySheetSetup("ruled"), size: "a4" } }
  }));
  return (plain === viaSetup && plain === viaPages) || { plain, viaSetup, viaPages };
});

await must("every first paper is its own legacy kind; nothing else is", () => {
  const kinds = ["grid", "ruled", "blank"].map((k) => setup.sheetLegacyKind(setup.legacySheetSetup(k)));
  const notDots = setup.sheetLegacyKind(setup.normalizeSheetSetup({ pattern: "dots" }));
  const blueGrid = setup.sheetLegacyKind({ ...setup.legacySheetSetup("grid"), line: "#1f5fd1" });
  const a5Grid = setup.sheetLegacyKind({ ...setup.legacySheetSetup("grid"), w: 420, h: 595 });
  return (kinds.join() === "grid,ruled,blank" && notDots === null && blueGrid === null && a5Grid === null) || { kinds, notDots, blueGrid, a5Grid };
});

await must("the default grid draws every line where the first grid did", () => {
  const legacy = segmentsOf(blank.paperStream("grid"));
  // A grid that is NOT legacy (a colour changed), so it goes through the new
  // stream, and must still put every line in the same place.
  const fresh = segmentsOf(setup.sheetPdfStream({ ...setup.legacySheetSetup("grid"), line: "#1f5fd1" }));
  return (legacy.length > 80 && JSON.stringify(legacy) === JSON.stringify(fresh)) || `${legacy.length} vs ${fresh.length} lines`;
});

await must("...and the default ruled paper its rules and its margin line", () => {
  const legacy = segmentsOf(blank.paperStream("ruled"));
  const fresh = segmentsOf(setup.sheetPdfStream({ ...setup.legacySheetSetup("ruled"), opacity: 0.5 }));
  return (legacy.length > 30 && JSON.stringify(legacy) === JSON.stringify(fresh)) || `${legacy.length} vs ${fresh.length} lines`;
});

await must("normalize clamps every number, rejects a bad colour and fills what is missing", () => {
  const s = setup.normalizeSheetSetup({
    pattern: "nope", w: 5, h: 99999, line: "red", opacity: 7, width: -1, pitch: 0.1,
    majorEvery: 400, margins: { top: -4, left: 1e9 }, dash: "wavy", dot: 50
  });
  const ok = s.pattern === "grid" && s.w === setup.SHEET_SIZE_MIN && s.h === setup.SHEET_SIZE_MAX
    && s.line === "#000000" && s.opacity === 1 && s.width === 0.1 && s.pitch > 5 && s.majorEvery === 20
    && s.margins.top === 0 && s.margins.left <= (s.w / 2) && s.dash === "solid" && s.dot === 4;
  return ok || s;
});

await must("normalize is idempotent and a paper colour that is too dark is lightened", () => {
  const once = setup.normalizeSheetSetup({ pattern: "dots", paper: "#101020", w: 612, h: 792 });
  const twice = setup.normalizeSheetSetup(once);
  return (JSON.stringify(once) === JSON.stringify(twice) && setup.isLightSheetPaper(once.paper) && once.paper !== "#101020") || once.paper;
});

await must("sizes are recognised in either orientation; anything else is custom", () => {
  const ids = [
    setup.sheetSizeIdFor(595, 842), setup.sheetSizeIdFor(842, 595),
    setup.sheetSizeIdFor(612, 792), setup.sheetSizeIdFor(500, 500)
  ];
  return ids.join() === "a4,a4,letter,custom" || ids.join();
});

await must("every page's box keeps its top-left corner at (0, 842)", () => {
  const boxes = [
    setup.sheetBox({ w: 595, h: 842 }),
    setup.sheetBox({ w: 595, h: 420 }),
    setup.sheetBox({ w: 842, h: 1191 }),
    setup.sheetBox({ w: 216, h: 360 })
  ];
  const ok = boxes.every((b) => b[0] === 0 && b[3] === 842) && boxes[0][1] === 0 && boxes[1][1] === 422 && boxes[2][1] === -349;
  return ok || boxes;
});

await must("a page made smaller or bigger keeps its lines where they were", () => {
  const a4 = segmentsOf(setup.sheetPdfStream({ pattern: "ruled", w: 595, h: 842, opacity: 0.4 }))
    .map((seg) => seg.split(",").map(Number)).filter(([, y]) => y > 422 && y < 818).map(([, y]) => y);
  const a5 = segmentsOf(setup.sheetPdfStream({ pattern: "ruled", w: 595, h: 420, opacity: 0.4 }))
    .map((seg) => seg.split(",").map(Number)).filter(([x0, y, x1, y1]) => y === y1 && x0 !== x1 && y > 422).map(([, y]) => y);
  return (a4.length > 10 && JSON.stringify([...new Set(a4)]) === JSON.stringify([...new Set(a5)])) || { a4, a5 };
});

await must("dot grid, Cornell, dashed and dotted lines all write finite ASCII numbers", () => {
  const streams = [
    setup.sheetPdfStream({ pattern: "dots", w: 842, h: 1191 }),
    setup.sheetPdfStream({ pattern: "cornell" }),
    setup.sheetPdfStream({ pattern: "ruled", dash: "dashed" }),
    setup.sheetPdfStream({ pattern: "grid", dash: "dotted", w: 3370, h: 3370 })
  ];
  const bad = streams.filter((s) => /NaN|Infinity|undefined|e[+-]\d/.test(s) || /[^\x09\x0a\x0d\x20-\x7e]/.test(s));
  return !bad.length || `${bad.length} stream(s) with a bad token`;
});

await must("a poster of dots is held to a spacing that keeps the file small", () => {
  const big = setup.normalizeSheetSetup({ pattern: "dots", w: 3370, h: 3370, pitch: 1 });
  const dots = setup.sheetOps(big).groups[0].segs.length;
  const bytes = setup.sheetPdfStream(big).length;
  return (dots <= 12500 && bytes < 600000) || { pitch: big.pitch, dots, bytes };
});

await must("Cornell draws its header, summary and cue dividers", () => {
  const ops = setup.sheetOps({ pattern: "cornell" });
  const dividers = ops.groups[1]?.segs || [];
  const vertical = dividers.filter(([x0, , x1]) => x0 === x1);
  return (dividers.length === 3 && vertical.length === 1 && ops.groups[0].segs.length > 20) || dividers;
});

await must("the preview SVG draws the same segments the PDF does", () => {
  const s = { pattern: "grid", w: 420, h: 595, majorEvery: 5 };
  const pdf = segmentsOf(setup.sheetPdfStream(s)).length;
  const svg = (setup.sheetSvg(s).match(/M[-\d.]+ [-\d.]+L/g) || []).length;
  return (pdf > 0 && pdf === svg) || { pdf, svg };
});

await must("pages drawn alike share one content stream; each has its own box", () => {
  const dots = { pattern: "dots", w: 595, h: 420 };
  const bytes = blank.buildBlankPdf({ pages: 4, paper: "grid", pageSetups: { 2: dots, 4: dots } });
  const text = latin1(bytes);
  const streams = (text.match(/\bstream\n/g) || []).length;
  const boxes = text.split("/MediaBox [").slice(1).map((t) => t.slice(0, t.indexOf("]")).trim());
  const ok = streams === 2 && JSON.stringify(boxes) === JSON.stringify(["0 0 595 842", "0 422 595 842", "0 0 595 842", "0 422 595 842"]);
  return ok || { streams, boxes };
});

await must("the same setups make the same bytes, every time", () => {
  const args = { pages: 3, paper: "ruled", setup: { pattern: "cornell", w: 612, h: 792 }, pageSetups: { 2: { pattern: "dots" } } };
  return sha(blank.buildBlankPdf(args)) === sha(blank.buildBlankPdf(JSON.parse(JSON.stringify(args))));
});

await must("pdf-lib reads every page at its own size and box", async () => {
  if (!PDFDocument) return true;
  const bytes = blank.buildBlankPdf({
    pages: 3,
    paper: "grid",
    setup: { pattern: "ruled", w: 612, h: 792 },
    pageSetups: { 3: { pattern: "dots", w: 842, h: 595 } }
  });
  const doc = await PDFDocument.load(bytes);
  const got = doc.getPages().map((p) => { const b = p.getMediaBox(); return [b.x, b.y, b.width, b.height]; });
  const want = [[0, 50, 612, 792], [0, 50, 612, 792], [0, 247, 842, 595]];
  return JSON.stringify(got) === JSON.stringify(want) || got;
});

await must("a page's setup follows it when pages are added, duplicated, moved and torn out", () => {
  const map = { 2: { pattern: "dots" }, 4: { pattern: "cornell" } };
  const at = (m) => Object.keys(m || {}).sort().map((k) => `${k}:${m[k].pattern}`).join(" ");
  // A page added after page 2: everything after it moves down one.
  const added = setup.remapPageSetups(map, ({ page }) => (page > 2 ? page + 1 : page));
  // Page 2 moved down one: 2 and 3 swap.
  const moved = setup.remapPageSetups(map, ({ page }) => (page === 2 ? 3 : page === 3 ? 2 : page));
  // Page 2 torn out.
  const torn = setup.remapPageSetups(map, ({ page }) => (page === 2 ? null : page > 2 ? page - 1 : page));
  const gone = setup.remapPageSetups({ 1: { pattern: "dots" } }, () => null);
  const ok = at(added) === "2:dots 5:cornell" && at(moved) === "3:dots 4:cornell" && at(torn) === "3:cornell" && gone === null;
  return ok || { added: at(added), moved: at(moved), torn: at(torn), gone };
});

await must("a Canvas record's pages: own setup, else the Canvas's, else its paper", () => {
  const record = { pages: 3, paper: "ruled", setup: { pattern: "grid", w: 612, h: 792 }, pageSetups: { 3: { pattern: "dots", w: 420, h: 595 } } };
  const kinds = [1, 2, 3].map((n) => setup.sheetSetupForPage(record, n).pattern);
  const legacy = setup.sheetSetupForPage({ pages: 1, paper: "ruled" }, 1);
  const boxes = setup.canvasPageBoxes(record);
  const ok = kinds.join() === "grid,grid,dots" && setup.sheetLegacyKind(legacy) === "ruled"
    && JSON.stringify(boxes) === JSON.stringify([[0, 50, 612, 842], [0, 50, 612, 842], [0, 247, 420, 842]]);
  return ok || { kinds, boxes };
});

await must("a box snaps to grid and dot grid squares at the page's own spacing, from (0, 0)", () => {
  const grid = setup.canvasSnapGridFor({ pattern: "grid", pitch: 20 });
  const dots = setup.canvasSnapGridFor({ pattern: "dots", pitch: 18 });
  const ruled = setup.canvasSnapGridFor({ pattern: "ruled" });
  return (grid.pitch === 20 && dots.pitch === 18 && grid.origin.join() === "0,0" && ruled === null) || { grid, dots, ruled };
});

await must("the menu's summary names the size, the way round and the paper", () => {
  const lines = [
    setup.sheetSetupSummary(setup.legacySheetSetup("ruled")),
    setup.sheetSetupSummary({ pattern: "dots", w: 595, h: 420 }),
    setup.sheetSetupSummary({ pattern: "blank", w: 300, h: 300 })
  ];
  return (lines[0] === "A4 portrait · Ruled 8.5 mm" && lines[1] === "A5 landscape · Dot grid 5 mm" && /^105\.8 × 105\.8 mm · Blank$/.test(lines[2])) || lines;
});

console.log(`\ncanvas-setup-check: ${ran - failed}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
