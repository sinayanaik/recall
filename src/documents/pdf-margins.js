// ⋯ → Page margins…: room to write beside a PDF's pages.
//
// The bytes are worked out in pdf-margins-core.js (pure, checked in Node by
// tools/pdf-margins-check.mjs). This is the rest: the dialog, and writing the
// new file over the PDF the deck names — the same sequence writeNotebookPdf
// (src/documents/notebook.js) uses for a notebook, which is the other document
// in this app whose bytes change.
//
// Nothing written on the PDF is touched. Highlights, strokes, shapes and typed
// boxes are all stored in the page's user space, and the margin grows the page
// outward from where it was, so each of them is drawn where it always was —
// and the pen, the Text tool and the typed boxes work in the new space with no
// code of their own, because to them it is simply more page.
//
// What the record keeps (on the deck's meta.pdfs entry, through withDeckPdfs):
//   margins     { top, right, bottom, left, paper } in points, as the reader
//               sees the page — what the dialog opens on
//   baseSha256  the hash of the file as it was attached, kept the first time,
//               so re-attaching that original file is still accepted
//               (reattachDocument) and gets the margins put back on it

import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import {
  MARGIN_MAX_MM,
  MARGIN_PAPER_DEFAULT,
  MarginsError,
  PT_PER_MM,
  applyPdfMargins,
  hasMargins,
  normalizeMargins
} from "./pdf-margins-core.js?v=__BUILD__";
import { activePdfId, deckPdfById, pdfStoreKey, recordsForSurface } from "./pdf-multi.js?v=__BUILD__";
import { replacePdfBytes } from "./pdf-replace.js?v=__BUILD__";
import { getDocument } from "./pdf-store.js?v=__BUILD__";
import { openDocumentPdfId } from "./pdf-view.js?v=__BUILD__";
import { ensurePdfLib } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

// The presets, in mm as the reader sees the page. "Wide right" is the
// Cornell-ish notes column; "Both sides" suits a two-page spread or a reader
// who writes on whichever side is free.
export const MARGIN_PRESETS = [
  { id: "none", label: "None", mm: { top: 0, right: 0, bottom: 0, left: 0 } },
  { id: "right", label: "Wide right", mm: { top: 0, right: 60, bottom: 0, left: 0 } },
  { id: "sides", label: "Both sides", mm: { top: 0, right: 35, bottom: 0, left: 35 } },
  { id: "all", label: "All round", mm: { top: 25, right: 25, bottom: 25, left: 25 } }
];

const DIALOG_SIDES = ["top", "right", "bottom", "left"];
const SIDE_LABELS = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" };
const PAPER_LABELS = { blank: "Blank", ruled: "Ruled", grid: "Grid" };

const toMm = (pt) => Math.round((Number(pt) || 0) / PT_PER_MM);
const toPt = (mm) => (Number(mm) || 0) * PT_PER_MM;

function currentPdfId() {
  return openDocumentPdfId() || activePdfId(state.meta);
}

// The margins the open PDF has now, in points — from its record, which every
// write below keeps in step with the bytes.
export function currentPdfMargins(pdfId = currentPdfId()) {
  const entry = deckPdfById(state.meta, pdfId);
  return entry?.margins ? normalizeMargins(entry.margins) : null;
}

// How many of this PDF's marks and typed boxes would run past the edge of their
// page with these boxes — what narrower margins do to writing that was in the
// margin they take away. Nothing is deleted: the records stay, and wider
// margins bring them back into view.
export function marksOffPage(pdfId, boxes) {
  const outside = (page, rect) => {
    const box = boxes[Number(page) - 1];
    if (!box || !Array.isArray(rect) || rect.length !== 4) return false;
    const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    // A point of slack: a stroke drawn to the very edge is not "past" it.
    return x0 < box[0] - 1 || y0 < box[1] - 1 || x1 > box[2] + 1 || y1 > box[3] + 1;
  };
  const marks = recordsForSurface(state.meta?.pdfHighlights, DOC_SLOT_DOC, pdfId)
    .filter((record) => !record?.imported)
    .filter((record) => outside(record.page || record.quads?.[0]?.page, record.quads?.[0]?.rect));
  const blocks = recordsForSurface(state.meta?.pdfBlocks, DOC_SLOT_DOC, pdfId)
    .filter((block) => outside(block.page, [block.x, block.y, block.x + block.w, block.y + block.h]));
  return marks.length + blocks.length;
}

