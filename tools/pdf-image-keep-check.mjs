// Dark page keeps a page's photographs (src/documents/pdf-image-keep.js).
//
//   node tools/pdf-image-keep-check.mjs           # Node, then the browser
//   node tools/pdf-image-keep-check.mjs --quick   # Node only
//
// The report: on a dark page "everything is getting inverted so the images look
// very very bad". The page is still inverted; the pictures on it that are not
// paper are put back. Asserted:
//
// In Node:
//   • the kit is self-contained — it runs from its own source text, which is
//     how the page renderer's worker gets it — and the worker is built with it;
//   • the quads an operator list paints pictures into: through save/restore,
//     transforms, form XObjects, annotations, a repeated image, an inline
//     group, a rotated page; stencil masks and specks ignored;
//   • the same, from the operator list the real pdf.js builds for the fixture's
//     photo page (tools/pdf-fixture.mjs, `photo`);
//   • which samples are paper: a photo and a colourful chart on white are not,
//     a line drawing, a scan of text and a blank are;
//   • the patch that hands the render's own operator list back is in the list.
// In the browser, the app loading pdf.js its own way (patched), for the worker
// with kept pictures, the worker's canvases, and the main thread:
//   • Black: the photo shows its own colours, the line drawing and the paper go
//     dark; Dim the same with the Dim paper; White back again, the photo
//     unchanged and the page white;
//   • a render task of the patched pdf.js hands back its operator list.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageKeepKit } from "../src/documents/pdf-image-keep.js";
import { PDFJS_PATCHES } from "../src/core/pdfjs-patches.js";
import { LINE_ART_RECT, PAGE_HEIGHT, PAGE_WIDTH, PHOTO_RECT, buildFixturePdf, photoPixel } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const near = (a, b, tolerance = 0.002) => Math.abs(a - b) <= tolerance;
const sameQuad = (q, expected, tolerance) => q.length === 8 && q.every((v, i) => near(v, expected[i], tolerance));

// The quad of a PDF rectangle [x, y, w, h] on an unrotated Letter page, in
// the order the kit emits (the image's own unit square: bottom-left first).
function rectQuad([x, y, w, h], pw = PAGE_WIDTH, ph = PAGE_HEIGHT) {
  const X = (v) => v / pw;
  const Y = (v) => (ph - v) / ph;
  return [X(x), Y(y), X(x + w), Y(y), X(x + w), Y(y + h), X(x), Y(y + h)];
}

// ── Node ────────────────────────────────────────────────────────────────────

const source = imageKeepKit.toString();
let kit = null;
try {
  // eslint-disable-next-line no-new-func
  kit = new Function(`"use strict"; return (${source})();`)();
} catch (error) {
  check("the kit runs from its own source", false, error?.message);
}
check("the kit runs from its own source, as the worker gets it",
  kit && ["quads", "classify", "bake", "paperLike", "pageMap", "regionMap", "pictureMap"].every((k) => typeof kit[k] === "function"));
const workerSource = readFileSync(path.join(ROOT, "src/documents/pdf-render-worker.js"), "utf8");
check("the page renderer's worker is built with the kit",
  workerSource.includes("(${pageRendererWorker.toString()})((${imageKeepKit.toString()})())") && /function pageRendererWorker\(kit\)/.test(workerSource));
check("pdf.js is patched to hand back the render's operator list",
  PDFJS_PATCHES.some((patch) => patch.name === "render-task-operator-list"));

