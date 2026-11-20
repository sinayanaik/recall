// The picker the "To the Canvas" buttons open (src/documents/canvas-feed.js):
// every highlight of the Notes or of the PDFs, or every card, one row each —
// the new ones ticked, the ones already on the Canvas not, and marked so —
// and Add, which puts the ticked ones at the end of the Canvas.
//
// Highlights can be narrowed to some of their colours (the Colours row, which
// this device remembers per part). Cards have a Style section: how the
// question Block, the answer Block and the arrow between them look, and
// whether the answer goes beside the question or under it
// (src/documents/card-canvas-style.js) — also what a card dragged by its grip
// takes.
//
// Built once, on first use, from the .confirm-modal chrome the other small
// dialogs use (styles/11-chrome.css); its own rules are styles/a8-canvas-feed.css.

import { cardItems, keysOnCanvas, latestCanvasBlockStyle, notesHighlightItems, pdfHighlightItems, placeOnCanvas } from "./canvas-feed.js?v=__BUILD__";
import { activePdfId, deckPdfs } from "./pdf-multi.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT, MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { INK_PEN_COLORS, INK_PEN_HEX } from "../format/ink-colors.js?v=__BUILD__";
import {
  BLOCK_FILL_HEX, BLOCK_FILL_LABEL, BLOCK_FILLS, BLOCK_FRAME_LABEL, BLOCK_FRAMES, BLOCK_SHAPE_LABEL, BLOCK_SHAPES,
  blockShapePatch, normalizeBlockStyle
} from "./block-style.js?v=__BUILD__";
import { CARD_CANVAS_STYLE_DEFAULT, cardArrowShape, readCardCanvasStyle, writeCardCanvasStyle } from "./card-canvas-style.js?v=__BUILD__";
import { newConnectorBase } from "./pdf-shapes.js?v=__BUILD__";
import { fontFamilyChoices, fontFamilyOptionGroups } from "../ui/theme-catalog.js?v=__BUILD__";
import { ensureWebfont } from "../core/lib-loader.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let feedDialog = null;
// { source, items, ticked: Set, onCanvas: Set, colourFilter: Set, allPdfs, colours, cardStyle, styleTab }
let feedModel = null;

const FEED_TITLE = {
  notes: "Notes highlights to the Canvas",
  pdf: "PDF highlights to the Canvas",
  cards: "Cards to the Canvas"
};

const FEED_EMPTY = {
  notes: "No highlights in the Notes yet — highlight something first",
  pdf: "No highlights in this PDF yet — highlight something first",
  cards: "No cards in this file yet"
};

// The colours last chosen, per part, on this device.
const COLOUR_STORE = "recall_canvas_feed_colours_v1";

function readColourChoice(source) {
  try {
    const all = JSON.parse(localStorage.getItem(COLOUR_STORE) || "{}");
    return Array.isArray(all?.[source]) ? all[source].map(String) : [];
  } catch {
    return [];
  }
}

function writeColourChoice(source, colours) {
  try {
    const all = JSON.parse(localStorage.getItem(COLOUR_STORE) || "{}") || {};
    all[source] = [...colours];
    localStorage.setItem(COLOUR_STORE, JSON.stringify(all));
  } catch { /* this session only */ }
}

// Whether Add fills each Block with its highlight's colour rather than the
// last Block's fill — off unless chosen, remembered beside the colours.
function readKeepFill() {
  try {
    return JSON.parse(localStorage.getItem(COLOUR_STORE) || "{}")?.keepFill === true;
  } catch {
    return false;
  }
}

function writeKeepFill(on) {
  try {
    const all = JSON.parse(localStorage.getItem(COLOUR_STORE) || "{}") || {};
    all.keepFill = Boolean(on);
    localStorage.setItem(COLOUR_STORE, JSON.stringify(all));
  } catch { /* this session only */ }
}

