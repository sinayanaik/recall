// How fast is the PDF reader on a phone? A benchmark, not a check.
//
//   node tools/pdf-perf.mjs                       # this tree, CPU throttled 4x
//   node tools/pdf-perf.mjs --root=/path/to/other/checkout
//   node tools/pdf-perf.mjs --runs=3 --throttle=6 --only=open,tab
//   node tools/pdf-perf.mjs --invert              # with dark page on
//   node tools/pdf-perf.mjs --highlights=30       # 30 highlights on every page
//   node tools/pdf-perf.mjs --main-thread         # pages drawn on the main thread
//
// "Everything is slow on my phone — opening a deck's PDF, switching tabs,
// switching PDFs, scrolling, zooming, panning." None of those had a number
// attached, so every change to the document surface was judged by feel. This
// drives the app's own code in a real browser, in phone emulation, with the CPU
// throttled, over a generated paper dense enough to cost what a real one costs
// (two columns, a word in two fonts every few words, a vector figure a page),
// and reports the median of each flow over --runs runs.
//
// Not wired into tools/check.mjs, deliberately: timings on a shared CI runner
// are noise, and a check that fails on noise is a check that gets ignored. Run
// it before and after a change to the document surface, and compare. --root
// points it at another checkout of this repo, which is how a before/after pair
// is taken on one machine.
//
// Flows (--only=a,b,…):
//   open    a deck's PDF opened from cold, to the first page's canvas
//   tab     Notes → PDF tab, to a canvas on screen again
//   switch  one PDF of the deck to the other and back, to its canvas
//   zoom    a zoom step, to the page in view drawn fresh at the new scale
//   zoomin  fit-width straight to 500%, to the page in view drawn fresh, and
//           (when the build has one) to its sharp detail tile
//   zoomout fit-width out to the lowest zoom, to every page on screen drawn
//   fling   a flick from page 1 to page 20, to page 20's canvas and its text
//   steady  three seconds of slow scrolling: frame times and long tasks
//   pan     a real touch drag (CDP touch events, so it goes through the
//           app's own touch listeners) started right after a zoom step, while
//           the pages are being redrawn: frame times and long tasks under the
//           finger. This is "zooming and panning lag" as a reader feels it.
//
// --images gives every page a large photograph (a JPEG, as most scanned or
// figure-heavy papers have), so the cost of drawing a page is the image and
// not the vector work — the shape of a 3.6MB, 6-page paper whose pages took
// 0.7–1.7s each to draw on a real phone.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROOT = path.resolve(arg("root", HERE));
const RUNS = Math.max(1, Number(arg("runs", 3)));
const THROTTLE = Number(arg("throttle", 4));
const ONLY = new Set(String(arg("only", "open,tab,switch,zoom,zoomin,zoomout,fling,steady,pan")).split(","));
const IMAGES = process.argv.includes("--images");
const INVERT = process.argv.includes("--invert");
// --highlights=N puts N text highlights (and one region for every ten) on every
// page of the paper being measured, the way a heavily annotated paper is read.
const HIGHLIGHTS = Math.max(0, Number(arg("highlights", 0)) || 0);
// --annotated puts a note on every other highlight and turns on the notes printed
// under each page, so the note folds and the inline notes (region pictures
// included) are on screen: the shape of a paper somebody has worked through.
// Implies --highlights=30 unless that is given.
const ANNOTATED = process.argv.includes("--annotated");
// --layers reports how many layers the compositor holds and how many device
// pixels they cover, settled on a page and mid-scroll — what a phone's GPU has to
// keep resident and composite every frame.
const LAYERS = process.argv.includes("--layers");
// --gpu composites on a software GPU rather than with the GPU off, so canvases
// are accelerated and layers are made as a phone makes them.
const GPU = process.argv.includes("--gpu");
// --report prints the App Info readout at the end of each run.
const REPORT = process.argv.includes("--report");
// --main-thread draws pages on the main thread instead of in the page renderer.
const MAIN_THREAD = process.argv.includes("--main-thread");
// --profile=<flow> prints where the main thread's time went during that flow:
// the functions with the most self time, from the V8 CPU profiler.
const PROFILE = arg("profile", "");
// --css="…" adds a stylesheet to the page before the app boots: a way to try a
// rendering idea on the real flows before writing it into styles/.
const EXTRA_CSS = arg("css", "");
// --pdfjs=modern injects pdf.js's untranspiled build instead of the legacy one
// the app ships, to see what the transpilation costs (needs the npm tarball
// tools/pdfjs-source.mjs caches, unpacked with its build/ directory).
const PDFJS_BUILD = arg("pdfjs", "legacy");
// --dpr=3 emulates a 3x screen (most current phones) instead of tools/cdp.mjs's 2x.
const DPR = Number(arg("dpr", 2));

