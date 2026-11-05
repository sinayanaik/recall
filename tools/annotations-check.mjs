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
import { HTMLTOIMAGE_VERSION, htmlToImageSource } from "./htmltoimage-source.mjs";

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
    "/src/format/render-toolbar.js?v=__BUILD__",
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
    "/src/documents/pdf-shape-style-popover.js?v=__BUILD__",
    "/src/documents/pdf-shape-markdown.js?v=__BUILD__",
    "/src/documents/pdf-shape-panel.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-timing.js?v=__BUILD__",
    "/src/documents/pdf-multi.js?v=__BUILD__",
    "/src/panels/highlight-cycle.js?v=__BUILD__",
    "/src/format/highlight-colors.js?v=__BUILD__",
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
// A text box's markdown is pictured by html-to-image (src/documents/
// pdf-region-marks.js). Without it that one case says so and is skipped.
let htmlToImage = null;
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`annotations-check: could not obtain html-to-image ${HTMLTOIMAGE_VERSION} (${error?.message || error}) — the rendered-picture case will be skipped.`);
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
  // With the typewriter armed, the first tap already opens it (see the
  // typewriter section); the second finds it open still.
  check("...and a tap on it with Text armed opens its words again", free.reopened === "see Fig. 3", JSON.stringify(free));

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
    const typed = shapes.find((r) => r.shape.type === "text" && r.shape.text.trim());
    const arrowEntry = entries.find((e) => e.highlightId === arrow?.id);
    const calloutEntry = entries.find((e) => e.highlightId === callout?.id);
    const typedEntry = entries.find((e) => e.highlightId === typed?.id);
    return {
      calloutPictured: Boolean(calloutEntry?.region),
      typedWords: typed?.shape.text || null,
      typedPictured: Boolean(typedEntry?.region),
      typedQuote: typedEntry?.markdown || "",
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
  // Listed ONCE: a callout as its picture (it points at something on the page),
  // a text box as its words rendered — never a picture AND the same words again.
  check("...a callout is named by its words and shown as its picture, with no second copy of the words", listed.calloutLabel.startsWith("Sign error") && listed.calloutText?.startsWith("Sign error") && listed.calloutPictured && listed.calloutQuote === "", JSON.stringify(listed));
  check("...a text box is listed once, as its words (markdown, unescaped), with no picture", Boolean(listed.typedWords) && !listed.typedPictured && listed.typedQuote.replace(/ {2}\n/g, "\n") === listed.typedWords, JSON.stringify(listed));
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


// ── Text on a PDF without a pen: the bar's + menu, and a finger's tap ─────
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const plus = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(4, 0, { smooth: false });
    await api.whenDocumentPageReady(4);
    await settle(300);
    api.toggleInkRail(true);
    api.chooseInkTool("pen");
    await settle(100);
    const group = document.querySelector("#documentInkRail .ink-rail-page");
    const shown = group && getComputedStyle(group).display !== "none";
    const btn = document.getElementById("inkRailAddBtn");
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    await settle(100);
    const menu = document.getElementById("inkRailAddMenu");
    const rows = Array.from(menu.querySelectorAll(".ink-rail-menu-item")).filter((n) => getComputedStyle(n).display !== "none").map((n) => n.textContent.trim());
    const before = api.documentShapes(null).length;
    const text = menu.querySelector('[data-hw-action="add-text"]');
    const enabled = !text.disabled;
    text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    await settle(150);
    const armed = api.inkTool() === "shape" && api.shapeType() === "text";
    const lit = document.getElementById("documentTextBtn")?.getAttribute("aria-pressed") === "true";
    // ...and the tap that says where.
    await window.__drag("text", [window.__at(4, 0.3, 0.1)], { pointerType: "touch", id: 80 });
    await settle(250);
    const made = api.documentShapes(null).at(-1);
    const editor = document.querySelector(".pdf-shape-editor");
    if (editor) { editor.textContent = "typed with a finger"; editor.blur(); }
    await settle(150);
    return { label: btn.textContent.trim(), shown, rows, enabled, armed, lit, made: api.documentShapes(null).length - before, type: made?.shape?.type, page: made?.page, opened: Boolean(editor), text: api.documentHighlightById(made?.id)?.shape?.text };
  }`);
  check("on a PDF the pen bar's + is there, with Text and Sticky note and no Page row", plus.shown && plus.rows.includes("Text") && plus.rows.includes("Sticky note") && plus.label === "+ Add" && plus.rows.includes("Text block") && !plus.rows.some((r) => /Page at the end/.test(r)) && plus.enabled, JSON.stringify(plus));
  check("+ → Text arms the typewriter (its Text button lit), and a tap puts a cursor there to type at", plus.armed && plus.lit && plus.made === 1 && plus.type === "text" && plus.page === 4 && plus.opened && plus.text === "typed with a finger", JSON.stringify(plus));

  const finger = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.chooseInkTool("shape");
    api.selectShape(null);
    api.setShapeType("sticky");
    const before = api.documentShapes(4).length;
    await window.__drag("sticky", [window.__at(4, 0.8, 0.12)], { pointerType: "touch", id: 77 });
    await settle(200);
    const tapped = api.documentShapes(4).length - before;
    const opened = api.isHighlightNoteEditorOpen();
    api.closeHighlightNoteEditor?.();
    // ...and a finger that moves is still a scroll.
    api.setShapeType("text");
    await window.__drag("text", [window.__at(4, 0.3, 0.2), window.__at(4, 0.3, 0.3), window.__at(4, 0.3, 0.4)], { pointerType: "touch", id: 78 });
    await settle(150);
    const swiped = api.documentShapes(4).length - before - tapped;
    // ...and with a line armed, a finger's tap makes nothing.
    api.setShapeType("arrow");
    await window.__drag("arrow", [window.__at(4, 0.6, 0.3)], { pointerType: "touch", id: 79 });
    await settle(150);
    const arrowTap = api.documentShapes(4).length - before - tapped - swiped;
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    return { tapped, opened, swiped, arrowTap };
  }`);
  check("a finger's tap with Sticky note armed places one and opens its note", finger.tapped === 1 && finger.opened, JSON.stringify(finger));
  check("...a finger that moves still scrolls, and a tap with Arrow armed makes nothing", finger.swiped === 0 && finger.arrowTap === 0, JSON.stringify(finger));
});