if (kit) {
  const OPS = {
    save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
    beginAnnotation: 80, endAnnotation: 81, paintImageMaskXObject: 83, paintImageXObject: 85,
    paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88
  };
  // A Letter page at scale 1, as pdf.js's viewport has it: y flipped.
  const viewport = { transform: [1, 0, 0, -1, 0, PAGE_HEIGHT], width: PAGE_WIDTH, height: PAGE_HEIGHT };
  const run = (ops, vp = viewport) => kit.quads({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1] ?? null) }, OPS, vp);

  const plain = run([[OPS.save], [OPS.transform, [200, 0, 0, 150, 72, 200]], [OPS.paintImageXObject, ["img1", 32, 32]], [OPS.restore]]);
  check("a picture's quad is its rectangle on the page", plain.length === 1 && sameQuad(plain[0], rectQuad([72, 200, 200, 150])), JSON.stringify(plain));

  const nested = run([
    [OPS.transform, [2, 0, 0, 2, 0, 0]],
    [OPS.save], [OPS.transform, [50, 0, 0, 40, 10, 10]], [OPS.restore],
    [OPS.save], [OPS.transform, [100, 0, 0, 80, 20, 30]], [OPS.paintInlineImageXObject, [{}]], [OPS.restore],
    [OPS.paintFormXObjectBegin, [[0.5, 0, 0, 0.5, 100, 100], [0, 0, 10, 10]]],
    [OPS.transform, [100, 0, 0, 100, 0, 0]], [OPS.paintImageXObject, ["img2", 4, 4]],
    [OPS.paintFormXObjectEnd],
    [OPS.transform, [100, 0, 0, 100, 0, 0]], [OPS.paintImageXObject, ["img3", 4, 4]]
  ]);
  check("transforms nest through save/restore and form XObjects", nested.length === 3
    && sameQuad(nested[0], rectQuad([40, 60, 200, 160]))
    && sameQuad(nested[1], rectQuad([200, 200, 100, 100]))
    && sameQuad(nested[2], rectQuad([0, 0, 200, 200])), JSON.stringify(nested));

  const annotated = run([
    [OPS.transform, [3, 0, 0, 3, 0, 0]],
    [OPS.beginAnnotation, ["a1", [0, 0, 100, 100], [1, 0, 0, 1, 300, 400], [1, 0, 0, 1, 0, 0], false]],
    [OPS.transform, [100, 0, 0, 100, 0, 0]], [OPS.paintImageXObject, ["stamp", 4, 4]],
    [OPS.endAnnotation],
    [OPS.transform, [10, 0, 0, 10, 0, 0]], [OPS.paintImageXObject, ["after", 4, 4]]
  ]);
  check("an annotation starts from the page, not the content's transform", annotated.length === 2
    && sameQuad(annotated[0], rectQuad([300, 400, 100, 100]))
    && sameQuad(annotated[1], rectQuad([0, 0, 30, 30])), JSON.stringify(annotated));

  const repeated = run([[OPS.paintImageXObjectRepeat, ["tile", 60, 50, [0, 0, 100, 0, 200, 300]]]]);
  check("a repeated image is a quad per placement", repeated.length === 3
    && sameQuad(repeated[2], rectQuad([200, 300, 60, 50])), JSON.stringify(repeated));

  const group = run([[OPS.paintInlineImageXObjectGroup, [{}, [{ transform: [80, 0, 0, 40, 10, 500] }, { transform: [80, 0, 0, 40, 100, 500] }]]]]);
  check("an inline group is a quad per entry", group.length === 2 && sameQuad(group[1], rectQuad([100, 500, 80, 40])), JSON.stringify(group));

  const ignored = run([
    [OPS.save], [OPS.transform, [300, 0, 0, 300, 0, 0]], [OPS.paintImageMaskXObject, [{}]], [OPS.restore],
    [OPS.save], [OPS.transform, [8, 0, 0, 8, 100, 100]], [OPS.paintImageXObject, ["bullet", 2, 2]], [OPS.restore],
    [OPS.save], [OPS.transform, [300, 0, 0, 300, 2000, 2000]], [OPS.paintImageXObject, ["off", 2, 2]], [OPS.restore]
  ]);
  check("stencil masks, specks and pictures off the page are not candidates", ignored.length === 0, JSON.stringify(ignored));

  // Rotated 90°, as pdf.js's viewport is for /Rotate 90: the shown page is
  // 792 wide and 612 tall, and a picture's quad is turned with it.
  const rotated = run([[OPS.transform, [200, 0, 0, 150, 72, 200]], [OPS.paintImageXObject, ["img", 4, 4]]],
    { transform: [0, 1, 1, 0, 0, 0], width: PAGE_HEIGHT, height: PAGE_WIDTH });
  const rx = rotated[0]?.filter((_, i) => i % 2 === 0) || [];
  const ry = rotated[0]?.filter((_, i) => i % 2 === 1) || [];
  check("a rotated page turns the quad with it", rotated.length === 1
    && near(Math.min(...rx), 200 / PAGE_HEIGHT) && near(Math.max(...rx), 350 / PAGE_HEIGHT)
    && near(Math.min(...ry), 72 / PAGE_WIDTH) && near(Math.max(...ry), 272 / PAGE_WIDTH), JSON.stringify(rotated));

  // Samples, as RGBA.
  const sample = (fn, n = 48) => {
    const data = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const [r, g, b] = fn(x / n, y / n);
        data.set([r, g, b, 255], (y * n + x) * 4);
      }
    }
    return data;
  };
  check("a photo is not paper", !kit.paperLike(sample((u, v) => photoPixel(u, v))));
  check("a dark screenshot is not paper", !kit.paperLike(sample((u, v) => (v * 10 % 1 < 0.2 && u < 0.7 ? [220, 220, 220] : [30, 32, 36]))));
  check("a colourful chart on white is not paper", !kit.paperLike(sample((u, v) => (Math.abs(v - (0.8 - u * 0.6)) < 0.03 ? [220, 40, 40]
    : Math.abs(v - (0.3 + u * 0.4)) < 0.03 ? [40, 90, 220] : [255, 255, 255]))));
  check("a black-on-white line drawing is paper", kit.paperLike(sample((u, v) => (v * 8 % 1 < 0.125 ? [0, 0, 0] : [255, 255, 255]))));
  check("a scan of text is paper", kit.paperLike(sample((u, v) => (v * 12 % 1 < 0.35 && u * 30 % 1 < 0.7 ? [25, 25, 25] : [244, 242, 238]))));
  check("a blank is paper", kit.paperLike(sample(() => [255, 255, 255])));

  const map = kit.regionMap(600, 800, { x: 100, y: 200 }, 2);
  check("a detail tile's map puts a page point in its pixels", map.sx * 0.5 - map.ox === 400 && map.sy * 0.5 - map.oy === 400);
  const cropped = kit.pictureMap(1000, 1300, { x: 100, y: 100, width: 500, height: 650 }, 250, 325);
  check("a cropped picture's map does too", near(cropped.sx * 0.5 - cropped.ox, 200, 1e-9) && near(cropped.sy * 0.5 - cropped.oy, 275, 1e-9));
}

