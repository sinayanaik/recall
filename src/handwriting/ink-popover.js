// The pen's settings, in a panel that comes when it is asked for.
//
// The rail used to BE the settings: eight swatches, four nibs, the eraser's four
// rings and its switch, the shape switch, three tools, undo, redo, clear, the
// notebook's three adders and seven selection pills, all in one band that
// wrapped to three, four, five rows on a phone and took that height off the
// page. Reported, fairly, as "the pen options panels are so oversizing — I want
// compact and more feature-rich pen options", and alongside it "I'm only seeing
// some preset pen sizes without any continuous customisation".
//
// So the rail is a slim bar now — the tools, a chip showing the armed tool's
// colour and size, undo and redo, whatever the moment needs, and ⋯ — and the
// settings live HERE, in a panel under the chip: a continuous size slider with
// the four old sizes as one-tap presets beside it, a live preview at the size
// the stroke will actually be on screen, the palette, colours of the reader's
// own, opacity, and the switches. One panel per tool, because the pen, the
// highlighter and the eraser ask different questions.
//
// ── Shared, through an adapter ─────────────────────────────────────────────
//
// The same panel serves the paper's rail and the drawing sheet's, which act on
// different engines — the reason src/handwriting/rail.js gives for keeping the
// PARTS shared and the dispatch local. Here the dispatch is an ADAPTER the rail
// hands in: what the settings are and how each is changed. What a reader sees
// and how it responds is one statement, written once.
//
// ── Preview on input, commit on change ─────────────────────────────────────
//
// A slider fires `input` at every step of a drag and `change` when it is let
// go. Committing on input would mean thirty restyles of a lassoed selection —
// thirty undo steps — and thirty preference writes per drag. So a drag only
// moves the readout, the preview and the chip, and the setting itself changes
// once, on release.

import {
  INK_ERASER_RANGE, INK_ERASE_TARGETS, INK_HL_WIDTH_RANGE, INK_SLIDER_STEPS, INK_WIDTH_RANGE,
  formatInkToken, inkSliderFromWidth, inkWidthFromSlider, normalizeInkHex, parseInkToken
} from "../format/ink-colors.js?v=__BUILD__";
import { paintInkLayers, paintInkStroke, resolveInkPaint } from "../render/ink-paint.js?v=__BUILD__";
import {
  bindInkRailActivation, buildInkEraserSizes, buildInkHlNibs, buildInkHlSwatches, buildInkNibs,
  buildInkPenSwatches, buildInkRecentColours, inkRailButton
} from "./rail.js?v=__BUILD__";

const INK_PANEL_RANGES = { pen: INK_WIDTH_RANGE, highlighter: INK_HL_WIDTH_RANGE, eraser: INK_ERASER_RANGE };

// How far one press of − or + moves a size: a tenth of a point is the finest
// the format stores and the right step for a pen; a highlighter and an eraser
// are broad enough that a tenth would take forty presses to notice.
const INK_PANEL_STEPS = { pen: 0.1, highlighter: 1, eraser: 0.5 };

const INK_PANEL_TARGET_LABELS = { all: "Everything", pen: "Pen only", highlighter: "Highlighter only" };

function inkPanelNode(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  });
  return node;
}

function inkPanelSizeRow(kind, label) {
  const row = inkPanelNode("div", "ink-pop-row ink-pop-size");
  row.append(
    inkPanelNode("span", "ink-pop-label", { text: label }),
    inkPanelNode("button", "tool-button ink-pop-step", { type: "button", "data-ink-step": kind, "data-ink-dir": "-1", title: "Thinner", "aria-label": `Thinner ${kind}`, text: "−" }),
    inkPanelNode("input", "ink-pop-slider", {
      type: "range", min: "0", max: String(INK_SLIDER_STEPS), step: "1",
      "data-ink-slider": kind, "aria-label": `${label} of the ${kind}`
    }),
    inkPanelNode("button", "tool-button ink-pop-step", { type: "button", "data-ink-step": kind, "data-ink-dir": "1", title: "Thicker", "aria-label": `Thicker ${kind}`, text: "+" }),
    inkPanelNode("output", "ink-pop-value", { "data-ink-value": kind })
  );
  return row;
}

