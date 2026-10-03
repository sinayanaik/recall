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

import { INK_DRAW_TOOLS, INK_ERASER_SIZES, INK_HL_COLORS, INK_HL_WIDTHS, INK_PEN_COLORS, INK_WIDTHS, inkPenVar, parseInkToken } from "../format/ink-colors.js?v=__BUILD__";

// ── A glyph, and — where a glyph was never going to be enough — a word ─────
//
// The rail was built entirely out of symbols, and the ones that had to carry the
// most meaning were the ones the fewest fonts agree about. "Clear the page" was
// U+23A7, which is not a symbol for anything: it is the TOP HOOK OF A CURLY
// BRACE, and it renders as one. "Add a text block" was a plus and a pencil
// crammed into a 30px square, "add an image" a plus and a full-colour camera
// emoji that sat a head taller than every monochrome glyph beside it, and "add a
// page" a plus and a rectangle that is tofu on any font without it. Copy and
// Duplicate were two squares nobody could tell apart. Reported, fairly, as
// buttons that are "very much unintuitive and not properly styled".
//
// styles/56-pen-text.css already wrote the general rule down while solving the
// same problem for one button: "There is no symbol for 'select text' that
// renders on Android, iOS and desktop alike." So the controls that are reached
// for constantly and ARE iconic — the pen, the eraser, the lasso, undo, redo —
// stay glyphs, and everything a reader has to stop and decode gets the word.
// `text` is that word; a button with one is laid out as a pill rather than a
// square (styles/52-ink.css).
export function inkRailButton(attribute, value, label, glyph, extraClass = "", text = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tool-button ink-rail-btn${text ? " is-labelled" : ""}${extraClass ? ` ${extraClass}` : ""}`;
  button.dataset[attribute] = String(value);
  button.title = label;
  // The full sentence stays on `title` and `aria-label` either way: the word on
  // the button is short by necessity, and "Delete" is not "Delete the selected
  // strokes". A screen reader must go on hearing the second one, so the visible
  // word is marked away from it rather than added to it.
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", "false");
  if (text) {
    button.innerHTML = `${glyph ? `<span class="ink-rail-ico" aria-hidden="true">${glyph}</span>` : ""}`
      + `<span class="ink-rail-word" aria-hidden="true">${text}</span>`;
  } else if (glyph) {
    button.innerHTML = glyph;
  }
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

// The highlighter's colours, as the pen's are — except that these are hues and
// not theme tokens (INK_HL_HEX), because a band multiplies with the paper and is
// the same colour on every page; the chip shows the wash it will leave rather
// than the full hue.
export function buildInkHlSwatches(host) {
  if (!host || host.childElementCount) return;
  INK_HL_COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-swatch is-hl";
    button.dataset.inkHl = color.value;
    button.title = `${color.name} highlighter`;
    button.setAttribute("aria-label", `${color.name} highlighter`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-swatch", color.swatch);
    host.appendChild(button);
  });
}

// ...and its four quick widths, drawn as BANDS rather than dots, because that is
// what a highlighter leaves.
export function buildInkHlNibs(host) {
  if (!host || host.childElementCount) return;
  const widest = INK_HL_WIDTHS[INK_HL_WIDTHS.length - 1];
  INK_HL_WIDTHS.forEach((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-nib is-hl";
    button.dataset.inkHlWidth = String(size);
    button.title = `${size}pt highlighter`;
    button.setAttribute("aria-label", `${size} point highlighter`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-nib", `${Math.round((size / widest) * 16) + 3}px`);
    host.appendChild(button);
  });
}

// Colours of the reader's own, most recent first — rebuilt whenever the list
// changes, because unlike the palette it is not fixed. `attribute` says which
// pen a press on one sets (data-ink-recent for the pen, data-ink-hl-recent for
// the highlighter), so one delegated listener can tell them apart.
export function buildInkRecentColours(host, colours, attribute = "inkRecent") {
  if (!host) return;
  const list = Array.isArray(colours) ? colours : [];
  const signature = list.join(",");
  if (host.dataset.inkRecentList === signature) return;
  host.dataset.inkRecentList = signature;
  host.querySelectorAll(".ink-rail-swatch").forEach((node) => node.remove());
  const before = host.firstChild;
  list.forEach((hex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ink-rail-swatch is-recent";
    button.dataset[attribute] = hex;
    button.title = `Your colour ${hex}`;
    button.setAttribute("aria-label", `Your colour ${hex}`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--ink-swatch", hex);
    host.insertBefore(button, before);
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

// The highlighter's glyph. Not a character, for the reason styles/56-pen-text.css
// gives for the T: there is no symbol for a highlighter that renders on Android,
// iOS and desktop alike — U+1F58D is a full-colour crayon emoji on one, tofu on
// another, and either way a head taller than the monochrome pen beside it. So it
// is drawn: a chisel-tipped marker over the band it leaves, in currentColor, at
// the size of the glyphs around it.
export const INK_HIGHLIGHTER_ICON = '<svg class="ink-rail-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M14.6 3.4l6 6-8.3 8.3H6.3v-6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
  + '<path d="M6.3 11.7l6 6" fill="none" stroke="currentColor" stroke-width="1.8"/>'
  + '<path d="M3.5 21h10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity="0.55"/>'
  + "</svg>";

// What each tool that MARKS the page is called and drawn as, in one table, so
// the sheet's loop and the paper's markup cannot come to disagree about it.
const INK_TOOL_BUTTONS = {
  pen: ["Pen", "&#9998;"],
  highlighter: ["Highlighter — a see-through band over the page, for text a highlight cannot select (a scanned page, a figure)", INK_HIGHLIGHTER_ICON],
  eraser: ["Eraser — cross a stroke to remove it", "&#9003;"],
  lasso: ["Lasso — circle strokes to move, resize or delete them", "&#9711;"]
};

// The four that MARK the page — INK_DRAW_TOOLS, not INK_TOOLS. The fifth,
// "text", turns the stylus into a way of selecting words instead of drawing
// them, and this rail is the drawing SHEET's: blank paper inside a note, with no
// text on it to select. The paper and the notebook carry all five, in their own
// markup in index.html.
export function buildInkToolGroup() {
  const tools = document.createElement("div");
  tools.className = "ink-rail-group";
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Tool");
  INK_DRAW_TOOLS.forEach((tool) => {
    const [label, glyph] = INK_TOOL_BUTTONS[tool] || [tool, ""];
    tools.append(inkRailButton("inkTool", tool, label, glyph));
  });
  return tools;
}

// Which of the three tools is lit, which pen, which nib. Everything here follows
// aria-pressed, which is what the CSS reads, so there is one statement of "this
// is the current one" rather than a class and an attribute that can disagree.
export function paintInkRailPressed(rail, {
  pen, width, tool, eraserSize = null, eraseMode = null, snapShapes = null,
  highlighter = null, eraseTarget = null, tapDots = null
}) {
  if (!rail) return;
  // The swatch is a COLOUR, and the pen's word carries more than one — a red pen
  // at half strength is still the red swatch, and a colour of the reader's own
  // lights none of them.
  const colour = parseInkToken(pen)?.name || null;
  rail.querySelectorAll("[data-ink-pen]").forEach((node) =>
    node.setAttribute("aria-pressed", node.dataset.inkPen === colour ? "true" : "false"));
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
  if (tapDots !== null) {
    rail.querySelector('[data-ink-action="tap-dots"]')
      ?.setAttribute("aria-pressed", tapDots ? "true" : "false");
  }
  // A colour of the reader's own lights its swatch in the recent row; a palette
  // pen lights its own. One or the other, never both.
  const hex = parseInkToken(pen)?.hex || null;
  rail.querySelectorAll("[data-ink-recent]").forEach((node) =>
    node.setAttribute("aria-pressed", node.dataset.inkRecent === hex ? "true" : "false"));
  if (highlighter) {
    const band = parseInkToken(highlighter.token);
    rail.querySelectorAll("[data-ink-hl]").forEach((node) =>
      node.setAttribute("aria-pressed", node.dataset.inkHl === band?.name ? "true" : "false"));
    rail.querySelectorAll("[data-ink-hl-recent]").forEach((node) =>
      node.setAttribute("aria-pressed", node.dataset.inkHlRecent === band?.hex ? "true" : "false"));
    rail.querySelectorAll("[data-ink-hl-width]").forEach((node) =>
      node.setAttribute("aria-pressed", Number(node.dataset.inkHlWidth) === highlighter.width ? "true" : "false"));
    rail.querySelector('[data-ink-action="hl-straight"]')
      ?.setAttribute("aria-pressed", highlighter.straight ? "true" : "false");
  }
  if (eraseTarget !== null) {
    rail.querySelectorAll("[data-ink-erase-target]").forEach((node) =>
      node.setAttribute("aria-pressed", node.dataset.inkEraseTarget === eraseTarget ? "true" : "false"));
  }
}

// The button a press landed on, or null. Both rails bind pointerdown rather than
// click and both preventDefault it, for the same reason: a press on a control
// must not travel on to the surface underneath and start a stroke, and on a
// stylus the two are a few pixels apart.
const INK_RAIL_PRESSABLE = "[data-ink-pen], [data-ink-width], [data-ink-eraser-size], [data-ink-tool], [data-ink-action], "
  + "[data-ink-hl], [data-ink-hl-width], [data-ink-recent], [data-ink-hl-recent], [data-ink-erase-target], [data-ink-step], [data-ink-panel-tab]";

export function readInkRailPress(event) {
  const button = event.target.closest?.(INK_RAIL_PRESSABLE);
  if (!button || button.disabled) return null;
  event.preventDefault();
  event.stopPropagation();
  return button;
}

// ── Pressed by a pointer, or by the keyboard ──────────────────────────────
//
// Every rail acted on pointerdown and on nothing else, which is right for a pen
// — a press must not travel on to the page and start a stroke — and meant that
// a rail button focused with Tab did nothing at all when Enter or Space was
// pressed on it. The keyboard's press arrives as a click with no pointer behind
// it (`detail` 0), so this takes those as well; a pointer's own click, which
// follows the pointerdown that already acted, is ignored, or every press would
// act twice.
export function bindInkRailActivation(root, handle, selector = INK_RAIL_PRESSABLE) {
  if (!root) return;
  root.addEventListener("pointerdown", (event) => {
    const button = event.target.closest?.(selector);
    if (!button || button.disabled || button.hasAttribute("disabled")) return;
    // A slider or a colour input is not a button: its own default is the whole
    // of how it works, and refusing the pointerdown would stop it being dragged.
    if (button.matches("input")) return;
    event.preventDefault();
    event.stopPropagation();
    handle(button, event);
  });
  root.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const button = event.target.closest?.(selector);
    if (!button || button.disabled || button.hasAttribute("disabled") || button.matches("input")) return;
    event.preventDefault();
    // Stopped here as the pointerdown is, so a rail nested in a rail (the pen's
    // panel sits inside the paper's) does not act on one key press twice.
    event.stopPropagation();
    handle(button, event);
  });
}
