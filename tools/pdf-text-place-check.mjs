// Is the text layer where the page is painted — on a line of Hindi?
//
//   node tools/pdf-text-place-check.mjs
//   node tools/pdf-text-place-check.mjs --shot=hindi-layer.png
//
// The report: on a Hindi PDF exported from Recall, double-clicking संस्कार
// selected a box over "स्कार"; a highlight over अध्यात्मवादी stopped at "…वा";
// one over इसलिए sat a word to the left; and one was stored as "वेचन ि". The
// page was fine. Three things were not, and each has its own assertion here:
//
//   1. pdf.js gave every half form and conjunct (ध्, क्, ज्ञ) no width, so a
//      line's item was a tenth narrower than the line (src/core/pdfjs-patches.js,
//      glyph-with-mark-has-width);
//   2. the text layer set each line in the browser's font and stretched it to
//      that width, so its words sat wherever that font put them — now each word
//      is placed where pdf.js says its glyphs are (text-item-char-x, and
//      appendTextItem in src/documents/pdf-view.js);
//   3. the writer's Hindi read back in DRAWING order ("िकया", "दशर्न") —
//      put back in typed order for files the writer made
//      (devanagariLogicalOrder in src/documents/pdf-selection.js).
//
// ...and a highlight made over the old layer is moved onto the words its box
// mostly covered (repairDocumentHighlightQuads, QUAD_GEOMETRY_VERSION 3).
//
// The PDF is made the way the app makes one — the Markdown → PDF writer, with
// pdf-lib, fontkit and Noto Sans Devanagari from npm, as tools/md-pdf-check.mjs
// does — and the writer's own layout says where every word was drawn, which is
// what the text layer is measured against.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";
import { fontkitSource, fontFile } from "./fontkit-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7);
export const WATCHDOG_MS = 4 * 60 * 1000;

// The report's own paragraph.
const HINDI = "कि भारतीय दर्शन में कि एक दर्शन ऐसा है जो लोगों के लिए बड़ा विवाद का विषय रहा है है उसका कारण भी है आज के भारत के लोग जो हैं वह अध्यात्मवादी हैं भारत के संस्कार ही ऐसे बने हैं वेद ने भारत को ए ए क्यों रास्ता दिखाया है वह अध्यात्म का रास्ता दिखाया है उपनिषद में भी ब्रह्म ज्ञान का और कि अध्यात्म का आत्मा का सारा विवेचन किया गया है इसलिए भारतीय लोग जो कोई ऐसी चीज हो जिस जो आत्मा पर संदेश करता हो या परलोक को नहीं मानता हो तो उसकी बात सुनकर के भारतीय कांप जाते हैं डर जाते हैं";

