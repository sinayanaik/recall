// Margins on a PDF's pages: the bytes, and nothing else.
//
// The reader asked for room to write beside a paper — a wide column on the
// right of every page, say — that the pen and the typed boxes can use and that
// leaves the app inside the PDF rather than beside it. So the margin is made
// part of the PAGE: each page's box is enlarged, and the paper (blank, ruled or
// grid, the Canvas's own sheets from blank-pdf.js) is drawn into the new space.
//
// ── Why nothing written on the page moves ─────────────────────────────────
//
// Every mark in this app — a highlight's quads, a stroke's points, a shape, a
// typed box — is stored in the page's own user space, in points, and placed
// through pdf.js's viewport (convertToPdfPoint / convertToViewportRectangle),
// which knows where the page box starts. So the box is grown OUTWARD and its
// origin is never shifted: a margin on the right raises x1, one on the left
// lowers x0 below wherever it was (to a negative number on most papers). The
// text, and every mark on it, keep their coordinates exactly.
//
// ── Repeatable, and reversible ────────────────────────────────────────────
//
// The page's original box is written into the page the first time, as
// /RecallBaseBox, and every later change starts from it rather than from the
// box as it now is — so changing 60mm to 40mm is 40mm, not 100mm, and "None"
// puts the page back exactly as it came. The paper is one content stream put
// FIRST in the page's /Contents (under everything the page draws) and named by
// /RecallMargin on the page, which is how the next change finds it and takes
// it out again.
//
// Pure in its inputs: handed the pdf-lib namespace and the bytes, it returns
// bytes, so tools/pdf-margins-check.mjs drives it in Node with no browser.

import { BLANK_PAPERS, paperStream } from "./blank-pdf.js?v=__BUILD__";

export const MARGIN_PAPERS = BLANK_PAPERS;
export const MARGIN_PAPER_DEFAULT = "blank";
// Points per millimetre — the dialog speaks mm, the file points.
export const PT_PER_MM = 72 / 25.4;
// The widest any one side may be, in mm. 150mm is most of an A4 page again:
// enough for a full notes column, not enough to bury the paper in white.
export const MARGIN_MAX_MM = 150;

const BASE_KEY = "RecallBaseBox";
const PAPER_KEY = "RecallMargin";
const MARGIN_SIDES = ["top", "right", "bottom", "left"];

// A margin spec, cleaned: four non-negative sizes in POINTS and a paper.
export function normalizeMargins(spec) {
  const source = spec && typeof spec === "object" ? spec : {};
  const max = MARGIN_MAX_MM * PT_PER_MM;
  const out = {};
  for (const side of MARGIN_SIDES) {
    const value = Number(source[side]);
    out[side] = Number.isFinite(value) && value > 0 ? Math.round(Math.min(max, value) * 100) / 100 : 0;
  }
  out.paper = MARGIN_PAPERS.includes(source.paper) ? source.paper : MARGIN_PAPER_DEFAULT;
  return out;
}

export function hasMargins(spec) {
  const m = normalizeMargins(spec);
  return MARGIN_SIDES.some((side) => m[side] > 0);
}