// The browser plumbing and pdf.js come from THIS tree, so two roots are
// measured with the same harness; only the app under test differs.
const { findChrome, launchChrome, connect, openPage, emulatePhone } = await import(path.join(HERE, "tools/cdp.mjs"));
const { pdfjsSources, servePdfjsFromDisk } = await import(path.join(HERE, "tools/pdfjs-source.mjs"));

// ── A paper that costs what a paper costs ──────────────────────────────────
// Photograph-like JPEGs, made once with ImageMagick and cached. Each page gets
// its own image OBJECT, even where the bytes repeat, so pdf.js decodes it per
// page as it would a real paper's figures rather than sharing one decode.
async function photoJpegs(count = 6) {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdirSync, readFileSync } = await import("node:fs");
  const dir = "/tmp/recall-perf-images";
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `photo-${i}.jpg`);
    if (!existsSync(file)) {
      execFileSync("convert", ["-size", "1800x2200", "-seed", String(100 + i), "plasma:fractal",
        "-blur", "0x1", "-quality", "88", file]);
    }
    out.push({ width: 1800, height: 2200, bytes: readFileSync(file).toString("latin1") });
  }
  return out;
}

function densePdf(pages = 40, { seed = 7, title = "Dense Paper", images = null } = {}) {
  const objs = [];
  const push = (b) => { objs.push(b); return objs.length; };
  const cat = push("");
  const pagesId = push("");
  const f1 = push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  const f2 = push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>");
  const words = ("spherical geometry efficient distance queries manual creation models time consuming "
    + "prone errors robot description format collision checking approximation pipeline").split(" ");
  const ids = [];
  let state = seed;
  const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let p = 0; p < pages; p++) {
    let s = "";
    for (let col = 0; col < 2; col++) {
      const x = col ? 316 : 54;
      for (let l = 0; l < 58; l++) {
        if (col === 1 && l > 20 && l < 36) continue;
        let line = `BT /F1 9 Tf ${x} ${740 - l * 11.5} Td `;
        for (let w = 0; w < 9; w++) {
          const word = words[Math.floor(rnd() * words.length)];
          line += w % 3 === 1
            ? `(${word.slice(0, 2)}) Tj /F2 9 Tf (${word.slice(2, 3)}) Tj /F1 9 Tf (${word.slice(3)} ) Tj `
            : `(${word} ) Tj `;
        }
        s += `${line}ET\n`;
      }
    }
    s += "q 0.3 w 0 0 1 RG\n";
    for (let i = 0; i < 2500; i++) {
      const x0 = 320 + rnd() * 230;
      const y0 = 480 + rnd() * 160;
      s += `${x0.toFixed(1)} ${y0.toFixed(1)} m ${(x0 + rnd() * 10).toFixed(1)} ${(y0 + rnd() * 10).toFixed(1)} l S\n`;
    }
    s += "Q\n";
    let xobjects = "";
    if (images?.length) {
      const img = images[p % images.length];
      const imgId = push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n${img.bytes}\nendstream`);
      s += "q 504 0 0 420 54 300 cm /Ph Do Q\n";
      xobjects = ` /XObject << /Ph ${imgId} 0 R >>`;
    }
    const c = push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    ids.push(push(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobjects} >> /Contents ${c} 0 R >>`));
  }
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${ids.map((i) => `${i} 0 R`).join(" ")}] /Count ${ids.length} >>`;
  const info = push(`<< /Title (${title}) >>`);
  let pdf = "%PDF-1.4\n";
  const off = [];
  objs.forEach((b, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xs = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${xs}\n%%EOF\n`;
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0) & 0xff);
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(HERE, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
  });
}

