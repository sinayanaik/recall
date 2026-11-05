// A web page saved as ONE very tall PDF page: is it sharp while you scroll?
//
//   node tools/pdf-tall-page-check.mjs
//   node tools/pdf-tall-page-check.mjs --dpr=2
//   node tools/pdf-tall-page-check.mjs --phone      # 390×844 at 2x, touch, CPU slowed 4×
//
// The report: "when I import a long website as a single page PDF, scrolling
// shows a blur at first that then clears." A page 200 inches tall is tens of
// millions of pixels at fit width, so its base canvas is soft by design
// (canvasOutputScale in src/documents/pdf-view.js), and the one detail tile that
// sharpened it was cancelled by every scroll and only drawn again once the
// reader stopped. Bands for tall pages (same file) draw the page in strips that
// follow the reader.
//
// Asserted, on a 14 400 pt page opened by the app's own import and viewer:
//
//   • while scrolling at reading speed, without stopping, what is on screen is
//     covered by bands at the screen's density in most of the samples;
//   • never more than PDF_BAND_MAX bands are kept, and the base canvas stays
//     inside the per-canvas budget;
//   • once still, what is on screen is sharp;
//   • scrolling back up is sharp too;
//   • the main thread stays free: no long task while scrolling is anywhere near
//     a dropped second, and the scroll handler itself stays cheap.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DPR = Number((process.argv.find((a) => a.startsWith("--dpr=")) || "--dpr=1").slice(6)) || 1;
const PHONE = process.argv.includes("--phone");

// ── the fixture: one page, 612 × 14 400 pt, a line of text every 24 pt ──────
function tallPdf() {
  const W = 612;
  const H = 14400;
  const lines = [];
  for (let y = H - 60, n = 1; y > 40; y -= 24, n += 1) {
    if (n % 25 === 1) lines.push(`0.85 0.88 0.95 rg 50 ${y - 6} ${W - 100} 20 re f 0 0 0 rg`);
    lines.push(`BT /F1 ${n % 25 === 1 ? 16 : 11} Tf 60 ${y} Td (${n % 25 === 1 ? `Section ${Math.ceil(n / 25)}` : `Line ${n}: the tide rises and falls twice a day as the moon pulls on the oceans.`}) Tj ET`);
  }
  const content = lines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.once("data", (d) => resolve({ proc, base: `http://127.0.0.1:${String(d).trim()}` }));
    proc.on("error", reject);
  });
}

