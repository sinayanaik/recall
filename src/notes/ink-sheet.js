// Writing by hand inside a note.
//
// A note is a markdown string that reflows — when it is edited, when the window
// changes width, when the reader changes the type size, and, past a couple of
// hundred kilobytes, as it is built span by span while they scroll. There is
// nothing in it for a free-floating stroke to be anchored to. So ink in a note
// is a BLOCK: you draw in a sheet, and what you drew lands in the note where
// the caret was, like a picture, and moves with the text around it forever
// after.
//
// ── It really is a picture ─────────────────────────────────────────────────
//
// What goes into the markdown is an ordinary `![](…)` pointing at an SVG in the
// same private Storage bucket every pasted image uses. Not a fenced block of
// encoded strokes, which was the other candidate: that would put tens of
// kilobytes of base64 in the middle of a note that a reader can triple-click
// into and read as raw markdown, and reading the raw markdown is a feature of
// this app rather than a debugging aid.
//
// Being a picture is also most of the implementation. insertPreparedImageUpload
// gives it the offline outbox and the `recall-img:` placeholder, the rewrite
// across every deck when the upload finally lands, the compression dialog
// (which passes SVG through untouched), the service worker's image cache, the
// resize grip, the delete button and its reference check, every export, and the
// backup — none of which had to be told that ink exists.
//
// The strokes ride inside the file (src/format/ink-svg.js), which is what makes
// a drawing re-openable rather than final.
//
// ── Why the ✎ is on the edit toolbar ───────────────────────────────────────
//
// Beside 🖼️, and only there, because inserting a picture in this app has always
// been something you do where there is a caret. The rendered view's own pill
// acts on a SELECTION, and a drawing is not a selection of anything. Re-opening
// a drawing is the other way round — that starts from the picture on screen, so
// it lives on the image's own grip row (src/images/surface-controls.js).

import { INK_PEN_COLORS, INK_WIDTHS, inkPenVar } from "../format/ink-colors.js?v=__BUILD__";
import { inkStrokesBounds } from "../format/ink-strokes.js?v=__BUILD__";
import { inkStrokesFromSvg, inkSvgFile } from "../format/ink-svg.js?v=__BUILD__";
import { insertPreparedImageUpload } from "../images/outbox.js?v=__BUILD__";
import { createInkEngine } from "../render/ink-engine.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

// The sheet's own host key. It has exactly one drawing surface, unlike the
// paper, which has one per page.
const INK_SHEET_HOST = "sheet";

let sheet = null;
let sheetEngine = null;
let sheetSession = null;

// ── The overlay ────────────────────────────────────────────────────────────

function inkRailButton(attribute, value, label, glyph, extraClass = "") {
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

function buildSheet() {
  if (sheet) return sheet;
  const root = document.createElement("div");
  root.className = "ink-sheet";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Draw");

  const head = document.createElement("div");
  head.className = "ink-sheet-head";
  const title = document.createElement("h2");
  title.className = "ink-sheet-title";
  title.textContent = "Draw";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tool-button ink-sheet-cancel";
  cancel.textContent = "Cancel";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "tool-button ink-sheet-done";
  done.textContent = "Done";
  head.append(title, cancel, done);

  const rail = document.createElement("div");
  rail.className = "ink-sheet-rail";
  rail.setAttribute("role", "toolbar");
  rail.setAttribute("aria-label", "Pen");

  const pens = document.createElement("div");
  pens.className = "ink-rail-group";
  INK_PEN_COLORS.forEach((color) => {
    const button = inkRailButton("inkPen", color.value, color.name, "", "ink-rail-swatch");
    button.classList.remove("tool-button", "ink-rail-btn");
    button.style.setProperty("--ink-swatch", `var(${inkPenVar(color.value)}, ${color.swatch})`);
    pens.appendChild(button);
  });

  const widths = document.createElement("div");
  widths.className = "ink-rail-group";
  const widest = INK_WIDTHS[INK_WIDTHS.length - 1];
  INK_WIDTHS.forEach((size) => {
    const button = inkRailButton("inkWidth", size, `${size}pt nib`, "", "ink-rail-nib");
    button.classList.remove("tool-button", "ink-rail-btn");
    button.style.setProperty("--ink-nib", `${Math.round((size / widest) * 16) + 4}px`);
    widths.appendChild(button);
  });

  const tools = document.createElement("div");
  tools.className = "ink-rail-group";
  tools.append(
    inkRailButton("inkTool", "pen", "Pen", "&#9998;"),
    inkRailButton("inkTool", "eraser", "Eraser", "&#9003;"),
    inkRailButton("inkTool", "lasso", "Lasso", "&#9711;")
  );

  const steps = document.createElement("div");
  steps.className = "ink-rail-group";
  steps.append(
    inkRailButton("inkAction", "undo", "Undo", "&#8630;"),
    inkRailButton("inkAction", "redo", "Redo", "&#8631;"),
    inkRailButton("inkAction", "delete", "Delete the selected strokes", "&#128465;", "is-danger")
  );

  rail.append(pens, widths, tools, steps);

  const stage = document.createElement("div");
  stage.className = "ink-sheet-stage";
  const host = document.createElement("div");
  host.className = "ink-sheet-host";
  stage.appendChild(host);

  root.append(head, rail, stage);
  document.body.appendChild(root);
  sheet = { root, host, stage, rail, title, cancel, done };

  cancel.addEventListener("click", () => closeInkSheet(false));
  done.addEventListener("click", () => closeInkSheet(true));

  // Same delegated shape as the document rail, and pointerdown for the same
  // reason: a press on a control must not travel on to the sheet underneath it
  // and start a stroke.
  rail.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-ink-pen], [data-ink-width], [data-ink-tool], [data-ink-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const data = button.dataset;
    if (data.inkPen) sheetEngine.setPen(data.inkPen);
    else if (data.inkWidth) sheetEngine.setWidth(Number(data.inkWidth));
    else if (data.inkTool) sheetEngine.setTool(data.inkTool);
    else if (data.inkAction === "undo") sheetEngine.undo();
    else if (data.inkAction === "redo") sheetEngine.redo();
    else if (data.inkAction === "delete") sheetEngine.deleteSelection();
    if (data.inkPen || data.inkWidth || data.inkTool) {
      writeInkPreferences({ pen: sheetEngine.getPen(), width: sheetEngine.getWidth(), tool: sheetEngine.getTool() });
    }
    refreshSheetRail();
  });

  bindSheetPointer(host);
  window.addEventListener("resize", () => { if (sheetSession) sheetEngine?.repaint(INK_SHEET_HOST); });
  document.addEventListener("keydown", (event) => {
    if (!sheetSession) return;
    if (event.key === "Escape") { event.preventDefault(); closeInkSheet(false); }
  });
  return sheet;
}

