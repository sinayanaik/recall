// Annotations on a PDF: text marks drawn as lines, waves and boxes; the Shapes
// tool's lines, arrows, rectangles, ellipses, callouts, text and sticky notes;
// and the annotated file they are saved into.
//
//   node tools/annotations-check.mjs
//
// Drives a real browser through the same generated fixture paper the PDF check
// uses (tools/pdf-fixture.mjs), with pdf.js and pdf-lib served from disk — see
// tools/pdf-preview-check.mjs, whose setup this repeats. It asserts outcomes on
// the page (what is painted, what is stored, what survives a reload) rather
// than comparing builds.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { PDFLIB_VERSION, pdflibSource } from "./pdflib-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --shot=file.png saves a picture of page 1 once every section has run.
const SHOT = (process.argv.slice(2).find((a) => a.startsWith("--shot=")) || "").slice(7);
// --shot-ui=dir saves pictures of the controls: the selection bar's style and
// colour rows, a mark's menu, the Shapes flyout and the shape panel.
const SHOT_UI = (process.argv.slice(2).find((a) => a.startsWith("--shot-ui=")) || "").slice(10);
const WATCHDOG_MS = 5 * 60 * 1000;

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    const deadline = setTimeout(() => reject(new Error("static server did not start")), 10000);
    proc.stdout.on("data", () => clearTimeout(deadline));
    proc.on("error", (error) => { clearTimeout(deadline); reject(error); });
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-selection.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-region-marks.js?v=__BUILD__",
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/format/ink-strokes.js?v=__BUILD__",
    "/src/notes/selection.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/format/mark-styles.js?v=__BUILD__",
    "/src/format/selection-tools.js?v=__BUILD__",
    "/src/notes/mark-menu.js?v=__BUILD__",
    "/src/render/canvas-record.js?v=__BUILD__",
    "/src/render/annot-shapes.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/ui/ink-rail.js?v=__BUILD__",
    "/src/documents/pdf-shape-text.js?v=__BUILD__",
    "/src/notes/highlight-note-editor.js?v=__BUILD__",
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/documents/pdf-region-embed.js?v=__BUILD__",
    "/src/documents/pdf-lib-shapes.js?v=__BUILD__",
    "/src/documents/pdf-annot-export.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("annotations-check does not touch the network"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/images/" + p } })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  return true;
}`;

// Selects the words of one text item on a page — the n-th span with at least
// two words — and returns nothing; the selection is left standing.
const SELECT_SRC = `async (pageNumber, nth) => {
  const { api, settle } = window.__recall;
  api.scrollToDocumentPage(pageNumber, 0, { smooth: false });
  await api.whenDocumentPageReady(pageNumber);
  await settle(200);
  const el = document.querySelector('.pdf-page[data-page-number="' + pageNumber + '"]');
  el?.classList.add("is-text-awake");
  const spans = Array.from(el?.querySelectorAll(".pdf-text-layer span[data-item-index]") || [])
    .filter((s) => (s.firstChild?.nodeValue || "").trim().split(/\\s+/).length >= 2 && !/rotate/.test(s.style.transform || ""));
  const span = spans[nth];
  if (!span) return false;
  const range = document.createRange();
  range.setStart(span.firstChild, 0);
  range.setEnd(span.firstChild, span.firstChild.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}`;


// Synthetic pointer events at page coordinates, on whatever is under them —
// the same route a real press takes into the scroller's capture listeners.
const POINTER_SRC = `() => {
  window.__drag = async (type, points, { pointerType = "mouse", shiftKey = false, id = 41 } = {}) => {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    // The press lands on what is under it; the rest goes to the scroller, as
    // the pointer capture the press takes would send it.
    const fire = (name, [x, y], buttons) => {
      const view = document.getElementById("documentView");
      const target = name === "pointerdown" ? (document.elementFromPoint(x, y) || view) : view;
      target.dispatchEvent(new PointerEvent(name, {
        bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType, isPrimary: true,
        button: name === "pointermove" ? -1 : 0, buttons, clientX: x, clientY: y, pressure: buttons ? 0.5 : 0, shiftKey
      }));
    };
    // A toast left by an earlier step would take the press.
    document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
    fire("pointerdown", points[0], 1);
    for (let i = 1; i < points.length; i += 1) { fire("pointermove", points[i], 1); await new Promise((r) => requestAnimationFrame(r)); }
    fire("pointerup", points[points.length - 1], 0);
    await settle(120);
  };
  // A point on page n, as fractions of its box.
  window.__at = (n, fx, fy) => {
    const r = document.querySelector('.pdf-page[data-page-number="' + n + '"]').getBoundingClientRect();
    return [r.left + r.width * fx, r.top + r.height * fy];
  };
  return true;
}`;

const chrome = findChrome();
if (!chrome) {
  console.error("annotations-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

let sources;
try {
  sources = pdfjsSources();
} catch (error) {
  console.log(`annotations-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}
let pdflib = null;
try {
  pdflib = pdflibSource();
} catch (error) {
  console.log(`annotations-check: could not obtain pdf-lib ${PDFLIB_VERSION} (${error?.message || error}) — annotated-file cases will be skipped.`);
}

const fixture = buildFixturePdf();
const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  process.exit(1);
}, WATCHDOG_MS);

const failures = [];
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (ok) console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
  else {
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
    failures.push(label);
  }
}

// Each section is a function of the page, so later phases add theirs here.
const sections = [];

