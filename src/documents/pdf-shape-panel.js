// The Shapes tool's controls: the flyout under its rail button, which picks the
// shape, and the panel under the rail's chip, which says how it looks.
//
// One Shapes button rather than seven on the rail: the rail already wraps on a
// phone, and the shape a reader is drawing changes far less often than the
// fact that they are drawing shapes. The button wears the armed shape's icon,
// a press arms it, and a press on it armed opens the flyout — the same "press
// again for more" every tool on the rail has.
//
// The panel is a section of the pen's own panel (#inkRailPopover,
// src/handwriting/ink-popover.js), shown when the Shapes tool is armed, so the
// chip, the placement and the way out are the ones a reader already knows.
// Every control commits through setShapeSettings, which restyles a selected
// shape as well as setting the next one's look.

import { INK_PEN_COLORS } from "../format/ink-colors.js?v=__BUILD__";
import { SHAPE_HEADS, SHAPE_LABELS, SHAPE_ROTATABLE, SHAPE_WIDTH_RANGE, normalizeShape } from "../render/annot-shapes.js?v=__BUILD__";
import { rememberInkRecentColor } from "../storage/ink-prefs.js?v=__BUILD__";
import { displayedShapeSettings, rotateShapeBy, setShapeRotation, setShapeSettings, shapeButtonType, shapeType, targetShapeRecord } from "./pdf-shapes.js?v=__BUILD__";

// The shapes the flyout offers, in its order. Not typed text: that is the Text
// button's own, in the top row beside the pen (src/ui/ink-rail.js).
export const SHAPE_MENU_TYPES = ["line", "arrow", "rect", "ellipse", "callout", "sticky"];

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

export const SHAPE_ICONS = {
  line: `<path d="M4 19L20 5"/>`,
  arrow: `<path d="M4 19L19 6"/><path d="M11 5.5h8.5V14"/>`,
  rect: `<rect x="4" y="6" width="16" height="12" rx="1.5"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>`,
  callout: `<rect x="9" y="3.5" width="12" height="8.5" rx="1.5"/><path d="M11 12L4 20"/>`,
  text: `<path d="M6 6h12M12 6v13M9.5 19h5"/>`,
  sticky: `<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>`
};

export function shapeIconSvg(type, className = "ink-rail-shape-glyph") {
  return `<svg class="${className}" ${ICON_ATTRS}>${SHAPE_ICONS[type] || SHAPE_ICONS.arrow}</svg>`;
}

// ── The flyout ────────────────────────────────────────────────────────────

export function buildShapeMenu(menu) {
  if (!menu || menu.childElementCount) return;
  menu.innerHTML = SHAPE_MENU_TYPES.map((type) =>
    `<button class="ink-rail-menu-item" type="button" role="menuitemradio" aria-checked="false" data-shape-type="${type}" title="${SHAPE_LABELS[type]}">${shapeIconSvg(type, "shape-menu-glyph")}${SHAPE_LABELS[type]}</button>`
  ).join("");
}

export function refreshShapeMenu(menu, button) {
  const type = shapeButtonType();
  const armedShape = shapeType();
  menu?.querySelectorAll("[data-shape-type]").forEach((item) => {
    const on = item.dataset.shapeType === armedShape;
    item.classList.toggle("is-current", on);
    item.setAttribute("aria-checked", String(on));
  });
  if (button && button.dataset.shapeIcon !== type) {
    button.dataset.shapeIcon = type;
    button.innerHTML = shapeIconSvg(type);
    const label = `Shapes: ${SHAPE_LABELS[type]} — press again to pick a line, arrow, box, ellipse, callout or sticky note`;
    button.title = label;
    button.setAttribute("aria-label", `Shapes (${SHAPE_LABELS[type]})`);
  }
}

// ── The panel ─────────────────────────────────────────────────────────────

const HEAD_LABELS = { none: "None", open: "Open", filled: "Filled", dot: "Dot", bar: "Bar" };
const DASH_LABELS = { solid: "Solid", dash: "Dashed", dot: "Dotted" };
const ROUTE_LABELS = { straight: "Straight", elbow: "Square corners", curve: "Curved" };

