// Handwritten Notes: a place you go, holding the real thing.
//
// ── What this panel actually contains ─────────────────────────────────────
//
// The Document surface. Not a copy of it, not something that looks like it —
// the same #documentStage, moved in here while the panel is open and moved back
// when it closes.
//
// That is the whole design, and it is worth being plain about why. Writing on a
// paper already worked: pdf.js lays the pages out, src/documents/pdf-ink.js
// stores strokes in the document's own user space so they survive a zoom, a
// rotate, a reload and a second device, and the pager, dark page, the annotated
// export, the device store and the backup all follow from that. A notebook is a
// paper whose words have not been written yet — so it gets a generated blank
// PDF (src/documents/notebook.js) and everything above is simply true of it.
//
// Building a second surface here instead would have meant a second pdf.js render
// loop, a second IntersectionObserver, a second zoom, a second coordinate
// system, and a second set of every bug all of those have already had.
//
// MOVED, never cloned — the same rule and for the same reason as
// liftNotesControlsIntoRow in src/notes/notes-head-overflow.js: every listener
// on that stage is bound to the real node, and a clone would have none of them
// while looking identical. The home it came from is recorded at the moment it is
// taken, so it always goes back to the same place even if the layout changes.

import { addNotebookPage, deleteNotebookPage, ensureNotebookDocument, isNotebookDeck, notebookPageCount, notebookPaper, setNotebookPaper } from "../documents/notebook.js?v=__BUILD__";
import { BLANK_PAPERS } from "../documents/blank-pdf.js?v=__BUILD__";
import { addDocumentBlock, commitBlockEdit, documentBlocks } from "../documents/pdf-blocks.js?v=__BUILD__";
import { currentDocumentPage, openDocumentView, pdfPageViewport, relayoutDocument } from "../documents/pdf-view.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let boardOpen = false;
let stageHome = null;
let wired = false;

export function isHandwritingBoardOpen() {
  return boardOpen;
}

// ── The panel's own chrome ─────────────────────────────────────────────────

function paintSummary() {
  if (!el.hwSummary) return;
  const pages = notebookPageCount();
  const blocks = documentBlocks().length;
  el.hwSummary.textContent = pages
    ? `${pages} page${pages === 1 ? "" : "s"}${blocks ? ` · ${blocks} text block${blocks === 1 ? "" : "s"}` : ""}`
    : "No pages yet";
  if (el.hwTitle) el.hwTitle.textContent = state.deckTitle || "Handwritten notes";
  const paper = notebookPaper();
  el.hwBoard?.querySelectorAll("[data-hw-paper-kind]").forEach((node) => {
    node.setAttribute("aria-pressed", node.dataset.hwPaperKind === paper ? "true" : "false");
    // A deck whose paper is somebody else's PDF has no paper of its own to set.
    node.toggleAttribute("disabled", !isNotebookDeck());
  });
  el.hwBoard?.querySelectorAll('[data-hw-action="add-page"], [data-hw-action="delete-page"]').forEach((node) => {
    node.toggleAttribute("disabled", !isNotebookDeck());
  });
}

export function refreshHandwritingBoard() {
  if (boardOpen) paintSummary();
}

// ── Opening and closing ────────────────────────────────────────────────────

function takeStage() {
  const stage = el.documentStage;
  if (!stage || !el.hwStage) return false;
  if (!stageHome) stageHome = { parent: stage.parentNode, next: stage.nextSibling };
  el.hwStage.appendChild(stage);
  stage.hidden = false;
  document.body.classList.add("is-handwriting");
  return true;
}

function giveStageBack() {
  const stage = el.documentStage;
  document.body.classList.remove("is-handwriting");
  if (!stage || !stageHome) return;
  // Back exactly where it was, by the sibling it was in front of — an append to
  // the recorded parent would put it last, and it is not last.
  stageHome.parent.insertBefore(stage, stageHome.next);
  // setViewMode owns whether it is visible out there; it is not visible unless
  // the reader is on the Document tab, and they are not, because they were here.
  stage.hidden = state.viewMode !== "document";
}

