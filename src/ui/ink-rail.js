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
import { canRedoInk, canUndoInk, clearInkPage, copyInkSelection, cutInkSelection, deleteInkSelection, duplicateInkSelection, hasInkClipboard, inkEraseMode, inkEraseTarget, inkEraserSize, inkHighlighter, inkPageHasStrokes, inkPageInView, inkPageInViewCheap, inkPaper, inkPaperBg, inkPen, inkPenOpacity, inkPreviewScale, inkSelectionCount, inkSelectionKinds, inkSnapShapes, inkTapDots, inkTool, inkWidth, isInkArmed, joinInkSelection, pasteInkSelection, redoInk, setInkArmed, setInkEraseMode, setInkEraseTarget, setInkEraserSize, setInkHighlighter, setInkOpacity, setInkPen, setInkSnapShapes, setInkTapDots, setInkTool, setInkWidth, splitInkSelection, suppressInkTap, undoInk } from "../documents/pdf-ink.js?v=__BUILD__";
import { deleteBlock, editBlock, openSelectedBlockStyle, selectedBlockKind, setBlockSelectionChangedHandler } from "../documents/pdf-blocks.js?v=__BUILD__";
import { INK_TOOL_DEFAULT } from "../format/ink-colors.js?v=__BUILD__";
import { bindInkRailActivation, paintInkRailPressed } from "../handwriting/rail.js?v=__BUILD__";
import { buildInkPanel, createInkPanel, paintInkChip } from "../handwriting/ink-popover.js?v=__BUILD__";
import { inkPreferences, inkRailOpen, rememberInkRecentColor, writeInkPreferences, writeInkRailOpen } from "../storage/ink-prefs.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "../documents/doc-slot.js?v=__BUILD__";
import { isRegionSelectArmed, setRegionSelect } from "../documents/pdf-region.js?v=__BUILD__";
import { displayedShapeSettings, setShapeChangedHandler, setShapeType, shapeButtonType, shapeType } from "../documents/pdf-shapes.js?v=__BUILD__";
import { buildShapeMenu, buildShapePanel, refreshShapeMenu, refreshShapePanel } from "../documents/pdf-shape-panel.js?v=__BUILD__";
import { syncShapeStylePopover } from "../documents/pdf-shape-style-popover.js?v=__BUILD__";
import { showConfirmModal } from "./feedback.js?v=__BUILD__";

function pressed(node, on) {
  if (node) node.setAttribute("aria-pressed", on ? "true" : "false");
}

// The panel under the chip (src/handwriting/ink-popover.js), made in
// initInkRail. Null until then, and on a page with no rail.
let inkPanel = null;

// ── The bar's three menus ──────────────────────────────────────────────────
//
// ⋯, the selection's ▾ and the notebook's +. Small, and the same three rules
// each: one open at a time, any press outside shuts it, and choosing a row
// shuts it — on CLICK, not on the press, because one of the rows is a <label>
// round a file input and a label hidden under the press never fires its click.
const MENUS = [
  { button: "inkRailShapeBtn", menu: "inkRailShapeMenu" },
  { button: "inkRailMoreBtn", menu: "inkRailMoreMenu" },
  { button: "inkRailSelectionMoreBtn", menu: "inkRailSelectionMenu" },
  { button: "inkRailAddBtn", menu: "inkRailAddMenu" }
];

// ── ↶ and ↷ mean what Ctrl+Z and Ctrl+Y mean ────────────────────────────────
//
// The bar's pair called the pen's ring and nothing else, so a block moved, a
// box shaped or a connector drawn between two boxes could be taken back from
// the keyboard and not from the bar — on a tablet, not at all. src/main.js owns
// the order the surface's two rings are taken back in (lastDocumentEdit) and
// hands the same four functions here.
let documentUndo = null;

// The Select tool's two names — see paintInkRail. The PDF's is the markup's
// own, read once.
const CANVAS_SELECT_TITLE = "Select — press a block or a shape to pick it up and move it, drag on bare paper to draw a box round several, Shift-click to add one";
let PDF_SELECT_TITLE = "";

export function setDocumentUndoHandlers(handlers) {
  documentUndo = handlers && typeof handlers.undo === "function" ? handlers : null;
}

function closeInkRailMenus(except = null) {
  MENUS.forEach(({ button, menu }) => {
    if (menu === except) return;
    const node = document.getElementById(menu);
    if (!node || node.hidden) return;
    node.hidden = true;
    document.getElementById(button)?.setAttribute("aria-expanded", "false");
  });
}