function confirmOffPage(count) {
  return new Promise((resolve) => {
    showConfirmModal(
      `${count} mark${count === 1 ? "" : "s"} or text box${count === 1 ? "" : "es"} would go past the edge of the page with these margins. Nothing is deleted, and they come back into view if you make the margins wider again. Change the margins anyway?`,
      () => resolve(true),
      { confirmLabel: "Change margins", onCancel: () => resolve(false) }
    );
  });
}

// Rewrite the open PDF with `spec` (points, sides as seen; a spec with every
// side 0 takes the margins off). Resolves true when the new pages are on screen.
//
// `source` is the file to start from instead of the stored copy — the reader's
// own copy of the ORIGINAL, re-attached (reattachDocument), which is put back
// with the margins this PDF has.
let marginsBusy = false;
export async function setCurrentPdfMargins(spec, pdfId = currentPdfId(), { source = null } = {}) {
  if (marginsBusy) return false;
  const entry = deckPdfById(state.meta, pdfId);
  if (!entry || !state.localDeckId) {
    showToast("Open a PDF first", "error");
    return false;
  }
  const wanted = normalizeMargins(spec);
  const had = entry.margins ? normalizeMargins(entry.margins) : null;
  if (!hasMargins(wanted) && !had && !source) {
    showToast("This PDF has no margins to take off");
    return false;
  }
  marginsBusy = true;
  try {
    const storeKey = pdfStoreKey(state.localDeckId, pdfId);
    const blob = source || await getDocument(storeKey, entry);
    if (!blob) {
      showToast("This device doesn't have a copy of the PDF to change.", "error");
      return false;
    }
    if (!(await ensurePdfLib())) {
      showToast(navigator.onLine === false
        ? "Changing the pages needs to be online once, to fetch the PDF writer."
        : "Could not load the PDF writer.", "error");
      return false;
    }
    if (!source) showToast(hasMargins(wanted) ? "Adding the margins…" : "Taking the margins off…", "info");
    let result;
    try {
      result = await applyPdfMargins(window.PDFLib, await blob.arrayBuffer(), wanted);
    } catch (error) {
      if (error instanceof MarginsError && error.code === "encrypted") {
        showToast("This PDF is protected, so its pages can't be changed.", "error");
      } else {
        console.warn("Could not change the PDF's margins", error);
        showToast("Could not change this PDF's pages.", "error");
      }
      return false;
    }
    const off = source ? 0 : marksOffPage(pdfId, result.boxes || []);
    if (off && !(await confirmOffPage(off))) return false;
    // replacePdfBytes checks the record as it is NOW: the question above can
    // sit open while the PDF is renamed, or synced from another device.
    const outcome = await replacePdfBytes(pdfId, entry, result.bytes, {
      patch: { margins: hasMargins(wanted) ? wanted : null }
    });
    if (outcome === "changed") {
      showToast("This PDF changed while the margins were being added — try again.", "error");
      return false;
    }
    if (outcome !== "ok") return false;
    if (source) showToast("PDF re-attached, with its margins");
    else showToast(hasMargins(wanted) ? "Margins added — write in them with the pen or add a text box" : "Margins taken off");
    return true;
  } finally {
    marginsBusy = false;
  }
}

// ── The dialog ─────────────────────────────────────────────────────────────

let dialog = null;

function presetFor(mm) {
  return MARGIN_PRESETS.find((preset) => DIALOG_SIDES.every((side) => preset.mm[side] === mm[side]))?.id || "custom";
}

