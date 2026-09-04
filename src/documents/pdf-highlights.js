// Highlights on the Document surface.
//
// The promise this pays for is "it works exactly like the notes do", and the
// way it keeps that promise is by reusing the machinery rather than
// re-implementing it:
//
//   colours    the same four tokens as a <mark> (format/highlight-colors.js),
//              so a document highlight and a note highlight are the same yellow
//              in every one of this app's themes.
//   notes      the same "## Highlight Notes" section at the end of state.notes,
//              keyed by the same hn-xxxx ids (format/highlight-notes.js). A
//              document highlight's id IS that id, which is why
//              setHighlightNoteInSource and the note editor are reused
//              unchanged rather than forked.
//   the menu   the same mark menu, given a different handler set.
//   the panel  the same Highlights tab, given a second row source.
//
// What is NOT shared is where the highlight itself lives. A <mark> is spliced
// into markdown; there is no markdown here, so a record goes in
// `meta.pdfHighlights` — an array on the deck's existing JSONB meta bag, no new
// table and no new column.

import { activeDocSlot, recordsInSlot, recordsOutsideSlot, stampDocSlotAll } from "./doc-slot.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { stripInvalidUnicode } from "../core/text.js?v=__BUILD__";
import { quadToPageBox, textForAnchorRange, textItemBox } from "./pdf-selection.js?v=__BUILD__";
import { pdfMarkLayer, pdfPageTextItems, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { decodeInkStrokes, inkStrokeHitsPoint } from "../format/ink-strokes.js?v=__BUILD__";
import { notifyHighlightsChanged } from "../format/highlight-edit.js?v=__BUILD__";
import { pruneOrphanHighlightNotes, readHighlightNotes, setHighlightNoteInSource } from "../format/highlight-notes.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { closeMarkMenu, openMarkMenuWith } from "../notes/mark-menu.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { dropHighlightTombstonesForLiveIds, recordDeletedHighlightId } from "../sync/document-sync.js?v=__BUILD__";

export const PDF_MARK_CLASS = "pdf-mark";

// How long a jumped-to highlight pulses. Matched to revealNoteMark's own flash
// so arriving at a highlight feels the same whichever surface it is on.
export const PDF_MARK_FLASH_MS = 1400;

// ── The records ─────────────────────────────────────────────────────────────

// ── One array, two papers ──────────────────────────────────────────────────
//
// A deck can carry its own paper AND a notebook (src/documents/doc-slot.js), and
// both keep their marks in this one array with a `doc` field saying which. Every
// reader on a surface wants only the surface it is looking at, so that is what
// this returns — the filter is here rather than at each of its callers because
// there are dozens of them and one that forgot would paint a notebook's strokes
// onto somebody's preprint.
export function documentHighlights() {
  return recordsInSlot(state.meta?.pdfHighlights, activeDocSlot());
}

// Both papers' records, for the callers that mean the DECK rather than the
// surface: the sync merge, the backup, the reconcile, and the prune that asks
// which highlight notes still have a highlight.
export function allDocumentHighlights() {
  const list = state.meta?.pdfHighlights;
  return Array.isArray(list) ? list : [];
}

// The array as it must be STORED: the surface's records, stamped with the slot
// they belong to, plus the other paper's untouched.
//
// Every write in this file assigns a whole array, because that is what makes one
// autosave one consistent picture. With two papers sharing the array, a write
// that assigned only its own records would silently delete the other paper's —
// a preprint's highlights lost the first time somebody drew in the notebook
// beside it. This is the one function that stops that, and it is idempotent, so
// a caller that assigns through it and then commits through it again is fine.
function wholeHighlightArray(next) {
  const slot = activeDocSlot();
  return recordsOutsideSlot(state.meta?.pdfHighlights, slot).concat(stampDocSlotAll(next, slot));
}

// "Does this deck have a document with marks on it?" — which is a different
// question from "does this deck have a PDF", now that a deck can carry a
// notebook and no paper at all. Asked by the Highlights panel and its export to
// decide whether to look at documentHighlights(), so a deck whose only document
// is one it wrote itself would otherwise have every mark in it left off both.
export function isPdfDeck() {
  return Boolean(state.meta?.pdf || state.meta?.notebook);
}

// Reading order, which is also the order the Highlights panel lists them in:
// by page, then down the page. Stored order is creation order, and a reader who
// goes back to annotate page 2 after finishing page 9 does not want that row
// at the bottom of the list.
// ── Lines, in PDF user space ───────────────────────────────────────────────
//
// A "line" here is a band of y values on one page: the geometry the file itself
// carries, read straight off record.quads[].rect and deliberately NOT through
// quadToPageBox, which needs a live viewport and therefore a page that is
// currently rendered. The Highlights panel has to work with the document closed
// and with an offloaded file, so nothing about which highlights share a line
// can depend on anything being on screen.
//
// PDF user space has its origin at the bottom left, so rect is
// [x0, yBottom, x1, yTop] and a LARGER y is higher up the page.
function firstQuadOn(record) {
  const page = Number(record?.page || 0);
  const quads = record?.quads || [];
  return quads.find((quad) => quad.page === page) || quads[0] || null;
}

// Two highlights are on the same line when their quads' y ranges overlap by
// more than half the shorter one. Not "the same y": a superscript, a different
// font size, or two runs the producer emitted at slightly different baselines
// all sit on one line to a reader and differ by a point or two here. The same
// argument QUAD_MERGE_TOLERANCE makes in pdf-selection.js, as a fraction rather
// than an absolute, because it has to hold at any font size.
export const LINE_BAND_OVERLAP = 0.5;

export function sameDocumentLine(a, b) {
  const qa = firstQuadOn(a);
  const qb = firstQuadOn(b);
  if (!qa || !qb || qa.page !== qb.page) return false;
  const [, aBottom, , aTop] = qa.rect;
  const [, bBottom, , bTop] = qb.rect;
  const overlap = Math.min(aTop, bTop) - Math.max(aBottom, bBottom);
  if (overlap <= 0) return false;
  const shorter = Math.min(aTop - aBottom, bTop - bBottom);
  return shorter > 0 && overlap / shorter > LINE_BAND_OVERLAP;
}

export function documentHighlightsInReadingOrder() {
  return documentHighlights().slice().sort((a, b) => {
    if (a.page !== b.page) return (a.page || 0) - (b.page || 0);
    const qa = firstQuadOn(a);
    const qb = firstQuadOn(b);
    // Larger y is HIGHER on the page — PDF user space has its origin at the
    // bottom left, so reading order is descending y.
    const down = (qb?.rect?.[3] || 0) - (qa?.rect?.[3] || 0);
    // ...and WITHIN a line, left to right. This tiebreak was missing, so two
    // highlights on one line fell through to Array.sort's stability — which is
    // to say to the order they were CREATED in. Highlight the end of a line and
    // then its beginning and the panel listed them backwards, and the numbered
    // badges printed on the page counted right-to-left. Compared by line band
    // rather than by exact y, or a two-point baseline difference puts two words
    // of one sentence in different "rows" again.
    if (sameDocumentLine(a, b)) return (qa?.rect?.[0] || 0) - (qb?.rect?.[0] || 0);
    return down;
  });
}

export function documentHighlightById(id) {
  return documentHighlights().find((record) => record.id === id) || null;
}

// Every live id, for pruneOrphanHighlightNotes and for minting the next one.
// A document highlight's id is a highlight-note id, so the notes section has to
// count these as live or every note written on a PDF would be pruned away the
// next time a <mark> was edited.
//
// The WHOLE deck, not the surface: ids are one namespace shared with the note
// body, so a paper and the notebook beside it must never mint the same one.
export function documentHighlightNoteIds() {
  return allDocumentHighlights().map((record) => record.id).filter(Boolean);
}

// Ids are minted the same way format/highlight-notes.js mints them, and
// deliberately in the same namespace: this IS a highlight-note id. Uniqueness
// is checked against both the records and the note text, since either can
// already be using one.
//
// ── The check that was missing, and what it cost ──────────────────────────
//
// This tested the note text for `[id]` and `"id"` — the two LEGACY forms, a
// heading entry and a base64 data-note attribute — and not for `hn:${id}`,
// which is the marker the current fenced format actually uses
// (ENTRY_MARKER_RE, src/format/highlight-notes.js). Its twin
// freshHighlightNoteId does test for it.
//
// So an id already owned by a live `<!--hn:X …-->` entry could be minted
// again, and the brand-new highlight then wore that entry's note: "in
// highlighted notes I'm seeing a random note from another highlight area",
// exactly. pruneOrphanHighlightNotes is thorough and counts meta.pdfHighlights
// as live, so reaching this needs a route that skips it — a sync merge that
// carried the note tail without the record, a restore, a hand-edit — but every
// one of those is a route a reader can be on, and the fix is one line.
//
// The id is six characters rather than four for the same reason. Four base-36
// characters is a 1.7-million space that the birthday bound turns into an even
// chance of a collision at about 1,500 highlights, which a heavily annotated
// book reaches; and `Math.random().toString(36).slice(2, 6)` can return FEWER
// than four when the fraction is short, shrinking it further. Existing ids stay
// valid: nothing here parses an id's length, it only compares them.
export function freshDocumentHighlightId() {
  const taken = new Set(documentHighlightNoteIds());
  const notes = state.notes || "";
  for (;;) {
    const id = `hn-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (taken.has(id)) continue;
    if (notes.includes(`hn:${id}`)) continue;
    if (!notes.includes(`[${id}]`) && !notes.includes(`"${id}"`)) return id;
  }
}

// The one write path. Every mutation goes through here so the two calls that
// have to follow a highlight change — the autosave and the panel refresh —
// cannot be forgotten. Exactly the pair rewriteHighlightGroup makes for a
// <mark> (src/format/highlight-edit.js).
// `notify` is the opt-out, and only the opt-out: the autosave is unconditional,
// because a record that is not written down is a record that is lost. What a
// caller can decline is TELLING everything — which rebuilds the Highlights panel
// and every printed notes page in the document, and is far too much to do per
// keystroke-pause or once per page as it paints. Both of the callers that
// decline it arrange for exactly one notify of their own afterwards.
function commitDocumentHighlights(next, { notify = true } = {}) {
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
  const whole = wholeHighlightArray(next);
  state.meta.pdfHighlights = whole;
  // A highlight that is PRESENT is not deleted — the invariant
  // dropTombstonesForLiveCards keeps for cards, and for the same reason: an id
  // that comes back (an undo, a re-import of the same annotated file) would
  // otherwise keep a tombstone that quietly blocks it from ever syncing again.
  // Asked of the WHOLE array: a tombstone is a deck-wide record, and testing it
  // against one paper's marks would retire the other paper's ids on every write.
  const tombstones = dropHighlightTombstonesForLiveIds(state.meta, whole);
  if (tombstones) state.meta.deletedHighlightIds = tombstones;
  else delete state.meta.deletedHighlightIds;
  scheduleDeckAutosave();
  if (notify) notifyHighlightsChanged();
}

// What to CALL a highlight in a list — the Highlights panel, an export, the
// heading of its note.
//
// A text highlight is its own words and always has been. A region drawn around a
// photograph has no words at all, and a blank row in a list of highlights is
// indistinguishable from a bug, so it is named by where it is instead. (A region
// around a boxed equation or a table usually DOES pick up text, and then it is
// called by that text like anything else.)
export function documentHighlightLabel(record) {
  const text = String(record?.text || "").trim();
  if (text) return text;
  const page = Number(record?.page || record?.quads?.[0]?.page || 0);
  // Ink has no words by definition — it is handwriting, and this app does not
  // read handwriting. Named by where it is, exactly as a region round a
  // photograph is, because a blank row in a list of marks is indistinguishable
  // from a bug.
  if (record?.kind === "ink") return page ? `Ink · page ${page}` : "Ink";
  return page ? `Region · page ${page}` : "Region";
}

// ── Moving every record between pages at once ─────────────────────────────
//
// One caller: tearing a page out of a notebook (src/documents/notebook.js). The
// file is regenerated with one page fewer, so every record after the gap is now
// describing the wrong page — and a highlight that names page 7 of a six-page
// document is a highlight that can never be painted or jumped to again.
//
// `move` is handed each record and returns the page it should be on now, or
// null for a record whose page has gone. Both are needed together: the ones on
// the torn-out page have to be buried in the same write that renumbers the rest,
// or a sync landing between two writes would see one half of the change.
export function remapDocumentHighlightPages(move) {
  const before = documentHighlights();
  if (!before.length) return 0;
  const next = [];
  const gone = [];
  before.forEach((record) => {
    const to = move(record);
    if (to === null || to === undefined) { gone.push(record); return; }
    if (Number(record.page) === Number(to)) { next.push(record); return; }
    next.push({
      ...record,
      page: to,
      // The quads carry their own page — they are what a paint and a "Go to"
      // actually resolve against, so renumbering the record and not them would
      // leave the mark pointing at the page it used to be on.
      quads: Array.isArray(record.quads)
        ? record.quads.map((quad) => (quad && typeof quad === "object" ? { ...quad, page: to } : quad))
        : record.quads,
      at: Date.now()
    });
  });
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
  state.meta.pdfHighlights = wholeHighlightArray(next);
  if (gone.length) {
    // Written back into the meta on EVERY step, not once at the end.
    // recordDeletedHighlightId reads the bag off `meta` and returns a fresh one,
    // so a loop that keeps its answer in a local and assigns after the last
    // iteration hands every step the SAME starting bag — and only the final id
    // survives. Tearing out a page with four marks on it buried one of them and
    // let the other three come back from the other device on the next merge,
    // which is the whole failure this tombstone bag exists to stop.
    gone.forEach((record) => {
      state.meta.deletedHighlightIds = recordDeletedHighlightId(state.meta, record.id);
    });
    // Same ordering rule setDocumentInkForPage keeps: the records are in place
    // before the prune runs, because the prune asks meta.pdfHighlights what is
    // still live.
    const pruned = pruneOrphanHighlightNotes(state.notes || "");
    if (pruned !== state.notes) state.notes = pruned;
  }
  commitDocumentHighlights(next);
  return gone.length;
}

// A short label for the note section's heading, so a hand-edited note file
// still says which highlight each entry belongs to.
export function documentExcerptLabel(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
  return `“${clipped}”`;
}

// ── Repairing the words a highlight was stored with ────────────────────────
//
// "I'm seeing garbage value most of the time when I'm highlighting something and
// then try to write a note for it."
//
// buildTextLayer used to put one bare <span> per text item in the layer with
// nothing between them, and a highlight's text is range.toString() over that —
// which concatenates text data and ignores elements. So every selection that
// spanned more than one item was stored welded together: "DURRANT-WHYTE" and
// "Simultaneous Localization…" arriving as "DURRANT-WHYTESimultaneous…". That
// string is the highlight's name everywhere it appears — the note's excerpt, the
// Highlights panel, the printed notes page, every export — and there is no
// surface in the app that can fix it, because none of them owns it.
//
// The layer has separators now, so no NEW highlight can be stored that way. This
// is for the ones that already are. Every highlight also stored the { item, ch }
// anchors the selection was made at, and those are enough to read the same words
// back off the page's own text items exactly as a fresh capture would now
// produce them.
//
// ── What it will not touch ────────────────────────────────────────────────
//
// Only a record whose stored text and re-read text are the SAME CHARACTERS with
// different whitespace. That is the whole signature of this bug, and it is a
// test nothing else passes: a hand-edited excerpt, an annotation imported from
// the file with its own comment, a region named by where it is, a highlight
// whose page has been re-paginated — every one of those differs by more than
// whitespace and is left exactly as it is. A note's own text is never read or
// rewritten here; only the quoted label on it, which is regenerated on every
// save anyway.
function squashWhitespace(text) {
  return String(text || "").replace(/\s+/g, "");
}

// One notify for a whole sweep, not one per record or one per page.
//
// The repair runs from the page-painted hook, which is inside the layer build —
// notifying from there would rebuild the Highlights panel and every printed
// notes page in the middle of a page rendering, once per page, which is the
// churn this feature is otherwise being fixed to avoid.
let repairNotifyTimer = 0;

export const REPAIR_NOTIFY_MS = 120;

function scheduleRepairNotify() {
  clearTimeout(repairNotifyTimer);
  repairNotifyTimer = setTimeout(() => {
    repairNotifyTimer = 0;
    notifyHighlightsChanged();
  }, REPAIR_NOTIFY_MS);
}

export function repairDocumentHighlightText(pageNumber) {
  const items = pdfPageTextItems(pageNumber);
  if (!items?.length) return false;
  const records = documentHighlights();
  if (!records.length) return false;
  let notes = state.notes || "";
  // One parse for the sweep, not one per record. Reading it inside the map made
  // this the third place that re-read the whole fenced block per highlight, and
  // this one runs from the page-painted hook — see annotatedDocumentHighlights
  // for what that costs on a heavily annotated paper.
  //
  // Still correct after the writes below: setHighlightNoteInSource only rewrites
  // an entry's quoted LABEL here, never its text, so what this map holds stays
  // true for the whole sweep.
  const noteTextById = readHighlightNotes(notes);
  let changed = false;
  const next = records.map((record) => {
    // A region is named by where it is, not by what it says (see
    // documentHighlightLabel), and an imported annotation has no anchors to
    // read back from.
    if (record.kind === "area") return record;
    const quads = record.quads || [];
    if (!quads.length || quads.some((quad) => quad.page !== pageNumber)) return record;
    const stored = String(record.text || "");
    if (!stored) return record;
    const derived = textForAnchorRange(items, record.anchor, record.focus);
    if (!derived || derived === stored) return record;
    if (squashWhitespace(derived) !== squashWhitespace(stored)) return record;
    changed = true;
    const note = noteTextById.get(record.id) || "";
    // Only when there IS a note: setHighlightNoteInSource treats an empty text
    // as "remove this entry", so writing a label for a highlight that has no
    // note would be a no-op on a good day and a removal on a bad one.
    if (note) notes = setHighlightNoteInSource(notes, record.id, note, documentExcerptLabel(derived));
    // `at` deliberately does NOT move. This is a deterministic repair every
    // device makes for itself the first time it paints the page, not an edit —
    // and a bumped timestamp would let it out-rank a recolour somebody actually
    // made on another device.
    return { ...record, text: derived };
  });
  if (!changed) return false;
  if (notes !== state.notes) state.notes = notes;
  commitDocumentHighlights(next, { notify: false });
  scheduleRepairNotify();
  return true;
}

// ── The band a highlight is painted in ──────────────────────────────────────
//
// Every quad stored before the text layer learned about font ascents
// (src/documents/pdf-view.js, buildTextLayer) is a fifth of an em too high: its
// box ran from the top of the em to the BASELINE, so it sat above the words and
// left their descenders outside it. Fixing the capture fixes every highlight
// made from now on and not one that already exists — and a reader's existing
// highlights are the ones they were complaining about.
//
// So they are repaired, once, on the page they are on, against the only thing
// on that page that knows where the glyphs really are: the text items pdf.js
// handed over when the layer was built. `textItemBox` is the same conversion
// the importer already uses to decide which items an annotation covers, and it
// reports the box a glyph run actually occupies — baseline minus the descender,
// up through the ascender.
//
// A snap to real glyph boxes rather than an arithmetic shift by "about 0.2em"
// is what makes this safe to run over data whose provenance is not knowable: a
// quad that is already right lands on the same band and is left alone, and a
// quad with no text under it at all (a region, a scanned page) is declined.
export const QUAD_GEOMETRY_VERSION = 2;

// How much of an item's own height has to fall inside the quad before that item
// is taken as "the line this highlight is on". Generous, because the whole
// point is that the quad is currently offset — but not so generous that the
// line ABOVE, which a high quad can just touch, can win.
export const QUAD_SNAP_MIN_OVERLAP = 0.35;

// The line band under one quad, in PDF user space, or null when nothing is
// there to snap to.
//
// Horizontal overlap is required as well as vertical: a two-column paper has a
// second column at exactly the same height, and a band unioned across both
// would paint a highlight over the gutter and the neighbouring text.
export function lineBandForQuad(items, quad) {
  const [x0, y0, x1, y1] = quad.rect;
  let best = null;
  const boxes = [];
  items.forEach((item) => {
    if (!item?.str) return;
    const box = textItemBox(item);
    const height = box.y1 - box.y0;
    if (!(height > 0)) return;
    if (box.x1 <= x0 || box.x0 >= x1) return;
    const overlap = Math.min(box.y1, y1) - Math.max(box.y0, y0);
    if (overlap <= 0 || overlap < height * QUAD_SNAP_MIN_OVERLAP) return;
    boxes.push(box);
    if (!best || overlap > best.overlap) best = { box, overlap };
  });
  if (!best) return null;
  // The best-overlapping item names the line; everything else joins it only if
  // its own middle sits inside that line. Two lines can both clear the overlap
  // test above on a tightly-leaded page, and unioning them would double the
  // height of the band.
  let top = best.box.y1;
  let bottom = best.box.y0;
  boxes.forEach((box) => {
    const middle = (box.y0 + box.y1) / 2;
    if (middle < best.box.y0 || middle > best.box.y1) return;
    top = Math.max(top, box.y1);
    bottom = Math.min(bottom, box.y0);
  });
  return { y0: bottom, y1: top };
}

// Below this, in PDF points, the stored band and the glyph band are the same
// band and the record is only stamped. A tenth of a point is not a highlight
// that looks wrong; it is two ways of rounding the same number.
export const QUAD_SNAP_EPSILON = 0.1;

export function repairDocumentHighlightQuads(pageNumber) {
  const items = pdfPageTextItems(pageNumber);
  if (!items?.length) return false;
  const records = documentHighlights();
  if (!records.length) return false;
  let changed = false;
  const next = records.map((record) => {
    if (record.qv >= QUAD_GEOMETRY_VERSION) return record;
    const quads = record.quads || [];
    // Only when the WHOLE record is on this page. A highlight running across a
    // page break gets both halves right when the second page paints, and
    // stamping it after seeing only the first would leave that half high
    // forever. Tested before the kind, so a region is stamped on the page it is
    // actually on rather than by whichever page happened to paint first.
    if (!quads.length || quads.some((quad) => quad.page !== pageNumber)) return record;
    // A region is a box the reader drew round a figure. It was never measured
    // off the text layer, so there is nothing about it to correct — but it is
    // still STAMPED, so that "has this been looked at?" stays one comparison
    // instead of a kind test on every record on every page paint forever.
    if (record.kind === "area") {
      changed = true;
      return { ...record, qv: QUAD_GEOMETRY_VERSION };
    }
    let moved = false;
    const snapped = quads.map((quad) => {
      const band = lineBandForQuad(items, quad);
      if (!band) return quad;
      if (Math.abs(band.y0 - quad.rect[1]) < QUAD_SNAP_EPSILON
          && Math.abs(band.y1 - quad.rect[3]) < QUAD_SNAP_EPSILON) return quad;
      moved = true;
      return { ...quad, rect: [quad.rect[0], band.y0, quad.rect[2], band.y1] };
    });
    changed = true;
    // Stamped whether or not anything moved: the question "has this record been
    // through the repair?" has to be answerable without re-deriving it, or a
    // highlight already in the right place is re-measured on every page paint
    // for the rest of the deck's life.
    //
    // `at` deliberately does NOT move, for the reason repairDocumentHighlight
    // Text gives: this is a deterministic repair each device makes for itself,
    // not an edit, and a bumped timestamp would let it out-rank a recolour
    // somebody actually made somewhere else.
    return { ...record, quads: moved ? snapped : quads, qv: QUAD_GEOMETRY_VERSION };
  });
  if (!changed) return false;
  commitDocumentHighlights(next, { notify: false });
  // Repainted here rather than left to the caller. buildPageLayers paints the
  // marks BEFORE it calls the page-painted hook this repair runs from, so the
  // bands already on screen are the ones just corrected — without this the page
  // keeps the old geometry until something else happens to repaint it, which on
  // a page nobody touches again is never.
  //
  // No notify: the Highlights panel and the printed page notes list a
  // highlight's words and its note, neither of which a quad has anything to say
  // about, and this runs once per page as a document is read through.
  paintDocumentHighlights(pageNumber);
  return true;
}

// ── Create / recolour / remove ──────────────────────────────────────────────

export function addDocumentHighlight(capture, color = MARK_HIGHLIGHT_DEFAULT) {
  if (!capture?.quads?.length) return null;
  const record = {
    id: freshDocumentHighlightId(),
    color: MARK_HIGHLIGHT_HEX[color] ? color : MARK_HIGHLIGHT_DEFAULT,
    page: capture.page,
    anchor: capture.anchor,
    focus: capture.focus,
    // The chokepoint for every highlight however its text was captured — the
    // text layer, an imported annotation, a raw selection — and highlight text
    // is also what becomes a card's question later. See stripInvalidUnicode:
    // one U+0000 out of a glyph mapping fails the whole deck's sync.
    text: stripInvalidUnicode(capture.text || ""),
    quads: capture.quads,
    // "text" (a run of glyphs dragged across the text layer) or "area" (a box
    // dragged around a figure — see pdf-region.js). Stored rather than derived,
    // because the two are told apart by INTENT and not by shape: a region drawn
    // around a boxed equation picks up that equation's text, and would be
    // indistinguishable from a text selection afterwards. Everything downstream
    // reads it as an optional field, so a record written before this existed is
    // a text highlight, which it was.
    kind: capture.kind === "area" ? "area" : "text",
    // Which geometry these quads were measured with — see repairDocument
    // HighlightQuads. Stamped at birth so a highlight made TODAY is never
    // re-measured against the page it was made on: the repair exists for quads
    // captured before the text layer knew about font ascents, and a record
    // carrying the current version says it is not one of them.
    qv: QUAD_GEOMETRY_VERSION,
    // Per-record, and per-EDIT: the sync merge is a union by id with newest
    // winning, so a recolour made on a phone has to be able to out-rank the
    // original made on a laptop. A whole-deck last-write-wins would simply drop
    // one device's afternoon of reading.
    at: Date.now()
  };
  commitDocumentHighlights([...documentHighlights(), record]);
  paintDocumentHighlights(record.page);
  return record;
}

export function recolourDocumentHighlight(id, color) {
  const next = documentHighlights().map((record) =>
    record.id === id ? { ...record, color, at: Date.now() } : record);
  commitDocumentHighlights(next);
  repaintDocumentHighlights();
}

export function removeDocumentHighlight(id) {
  const record = documentHighlightById(id);
  if (!record) return;
  // An undo step, which this did not take. Deleting a <mark> in a note is
  // undoable (see rewriteHighlightGroup in src/format/highlight-edit.js) and
  // deleting a highlight on a paper was not — one mis-tap and a passage and its
  // note were simply gone. Taken before anything is written, so it holds the
  // note as it was.
  pushNotesUndo("remove highlight");
  const next = documentHighlights().filter((entry) => entry.id !== id);
  // ── The tombstone ────────────────────────────────────────────────────────
  //
  // Absence is ambiguous, here exactly as it is for a card: a highlight that is
  // gone on this device and present in the cloud is either a deletion to push or
  // an annotation to pull, and nothing in the records themselves says which. Up
  // to now the only thing that made a deleted highlight stay deleted was the
  // whole-column last-write-wins that this change removes — so without a
  // tombstone, taking the union of both sides would resurrect every highlight
  // anyone ever deleted, on their next sync.
  //
  // Same shape and same lifecycle as snapshot.deletedCardIds (see
  // src/sync/cards.js): { id: iso }, honoured by both the pull merge and the
  // pre-push reconcile, retired once the push that acts on it has landed, and
  // aged/capped so the bag cannot grow without limit.
  const tombstones = recordDeletedHighlightId(state.meta, id);
  // ── Prune BEFORE the commit, not after it ────────────────────────────────
  //
  // The note attached to this highlight would otherwise sit in the fenced
  // "Highlight Notes" block forever with nothing pointing at it — the same
  // cleanup removeHighlightAt does for a <mark>. It used to run after
  // commitDocumentHighlights, and commitDocumentHighlights is the only thing
  // that fires notifyHighlightsChanged(), which is the only thing that rebuilds
  // the Highlights panel and the printed page notes. So the panel was rebuilt
  // from a state.notes that still held the deleted highlight's note, and there
  // it stayed — visibly attached to nothing — until some unrelated edit
  // happened to refresh the panel again.
  //
  // pruneOrphanHighlightNotes reads state.meta.pdfHighlights to decide what is
  // live, so the records have to be in place first: assigned here, then
  // committed once, then everything told once.
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
  state.meta.pdfHighlights = wholeHighlightArray(next);
  state.meta.deletedHighlightIds = tombstones;
  const pruned = pruneOrphanHighlightNotes(state.notes || "");
  if (pruned !== state.notes) state.notes = pruned;
  commitDocumentHighlights(next);
  repaintDocumentHighlights();
}

// ── The note on a highlight ─────────────────────────────────────────────────
//
// Written straight into state.notes through the existing section writer. The
// deck's Notes tab is an ordinary markdown note, so a note taken on a PDF
// highlight is readable, editable and exportable exactly like one taken on a
// <mark> — including by hand, in any editor.

export function documentHighlightNote(id) {
  if (!id) return "";
  return readHighlightNotes(state.notes || "").get(id) || "";
}

// ── The number a highlight is shown as ──────────────────────────────────────
//
// Every annotated highlight on this paper, in reading order, with the number it
// wears. It lives HERE, beside the records and the ordering it is derived from,
// rather than in whichever surface happens to print it — and that is the point
// of the file it moved out of (src/documents/pdf-page-notes.js, which paints the
// badges) rather than a tidying preference. Three surfaces show this number now:
// the badge pinned to the highlight on the page, the note printed under that
// page, and the card in the side-by-side pane. A number that means one thing in
// two of them and something else in the third is worse than no number at all,
// and "we computed the same sequence the same way in three files" is exactly the
// guarantee that does not survive an edit to one of them.
//
// A highlight with NO note is not numbered and is not in this list. The number
// is the whole indicator — it says both "there is something written here" and
// "it is the third thing you wrote" — so numbering an unannotated highlight
// would promise something to read that does not exist.
//
// Rebuilt on demand rather than memoized: it is one pass over an array that is
// tens of entries long even for a heavily marked-up paper, and the note text it
// reads comes from state.notes, which any edit anywhere can replace.
export function annotatedDocumentHighlights() {
  // ONE parse for the whole list, not one per record — the same hoist
  // collectHighlightEntries and documentHighlightEntries already make, and the
  // note on both of them says why: documentHighlightNote(id) re-reads the fenced
  // block out of state.notes on every call, so asking it per record is quadratic
  // in how many highlights a paper has.
  //
  // This one mattered most and was the one missed. It runs from the page-painted
  // hook by way of paintPageNoteBadges, so the cost was paid again for every
  // page the reader scrolled past: measured on a 4-page paper at 3.9ms per four
  // pages with 25 annotated highlights and 312ms with 300, which is what
  // "rendering and scrolling became hella slow" is made of.
  const notes = readHighlightNotes(state.notes || "");
  const out = [];
  documentHighlightsInReadingOrder().forEach((record) => {
    const note = notes.get(record.id) || "";
    if (!note) return;
    out.push({ record, note, n: out.length + 1 });
  });
  return out;
}

// ...and the same answer as a lookup, for a caller that has an id in its hand
// rather than a list to walk. 0 for a highlight with nothing written about it,
// which is the same "no number" the page shows.
export function annotatedDocumentHighlightNumbers() {
  const numbers = new Map();
  annotatedDocumentHighlights().forEach(({ record, n }) => numbers.set(record.id, n));
  return numbers;
}

// `rerender` is the note editor's autosave option, and it is honoured here now.
//
// "Whenever I'm editing the highlight the whole PDF rendering gets refreshed."
//
// The editor saves as you type — one write per typing pause — and every one of
// those writes went through commitDocumentHighlights, whose notify rebuilds the
// Highlights panel AND tears down and re-creates every printed notes page in the
// document. So a sentence typed into a note re-laid out the whole paper
// underneath it, three or four times over, moving the reader each time.
//
// The editor has always said which writes are worth repainting for: it passes
// { rerender: false } on every autosave and calls repaint() exactly once on the
// way out (closeHighlightNoteEditor). The notes side honours that; the document
// side dropped it on the floor. Both agree now — and the deck autosave inside
// commitDocumentHighlights is unconditional either way, so nothing typed is at
// risk of not being written down.
// `notify` is a separate question from `rerender` — see the option list above
// rewriteFirstMarkNote, which is this verb's twin for a <mark>'s note and now
// takes the same three options by the same names. It DEFAULTS to `rerender`
// rather than to true, and only here: the one caller that passes { rerender:
// false } and nothing else is an editor saving on a typing pause, and printing
// a page's notes again between keystrokes is what made the paper jump under the
// note being written (see pageNotesSignature). A caller that wants the surfaces
// told without the paper repainted asks for it by name.
export function setDocumentHighlightNote(id, text, { undo = false, rerender = true, notify = rerender } = {}) {
  const record = documentHighlightById(id);
  if (!record) return false;
  // One snapshot per editing session, taken on the first write — the same
  // contract rewriteFirstMarkNote honours for a <mark>'s note. The document
  // handlers used to drop this option on the floor, so a note written on a
  // paper was the one kind of note in the app that could not be undone.
  if (undo) pushNotesUndo("highlight note");
  state.notes = setHighlightNoteInSource(state.notes || "", id, text, documentExcerptLabel(documentHighlightLabel(record)));
  // ── noteAt, and why `at` deliberately does NOT move here ─────────────────
  //
  // This used to bump `at`, on the reasoning that a note is an edit to the
  // highlight and the sync merge decides by timestamp. That was right while `at`
  // was the only stamp there was, and wrong the moment the merge started
  // resolving a highlight field by field: `at` is also bumped by a RECOLOUR, so
  // one stamp for two independent edits means whichever happened later silently
  // takes the other with it — a colour changed on a phone erasing a note written
  // on a laptop, or the reverse.
  //
  // So there are two stamps now, and each one dates exactly one thing: `at` for
  // the highlight itself (made, recoloured), `noteAt` for its note. Nothing else
  // writes noteAt. mergePdfHighlights resolves them independently, and
  // mergeHighlightNoteTails uses noteAt — and only noteAt — to settle two
  // versions of the same note's text.
  //
  // A record written before this existed carries no noteAt at all, which reads
  // as older than one that has one — the rule mergePdfHighlights and
  // betterReadingPosition already use for the same reason.
  commitDocumentHighlights(documentHighlights().map((entry) =>
    entry.id === id ? { ...entry, noteAt: Date.now() } : entry), { notify });
  return true;
}

export function clearDocumentHighlightNote(id, options) {
  return setDocumentHighlightNote(id, "", options);
}

// ── Painting ────────────────────────────────────────────────────────────────
//
// One absolutely-positioned div per quad, in the page's mark layer — which sits
// UNDER the text layer, so the reader still selects text through a highlight
// rather than selecting the highlight.
//
// The colours come from `--hl-<token>` custom properties rather than from
// MARK_HIGHLIGHT_HEX directly, for the same reason a <mark> does (see
// format/highlight-colors.js): an opaque swatch chosen at authoring time looks
// wrong the moment the theme changes, and these are alpha tints over whatever
// is behind them.
export function paintDocumentHighlights(pageNumber) {
  const layer = pdfMarkLayer(pageNumber);
  if (!layer) return;
  layer.innerHTML = "";
  const frag = document.createDocumentFragment();
  documentHighlights().forEach((record) => {
    // Ink paints itself, on its own canvas layer (src/documents/pdf-ink.js).
    // Its quad is a BOUNDING BOX and nothing else — it exists so that the
    // Highlights pane can crop a thumbnail, the note badge has a corner to sit
    // on and the export knows where the mark is. Drawn as a mark div it would
    // be a tinted rectangle over the reader's own handwriting.
    if (record.kind === "ink") return;
    (record.quads || []).forEach((quad) => {
      if (quad.page !== pageNumber) return;
      const box = quadToPageBox(quad);
      if (!box) return;
      const mark = document.createElement("div");
      mark.className = PDF_MARK_CLASS;
      mark.dataset.color = record.color || MARK_HIGHLIGHT_DEFAULT;
      // A region is drawn as an outline rather than tinted: `mix-blend-mode:
      // multiply` over a photograph washes out the figure being highlighted.
      // See styles/37-document-chrome.css.
      if (record.kind === "area") mark.dataset.kind = "area";
      mark.dataset.highlightId = record.id;
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      frag.appendChild(mark);
    });
  });
  layer.appendChild(frag);
}

