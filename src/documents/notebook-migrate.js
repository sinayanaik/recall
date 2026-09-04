// Bringing an older notebook onto real paper.
//
// Before the Handwritten Notes surface became the Document surface, a notebook's
// pages were records in `meta.pages` — a page size, a paper, and the strokes on
// it — with typed boxes in `meta.textBoxes` beside them. That model is gone. The
// handwriting it holds is not, and this is what carries it across.
//
// ── What "safe" means here, concretely ────────────────────────────────────
//
// Four properties, and each one is a way this could otherwise lose an
// afternoon's work:
//
//   1. NOTHING IS DELETED BEFORE ITS REPLACEMENT EXISTS. The legacy keys are
//      removed in the same write that adds the ink records they became, so
//      there is no moment at which the strokes live nowhere. A failure before
//      that write leaves the deck exactly as it was, and the next open tries
//      again.
//   2. IT RUNS AT MOST ONCE. The plan is computed from the legacy keys and the
//      legacy keys are gone afterwards, so a second run has nothing to find.
//      Getting this wrong would duplicate every page on every open.
//   3. IT NEEDS NO NETWORK. The paper is generated locally and the upload is
//      best-effort, exactly as it is for a page added by hand.
//   4. IT REFUSES NOTHING ANY MORE, AND THAT IS THE FIX. It used to refuse a
//      deck that already had somebody else's PDF, because there was one document
//      slot and the deck's paper was in it — so those strokes, which are
//      coordinates into a page this app generated, had nowhere honest to go. A
//      deck has two slots now (src/documents/doc-slot.js), and the generated
//      pages go in the one that was made for them.
//
// ── The coordinates ───────────────────────────────────────────────────────
//
// The old page was 794x1123 CSS pixels — A4 at 96dpi, with y running DOWN from
// the top corner, because that is what a browser does. A PDF page is 595x842
// points — A4 at 72dpi, with y running UP from the bottom corner, because that
// is what PostScript did. So the conversion is a scale of 72/96 and a FLIP, and
// the flip is the part that is easy to get wrong and impossible to miss when it
// is wrong: everything lands mirrored top to bottom.
//
// The scale is exactly 0.75 rather than 595/794, which differs from it by four
// hundredths of a point across a whole page. Uniform, because a stroke's nib
// width is one number and cannot be scaled two ways.

import { BLANK_PAGE_HEIGHT, BLANK_PAGE_WIDTH, normalizeBlankPaper } from "./blank-pdf.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, stampDocSlotAll } from "./doc-slot.js?v=__BUILD__";
import { decodeInkStrokes, encodeInkStrokes, inkStrokesBounds } from "../format/ink-strokes.js?v=__BUILD__";

// 72 points per inch over 96 CSS pixels per inch. The old page model was A4 at
// 96dpi and a PDF page is A4 at 72dpi, so this is the whole of it.
export const LEGACY_SCALE = 72 / 96;

// The version of the ink wire format a record carries. Read from the same place
// pdf-ink.js writes it, rather than restated, so a bump cannot leave the
// migration writing records nothing will decode.
export const LEGACY_INK_FORMAT_VERSION = 1;

export function hasLegacyNotebook(meta) {
  const pages = Array.isArray(meta?.pages) ? meta.pages : [];
  const boxes = Array.isArray(meta?.textBoxes) ? meta.textBoxes : [];
  return pages.length > 0 || boxes.length > 0;
}

// One legacy point to one PDF point. `x` scales; `y` scales and flips.
function toPdfPoint(x, y) {
  return [x * LEGACY_SCALE, BLANK_PAGE_HEIGHT - (y * LEGACY_SCALE)];
}

