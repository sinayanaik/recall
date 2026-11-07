// Markdown → PDF: putting the pages in the file.
//
//   new PDF      a PDF of its own in the file's PDFs list, through
//                attachPdfToOpenDeck — the same path a PDF from the device takes
//   insert       markdown pages put into the open PDF before page N
//   rebuild      a part's pages made again from its edited markdown
//   remove       a part's pages taken out of a PDF
//
// The last three change somebody's PDF, so they take the path the margins do
// (src/documents/pdf-replace.js) and move what is written on the PDF with its
// pages: a highlight, a stroke, a shape or a block on a page after the change
// is renumbered by the pages that came or went. On a rebuild the marks ON the
// remade pages are found again by their words (md-pdf/anchors.js); a mark that
// cannot be — its words were edited away, or it is ink — stays on the page it
// was on (as near as the remade part has one), and the reader is told how many.
//
// The markdown itself is kept inside the PDF (md-pdf/parts.js); the record only
// says how many parts there are, so the ⋯ menu knows to offer "Edit markdown…".

import { ensurePdfLib } from "../../core/lib-loader.js?v=__BUILD__";
import { state } from "../../core/state.js?v=__BUILD__";
import { attachPdfToOpenDeck } from "../../import/pdf.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../../ui/feedback.js?v=__BUILD__";
import { activeDocSlot, DOC_SLOT_DOC } from "../doc-slot.js?v=__BUILD__";
import { remapDocumentBlockPages } from "../pdf-blocks.js?v=__BUILD__";
import { documentHighlights, remapDocumentHighlightPages, updateDocumentHighlight } from "../pdf-highlights.js?v=__BUILD__";
import { applyPdfMargins, hasMargins } from "../pdf-margins-core.js?v=__BUILD__";
import { deckPdfById, pdfStoreKey } from "../pdf-multi.js?v=__BUILD__";
import { replacePdfBytes } from "../pdf-replace.js?v=__BUILD__";
import { getDocument } from "../pdf-store.js?v=__BUILD__";
import { openDocumentPdfId } from "../pdf-view.js?v=__BUILD__";
import { locateText, textCorpus } from "./anchors.js?v=__BUILD__";
import { PartsError, mintPartId, readParts, splicePart } from "./parts.js?v=__BUILD__";