function toggleInkRailMenu(menuId) {
  const entry = MENUS.find((candidate) => candidate.menu === menuId);
  const node = document.getElementById(menuId);
  if (!entry || !node) return;
  closeInkRailMenus(menuId);
  inkPanel?.close();
  node.hidden = !node.hidden;
  document.getElementById(entry.button)?.setAttribute("aria-expanded", node.hidden ? "false" : "true");
}

// Whether anything the bar opened is open — the hardware Back key's question
// (src/ui/back-gesture.js), and the panel's.
export function isInkRailPopupOpen() {
  return Boolean(inkPanel?.isOpen()) || MENUS.some(({ menu }) => document.getElementById(menu)?.hidden === false);
}

export function closeInkRailPopups() {
  inkPanel?.close();
  closeInkRailMenus();
}

// ── A block's own actions, once one is picked up ───────────────────────────
//
// Style / Edit / Delete used to be a header drawn on every block, permanently,
// whether or not the reader was doing anything with it — chrome that earns its
// keep only the moment a block is selected. #inkRailSelection already answers
// the same question for a lassoed stroke, so a selected BLOCK gets the same
// answer here: hidden until src/documents/pdf-blocks.js says something is
// picked up, and painted off exactly that — never off refreshInkRail's own
// loop, which runs on every ink commit (several times a second while somebody
// writes) and would repaint a group that almost never changed.
function refreshBlockRail() {
  const group = el.inkRailBlock;
  if (!group) return;
  const kind = selectedBlockKind();
  group.hidden = !kind;
  if (!kind) return;
  // The one thing that still differs by kind, exactly as it did on the block's
  // own buttons: a picture has no words to style and no markdown to edit — it
  // has a frame, and a description read out when it cannot be shown.
  const isImage = kind === "image";
  const style = group.querySelector('[data-block-rail-action="style"]');
  const edit = group.querySelector('[data-block-rail-action="edit"]');
  if (style) {
    style.title = isImage ? "Frame this picture" : "Style this block";
    style.setAttribute("aria-label", style.title);
  }
  if (edit) {
    edit.title = isImage ? "Describe this image" : "Edit this block";
    edit.setAttribute("aria-label", edit.title);
    const word = edit.querySelector(".ink-rail-word");
    if (word) word.textContent = isImage ? "Describe" : "Edit";
  }
}

// ── Text, a button of its own ──────────────────────────────────────────────
//
// The typewriter is the Shapes tool on Text, underneath — but it was reached by
// pressing ✎ and then finding Text among the pen's tools, and "text should have
// a separate button instead of a hierarchy inside the pen". So it has its own
// button in the top row (#documentTextBtn), and while it is armed the pen's bar
// becomes the TEXT bar (`.is-typing`, styles/88-annotations.css): the pen's
// tools step aside and what is left is the style chip, undo and redo, and Done.
//
// Typing is read off the engine — the tool and the shape — never kept as a flag
// of its own, so nothing can come to disagree with what a tap actually does.
export function isTypewriterArmed() {
  return inkTool() === "shape" && shapeType() === "text";
}

// What Text was pressed from, so pressing it again (or Done) puts that back:
// the tool, and whether the bar was open before Text opened it. Per slot, and
// dropped when a document opens (applyInkRailPreference).
let typewriterReturn = null;

export function toggleTypewriter(force = null) {
  const typing = isTypewriterArmed();
  const on = force === null ? !typing : Boolean(force);
  if (isRegionSelectArmed()) setRegionSelect(false);
  closeInkRailMenus();
  if (on) {
    if (!typing) {
      typewriterReturn = { slot: activeDocSlot(), tool: inkTool(), railWasOpen: isInkArmed() };
      typewriterDoneWhenPanelCloses = false;
      // A mouse types only while the bar is armed (shapeTakesPointer,
      // src/documents/pdf-shapes.js), as it draws only then. NOT written to
      // ink-prefs: Text opening the bar is not the reader opening the pen's.
      if (!isInkArmed()) setInkArmed(true);
      setShapeType("text");
      setInkTool("shape");
      inkPanel?.close();
    }
  } else if (typing) {
    const back = typewriterReturn?.slot === activeDocSlot()
      ? typewriterReturn
      : { tool: INK_TOOL_DEFAULT, railWasOpen: inkRailOpen(activeDocSlot()) };
    typewriterReturn = null;
    inkPanel?.close();
    if (back.tool === "shape") {
      setShapeType(shapeButtonType());
      setInkTool("shape");
    } else {
      setInkTool(back.tool && back.tool !== "shape" ? back.tool : INK_TOOL_DEFAULT);
    }
    if (!back.railWasOpen) setInkArmed(false);
  }
  rememberInkPreferences();
  refreshInkRail();
}