const colourName = (color) => {
  const name = String(color || MARK_HIGHLIGHT_DEFAULT);
  return name[0].toUpperCase() + name.slice(1);
};
const colourHex = (color) => MARK_HIGHLIGHT_HEX?.[color] || (/^#[0-9a-f]{3,8}$/i.test(color) ? color : MARK_HIGHLIGHT_HEX[MARK_HIGHLIGHT_DEFAULT]);

function feedItemsFor(source, { allPdfs = false } = {}) {
  if (source === "notes") return notesHighlightItems();
  if (source === "cards") return cardItems();
  return pdfHighlightItems(allPdfs ? null : activePdfId(state.meta));
}

function buildCanvasFeedDialog() {
  const section = document.createElement("section");
  section.className = "confirm-modal canvas-feed-modal";
  section.id = "canvasFeedModal";
  section.hidden = true;
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-modal", "true");
  section.setAttribute("aria-labelledby", "canvasFeedTitle");
  section.innerHTML = `
    <div class="confirm-modal-content canvas-feed-content">
      <header class="canvas-feed-head">
        <h3 class="prompt-modal-title" id="canvasFeedTitle"></h3>
        <p class="canvas-feed-note">Ticked items become Blocks at the end of the Canvas, sized and placed for you. New pages are added when one fills up.</p>
        <div class="canvas-feed-tools">
          <button type="button" class="canvas-feed-chip" data-cf-pick="new">New only</button>
          <button type="button" class="canvas-feed-chip" data-cf-pick="all">All</button>
          <button type="button" class="canvas-feed-chip" data-cf-pick="none">None</button>
        </div>
        <div class="canvas-feed-colours" data-cf-colours-bar hidden>
          <span class="canvas-feed-label">Colours</span>
          <span class="canvas-feed-colour-chips" data-cf-colours></span>
        </div>
        <label class="canvas-feed-check" data-cf-all-pdfs-row hidden><input type="checkbox" data-cf-all-pdfs> Every PDF of this file</label>
        <details class="canvas-feed-style" data-cf-style hidden>
          <summary>Style</summary>
          <div class="cf-style-body">
            <div class="cf-style-preview" data-cf-preview aria-hidden="true"></div>
            <div class="cf-style-tabs" role="tablist">
              <button type="button" role="tab" data-cf-tab="q">Question</button>
              <button type="button" role="tab" data-cf-tab="a">Answer</button>
              <button type="button" role="tab" data-cf-tab="arrow">Arrow</button>
            </div>
            <div class="cf-style-panel" data-cf-panel></div>
            <div class="cf-style-row">
              <span class="canvas-feed-label">Layout</span>
              <span class="cf-style-chips">
                <button type="button" class="canvas-feed-chip" data-cf-layout="side">Side by side</button>
                <button type="button" class="canvas-feed-chip" data-cf-layout="stacked">Question above answer</button>
              </span>
              <button type="button" class="canvas-feed-chip cf-style-reset" data-cf-reset>Reset</button>
            </div>
          </div>
        </details>
      </header>
      <ol class="canvas-feed-list" data-cf-list></ol>
      <footer class="sync-modal-actions canvas-feed-actions">
        <label class="canvas-feed-check" data-cf-colours-row><input type="checkbox" data-cf-keep-colours> Fill with each highlight's colour <span class="cf-src">otherwise the last Block's fill</span></label>
        <span class="canvas-feed-spacer"></span>
        <button type="button" class="sync-modal-btn" data-cf-action="cancel">Cancel</button>
        <button type="button" class="sync-modal-btn is-primary" data-cf-action="add"></button>
      </footer>
    </div>`;
  document.body.appendChild(section);
  section.addEventListener("click", onCanvasFeedClick);
  section.addEventListener("change", onCanvasFeedChange);
  section.addEventListener("input", onCanvasFeedInput);
  section.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCanvasFeedDialog();
    }
  });
  return section;
}