// ── Text marks: underline, strike, squiggly, box, and colours of one's own ──
sections.push(async () => {
  const styles = ["underline", "strike", "squiggly", "box"];
  const made = [];
  for (let i = 0; i < styles.length; i += 1) {
    const selected = await page.evaluate(SELECT_SRC, 1, i + 1);
    if (!selected) { made.push({ error: "no span " + (i + 1) }); continue; }
    made.push(await page.evaluate(`async (style) => {
      const { api, settle } = window.__recall;
      const result = api.applyPillHighlight("blue", { style, hex: null });
      await settle(250);
      const record = result && api.documentHighlightById(result.id);
      const mark = record && document.querySelector('.pdf-mark[data-highlight-id="' + record.id + '"]');
      if (!mark) return { error: "nothing painted" };
      const after = getComputedStyle(mark, "::after");
      return {
        style: record.style || null,
        color: record.color,
        painted: mark.dataset.style || null,
        background: getComputedStyle(mark).backgroundImage,
        shadow: getComputedStyle(mark).boxShadow,
        wave: after.content !== "none" && after.content !== "normal" ? after.maskImage || after.webkitMaskImage || "" : ""
      };
    }`, styles[i]));
  }
  styles.forEach((style, i) => {
    const r = made[i] || {};
    check(`a selection marked as ${style} is stored and painted as one`, !r.error && r.style === style && r.painted === style && r.color === "blue", JSON.stringify(r).slice(0, 200));
  });
  check("...the underline and strike are a line, not a tint", /gradient/.test(made[0]?.background || "") && /gradient/.test(made[1]?.background || ""), made[0]?.background?.slice(0, 60));
  check("...the squiggle is a masked wave", /svg/.test(made[2]?.wave || ""), (made[2]?.wave || "").slice(0, 60));
  check("...the box is an outline", /inset/.test(made[3]?.shadow || "") || /rgb/.test(made[3]?.shadow || ""), made[3]?.shadow);

  // The same words underlined after being highlighted get a second mark; the
  // same words highlighted again in another colour are recoloured.
  const stacking = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    return { before: (api.state.meta.pdfHighlights || []).length };
  }`);
  await page.evaluate(SELECT_SRC, 1, 6);
  const tint = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const made = api.applyPillHighlight("yellow", { style: "highlight", hex: null });
    await settle(150);
    return made?.id || null;
  }`);
  await page.evaluate(SELECT_SRC, 1, 6);
  const line = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const made = api.applyPillHighlight("yellow", { style: "underline", hex: null });
    await settle(150);
    return made?.id || null;
  }`);
  await page.evaluate(SELECT_SRC, 1, 6);
  const recoloured = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const made = api.applyPillHighlight("green", { style: "underline", hex: null });
    await settle(150);
    const count = (api.state.meta.pdfHighlights || []).length;
    return { id: made?.id || null, count, color: api.documentHighlightById(made?.id)?.color };
  }`);
  check("underlining highlighted words adds a second mark", tint && line && tint !== line, `${tint} / ${line}`);
  check("...and underlining them again in green recolours the underline", recoloured.id === line && recoloured.color === "green" && recoloured.count === stacking.before + 2, JSON.stringify(recoloured));

  // A colour of one's own: stored as hex, filed under the nearest token.
  await page.evaluate(SELECT_SRC, 1, 7);
  const custom = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const made = api.applyPillMarkHex("#dc2626");
    await settle(200);
    const record = api.documentHighlightById(made?.id);
    const mark = record && document.querySelector('.pdf-mark[data-highlight-id="' + record.id + '"]');
    const prefs = api.inkPreferences();
    return {
      hex: record?.hex, color: record?.color,
      painted: mark ? mark.style.getPropertyValue("--mark-hex") : null,
      remembered: prefs.markHex
    };
  }`);
  check("a pen colour marks the words in that colour, filed under the nearest of the four", custom.hex === "#dc2626" && custom.color === "pink" && custom.painted === "#dc2626", JSON.stringify(custom));
  check("...and the bar remembers it for its next press", custom.remembered === "#dc2626", String(custom.remembered));

  // The mark menu restyles a record in place, and is not offered for a region.
  const menu = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    const anchor = document.querySelector('.pdf-mark[data-highlight-id="' + id + '"]');
    api.openMarkMenuWith(anchor, id, api.DOCUMENT_MARK_HANDLERS, "pink");
    const rows = document.querySelector(".mark-menu .mark-menu-styles");
    const shown = Boolean(rows && !rows.hidden);
    const lit = rows?.querySelector(".is-current")?.dataset.markStyle || null;
    rows?.querySelector('[data-mark-style="squiggly"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(200);
    const after = api.documentHighlightById(id);
    const area = api.addDocumentHighlight({ kind: "area", page: 1, anchor: { page: 1, item: 0, ch: 0 }, focus: { page: 1, item: 0, ch: 0 }, text: "", quads: [{ page: 1, rect: [10, 10, 60, 60] }] }, "yellow", { style: "underline", hex: "#123456" });
    await settle(150);
    const areaMark = document.querySelector('.pdf-mark[data-highlight-id="' + area.id + '"]');
    api.openMarkMenuWith(areaMark, area.id, api.DOCUMENT_MARK_HANDLERS, "yellow");
    const areaRows = !document.querySelector(".mark-menu .mark-menu-styles").hidden;
    api.closeMarkMenu();
    api.removeDocumentHighlight(area.id, { undo: false });
    return { shown, lit, style: after?.style, hex: after?.hex, areaRows, areaStyle: area.style || null, areaHex: area.hex || null };
  }`, custom.hex ? (await page.evaluate(`() => (window.__recall.api.state.meta.pdfHighlights || []).find((r) => r.hex === "#dc2626")?.id`)) : "");
  check("the mark menu offers the styles for a run of words, with its own lit", menu.shown && menu.lit === "highlight", JSON.stringify(menu));
  check("...and restyles it in place, keeping its colour", menu.style === "squiggly" && menu.hex === "#dc2626", JSON.stringify(menu));
  check("a region takes no style and no custom colour, and is offered none", !menu.areaRows && !menu.areaStyle && !menu.areaHex, JSON.stringify(menu));

  // The picture of a page draws the style too: the recorded ops for an
  // underline are a bar, not a box-sized fill.
  const painted = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const marks = api.regionMarksOnPage({ slot: "doc", pdfId: null }, 1);
    const viewport = await (async () => {
      const doc = api.currentPdfDocument();
      const pdfPage = await doc.getPage(1);
      return pdfPage.getViewport({ scale: 1 });
    })();
    const underline = marks.highlights.find((r) => r.style === "underline");
    if (!underline) return { error: "no underline on page 1" };
    const ctx = api.createRecordingContext();
    api.paintRegionMarks(ctx, viewport, { page: 1, highlights: [underline], ink: [] }, { paper: "light", areas: false });
    const fills = ctx.ops.filter((op) => op[0] === "fillRect");
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(underline.quads[0].rect);
    const boxHeight = Math.abs(y1 - y0);
    return { fills: fills.length, barHeight: fills[0] ? fills[0][4] : null, boxHeight };
  }`);
  check("a page's picture draws an underline as a thin bar", !painted.error && painted.fills >= 1 && painted.barHeight < painted.boxHeight * 0.3, JSON.stringify(painted));

  // The selection bar itself: its colour menu grows the two PDF rows, and a
  // style pressed there marks the selection and is remembered.
  await page.evaluate(SELECT_SRC, 1, 8);
  const bar = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = new Set((api.state.meta.pdfHighlights || []).map((r) => r.id));
    const btn = document.getElementById("highlightSelectionMenuBtn");
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(80);
    const menu = document.getElementById("highlightSelectionMenu");
    const rows = Array.from(menu.querySelectorAll("[data-pill-row]")).map((row) => row.dataset.pillRow + ":" + (row.hidden ? "hidden" : "shown"));
    menu.querySelector('[data-pill-style="strike"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(250);
    const made = (api.state.meta.pdfHighlights || []).filter((r) => !before.has(r.id));
    const remembered = api.inkPreferences().markStyle;
    api.writeInkPreferences({ markStyle: "highlight", markHex: null });
    return { rows, made: made.map((r) => r.style || "highlight"), remembered };
  }`);
  check("on a PDF the bar's colour menu shows the style and colour rows", bar.rows.join() === "colours:shown,styles:shown,more:shown", bar.rows.join());
  check("...and a style pressed there marks the selection and is remembered", bar.made.join() === "strike" && bar.remembered === "strike", JSON.stringify(bar));

  // ...and every one of them survives a save and a reload.
  const reloaded = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = (api.state.meta.pdfHighlights || []).filter((r) => r.style || r.hex).map((r) => r.id + ":" + (r.style || "") + ":" + (r.hex || "")).sort();
    await api.flushPendingDeckAutosave();
    await settle(400);
    const id = api.readLocalDeckIndex()[0].id;
    await api.loadDeckFromLibrary(id);
    await settle(600);
    const after = (api.state.meta.pdfHighlights || []).filter((r) => r.style || r.hex).map((r) => r.id + ":" + (r.style || "") + ":" + (r.hex || "")).sort();
    return { before, after };
  }`);
  check("styles and colours survive a reload", reloaded.before.length >= 5 && JSON.stringify(reloaded.before) === JSON.stringify(reloaded.after), `${reloaded.before.length} → ${reloaded.after.length}`);
});


// ── Shapes: line, arrow, rectangle, ellipse ────────────────────────────────
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const drawn = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(2, 0, { smooth: false });
    await api.whenDocumentPageReady(2);
    await settle(300);
    api.toggleInkRail(true);
    api.chooseInkTool("shape");
    api.setShapeType("arrow");
    api.setShapeSettings({ stroke: "#2563eb", width: 2, snap: false });
    const before = api.documentShapes(2).length;

    await window.__drag("arrow", [window.__at(2, 0.2, 0.3), window.__at(2, 0.3, 0.35), window.__at(2, 0.45, 0.4)]);
    const shapes = api.documentShapes(2);
    const arrow = shapes[shapes.length - 1];
    const painted = arrow && document.querySelector('.pdf-shape[data-highlight-id="' + arrow.id + '"]');
    return {
      made: shapes.length - before,
      type: arrow?.shape?.type, heads: arrow?.shape?.heads, stroke: arrow?.shape?.stroke, color: arrow?.color,
      quads: arrow?.quads?.length, paths: painted ? painted.querySelectorAll("path").length : 0,
      selected: api.selectedShapeRecord()?.id === arrow?.id,
      handles: document.querySelectorAll(".pdf-shape-handle").length,
      id: arrow?.id
    };
  }`);
  check("a mouse drag with the Shapes tool draws an arrow, filed as a shape", drawn.made === 1 && drawn.type === "arrow" && drawn.heads?.[1] === "filled" && drawn.stroke === "#2563eb" && drawn.color === "blue" && drawn.quads === 1, JSON.stringify(drawn));
  check("...painted as a shaft and a head, and left selected with its two handles", drawn.paths >= 2 && drawn.selected && drawn.handles === 2, JSON.stringify(drawn));

  const finger = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const before = api.documentShapes(2).length;
    await window.__drag("arrow", [window.__at(2, 0.6, 0.6), window.__at(2, 0.7, 0.7)], { pointerType: "touch", id: 42 });
    return api.documentShapes(2).length - before;
  }`);
  check("a finger drag draws nothing — it is a scroll", finger === 0, `${finger} made`);

  const edited = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    const before = api.documentHighlightById(id).shape.p.map((p) => p.slice());
    // The finger's scroll put it down; picked up again.
    api.selectShape(id);
    await settle(40);
    // Its end handle, dragged further right.
    const handle = document.querySelector('.pdf-shape-handle[data-handle="p1"]').getBoundingClientRect();
    const from = [handle.left + handle.width / 2, handle.top + handle.height / 2];

    await window.__drag("arrow", [from, [from[0] + 30, from[1]], [from[0] + 60, from[1]]]);
    const P = () => api.documentHighlightById(id)?.shape?.p?.map((p) => p.slice()) || null;
    const count0 = api.documentShapes(2).length;
    const afterHandle = P();
    if (!afterHandle) return { error: "gone after the handle drag", count0 };
    // Its body, dragged down.
    const r = document.querySelector('.pdf-page[data-page-number="2"]').getBoundingClientRect();
    const vp = api.pdfPageViewport(2);
    const mid = vp.convertToViewportPoint((afterHandle[0][0] + afterHandle[1][0]) / 2, (afterHandle[0][1] + afterHandle[1][1]) / 2);
    const at = [r.left + mid[0], r.top + mid[1]];
    await window.__drag("arrow", [at, [at[0], at[1] + 20], [at[0], at[1] + 40]]);
    const afterMove = P();
    const count1 = api.documentShapes(2).length;
    api.undoInk(); await settle(80);
    const undoneMove = P();
    api.undoInk(); await settle(80);
    const undoneHandle = P();
    api.redoInk(); api.redoInk(); await settle(80);
    const redone = P();
    return { before, afterHandle, afterMove, undoneMove, undoneHandle, redone, count0, count1 };
  }`, drawn.id);
  const near = (a, b) => Math.abs(a - b) < 0.6;
  if (edited.error || !edited.afterMove || !edited.undoneHandle || !edited.redone) { check("editing an arrow", false, JSON.stringify(edited)); return; }
  check("dragging the end handle moves that end, and only that end", edited.afterHandle[1][0] > edited.before[1][0] + 20 && near(edited.afterHandle[0][0], edited.before[0][0]) && near(edited.afterHandle[0][1], edited.before[0][1]), JSON.stringify(edited.afterHandle));
  check("dragging the body moves the whole arrow", edited.afterMove[0][1] < edited.afterHandle[0][1] - 10 && edited.afterMove[1][1] < edited.afterHandle[1][1] - 10, JSON.stringify(edited.afterMove));
  check("undo takes back the move, then the handle; redo puts both back", JSON.stringify(edited.undoneMove) === JSON.stringify(edited.afterHandle) && JSON.stringify(edited.undoneHandle) === JSON.stringify(edited.before) && JSON.stringify(edited.redone) === JSON.stringify(edited.afterMove), JSON.stringify(edited));

  const boxes = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // Every drag inside the part of page 2 on screen; each new shape's look set
    // with nothing selected, so the last one is not restyled by it.
    api.selectShape(null);
    api.setShapeType("rect");
    api.setShapeSettings({ fill: "#16a34a", dash: "dash" });
    await window.__drag("rect", [window.__at(2, 0.55, 0.1), window.__at(2, 0.62, 0.13), window.__at(2, 0.7, 0.14)], { shiftKey: true });
    const rect = api.documentShapes(2).at(-1);
    const dashed = document.querySelector('.pdf-shape[data-highlight-id="' + rect.id + '"] path')?.getAttribute("stroke-dasharray") || "";
    api.selectShape(null);
    api.setShapeType("ellipse");
    api.setShapeSettings({ fill: null, dash: "solid" });
    await window.__drag("ellipse", [window.__at(2, 0.1, 0.42), window.__at(2, 0.2, 0.44), window.__at(2, 0.3, 0.47)]);
    const ellipse = api.documentShapes(2).at(-1);
    api.selectShape(null);
    api.setShapeType("line");
    await window.__drag("line", [window.__at(2, 0.5, 0.45), window.__at(2, 0.65, 0.452), window.__at(2, 0.8, 0.455)], { shiftKey: true });
    const line = api.documentShapes(2).at(-1);
    const rw = Math.abs(rect.shape.p[1][0] - rect.shape.p[0][0]);
    const rh = Math.abs(rect.shape.p[1][1] - rect.shape.p[0][1]);
    const dy = Math.abs(line.shape.p[1][1] - line.shape.p[0][1]);
    return {
      rect: { type: rect.shape.type, fill: rect.shape.fill, dash: rect.shape.dash, square: Math.abs(rw - rh) < 0.5, rw, rh },
      ellipse: { type: ellipse.shape.type, fill: ellipse.shape.fill, paths: document.querySelectorAll('.pdf-shape[data-highlight-id="' + ellipse.id + '"] path').length },
      line: { type: line.shape.type, heads: line.shape.heads, level: dy < 0.5 },
      dashed
    };
  }`);
  check("Shift makes a rectangle square, filled and dashed as set", boxes.rect.type === "rect" && boxes.rect.square && boxes.rect.fill === "#16a34a" && boxes.rect.dash === "dash" && boxes.dashed.length > 0, JSON.stringify(boxes.rect) + " " + boxes.dashed);
  check("an ellipse is drawn, unfilled", boxes.ellipse.type === "ellipse" && !boxes.ellipse.fill && boxes.ellipse.paths === 1, JSON.stringify(boxes.ellipse));
  check("Shift levels a line, and a line has no heads", boxes.line.type === "line" && boxes.line.level && boxes.line.heads.join() === "none,none", JSON.stringify(boxes.line));

  const restyled = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const line = api.documentShapes(2).at(-1);
    api.selectShape(line.id);
    api.setShapeSettings({ stroke: "#7c3aed", width: 5, heads: { line: ["dot", "bar"] } });
    const after = api.documentHighlightById(line.id).shape;
    api.undoInk(); await settle(60);
    const undone = api.documentHighlightById(line.id).shape;
    api.redoInk(); await settle(60);
    return { after: { stroke: after.stroke, width: after.width, heads: after.heads }, undone: { stroke: undone.stroke, width: undone.width } };
  }`);
  check("the panel restyles the selected shape: colour, width and heads", restyled.after.stroke === "#7c3aed" && restyled.after.width === 5 && restyled.after.heads.join() === "dot,bar", JSON.stringify(restyled));

  const tapped = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const rect = api.documentShapes(2).find((r) => r.shape.type === "rect");
    api.chooseInkTool("pen");
    api.selectShape(null);
    const vp = api.pdfPageViewport(2);
    const r = document.querySelector('.pdf-page[data-page-number="2"]').getBoundingClientRect();
    const corner = vp.convertToViewportPoint(rect.shape.p[0][0], rect.shape.p[0][1]);
    const edge = api.documentHighlightAtPoint(r.left + corner[0], r.top + corner[1]);
    // Inside a FILLED box is on it; a tap in an unfilled ellipse's middle is not.
    const ellipse = api.documentShapes(2).find((r) => r.shape.type === "ellipse");
    const c = vp.convertToViewportPoint((ellipse.shape.p[0][0] + ellipse.shape.p[1][0]) / 2, (ellipse.shape.p[0][1] + ellipse.shape.p[1][1]) / 2);
    const middle = api.documentHighlightAtPoint(r.left + c[0], r.top + c[1]);
    return { edge: edge?.id === rect.id, middle: middle?.kind === "shape" ? middle.shape.type : null };
  }`);
  check("a tap on a shape's line finds it, with no tool armed", tapped.edge, JSON.stringify(tapped));
  check("...and a tap inside an unfilled ellipse does not", tapped.middle !== "ellipse", JSON.stringify(tapped));

  const deleted = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.chooseInkTool("shape");
    const ellipse = api.documentShapes(2).find((r) => r.shape.type === "ellipse");
    api.selectShape(ellipse.id);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle(80);
    const gone = !api.documentHighlightById(ellipse.id);
    api.undoInk(); await settle(80);
    const back = Boolean(api.documentHighlightById(ellipse.id));
    const baked = api.regionMarksOnPage({ slot: "doc", pdfId: null }, 2);
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    return { gone, back, inHighlights: baked.highlights.some((r) => r.kind === "shape"), inShapes: baked.shapes.length };
  }`);
  check("Delete removes the selected shape, and undo brings it back", deleted.gone && deleted.back, JSON.stringify(deleted));
  check("a page's picture never paints a shape as a tinted box", !deleted.inHighlights && deleted.inShapes >= 4, JSON.stringify(deleted));
});