// How a line runs between its ends — the three a diagram tool offers. Drawn
// end to end, as the line itself would be.
function routeIcon(route) {
  const d = { straight: "M3 12L19 4", elbow: "M3 12h8V4h8", curve: "M3 12C11 12 11 4 19 4" }[route];
  return `<svg viewBox="0 0 22 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

function headIcon(style, end) {
  // Drawn pointing right for the end, left for the start.
  const flip = end === "start" ? ' transform="translate(22 0) scale(-1 1)"' : "";
  const tip = {
    none: "",
    open: '<path d="M14 3l6 4-6 4"/>',
    filled: '<path d="M14 3l6 4-6 4z" fill="currentColor"/>',
    dot: '<circle cx="18" cy="7" r="2.6" fill="currentColor"/>',
    bar: '<path d="M20 2.5v9"/>'
  }[style] || "";
  return `<svg viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><g${flip}><path d="M2 7h${style === "none" ? 18 : 16}"/>${tip}</g></svg>`;
}

function dashIcon(dash) {
  const array = { solid: "", dash: ' stroke-dasharray="5 3"', dot: ' stroke-dasharray="0.1 3.5"' }[dash];
  return `<svg viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 7h18"${array}/></svg>`;
}

function shapeSwatchRow(kind, { none = false } = {}) {
  const items = INK_PEN_COLORS.map((c) =>
    `<button type="button" class="shape-pop-swatch" data-shape-${kind}="${c.swatch}" style="--sw:${c.swatch}" title="${c.name}" aria-label="${c.name}" aria-pressed="false"></button>`);
  if (none) items.unshift(`<button type="button" class="shape-pop-swatch is-none" data-shape-${kind}="none" title="No fill" aria-label="No fill" aria-pressed="false"></button>`);
  items.push(`<label class="shape-pop-colour" title="A colour of your own"><span aria-hidden="true">+</span><input type="color" data-shape-${kind}-custom aria-label="A colour of your own"></label>`);
  return items.join("");
}

// Width on a log scale, so a hairline and a marker are both a short drag away.
const SHAPE_SLIDER_STEPS = 1000;

function widthFromSlider(position) {
  const t = Math.min(1, Math.max(0, position / SHAPE_SLIDER_STEPS));
  const { min, max } = SHAPE_WIDTH_RANGE;
  return Math.round(min * Math.pow(max / min, t) * 10) / 10;
}

function sliderFromWidth(width) {
  const { min, max } = SHAPE_WIDTH_RANGE;
  return Math.round((Math.log(Math.max(min, width) / min) / Math.log(max / min)) * SHAPE_SLIDER_STEPS);
}

// ── Sizes, typed ──────────────────────────────────────────────────────────
//
// A−/A+ and the width slider are quick steps; the number box beside each is the
// whole range — any positive number of points, uncapped.

// Up to two decimals, no trailing zeros: 11, 0.35, 1234.5.
function formatPoints(value) {
  return String(Math.round(Number(value) * 100) / 100);
}