function feedVisible(item) {
  return !feedModel.colourFilter.size || feedModel.colourFilter.has(item.color || MARK_HIGHLIGHT_DEFAULT);
}

function feedVisibleItems() {
  if (!feedModel) return [];
  return feedModel.items.filter(feedVisible);
}

function paintColourChips() {
  const bar = feedDialog.querySelector("[data-cf-colours-bar]");
  const counts = new Map();
  if (feedModel.source !== "cards") {
    feedModel.items.forEach((item) => {
      const color = item.color || MARK_HIGHLIGHT_DEFAULT;
      counts.set(color, (counts.get(color) || 0) + 1);
    });
  }
  bar.hidden = !counts.size;
  if (!counts.size) return;
  const all = `<button type="button" class="canvas-feed-chip canvas-feed-colour" data-cf-colour="" aria-pressed="${!feedModel.colourFilter.size}">All colours <span class="canvas-feed-count">${feedModel.items.length}</span></button>`;
  const chips = [...counts.entries()].map(([color, count]) => `<button type="button" class="canvas-feed-chip canvas-feed-colour" data-cf-colour="${escapeHtml(color)}" aria-pressed="${feedModel.colourFilter.has(color)}" title="Only ${escapeHtml(colourName(color).toLowerCase())} highlights — press more than one to take several">`
    + `<span class="canvas-feed-dot" style="--swatch:${escapeHtml(colourHex(color))}"></span>${escapeHtml(colourName(color))} <span class="canvas-feed-count">${count}</span></button>`);
  feedDialog.querySelector("[data-cf-colours]").innerHTML = all + chips.join("");
}

function paintCanvasFeedDialog() {
  if (!feedDialog || !feedModel) return;
  feedDialog.querySelector("#canvasFeedTitle").textContent = FEED_TITLE[feedModel.source] || "To the Canvas";
  const severalPdfs = feedModel.source === "pdf" && deckPdfs(state.meta).length > 1;
  const allRow = feedDialog.querySelector("[data-cf-all-pdfs-row]");
  allRow.hidden = !severalPdfs;
  allRow.querySelector("input").checked = feedModel.allPdfs;
  feedDialog.querySelector("[data-cf-colours-row]").hidden = feedModel.source === "cards";
  paintColourChips();
  let lastLabel = null;
  const rows = feedVisibleItems().map((item) => {
    const index = feedModel.items.indexOf(item);
    const on = feedModel.onCanvas.has(item.from);
    const head = item.label && item.label !== lastLabel ? `<li class="canvas-feed-group">${escapeHtml(item.label)}</li>` : "";
    lastLabel = item.label;
    const dot = item.color ? `<span class="canvas-feed-dot" style="--swatch:${escapeHtml(colourHex(item.color))}"></span>` : "";
    return `${head}<li class="canvas-feed-row${on ? " is-on-canvas" : ""}"><label>`
      + `<input type="checkbox" data-cf-item="${index}"${feedModel.ticked.has(index) ? " checked" : ""}>`
      + `${dot}<span class="canvas-feed-text">${escapeHtml(item.preview || "")}</span>`
      + `${on ? '<span class="canvas-feed-badge">on the Canvas</span>' : ""}</label></li>`;
  });
  feedDialog.querySelector("[data-cf-list]").innerHTML = rows.join("")
    || '<li class="canvas-feed-group">No highlights in these colours</li>';
  const count = feedModel.ticked.size;
  const blocks = feedModel.source === "cards" ? count * 2 : count;
  const addButton = feedDialog.querySelector('[data-cf-action="add"]');
  addButton.textContent = count ? `Add ${blocks} Block${blocks === 1 ? "" : "s"}` : "Add";
  addButton.disabled = !count;
  const style = feedDialog.querySelector("[data-cf-style]");
  style.hidden = feedModel.source !== "cards";
  if (feedModel.source === "cards") paintCardStyle();
}