// ── Callouts, text boxes and sticky notes ─────────────────────────────────
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const typed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(3, 0, { smooth: false });
    await api.whenDocumentPageReady(3);
    await settle(300);
    api.toggleInkRail(true);
    api.chooseInkTool("shape");
    api.selectShape(null);
    api.setShapeType("callout");
    api.setShapeSettings({ stroke: "#dc2626", width: 1.2, fontSize: 12, bold: false });
    await window.__drag("callout", [window.__at(3, 0.3, 0.15), window.__at(3, 0.45, 0.22), window.__at(3, 0.55, 0.28)]);
    await settle(150);
    const callout = api.documentShapes(3).at(-1);
    const editor = document.querySelector(".pdf-shape-editor");
    const opened = Boolean(editor) && document.activeElement === editor;
    const before = callout.shape.p.map((p) => p.slice());
    editor.textContent = "Sign error here: the second term should be negative, which changes the limit.";
    editor.blur();
    await settle(150);
    const after = api.documentHighlightById(callout.id);
    const box = document.querySelector('.pdf-shape-text[data-highlight-id="' + callout.id + '"]');
    return {
      type: callout.shape.type, target: callout.shape.p[2], opened,
      text: after.shape.text, recordText: after.text,
      grewDown: Math.min(after.shape.p[0][1], after.shape.p[1][1]) < Math.min(before[0][1], before[1][1]) - 1,
      topKept: Math.abs(Math.max(after.shape.p[0][1], after.shape.p[1][1]) - Math.max(before[0][1], before[1][1])) < 0.5,
      shown: box?.textContent || "", editorGone: !document.querySelector(".pdf-shape-editor"),
      id: callout.id
    };
  }`);
  check("a drag with the Callout tool makes a callout pointing where it began, and opens its box to type in", typed.type === "callout" && Array.isArray(typed.target) && typed.opened, JSON.stringify(typed).slice(0, 300));
  check("...the words typed are stored on the shape and the record, and shown on the page", typed.text.startsWith("Sign error") && typed.recordText === typed.text && typed.shown === typed.text && typed.editorGone, JSON.stringify(typed).slice(0, 300));
  check("...and the box grows down to hold them, its top edge where it was put", typed.grewDown && typed.topKept, JSON.stringify(typed).slice(0, 300));

  const free = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.selectShape(null);
    api.setShapeType("text");
    const before = api.documentShapes(3).length;
    // A tap makes a text box where it lands.
    await window.__drag("text", [window.__at(3, 0.15, 0.4)]);
    await settle(150);
    const made = api.documentShapes(3).length - before;
    const editor = document.querySelector(".pdf-shape-editor");
    // Left empty, it is taken away again.
    editor?.blur();
    await settle(150);
    const afterEmpty = api.documentShapes(3).length - before;
    api.selectShape(null);
    await window.__drag("text", [window.__at(3, 0.15, 0.45), window.__at(3, 0.3, 0.47), window.__at(3, 0.45, 0.5)]);
    await settle(150);
    const box = api.documentShapes(3).at(-1);
    const ed2 = document.querySelector(".pdf-shape-editor");
    ed2.textContent = "see Fig. 3";
    ed2.blur();
    await settle(150);
    const kept = api.documentHighlightById(box.id);
    // Tapped twice with the tool armed, its words open again.
    const vp = api.pdfPageViewport(3);
    const r = document.querySelector('.pdf-page[data-page-number="3"]').getBoundingClientRect();
    const c = vp.convertToViewportPoint((kept.shape.p[0][0] + kept.shape.p[1][0]) / 2, (kept.shape.p[0][1] + kept.shape.p[1][1]) / 2);
    api.selectShape(null);
    await window.__drag("text", [[r.left + c[0], r.top + c[1]]]);
    const selectedFirst = api.selectedShapeRecord()?.id === box.id && !document.querySelector(".pdf-shape-editor");
    await window.__drag("text", [[r.left + c[0], r.top + c[1]]]);
    await settle(100);
    const reopened = document.querySelector(".pdf-shape-editor")?.textContent || null;
    api.commitShapeTextEditor();
    return { made, afterEmpty, text: kept?.shape?.text, fill: kept?.shape?.fill, selectedFirst, reopened };
  }`);
  check("a tap with the Text tool makes a text box and opens it", free.made === 1, JSON.stringify(free));
  check("...an empty one is taken away when it loses focus", free.afterEmpty === 0, JSON.stringify(free));
  check("...a dragged one keeps its words", free.text === "see Fig. 3", JSON.stringify(free));
  check("...and is drawn the way the tool is set, not like the callout selected before it", free.fill === null, JSON.stringify(free));
  check("...and a second tap on a selected one opens its words again", free.selectedFirst && free.reopened === "see Fig. 3", JSON.stringify(free));

  const sticky = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.selectShape(null);
    api.setShapeType("sticky");
    api.setShapeSettings({ stroke: "#e0b400" });
    await window.__drag("sticky", [window.__at(3, 0.85, 0.1)]);
    await settle(200);
    const note = api.documentShapes(3).at(-1);
    const opened = api.isHighlightNoteEditorOpen();
    api.setDocumentHighlightNote(note.id, "Check this against the appendix.");
    api.closeHighlightNoteEditor?.();
    await settle(100);
    // With no tool armed, a finger's tap on it opens the note, not a menu.
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    const icon = document.querySelector('.pdf-shape[data-highlight-id="' + note.id + '"]').getBoundingClientRect();
    const x = icon.left + icon.width / 2;
    const y = icon.top + icon.height / 2;
    (document.elementFromPoint(x, y) || document.getElementById("documentView")).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }));
    await settle(150);
    const reopened = api.isHighlightNoteEditorOpen();
    api.closeHighlightNoteEditor?.();
    // ...and a callout's menu offers its words.
    const callout = api.documentShapes(3).find((r) => r.shape.type === "callout");
    const anchor = document.querySelector('.pdf-shape[data-highlight-id="' + callout.id + '"]');
    api.openMarkMenuWith(anchor, callout.id, api.DOCUMENT_MARK_HANDLERS, callout.color);
    const editRow = document.querySelector(".mark-menu .mark-menu-edit-text");
    const offered = Boolean(editRow && !editRow.hidden);
    const styleRows = !document.querySelector(".mark-menu .mark-menu-styles").hidden;
    api.closeMarkMenu();
    return { type: note.shape.type, opened, reopened, note: api.documentHighlightNote(note.id), offered, styleRows };
  }`);
  check("a tap with the Sticky note tool places a note and opens it", sticky.type === "sticky" && sticky.opened, JSON.stringify(sticky));
  check("...a tap on it later opens the note again", sticky.reopened && sticky.note.startsWith("Check this"), JSON.stringify(sticky));
  check("a callout's menu offers Edit the text, and no word styles", sticky.offered && !sticky.styleRows, JSON.stringify(sticky));

  const survived = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = api.documentShapes(null).map((r) => r.id + ":" + r.shape.type + ":" + r.shape.text).sort();
    await api.flushPendingDeckAutosave();
    await settle(300);
    await api.loadDeckFromLibrary(api.readLocalDeckIndex()[0].id);
    await settle(600);
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView();
    await settle(500);
    const after = api.documentShapes(null).map((r) => r.id + ":" + r.shape.type + ":" + r.shape.text).sort();
    return { before, after, painted: document.querySelectorAll(".pdf-shape").length };
  }`);
  check("every shape survives a reload, words and all", survived.before.length >= 7 && JSON.stringify(survived.before) === JSON.stringify(survived.after), `${survived.before.length} → ${survived.after.length}`);
});