// Every page currently carrying a mark layer. Called after any CRUD, because a
// highlight can span a page break and a recolour has to reach both halves.
export function repaintDocumentHighlights() {
  document.querySelectorAll(".pdf-page[data-page-number]").forEach((page) => {
    const pageNumber = Number(page.dataset.pageNumber);
    if (pageNumber && page.querySelector(".pdf-mark-layer")) paintDocumentHighlights(pageNumber);
  });
}

// Every painted quad belonging to one highlight. One highlight is several of
// them — a phrase spanning three lines is three boxes — so everything that acts
// on "the highlight on the page" acts on a list.
export function documentHighlightMarks(id) {
  if (!id) return [];
  return [...document.querySelectorAll(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(id)}"]`)];
}

// Pulse one highlight's quads, so a jump from a card or the highlights pane
// lands somewhere the reader can see it landed.
export function flashDocumentHighlight(id) {
  const marks = documentHighlightMarks(id);
  marks.forEach((mark) => {
    mark.classList.remove("is-flashing");
    // Forces the class removal to take effect before it is re-added, so a
    // second jump to the same highlight flashes again rather than doing
    // nothing.
    void mark.offsetWidth;
    mark.classList.add("is-flashing");
    setTimeout(() => mark.classList.remove("is-flashing"), PDF_MARK_FLASH_MS);
  });
  return marks.length > 0;
}

// The highlight under a tap, if any.
//
// Hit-tested against the RECORDS, geometrically — not by letting the mark divs
// receive the event, and not through elementsFromPoint either. The mark layer
// carries `pointer-events: none` (it has to: the text layer sits above it and
// must keep receiving every pointer event, or selection stops working over a
// highlight), and an element with pointer-events disabled is exactly what
// elementsFromPoint declines to return. So the quads are tested directly, in
// the page's own coordinate space, which is where they already live.
export function documentHighlightAtPoint(clientX, clientY) {
  const page = document.elementFromPoint(clientX, clientY)?.closest(".pdf-page");
  if (!page) return null;
  const box = page.getBoundingClientRect();
  const x = clientX - box.left;
  const y = clientY - box.top;
  const pageNumber = Number(page.dataset.pageNumber);
  for (const record of documentHighlights()) {
    // An ink mark is tested against the STROKES, not against the box round
    // them. A margin note and an arrow across a column share one large mostly
    // empty bounding box, and testing that box would make every tap inside it
    // open the ink's menu — including the taps meant for the text underneath,
    // which is most of them. What the reader means by "that one" is the ink
    // they pointed at.
    if (record.kind === "ink") {
      if (Number(record.page) !== pageNumber) continue;
      const point = inkPagePoint(pageNumber, x, y);
      if (point && decodeInkStrokes(record.ink?.s).some((stroke) =>
        inkStrokeHitsPoint(stroke, point.x, point.y, INK_TAP_SLACK))) return record;
      continue;
    }
    for (const quad of record.quads || []) {
      if (quad.page !== pageNumber) continue;
      const quadBox = quadToPageBox(quad);
      if (!quadBox) continue;
      if (x >= quadBox.left && x <= quadBox.left + quadBox.width
          && y >= quadBox.top && y <= quadBox.top + quadBox.height) return record;
    }
  }
  return null;
}

// How near a stroke a tap has to land to count as being on it, in PDF points.
// Wider than the nib because a finger is wider than a nib, and because the
// alternative — missing — is a reader tapping their own handwriting repeatedly
// and nothing happening.
export const INK_TAP_SLACK = 6;

// A point in the page element's own pixel space, back into PDF user space,
// where the strokes live. The inverse of what quadToPageBox does for a quad;
// written here rather than in pdf-selection.js because that module's job is
// SELECTIONS and this is the only caller that needs a bare point.
function inkPagePoint(pageNumber, x, y) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return null;
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}