const API_SRC = `async () => {
  const paths = ["/src/documents/pdf-view.js", "/src/import/pdf.js", "/src/library/local-library.js",
    "/src/storage/deck-store.js", "/src/ui/view-mode.js", "/src/cloud/supabase-client.js",
    "/src/core/state.js", "/src/ui/boot-screens.js", "/src/boot.js", "/src/library/my-decks.js",
    "/src/documents/pdf-multi.js", "/src/ui/deck-header.js", "/src/documents/pdf-highlights.js", "/src/documents/pdf-timing.js",
    "/src/format/highlight-notes.js", "/src/documents/pdf-page-notes.js"]
    .map((p) => p + "?v=__BUILD__");
  const mods = await Promise.all(paths.map((p) => import(p).catch(() => ({}))));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // A canvas that is DRAWN, on a page that is on screen: what the reader is
  // waiting for in every flow below.
  const drawnOnScreen = () => {
    const view = document.getElementById("documentView");
    if (!view || view.hidden || !view.clientHeight) return false;
    const box = view.getBoundingClientRect();
    return Array.from(view.querySelectorAll(".pdf-canvas:not(.is-stale)")).some((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom && r.height > 0;
    });
  };
  const until = async (test, limit = 30000) => {
    const t0 = performance.now();
    while (!test()) {
      if (performance.now() - t0 > limit) return -1;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t0;
  };
  window.__recall = { api, settle, drawnOnScreen, until };
  api.setSupabaseClient({
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "y@e.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) },
    from: () => { throw new Error("offline"); },
    storage: { from: () => ({ upload: async () => ({ error: { message: "offline" } }), remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }), createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: p } }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true); api.showAuthenticatedUI(); api.initAppForUser();
  await settle(600);
  return true;
}`;

const photos = IMAGES ? await photoJpegs(6) : null;

