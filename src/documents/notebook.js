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
// exactly as a document is — but in a slot of its own, `meta.notebook`
// (src/documents/doc-slot.js), beside whatever paper the deck already carries in
// `meta.pdf`. The slot is the whole difference. It is what says these bytes were
// generated rather than given to us, which is what makes it safe to REGENERATE
// them when a page is added, torn out, or the paper changed — none of which may
// ever happen to somebody's actual document.
//
// It used to live in `meta.pdf` with a `notebook: true` flag on it, and that is
// what made the app say "This deck already has a PDF — its handwriting goes on
// that" to anybody who wanted to write beside a paper they were reading. One
// shelf, two things that want to be on it. Decks in that state are moved here on
// open (migrateNotebookSlot below).
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

import { BLANK_PAPERS, BLANK_PAGE_HEIGHT, BLANK_PAGE_WIDTH, BLANK_PAPER_VERSION, blankPdfFile, normalizeBlankPaper } from "./blank-pdf.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, documentStoreKey } from "./doc-slot.js?v=__BUILD__";
import { hasLegacyNotebook, hasNotebookInPdfSlot, migratedNotebookMeta, movedNotebookSlotMeta, planLegacyNotebookMigration } from "./notebook-migrate.js?v=__BUILD__";
import { freshDocumentHighlightId, remapDocumentHighlightPages } from "./pdf-highlights.js?v=__BUILD__";
import { deleteLocalDocument, putDocument, readDocument, sha256, uploadDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentView } from "./pdf-view.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { storageFolderSlug, storageGroupId } from "../images/upload.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export const NOTEBOOK_MAX_PAGES = 300;

export function hasNotebook(meta = state.meta) {
  return Boolean(meta?.notebook);
}

export function notebookPaper(meta = state.meta) {
  return normalizeBlankPaper(meta?.notebook?.paper);
}

export function notebookPageCount(meta = state.meta) {
  return Number(meta?.notebook?.pages) || 0;
}