// ── Shapes everywhere else: the pane, cards, pictures, the eraser ──────────
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const listed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const entries = api.collectHighlightEntries();
    const shapes = api.documentShapes(null);
    const arrow = shapes.find((r) => r.shape.type === "arrow");
    const callout = shapes.find((r) => r.shape.type === "callout");
    const arrowEntry = entries.find((e) => e.highlightId === arrow?.id);
    const calloutEntry = entries.find((e) => e.highlightId === callout?.id);
    return {
      arrowLabel: api.documentHighlightLabel(arrow),
      calloutLabel: api.documentHighlightLabel(callout),
      arrowListed: Boolean(arrowEntry),
      arrowPictured: Boolean(arrowEntry && (arrowEntry.region || arrowEntry.pictured)),
      calloutText: calloutEntry?.anchor?.text || null,
      calloutQuote: calloutEntry?.markdown || "",
      ref: api.pdfRegionRefForRecord(arrow)
    };
  }`);
  check("a shape is listed in the Highlights pane as a picture, named by what it is", listed.arrowListed && listed.arrowPictured && /^Arrow · page 2$/.test(listed.arrowLabel), JSON.stringify(listed));
  check("...and a callout by its words, quoted under its picture", listed.calloutLabel.startsWith("Sign error") && listed.calloutText?.startsWith("Sign error") && /Sign error/.test(listed.calloutQuote), JSON.stringify(listed));
  check("a shape has a location to make a card of — a live picture of the spot it is on", /^!\[\]\(pdfref:2:/.test(listed.ref || ""), listed.ref);

  const pictured = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const callout = api.documentShapes(3).find((r) => r.shape.type === "callout");
    // The recorded picture of the page has the callout's lines and its words.
    const doc = api.currentPdfDocument();
    const pdfPage = await doc.getPage(3);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const ctx = api.createRecordingContext();
    api.paintRegionMarks(ctx, viewport, api.regionMarksOnPage({ slot: "doc", pdfId: null }, 3), { paper: "light", areas: true });
    const texts = ctx.ops.filter((op) => op[0] === "fillText").map((op) => op[1]);
    const strokes = ctx.ops.filter((op) => op[0] === "stroke").length;
    // ...and a picture of the region round it is made (the pane's thumbnail).
    const url = await api.renderRegionImage(callout, { width: 240 });
    return { texts, strokes, thumb: typeof url === "string" && url.startsWith("data:image") };
  }`);
  check("a page's picture draws a shape's lines and its words", pictured.strokes >= 2 && pictured.texts.some((t) => t.startsWith("Sign error")), JSON.stringify(pictured).slice(0, 300));
  check("...and a shape's thumbnail is drawn", pictured.thumb, JSON.stringify(pictured).slice(0, 200));

  if (pdflib) {
    const vector = await page.evaluate(`async () => {
      const { api } = window.__recall;
      const { PDFDocument } = window.PDFLib;
      const out = await PDFDocument.create();
      const pdfPage = out.addPage([612, 792]);
      await api.drawShapesWithPdfLib(out, pdfPage, api.documentShapes(null));
      const bytes = await out.save({ useObjectStreams: false });
      const size = bytes.length;
      // Read it back with pdf.js (which takes the buffer): the words are real
      // text, not pixels.
      const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
      return { size, text };
    }`);
    check("a region saved as a PDF draws shapes as vectors, with their words as real text", vector.size > 500 && /Sign error/.test(vector.text) && /see Fig\. 3/.test(vector.text), JSON.stringify(vector).slice(0, 300));
  }

  const printed = await page.evaluate(`async () => {
    const { api } = window.__recall;
    // The printed export draws a page through the same canvas painter; asked of
    // the painter directly, with a canvas that remembers what it was told.
    const calls = [];
    const ctx = new Proxy(document.createElement("canvas").getContext("2d"), {
      get(target, key) {
        const value = target[key];
        if (typeof value === "function") return (...args) => { calls.push(String(key)); return value.apply(target, args); };
        return value;
      },
      set(target, key, value) { target[key] = value; return true; }
    });
    const shape = api.documentShapes(null).find((r) => r.shape.type === "rect").shape;
    api.paintShapeOnCanvas(ctx, shape, ([x, y]) => [x, 792 - y], 1);
    return { fill: calls.includes("fill"), stroke: calls.includes("stroke"), dash: calls.includes("setLineDash") };
  }`);
  check("the printed export's painter fills, dashes and strokes a box", printed.fill && printed.stroke && printed.dash, JSON.stringify(printed));

  const erased = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(2, 0, { smooth: false });
    await settle(300);
    const line = api.documentShapes(2).find((r) => r.shape.type === "line");
    api.toggleInkRail(true);
    api.chooseInkTool("eraser");
    const vp = api.pdfPageViewport(2);
    const r = document.querySelector('.pdf-page[data-page-number="2"]').getBoundingClientRect();
    const mid = vp.convertToViewportPoint((line.shape.p[0][0] + line.shape.p[1][0]) / 2, line.shape.p[0][1]);
    const x = r.left + mid[0];
    const y = r.top + mid[1];
    await window.__drag("eraser", [[x, y - 25], [x, y - 8], [x, y + 8], [x, y + 25]]);
    const gone = !api.documentHighlightById(line.id);
    api.undoInk();
    await settle(80);
    const back = Boolean(api.documentHighlightById(line.id));
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    return { gone, back };
  }`);
  check("the eraser crossing a shape removes it, and undo brings it back", erased.gone && erased.back, JSON.stringify(erased));
});


// ── Saved with annotations: every mark as a real PDF annotation ────────────
sections.push(async () => {
  if (!pdflib) return;
  const written = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // A note on an underline, to ride along as its Contents.
    const underline = (api.state.meta.pdfHighlights || []).find((r) => r.style === "underline");
    api.setDocumentHighlightNote(underline.id, "Compare with eq. 4");
    // An ink mark — two strokes, pen and highlighter — as the pen stores one.
    const strokes = [
      { w: 2, c: "red", p: [100, 300, 0.5, 140, 320, 0.5, 180, 300, 0.5] },
      { w: 14, c: "hyellowq35", p: [100, 260, 0.5, 220, 260, 0.5] }
    ];
    api.reinstateDocumentHighlight({
      id: "hn-inktest", color: "pink", page: 4, anchor: null, focus: null, text: "", kind: "ink",
      quads: [{ page: 4, rect: [90, 250, 230, 330] }], ink: { v: api.INK_FORMAT_VERSION, s: api.encodeInkStrokes(strokes) },
      qv: api.QUAD_GEOMETRY_VERSION, at: Date.now()
    });
    const result = await api.annotatedPdfBytes();
    if (!result) return { error: "no bytes" };
    const size = result.bytes.length;
    const { PDFDocument, PDFName, PDFDict, PDFArray } = window.PDFLib;
    const copy = result.bytes.slice();
    const doc = await PDFDocument.load(copy);
    const found = [];
    doc.getPages().forEach((p, i) => {
      const annots = p.node.Annots();
      if (!annots) return;
      for (let k = 0; k < annots.size(); k += 1) {
        const dict = doc.context.lookup(annots.get(k), PDFDict);
        const subtype = dict.get(PDFName.of("Subtype"))?.toString();
        found.push({
          page: i + 1,
          subtype,
          nm: dict.get(PDFName.of("NM"))?.decodeText?.() || null,
          ap: Boolean(dict.get(PDFName.of("AP"))),
          contents: dict.get(PDFName.of("Contents"))?.decodeText?.() || null,
          le: dict.get(PDFName.of("LE"))?.toString() || null,
          it: dict.get(PDFName.of("IT"))?.toString() || null,
          quads: dict.get(PDFName.of("QuadPoints")) ? dict.lookup(PDFName.of("QuadPoints"), PDFArray).size() : 0,
          inkList: dict.get(PDFName.of("InkList")) ? dict.lookup(PDFName.of("InkList"), PDFArray).size() : 0,
          popup: Boolean(dict.get(PDFName.of("Popup")))
        });
      }
    });
    // ...and pdf.js, which is what a browser's viewer is built on, reads them.
    const pdfDoc = await window.pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    const seen = [];
    for (let i = 1; i <= pdfDoc.numPages; i += 1) {
      (await (await pdfDoc.getPage(i)).getAnnotations()).forEach((a) => seen.push(a.subtype));
    }
    return { size, count: result.count, name: result.name, found, seen, underlineId: underline.id };
  }`);
  if (written.error) { check("the annotated file is written", false, written.error); return; }
  const subtypes = new Set(written.found.map((a) => a.subtype));
  const want = ["/Highlight", "/Underline", "/StrikeOut", "/Squiggly", "/Square", "/Circle", "/Line", "/FreeText", "/Text"];
  check("the annotated file is written, named for the paper", written.size > 1000 && / \(annotated\)\.pdf$/.test(written.name) && written.count >= 15, `${written.count} annotations · ${written.name}`);
  check("every kind of mark becomes the PDF annotation made for it", want.every((t) => subtypes.has(t)), [...subtypes].join(" "));
  // Ours carry the mark's id; the file's own (the fixture's comment) do not,
  // and are left exactly as they came — not written a second time.
  const own = written.found.filter((a) => a.nm);
  const theirs = written.found.filter((a) => !a.nm && a.subtype !== "/Popup");
  check("every annotation written carries its own appearance and the mark's id", own.length >= written.count && own.every((a) => a.ap || a.subtype === "/Text"), JSON.stringify(own.filter((a) => !a.ap)).slice(0, 300));
  check("...and the file's own annotation is kept, once", theirs.length === 1 && /came in with the file/.test(theirs[0].contents || ""), JSON.stringify(theirs).slice(0, 300));
  const underline = written.found.find((a) => a.nm === written.underlineId);
  check("a note becomes the annotation's Contents, with a Popup to show it in", underline?.contents === "Compare with eq. 4" && underline?.popup && underline?.quads === 8, JSON.stringify(underline));
  const line = written.found.find((a) => a.subtype === "/Line" && /Butt/.test(a.le || ""));
  const arrow = written.found.find((a) => a.subtype === "/Line" && /ClosedArrow/.test(a.le || ""));
  check("a line's and an arrow's heads are its line endings", Boolean(line) && Boolean(arrow), JSON.stringify(written.found.filter((a) => a.subtype === "/Line")));
  const callout = written.found.find((a) => a.it === "/FreeTextCallout");
  check("a callout is a FreeText callout whose Contents are its words", Boolean(callout) && /^Sign error/.test(callout.contents || ""), JSON.stringify(callout));
  const sticky = written.found.find((a) => a.subtype === "/Text" && /appendix/.test(a.contents || ""));
  check("a sticky note is a Text annotation with its note", Boolean(sticky), JSON.stringify(written.found.filter((a) => a.subtype === "/Text")));
  const ink = written.found.find((a) => a.nm === "hn-inktest");
  check("ink is an Ink annotation, one path per stroke", ink?.subtype === "/Ink" && ink.inkList === 2 && ink.ap, JSON.stringify(ink));
  const seen = new Set(written.seen);
  check("pdf.js reads them back as the same kinds", ["Highlight", "Underline", "StrikeOut", "Squiggly", "Line", "FreeText", "Text", "Ink"].every((t) => seen.has(t)), [...seen].join(" "));

  const menu = await page.evaluate(`async () => {
    const { api } = window.__recall;
    api.paintViewExportMenu();
    const row = document.querySelector('#viewExportMenu [data-view-export="doc:native"]');
    return row ? row.textContent : null;
  }`);
  check("the PDF tab's export menu offers it", /With annotations/.test(menu || ""), String(menu));
});

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
  });
  await servePdfjsFromDisk(client, page, sources);
  if (pdflib) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const imported = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], "fixture.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    if (!entry) return { error: "no file was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(400);
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView();
    await settle(400);
    api.fitDocumentToWidth?.();
    await settle(300);
    return { pages: api.state.meta?.pdf?.pages || 0 };
  }`, Array.from(fixture.bytes));
  if (imported.error) throw new Error(imported.error);
  check("the fixture opens on its PDF tab", imported.pages > 0, `${imported.pages} page(s)`);

  for (const section of sections) await section();

  if (SHOT_UI) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOT_UI, { recursive: true });
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
    const snap = async (name) => {
      const shot = await page.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOT_UI, name), Buffer.from(shot.data, "base64"));
      console.log(`  shot  ${path.join(SHOT_UI, name)}`);
    };
    const tidy = `() => { window.__recall.api.closeMyDecksPanel(); document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove()); }`;
    // The selection bar on a PDF, its colour menu open.
    await page.evaluate(tidy);
    await page.evaluate(SELECT_SRC, 1, 9);
    await page.evaluate(`async () => {
      const { settle } = window.__recall;
      document.dispatchEvent(new Event("selectionchange"));
      await settle(700);
      document.getElementById("highlightSelectionMenuBtn")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      await settle(200);
    }`);
    await snap("selection-bar.png");
    // A text mark's menu.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      window.getSelection().removeAllRanges();
      document.getElementById("highlightSelectionMenu").hidden = true;
      api.hideNotesSelectionButton?.();
      const record = (api.state.meta.pdfHighlights || []).find((r) => r.style === "squiggly");
      const anchor = document.querySelector('.pdf-mark[data-highlight-id="' + record.id + '"]');
      api.openMarkMenuWith(anchor, record.id, api.DOCUMENT_MARK_HANDLERS, record.color);
      await settle(150);
    }`);
    await snap("mark-menu.png");
    // The Shapes flyout, and the shape panel.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.closeMarkMenu();
      api.scrollToDocumentPage(2, 0, { smooth: false });
      await settle(400);
      api.toggleInkRail(true);
      api.chooseInkTool("shape");
      api.setShapeType("arrow");
      await settle(100);
      document.getElementById("inkRailShapeBtn").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      await settle(200);
    }`);
    await snap("shapes-flyout.png");
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      document.getElementById("inkRailShapeMenu").hidden = true;
      const arrow = api.documentShapes(2).find((r) => r.shape.type === "arrow");
      api.selectShape(arrow.id);
      document.getElementById("inkRailStyleChip").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      await settle(250);
    }`);
    await snap("shape-panel.png");
  }

  if (SHOT) {
    // One picture per page that has something on it: page 1's text marks and
    // page 2's shapes. The first goes to SHOT, the second beside it.
    const { writeFileSync } = await import("node:fs");
    for (const n of [1, 2, 3]) {
      const clip = await page.evaluate(`async (n) => {
        const { api, settle } = window.__recall;
        api.closeMyDecksPanel();
        api.selectShape?.(null);
        document.querySelectorAll(".toast, #toastHost > *").forEach((node) => node.remove());
        api.scrollToDocumentPage(n, 0, { smooth: false });
        await settle(800);
        const r = document.querySelector('.pdf-page[data-page-number="' + n + '"]').getBoundingClientRect();
        return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, 1280), height: Math.min(r.height, 900 - Math.max(0, r.top)), scale: 1 };
      }`, n);
      const shot = await page.call("Page.captureScreenshot", { format: "png", clip });
      const file = n === 1 ? SHOT : SHOT.replace(/\.png$/, "") + "-p" + n + ".png";
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`  shot  ${file}`);
    }
    // ...and the file saved with its annotations, drawn by pdf.js from their
    // appearance streams — what a browser's own viewer shows.
    if (pdflib) {
      for (const n of [1, 2, 3]) {
        const url = await page.evaluate(`async (n) => {
          const { api } = window.__recall;
          const result = await api.annotatedPdfBytes();
          const doc = await window.pdfjsLib.getDocument({ data: result.bytes }).promise;
          const p = await doc.getPage(n);
          const viewport = p.getViewport({ scale: 1.5 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await p.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: window.pdfjsLib.AnnotationMode.ENABLE }).promise;
          return canvas.toDataURL("image/png");
        }`, n);
        const file = SHOT.replace(/\.png$/, "") + "-native-p" + n + ".png";
        writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
        console.log(`  shot  ${file}`);
      }
    }
  }
} catch (error) {
  check("the check itself", false, error?.stack || String(error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
}

console.log(`\nannotations-check: ${failures.length ? `${failures.length} failed` : "all held"}`);
console.log(`CHECK: ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