export function pdfFileName(title) {
  const base = String(title || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "Markdown"}.pdf`;
}

function partData({ markdown, options, cuts, title }) {
  return { source: String(markdown || ""), options, cuts: Array.isArray(cuts) ? cuts : null, title: title || "" };
}

// ── a new PDF ───────────────────────────────────────────────────────────────

export async function saveNewMarkdownPdf(session, laid, plan, { markdown, options, cuts, title }) {
  const part = { id: mintPartId(), data: partData({ markdown, options, cuts, title }) };
  const out = await session.write(laid, plan, { title, part });
  const file = new File([out.bytes], pdfFileName(title), { type: "application/pdf" });
  return attachPdfToOpenDeck(file, { entry: { label: title || undefined, md: { parts: 1 } } });
}

// ── the open PDF ────────────────────────────────────────────────────────────

function openMdTarget() {
  if (activeDocSlot() !== DOC_SLOT_DOC) return null;
  const pdfId = openDocumentPdfId();
  const entry = pdfId ? deckPdfById(state.meta, pdfId) : null;
  return entry ? { pdfId, entry } : null;
}

async function storedBytes(pdfId, entry) {
  const blob = await getDocument(pdfStoreKey(state.localDeckId, pdfId), entry);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// The open PDF's markdown parts, read out of its bytes: [{ id, data, pages }].
export async function openPdfParts() {
  const open = openMdTarget();
  if (!open || !(await ensurePdfLib())) return [];
  const bytes = await storedBytes(open.pdfId, open.entry);
  if (!bytes) return [];
  try {
    const doc = await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    return readParts(window.PDFLib, doc).filter((part) => part.data && typeof part.data.source === "string");
  } catch (error) {
    console.warn("Could not read the markdown kept in this PDF", error);
    return [];
  }
}

export function openPdfPageCount() {
  return Number(openMdTarget()?.entry?.pages) || 0;
}

// The marks on the open PDF, moved for a change to pages [from, from+removed)
// that became [from, from+added) — 0-based `from`, records 1-based. `found` is
// id → { page, quads } for the marks whose words were found again.
function moveMarks({ from, removed, added, found = new Map(), drop = false }) {
  const delta = added - removed;
  const move = (page) => {
    const p = Number(page) - 1;
    if (!Number.isFinite(p)) return page;
    if (p < from) return page;
    if (p >= from + removed) return page + delta;
    // On a page that was replaced: kept on the page at the same place in the
    // part, or the part's last page if it is shorter now.
    if (drop || added <= 0) return null;
    return from + Math.min(p - from, added - 1) + 1;
  };
  remapDocumentHighlightPages((record) => (found.has(record.id) ? found.get(record.id).page : move(record.page)));
  remapDocumentBlockPages((block) => move(block.page));
  for (const [id, place] of found) {
    updateDocumentHighlight(id, { page: place.page, quads: place.quads, anchor: null, focus: null });
  }
}

// After a remake: the text marks that were on the old pages, found on the new.
function reanchor(out, { from, removed }, measure) {
  const found = new Map();
  let lost = 0;
  const corpus = textCorpus(out.textRuns);
  for (const record of documentHighlights()) {
    const p = Number(record.page) - 1;
    if (p < from || p >= from + removed) continue;
    // Only a text highlight has words to look for. Ink, shapes and regions
    // keep their place on the page (moveMarks).
    const isText = (!record.kind || record.kind === "text") && record.text;
    if (!isText) continue;
    const quads = locateText(out.textRuns, record.text, measure, { near: p - from, corpus });
    if (!quads) { lost += 1; continue; }
    const page = from + quads[0].page + 1;
    found.set(record.id, { page, quads: quads.map((q) => ({ page: from + q.page + 1, rect: q.rect })) });
  }
  return { found, lost };
}

function marksOnPages(from, count) {
  const onPages = (page) => {
    const p = Number(page) - 1;
    return p >= from && p < from + count;
  };
  return documentHighlights().filter((r) => onPages(r.page)).length;
}

let mdPagesBusy = false;

// Put the pages in (insert), or replace a part's pages with them (rebuild).
// `at` is 0-based (insert before page at+1). Resolves true on success.
export async function spliceIntoOpenPdf(session, laid, plan, { markdown, options, cuts, title, at = null, partId = null }) {
  if (mdPagesBusy) return false;
  const open = openMdTarget();
  if (!open || !state.localDeckId) {
    showToast("Open a PDF first", "error");
    return false;
  }
  mdPagesBusy = true;
  try {
    const { pdfId, entry } = open;
    if (!(await ensurePdfLib())) {
      showToast("Changing the pages needs to be online once, to fetch the PDF writer.", "error");
      return false;
    }
    const base = await storedBytes(pdfId, entry);
    if (!base) {
      showToast("This device doesn't have a copy of the PDF to change.", "error");
      return false;
    }
    const data = partData({ markdown, options, cuts, title });
    const id = partId || mintPartId();
    const out = await session.write(laid, plan, { title, deferInternalLinks: true });
    let result;
    try {
      result = await splicePart(window.PDFLib, base, out.bytes, partId ? { replaceId: partId, part: { id, data } } : { at, part: { id, data } });
      // Margins on this PDF go on the new pages too; the pages that had them
      // keep them exactly (the margins start from each page's own base box).
      if (entry.margins && hasMargins(entry.margins)) {
        result = { ...result, bytes: (await applyPdfMargins(window.PDFLib, result.bytes, entry.margins)).bytes };
      }
    } catch (error) {
      if (error instanceof PartsError && error.code === "encrypted") showToast("This PDF is protected, so its pages can't be changed.", "error");
      else if (error instanceof PartsError) showToast(error.message, "error");
      else {
        console.warn("Could not put the markdown pages in the PDF", error);
        showToast("Could not change this PDF's pages.", "error");
      }
      return false;
    }
    const parts = readParts(window.PDFLib, await window.PDFLib.PDFDocument.load(result.bytes, { updateMetadata: false }));
    let lost = 0;
    const outcome = await replacePdfBytes(pdfId, entry, result.bytes, {
      // The original file the reader has on disk is no longer this PDF once
      // pages have been put into it: re-attaching it would lose them.
      patch: { pages: result.pageCount, md: { parts: parts.length }, baseSha256: null },
      beforeSave: () => {
        const span = { from: result.from, removed: result.removed, added: result.added };
        const { found, lost: missing } = partId ? reanchor(out, span, laid.fontSet.measure) : { found: new Map(), lost: 0 };
        lost = missing;
        moveMarks({ ...span, found });
      }
    });
    if (outcome === "changed") {
      showToast("This PDF changed while the pages were being made — try again.", "error");
      return false;
    }
    if (outcome !== "ok") return false;
    const pages = `${result.added} page${result.added === 1 ? "" : "s"}`;
    if (partId) {
      showToast(lost
        ? `Pages remade — ${lost} mark${lost === 1 ? "" : "s"} on them could not be matched to the new text and stayed where they were`
        : `Pages remade — ${pages}`);
    } else {
      showToast(`${pages} of markdown put in before page ${result.from + 1}`);
    }
    return true;
  } finally {
    mdPagesBusy = false;
  }
}

// Take a part's pages out of the open PDF.
export async function removePartFromOpenPdf(partId) {
  if (mdPagesBusy) return false;
  const open = openMdTarget();
  if (!open || !(await ensurePdfLib())) return false;
  const { pdfId, entry } = open;
  const base = await storedBytes(pdfId, entry);
  if (!base) {
    showToast("This device doesn't have a copy of the PDF to change.", "error");
    return false;
  }
  const doc = await window.PDFLib.PDFDocument.load(base, { updateMetadata: false });
  const part = readParts(window.PDFLib, doc).find((p) => p.id === partId);
  if (!part) {
    showToast("Those pages are no longer in this PDF", "error");
    return false;
  }
  if (part.pages.length >= doc.getPageCount()) {
    showToast("Every page of this PDF is that markdown — use Remove this PDF instead", "error");
    return false;
  }
  const marks = marksOnPages(part.pages[0], part.pages.length);
  const ok = await new Promise((resolve) => {
    showConfirmModal(
      `Take ${part.pages.length} page${part.pages.length === 1 ? "" : "s"} made from markdown out of this PDF${marks ? `, with the ${marks} mark${marks === 1 ? "" : "s"} on them` : ""}?`,
      () => resolve(true),
      { confirmLabel: "Take out", danger: true, onCancel: () => resolve(false) }
    );
  });
  if (!ok) return false;
  mdPagesBusy = true;
  try {
    const result = await splicePart(window.PDFLib, base, null, { removeId: partId });
    const parts = readParts(window.PDFLib, await window.PDFLib.PDFDocument.load(result.bytes, { updateMetadata: false }));
    const outcome = await replacePdfBytes(pdfId, entry, result.bytes, {
      patch: { pages: result.pageCount, md: parts.length ? { parts: parts.length } : null },
      beforeSave: () => moveMarks({ from: result.from, removed: result.removed, added: 0, drop: true })
    });
    if (outcome === "ok") showToast(`Took out ${result.removed} page${result.removed === 1 ? "" : "s"}`);
    return outcome === "ok";
  } catch (error) {
    console.warn("Could not take the pages out", error);
    showToast("Could not change this PDF's pages.", "error");
    return false;
  } finally {
    mdPagesBusy = false;
  }
}

// A whole PDF that is ONE markdown part: remade as a fresh file (so it keeps
// its bookmarks, which pages copied into another file do not carry), with the
// marks moved as for any rebuild.
export async function rebuildWholePdf(session, laid, plan, { markdown, options, cuts, title, partId }) {
  if (mdPagesBusy) return false;
  const open = openMdTarget();
  if (!open) return false;
  mdPagesBusy = true;
  try {
    return await rebuildWholeNow(session, laid, plan, { markdown, options, cuts, title, partId, open });
  } finally {
    mdPagesBusy = false;
  }
}

async function rebuildWholeNow(session, laid, plan, { markdown, options, cuts, title, partId, open }) {
  const { pdfId, entry } = open;
  const data = partData({ markdown, options, cuts, title });
  const out = await session.write(laid, plan, { title, part: { id: partId, data } });
  let bytes = out.bytes;
  if (entry.margins && hasMargins(entry.margins)) bytes = (await applyPdfMargins(window.PDFLib, bytes, entry.margins)).bytes;
  const removed = Number(entry.pages) || 0;
  let lost = 0;
  const outcome = await replacePdfBytes(pdfId, entry, bytes, {
    patch: { pages: out.pageCount, md: { parts: 1 }, baseSha256: null },
    beforeSave: () => {
      const span = { from: 0, removed, added: out.pageCount };
      const { found, lost: missing } = reanchor(out, span, laid.fontSet.measure);
      lost = missing;
      moveMarks({ ...span, found });
    }
  });
  if (outcome === "changed") {
    showToast("This PDF changed while it was being remade — try again.", "error");
    return false;
  }
  if (outcome !== "ok") return false;
  showToast(lost
    ? `PDF remade — ${lost} mark${lost === 1 ? "" : "s"} could not be matched to the new text and stayed where they were`
    : `PDF remade — ${out.pageCount} page${out.pageCount === 1 ? "" : "s"}`);
  return true;
}
