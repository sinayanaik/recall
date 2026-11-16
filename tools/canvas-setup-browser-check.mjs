// Page setup on a real Canvas, through the real dialog.
//
//   node tools/canvas-setup-browser-check.mjs
//   CANVAS_SETUP_SHOTS=<dir> node tools/canvas-setup-browser-check.mjs   (and pictures)
//
// What a reader asked for: "There's not at all parameters defined to how to
// set up the Canvas page — the page size, the line, grid, opacity, width,
// everything." ⋯ → Canvas pages → Page setup… (src/documents/canvas-setup-dialog.js)
// sets a page's size, orientation, paper and lines, this page or every page.
// The pure half — the numbers, the bytes, the lattice the lines sit on — is
// tools/canvas-setup-check.mjs. This is the half only a browser can answer:
//
//   1. the dialog opens from ⋯ on the page in view and draws a picture of it;
//   2. one page set to A5 landscape dot grid is laid out at that size, the page
//      beside it is not, and nothing written on either moves;
//   3. a page added after it, duplicated, moved or torn out takes its setup
//      with it; every page set up at once clears the pages' own;
//      ＋ Page pressed twice in a row adds ONE page and moves everything once
//      (a second change is refused while the first runs); the new pages are
//      on screen before the upload, and an upload a later change overtook
//      never names the record (its object is deleted instead);
//   4. a smaller page asks before it hides what is written past its edge;
//   5. the squares a dragged box snaps to follow the page; the "k / n" is the
//      export's 9pt at every size; the Canvas PDF keeps each page's size;
//   6. set back to plain grid, the Canvas is byte-for-byte the file it was;
//   7. a Canvas started from "Page setup…" starts on that setup, and View only
//      hides the row.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 240000;
const SHOTS = process.env.CANVAS_SETUP_SHOTS || "";

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
  window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @ " + String(e.filename).split("/").pop() + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push("reject: " + String((e.reason && e.reason.stack) || e.reason)));
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("canvas-setup-browser-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Page setup fixture", notesMode: true });
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
if (!chrome) { console.log("canvas-setup-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

// pdf-lib for the Canvas PDF case, from disk as the other checks take it; with
// no way to fetch it, that one case is skipped rather than the whole check.
let pdflib = null;
try {
  pdflib = pdflibSource();
} catch (error) {
  console.log(`canvas-setup-browser-check: no pdf-lib (${error?.message || error}) — the Canvas PDF case will be skipped.`);
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
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));
  await page.evaluate(HELPERS_SRC);

  // ── 1. The dialog, from ⋯, on the page in view ─────────────────────────
  const first = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { painted, openFromMenu, open, q, pageEl } = window.__h;
    const sha = api.state.meta.notebook.sha256;
    await api.setNotebookPaper("grid");
    await painted(sha === api.state.meta.notebook.sha256 ? null : sha);
    const before = api.state.meta.notebook.sha256;
    await api.addNotebookPage();
    await painted(before);
    // Something written on each page, where it can be found again.
    const b1 = api.addDocumentBlock(1, { x: 120, y: 700 }, { md: "On page one", edit: false });
    const b2 = api.addDocumentBlock(2, { x: 60, y: 780 }, { md: "On page two", edit: false });
    await settle(300);
    api.selectBlock?.(null);
    const offset = (id, n) => {
      const node = document.querySelector('[data-pdf-block="' + id + '"]').getBoundingClientRect();
      const box = pageEl(n).getBoundingClientRect();
      return [Math.round(((node.left - box.left) / box.width) * 1000), Math.round(((node.top - box.top) / box.width) * 1000)];
    };
    const where = (id) => { const b = api.documentBlocks().find((x) => x.id === id); return [b.x, b.y]; };
    const out = { pages: api.notebookPageCount(), b1: b1.id, b2: b2.id, at1: offset(b1.id, 1), pos1: where(b1.id), pos2: where(b2.id) };
    await openFromMenu(2);
    out.open = open();
    out.title = q("#canvasSetupTitle").textContent;
    out.scopePage = q('[data-cs-scope="page"]').textContent;
    out.scopeAll = q('[data-cs-scope="all"]').getAttribute("aria-checked");
    out.preview = Boolean(q("[data-cs-preview] svg path"));
    out.closeUp = Boolean(q("[data-cs-zoom] svg"));
    out.hint = document.querySelector('#documentMoreMenu [data-hw-setup-hint]').textContent;
    return out;
  }`);
  check("the Canvas has two pages with a Block on each", first.pages === 2 && first.b1 && first.b2, JSON.stringify(first));
  check("⋯ → Page setup… opens the dialog on the page in view", first.open && first.scopePage === "Page 2", JSON.stringify(first));
  check("...on every page, since page 2 follows the Canvas", first.scopeAll === "true", first.scopeAll);
  check("...with a picture of the page and a close-up of its corner", first.preview && first.closeUp, JSON.stringify(first));
  check("the menu row says what the page is", /A4 portrait · Grid/.test(first.hint), first.hint);
  await shot("dialog-desktop.png");

  // ── 2. Page 2: A5 landscape dot grid ──────────────────────────────────
  const dots = await page.evaluate(`async (ids) => {
    const { api, settle } = window.__recall;
    const { q, click, pick, painted, ratio, ownSetups, pageEl, open } = window.__h;
    click('[data-cs-scope="page"]');
    pick("a5");
    click('[data-cs-orient="landscape"]');
    click('[data-cs-pattern="dots"]');
    const out = {};
    out.note = q("[data-cs-size-note]").textContent;
    out.linesHidden = q('[data-cs-range="width"]').closest("[data-cs-for]").hidden;
    out.dotShown = !q('[data-cs-range="dot"]').closest("[data-cs-for]").hidden;
    out.remember = q('[data-cs-toggle="remember"]').hidden;
    const sha = api.state.meta.notebook.sha256;
    click('[data-cs-action="apply"]');
    await painted(sha);
    out.closed = !open();
    out.own = ownSetups();
    out.ratio1 = ratio(1);
    out.ratio2 = ratio(2);
    out.width1 = Math.round(pageEl(1).getBoundingClientRect().width);
    out.width2 = Math.round(pageEl(2).getBoundingClientRect().width);
    out.box2 = api.pdfPageViewport(2)?.viewBox;
    out.box1 = api.pdfPageViewport(1)?.viewBox;
    const stored = (id) => { const b = api.documentBlocks().find((x) => x.id === id); return [b.x, b.y]; };
    out.b1 = stored(ids[0]);
    out.b2 = stored(ids[1]);
    const node = document.querySelector('[data-pdf-block="' + ids[0] + '"]').getBoundingClientRect();
    const box = pageEl(1).getBoundingClientRect();
    out.at1 = [Math.round(((node.left - box.left) / box.width) * 1000), Math.round(((node.top - box.top) / box.width) * 1000)];
    out.snap1 = api.canvasSnapGrid(1);
    out.snap2 = api.canvasSnapGrid(2);
    const after = getComputedStyle(pageEl(2), "::after");
    out.numberPx = parseFloat(after.fontSize);
    out.scale = api.pdfPageViewport(2)?.scale;
    return out;
  }`, [first.b1, first.b2]);
  check("A5 landscape reads as such while it is chosen", /148 × 210|210 × 148/.test(dots.note) && /Landscape/.test(dots.note), dots.note);
  check("dot grid shows the dot size and not the line thickness", dots.linesHidden && dots.dotShown, JSON.stringify(dots));
  check("Apply closes the dialog and gives page 2 a setup of its own", dots.closed && dots.own?.["2"]?.pattern === "dots" && dots.own["2"].w === 595 && dots.own["2"].h === 420, JSON.stringify(dots.own));
  check("page 2 is laid out landscape (595 × 420), page 1 still A4 portrait",
    Math.abs(dots.ratio2 - 595 / 420) < 0.02 && Math.abs(dots.ratio1 - 595 / 842) < 0.02, `${dots.ratio1} / ${dots.ratio2}`);
  check("page 2's box keeps its top-left at (0, 842)", JSON.stringify(dots.box2) === JSON.stringify([0, 422, 595, 842]), JSON.stringify(dots.box2));
  check("nothing written moved: both Blocks are where they were stored",
    JSON.stringify(dots.b1) === JSON.stringify(first.pos1) && JSON.stringify(dots.b2) === JSON.stringify(first.pos2), JSON.stringify([first.pos1, first.pos2, dots.b1, dots.b2]));
  check("...and page 1's Block is in the same place on its page", Math.abs(dots.at1[0] - first.at1[0]) <= 2 && Math.abs(dots.at1[1] - first.at1[1]) <= 2, JSON.stringify([first.at1, dots.at1]));
  check("a box snaps to each page's own squares", dots.snap1?.pitch === 16 && Math.abs((dots.snap2?.pitch || 0) - 14.17) < 0.01, JSON.stringify([dots.snap1, dots.snap2]));
  check("the 'k / n' is 9pt of the page at its scale", Math.abs(dots.numberPx - 9 * dots.scale) < 0.6, `${dots.numberPx}px at ${dots.scale}`);
  await page.evaluate(`async () => { window.__recall.api.scrollToDocumentPage(1, 0); await window.__recall.settle(300); window.__h.pageEl(2).scrollIntoView({ block: "center" }); await window.__recall.settle(600); }`);
  await shot("mixed-pages.png");

  // ── 3. The setup goes where the page goes ─────────────────────────────
  const moves = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const { painted, ownSetups } = window.__h;
    const out = {};
    let sha = api.state.meta.notebook.sha256;
    await api.addNotebookPage({ after: 2 });
    await painted(sha);
    out.afterAdd = Object.keys(ownSetups() || {}).sort();
    sha = api.state.meta.notebook.sha256;
    await api.duplicateNotebookPage(1);
    await painted(sha);
    out.afterDuplicate = Object.keys(ownSetups() || {}).sort();
    sha = api.state.meta.notebook.sha256;
    await api.moveNotebookPage(3, -1);
    await painted(sha);
    out.afterMove = Object.keys(ownSetups() || {}).sort();
    out.moveRewrote = api.state.meta.notebook.sha256 !== sha;
    sha = api.state.meta.notebook.sha256;
    await api.deleteNotebookPage(2);
    await painted(sha);
    out.afterTearOut = Object.keys(ownSetups() || {}).sort();
    out.pages = api.notebookPageCount();
    out.boxes = api.notebookPageBoxes();
    return out;
  }`);
  check("a page added after a dot-grid page is dot grid too", JSON.stringify(moves.afterAdd) === JSON.stringify(["2", "3"]), JSON.stringify(moves.afterAdd));
  check("a page duplicated before them moves their setups down", JSON.stringify(moves.afterDuplicate) === JSON.stringify(["3", "4"]), JSON.stringify(moves.afterDuplicate));
  check("moving a dot-grid page up swaps its setup and redraws the file", JSON.stringify(moves.afterMove) === JSON.stringify(["2", "4"]) && moves.moveRewrote, JSON.stringify(moves));
  check("a page torn out takes its setup with it", JSON.stringify(moves.afterTearOut) === JSON.stringify(["3"]) && moves.pages === 3, JSON.stringify(moves));

  // ── 3b. ＋ Page pressed twice in a row ───────────────────────────────
  //
  // Reported as "adding a page distorts the whole Canvas": a second page
  // change started while the first was still writing read a half-renumbered
  // record and renumbered every Block, mark and page setup again — Blocks two
  // pages down, a landscape page's setup copied onto the portrait page under a
  // Block, all of it saved. The second is refused now (runCanvasPageChange).
  const twice = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { painted, ownSetups, pageEl } = window.__h;
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(400);
    const pages0 = api.notebookPageCount();
    const own0 = Object.keys(ownSetups() || {}).map(Number);
    const blocks0 = api.documentBlocks().map((b) => [b.id, b.page]);
    const sha = api.state.meta.notebook.sha256;
    const pill = pageEl(1).querySelector(".canvas-page-insert");
    const out = { blocks: blocks0.length };
    pill.click();
    out.busy = api.notebookPagesBusy() && document.body.classList.contains("canvas-pages-busy");
    out.pillInert = getComputedStyle(pill).pointerEvents === "none";
    // The second press, as the pill's own handler would make it.
    out.second = await api.addNotebookPage({ after: 1 });
    await painted(sha);
    for (let i = 0; i < 100 && api.notebookPagesBusy(); i += 1) await settle(50);
    out.added = api.notebookPageCount() - pages0;
    out.own = Object.keys(ownSetups() || {}).sort();
    out.ownWanted = own0.map((n) => String(n > 1 ? n + 1 : n)).sort();
    const now = new Map(api.documentBlocks().map((b) => [b.id, b.page]));
    out.misplaced = blocks0.filter(([id, p]) => now.get(id) !== (p > 1 ? p + 1 : p));
    out.shown = document.querySelectorAll("#documentStage .pdf-page").length === api.notebookPageCount();
    out.idle = !api.notebookPagesBusy() && !document.body.classList.contains("canvas-pages-busy");
    return out;
  }`);
  check("＋ Page marks the Canvas busy and its pills inert while the page goes in", twice.busy && twice.pillInert, JSON.stringify(twice));
  check("...so a second press is refused rather than run into the first", twice.second === false, JSON.stringify(twice));
  check("two presses add one page, shown", twice.added === 1 && twice.shown && twice.idle, JSON.stringify(twice));
  check("...every Block moved once, to the page one insert puts it on", twice.blocks > 0 && twice.misplaced.length === 0, JSON.stringify(twice));
  check("...and each page's own setup moved once with its page", JSON.stringify(twice.own) === JSON.stringify(twice.ownWanted), JSON.stringify(twice));

  // ── 3c. A slow bucket ─────────────────────────────────────────────────
  //
  // The view used to reopen only once the whole file was in the bucket, so on
  // a real connection the old pages sat on screen under the new numbering for
  // seconds; and an upload that finished after the NEXT page change stamped
  // its key onto that change's record. A bucket that takes 2.5s per PUT:
  const slow = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const log = { puts: [], landed: 0, deletes: [] };
    api.setS3Transport(async (url, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      if (method === "PUT") {
        log.puts.push(String(url));
        await new Promise((r) => setTimeout(r, 2500));
        log.landed += 1;
        return new Response("", { status: 200 });
      }
      if (method === "DELETE") { log.deletes.push(String(url)); return new Response("", { status: 204 }); }
      return new Response("", { status: 404 });
    });
    localStorage.setItem("recall:s3Config", JSON.stringify({ endpoint: "https://bucket.invalid", bucket: "canvas-check", region: "auto", accessKeyId: "k", secretAccessKey: "s" }));
    const out = {};
    try {
      const pages0 = api.notebookPageCount();
      const t0 = performance.now();
      out.first = await api.addNotebookPage();
      out.firstMs = Math.round(performance.now() - t0);
      // Back, and drawn, with the bucket still holding the upload: nothing has
      // landed, yet the view already has the new page.
      out.landedOnReturn = log.landed;
      out.pagesOnReturn = document.querySelectorAll("#documentStage .pdf-page").length - pages0;
      out.shownBeforeUpload = log.landed === 0 && out.pagesOnReturn === 1;
      const hash1 = api.state.meta.notebook.sha256;
      out.second = await api.addNotebookPage();
      const hash2 = api.state.meta.notebook.sha256;
      for (let i = 0; i < 120 && log.landed < log.puts.length; i += 1) await settle(100);
      await settle(400);
      const key = String(api.state.meta.notebook.s3Key || "");
      out.key = key;
      out.keyIsLatest = key.includes(hash2) && !key.includes(hash1);
      out.overtakenDeleted = log.deletes.some((url) => url.includes(hash1));
      out.latestKept = !log.deletes.some((url) => url.includes(hash2));
      out.pages = api.notebookPageCount() - pages0;
      out.puts = log.puts.length;
    } finally {
      localStorage.removeItem("recall:s3Config");
      api.resetS3Transport();
    }
    return out;
  }`);
  check("with a slow bucket the new page is on screen before its upload lands", slow.first === true && slow.shownBeforeUpload, JSON.stringify(slow));
  check("an upload overtaken by the next page change never names the record", slow.second === true && slow.pages === 2 && slow.keyIsLatest, JSON.stringify(slow));
  check("...its object is deleted, and the latest one kept", slow.overtakenDeleted && slow.latestKept, JSON.stringify(slow));

  // The Canvas back as section 3 left it — the blank page 3b put in at 2 and
  // the two 3c put at the end torn out — for the sections below, which count
  // pages and find Blocks by where section 1 put them.
  await page.evaluate(`async () => {
    const { api } = window.__recall;
    const { painted } = window.__h;
    for (const n of [api.notebookPageCount(), api.notebookPageCount() - 1, 2]) {
      const sha = api.state.meta.notebook.sha256;
      await api.deleteNotebookPage(n);
      await painted(sha);
    }
    return api.notebookPageCount();
  }`);

  // ── 4. A smaller page asks first ──────────────────────────────────────
  const shrink = await page.evaluate(`async (b1) => {
    const { api, settle } = window.__recall;
    const { q, click, pick, painted, open, openFromMenu, ownSetups } = window.__h;
    // Page 1's Block sits at y 700 of 842 — near the top. One near the foot:
    const low = api.addDocumentBlock(1, { x: 80, y: 60 }, { md: "Near the foot", edit: false });
    await settle(250);
    const lowAt = (() => { const b = api.documentBlocks().find((x) => x.id === low.id); return [b.x, b.y]; })();
    api.selectBlock?.(null);
    await openFromMenu(1);
    const out = { scope: q('[data-cs-scope="all"]').getAttribute("aria-checked") };
    click('[data-cs-scope="page"]');
    pick("a6");
    click('[data-cs-action="apply"]');
    await settle(300);
    const confirm = document.getElementById("confirmModal");
    out.asked = Boolean(confirm && !confirm.hidden);
    out.message = document.getElementById("confirmModalMessage")?.textContent || "";
    document.getElementById("confirmModalCancelBtn").click();
    await settle(300);
    out.backInDialog = open() && q("[data-cs-size]").value === "a6";
    out.unchanged = !ownSetups()?.["1"];
    const sha = api.state.meta.notebook.sha256;
    click('[data-cs-action="apply"]');
    await settle(300);
    document.getElementById("confirmModalOkBtn").click();
    await painted(sha);
    out.own1 = ownSetups()?.["1"];
    const kept = api.documentBlocks().find((b) => b.id === low.id);
    out.kept = kept ? [kept.x, kept.y] : null;
    out.lowAt = lowAt;
    // ...and bigger again.
    await api.setNotebookPageSetup(api.legacySheetSetup("grid"), { page: 1 });
    await painted(null);
    out.restored = !ownSetups()?.["1"];
    api.deleteDocumentBlock?.(low.id);
    return out;
  }`, first.b1);
  check("a page made smaller than what is written on it asks first", shrink.asked && /past the edge/.test(shrink.message), JSON.stringify(shrink));
  check("...and a cancel goes back to the dialog with nothing changed", shrink.backInDialog && shrink.unchanged, JSON.stringify(shrink));
  check("...a yes makes the page smaller and keeps the Block's record", shrink.own1?.size === "a6" && JSON.stringify(shrink.kept) === JSON.stringify(shrink.lowAt), JSON.stringify(shrink));
  check("...and back to A4 grid, page 1 follows the Canvas again", shrink.restored, JSON.stringify(shrink));

  // ── 5. Every page at once, and the Canvas PDF ─────────────────────────
  const every = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const { q, click, pick, painted, openFromMenu, ownSetups, ratio } = window.__h;
    await openFromMenu(2);
    click('[data-cs-scope="all"]');
    pick("letter");
    click('[data-cs-orient="portrait"]');
    click('[data-cs-pattern="ruled"]');
    click('[data-cs-spacing="20.25"]');
    click('[data-cs-line="#1f5fd1"]');
    const range = q('[data-cs-range="opacity"]');
    range.value = "50";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    const out = { remember: q('[data-cs-toggle="remember"]').getAttribute("aria-checked") };
    const sha = api.state.meta.notebook.sha256;
    click('[data-cs-action="apply"]');
    await painted(sha);
    const nb = api.state.meta.notebook;
    out.setup = nb.setup ? { size: nb.setup.size, pattern: nb.setup.pattern, pitch: nb.setup.pitch, line: nb.setup.line, opacity: nb.setup.opacity } : null;
    out.own = ownSetups();
    out.paper = nb.paper;
    out.ratios = [1, 2, 3].map(ratio);
    out.remembered = api.notebookSetupPreference()?.size;
    if (window.PDFLib) {
      const built = await api.buildCanvasPdfBytes();
      const doc = await window.PDFLib.PDFDocument.load(built.bytes);
      out.exported = doc.getPages().map((p) => { const b = p.getMediaBox(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v)); });
    }
    return out;
  }`);
  check("every page at once: Letter ruled, blue at 50%, 7.1mm, on the Canvas", every.setup?.size === "letter" && every.setup.pattern === "ruled" && every.setup.pitch === 20.25 && every.setup.line === "#1f5fd1" && every.setup.opacity === 0.5, JSON.stringify(every));
  check("...the pages' own setups are cleared and the old paper names the nearest", every.own === null && every.paper === "ruled", JSON.stringify(every));
  check("...every page is Letter-shaped", every.ratios.every((r) => Math.abs(r - 612 / 792) < 0.02), JSON.stringify(every.ratios));
  check("...and it is what a new Canvas starts on", every.remember === "true" && every.remembered === "letter", JSON.stringify(every));
  if (every.exported) check("the Canvas PDF keeps each page's size and box", every.exported.length === 3 && every.exported.every((b) => JSON.stringify(b) === JSON.stringify([0, 50, 612, 792])), JSON.stringify(every.exported));

  // ── 6. Plain grid again is the very file a plain grid Canvas is ───────
  const plain = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const { painted } = window.__h;
    const sha = api.state.meta.notebook.sha256;
    await api.setNotebookPageSetup(api.legacySheetSetup("grid"), { all: true });
    await painted(sha);
    const nb = api.state.meta.notebook;
    const file = api.blankPdfFile({ pages: nb.pages, paper: "grid", name: api.state.deckTitle || "handwritten-notes" });
    return { setup: nb.setup || null, own: nb.pageSetups || null, paper: nb.paper, same: (await api.sha256(file)) === nb.sha256 };
  }`);
  check("set back to plain grid, the record holds no setup", !plain.setup && !plain.own && plain.paper === "grid", JSON.stringify(plain));
  check("...and the bytes are exactly a plain grid Canvas's", plain.same, JSON.stringify(plain));

  // ── 7. View only hides the row ────────────────────────────────────────
  const viewOnly = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    document.getElementById("documentEditBtn").click();
    await settle(300);
    document.getElementById("documentMoreBtn").click();
    await settle(150);
    const row = document.querySelector('#documentMoreMenu [data-document-action="hw-page-setup"]');
    const shown = Boolean(row && row.getClientRects().length);
    document.getElementById("documentMoreBtn").click();
    document.getElementById("documentEditBtn").click();
    await settle(300);
    return { shown };
  }`);
  check("View only hides Page setup…", viewOnly.shown === false, JSON.stringify(viewOnly));

  // ── 8. A Canvas started from "Page setup…" ────────────────────────────
  const fresh = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { q, click, pick, open, painted } = window.__h;
    api.writeNotebookSetupPreference(null);
    api.createNewDeck({ title: "Started from the dialog", notesMode: true });
    await settle(200);
    // "Create a new file?" over the file that is open.
    const sure = document.getElementById("confirmModal");
    if (sure && !sure.hidden) document.getElementById("confirmModalOkBtn").click();
    await settle(500);
    document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
    await settle(300);
    const second = document.querySelector("#documentView .pdf-missing-pick.is-secondary");
    const out = { offered: second?.textContent || "" };
    second?.click();
    await settle(250);
    out.open = open();
    out.scopeHidden = q("[data-cs-scope-row]").hidden;
    out.label = q('[data-cs-action="apply"]').textContent;
    pick("a5");
    click('[data-cs-pattern="cornell"]');
    click('[data-cs-action="apply"]');
    await painted(null);
    const nb = api.state.meta.notebook;
    out.setup = nb?.setup ? { size: nb.setup.size, pattern: nb.setup.pattern } : null;
    out.pages = nb?.pages;
    out.painted = Boolean(document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"));
    return out;
  }`);
  check("an empty Canvas tab offers Page setup… beside Start", fresh.offered === "Page setup…", JSON.stringify(fresh));
  check("...which opens the dialog with no pages to choose between", fresh.open && fresh.scopeHidden && fresh.label === "Start the Canvas", JSON.stringify(fresh));
  check("...and starts the Canvas on A5 Cornell", fresh.setup?.size === "a5" && fresh.setup.pattern === "cornell" && fresh.pages === 1 && fresh.painted, JSON.stringify(fresh));

  if (SHOTS) {
    await page.evaluate(`async () => {
      const { settle } = window.__recall;
      const { openFromMenu, click } = window.__h;
      await openFromMenu(1);
      click('[data-cs-pattern="ruled"]');
      await settle(200);
    }`);
    await shot("dialog-ruled.png");
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(`async () => { await window.__recall.settle(600); }`);
    await shot("dialog-phone.png");
    await page.evaluate(`async () => { window.__h.click('[data-cs-action="cancel"]'); await window.__recall.settle(200); }`);
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false });
  }

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

console.log(`\ncanvas-setup-browser-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
