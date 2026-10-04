// Does SCROLLING stay cheap — on a phone, on a paper and on a note?
//
//   node tools/scroll-perf-check.mjs
//   node tools/scroll-perf-check.mjs --report     # print the numbers, assert nothing
//   node tools/scroll-perf-check.mjs --only=1,3   # just those scenarios
//   node tools/scroll-perf-check.mjs --only=1 --trace   # ...and say what each
//                                         style recalculation was FOR
//
// "I'm feeling a little lag while scrolling pdf and notes, also the app is too
// heavy on mobile devices." Every scroll handler on both surfaces had already
// been made passive, coalesced and read-before-write (ac6d08e, 4915e34, 5a15b00)
// — and it was still true, because the cost had moved off the handlers and into
// the work a scroll SETS OFF:
//
//   • a paper rasterised every page it was flung past, several at once — pdf.js
//     runs a display render as one ≤15ms slice per animation frame, so three
//     renders in flight are three slices in every frame — and finished each
//     one even after the page had left the window and was going to be thrown
//     away;
//   • every pause in a paper's scroll saved the WHOLE deck, 400ms later, to
//     record a page number;
//   • a note with PDF regions in it opened every one of them up front, each
//     with a text layer for its WHOLE page, however far down the note it sat.
//
// None of that shows on a desktop, and none of it is a property of one scroll
// handler, which is why nothing already in this directory saw it. Each check
// below is a COUNT or a RATIO rather than a millisecond budget, the convention
// pdf-preview-check's badge guard set (b7a7c50): it has to mean the same thing
// on a laptop and on a loaded CI runner. The milliseconds are printed anyway —
// long tasks under a 4x CPU throttle on a phone-sized, touch-emulated page —
// because they are what a reader actually feels, and the commit that changes
// them should say by how much.
//
// Why a phone matters to every number here: on a touch screen the notes and
// document surfaces carry a NON-passive touchmove for the whole session
// (src/notes/touch-selection.js, onRootTouchMove — press-and-slide needs it), so
// a scroll cannot START until the main thread has answered. Any long task in
// flight is a scroll that starts late.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_ONLY = process.argv.includes("--report");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean).map(Number);
const wants = (n) => !ONLY.length || ONLY.includes(n);
const TRACE = process.argv.includes("--trace");
const CPU_THROTTLE = 4;