// The sides as the reader SEES them, turned into the sides of the page's user
// space. A page with /Rotate 90 is shown turned a quarter clockwise, so what
// the reader calls its right is the top of its box — and a "wide right" margin
// has to land there, or it lands at the foot of the page on screen.
export function userSides(margins, rotation) {
  const v = normalizeMargins(margins);
  switch (((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360) {
    case 90: return { top: v.right, bottom: v.left, left: v.top, right: v.bottom };
    case 180: return { left: v.right, right: v.left, bottom: v.top, top: v.bottom };
    case 270: return { bottom: v.right, top: v.left, right: v.top, left: v.bottom };
    default: return { top: v.top, right: v.right, bottom: v.bottom, left: v.left };
  }
}

// From the page as SEEN (origin at its lower left, as the reader looks at it)
// to user space, for a box [x0, y0, x1, y1] turned by `rotation` — so the paper
// is ruled across the page the reader sees, not across the page's own axes.
// Returns the matrix and the size of the box as seen.
export function seenToUser(box, rotation) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  switch (((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360) {
    case 90: return { matrix: [0, 1, -1, 0, x1, y0], width: h, height: w };
    case 180: return { matrix: [-1, 0, 0, -1, x1, y1], width: w, height: h };
    case 270: return { matrix: [0, -1, 1, 0, x0, y1], width: h, height: w };
    default: return { matrix: [1, 0, 0, 1, x0, y0], width: w, height: h };
  }
}

const pdfNum = (value) => String(Number(Number(value).toFixed(2)));

// The content stream that paints the margin of one page: the paper, clipped to
// the ring between the grown box and the page as it was, then a faint line
// where the page used to end so the reader can still see its edge.
export function marginPaperStream(box, base, rotation, paper) {
  const [x0, y0, x1, y1] = box;
  const [bx0, by0, bx1, by1] = base;
  const seen = seenToUser(box, rotation);
  const sheetOps = paperStream(paper, {
    x: 0,
    y: 0,
    width: seen.width,
    height: seen.height,
    // A margin is a strip, often a narrow one: the ruled lines run edge to
    // edge with a small inset, and there is no notebook margin line in it.
    ruleFrom: 8,
    ruleInset: 8,
    marginLine: false
  });
  return [
    "q",
    // The even-odd rule makes the clip the ring: inside the grown box and
    // outside the page as it was.
    `${pdfNum(x0)} ${pdfNum(y0)} ${pdfNum(x1 - x0)} ${pdfNum(y1 - y0)} re`,
    `${pdfNum(bx0)} ${pdfNum(by0)} ${pdfNum(bx1 - bx0)} ${pdfNum(by1 - by0)} re`,
    "W* n",
    "q",
    `${seen.matrix.map(pdfNum).join(" ")} cm`,
    sheetOps,
    "Q",
    "Q",
    "q",
    "0.78 0.78 0.78 RG",
    "0.6 w",
    `${pdfNum(bx0)} ${pdfNum(by0)} ${pdfNum(bx1 - bx0)} ${pdfNum(by1 - by0)} re`,
    "S",
    "Q"
  ].join("\n");
}

function rectangleOf(array) {
  if (!array || typeof array.asRectangle !== "function") return null;
  try {
    const r = array.asRectangle();
    const xs = [r.x, r.x + r.width];
    const ys = [r.y, r.y + r.height];
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1] ? box : null;
  } catch {
    return null;
  }
}

// The page as the reader saw it before any margin: the box stored the first
// time, or — the first time — the crop box inside the media box, which is the
// rectangle pdf.js shows (page.view).
function basePageBox(PDFLib, page) {
  const { PDFName, PDFArray } = PDFLib;
  const stored = page.node.lookupMaybe?.(PDFName.of(BASE_KEY), PDFArray) || null;
  const kept = rectangleOf(stored);
  if (kept) return { box: kept, stored: true };
  const media = rectangleOf(page.node.MediaBox());
  if (!media) return { box: null, stored: false };
  const crop = rectangleOf(page.node.CropBox?.());
  if (!crop) return { box: media, stored: false };
  const box = [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])];
  return { box: box[2] > box[0] && box[3] > box[1] ? box : media, stored: false };
}

// The page's content streams as a list of references, with the margin's paper
// taken out if a previous change put one in.
function contentRefs(PDFLib, doc, page, drop) {
  const { PDFName, PDFArray, PDFRef } = PDFLib;
  const raw = page.node.get(PDFName.of("Contents"));
  let refs = [];
  if (raw instanceof PDFArray) refs = raw.asArray();
  else if (raw instanceof PDFRef) refs = [raw];
  else if (raw) refs = [doc.context.register(raw)];
  const gone = drop ? drop.toString() : "";
  return gone ? refs.filter((ref) => String(ref) !== gone) : refs;
}

