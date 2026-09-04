// Which document a deck is showing — and there are two of them now.
//
// ── Why a deck grew a second shelf ─────────────────────────────────────────
//
// A deck used to have exactly one document: `meta.pdf`, the paper somebody
// handed us. Handwritten Notes was built on that single slot, because a notebook
// IS a paper whose words have not been written yet and the Document surface
// already did everything a notebook needs — pdf.js laying the pages out, the pen
// storing strokes in the document's own user space, the pager, the export, the
// device store, the backup. That reasoning was right and none of it is being
// undone here.
//
// What was wrong was the arithmetic. One shelf, two things that want to be on
// it: a deck that already carried a paper had nowhere to put a notebook, and the
// app said so out loud — "This deck already has a PDF — its handwriting goes on
// that" — which is not a feature, it is a data model apologising. A notebook
// beside your cards and your note and your paper is the ordinary case.
//
// So there are two shelves, holding the same shape of thing:
//
//   doc       meta.pdf        the paper somebody gave us
//   notebook  meta.notebook   paper this app wrote itself (blank-pdf.js)
//
// ── Why the records did NOT get a second array ─────────────────────────────
//
// Strokes, highlights and typed blocks stay in `meta.pdfHighlights` and
// `meta.pdfBlocks`, with one optional field — `doc: "notebook"` — saying which
// paper they are coordinates into. An absent field means the deck's own paper,
// so nothing already stored has to be rewritten to keep meaning what it meant.
//
// Two arrays would have been the obvious move and it is the expensive one: the
// per-record timestamp, the merge on the pull, the reconcile before the push,
// the tombstones, the archive's table of what a backup carries, and every one of
// the nineteen files that names `pdfHighlights` would each need a second copy of
// itself. `mergeRecordsById` merges by id and carries fields it does not know
// about straight through, so one more field on a record is free everywhere and a
// second array is free nowhere.
//
// ── Why this file imports almost nothing ───────────────────────────────────
//
// Same rule src/format/ink-colors.js states for itself. The painters, the
// writers, the store, the view and the sync path all read this, one of them from
// a top-level initialiser, and a module that took part in an import cycle would
// be read before it was evaluated. That has already cost this app a boot once.
// `state` is the one import, and `state` imports nothing.

import { state } from "../core/state.js?v=__BUILD__";

export const DOC_SLOT_DOC = "doc";

export const DOC_SLOT_NOTEBOOK = "notebook";

export const DOC_SLOTS = [DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK];

export function normalizeDocSlot(value) {
  return String(value || "") === DOC_SLOT_NOTEBOOK ? DOC_SLOT_NOTEBOOK : DOC_SLOT_DOC;
}

// The meta key each slot's document record lives under. Kept here rather than
// spelled out at each call site so that renaming one is a single edit.
export function docSlotMetaKey(slot) {
  return normalizeDocSlot(slot) === DOC_SLOT_NOTEBOOK ? "notebook" : "pdf";
}

export function docSlotMeta(slot, meta = state.meta) {
  const record = meta?.[docSlotMetaKey(slot)];
  return record && typeof record === "object" ? record : null;
}

export function hasDocSlot(slot, meta = state.meta) {
  return Boolean(docSlotMeta(slot, meta));
}

// ── Which slot is on screen ────────────────────────────────────────────────
//
// Derived from state.viewMode rather than held as a scalar of its own, and that
// is deliberate: a second piece of state saying which surface the reader is on
// is a second piece of state that can disagree with the first one. The Document
// tab and the Write tab are the same #documentStage showing different files, and
// exactly one of them is ever the view.
export function activeDocSlot() {
  return state.viewMode === "handwriting" ? DOC_SLOT_NOTEBOOK : DOC_SLOT_DOC;
}

// Is the reader on the document surface at all? Two tabs land on it, so every
// "am I looking at pages?" test in the app has to ask this rather than compare
// state.viewMode with one string — which is what several of them did, and what
// would have left the pager, the page-up key, the touch-selection controller and
// the bookmark all inert on the Write tab.
export function onDocumentSurface() {
  return state.viewMode === "document" || state.viewMode === "handwriting";
}

// Which surface an opening deck should land on. Here, in the leaf, because two
// loaders a few files apart both ask it — the library one and the cloud one —
// and the two answering it differently is how a notebook opens on an empty
// Notes tab by one route and not the other.
//
// A PDF deck opens on its Document tab: the document IS the deck. A deck whose
// only document is paper it wrote itself opens on Write, by the same argument.
// Everything else opens on Notes, exactly as it always has.
export function documentTabForOpenDeck(meta = state.meta) {
  if (meta?.pdf && !meta.pdf.notebook) return "document";
  // Every shape of notebook, including the two that have not been moved onto the
  // current one yet — a deck saved by an older build opens on its pages, not on
  // an empty Notes tab that says nothing about them.
  if (deckHasHandwrittenPages(meta)) return "handwriting";
  return "notes";
}

