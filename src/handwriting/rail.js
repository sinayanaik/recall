// The pen's controls, built once.
//
// There were two of these. src/ui/ink-rail.js built the swatches and the nibs
// into the static markup of the document rail; src/notes/ink-sheet.js built the
// same swatches, the same nibs, the same three tools and the same undo pair a
// second time, from its own copy of the same loop, and then stripped classes off
// the result so the two would look alike. Every change to the pen had to be made
// in both, and the ways they had already drifted were not decisions: the sheet
// forgot the saved tool on open, the document rail had no always-present delete.
//
// So the PARTS are here and the DISPATCH is not. What a press means depends on
// which engine is under it — the document rail acts on a page of a paper, the
// sheet and the notebook on a page of their own — and a shared dispatcher would
// have to be handed one, which is just the same duplication wearing a parameter.
// What is shared is everything a reader can see.

import { INK_ERASER_SIZES, INK_PEN_COLORS, INK_WIDTHS, inkPenVar } from "../format/ink-colors.js?v=__BUILD__";

export function inkRailButton(attribute, value, label, glyph, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tool-button ink-rail-btn${extraClass ? ` ${extraClass}` : ""}`;
  button.dataset[attribute] = String(value);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  if (glyph) button.innerHTML = glyph;
  return button;
}

// The swatch is drawn from the pen's own custom property rather than from a hex
// value, so the chip in the rail is the colour the ink will actually be on the
// theme that is on — the same discipline the highlight picker keeps.
export function buildInkPenSwatches(host) {
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
export function buildInkNibs(host) {
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

// The eraser's sizes, drawn as the nibs are and for the same reason: "1.5 / 3 /
// 7 / 14" is a list of numbers nobody can picture, and a ring the size of the
// rubber is. A ring rather than the nibs' filled dot, because an eraser takes
// ink away — a solid blob would read as a very fat pen.
export function buildInkEraserSizes(host) {
  if (!host || host.querySelector("[data-ink-eraser-size]")) return;
  const widest = INK_ERASER_SIZES[INK_ERASER_SIZES.length - 1];
  // Prepended, so the sizes come before the part/whole toggle that is already in
  // the markup — the same order the pen's row has, size first and then what the
  // tool does with it.
  const frag = document.createDocumentFragment();
  INK_ERASER_SIZES.forEach((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-nib is-eraser";
    button.dataset.inkEraserSize = String(size);
    button.title = `${size}pt eraser`;
    button.setAttribute("aria-label", `${size} point eraser`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-nib", `${Math.round((size / widest) * 16) + 4}px`);
    frag.appendChild(button);
  });
  host.insertBefore(frag, host.firstChild);
}

export function buildInkToolGroup() {
  const tools = document.createElement("div");
  tools.className = "ink-rail-group";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Tool");
  tools.append(
    inkRailButton("inkTool", "pen", "Pen", "&#9998;"),
    inkRailButton("inkTool", "eraser", "Eraser — cross a stroke to remove it", "&#9003;"),
    inkRailButton("inkTool", "lasso", "Lasso — circle strokes to move, resize or delete them", "&#9711;")
  );
  return tools;
}

// Which of the three tools is lit, which pen, which nib. Everything here follows
// aria-pressed, which is what the CSS reads, so there is one statement of "this
// is the current one" rather than a class and an attribute that can disagree.
export function paintInkRailPressed(rail, { pen, width, tool, eraserSize = null, eraseMode = null, snapShapes = null }) {
  if (!rail) return;
  rail.querySelectorAll("[data-ink-pen]").forEach((node) =>
    node.setAttribute("aria-pressed", node.dataset.inkPen === pen ? "true" : "false"));
  rail.querySelectorAll("[data-ink-width]").forEach((node) =>
    node.setAttribute("aria-pressed", Number(node.dataset.inkWidth) === width ? "true" : "false"));
  rail.querySelectorAll("[data-ink-tool]").forEach((node) =>
    node.setAttribute("aria-pressed", node.dataset.inkTool === tool ? "true" : "false"));
  if (eraserSize !== null) {
    rail.querySelectorAll("[data-ink-eraser-size]").forEach((node) =>
      node.setAttribute("aria-pressed", Number(node.dataset.inkEraserSize) === eraserSize ? "true" : "false"));
  }
  // Both of these are a switch rather than one of a set, so they say "on" rather
  // than "chosen" — but through the same aria-pressed the CSS already lights, so
  // there is still one statement of what is current on this rail.
  if (eraseMode !== null) {
    rail.querySelector('[data-ink-action="erase-mode"]')
      ?.setAttribute("aria-pressed", eraseMode === "part" ? "true" : "false");
  }
  if (snapShapes !== null) {
    rail.querySelector('[data-ink-action="snap"]')
      ?.setAttribute("aria-pressed", snapShapes ? "true" : "false");
  }
}

// The button a press landed on, or null. Both rails bind pointerdown rather than
// click and both preventDefault it, for the same reason: a press on a control
// must not travel on to the surface underneath and start a stroke, and on a
// stylus the two are a few pixels apart.
export function readInkRailPress(event) {
  const button = event.target.closest?.("[data-ink-pen], [data-ink-width], [data-ink-eraser-size], [data-ink-tool], [data-ink-action]");
  if (!button || button.disabled) return null;
  event.preventDefault();
  event.stopPropagation();
  return button;
}
