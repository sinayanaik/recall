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
// Built here rather than in index.html for the swatches and the nibs, because
// both come from the palette leaf and a second copy of that list in markup is a
// second place for it to be wrong. The tools, the undo pair and the selection
// actions are markup, because they are fixed.
//
// One delegated listener over `data-ink-*`, which is the pattern
// src/editor/toolbar-actions.js and src/format/render-toolbar.js both already
// follow: a control is a button with an attribute, not a binding.

import { el } from "../core/dom.js?v=__BUILD__";
import { canRedoInk, canUndoInk, deleteInkSelection, inkPen, inkSelectionCount, inkTool, inkWidth, isInkArmed, joinInkSelection, redoInk, setInkArmed, setInkPen, setInkTool, setInkWidth, splitInkSelection, undoInk } from "../documents/pdf-ink.js?v=__BUILD__";
import { INK_PEN_COLORS, INK_WIDTHS, inkPenVar } from "../format/ink-colors.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";

// The swatch is drawn from the pen's own custom property rather than from a hex
// value, so the chip in the rail is the colour the ink will actually be on the
// theme that is on — the same discipline the highlight picker keeps.
function buildPens() {
  const host = el.inkRailPens;
  if (!host || host.childElementCount) return;
  INK_PEN_COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-swatch";
    button.dataset.inkPen = color.value;
    button.title = color.name;
    button.setAttribute("aria-label", color.name);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-swatch", `var(${inkPenVar(color.value)}, ${color.swatch})`);
    host.appendChild(button);
  });
}

// A nib is drawn AS a nib — a dot the size the pen will actually be — because
// "1.2 / 2 / 3.4 / 6" is a list of numbers nobody can picture. The dot is
// scaled off the widest, so the four read as a set.
function buildWidths() {
  const host = el.inkRailWidths;
  if (!host || host.childElementCount) return;
  const widest = INK_WIDTHS[INK_WIDTHS.length - 1];
  INK_WIDTHS.forEach((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-nib";
    button.dataset.inkWidth = String(size);
    button.title = `${size}pt nib`;
    button.setAttribute("aria-label", `${size} point nib`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-nib", `${Math.round((size / widest) * 16) + 4}px`);
    host.appendChild(button);
  });
}

function pressed(node, on) {
  if (node) node.setAttribute("aria-pressed", on ? "true" : "false");
}

export function refreshInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  const open = isInkArmed();
  rail.hidden = !open;
  pressed(el.documentInkBtn, open);
  if (!open) return;

  const pen = inkPen();
  const width = inkWidth();
  const tool = inkTool();
  rail.querySelectorAll("[data-ink-pen]").forEach((node) => pressed(node, node.dataset.inkPen === pen));
  rail.querySelectorAll("[data-ink-width]").forEach((node) => pressed(node, Number(node.dataset.inkWidth) === width));
  rail.querySelectorAll("[data-ink-tool]").forEach((node) => pressed(node, node.dataset.inkTool === tool));
  rail.querySelector('[data-ink-action="undo"]')?.toggleAttribute("disabled", !canUndoInk());
  rail.querySelector('[data-ink-action="redo"]')?.toggleAttribute("disabled", !canRedoInk());

  const count = inkSelectionCount();
  if (el.inkRailSelection) el.inkRailSelection.hidden = count < 1;
  // Join needs two strokes to join. Shown but refused rather than hidden, so
  // the row does not change width under the reader's thumb between one
  // selection and the next.
  rail.querySelector('[data-ink-action="join"]')?.toggleAttribute("disabled", count < 2);
}

export function toggleInkRail(force = null) {
  setInkArmed(force === null ? !isInkArmed() : Boolean(force));
  refreshInkRail();
}

export function initInkRail() {
  const rail = el.documentInkRail;
  if (!rail) return;
  buildPens();
  buildWidths();

  // The pen, the nib and the tool are remembered per device rather than per
  // deck: which colour you write in is a fact about you, not about the paper.
  const saved = inkPreferences();
  setInkPen(saved.pen);
  setInkWidth(saved.width);
  setInkTool(saved.tool);

  el.documentInkBtn?.addEventListener("click", () => toggleInkRail());

  // pointerdown, not click, and preventDefault with it: a press on the rail
  // must not travel on to the page underneath and start a stroke, and on a
  // stylus the two are a few pixels apart.
  rail.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-ink-pen], [data-ink-width], [data-ink-tool], [data-ink-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const { inkPen: nextPen, inkWidth: nextWidth, inkTool: nextTool, inkAction: action } = button.dataset;
    if (nextPen) setInkPen(nextPen);
    else if (nextWidth) setInkWidth(Number(nextWidth));
    else if (nextTool) setInkTool(nextTool);
    else if (action === "undo") undoInk();
    else if (action === "redo") redoInk();
    else if (action === "join") joinInkSelection();
    else if (action === "split") splitInkSelection();
    else if (action === "delete") deleteInkSelection();
    if (nextPen || nextWidth || nextTool) {
      writeInkPreferences({ pen: inkPen(), width: inkWidth(), tool: inkTool() });
    }
    refreshInkRail();
  });

  refreshInkRail();
}