// The real pdf.js, in Node: no canvas, but operator lists need none.
let sources = null;
try {
  const { pdfjsSources } = await import("./pdfjs-source.mjs");
  sources = pdfjsSources();
} catch (error) {
  console.log(`  (could not obtain pdf.js: ${error?.message || error} — skipping the pdf.js checks)`);
}
if (sources && kit) {
  const require = createRequire(import.meta.url);
  const quiet = console.log;
  console.log = () => {};
  let quads = null;
  let lib = null;
  try {
    lib = require("/tmp/recall-pdfjs/package/legacy/build/pdf.min.js");
    lib.GlobalWorkerOptions.workerSrc = "/tmp/recall-pdfjs/package/legacy/build/pdf.worker.min.js";
    const doc = await lib.getDocument({ data: buildFixturePdf({ pages: 1, photo: true, annotate: false }).bytes, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    quads = kit.quads(await page.getOperatorList(), lib.OPS, page.getViewport({ scale: 1.5 }));
    await doc.destroy();
  } catch (error) {
    quads = String(error?.message || error);
  } finally {
    console.log = quiet;
  }
  check("pdf.js's own operator list for the photo page: two pictures, where the fixture drew them",
    Array.isArray(quads) && quads.length === 2
    && sameQuad(quads[0], rectQuad(PHOTO_RECT), 0.001) && sameQuad(quads[1], rectQuad(LINE_ART_RECT), 0.001),
    JSON.stringify(quads));
}

// ── The browser ─────────────────────────────────────────────────────────────

async function browser() {
  const { findChrome, launchChrome, connect, openPage } = await import("./cdp.mjs");
  const { servePdfjsFromDisk } = await import("./pdfjs-source.mjs");
  const chromePath = findChrome();
  if (!chromePath) {
    console.log("  (no Chrome on this machine — skipping the browser checks)");
    return;
  }
  const server = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), ROOT, "0"], { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.once("data", (d) => resolve({ proc, base: `http://127.0.0.1:${String(d).trim()}` }));
    proc.on("error", reject);
  });
  const watchdog = setTimeout(() => { console.log("  FAIL  gave up after 5 minutes"); process.exit(1); }, 5 * 60 * 1000);
  const fixture = [...buildFixturePdf({ pages: 2, photo: true, annotate: false }).bytes];
  // Where to look, as fractions of the shown page: the photo's dark blue
  // corner (inverted, it would be a pale lilac — a mid-grey would not tell the
  // two apart), a white row of the line drawing, and empty paper in the right
  // margin.
  const at = ([x, y, w, h], fx, fy) => [(x + w * fx) / PAGE_WIDTH, (PAGE_HEIGHT - (y + h * fy)) / PAGE_HEIGHT];
  const spots = { photo: at(PHOTO_RECT, 0.1, 0.9), lineArt: at(LINE_ART_RECT, 0.5, 0.75), paper: [580 / PAGE_WIDTH, 0.55] };
  const photoCorner = photoPixel(0.1, 0.1);

  // A browser of its own for each way of drawing: once the app has loaded, its
  // service worker answers the CDN's pdf.js itself, past the check's answer
  // from disk, and a second load of the app in the same profile has no pdf.js.
  const modes = [
      { name: "kept pictures", storage: {} },
      { name: "the worker's canvases", storage: { "recall:pdfPictures": "0" } },
      { name: "the main thread", storage: { "recall:pdfPictures": "0", "recall:pdfRenderWorker": "0" } }
  ];
  for (const [index, mode] of modes.entries()) {
    const launched = await launchChrome(chromePath);
    const client = await connect(launched.wsUrl);
    const page = await openPage(client);
    try {
      await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await servePdfjsFromDisk(client, page, sources);
      // The storage first, from a page of the same origin that is not the app.
      await page.goto(`${server.base}/__storage-only__`);
      await page.evaluate(`(storage) => { for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); }`, mode.storage);
      await page.goto(`${server.base}/index.html`);
      const report = await page.evaluate(`async (bytes, spots, first) => {
        const paths = ["/src/documents/pdf-view.js?v=__BUILD__", "/src/documents/pdf-render-worker.js?v=__BUILD__",
          "/src/import/pdf.js?v=__BUILD__", "/src/library/local-library.js?v=__BUILD__", "/src/storage/deck-store.js?v=__BUILD__",
          "/src/ui/boot-screens.js?v=__BUILD__", "/src/cloud/supabase-client.js?v=__BUILD__", "/src/core/state.js?v=__BUILD__",
          "/src/boot.js?v=__BUILD__", "/src/core/lib-loader.js?v=__BUILD__", "/src/ui/deck-header.js?v=__BUILD__"];
        const api = {};
        for (const m of await Promise.all(paths.map((p) => import(p)))) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
        const settle = (ms) => new Promise((r) => setTimeout(r, ms));
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
        await api.ensurePdfJs();
        await api.importPdfFile(new File([new Uint8Array(bytes)], "Photographs.pdf", { type: "application/pdf" }), null);
        await settle(400);
        const entry = api.readLocalDeckIndex().find((e) => /Photographs/.test(e.title || e.name || "")) || api.readLocalDeckIndex()[0];
        if (!entry) return { error: "nothing imported", toasts: [...document.querySelectorAll("[class*=toast]")].map((t) => t.textContent).join(" / ") };
        await api.loadDeckFromLibrary(entry.id);
        await api.openDocumentView({ force: true });
        api.closeMyDecksPanel?.();
        api.fitDocumentToWidth();

        const shown = () => document.querySelector('.pdf-page[data-page-number="1"] .pdf-picture:not(.is-stale), .pdf-page[data-page-number="1"] .pdf-canvas:not(.is-stale)');
        const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await settle(100); } return false; };
        const read = () => {
          const node = shown();
          if (!node) return null;
          const w = node.naturalWidth || node.width;
          const h = node.naturalHeight || node.height;
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(node, 0, 0, w, h);
          const px = ([fx, fy]) => [...ctx.getImageData(Math.floor(fx * w), Math.floor(fy * h), 1, 1).data.slice(0, 3)];
          return {
            kind: node.tagName.toLowerCase() + (node.classList.contains("pdf-picture") ? " picture" : ""),
            darkPixels: node.classList.contains("is-dark-pixels"),
            filter: getComputedStyle(node).filter,
            photo: px(spots.photo), lineArt: px(spots.lineArt), paper: px(spots.paper)
          };
        };
        const onPaper = async (tone) => {
          api.setPaperTone(tone);
          const dark = tone !== "white";
          await until(() => shown() && shown().classList.contains("is-dark-pixels") === dark && getComputedStyle(shown()).filter === "none");
          await settle(600);
          return read();
        };
        await until(() => shown());
        const out = { worker: api.pageRendererActive(), status: api.pdfjsPatchStatus() };
        out.black = await onPaper("black");
        out.dim = await onPaper("dim");
        out.white = await onPaper("white");
        out.blackAgain = await onPaper("black");
        if (first) {
          // A render task of the patched pdf.js, asked for its operator list.
          const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
          const pg = await doc.getPage(1);
          const viewport = pg.getViewport({ scale: 1 });
          const c = document.createElement("canvas");
          c.width = viewport.width; c.height = viewport.height;
          const task = pg.render({ canvasContext: c.getContext("2d"), viewport });
          await task.promise;
          out.opList = task.recallOperatorList?.fnArray?.length || 0;
          out.opImages = (task.recallOperatorList?.fnArray || []).filter((fn) => fn === pdfjsLib.OPS.paintImageXObject).length;
          doc.destroy();
        }
        return out;
      }`, fixture, spots, index === 0);

      const label = mode.name;
      if (report.error) console.log("  report:", JSON.stringify(report).slice(0, 600));
      if (index === 0) {
        check("the app's pdf.js carries the operator-list patch",
          report.status?.applied?.includes("render-task-operator-list"), JSON.stringify(report.status));
        check("...and a render task hands back the list it drew from", report.opList > 0 && report.opImages === 2,
          `${report.opList} ops, ${report.opImages} pictures`);
      }
      check(`${label}: drawn where asked`, mode.storage["recall:pdfRenderWorker"] === "0" ? report.worker === false : report.worker === true,
        `worker ${report.worker}, ${report.black?.kind}`);
      const close = (a, b, t = 28) => Array.isArray(a) && a.every((v, i) => Math.abs(v - b[i]) <= t);
      const dark = (a, t = 40) => Array.isArray(a) && a.every((v) => v <= t);
      const light = (a, t = 225) => Array.isArray(a) && a.every((v) => v >= t);
      const dim = [0x26, 0x28, 0x2d];
      const say = (r) => JSON.stringify({ photo: r?.photo, lineArt: r?.lineArt, paper: r?.paper, dark: r?.darkPixels, filter: r?.filter });
      check(`${label}, Black: the photo keeps its own colours`, close(report.black?.photo, photoCorner), `${say(report.black)} want photo ${photoCorner}`);
      check(`${label}, Black: the line drawing and the paper go dark`, dark(report.black?.lineArt) && dark(report.black?.paper, 12), say(report.black));
      check(`${label}, Dim: the photo kept, the paper Dim`, close(report.dim?.photo, photoCorner) && close(report.dim?.paper, dim, 8)
        && close(report.dim?.lineArt, dim, 16), say(report.dim));
      check(`${label}, White: the photo as it is, the page white`, close(report.white?.photo, photoCorner)
        && light(report.white?.paper, 245) && light(report.white?.lineArt), say(report.white));
      check(`${label}, Black again: the photo still kept`, close(report.blackAgain?.photo, photoCorner) && dark(report.blackAgain?.paper, 12),
        say(report.blackAgain));
    } catch (error) {
      check(`${mode.name}: ran to the end`, false, error?.stack || String(error));
    }
    try { client.close(); } catch (_) { /* gone */ }
    await launched.close?.();
    try { launched.proc?.kill("SIGKILL"); } catch (_) { /* gone */ }
  }
  clearTimeout(watchdog);
  server.proc.kill();
}

if (!QUICK && sources) await browser();

const failed = results.filter((ok) => !ok).length;
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
