// The Write tab: the controls that only mean something on a notebook.
//
// ── What this file used to be, and why it is not that any more ─────────────
//
// A full-surface overlay, opened from the ☰ drawer, which MOVED #documentStage
// into itself to have anything to show and moved it back on close. The move was
// the honest half of the idea: writing on a paper already worked, so a notebook
// should be the Document surface with paper this app generated, rather than a
// second render loop, a second IntersectionObserver, a second zoom and a second
// coordinate system with every bug the first one has already had.
//
// The overlay around it was the mistake, and it cost three separate things:
//
//   • it lived in the app menu, which is where what is true of the APP goes.
//     Handwriting is true of the DECK in front of you, and this app's own rule
//     for that is that it belongs in that view's own chrome. So it is a tab now,
//     beside Cards, Notes and Document, on every open deck;
//   • `position: fixed; z-index: 600`, with the stage re-parented into it on
//     every open. The pen's wet and tip canvases are `desynchronized` — they ask
//     to be taken out of the normal compositing path, which is what makes the
//     line keep up with the nib — and a low-latency canvas re-parented into a
//     fixed stacking context is exactly the flicker this feature was reported
//     for, on a surface that is otherwise the same code as the PDF one nobody
//     reported anything about;
//   • it forced `relayoutDocument({ refit: true })` on every open, because the
//     stage really had arrived in a box of a different width. Nothing moves now,
//     so nothing has to be re-laid-out.
//
// What is left is the chrome: the paper, + Text, + Image, + Page and the tear-out.
// Those are lifted into #viewModeRow at boot beside the document's own controls
// (liftNotesControlsIntoRow), so a notebook and a paper have the same one row in
// the same shape, and CSS stands each set down on the views where it means
// nothing.

import { addNotebookPage, deleteNotebookPage, ensureNotebookDocument, hasNotebook, notebookPageCount, notebookPaper, setNotebookPaper } from "../documents/notebook.js?v=__BUILD__";
import { BLANK_PAPERS } from "../documents/blank-pdf.js?v=__BUILD__";
import { addDocumentBlock, addDocumentImageBlock } from "../documents/pdf-blocks.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, deckHasHandwrittenPages } from "../documents/doc-slot.js?v=__BUILD__";
import { currentDocumentPage, openDocumentView, pdfPageViewport, scrollToDocumentPage } from "../documents/pdf-view.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hasActiveDeck, refreshHandwritingTab } from "../cards/card-status.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

let wired = false;

export function isHandwritingView() {
  return state.viewMode === "handwriting";
}

// ── The controls ───────────────────────────────────────────────────────────

// Which paper is lit, and what can be pressed. A deck whose Write tab is still
// showing the offer of a notebook has no pages to add to, tear out or re-rule,
// so those stand down rather than sitting there inert.
export function paintHandwritingControls() {
  // The class this row's CSS is shown from lives with the TAB, and the tab is
  // repainted by updateMeta — which nothing on the way to making a notebook
  // calls. Without this the controls stay stood down over the notebook that was
  // just made, until some unrelated deck change happened to repaint the header.
  refreshHandwritingTab();
  const ready = hasNotebook();
  const paper = notebookPaper();
  el.handwritingPaperGroup?.querySelectorAll("[data-hw-paper-kind]").forEach((node) => {
    node.setAttribute("aria-pressed", node.dataset.hwPaperKind === paper ? "true" : "false");
    node.toggleAttribute("disabled", !ready);
  });
  [el.handwritingTextBtn, el.handwritingPageBtn, el.handwritingTearBtn].forEach((node) => {
    node?.toggleAttribute("disabled", !ready);
  });
  // A <label> carries no `disabled`, so the picker inside it is what is turned
  // off — and the class is what CSS greys, matching the buttons beside it.
  el.handwritingImageBtn?.classList.toggle("is-disabled", !ready);
  if (el.handwritingImageInput) el.handwritingImageInput.disabled = !ready;
  el.handwritingTearBtn?.setAttribute(
    "title",
    ready && notebookPageCount() > 1
      ? `Tear out page ${currentDocumentPage() || 1} — everything written on it goes with it`
      : "Tear out the page you are looking at"
  );
}

// Called whenever the blocks change, so the count behind the controls is never
// a frame stale. A no-op off the Write tab, which is where it usually is.
export function refreshHandwritingBoard() {
  if (isHandwritingView()) paintHandwritingControls();
}

// ── Opening ────────────────────────────────────────────────────────────────

