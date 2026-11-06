// A tall page painted through a page-sized tiling pattern: does reading it in
// bands show "page breaks" the PDF does not have?
//
//   node tools/pdf-pattern-band-check.mjs
//   node tools/pdf-pattern-band-check.mjs --dpr=2
//
// The report: "even if there are no page breaks in the original PDF, I am
// seeing breakers in the long single-page PDFs" — a web page saved as one tall
// page, where every few thousand pixels the content was cut off and faded back
// in. The page's top fade (CSS mask-image) was printed as a tiling pattern whose
// one tile is the whole page, and pdf.js 3.11.174 clamps a tile's canvas to
// max(3000, the canvas being drawn into) without shrinking the scale — so in a
// band, a canvas far smaller than the tile, the tile was cut off and repeated
// every 3000 pixels. src/core/pdfjs-patches.js fixes it in pdf.js's source as
// the app loads it.
//
// The fixture is the bug with nothing else around it: a 612 × 14 400 pt page
// painted through ONE page-sized tile that has a blue bar at the top of the page
// and a red bar at the bottom. Drawn right there is one of each; drawn with the
// bug, the blue bar is gone and the red one repeats down the page.
//
// pdf.js is NOT injected here, unlike the other PDF checks: the app fetches it
// by its CDN URL (answered from the npm copy on disk, as the CDN would) and
// patches it, which is the path this check exists to cover. Asserted:
//
//   • the pdf.js the page runs is the patched one;
//   • drawn in bands by that pdf.js, at 1× and 2× density: one blue bar at the
//     top, one red bar at the bottom, nothing in between;
//   • in the viewer, with the page renderer's worker drawing, the bands on
//     screen at several places down the page carry no bar that is not there.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DPR = Number((process.argv.find((a) => a.startsWith("--dpr=")) || "--dpr=1").slice(6)) || 1;