// ── Ink marks ──────────────────────────────────────────────────────────────
//
// An ink mark is a highlight whose geometry is a set of strokes rather than a
// run of glyphs — the same argument src/documents/pdf-region.js makes for
// `kind: "area"`, made once more. It rides in meta.pdfHighlights with
// everything else, so the sync merge, the tombstone bag, the notes fence, the
// Highlights pane, the note badges, the make-card path, the export and the
// backup all carry it with no change: a new field on a record rides along
// untouched, and `ink` is that field.

export function documentInkMarks(pageNumber = null) {
  return documentHighlights().filter((record) => record.kind === "ink"
    && (pageNumber === null || Number(record.page) === Number(pageNumber)));
}

// Replaces every ink mark on ONE page. The whole page rather than one mark
// because that is the unit the engine commits in — a stroke can be erased out
// of the middle of one mark, a lasso can move strokes between two, and asking
// the caller to work out the difference is asking it to get it wrong.
//
// Ink ids are highlight ids, so a mark that has gone gets a tombstone and loses
// its note exactly as removeDocumentHighlight would have given it — without
// which a page cleared of ink on one device would fill back up from the cloud
// on the next sync.
// `notify` is passed straight through to commitDocumentHighlights, and the pen
// is the caller that declines it: see INK_NOTIFY_IDLE_MS in pdf-ink.js. The
// autosave inside commitDocumentHighlights is NOT optional and is not affected.
export function setDocumentInkForPage(pageNumber, records, { notify = true } = {}) {
  const page = Number(pageNumber);
  const before = documentInkMarks(page);
  const nextIds = new Set(records.map((record) => record.id));
  const gone = before.filter((record) => !nextIds.has(record.id));
  const rest = documentHighlights().filter((record) =>
    !(record.kind === "ink" && Number(record.page) === page));
  const next = rest.concat(records);

  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
  state.meta.pdfHighlights = wholeHighlightArray(next);
  if (gone.length) {
    // Written back into the meta on EVERY step, not once at the end.
    // recordDeletedHighlightId reads the bag off `meta` and returns a fresh one,
    // so a loop that keeps its answer in a local and assigns after the last
    // iteration hands every step the SAME starting bag — and only the final id
    // survives. Tearing out a page with four marks on it buried one of them and
    // let the other three come back from the other device on the next merge,
    // which is the whole failure this tombstone bag exists to stop.
    gone.forEach((record) => {
      state.meta.deletedHighlightIds = recordDeletedHighlightId(state.meta, record.id);
    });
    // Same ordering rule removeDocumentHighlight spells out at length: the
    // records have to be in place before the prune runs, because the prune asks
    // meta.pdfHighlights what is still live, and the one commit below is the
    // only thing that tells the panel anything.
    const pruned = pruneOrphanHighlightNotes(state.notes || "");
    if (pruned !== state.notes) state.notes = pruned;
  }
  commitDocumentHighlights(next, { notify });
}

