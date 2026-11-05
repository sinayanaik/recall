// Margins on a PDF, in the app: ⋯ → Page margins…
//
//   node tools/pdf-margins-browser-check.mjs [--shot=dir]
//
// The bytes are checked on their own by tools/pdf-margins-check.mjs. This is
// the rest, through a real browser and the generated fixture paper (setup as
// tools/annotations-check.mjs): a highlight and a typed box written before the
// margins are where they were after; the page on screen is wider; a typed box
// can be put in the margin and stays there; the file saved with annotations
// has the wider pages and the typed box as a Stamp; "None" puts the page back;
// and the original file, re-attached, gets its margins put back on it.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { PDFLIB_VERSION, pdflibSource } from "./pdflib-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";
import { HTMLTOIMAGE_VERSION, htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    "/src/documents/pdf-margins.js?v=__BUILD__",
    "/src/documents/pdf-margins-core.js?v=__BUILD__",
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
    from: () => { throw new Error("pdf-margins-browser-check does not touch the network"); },
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


const SHOT = (process.argv.slice(2).find((a) => a.startsWith("--shot=")) || "").slice(7);
const WATCHDOG_MS = 4 * 60 * 1000;

const chrome = findChrome();
if (!chrome) {
  console.error("pdf-margins-browser-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}
let sources;
let pdflib;
let htmlToImage = null;
try {
  sources = pdfjsSources();
  pdflib = pdflibSource();
} catch (error) {
  console.log(`pdf-margins-browser-check: could not obtain pdf.js ${PDFJS_VERSION} / pdf-lib ${PDFLIB_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`pdf-margins-browser-check: no html-to-image ${HTMLTOIMAGE_VERSION} — the typed-box export case will be skipped.`);
}

const fixture = buildFixturePdf({ pages: 3 });
const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);
const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
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

async function shot(name) {
  if (!SHOT) return;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(SHOT, { recursive: true });
  await page.evaluate(`() => document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove())`);
  const data = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOT, name), Buffer.from(data.data, "base64"));
  console.log(`  shot  ${path.join(SHOT, name)}`);
}

const MM = 72 / 25.4;

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
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const before = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    window.__original = new Uint8Array(bytes);
    const file = new File([window.__original], "fixture.pdf", { type: "application/pdf" });
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
    // A typed box on page 1, written before any margin.
    // A new box opens for editing; it is closed first, so the words set on its
    // record below are not overwritten by the empty editor.
    const block = api.addDocumentBlock(1, { x: 300, y: 400 });
    api.commitBlockEdit?.();
    api.selectBlock?.(null);
    const record = api.state.meta.pdfBlocks.find((b) => b.id === block.id);
    record.md = "Written **before** the margins";
    document.querySelector('[data-pdf-block="' + block.id + '"]')?.remove();
    api.repaintDocumentBlocks();
    await settle(300);
    const vp = api.pdfPageViewport(1);
    return {
      sha: api.state.meta.pdf.sha256,
      viewBox: Array.from(vp.viewBox),
      // Its top-left corner: a box fits its height to its words, keeping its top.
      block: { id: record.id, x: record.x, top: record.y + record.h },
      highlights: (api.state.meta.pdfHighlights || []).map((h) => ({ id: h.id, rect: h.quads?.[0]?.rect }))
    };
  }`, Array.from(fixture.bytes));
  if (before.error) throw new Error(before.error);
  check("the fixture opens on its PDF tab, with a typed box on page 1", Boolean(before.block?.id), JSON.stringify(before.viewBox));

  // ⋯ → Page margins… opens the dialog, on "Wide right".
  const dialog = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    const row = document.querySelector('#documentMoreMenu [data-document-action="margins"]');
    if (!row) return { error: "no Page margins row in the ⋯ menu" };
    const visible = row.getClientRects().length > 0;
    row.click();
    await settle(200);
    const modal = document.getElementById("pdfMarginsModal");
    return {
      visible,
      open: modal && !modal.hidden,
      preset: modal?.querySelector('[data-margin-preset][aria-pressed="true"]')?.dataset.marginPreset,
      right: modal?.querySelector('[data-margin-side="right"]')?.value
    };
  }`);
  check("the ⋯ menu has a Page margins… row on a PDF, and it opens the dialog", dialog.visible && dialog.open, JSON.stringify(dialog));
  check("...which opens on Wide right, 60mm", dialog.preset === "right" && dialog.right === "60", JSON.stringify(dialog));
  await shot("dialog.png");

  // Ruled paper, Apply.
  const after = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const modal = document.getElementById("pdfMarginsModal");
    modal.querySelector('[data-margin-paper="ruled"]').click();
    modal.querySelector('[data-margin-action="apply"]').click();
    for (let i = 0; i < 100 && api.state.meta.pdf?.margins == null; i += 1) await settle(100);
    await settle(800);
    await api.whenDocumentPageReady?.(1);
    await settle(300);
    const vp = api.pdfPageViewport(1);
    const record = api.state.meta.pdfBlocks.find((b) => b.page === 1);
    return {
      closed: modal.hidden,
      margins: api.state.meta.pdf.margins,
      sha: api.state.meta.pdf.sha256,
      baseSha: api.state.meta.pdf.baseSha256,
      viewBox: vp ? Array.from(vp.viewBox) : null,
      block: record ? { id: record.id, x: record.x, top: record.y + record.h } : null,
      highlights: (api.state.meta.pdfHighlights || []).map((h) => ({ id: h.id, rect: h.quads?.[0]?.rect }))
    };
  }`);
  check("Apply closes the dialog and records the margins on the PDF", after.closed && Math.abs((after.margins?.right || 0) - 60 * MM) < 0.1 && after.margins?.paper === "ruled", JSON.stringify(after.margins));
  check("the PDF's bytes changed, and the original's hash is kept", after.sha !== before.sha && after.baseSha === before.sha);
  check("the page on screen is 60mm wider, on the right, with its origin where it was",
    after.viewBox && after.viewBox[0] === before.viewBox[0] && after.viewBox[1] === before.viewBox[1]
      && Math.abs(after.viewBox[2] - (before.viewBox[2] + 60 * MM)) < 0.1 && after.viewBox[3] === before.viewBox[3],
    `${JSON.stringify(before.viewBox)} → ${JSON.stringify(after.viewBox)}`);
  check("the typed box and the highlights written before are exactly where they were",
    JSON.stringify(after.block) === JSON.stringify(before.block) && JSON.stringify(after.highlights) === JSON.stringify(before.highlights),
    `${JSON.stringify(before.block)} → ${JSON.stringify(after.block)} · ${before.highlights.length} highlight(s)`);
  await shot("margins-right-ruled.png");

  // A typed box put in the margin stays in the margin.
  const inMargin = await page.evaluate(`async (edge) => {
    const { api, settle } = window.__recall;
    // Dropped at a point in the margin. The default box is wider than a 60mm
    // margin, so it is kept on the page by its right edge — in the margin, not
    // pushed back over the text by a clamp that thought the page ended at x1.
    const block = api.addDocumentBlock(1, { x: edge + 60, y: 500 });
    api.commitBlockEdit?.();
    api.selectBlock?.(null);
    const record = api.state.meta.pdfBlocks.find((b) => b.id === block.id);
    const placed = { x: record.x, w: record.w, right: api.pdfPageViewport(1).viewBox[2] };
    Object.assign(record, { md: "A note in the margin", x: Math.round(edge + 10), w: 150 });
    document.querySelector('[data-pdf-block="' + block.id + '"]')?.remove();
    api.repaintDocumentBlocks();
    await settle(300);
    return placed;
  }`, before.viewBox[2]);
  check("a typed box dropped in the margin is kept on the wider page, reaching into the margin",
    inMargin.x + inMargin.w <= inMargin.right - 11 && inMargin.x + inMargin.w > before.viewBox[2], JSON.stringify(inMargin));

  // The file saved with annotations: the wider pages, and the typed boxes as Stamps.
  const exported = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const result = await api.annotatedPdfBytes();
    const doc = await window.pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    const p = await doc.getPage(1);
    const annots = await p.getAnnotations();
    const stamps = annots.filter((a) => a.subtype === "Stamp").map((a) => ({ rect: a.rect, contents: a.contentsObj?.str || a.contents || "" }));
    return { view: p.view, count: result.count, missed: result.missed || 0, stamps };
  }`);
  check("the file saved with annotations has the wider page", Math.abs(exported.view[2] - (before.viewBox[2] + 60 * MM)) < 0.1, JSON.stringify(exported.view));
  if (htmlToImage) {
    const margin = exported.stamps.find((s) => /in the margin/.test(s.contents));
    check("...and each typed box as a Stamp with its words, the margin one in the margin",
      exported.stamps.length === 2 && margin && margin.rect[0] >= before.viewBox[2] - 1 && exported.missed === 0,
      JSON.stringify(exported.stamps));
  }
  if (SHOT) {
    const url = await page.evaluate(`async () => {
      const { api } = window.__recall;
      const result = await api.annotatedPdfBytes();
      const doc = await window.pdfjsLib.getDocument({ data: result.bytes }).promise;
      const p = await doc.getPage(1);
      const viewport = p.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await p.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: window.pdfjsLib.AnnotationMode.ENABLE }).promise;
      return canvas.toDataURL("image/png");
    }`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(SHOT, "exported-p1.png"), Buffer.from(url.split(",")[1], "base64"));
    console.log(`  shot  ${path.join(SHOT, "exported-p1.png")}`);
  }

  // Changing to "All round" grid starts from the page as it came.
  const all = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const sha = api.state.meta.pdf.sha256;
    // The box in the 60mm margin runs past the edge of a page with 25mm, so
    // the change asks first. Cancelled, nothing changes; confirmed, it goes ahead.
    const ask = async () => {
      const done = api.setCurrentPdfMargins({ top: 25 * ${MM}, right: 25 * ${MM}, bottom: 25 * ${MM}, left: 25 * ${MM}, paper: "grid" });
      const modal = document.getElementById("confirmModal");
      for (let i = 0; i < 100 && modal.hidden; i += 1) await settle(50);
      return { done, asked: !modal.hidden ? document.getElementById("confirmModalMessage").textContent : "" };
    };
    const first = await ask();
    document.getElementById("confirmModalCancelBtn").click();
    const cancelled = (await first.done) === false && api.state.meta.pdf.sha256 === sha;
    const second = await ask();
    document.getElementById("confirmModalOkBtn").click();
    await second.done;
    await settle(500);
    await api.whenDocumentPageReady?.(1);
    return { asked: first.asked, cancelled, changed: api.state.meta.pdf.sha256 !== sha, viewBox: Array.from(api.pdfPageViewport(1).viewBox) };
  }`);
  check("narrower margins that would leave a text box off the page ask first, and Cancel changes nothing",
    /^1 mark or text box would go past the edge of the page/.test(all.asked) && all.cancelled, JSON.stringify({ asked: all.asked, cancelled: all.cancelled }));
  const want = [before.viewBox[0] - 25 * MM, before.viewBox[1] - 25 * MM, before.viewBox[2] + 25 * MM, before.viewBox[3] + 25 * MM];
  check("changing to All round puts 25mm on every side of the page as it came (not on top of the 60mm)",
    all.changed && all.viewBox.every((v, i) => Math.abs(v - want[i]) < 0.1), JSON.stringify(all.viewBox));
  await shot("margins-all-grid.png");

  // The original file, re-attached, is accepted and gets the margins back.
  const reattached = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const file = new File([window.__original], "fixture.pdf", { type: "application/pdf" });
    const ok = await api.reattachDocument(file, api.deckPdfById(api.state.meta, "primary"), "primary");
    await settle(400);
    return { ok, viewBox: Array.from(api.pdfPageViewport(1).viewBox), margins: api.state.meta.pdf.margins };
  }`);
  check("re-attaching the original file is accepted, and its margins are put back on it",
    reattached.ok && reattached.viewBox.every((v, i) => Math.abs(v - want[i]) < 0.1), JSON.stringify(reattached));

  // None puts the page back as it came.
  const none = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const done = api.setCurrentPdfMargins({ top: 0, right: 0, bottom: 0, left: 0 });
    // The box in the margin is off the page as it came: confirmed.
    const modal = document.getElementById("confirmModal");
    for (let i = 0; i < 100 && modal.hidden; i += 1) await settle(50);
    document.getElementById("confirmModalOkBtn").click();
    await done;
    await settle(500);
    await api.whenDocumentPageReady?.(1);
    return { viewBox: Array.from(api.pdfPageViewport(1).viewBox), margins: api.state.meta.pdf.margins ?? null };
  }`);
  check("None puts the page back exactly as it came", JSON.stringify(none.viewBox) === JSON.stringify(before.viewBox) && none.margins === null, JSON.stringify(none));
} catch (error) {
  check("the check itself", false, error?.stack || String(error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
}

console.log(`\npdf-margins-browser-check: ${failures.length ? `${failures.length} failed` : "all held"}`);
console.log(`CHECK: ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