// Does this deck have handwritten pages ANYWHERE?
//
// Three shapes answer yes, and a surface that only knew about the first would
// offer to "start a notebook" to somebody who already has one — and then make a
// second, orphaning what they wrote:
//
//   • meta.notebook            — the slot pages live in now;
//   • meta.pdf.notebook        — the slot they lived in before this one, moved
//                                on open by migrateNotebookSlot;
//   • meta.pages / textBoxes   — the model before there was a document at all,
//                                converted on open by migrateLegacyNotebook.
//
// The third test is stated here as well as in hasLegacyNotebook
// (./notebook-migrate.js) rather than imported from it, because that module
// imports THIS one and the cycle would be read before either was evaluated. The
// two are deliberately the same test: that one decides whether to CONVERT, this
// one decides whether there is anything to open.
export function deckHasHandwrittenPages(meta = state.meta) {
  if (meta?.notebook || meta?.pdf?.notebook) return true;
  const pages = Array.isArray(meta?.pages) ? meta.pages : [];
  const boxes = Array.isArray(meta?.textBoxes) ? meta.textBoxes : [];
  return pages.length > 0 || boxes.length > 0;
}

// ── Records ────────────────────────────────────────────────────────────────

// An absent `doc` is the deck's own paper. Every record written before this
// existed is therefore correctly attributed with nothing done to it, which is
// the whole reason the field is optional rather than required.
export function recordDocSlot(record) {
  return String(record?.doc || "") === DOC_SLOT_NOTEBOOK ? DOC_SLOT_NOTEBOOK : DOC_SLOT_DOC;
}

export function isRecordInSlot(record, slot) {
  return recordDocSlot(record) === normalizeDocSlot(slot);
}

// Stamped on the way in, and the doc slot is stamped by OMISSION — a `doc: "doc"`
// on every highlight in the library would be a field per record saying what its
// absence already says, re-sent on every sync, for ever.
export function stampDocSlot(record, slot) {
  if (!record || typeof record !== "object") return record;
  const wanted = normalizeDocSlot(slot);
  // Returned UNCHANGED when it already says the right thing, and that identity
  // is load-bearing rather than tidy: src/documents/pdf-ink.js decides whether a
  // page needs re-seeding by comparing record references (sameRefs), and a copy
  // made on every write would defeat it — which is a decode and a repaint of
  // every stroke on the page at the start of every stroke.
  if (recordDocSlot(record) === wanted) return record;
  if (wanted === DOC_SLOT_NOTEBOOK) return { ...record, doc: DOC_SLOT_NOTEBOOK };
  const next = { ...record };
  delete next.doc;
  return next;
}

export function stampDocSlotAll(list, slot) {
  return (Array.isArray(list) ? list : []).map((record) => stampDocSlot(record, slot));
}

export function recordsInSlot(list, slot) {
  return (Array.isArray(list) ? list : []).filter((record) => isRecordInSlot(record, slot));
}

// The other half of the array — what a writer for one slot must put back.
//
// Every writer in this app assigns a whole array (`state.meta.pdfHighlights =
// next`), because that is what makes one autosave one consistent picture. With
// two slots sharing the array, a writer that assigned only its own slot's
// records would silently delete the other slot's — a paper's highlights lost the
// first time somebody drew on the notebook beside it. This is the function that
// stops that, and it is why the writes go through one helper each rather than
// being open-coded.
export function recordsOutsideSlot(list, slot) {
  return (Array.isArray(list) ? list : []).filter((record) => !isRecordInSlot(record, slot));
}

// ── The bytes on the device ────────────────────────────────────────────────
//
// src/documents/pdf-store.js is keyed by the deck's local id, one row per deck.
// A deck with two documents needs two rows, so the notebook's row is the deck's
// id with a suffix. "#" cannot appear in a local id (they are minted as
// `ld_<random>`), so the two key spaces cannot collide, and a store written
// before this existed is untouched: its rows are already the doc slot's.
export const DOC_SLOT_KEY_SEPARATOR = "#";

export function documentStoreKey(deckLocalId, slot) {
  if (!deckLocalId) return deckLocalId;
  return normalizeDocSlot(slot) === DOC_SLOT_NOTEBOOK
    ? `${deckLocalId}${DOC_SLOT_KEY_SEPARATOR}${DOC_SLOT_NOTEBOOK}`
    : String(deckLocalId);
}

// The inverse, for the two places that read the store back without knowing which
// deck they are looking at: the storage panel's usage pass and a restore
// rebinding an archive's rows onto this device's ids.
export function splitDocumentStoreKey(key) {
  const value = String(key || "");
  const at = value.lastIndexOf(`${DOC_SLOT_KEY_SEPARATOR}${DOC_SLOT_NOTEBOOK}`);
  return at > 0 && at === value.length - DOC_SLOT_NOTEBOOK.length - 1
    ? { deckLocalId: value.slice(0, at), slot: DOC_SLOT_NOTEBOOK }
    : { deckLocalId: value, slot: DOC_SLOT_DOC };
}