// Where this deck's notebook bytes are filed on the device. One row per
// document, so a deck with a paper AND a notebook has two.
function notebookStoreKey() {
  return documentStoreKey(state.localDeckId, DOC_SLOT_NOTEBOOK);
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
  // being attached: write meta.notebook first and the deck has something to save,
  // and the save is what hands back the id the bytes are filed under.
  // (deckPayloadHasContent counts a notebook for exactly this reason.)
  state.meta = {
    ...(state.meta && typeof state.meta === "object" ? state.meta : {}),
    notebook: {
      ...(state.meta?.notebook && typeof state.meta.notebook === "object" ? state.meta.notebook : {}),
      name: file.name,
      size: file.size,
      pages,
      paper,
      notebook: true,
      // What the sheet under the ink looks like — see BLANK_PAPER_VERSION. A
      // notebook drawn at an older one is redrawn on the next open.
      paperV: BLANK_PAPER_VERSION,
      sha256: hash,
      // The old path is not kept. It names bytes that no longer exist, and a
      // device that pulled this deck must not be handed the previous page count.
      path: null,
      importedAt: state.meta?.notebook?.importedAt || new Date().toISOString()
    }
  };
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this deck on your device", "error");
    return false;
  }
  // The device copy before the upload, because it is the one the reader is about
  // to draw on and the one that survives being offline.
  await putDocument({ deckLocalId: notebookStoreKey(), blob: file, sha256: hash, name: file.name, at: Date.now() });

  try {
    const folder = `${storageFolderSlug(state.deckTitle || "notes", "notes")}--${storageGroupId()}`;
    const path = await uploadDocument(file, { folder, name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook") });
    state.meta = { ...state.meta, notebook: { ...state.meta.notebook, path } };
    await saveDeckToLibrary({ silent: true });
  } catch (error) {
    // Not fatal and not silent. The pages are on this device and drawable; what
    // is not true yet is that they are anywhere else.
    console.warn("Could not upload the notebook", error);
    showToast("Pages saved here — they upload when you're back online", "info");
  }

  if (reopen) await openDocumentView({ force: true, slot: DOC_SLOT_NOTEBOOK });
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
  // Decks whose notebook is still in the document slot are moved first, so every
  // branch below is asking about the same key on every deck. Idempotent, and a
  // no-op for every deck that has never had a notebook.
  if (hasNotebookInPdfSlot(state.meta)) await migrateNotebookSlot();
  if (hasNotebook()) {
    // A notebook whose bytes have gone — a device that pulled the deck but never
    // the file, a store cleared to reclaim space. The paper is GENERATED, so it
    // can simply be made again from the record of what it was; that is a property
    // no real document has and it would be a waste not to use it.
    if (!(await notebookBytesPresent())) {
      showToast("Re-making this notebook's paper on this device…", "info");
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    // ...and the same property, used for the same reason one step further on: a
    // sheet drawn by an older build is redrawn to the current one. Silent,
    // because nothing about the deck changes — same page box, same page count,
    // same ink in the same places — only the paper under it. Here rather than on
    // deck load, so it is the reader arriving at the surface that pays for it.
    if (Number(state.meta.notebook.paperV || 1) < BLANK_PAPER_VERSION) {
      return (await writeNotebookPdf({ pages: notebookPageCount(), paper: notebookPaper(), reopen: false })) && "wrote";
    }
    return "kept";
  }
  // ── There is no refusal here any more ────────────────────────────────────
  //
  // This used to stop dead on a deck that already had a PDF — "This deck already
  // has a PDF, its handwriting goes on that" — because there was one document
  // slot and the paper was in it. There are two now, so a deck that is reading
  // somebody's preprint can have blank pages of its own beside it, which is what
  // anybody pressing this on such a deck meant in the first place.
  if (hasLegacyNotebook(state.meta)) return (await migrateLegacyNotebook()) && "wrote";
  return (await writeNotebookPdf({ pages: 1, paper: normalizeBlankPaper(paper), reopen: false })) && "wrote";
}

async function notebookBytesPresent() {
  if (!state.localDeckId) return false;
  try {
    const entry = await readDocument(notebookStoreKey());
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

  await putDocument({ deckLocalId: notebookStoreKey(), blob: file, sha256: hash, name: file.name, at: Date.now() });
  try {
    const folder = `${storageFolderSlug(state.deckTitle || "notes", "notes")}--${storageGroupId()}`;
    const path = await uploadDocument(file, { folder, name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "notebook") });
    state.meta = { ...state.meta, notebook: { ...state.meta.notebook, path } };
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

// ── The move out of the document slot ──────────────────────────────────────
//
// The first real-paper notebooks put their generated PDF in `meta.pdf`, because
// that was the only slot there was — which is exactly what made a deck able to
// have a notebook or a paper and never both. This moves such a deck onto
// `meta.notebook`, and the order is the same one every other write in this file
// keeps, for the same reason:
//
//   • the meta is computed by a pure function that touches nothing
//     (movedNotebookSlotMeta), so a failure before the save leaves the deck
//     exactly as it was and the next open tries again;
//   • ONE write swaps the slot and stamps the records in the same breath, so
//     there is no moment at which the strokes belong to no paper;
//   • the save is the commit point;
//   • the bytes are moved after it, and a failure there costs nothing — the
//     paper is GENERATED, so notebookBytesPresent will simply make it again.
//
// The old row is deleted only once the new one is written. A crash between the
// two leaves the file under both keys, which is a few kilobytes, not a loss.
export async function migrateNotebookSlot() {
  if (!hasNotebookInPdfSlot(state.meta)) return false;
  const wasLocalId = state.localDeckId;
  state.meta = movedNotebookSlotMeta(state.meta);
  if (!(await saveDeckToLibrary({ silent: true })) || !state.localDeckId) {
    showToast("Could not save this deck on your device — your pages were left as they were", "error");
    return false;
  }
  if (!wasLocalId) return true;
  try {
    const existing = await readDocument(wasLocalId);
    if (existing?.blob) {
      await putDocument({ ...existing, deckLocalId: notebookStoreKey() });
      await deleteLocalDocument(wasLocalId);
    }
  } catch (error) {
    console.warn("Could not move the notebook's paper on this device", error);
  }
  return true;
}

export async function addNotebookPage() {
  if (!hasNotebook()) return false;
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
  if (!hasNotebook()) return false;
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
  if (!hasNotebook()) return false;
  const paper = normalizeBlankPaper(kind);
  if (paper === notebookPaper()) return false;
  // Only the paper under the ink changes. The page box is identical, so nothing
  // already written moves — which is why this is a regeneration and not a
  // migration.
  return writeNotebookPdf({ pages: notebookPageCount(), paper });
}

export { BLANK_PAPERS, BLANK_PAGE_WIDTH, BLANK_PAGE_HEIGHT };