// ── Text is one box per press ───────────────────────────────────────────────
//
// It used to stay armed after the words were put down, so every line ended
// with a trip to Done before the reader could do anything else on the page.
// Now putting the words down (a press elsewhere, Escape, Ctrl+Enter, the ✓)
// puts the Text tool away too, and what was in hand before T comes back.
//
// The one exception is focus moving onto the pen's own bar: that is the
// reader opening the style panel to colour or resize what they just typed,
// and putting the tool away would shut the panel under them. Then the tool
// goes when that panel does.
let typewriterDoneWhenPanelCloses = false;

export function finishTypewriterBox({ to = null } = {}) {
  if (!isTypewriterArmed()) return;
  if (to?.closest?.(".document-ink-rail")) {
    typewriterDoneWhenPanelCloses = true;
    return;
  }
  typewriterDoneWhenPanelCloses = false;
  toggleTypewriter(false);
}

function onInkPanelToggle(open) {
  if (open || !typewriterDoneWhenPanelCloses) return;
  typewriterDoneWhenPanelCloses = false;
  if (isTypewriterArmed()) queueMicrotask(() => { if (isTypewriterArmed()) toggleTypewriter(false); });
}

// ── On a wide screen, the bar sits in the tab row ───────────────────────────
//
// Pressing ✎ or T used to open the bar as a row of its own between the tabs and
// the page, pushing the page down — on a desktop, under a tab row with most of
// its width empty. So with a mouse on a wide window the bar is MOVED (not
// cloned: every control in it is wired by delegation on the bar itself) into
// #viewModeRow after the document's tools, and styled as one tinted group there
// (styles/91-ink-rail-inline.css) so it reads as the tools' settings and not as
// more tabs. Everywhere else it stays where it is written in the stage.
//
// It goes back to the stage when the row cannot hold it: a narrower window, a
// touch screen, or a row that turns out too full — tabs squeezed to "CAR…" —
// which is measured once per shape of the bar and remembered for that width.
// Focus mode is not one of them any more: it folds only the title bar, and the
// row (and the pen in it) stays on screen.
const INLINE_RAIL_QUERY = "(min-width: 1100px) and (hover: hover) and (pointer: fine)";
let inlineRailMedia = null;
let railHomeMarker = null;
const inlineRailRefusedAt = { typing: 0, full: 0 };
let inlineFitSignature = "";

function railShape(rail) {
  return rail.classList.contains("is-typing") ? "typing" : "full";
}

function wantsInlineRail(rail) {
  if (!inlineRailMedia?.matches || !railHomeMarker) return false;
  const refused = inlineRailRefusedAt[railShape(rail)];
  return !refused || window.innerWidth > refused;
}

// The stage's facts the bar's own rules are written against (no document, the
// notebook's slot, a dark page), copied onto the bar so they still hold once it
// has left the stage.
function mirrorStageOntoRail(rail) {
  const stage = el.documentStage;
  if (!stage) return;
  const slot = stage.dataset.docSlot || "";
  if (rail.dataset.docSlot !== slot) rail.dataset.docSlot = slot;
  rail.classList.toggle("on-no-document", stage.classList.contains("has-no-document"));
  rail.classList.toggle("on-no-notebook", stage.classList.contains("has-no-notebook"));
  rail.classList.toggle("on-dark-page", stage.classList.contains("is-pdf-inverted"));
}

export function placeInkRail() {
  const rail = el.documentInkRail;
  const row = document.getElementById("viewModeRow");
  if (!rail || !row || !railHomeMarker) return;
  mirrorStageOntoRail(rail);
  const inline = wantsInlineRail(rail);
  if (inline !== (rail.parentElement === row)) {
    if (inline) {
      // Right after the button that opened it (✎ and T sit together), so the
      // settings are beside what they set; the PDF switcher and ⋯ follow.
      const after = el.documentTextBtn?.parentElement === row ? el.documentTextBtn
        : el.documentInkBtn?.parentElement === row ? el.documentInkBtn
          : row.querySelector(":scope > .view-mode-row-break");
      row.insertBefore(rail, after ? after.nextSibling : null);
    } else {
      railHomeMarker.parentNode?.insertBefore(rail, railHomeMarker.nextSibling);
    }
    rail.classList.toggle("is-inline", inline);
    inlineFitSignature = "";
  }
  if (!inline || rail.hidden) return;
  // Measured only when the bar's shape changes — this runs on every pen lift,
  // and a layout read there is the cost refreshInkRail is written to avoid.
  const signature = [railShape(rail), rail.classList.contains("is-selecting"), rail.classList.contains("has-clipboard"), window.innerWidth].join("|");
  if (signature === inlineFitSignature) return;
  inlineFitSignature = signature;
  requestAnimationFrame(() => {
    if (rail.parentElement !== row || rail.hidden) return;
    const squeezed = row.scrollWidth > row.clientWidth + 1
      || [...row.querySelectorAll(":scope > .view-mode-toggle > button:not([hidden])")].some((tab) => tab.scrollWidth > tab.clientWidth + 1);
    if (!squeezed) return;
    inlineRailRefusedAt[railShape(rail)] = window.innerWidth;
    placeInkRail();
  });
}

