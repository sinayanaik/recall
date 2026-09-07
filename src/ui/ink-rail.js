// The pen's rail: what colour, what nib, and which of the three tools.
//
// Deliberately NOT a mode switch for the pen. A stylus draws whether this is
// open or shut — that is the whole promise of the feature and the reason
// src/documents/pdf-ink.js has no armed state to forget. What the rail is for
// is the three things a pen cannot say by itself: which colour, how thick, and
// whether this stroke is meant to erase or to lasso. Plus one thing it can only
// say on a machine with no stylus at all, which is that a MOUSE drag is meant
// as ink; that is what setInkArmed carries.
//
// Built rather than written in index.html for the swatches and the nibs,
// because both come from the palette leaf and a second copy of that list in
// markup is a second place for it to be wrong. The tools, the undo pair and the
// selection actions are markup, because they are fixed.
//
// The building itself is in src/handwriting/rail.js now, shared with the drawing
// sheet and the notebook. It used to be here and a second, hand-copied version
// of the same loops in src/notes/ink-sheet.js, which then stripped classes back
// off its buttons so the two would look alike — and every change to the pen had
// to be made twice. What differs between the rails is what a press MEANS, since
// each acts on a different engine, and that is deliberately still local to each.
//
// One delegated listener over `data-ink-*`, which is the pattern
// src/editor/toolbar-actions.js and src/format/render-toolbar.js both already
// follow: a control is a button with an attribute, not a binding.

import { el } from "../core/dom.js?v=__BUILD__";
import { canRedoInk, canUndoInk, clearInkPage, copyInkSelection, cutInkSelection, deleteInkSelection, duplicateInkSelection, hasInkClipboard, inkEraseMode, inkEraserSize, inkPageHasStrokes, inkPageInView, inkPageInViewCheap, inkPen, inkSelectionCount, inkSnapShapes, inkTool, inkWidth, isInkArmed, joinInkSelection, pasteInkSelection, redoInk, setInkArmed, setInkEraseMode, setInkEraserSize, setInkPen, setInkSnapShapes, setInkTool, setInkWidth, splitInkSelection, undoInk } from "../documents/pdf-ink.js?v=__BUILD__";
import { buildInkEraserSizes, buildInkNibs, buildInkPenSwatches, paintInkRailPressed, readInkRailPress } from "../handwriting/rail.js?v=__BUILD__";
import { inkPreferences, inkRailOpen, writeInkPreferences, writeInkRailOpen } from "../storage/ink-prefs.js?v=__BUILD__";
import { activeDocSlot } from "../documents/doc-slot.js?v=__BUILD__";
import { showConfirmModal } from "./feedback.js?v=__BUILD__";

function pressed(node, on) {
  if (node) node.setAttribute("aria-pressed", on ? "true" : "false");
}

export function refreshInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  const open = isInkArmed();
  if (!open) {
    rail.hidden = true;
    pressed(el.documentInkBtn, open);
    return;
  }

  // ── Everything this needs to READ, read before anything is written ────────
  //
  // This function runs on every commit the engine makes — which is every pen
  // lift, several times a second while somebody is handwriting — and it used to
  // ask its last question after writing all of its answers. `rail.hidden`,
  // aria-pressed on the button, a class on every swatch and every nib, two more
  // hidden rows and two disabled toggles, and THEN
  // `inkPageHasStrokes(inkPageInView())`. The writes invalidate style and layout;
  // the read forces the browser to flush them there and then, and the thing it
  // was reaching for was a scan of every page box in the document.
  //
  // So the reads come first and there is no layout read left among them.
  // inkPageInViewCheap answers out of a memo or says it does not know, and never
  // measures; if it does not know, the Clear button is left as it is rather than
  // a whole document being measured to grey out one control. The rail is
  // repainted on the very next stroke, and askToClearPage asks the authoritative
  // question before it clears anything.
  const page = inkPageInViewCheap();
  const hasStrokes = page ? inkPageHasStrokes(page) : null;
  const undoable = canUndoInk();
  const redoable = canRedoInk();
  const count = inkSelectionCount();
  const pasteable = hasInkClipboard();
  const tool = inkTool();

  rail.hidden = false;
  pressed(el.documentInkBtn, open);
  paintInkRailPressed(rail, {
    pen: inkPen(),
    width: inkWidth(),
    tool,
    eraserSize: inkEraserSize(),
    eraseMode: inkEraseMode(),
    snapShapes: inkSnapShapes()
  });
  // The eraser's row takes the place of the pen's, rather than sitting beside
  // it: they answer the same question about whichever tool is armed, and the
  // rail is already a wrapping panel over the page with no room to carry both.
  // The COLOURS stay up whatever is armed, because with a lasso selection a
  // press on one recolours what is selected — and because a reader who is about
  // to swap back to the pen should be able to choose the colour first.
  const erasing = tool === "eraser";
  if (el.inkRailWidths) el.inkRailWidths.hidden = erasing;
  if (el.inkRailEraser) el.inkRailEraser.hidden = !erasing;
  rail.querySelector('[data-ink-action="undo"]')?.toggleAttribute("disabled", !undoable);
  rail.querySelector('[data-ink-action="redo"]')?.toggleAttribute("disabled", !redoable);
  // Refused rather than hidden, for the reason join is below: a control that
  // comes and goes moves the ones beside it under the reader's thumb. Left
  // exactly as it is when the page in view is not already known — see above.
  if (hasStrokes !== null) {
    rail.querySelector('[data-ink-action="clear"]')?.toggleAttribute("disabled", !hasStrokes);
  }

  // Up while there is a selection OR something to paste. Paste is the one
  // control in this group that is FOR the moment nothing is selected: copying on
  // page 1 and pasting on page 4 is the case it exists for, and a group that
  // vanished with the selection would take the only way of finishing that with it.
  if (el.inkRailSelection) el.inkRailSelection.hidden = count < 1 && !pasteable;
  // Each one refused rather than hidden, so the row does not change width under
  // the reader's thumb between one selection and the next. Join needs two
  // strokes to join; the rest need one; paste needs only a clipboard.
  rail.querySelector('[data-ink-action="join"]')?.toggleAttribute("disabled", count < 2);
  ["split", "duplicate", "copy", "cut", "delete"].forEach((action) => {
    rail.querySelector(`[data-ink-action="${action}"]`)?.toggleAttribute("disabled", count < 1);
  });
  rail.querySelector('[data-ink-action="paste"]')?.toggleAttribute("disabled", !pasteable);
}

