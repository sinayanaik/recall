// A notebook: the Document surface, with paper this app wrote itself.
//
// ── Why a notebook is a PDF and not a canvas ──────────────────────────────
//
// Because writing on a paper already worked, and a notebook is a paper whose
// words have not been written yet. Everything the Document surface does — pdf.js
// laying out the pages, the pen storing strokes in that document's user space
// (which is what makes them survive a zoom, a rotate, a reload and a second
// device), the pager, dark page, the annotated export, the device store, the
// backup that packs the bytes — is already built and already checked. A notebook
// made of anything else needs a second version of every one of them, and this
// repository has one of those and does not want two.
//
// So the paper is a real file (src/documents/blank-pdf.js), attached to the deck
// as `meta.pdf` like any other, with one extra key on it: `notebook`. That flag
// is the whole difference. It is what says these bytes were generated rather
// than given to us, which is what makes it safe to REGENERATE them when a page
// is added, torn out, or the paper changed — none of which may ever happen to
// somebody's actual document.
//
// ── What regenerating costs ────────────────────────────────────────────────
//
// Very little, and deliberately: every page shares one content stream, so sixty
// pages of grid is under ten kilobytes. That is the number that makes "add a
// page" a rewrite of the whole file rather than an incremental edit — the
// simplest thing that could work, and it works because the file is tiny.
//
// The ink does not move. It is stored per page in PDF user space and the page
// box never changes, so adding a page at the end is invisible to every stroke
// already on the others. Tearing one OUT is the only case that touches them, and
// it is a renumbering: see remapDocumentHighlightPages.

import { BLANK_PAPERS, BLANK_PAGE_HEIGHT, BLANK_PAGE_WIDTH, blankPdfFile, normalizeBlankPaper } from "./blank-pdf.js?v=__BUILD__";
import { remapDocumentHighlightPages } from "./pdf-highlights.js?v=__BUILD__";
import { putDocument, sha256, uploadDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentView } from "./pdf-view.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { storageFolderSlug, storageGroupId } from "../images/upload.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export const NOTEBOOK_MAX_PAGES = 300;

export function isNotebookDeck(meta = state.meta) {
  return Boolean(meta?.pdf?.notebook);
}

export function notebookPaper(meta = state.meta) {
  return normalizeBlankPaper(meta?.pdf?.paper);
}

export function notebookPageCount(meta = state.meta) {
  return Number(meta?.pdf?.pages) || 0;
}

// Write a freshly generated file over the deck's document.
//
// The order is the one src/import/pdf.js arrived at and for the same reason: the
// device copy is written BEFORE the upload, because it is the copy the reader is
// about to draw on and the one that survives being offline. An upload that fails
// leaves a perfectly usable notebook that syncs later.
async function writeNotebookPdf({ pages, paper, reopen = true }) {
  const file = blankPdfFile({ pages, paper, name: state.deckTitle || "handwritten-notes" });
  const hash = await sha256(file);
  // ── meta first, then the save, then the bytes ────────────────────────────
  //
  // Not an arbitrary order — it is the only one that works, and it is the one
  // attachPdfToOpenDeck arrived at. The device store is keyed by the deck's
  // LOCAL id, a local id is minted by the first save, and a save is a silent
  // no-op for a deck with nothing in it (deckPayloadHasContent). A brand-new
  // notebook has no cards and no note, so its only content is the very document
  // being attached: write meta.pdf first and the deck has something to save, and
  // the save is what hands back the id the bytes are filed under.
  state.meta = {
    ...(state.meta && typeof state.meta === "object" ? state.meta : {}),
    pdf: {
      ...(state.meta?.pdf && typeof state.meta.pdf === "object" ? state.meta.pdf : {}),
      name: file.name,
      size: file.size,
      pages,
      paper,
      notebook: true,
      sha256: hash,
      // The old path is not kept. It names bytes that no longer exist, and a
      // device that pulled this deck must not be handed the previous page count.
      path: null,
      importedAt: state.meta?.pdf?.importedAt || new Date().toISOString()
    }
  };
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this deck on your device", "error");
    return false;
  }
  // The device copy before the upload, because it is the one the reader is about
  // to draw on and the one that survives being offline.
  await putDocument({ deckLocalId: state.localDeckId, blob: file, sha256: hash, name: file.name, at: Date.now() });

  try {
    const folder = `${storageFolderSlug(state.deckTitle || "notes", "notes")}--${storageGroupId()}`;
    const path = await uploadDocument(file, { folder, name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook") });
    state.meta = { ...state.meta, pdf: { ...state.meta.pdf, path } };
    await saveDeckToLibrary({ silent: true });
  } catch (error) {
    // Not fatal and not silent. The pages are on this device and drawable; what
    // is not true yet is that they are anywhere else.
    console.warn("Could not upload the notebook", error);
    showToast("Pages saved here — they upload when you're back online", "info");
  }

  if (reopen) await openDocumentView({ force: true });
  return true;
}

// The deck's first page. Called when the Handwritten Notes surface opens on a
// deck that has no document of its own — which is every deck, until it does.
export async function ensureNotebookDocument({ paper = null } = {}) {
  if (state.meta?.pdf) {
    // A deck that already has a PAPER is not a notebook and must never be
    // written over. The surface offers itself on any deck; this is the line
    // that keeps that offer from being destructive.
    if (!isNotebookDeck()) {
      showToast("This deck already has a PDF — its handwriting goes on that", "info");
      return false;
    }
    return true;
  }
  return writeNotebookPdf({ pages: 1, paper: normalizeBlankPaper(paper), reopen: false });
}

export async function addNotebookPage() {
  if (!isNotebookDeck()) return false;
  const pages = notebookPageCount();
  if (pages >= NOTEBOOK_MAX_PAGES) {
    showToast(`A notebook stops at ${NOTEBOOK_MAX_PAGES} pages — start another one`, "info");
    return false;
  }
  return writeNotebookPdf({ pages: pages + 1, paper: notebookPaper() });
}

// Tear out one page.
//
// The renumbering is the whole of it. Every stroke and every highlight after the
// gap is describing a page that has just moved down by one, and a record naming
// page 7 of a six-page document can never be painted or jumped to again. The
// records on the torn-out page are buried in the SAME write, or a sync landing
// between two writes would carry one half of the change.
export async function deleteNotebookPage(pageNumber) {
  if (!isNotebookDeck()) return false;
  const pages = notebookPageCount();
  const n = Number(pageNumber);
  if (!(n >= 1 && n <= pages)) return false;
  if (pages < 2) {
    showToast("A notebook keeps at least one page", "info");
    return false;
  }
  remapDocumentHighlightPages((record) => {
    const on = Number(record?.page) || 0;
    if (on === n) return null;
    return on > n ? on - 1 : on;
  });
  return writeNotebookPdf({ pages: pages - 1, paper: notebookPaper() });
}

export async function setNotebookPaper(kind) {
  if (!isNotebookDeck()) return false;
  const paper = normalizeBlankPaper(kind);
  if (paper === notebookPaper()) return false;
  // Only the paper under the ink changes. The page box is identical, so nothing
  // already written moves — which is why this is a regeneration and not a
  // migration.
  return writeNotebookPdf({ pages: notebookPageCount(), paper });
}

export { BLANK_PAPERS, BLANK_PAGE_WIDTH, BLANK_PAGE_HEIGHT };
