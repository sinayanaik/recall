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
import { canRedoInk, canUndoInk, clearInkPage, copyInkSelection, cutInkSelection, deleteInkSelection, duplicateInkSelection, hasInkClipboard, inkEraseMode, inkEraseTarget, inkEraserSize, inkHighlighter, inkPageHasStrokes, inkPageInView, inkPageInViewCheap, inkPaper, inkPen, inkPenOpacity, inkScreenScale, inkSelectionCount, inkSelectionKinds, inkSnapShapes, inkTapDots, inkTool, inkWidth, isInkArmed, joinInkSelection, pasteInkSelection, redoInk, setInkArmed, setInkEraseMode, setInkEraseTarget, setInkEraserSize, setInkHighlighter, setInkOpacity, setInkPen, setInkSnapShapes, setInkTapDots, setInkTool, setInkWidth, splitInkSelection, suppressInkTap, undoInk } from "../documents/pdf-ink.js?v=__BUILD__";
import { deleteBlock, editBlock, openSelectedBlockStyle, selectedBlockKind, setBlockSelectionChangedHandler } from "../documents/pdf-blocks.js?v=__BUILD__";
import { INK_TOOL_DEFAULT } from "../format/ink-colors.js?v=__BUILD__";
import { bindInkRailActivation, paintInkRailPressed } from "../handwriting/rail.js?v=__BUILD__";
import { buildInkPanel, createInkPanel, paintInkChip } from "../handwriting/ink-popover.js?v=__BUILD__";
import { inkPreferences, inkRailOpen, rememberInkRecentColor, writeInkPreferences, writeInkRailOpen } from "../storage/ink-prefs.js?v=__BUILD__";
import { activeDocSlot } from "../documents/doc-slot.js?v=__BUILD__";
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
  { button: "inkRailMoreBtn", menu: "inkRailMoreMenu" },
  { button: "inkRailSelectionMoreBtn", menu: "inkRailSelectionMenu" },
  { button: "inkRailAddBtn", menu: "inkRailAddMenu" }
];

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

  const highlighter = inkHighlighter();
  const eraser = { size: inkEraserSize(), mode: inkEraseMode(), target: inkEraseTarget() };

  rail.hidden = false;
  pressed(el.documentInkBtn, open);
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
    selecting: count > 0
  });
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
  return tool === "text" || tool === "highlighter" ? tool : INK_TOOL_DEFAULT;
}

// Every setting the rail owns, read back off the engine rather than off the
// button that was pressed, so what is remembered cannot come to disagree with
// what is armed. One statement of it, because there are two doors to the tool
// now — this rail, and the reading rail's own row.
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
  });
}

// The tool, chosen from somewhere that is not this rail: the reading rail's
// "Select text" row (src/ui/reading-rail.js), which in focus mode is the only
// door to the pen at all — that mode folds #viewModeRow away and takes the ✎
// with it. Exported from here rather than written there so there is one
// statement of what changing the tool entails: set it, remember it, repaint.
export function chooseInkTool(tool) {
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
  setInkArmed(inkRailOpen(slot));
  // AFTER setInkArmed, which resets the tool when it shuts the rail: this slot's
  // tool is the last word on what the pen does here, open rail or shut. A stylus
  // draws — or selects — whether the rail is up or not, so the tool cannot be a
  // property of the rail's visibility.
  setInkTool(slotTools[slot] || INK_TOOL_DEFAULT);
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
  scale: () => inkScreenScale(),
  changed: () => { rememberInkPreferences(); refreshInkRail(); },
  suppressTap: () => suppressInkTap()
};

// One press on the bar, by pointer or by keyboard (bindInkRailActivation).
function pressRail(button) {
  const {
    inkPen: nextPen, inkWidth: nextWidth, inkEraserSize: nextEraser, inkTool: nextTool, inkAction: action
  } = button.dataset;
  // A row of a menu shuts the menu it is in — on click, see MENUS.
  if (nextPen) setInkPen(nextPen);
  else if (nextWidth) setInkWidth(Number(nextWidth));
  else if (nextEraser) setInkEraserSize(Number(nextEraser));
  else if (nextTool) {
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
  else if (action === "undo") undoInk();
  else if (action === "redo") redoInk();
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
  inkPanel = el.inkRailPopover
    ? createInkPanel({ rail, popover: el.inkRailPopover, chip: el.inkRailStyleChip, adapter: panelAdapter, onToggle: () => {} })
    : null;

  // The pen, the nib and the tool are remembered per device rather than per
  // deck: which colour you write in is a fact about you, not about the paper.
  const saved = inkPreferences();
  // Whole, opacity and all — this is the saved pen, not a colour pressed on it.
  setInkPen(saved.pen, { keepOpacity: false });
  setInkWidth(saved.width);
  setInkHighlighter({ token: saved.hlPen, width: saved.hlWidth, straight: saved.hlStraight });
  setInkTool(saved.tool);
  slotTools.doc = saved.tool;
  slotTools.notebook = saved.tool;
  setInkEraserSize(saved.eraserSize);
  setInkEraseMode(saved.eraseMode);
  setInkEraseTarget(saved.eraseTarget);
  setInkSnapShapes(saved.snapShapes);
  setInkTapDots(saved.tapDots);

  el.documentInkBtn?.addEventListener("click", () => toggleInkRail());

  // pointerdown, not click, and preventDefault with it: a press on the rail
  // must not travel on to the page underneath and start a stroke, and on a
  // stylus the two are a few pixels apart. And the keyboard's own press, which
  // is a click with no pointer behind it — see bindInkRailActivation. The panel
  // under the chip is inside the rail and handles its own presses first.
  bindInkRailActivation(rail, pressRail, "[data-ink-pen], [data-ink-width], [data-ink-eraser-size], [data-ink-tool], [data-ink-action]");

  // A row of a menu, chosen: the menu goes once the row has done its work.
  rail.addEventListener("click", (event) => {
    if (!event.target.closest?.(".ink-rail-menu-item")) return;
    setTimeout(() => closeInkRailMenus(), 0);
  });
  // ...and a press anywhere else shuts any of them. Capture, so the page's own
  // handlers see a press that has already put the menu away.
  document.addEventListener("pointerdown", (event) => {
    if (!MENUS.some(({ menu }) => document.getElementById(menu)?.hidden === false)) return;
    if (event.target.closest?.(".ink-rail-menu, #inkRailMoreBtn, #inkRailSelectionMoreBtn, #inkRailAddBtn")) return;
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