// What a typed box holds, as a size — or null when it is not one.
export function typedPoints(raw) {
  const value = Number(String(raw ?? "").trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// One press of A− or A+. Steps of 1pt below 20 and 2pt above, as before — and
// no floor or ceiling: A+ keeps going, and A− below one step halves instead,
// so it approaches zero without ever reaching a size that cannot be drawn.
export function steppedFontSize(size, step) {
  const by = size >= 20 ? 2 : 1;
  const next = size + step * by;
  if (next > 0) return Math.round(next * 100) / 100;
  return Math.round((size / 2) * 100) / 100 || size;
}

// What a typed angle box holds, in degrees — any finite number, a turn past
// 180° or below −180° wrapped round — or null when it is not one.
export function typedDegrees(raw) {
  const text = String(raw ?? "").trim().replace(",", ".").replace(/°$/, "");
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// A box the reader is typing in is left alone; every other one says the truth.
function setNumberBox(box, value) {
  if (!box || document.activeElement === box) return;
  box.value = formatPoints(value);
}

// ── The rows, as pieces ───────────────────────────────────────────────────
//
// Both panels are built from these: the pen's panel lays them out as labelled
// rows, the floating bar puts each behind its own icon.

function panelRow(key, label, inner, aria = "") {
  const group = aria ? ` role="group" aria-label="${aria}"` : "";
  const data = key ? ` data-shape-row="${key}"` : "";
  return `<div class="shape-pop-row"${group}${data}><span class="shape-pop-label">${label}</span>${inner}</div>`;
}

const WIDTH_INNER = `
      <input class="shape-pop-slider" type="range" min="0" max="${SHAPE_SLIDER_STEPS}" step="1" data-shape-width aria-label="Line width">
      <input class="shape-pop-number" type="number" min="0" step="any" inputmode="decimal" data-shape-width-value aria-label="Line width in points" title="Any width, in points"><span class="shape-pop-unit">pt</span>`;
const OPACITY_INNER = `
      <input class="shape-pop-slider" type="range" min="10" max="100" step="1" data-shape-opacity aria-label="Opacity">
      <output class="shape-pop-value" data-shape-opacity-value></output>`;
const DASH_INNER = ["solid", "dash", "dot"].map((d) => `<button type="button" class="shape-pop-seg" data-shape-dash="${d}" title="${DASH_LABELS[d]}" aria-label="${DASH_LABELS[d]}" aria-pressed="false">${dashIcon(d)}</button>`).join("");
const ROUTE_INNER = ["straight", "elbow", "curve"].map((r) => `<button type="button" class="shape-pop-seg" data-shape-route="${r}" title="${ROUTE_LABELS[r]}" aria-label="${ROUTE_LABELS[r]}" aria-pressed="false">${routeIcon(r)}</button>`).join("");
const HEAD_START_INNER = SHAPE_HEADS.map((h) => `<button type="button" class="shape-pop-seg" data-shape-head-start="${h}" title="Start: ${HEAD_LABELS[h]}" aria-label="Start: ${HEAD_LABELS[h]}" aria-pressed="false">${headIcon(h, "start")}</button>`).join("");
const HEAD_END_INNER = SHAPE_HEADS.map((h) => `<button type="button" class="shape-pop-seg" data-shape-head-end="${h}" title="End: ${HEAD_LABELS[h]}" aria-label="End: ${HEAD_LABELS[h]}" aria-pressed="false">${headIcon(h, "end")}</button>`).join("");
const SIZE_INNER = `
      <button type="button" class="shape-pop-seg" data-shape-font-step="-1" title="Smaller text" aria-label="Smaller text">A&#8722;</button>
      <input class="shape-pop-number" type="number" min="0" step="any" inputmode="decimal" data-shape-font-value aria-label="Text size in points" title="Any size, in points"><span class="shape-pop-unit">pt</span>
      <button type="button" class="shape-pop-seg" data-shape-font-step="1" title="Larger text" aria-label="Larger text">A+</button>`;
const BOLD_BUTTON = `<button type="button" class="shape-pop-seg" data-shape-bold title="Bold" aria-label="Bold" aria-pressed="false"><b>B</b></button>`;
const ALIGN_GLYPHS = { left: "&#8676;", center: "&#8596;", right: "&#8677;" };
const ALIGN_INNER = ["left", "center", "right"].map((a) => `<button type="button" class="shape-pop-seg" data-shape-align="${a}" title="Align ${a}" aria-label="Align ${a}" aria-pressed="false">${ALIGN_GLYPHS[a]}</button>`).join("");
const WRAP_INNER = `
      <button type="button" class="shape-pop-seg" data-shape-wrap="off" title="Grow with the words — a new line only where you press Enter" aria-pressed="false">Grow</button>
      <button type="button" class="shape-pop-seg" data-shape-wrap="on" title="Wrap the words at the box's width — drag a side handle to change it" aria-pressed="false">Wrap</button>
      <button type="button" class="shape-pop-seg" data-shape-border title="An outline round the text" aria-pressed="false">Border</button>`;
const ROTATE_INNER = `
      <button type="button" class="shape-pop-seg" data-shape-rotate-by="90" title="Turn 90° anticlockwise" aria-label="Turn 90° anticlockwise">&#8634;</button>
      <input class="shape-pop-number" type="number" step="any" inputmode="decimal" data-shape-rot-value aria-label="Angle in degrees" title="Any angle, in degrees, anticlockwise"><span class="shape-pop-unit">&#176;</span>
      <button type="button" class="shape-pop-seg" data-shape-rotate-by="-90" title="Turn 90° clockwise" aria-label="Turn 90° clockwise">&#8635;</button>
      <button type="button" class="shape-pop-seg" data-shape-rotate-reset title="Upright again" aria-label="Upright again">0&#176;</button>`;

function railPanelHtml() {
  return `
    ${panelRow("", "Colour", shapeSwatchRow("stroke"), "Line colour")}
    ${panelRow("width", "Width", WIDTH_INNER)}
    ${panelRow("", "Opacity", OPACITY_INNER)}
    ${panelRow("dash", "Line", DASH_INNER, "Line style")}
    ${panelRow("route", "Route", ROUTE_INNER, "Route")}
    ${panelRow("heads", "Start", HEAD_START_INNER, "Start")}
    ${panelRow("heads", "End", HEAD_END_INNER, "End")}
    ${panelRow("fill", "Fill", shapeSwatchRow("fill", { none: true }), "Fill")}
    ${panelRow("font", "Text", SIZE_INNER + BOLD_BUTTON + ALIGN_INNER, "Text")}
    ${panelRow("wrap", "Box", WRAP_INNER, "Box")}
    ${panelRow("edge", "Border", shapeSwatchRow("edge"), "Border colour")}
    ${panelRow("rotate", "Rotate", ROTATE_INNER, "Rotate")}
    <div class="shape-pop-row" data-shape-row="snap"><button type="button" class="shape-pop-seg" data-shape-snap aria-pressed="false" title="Snap — lines at 15° steps, boxes square and ellipses round (Shift does this for one drag)">Snap angles</button></div>`;
}

// ── The floating bar ──────────────────────────────────────────────────────
//
// At a shape on the page the panel is not laid out at all: one slim row of
// icons, each opening a small tray of its own controls, one tray at a time.
// "The styling options are too obtrusive, overshadowing the text — a compact,
// minimal option UI." Each icon wears what it sets: the colour's dot, the
// size's number, the alignment's lines, the fill's square.

// Which rows each tray shows. `actions` is the popover's own row (Edit text,
// Note, the menu) — pdf-shape-style-popover.js puts it in the tray box.
export const SHAPE_TRAYS = {
  colour: ["colour", "opacity"],
  size: ["size"],
  align: ["align"],
  box: ["fill", "wrap", "edge", "width", "dash"],
  fill: ["fill"],
  line: ["width", "dash"],
  heads: ["heads"],
  route: ["route"],
  rotate: ["rotate"],
  more: ["actions"]
};

// A press in one of these trays is the whole choice: it shuts behind it.
const ONE_TAP_TRAYS = new Set(["colour", "align", "fill", "route"]);

const BAR_ICON = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ALIGN_ICON_PATHS = {
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10"
};

function alignIcon(align) {
  return `<svg ${BAR_ICON}><path d="${ALIGN_ICON_PATHS[align] || ALIGN_ICON_PATHS.left}"/></svg>`;
}

export const SHAPE_BAR_ICONS = {
  box: `<svg ${BAR_ICON}><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>`,
  line: `<svg ${BAR_ICON}><path d="M4 6h16" stroke-width="1.2"/><path d="M4 12h16" stroke-width="2.4"/><path d="M4 18h16" stroke-width="2.4" stroke-dasharray="3 3"/></svg>`,
  heads: `<svg ${BAR_ICON}>${SHAPE_ICONS.arrow}</svg>`,
  route: `<svg ${BAR_ICON}><path d="M4 18h7V6h9"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/><circle cx="20" cy="6" r="1.6" fill="currentColor"/></svg>`,
  rotate: `<svg ${BAR_ICON}><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/></svg>`,
  trash: `<svg ${BAR_ICON}><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>`,
  done: `<svg ${BAR_ICON}><path d="M5 12.5l4.5 4.5L19 7"/></svg>`
};

function barTrigger(tray, label, face) {
  return `<button type="button" class="shape-bar-btn" data-shape-tray="${tray}" title="${label}" aria-label="${label}" aria-haspopup="true" aria-expanded="false">${face}</button>`;
}

function floatingPanelHtml() {
  return `
    <div class="shape-bar" role="toolbar" aria-label="Style">
      ${barTrigger("colour", "Colour and opacity", '<span class="shape-bar-dot" data-shape-colour-face></span>')}
      ${barTrigger("size", "Text size", '<span class="shape-bar-num" data-shape-size-face></span>')}
      <button type="button" class="shape-bar-btn" data-shape-bold title="Bold" aria-label="Bold" aria-pressed="false"><b>B</b></button>
      ${barTrigger("align", "Alignment", `<span class="shape-bar-glyph" data-shape-align-face>${alignIcon("left")}</span>`)}
      ${barTrigger("box", "Box — background, wrapping, border", SHAPE_BAR_ICONS.box)}
      ${barTrigger("fill", "Fill", '<span class="shape-bar-fill" data-shape-fill-face></span>')}
      ${barTrigger("line", "Line — width and style", SHAPE_BAR_ICONS.line)}
      ${barTrigger("heads", "Arrow heads", SHAPE_BAR_ICONS.heads)}
      ${barTrigger("route", "Route — straight, square corners or curved", SHAPE_BAR_ICONS.route)}
      ${barTrigger("rotate", "Rotate", SHAPE_BAR_ICONS.rotate)}
      <span class="shape-bar-end" data-shape-bar-end></span>
    </div>
    <div class="shape-sheet" hidden>
      ${panelRow("colour", "Colour", shapeSwatchRow("stroke"), "Colour")}
      ${panelRow("opacity", "Opacity", OPACITY_INNER)}
      ${panelRow("size", "Size", SIZE_INNER, "Text size")}
      ${panelRow("align", "Align", ALIGN_INNER, "Alignment")}
      ${panelRow("fill", "Fill", shapeSwatchRow("fill", { none: true }), "Fill")}
      ${panelRow("wrap", "Box", WRAP_INNER, "Box")}
      ${panelRow("edge", "Border", shapeSwatchRow("edge"), "Border colour")}
      ${panelRow("width", "Width", WIDTH_INNER)}
      ${panelRow("dash", "Line", DASH_INNER, "Line style")}
      ${panelRow("heads", "Start", HEAD_START_INNER, "Start")}
      ${panelRow("heads", "End", HEAD_END_INNER, "End")}
      ${panelRow("route", "Route", ROUTE_INNER, "Route")}
      ${panelRow("rotate", "Rotate", ROTATE_INNER, "Rotate")}
    </div>`;
}

// The tray open in a floating panel, or null for none — the bar alone.
export function shapeTray(section) {
  return section?.dataset.shapeTray || null;
}

export function setShapeTray(section, tray) {
  if (!section) return;
  if (tray && SHAPE_TRAYS[tray]) section.dataset.shapeTray = tray;
  else delete section.dataset.shapeTray;
  refreshShapePanel(section);
}

// One press inside the panel. A press on the popover's own actions is left to
// it (src/documents/pdf-shape-style-popover.js), so it is not stopped here.
function pressInPanel(section, event) {
  const button = event.target.closest("button");
  if (!button || !section.contains(button) || button.dataset.shapeStyleAction) return;
  event.preventDefault();
  event.stopPropagation();
  if (button.dataset.shapeTray) {
    const tray = button.dataset.shapeTray;
    setShapeTray(section, shapeTray(section) === tray ? null : tray);
    return;
  }
  pressShapePanel(button);
  const tray = shapeTray(section);
  const oneTap = button.dataset.shapeStroke || button.dataset.shapeAlign || button.dataset.shapeRoute || (tray === "fill" && button.dataset.shapeFill);
  if (tray && ONE_TAP_TRAYS.has(tray) && oneTap) delete section.dataset.shapeTray;
  refreshShapePanel(section);
}

// Built twice: as a section of the pen's panel (the rail's chip opens it), and
// `floating` — the bar in the style popover at a selected shape (src/documents/
// pdf-shape-style-popover.js), which has no Snap row, since snapping is how the
// NEXT shape is drawn and not something a shape on the page has.
export function buildShapePanel(shapePopover, { floating = false } = {}) {
  if (!shapePopover || (!floating && shapePopover.querySelector('[data-ink-panel="shape"]'))) return null;
  const section = document.createElement("section");
  section.className = `ink-pop-panel shape-pop-panel${floating ? " is-floating" : ""}`;
  if (!floating) section.dataset.inkPanel = "shape";
  section.setAttribute("aria-label", "Shape");
  section.hidden = !floating;
  section.innerHTML = floating ? floatingPanelHtml() : railPanelHtml();
  shapePopover.appendChild(section);

  section.addEventListener("pointerdown", (event) => pressInPanel(section, event));
  // The keyboard's own press — a click with no pointer behind it.
  section.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    pressInPanel(section, event);
  });
  // A drag previews its number; the release commits, once.
  section.addEventListener("input", (event) => {
    const input = event.target;
    if (input.matches("[data-shape-width]")) section.querySelector("[data-shape-width-value]").value = formatPoints(widthFromSlider(Number(input.value)));
    else if (input.matches("[data-shape-opacity]")) section.querySelector("[data-shape-opacity-value]").textContent = `${input.value}%`;
  });
  section.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-shape-width]")) setShapeSettings({ [widthKey()]: widthFromSlider(Number(input.value)) });
    // The typed boxes: any positive number, applied as typed (see
    // positiveNumber in src/render/annot-shapes.js). Something that is not a
    // size — empty, 0, "abc" — is refused here rather than handed on, and the
    // box goes back to the value the shape actually has.
    else if (input.matches("[data-shape-width-value]")) {
      const width = typedPoints(input.value);
      if (width !== null) setShapeSettings({ [widthKey()]: width });
    } else if (input.matches("[data-shape-font-value]")) {
      const fontSize = typedPoints(input.value);
      if (fontSize !== null) setShapeSettings({ fontSize });
    }
    else if (input.matches("[data-shape-opacity]")) setShapeSettings({ opacity: Number(input.value) / 100 });
    else if (input.matches("[data-shape-stroke-custom]")) {
      const type = panelShapeType();
      setShapeSettings({ [type === "text" ? "textColor" : type === "sticky" ? "stickyColor" : "stroke"]: input.value });
      rememberInkRecentColor(input.value);
    }
    else if (input.matches("[data-shape-fill-custom]")) { setShapeSettings({ fill: input.value }); rememberInkRecentColor(input.value); }
    else if (input.matches("[data-shape-edge-custom]")) { setShapeSettings({ textBorderColor: input.value }); rememberInkRecentColor(input.value); }
    else if (input.matches("[data-shape-rot-value]")) {
      const deg = typedDegrees(input.value);
      if (deg !== null) setShapeRotation(deg);
    }
    else return;
    refreshShapePanel(section);
  });
  return section;
}