// The one control here that a stroke cannot put right, so it is the one that
// asks — and it names the page, because the rail floats over a scroller and
// "the page" is whichever one the reader has scrolled to.
function askToClearPage() {
  const page = inkPageInView();
  if (!inkPageHasStrokes(page)) return;
  showConfirmModal(
    `Remove every mark from page ${page}? Undo can put them back.`,
    () => { clearInkPage(page); refreshInkRail(); },
    { confirmLabel: "Clear the page", danger: true }
  );
}

export function toggleInkRail(force = null) {
  setInkArmed(force === null ? !isInkArmed() : Boolean(force));
  // Remembered per surface. A reader who shuts the rail on a notebook has said
  // something, and re-opening it on their next visit would be worse than never
  // having opened it — see RAIL_OPEN_DEFAULT for why the two surfaces start in
  // different places.
  writeInkRailOpen(activeDocSlot(), isInkArmed());
  refreshInkRail();
}

// The rail as this surface last left it, or as this surface starts. Called when
// a document is opened; `setInkArmed` is also what lets a MOUSE draw, so on a
// notebook this is not only about which panel is visible.
export function applyInkRailPreference() {
  setInkArmed(inkRailOpen(activeDocSlot()));
  refreshInkRail();
}

export function initInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  buildInkPenSwatches(el.inkRailPens);
  buildInkNibs(el.inkRailWidths);
  buildInkEraserSizes(el.inkRailEraser);

  // The pen, the nib and the tool are remembered per device rather than per
  // deck: which colour you write in is a fact about you, not about the paper.
  const saved = inkPreferences();
  setInkPen(saved.pen);
  setInkWidth(saved.width);
  setInkTool(saved.tool);
  setInkEraserSize(saved.eraserSize);
  setInkEraseMode(saved.eraseMode);
  setInkSnapShapes(saved.snapShapes);

  el.documentInkBtn?.addEventListener("click", () => toggleInkRail());

  // pointerdown, not click, and preventDefault with it: a press on the rail
  // must not travel on to the page underneath and start a stroke, and on a
  // stylus the two are a few pixels apart.
  rail.addEventListener("pointerdown", (event) => {
    const button = readInkRailPress(event);
    if (!button) return;
    const {
      inkPen: nextPen, inkWidth: nextWidth, inkEraserSize: nextEraser, inkTool: nextTool, inkAction: action
    } = button.dataset;
    if (nextPen) setInkPen(nextPen);
    else if (nextWidth) setInkWidth(Number(nextWidth));
    else if (nextEraser) setInkEraserSize(Number(nextEraser));
    else if (nextTool) setInkTool(nextTool);
    else if (action === "undo") undoInk();
    else if (action === "redo") redoInk();
    else if (action === "clear") askToClearPage();
    else if (action === "join") joinInkSelection();
    else if (action === "split") splitInkSelection();
    else if (action === "duplicate") duplicateInkSelection();
    else if (action === "copy") copyInkSelection();
    else if (action === "cut") cutInkSelection();
    else if (action === "paste") pasteInkSelection();
    else if (action === "delete") deleteInkSelection();
    // The two switches. Read back off the engine rather than toggled from the
    // button's own aria-pressed, so the rail cannot come to disagree with the
    // thing it is describing.
    else if (action === "erase-mode") setInkEraseMode(inkEraseMode() === "part" ? "stroke" : "part");
    else if (action === "snap") setInkSnapShapes(!inkSnapShapes());
    if (nextPen || nextWidth || nextTool || nextEraser || action === "erase-mode" || action === "snap") {
      writeInkPreferences({
        pen: inkPen(),
        width: inkWidth(),
        tool: inkTool(),
        eraserSize: inkEraserSize(),
        eraseMode: inkEraseMode(),
        snapShapes: inkSnapShapes()
      });
    }
    refreshInkRail();
  });

  refreshInkRail();
}