// ── The typewriter, and settings kept per tab ──────────────────────────────
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const typed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(4, 0, { smooth: false });
    await settle(300);
    // The bar shut and the pen armed: Text is one press from the top row.
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    await settle(80);
    const button = document.getElementById("documentTextBtn");
    const box = button?.getBoundingClientRect();
    const visible = Boolean(box && box.width > 0 && box.height > 0) && Boolean(button.closest("#viewModeRow"));
    const inRail = Boolean(document.querySelector('#documentInkRail [data-ink-action="typewriter"]'));
    const flyoutText = Boolean(document.querySelector('#inkRailShapeMenu [data-shape-type="text"]'));
    button.click();
    await settle(100);
    const armed = api.inkTool() === "shape" && api.shapeType() === "text";
    const panelClosed = document.getElementById("inkRailPopover").hidden;
    const rail = document.getElementById("documentInkRail");
    const textBar = !rail.hidden && rail.classList.contains("is-typing")
      && getComputedStyle(rail.querySelector(".ink-rail-tools")).display === "none"
      && getComputedStyle(rail.querySelector(".ink-rail-typing")).display !== "none";
    const lit = button.getAttribute("aria-pressed") === "true" && document.getElementById("documentInkBtn").getAttribute("aria-pressed") === "false";
    const before = api.documentShapes(4).length;
    // A MOUSE types, with the bar opened by Text alone.
    await window.__drag("text", [window.__at(4, 0.15, 0.2)], { pointerType: "mouse" });
    await settle(200);
    const editor = document.querySelector(".pdf-shape-editor");
    const focused = document.activeElement === editor;
    const narrow = editor.getBoundingClientRect().width;
    editor.textContent = "a typewriter line that is longer";
    await settle(30);
    const wide = editor.getBoundingClientRect().width;
    // A tap somewhere else: the first is kept, a second cursor opens there.
    await window.__drag("text", [window.__at(4, 0.6, 0.35)]);
    await settle(200);
    const second = document.querySelector(".pdf-shape-editor");
    second.textContent = "second";
    second.blur();
    await settle(150);
    const shapes = api.documentShapes(4).slice(before);
    const first = shapes[0];
    const w = Math.abs(first.shape.p[1][0] - first.shape.p[0][0]);
    // One tap on typed text, the typewriter armed, opens it again.
    const vp = api.pdfPageViewport(4);
    const r = document.querySelector('.pdf-page[data-page-number="4"]').getBoundingClientRect();
    const c = vp.convertToViewportPoint(first.shape.p[0][0] + 4, (first.shape.p[0][1] + first.shape.p[1][1]) / 2);
    api.selectShape(null);
    await window.__drag("text", [[r.left + c[0], r.top + c[1]]]);
    await settle(150);
    const reopened = document.querySelector(".pdf-shape-editor")?.textContent || null;
    api.commitShapeTextEditor();
    api.selectShape(null);
    // Text pressed again: the pen back, and the bar shut as it was.
    button.click();
    await settle(80);
    const backToPen = api.inkTool() === "pen" && document.getElementById("documentInkRail").hidden;
    const textUnlit = button.getAttribute("aria-pressed") === "false";
    // ...and from the pen's open bar, Done on the Text bar puts the pen back with its bar.
    api.toggleInkRail(true);
    api.chooseInkTool("pen");
    button.click();
    await settle(60);
    rail.querySelector('[data-ink-action="typewriter-done"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    await settle(60);
    const doneBack = api.inkTool() === "pen" && !rail.hidden && !rail.classList.contains("is-typing");
    api.toggleInkRail(false);
    return {
      backToPen, textUnlit, doneBack, inRail, flyoutText, textBar, lit,
      visible, armed, panelClosed, focused, grew: wide > narrow + 20, made: shapes.length,
      texts: shapes.map((r) => r.shape.text), fit: first.shape.fit, width: w, colour: first.shape.font.color, reopened
    };
  }`);
  check("Text is a button of its own in the top row, not on the pen's bar nor in the Shapes list", typed.visible && !typed.inRail && !typed.flyoutText, JSON.stringify(typed));
  check("one press arms the typewriter with the bar as a Text bar, Text lit and the pen not", typed.armed && typed.panelClosed && typed.textBar && typed.lit, JSON.stringify(typed));
  check("a tap puts a cursor there (a mouse too), and the line grows as it is typed", typed.focused && typed.grew, JSON.stringify(typed));
  check("a tap elsewhere keeps what was typed and starts again there", typed.made === 2 && typed.texts.join("|") === "a typewriter line that is longer|second", JSON.stringify(typed));
  check("typed text is boxed to its words, in the tool's own text colour", typed.fit === true && typed.width > 60 && typed.colour === "#16181d", JSON.stringify(typed));
  check("one tap on typed text, with Text armed, opens it to type in", typed.reopened === "a typewriter line that is longer", JSON.stringify(typed));
  check("Text pressed again puts the pen back and the bar shut as it was; Done does the same from an open bar", typed.backToPen && typed.textUnlit && typed.doneBack, JSON.stringify(typed));

  // ── Restyling what is already on the page ──────────────────────────────
  const restyle = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const pop = () => document.querySelector(".shape-style-popover");
    const popUp = () => Boolean(pop() && !pop().hidden && pop().getBoundingClientRect().width > 0);
    const text = api.documentShapes(4).find((r) => r.shape.type === "text" && r.shape.text === "second");
    // The pen armed and its bar shut: a tap on typed text opens its menu, which has Style.
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    api.selectShape(null);
    await settle(80);
    const box = document.querySelector('.pdf-shape-text[data-highlight-id="' + text.id + '"]').getBoundingClientRect();
    const x = box.left + 6, y = box.top + box.height / 2;
    (document.elementFromPoint(x, y) || document.getElementById("documentView")).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }));
    await settle(150);
    const styleRow = document.querySelector(".mark-menu .mark-menu-style-shape");
    const offered = Boolean(styleRow && !styleRow.hidden);
    // A highlight's menu does not have it.
    styleRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    await settle(150);
    const opened = popUp() && api.selectedShapeRecord()?.id === text.id;
    // Under the text, or over it where there is no room under — never on it.
    const pr0 = pop().getBoundingClientRect();
    const below = opened && (pr0.top >= box.bottom - 2 || pr0.bottom <= box.top + 2);
    const rows = Array.from(pop().querySelectorAll("[data-shape-row]")).filter((n) => !n.hidden).map((n) => n.dataset.shapeRow);
    const sizeBefore = api.documentHighlightById(text.id).shape.font.size;
    const fire = (sel) => pop().querySelector(sel).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    fire('[data-shape-font-step="1"]');
    fire("[data-shape-bold]");
    fire('[data-shape-stroke="' + pop().querySelector("[data-shape-stroke]:nth-of-type(3)").dataset.shapeStroke + '"]');
    await settle(80);
    const after = api.documentHighlightById(text.id).shape;
    const grown = after.font.size > sizeBefore && after.font.bold === true && after.font.color !== "#16181d";
    const painted = document.querySelector('.pdf-shape-text[data-highlight-id="' + text.id + '"]');
    const paintedBold = painted && getComputedStyle(painted).fontWeight === "700";
    // One undo takes the colour back, as one step of the pen's ring.
    api.undoInk();
    await settle(60);
    const undone = api.documentHighlightById(text.id).shape.font.color !== after.font.color && api.documentHighlightById(text.id).shape.font.bold === true;
    // Done puts it down, and the popover with it.
    fire('[data-shape-style-action="done"]');
    await settle(60);
    const closed = !popUp() && !api.selectedShapeRecord();

    // An arrow, tapped with Shapes armed: the popover is up at once, no menu.
    api.toggleInkRail(true);
    api.chooseInkTool("shape");
    api.setShapeType("arrow");
    api.selectShape(null);
    await window.__drag("arrow", [window.__at(4, 0.1, 0.42), window.__at(4, 0.2, 0.45), window.__at(4, 0.35, 0.48)], { pointerType: "pen", id: 91 });
    await settle(150);
    const arrow = api.documentShapes(4).at(-1);
    api.selectShape(null);
    await settle(50);
    const vp = api.pdfPageViewport(4);
    const pr = document.querySelector('.pdf-page[data-page-number="4"]').getBoundingClientRect();
    const mid = vp.convertToViewportPoint((arrow.shape.p[0][0] + arrow.shape.p[1][0]) / 2, (arrow.shape.p[0][1] + arrow.shape.p[1][1]) / 2);
    await window.__drag("arrow", [[pr.left + mid[0], pr.top + mid[1]]], { pointerType: "pen", id: 92 });
    const mx = pr.left + mid[0], my = pr.top + mid[1];
    (document.elementFromPoint(mx, my) || document.getElementById("documentView")).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: mx, clientY: my, detail: 1 }));
    await settle(150);
    const arrowPop = popUp() && api.selectedShapeRecord()?.id === arrow.id && !api.isMarkMenuOpen?.();
    // Small until asked: picked up, the popover is a row of actions and the
    // panel is folded away; Aa Style opens it.
    const panelOf = () => pop().querySelector(".shape-pop-panel");
    const arrowCompact = pop().classList.contains("is-compact") && panelOf().hidden;
    fire('[data-shape-style-action="style"]');
    await settle(60);
    const arrowExpanded = !panelOf().hidden && !pop().classList.contains("is-compact");
    const arrowRows = Array.from(pop().querySelectorAll("[data-shape-row]")).filter((n) => !n.hidden).map((n) => n.dataset.shapeRow);
    fire('[data-shape-dash="dash"]');
    await settle(60);
    const dashed = api.documentHighlightById(arrow.id).shape.dash === "dash";
    api.selectShape(null);

    // While typing: A+ grows the words under the cursor, and the typing goes on.
    api.toggleTypewriter(true);
    await window.__drag("text", [window.__at(4, 0.1, 0.3)]);
    await settle(200);
    const editor = document.querySelector(".pdf-shape-editor");
    editor.textContent = "styled mid-sentence";
    const typingPop = popUp();
    // While typing: the style as an option, not as the panel — Aa Style and
    // Done, and nothing else on screen.
    const typingButtons = Array.from(pop().querySelectorAll("[data-shape-style-action]")).filter((n) => !n.hidden).map((n) => n.dataset.shapeStyleAction);
    const typingCompact = panelOf().hidden && typingButtons.join() === "style,done";
    fire('[data-shape-style-action="style"]');
    await settle(60);
    const typingStillTyping = Boolean(document.querySelector(".pdf-shape-editor")) && !panelOf().hidden;
    const fontBefore = parseFloat(editor.style.fontSize);
    fire('[data-shape-font-step="1"]');
    fire('[data-shape-font-step="1"]');
    await settle(80);
    const liveEditor = document.querySelector(".pdf-shape-editor");
    const live = Boolean(liveEditor) && parseFloat(liveEditor.style.fontSize) > fontBefore && liveEditor.textContent === "styled mid-sentence";
    api.commitShapeTextEditor();
    await settle(80);
    const typedRec = api.documentShapes(4).at(-1);
    const keptText = typedRec.shape.text === "styled mid-sentence" && typedRec.shape.font.size > 12;
    api.selectShape(null);
    api.toggleTypewriter(false);

    // The menu's own swatch on typed text changes the WORDS' colour.
    api.recolourDocumentHighlight(typedRec.id, "green");
    const recoloured = api.documentHighlightById(typedRec.id).shape.font.color === api.MARK_HIGHLIGHT_HEX.green;
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    return { offered, opened, below, rows, grown, paintedBold, undone, closed, arrowPop, arrowCompact, arrowExpanded, arrowRows, dashed, typingPop, typingButtons, typingCompact, typingStillTyping, live, keptText, recoloured };
  }`);
  check("tapping typed text with the pen opens its menu, which has Style", restyle.offered, JSON.stringify(restyle));
  check("Style puts the style popover up beside the text (not over it), with its colour, size and weight", restyle.opened && restyle.below && restyle.rows.includes("font") && !restyle.rows.includes("snap"), JSON.stringify(restyle));
  check("...A+, bold and a colour there restyle that text, and it is painted so", restyle.grown && restyle.paintedBold, JSON.stringify(restyle));
  check("...each a step undo takes back, and Done puts it down", restyle.undone && restyle.closed, JSON.stringify(restyle));
  check("an arrow tapped with Shapes armed has the popover at once — folded, with Aa Style to open it", restyle.arrowPop && restyle.arrowCompact && restyle.arrowExpanded, JSON.stringify(restyle));
  check("...and Aa Style shows its line and heads, which restyle it", restyle.arrowRows.includes("heads") && restyle.arrowRows.includes("dash") && restyle.dashed, JSON.stringify(restyle));
  check("while typing, only Aa Style and Done are offered — no panel until asked, and asking keeps the typing going", restyle.typingCompact && restyle.typingStillTyping, JSON.stringify(restyle));
  check("while typing, the popover is up and A+ grows the words under the cursor, which are kept", restyle.typingPop && restyle.live && restyle.keptText, JSON.stringify(restyle));
  check("a menu swatch on typed text changes the words' colour", restyle.recoloured, JSON.stringify(restyle));

  const tabs = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // The pen: set on a PDF, untouched on a Canvas and on Notes.
    const canvasBefore = api.inkPreferences("notebook").pen;
    const notesBefore = api.inkPreferences("notes").pen;
    api.writeInkPreferences({ pen: "violet" }, "doc");
    const pen = { doc: api.inkPreferences("doc").pen, notebook: api.inkPreferences("notebook").pen, notes: api.inkPreferences("notes").pen, canvasBefore, notesBefore };
    // Shapes on a PDF.
    api.setShapeSettings({ stroke: "#0d9488" });
    const shapeDoc = api.currentShapeSettings().stroke;
    const shapeCanvas = api.normalizeShapeSettings(api.inkPreferences("notebook").shape).stroke;
    // The highlight colour: set on the PDF tab, read on the Notes tab.
    api.setRenderDefault("highlight", "blue");
    const onPdf = api.renderFormatDefaults.highlight;
    const mode = api.state.viewMode;
    api.state.viewMode = "notes";
    const onNotes = api.renderFormatDefaults.highlight;
    api.setRenderDefault("highlight", "pink");
    api.state.viewMode = mode;
    const backOnPdf = api.renderFormatDefaults.highlight;
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    return { pen, shapeDoc, shapeCanvas, onPdf, onNotes, backOnPdf };
  }`);
  check("the pen set on a PDF is not the Canvas's or the drawing sheet's", tabs.pen.doc === "violet" && tabs.pen.notebook === tabs.pen.canvasBefore && tabs.pen.notes === tabs.pen.notesBefore, JSON.stringify(tabs.pen));
  check("shape settings set on a PDF are not the Canvas's", tabs.shapeDoc === "#0d9488" && tabs.shapeCanvas !== "#0d9488", JSON.stringify(tabs));
  check("the highlight colour chosen on a PDF is not the Notes tab's, and back again", tabs.onPdf === "blue" && tabs.onNotes !== "blue" && tabs.backOnPdf === "blue", JSON.stringify(tabs));
});

// ── Text and pictures placed on a page: markdown, picked up, listed once ──────
//
// Driven with TRUSTED input (Input.dispatchMouseEvent / dispatchTouchEvent)
// where it matters: a drag that "stops after a few pixels" on a phone is the
// browser cancelling the pointer — touch-action, a native image drag — and a
// dispatchEvent from inside the page goes round every one of those.
sections.push(async () => {
  await page.evaluate(POINTER_SRC);
  const mouse = async (type, x, y, buttons) => page.call("Input.dispatchMouseEvent", {
    type, x, y, button: "left", buttons, clickCount: 1, pointerType: "mouse"
  });
  const touch = async (type, points) => page.call("Input.dispatchTouchEvent", {
    type, touchPoints: points.map(([x, y]) => ({ x, y, radiusX: 8, radiusY: 8, force: 1 }))
  });
  const glide = async (from, to, steps, step) => {
    for (let i = 1; i <= steps; i += 1) {
      await step(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
      await new Promise((r) => setTimeout(r, 16));
    }
  };

  // A text box of markdown, made the way the Text tool makes one, on page 1.
  const made = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // Gestures are traced while diagnostics are on — read back into a failing
    // case's detail, which is what the trace is for.
    api.setPdfDiagnostics(true);
    api.toggleTypewriter?.(false);
    api.chooseInkTool("pen");
    api.toggleInkRail(false);
    api.selectShape(null);
    document.querySelector('.pdf-page[data-page-number="1"]').scrollIntoView({ block: "start" });
    await settle(700);
    const record = api.addDocumentShape(1, {
      type: "text", p: [[90, 620], [130, 640]], fit: true, width: 0.3, stroke: "#16181d",
      font: { size: 13, bold: false, align: "left", color: "#16181d" },
      text: "**Bold claim** and $x^2$\\nsecond line"
    });
    for (let i = 0; i < 40; i += 1) {
      await settle(100);
      if (api.shapeTextBodyState(record.id) === "rendered") break;
    }
    await settle(300);
    // Settled means settled: the fitter writes only when the box and the record
    // disagree, so once they agree nothing more is written — no loop of fits
    // (each one an autosave and a sync push) on a box nobody is touching.
    const fits = () => api.pdfGestureLog().filter((g) => g.what === "fitted to its words").length;
    const fitsBefore = fits();
    await settle(1500);
    const fitsAfter = fits();
    const box = document.querySelector('.pdf-shape-text[data-highlight-id="' + record.id + '"]');
    const rect = box.getBoundingClientRect();
    const vp = api.pdfPageViewport(1);
    const stored = api.documentHighlightById(record.id).shape.p;
    const storedWidth = Math.abs(stored[1][0] - stored[0][0]) * vp.scale;
    const storedHeight = Math.abs(stored[1][1] - stored[0][1]) * vp.scale;
    return {
      id: record.id,
      state: api.shapeTextBodyState(record.id),
      strong: box.querySelector("strong")?.textContent || "",
      katex: Boolean(box.querySelector(".katex")),
      lines: box.querySelectorAll("br").length,
      fitted: Math.abs(storedWidth - rect.width) <= 2 * vp.scale && Math.abs(storedHeight - rect.height) <= 2 * vp.scale,
      sizes: [Math.round(storedWidth), Math.round(rect.width), Math.round(storedHeight), Math.round(rect.height)],
      takesPress: getComputedStyle(box).pointerEvents === "auto" && getComputedStyle(box).touchAction === "none",
      centre: [rect.left + rect.width / 2, rect.top + rect.height / 2],
      scale: vp.scale,
      p0: stored[0].slice(),
      fitsBefore,
      fitsAfter
    };
  }`);
  check("...and once it agrees with its words it is left alone — no stream of re-fits", made.fitsAfter === made.fitsBefore, `${made.fitsBefore} → ${made.fitsAfter} fits`);
  check("a text box holds markdown: bold and maths rendered on the page, Enter still a new line", made.state === "rendered" && made.strong === "Bold claim" && made.katex && made.lines >= 1, JSON.stringify(made));
  check("...and its stored box follows the rendered words, so a press lands where they are", made.fitted, JSON.stringify(made.sizes));
  check("...and the box takes a press, with a finger too (touch-action: none)", made.takesPress, JSON.stringify(made));

  // Picked up with the PEN tool armed and its bar shut — no Shapes, no Text.
  const [cx, cy] = made.centre;
  await mouse("mouseMoved", cx, cy, 0);
  await mouse("mousePressed", cx, cy, 1);
  await glide([cx, cy], [cx + 60, cy + 40], 6, (x, y) => mouse("mouseMoved", x, y, 1));
  await mouse("mouseReleased", cx + 60, cy + 40, 0);
  const afterMouse = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    await settle(250);
    return { p0: api.documentHighlightById(id).shape.p[0].slice(), inked: (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink" && r.page === 1).length };
  }`, made.id);
  const mdx = (afterMouse.p0[0] - made.p0[0]) * made.scale;
  const mdy = (afterMouse.p0[1] - made.p0[1]) * made.scale;
  check("a mouse drags typed text with no tool armed, by the distance dragged", Math.abs(mdx - 60) <= 3 && Math.abs(mdy + 40) <= 3, `moved ${mdx.toFixed(1)}, ${mdy.toFixed(1)} px`);

  // ...and a finger, which before could never move one.
  const at = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    api.selectShape(null);
    await settle(120);
    const r = document.querySelector('.pdf-shape-text[data-highlight-id="' + id + '"]').getBoundingClientRect();
    return { centre: [r.left + r.width / 2, r.top + r.height / 2], p0: api.documentHighlightById(id).shape.p[0].slice(), scroll: document.getElementById("documentView").scrollTop };
  }`, made.id);
  const [tx, ty] = at.centre;
  await touch("touchStart", [[tx, ty]]);
  await glide([tx, ty], [tx - 50, ty + 30], 6, (x, y) => touch("touchMove", [[x, y]]));
  await touch("touchEnd", []);
  const afterTouch = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    await settle(250);
    return { p0: api.documentHighlightById(id).shape.p[0].slice(), scroll: document.getElementById("documentView").scrollTop };
  }`, made.id);
  const tdx = (afterTouch.p0[0] - at.p0[0]) * made.scale;
  const tdy = (afterTouch.p0[1] - at.p0[1]) * made.scale;
  check("a finger drags typed text too, and the page does not scroll under it", Math.abs(tdx + 50) <= 4 && Math.abs(tdy + 30) <= 4 && afterTouch.scroll === at.scroll, `moved ${tdx.toFixed(1)}, ${tdy.toFixed(1)} px · scroll ${at.scroll} → ${afterTouch.scroll}`);

  // A tap selects it (the small bar); a second tap opens it to type in.
  const tapped = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    // The drag above left it picked up; put down, so the first tap is a FIRST tap.
    api.selectShape(null);
    await settle(100);
    const r = document.querySelector('.pdf-shape-text[data-highlight-id="' + id + '"]').getBoundingClientRect();
    const pt = [r.left + r.width / 2, r.top + r.height / 2];
    await window.__drag("text", [pt], { pointerType: "touch", id: 77 });
    await settle(150);
    const pop = document.querySelector(".shape-style-popover");
    const selected = api.selectedShapeRecord()?.id === id;
    const compact = Boolean(pop && !pop.hidden && pop.classList.contains("is-compact"));
    await window.__drag("text", [pt], { pointerType: "touch", id: 78 });
    await settle(200);
    const editor = document.querySelector('.pdf-shape-editor[data-highlight-id="' + id + '"]');
    const source = editor?.textContent || "";
    api.commitShapeTextEditor();
    await settle(200);
    return { selected, compact, editing: Boolean(editor), source };
  }`, made.id);
  check("a tap on typed text selects it with the small Style bar; a second tap types in it, as markdown source", tapped.selected && tapped.compact && tapped.editing && tapped.source.startsWith("**Bold claim**"), JSON.stringify(tapped));

  // No caps: a size typed into the box is the size, however large or small.
  const sized = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    api.selectShape(id);
    api.expandShapeStylePopover(id);
    await settle(100);
    const input = document.querySelector(".shape-style-popover [data-shape-font-value]");
    input.focus();
    input.value = "300";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(150);
    const big = api.documentHighlightById(id).shape.font.size;
    input.value = "2.5";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(150);
    const small = api.documentHighlightById(id).shape.font.size;
    input.value = "abc";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(150);
    const refused = api.documentHighlightById(id).shape.font.size;
    input.blur();
    const stepped = api.steppedFontSize(2.5, -1) > 0 && api.steppedFontSize(96, 1) === 98;
    api.setShapeSettings({ fontSize: 13 });
    api.selectShape(null);
    await settle(150);
    return { big, small, refused, stepped };
  }`, made.id);
  check("a type size is any number typed — 300pt and 2.5pt both kept, nonsense refused, A± uncapped", sized.big === 300 && sized.small === 2.5 && sized.refused === 2.5 && sized.stepped, JSON.stringify(sized));

  // The side-by-side pane: listed once, and lit on the page as the list reaches it.
  const pane = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    const envelopes = api.documentHighlightMarks(id).filter((n) => n.classList.contains("pdf-mark-envelope")).length;
    api.openHighlightSplit("document");
    await settle(900);
    const card = document.querySelector('#highlightCycleBody .hl-note[data-highlight-key="doc:' + id + '"]');
    const pictured = Boolean(card?.querySelector(".hl-note-region"));
    const rendered = Boolean(card?.querySelector(".hl-note-quote strong"));
    let lit = false;
    for (let i = 0; i < 60 && !lit; i += 1) {
      const current = document.querySelector("#highlightCycleBody .hl-note.is-current")?.dataset.highlightKey || "";
      if (current === "doc:" + id) {
        await settle(200);
        lit = Boolean(document.querySelector('.pdf-mark-envelope.is-linked[data-highlight-id="' + id + '"]'));
        break;
      }
      api.cycleHighlightBy(1);
      await settle(120);
    }
    const glow = getComputedStyle(document.querySelector('.pdf-mark-envelope[data-highlight-id="' + id + '"]') || document.body).boxShadow;
    api.closeHighlightSplit();
    await settle(400);
    const flashed = api.flashDocumentHighlight(id);
    return { envelopes, listed: Boolean(card), pictured, rendered, lit, glow: glow !== "none", flashed };
  }`, made.id);
  check("the side-by-side pane lists typed text once — its words rendered, no picture of them as well", pane.listed && !pane.pictured && pane.rendered, JSON.stringify(pane));
  check("...and as the list reaches it, it glows on the page; a jump to it pulses", pane.envelopes >= 1 && pane.lit && pane.glow && pane.flashed, JSON.stringify(pane));

  // A picture on a PDF page, dragged by its body with a finger and a mouse.
  const pic = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // Placed as a block and turned into a picture in place: the upload path
    // (storeImageOrQueue) needs an account, and what is asserted here is the
    // picture on the page, not where its bytes went. The record is exactly the
    // shape addDocumentImageBlock writes.
    const text = api.addDocumentBlock(1, { x: 300, y: 400 });
    api.commitBlockEdit();
    await settle(200);
    const record = api.state.meta.pdfBlocks.find((entry) => entry.id === text.id);
    Object.assign(record, { kind: "image", md: "", w: 120, h: 60, alt: "",
      src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8//8/AzJgYkAFAB8FAv3EhrhCAAAAAElFTkSuQmCC" });
    document.querySelector('[data-pdf-block="' + text.id + '"]')?.remove();
    api.repaintDocumentBlocks();
    await settle(500);
    const added = api.documentBlocks().find((entry) => entry.id === text.id);
    if (!added || added.kind !== "image") return { error: "no picture block" };
    api.selectBlock(null);
    await settle(100);
    const node = document.querySelector('[data-pdf-block="' + added.id + '"]');
    const img = node.querySelector("img");
    const r = node.getBoundingClientRect();
    return { id: added.id, x: added.x, y: added.y, draggable: img.draggable, centre: [r.left + r.width / 2, r.top + r.height / 2], scale: api.pdfPageViewport(1).scale };
  }`);
  if (pic.error) { check("a picture is placed on a PDF page", false, pic.error); return; }
  check("a picture's image is never the browser's to drag (draggable=false)", pic.draggable === false, JSON.stringify(pic));
  const [ix, iy] = pic.centre;
  await touch("touchStart", [[ix, iy]]);
  await glide([ix, iy], [ix + 40, iy + 50], 6, (x, y) => touch("touchMove", [[x, y]]));
  await touch("touchEnd", []);
  const picAfter = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    await settle(250);
    const b = api.documentBlocks().find((entry) => entry.id === id);
    return { x: b.x, y: b.y };
  }`, pic.id);
  const pdx = (picAfter.x - pic.x) * pic.scale;
  picAfter.trace = await page.evaluate(`() => window.__recall.api.pdfGestureLog().slice(-4).map((g) => g.scope + " " + g.what + " " + g.detail)`);
  const pdy = (picAfter.y - pic.y) * pic.scale;
  check("a finger drags a picture by its body", Math.abs(pdx - 40) <= 4 && Math.abs(pdy + 50) <= 4, `moved ${pdx.toFixed(1)}, ${pdy.toFixed(1)} px · ${picAfter.trace.join(" | ")}`);
  const offPage = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    document.querySelector('[data-pdf-block="' + id + '"]').scrollIntoView({ block: "center" });
    await settle(400);
    const node = document.querySelector('[data-pdf-block="' + id + '"]');
    const r = node.getBoundingClientRect();
    const pageBox = document.querySelector('.pdf-page[data-page-number="1"]').getBoundingClientRect();
    const from = [r.left + r.width / 2, r.top + r.height / 2];
    const hit = document.elementFromPoint(from[0], from[1]);
    return { from, to: [pageBox.left - 600, r.top + r.height / 2], hit: hit ? hit.tagName + "." + hit.className : "none", inView: [window.innerWidth, window.innerHeight] };
  }`, pic.id);
  await mouse("mouseMoved", offPage.from[0], offPage.from[1], 0);
  await mouse("mousePressed", offPage.from[0], offPage.from[1], 1);
  await glide(offPage.from, offPage.to, 8, (x, y) => mouse("mouseMoved", x, y, 1));
  await mouse("mouseReleased", offPage.to[0], offPage.to[1], 0);
  const clamped = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    await settle(250);
    const b = api.documentBlocks().find((entry) => entry.id === id);
    const vb = api.pdfPageViewport(1).viewBox;
    api.deleteBlock(id);
    return { right: b.x + b.w, keep: vb[0] + api.PDF_BLOCK_KEEP_ON_PAGE, trace: api.pdfGestureLog().slice(-4).map((g) => g.scope + " " + g.what + " " + g.detail) };
  }`, pic.id);
  check("a mouse drags it too — and a drag off the page edge stops with part of it still on the paper", clamped.right >= clamped.keep - 0.5 && clamped.right <= clamped.keep + 1.5, JSON.stringify({ ...clamped, from: offPage.from, hit: offPage.hit, view: offPage.inView }));

  // The markdown in a picture of the page: the words rendered, not printed plain.
  const pictured = await page.evaluate(`async (id) => {
    const { api } = window.__recall;
    const record = api.documentHighlightById(id);
    const source = { slot: "doc", pdfId: api.activePdfId(api.state.meta) };
    const doc = api.currentPdfDocument();
    const pdfPage = await doc.getPage(1);
    // What went wrong, if it did, is in the detail: the rasteriser warns and
    // falls back to plain words rather than throwing.
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => { warned.push(args.map((a) => String(a?.stack || a?.message || a)).join(" ").slice(0, 300)); warn.apply(console, args); };
    let rasters = [];
    try {
      ({ rasters } = await api.rasteriseRegionBlocks(pdfPage, source, 1, record.quads[0].rect, 2));
    } finally {
      console.warn = warn;
    }
    const mine = rasters.find((r) => r.kind === "shape-text" && r.block.id === id);
    api.removeDocumentHighlight(id, { undo: false });
    return { found: Boolean(mine), plain: Boolean(mine?.plain), size: mine ? [mine.canvas.width, mine.canvas.height] : null, warned };
  }`, made.id);
  if (htmlToImage) check("a picture of the page draws a text box's markdown rendered, over its box", pictured.found && !pictured.plain, JSON.stringify(pictured));
  else console.log("  skip  a text box's markdown in a picture — html-to-image not available");
  check("...and never loses the words: without the renderer they are drawn plain", pictured.found, JSON.stringify(pictured));
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
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
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
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.selectShape(null);
      api.closeInkRailPopups?.();
      api.chooseInkTool("pen");
      await settle(100);
      document.getElementById("inkRailAddBtn").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      await settle(200);
    }`);
    await snap("add-menu.png");
    // The typewriter, mid-sentence.
    await page.evaluate(POINTER_SRC);
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      document.getElementById("inkRailAddMenu").hidden = true;
      api.closeInkRailPopups?.();
      api.toggleInkRail(false);
      document.getElementById("documentTextBtn").click();
      await settle(100);
      await window.__drag("text", [window.__at(2, 0.62, 0.36)]);
      await settle(200);
      const editor = document.querySelector(".pdf-shape-editor");
      if (editor) editor.textContent = "Typed straight onto the page";
      await settle(150);
    }`);
    // The Text bar, and the style popover under the words being typed.
    await snap("typewriter.png");
    // An arrow already on the page, picked up from its menu's Style row.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.commitShapeTextEditor();
      api.selectShape(null);
      api.toggleTypewriter(false);
      api.chooseInkTool("pen");
      api.toggleInkRail(false);
      const arrow = api.documentShapes(2).find((r) => r.shape.type === "arrow");
      const anchor = document.querySelector('.pdf-shape[data-highlight-id="' + arrow.id + '"]');
      api.openMarkMenuWith(anchor, arrow.id, api.DOCUMENT_MARK_HANDLERS, arrow.color);
      await settle(150);
      document.querySelector(".mark-menu .mark-menu-style-shape").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      await settle(250);
    }`);
    await snap("shape-style-popover.png");
    // The top row on a phone: ✎ and Text beside the tabs, nothing clipped.
    await page.evaluate(`async () => { window.__recall.api.selectShape(null); }`);
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(`async () => { await window.__recall.settle(500); }`);
    await snap("phone-row.png");
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
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