function inkPanelOpacityRow(kind) {
  const row = inkPanelNode("div", "ink-pop-row ink-pop-opacity");
  row.append(
    inkPanelNode("span", "ink-pop-label", { text: "Opacity" }),
    inkPanelNode("input", "ink-pop-slider", {
      type: "range", min: "10", max: "100", step: "1",
      "data-ink-opacity": kind, "aria-label": `Opacity of the ${kind}`
    }),
    inkPanelNode("output", "ink-pop-value", { "data-ink-opacity-value": kind })
  );
  return row;
}

// The reader's own colours, and the way to add one: the browser's own colour
// picker, behind a swatch-shaped button so it sits in the row it adds to.
function inkPanelCustomRow(kind) {
  const row = inkPanelNode("div", "ink-pop-custom", { "data-ink-recent-host": kind, role: "group", "aria-label": "Your colours" });
  const pick = inkPanelNode("label", "ink-pop-colour", { title: "A colour of your own" });
  pick.append(
    inkPanelNode("input", "", { type: "color", "data-ink-colour": kind, "aria-label": `A colour of your own for the ${kind}` }),
    inkPanelNode("span", "ink-pop-colour-face", { "aria-hidden": "true", text: "+" })
  );
  row.append(pick);
  return row;
}

function inkPanelSwitch(action, label, title) {
  const button = inkRailButton("inkAction", action, title, "", "is-switch", label);
  return button;
}

// ── Building the panel ─────────────────────────────────────────────────────
//
// Once, into an empty element. `ids` names the groups the paper's rail and its
// checks already address by id (#inkRailPens and the rest); the sheet passes
// none. `tapDots` is whether the surface has the Tap dots switch at all — the
// sheet does not, because on the sheet every tap is a dot.
export function buildInkPanel(inkPopover, { ids = {}, tapDots = true } = {}) {
  if (!inkPopover || inkPopover.childElementCount) return;
  const tabs = inkPanelNode("div", "ink-pop-tabs", { role: "tablist", "aria-label": "Restyle", hidden: "" });
  tabs.append(
    inkPanelNode("button", "tool-button ink-pop-tab", { type: "button", role: "tab", "data-ink-panel-tab": "pen", text: "Pen" }),
    inkPanelNode("button", "tool-button ink-pop-tab", { type: "button", role: "tab", "data-ink-panel-tab": "highlighter", text: "Highlighter" })
  );

  const pen = inkPanelNode("section", "ink-pop-panel", { "data-ink-panel": "pen", "aria-label": "Pen" });
  const widths = inkPanelNode("div", "ink-rail-group ink-pop-presets", { id: ids.widths || null, role: "group", "aria-label": "Nib" });
  const pens = inkPanelNode("div", "ink-rail-group ink-pop-swatches", { id: ids.pens || null, role: "group", "aria-label": "Pen colour" });
  buildInkNibs(widths);
  buildInkPenSwatches(pens);
  const penSwitches = inkPanelNode("div", "ink-pop-row ink-pop-switches");
  penSwitches.append(inkPanelSwitch("snap", "Snap shapes", "Snap shapes — hold the pen still at the end of a stroke and a rough circle, box, line or arrow is offered as a neat one"));
  if (tapDots) penSwitches.append(inkPanelSwitch("tap-dots", "Tap dots", "Tap dots — a quick tap of the pen on bare paper leaves a dot: the dot on an i, a full stop, a decimal point"));
  pen.append(inkPanelSizeRow("pen", "Size"), widths, inkPanelNode("canvas", "ink-pop-preview", { "data-ink-preview": "pen", "aria-hidden": "true" }),
    pens, inkPanelCustomRow("pen"), inkPanelOpacityRow("pen"), penSwitches);

  const hl = inkPanelNode("section", "ink-pop-panel", { "data-ink-panel": "highlighter", "aria-label": "Highlighter", hidden: "" });
  const hlWidths = inkPanelNode("div", "ink-rail-group ink-pop-presets", { id: ids.hlWidths || null, role: "group", "aria-label": "Highlighter width" });
  const hlPens = inkPanelNode("div", "ink-rail-group ink-pop-swatches", { id: ids.hlPens || null, role: "group", "aria-label": "Highlighter colour" });
  buildInkHlNibs(hlWidths);
  buildInkHlSwatches(hlPens);
  const hlSwitches = inkPanelNode("div", "ink-pop-row ink-pop-switches");
  hlSwitches.append(inkPanelSwitch("hl-straight", "Straight", "Straight — a band swept along a line is laid down straight, and level when it nearly was"));
  hl.append(inkPanelSizeRow("highlighter", "Width"), hlWidths, inkPanelNode("canvas", "ink-pop-preview", { "data-ink-preview": "highlighter", "aria-hidden": "true" }),
    hlPens, inkPanelCustomRow("highlighter"), inkPanelOpacityRow("highlighter"), hlSwitches);

  const eraser = inkPanelNode("section", "ink-pop-panel", { "data-ink-panel": "eraser", "aria-label": "Eraser", hidden: "" });
  const sizes = inkPanelNode("div", "ink-rail-group ink-pop-presets", { id: ids.eraser || null, role: "group", "aria-label": "Eraser" });
  sizes.append(inkRailButton("inkAction", "erase-mode", "Rub out part of a stroke, rather than all of it — cross one letter in the middle of a word and only that letter goes", "", "is-switch", "Part"));
  buildInkEraserSizes(sizes);
  const targets = inkPanelNode("div", "ink-pop-row ink-pop-segmented", { role: "group", "aria-label": "What the eraser takes" });
  INK_ERASE_TARGETS.forEach((target) => {
    targets.append(inkPanelNode("button", "tool-button ink-pop-seg", {
      type: "button", "data-ink-erase-target": target, "aria-pressed": "false",
      title: `The eraser takes ${INK_PANEL_TARGET_LABELS[target].toLowerCase()}`, text: INK_PANEL_TARGET_LABELS[target]
    }));
  });
  eraser.append(inkPanelSizeRow("eraser", "Size"), sizes, inkPanelNode("canvas", "ink-pop-preview", { "data-ink-preview": "eraser", "aria-hidden": "true" }), targets);

  inkPopover.append(tabs, pen, hl, eraser);
}

