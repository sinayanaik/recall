// PDF import: one deck per paper, with the PDF itself as the document.
//
// Nothing is extracted. There is no markdown conversion step here and no OCR —
// the deck's Notes tab starts empty, for the reader to write in, and the
// Document tab is the file. That is the whole design: reconstructing display
// maths from glyph positions is unreliable, and cropping every equation to an
// image would spend a 1GB budget on a few dozen papers.
//
// What IS read at import time is metadata: the title, the page count, and any
// highlights already in the file (Zotero, Preview, Okular). Those are converted
// to the app's own records once, so dropping in a paper you have already been
// annotating carries on where you left off rather than starting blank.
//
// Exports mirror src/import/epub.js — isPdfName / importPdfFile /
// reportPdfImportCrash — so the dispatch in files.js stays symmetric and a
// reader of that file does not have to learn two shapes.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensurePdfJs } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { annotationQuads, nearestHighlightColor } from "../documents/pdf-highlights.js?v=__BUILD__";
import { textForQuads } from "../documents/pdf-selection.js?v=__BUILD__";
import { MAX_DOCUMENT_BYTES, putDocument, sha256, uploadDocument } from "../documents/pdf-store.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { setHighlightNoteInSource } from "../format/highlight-notes.js?v=__BUILD__";
import { storageFolderSlug, storageGroupId } from "../images/upload.js?v=__BUILD__";
import { showImportProgress } from "./epub.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { currentMyDecksFolder } from "../library/my-decks-menu.js?v=__BUILD__";
import { setMyDecksCwd, setMyDecksView } from "../library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { persistWorkingDeck } from "../storage/quota.js?v=__BUILD__";
import { openMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

export function isPdfName(name) {
  return /\.pdf$/i.test(String(name || ""));
}

// A PDF's own Title metadata is frequently the LaTeX class's leftovers
// ("untitled.dvi", "Microsoft Word - paper_final_v3.doc") rather than the
// paper's name, so a candidate has to earn its place. Anything that looks like
// a filename, a producer string, or a placeholder loses to the actual filename,
// which at least someone chose.
export const GENERIC_PDF_TITLE_RE = /^(untitled|unknown|no\s*title|n\/a|null|undefined|document\d*|paper|main|ms|manuscript)$/i;

export const MAX_PDF_TITLE_LENGTH = 120;

export function normalizePdfTitle(raw) {
  const text = String(raw || "")
    .replace(/^Microsoft Word\s*-\s*/i, "")
    .replace(/\.(dvi|tex|doc|docx|pdf|ps|indd)$/i, "")
    .replace(/[_\s]+/g, " ")
    .trim();
  if (!text) return "";
  if (GENERIC_PDF_TITLE_RE.test(text)) return "";
  // A "title" that is really a path or a producer banner.
  if (/[\\/]/.test(text)) return "";
  if (text.length > MAX_PDF_TITLE_LENGTH) return text.slice(0, MAX_PDF_TITLE_LENGTH).trimEnd();
  return text;
}

export function pdfTitleFor(metadata, fileName) {
  // The generic-title filter applies to the PDF's own METADATA only. Those
  // words ("paper", "main", "ms", "manuscript") are what a LaTeX class or Word
  // leaves behind; a FILENAME is something a person typed, so "paper.pdf"
  // should give a deck called "paper" rather than one called "Imported PDF" —
  // which is both less informative and identical for every such file.
  const fromMetadata = normalizePdfTitle(metadata?.info?.Title);
  if (fromMetadata) return fromMetadata;
  const fromName = String(fileName || "").replace(/\.pdf$/i, "").replace(/[_\s]+/g, " ").trim();
  return fromName.slice(0, MAX_PDF_TITLE_LENGTH).trim() || "Imported PDF";
}

// How many pages are scanned for existing annotations. A getAnnotations() per
// page is cheap, but a thousand-page reference work is a thousand of them
// during an import the reader is watching — and a document that long was not
// annotated by hand past this point either.
export const ANNOTATION_SCAN_PAGE_LIMIT = 600;

// Every Highlight annotation already in the file, as this app's own records.
//
// The annotation's own `contents` — what Zotero calls the comment on a
// highlight — becomes a highlight NOTE, written into the same "## Highlight
// Notes" section a note taken in this app goes into. That is the point of using
// one id namespace for both: an imported comment is not a second-class
// annotation, it is a note, and it is editable and exportable as one.
export async function readExistingHighlights(doc, progress) {
  const records = [];
  const notes = [];
  const pageCount = Math.min(doc.numPages, ANNOTATION_SCAN_PAGE_LIMIT);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    if (progress?.cancelled()) break;
    if (pageNumber % 25 === 0) {
      progress?.update(`Reading existing highlights… page ${pageNumber} of ${pageCount}`, 0.1 + 0.5 * (pageNumber / pageCount));
      // Yields to the event loop so the progress modal actually repaints and
      // its Cancel button stays live on a long document.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    let annotations;
    let page;
    try {
      page = await doc.getPage(pageNumber);
      annotations = await page.getAnnotations();
    } catch (error) {
      console.warn(`Could not read annotations on page ${pageNumber}`, error);
      continue;
    }
    const highlights = (annotations || []).filter((annotation) => annotation?.subtype === "Highlight");
    if (!highlights.length) continue;

    // Only fetched for a page that actually has highlights on it — this is the
    // expensive call, and most pages have none.
    let items = [];
    try {
      items = (await page.getTextContent()).items || [];
    } catch (_) { /* an image-only page: the quads still paint, there is just no text */ }

    highlights.forEach((annotation, index) => {
      const quads = annotationQuads(annotation, pageNumber);
      if (!quads.length) return;
      const { text, item } = textForQuads(items, quads);
      const id = `hn-${(pageNumber * 1000 + index).toString(36)}${Math.random().toString(36).slice(2, 4)}`;
      records.push({
        id,
        color: nearestHighlightColor(annotation.color) || MARK_HIGHLIGHT_DEFAULT,
        page: pageNumber,
        anchor: { page: pageNumber, item, ch: 0 },
        focus: { page: pageNumber, item, ch: 0 },
        text,
        quads,
        imported: true,
        at: Date.now()
      });
      const comment = String(annotation.contentsObj?.str || annotation.contents || "").trim();
      if (comment) notes.push({ id, text: comment, label: text ? `“${text.slice(0, 60)}”` : "" });
    });
  }
  return { records, notes };
}

export function reportPdfImportCrash(error) {
  console.error("PDF import failed", error);
  const message = `Could not import this PDF — ${error?.message || error?.name || "unexpected error"}`;
  setStatus(message, "error");
  showToast(message, "error");
}

// Entry point, wired to the Import panel's file input and to My Decks →
// Import PDF.
export async function importPdfFile(file, folderPath = null) {
  if (!file) return;
  if (file.size > MAX_DOCUMENT_BYTES) {
    const message = `${file.name} is larger than the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))}MB limit for a document.`;
    setStatus(message, "error");
    showToast(message, "error");
    return;
  }
  setStatus(`Reading ${file.name}…`);
  if (!(await ensurePdfJs())) {
    setStatus("The PDF reader did not load — reconnect once and try again.", "error");
    showToast("The PDF reader did not load", "error");
    return;
  }

  let doc;
  let metadata = null;
  try {
    // A copy, because pdf.js transfers the buffer it is given to its worker and
    // the File has to stay readable afterwards for the store and the upload.
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    metadata = await doc.getMetadata().catch(() => null);
  } catch (error) {
    console.error("PDF parse failed", error);
    setStatus(`Could not read ${file.name}.`, "error");
    showToast("Could not read this PDF", "error");
    return;
  }

  const title = pdfTitleFor(metadata, file.name);
  const progress = showImportProgress(title, "PDF");
  let savedState = null;
  try {
    progress.update("Reading the document…", 0.05);
    const pageCount = doc.numPages;
    const { records, notes } = await readExistingHighlights(doc, progress);
    // The parsed document has done its job — the reader gets a fresh one when
    // the deck opens, from the stored blob.
    await doc.destroy().catch(() => {});
    doc = null;

    progress.update("Hashing the file…", 0.65);
    const hash = await sha256(file);

    // The working deck is put back afterwards, exactly as runEpubImport does:
    // this writes a deck through saveDeckToLibrary rather than the
    // one-deck-at-a-time editor flow, so it must not clobber whatever the
    // reader had open.
    savedState = {
      deckId: state.deckId, localDeckId: state.localDeckId, deckTitle: state.deckTitle,
      deckCategory: state.deckCategory, notes: state.notes, masterCards: state.masterCards,
      sourceTitle: state.sourceTitle, meta: state.meta
    };

    const parentFolder = folderPath != null ? folderPath : currentMyDecksFolder();
    const targetFolder = normalizeDeckCategory(parentFolder);
    const sanitizedTitle = title.replace(/\//g, "-").trim() || "Imported PDF";

    // Imported comments become highlight notes in the deck's own note, through
    // the same writer the note editor uses — so the section is byte-identical
    // in shape to one this app wrote itself.
    let deckNotes = "";
    notes.forEach((note) => {
      deckNotes = setHighlightNoteInSource(deckNotes, note.id, note.text, note.label);
    });

    state.deckId = null;
    state.localDeckId = null;
    state.deckTitle = sanitizedTitle;
    state.deckCategory = targetFolder;
    state.notes = deckNotes;
    state.masterCards = [];
    state.sourceTitle = sanitizedTitle;
    state.meta = {
      pdf: {
        name: file.name,
        size: file.size,
        pages: pageCount,
        sha256: hash,
        // Filled in below once the upload lands. A deck saved with no path is a
        // perfectly good device-local PDF deck — which is exactly what a failed
        // or offline import should leave behind.
        path: null,
        importedAt: new Date().toISOString()
      },
      pdfHighlights: records
    };

    progress.update("Saving the deck…", 0.7);
    if (!(await saveDeckToLibrary({ silent: true }))) {
      throw new Error("could not save the deck on this device");
    }
    const deckLocalId = state.localDeckId;

    // The device copy FIRST, and before the upload: it is the copy the reader
    // is about to open, and it is the one that survives being offline. An
    // import that gets this far is already a usable deck.
    progress.update("Storing the document on this device…", 0.75);
    await putDocument({ deckLocalId, blob: file, sha256: hash, name: file.name, at: Date.now() });

    let uploadError = "";
    try {
      progress.update("Uploading the document…", 0.85);
      const folder = `${storageFolderSlug(title, "paper")}--${storageGroupId()}`;
      const path = await uploadDocument(file, { folder, name: storageFolderSlug(file.name.replace(/\.pdf$/i, ""), "document") }, progress);
      state.meta = { ...state.meta, pdf: { ...state.meta.pdf, path } };
      await saveDeckToLibrary({ silent: true });
    } catch (error) {
      // Deliberately not fatal, and deliberately said out loud. The deck is
      // readable on this device either way; what the reader loses is the copy
      // that would let them open it on their phone, and they can only decide
      // what to do about that if they are told.
      uploadError = error?.message === "OFFLINE" ? "you're offline"
        : error?.message === "NOT_SIGNED_IN" ? "you're not signed in"
          : error?.message === "CANCELLED" ? "you cancelled it"
            : /timed out/i.test(error?.message || "") ? "the connection timed out"
              : /bucket/i.test(error?.message || "")
                ? "the documents bucket is missing — re-run supabase_setup.sql"
                : error?.message || "the upload failed";
      console.warn("Could not upload the document", error);
    }

    Object.assign(state, savedState);
    persistWorkingDeck();
    savedState = null;

    setMyDecksView("folder");
    setMyDecksCwd(targetFolder);
    if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    else openMyDecksPanel();

    const highlightNote = records.length
      ? ` · ${records.length} existing highlight${records.length === 1 ? "" : "s"} imported`
      : "";
    const summary = `Imported "${title}" — ${pageCount} page${pageCount === 1 ? "" : "s"}${highlightNote}`;
    progress.update(summary, 1);
    if (uploadError) {
      const message = `${summary}. It's on this device, but not in the cloud — ${uploadError}. Sync once you're back to read it elsewhere.`;
      setStatus(message, "error");
      showToast(message, "error");
    } else {
      setStatus(`${summary}.`);
      showToast(summary);
    }
  } catch (error) {
    console.error("PDF import failed", error);
    if (savedState) {
      Object.assign(state, savedState);
      persistWorkingDeck();
    }
    const message = `Could not import "${title}" — ${error?.message || error?.name || "unexpected error"}`;
    setStatus(message, "error");
    showToast(message, "error");
  } finally {
    await doc?.destroy?.().catch(() => {});
    progress.close();
  }
}
