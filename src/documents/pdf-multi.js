// Multiple PDFs on the deck's own paper slot.
//
// doc-slot.js gave a deck two shelves — its own paper (`meta.pdf`) and a
// notebook (`meta.notebook`) — and kept every record in one shared array with
// a `doc` tag saying which shelf it belongs to, rather than a second array per
// shelf. This module makes the "doc" shelf hold more than one paper, by the
// same trade one level down: still one array (`meta.pdfHighlights`,
// `meta.pdfBlocks`), now tagged with an optional `pdfId` saying which OF the
// doc slot's papers a record belongs to. An absent `pdfId` still means "the
// deck's own paper" — now specifically its PRIMARY one — so nothing already
// stored has to be rewritten.
//
// doc-slot.js itself is not touched by any of this: the notebook shelf, and
// the "doc vs notebook" question, are exactly what they were.
//
// ── The shape ────────────────────────────────────────────────────────────
//
//   meta.pdf         unchanged — a live mirror of the PRIMARY entry, kept
//                     forever so a client running old cached JS still reads
//                     and writes a deck's first PDF exactly as it always has.
//   meta.pdfs        [{ id, name, size, pages, sha256, path, importedAt,
//                     offloaded?, label?, at }] — every PDF, primary
//                     included. Absent for a deck that has only ever had one:
//                     see deckPdfs, which synthesizes this list from the bare
//                     meta.pdf when it is missing, so an ordinary deck's JSONB
//                     never grows a byte for a feature it does not use.
//   meta.pdfActiveId which one is open. Validated on every read (activePdfId)
//                     rather than trusted, because a stale id left over from a
//                     PDF removed on another device must fall back to
//                     something the deck still has, not to nothing.
//
// The primary's id is the fixed literal below, never minted. Two devices each
// independently synthesizing a deck's first-ever meta.pdfs list (because
// neither has written one yet) have to agree on that entry's id, or the
// sync's union-by-id merge (see sync/document-sync.js) treats one paper as
// two the moment they compare notes.
export const PDF_PRIMARY_ID = "primary";

import {
  DOC_SLOT_DOC,
  DOC_SLOT_KEY_SEPARATOR,
  documentStoreKey,
  isRecordInSlot,
  normalizeDocSlot
} from "./doc-slot.js?v=__BUILD__";

