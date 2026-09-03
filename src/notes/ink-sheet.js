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

import { HW_ZOOM_STEP, createHandwritingPaper } from "../handwriting/paper.js?v=__BUILD__";
import { addHandwritingPage, fitHandwritingStrokesToPage, makeHandwritingPage, removeHandwritingPage } from "../handwriting/pages.js?v=__BUILD__";
import { buildInkNibs, buildInkPenSwatches, buildInkToolGroup, inkRailButton, paintInkRailPressed, readInkRailPress } from "../handwriting/rail.js?v=__BUILD__";
import { inkStrokesFromSvg, inkSvgFile } from "../format/ink-svg.js?v=__BUILD__";
import { insertPreparedImageUpload } from "../images/outbox.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let sheet = null;
let sheetPaper = null;
let sheetSession = null;
// The sheet's pages, which are the page model's pages and nothing else — they
// are simply never written to a deck. A drawing is still a picture in a note
// when it is finished; what changed is that it is no longer one SCREENFUL.
let sheetPages = [];

// ── The overlay ────────────────────────────────────────────────────────────

function buildSheet() {
  if (sheet) return sheet;
  const root = document.createElement("div");
  root.className = "ink-sheet";
  // An id as well as a class, because src/ui/overlays.js has to be able to ask
  // whether this is open and cannot import this module to do it — ink-sheet.js
  // imports the scroll lock FROM overlays.js, so the arrow only points one way.
  root.id = "inkSheet";
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
  pens.setAttribute("role", "group");
  pens.setAttribute("aria-label", "Pen colour");
  buildInkPenSwatches(pens);

  const widths = document.createElement("div");
  widths.className = "ink-rail-group";
  widths.setAttribute("role", "group");
  widths.setAttribute("aria-label", "Nib");
  buildInkNibs(widths);

  const steps = document.createElement("div");
  steps.className = "ink-rail-group";
  steps.append(
    inkRailButton("inkAction", "undo", "Undo", "&#8630;"),
    inkRailButton("inkAction", "redo", "Redo", "&#8631;"),
    inkRailButton("inkAction", "delete", "Delete the selected strokes", "&#128465;", "is-danger")
  );

  // The paper's own controls, which is what a sheet with more than one page
  // needs and a sheet with exactly one never did.
  const paperGroup = document.createElement("div");
  paperGroup.className = "ink-rail-group";
  paperGroup.setAttribute("role", "group");
  paperGroup.setAttribute("aria-label", "Paper");
  paperGroup.append(
    inkRailButton("inkAction", "zoom-out", "Smaller", "&#8722;"),
    inkRailButton("inkAction", "zoom-in", "Larger", "&#43;"),
    inkRailButton("inkAction", "add-page", "Add a page below", "&#43;&#9647;")
  );

  rail.append(pens, widths, buildInkToolGroup(), steps, paperGroup);

  const stage = document.createElement("div");
  stage.className = "ink-sheet-stage";
  const scroller = document.createElement("div");
  scroller.className = "hw-scroll ink-sheet-scroll";
  stage.appendChild(scroller);

  root.append(head, rail, stage);
  document.body.appendChild(root);
  sheet = { root, scroller, stage, rail, title, cancel, done };

  cancel.addEventListener("click", () => closeInkSheet(false));
  done.addEventListener("click", () => closeInkSheet(true));

  // Delegated, and pointerdown rather than click, for the reason readInkRailPress
  // spells out: a press on a control must not travel on to the paper underneath
  // it and start a stroke.
  rail.addEventListener("pointerdown", (event) => {
    const button = readInkRailPress(event);
    if (!button || !sheetPaper) return;
    const data = button.dataset;
    const pen = sheetPaper.engine;
    if (data.inkPen) pen.setPen(data.inkPen);
    else if (data.inkWidth) pen.setWidth(Number(data.inkWidth));
    else if (data.inkTool) pen.setTool(data.inkTool);
    else if (data.inkAction === "undo") pen.undo();
    else if (data.inkAction === "redo") pen.redo();
    else if (data.inkAction === "delete") pen.deleteSelection();
    else if (data.inkAction === "zoom-in") sheetPaper.setZoom(sheetPaper.zoom() * HW_ZOOM_STEP);
    else if (data.inkAction === "zoom-out") sheetPaper.setZoom(sheetPaper.zoom() / HW_ZOOM_STEP);
    else if (data.inkAction === "add-page") addSheetPage();
    if (data.inkPen || data.inkWidth || data.inkTool) {
      writeInkPreferences({ pen: pen.getPen(), width: pen.getWidth(), tool: pen.getTool() });
    }
    refreshSheetRail();
  });

  bindSheetPointer(scroller);

  // rAF-batched. The old handler repainted straight off `resize`, which fires in
  // a burst while a window is being dragged and repaints every stroke on the
  // page each time — and it repainted without re-measuring, so the ink was
  // redrawn at the scale it had before the resize.
  let relayoutFrame = 0;
  window.addEventListener("resize", () => {
    if (!sheetSession || relayoutFrame) return;
    relayoutFrame = requestAnimationFrame(() => { relayoutFrame = 0; sheetPaper?.relayout(); });
  });

  document.addEventListener("keydown", (event) => {
    if (!sheetSession) return;
    if (event.key === "Escape") { event.preventDefault(); closeInkSheet(false); }
  });
  return sheet;
}

