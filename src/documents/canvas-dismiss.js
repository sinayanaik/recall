// A press anywhere off the page puts down what is picked up on it.
//
// Every "press elsewhere" rule on a Canvas or a PDF lived on the page's own
// scroller: a Block was put down by a press on the paper (handleBlockPointerDown,
// src/documents/pdf-blocks.js), a shape by a press on the paper
// (src/documents/pdf-shapes.js), several things by a press on a page
// (src/documents/canvas-selection.js). A press anywhere else — the tab row, the
// top bar, Notes beside the Canvas, the gap round the pages — reached none of
// them, so a Block's ring, its connect arrows and its strip of actions, a
// connector's handles, the Arrange bar, stayed up "unless clicking some other
// block". One listener at the top of the document now puts them all down for a
// press that is not on the live paper and not on one of their own panels.
//
// It also puts them down when the part in focus changes (a tab, or the paper
// beside taking the focus): what was picked up belongs to the page that was in
// focus, and the controls drawn for it must not be left on a paper the keys no
// longer talk to.

import { commitBlockEdit, isEditingBlock, selectBlock, selectedBlockId } from "./pdf-blocks.js?v=__BUILD__";
import { selectShape, selectedShapeRecord } from "./pdf-shapes.js?v=__BUILD__";
import { clearPick, isMultiPicked } from "./canvas-selection.js?v=__BUILD__";
import { cancelConnectDrag } from "./pdf-connectors.js?v=__BUILD__";
import { documentScrollers, isLiveDocumentScroller } from "./doc-scrollers.js?v=__BUILD__";
import { closeBlockActionsPopover } from "./block-actions-popover.js?v=__BUILD__";

// Presses on these are presses ON what is picked up — its own strip, its style
// panel, the pen's rail that restyles it, the editor its words are in, a dialog
// or a menu opened from one of those — and must leave it picked up.
const OWN_PANELS = [
  ".pdf-block-actions-pop",
  ".pdf-block-style-pop",
  ".pdf-block-editor",
  ".pdf-block-inline",
  ".diagram-arrange-bar",
  ".shape-style-popover",
  ".pdf-connector-label-editor",
  ".pdf-shape-editor",
  ".document-ink-rail",
  ".ink-rail-popover",
  "dialog",
  "[role='dialog']",
  "[role='menu']",
  "[role='listbox']",
  // A choice asked over the page — "Upload image" above all, which a picture
  // pasted into a Block opens. Upload there is a press on the Block's own
  // picture; putting the Block down for it lost the picture.
  ".category-choice-modal",
  // The selection bar raised over words picked in a Block being typed in, and
  // what it opens: a press on B is a press on the Block's words.
  ".selection-float",
  ".mark-menu",
  ".note-link-picker",
  ".style-pop",
  ".paper-menu",
  ".pdf-context-menu",
  ".ink-sheet"
].join(", ");

function somethingUp() {
  return Boolean(selectedBlockId() || selectedShapeRecord() || isMultiPicked() || isEditingBlock()
    || document.querySelector(".pdf-block.is-selected, .pdf-connect-arrow, .pdf-block-turn"));
}

// The rings and arrows a paper that is not live still shows. The paint of each
// of them only reaches the live paper (repaintDocumentBlocks and the diagram
// overlay follow it), so the one left behind side by side is cleared here.
function clearLeftBehind() {
  documentScrollers().forEach((view) => {
    if (!view || isLiveDocumentScroller(view)) return;
    view.querySelectorAll(".pdf-block.is-selected").forEach((node) => node.classList.remove("is-selected"));
    view.querySelectorAll(".pdf-connect-arrow, .pdf-block-turn").forEach((node) => node.remove());
  });
}

// Everything picked up, put down: a Block being typed in is put down with its
// words kept (every way out of the editor keeps them), a connector being drawn
// is called off, and the Block, the shape and the pick are let go.
export function putCanvasThingsDown() {
  cancelConnectDrag();
  if (isEditingBlock()) commitBlockEdit();
  if (selectedBlockId()) selectBlock(null);
  else closeBlockActionsPopover();
  if (selectedShapeRecord()) selectShape(null);
  if (isMultiPicked()) clearPick();
  clearLeftBehind();
}

function onPressAnywhere(event) {
  if (event.button !== undefined && event.button > 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  // On the live paper, the page's own handlers decide (a press on another
  // Block picks that one up; one on bare paper puts this one down).
  if (documentScrollers().some((scroller) => isLiveDocumentScroller(scroller) && scroller.contains(target))) return;
  if (target.closest(OWN_PANELS)) return;
  if (!somethingUp()) return;
  putCanvasThingsDown();
}

let canvasDismissWired = false;

export function initCanvasDismiss() {
  if (canvasDismissWired) return;
  canvasDismissWired = true;
  // Capture, so a control that stops the press (a tab, a menu button) does not
  // hide it from this; passive, because it never cancels anything.
  document.addEventListener("pointerdown", onPressAnywhere, { capture: true, passive: true });
}
