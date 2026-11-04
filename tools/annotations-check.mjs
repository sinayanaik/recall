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
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/format/mark-styles.js?v=__BUILD__",
    "/src/format/selection-tools.js?v=__BUILD__",
    "/src/notes/mark-menu.js?v=__BUILD__",
    "/src/render/canvas-record.js?v=__BUILD__",
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

  if (SHOT) {
    const clip = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.closeMyDecksPanel();
      document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
      api.scrollToDocumentPage(1, 0, { smooth: false });
      await settle(800);
      const r = document.querySelector('.pdf-page[data-page-number="1"]').getBoundingClientRect();
      return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, 1280), height: Math.min(r.height, 900 - Math.max(0, r.top)), scale: 1 };
    }`);
    const shot = await page.call("Page.captureScreenshot", { format: "png", clip });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    console.log(`  shot  ${SHOT}`);
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