// ── The controller ─────────────────────────────────────────────────────────
//
// `adapter` is what the panel reads and changes:
//
//   tool()                       the armed tool
//   selectionKinds()             { pen, highlighter } counts in a lasso selection
//   pen()                        { token, width, opacity }
//   highlighter()                { token, width, opacity, straight }
//   eraser()                     { size, mode, target }
//   setPenColour(token), setPenWidth(w), setPenOpacity(o)
//   setHighlighter({ color, width, opacity, straight })
//   setEraserSize(s), setEraseMode(m), setEraseTarget(t)
//   snapShapes(), setSnapShapes(on), tapDots(), setTapDots(on)
//   recentColours(), rememberColour(hex)
//   paper()                      "light" | "dark" | null — what the preview is drawn on
//   scale()                      screen pixels per point, so the preview is true size
//   changed()                    after every commit: remember, repaint
//   suppressTap()                the press that shuts the panel is not a dot
export function createInkPanel({ rail, popover: inkPopover, chip, adapter, onToggle = () => {} }) {
  let panel = null;

  const sections = () => [...inkPopover.querySelectorAll("[data-ink-panel]")];

  // Which panel the armed tool, or the selection, is asking for. Text and an
  // empty lasso have none: nothing is being drawn, so there is nothing to set.
  function panelFor() {
    const tool = adapter.tool();
    if (tool === "eraser") return "eraser";
    if (tool === "highlighter") return "highlighter";
    if (tool === "pen") return "pen";
    if (tool === "lasso") {
      const kinds = adapter.selectionKinds();
      if (!kinds.pen && !kinds.highlighter) return null;
      return kinds.highlighter && !kinds.pen ? "highlighter" : "pen";
    }
    return null;
  }

  function isOpen() {
    return !inkPopover.hidden;
  }

  function open(which = panelFor()) {
    if (!which) return false;
    panel = which;
    inkPopover.hidden = false;
    chip?.setAttribute("aria-expanded", "true");
    refresh();
    onToggle(true);
    return true;
  }

  function close() {
    if (inkPopover.hidden) return;
    inkPopover.hidden = true;
    chip?.setAttribute("aria-expanded", "false");
    onToggle(false);
  }

  function toggle() {
    if (isOpen()) { close(); return false; }
    return open();
  }

  function current(kind) {
    if (kind === "pen") return adapter.pen();
    if (kind === "highlighter") return adapter.highlighter();
    const eraser = adapter.eraser();
    return { width: eraser.size };
  }

  function setWidth(kind, width) {
    if (kind === "pen") adapter.setPenWidth(width);
    else if (kind === "highlighter") adapter.setHighlighter({ width });
    else adapter.setEraserSize(width);
  }

  function setColour(kind, token) {
    if (kind === "pen") adapter.setPenColour(token);
    else adapter.setHighlighter({ color: token });
  }

  // ── Painting it ──────────────────────────────────────────────────────────

  function paintSize(kind, width) {
    const range = INK_PANEL_RANGES[kind];
    const slider = inkPopover.querySelector(`[data-ink-slider="${kind}"]`);
    if (slider && document.activeElement !== slider) slider.value = String(inkSliderFromWidth(width, range));
    const out = inkPopover.querySelector(`[data-ink-value="${kind}"]`);
    if (out) out.textContent = `${Number(width).toFixed(1)} pt`;
  }

  function paintOpacity(kind, opacity) {
    const slider = inkPopover.querySelector(`[data-ink-opacity="${kind}"]`);
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(opacity * 100));
    const out = inkPopover.querySelector(`[data-ink-opacity-value="${kind}"]`);
    if (out) out.textContent = `${Math.round(opacity * 100)}%`;
  }

  // The preview is drawn at the size the stroke will be ON SCREEN at the zoom
  // the page is at — "2.4 pt" is a number nobody can picture, and the point of
  // a continuous control is to be able to see what the next increment does.
  function paintPreview(kind, override = {}) {
    const canvas = inkPopover.querySelector(`[data-ink-preview="${kind}"]`);
    if (!canvas || canvas.closest("[hidden]")) return;
    const cssWidth = Math.max(120, Math.round(canvas.getBoundingClientRect().width || 240));
    const cssHeight = 44;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cssWidth * dpr)) canvas.width = Math.round(cssWidth * dpr);
    if (canvas.height !== Math.round(cssHeight * dpr)) canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paper = adapter.paper?.() || null;
    const scale = Math.max(0.2, Number(adapter.scale?.()) || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = paper === "dark" ? "#16181d" : "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Model units are points, drawn at `scale` CSS pixels each.
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    const w = cssWidth / scale;
    const h = cssHeight / scale;
    if (kind === "eraser") {
      // A line of the pen across, and the rubber over the middle of it, at the
      // size it reaches on screen — floored at a few pixels so the smallest
      // setting is still something to look at rather than a speck.
      const size = override.width ?? adapter.eraser().size;
      const ink = paper === "dark" ? "#e8eaed" : "#16181d";
      const pen = adapter.pen();
      paintInkStroke(ctx, { w: Math.min(pen.width, 4), c: pen.token, p: [w * 0.06, h / 2, 0.6, w * 0.94, h / 2, 0.6] }, { paper });
      const radius = Math.max(4 / scale, size);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = paper === "dark" ? "rgba(22, 24, 29, 0.85)" : "rgba(255, 255, 255, 0.85)";
      ctx.fill();
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = ink;
      ctx.stroke();
      return;
    }
    if (kind === "highlighter") {
      const band = adapter.highlighter();
      const token = override.token || band.token;
      const width = override.width ?? band.width;
      // Two lines of "type" under the band, so the preview shows what it is for:
      // a wash the words stay legible through.
      ctx.fillStyle = paper === "dark" ? "#c9ccd1" : "#3a3d44";
      for (let i = 0; i < 2; i += 1) ctx.fillRect(w * 0.08, (h / 2) - 3 + (i * 5), w * (i ? 0.62 : 0.84), 1.6);
      paintInkLayers(ctx, [{ w: width, c: token, p: [w * 0.06, h / 2, 0.5, w * 0.94, h / 2, 0.5] }],
        { paper, blend: paper === "dark" ? "screen" : "multiply" });
      return;
    }
    const pen = adapter.pen();
    const token = override.token || pen.token;
    const width = override.width ?? pen.width;
    const points = [];
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40;
      points.push(w * (0.06 + (0.88 * t)), (h / 2) + (Math.sin(t * Math.PI * 2) * h * 0.22), 0.45 + (0.45 * Math.sin(t * Math.PI)));
    }
    paintInkStroke(ctx, { w: width, c: token, p: points }, { paper });
  }

  function refresh() {
    if (!isOpen()) return;
    const which = panel || panelFor();
    const kinds = adapter.tool() === "lasso" ? adapter.selectionKinds() : { pen: 0, highlighter: 0 };
    const mixed = kinds.pen > 0 && kinds.highlighter > 0;
    const tabs = inkPopover.querySelector(".ink-pop-tabs");
    if (tabs) tabs.hidden = !mixed;
    inkPopover.querySelectorAll("[data-ink-panel-tab]").forEach((tab) =>
      tab.setAttribute("aria-selected", tab.dataset.inkPanelTab === which ? "true" : "false"));
    sections().forEach((section) => { section.hidden = section.dataset.inkPanel !== which; });
    const pen = adapter.pen();
    const band = adapter.highlighter();
    paintSize("pen", pen.width);
    paintOpacity("pen", pen.opacity);
    paintSize("highlighter", band.width);
    paintOpacity("highlighter", band.opacity);
    paintSize("eraser", adapter.eraser().size);
    const recent = adapter.recentColours?.() || [];
    buildInkRecentColours(inkPopover.querySelector('[data-ink-recent-host="pen"]'), recent, "inkRecent");
    buildInkRecentColours(inkPopover.querySelector('[data-ink-recent-host="highlighter"]'), recent, "inkHlRecent");
    const penHex = parseInkToken(pen.token)?.hex;
    const bandHex = parseInkToken(band.token)?.hex;
    const penPick = inkPopover.querySelector('[data-ink-colour="pen"]');
    const bandPick = inkPopover.querySelector('[data-ink-colour="highlighter"]');
    if (penPick && document.activeElement !== penPick) penPick.value = penHex || resolveInkPaint(pen.token, { paper: adapter.paper?.() || "light" }).color;
    if (bandPick && document.activeElement !== bandPick) bandPick.value = bandHex || resolveInkPaint(band.token).color;
    paintPreview(which);
  }

  // ── Pressing it ──────────────────────────────────────────────────────────

  function pressPanel(button) {
    const data = button.dataset;
    if (data.inkPanelTab) { panel = data.inkPanelTab; refresh(); return; }
    if (data.inkPen) setColour("pen", data.inkPen);
    else if (data.inkRecent) setColour("pen", formatInkToken({ kind: "pen", hex: data.inkRecent }));
    else if (data.inkHl) setColour("highlighter", formatInkToken({ kind: "highlighter", name: data.inkHl }));
    else if (data.inkHlRecent) setColour("highlighter", formatInkToken({ kind: "highlighter", hex: data.inkHlRecent }));
    else if (data.inkWidth) adapter.setPenWidth(Number(data.inkWidth));
    else if (data.inkHlWidth) adapter.setHighlighter({ width: Number(data.inkHlWidth) });
    else if (data.inkEraserSize) adapter.setEraserSize(Number(data.inkEraserSize));
    else if (data.inkEraseTarget) adapter.setEraseTarget(data.inkEraseTarget);
    else if (data.inkStep) {
      const kind = data.inkStep;
      const now = current(kind).width;
      setWidth(kind, Math.round((now + (INK_PANEL_STEPS[kind] * Number(data.inkDir || 1))) * 10) / 10);
    } else if (data.inkAction === "snap") adapter.setSnapShapes(!adapter.snapShapes());
    else if (data.inkAction === "tap-dots") adapter.setTapDots?.(!adapter.tapDots?.());
    else if (data.inkAction === "hl-straight") adapter.setHighlighter({ straight: !adapter.highlighter().straight });
    else if (data.inkAction === "erase-mode") adapter.setEraseMode(adapter.eraser().mode === "part" ? "stroke" : "part");
    else return;
    adapter.changed();
    refresh();
  }

  bindInkRailActivation(inkPopover, pressPanel);

  // A drag previews; a release commits — see the header.
  inkPopover.addEventListener("input", (event) => {
    const slider = event.target;
    if (slider.dataset.inkSlider) {
      const kind = slider.dataset.inkSlider;
      const width = inkWidthFromSlider(Number(slider.value), INK_PANEL_RANGES[kind]);
      const out = inkPopover.querySelector(`[data-ink-value="${kind}"]`);
      if (out) out.textContent = `${width.toFixed(1)} pt`;
      paintPreview(kind, { width });
    } else if (slider.dataset.inkOpacity) {
      const kind = slider.dataset.inkOpacity;
      const out = inkPopover.querySelector(`[data-ink-opacity-value="${kind}"]`);
      if (out) out.textContent = `${slider.value}%`;
      const now = kind === "pen" ? adapter.pen().token : adapter.highlighter().token;
      const parsed = parseInkToken(now);
      if (parsed) paintPreview(kind, { token: formatInkToken({ ...parsed, opacity: Number(slider.value) / 100 }) });
    } else if (slider.dataset.inkColour) {
      const kind = slider.dataset.inkColour;
      const hex = normalizeInkHex(slider.value);
      if (hex) paintPreview(kind, { token: formatInkToken({ kind, hex, opacity: current(kind).opacity ?? 1 }) });
    }
  });

  inkPopover.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.inkSlider) {
      const kind = input.dataset.inkSlider;
      setWidth(kind, inkWidthFromSlider(Number(input.value), INK_PANEL_RANGES[kind]));
    } else if (input.dataset.inkOpacity) {
      const opacity = Number(input.value) / 100;
      if (input.dataset.inkOpacity === "pen") adapter.setPenOpacity(opacity);
      else adapter.setHighlighter({ opacity });
    } else if (input.dataset.inkColour) {
      const kind = input.dataset.inkColour;
      const hex = normalizeInkHex(input.value);
      if (!hex) return;
      setColour(kind, formatInkToken({ kind, hex }));
      adapter.rememberColour?.(hex);
    } else {
      return;
    }
    adapter.changed();
    refresh();
  });

  // Escape on the panel itself: the app's own keydown handler leaves keys inside
  // inputs alone (src/main.js), and the panel is mostly inputs.
  inkPopover.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    chip?.focus?.();
  });

  // A press anywhere that is not the rail shuts the panel — and, on the page, is
  // not also a dot (adapter.suppressTap). Capture, so it is decided before the
  // page's own handlers see the press.
  document.addEventListener("pointerdown", (event) => {
    if (!isOpen()) return;
    if (rail.contains(event.target)) return;
    close();
    adapter.suppressTap?.();
  }, true);

  return { open, close, toggle, isOpen, refresh, panelFor };
}