// The Write tab's own paint step, called from setViewMode by way of main.js.
//
// The paper first, and only when there is none: ensureNotebookDocument moves a
// deck that still keeps its notebook in the document slot, remakes the bytes on
// a device that pulled the deck but not the file, and otherwise says "kept" and
// does nothing at all. The reopen is FORCED only when it says the bytes are new
// — everything else is left to openDocumentView's own idempotence, which is what
// makes switching into this tab and back cost nothing.
export async function enterHandwritingView({ create = false } = {}) {
  if (!hasActiveDeck()) return false;
  wire();
  // deckHasHandwrittenPages, not hasNotebook: a deck whose pages are still in the
  // document slot, or still in the model before that, HAS a notebook — it just
  // has not been moved yet. Asking it to "start" one would make a second and
  // orphan what is already written. ensureNotebookDocument does the moving.
  if (!deckHasHandwrittenPages() && !create) {
    // No pages anywhere and nobody has asked for any: the surface shows the
    // offer (renderStartNotebookPrompt) and this is not the moment to make a file.
    await openDocumentView({ slot: DOC_SLOT_NOTEBOOK });
    paintHandwritingControls();
    return true;
  }
  const paperState = await ensureNotebookDocument();
  // It said no — the device store refused the save, and it has already said so.
  // The surface still has to show something honest: the offer, not whatever
  // document happened to be on the stage before this tab was pressed.
  await openDocumentView({ force: paperState === "wrote", slot: DOC_SLOT_NOTEBOOK });
  paintHandwritingControls();
  return Boolean(paperState);
}

// The "Start a notebook" press on the empty surface. Registered with pdf-view
// through setNotebookStartHandler, which is why it takes no arguments and why
// pdf-view does not import this module: it is the one that gets imported.
export function startHandwritingNotebook() {
  return enterHandwritingView({ create: true });
}

function wire() {
  if (wired) return;
  wired = true;
  // Delegated on the row the controls were lifted INTO, not on the head they
  // were authored in — that head is empty by the time anybody presses anything.
  const row = document.getElementById("viewModeRow");
  row?.addEventListener("click", (event) => {
    const kind = event.target.closest("[data-hw-paper-kind]")?.dataset.hwPaperKind;
    if (kind && BLANK_PAPERS.includes(kind)) {
      setNotebookPaper(kind).then(() => paintHandwritingControls());
      return;
    }
    const action = event.target.closest("[data-hw-action]")?.dataset.hwAction;
    if (!action) return;
    if (action === "add-page") addPage();
    else if (action === "delete-page") tearOutPage();
    else if (action === "add-block") addBlock();
  });
}

async function addPage() {
  if (!(await addNotebookPage())) return;
  paintHandwritingControls();
  // Scrolled to, because a page added off the bottom of a scroller that nothing
  // moved is a press that appears to have done nothing.
  const last = notebookPageCount();
  setTimeout(() => scrollToDocumentPage(last, 0, { smooth: true }), 60);
}

function tearOutPage() {
  const page = currentDocumentPage();
  const total = notebookPageCount();
  if (total < 2) { showToast("A notebook keeps at least one page", "info"); return; }
  showConfirmModal(
    `Tear out page ${page}? Everything written on it goes with it.`,
    () => { deleteNotebookPage(page).then(() => paintHandwritingControls()); },
    { confirmLabel: "Tear it out", danger: true }
  );
}

// The middle of what the reader is looking at, in the page's own points —
// converted from the scroller's centre rather than assumed, so a block lands
// where they are rather than in the middle of a page they have scrolled past.
export function handwritingDropPoint(page) {
  const viewport = pdfPageViewport(page);
  if (!viewport) return null;
  const view = el.documentView?.getBoundingClientRect();
  const pageEl = document.querySelector(`.pdf-page[data-page-number="${page}"]`);
  const box = pageEl?.getBoundingClientRect();
  if (!view || !box) return null;
  const cx = Math.min(Math.max(view.left + (view.width / 2), box.left), box.right) - box.left;
  const cy = Math.min(Math.max(view.top + (view.height / 2), box.top), box.bottom) - box.top;
  const [x, y] = viewport.convertToPdfPoint(cx, cy);
  return { x, y };
}

function addBlock() {
  const page = currentDocumentPage();
  if (!pdfPageViewport(page)) return;
  addDocumentBlock(page, handwritingDropPoint(page));
  paintHandwritingControls();
}

// The + 📷 picker, and the paste/drop path in src/main.js, both land here.
export async function addHandwritingImage(file) {
  const page = currentDocumentPage();
  if (!pdfPageViewport(page)) return false;
  const added = await addDocumentImageBlock(page, file, handwritingDropPoint(page));
  if (added) paintHandwritingControls();
  return added;
}