// The type the panel is about: the selected shape's (or the one being typed
// in), or the armed one's.
function panelShapeType() {
  return targetShapeRecord()?.shape?.type || shapeType();
}

// The width row is the line's — or, for typed text, its border's, kept apart
// from an arrow's (textBorderWidth).
function widthKey() {
  return panelShapeType() === "text" ? "textBorderWidth" : "width";
}

// The turn of the shape the panel is about, or null when there is none to turn.
function panelShapeRotation() {
  const shape = normalizeShape(targetShapeRecord()?.shape);
  return shape && SHAPE_ROTATABLE.includes(shape.type) ? (shape.rot || 0) : null;
}

function pressShapePanel(button) {
  const data = button.dataset;
  const s = displayedShapeSettings();
  const type = panelShapeType();
  // The colour row is the line's — or, for typed text and a sticky note, their
  // own colour (textColor, stickyColor), kept apart from the line's.
  const colourKey = type === "text" ? "textColor" : type === "sticky" ? "stickyColor" : "stroke";
  if (data.shapeStroke) setShapeSettings({ [colourKey]: data.shapeStroke });
  else if (data.shapeFill) setShapeSettings({ fill: data.shapeFill === "none" ? null : data.shapeFill });
  else if (data.shapeDash) setShapeSettings({ dash: data.shapeDash });
  else if (data.shapeRoute) setShapeSettings({ route: data.shapeRoute });
  else if (data.shapeHeadStart || data.shapeHeadEnd) {
    const headsType = s.heads[type] ? type : "arrow";
    const pair = [...s.heads[headsType]];
    if (data.shapeHeadStart) pair[0] = data.shapeHeadStart;
    else pair[1] = data.shapeHeadEnd;
    setShapeSettings({ heads: { [headsType]: pair } });
  } else if (data.shapeFontStep) {
    const step = Number(data.shapeFontStep);
    setShapeSettings({ fontSize: steppedFontSize(s.fontSize, step) });
  } else if ("shapeBold" in data) setShapeSettings({ bold: !s.bold });
  else if (data.shapeAlign) setShapeSettings({ align: data.shapeAlign });
  else if ("shapeSnap" in data) setShapeSettings({ snap: !s.snap });
  else if (data.shapeWrap) setShapeSettings({ wrap: data.shapeWrap === "on" });
  else if ("shapeBorder" in data) setShapeSettings({ textBorder: !s.textBorder });
  else if (data.shapeEdge) setShapeSettings({ textBorderColor: data.shapeEdge });
  else if (data.shapeRotateBy) rotateShapeBy(Number(data.shapeRotateBy));
  else if ("shapeRotateReset" in data) setShapeRotation(0);
}

