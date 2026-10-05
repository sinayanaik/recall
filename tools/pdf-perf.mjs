// How fast is the PDF reader on a phone? A benchmark, not a check.
//
//   node tools/pdf-perf.mjs                       # this tree, CPU throttled 4x
//   node tools/pdf-perf.mjs --root=/path/to/other/checkout
//   node tools/pdf-perf.mjs --runs=3 --throttle=6 --only=open,tab
//   node tools/pdf-perf.mjs --invert              # with dark page on
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
//   fling   a flick from page 1 to page 20, to page 20's canvas and its text
//   steady  three seconds of slow scrolling: frame times and long tasks

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
const ONLY = new Set(String(arg("only", "open,tab,switch,zoom,fling,steady")).split(","));
const INVERT = process.argv.includes("--invert");
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
const { pdfjsSources } = await import(path.join(HERE, "tools/pdfjs-source.mjs"));

// ── A paper that costs what a paper costs ──────────────────────────────────
function densePdf(pages = 40, { seed = 7, title = "Dense Paper" } = {}) {
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
    const c = push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    ids.push(push(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
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
    "/src/documents/pdf-multi.js"]
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
  const launched = await launchChrome(chrome);
  const client = await connect(launched.wsUrl);
  const page = await openPage(client);
  const results = {};
  try {
    await emulatePhone(page, { cpuThrottle: 1 });
    if (DPR !== 2) await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true });
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
      api.applyPdfInvert(Boolean(invert), { remember: false });
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      return { deckId: entry.id, otherId, firstId, secondId, pages: api.currentPdfPageCount() };
    }`, Array.from(densePdf(40)), Array.from(densePdf(20, { seed: 11, title: "Second Paper" })),
    Array.from(densePdf(30, { seed: 23, title: "Other Deck" })), INVERT);

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
console.log(`pdf-perf · ${ROOT} · CPU ${THROTTLE}x · dpr ${DPR} · ${RUNS} run(s)${INVERT ? " · dark page" : ""} · median (each run)`);
row("open: deck PDF to first page", (r) => r.open);
row("tab: Notes → PDF, page on screen", (r) => r.tab?.ms);
runs.forEach((r, i) => {
  if (r.tab && r.tab.before !== r.tab.after) console.log(`  !! run ${i + 1}: the tab switch moved the reader from page ${r.tab.before} to ${r.tab.after}`);
});
row("switch: PDF ↔ PDF, page on screen", (r) => r.switch);
row("zoom: step to page redrawn", (r) => r.zoom);
row("fling: page 20 canvas", (r) => r.fling?.canvas);
row("fling: page 20 text layer", (r) => r.fling?.text);
row("fling: page 20 sharp (full density)", (r) => r.fling?.sharp);
row("steady scroll: p90 frame", (r) => r.steady?.p90Frame);
row("steady scroll: worst frame", (r) => r.steady?.worstFrame);
row("steady scroll: long tasks", (r) => r.steady?.longTaskMs);
process.exit(0);