export function mintPdfId() {
  return `pdf-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

// The deck's PDFs, as a list — even for a deck that has never heard of
// meta.pdfs. A deck whose only PDF is still the bare meta.pdf object reads as
// a one-entry list here, under PDF_PRIMARY_ID, so every caller below can ask
// "which PDFs does this deck have" without first asking which shape it is in.
export function deckPdfs(meta) {
  if (Array.isArray(meta?.pdfs) && meta.pdfs.length) {
    return meta.pdfs.filter((entry) => entry && typeof entry === "object" && entry.id);
  }
  if (meta?.pdf && typeof meta.pdf === "object") return [{ ...meta.pdf, id: PDF_PRIMARY_ID }];
  return [];
}

export function deckPdfById(meta, id) {
  if (!id) return null;
  return deckPdfs(meta).find((entry) => entry.id === id) || null;
}

// Which PDF is open, validated against what the deck actually has rather than
// trusted outright — meta.pdfActiveId can outlive the entry it named (removed
// here, removed on another device before this one heard about it), and a
// stale id has to fall back to a PDF that still exists rather than to
// nothing.
export function activePdfId(meta) {
  const list = deckPdfs(meta);
  if (!list.length) return null;
  const wanted = meta?.pdfActiveId;
  return list.some((entry) => entry.id === wanted) ? wanted : list[0].id;
}

// The one write path for the list. Keeps meta.pdf in step as a mirror of
// whichever entry is PRIMARY_ID — deleted along with it if that entry is
// gone — which is what makes an old cached client's view of "this deck's PDF"
// stay correct without that client knowing anything changed.
export function withDeckPdfs(meta, nextList) {
  const base = meta && typeof meta === "object" ? meta : {};
  const list = (Array.isArray(nextList) ? nextList : []).filter((entry) => entry && entry.id);
  const next = { ...base };
  if (list.length) next.pdfs = list;
  else delete next.pdfs;
  const primary = list.find((entry) => entry.id === PDF_PRIMARY_ID);
  if (primary) {
    const { id: _drop, ...rest } = primary;
    next.pdf = rest;
  } else {
    delete next.pdf;
  }
  if (!list.some((entry) => entry.id === next.pdfActiveId)) delete next.pdfActiveId;
  return next;
}

// ── Records ─────────────────────────────────────────────────────────────
//
// A record's `pdfId` means something only on the doc slot — the notebook
// shelf has exactly one paper and doc-slot.js's own `doc` tag already says
// everything there is to say about it. An absent `pdfId` on a doc-slot record
// means the primary PDF, by the same omission convention doc-slot.js uses for
// an absent `doc`.
export function recordPdfId(record) {
  return record?.pdfId ? String(record.pdfId) : PDF_PRIMARY_ID;
}

function stampRecordPdfId(record, pdfId) {
  if (!record || typeof record !== "object") return record;
  const wanted = pdfId && pdfId !== PDF_PRIMARY_ID ? String(pdfId) : "";
  if ((record.pdfId || "") === wanted) return record;
  if (wanted) return { ...record, pdfId: wanted };
  const next = { ...record };
  delete next.pdfId;
  return next;
}

export function stampRecordPdfIdAll(list, pdfId) {
  return (Array.isArray(list) ? list : []).map((record) => stampRecordPdfId(record, pdfId));
}

// Slot match first, then — only on the doc slot, where more than one PDF can
// exist — a pdfId match too. A notebook record (or anything else off the doc
// slot) answers on slot alone, exactly as it always has.
export function isRecordForSurface(record, slot, pdfId) {
  if (!isRecordInSlot(record, slot)) return false;
  if (normalizeDocSlot(slot) !== DOC_SLOT_DOC) return true;
  return recordPdfId(record) === (pdfId || PDF_PRIMARY_ID);
}

export function recordsForSurface(list, slot, pdfId) {
  return (Array.isArray(list) ? list : []).filter((record) => isRecordForSurface(record, slot, pdfId));
}

// The other half of the array — what a writer for one PDF must put back
// alongside it, exactly as recordsOutsideSlot is for a slot. Without this, a
// highlight made on a deck's second PDF would delete every record belonging
// to its first PDF and its notebook the next time either was written to.
export function recordsOutsideSurface(list, slot, pdfId) {
  return (Array.isArray(list) ? list : []).filter((record) => !isRecordForSurface(record, slot, pdfId));
}

// ── The bytes on the device ─────────────────────────────────────────────
//
// The primary PDF keeps today's bare key (documentStoreKey's own "doc" answer
// — a deckLocalId with no suffix at all), so a device that has never heard of
// a second PDF has nothing to migrate. Anything else gets a suffix that
// cannot collide with the notebook's `#notebook` (doc-slot.js) because it
// carries a colon no local id or notebook suffix can.
const PDF_STORE_KEY_INFIX = "pdf:";

export function pdfStoreKey(deckLocalId, pdfId) {
  if (!deckLocalId) return deckLocalId;
  if (!pdfId || pdfId === PDF_PRIMARY_ID) return documentStoreKey(deckLocalId, DOC_SLOT_DOC);
  return `${deckLocalId}${DOC_SLOT_KEY_SEPARATOR}${PDF_STORE_KEY_INFIX}${pdfId}`;
}

// The inverse, for a sweep that has a key and wants to know which deck and
// which of its PDFs it belongs to (the storage panel's usage pass, a backup
// restore rebinding an archive's rows onto this device's ids).
export function splitPdfStoreKey(key) {
  const value = String(key || "");
  const marker = `${DOC_SLOT_KEY_SEPARATOR}${PDF_STORE_KEY_INFIX}`;
  const at = value.indexOf(marker);
  if (at > 0) return { deckLocalId: value.slice(0, at), pdfId: value.slice(at + marker.length) };
  return { deckLocalId: value, pdfId: PDF_PRIMARY_ID };
}