// Every highlight any of these client rects touches, in reading order.
//
// documentHighlightAtPoint above answers "what is under this finger", which is
// the right question for a tap and the wrong one for a selection: a selection
// is a run of line fragments, and the one point the old caller derived from it
// — the left edge of its bounding box at half its height — lands in the margin
// between the lines for anything spanning more than one. That is why removing a
// highlight by selecting it reported "Nothing highlighted there" for most real
// selections.
//
// Intersection rather than containment, because a reader dragging across a
// highlight rarely covers it exactly and always means it.
export function documentHighlightsUnderRects(rects) {
  const found = [];
  if (!Array.isArray(rects) || !rects.length) return found;
  // Which page each rect is on, resolved GEOMETRICALLY rather than by
  // hit-testing. document.elementFromPoint returns whatever is topmost at a
  // point, and at the moment this runs there is reliably something else there:
  // the selection pill floats over the text it was raised for, and a note
  // badge, the mark menu or an open panel can be over it too. Asking the page
  // boxes directly cannot be wrong about z-order because it never consults it.
  const pages = [];
  document.querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (pageNumber) pages.push({ pageNumber, box: pageEl.getBoundingClientRect() });
  });
  if (!pages.length) return found;
  // Each rect, in the page-relative coordinates quadToPageBox reports in.
  const targets = [];
  rects.forEach((rect) => {
    if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) return;
    const midY = (rect.top + rect.bottom) / 2;
    const midX = (rect.left + rect.right) / 2;
    const on = pages.find(({ box }) => midX >= box.left && midX <= box.right
      && midY >= box.top && midY <= box.bottom);
    if (!on) return;
    targets.push({
      page: on.pageNumber,
      left: rect.left - on.box.left,
      top: rect.top - on.box.top,
      right: rect.right - on.box.left,
      bottom: rect.bottom - on.box.top
    });
  });
  if (!targets.length) return found;
  documentHighlightsInReadingOrder().forEach((record) => {
    const hit = (record.quads || []).some((quad) => {
      const quadBox = quadToPageBox(quad);
      if (!quadBox) return false;
      return targets.some((t) => t.page === quad.page
        && t.left < quadBox.left + quadBox.width && t.right > quadBox.left
        && t.top < quadBox.top + quadBox.height && t.bottom > quadBox.top);
    });
    if (hit) found.push(record);
  });
  return found;
}