// Ticks the rows on show: the new ones, all of them, or none. Rows the colour
// filter hides are never ticked, so Add adds what is on show.
function pickFeedRows(which) {
  feedModel.ticked = new Set();
  feedVisibleItems().forEach((item) => {
    const index = feedModel.items.indexOf(item);
    if (which === "all" || (which === "new" && !feedModel.onCanvas.has(item.from))) feedModel.ticked.add(index);
  });
  paintCanvasFeedDialog();
}

function chooseColour(color) {
  if (!color) feedModel.colourFilter = new Set();
  else if (feedModel.colourFilter.has(color)) feedModel.colourFilter.delete(color);
  else feedModel.colourFilter.add(color);
  writeColourChoice(feedModel.source, feedModel.colourFilter);
  pickFeedRows("new");
}

// ── The card style ────────────────────────────────────────────────────────

const ARROW_HEAD_LABEL = { none: "None", open: "Open", filled: "Filled", dot: "Dot", bar: "Bar" };
const ARROW_DASH_LABEL = { solid: "Solid", dash: "Dashed", dot: "Dotted" };
const ARROW_ROUTE_LABEL = { straight: "Straight", elbow: "Elbow", curve: "Curve" };

// Where a value in the Style comes from, said beside it: chosen here (with ✕
// to let it follow again), the last Block styled on the Canvas, ◐ Canvas, or
// the Shapes tool's arrow. Every control shows the value that will be used —
// never a bare "Default" or "auto".
const SOURCE_LABEL = {
  last: "from the last Block",
  canvas: "◐ Canvas",
  plain: "a plain Block",
  tool: "Shapes tool's arrow"
};

function sourceTag(field, source) {
  if (source === "here") {
    return `<button type="button" class="cf-src is-set" data-cf-clear="${escapeHtml(field)}" title="Stop choosing this here: follow ${field.startsWith("arrow.") ? "the Shapes tool's arrow" : "the last Block on the Canvas"} again">set here ✕</button>`;
  }
  return `<span class="cf-src" title="Not chosen here — this is the value in use, and where it comes from">${escapeHtml(SOURCE_LABEL[source] || source)}</span>`;
}

function cardStyleRow(label, field, source, body) {
  return `<div class="cf-style-row"><span class="cf-style-head"><span class="canvas-feed-label">${escapeHtml(label)}</span>${sourceTag(field, source)}</span><span class="cf-style-chips">${body}</span></div>`;
}

function cardStyleChips(field, options, current, { swatch = null } = {}) {
  return options.map(([value, text]) => {
    const dot = swatch ? `<span class="canvas-feed-dot" style="--swatch:${escapeHtml(swatch(value) || "transparent")}"></span>` : "";
    return `<button type="button" class="canvas-feed-chip" data-cf-set="${field}" data-cf-value="${escapeHtml(value)}" aria-pressed="${String(current) === String(value)}" title="${escapeHtml(text)}">${dot}${escapeHtml(text)}</button>`;
  }).join("");
}

const fontName = (key) => {
  const value = String(key || "system");
  return value[0].toUpperCase() + value.slice(1);
};

// The Canvas's own face for a Block's words: ◐ Canvas → Blocks → Font, or the
// app's font when that follows it.
function canvasFontKey() {
  const settings = state.styleSettings || {};
  const own = settings.canvasBlockFontFamily;
  return own && own !== "inherit" ? own : settings.fontFamily || "system";
}

// The Canvas's own size for a Block's words, in points, as it is drawn now.
function canvasTextPoints() {
  const probe = document.createElement("div");
  probe.className = "region-block-host";
  probe.dataset.docSlot = "notebook";
  probe.style.cssText = "position:fixed;left:-9999px;top:0;visibility:hidden;font-size:var(--doc-block-font-size, 0.82rem)";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize) || 13;
  probe.remove();
  return Math.round(px * 0.75 * 10) / 10;
}