function initInlineRail() {
  const rail = el.documentInkRail;
  if (!rail || !rail.parentNode || typeof window.matchMedia !== "function") return;
  railHomeMarker = document.createComment(" #documentInkRail's home on a narrow screen (placeInkRail) ");
  rail.parentNode.insertBefore(railHomeMarker, rail);
  inlineRailMedia = window.matchMedia(INLINE_RAIL_QUERY);
  inlineRailMedia.addEventListener?.("change", () => {
    inlineRailRefusedAt.typing = 0;
    inlineRailRefusedAt.full = 0;
    placeInkRail();
  });
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; placeInkRail(); });
  });
  // <body>'s classes (the drawer, the view, edit mode) and the stage's own
  // state: both change through class and attribute writes that do not pass
  // through here.
  const observer = new MutationObserver(() => placeInkRail());
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if (el.documentStage) observer.observe(el.documentStage, { attributes: true, attributeFilter: ["class", "data-doc-slot"] });
  placeInkRail();
}

export function refreshInkRail() {
  paintInkRail();
  placeInkRail();
}

function paintInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  const open = isInkArmed();
  const typingNow = isTypewriterArmed();
  pressed(el.documentTextBtn, typingNow);
  rail.classList.toggle("is-typing", typingNow);
  rail.setAttribute("aria-label", typingNow ? "Text" : "Pen");
  if (!open) {
    rail.hidden = true;
    pressed(el.documentInkBtn, open);
    syncShapeStylePopover();
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
  const undoable = documentUndo ? documentUndo.canUndo() : canUndoInk();
  const redoable = documentUndo ? documentUndo.canRedo() : canRedoInk();
  const count = inkSelectionCount();
  const pasteable = hasInkClipboard();
  const tool = inkTool();

  const highlighter = inkHighlighter();
  const eraser = { size: inkEraserSize(), mode: inkEraseMode(), target: inkEraseTarget() };

  rail.hidden = false;
  // While Text has the bar, it is Text that is lit, not the pen.
  pressed(el.documentInkBtn, open && !typingNow);
  paintInkRailPressed(rail, {
    pen: inkPen(),
    width: inkWidth(),
    tool,
    eraserSize: eraser.size,
    eraseMode: eraser.mode,
    snapShapes: inkSnapShapes(),
    highlighter,
    eraseTarget: eraser.target,
    tapDots: inkTapDots()
  });
  paintInkChip(el.inkRailStyleChip, {
    tool,
    pen: { token: inkPen(), width: inkWidth() },
    highlighter,
    eraser,
    selecting: count > 0,
    shape: displayedShapeSettings()
  });
  refreshShapeMenu(document.getElementById("inkRailShapeMenu"), document.getElementById("inkRailShapeBtn"));
  // The typewriter is the Shapes tool on Text, but its own button (in the top
  // row): Shapes is lit for every other shape, not for that.
  if (typingNow) pressed(document.getElementById("inkRailShapeBtn"), false);
  refreshShapePanel(shapePanel);
  // Text takes the pen's colours and nibs down, and the panel with them.
  // Nothing is being drawn, so there is no nib and no ink colour to choose; and
  // the swatches' other job — recolouring a lasso selection — has nothing to act
  // on either, because setTool clears that selection on the way out of the lasso.
  // The colour a highlight is made in is the pill's, chosen there.
  const selectingText = tool === "text";
  const pens = document.getElementById("inkRailPens");
  const nibs = document.getElementById("inkRailWidths");
  if (pens) pens.hidden = selectingText;
  if (nibs) nibs.hidden = selectingText;
  if (selectingText) inkPanel?.close();
  // The panel follows the tool: open on the pen and switch to the eraser, and it
  // is the eraser's panel that is showing — or none, for a tool with nothing to
  // set.
  if (inkPanel?.isOpen()) {
    if (!inkPanel.panelFor()) inkPanel.close();
    else inkPanel.open(inkPanel.panelFor());
  }
  rail.querySelector('[data-ink-action="undo"]')?.toggleAttribute("disabled", !undoable);
  rail.querySelector('[data-ink-action="redo"]')?.toggleAttribute("disabled", !redoable);
  // ── On a Canvas, "Select text" selects THINGS ───────────────────────────
  //
  // A Canvas's paper has no words to pick out, so the same tool picks up its
  // blocks and shapes instead — a press moves one, a drag on bare paper draws
  // a box round several (src/documents/canvas-selection.js). Its name says so
  // there, and says what it always said on a PDF.
  const selectTool = rail.querySelector('[data-ink-tool="text"]');
  if (selectTool) {
    if (!PDF_SELECT_TITLE) PDF_SELECT_TITLE = selectTool.title;
    const canvas = activeDocSlot() === DOC_SLOT_NOTEBOOK;
    const title = canvas ? CANVAS_SELECT_TITLE : PDF_SELECT_TITLE;
    if (selectTool.title !== title) {
      selectTool.title = title;
      selectTool.setAttribute("aria-label", canvas ? "Select" : "Select text");
    }
  }
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
  // With a selection the slot shows Copy, Delete and the ▾ menu; with only a
  // clipboard it shows Paste on its own. The page's own + steps aside for
  // either (styles/73-ink-panel.css), so the slot holds one thing at a time.
  rail.classList.toggle("is-selecting", count > 0);
  rail.classList.toggle("has-clipboard", pasteable && count < 1);
  if (count < 1 && !pasteable) document.getElementById("inkRailSelectionMenu")?.setAttribute("hidden", "");
  // Each one refused rather than hidden, so the menu does not change shape
  // under the reader's thumb between one selection and the next. Join needs two
  // strokes to join; the rest need one; paste needs only a clipboard.
  rail.querySelector('[data-ink-action="join"]')?.toggleAttribute("disabled", count < 2);
  ["split", "duplicate", "copy", "cut", "delete"].forEach((action) => {
    rail.querySelector(`[data-ink-action="${action}"]`)?.toggleAttribute("disabled", count < 1);
  });
  rail.querySelectorAll('[data-ink-action="paste"]').forEach((node) => node.toggleAttribute("disabled", !pasteable));
  inkPanel?.refresh();
  // The style popover at a selected shape — unless the chip's panel is up and
  // already showing the same controls (pdf-shape-style-popover.js).
  syncShapeStylePopover();
}