function refreshSheetRail() {
  if (!sheet || !sheetEngine) return;
  const pen = sheetEngine.getPen();
  const width = sheetEngine.getWidth();
  const tool = sheetEngine.getTool();
  sheet.rail.querySelectorAll("[data-ink-pen]").forEach((n) => n.setAttribute("aria-pressed", n.dataset.inkPen === pen ? "true" : "false"));
  sheet.rail.querySelectorAll("[data-ink-width]").forEach((n) => n.setAttribute("aria-pressed", Number(n.dataset.inkWidth) === width ? "true" : "false"));
  sheet.rail.querySelectorAll("[data-ink-tool]").forEach((n) => n.setAttribute("aria-pressed", n.dataset.inkTool === tool ? "true" : "false"));
  sheet.rail.querySelector('[data-ink-action="undo"]')?.toggleAttribute("disabled", !sheetEngine.canUndo());
  sheet.rail.querySelector('[data-ink-action="redo"]')?.toggleAttribute("disabled", !sheetEngine.canRedo());
  sheet.rail.querySelector('[data-ink-action="delete"]')?.toggleAttribute("disabled", !sheetEngine.hasSelection());
}

// ── Input ──────────────────────────────────────────────────────────────────
//
// Simpler than the paper's, and deliberately: a sheet is a surface whose only
// purpose is drawing, so there is no text to select, nothing to scroll and
// nothing underneath for a tap to pass through to. Every pointer draws —
// stylus, finger and mouse alike — which is also what makes the sheet the
// answer for someone whose tablet has no pen at all.