// ── the fixture ─────────────────────────────────────────────────────────────
const W = 612;
const H = 14400;
const BAR = 40;
function patternPdf() {
  const tile = `0 0 1 rg 0 ${H - BAR} ${W} ${BAR} re f 1 0 0 rg 0 0 ${W} ${BAR} re f`;
  const page = [`/Pattern cs /P1 scn 0 0 ${W} ${H} re f`];
  for (let y = H - 80, n = 1; y > 60; y -= 24, n += 1) page.push(`BT /F1 11 Tf 0 0 0 rg 60 ${y} Td (Line ${n}) Tj ET`);
  const content = page.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R >> /Pattern << /P1 6 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    // A step two points past the box, as Chrome writes them: one tile a page.
    `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${W} ${H}] /XStep ${W + 2} /YStep ${H + 2} /Resources << >> /Length ${tile.length} >>\nstream\n${tile}\nendstream`
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
if (!chromePath) { console.log("pdf-pattern-band-check: no Chrome on this machine — skipping."); process.exit(0); }
let sources;
try { sources = pdfjsSources(); } catch (error) {
  console.log(`pdf-pattern-band-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
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

// Which rows of a strip of pixels (one column, top to bottom) are the blue bar
// and which the red one, as page-pixel ranges.
const BARS_IN = `(data, top, perPixel) => {
  const blue = [], red = [];
  for (let r = 0; r * 4 < data.length; r += 1) {
    const R = data[r * 4], B = data[r * 4 + 2];
    if (B > 200 && R < 60) blue.push(top + r / perPixel);
    if (R > 200 && B < 60) red.push(top + r / perPixel);
  }
  const ranges = (list) => {
    const out = [];
    for (const y of list) { const last = out.at(-1); if (last && y - last[1] <= 2) last[1] = y; else out.push([y, y]); }
    return out.map(([a, b]) => [Math.round(a), Math.round(b)]);
  };
  return { blue: ranges(blue), red: ranges(red) };
}`;

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: DPR, mobile: false });
  // The app's own fetch of the CDN URL is answered with the library as the CDN
  // serves it (unpatched): the app has to patch it itself.
  await servePdfjsFromDisk(client, page, sources);
  await page.goto(`${server.base}/index.html`);

  const opened = await page.evaluate(`async (bytes) => {
    const paths = ["/src/documents/pdf-view.js?v=__BUILD__", "/src/documents/pdf-render-worker.js?v=__BUILD__",
      "/src/import/pdf.js?v=__BUILD__", "/src/library/local-library.js?v=__BUILD__", "/src/storage/deck-store.js?v=__BUILD__",
      "/src/ui/boot-screens.js?v=__BUILD__", "/src/cloud/supabase-client.js?v=__BUILD__", "/src/core/state.js?v=__BUILD__",
      "/src/boot.js?v=__BUILD__", "/src/core/lib-loader.js?v=__BUILD__", "/src/ui/deck-header.js?v=__BUILD__"];
    const api = {};
    for (const m of await Promise.all(paths.map((p) => import(p)))) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__pat = { api, settle };
    const injected = Boolean(window.pdfjsLib);
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
    const loaded = await api.ensurePdfJs();
    await api.importPdfFile(new File([new Uint8Array(bytes)], "A patterned page.pdf", { type: "application/pdf" }), null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    await api.loadDeckFromLibrary(entry.id);
    await api.openDocumentView({ force: true });
    api.closeMyDecksPanel?.();
    api.fitDocumentToWidth();
    for (let i = 0; i < 100 && !document.querySelector("#documentView .pdf-canvas:not(.is-stale)"); i += 1) await settle(50);
    await settle(800);
    return { injected, loaded, status: api.pdfjsPatchStatus(), worker: api.pageRendererActive?.() ?? null };
  }`, [...patternPdf()]);
  check("pdf.js was loaded by the app, not injected", opened.loaded && !opened.injected);
  check("...and it is the patched pdf.js", opened.status.loaded === "patched" && opened.status.applied.includes("tiling-pattern-clamp")
    && !opened.status.missing.length, JSON.stringify(opened.status));
  check("the page renderer's worker is drawing", opened.worker === true);

  // Bands drawn by that pdf.js on its own, at both densities: where the bars are.
  const plain = await page.evaluate(`async (bytes) => {
    const bars = ${BARS_IN};
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pg = await doc.getPage(1);
    const viewport = pg.getViewport({ scale: 800 / pg.getViewport({ scale: 1 }).width });
    const out = {};
    for (const density of [1, 2]) {
      const blue = [], red = [];
      for (let y = 0; y < viewport.height; y += 700) {
        const h = Math.min(700, viewport.height - y);
        const c = document.createElement("canvas");
        c.width = Math.floor(viewport.width * density);
        c.height = Math.floor(h * density);
        const ctx = c.getContext("2d", { alpha: false, willReadFrequently: true });
        await pg.render({ canvasContext: ctx, viewport, transform: [density, 0, 0, density, 0, -y * density] }).promise;
        const found = bars(ctx.getImageData(Math.floor(c.width * 0.9), 0, 1, c.height).data, y, density);
        blue.push(...found.blue);
        red.push(...found.red);
      }
      out[density] = { blue, red };
    }
    doc.destroy();
    return { height: viewport.height, scale: viewport.scale, out };
  }`, [...patternPdf()]);
  const barPx = BAR * plain.scale;
  for (const density of [1, 2]) {
    const { blue, red } = plain.out[density];
    check(`drawn in bands at ${density}×: one blue bar, at the top`,
      blue.length === 1 && blue[0][0] <= 8 && blue[0][1] >= barPx - 8, JSON.stringify(blue));
    check(`...and one red bar, at the bottom — no repeats down the page`,
      red.length === 1 && red[0][0] >= plain.height - barPx - 8, `${red.length} bar(s): ${JSON.stringify(red.slice(0, 6))}`);
  }

  // The viewer: the bands it actually put on screen, at several places.
  const viewer = await page.evaluate(`async () => {
    const { api, settle } = window.__pat;
    const bars = ${BARS_IN};
    const view = document.getElementById("documentView");
    const pageEl = view.querySelector(".pdf-page");
    const seen = [];
    let bandsSeen = 0;
    for (const at of [0.12, 0.25, 0.42, 0.58, 0.75, 0.9, 0.995]) {
      view.scrollTop = pageEl.offsetTop + pageEl.offsetHeight * at - view.clientHeight / 2;
      await settle(1800);
      for (const c of pageEl.querySelectorAll(".pdf-band")) {
        bandsSeen += 1;
        const copy = document.createElement("canvas");
        copy.width = 1; copy.height = c.height;
        const ctx = copy.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(c, Math.floor(c.width * 0.9), 0, 1, c.height, 0, 0, 1, c.height);
        const top = parseFloat(c.style.top) || 0;
        const height = parseFloat(c.style.height) || 1;
        const found = bars(ctx.getImageData(0, 0, 1, c.height).data, top, c.height / height);
        seen.push({ top, height, ...found });
      }
    }
    return { pageHeight: pageEl.offsetHeight, bandsSeen, seen };
  }`);
  const pageBar = BAR * (viewer.pageHeight / H);
  const stray = viewer.seen.flatMap((b) => [
    ...b.red.filter(([from]) => from < viewer.pageHeight - pageBar - 8).map((r) => ({ bar: "red", at: r })),
    ...b.blue.filter(([, to]) => to > pageBar + 8).map((r) => ({ bar: "blue", at: r }))
  ]);
  check("the viewer drew bands down the page", viewer.bandsSeen >= 7, `${viewer.bandsSeen} band(s) looked at`);
  check("...with no bar the page does not have in any of them", stray.length === 0,
    stray.length ? JSON.stringify(stray.slice(0, 6)) : "");
  check("...and the page's own bottom bar where it belongs",
    viewer.seen.some((b) => b.red.some(([, to]) => to >= viewer.pageHeight - 8)));
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