const chrome = findChrome();
if (!chrome) {
  console.error("scroll-perf-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

let sources;
try {
  sources = pdfjsSources();
} catch (error) {
  console.error(`scroll-perf-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}).`);
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

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

// ── A paper that is actually dense ─────────────────────────────────────────
//
// tools/pdf-fixture.mjs draws one text item per line, forty lines a page —
// right for asserting where a highlight lands, and nothing like the several
// thousand items of a two-column paper, which is the page whose text layer the
// reader is waiting on. So: two columns, eighty lines each, every word its own
// run in alternating faces (a font switch is what makes pdf.js end an item, the
// way a ligature, a kern or an italic does in a real paper). pdf.js reports the
// gap between two runs as an item of its own, so a page comes to about 2,400.
export const DENSE_COLUMNS = [36, 316];
export const DENSE_LINES = 80;
export const DENSE_WORDS_PER_LINE = 8;
export const DENSE_TOP = 756;
export const DENSE_LEADING = 8.8;
export const DENSE_SIZE = 7;

const WORDS = ("results show that the proposed method improves accuracy across every "
  + "benchmark while keeping inference cheap enough for small devices in practice").split(" ");

function pdfString(text) {
  return String(text).replace(/([\\()])/g, "\\$1");
}

function denseStream(pageNumber) {
  const parts = [];
  DENSE_COLUMNS.forEach((x0, column) => {
    for (let line = 0; line < DENSE_LINES; line += 1) {
      const y = DENSE_TOP - line * DENSE_LEADING;
      let x = x0;
      parts.push("BT");
      for (let w = 0; w < DENSE_WORDS_PER_LINE; w += 1) {
        const word = WORDS[(pageNumber * 7 + line * 3 + w + column) % WORDS.length];
        parts.push(`/F${(w % 2) + 1} ${DENSE_SIZE} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(word)}) Tj`);
        x += word.length * 3.7 + 3.2;
      }
      parts.push("ET");
    }
  });
  return parts.join("\n");
}

function buildDensePdf(pages) {
  const objects = [];
  const push = (body) => { objects.push(body); return objects.length; };
  const catalogId = push("");
  const pagesId = push("");
  const helvetica = push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const times = push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  const pageIds = [];
  for (let n = 1; n <= pages; n += 1) {
    const stream = denseStream(n);
    const contentId = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(push(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${helvetica} 0 R /F2 ${times} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  const infoId = push("<< /Title (The Dense Paper) /Author (Recall Checks) >>");
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff);
}

const PAGES = 40;
const RUNS_PER_PAGE = DENSE_COLUMNS.length * DENSE_LINES * DENSE_WORDS_PER_LINE;

// The box every embed in the notes scenario crops: seven lines of the left
// column, a small fraction of the page's items.
const CROP = [30, 690, 300, 752];
const CROP_LINES = 7;

const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-region-embed.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/notes-edit-split.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/render/block-cache.js?v=__BUILD__",
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
    from: () => { throw new Error("scroll-perf-check does not touch the network"); },
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

// Everything the scenarios count, installed once. Counting at the pdf.js
// prototype rather than on one document's pages, so the region embeds (their
// own document) are seen too — told apart by the canvas they draw into.
const INSTRUMENT_SRC = `async () => {
  const { api } = window.__recall;
  const P = window.__perf = {
    longtasks: [],
    doc: { started: 0, completed: 0, cancelled: 0, failed: 0, live: 0, peak: 0, wasted: 0 },
    embed: { started: 0, completed: 0, cancelled: 0 },
    deckPuts: 0
  };
  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => P.longtasks.push({ start: e.startTime, dur: e.duration }));
    }).observe({ type: "longtask", buffered: false });
  } catch (_) { /* no longtask support: the counts below still stand */ }
  const doc = api.currentPdfDocument();
  const proto = Object.getPrototypeOf(await doc.getPage(1));
  const render = proto.render;
  proto.render = function (params) {
    const task = render.call(this, params);
    const canvas = params?.canvasContext?.canvas;
    const kind = canvas?.classList?.contains("pdf-region-embed-canvas") ? "embed"
      : canvas?.classList?.contains("pdf-canvas") ? "doc" : null;
    if (!kind) return task;
    const bucket = P[kind];
    const pageNumber = this.pageNumber;
    bucket.started += 1;
    if (kind === "doc") { P.doc.live += 1; P.doc.peak = Math.max(P.doc.peak, P.doc.live); }
    task.promise.then(() => {
      bucket.completed += 1;
      // A page that finished rasterising while it was already outside the
      // window the viewer keeps (PDF_RENDER_WINDOW + 1 either side of the
      // page being read) — drawn only to be thrown away.
      if (kind === "doc" && Math.abs(pageNumber - api.currentDocumentPage()) > api.PDF_RENDER_WINDOW + 1) P.doc.wasted += 1;
    }, (error) => {
      if (error?.name === "RenderingCancelledException") bucket.cancelled += 1;
      else if (kind === "doc") P.doc.failed += 1;
    }).finally(() => { if (kind === "doc") P.doc.live -= 1; });
    return task;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === api.DECK_STORE_NAME) P.deckPuts += 1;
    return put.apply(this, args);
  };
  return true;
}`;

// A fling at a fixed speed, on the page's own clock: each frame puts the
// scroller where a finger moving at \`speed\` px/s would have taken it by now, so
// a frame the main thread drops is distance skipped rather than time stretched
// — which is exactly what a reader sees.
const FLING_SRC = `async (selector, distance, speed) => {
  const view = document.querySelector(selector);
  const from = view.scrollTop;
  const target = Math.max(0, Math.min(view.scrollHeight - view.clientHeight, from + distance));
  const started = performance.now();
  const frames = [];
  let last = started;
  await new Promise((resolve) => {
    const step = (now) => {
      frames.push(now - last);
      last = now;
      const at = from + Math.sign(distance) * Math.min(Math.abs(target - from), ((now - started) / 1000) * speed);
      view.scrollTop = at;
      if (Math.abs(at - target) < 1) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return { started, ended: performance.now(), frames };
}`;

// What the main thread spent its time on, between two Performance.getMetrics
// readings: script, style recalculation and layout, in milliseconds. A long task
// says THAT the thread was busy; this says with what.
async function threadMetrics() {
  const { metrics } = await page.call("Performance.getMetrics");
  const pick = (name) => (metrics.find((m) => m.name === name)?.value || 0);
  return {
    script: pick("ScriptDuration") * 1000,
    style: pick("RecalcStyleDuration") * 1000,
    layout: pick("LayoutDuration") * 1000,
    layouts: pick("LayoutCount"),
    styles: pick("RecalcStyleCount")
  };
}

function metricsDelta(before, after) {
  const ms = (key) => Math.round(after[key] - before[key]);
  return `script ${ms("script")}ms · style ${ms("style")}ms (${ms("styles")} recalcs) · layout ${ms("layout")}ms (${ms("layouts")} layouts)`;
}

// ── --trace: what each style recalculation touched, and why ───────────────
//
// Performance.getMetrics can say the thread spent seconds recalculating style;
// only a trace says how many elements each recalculation walked and what
// invalidated them. A diagnostic, not an assertion — printed and left to the
// reader.
async function startTrace() {
  const events = [];
  const off = client.on((message) => {
    if (message.method === "Tracing.dataCollected") events.push(...(message.params?.value || []));
  });
  await page.call("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking",
    transferMode: "ReportEvents"
  });
  return async () => {
    const done = new Promise((resolve) => {
      const offDone = client.on((message) => {
        if (message.method === "Tracing.tracingComplete") { offDone(); resolve(); }
      });
    });
    await page.call("Tracing.end");
    await done;
    off();
    return events;
  };
}

function summariseTrace(events) {
  const recalcs = events.filter((e) => e.name === "UpdateLayoutTree" && e.ph === "X");
  const sizes = recalcs.map((e) => ({ dur: (e.dur || 0) / 1000, elements: e.args?.elementCount || 0 }))
    .sort((a, b) => b.dur - a.dur);
  console.log(`   trace: ${recalcs.length} style recalcs · ${Math.round(sizes.reduce((t, r) => t + r.dur, 0))}ms`);
  sizes.slice(0, 8).forEach((r) => console.log(`     ${Math.round(r.dur)}ms over ${r.elements} elements`));
  const reasons = new Map();
  events.filter((e) => /InvalidationTracking/.test(e.name)).forEach((e) => {
    const d = e.args?.data || {};
    const key = `${e.name.replace("InvalidationTracking", "")} · ${d.reason || d.changedClass || d.changedAttribute || d.changedId || d.changedPseudo || "?"} · ${d.nodeName || ""}`;
    reasons.set(key, (reasons.get(key) || 0) + 1);
  });
  [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([key, n]) => console.log(`     ${String(n).padStart(6)}× ${key}`));
  if (process.env.TRACE_DUMP) {
    const seen = new Set();
    events.filter((e) => /InvalidationTracking/.test(e.name) && /subtree|has/i.test(JSON.stringify(e.args?.data || {})))
      .forEach((e) => {
        const text = JSON.stringify({ name: e.name, data: e.args?.data });
        if (seen.has(text)) return;
        seen.add(text);
        if (seen.size <= 12) console.log("     " + text.slice(0, 900));
      });
  }
}

function longTaskSummary(tasks, from, to) {
  const inside = tasks.filter((t) => t.start >= from && t.start <= to);
  const total = inside.reduce((sum, t) => sum + t.dur, 0);
  const max = inside.reduce((m, t) => Math.max(m, t.dur), 0);
  return { count: inside.length, total: Math.round(total), max: Math.round(max) };
}

function frameSummary(frames) {
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const over50 = frames.filter((f) => f > 50).length;
  return { frames: frames.length, p95: Math.round(p95), over50, worst: Math.round(sorted[sorted.length - 1] || 0) };
}

let ran = 0;
let failed = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (REPORT_ONLY) {
    console.log(`  --    ${label}${detail ? `  ${detail}` : ""}`);
    return;
  }
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

const watchdog = setTimeout(() => {
  console.log("  FAIL  the check itself: gave up after 6 minutes");
  console.log(`CHECK: ${ran + 1} checks · ${failed + 1} failed`);
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  process.exit(1);
}, 6 * 60 * 1000);

try {
  // A phone from the first byte, so every (pointer: coarse) decision the app
  // makes at boot — the touch-selection controller arming, the half-viewport
  // render lead — is the phone's.
  await emulatePhone(page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
  });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const opened = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], "dense.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    if (!entry) return { error: "no deck was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(300);
    api.setViewMode("document");
    await api.openDocumentView({ force: true });
    await api.whenDocumentPageReady(1);
    await settle(800);
    const items = document.querySelectorAll('.pdf-page[data-page-number="1"] .pdf-text-layer span[data-item-index]').length;
    return { pages: api.currentPdfPageCount(), items, pdfId: api.state.meta?.pdf?.id || null };
  }`, Array.from(buildDensePdf(PAGES)));
  if (opened.error) throw new Error(opened.error);
  check("the dense paper opens with its text layer", opened.pages === PAGES && opened.items >= RUNS_PER_PAGE,
    `${opened.pages} pages · ${opened.items} items on page 1 (${RUNS_PER_PAGE} runs)`);
  const ITEMS_PER_PAGE = opened.items;
  // The items a crop of CROP_LINES lines of one column holds, out of the page's.
  const CROP_ITEMS = Math.ceil(ITEMS_PER_PAGE * CROP_LINES / (DENSE_COLUMNS.length * DENSE_LINES));

  await page.evaluate(INSTRUMENT_SRC);
  await page.call("Performance.enable");
  await page.call("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  if (wants(1)) {
    // ── 1. A paper, flung ────────────────────────────────────────────────────
    console.log(`\n1. A ${PAGES}-page, ${ITEMS_PER_PAGE}-item-a-page paper, flung on a phone at ${CPU_THROTTLE}x CPU`);
    const pdfBefore = await threadMetrics();
    const stopTrace = TRACE ? await startTrace() : null;
    const pdfFling = await page.evaluate(FLING_SRC, "#documentView", 9000, 2400);
    await page.evaluate(`() => window.__recall.settle(2500)`);
    const pdfAfter = await threadMetrics();
    if (stopTrace) summariseTrace(await stopTrace());
    const pdf = await page.evaluate(`() => {
      const { api } = window.__recall;
      const canvases = [...document.querySelectorAll("#documentView canvas.pdf-canvas")];
      return {
        perf: JSON.parse(JSON.stringify(window.__perf)),
        current: api.currentDocumentPage(),
        canvases: canvases.length,
        pixels: canvases.reduce((sum, c) => sum + c.width * c.height, 0)
      };
    }`);
    const pdfLong = longTaskSummary(pdf.perf.longtasks, pdfFling.started, pdfFling.ended + 2500);
    const pdfFrames = frameSummary(pdfFling.frames);
    console.log(`   reached page ${pdf.current} · renders started ${pdf.perf.doc.started}, completed ${pdf.perf.doc.completed}, `
      + `cancelled ${pdf.perf.doc.cancelled}, peak in flight ${pdf.perf.doc.peak}, finished outside the window ${pdf.perf.doc.wasted}`);
    console.log(`   long tasks ${pdfLong.count} · total ${pdfLong.total}ms · longest ${pdfLong.max}ms · `
      + `frames ${pdfFrames.frames}, p95 ${pdfFrames.p95}ms, ${pdfFrames.over50} over 50ms`);
    console.log(`   live page canvases afterwards ${pdf.canvases} (${(pdf.pixels / 1e6).toFixed(1)}M px)`);
    console.log(`   main thread: ${metricsDelta(pdfBefore, pdfAfter)}`);

    // One page at a time on a phone: a second render in flight is a second
    // 15ms slice in the same frame, and the page being looked at is the one it
    // delays.
    check("a phone rasterises one page at a time", pdf.perf.doc.peak <= 1, `peak ${pdf.perf.doc.peak} in flight`);
    // At most one: a render can land in the frame between its page leaving
    // the window and the observer saying so. Before cancellation it was most
    // of the renders a fling started (7-12 of them here).
    check("no page is rasterised to completion after it has left the window", pdf.perf.doc.wasted <= 1,
      `${pdf.perf.doc.wasted} finished outside it`);
    check("every page canvas left standing belongs to the window", pdf.canvases <= 2 * (3 + 1) + 1,
      `${pdf.canvases} canvases`);
  }

  if (wants(2)) {
    // ── 2. A paper, read: short pauses, then a real stop ─────────────────────
    console.log("\n2. Reading a paper: four flicks with short pauses, then a stop");
    await page.evaluate(`() => { window.__perf.deckPuts = 0; }`);
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(FLING_SRC, "#documentView", -700, 1800);
      await page.evaluate(`() => window.__recall.settle(900)`);
    }
    const putsWhileReading = await page.evaluate(`() => window.__perf.deckPuts`);
    await page.evaluate(`() => window.__recall.settle(4500)`);
    const saved = await page.evaluate(`async () => {
      const { api } = window.__recall;
      const snapshot = await api.readDeckSnapshot(api.state.localDeckId);
      return {
        puts: window.__perf.deckPuts,
        page: api.currentDocumentPage(),
        storedPage: snapshot?.meta?.readingPosition?.pdfPage ?? null
      };
    }`);
    console.log(`   whole-deck saves during the flicks ${putsWhileReading} · after the stop ${saved.puts} · `
      + `stored page ${saved.storedPage} (reading page ${saved.page})`);
    check("pausing between flicks does not save the whole deck each time", putsWhileReading <= 1,
      `${putsWhileReading} saves in four pauses`);
    check("...and the page reached is still saved once the reader stops", saved.storedPage === saved.page,
      `stored ${saved.storedPage}, reading ${saved.page}`);
  }

  if (wants(3)) {
    // ── 3. A note full of PDF regions ────────────────────────────────────────
    console.log("\n3. A note carrying 24 regions of the paper, opened and scrolled");
    const EMBEDS = 24;
    const notesOpen = await page.evaluate(`async (embeds, crop) => {
      const { api, settle } = window.__recall;
      const parts = [];
      for (let i = 0; i < embeds; i += 1) {
        parts.push("## Figure " + (i + 1));
        parts.push("Paragraph " + (i + 1) + " discussing the figure below, with $e^{i\\\\pi} + 1 = 0$ inline. "
          + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(4));
        parts.push(api.pdfRegionRefMarkdown((i % 40) + 1, crop, null, 300));
        parts.push("\`\`\`js\\nconst figure = " + i + ";\\nconsole.log(figure * 2);\\n\`\`\`");
      }
      api.state.notes = parts.join("\\n\\n");
      window.__perf.embed = { started: 0, completed: 0, cancelled: 0 };
      const t0 = performance.now();
      api.setViewMode("notes");
      // Until the first region at the top has landed — the paper has to be opened
      // for it, which is seconds under the throttle — and a beat after, so every
      // region that WAS going to be drawn up front has asked to be.
      for (let i = 0; i < 300 && !document.querySelector("#notesView .pdf-region-embed:not(.is-loading)"); i += 1) await settle(100);
      await settle(1000);
      const all = document.querySelectorAll("#notesView .pdf-region-embed");
      const painted = document.querySelectorAll("#notesView .pdf-region-embed:not(.is-loading)").length;
      return { t0, t1: performance.now(), total: all.length, painted, started: window.__perf.embed.started };
    }`, EMBEDS, CROP);
    const notesFling = await page.evaluate(FLING_SRC, "#notesView", 200000, 2400);
    // Every region near the end has been asked for by now; give the slowest of
    // them — a phone-throttled pdf.js — time to land rather than guessing a wait.
    await page.evaluate(`async (embeds) => {
      for (let i = 0; i < 300; i += 1) {
        const done = document.querySelectorAll("#notesView .pdf-region-embed:not(.is-loading)").length;
        if (done >= embeds) break;
        await window.__recall.settle(100);
      }
    }`, EMBEDS);
    const notes = await page.evaluate(`() => {
      const embeds = [...document.querySelectorAll("#notesView .pdf-region-embed")];
      const spans = embeds.map((e) => e.querySelectorAll(".pdf-text-layer span[data-item-index]").length);
      return {
        perf: JSON.parse(JSON.stringify(window.__perf)),
        total: embeds.length,
        painted: embeds.filter((e) => !e.classList.contains("is-loading") && !e.classList.contains("is-fallback")).length,
        fallback: embeds.filter((e) => e.classList.contains("is-fallback")).length,
        spans: spans.reduce((a, b) => a + b, 0),
        maxSpans: Math.max(0, ...spans)
      };
    }`);
    const openLong = longTaskSummary(notes.perf.longtasks, notesOpen.t0, notesOpen.t1);
    const notesLong = longTaskSummary(notes.perf.longtasks, notesFling.started, notesFling.ended + 4000);
    const notesFrames = frameSummary(notesFling.frames);
    console.log(`   on open: ${notesOpen.painted}/${notesOpen.total} regions painted, ${notesOpen.started} rasterised · `
      + `long tasks ${openLong.count}, total ${openLong.total}ms, longest ${openLong.max}ms`);
    console.log(`   scrolled to the end: ${notes.painted}/${notes.total} painted, ${notes.fallback} fallbacks · `
      + `text-layer spans ${notes.spans} (largest ${notes.maxSpans}; ${CROP_ITEMS} items sit inside a crop)`);
    console.log(`   long tasks while scrolling ${notesLong.count} · total ${notesLong.total}ms · longest ${notesLong.max}ms · `
      + `frames p95 ${notesFrames.p95}ms, ${notesFrames.over50} over 50ms`);
    check("a region far down the note is not drawn until the reader nears it", notesOpen.started < EMBEDS / 2,
      `${notesOpen.started} of ${EMBEDS} rasterised on open`);
    check("...and every region is drawn by the time the reader gets there", notes.painted === EMBEDS && notes.fallback === 0,
      `${notes.painted}/${EMBEDS} painted, ${notes.fallback} fallbacks`);
    check("a region carries the text of its own box, not its whole page",
      notes.maxSpans > 0 && notes.maxSpans <= CROP_ITEMS * 3,
      `largest ${notes.maxSpans} spans for a ${CROP_ITEMS}-item crop of a ${ITEMS_PER_PAGE}-item page`);
  }

  if (wants(4)) {
    // ── 4. A book-sized note ─────────────────────────────────────────────────
    console.log("\n4. A 300KB note with code and mathematics, opened and flung");
    const bookOpen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const out = [];
      for (let c = 0; c < 30; c += 1) {
        out.push("# Chapter " + (c + 1));
        for (let s = 0; s < 18; s += 1) {
          out.push("## Section " + (c + 1) + "." + (s + 1));
          out.push("Paragraph " + c + "." + s + " with $\\\\int_0^1 x^" + s + " dx$ inside it. "
            + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(3));
          if (s % 3 === 0) out.push("\`\`\`python\\ndef f(x):\\n    return x * " + s + "\\n\`\`\`");
          if (s % 4 === 0) out.push("$$\\\\sum_{k=1}^{" + (s + 2) + "} k^2$$");
        }
      }
      api.state.notes = out.join("\\n\\n");
      api.setNotesScrolledSource?.(null);
      api.invalidateRenderedBlockCache?.();
      const t0 = performance.now();
      await api.renderNotesView();
      const t1 = performance.now();
      document.getElementById("notesView").scrollTop = 0;
      await settle(800);
      return { t0, t1, chars: api.state.notes.length };
    }`);
    const bookFling = await page.evaluate(FLING_SRC, "#notesView", 60000, 3000);
    await page.evaluate(`() => window.__recall.settle(1500)`);
    const book = await page.evaluate(`() => JSON.parse(JSON.stringify(window.__perf.longtasks))`);
    const bookOpenLong = longTaskSummary(book, bookOpen.t0, bookOpen.t1 + 800);
    const bookLong = longTaskSummary(book, bookFling.started, bookFling.ended + 1500);
    const bookFrames = frameSummary(bookFling.frames);
    console.log(`   ${Math.round(bookOpen.chars / 1000)}KB · render ${Math.round(bookOpen.t1 - bookOpen.t0)}ms · `
      + `long tasks while opening ${bookOpenLong.count}, longest ${bookOpenLong.max}ms`);
    console.log(`   long tasks while flinging ${bookLong.count} · total ${bookLong.total}ms · longest ${bookLong.max}ms · `
      + `frames p95 ${bookFrames.p95}ms, ${bookFrames.over50} over 50ms`);
    check("the book renders and scrolls", bookFrames.frames > 10, `${bookFrames.frames} frames`);
  }
} catch (error) {
  failed += 1;
  ran += 1;
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
}

console.log(`\nCHECK: ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
