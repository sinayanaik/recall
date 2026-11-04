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
import { SHAPE_HEADS, SHAPE_LABELS, SHAPE_WIDTH_RANGE } from "../render/annot-shapes.js?v=__BUILD__";
import { rememberInkRecentColor } from "../storage/ink-prefs.js?v=__BUILD__";
import { currentShapeSettings, selectedShapeRecord, setShapeSettings, shapeType } from "./pdf-shapes.js?v=__BUILD__";

// The shapes the flyout offers, in its order.
export const SHAPE_MENU_TYPES = ["line", "arrow", "rect", "ellipse", "callout", "text", "sticky"];

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
  const type = shapeType();
  menu?.querySelectorAll("[data-shape-type]").forEach((item) => {
    const on = item.dataset.shapeType === type;
    item.classList.toggle("is-current", on);
    item.setAttribute("aria-checked", String(on));
  });
  if (button && button.dataset.shapeIcon !== type) {
    button.dataset.shapeIcon = type;
    button.innerHTML = shapeIconSvg(type);
    const label = `Shapes: ${SHAPE_LABELS[type]} — press again to pick a line, arrow, box, ellipse, callout, text or sticky note`;
    button.title = label;
    button.setAttribute("aria-label", `Shapes (${SHAPE_LABELS[type]})`);
  }
}

// ── The panel ─────────────────────────────────────────────────────────────

const HEAD_LABELS = { none: "None", open: "Open", filled: "Filled", dot: "Dot", bar: "Bar" };
const DASH_LABELS = { solid: "Solid", dash: "Dashed", dot: "Dotted" };

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

export function buildShapePanel(shapePopover) {
  if (!shapePopover || shapePopover.querySelector('[data-ink-panel="shape"]')) return null;
  const section = document.createElement("section");
  section.className = "ink-pop-panel shape-pop-panel";
  section.dataset.inkPanel = "shape";
  section.setAttribute("aria-label", "Shape");
  section.hidden = true;
  section.innerHTML = `
    <div class="shape-pop-row" role="group" aria-label="Line colour"><span class="shape-pop-label">Colour</span>${shapeSwatchRow("stroke")}</div>
    <div class="shape-pop-row" data-shape-row="width"><span class="shape-pop-label">Width</span>
      <input class="shape-pop-slider" type="range" min="0" max="${SHAPE_SLIDER_STEPS}" step="1" data-shape-width aria-label="Line width">
      <output class="shape-pop-value" data-shape-width-value></output></div>
    <div class="shape-pop-row"><span class="shape-pop-label">Opacity</span>
      <input class="shape-pop-slider" type="range" min="10" max="100" step="1" data-shape-opacity aria-label="Opacity">
      <output class="shape-pop-value" data-shape-opacity-value></output></div>
    <div class="shape-pop-row" role="group" aria-label="Line style" data-shape-row="dash"><span class="shape-pop-label">Line</span>
      ${["solid", "dash", "dot"].map((d) => `<button type="button" class="shape-pop-seg" data-shape-dash="${d}" title="${DASH_LABELS[d]}" aria-label="${DASH_LABELS[d]}" aria-pressed="false">${dashIcon(d)}</button>`).join("")}</div>
    <div class="shape-pop-row" role="group" aria-label="Start" data-shape-row="heads"><span class="shape-pop-label">Start</span>
      ${SHAPE_HEADS.map((h) => `<button type="button" class="shape-pop-seg" data-shape-head-start="${h}" title="Start: ${HEAD_LABELS[h]}" aria-label="Start: ${HEAD_LABELS[h]}" aria-pressed="false">${headIcon(h, "start")}</button>`).join("")}</div>
    <div class="shape-pop-row" role="group" aria-label="End" data-shape-row="heads"><span class="shape-pop-label">End</span>
      ${SHAPE_HEADS.map((h) => `<button type="button" class="shape-pop-seg" data-shape-head-end="${h}" title="End: ${HEAD_LABELS[h]}" aria-label="End: ${HEAD_LABELS[h]}" aria-pressed="false">${headIcon(h, "end")}</button>`).join("")}</div>
    <div class="shape-pop-row" role="group" aria-label="Fill" data-shape-row="fill"><span class="shape-pop-label">Fill</span>${shapeSwatchRow("fill", { none: true })}</div>
    <div class="shape-pop-row" role="group" aria-label="Text" data-shape-row="font"><span class="shape-pop-label">Text</span>
      <button type="button" class="shape-pop-seg" data-shape-font-step="-1" title="Smaller text" aria-label="Smaller text">A&#8722;</button>
      <output class="shape-pop-value" data-shape-font-value></output>
      <button type="button" class="shape-pop-seg" data-shape-font-step="1" title="Larger text" aria-label="Larger text">A+</button>
      <button type="button" class="shape-pop-seg" data-shape-bold title="Bold" aria-label="Bold" aria-pressed="false"><b>B</b></button>
      ${["left", "center", "right"].map((a) => `<button type="button" class="shape-pop-seg" data-shape-align="${a}" title="Align ${a}" aria-label="Align ${a}" aria-pressed="false">${{ left: "&#8676;", center: "&#8596;", right: "&#8677;" }[a]}</button>`).join("")}</div>
    <div class="shape-pop-row"><button type="button" class="shape-pop-seg" data-shape-snap aria-pressed="false" title="Snap — lines at 15° steps, boxes square and ellipses round (Shift does this for one drag)">Snap angles</button></div>`;
  shapePopover.appendChild(section);

  section.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if (!button || !section.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    pressShapePanel(button);
    refreshShapePanel(section);
  });
  // The keyboard's own press — a click with no pointer behind it.
  section.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const button = event.target.closest("button");
    if (!button || !section.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    pressShapePanel(button);
    refreshShapePanel(section);
  });
  // A drag previews its number; the release commits, once.
  section.addEventListener("input", (event) => {
    const input = event.target;
    if (input.matches("[data-shape-width]")) section.querySelector("[data-shape-width-value]").textContent = `${widthFromSlider(Number(input.value)).toFixed(1)} pt`;
    else if (input.matches("[data-shape-opacity]")) section.querySelector("[data-shape-opacity-value]").textContent = `${input.value}%`;
  });
  section.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-shape-width]")) setShapeSettings({ width: widthFromSlider(Number(input.value)) });
    else if (input.matches("[data-shape-opacity]")) setShapeSettings({ opacity: Number(input.value) / 100 });
    else if (input.matches("[data-shape-stroke-custom]")) { setShapeSettings({ stroke: input.value }); rememberInkRecentColor(input.value); }
    else if (input.matches("[data-shape-fill-custom]")) { setShapeSettings({ fill: input.value }); rememberInkRecentColor(input.value); }
    else return;
    refreshShapePanel(section);
  });
  return section;
}