const chromePath = findChrome();
if (!chromePath) { console.log("pdf-tall-page-check: no Chrome on this machine — skipping."); process.exit(0); }
let sources;
try { sources = pdfjsSources(); } catch (error) {
  console.log(`pdf-tall-page-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const server = await serveOn(ROOT);
const launched = await launchChrome(chromePath);
const client = await connect(launched.wsUrl);
const page = await openPage(client);
const watchdog = setTimeout(() => { console.log("  FAIL  gave up after 4 minutes"); process.exit(1); }, 4 * 60 * 1000);

try {
  if (PHONE) await emulatePhone(page, { cpuThrottle: 4 });
  else await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: DPR, mobile: false });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () { try { var b = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" }); window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(b); } catch (e) {} })();`
  });
  await servePdfjsFromDisk(client, page, sources);
  await page.goto(`${server.base}/index.html`);

  const opened = await page.evaluate(`async (bytes) => {
    const paths = ["/src/documents/pdf-view.js?v=__BUILD__", "/src/documents/pdf-render-worker.js?v=__BUILD__",
      "/src/import/pdf.js?v=__BUILD__", "/src/library/local-library.js?v=__BUILD__", "/src/storage/deck-store.js?v=__BUILD__",
      "/src/ui/boot-screens.js?v=__BUILD__", "/src/cloud/supabase-client.js?v=__BUILD__", "/src/core/state.js?v=__BUILD__",
      "/src/boot.js?v=__BUILD__"];
    const api = {};
    for (const m of await Promise.all(paths.map((p) => import(p)))) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__tall = { api, settle };
    api.setSupabaseClient({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
        getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => ({ error: null })
      },
      from: () => { throw new Error("offline in this check"); },
      storage: { from: () => ({
        upload: async () => ({ error: { message: "offline in this check" } }),
        remove: async () => ({ error: null }),
        list: async () => ({ data: [], error: null }),
        createSignedUrls: async () => ({ data: [], error: null }),
        getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/" + p } })
      }) }
    });
    for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
    api.setSignedIn(true);
    api.showAuthenticatedUI();
    api.initAppForUser();
    await settle(600);
    await api.importPdfFile(new File([new Uint8Array(bytes)], "A long web page.pdf", { type: "application/pdf" }), null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    await api.loadDeckFromLibrary(entry.id);
    await api.openDocumentView({ force: true });
    api.fitDocumentToWidth();
    for (let i = 0; i < 100 && !document.querySelector("#documentView .pdf-canvas:not(.is-stale)"); i += 1) await settle(50);
    await settle(800);
    return { canvas: Boolean(document.querySelector("#documentView .pdf-canvas")), worker: api.pageRendererActive?.() ?? null };
  }`, [...tallPdf()]);
  check("the tall page opens and draws", opened.canvas, `page renderer ${opened.worker ? "on" : "off"}`);

  // One sample: is what is on screen covered by bands at the screen's density?
  const SAMPLE = `() => {
    const { api } = window.__tall;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const seen = api.documentPageVisibleRect(1);
    // Every sharp layer on the page, read from the page itself — bands and the
    // single detail tile alike — so the same sample measures the old viewer too.
    const bands = [...document.querySelectorAll("#documentView .pdf-detail")].map((c) => {
      const width = parseFloat(c.style.width) || 1;
      return { y: parseFloat(c.style.top) || 0, height: parseFloat(c.style.height) || 0, width, density: c.width / width };
    }).sort((a, b) => a.y - b.y);
    if (!seen) return { covered: false, bands: bands.length };
    let y = seen.y;
    const end = seen.y + seen.height - 1;
    for (const b of bands) {
      if (b.density < dpr - 0.05 || b.y > y + 1) continue;
      if (b.y + b.height > y) y = b.y + b.height;
    }
    const base = document.querySelector("#documentView .pdf-canvas:not(.is-stale)");
    return { covered: y >= end, bands: bands.length, pixels: bands.reduce((s, b) => s + b.width * b.height * b.density * b.density, 0),
      // naturalWidth for a page kept as a picture (an <img>), width for a canvas.
      base: base ? (base.naturalWidth || base.width) * (base.naturalHeight || base.height) : 0, budget: api.canvasPixelBudget() };
  }`;

  const settled = await page.evaluate(`async () => { await window.__tall.settle(1500); return (${SAMPLE})(); }`);
  check("still: what is on screen is sharp", settled.covered, `${settled.bands} band(s)`);
  check("the base canvas stays inside the per-canvas budget", settled.base > 0 && settled.base <= settled.budget * 1.01,
    `${(settled.base / 1e6).toFixed(1)}MP of ${(settled.budget / 1e6).toFixed(1)}MP`);

  // Reading-speed scrolling — about one screen a second, well under a fling —
  // for six seconds, never stopping long enough for the page to settle.
  async function scrollRun(direction) {
    return page.evaluate(`async (direction) => {
      const { api } = window.__tall;
      const view = document.getElementById("documentView");
      const sample = ${SAMPLE};
      const longTasks = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => list.getEntries().forEach((t) => longTasks.push(Math.round(t.duration))));
        observer.observe({ type: "longtask", buffered: false });
      } catch (_) { /* no long-task timing here */ }
      const frames = [];
      let samples = 0, covered = 0, maxBands = 0, maxPixels = 0, budget = api.canvasPixelBudget();
      const step = Math.round(view.clientHeight / 12);
      const started = performance.now();
      let last = started;
      while (performance.now() - started < 6000) {
        view.scrollTop += direction * step;
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
        const now = performance.now();
        frames.push(now - last);
        last = now;
        // The first second is the bands catching up with a page that was still.
        if (now - started < 1000) continue;
        const s = sample();
        samples += 1;
        if (s.covered) covered += 1;
        maxBands = Math.max(maxBands, s.bands);
        maxPixels = Math.max(maxPixels, s.pixels || 0);
      }
      observer?.disconnect();
      frames.sort((a, b) => a - b);
      return { samples, covered, maxBands, maxPixels, budget, longest: Math.max(0, ...longTasks), longTasks: longTasks.length,
        p95: Math.round(frames[Math.floor(frames.length * 0.95)] || 0), max: PDF_MAX(api) };
      function PDF_MAX(api) { return api.PDF_BAND_MAX ?? 1; }
    }`, direction);
  }

  const down = await scrollRun(1);
  const share = down.samples ? down.covered / down.samples : 0;
  check("scrolling down without stopping: the screen is sharp in most samples", share >= 0.8,
    `${down.covered}/${down.samples} samples sharp`);
  check("...with no more bands than allowed", down.maxBands <= down.max, `at most ${down.maxBands} of ${down.max}`);
  check("...and their pixels within a few canvases' worth", down.maxPixels <= down.budget * 3.05,
    `${(down.maxPixels / 1e6).toFixed(1)}MP for ${(down.budget / 1e6).toFixed(1)}MP a canvas`);
  check("...and the main thread free: no long task near a dropped second", down.longest < 250,
    `${down.longTasks} long task(s), longest ${down.longest}ms; 95th percentile step ${down.p95}ms`);

  const up = await scrollRun(-1);
  const shareUp = up.samples ? up.covered / up.samples : 0;
  check("scrolling back up: sharp in most samples too", shareUp >= 0.8, `${up.covered}/${up.samples} samples sharp`);
} catch (error) {
  check("ran to the end", false, error?.stack || String(error));
}

clearTimeout(watchdog);
try { client.close(); } catch (_) { /* gone */ }
await launched.close?.();
try { launched.proc?.kill("SIGKILL"); } catch (_) { /* gone */ }
server.proc.kill();
const failed = results.filter((ok) => !ok).length;
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