// The highlights that between them COVER every rect of a selection.
//
// documentHighlightsUnderRects answers "what does this selection touch", which
// is what removing wants. Recolouring wants the stricter question — "is this
// selection already highlighted, all of it?" — because the two differ exactly
// where it matters: a paragraph containing one highlighted word touches that
// word and is nowhere near covered by it. Answering the loose question there
// would recolour the word and leave the paragraph unmarked, which is not what
// pressing a colour over a paragraph means.
//
// Returns the covering records, or an empty list if any part of the selection
// is bare. The tolerance is a couple of CSS pixels: a quad is built from a
// glyph run's own box and a selection rect from the range's, and they agree to
// about that.
export const COVER_TOLERANCE = 2;

export function documentHighlightsCovering(rects) {
  const touching = documentHighlightsUnderRects(rects);
  if (!touching.length) return [];
  const boxes = [];
  touching.forEach((record) => {
    (record.quads || []).forEach((quad) => {
      const box = quadToPageBox(quad);
      if (box) boxes.push({ page: quad.page, ...box });
    });
  });
  const pages = new Map();
  document.querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (pageNumber) pages.set(pageNumber, pageEl.getBoundingClientRect());
  });
  const covered = rects.every((rect) => {
    if (!rect || rect.right <= rect.left) return true;
    for (const [pageNumber, pageBox] of pages) {
      const midY = (rect.top + rect.bottom) / 2;
      if (midY < pageBox.top || midY > pageBox.bottom) continue;
      const left = rect.left - pageBox.left;
      const right = rect.right - pageBox.left;
      const top = rect.top - pageBox.top;
      const bottom = rect.bottom - pageBox.top;
      // Every horizontal slice of this rect has to sit inside some quad on the
      // same line. Walked left to right rather than summed, so two quads either
      // side of an unhighlighted gap do not add up to "covered".
      let x = left;
      let progressed = true;
      while (x < right - COVER_TOLERANCE && progressed) {
        progressed = false;
        for (const box of boxes) {
          if (box.page !== pageNumber) continue;
          if (bottom <= box.top + COVER_TOLERANCE || top >= box.top + box.height - COVER_TOLERANCE) continue;
          if (box.left > x + COVER_TOLERANCE || box.left + box.width <= x + COVER_TOLERANCE) continue;
          x = box.left + box.width;
          progressed = true;
          break;
        }
      }
      return x >= right - COVER_TOLERANCE;
    }
    return false;
  });
  return covered ? touching : [];
}

