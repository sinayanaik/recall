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
import { hasLegacyNotebook, migratedNotebookMeta, planLegacyNotebookMigration } from "./notebook-migrate.js?v=__BUILD__";
import { freshDocumentHighlightId, remapDocumentHighlightPages } from "./pdf-highlights.js?v=__BUILD__";
import { putDocument, readDocument, sha256, uploadDocument } from "./pdf-store.js?v=__BUILD__";
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
//
// Answers one of three things, and the caller needs all three: `false` (there is
// no paper and this deck is not getting any), "kept" (the paper that was already
// there is the paper to use), or "wrote" (these bytes are NEW). The last one
// matters because openDocumentView with `force: false` is a no-op for a document
// it believes is already open, and it decides that by deck — not by the bytes.
// Regenerate a notebook's paper under a view that is already showing that same
// deck and the reader is left looking at the previous file: the page that was
// just re-made, or the pages that were just converted, are not on the screen and
// nothing says why. So "wrote" is the caller's instruction to force the reopen.
export async function ensureNotebookDocument({ paper = null } = {}) {
  if (state.meta?.pdf) {
    // A deck that already has a PAPER is not a notebook and must never be
    // written over. The surface offers itself on any deck; this is the line
    // that keeps that offer from being destructive.
    if (!isNotebookDeck()) {
      if (hasLegacyNotebook(state.meta)) {
        // The one case the migration refuses. Those strokes are coordinates into
        // a page this app generated, and this deck's pages belong to somebody
        // else's document — there is nowhere honest to put them. Left completely
        // alone rather than half-converted, and said out loud so it is a decision
        // and not a silence.
        showToast("This deck has its own PDF, so its older handwritten pages were left untouched", "info");
      } else {
        showToast("This deck already has a PDF — its handwriting goes on that", "info");
      }
      return false;
    }
    // A notebook whose bytes have gone — a device that pulled the deck but never
    // the file, a store cleared to reclaim space. The paper is GENERATED, so it
    // can simply be made again from the record of what it was; that is a property
    // no real document has and it would be a waste not to use it.
    if (!(await notebookBytesPresent())) {
      showToast("Re-making this notebook's paper on this device…", "info");
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    return "kept";
  }
  if (hasLegacyNotebook(state.meta)) return (await migrateLegacyNotebook()) && "wrote";
  return (await writeNotebookPdf({ pages: 1, paper: normalizeBlankPaper(paper), reopen: false })) && "wrote";
}

async function notebookBytesPresent() {
  if (!state.localDeckId) return false;
  try {
    const entry = await readDocument(state.localDeckId);
    return Boolean(entry?.blob);
  } catch (_) {
    // An unreadable store is not the same as an absent file, and re-generating
    // over one would be writing on a guess. Treated as present so nothing is
    // overwritten; the ordinary "could not open" path reports it.
    return true;
  }
}

// ── Older notebooks ────────────────────────────────────────────────────────
//
// The conversion itself is pure and lives in ./notebook-migrate.js so a Node
// check can drive it. What is here is the writing, and the order of it is the
// whole of the safety:
//
//   • the plan is computed first and touches nothing;
//   • the bytes are made and hashed, still touching nothing;
//   • ONE write then swaps the legacy keys for the records they became, so
//     there is no moment at which the strokes live nowhere;
//   • the save is the commit point. Everything after it — storing the bytes,
//     uploading them — can fail without losing anything, because a generated
//     paper can always be made again (see notebookBytesPresent above).
//
// A failure before the save leaves the deck exactly as it was, legacy keys
// included, and the next open tries again.
export async function migrateLegacyNotebook() {
  const plan = planLegacyNotebookMigration(state.meta, { mintId: freshDocumentHighlightId });
  const file = blankPdfFile({ pages: plan.pages, paper: plan.paper, name: state.deckTitle || "handwritten-notes" });
  const hash = await sha256(file);

  state.meta = migratedNotebookMeta(state.meta, plan, {
    name: file.name,
    size: file.size,
    pages: plan.pages,
    paper: plan.paper,
    notebook: true,
    sha256: hash,
    path: null,
    importedAt: new Date().toISOString()
  });

  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this deck on your device — your pages were left as they were", "error");
    return false;
  }

  await putDocument({ deckLocalId: state.localDeckId, blob: file, sha256: hash, name: file.name, at: Date.now() });
  try {
    const folder = `${storageFolderSlug(state.deckTitle || "notes", "notes")}--${storageGroupId()}`;
    const path = await uploadDocument(file, { folder, name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook") });
    state.meta = { ...state.meta, pdf: { ...state.meta.pdf, path } };
    await saveDeckToLibrary({ silent: true });
  } catch (error) {
    console.warn("Could not upload the migrated notebook", error);
  }

  const marks = plan.ink.length;
  const blocks = plan.blocks.length;
  const lost = plan.orphans
    ? ` ${plan.orphans} text box${plan.orphans === 1 ? "" : "es"} had no page to sit on and were left out.`
    : "";
  showToast(
    `Your handwritten pages are on real paper now — ${plan.pages} page${plan.pages === 1 ? "" : "s"}`
    + `${marks ? `, ${marks} with writing on` : ""}${blocks ? `, ${blocks} text block${blocks === 1 ? "" : "s"}` : ""}.${lost}`
  );
  return true;
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
