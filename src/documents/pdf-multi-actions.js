// Removing and relabelling one of a deck's PDFs.
//
// The counterpart to attachPdfToOpenDeck (src/import/pdf.js): that adds a
// paper to the doc slot's list, these take one back off it or change what its
// tab is called. Neither touches the notebook shelf or its records.

import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import {
  deckPdfs,
  pdfStoreKey,
  recordsForSurface,
  recordsOutsideSurface,
  withDeckPdfs
} from "./pdf-multi.js?v=__BUILD__";
import { deleteLocalDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentView, renderDocumentPdfSwitcher, switchToPdf } from "./pdf-view.js?v=__BUILD__";
import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
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
// Any of a deck's papers can go, the first and the last included. The first
// used to be refused, because meta.pdf mirrors it and a good many modules asked
// `state.meta?.pdf` for "does this deck have a document". They ask deckHasPdf
// (src/documents/doc-slot.js) now, which counts every paper. The last used to
// be refused too; removing it leaves the deck with no document, and the PDF tab
// opens to the offer of one, exactly as on a deck that never had a paper.
export async function removePdfFromDeck(pdfId) {
  const list = deckPdfs(state.meta);
  const entry = list.find((item) => item.id === pdfId);
  if (!entry) return false;

  const remaining = list.filter((item) => item.id !== pdfId);
  const highlights = Array.isArray(state.meta?.pdfHighlights) ? state.meta.pdfHighlights : [];
  const blocks = Array.isArray(state.meta?.pdfBlocks) ? state.meta.pdfBlocks : [];
  const goneHighlights = recordsForSurface(highlights, DOC_SLOT_DOC, pdfId);
  const goneBlocks = recordsForSurface(blocks, DOC_SLOT_DOC, pdfId);

  // An empty list is kept as `[]` rather than dropped, so the sync merge stays
  // on its by-id rule and honours the tombstone below; see withDeckPdfs.
  const meta = withDeckPdfs(state.meta, remaining, { keepEmpty: true });
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
  const nextActive = remaining.some((item) => item.id === meta.pdfActiveId) ? meta.pdfActiveId : (remaining[0]?.id || null);
  if (nextActive) meta.pdfActiveId = nextActive;
  else delete meta.pdfActiveId;
  state.meta = meta;
  scheduleDeckAutosave();

  // The bucket copy too. It used to be only Drive and Supabase, so every paper
  // removed from a deck since the move to a bucket stayed in it for good —
  // unreachable, since no record named it any more, and still billed.
  if ((entry.s3Key || entry.driveId || entry.path) && !entry.offloaded) {
    deleteDocumentCopies(entry, { deckLocalId: state.localDeckId, slot: DOC_SLOT_DOC, pdfId }).catch(() => {});
  }
  deleteLocalDocument(pdfStoreKey(state.localDeckId, pdfId)).catch(() => {});

  if (nextActive) {
    await switchToPdf(nextActive);
  } else {
    // Nothing left to switch to: the tab and the stage are told the deck has no
    // document, and the stage reopens onto the attach panel.
    updateMeta();
    if (state.viewMode === "document") await openDocumentView({ force: true, slot: DOC_SLOT_DOC });
  }
  renderDocumentPdfSwitcher();
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