function buildDialog() {
  const section = document.createElement("section");
  section.className = "confirm-modal pdf-margins-modal";
  section.id = "pdfMarginsModal";
  section.hidden = true;
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-modal", "true");
  section.setAttribute("aria-labelledby", "pdfMarginsTitle");
  const presets = MARGIN_PRESETS.map((preset) => (
    `<button type="button" class="pdf-margins-chip" data-margin-preset="${preset.id}" aria-pressed="false">${preset.label}</button>`
  )).join("");
  const sides = DIALOG_SIDES.map((side) => (
    `<label class="pdf-margins-side"><span>${SIDE_LABELS[side]}</span>`
    + `<input type="number" class="prompt-modal-input" data-margin-side="${side}" min="0" max="${MARGIN_MAX_MM}" step="1" inputmode="numeric">`
    + `<span class="pdf-margins-unit">mm</span></label>`
  )).join("");
  const papers = Object.keys(PAPER_LABELS).map((paper) => (
    `<button type="button" class="pdf-margins-chip" data-margin-paper="${paper}" aria-pressed="false">${PAPER_LABELS[paper]}</button>`
  )).join("");
  section.innerHTML = `
    <div class="confirm-modal-content pdf-margins-content">
      <h3 class="prompt-modal-title" id="pdfMarginsTitle">Page margins</h3>
      <p class="confirm-modal-message">Adds room beside every page of this PDF to write in. What you've already written stays where it is, and the margins are part of the PDF when you save or export it.</p>
      <div class="pdf-margins-row" role="group" aria-label="Margin size">${presets}</div>
      <div class="pdf-margins-sides">${sides}</div>
      <span class="frame-card-label">Paper in the margin</span>
      <div class="pdf-margins-row" role="group" aria-label="Paper in the margin">${papers}</div>
      <div class="sync-modal-actions">
        <button type="button" class="sync-modal-btn" data-margin-action="cancel">Cancel</button>
        <button type="button" class="sync-modal-btn is-primary" data-margin-action="apply">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(section);
  return section;
}

function readDialog() {
  const mm = {};
  for (const side of DIALOG_SIDES) {
    const input = dialog.querySelector(`[data-margin-side="${side}"]`);
    mm[side] = Math.max(0, Math.min(MARGIN_MAX_MM, Math.round(Number(input.value) || 0)));
  }
  const paper = dialog.querySelector("[data-margin-paper][aria-pressed=\"true\"]")?.dataset.marginPaper || MARGIN_PAPER_DEFAULT;
  return { mm, paper };
}

function paintDialog({ mm, paper }) {
  for (const side of DIALOG_SIDES) dialog.querySelector(`[data-margin-side="${side}"]`).value = String(mm[side]);
  const preset = presetFor(mm);
  dialog.querySelectorAll("[data-margin-preset]").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.marginPreset === preset));
  });
  dialog.querySelectorAll("[data-margin-paper]").forEach((chip) => {
    chip.setAttribute("aria-pressed", String(chip.dataset.marginPaper === paper));
  });
}

export function isPdfMarginsDialogOpen() {
  return Boolean(dialog && !dialog.hidden);
}

export function closePdfMarginsDialog() {
  if (!isPdfMarginsDialogOpen()) return;
  dialog.hidden = true;
  unlockPageScroll();
}

export function openPdfMarginsDialog() {
  const pdfId = currentPdfId();
  if (!deckPdfById(state.meta, pdfId)) {
    showToast("Open a PDF first", "error");
    return;
  }
  if (!dialog) {
    dialog = buildDialog();
    dialog.addEventListener("click", (event) => {
      const preset = event.target.closest("[data-margin-preset]");
      if (preset) {
        const chosen = MARGIN_PRESETS.find((item) => item.id === preset.dataset.marginPreset);
        if (chosen) paintDialog({ mm: { ...chosen.mm }, paper: readDialog().paper });
        return;
      }
      const paper = event.target.closest("[data-margin-paper]");
      if (paper) {
        paintDialog({ mm: readDialog().mm, paper: paper.dataset.marginPaper });
        return;
      }
      const action = event.target.closest("[data-margin-action]")?.dataset.marginAction;
      // A press on the dim backdrop is a cancel, as the other small dialogs do.
      if (action === "cancel" || event.target === dialog) {
        closePdfMarginsDialog();
        return;
      }
      if (action === "apply") {
        const { mm, paper } = readDialog();
        const target = dialog.dataset.pdfId || currentPdfId();
        closePdfMarginsDialog();
        setCurrentPdfMargins({ top: toPt(mm.top), right: toPt(mm.right), bottom: toPt(mm.bottom), left: toPt(mm.left), paper }, target);
      }
    });
    // Typing a number moves the preset mark to "custom" (none lit) or to the
    // preset it now matches.
    dialog.addEventListener("input", () => paintDialog(readDialog()));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePdfMarginsDialog();
      } else if (event.key === "Enter" && event.target.matches("input")) {
        event.preventDefault();
        dialog.querySelector("[data-margin-action=\"apply\"]").click();
      }
    });
  }
  const now = currentPdfMargins(pdfId);
  dialog.dataset.pdfId = pdfId;
  paintDialog(now
    ? { mm: { top: toMm(now.top), right: toMm(now.right), bottom: toMm(now.bottom), left: toMm(now.left) }, paper: now.paper }
    // A PDF with none opens on the preset most asked for.
    : { mm: { ...MARGIN_PRESETS[1].mm }, paper: MARGIN_PAPER_DEFAULT });
  dialog.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => dialog.querySelector("[data-margin-action=\"apply\"]")?.focus());
}

// For reattachDocument: the reader's own copy of the ORIGINAL file of a PDF
// that has had margins added, put back with those margins.
export function reattachOriginal(file, entry, pdfId) {
  return setCurrentPdfMargins(entry?.margins || {}, pdfId, { source: file });
}
