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
// ── ...and why its controls are not in the tab row either ──────────────────
//
// They were, briefly, lifted into #viewModeRow beside the document's own. That
// row is a nowrap flex line capped at 560px: a fourth tab plus ☰, ⇓, ◐, ✎, ⋯, a
// three-button paper picker and four actions came to about 360px of a 390px
// phone, and the tab labels were clipped mid-word to "CAR NOT DOCU WRI". The row
// has a budget and adding to it does not create more of it.
//
// So they went where the Document surface already puts what acts on the page:
//
//   • + Text, + Image and + Page are a group in the pen's rail, which floats
//     over the page, wraps on a phone and dims while the nib is down;
//   • the paper and the tear-out are rows of ⋯, because a thing you do once a
//     session does not need to be on screen for the whole of it.
//
// Neither needed lifting — both are already inside #documentStage. What is left
// in this file is what a press MEANS.

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
  // The class the notebook's CSS is shown from lives with the TAB, and the tab
  // is repainted by updateMeta — which nothing on the way to making a notebook
  // calls. Without this the controls stay stood down over the notebook that was
  // just made, until some unrelated deck change happened to repaint the header.
  refreshHandwritingTab();
  const ready = hasNotebook();
  const paper = notebookPaper();

  // The rail's page group.
  el.documentInkRail?.querySelectorAll("[data-hw-action]").forEach((node) => {
    node.toggleAttribute("disabled", !ready);
  });
  // A <label> carries no `disabled`, so the picker inside it is what is turned
  // off — and the class is what CSS greys, matching the buttons beside it.
  el.handwritingImageBtn?.classList.toggle("is-disabled", !ready);
  if (el.handwritingImageInput) el.handwritingImageInput.disabled = !ready;

  // The ⋯ menu's notebook rows. The paper rows are a choice, so they carry the
  // same switch the page-notes row does and one of them is always on — a picker
  // that shows nothing selected is a picker that does not say what the paper is.
  el.documentMoreMenu?.querySelectorAll('[data-document-action^="hw-paper-"]').forEach((node) => {
    const kind = node.dataset.documentAction.slice("hw-paper-".length);
    // aria-pressed is what draws the switch — styles/37-document-chrome.css:344
    // already lights it for any .md-menu-item in this menu, so these rows say
    // which paper is on with the same control the page-notes row uses.
    node.setAttribute("aria-pressed", ready && kind === paper ? "true" : "false");
    node.toggleAttribute("disabled", !ready);
  });
  const tearOut = el.documentMoreMenu?.querySelector('[data-document-action="hw-tear-out"]');
  // Refused rather than hidden on a one-page notebook, for the reason the rail
  // refuses join rather than hiding it: a row that comes and goes moves the ones
  // beside it under the reader's thumb.
  tearOut?.toggleAttribute("disabled", !ready || notebookPageCount() < 2);
  tearOut?.setAttribute(
    "title",
    ready && notebookPageCount() > 1
      ? `Tear out page ${currentDocumentPage() || 1} — everything written on it goes with it`
      : "A notebook keeps at least one page"
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

// What the ⋯ menu's notebook rows do. Called from the one delegated
// [data-document-action] handler in src/main.js, which is where every other row
// of that menu is already dispatched — a second listener on the same menu is a
// second place for the close-the-menu rules to be got wrong.
export function runHandwritingMenuAction(action) {
  if (action === "hw-tear-out") { tearOutPage(); return true; }
  if (action.startsWith("hw-paper-")) {
    const kind = action.slice("hw-paper-".length);
    if (!BLANK_PAPERS.includes(kind)) return false;
    setNotebookPaper(kind).then(() => paintHandwritingControls());
    return true;
  }
  return false;
}

function wire() {
  if (wired) return;
  wired = true;
  // Delegated on the pen's rail, which is where the page group lives now.
  // pointerdown rather than click, and preventDefault with it, for the reason
  // src/ui/ink-rail.js gives for the controls beside these: a press on the rail
  // must not travel on to the page underneath and start a stroke, and on a
  // stylus the two are a few pixels apart.
  el.documentInkRail?.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-hw-action]");
    if (!button || button.hasAttribute("disabled")) return;
    event.preventDefault();
    const action = button.dataset.hwAction;
    if (action === "add-page") addPage();
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