// ── The chip on the bar ────────────────────────────────────────────────────
//
// The armed tool's colour, size and opacity at a glance — the one thing the
// old rail showed by lighting a swatch and a nib among twelve. A dot for the
// pen, a band for the highlighter, a ring for the eraser; nothing for a tool
// that does not draw. The colour goes through the same custom properties the
// swatches use, so it is the paper's pen and not the theme's.
export function paintInkChip(chip, { tool, pen, highlighter, eraser, selecting = false }) {
  if (!chip) return;
  let kind = tool;
  if (tool === "lasso") kind = selecting ? "pen" : null;
  if (tool === "text") kind = null;
  chip.hidden = !kind;
  if (!kind) return;
  chip.dataset.kind = kind;
  const sizeFor = (width, range) => {
    const t = Math.log(Math.max(range.min, width) / range.min) / Math.log(range.max / range.min);
    return Math.round(5 + (t * 15));
  };
  let colour = "currentColor";
  let opacity = 1;
  let size = 10;
  let title = "";
  if (kind === "pen") {
    const parsed = parseInkToken(pen.token);
    colour = parsed?.hex || `var(--ink-pen-${parsed?.name || "ink"})`;
    opacity = parsed?.opacity ?? 1;
    size = sizeFor(pen.width, INK_WIDTH_RANGE);
    title = `Pen: ${pen.width.toFixed(1)} pt${opacity < 1 ? `, ${Math.round(opacity * 100)}%` : ""} — size, colour and opacity`;
  } else if (kind === "highlighter") {
    const paint = resolveInkPaint(highlighter.token);
    colour = paint.color;
    opacity = Math.max(0.35, paint.alpha);
    size = sizeFor(highlighter.width, INK_HL_WIDTH_RANGE);
    title = `Highlighter: ${highlighter.width.toFixed(1)} pt, ${Math.round(paint.alpha * 100)}% — width, colour and opacity`;
  } else if (kind === "eraser") {
    size = sizeFor(eraser.size, INK_ERASER_RANGE);
    title = `Eraser: ${eraser.size.toFixed(1)} pt, ${eraser.mode === "part" ? "rubs out part of a stroke" : "takes whole strokes"} — size and how it erases`;
  }
  chip.style.setProperty("--chip-colour", colour);
  chip.style.setProperty("--chip-opacity", String(opacity));
  chip.style.setProperty("--chip-size", `${size}px`);
  chip.title = title;
  chip.setAttribute("aria-label", title);
}