// ── Which tool each of the deck's two papers was left on ──────────────────
//
// The Document tab and the Write tab are one #documentStage showing two
// documents (src/documents/doc-slot.js) — and, until this, one ink engine with
// ONE tool between them. So a reader who used the pen as a text selector on the
// paper walked onto their notebook with the selector still armed: the stylus
// swept a selection across blank paper and drew nothing, with the tool row shut
// in the rail and nothing on screen saying why. Reported as "the switch is not
// seamless — sometimes it just does not draw", and that is exactly what it is.
//
// The two tabs are two working surfaces and the tool belongs to the surface, so
// it is kept per slot and restored when a document is opened. Deliberately in
// memory rather than in ink-prefs: a tab switch is the same sitting and the
// reader remembers what they armed a moment ago, but a LAUNCH is not, and a
// session that opens with the pen unable to draw is the fault this is fixing
// wearing different clothes. inkPreferences() goes on persisting only "pen" for
// exactly that reason, and every launch starts both surfaces drawing.
const slotTools = { doc: INK_TOOL_DEFAULT, notebook: INK_TOOL_DEFAULT };

// Two of the four tools come back, and two do not — the same division
// inkPreferences() makes for the same reason, and the same one the reading
// rail's own row already states: "the two tools this switches between are the
// two a reader means by draw and select". Coming back to a tab and finding the
// ERASER armed, because that is what you were doing on it ten minutes ago, is
// the first stroke of the visit silently deleting something; coming back to the
// lasso is a stroke that does not appear. Both are the fault this is fixing
// wearing a different hat, so both fall back to the pen.
//
// The highlighter comes back as well: like the pen it only ever adds to the page,
// and a reader working down a scanned chapter with it should find it still in
// hand after a glance at the notebook.
function rememberableInkTool(tool) {
  return tool === "text" || tool === "highlighter" || tool === "shape" ? tool : INK_TOOL_DEFAULT;
}

