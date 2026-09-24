// Removing and relabelling one of a deck's PDFs.
//
// The counterpart to attachPdfToOpenDeck (src/import/pdf.js): that adds a
// paper to the doc slot's list, these take one back off it or change what its
// tab is called. Neither touches the notebook shelf or its records.

import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import {
  deckPdfs,
  PDF_PRIMARY_ID,
  pdfStoreKey,
  recordsForSurface,
  recordsOutsideSurface,
  withDeckPdfs
} from "./pdf-multi.js?v=__BUILD__";
import { deleteLocalDocument } from "./pdf-store.js?v=__BUILD__";
import { renderDocumentPdfSwitcher, switchToPdf } from "./pdf-view.js?v=__BUILD__";
import { recordDeletedMetaId } from "../sync/document-sync.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { deleteDocumentCopies } from "../storage/document-migration.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Fully remove one PDF: the entry, its highlights and typed blocks (each with
// its own tombstone, so the removal sticks across a sync rather than being
// resurrected by a device that still has them), its reading position and
// outline cache, and — best-effort, same as offloadCurrentDocument — its
// bytes on this device and in the cloud.
//
// Refused on a deck's only PDF. There is nowhere else for the doc slot to
// land, and "get rid of my only paper" is what offload (keep the record, drop
// the cloud bytes) and a fresh attach already cover.
export async function removePdfFromDeck(pdfId) {
  const list = deckPdfs(state.meta);
  const entry = list.find((item) => item.id === pdfId);
  if (!entry) return false;
  if (list.length < 2) {
    showToast("This is the deck's only PDF — offload it or attach a different one instead", "info");
    return false;
  }
  // The primary is not just "first in the list" — a good many other modules
  // (the bookmark, the page-notes toggle, "does this deck have a document at
  // all") ask `state.meta?.pdf` directly rather than "does deckPdfs(meta)
  // have anything", exactly because every deck that has EVER had a PDF has
  // had this one populated. Removing it out from under them would read as
  // "this deck has no document" to every one of those the moment a SECOND,
  // still-present PDF is the only one left. Removing another PDF and keeping
  // this one is unaffected by this at all.
  if (pdfId === PDF_PRIMARY_ID) {
    showToast("This is the deck's first PDF — remove the others first, or offload this one instead", "info");
    return false;
  }

  const remaining = list.filter((item) => item.id !== pdfId);
  const highlights = Array.isArray(state.meta?.pdfHighlights) ? state.meta.pdfHighlights : [];
  const blocks = Array.isArray(state.meta?.pdfBlocks) ? state.meta.pdfBlocks : [];
  const goneHighlights = recordsForSurface(highlights, DOC_SLOT_DOC, pdfId);
  const goneBlocks = recordsForSurface(blocks, DOC_SLOT_DOC, pdfId);

  const meta = withDeckPdfs(state.meta, remaining);
  meta.pdfHighlights = recordsOutsideSurface(highlights, DOC_SLOT_DOC, pdfId);
  meta.pdfBlocks = recordsOutsideSurface(blocks, DOC_SLOT_DOC, pdfId);
  goneHighlights.forEach((record) => {
    meta.deletedHighlightIds = recordDeletedMetaId(meta, "deletedHighlightIds", record.id);
  });
  goneBlocks.forEach((record) => {
    meta.deletedBlockIds = recordDeletedMetaId(meta, "deletedBlockIds", record.id);
  });
  meta.deletedPdfIds = recordDeletedMetaId(meta, "deletedPdfIds", pdfId);
  if (meta.pdfReadingPositions && pdfId in meta.pdfReadingPositions) {
    const { [pdfId]: _drop, ...rest } = meta.pdfReadingPositions;
    if (Object.keys(rest).length) meta.pdfReadingPositions = rest;
    else delete meta.pdfReadingPositions;
  }
  if (meta.pdfTocByPdfId && pdfId in meta.pdfTocByPdfId) {
    const { [pdfId]: _drop, ...rest } = meta.pdfTocByPdfId;
    if (Object.keys(rest).length) meta.pdfTocByPdfId = rest;
    else delete meta.pdfTocByPdfId;
  }
  const nextActive = remaining.some((item) => item.id === meta.pdfActiveId) ? meta.pdfActiveId : remaining[0].id;
  meta.pdfActiveId = nextActive;
  state.meta = meta;
  scheduleDeckAutosave();

  // The bucket copy too. It used to be only Drive and Supabase, so every paper
  // removed from a deck since the move to a bucket stayed in it for good —
  // unreachable, since no record named it any more, and still billed.
  if ((entry.s3Key || entry.driveId || entry.path) && !entry.offloaded) {
    deleteDocumentCopies(entry, { deckLocalId: state.localDeckId, slot: DOC_SLOT_DOC, pdfId }).catch(() => {});
  }
  deleteLocalDocument(pdfStoreKey(state.localDeckId, pdfId)).catch(() => {});

  await switchToPdf(nextActive);
  showToast(`Removed "${entry.name || "PDF"}" from this deck`);
  return true;
}

// Just the label shown on its tab/dropdown row — no bytes touched, no
// tombstone, since nothing about the file itself changed.
export function renamePdf(pdfId, label) {
  const list = deckPdfs(state.meta);
  if (!list.some((entry) => entry.id === pdfId)) return false;
  const trimmed = String(label || "").trim();
  state.meta = withDeckPdfs(state.meta, list.map((entry) => {
    if (entry.id !== pdfId) return entry;
    const next = { ...entry, at: Date.now() };
    if (trimmed) next.label = trimmed;
    else delete next.label;
    return next;
  }));
  scheduleDeckAutosave();
  renderDocumentPdfSwitcher();
  return true;
}