function fontSelect(field, current, canvasKey) {
  const known = new Set(fontFamilyOptionGroups.flatMap((group) => group.options));
  const groups = fontFamilyOptionGroups.map((group) => `<optgroup label="${escapeHtml(group.label)}">${group.options
    .filter((key) => Object.prototype.hasOwnProperty.call(fontFamilyChoices, key))
    .map((key) => `<option value="${escapeHtml(key)}"${current === key ? " selected" : ""}>${escapeHtml(fontName(key))}</option>`).join("")}</optgroup>`).join("");
  const extra = current && current !== "inherit" && !known.has(current) ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>` : "";
  return `<select data-cf-input="${field}"><option value="inherit"${current === "inherit" ? " selected" : ""}>${escapeHtml(fontName(canvasKey))} — ◐ Canvas's font</option>${extra}${groups}</select>`;
}

// One side of a card as it will be drawn: the last Block's look, with what was
// chosen here over it — each value with where it came from.
function cardSideStyle(side) {
  const chosen = feedModel.cardStyle[side] || {};
  const last = feedModel.latest || {};
  const value = normalizeBlockStyle({ ...last, ...chosen });
  const sourceOf = (field, follows = "plain") => (field in chosen ? "here" : field in last ? "last" : follows);
  return { value, sourceOf };
}

function blockSidePanel(side) {
  const { value, sourceOf } = cardSideStyle(side);
  const canvasKey = canvasFontKey();
  const points = value.size ?? canvasTextPoints();
  const text = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#888";
  const pens = [["default", "Theme text"], ...INK_PEN_COLORS.map((pen) => [pen.value, pen.name])];
  const bold = value.weight && value.weight >= 600;
  return [
    cardStyleRow("Fill", "fill", sourceOf("fill"), cardStyleChips("fill", BLOCK_FILLS.map((fill) => [fill, BLOCK_FILL_LABEL[fill] || fill]), value.fill, { swatch: (v) => BLOCK_FILL_HEX[v] })),
    cardStyleRow("Text colour", "ink", sourceOf("ink", "canvas"), cardStyleChips("ink", pens, value.ink, { swatch: (v) => INK_PEN_HEX[v] || text })),
    cardStyleRow("Size", "size", sourceOf("size", "canvas"), `<label class="cf-style-field"><input type="text" inputmode="decimal" data-cf-input="size" value="${points}"> pt</label>`),
    cardStyleRow("Face", "font", sourceOf("font", "canvas"), fontSelect("font", value.font, canvasKey)),
    cardStyleRow("Weight", "weight", sourceOf("weight", "canvas"), cardStyleChips("weight", [["400", "Regular"], ["700", "Bold"]], bold ? "700" : "400")),
    cardStyleRow("Align", "align", sourceOf("align"), cardStyleChips("align", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], value.align)),
    cardStyleRow("Frame", "frame", sourceOf("frame"), cardStyleChips("frame", BLOCK_FRAMES.map((frame) => [frame, BLOCK_FRAME_LABEL[frame] || frame]), value.frame)),
    cardStyleRow("Shape", "shape", sourceOf("shape"), `<select data-cf-input="shape">${BLOCK_SHAPES.map((shape) => `<option value="${shape}"${value.shape === shape ? " selected" : ""}>${escapeHtml(BLOCK_SHAPE_LABEL[shape] || shape)}</option>`).join("")}</select>`)
  ].join("");
}

// The arrow as it will be drawn: the Shapes tool's connector, with what was
// chosen here over it.
function cardArrowValues() {
  const chosen = feedModel.cardStyle.arrow || {};
  const base = newConnectorBase();
  const shape = cardArrowShape(base, chosen);
  const pen = Object.keys(INK_PEN_HEX).find((token) => INK_PEN_HEX[token].toLowerCase() === String(shape.stroke || "").toLowerCase()) || "";
  return {
    shape,
    color: chosen.color || pen,
    width: shape.width,
    dash: shape.dash || "solid",
    head: (shape.heads || [])[1] || "none",
    route: shape.route || "straight",
    sourceOf: (field) => (chosen[field] ? "here" : "tool")
  };
}