// Every setting the rail owns, read back off the engine rather than off the
// button that was pressed, so what is remembered cannot come to disagree with
// what is armed. One statement of it, because there are two doors to the tool
// now — this rail, and the reading rail's own row.
// Which tab's settings the paper's pen reads and writes: a PDF's or a Canvas's
// (src/storage/ink-prefs.js, INK_SURFACES). The two share one engine, so the
// engine is reloaded from the tab's own settings whenever a document opens.
function inkRailSurface() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK ? "notebook" : "doc";
}

function applyRailInkSettings(saved) {
  setInkPen(saved.pen, { keepOpacity: false });
  setInkWidth(saved.width);
  setInkHighlighter({ token: saved.hlPen, width: saved.hlWidth, straight: saved.hlStraight });
  setInkEraserSize(saved.eraserSize);
  setInkEraseMode(saved.eraseMode);
  setInkEraseTarget(saved.eraseTarget);
  setInkSnapShapes(saved.snapShapes);
  setInkTapDots(saved.tapDots);
}

function rememberInkPreferences() {
  slotTools[activeDocSlot()] = rememberableInkTool(inkTool());
  const highlighter = inkHighlighter();
  writeInkPreferences({
    pen: inkPen(),
    width: inkWidth(),
    tool: inkTool(),
    eraserSize: inkEraserSize(),
    eraseMode: inkEraseMode(),
    snapShapes: inkSnapShapes(),
    hlPen: highlighter.token,
    hlWidth: highlighter.width,
    hlStraight: highlighter.straight,
    eraseTarget: inkEraseTarget(),
    tapDots: inkTapDots()
  }, inkRailSurface());
}

// The tool, chosen from somewhere that is not this rail: the reading rail's
// "Select text" row (src/ui/reading-rail.js), which in focus mode is the only
// door to the pen at all — that mode folds #viewModeRow away and takes the ✎
// with it. Exported from here rather than written there so there is one
// statement of what changing the tool entails: set it, remember it, repaint.
export function chooseInkTool(tool) {
  if (isRegionSelectArmed()) setRegionSelect(false);
  setInkTool(tool);
  rememberInkPreferences();
  refreshInkRail();
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
  // Shutting the rail puts the pen back to drawing (setInkArmed), so this slot
  // is now on the pen whatever it was on before — recorded, or coming back to
  // this tab would restore a tool the reader had already put down.
  rememberInkPreferences();
  refreshInkRail();
}

// The rail as this surface last left it, or as this surface starts. Called when
// a document is opened; `setInkArmed` is also what lets a MOUSE draw, so on a
// notebook this is not only about which panel is visible.
export function applyInkRailPreference() {
  const slot = activeDocSlot();
  // This tab's own pen — a PDF's and a Canvas's are set apart.
  applyRailInkSettings(inkPreferences(inkRailSurface()));
  setInkArmed(inkRailOpen(slot));
  // AFTER setInkArmed, which resets the tool when it shuts the rail: this slot's
  // tool is the last word on what the pen does here, open rail or shut. A stylus
  // draws — or selects — whether the rail is up or not, so the tool cannot be a
  // property of the rail's visibility.
  setInkTool(slotTools[slot] || INK_TOOL_DEFAULT);
  // ...and a tab left typing comes back typing, with its Text bar up — a tap
  // that makes text needs the bar that says so, and a mouse needs it armed.
  typewriterReturn = null;
  if (isTypewriterArmed() && !isInkArmed()) setInkArmed(true);
  // ...and that repaint takes a shape picked up on the other document's style
  // popover away with it (syncShapeStylePopover).
  refreshInkRail();
}