export function closeHandwritingBoard() {
  if (!boardOpen) return false;
  commitBlockEdit();
  boardOpen = false;
  giveStageBack();
  if (el.hwBoard) el.hwBoard.hidden = true;
  unlockPageScroll();
  return true;
}

function wire() {
  if (wired || !el.hwBoard) return;
  wired = true;
  el.hwBoard.addEventListener("click", (event) => {
    const kind = event.target.closest("[data-hw-paper-kind]")?.dataset.hwPaperKind;
    if (kind && BLANK_PAPERS.includes(kind)) {
      setNotebookPaper(kind).then(() => paintSummary());
      return;
    }
    const action = event.target.closest("[data-hw-action]")?.dataset.hwAction;
    if (!action) return;
    if (action === "close") closeHandwritingBoard();
    else if (action === "add-page") addPage();
    else if (action === "delete-page") tearOutPage();
    else if (action === "add-block") addBlock();
  });
}

async function addPage() {
  if (!(await addNotebookPage())) return;
  paintSummary();
  // Scrolled to, because a page added off the bottom of a scroller that nothing
  // moved is a press that appears to have done nothing.
  const last = notebookPageCount();
  setTimeout(() => {
    import("../documents/pdf-view.js?v=__BUILD__").then((mod) => mod.scrollToDocumentPage(last, 0, { smooth: true }));
  }, 60);
}

function tearOutPage() {
  const page = currentDocumentPage();
  const total = notebookPageCount();
  if (total < 2) { showToast("A notebook keeps at least one page", "info"); return; }
  showConfirmModal(
    `Tear out page ${page}? Everything written on it goes with it.`,
    () => { deleteNotebookPage(page).then(() => paintSummary()); },
    { confirmLabel: "Tear it out", danger: true }
  );
}

function addBlock() {
  const page = currentDocumentPage();
  const viewport = pdfPageViewport(page);
  if (!viewport) return;
  // The middle of what the reader is looking at, in the page's own points —
  // converted from the scroller's centre rather than assumed, so a block lands
  // where they are rather than in the middle of a page they have scrolled past.
  const view = el.documentView?.getBoundingClientRect();
  const pageEl = document.querySelector(`.pdf-page[data-page-number="${page}"]`);
  const box = pageEl?.getBoundingClientRect();
  let at = null;
  if (view && box) {
    const cx = Math.min(Math.max(view.left + (view.width / 2), box.left), box.right) - box.left;
    const cy = Math.min(Math.max(view.top + (view.height / 2), box.top), box.bottom) - box.top;
    const [x, y] = viewport.convertToPdfPoint(cx, cy);
    at = { x, y };
  }
  addDocumentBlock(page, at);
  paintSummary();
}

export async function openHandwritingBoard() {
  if (!el.hwBoard || !el.hwStage) return false;
  if (!hasActiveDeck()) {
    showToast("Open or create a deck first — its handwritten pages live with it", "info");
    return false;
  }
  wire();
  // The paper first. A deck with no document of its own gets one page of
  // generated blank paper; a deck that already has somebody else's PDF keeps it
  // and is simply written on, which is the same feature seen from the other end.
  const paperState = await ensureNotebookDocument();
  if (!paperState) {
    if (!state.meta?.pdf) return false;
  }
  boardOpen = true;
  el.hwBoard.hidden = false;
  if (!takeStage()) { boardOpen = false; el.hwBoard.hidden = true; return false; }
  lockPageScroll();
  // Forced only when ensureNotebookDocument says the bytes are new — see the
  // comment on it. An unforced open is right in every other case and is what
  // keeps switching to this panel and back from re-rendering the whole document.
  await openDocumentView({ force: paperState === "wrote" });
  // Laid out against the panel's width rather than the width the stage had
  // wherever it came from — which is a different box, and often a much narrower
  // one.
  relayoutDocument({ refit: true });
  paintSummary();
  return true;
}