// The type the panel is about: the selected shape's, or the armed one's.
function panelShapeType() {
  return selectedShapeRecord()?.shape?.type || shapeType();
}

function pressShapePanel(button) {
  const data = button.dataset;
  const s = currentShapeSettings();
  const type = panelShapeType();
  if (data.shapeStroke) setShapeSettings({ stroke: data.shapeStroke });
  else if (data.shapeFill) setShapeSettings({ fill: data.shapeFill === "none" ? null : data.shapeFill });
  else if (data.shapeDash) setShapeSettings({ dash: data.shapeDash });
  else if (data.shapeHeadStart || data.shapeHeadEnd) {
    const headsType = s.heads[type] ? type : "arrow";
    const pair = [...s.heads[headsType]];
    if (data.shapeHeadStart) pair[0] = data.shapeHeadStart;
    else pair[1] = data.shapeHeadEnd;
    setShapeSettings({ heads: { [headsType]: pair } });
  } else if (data.shapeFontStep) {
    const step = Number(data.shapeFontStep);
    const size = Math.max(5, Math.min(96, Math.round(s.fontSize + step * (s.fontSize >= 20 ? 2 : 1))));
    setShapeSettings({ fontSize: size });
  } else if ("shapeBold" in data) setShapeSettings({ bold: !s.bold });
  else if (data.shapeAlign) setShapeSettings({ align: data.shapeAlign });
  else if ("shapeSnap" in data) setShapeSettings({ snap: !s.snap });
}

export function refreshShapePanel(section) {
  if (!section) return;
  const s = currentShapeSettings();
  const type = panelShapeType();
  const markPressed = (selector, on) => section.querySelectorAll(selector).forEach((node) => node.setAttribute("aria-pressed", String(on(node))));
  markPressed("[data-shape-stroke]", (n) => n.dataset.shapeStroke === s.stroke);
  markPressed("[data-shape-fill]", (n) => (n.dataset.shapeFill === "none" ? !s.fill : n.dataset.shapeFill === s.fill));
  markPressed("[data-shape-dash]", (n) => n.dataset.shapeDash === s.dash);
  const heads = s.heads[type] || s.heads.arrow;
  markPressed("[data-shape-head-start]", (n) => n.dataset.shapeHeadStart === heads[0]);
  markPressed("[data-shape-head-end]", (n) => n.dataset.shapeHeadEnd === heads[1]);
  markPressed("[data-shape-bold]", () => s.bold);
  markPressed("[data-shape-align]", (n) => n.dataset.shapeAlign === s.align);
  markPressed("[data-shape-snap]", () => s.snap);
  const width = section.querySelector("[data-shape-width]");
  if (width && document.activeElement !== width) width.value = String(sliderFromWidth(s.width));
  section.querySelector("[data-shape-width-value]").textContent = `${s.width.toFixed(1)} pt`;
  const opacity = section.querySelector("[data-shape-opacity]");
  if (opacity && document.activeElement !== opacity) opacity.value = String(Math.round(s.opacity * 100));
  section.querySelector("[data-shape-opacity-value]").textContent = `${Math.round(s.opacity * 100)}%`;
  section.querySelector("[data-shape-font-value]").textContent = `${s.fontSize} pt`;
  const stroke = section.querySelector("[data-shape-stroke-custom]");
  if (stroke && document.activeElement !== stroke) stroke.value = s.stroke;
  // Only the rows this shape has. A line has no fill and no text; a box has no
  // heads; free text has no line to dash and no heads; a sticky note is a
  // colour and nothing else.
  const rows = {
    width: type !== "sticky" && type !== "text",
    dash: type !== "sticky" && type !== "text",
    heads: type === "line" || type === "arrow" || type === "callout",
    fill: type === "rect" || type === "ellipse" || type === "callout" || type === "text",
    font: type === "callout" || type === "text"
  };
  section.querySelectorAll("[data-shape-row]").forEach((row) => { row.hidden = !rows[row.dataset.shapeRow]; });
}