// What the panel reads and changes, for the paper's rail — the adapter
// createInkPanel takes (src/handwriting/ink-popover.js). Every commit goes
// through the pdf-ink setters, which restyle a lassoed selection as well as
// setting the pen, and then through the same remember-and-repaint as a press on
// the bar.
const panelAdapter = {
  tool: () => inkTool(),
  selectionKinds: () => inkSelectionKinds(),
  pen: () => ({ token: inkPen(), width: inkWidth(), opacity: inkPenOpacity() }),
  highlighter: () => inkHighlighter(),
  eraser: () => ({ size: inkEraserSize(), mode: inkEraseMode(), target: inkEraseTarget() }),
  setPenColour: (token) => setInkPen(token),
  setPenWidth: (width) => setInkWidth(width),
  setPenOpacity: (opacity) => setInkOpacity(opacity),
  setHighlighter: (patch) => setInkHighlighter(patch),
  setEraserSize: (size) => setInkEraserSize(size),
  setEraseMode: (mode) => setInkEraseMode(mode),
  setEraseTarget: (target) => setInkEraseTarget(target),
  snapShapes: () => inkSnapShapes(),
  setSnapShapes: (on) => setInkSnapShapes(on),
  tapDots: () => inkTapDots(),
  setTapDots: (on) => setInkTapDots(on),
  recentColours: () => inkPreferences().recentColors,
  rememberColour: (hex) => rememberInkRecentColor(hex),
  paper: () => inkPaper(),
  paperBg: () => inkPaperBg(),
  scale: () => inkPreviewScale(),
  changed: () => { rememberInkPreferences(); refreshInkRail(); },
  suppressTap: () => suppressInkTap(),
  // The Shapes tool's section of this panel (src/documents/pdf-shape-panel.js).
  shapePanel: () => Boolean(shapePanel)
};

let shapePanel = null;

// One press on the bar, by pointer or by keyboard (bindInkRailActivation).
function pressRail(button) {
  const {
    inkPen: nextPen, inkWidth: nextWidth, inkEraserSize: nextEraser, inkTool: nextTool, inkAction: action,
    shapeType: nextShape
  } = button.dataset;
  // Done, on the Text bar: typing put down, and what was armed before is back.
  if (action === "typewriter-done") {
    toggleTypewriter(false);
    return;
  }
  // A row of the Shapes flyout: that shape, armed.
  if (nextShape) {
    if (isRegionSelectArmed()) setRegionSelect(false);
    setShapeType(nextShape);
    if (inkTool() !== "shape") setInkTool("shape");
    rememberInkPreferences();
    closeInkRailMenus();
    refreshInkRail();
    return;
  }
  // The Shapes button pressed while armed opens its flyout, not the panel —
  // which shape is the question its button is asked; how it looks is the chip's.
  // ...unless the typewriter has it: then the Shapes button means the shapes
  // again, the last one drawn.
  if (nextTool === "shape" && shapeType() === "text") {
    if (isRegionSelectArmed()) setRegionSelect(false);
    setShapeType(shapeButtonType());
    setInkTool("shape");
    rememberInkPreferences();
    refreshInkRail();
    return;
  }
  if (nextTool === "shape" && inkTool() === "shape") {
    toggleInkRailMenu("inkRailShapeMenu");
    return;
  }
  // A row of a menu shuts the menu it is in — on click, see MENUS.
  if (nextPen) setInkPen(nextPen);
  else if (nextWidth) setInkWidth(Number(nextWidth));
  else if (nextEraser) setInkEraserSize(Number(nextEraser));
  else if (nextTool) {
    // Picking up one of the pen's own tools puts ▣ down — while it is on, the
    // stylus is ▣'s, and a reader reaching for the highlighter here means the
    // pen's (src/documents/pdf-region.js).
    if (isRegionSelectArmed()) setRegionSelect(false);
    // The armed tool pressed again opens its panel, the way every drawing app
    // a reader has used does it; a different tool is armed, and the panel —
    // if it was up — follows it (refreshInkRail).
    if (nextTool === inkTool() && inkPanel?.panelFor()) {
      closeInkRailMenus();
      inkPanel.toggle();
      refreshInkRail();
      return;
    }
    setInkTool(nextTool);
  } else if (action === "style") {
    closeInkRailMenus();
    inkPanel?.toggle();
    refreshInkRail();
    return;
  } else if (action === "rail-more") { toggleInkRailMenu("inkRailMoreMenu"); return; }
  else if (action === "selection-more") { toggleInkRailMenu("inkRailSelectionMenu"); return; }
  else if (action === "add-menu") { toggleInkRailMenu("inkRailAddMenu"); return; }
  else if (action === "undo") (documentUndo ? documentUndo.undo() : undoInk());
  else if (action === "redo") (documentUndo ? documentUndo.redo() : redoInk());
  else if (action === "clear") { closeInkRailMenus(); askToClearPage(); }
  else if (action === "join") joinInkSelection();
  else if (action === "split") splitInkSelection();
  else if (action === "duplicate") duplicateInkSelection();
  else if (action === "copy") copyInkSelection();
  else if (action === "cut") cutInkSelection();
  else if (action === "paste") pasteInkSelection();
  else if (action === "delete") deleteInkSelection();
  // The two switches that are still on the bar's own handler when a surface
  // without the panel presses them. Read back off the engine rather than
  // toggled from the button's own aria-pressed, so the rail cannot come to
  // disagree with the thing it is describing.
  else if (action === "erase-mode") setInkEraseMode(inkEraseMode() === "part" ? "stroke" : "part");
  else if (action === "snap") setInkSnapShapes(!inkSnapShapes());
  if (nextPen || nextWidth || nextTool || nextEraser || action === "erase-mode" || action === "snap") {
    rememberInkPreferences();
  }
  refreshInkRail();
}

