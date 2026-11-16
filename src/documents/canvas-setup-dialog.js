// ⋯ → Canvas pages → Page setup…: a Canvas page's size, paper and lines.
//
// The numbers are src/documents/canvas-setup.js (pure, checked in Node by
// tools/canvas-setup-check.mjs); the writing is setNotebookPageSetup in
// src/documents/notebook.js. This is the dialog between them: one page or every
// page, a live picture of the page, and every setting a paper template has —
// size and orientation, the pattern, the paper's colour, the lines' spacing,
// colour, strength, width and style, the heavier grid lines, the dots, the
// margin line, the Cornell columns and the margins the pattern is drawn inside.
//
// ── The model is in points, and only what is touched changes ───────────────
//
// The fields show millimetres or inches, but the model is the setup itself, in
// points, and an input writes only its own field. Re-reading every field on
// Apply would round each untouched value through the unit and back — the first
// ruled paper's 56pt margin is 19.8mm, which is 56.13pt — and a page whose
// lines had moved by a tenth of a point would no longer be the first paper, so
// its file would change for nothing (canvas-setup.js, sheetLegacyKind).
//
// The same dialog starts a Canvas (`create`): the Canvas tab's "Page setup…"
// before there are any pages, where Apply reads "Start the Canvas".

import {
  SHEET_DASHES,
  SHEET_DASH_LABEL,
  SHEET_LINE_COLORS,
  SHEET_MARGIN_COLORS,
  SHEET_PAPER_COLORS,
  SHEET_PATTERNS,
  SHEET_PATTERN_LABEL,
  SHEET_PT_PER_IN,
  SHEET_PT_PER_MM,
  SHEET_SIZES,
  SHEET_SIZE_CUSTOM,
  SHEET_SPACING_PRESETS,
  lightSheetPaper,
  legacySheetSetup,
  normalizeSheetSetup,
  sheetBox,
  sheetPatternDefaults,
  sheetSizeById,
  sheetSvg
} from "./canvas-setup.js?v=__BUILD__";
import {
  hasNotebook,
  notebookCanvasSetup,
  notebookPageBoxes,
  notebookPageCount,
  notebookPageHasOwnSetup,
  notebookPageNumbers,
  notebookPageSetup,
  setNotebookPageNumbers,
  setNotebookPageSetup
} from "./notebook.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { marksOffPage } from "./pdf-margins.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
import { notebookPaperPreference, notebookSetupPreference, writeNotebookSetupPreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

// The preview: the whole page inside this box, and a close-up of its top-left
// corner at about the size it is written on.
const SETUP_PREVIEW_BOX = { w: 150, h: 196 };
const SETUP_CLOSE_UP_PT = { w: 170, h: 128 };
const SETUP_CLOSE_UP_SCALE = 1.25;

// The pattern chips' pictures: each pattern on a little page of its own, with
// lines spaced so they read at 26px.
const SETUP_PATTERN_ICONS = {
  blank: { pattern: "blank", w: 145, h: 200 },
  ruled: { pattern: "ruled", w: 145, h: 200, pitch: 24, opacity: 0.55, margins: { top: 24, right: 10, bottom: 0, left: 32 } },
  grid: { pattern: "grid", w: 145, h: 200, pitch: 24, opacity: 0.5, majorEvery: 0 },
  dots: { pattern: "dots", w: 145, h: 200, pitch: 24, dot: 4, opacity: 0.8 },
  cornell: { pattern: "cornell", w: 145, h: 200, pitch: 20, opacity: 0.45, majorOpacity: 0.9, margins: { top: 30, right: 0, bottom: 0, left: 0 }, cue: 46, summary: 44 }
};

const SETUP_MARGIN_SIDES = ["top", "bottom", "left", "right"];
const SETUP_MARGIN_LABEL = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" };

// What the margins mean on each paper, said under them.
const SETUP_MARGIN_NOTE = {
  ruled: "Top is the space above the first line; the margin line is drawn at Left.",
  grid: "The squares stop this far from each edge.",
  dots: "The dots stop this far from each edge.",
  cornell: "Top is the title band; the columns and lines fill the rest."
};

// The unit the lengths are shown in, kept for the session.
let setupLengthUnit = "mm";

let setupDialog = null;
let setupModel = null;
let setupBusy = false;

function setupAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// A length as the field shows it. Millimetres within a fifth of a whole one
// show whole: A4 is 595pt, which is 209.9mm, and every A4 sheet ever sold says
// 210.
function setupToUnit(pt) {
  if (setupLengthUnit === "in") return String(Math.round((pt / SHEET_PT_PER_IN) * 100) / 100);
  const mm = pt / SHEET_PT_PER_MM;
  if (Math.abs(mm - Math.round(mm)) <= 0.2) return String(Math.round(mm));
  return String(Math.round(mm * 10) / 10);
}

// A width or height typed to within a hair of a size's own — "210" for A4's
// 595pt — is that size's, exactly, so A4 typed is the A4 every page already is.
function setupSnapDimension(pt) {
  for (const size of SHEET_SIZES) {
    for (const side of [size.w, size.h]) {
      if (Math.abs(side - pt) < 0.75) return side;
    }
  }
  return pt;
}

function setupFromUnit(text) {
  const value = Number(String(text).replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return setupLengthUnit === "in" ? value * SHEET_PT_PER_IN : value * SHEET_PT_PER_MM;
}

function setupSizeNote(setup) {
  const w = setup.w / SHEET_PT_PER_MM;
  const h = setup.h / SHEET_PT_PER_MM;
  const inches = `${Math.round((setup.w / 72) * 100) / 100} × ${Math.round((setup.h / 72) * 100) / 100} in`;
  const turn = setup.w > setup.h ? "Landscape" : (setup.w === setup.h ? "Square" : "Portrait");
  return `${Math.round(w)} × ${Math.round(h)} mm · ${inches} · ${turn}`;
}

// ── Building ───────────────────────────────────────────────────────────────

function setupSwatchRow(name, colors, label) {
  const swatches = colors.map((color) => (
    `<button type="button" class="canvas-setup-swatch" data-cs-${name}="${color.hex}" aria-pressed="false" title="${setupAttr(color.label)}" aria-label="${setupAttr(color.label)}" style="--cs-swatch:${color.hex}"></button>`
  )).join("");
  return `<div class="canvas-setup-swatches" role="group" aria-label="${setupAttr(label)}">${swatches}`
    + `<label class="canvas-setup-swatch is-custom" title="Another colour"><span class="canvas-setup-visually-hidden">Another colour</span>`
    + `<input type="color" data-cs-${name}-custom value="#ffffff"></label></div>`;
}

function setupLengthField(key, label, extra = "") {
  return `<label class="canvas-setup-field"${extra}><span>${label}</span>`
    + `<span class="canvas-setup-input-unit"><input type="number" class="prompt-modal-input" data-cs-len="${key}" min="0" step="any" inputmode="decimal">`
    + `<span class="canvas-setup-unit" data-cs-unit-label></span></span></label>`;
}

function setupRangeField(key, label, { min, max, step }, extra = "") {
  return `<label class="canvas-setup-field canvas-setup-range"${extra}><span>${label} <output data-cs-out="${key}"></output></span>`
    + `<input type="range" data-cs-range="${key}" min="${min}" max="${max}" step="${step}"></label>`;
}

function setupSwitchRow(key, label, hint, extra = "") {
  return `<button type="button" class="canvas-setup-switch" data-cs-toggle="${key}" role="switch" aria-checked="false"${extra}>`
    + `<span class="canvas-setup-switch-text"><span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</span>`
    + `<span class="nhm-switch" aria-hidden="true"></span></button>`;
}

function buildCanvasSetupDialog() {
  const section = document.createElement("section");
  section.className = "confirm-modal canvas-setup-modal";
  section.id = "canvasSetupModal";
  section.hidden = true;
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-modal", "true");
  section.setAttribute("aria-labelledby", "canvasSetupTitle");
  const sizes = SHEET_SIZES.map((size) => `<option value="${size.id}">${setupAttr(size.label)} — ${setupAttr(size.note)}</option>`).join("")
    + `<option value="${SHEET_SIZE_CUSTOM}">Custom size</option>`;
  const patterns = SHEET_PATTERNS.map((pattern) => (
    `<button type="button" class="canvas-setup-pattern" data-cs-pattern="${pattern}" aria-pressed="false">`
    + `<span class="canvas-setup-pattern-icon" aria-hidden="true">${sheetSvg(SETUP_PATTERN_ICONS[pattern], { minStroke: 5.5 })}</span>`
    + `<span>${SHEET_PATTERN_LABEL[pattern]}</span></button>`
  )).join("");
  const dashes = SHEET_DASHES.map((dash) => (
    `<button type="button" class="canvas-setup-chip" data-cs-dash="${dash}" aria-pressed="false">${SHEET_DASH_LABEL[dash]}</button>`
  )).join("");
  const margins = SETUP_MARGIN_SIDES.map((side) => setupLengthField(side, SETUP_MARGIN_LABEL[side])).join("");
  section.innerHTML = `
    <div class="confirm-modal-content canvas-setup-content">
      <header class="canvas-setup-head">
        <h3 class="prompt-modal-title" id="canvasSetupTitle">Page setup</h3>
        <div class="canvas-setup-seg" role="radiogroup" aria-label="Apply to" data-cs-scope-row>
          <button type="button" role="radio" aria-checked="false" data-cs-scope="page"></button>
          <button type="button" role="radio" aria-checked="false" data-cs-scope="all">All pages</button>
        </div>
      </header>
      <div class="canvas-setup-body">
        <div class="canvas-setup-preview" aria-hidden="true">
          <div class="canvas-setup-page-frame"><div class="canvas-setup-page" data-cs-preview></div></div>
          <div class="canvas-setup-zoom-frame"><div class="canvas-setup-zoom" data-cs-zoom></div><span>Close-up</span></div>
          <p class="canvas-setup-size-note" data-cs-size-note></p>
        </div>
        <div class="canvas-setup-fields">
          <p class="canvas-setup-own" data-cs-own hidden>This page has its own setup. <button type="button" class="canvas-setup-link" data-cs-action="follow">Use the Canvas's setup</button></p>
          <fieldset class="canvas-setup-group">
            <legend>Size</legend>
            <label class="canvas-setup-field is-wide"><span>Page size</span>
              <select class="prompt-modal-input" data-cs-size>${sizes}</select></label>
            <div class="canvas-setup-seg" role="radiogroup" aria-label="Orientation">
              <button type="button" role="radio" aria-checked="false" data-cs-orient="portrait">Portrait</button>
              <button type="button" role="radio" aria-checked="false" data-cs-orient="landscape">Landscape</button>
            </div>
            <div class="canvas-setup-dims">
              ${setupLengthField("w", "Width")}
              <span class="canvas-setup-times" aria-hidden="true">×</span>
              ${setupLengthField("h", "Height")}
              <div class="canvas-setup-seg is-small" role="radiogroup" aria-label="Units">
                <button type="button" role="radio" aria-checked="false" data-cs-unit="mm">mm</button>
                <button type="button" role="radio" aria-checked="false" data-cs-unit="in">in</button>
              </div>
            </div>
          </fieldset>
          <fieldset class="canvas-setup-group">
            <legend>Paper</legend>
            <div class="canvas-setup-patterns" role="group" aria-label="Pattern">${patterns}</div>
            <span class="canvas-setup-label">Paper colour</span>
            ${setupSwatchRow("paper", SHEET_PAPER_COLORS, "Paper colour")}
            <p class="canvas-setup-hint" data-cs-paper-note>Shown on your paper tone (☾ beside the tabs) — on White, exactly these colours. Dark pages come from there.</p>
          </fieldset>
          <fieldset class="canvas-setup-group" data-cs-for="ruled grid dots cornell">
            <legend data-cs-lines-legend>Lines</legend>
            <span class="canvas-setup-label">Spacing</span>
            <div class="canvas-setup-chips" data-cs-spacing-row></div>
            ${setupLengthField("pitch", "Exact spacing")}
            <span class="canvas-setup-label">Colour</span>
            ${setupSwatchRow("line", SHEET_LINE_COLORS, "Line colour")}
            ${setupRangeField("opacity", "Strength", { min: 5, max: 100, step: 1 })}
            ${setupRangeField("width", "Thickness", { min: 0.1, max: 2, step: 0.05 }, ' data-cs-for="ruled grid cornell"')}
            ${setupRangeField("dot", "Dot size", { min: 0.3, max: 4, step: 0.1 }, ' data-cs-for="dots"')}
            <div data-cs-for="ruled grid cornell">
              <span class="canvas-setup-label">Style</span>
              <div class="canvas-setup-chips" role="group" aria-label="Line style">${dashes}</div>
            </div>
            <label class="canvas-setup-field" data-cs-for="grid"><span>Heavier line every</span>
              <span class="canvas-setup-input-unit"><input type="number" class="prompt-modal-input" data-cs-num="majorEvery" min="0" max="20" step="1" inputmode="numeric"><span class="canvas-setup-unit">squares (0 for none)</span></span></label>
            ${setupRangeField("majorOpacity", "Heavier line strength", { min: 5, max: 100, step: 1 }, ' data-cs-for="grid" data-cs-needs-major')}
            ${setupRangeField("majorOpacity", "Divider strength", { min: 5, max: 100, step: 1 }, ' data-cs-for="cornell"')}
            <div class="canvas-setup-pair" data-cs-for="cornell">
              ${setupLengthField("cue", "Cue column")}
              ${setupLengthField("summary", "Summary")}
            </div>
            <div data-cs-for="ruled">
              ${setupSwitchRow("marginLine", "Margin line", "Down the page where the lines start")}
              <div data-cs-margin-colors>${setupSwatchRow("margin", SHEET_MARGIN_COLORS, "Margin line colour")}</div>
            </div>
          </fieldset>
          <fieldset class="canvas-setup-group" data-cs-for="ruled grid dots cornell">
            <legend>Margins</legend>
            <div class="canvas-setup-margins">${margins}</div>
            <p class="canvas-setup-hint" data-cs-margin-note></p>
          </fieldset>
          <fieldset class="canvas-setup-group">
            <legend>Pages</legend>
            ${setupSwitchRow("numbers", "Page numbers", "1 / n at the foot of each page, exported too", " data-cs-not-create")}
            ${setupSwitchRow("remember", "Use for new Canvases", "A new Canvas starts on this setup")}
          </fieldset>
          <p class="canvas-setup-hint">What is written on the page stays where it is. A smaller page hides what falls past its edge until it grows again.</p>
        </div>
      </div>
      <footer class="sync-modal-actions canvas-setup-actions">
        <button type="button" class="sync-modal-btn" data-cs-action="reset" title="This paper's own settings, at this size">Reset</button>
        <span class="canvas-setup-spacer"></span>
        <button type="button" class="sync-modal-btn" data-cs-action="cancel">Cancel</button>
        <button type="button" class="sync-modal-btn is-primary" data-cs-action="apply">Apply</button>
      </footer>
    </div>`;
  document.body.appendChild(section);
  section.addEventListener("click", onCanvasSetupClick);
  section.addEventListener("input", onCanvasSetupInput);
  section.addEventListener("change", onCanvasSetupInput);
  section.addEventListener("keydown", onCanvasSetupKey);
  return section;
}

// ── Painting ───────────────────────────────────────────────────────────────

function setupSetPressed(selector, test) {
  setupDialog.querySelectorAll(selector).forEach((node) => {
    const on = Boolean(test(node));
    if (node.getAttribute("role") === "radio" || node.getAttribute("role") === "switch") node.setAttribute("aria-checked", String(on));
    else node.setAttribute("aria-pressed", String(on));
  });
}

// A field's value, unless the reader is typing in it: rewriting the field under
// the caret would turn "1" on the way to "12" into the clamped minimum.
function setupSetValue(input, value) {
  if (!input || document.activeElement === input) return;
  input.value = value;
}

function paintCanvasSetupPreview(s) {
  const [x0, , , y1] = sheetBox(s);
  const page = setupDialog.querySelector("[data-cs-preview]");
  // As big as its frame allows (the frame is smaller on a phone), at the page's
  // own proportions.
  const frame = page.parentElement;
  const room = {
    w: Math.max(40, (frame?.clientWidth || SETUP_PREVIEW_BOX.w + 20) - 20),
    h: Math.max(50, (frame?.clientHeight || SETUP_PREVIEW_BOX.h + 16) - 16)
  };
  const scale = Math.min(room.w / s.w, room.h / s.h);
  page.style.width = `${Math.round(s.w * scale)}px`;
  page.style.height = `${Math.round(s.h * scale)}px`;
  page.innerHTML = sheetSvg(s, { minStroke: 0.7 / scale });
  const cw = Math.min(SETUP_CLOSE_UP_PT.w, s.w);
  const ch = Math.min(SETUP_CLOSE_UP_PT.h, s.h);
  const zoom = setupDialog.querySelector("[data-cs-zoom]");
  zoom.style.width = `${Math.round(cw * SETUP_CLOSE_UP_SCALE)}px`;
  zoom.style.height = `${Math.round(ch * SETUP_CLOSE_UP_SCALE)}px`;
  zoom.innerHTML = sheetSvg(s, { crop: [x0, y1 - ch, x0 + cw, y1], minStroke: 0.45 / SETUP_CLOSE_UP_SCALE });
  setupDialog.querySelector("[data-cs-size-note]").textContent = setupSizeNote(s);
}

function paintSetupSwatches(name, hex) {
  let matched = false;
  setupDialog.querySelectorAll(`[data-cs-${name}]`).forEach((node) => {
    const on = node.getAttribute(`data-cs-${name}`) === hex;
    matched = matched || on;
    node.setAttribute("aria-pressed", String(on));
  });
  const custom = setupDialog.querySelector(`[data-cs-${name}-custom]`);
  if (custom) {
    setupSetValue(custom, hex);
    custom.closest(".canvas-setup-swatch")?.classList.toggle("is-on", !matched);
    custom.closest(".canvas-setup-swatch")?.style.setProperty("--cs-swatch", hex);
  }
}

function paintCanvasSetupDialog() {
  const s = setupModel.setup;
  const pattern = s.pattern;
  const pages = setupModel.create ? 1 : notebookPageCount();
  const scopeRow = setupDialog.querySelector("[data-cs-scope-row]");
  scopeRow.hidden = setupModel.create || pages < 2;
  setupDialog.querySelector('[data-cs-scope="page"]').textContent = `Page ${setupModel.page}`;
  setupSetPressed("[data-cs-scope]", (node) => node.dataset.csScope === setupModel.scope);
  const own = !setupModel.create && setupModel.scope === "page" && notebookPageHasOwnSetup(setupModel.page);
  setupDialog.querySelector("[data-cs-own]").hidden = !own;

  // Which parts apply to this paper.
  setupDialog.querySelectorAll("[data-cs-for]").forEach((node) => {
    node.hidden = !node.dataset.csFor.split(" ").includes(pattern);
  });
  setupDialog.querySelectorAll("[data-cs-needs-major]").forEach((node) => {
    if (!node.hidden) node.hidden = !s.majorEvery;
  });
  setupDialog.querySelectorAll("[data-cs-not-create]").forEach((node) => { node.hidden = setupModel.create; });
  setupDialog.querySelector("[data-cs-lines-legend]").textContent = pattern === "dots" ? "Dots" : "Lines";

  // Size.
  const sizeSelect = setupDialog.querySelector("[data-cs-size]");
  setupSetValue(sizeSelect, s.size);
  setupSetPressed("[data-cs-orient]", (node) => (s.w === s.h ? false : (node.dataset.csOrient === "landscape") === (s.w > s.h)));
  setupSetPressed("[data-cs-unit]", (node) => node.dataset.csUnit === setupLengthUnit);
  setupDialog.querySelectorAll("[data-cs-unit-label]").forEach((node) => { node.textContent = setupLengthUnit; });
  const len = (key) => setupDialog.querySelector(`[data-cs-len="${key}"]`);
  setupSetValue(len("w"), setupToUnit(s.w));
  setupSetValue(len("h"), setupToUnit(s.h));

  // Paper.
  setupSetPressed("[data-cs-pattern]", (node) => node.dataset.csPattern === pattern);
  paintSetupSwatches("paper", s.paper);

  // Lines.
  const presets = SHEET_SPACING_PRESETS[pattern] || [];
  const spacingRow = setupDialog.querySelector("[data-cs-spacing-row]");
  const wanted = presets.map((preset) => `${preset.label}|${preset.pt}`).join(",");
  if (spacingRow.dataset.for !== wanted) {
    spacingRow.dataset.for = wanted;
    spacingRow.innerHTML = presets.map((preset) => (
      `<button type="button" class="canvas-setup-chip" data-cs-spacing="${preset.pt}" aria-pressed="false">${setupAttr(preset.label)}</button>`
    )).join("");
  }
  setupSetPressed("[data-cs-spacing]", (node) => Math.abs(Number(node.dataset.csSpacing) - s.pitch) < 0.01);
  setupSetValue(len("pitch"), setupToUnit(s.pitch));
  paintSetupSwatches("line", s.line);
  const range = (key) => setupDialog.querySelector(`[data-cs-range="${key}"]`);
  const out = (key, text) => setupDialog.querySelectorAll(`[data-cs-out="${key}"]`).forEach((node) => { node.textContent = text; });
  setupSetValue(range("opacity"), String(Math.round(s.opacity * 100)));
  out("opacity", `${Math.round(s.opacity * 100)}%`);
  setupSetValue(range("width"), String(s.width));
  out("width", `${s.width} pt`);
  setupSetValue(range("dot"), String(s.dot));
  out("dot", `${s.dot} pt`);
  setupDialog.querySelectorAll('[data-cs-range="majorOpacity"]').forEach((input) => setupSetValue(input, String(Math.round(s.majorOpacity * 100))));
  out("majorOpacity", `${Math.round(s.majorOpacity * 100)}%`);
  setupSetPressed("[data-cs-dash]", (node) => node.dataset.csDash === s.dash);
  setupSetValue(setupDialog.querySelector('[data-cs-num="majorEvery"]'), String(s.majorEvery));
  setupSetValue(len("cue"), setupToUnit(s.cue));
  setupSetValue(len("summary"), setupToUnit(s.summary));
  setupSetPressed('[data-cs-toggle="marginLine"]', () => s.marginLine.on);
  setupDialog.querySelector("[data-cs-margin-colors]").hidden = !s.marginLine.on;
  paintSetupSwatches("margin", s.marginLine.color);

  // Margins.
  SETUP_MARGIN_SIDES.forEach((side) => setupSetValue(len(side), setupToUnit(s.margins[side])));
  setupDialog.querySelector("[data-cs-margin-note]").textContent = SETUP_MARGIN_NOTE[pattern] || "";

  // Pages.
  setupSetPressed('[data-cs-toggle="numbers"]', () => setupModel.numbers);
  const remember = setupDialog.querySelector('[data-cs-toggle="remember"]');
  remember.hidden = !setupModel.create && setupModel.scope !== "all";
  setupSetPressed('[data-cs-toggle="remember"]', () => setupModel.remember);

  setupDialog.querySelector('[data-cs-action="apply"]').textContent = setupModel.create ? "Start the Canvas" : "Apply";
  paintCanvasSetupPreview(s);
}

// ── Changing ───────────────────────────────────────────────────────────────

function changeSetup(patch) {
  setupModel.setup = normalizeSheetSetup({ ...setupModel.setup, ...patch });
  paintCanvasSetupDialog();
}

function setSetupLength(key, typed) {
  if (typed === null) return;
  const pt = key === "w" || key === "h" ? setupSnapDimension(typed) : typed;
  if (SETUP_MARGIN_SIDES.includes(key)) changeSetup({ margins: { ...setupModel.setup.margins, [key]: pt } });
  else changeSetup({ [key]: pt });
}

// A pattern's own lines, at the page's size and on its paper.
function setupForPattern(pattern) {
  const s = setupModel.setup;
  return { ...sheetPatternDefaults(pattern), w: s.w, h: s.h, paper: s.paper, line: s.line, dash: s.dash };
}

function onCanvasSetupClick(event) {
  if (setupBusy || !setupModel) return;
  const target = event.target;
  if (target === setupDialog) { closeCanvasSetupDialog(); return; }
  const node = target.closest?.("button");
  if (!node || !setupDialog.contains(node)) return;
  const d = node.dataset;
  if (d.csScope) {
    setupModel.scope = d.csScope;
    // Every page starts from the Canvas's setup; one page from its own.
    setupModel.remember = setupModel.scope === "all";
    paintCanvasSetupDialog();
  } else if (d.csOrient) {
    const { w, h } = setupModel.setup;
    const landscape = d.csOrient === "landscape";
    if ((w > h) !== landscape && w !== h) changeSetup({ w: h, h: w });
  } else if (d.csUnit) {
    setupLengthUnit = d.csUnit === "in" ? "in" : "mm";
    setupDialog.querySelectorAll("[data-cs-len]").forEach((input) => { if (document.activeElement === input) input.blur(); });
    paintCanvasSetupDialog();
  } else if (d.csPattern) {
    if (d.csPattern !== setupModel.setup.pattern) changeSetup(setupForPattern(d.csPattern));
  } else if (d.csPaper) {
    changeSetup({ paper: d.csPaper });
  } else if (d.csLine) {
    changeSetup({ line: d.csLine });
  } else if (d.csMargin) {
    changeSetup({ marginLine: { ...setupModel.setup.marginLine, color: d.csMargin } });
  } else if (d.csSpacing) {
    changeSetup({ pitch: Number(d.csSpacing) });
  } else if (d.csDash) {
    changeSetup({ dash: d.csDash });
  } else if (d.csToggle === "marginLine") {
    changeSetup({ marginLine: { ...setupModel.setup.marginLine, on: !setupModel.setup.marginLine.on } });
  } else if (d.csToggle === "numbers") {
    setupModel.numbers = !setupModel.numbers;
    paintCanvasSetupDialog();
  } else if (d.csToggle === "remember") {
    setupModel.remember = !setupModel.remember;
    paintCanvasSetupDialog();
  } else if (d.csAction === "follow") {
    setupModel.setup = notebookCanvasSetup();
    paintCanvasSetupDialog();
  } else if (d.csAction === "reset") {
    const s = setupModel.setup;
    changeSetup({ ...sheetPatternDefaults(s.pattern), w: s.w, h: s.h, paper: s.paper });
  } else if (d.csAction === "cancel") {
    closeCanvasSetupDialog();
  } else if (d.csAction === "apply") {
    applyCanvasSetupDialog();
  }
}

function onCanvasSetupInput(event) {
  if (!setupModel) return;
  const target = event.target;
  const d = target.dataset || {};
  if (d.csSize !== undefined) {
    const size = sheetSizeById(target.value);
    if (!size) {
      // "Custom size": the width and height below are the custom size — say so
      // by putting the caret in the first of them.
      if (event.type === "change") {
        const width = setupDialog.querySelector('[data-cs-len="w"]');
        width?.focus();
        width?.select?.();
      }
      return;
    }
    const landscape = size.landscape || setupModel.setup.w > setupModel.setup.h;
    changeSetup(landscape ? { w: size.h, h: size.w } : { w: size.w, h: size.h });
    return;
  }
  if (d.csLen) {
    if (target.value === "") return;
    setSetupLength(d.csLen, setupFromUnit(target.value));
    return;
  }
  if (d.csNum === "majorEvery") {
    if (target.value === "") return;
    changeSetup({ majorEvery: Math.round(Number(target.value) || 0) });
    return;
  }
  if (d.csRange) {
    const value = Number(target.value);
    const percent = d.csRange === "opacity" || d.csRange === "majorOpacity";
    changeSetup({ [d.csRange]: percent ? value / 100 : value });
    return;
  }
  if (d.csPaperCustom !== undefined) {
    const picked = target.value;
    const light = lightSheetPaper(picked);
    setupModel.setup = normalizeSheetSetup({ ...setupModel.setup, paper: light });
    paintCanvasSetupDialog();
    if (event.type === "change" && light !== picked.toLowerCase()) {
      showToast("Lightened to stay paper — choose a dark page from ☾ Paper", "info");
    }
    return;
  }
  if (d.csLineCustom !== undefined) { changeSetup({ line: target.value }); return; }
  if (d.csMarginCustom !== undefined) changeSetup({ marginLine: { ...setupModel.setup.marginLine, color: target.value } });
}

function onCanvasSetupKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCanvasSetupDialog();
  } else if (event.key === "Enter" && event.target.matches("input[type=number]")) {
    event.preventDefault();
    event.target.blur();
    setupDialog.querySelector('[data-cs-action="apply"]').click();
  }
}