function arrowPanel() {
  const a = cardArrowValues();
  const pens = INK_PEN_COLORS.map((pen) => [pen.value, pen.name]);
  // The Shapes tool's own colour, when it is not one of the pens.
  const own = a.color ? "" : `<span class="canvas-feed-chip" aria-pressed="true"><span class="canvas-feed-dot" style="--swatch:${escapeHtml(a.shape.stroke)}"></span>${escapeHtml(a.shape.stroke)}</span>`;
  return [
    cardStyleRow("Colour", "arrow.color", a.sourceOf("color"), own + cardStyleChips("arrow.color", pens, a.color, { swatch: (v) => INK_PEN_HEX[v] || "" })),
    cardStyleRow("Thickness", "arrow.width", feedModel.cardStyle.arrow?.width ? "here" : "tool", `<label class="cf-style-field"><input type="text" inputmode="decimal" data-cf-input="arrow.width" value="${a.width}"> pt</label>`),
    cardStyleRow("Line", "arrow.dash", a.sourceOf("dash"), cardStyleChips("arrow.dash", Object.entries(ARROW_DASH_LABEL), a.dash)),
    cardStyleRow("End", "arrow.head", a.sourceOf("head"), cardStyleChips("arrow.head", Object.entries(ARROW_HEAD_LABEL), a.head)),
    cardStyleRow("Route", "arrow.route", a.sourceOf("route"), cardStyleChips("arrow.route", Object.entries(ARROW_ROUTE_LABEL), a.route))
  ].join("");
}