function setBoxes(page, [x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  page.setMediaBox(x0, y0, w, h);
  page.setCropBox(x0, y0, w, h);
  page.setBleedBox(x0, y0, w, h);
  page.setTrimBox(x0, y0, w, h);
  page.setArtBox(x0, y0, w, h);
}

// The bytes with `margins` on every page (or with none, which takes them off).
// `margins` is in points, sides as the reader sees the page. Resolves
// { bytes, pages, boxes } — boxes[i] the new [x0, y0, x1, y1] of page i+1;
// throws a MarginsError with a `code` the caller can turn
// into words: "encrypted" for a file pdf-lib cannot rewrite faithfully.
export class MarginsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export async function applyPdfMargins(PDFLib, bytes, margins) {
  const { PDFDocument, PDFName } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  // An encrypted file's streams are written back still encrypted, and the
  // paper added beside them would not be: a reader decrypting the result gets
  // garbage for one or the other. Refused rather than half done.
  if (doc.isEncrypted) throw new MarginsError("encrypted", "This PDF is encrypted");
  const spec = normalizeMargins(margins);
  const on = hasMargins(spec);
  const pages = doc.getPages();
  // One stream per distinct page shape, shared by every page that has it: a
  // three-hundred-page book of identical pages carries one sheet, not three
  // hundred. Keyed by box, base and turn — the only inputs to the stream.
  const shared = new Map();
  // Each page's box as it will be — for the caller to ask whether anything
  // written in a margin being taken away would be left off the page.
  const boxes = [];
  for (const page of pages) {
    const { box: base, stored } = basePageBox(PDFLib, page);
    boxes.push(null);
    if (!base) continue;
    const rotation = page.getRotation?.().angle || 0;
    const previous = page.node.get(PDFName.of(PAPER_KEY)) || null;
    const refs = contentRefs(PDFLib, doc, page, previous);
    page.node.delete(PDFName.of(PAPER_KEY));
    if (!on) {
      // Back to the page as it came. A page that never had a margin is left
      // exactly as it is — not even its boxes are rewritten.
      if (stored) {
        setBoxes(page, base);
        page.node.delete(PDFName.of(BASE_KEY));
      }
      if (previous) page.node.set(PDFName.of("Contents"), doc.context.obj(refs));
      boxes[boxes.length - 1] = base;
      continue;
    }
    if (!stored) page.node.set(PDFName.of(BASE_KEY), doc.context.obj(base));
    const side = userSides(spec, rotation);
    const box = [base[0] - side.left, base[1] - side.bottom, base[2] + side.right, base[3] + side.top];
    setBoxes(page, box);
    boxes[boxes.length - 1] = box;
    const key = `${box.join(",")}|${base.join(",")}|${rotation}|${spec.paper}`;
    let paperRef = shared.get(key);
    if (!paperRef) {
      paperRef = doc.context.register(doc.context.flateStream(marginPaperStream(box, base, rotation, spec.paper)));
      shared.set(key, paperRef);
    }
    page.node.set(PDFName.of(PAPER_KEY), paperRef);
    page.node.set(PDFName.of("Contents"), doc.context.obj([paperRef, ...refs]));
  }
  const out = await doc.save();
  return { bytes: out, pages: pages.length, boxes };
}

// What a PDF's pages carry now, read back from the bytes: the margin each side
// has (as the reader sees the first page), or null when there is none. For the
// dialog to open on the truth even when the record was lost to a sync.
export async function readPdfMargins(PDFLib, bytes) {
  const { PDFDocument, PDFName, PDFArray } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const page = doc.getPages()[0];
  if (!page) return null;
  const base = rectangleOf(page.node.lookupMaybe?.(PDFName.of(BASE_KEY), PDFArray));
  const box = rectangleOf(page.node.MediaBox());
  if (!base || !box) return null;
  const user = { left: base[0] - box[0], bottom: base[1] - box[1], right: box[2] - base[2], top: box[3] - base[3] };
  // ...and back from the page's sides to the reader's, which is the inverse
  // turn: userSides at -rotation.
  const rotation = page.getRotation?.().angle || 0;
  const seen = userSides(user, (360 - rotation) % 360);
  return { top: seen.top, right: seen.right, bottom: seen.bottom, left: seen.left };
}