// ── The plan ───────────────────────────────────────────────────────────────
//
// A PURE function: legacy meta in, the records that should replace it out, and
// not one side effect between. That is what lets tools/handwriting-check.mjs
// drive the conversion in plain Node with no browser and no deck — and the
// conversion, not the plumbing round it, is where a coordinate flip or a lost
// page would actually hide.
//
// `mintId` is injected for the same reason: the real one reads the deck's note
// to guarantee a fresh id, and a plan should not need a deck to be computed.
export function planLegacyNotebookMigration(meta, { mintId = null } = {}) {
  const legacyPages = (Array.isArray(meta?.pages) ? meta.pages : [])
    .filter((page) => page && typeof page === "object" && page.id)
    .map((page, index) => ({
      id: String(page.id),
      order: Number.isFinite(Number(page.order)) ? Number(page.order) : index,
      paper: page.paper,
      ink: Array.isArray(page.ink) ? page.ink.filter((s) => typeof s === "string") : []
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const legacyBoxes = (Array.isArray(meta?.textBoxes) ? meta.textBoxes : [])
    .filter((box) => box && typeof box === "object" && box.id && box.page);

  // Page ids become page NUMBERS, one-based and in reading order. A box or a
  // stroke whose page is not in the list has nothing to be on, and is counted
  // rather than silently dropped — see `orphans` below.
  const numberOf = new Map(legacyPages.map((page, index) => [page.id, index + 1]));

  let counter = 0;
  const nextId = typeof mintId === "function"
    ? mintId
    : () => `mg-${(counter += 1).toString(36).padStart(4, "0")}`;

  // One ink mark per page, because that is exactly what the old model held: a
  // page's strokes were one array with no grouping in it, so inventing marks
  // here would be inventing a structure the reader never made.
  const ink = [];
  legacyPages.forEach((page, index) => {
    const strokes = decodeInkStrokes(page.ink);
    if (!strokes.length) return;
    const moved = strokes.map((stroke) => {
      const points = Array.isArray(stroke?.p) ? stroke.p : [];
      const out = new Array(points.length);
      for (let i = 0; i + 2 < points.length; i += 3) {
        const [x, y] = toPdfPoint(points[i], points[i + 1]);
        out[i] = x;
        out[i + 1] = y;
        out[i + 2] = points[i + 2];
      }
      return { ...stroke, w: (Number(stroke.w) || 1) * LEGACY_SCALE, p: out };
    });
    const encoded = encodeInkStrokes(moved);
    if (!encoded.length) return;
    const box = inkStrokesBounds(moved);
    ink.push({
      id: nextId(),
      color: "yellow",
      page: index + 1,
      anchor: null,
      focus: null,
      text: "",
      quads: box ? [{ page: index + 1, rect: [box.minX, box.minY, box.maxX, box.maxY] }] : [],
      kind: "ink",
      ink: { v: LEGACY_INK_FORMAT_VERSION, s: encoded },
      at: Date.now()
    });
  });

  let orphans = 0;
  const blocks = [];
  legacyBoxes.forEach((box) => {
    const page = numberOf.get(String(box.page));
    if (!page) { orphans += 1; return; }
    const w = Math.max(1, Number(box.w) || 0) * LEGACY_SCALE;
    const h = Math.max(1, Number(box.h) || 0) * LEGACY_SCALE;
    // The old y was the box's TOP edge measured down the page; a block's y is
    // its BOTTOM edge measured up. So the bottom is the far edge of the box,
    // flipped — not the near one.
    const [x, top] = toPdfPoint(Number(box.x) || 0, Number(box.y) || 0);
    blocks.push({
      id: nextId(),
      page,
      x: Math.round(x),
      y: Math.round(top - h),
      w: Math.round(w),
      h: Math.round(h),
      z: Number(box.z) || 0,
      md: typeof box.md === "string" ? box.md : "",
      at: Number(box.at) || Date.now()
    });
  });

  return {
    // At least one page: a notebook whose every page was blank is still a
    // notebook, and handing back zero pages would produce a PDF with none.
    pages: Math.max(1, legacyPages.length),
    paper: normalizeBlankPaper(legacyPages[legacyPages.length - 1]?.paper),
    width: BLANK_PAGE_WIDTH,
    height: BLANK_PAGE_HEIGHT,
    ink,
    blocks,
    orphans
  };
}

// The keys the old model owned. Listed once, so removing them and describing
// them in the backup's coverage table cannot drift apart.
export const LEGACY_NOTEBOOK_KEYS = ["pages", "textBoxes", "deletedPageIds", "deletedTextBoxIds"];

// ── The second migration: out of the document slot, into the notebook slot ──
//
// The first version of the real-paper notebook put its generated PDF in
// `meta.pdf`, because that was the only slot there was. That is what made a deck
// able to have a notebook OR a paper and never both. `meta.notebook` is the slot
// those bytes belong in, and this moves them.
//
// Pure, like everything else in this file: it computes the meta a deck should
// have and touches nothing. The bytes are moved by the caller, in the order
// src/documents/notebook.js keeps for every other write.
export function hasNotebookInPdfSlot(meta) {
  return Boolean(meta?.pdf?.notebook) && !meta?.notebook;
}

// Which records move. A deck in this state has exactly one document, so
// everything measured against it is the notebook's — including highlights, which
// on generated paper can only have come from a region drawn round somebody's own
// handwriting. Records already stamped for a slot are left as they are, so this
// is safe to run twice even though it never has to be.
export function movedNotebookSlotMeta(meta) {
  const next = { ...(meta && typeof meta === "object" ? meta : {}) };
  next.notebook = { ...next.pdf };
  delete next.pdf;
  if (Array.isArray(next.pdfHighlights)) next.pdfHighlights = stampDocSlotAll(next.pdfHighlights, DOC_SLOT_NOTEBOOK);
  if (Array.isArray(next.pdfBlocks)) next.pdfBlocks = stampDocSlotAll(next.pdfBlocks, DOC_SLOT_NOTEBOOK);
  return next;
}

// The meta a migrated deck should have, given the plan and the paper that was
// generated for it. Also pure — the caller does the writing.
export function migratedNotebookMeta(meta, plan, pdf) {
  const next = { ...(meta && typeof meta === "object" ? meta : {}) };
  LEGACY_NOTEBOOK_KEYS.forEach((key) => { delete next[key]; });
  // The NOTEBOOK slot, not the document slot. A deck that also carries a paper
  // of its own keeps it, which is the whole of what the old refusal was for.
  next.notebook = pdf;
  // Merged, never assigned: a deck can already carry highlights of its own, and
  // the ids minted here are from the same namespace. Everything coming out of
  // the plan is a coordinate into the generated pages, so it is stamped as the
  // notebook's; the deck's existing records are left exactly as they are.
  next.pdfHighlights = [
    ...(Array.isArray(meta?.pdfHighlights) ? meta.pdfHighlights : []),
    ...stampDocSlotAll(plan.ink, DOC_SLOT_NOTEBOOK)
  ];
  if (plan.blocks.length) {
    next.pdfBlocks = [
      ...(Array.isArray(meta?.pdfBlocks) ? meta.pdfBlocks : []),
      ...stampDocSlotAll(plan.blocks, DOC_SLOT_NOTEBOOK)
    ];
  }
  return next;
}