export function refreshShapePanel(section) {
  if (!section) return;
  const s = displayedShapeSettings();
  const type = panelShapeType();
  const markPressed = (selector, on) => section.querySelectorAll(selector).forEach((node) => node.setAttribute("aria-pressed", String(on(node))));
  const colour = type === "text" ? s.textColor : type === "sticky" ? s.stickyColor : s.stroke;
  markPressed("[data-shape-stroke]", (n) => n.dataset.shapeStroke === colour);
  markPressed("[data-shape-fill]", (n) => (n.dataset.shapeFill === "none" ? !s.fill : n.dataset.shapeFill === s.fill));
  markPressed("[data-shape-dash]", (n) => n.dataset.shapeDash === s.dash);
  markPressed("[data-shape-route]", (n) => n.dataset.shapeRoute === s.route);
  const heads = s.heads[type] || s.heads.arrow;
  markPressed("[data-shape-head-start]", (n) => n.dataset.shapeHeadStart === heads[0]);
  markPressed("[data-shape-head-end]", (n) => n.dataset.shapeHeadEnd === heads[1]);
  markPressed("[data-shape-bold]", () => s.bold);
  markPressed("[data-shape-align]", (n) => n.dataset.shapeAlign === s.align);
  markPressed("[data-shape-snap]", () => s.snap);
  markPressed("[data-shape-wrap]", (n) => (n.dataset.shapeWrap === "on") === s.wrap);
  markPressed("[data-shape-border]", () => s.textBorder);
  markPressed("[data-shape-edge]", (n) => n.dataset.shapeEdge === s.textBorderColor);
  const lineWidth = type === "text" ? s.textBorderWidth : s.width;
  const width = section.querySelector("[data-shape-width]");
  if (width && document.activeElement !== width) width.value = String(sliderFromWidth(lineWidth));
  setNumberBox(section.querySelector("[data-shape-width-value]"), lineWidth);
  const edge = section.querySelector("[data-shape-edge-custom]");
  if (edge && document.activeElement !== edge) edge.value = s.textBorderColor;
  const rotation = panelShapeRotation();
  const rotBox = section.querySelector("[data-shape-rot-value]");
  if (rotBox && document.activeElement !== rotBox) rotBox.value = String(rotation || 0);
  const opacity = section.querySelector("[data-shape-opacity]");
  if (opacity && document.activeElement !== opacity) opacity.value = String(Math.round(s.opacity * 100));
  section.querySelector("[data-shape-opacity-value]").textContent = `${Math.round(s.opacity * 100)}%`;
  setNumberBox(section.querySelector("[data-shape-font-value]"), s.fontSize);
  const stroke = section.querySelector("[data-shape-stroke-custom]");
  if (stroke && document.activeElement !== stroke) stroke.value = colour;
  // Only the rows this shape has. A line has no fill and no text; a box has no
  // heads; free text has no line to dash and no heads unless it has a border;
  // a sticky note is a colour and nothing else. Rotate is for a box that is ON
  // the page — a turn belongs to one shape, never to the next one drawn.
  const textLine = type !== "text" || s.textBorder;
  const floating = section.classList.contains("is-floating");
  const font = type === "callout" || type === "text";
  const rows = {
    colour: true,
    opacity: true,
    width: type !== "sticky" && textLine,
    dash: type !== "sticky" && textLine,
    wrap: type === "text",
    edge: type === "text" && s.textBorder,
    rotate: rotation !== null,
    heads: type === "line" || type === "arrow" || type === "callout",
    route: type === "line" || type === "arrow",
    fill: type === "rect" || type === "ellipse" || type === "callout" || type === "text",
    font,
    size: font,
    align: font,
    actions: true,
    snap: !floating
  };
  if (!floating) {
    section.querySelectorAll("[data-shape-row]").forEach((row) => { row.hidden = !rows[row.dataset.shapeRow]; });
    return;
  }
  // The bar: the icons this shape has. Typed text keeps its background, its
  // wrapping and its border together under Box; a box or a callout has Fill and
  // Line of its own.
  const triggers = {
    colour: true,
    size: font,
    align: font,
    box: type === "text",
    fill: rows.fill && type !== "text",
    line: rows.width && type !== "text",
    heads: rows.heads,
    route: rows.route,
    rotate: rows.rotate
  };
  let tray = shapeTray(section);
  // A tray this shape has no icon for (the popover's own `more` aside) is shut.
  if (tray && tray !== "more" && !triggers[tray]) { delete section.dataset.shapeTray; tray = null; }
  section.querySelectorAll("[data-shape-tray]").forEach((button) => {
    const name = button.dataset.shapeTray;
    button.hidden = name in triggers ? !triggers[name] : false;
    button.setAttribute("aria-expanded", String(name === tray));
  });
  const bold = section.querySelector(".shape-bar [data-shape-bold]");
  if (bold) bold.hidden = !font;
  const inTray = new Set(tray ? SHAPE_TRAYS[tray] : []);
  section.querySelectorAll("[data-shape-row]").forEach((row) => {
    const key = row.dataset.shapeRow;
    row.hidden = !rows[key] || !inTray.has(key);
  });
  const trayBox = section.querySelector(".shape-sheet");
  if (trayBox) {
    trayBox.hidden = !tray;
    if (tray) trayBox.dataset.tray = tray;
    else delete trayBox.dataset.tray;
  }
  // What each icon wears.
  const dot = section.querySelector("[data-shape-colour-face]");
  if (dot) dot.style.background = colour;
  const sizeFace = section.querySelector("[data-shape-size-face]");
  if (sizeFace) sizeFace.textContent = formatPoints(s.fontSize);
  const alignFace = section.querySelector("[data-shape-align-face]");
  if (alignFace && alignFace.dataset.align !== s.align) {
    alignFace.dataset.align = s.align;
    alignFace.innerHTML = alignIcon(s.align);
  }
  const fillFace = section.querySelector("[data-shape-fill-face]");
  if (fillFace) {
    fillFace.classList.toggle("is-none", !s.fill);
    fillFace.style.background = s.fill || "";
  }
}
