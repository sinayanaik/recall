// Write new bytes over one of a file's PDFs.
//
// The sequence every change to a PDF's pages takes — page margins
// (src/documents/pdf-margins.js) and markdown pages put in, remade or taken out
// (src/documents/md-pdf/save.js) — and the same one writeNotebookPdf
// (src/documents/notebook.js) arrived at for the Canvas:
//
//   1. check the record still names the bytes the change was worked out on —
//      a question can sit open while the PDF is renamed, or synced from
//      another device;
//   2. the new record: new size and hash, no locator (each names bytes that
//      are no longer this PDF), the hash of the file as first attached kept;
//   3. anything else the change moves (highlights renumbered) — `beforeSave`,
//      so ONE save persists the bytes' record and the marks together;
//   4. save the file, then the device copy, then the upload in the background
//      — the device copy is the one about to be drawn on, and the one that
//      survives being offline; a PDF the reader took out of the cloud stays out;
//   5. the new pages on screen.
//
// Resolves "ok", "changed" (the bytes moved under the change) or "failed".

import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import { deckPdfById, deckPdfs, pdfStoreKey, withDeckPdfs } from "./pdf-multi.js?v=__BUILD__";
import { putDocument, sha256, uploadDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentView } from "./pdf-view.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { storageFolderSlug } from "../images/upload.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { deleteDocumentCopies } from "../storage/document-migration.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export async function replacePdfBytes(pdfId, entry, bytes, { patch = {}, beforeSave = null, uploadFailedMessage = "Pages saved here — they upload at the next sync" } = {}) {
  const latest = deckPdfById(state.meta, pdfId);
  if (!latest || latest.sha256 !== entry.sha256) return "changed";
  const name = entry.name || `${state.deckTitle || "document"}.pdf`;
  const file = new File([bytes], name, { type: "application/pdf" });
  const hash = await sha256(file);
  // Where the PREVIOUS bytes live, captured before the record naming them is
  // overwritten — see writeNotebookPdf, which learned this the hard way.
  const previous = { driveId: entry.driveId || "", path: entry.path || "", s3Key: entry.s3Key || "" };
  const nextEntry = {
    ...latest,
    // The file as it was first attached: kept once, never replaced, so the
    // reader's own copy of the original can still be re-attached.
    baseSha256: entry.baseSha256 || entry.sha256 || null,
    ...patch,
    size: file.size,
    sha256: hash,
    s3Key: null,
    path: null,
    driveId: null,
    retiredLocators: null,
    at: Date.now()
  };
  if (beforeSave) beforeSave();
  state.meta = withDeckPdfs(state.meta, deckPdfs(state.meta).map((item) => (item.id === pdfId ? nextEntry : item)));
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this file on your device", "error");
    return "failed";
  }
  await putDocument({ deckLocalId: pdfStoreKey(state.localDeckId, pdfId), blob: file, sha256: hash, name: file.name, at: Date.now() });
  if (!entry.offloaded) uploadReplacement(file, hash, pdfId, previous, uploadFailedMessage);
  await openDocumentView({ force: true, slot: DOC_SLOT_DOC, pdfId });
  return "ok";
}

// In the background: the pages are already on screen and on this device, and
// an upload that fails is picked up by the next sync's backfill
// (scheduleDocumentBackfill in src/storage/document-migration.js).
async function uploadReplacement(file, hash, pdfId, previous, failedMessage) {
  try {
    const locator = await uploadDocument(file, {
      name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "document"),
      pdfId,
      sha256: hash
    });
    // Only if the record still names these bytes: a second change made while
    // this was uploading has its own upload, and its own locator.
    const now = deckPdfById(state.meta, pdfId);
    if (now?.sha256 !== hash) return;
    state.meta = withDeckPdfs(state.meta, deckPdfs(state.meta).map((item) => (item.id === pdfId ? { ...item, ...locator } : item)));
    await saveDeckToLibrary({ silent: true });
    const stale = { ...previous, s3Key: previous.s3Key && previous.s3Key !== locator?.s3Key ? previous.s3Key : "" };
    if (stale.driveId || stale.path || stale.s3Key) {
      deleteDocumentCopies(stale, { deckLocalId: state.localDeckId, slot: DOC_SLOT_DOC, pdfId }).catch(() => {});
    }
  } catch (error) {
    console.warn("Could not upload the changed PDF", error);
    showToast(failedMessage, "info");
  }
}