// ── Applying ───────────────────────────────────────────────────────────────

// How many marks and Blocks would sit past a page's edge with these boxes that
// do not now — the same count the PDF margins ask with (marksOffPage).
function canvasNewlyOffPage(boxes) {
  const now = marksOffPage(null, notebookPageBoxes(), DOC_SLOT_NOTEBOOK);
  return Math.max(0, marksOffPage(null, boxes, DOC_SLOT_NOTEBOOK) - now);
}

function confirmCanvasOffEdge(count) {
  return new Promise((resolve) => {
    showConfirmModal(
      `${count} thing${count === 1 ? "" : "s"} written on ${count === 1 ? "it" : "them"} would sit past the edge of the smaller page. Nothing is deleted, and ${count === 1 ? "it comes" : "they come"} back into view if the page is made bigger again. Change the page anyway?`,
      () => resolve(true),
      { confirmLabel: "Change the page", onCancel: () => resolve(false) }
    );
  });
}

async function applyCanvasSetupDialog() {
  if (setupBusy || !setupModel) return;
  const setup = normalizeSheetSetup(setupModel.setup);
  const chosen = setupModel;
  if (chosen.create) {
    hideCanvasSetupDialog();
    if (chosen.remember) writeNotebookSetupPreference(setup);
    setupModel = null;
    await chosen.onStart?.(setup);
    return;
  }
  if (!hasNotebook()) { closeCanvasSetupDialog(); return; }
  const all = chosen.scope === "all" || notebookPageCount() < 2;
  const boxes = notebookPageBoxes().map((box, index) => ((all || index + 1 === chosen.page) ? sheetBox(setup) : box));
  const off = canvasNewlyOffPage(boxes);
  hideCanvasSetupDialog();
  if (off && !(await confirmCanvasOffEdge(off))) {
    // Back to the dialog as it was, so a cancel costs nothing that was chosen.
    showCanvasSetupDialog();
    return;
  }
  setupModel = null;
  setupBusy = true;
  try {
    if (all && chosen.remember) writeNotebookSetupPreference(setup);
    if (chosen.numbers !== notebookPageNumbers()) await setNotebookPageNumbers(chosen.numbers);
    const changed = await setNotebookPageSetup(setup, all ? { all: true } : { page: chosen.page });
    if (changed) showToast(all ? "Every page set up" : `Page ${chosen.page} set up`);
    chosen.onApplied?.();
  } finally {
    setupBusy = false;
  }
}