async function oneRun() {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome on this machine");
  let sources = pdfjsSources();
  if (PDFJS_BUILD === "modern") {
    const { readFileSync } = await import("node:fs");
    sources = {
      main: readFileSync("/tmp/recall-pdfjs/package/build/pdf.min.js", "utf8"),
      worker: readFileSync("/tmp/recall-pdfjs/package/build/pdf.worker.min.js", "utf8")
    };
  }
  const server = await serveOn(ROOT);
  const launched = await launchChrome(chrome, [], { gpu: GPU });
  const client = await connect(launched.wsUrl);
  const page = await openPage(client);
  const results = {};
  try {
    await emulatePhone(page, { cpuThrottle: 1 });
    if (DPR !== 2) await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true });
    // The PDF page renderer fetches pdf.js by its CDN URL to start its worker;
    // answered from the same files. --main-thread turns the renderer off, to
    // compare the two on one build.
    await servePdfjsFromDisk(client, page, sources);
    if (MAIN_THREAD) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("recall:pdfRenderWorker", "0"); } catch (e) {}` });
    await page.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${sources.main}
;(function () { var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob); })();
window.__perf = { longTasks: [] };
${EXTRA_CSS ? `document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = ${JSON.stringify(EXTRA_CSS)}; document.head.appendChild(st); });` : ""}
try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.longTasks.push(e.duration)))
  .observe({ type: "longtask", buffered: true }); } catch (e) {}`
    });
    await page.goto(`${server.base}/index.html`);
    await page.evaluate(SETUP_SRC, API_SRC);

    // Import two papers into one deck, unthrottled: setting up is not the
    // thing being measured.
    const prepared = await page.evaluate(`async (main, second, other, invert) => {
      const { api, settle } = window.__recall;
      // A second deck first, so the "open" flow can open a deck's PDF the way
      // a reader does — by loading a different deck — rather than reopening
      // the one already on screen.
      await api.importPdfFile(new File([new Uint8Array(other)], "other.pdf", { type: "application/pdf" }), null);
      await settle(400);
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      const otherId = api.readLocalDeckIndex()[0]?.id;
      const before = api.readLocalDeckIndex().map((m) => m.id);
      await api.importPdfFile(new File([new Uint8Array(main)], "dense.pdf", { type: "application/pdf" }), null);
      await settle(400);
      const entry = api.readLocalDeckIndex().find((m) => !before.includes(m.id));
      await api.loadDeckFromLibrary(entry.id);
      await settle(300);
      api.closeMyDecksPanel?.();
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await api.whenDocumentPageReady(1);
      const firstId = api.openDocumentPdfId();
      await api.attachPdfToOpenDeck(new File([new Uint8Array(second)], "second.pdf", { type: "application/pdf" }));
      await settle(800);
      const ids = (api.deckPdfs(api.state.meta) || []).map((p) => p.id);
      const secondId = ids.find((id) => id !== firstId) || null;
      if (api.openDocumentPdfId() !== firstId) await api.switchToPdf(firstId);
      await settle(500);
      // Remembered, so the flows that load another deck and come back keep it.
      api.applyPdfInvert(Boolean(invert));
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      return { deckId: entry.id, otherId, firstId, secondId, pages: api.currentPdfPageCount() };
    }`, Array.from(densePdf(IMAGES ? 24 : 40, { images: photos })),
    Array.from(densePdf(IMAGES ? 8 : 20, { seed: 11, title: "Second Paper", images: photos })),
    Array.from(densePdf(IMAGES ? 8 : 30, { seed: 23, title: "Other Deck", images: photos })), INVERT);

    const perPageHighlights = HIGHLIGHTS || (ANNOTATED ? 30 : 0);
    if (perPageHighlights) {
      await page.evaluate(`async (perPage, pages, annotated) => {
        const { api, settle } = window.__recall;
        let seed = 5;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const colors = ["yellow", "green", "blue", "pink"];
        const made = [];
        for (let page = 1; page <= pages; page += 1) {
          for (let i = 0; i < perPage; i += 1) {
            const area = i % 10 === 9;
            const col = rnd() < 0.5 ? 54 : 316;
            const line = Math.floor(rnd() * 56);
            const y1 = 748 - line * 11.5;
            const rect = area
              ? [col, y1 - 120, col + 230, y1]
              : [col + rnd() * 80, y1 - 10, col + 120 + rnd() * 110, y1];
            made.push({ id: "hn-p" + page + "x" + i, color: colors[i % 4], page, text: area ? "" : "perf",
              quads: [{ page, rect }], kind: area ? "area" : "text", qv: 2, at: 1 });
          }
        }
        api.state.meta = { ...api.state.meta, pdfHighlights: made };
        if (annotated) {
          let notes = api.state.notes || "";
          made.forEach((record, i) => {
            if (i % 2) return;
            notes = api.setHighlightNoteInSource(notes, record.id, "A note about this, with a few words to wrap " + i + ".", "perf " + i);
          });
          api.state.notes = notes;
          try { localStorage.setItem("recall:pdfPageNotes", "1"); } catch (e) {}
          api.setPdfPageNotesFlag(true);
          api.applyPdfPageNotes();
        }
        api.repaintDocumentHighlights();
        api.repaintOpenDocumentPages?.();
        // Saved, so the flows that leave the deck and come back find them again.
        api.scheduleDeckAutosave?.();
        await settle(500);
        for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
        return made.length;
      }`, perPageHighlights, prepared.pages, ANNOTATED);
    }

    await page.call("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

    // Runs one flow, under the profiler when --profile names it.
    const flow = async (name, src, ...args) => {
      if (PROFILE !== name) return page.evaluate(src, ...args);
      await page.call("Profiler.enable");
      await page.call("Profiler.setSamplingInterval", { interval: 200 });
      await page.call("Profiler.start");
      const value = await page.evaluate(src, ...args);
      const { profile } = await page.call("Profiler.stop");
      printProfile(profile);
      return value;
    };

    if (ONLY.has("open")) {
      results.open = await flow("open", `async (deckId, otherId) => {
        const { api, settle, drawnOnScreen, until } = window.__recall;
        // The other deck's PDF, from the library, as a reader opens one.
        const t0 = performance.now();
        await api.loadDeckFromLibrary(otherId);
        api.closeMyDecksPanel?.();
        api.setViewMode("document");
        await api.openDocumentView();
        await until(drawnOnScreen);
        const ms = performance.now() - t0;
        await settle(1500);
        // ...and back to the deck the other flows use.
        await api.loadDeckFromLibrary(deckId);
        api.closeMyDecksPanel?.();
        api.setViewMode("document");
        await api.openDocumentView();
        await until(drawnOnScreen);
        await settle(2000);
        return Math.round(ms);
      }`, prepared.deckId, prepared.otherId);
    }

    if (ONLY.has("tab")) {
      results.tab = await flow("tab", `async () => {
        const { api, settle, drawnOnScreen, until } = window.__recall;
        // Somewhere other than the top, so a switch that loses the reader's
        // place shows up as a different page rather than passing by accident.
        api.scrollToDocumentPage(6, 0.3, { smooth: false });
        await settle(2500);
        const before = api.currentDocumentPage();
        api.setViewMode("notes");
        await settle(800);
        const t0 = performance.now();
        api.setViewMode("document");
        await api.openDocumentView();
        await until(drawnOnScreen);
        // ...and one more frame, so a long task the switch left behind counts.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ms = performance.now() - t0;
        const after = api.currentDocumentPage();
        await settle(1000);
        if (before !== after) console.warn("tab switch moved the reader from page " + before + " to " + after);
        return { ms: Math.round(ms), before, after };
      }`);
    }

    if (ONLY.has("switch") && prepared.secondId) {
      results.switch = await flow("switch", `async (firstId, secondId) => {
        const { api, settle, drawnOnScreen, until } = window.__recall;
        const times = [];
        for (const id of [secondId, firstId]) {
          const t0 = performance.now();
          await api.switchToPdf(id);
          await until(drawnOnScreen);
          times.push(performance.now() - t0);
          await settle(1200);
        }
        return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      }`, prepared.firstId, prepared.secondId);
    }

    if (ONLY.has("zoom")) {
      results.zoom = await flow("zoom", `async () => {
        const { api, settle, until } = window.__recall;
        api.scrollToDocumentPage(3, 0.2, { smooth: false });
        await settle(1500);
        const page = api.currentDocumentPage();
        const t0 = performance.now();
        api.zoomDocument(1.25);
        const fresh = () => {
          const el = api.pdfPageElement(page);
          return Boolean(el && el.querySelector(".pdf-canvas:not(.is-stale)") && el.querySelector(".pdf-text-layer"));
        };
        await until(fresh);
        const ms = performance.now() - t0;
        api.fitDocumentToWidth();
        await settle(1500);
        return Math.round(ms);
      }`);
    }

    if (ONLY.has("zoomin")) {
      results.zoomin = await flow("zoomin", `async () => {
        const { api, settle, until } = window.__recall;
        api.fitDocumentToWidth();
        api.scrollToDocumentPage(3, 0.2, { smooth: false });
        await settle(1500);
        window.__perf.longTasks.length = 0;
        const t0 = performance.now();
        if (api.setDocumentScale) api.setDocumentScale(5); else api.zoomDocument(5 / 0.6);
        // The page in view AFTER the zoom: a 500% zoom with no anchor lands the
        // reader on a different page from the one they were on, and waiting for
        // the old one waited for a page nothing would ever draw.
        const el = () => api.pdfPageElement(api.currentDocumentPage());
        await until(() => Boolean(el()?.querySelector(".pdf-canvas:not(.is-stale)")));
        const drawn = performance.now() - t0;
        const sharp = await until(() => Boolean(el()?.querySelector(".pdf-detail")), 6000);
        const canvas = el()?.querySelector(".pdf-canvas:not(.is-stale)");
        const result = { drawn: Math.round(drawn), sharp: sharp < 0 ? -1 : Math.round(performance.now() - t0),
          mp: canvas ? Math.round(canvas.width * canvas.height / 1e5) / 10 : 0,
          longTaskMs: Math.round(window.__perf.longTasks.reduce((a, b) => a + b, 0)) };
        api.fitDocumentToWidth();
        await settle(2000);
        return result;
      }`);
    }

    if (ONLY.has("zoomout")) {
      results.zoomout = await flow("zoomout", `async () => {
        const { api, settle, until } = window.__recall;
        api.fitDocumentToWidth();
        api.scrollToDocumentPage(3, 0.2, { smooth: false });
        await settle(1500);
        window.__perf.longTasks.length = 0;
        const view = document.getElementById("documentView");
        const t0 = performance.now();
        api.setDocumentScale(0.01);
        const allDrawn = () => {
          const box = view.getBoundingClientRect();
          const pages = Array.from(view.querySelectorAll(".pdf-page")).filter((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > box.top && r.top < box.bottom;
          });
          return pages.length > 0 && pages.every((p) => p.querySelector(".pdf-canvas:not(.is-stale)"));
        };
        await settle(50);
        const ms = await until(allDrawn, 20000);
        const result = { ms: ms < 0 ? -1 : Math.round(performance.now() - t0),
          longTaskMs: Math.round(window.__perf.longTasks.reduce((a, b) => a + b, 0)) };
        api.fitDocumentToWidth();
        await settle(2000);
        return result;
      }`);
    }

    if (ONLY.has("fling")) {
      results.fling = await flow("fling", `async () => {
        const { api, settle } = window.__recall;
        api.scrollToDocumentPage(1, 0, { smooth: false });
        await settle(1500);
        const view = document.getElementById("documentView");
        const target = api.pdfPageElement(20);
        const to = target.offsetTop - view.offsetTop;
        const from = view.scrollTop;
        const t0 = performance.now();
        await new Promise((resolve) => {
          const step = (now) => {
            const k = Math.min(1, (now - t0) / 700);
            view.scrollTop = from + (to - from) * (1 - Math.pow(1 - k, 3));
            if (k < 1) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
        const landed = performance.now();
        let canvasAt = -1;
        let textAt = -1;
        for (let i = 0; i < 1200; i++) {
          const el = api.pdfPageElement(20);
          if (canvasAt < 0 && el.querySelector(".pdf-canvas:not(.is-stale)")) canvasAt = performance.now() - landed;
          if (canvasAt >= 0 && el.querySelector(".pdf-text-layer")) { textAt = performance.now() - landed; break; }
          await settle(25);
        }
        // ...and how long until it is SHARP: drawn at the screen's full
        // density (the second pass), not just on screen.
        let sharpAt = -1;
        for (let i = 0; i < 400; i++) {
          const c = api.pdfPageElement(20).querySelector(".pdf-canvas:not(.is-stale)");
          const density = c ? c.width / c.getBoundingClientRect().width : 0;
          if (density >= Math.min(3, window.devicePixelRatio || 1) - 0.05) { sharpAt = performance.now() - landed; break; }
          await settle(25);
        }
        await settle(1500);
        return { canvas: Math.round(canvasAt), text: Math.round(textAt), sharp: Math.round(sharpAt) };
      }`);
    }

    if (ONLY.has("steady")) {
      results.steady = await flow("steady", `async () => {
        const { api, settle } = window.__recall;
        api.scrollToDocumentPage(2, 0, { smooth: false });
        await settle(1500);
        const view = document.getElementById("documentView");
        window.__perf.longTasks.length = 0;
        const frames = [];
        const t0 = performance.now();
        let last = t0;
        await new Promise((resolve) => {
          const step = (now) => {
            frames.push(now - last); last = now;
            view.scrollTop += 6;
            if (now - t0 < 3000) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
        const sorted = frames.slice(1).sort((a, b) => a - b);
        return {
          p90Frame: Math.round(sorted[Math.floor(sorted.length * 0.9)]),
          worstFrame: Math.round(sorted[sorted.length - 1]),
          longTaskMs: Math.round(window.__perf.longTasks.reduce((a, b) => a + b, 0))
        };
      }`);
    }
    if (ONLY.has("pan")) {
      // Somewhere in the middle, settled, then a zoom step — so the pages are
      // being redrawn at the new scale when the finger comes down, which is
      // when a reader feels the lag.
      await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        api.fitDocumentToWidth();
        api.scrollToDocumentPage(3, 0.1, { smooth: false });
        await settle(2500);
        window.__pan = { frames: [], longTasks: [], startTop: 0 };
        if (!${JSON.stringify(process.argv.includes("--pan-nozoom"))}) api.zoomDocument(1.2);
        await settle(60);
        const view = document.getElementById("documentView");
        window.__pan.startTop = view.scrollTop;
        const t0 = performance.now();
        let last = t0;
        window.__pan.running = true;
        const step = (now) => {
          window.__pan.frames.push(now - last);
          last = now;
          if (window.__pan.running) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        window.__pan.longFrom = window.__perf.longTasks.length;
        return true;
      }`);
      // The drag: touch events through the browser's own input pipeline —
      // touchstart, then a move every 16ms, 9px at a time (past any long-press
      // slop at once, so it is a pan and not a press), then the lift. What
      // matters is what the main thread is doing while a finger is down: with
      // a non-passive touchmove on this surface (touch selection needs one),
      // every move waits for it.
      const x = 200;
      let y = 650;
      //
      // Sent on a 16ms clock WITHOUT waiting for the page to acknowledge each
      // one, as a finger does: a dispatch is only answered once the page has
      // handled it, and waiting for that turned a busy main thread into a finger
      // that rested on the glass for most of a second before moving — a long
      // press, which the page rightly answered by selecting text. The events
      // still arrive in order.
      const sent = [page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] })];
      for (let i = 0; i < 70; i++) {
        await new Promise((r) => setTimeout(r, 16));
        y -= 6;
        sent.push(page.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] }));
      }
      sent.push(page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
      await Promise.all(sent);
      results.pan = await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        await settle(200);
        window.__pan.running = false;
        const view = document.getElementById("documentView");
        const frames = window.__pan.frames.slice(1).sort((a, b) => a - b);
        const long = window.__perf.longTasks.slice(window.__pan.longFrom);
        const result = {
          p90Frame: Math.round(frames[Math.floor(frames.length * 0.9)] || 0),
          worstFrame: Math.round(frames[frames.length - 1] || 0),
          longTasks: long.length,
          longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)),
          moved: Math.round(view.scrollTop - window.__pan.startTop),
          hit: (() => { const e = document.elementFromPoint(200, 600); return e ? (e.id || e.className || e.tagName) : "none"; })(),
          viewTop: Math.round(view.scrollTop), winY: Math.round(window.scrollY)
        };
        // ...and everything comes back afterwards: the page on screen drawn
        // fresh at the new scale, with its text layer.
        const page = api.currentDocumentPage();
        const t0 = performance.now();
        let settledMs = -1;
        for (let i = 0; i < 400; i++) {
          const el = api.pdfPageElement(page);
          if (el && el.querySelector(".pdf-canvas:not(.is-stale)") && el.querySelector(".pdf-text-layer")) { settledMs = performance.now() - t0; break; }
          await settle(25);
        }
        result.afterLiftMs = Math.round(settledMs);
        api.fitDocumentToWidth();
        await settle(1500);
        return result;
      }`);
    }
    if (LAYERS) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const snapshot = async () => {
        let latest = null;
        const off = client.on((m) => {
          if (m.method === "LayerTree.layerTreeDidChange" && m.sessionId === page.sessionId && m.params?.layers) latest = m.params.layers;
        });
        await page.call("LayerTree.enable");
        await page.evaluate(`() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        await sleep(400);
        await page.call("LayerTree.disable");
        off();
        const drawing = (latest || []).filter((l) => l.drawsContent);
        // LAYER_DEBUG=1 lists every layer with the element it belongs to.
        if (process.env.LAYER_DEBUG) {
          for (const l of drawing) {
            let who = "";
            if (l.backendNodeId) {
              try {
                const { node } = await page.call("DOM.describeNode", { backendNodeId: l.backendNodeId });
                who = node.nodeName + " " + JSON.stringify(node.attributes || []);
              } catch (e) { who = "?"; }
            }
            console.error("LAYER", Math.round(l.width) + "x" + Math.round(l.height), who, l.layerId);
          }
        }
        const area = drawing.reduce((sum, l) => sum + l.width * l.height, 0) * DPR * DPR;
        return { layers: drawing.length, mp: Math.round(area / 1e5) / 10 };
      };
      await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        api.fitDocumentToWidth();
        api.scrollToDocumentPage(3, 0.1, { smooth: false });
        await settle(3500);
      }`);
      const still = await snapshot();
      await page.evaluate(`() => {
        const view = document.getElementById("documentView");
        let frames = 0;
        const step = () => { view.scrollTop += 4; if (++frames < 120) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      }`);
      await sleep(600);
      const moving = await snapshot();
      results.layers = { still, moving };
      await page.evaluate(`async () => { await window.__recall.settle(1500); }`);
    }
    // --report prints App Info's PDF readout as the run left it — the same
    // lines a reader copies off their phone.
    if (REPORT) console.log(await page.evaluate(`() => window.__recall.api.pdfTimingReport?.() || "(no readout in this build)"`));
  } finally {
    client.close();
    launched.proc.kill("SIGKILL");
    server.proc.kill("SIGKILL");
  }
  return results;
}

function printProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas || [];
  (profile.samples || []).forEach((id, i) => {
    const node = byId.get(id);
    const { functionName, url, lineNumber } = node.callFrame;
    const file = (url || "").split("/").pop().split("?")[0];
    const key = `${functionName || "(anonymous)"} ${file ? `${file}:${lineNumber + 1}` : ""}`.trim();
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`profile · ${Math.round(total)}ms sampled · top self time`);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([key, ms]) => console.log(`  ${String(Math.round(ms)).padStart(6)}ms  ${key}`));
}

const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

const runs = [];
for (let i = 0; i < RUNS; i++) {
  runs.push(await oneRun());
  process.stderr.write(`run ${i + 1}/${RUNS} done\n`);
}

const row = (label, pick, unit = "ms") => {
  const values = runs.map(pick);
  if (values.every((v) => v === undefined)) return;
  console.log(`  ${label.padEnd(34)} ${String(median(values)).padStart(6)} ${unit}   (${values.join(", ")})`);
};
console.log(`pdf-perf · ${ROOT} · CPU ${THROTTLE}x · dpr ${DPR}${IMAGES ? " · photo pages" : ""} · ${RUNS} run(s)${INVERT ? " · dark page" : ""}${HIGHLIGHTS ? ` · ${HIGHLIGHTS} highlights a page` : ""}${ANNOTATED ? " · notes on half of them, printed under the pages" : ""}${MAIN_THREAD ? " · drawn on the main thread" : ""} · median (each run)`);
row("open: deck PDF to first page", (r) => r.open);
row("tab: Notes → PDF, page on screen", (r) => r.tab?.ms);
runs.forEach((r, i) => {
  if (r.tab && r.tab.before !== r.tab.after) console.log(`  !! run ${i + 1}: the tab switch moved the reader from page ${r.tab.before} to ${r.tab.after}`);
});
row("switch: PDF ↔ PDF, page on screen", (r) => r.switch);
row("zoom: step to page redrawn", (r) => r.zoom);
row("zoom in to 500%: page redrawn", (r) => r.zoomin?.drawn);
row("zoom in to 500%: sharp detail", (r) => r.zoomin?.sharp);
row("zoom in to 500%: canvas", (r) => r.zoomin?.mp, "MP");
row("zoom in to 500%: long tasks", (r) => r.zoomin?.longTaskMs);
row("zoom out: every page on screen drawn", (r) => r.zoomout?.ms);
row("zoom out: long tasks", (r) => r.zoomout?.longTaskMs);
row("fling: page 20 canvas", (r) => r.fling?.canvas);
row("fling: page 20 text layer", (r) => r.fling?.text);
row("fling: page 20 sharp (full density)", (r) => r.fling?.sharp);
row("steady scroll: p90 frame", (r) => r.steady?.p90Frame);
row("steady scroll: worst frame", (r) => r.steady?.worstFrame);
row("steady scroll: long tasks", (r) => r.steady?.longTaskMs);
row("pan after zoom: p90 frame", (r) => r.pan?.p90Frame);
row("pan after zoom: worst frame", (r) => r.pan?.worstFrame);
row("pan after zoom: long tasks (count)", (r) => r.pan?.longTasks, "");
row("pan after zoom: long tasks (total)", (r) => r.pan?.longTaskMs);
row("pan after zoom: scrolled", (r) => r.pan?.moved, "px");
row("pan: page fresh after lift", (r) => r.pan?.afterLiftMs);
row("layers, settled on a page", (r) => r.layers?.still.layers, "");
row("layers, settled: area", (r) => r.layers?.still.mp, "MP");
row("layers, mid-scroll", (r) => r.layers?.moving.layers, "");
row("layers, mid-scroll: area", (r) => r.layers?.moving.mp, "MP");
if (process.argv.includes("--debug")) runs.forEach((r) => console.log(JSON.stringify(r.pan)));
process.exit(0);