function paintCardStyle({ panel = true } = {}) {
  const tab = feedModel.styleTab;
  feedDialog.querySelectorAll("[data-cf-tab]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.cfTab === tab)));
  feedDialog.querySelectorAll("[data-cf-layout]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.cfLayout === feedModel.cardStyle.layout)));
  if (panel) feedDialog.querySelector("[data-cf-panel]").innerHTML = tab === "arrow" ? arrowPanel() : blockSidePanel(tab);
  paintCardPreview();
}

// The preview's look for one side, from the same custom properties a Block on
// the Canvas reads (styles/58-block-style.css, styles/52-ink.css,
// styles/79-tab-text.css) — the last Block's look with this side's choices.
function previewSideStyle(side) {
  const bag = cardSideStyle(side).value;
  const rules = [`background:var(--block-fill-${bag.fill})`];
  if (bag.ink !== "default") rules.push(`color:var(--ink-pen-${bag.ink})`);
  rules.push(bag.size ? `font-size:${bag.size}pt` : "font-size:var(--doc-block-font-size, 0.82rem)");
  if (bag.font !== "inherit" && fontFamilyChoices[bag.font]) {
    ensureWebfont(bag.font);
    rules.push(`font-family:${fontFamilyChoices[bag.font]}`);
  } else {
    rules.push("font-family:var(--canvas-block-font, inherit)");
  }
  if (bag.weight) rules.push(`font-weight:${bag.weight}`);
  rules.push(`text-align:${bag.align}`);
  if (bag.frame === "none") rules.push("border-color:transparent;box-shadow:none");
  else if (bag.frame === "outline") rules.push("box-shadow:none");
  const radius = { rounded: "12px", pill: "999px", ellipse: "50%" }[bag.shape];
  if (radius) rules.push(`border-radius:${radius}`);
  if (bag.shape === "diamond") rules.push("clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);padding:14px 22px");
  return rules.join(";");
}

function paintCardPreview() {
  const preview = feedDialog.querySelector("[data-cf-preview]");
  const stacked = feedModel.cardStyle.layout === "stacked";
  const { shape } = cardArrowValues();
  const dash = shape.dash === "dash" ? `${shape.width * 3} ${shape.width * 2}` : shape.dash === "dot" ? `${shape.width} ${shape.width * 1.6}` : "";
  const head = (shape.heads || ["none", "filled"])[1] || "none";
  const len = 46;
  const w = Math.max(1, Number(shape.width) || 1.6);
  const tip = { filled: `<path d="M${len - 9} -5 L${len} 0 L${len - 9} 5 Z" fill="${shape.stroke}"/>`, open: `<path d="M${len - 9} -5 L${len} 0 L${len - 9} 5" fill="none" stroke="${shape.stroke}" stroke-width="${w}"/>`, dot: `<circle cx="${len - 3}" cy="0" r="3.4" fill="${shape.stroke}"/>`, bar: `<path d="M${len} -5 L${len} 5" stroke="${shape.stroke}" stroke-width="${w}"/>` }[head] || "";
  const arrow = `<svg class="cf-preview-arrow" viewBox="0 -8 ${len} 16" width="${len}" height="16"${stacked ? ' style="transform:rotate(90deg)"' : ""}>`
    + `<line x1="2" y1="0" x2="${head === "none" ? len : len - 4}" y2="0" stroke="${shape.stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>${tip}</svg>`;
  preview.classList.toggle("is-stacked", stacked);
  preview.innerHTML = `<div class="cf-preview-block" style="${previewSideStyle("q")}">What is a question?</div>${arrow}<div class="cf-preview-block" style="${previewSideStyle("a")}">Its answer, on the Canvas.</div>`;
}

function setCardStyleValue(field, value) {
  const style = JSON.parse(JSON.stringify(feedModel.cardStyle));
  if (field.startsWith("arrow.")) {
    style.arrow[field.slice(6)] = value;
  } else {
    const side = feedModel.styleTab === "a" ? "a" : "q";
    const bag = { ...style[side] };
    if (field === "shape") {
      const patch = blockShapePatch(value);
      delete patch.fit;
      Object.assign(bag, patch);
    } else if (value === "" || value === null) {
      delete bag[field];
    } else {
      bag[field] = field === "weight" ? Number(value) : value;
    }
    style[side] = bag;
  }
  feedModel.cardStyle = writeCardCanvasStyle(style);
}

// ── Events ────────────────────────────────────────────────────────────────

function onCanvasFeedClick(event) {
  if (event.target === feedDialog) { closeCanvasFeedDialog(); return; }
  const chip = event.target.closest("[data-cf-pick]");
  if (chip) { pickFeedRows(chip.dataset.cfPick); return; }
  const colour = event.target.closest("[data-cf-colour]");
  if (colour) { chooseColour(colour.dataset.cfColour); return; }
  const tab = event.target.closest("[data-cf-tab]");
  if (tab) { feedModel.styleTab = tab.dataset.cfTab; paintCardStyle(); return; }
  const set = event.target.closest("[data-cf-set]");
  if (set) {
    setCardStyleValue(set.dataset.cfSet, set.dataset.cfValue);
    paintCardStyle();
    return;
  }
  const clear = event.target.closest("[data-cf-clear]");
  if (clear) {
    const field = clear.dataset.cfClear;
    if (field === "shape") {
      const side = feedModel.styleTab === "a" ? "a" : "q";
      const bag = { ...feedModel.cardStyle[side] };
      ["shape", "align", "valign"].forEach((key) => delete bag[key]);
      feedModel.cardStyle = writeCardCanvasStyle({ ...feedModel.cardStyle, [side]: bag });
    } else {
      setCardStyleValue(field, field.startsWith("arrow.") ? (field === "arrow.width" ? null : "") : "");
    }
    paintCardStyle();
    return;
  }
  const layout = event.target.closest("[data-cf-layout]");
  if (layout) {
    feedModel.cardStyle = writeCardCanvasStyle({ ...feedModel.cardStyle, layout: layout.dataset.cfLayout });
    paintCardStyle({ panel: false });
    return;
  }
  if (event.target.closest("[data-cf-reset]")) {
    feedModel.cardStyle = writeCardCanvasStyle(CARD_CANVAS_STYLE_DEFAULT);
    paintCardStyle();
    return;
  }
  const action = event.target.closest("[data-cf-action]")?.dataset.cfAction;
  if (action === "cancel") closeCanvasFeedDialog();
  else if (action === "add") addFeedItems();
}

// A typed size: the preview follows each key; the box is left alone so the
// caret stays where it is.
function onCanvasFeedInput(event) {
  const input = event.target.closest?.("input[data-cf-input]");
  if (!input) return;
  setCardStyleValue(input.dataset.cfInput, input.value.trim());
  paintCardPreview();
}

function onCanvasFeedChange(event) {
  const box = event.target;
  if (box.matches("input[data-cf-input]")) {
    // Left the box: its tag now says it was set here.
    paintCardStyle();
  } else if (box.matches("select[data-cf-input]")) {
    setCardStyleValue(box.dataset.cfInput, box.value);
    paintCardStyle();
  } else if (box.matches("[data-cf-item]")) {
    const index = Number(box.dataset.cfItem);
    if (box.checked) feedModel.ticked.add(index);
    else feedModel.ticked.delete(index);
    paintCanvasFeedDialog();
  } else if (box.matches("[data-cf-all-pdfs]")) {
    feedModel.allPdfs = box.checked;
    loadFeedItems();
  } else if (box.matches("[data-cf-keep-colours]")) {
    feedModel.colours = box.checked;
    writeKeepFill(box.checked);
  }
}

function loadFeedItems() {
  feedModel.items = feedItemsFor(feedModel.source, { allPdfs: feedModel.allPdfs });
  feedModel.onCanvas = keysOnCanvas();
  const present = new Set(feedModel.items.map((item) => item.color || MARK_HIGHLIGHT_DEFAULT));
  feedModel.colourFilter = new Set(feedModel.source === "cards" ? [] : readColourChoice(feedModel.source).filter((color) => present.has(color)));
  pickFeedRows("new");
}

async function addFeedItems() {
  const chosen = [...feedModel.ticked].sort((a, b) => a - b)
    .map((index) => feedModel.items[index])
    .filter((item) => item && feedVisible(item));
  const colours = feedModel.colours;
  closeCanvasFeedDialog();
  if (chosen.length) await placeOnCanvas(chosen, { colours });
}

function closeCanvasFeedDialog() {
  if (!feedDialog || feedDialog.hidden) return;
  feedDialog.hidden = true;
  unlockPageScroll();
  feedModel = null;
}

export function isCanvasFeedDialogOpen() {
  return Boolean(feedDialog && !feedDialog.hidden);
}

// `source`: "notes", "pdf" or "cards".
export function openCanvasFeedDialog(source) {
  const items = feedItemsFor(source);
  if (!items.length && !(source === "pdf" && deckPdfs(state.meta).length > 1)) {
    showToast(FEED_EMPTY[source] || "Nothing to put on the Canvas", "info");
    return false;
  }
  if (!feedDialog) feedDialog = buildCanvasFeedDialog();
  feedModel = {
    source, items: [], ticked: new Set(), onCanvas: new Set(), colourFilter: new Set(), allPdfs: false, colours: readKeepFill(),
    cardStyle: readCardCanvasStyle(), styleTab: "q", latest: latestCanvasBlockStyle()
  };
  feedDialog.querySelector("[data-cf-keep-colours]").checked = feedModel.colours;
  feedDialog.querySelector("[data-cf-style]").open = false;
  loadFeedItems();
  feedDialog.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => feedDialog.querySelector('[data-cf-action="add"]')?.focus({ preventScroll: true }));
  return true;
}
