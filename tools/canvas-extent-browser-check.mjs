// Canvas pages that grow as needed, and Boundless pages, on a real Canvas.
//
//   node tools/canvas-extent-browser-check.mjs
//   CANVAS_EXTENT_SHOTS=<dir> node tools/canvas-extent-browser-check.mjs   (and pictures)
//
// What a reader asked for: a page that is "extendable like draw.io, where the
// length and width resize on demand, and this should not disturb the page
// rendering or export", and a page with no size at all — Boundless — whose PDF
// "should work perfectly". The numbers are tools/canvas-extent-check.mjs; this
// is what only a browser can answer:
//
//   1. a Block put past the foot of a page that grows makes the page longer
//      IN PLACE — no "Opening the document…", the other pages' canvases are
//      the very same elements, the reader is not moved, and nothing on the
//      page moves on screen; an undo takes the room back;
//   2. a Boundless page grows left and up as well, and what is on it stays
//      where it was on screen;
//   3. a page that grows is fitted to the screen by its set-up width, so a
//      page growing wider does not zoom the Canvas out;
//   4. the Canvas PDF has the grown page at its full size, and the Boundless
//      page cut to what is on it, unnumbered — a large one drawn in tiles;
//   5. the web page export is one file, with its pictures in it, byte for byte.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";
import { htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 240000;
const SHOTS = process.env.CANVAS_EXTENT_SHOTS || "";

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
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/handwriting/board.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/documents/view-only.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/canvas-setup.js?v=__BUILD__",
    "/src/documents/canvas-setup-dialog.js?v=__BUILD__",
    "/src/documents/canvas-extent.js?v=__BUILD__",
    "/src/documents/page-grow-preview.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/export/run.js?v=__BUILD__",
    "/src/export/canvas-html.js?v=__BUILD__",
    "/src/documents/blank-pdf.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/cloud/s3-files.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
    "/src/core/lib-loader.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc, pdfjsSrc, workerSrc) => {
  const tag = document.createElement("script");
  tag.textContent = pdfjsSrc;
  document.head.appendChild(tag);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  window.__errs = [];
  window.__warns = [];
  const warn = console.warn.bind(console);
  console.warn = (...args) => { window.__warns.push(args.map((a) => String((a && a.stack) || a)).join(" ").slice(0, 300)); warn(...args); };
  window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @ " + String(e.filename).split("/").pop() + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push("reject: " + String((e.reason && e.reason.stack) || e.reason)));
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("canvas-extent-browser-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Growing pages fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  await settle(300);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

const HELPERS_SRC = `() => {
  const { api, settle } = window.__recall;
  const pageEl = (n = 1) => document.querySelector('#documentStage .pdf-page[data-page-number="' + n + '"]');
  const ratio = (n) => { const r = pageEl(n).getBoundingClientRect(); return Math.round((r.width / r.height) * 1000) / 1000; };
  // Until the Canvas has reopened on new bytes and page n has painted.
  const painted = async (sha) => {
    for (let i = 0; i < 100; i += 1) {
      const moved = !sha || api.state.meta.notebook.sha256 !== sha;
      if (moved && document.querySelector("#documentStage .pdf-page canvas.pdf-canvas")) break;
      await settle(80);
    }
    await settle(500);
  };
  const modal = () => document.getElementById("canvasSetupModal");
  const open = () => Boolean(modal() && !modal().hidden);
  const q = (sel) => modal().querySelector(sel);
  const click = (sel) => { const node = typeof sel === "string" ? q(sel) : sel; node.click(); };
  const pick = (value) => { const select = q("[data-cs-size]"); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
  const openFromMenu = async (page) => {
    api.scrollToDocumentPage(page, 0);
    await settle(400);
    document.getElementById("documentMoreBtn").click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="hw-page-setup"]').click();
    await settle(250);
  };
  const ownSetups = () => JSON.parse(JSON.stringify(api.state.meta.notebook.pageSetups || null));
  window.__h = { pageEl, ratio, painted, modal, open, q, click, pick, openFromMenu, ownSetups };
  return true;
}`;

const chrome = findChrome();
if (!chrome) { console.log("canvas-extent-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

// pdf-lib for the Canvas PDF case, from disk as the other checks take it; with
// no way to fetch it, that one case is skipped rather than the whole check.
let pdflib = null;
try {
  pdflib = pdflibSource();
} catch (error) {
  console.log(`canvas-extent-browser-check: no pdf-lib (${error?.message || error}) — the Canvas PDF case will be skipped.`);
}

// html-to-image draws the Blocks into the exported pages; without it they are
// left out of the file, and the cases that read their words are skipped.
let htmlToImage = null;
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`canvas-extent-browser-check: no html-to-image (${error?.message || error}) — the Block words in the PDF will not be asked about.`);
}

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

let failures = 0;
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const picture = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(picture.data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: SHOTS ? 2 : 1, mobile: false });
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); localStorage.removeItem("recall:view-only-v1"); } catch (e) {}`
  });
  if (pdflib) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));
  await page.evaluate(HELPERS_SRC);

  // ── 1. A page that grows: a Block past its foot ──────────────────────
  const grow = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { painted, pageEl } = window.__h;
    const out = {};
    // Two pages, every page growing as needed.
    let sha = api.state.meta.notebook.sha256;
    await api.addNotebookPage();
    await painted(sha);
    sha = api.state.meta.notebook.sha256;
    await api.setNotebookPageSetup({ ...api.notebookPageSetup(1), fit: "grow" }, { all: true });
    await painted(sha);
    out.fit = api.notebookPageFit(1);
    out.box0 = api.notebookPageBox(1);
    // A Block near the foot of page 1, then the reader looking at it.
    const b = api.addDocumentBlock(1, { x: 120, y: 60 }, { md: "Near the foot", edit: false, anchor: "center" });
    api.selectBlock?.(null);
    await settle(200);
    pageEl(1).scrollIntoView({ block: "end" });
    await settle(500);
    // Watch for a reopen while it grows.
    let reopened = false;
    const watch = new MutationObserver(() => { if (document.querySelector("#documentView .pdf-loading")) reopened = true; });
    watch.observe(document.getElementById("documentView"), { childList: true, subtree: true });
    const canvas2 = pageEl(2).querySelector("canvas.pdf-canvas");
    const blockAt = () => {
      const r = document.querySelector('[data-pdf-block="' + b.id + '"]').getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top)];
    };
    const view = document.getElementById("documentView");
    const scrollBefore = view.scrollTop;
    const shownBefore = blockAt();
    // Dragged down past the foot: the record moved, as a drop writes it.
    const before = api.state.meta.notebook.sha256;
    api.runDiagramEdit(() => {
      api.writeDocumentBlocks(api.documentBlocks().map((x) => (x.id === b.id ? { ...x, y: -40 } : x)));
    });
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === before; i += 1) await settle(80);
    await settle(900);
    watch.disconnect();
    out.box1 = api.notebookPageBox(1);
    out.box2 = api.notebookPageBox(2);
    out.pageBoxes = api.state.meta.notebook.pageBoxes || null;
    out.boxSha = api.state.meta.notebook.boxSha === api.state.meta.notebook.sha256;
    out.reopened = reopened;
    out.sameCanvas2 = pageEl(2).querySelector("canvas.pdf-canvas") === canvas2;
    out.scrollMoved = Math.abs(view.scrollTop - scrollBefore);
    out.ratio = (() => { const r = pageEl(1).getBoundingClientRect(); return Math.round((r.height / r.width) * 1000) / 1000; })();
    out.drawn = Boolean(pageEl(1).querySelector("canvas.pdf-canvas:not(.is-stale)"));
    out.blockShown = Boolean(document.querySelector('[data-pdf-block="' + b.id + '"]'));
    // The page the Canvas was fitted by is the set-up width, so page 2 kept
    // its width on screen.
    out.width1 = Math.round(pageEl(1).getBoundingClientRect().width);
    out.width2 = Math.round(pageEl(2).getBoundingClientRect().width);
    // An undo takes the Block back, and the room with it.
    const grown = api.state.meta.notebook.sha256;
    api.undoBlocks();
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === grown; i += 1) await settle(80);
    await settle(600);
    out.boxUndone = api.notebookPageBox(1);
    out.pageBoxesUndone = api.state.meta.notebook.pageBoxes || null;
    // A shape drawn past the right edge — a mark, not a Block — widens it.
    const plain = api.state.meta.notebook.sha256;
    const shape = api.addDocumentShape(1, { type: "rect", p: [[520, 400], [660, 470]], stroke: "#d0342c", width: 2 });
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === plain; i += 1) await settle(80);
    await settle(600);
    out.shape = Boolean(shape);
    out.boxWide = api.notebookPageBox(1);
    const wide = api.state.meta.notebook.sha256;
    api.applyDocumentRecordChanges({ remove: [shape.id] });
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === wide; i += 1) await settle(80);
    await settle(600);
    out.boxNarrow = api.notebookPageBox(1);
    window.__ids = { grow: b.id };
    return out;
  }`);
  check("a page set to grow as needed", grow.fit === "grow" && JSON.stringify(grow.box0) === "[0,0,595,842]", JSON.stringify(grow));
  check("a Block past its foot makes it longer, by just enough", grow.box1[0] === 0 && grow.box1[3] === 842 && grow.box1[2] === 595 && grow.box1[1] < -40 && grow.box1[1] >= -40 - 72 - 72, JSON.stringify(grow.box1));
  check("...the page that did not grow is untouched", JSON.stringify(grow.box2) === "[0,0,595,842]" && grow.sameCanvas2, JSON.stringify(grow));
  check("...in place: no reopen, the reader not moved", !grow.reopened && grow.scrollMoved <= 2, JSON.stringify(grow));
  check("...the record holds the box and which bytes were drawn with it", grow.pageBoxes && grow.pageBoxes["1"] && grow.boxSha, JSON.stringify(grow.pageBoxes));
  check("...redrawn at its new size, the Block on it", grow.drawn && grow.blockShown && grow.ratio > 1.42, JSON.stringify(grow));
  check("...and fitted by its set-up width: both pages as wide as before", grow.width1 === grow.width2, JSON.stringify(grow));
  check("an undo takes the room back", JSON.stringify(grow.boxUndone) === "[0,0,595,842]" && !grow.pageBoxesUndone, JSON.stringify(grow));
  check("a shape past the right edge makes it wider, and gone, narrow again", grow.shape && grow.boxWide[2] > 660 && grow.boxWide[0] === 0 && grow.boxWide[3] === 842 && JSON.stringify(grow.boxNarrow) === "[0,0,595,842]", JSON.stringify({ wide: grow.boxWide, narrow: grow.boxNarrow }));
  await shot("grown.png");

  // ── 1b. By hand: the pointer decides — this page grows, or the next takes it
  const hand = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { painted, pageEl } = window.__h;
    const out = {};
    const view = document.getElementById("documentView");
    // Every page grows unless set to its size: page 1 back to the default.
    let sha = api.state.meta.notebook.sha256;
    await api.setNotebookPageSetup({ ...api.notebookPageSetup(1), fit: undefined }, { all: true });
    await painted(sha);
    out.fit = api.notebookPageFit(1);
    const b = api.addDocumentBlock(1, { x: 200, y: 140 }, { md: "Carried by hand", edit: false });
    api.selectBlock?.(null);
    await settle(300);
    const node = () => document.querySelector('[data-pdf-block="' + b.id + '"]');
    node().scrollIntoView({ block: "center" });
    await settle(500);
    const fire = (type, x, y, buttons = 1) => {
      const target = type === "pointerdown" ? node() : (document.elementFromPoint(x, y) || view);
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: "mouse", isPrimary: true, altKey: true,
        clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pressure: buttons ? 0.5 : 0
      }));
    };
    const carry = async (dx, dy, during) => {
      const r = node().getBoundingClientRect();
      const x0 = r.left + 10;
      const y0 = r.top + 6;
      fire("pointerdown", x0, y0);
      for (let i = 1; i <= 14; i += 1) {
        fire("pointermove", x0 + (dx * i) / 14, y0 + (dy * i) / 14);
        await settle(20);
      }
      await settle(80);
      const mid = during(x0 + dx, y0 + dy);
      fire("pointerup", x0 + dx, y0 + dy, 0);
      return mid;
    };
    // (a) The pointer stays on page 1, the Block hanging past its foot.
    const p1 = pageEl(1).getBoundingClientRect();
    const box0 = api.notebookPageBox(1);
    sha = api.state.meta.notebook.sha256;
    out.mid = await carry(0, Math.round(p1.bottom - 8 - (node().getBoundingClientRect().top + 6)), (x, y) => ({
      pointerOnPage1: y < pageEl(1).getBoundingClientRect().bottom,
      outline: Boolean(pageEl(1).querySelector(".canvas-grow-preview")),
      outlineBelow: (() => { const o = pageEl(1).querySelector(".canvas-grow-preview"); return o ? Math.round(o.getBoundingClientRect().bottom - pageEl(1).getBoundingClientRect().bottom) : 0; })(),
      growing: pageEl(1).classList.contains("is-growing"),
      target2: pageEl(2).classList.contains("is-drop-target"),
      state: api.pageGrowthPreviewState()
    }));
    const t0 = performance.now();
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === sha; i += 1) await settle(40);
    out.grewMs = Math.round(performance.now() - t0);
    await settle(500);
    out.box0 = box0;
    out.box1 = api.notebookPageBox(1);
    out.onPage = api.documentBlocks().find((x) => x.id === b.id)?.page;
    out.outlineAfter = Boolean(document.querySelector(".canvas-grow-preview"));
    // (b) Carried on until the pointer is over page 2: it goes there, and
    // page 1 is not made any longer for it.
    node().scrollIntoView({ block: "center" });
    await settle(400);
    const before = api.notebookPageBox(1);
    const p2 = pageEl(2).getBoundingClientRect();
    const start = node().getBoundingClientRect();
    out.mid2 = await carry(0, Math.round(p2.top + 60 - (start.top + 6)), () => ({
      target2: pageEl(2).classList.contains("is-drop-target"),
      outline1: Boolean(pageEl(1).querySelector(".canvas-grow-preview"))
    }));
    await settle(1200);
    out.onPage2 = api.documentBlocks().find((x) => x.id === b.id)?.page;
    out.box1After = api.notebookPageBox(1);
    out.box1Before = before;
    out.targetCleared = !document.querySelector(".pdf-page.is-drop-target");
    return out;
  }`);
  check("every page grows unless set to its size", hand.fit === "grow", JSON.stringify(hand));
  check("dragged past the foot with the pointer on the page: the page shows it growing, live", hand.mid.pointerOnPage1 && hand.mid.outline && hand.mid.growing && hand.mid.outlineBelow > 20 && !hand.mid.target2, JSON.stringify(hand.mid));
  check("...let go, the page grows at once, the Block on it", hand.box1[1] < hand.box0[1] && hand.onPage === 1 && hand.grewMs < 1500 && !hand.outlineAfter, JSON.stringify(hand));
  check("carried until the pointer is over the next page: that page is outlined, this one does not grow", hand.mid2.target2 && !hand.mid2.outline1, JSON.stringify(hand.mid2));
  check("...let go, it is on the next page, and the page it left is not made longer for it", hand.onPage2 === 2 && hand.box1After[1] >= hand.box1Before[1] && hand.targetCleared, JSON.stringify(hand));
  await shot("by-hand.png");
  if (SHOTS) {
    // A picture of the page mid-drag, growing.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const { pageEl } = window.__h;
      const b = api.addDocumentBlock(2, { x: 200, y: 160 }, { md: "Dragged past the foot", edit: false });
      api.selectBlock?.(null);
      await settle(300);
      const node = document.querySelector('[data-pdf-block="' + b.id + '"]');
      pageEl(2).scrollIntoView({ block: "end" });
      await settle(400);
      const r = node.getBoundingClientRect();
      const x0 = r.left + 10;
      const y0 = r.top + 6;
      const fire = (type, x, y, target) => (target || document.elementFromPoint(x, y) || document.body).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 12, pointerType: "mouse", isPrimary: true, altKey: true,
        clientX: x, clientY: y, buttons: 1, button: type === "pointermove" ? -1 : 0, pressure: 0.5
      }));
      fire("pointerdown", x0, y0, node);
      const dy = Math.round(pageEl(2).getBoundingClientRect().bottom - 10 - y0);
      for (let i = 1; i <= 14; i += 1) { fire("pointermove", x0 + i * 3, y0 + (dy * i) / 14); await settle(20); }
      await settle(200);
      window.__dragEnd = () => fire("pointerup", x0 + 42, y0 + dy);
    }`);
    await shot("mid-drag.png");
    await page.evaluate(`async () => { window.__dragEnd(); await window.__recall.settle(1200); }`);
    await shot("after-drop.png");
  }

  // ── 2. Boundless: left and up, nothing on screen moves ───────────────
  const free = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { painted, pageEl } = window.__h;
    const out = {};
    let sha = api.state.meta.notebook.sha256;
    await api.setNotebookPageSetup({ ...api.notebookPageSetup(2), fit: "boundless" }, { page: 2 });
    await painted(sha);
    out.fit = api.notebookPageFit(2);
    out.hasClass = pageEl(2).classList.contains("is-boundless");
    out.box0 = api.notebookPageBox(2);
    const anchor = api.addDocumentBlock(2, { x: 300, y: 500 }, { md: "Stays put", edit: false });
    const mover = api.addDocumentBlock(2, { x: 200, y: 400 }, { md: "Goes left and up", edit: false });
    api.selectBlock?.(null);
    await settle(300);
    pageEl(2).scrollIntoView({ block: "center" });
    await settle(500);
    const at = (id) => { const r = document.querySelector('[data-pdf-block="' + id + '"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; };
    const shown = at(anchor.id);
    sha = api.state.meta.notebook.sha256;
    api.runDiagramEdit(() => {
      api.writeDocumentBlocks(api.documentBlocks().map((x) => (x.id === mover.id ? { ...x, x: -200, y: 900 } : x)));
    });
    for (let i = 0; i < 60 && api.state.meta.notebook.sha256 === sha; i += 1) await settle(80);
    await settle(900);
    out.box1 = api.notebookPageBox(2);
    // A page narrower than the view sat centred in it; grown wider, it starts
    // at the scroller's edge, and the most the view can scroll is its right
    // edge — the one place a hold can come up short, by that centring.
    const view = document.getElementById("documentView");
    out.atRightEnd = view.scrollLeft >= view.scrollWidth - view.clientWidth - 1;
    out.moved = at(anchor.id).map((v, i) => v - shown[i]);
    out.drawn = Boolean(pageEl(2).querySelector("canvas.pdf-canvas:not(.is-stale)"));
    out.number = getComputedStyle(pageEl(2), "::after").content;
    window.__ids.anchor = anchor.id;
    window.__ids.mover = mover.id;
    return out;
  }`);
  check("a page set Boundless", free.fit === "boundless" && free.hasClass, JSON.stringify(free));
  check("...grows left and up as well as right and down", free.box1[0] < -200 && free.box1[3] > 900, JSON.stringify(free.box1));
  check("...and what was on it stays where it was on screen", (Math.abs(free.moved[0]) <= 2 || (free.atRightEnd && Math.abs(free.moved[0]) <= 40)) && Math.abs(free.moved[1]) <= 2, JSON.stringify(free));
  check("...with no page number", free.number === "none", free.number);
  await shot("boundless.png");

  // ── 3. The Canvas PDF: the grown page whole, the Boundless one cut ─────
  if (pdflib) {
    if (SHOTS) await page.evaluate("() => { window.__shotPdf = true; }");
    const pdf = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const out = {};
      // Page 1 grown well past its foot; the Boundless page's Block taken far
      // out, so its page is bigger than one picture.
      let sha = api.state.meta.notebook.sha256;
      api.runDiagramEdit(() => {
        api.writeDocumentBlocks(api.documentBlocks().map((x) => {
          if (x.id === window.__ids.grow) return { ...x, y: -400 };
          if (x.id === window.__ids.mover) return { ...x, x: -2600, y: 2900 };
          return x;
        }));
      });
      for (let i = 0; i < 80 && api.state.meta.notebook.sha256 === sha; i += 1) await settle(80);
      await settle(1200);
      out.box1 = api.notebookPageBox(1);
      out.box2 = api.notebookPageBox(2);
      const built = await api.buildCanvasPdfBytes();
      const doc = await window.PDFLib.PDFDocument.load(built.bytes);
      out.boxes = doc.getPages().map((p) => { const b = p.getMediaBox(); return [b.x, b.y, b.x + b.width, b.y + b.height].map((v) => Math.round(v)); });
      out.pictures = doc.getPages().map((p) => {
        const xo = p.node.Resources()?.lookup(window.PDFLib.PDFName.of("XObject"));
        return xo ? xo.keys().length : 0;
      });
      const read = await window.pdfjsLib.getDocument({ data: built.bytes.slice() }).promise;
      out.texts = [];
      for (let n = 1; n <= read.numPages; n += 1) {
        const content = await (await read.getPage(n)).getTextContent();
        out.texts.push(content.items.map((item) => item.str).join(" ").replace(/\\s+/g, " ").trim());
      }
      if (window.__shotPdf) {
        const p2 = await read.getPage(2);
        const vp = p2.getViewport({ scale: 0.6 });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await p2.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        out.png2 = c.toDataURL("image/png");
      }
      const blocks = api.documentBlocks().filter((x) => x.page === 2);
      const xs = blocks.flatMap((x) => [x.x, x.x + x.w]);
      const ys = blocks.flatMap((x) => [x.y, x.y + x.h]);
      out.content2 = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
      return out;
    }`);
    if (SHOTS && pdf.png2) {
      writeFileSync(path.join(SHOTS, "boundless-pdf-page.png"), Buffer.from(pdf.png2.split(",")[1], "base64"));
      delete pdf.png2;
    }
    check("the grown page is one PDF page at its full size", JSON.stringify(pdf.boxes[0]) === JSON.stringify(pdf.box1.map(Math.round)) && pdf.box1[1] < -400, JSON.stringify(pdf));
    const cut = pdf.boxes[1];
    const near = (a, b) => Math.abs(a - b) <= 26;
    check("the Boundless page is cut to what is on it", near(cut[0], pdf.content2[0] - 24) && near(cut[1], pdf.content2[1] - 24) && near(cut[2], pdf.content2[2] + 24) && near(cut[3], pdf.content2[3] + 24) && cut[2] - cut[0] < pdf.box2[2] - pdf.box2[0], JSON.stringify(pdf));
    check("...drawn in tiles, being bigger than one picture", pdf.pictures[1] > 1 && pdf.pictures[0] >= 1, JSON.stringify(pdf.pictures));
    check("...and unnumbered, while the grown page has its number", /1 \/ 2/.test(pdf.texts[0]) && !/2 \/ 2/.test(pdf.texts[1]), JSON.stringify(pdf.texts));
    if (htmlToImage) check("...with the Blocks' words on both, where they are", /Near the foot/.test(pdf.texts[0]) && /Goes left and up/.test(pdf.texts[1]) && /Stays put/.test(pdf.texts[1]), JSON.stringify(pdf.texts));
  }

  // ── 4. The web page: one file, its moving picture in it as itself ─────
  const web = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const out = {};
    // A two-frame GIF, as a Picture on page 1 — read by its address, as a
    // picture in the reader's storage is.
    const gif = "R0lGODlhCAAIAIEAANwoKAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBFAABACwAAAAACAAIAIEoWtwAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7";
    const bytes = Uint8Array.from(atob(gif), (c) => c.charCodeAt(0));
    const src = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    const id = api.freshDocumentBlockId();
    api.runDiagramEdit(() => {
      api.writeDocumentBlocks([...api.documentBlocks(), { id, page: 1, x: 300, y: 600, w: 80, h: 80, z: 9, kind: "image", src }]);
    });
    await settle(900);
    const built = await api.buildCanvasHtml();
    out.name = built.name;
    out.pages = built.pages;
    out.pictures = built.pictures;
    out.size = built.html.length;
    const match = /<img src="data:image\\/gif;base64,([^"]+)"/.exec(built.html);
    out.gifSame = Boolean(match) && match[1] === gif;
    out.noBlob = !/src="blob:/.test(built.html);
    out.words = ["Near the foot", "Stays put", "Goes left and up"].filter((w) => built.html.includes(w));
    out.boundlessNumbered = /2 \\/ 2/.test(built.html);
    out.numbered = /1 \\/ 2/.test(built.html);
    out.script = /<script>/.test(built.html);
    // Opened on its own, as a downloaded file is: it lays out, and its pages
    // are the Canvas's.
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:0;top:0;width:900px;height:700px;border:0;z-index:99999;background:#fff";
    document.body.appendChild(frame);
    frame.srcdoc = built.html;
    await new Promise((resolve) => { frame.onload = resolve; setTimeout(resolve, 4000); });
    await settle(400);
    const doc = frame.contentDocument;
    const pages = [...doc.querySelectorAll(".cx-page")];
    out.shown = pages.map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    const img = doc.querySelector('.cx-box.is-picture img');
    out.imgLoaded = Boolean(img && img.complete && img.naturalWidth === 8);
    const words = [...doc.querySelectorAll(".cx-box .rendered")].map((n) => n.textContent.trim());
    out.wordsShown = words;
    const block = [...doc.querySelectorAll(".cx-box")].find((n) => /Near the foot/.test(n.textContent));
    out.fontPx = block ? parseFloat(getComputedStyle(block).fontSize) : 0;
    out.pageWidth = pages[0] ? pages[0].getBoundingClientRect().width : 0;
    window.__frame = frame;
    return out;
  }`);
  check("the web page is one .html file named for the Canvas", /canvas\.html$/.test(web.name) && web.pages === 2 && web.script, JSON.stringify(web));
  check("...with the GIF in it as its own bytes, and no address that leaves the file", web.gifSame && web.noBlob && web.pictures >= 1, JSON.stringify(web));
  check("...every Block's words, and the grown page numbered while the Boundless one is not", web.words.length === 3 && web.numbered && !web.boundlessNumbered, JSON.stringify(web));
  check("...and opened on its own it lays out: the pages, the picture loaded", web.shown.length === 2 && web.shown.every(([w, h]) => w > 100 && h > 100) && web.imgLoaded, JSON.stringify(web));
  check("...the words sized in the page's own points", web.fontPx > 0 && Math.abs(web.fontPx - (web.pageWidth / 595) * 11) < 2.5, JSON.stringify(web));
  await shot("web-page.png");
  await page.evaluate("() => { window.__frame?.remove(); }");

  const errs = await page.evaluate("() => window.__errs");
  check("no page errors", !errs.length, errs.join(" | "));
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\ncanvas-extent-browser-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