function bindSheetPointer(host) {
  let active = null;
  host.addEventListener("pointerdown", (event) => {
    if (!sheetSession || active) return;
    if (event.button !== undefined && event.button > 0 && event.button !== 5) return;
    // Not a tap threshold: on a sheet a tap IS a dot, and waiting 150ms to find
    // out would cost the first samples of every stroke.
    event.preventDefault();
    active = event.pointerId;
    try { host.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
    if (!sheetEngine.begin(INK_SHEET_HOST, [event], event)) active = null;
  });
  host.addEventListener("pointermove", (event) => {
    if (active === null || event.pointerId !== active) return;
    event.preventDefault();
    sheetEngine.move(event);
  });
  const finish = (event, cancelled) => {
    if (active === null || event.pointerId !== active) return;
    active = null;
    try { host.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    if (cancelled) sheetEngine.cancel();
    else { sheetEngine.move(event); sheetEngine.end(); }
    refreshSheetRail();
  };
  host.addEventListener("pointerup", (event) => finish(event, false));
  host.addEventListener("pointercancel", (event) => finish(event, true));
}

function ensureSheetEngine() {
  if (sheetEngine) return sheetEngine;
  sheetEngine = createInkEngine({
    // The sheet's model space IS its CSS pixel space. Nothing here is a
    // coordinate into somebody else's document, so there is no transform to
    // carry and the SVG's viewBox comes out in the units it was drawn in.
    getMatrix: () => [1, 0, 0, 1, 0, 0],
    getHostSize: () => {
      const box = sheet?.host?.getBoundingClientRect();
      return box ? { width: box.width, height: box.height } : null;
    },
    toModel: (_key, clientX, clientY) => {
      const box = sheet?.host?.getBoundingClientRect();
      if (!box) return null;
      return { x: clientX - box.left, y: clientY - box.top };
    },
    onCommit: () => refreshSheetRail(),
    onSelectionChange: () => refreshSheetRail(),
    className: "ink-sheet-canvas"
  });
  return sheetEngine;
}

// ── Opening and closing ────────────────────────────────────────────────────

export function isInkSheetOpen() {
  return Boolean(sheetSession);
}

function openInkSheet({ title, strokes, onDone }) {
  const built = buildSheet();
  ensureSheetEngine();
  sheetSession = { onDone };
  built.title.textContent = title;
  built.root.hidden = false;
  lockPageScroll();
  const saved = inkPreferences();
  sheetEngine.setPen(saved.pen);
  sheetEngine.setWidth(saved.width);
  sheetEngine.setTool("pen");
  sheetEngine.attachHost(INK_SHEET_HOST, built.host);
  // Placed after the host is attached and the overlay is visible, so the size
  // the canvas is measured against is the one it will actually have.
  sheetEngine.setStrokes(INK_SHEET_HOST, centreStrokes(strokes, built.host));
  refreshSheetRail();
}

// An existing drawing is re-opened CENTRED rather than at the coordinates it
// was drawn at. Those coordinates were the sheet's pixel space on whatever
// device made it — a phone in portrait, most likely — and reopening a drawing
// on a laptop with it jammed into the top-left corner reads as damage.
function centreStrokes(strokes, host) {
  const list = Array.isArray(strokes) ? strokes : [];
  if (!list.length) return [];
  const box = inkStrokesBounds(list);
  const size = host.getBoundingClientRect();
  if (!box || !size.width) return list;
  const dx = ((size.width - (box.maxX - box.minX)) / 2) - box.minX;
  const dy = ((size.height - (box.maxY - box.minY)) / 2) - box.minY;
  return list.map((stroke) => ({
    ...stroke,
    p: stroke.p.map((value, index) => (index % 3 === 0 ? value + dx : (index % 3 === 1 ? value + dy : value)))
  }));
}

function closeInkSheet(commit) {
  if (!sheetSession) return;
  const session = sheetSession;
  const strokes = commit ? sheetEngine.getStrokes(INK_SHEET_HOST) : null;
  sheetSession = null;
  sheetEngine.clearSelection();
  sheetEngine.detachHost(INK_SHEET_HOST);
  sheet.root.hidden = true;
  unlockPageScroll();
  if (!commit) return;
  if (!strokes?.length) {
    // Nothing drawn. Not an error and not worth a toast — Done on an empty
    // sheet means the same thing as Cancel.
    return;
  }
  session.onDone(strokes);
}

// ── The two ways in ────────────────────────────────────────────────────────

// The ✎ on an edit toolbar. `surface` is a renderTargetConfig-shaped object; the
// caret position is captured BEFORE the sheet opens, because opening a modal
// blurs the textarea and a blurred textarea reports a selection of 0 — the same
// reason the toolbar's image button passes `atPos`.
export function insertInkDrawing(textarea, caret = null) {
  if (!textarea) return;
  const atPos = Number.isFinite(caret) ? caret : textarea.selectionStart;
  openInkSheet({
    title: "Draw",
    strokes: [],
    onDone: async (strokes) => {
      const file = inkSvgFile(strokes, { name: `ink-${Date.now().toString(36)}` });
      if (!file) return;
      await insertPreparedImageUpload(textarea, file, atPos);
    }
  });
}

// The ✎ on a drawing's own grip row. `load` fetches the SVG text; `replace`
// writes the new file's markdown over the old image's slice of the source.
export async function reopenInkDrawing({ load, replace }) {
  let strokes = [];
  try {
    strokes = inkStrokesFromSvg(await load());
  } catch (_) {
    strokes = [];
  }
  if (!strokes.length) {
    // The drawing still RENDERS — the <img> is what renders — so this is not a
    // broken image and must not be reported as one. It is one specific thing:
    // the strokes could not be read back, so it can be looked at and not added
    // to. Said out loud rather than opening an empty sheet that would replace
    // the drawing with nothing the moment Done was pressed.
    showToast("Couldn't read this drawing's strokes — it can be deleted or replaced, but not edited", "error");
    return;
  }
  openInkSheet({
    title: "Edit drawing",
    strokes,
    onDone: async (next) => {
      const file = inkSvgFile(next, { name: `ink-${Date.now().toString(36)}` });
      if (!file) return;
      await replace(file);
    }
  });
}