// ── Importing the PDF's own highlights ──────────────────────────────────────
//
// A paper that arrives already annotated in Zotero, Preview or Okular carries
// those highlights as PDF annotations. Reading them once, at import, is what
// makes "drop the paper in" mean the same thing as "carry on where I was" —
// and it costs one getAnnotations() per page during an import that is already
// reading every page.
//
// Deliberately one-way and one-time. The app never writes annotations back into
// the file: the bytes are the reader's original document, and rewriting them
// would break the sha256 that every anchor depends on.

// Annotation colours are arbitrary RGB; the app's are four named tokens. Mapped
// by nearest neighbour in plain RGB space — good enough to put a Zotero yellow
// in the yellow bucket and a Zotero pink in the pink one, which is all this
// needs to do.
export function nearestHighlightColor(rgb) {
  if (!rgb || rgb.length < 3) return MARK_HIGHLIGHT_DEFAULT;
  let best = MARK_HIGHLIGHT_DEFAULT;
  let bestDistance = Infinity;
  Object.entries(MARK_HIGHLIGHT_HEX).forEach(([token, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = token;
    }
  });
  return best;
}

// quadPoints has been two different shapes across pdf.js versions: a flat
// Float32Array of 8 numbers per quad (x1,y1,…,x4,y4), and an array of arrays of
// {x,y} points. Both are read here rather than pinning the reader's imported
// highlights to one library version.
export function annotationQuads(annotation, pageNumber) {
  const quads = [];
  const points = annotation?.quadPoints;
  if (Array.isArray(points) && points.length && Array.isArray(points[0])) {
    points.forEach((corners) => {
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      quads.push({ page: pageNumber, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    });
  } else if (points && points.length >= 8) {
    for (let i = 0; i + 7 < points.length; i += 8) {
      const xs = [points[i], points[i + 2], points[i + 4], points[i + 6]];
      const ys = [points[i + 1], points[i + 3], points[i + 5], points[i + 7]];
      quads.push({ page: pageNumber, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  } else if (Array.isArray(annotation?.rect) && annotation.rect.length === 4) {
    // A highlight with no quadPoints at all (some producers omit them) still
    // has a rectangle. Coarser, but a highlight in roughly the right place beats
    // dropping the reader's annotation on the floor.
    const [x0, y0, x1, y1] = annotation.rect;
    quads.push({ page: pageNumber, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] });
  }
  return quads;
}

// ── The mark menu, on a coordinate ──────────────────────────────────────────
//
// Same menu, same four swatches, same ✎ and ✕ as in a note — given a different
// set of verbs. The key it is opened with is the highlight's id rather than a
// <mark>'s ordinal, which is the whole reason src/notes/mark-menu.js takes a
// handler set at all.

export const DOCUMENT_MARK_HANDLERS = {
  surface: "document",
  // No "pin". A Quick Note keeps a trimNoteAnchor'd anchor
  // (src/quick-notes/anchors.js), and that shape has no room for `pdf` or
  // `quads` — the two fields that are the whole of where a highlight on a paper
  // IS. Pinning one would store the words and lose the page, so the card's "Go
  // to notes" would fall back to searching a note that does not contain them.
  // A row that half-works is worse than a row that is not offered, so the
  // Document surface does not offer it. Everything else crosses intact: the
  // text is text, the anchor carries the page for a card, and the locator is
  // the record's own id.
  //
  // ...and the take-it-elsewhere verbs cross most easily of all — copy, share
  // and search are handed the passage and nothing else, so there is nothing
  // about a paper for them to lose. A region drawn round a figure resolves to
  // documentHighlightLabel's "Region · page 12", which is the same string the
  // drawer already shows for it.
  actions: ["card", "highlights", "copy", "share", "search"],
  recolour: (id, color) => recolourDocumentHighlight(id, color),
  remove: (id) => removeDocumentHighlight(id),
  noteText: (id) => documentHighlightNote(id),
  openNote: (id, rect) => openHighlightNoteEditor(id, rect, documentHighlightNote(id), DOCUMENT_NOTE_HANDLERS)
};

export const DOCUMENT_NOTE_HANDLERS = {
  // The options are passed through, not dropped. The editor sends
  // `{ rerender, undo }`; `rerender` means nothing here (the note's text is not
  // on the page), but `undo` is what gives a PDF highlight's note the same one
  // snapshot per session every other note in the app gets.
  save: (id, text, options) => setDocumentHighlightNote(id, text, options),
  remove: (id, options) => clearDocumentHighlightNote(id, options),
  // Nothing on the page changes when a note is written — the note's text lives
  // in the deck's markdown, not in the PDF — but the highlight's own "has a
  // note" state does, and the Highlights panel is a different surface that may
  // well be where the edit was made from.
  repaint: () => { repaintDocumentHighlights(); notifyHighlightsChanged(); }
};

// A tap on a highlight opens its menu; a tap anywhere else on the page closes
// it. Deliberately a click and not a selection, exactly as in a note: selecting
// a highlight to change it would go through the text layer, which is the one
// thing that cannot tell you WHICH highlight you meant.
export function initDocumentMarkMenu() {
  const view = el.documentView;
  if (!view) return;
  view.addEventListener("click", (event) => {
    // A live text selection means the reader is selecting, not tapping a
    // highlight — the floating pill is the right surface for that. Read
    // through the RANGE rather than Selection.toString(), for the reason
    // src/notes/mark-menu.js gives at the same test: an armed touch controller
    // makes toString() answer "" over unselectable content while every Range
    // operation stays correct.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount
        && selection.getRangeAt(0).toString().trim()) return;
    const record = documentHighlightAtPoint(event.clientX, event.clientY);
    if (!record) {
      closeMarkMenu();
      return;
    }
    event.preventDefault();
    // Anchored to the highlight's own first painted quad, so the menu appears
    // over the words it acts on rather than wherever the finger landed.
    const anchor = view.querySelector(`.${PDF_MARK_CLASS}[data-highlight-id="${CSS.escape(record.id)}"]`) || event.target;
    openMarkMenuWith(anchor, record.id, DOCUMENT_MARK_HANDLERS, record.color || MARK_HIGHLIGHT_DEFAULT);
  });

  // The menu is positioned against a rect that scrolling invalidates.
  view.addEventListener("scroll", closeMarkMenu, { passive: true });
}