// ── Opening and closing ────────────────────────────────────────────────────

// The preview is sized to its frame, and the frame to the window.
function onCanvasSetupResize() {
  if (setupModel && setupDialog && !setupDialog.hidden) paintCanvasSetupPreview(setupModel.setup);
}

function showCanvasSetupDialog() {
  if (!setupDialog || !setupModel) return;
  setupDialog.hidden = false;
  lockPageScroll();
  window.addEventListener("resize", onCanvasSetupResize);
  paintCanvasSetupDialog();
  requestAnimationFrame(() => setupDialog.querySelector('[data-cs-action="apply"]')?.focus({ preventScroll: true }));
}

function hideCanvasSetupDialog() {
  if (!setupDialog || setupDialog.hidden) return;
  setupDialog.hidden = true;
  unlockPageScroll();
  window.removeEventListener("resize", onCanvasSetupResize);
}

export function isCanvasSetupDialogOpen() {
  return Boolean(setupDialog && !setupDialog.hidden);
}

export function closeCanvasSetupDialog() {
  hideCanvasSetupDialog();
  setupModel = null;
}

// `page` is the page in view, which "Page k" means. `create` is the dialog
// before there is a Canvas: no pages to choose between, and Apply hands the
// setup to `onStart` to make the first page with.
export function openCanvasSetupDialog({ page = 1, create = false, onApplied = null, onStart = null } = {}) {
  if (!create && (!hasNotebook() || documentViewOnly())) return false;
  if (!setupDialog) setupDialog = buildCanvasSetupDialog();
  if (create) {
    const remembered = notebookSetupPreference();
    setupModel = {
      create: true,
      scope: "all",
      page: 1,
      setup: remembered || legacySheetSetup(notebookPaperPreference()),
      numbers: true,
      remember: true,
      onStart
    };
  } else {
    const pages = notebookPageCount();
    const n = Math.max(1, Math.min(pages, Math.round(Number(page) || 1)));
    const own = notebookPageHasOwnSetup(n);
    // A page set up on its own opens on itself; a page that follows the Canvas
    // opens on every page, because that is what changing it has always meant.
    const scope = pages > 1 && own ? "page" : "all";
    setupModel = {
      create: false,
      scope,
      page: n,
      setup: notebookPageSetup(n),
      numbers: notebookPageNumbers(),
      remember: scope === "all",
      onApplied
    };
  }
  showCanvasSetupDialog();
  return true;
}