export function initInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  buildInkPanel(el.inkRailPopover, {
    ids: { pens: "inkRailPens", widths: "inkRailWidths", eraser: "inkRailEraser", hlPens: "inkRailHlPens", hlWidths: "inkRailHlWidths" },
    tapDots: true
  });
  shapePanel = buildShapePanel(el.inkRailPopover);
  buildShapeMenu(document.getElementById("inkRailShapeMenu"));
  setShapeChangedHandler(() => {
    // A shape selected with no Shapes panel up still repaints the chip, and
    // its style popover comes up at it, or goes with it (refreshInkRail).
    refreshInkRail();
  });
  inkPanel = el.inkRailPopover
    ? createInkPanel({ rail, popover: el.inkRailPopover, chip: el.inkRailStyleChip, adapter: panelAdapter, onToggle: onInkPanelToggle })
    : null;

  // The pen, the nib and the tool are remembered per device rather than per
  // deck: which colour you write in is a fact about you, not about the paper.
  const saved = inkPreferences(inkRailSurface());
  // Whole, opacity and all — this is the saved pen, not a colour pressed on it.
  applyRailInkSettings(saved);
  setInkTool(saved.tool);
  slotTools.doc = inkPreferences("doc").tool;
  slotTools.notebook = inkPreferences("notebook").tool;

  el.documentInkBtn?.addEventListener("click", () => {
    // ✎ while Text has the bar: the pen, with its whole bar — not the bar shut.
    if (isTypewriterArmed() && isInkArmed()) {
      typewriterReturn = null;
      inkPanel?.close();
      setInkTool(INK_TOOL_DEFAULT);
      writeInkRailOpen(activeDocSlot(), true);
      rememberInkPreferences();
      refreshInkRail();
      return;
    }
    toggleInkRail();
  });
  el.documentTextBtn?.addEventListener("click", () => toggleTypewriter());
  initInlineRail();

  // pointerdown, not click, and preventDefault with it: a press on the rail
  // must not travel on to the page underneath and start a stroke, and on a
  // stylus the two are a few pixels apart. And the keyboard's own press, which
  // is a click with no pointer behind it — see bindInkRailActivation. The panel
  // under the chip is inside the rail and handles its own presses first.
  bindInkRailActivation(rail, pressRail, "[data-ink-pen], [data-ink-width], [data-ink-eraser-size], [data-ink-tool], [data-ink-action], [data-shape-type]");

  // A row of a menu, chosen: the menu goes once the row has done its work.
  rail.addEventListener("click", (event) => {
    if (!event.target.closest?.(".ink-rail-menu-item, .ink-rail-add-shape")) return;
    setTimeout(() => closeInkRailMenus(), 0);
  });
  // ...and a press anywhere else shuts any of them. Capture, so the page's own
  // handlers see a press that has already put the menu away.
  document.addEventListener("pointerdown", (event) => {
    if (!MENUS.some(({ menu }) => document.getElementById(menu)?.hidden === false)) return;
    if (event.target.closest?.(".ink-rail-menu, #inkRailMoreBtn, #inkRailSelectionMoreBtn, #inkRailAddBtn, #inkRailShapeBtn")) return;
    closeInkRailMenus();
  }, true);
  rail.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!MENUS.some(({ menu }) => document.getElementById(menu)?.hidden === false)) return;
    event.preventDefault();
    event.stopPropagation();
    closeInkRailMenus();
  });

  // A second delegated listener on the same rail, over a different attribute
  // namespace — the pattern src/handwriting/board.js already uses for the
  // +Text/+Image/+Page group on this element: each acts on a different engine,
  // so what a press MEANS stays local to the module that owns it.
  bindInkRailActivation(el.inkRailBlock, (button) => {
    const action = button.dataset.blockRailAction;
    if (action === "style") openSelectedBlockStyle();
    else if (action === "edit") editBlock();
    else if (action === "delete") deleteBlock();
  }, "[data-block-rail-action]");
  setBlockSelectionChangedHandler(refreshBlockRail);
  refreshBlockRail();

  refreshInkRail();
}