// ── The PDF, made by the app's own writer ──────────────────────────────────
//
// The same steps md-pdf/build.js takes in the browser, as tools/md-pdf-check.mjs
// takes them. Its modules reach for a DOM at load only, which is stubbed.
async function writeHindiPdf() {
  const saved = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  globalThis.document = new Proxy({}, { get() { return () => null; } });
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  try {
    const load = (src) => {
      const m = { exports: {} };
      new Function("module", "exports", "self", "globalThis", "window", src)(m, m.exports, {}, {}, {});
      return m.exports;
    };
    const PDFLib = load(pdflibSource());
    const fontkit = load(fontkitSource());
    const { marked } = load(readFileSync(path.join(ROOT, "vendor/marked-14.1.2/marked.min.js"), "utf8"));
    const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
    const pre = await mod("src/render/preprocess.js");
    const fc = await mod("src/documents/md-pdf/fonts-core.js");
    const L = await mod("src/documents/md-pdf/layout.js");
    const B = await mod("src/documents/md-pdf/breaks.js");
    const W = await mod("src/documents/md-pdf/writer.js");
    const { woffToSfnt } = await mod("src/documents/md-pdf/woff.js");
    fc.installRegeneratorShim(globalThis);
    const o = L.normalizeMdPdfOptions({});
    const blocks = L.blocksFromTokens(marked.lexer(pre.preprocessSpecialBlocks(`${HINDI}\n`)));
    const needs = L.collectNeeds(blocks);
    const faces = new Set();
    for (const t of needs.text) fc.facesNeeded(t.text, t.family === "body" ? o.font : t.family, t.bold, t.italic, faces);
    const bytes = new Map();
    const fonts = new Map();
    for (const face of faces) {
      const woff = fontFile(fc.facePath(face));
      if (!woff) continue;
      const sfnt = await woffToSfnt(woff, async (b) => new Uint8Array(zlib.inflateSync(b)));
      bytes.set(face, sfnt);
      fonts.set(face, fontkit.create(sfnt));
    }
    const fontSet = fc.createFontSet(fonts);
    const flow = L.layoutMarkdown({ blocks, fontSet, options: o, geometry: L.pageGeometry(o) });
    const plan = B.planPages(flow, {});
    const out = await W.writeMarkdownPdf({ PDFLib, fontkit, flow, plan, fontBytes: bytes, title: "Hindi" });
    // Where the writer drew every word of page 1: its runs are whole lines, and
    // a word starts where the run's text up to it ends.
    const words = [];
    out.textRuns[0].forEach((run, line) => {
      let prefix = "";
      run.text.split(" ").forEach((word) => {
        if (word) {
          const x0 = run.x + fontSet.measure(prefix, run.face, run.size);
          words.push({ line, text: word, x0, x1: x0 + fontSet.measure(word, run.face, run.size), y: run.y, size: run.size });
        }
        prefix += `${word} `;
      });
    });
    return { bytes: out.bytes, words, lines: out.textRuns[0].map((run) => run.text) };
  } finally {
    Object.assign(globalThis, saved);
  }
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
    setTimeout(() => reject(new Error("static server did not start")), 10000);
    proc.on("error", reject);
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-selection.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/core/lib-loader.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// As tools/pdf-preview-check.mjs: signed in, with a client that refuses every
// network call, so the import keeps the file on this device.
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
    from: () => { throw new Error("pdf-text-place-check does not touch the network"); },
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

const chrome = findChrome();
if (!chrome) {
  console.error("pdf-text-place-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

const failures = [];
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const made = await writeHindiPdf();
const sources = pdfjsSources();
const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);
const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  process.exit(1);
}, WATCHDOG_MS);

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // pdf.js and its worker as the app runs them — patched (tools/pdfjs-source.mjs).
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
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const opened = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], "hindi.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    if (!entry) return { error: "no deck was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(300);
    await api.openDocumentView({ force: true });
    await api.whenDocumentPageReady(1);
    for (let i = 0; i < 60 && !document.querySelector('.pdf-page[data-page-number="1"] .pdf-text-layer span'); i += 1) await settle(50);
    return { ok: true };
  }`, Array.from(made.bytes));
  if (opened.error) throw new Error(opened.error);

  // ── 1–3. The words, read off the page's items and placed off its spans ────
  //
  // For every word the writer drew: the text the page's items now say, and the
  // left and right edge of the word's characters in the text layer, in PDF
  // points. Measured with a Range over the layer's own text nodes, which is
  // exactly what a selection and a highlight are made from.
  const layer = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const items = api.pdfPageTextItems(1) || [];
    const pageEl = api.pdfPageElement(1);
    const viewport = api.pdfPageViewport(1);
    const box = pageEl.getBoundingClientRect();
    const spans = [...pageEl.querySelectorAll(".pdf-text-layer span[data-item-index]")];
    const spanFor = (item, ch) => {
      let best = null;
      spans.forEach((span) => {
        if (Number(span.dataset.itemIndex) !== item) return;
        const start = Number(span.getAttribute("data-ch-start")) || 0;
        if (start <= ch && (!best || start >= best.start)) best = { span, start };
      });
      return best;
    };
    const words = [];
    items.forEach((item, index) => {
      if (!item.str) return;
      const re = /\\S+/g;
      let m;
      while ((m = re.exec(item.str))) {
        const a = spanFor(index, m.index);
        const b = spanFor(index, m.index + m[0].length - 1);
        if (!a || !b) continue;
        const range = document.createRange();
        range.setStart(a.span.firstChild, m.index - a.start);
        range.setEnd(b.span.firstChild, m.index + m[0].length - b.start);
        const r = range.getBoundingClientRect();
        const [x0] = viewport.convertToPdfPoint(r.left - box.left, r.top - box.top);
        const [x1] = viewport.convertToPdfPoint(r.right - box.left, r.top - box.top);
        words.push({ text: m[0], x0, x1 });
      }
    });
    return { words, spans: spans.length, items: items.filter((i) => i.str).length, charX: items.filter((i) => Array.isArray(i.charX)).length, scale: viewport.scale };
  }`);

  check("the page's items carry real character positions (charX)", layer.charX > 0 && layer.charX === layer.items,
    `${layer.charX} of ${layer.items} item(s)`);
  const gotText = layer.words.map((w) => w.text).join(" ");
  const wantText = made.words.map((w) => w.text).join(" ");
  check("the text reads back in typed order (no िक, no दशर्न)", gotText === wantText,
    gotText === wantText ? `${layer.words.length} words` : `got “${gotText.slice(0, 120)}…”`);
  const paired = layer.words.length === made.words.length;
  let worst = 0;
  let worstWord = "";
  if (paired) {
    made.words.forEach((want, i) => {
      const got = layer.words[i];
      const off = Math.max(Math.abs(got.x0 - want.x0), Math.abs(got.x1 - want.x1));
      if (off > worst) { worst = off; worstWord = `${want.text} ${got.x0.toFixed(1)}–${got.x1.toFixed(1)} vs ${want.x0.toFixed(1)}–${want.x1.toFixed(1)}`; }
    });
  }
  // A point is a pixel and a third at this scale; a fifth of an em is where a
  // reader would see a selection sit off its word.
  const limit = made.words[0].size * 0.2;
  check("every word of the text layer is where the writer drew it", paired && worst < limit,
    paired ? `worst ${worst.toFixed(2)}pt (limit ${limit.toFixed(1)}): ${worstWord}` : `${layer.words.length} vs ${made.words.length} words`);

  // ── A double-click on a painted word selects that word ───────────────────
  const target = made.words.find((w) => w.text === "संस्कार");
  // The import leaves My Files open over the page; Escape puts it away.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    // eslint-disable-next-line no-await-in-loop
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
  const point = await page.evaluate(`async (x, y) => {
    const { api } = window.__recall;
    const pageEl = api.pdfPageElement(1);
    const viewport = api.pdfPageViewport(1);
    pageEl.scrollIntoView({ block: "start" });
    await new Promise((r) => setTimeout(r, 300));
    const box = pageEl.getBoundingClientRect();
    const [px, py] = viewport.convertToViewportPoint(x, y);
    const at = { x: box.left + px, y: box.top + py };
    const hit = document.elementFromPoint(at.x, at.y);
    return { ...at, hit: hit ? hit.tagName + "." + hit.className + " " + (hit.textContent || "").slice(0, 20) : "nothing", onLayer: Boolean(hit?.closest?.(".pdf-text-layer")) };
  }`, (target.x0 + target.x1) / 2, target.y + target.size * 0.3);
  check("the painted संस्कार is under the text layer, not under a dialog", point.onLayer, point.hit);
  // A real double-click: two presses, the second carrying clickCount 2.
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  for (const clickCount of [1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount });
    // eslint-disable-next-line no-await-in-loop
    await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount });
  }
  const selected = await page.evaluate(`() => String(window.getSelection()).trim()`);
  check("a double-click on the painted संस्कार selects संस्कार", selected === "संस्कार", `selected “${selected}”`);
  await page.evaluate(`() => window.getSelection().removeAllRanges()`);

  // ── A highlight made over the old layer is moved onto its words ──────────
  //
  // Three records in the shapes the report showed, unstamped (made before
  // QUAD_GEOMETRY_VERSION 3): a box stopping short of its word, a box a word to
  // the left of the word it names, and a box over a word that stored garbled
  // drawing-order text.
  const word = (text, nth = 0) => made.words.filter((w) => w.text === text)[nth];
  const band = (w) => [w.y - w.size * 0.25, w.y + w.size * 0.95];
  const a = word("अध्यात्मवादी");
  const prior = made.words[made.words.indexOf(word("इसलिए")) - 1];
  const b = word("इसलिए");
  const c = word("विवेचन");
  const planted = [
    { id: "hn-drift01", text: "अध्यात्मवादी", rect: [a.x0, ...band(a).slice(0, 1), a.x0 + (a.x1 - a.x0) * 0.82, band(a)[1]], want: "अध्यात्मवादी", wantRect: [a.x0, a.x1] },
    { id: "hn-drift02", text: "इसिलए", rect: [prior.x0, band(b)[0], b.x0 + (b.x1 - b.x0) * 0.8, band(b)[1]], want: "इसलिए", wantRect: [b.x0, b.x1] },
    { id: "hn-drift03", text: "वेचन ि", rect: [c.x0 - 0.5, band(c)[0], c.x1 + 0.5, band(c)[1]], want: "विवेचन", wantRect: [c.x0, c.x1] }
  ];
  const repaired = await page.evaluate(`async (planted) => {
    const { api, settle } = window.__recall;
    const records = planted.map((p) => ({
      id: p.id, color: "yellow", page: 1, kind: "text", text: p.text, at: 1, qv: 2,
      anchor: { page: 1, item: 0, ch: 0 }, focus: { page: 1, item: 0, ch: 3 },
      quads: [{ page: 1, rect: p.rect }]
    }));
    api.state.meta.pdfHighlights = [...(api.state.meta.pdfHighlights || []), ...records];
    const ran = api.repairDocumentHighlightQuads(1);
    await settle(60);
    const again = api.repairDocumentHighlightQuads(1);
    return { ran, again, after: planted.map((p) => (api.state.meta.pdfHighlights || []).find((r) => r.id === p.id)) };
  }`, planted);
  planted.forEach((p, i) => {
    const after = repaired.after[i];
    const rect = after?.quads?.[0]?.rect || [];
    const off = Math.max(Math.abs(rect[0] - p.wantRect[0]), Math.abs(rect[2] - p.wantRect[1]));
    check(`an old highlight stored as “${p.text}” is moved onto ${p.want}`,
      after?.text === p.want && after.quads.length === 1 && off < limit && after.qv === 3 && after.at === 1,
      `text “${after?.text}”, x ${rect[0]?.toFixed(1)}–${rect[2]?.toFixed(1)} vs ${p.wantRect[0].toFixed(1)}–${p.wantRect[1].toFixed(1)}, qv ${after?.qv}`);
  });
  check("...once: the next paint leaves them alone", repaired.ran && repaired.again === false);

  if (SHOT) {
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.resolve(ROOT, SHOT), Buffer.from(shot.data, "base64"));
    console.log(`      screenshot → ${SHOT}`);
  }
} catch (error) {
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
  failures.push("harness");
} finally {
  clearTimeout(watchdog);
  client.close();
  launched.proc.kill("SIGKILL");
  server.proc.kill("SIGKILL");
}

console.log(`CHECK: ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