function addSheetPage() {
  const { pages, page } = addHandwritingPage(sheetPages, {});
  sheetPages = pages;
  sheetPaper.render();
  // Scrolled to, because a page added off the bottom of a scroller that nothing
  // moved is a press that appears to have done nothing.
  sheetPaper.pageElement(page.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  refreshSheetRail();
}

function refreshSheetRail() {
  if (!sheet || !sheetPaper) return;
  const pen = sheetPaper.engine;
  paintInkRailPressed(sheet.rail, { pen: pen.getPen(), width: pen.getWidth(), tool: pen.getTool() });
  sheet.rail.querySelector('[data-ink-action="undo"]')?.toggleAttribute("disabled", !pen.canUndo());
  sheet.rail.querySelector('[data-ink-action="redo"]')?.toggleAttribute("disabled", !pen.canRedo());
  sheet.rail.querySelector('[data-ink-action="delete"]')?.toggleAttribute("disabled", !pen.hasSelection());
}

// ── Input ──────────────────────────────────────────────────────────────────
//
// Simpler than the paper's, and deliberately: a sheet is a surface whose only
// purpose is drawing, so there is no text to select and nothing underneath for a
// tap to pass through to. Every pointer draws — stylus, finger and mouse alike —
// which is also what makes the sheet the answer for someone whose tablet has no
// pen at all.
//
// The one thing more than a single host needed: which page the press landed on.
// It is asked once, at pointerdown, against rects measured at layout time, and
// the rest of the stroke belongs to that page whatever it crosses afterwards —
// a stroke that ran over a page boundary and changed hands halfway would be two
// half strokes, which is not what anybody drew.

function bindSheetPointer(scroller) {
  let active = null;
  let activePage = null;
  scroller.addEventListener("pointerdown", (event) => {
    if (!sheetSession || active) return;
    if (event.button !== undefined && event.button > 0 && event.button !== 5) return;
    const page = sheetPaper.pageAt(event.clientX, event.clientY);
    if (!page) return;
    // Not a tap threshold: on a sheet a tap IS a dot, and waiting 150ms to find
    // out would cost the first samples of every stroke.
    event.preventDefault();
    active = event.pointerId;
    activePage = page;
    try { scroller.setPointerCapture(event.pointerId); } catch (_) { /* synthetic */ }
    if (!sheetPaper.engine.begin(page, [event], event)) { active = null; activePage = null; }
  });
  scroller.addEventListener("pointermove", (event) => {
    if (active === null || event.pointerId !== active) return;
    event.preventDefault();
    sheetPaper.engine.move(event);
  });
  const finish = (event, cancelled) => {
    if (active === null || event.pointerId !== active) return;
    active = null;
    activePage = null;
    try { scroller.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    if (cancelled) sheetPaper.engine.cancel();
    else { sheetPaper.engine.move(event); sheetPaper.engine.end(); }
    refreshSheetRail();
  };
  scroller.addEventListener("pointerup", (event) => finish(event, false));
  scroller.addEventListener("pointercancel", (event) => finish(event, true));
  // Scrolling the stack is a scroll; the pages are what is drawn on. Without
  // this a page's own scroll would fight the stroke on a touch device.
  scroller.addEventListener("touchmove", (event) => {
    if (active !== null) event.preventDefault();
  }, { passive: false });
}

function ensureSheetPaper() {
  if (sheetPaper) return sheetPaper;
  sheetPaper = createHandwritingPaper({
    scroller: sheet.scroller,
    getPages: () => sheetPages,
    onCommit: () => refreshSheetRail(),
    onSelectionChange: () => refreshSheetRail()
  });
  return sheetPaper;
}

// ── Opening and closing ────────────────────────────────────────────────────

export function isInkSheetOpen() {
  return Boolean(sheetSession);
}

// For the hardware Back key and for Escape, both of which mean "take this away"
// and neither of which means "keep what I drew". Same route as Cancel.
export function dismissInkSheet() {
  if (!sheetSession) return false;
  closeInkSheet(false);
  return true;
}

// Ctrl+Z while the sheet is open. Without these the global handler saw a blurred
// textarea, decided the press was for the note behind the sheet, and stepped
// that note's history back instead — an undo that changed something the reader
// could not even see.
export function undoInkSheet() { return Boolean(sheetSession) && sheetPaper.engine.undo(); }

export function redoInkSheet() { return Boolean(sheetSession) && sheetPaper.engine.redo(); }

function openInkSheet({ title, strokes, onDone }) {
  const built = buildSheet();
  sheetSession = { onDone };
  built.title.textContent = title;
  built.root.hidden = false;
  lockPageScroll();
  // One page to begin with. A drawing that arrives from somewhere else is fitted
  // onto it rather than centred and clipped — see fitHandwritingStrokesToPage.
  const first = makeHandwritingPage({});
  sheetPages = [first];
  const surface = ensureSheetPaper();
  const saved = inkPreferences();
  surface.engine.setPen(saved.pen);
  surface.engine.setWidth(saved.width);
  surface.engine.setTool(saved.tool);
  // Rendered before the strokes are placed, so the page has the size it will
  // actually have when the fit is worked out against it.
  surface.render();
  const placed = fitHandwritingStrokesToPage(strokes, first);
  if (placed.length) surface.engine.setStrokes(first.id, placed);
  built.scroller.scrollTop = 0;
  refreshSheetRail();
}

// Every page that has something on it, in order — and the pages that do not are
// simply not there. Adding a page and then not using it is not a decision to
// insert a blank picture into a note.
function sheetDrawings() {
  return sheetPages
    .map((page) => ({ page, strokes: sheetPaper.engine.getStrokes(page.id) }))
    .filter((entry) => entry.strokes.length);
}

function closeInkSheet(commit) {
  if (!sheetSession) return;
  const session = sheetSession;
  const drawings = commit ? sheetDrawings() : [];
  sheetSession = null;
  sheetPaper.engine.clearSelection();
  // Emptying the stack and re-rendering is what takes the pages down — render()
  // forgets any host whose page is gone, which is one statement of that rule
  // rather than two that can disagree.
  sheetPages = [];
  sheetPaper.render();
  sheet.root.hidden = true;
  unlockPageScroll();
  if (!commit) return;
  if (!drawings.length) {
    // Nothing drawn. Not an error and not worth a toast — Done on an empty
    // sheet means the same thing as Cancel.
    return;
  }
  session.onDone(drawings.map((entry) => entry.strokes));
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
    onDone: async (pages) => {
      // One picture per page, in order, each inserted after the last. Sequential
      // rather than fanned out: insertPreparedImageUpload puts a placeholder in
      // at a position and settles it later, and two of those racing for the same
      // caret would interleave. `at` walks forward by what actually landed, so
      // the pages come out in the order they were drawn.
      let at = atPos;
      for (const strokes of pages) {
        const file = inkSvgFile(strokes, { name: `ink-${Date.now().toString(36)}` });
        if (!file) continue;
        const before = textarea.value.length;
        await insertPreparedImageUpload(textarea, file, at);
        at += Math.max(0, textarea.value.length - before);
      }
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
    onDone: async (pages) => {
      // Re-opening replaces ONE picture, so it commits one. A reader who added
      // pages while editing gets them as the drawing they now have: the pages
      // are laid out one under the next in the same file, which is what the
      // sheet showed them.
      const file = inkSvgFile(pages.flat(), { name: `ink-${Date.now().toString(36)}` });
      if (!file) return;
      await replace(file);
    }
  });
}
