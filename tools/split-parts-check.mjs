// Side by side parts: do two parts of one file both work, at once?
//
//   node tools/split-parts-check.mjs
//   node tools/split-parts-check.mjs --shots DIR   # also save a screenshot per pair
//
// A file has four parts — Cards, Notes, PDFs and Canvas — and any two can be on
// screen together (src/ui/split-parts.js, src/ui/view-mode.js openSplitPart).
// "On screen" is the easy half. The questions this asks are the other half:
//
//   1. Every pair opens with both panes laid out side by side, each with real
//      width, the focused one on the left where the reader already was.
//   2. Pressing in a pane moves the focus there — the tab pills, ⇓'s heading
//      and the tab row's tools follow — and re-renders NOTHING: no note parse,
//      no document open.
//   3. Each pane still does its own job beside the other: a card flips, the
//      note takes typing, a page of the PDF and of the Canvas is drawn, and
//      scrolling one leaves the other where it was.
//   4. Ink on the Canvas beside the PDF is the Canvas's, and a highlight on
//      the PDF beside the Canvas is the PDF's — two papers, one stored list.
//   5. A tab press while split replaces the focused part, and a jump to the
//      part beside lands in it without closing anything.
//   6. The split gives way: to the Highlights pane (they share a column), to a
//      different file, to a window too narrow for two, and to ⫿ → Close.
//
// Driven through tools/cdp.mjs, like tools/handwriting-check.mjs, whose setup
// this borrows: pdf.js injected from disk, the pages as canvases.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 240000;
const SHOTS = (() => {
  const at = process.argv.indexOf("--shots");
  return at > 0 ? process.argv[at + 1] : "";
})();

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
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/split-parts.js?v=__BUILD__",
    "/src/ui/split-layout.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/doc-slot.js?v=__BUILD__",
    "/src/handwriting/board.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/panels/highlight-cycle.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/cards/card-view.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc, pdfjsSrc, workerSrc, bytes) => {
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
  const bucket = {
    upload: async (p) => ({ data: { path: p }, error: null }),
    createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: "blob:signed/" + encodeURIComponent(p), error: null })), error: null }),
    list: async () => ({ data: [], error: null }),
    remove: async () => ({ data: [], error: null })
  };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("split-parts-check does not touch the database"); },
    storage: { from: () => bucket }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Side by side fixture", notesMode: true });
  await settle(300);
  document.getElementById("confirmModalOkBtn")?.click();
  await settle(300);
  // A note long enough to scroll, and three cards.
  const para = "A paragraph long enough to wrap over several lines in a narrow column, so that the note has somewhere to scroll to. ";
  api.state.notes = Array.from({ length: 40 }, (_, i) => "## Section " + (i + 1) + "\\n\\n" + para.repeat(3)).join("\\n\\n");
  const cards = [1, 2, 3].map((n) => ({ id: "c" + n, question: "Question " + n, answer: "Answer " + n }));
  api.state.masterCards = cards.slice();
  api.state.cards = cards.slice();
  api.state.current = 0;
  const file = new File([new Uint8Array(bytes)], "paper.pdf", { type: "application/pdf" });
  await api.attachPdfToOpenDeck(file);
  await settle(300);
  api.setViewMode("handwriting");
  await settle(200);
  // A Canvas with pages, not the offer of one.
  await api.startHandwritingNotebook();
  await settle(300);
  if (api.addNotebookPage) { await api.addNotebookPage(); await api.addNotebookPage(); }
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page[data-page-number='1'] canvas.pdf-canvas"); i += 1) await settle(100);
  api.setViewMode("notes");
  await settle(400);
  return {
    title: api.state.deckTitle,
    hasPdf: Boolean(api.state.meta?.pdf),
    // The Canvas tab is on every file and opens on a page of its own.
    hasNotebook: !document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').hidden
  };
}`;

// Where everything is, in one read.
const SNAPSHOT_SRC = `() => {
  const { api } = window.__recall;
  const panel = document.querySelector(".quiz-panel");
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const stages = [...document.querySelectorAll(".quiz-panel > .document-stage")].filter((s) => !s.hidden);
  return {
    viewMode: api.state.viewMode,
    splitPart: api.state.splitPart,
    split: panel.classList.contains("is-parts-split"),
    left: panel.dataset.splitLeft || "",
    right: panel.dataset.splitRight || "",
    focus: panel.dataset.focusPart || "",
    notes: document.getElementById("notesStage").hidden ? null : box(document.getElementById("notesStage")),
    cards: getComputedStyle(document.getElementById("deck")).display === "none" ? null : box(document.getElementById("deck")),
    docs: stages.map((s) => ({ slot: s.dataset.docSlot, box: box(s) })),
    divider: document.getElementById("splitDivider").hidden ? null : box(document.getElementById("splitDivider")),
    active: [...document.querySelectorAll("#viewModeToggle [data-view-mode].is-active")].map((b) => b.dataset.viewMode),
    beside: [...document.querySelectorAll("#viewModeToggle [data-view-mode].is-beside")].map((b) => b.dataset.viewMode),
    exportHead: document.querySelector("#viewExportMenu .md-menu-head")?.textContent || "",
    docToolsShown: document.body.classList.contains("cs-doc-shown"),
    errs: window.__errs.slice()
  };
}`;

const chrome = findChrome();
if (!chrome) { console.log("split-parts-check: no Chrome on this machine — skipping."); process.exit(0); }

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
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}

const snapshot = () => page.evaluate(SNAPSHOT_SRC);

// Open `beside` next to `focus`, from single-part mode on `focus`, the way the
// reader does: the tab, then ⫿ and its row. Waits for whatever paints.
const OPEN_SRC = `async (focus, beside) => {
  const { api, settle } = window.__recall;
  api.closeSplitPart();
  api.setViewMode(focus);
  await settle(300);
  document.getElementById("splitPartsBtn").click();
  await settle(50);
  const row = document.querySelector('#splitPartsMenu [data-split-action="open:' + beside + '"]');
  if (!row) return { error: "no row for " + beside + " in the menu: " + [...document.querySelectorAll("#splitPartsMenu [data-split-action]")].map((b) => b.dataset.splitAction).join(",") };
  row.click();
  for (let i = 0; i < 60; i += 1) {
    await settle(100);
    const pages = [...document.querySelectorAll(".quiz-panel > .document-stage:not([hidden]) .pdf-page[data-page-number='1'] canvas.pdf-canvas")];
    const wantDocs = ["document", "handwriting"].filter((m) => m === focus || m === beside).length;
    if (pages.length >= wantDocs) break;
  }
  // Two papers: the focus goes back to the one the reader was on once the new
  // one has drawn (src/documents/pdf-view.js, openDocumentBeside).
  for (let i = 0; i < 40; i += 1) {
    const v = api.documentViewersForCheck();
    if (!v.dual || v.live === v.focus) break;
    await settle(100);
  }
  await settle(250);
  return { ok: true };
}`;

const LABEL = { cards: "Cards", notes: "Notes", document: "PDFs", handwriting: "Canvas" };

// A stylus, as tools/handwriting-check.mjs drives one: the events the pen takes.
const PEN_SRC = `(target, type, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
  bubbles: true, cancelable: true, pointerId: 7, pointerType: "pen", isPrimary: true,
  clientX: x, clientY: y, buttons, pressure: buttons ? 0.55 : 0
}))`;

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}`
  });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const fixture = buildFixturePdf({ pages: 4 });
  const setup = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker, Array.from(fixture.bytes));
  check("the fixture file has notes, cards, a PDF and a Canvas", setup.hasPdf && setup.hasNotebook, JSON.stringify(setup));

  const dual = await page.evaluate(`() => window.__recall.api.splitPairAllowedForCheck?.("document", "handwriting") ?? false`);
  const PAIRS = [
    ["notes", "cards"], ["cards", "notes"],
    ["notes", "document"], ["document", "notes"],
    ["notes", "handwriting"], ["handwriting", "cards"],
    ["cards", "document"],
    ...(dual ? [["document", "handwriting"], ["handwriting", "document"]] : [])
  ];

  // ── 1. Every pair, side by side ──────────────────────────────────────────
  for (const [focus, beside] of PAIRS) {
    const opened = await page.evaluate(OPEN_SRC, focus, beside);
    if (opened.error) { check(`${LABEL[focus]} + ${LABEL[beside]}: opens from the ⫿ menu`, false, opened.error); continue; }
    const s = await snapshot();
    const paneOf = (mode) => mode === "notes" ? s.notes
      : mode === "cards" ? s.cards
        : s.docs.find((d) => d.slot === (mode === "handwriting" ? "notebook" : "doc"))?.box;
    const a = paneOf(focus);
    const b = paneOf(beside);
    check(`${LABEL[focus]} + ${LABEL[beside]}: both panes are up, side by side`,
      s.split && a && b && a.width > 200 && b.width > 200 && a.right <= b.left + 2 && s.divider,
      `split=${s.split} focus=${JSON.stringify(a)} beside=${JSON.stringify(b)}`);
    check(`${LABEL[focus]} + ${LABEL[beside]}: the focused part stays on the left, and both tabs are lit`,
      s.left === focus && s.right === beside && s.active.join() === focus && s.beside.join() === beside,
      `left=${s.left} right=${s.right} active=${s.active} beside=${s.beside}`);
    await shot(`split-${focus}-${beside}.png`);
  }

  // ── 4. Two papers: the PDFs and the Canvas, both live ────────────────────
  if (dual) {
    await page.evaluate(OPEN_SRC, "document", "handwriting");
    const papers = await page.evaluate(`async (penSrc) => {
      const { api, settle } = window.__recall;
      const pen = (0, eval)(penSrc);
      const stageOf = (slot) => document.querySelector(".quiz-panel > .document-stage[data-doc-slot='" + slot + "']:not([hidden])");
      const pdfStage = stageOf("doc");
      const canvasStage = stageOf("notebook");
      if (!pdfStage || !canvasStage || pdfStage === canvasStage) return { error: "two stages were not up: " + Boolean(pdfStage) + "/" + Boolean(canvasStage) };
      const pdfPage1 = pdfStage.querySelector(".pdf-page[data-page-number='1']");
      const canvasPage1 = canvasStage.querySelector(".pdf-page[data-page-number='1']");
      const ink = () => (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
      const before = { notebook: ink().filter((r) => r.doc === "notebook").length, paper: ink().filter((r) => !r.doc).length };
      const out = { before };
      out.start = { viewMode: api.state.viewMode, live: api.openDocumentSlot(), pagerIn: document.getElementById("documentPager").closest(".document-stage") === pdfStage };
      const scribble = async (stage) => {
        for (let i = 0; i < 40 && document.querySelector(".toast"); i += 1) await settle(100);
        const view = stage.querySelector(".document-scroll");
        const box = stage.querySelector(".pdf-page[data-page-number='1']").getBoundingClientRect();
        pen(view, "pointerdown", box.left + 60, box.top + 120, 1);
        for (let i = 1; i <= 12; i += 1) pen(view, "pointermove", box.left + 60 + i * 7, box.top + 120 + i * 3, 1);
        await settle(120);
        pen(view, "pointerup", box.left + 144, box.top + 156, 0);
        await settle(300);
      };
      // The Canvas, reached for with the pen: it becomes the live paper and
      // takes the ink.
      await scribble(canvasStage);
      out.onCanvas = {
        viewMode: api.state.viewMode,
        live: api.openDocumentSlot(),
        pagerIn: document.getElementById("documentPager").closest(".document-stage") === canvasStage,
        notebook: ink().filter((r) => r.doc === "notebook").length,
        paper: ink().filter((r) => !r.doc).length,
        pages: api.currentPdfPageCount()
      };
      // ...and the PDF, the same way: its ink is the paper's.
      await scribble(pdfStage);
      out.onPaper = {
        viewMode: api.state.viewMode,
        live: api.openDocumentSlot(),
        notebook: ink().filter((r) => r.doc === "notebook").length,
        paper: ink().filter((r) => !r.doc).length
      };
      out.samePages = pdfStage.querySelector(".pdf-page[data-page-number='1']") === pdfPage1
        && canvasStage.querySelector(".pdf-page[data-page-number='1']") === canvasPage1;
      out.canvasStillPainted = Boolean(canvasStage.querySelector(".pdf-page[data-page-number='1'] canvas.pdf-canvas"));
      // Scrolled far down the PDF and straight over to the Canvas, before the
      // PDF has drawn where it went: it catches up once the hands are still.
      const pdfView = pdfStage.querySelector(".document-scroll");
      const canvasView = canvasStage.querySelector(".document-scroll");
      const canvasTop = canvasView.scrollTop;
      pdfView.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 3000 }));
      pdfView.scrollTop = pdfView.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => r()));
      const canvasBox = canvasView.getBoundingClientRect();
      canvasView.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX: canvasBox.left + 30, clientY: canvasBox.top + 30, buttons: 1 }));
      canvasView.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", clientX: canvasBox.left + 30, clientY: canvasBox.top + 30 }));
      const lastPage = api.state.meta?.pdf?.pages || 4;
      out.leftUndrawn = !pdfStage.querySelector(".pdf-page[data-page-number='" + lastPage + "'] canvas.pdf-canvas");
      await settle(3000);
      out.caughtUp = Boolean(pdfStage.querySelector(".pdf-page[data-page-number='" + lastPage + "'] canvas.pdf-canvas"));
      out.afterCatchUp = { viewMode: api.state.viewMode, live: api.openDocumentSlot(), pagerIn: document.getElementById("documentPager").closest(".document-stage") === canvasStage, canvasTop: canvasView.scrollTop === canvasTop };
      // Two papers to one, from the menu: the Canvas stays, the PDF is parked
      // — so its tab, pressed afterwards, brings back the very same pages.
      const parkedPage = pdfStage.querySelector(".pdf-page[data-page-number='1']");
      document.getElementById("splitPartsBtn").click();
      await settle(50);
      document.querySelector('#splitPartsMenu [data-split-action="close"]')?.click();
      await settle(300);
      out.closed = { parts: api.state.splitPart, live: api.openDocumentSlot(), stages: document.querySelectorAll(".quiz-panel > .document-stage:not([hidden])").length };
      document.querySelector('#viewModeToggle [data-view-mode="document"]').click();
      for (let i = 0; i < 40 && api.openDocumentSlot() !== "doc"; i += 1) await settle(100);
      await settle(200);
      out.backToPaper = { live: api.openDocumentSlot(), samePage: document.querySelector(".quiz-panel > .document-stage:not([hidden]) .pdf-page[data-page-number='1']") === parkedPage };
      return out;
    }`, PEN_SRC);
    if (papers.error) {
      check("PDFs + Canvas: both papers are up", false, papers.error);
    } else {
      check("PDFs + Canvas: the PDF in focus is the live paper, with the pager in its stage",
        papers.start.viewMode === "document" && papers.start.live === "doc" && papers.start.pagerIn, JSON.stringify(papers.start));
      check("...the pen on the Canvas makes it the live paper, and its ink is the Canvas's",
        papers.onCanvas.viewMode === "handwriting" && papers.onCanvas.live === "notebook" && papers.onCanvas.pagerIn
          && papers.onCanvas.notebook === papers.before.notebook + 1 && papers.onCanvas.paper === papers.before.paper,
        JSON.stringify({ before: papers.before, after: papers.onCanvas }));
      check("...and the pen on the PDF, the PDF's",
        papers.onPaper.viewMode === "document" && papers.onPaper.live === "doc"
          && papers.onPaper.paper === papers.before.paper + 1 && papers.onPaper.notebook === papers.before.notebook + 1,
        JSON.stringify(papers.onPaper));
      check("...with neither paper's pages rebuilt by the swaps, and the Canvas still painted",
        papers.samePages && papers.canvasStillPainted, `same pages=${papers.samePages}, canvas painted=${papers.canvasStillPainted}`);
      check("a PDF left mid-scroll catches up beside the Canvas, without taking the focus or moving the Canvas",
        papers.caughtUp && papers.afterCatchUp.viewMode === "handwriting" && papers.afterCatchUp.live === "notebook"
          && papers.afterCatchUp.pagerIn && papers.afterCatchUp.canvasTop,
        JSON.stringify({ leftUndrawn: papers.leftUndrawn, caughtUp: papers.caughtUp, ...papers.afterCatchUp }));
      check("closing leaves the Canvas alone on the stage",
        papers.closed.parts === null && papers.closed.live === "notebook" && papers.closed.stages === 1, JSON.stringify(papers.closed));
      check("...and the PDF's tab brings back the same pages, parked rather than reopened",
        papers.backToPaper.live === "doc" && papers.backToPaper.samePage, JSON.stringify(papers.backToPaper));
    }
    await shot("split-papers-after.png");
  }

  // ── 2. Focus follows the hand, and costs no render ───────────────────────
  await page.evaluate(OPEN_SRC, "notes", "document");
  const focusSwap = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    let notesRenders = 0;
    let documentOpens = 0;
    const view = document.getElementById("notesView");
    const before = view.innerHTML.length;
    const observer = new MutationObserver((list) => { notesRenders += list.length; });
    observer.observe(view, { childList: true });
    const stage = document.querySelector(".quiz-panel > .document-stage[data-doc-slot='doc']:not([hidden])");
    const pages = stage.querySelector(".pdf-pages");
    const page1 = stage.querySelector(".pdf-page[data-page-number='1']");
    const box = page1.getBoundingClientRect();
    page1.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: box.left + 20, clientY: box.top + 20, pointerType: "mouse", buttons: 1 }));
    page1.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: box.left + 20, clientY: box.top + 20, pointerType: "mouse" }));
    await settle(200);
    const afterDoc = { viewMode: api.state.viewMode, splitPart: api.state.splitPart, docTools: document.body.classList.contains("cs-doc-shown") };
    api.paintViewExportMenu();
    afterDoc.exportHead = document.querySelector("#viewExportMenu .md-menu-head")?.textContent || "";
    const notesBox = view.getBoundingClientRect();
    view.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: notesBox.left + 30, clientY: notesBox.top + 30, pointerType: "mouse", buttons: 1 }));
    await settle(200);
    observer.disconnect();
    return {
      afterDoc,
      afterNotes: { viewMode: api.state.viewMode, splitPart: api.state.splitPart, docTools: document.body.classList.contains("cs-doc-shown") },
      notesRenders,
      sameNote: view.innerHTML.length === before,
      samePages: stage.querySelector(".pdf-pages") === pages && stage.querySelector(".pdf-page[data-page-number='1']") === page1
    };
  }`);
  check("a press on the PDF moves the focus to it",
    focusSwap.afterDoc.viewMode === "document" && focusSwap.afterDoc.splitPart === "notes" && focusSwap.afterDoc.docTools,
    JSON.stringify(focusSwap.afterDoc));
  check("...and ⇓ exports what is in focus", /pdf/i.test(focusSwap.afterDoc.exportHead), focusSwap.afterDoc.exportHead);
  check("...and a press on the note moves it back, with the PDF's tools stepping out of the row",
    focusSwap.afterNotes.viewMode === "notes" && focusSwap.afterNotes.splitPart === "document" && !focusSwap.afterNotes.docTools,
    JSON.stringify(focusSwap.afterNotes));
  check("...with nothing re-rendered: the same note, the same pages",
    focusSwap.notesRenders === 0 && focusSwap.sameNote && focusSwap.samePages,
    `note mutations=${focusSwap.notesRenders}, same note=${focusSwap.sameNote}, same pages=${focusSwap.samePages}`);

  // ── 3. Each pane does its own job beside the other ───────────────────────
  const scrolling = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const notes = document.getElementById("notesView");
    const docView = document.querySelector(".quiz-panel > .document-stage[data-doc-slot='doc']:not([hidden]) .document-scroll");
    notes.scrollTop = 0;
    docView.scrollTop = 0;
    await settle(100);
    notes.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    notes.scrollTop = 600;
    await settle(250);
    const docAfterNotes = docView.scrollTop;
    docView.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    docView.scrollTop = 500;
    await settle(250);
    return { notesTop: notes.scrollTop, docAfterNotes, docTop: docView.scrollTop, notesAfterDoc: notes.scrollTop };
  }`);
  check("scrolling the note leaves the PDF where it was, and the other way round",
    scrolling.notesTop > 0 && scrolling.docAfterNotes === 0 && scrolling.docTop > 0 && scrolling.notesAfterDoc === scrolling.notesTop,
    JSON.stringify(scrolling));

  await page.evaluate(OPEN_SRC, "cards", "notes");
  const cardsBeside = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const card = document.getElementById("card");
    const flippedBefore = Boolean(api.state.flipped);
    card.querySelector(".card-question")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", buttons: 1 }));
    card.click();
    await settle(400);
    const flipped = Boolean(api.state.flipped) !== flippedBefore;
    // Typing in the notes beside the cards: the raw editor, a word, committed.
    api.enterNotesEditing();
    await settle(200);
    const area = document.getElementById("notesEdit");
    area.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    area.focus();
    area.setSelectionRange(0, 0);
    document.execCommand("insertText", false, "Typed beside the cards. ");
    await settle(300);
    api.commitNotesEditIfActive?.();
    await settle(300);
    return { flipped, typed: api.state.notes.startsWith("Typed beside the cards."), focus: api.state.viewMode, cardShown: !card.hidden };
  }`);
  check("a card flips with the notes beside it", cardsBeside.flipped && cardsBeside.cardShown, JSON.stringify(cardsBeside));
  check("...and the notes beside the cards take typing, with the focus moving to them",
    cardsBeside.typed && cardsBeside.focus === "notes", JSON.stringify(cardsBeside));

  // ── 5. Tabs and jumps while split ────────────────────────────────────────
  await page.evaluate(OPEN_SRC, "notes", "cards");
  const tabs = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // The tab of the part beside: a move of focus, nothing closes.
    document.querySelector('#viewModeToggle [data-view-mode="cards"]').click();
    await settle(200);
    const focusOnly = { viewMode: api.state.viewMode, splitPart: api.state.splitPart };
    // Another tab: replaces the focused part, in its own column.
    document.querySelector('#viewModeToggle [data-view-mode="document"]').click();
    for (let i = 0; i < 40 && !document.querySelector(".quiz-panel > .document-stage:not([hidden]) .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(200);
    const panel = document.querySelector(".quiz-panel");
    const replaced = { viewMode: api.state.viewMode, splitPart: api.state.splitPart, left: panel.dataset.splitLeft, right: panel.dataset.splitRight };
    // A programmatic jump to the part beside, as "Go to notes" makes.
    api.setViewMode("notes");
    await settle(200);
    const jumped = { viewMode: api.state.viewMode, splitPart: api.state.splitPart };
    return { focusOnly, replaced, jumped };
  }`);
  check("the tab of the part beside moves the focus and closes nothing",
    tabs.focusOnly.viewMode === "cards" && tabs.focusOnly.splitPart === "notes", JSON.stringify(tabs.focusOnly));
  check("...another tab replaces the focused part, in its column",
    tabs.replaced.viewMode === "document" && tabs.replaced.splitPart === "notes" && tabs.replaced.right === "document" && tabs.replaced.left === "notes",
    JSON.stringify(tabs.replaced));
  check("...and a jump to the part beside lands in it", tabs.jumped.viewMode === "notes" && tabs.jumped.splitPart === "document", JSON.stringify(tabs.jumped));

  // ── 6. The split gives way ───────────────────────────────────────────────
  const givesWay = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const out = {};
    // To the Highlights pane, which shares the column.
    api.setViewMode("notes");
    api.openHighlightSplit("notes");
    await settle(200);
    out.highlights = { parts: api.state.splitPart, highlightPane: api.isHighlightSplitOpen() };
    api.closeHighlightSplit();
    await settle(100);
    // ...and the other way round.
    api.openHighlightSplit("notes");
    await settle(100);
    api.openSplitPart("cards");
    await settle(200);
    out.partsBack = { parts: api.state.splitPart, highlightPane: api.isHighlightSplitOpen() };
    // ⫿ → Close.
    document.getElementById("splitPartsBtn").click();
    await settle(50);
    document.querySelector('#splitPartsMenu [data-split-action="close"]')?.click();
    await settle(200);
    const panel = document.querySelector(".quiz-panel");
    out.closed = { parts: api.state.splitPart, split: panel.classList.contains("is-parts-split"), divider: document.getElementById("splitDivider").hidden, deckHidden: getComputedStyle(document.getElementById("deck")).display === "none" };
    return out;
  }`);
  check("opening the Highlights pane closes the split, as they share a column",
    givesWay.highlights.parts === null && givesWay.highlights.highlightPane, JSON.stringify(givesWay.highlights));
  check("...and opening a part beside closes the Highlights pane",
    givesWay.partsBack.parts === "cards" && !givesWay.partsBack.highlightPane, JSON.stringify(givesWay.partsBack));
  check("⫿ → Close side by side leaves the focused part alone on the panel",
    givesWay.closed.parts === null && !givesWay.closed.split && givesWay.closed.divider && givesWay.closed.deckHidden,
    JSON.stringify(givesWay.closed));

  await page.evaluate(OPEN_SRC, "notes", "cards");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 400));
  const narrow = await page.evaluate(`() => ({
    parts: window.__recall.api.state.splitPart,
    button: getComputedStyle(document.getElementById("splitPartsBtn")).display
  })`);
  check("a window narrower than 720px closes the split and hides ⫿",
    narrow.parts === null && narrow.button === "none", JSON.stringify(narrow));
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 300));

  const otherFile = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.openSplitPart("cards");
    await settle(200);
    const opened = api.state.splitPart;
    api.createNewDeck({ title: "Another file", notesMode: true });
    await settle(200);
    document.getElementById("confirmModalOkBtn")?.click();
    await settle(500);
    return { opened, after: api.state.splitPart, split: document.querySelector(".quiz-panel").classList.contains("is-parts-split") };
  }`);
  check("opening another file closes the split", otherFile.opened === "cards" && otherFile.after === null && !otherFile.split, JSON.stringify(otherFile));

  // ...and with both papers up, which is two parsed documents of the file being
  // left: neither may be kept under the new file's name.
  if (dual) {
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.closeMyDecksPanel?.();
    }`);
    const backTo = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const entry = api.readLocalDeckIndex().find((e) => e.title === "Side by side fixture");
      if (!entry) return { error: "the fixture file is not in the library" };
      await api.loadDeckFromLibrary(entry.id);
      await settle(600);
      return { title: api.state.deckTitle };
    }`);
    if (backTo.error) {
      check("back on the fixture file for the two-papers case", false, backTo.error);
    } else {
      await page.evaluate(OPEN_SRC, "document", "handwriting");
      const papersThenFile = await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        const opened = api.documentViewersForCheck().dual;
        api.createNewDeck({ title: "A third file", notesMode: true });
        await settle(200);
        document.getElementById("confirmModalOkBtn")?.click();
        await settle(600);
        return {
          opened,
          after: api.documentViewersForCheck(),
          parts: api.state.splitPart,
          stages: document.querySelectorAll(".quiz-panel > .document-stage:not([hidden])").length
        };
      }`);
      check("opening another file with both papers up lets both go",
        papersThenFile.opened && !papersThenFile.after.dual && papersThenFile.parts === null && papersThenFile.stages <= 1,
        JSON.stringify(papersThenFile));
    }
  }

  const final = await snapshot();
  check("nothing threw anywhere in this run", final.errs.length === 0, final.errs.join(" | "));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

if (failures) {
  console.log(`\nsplit-parts-check: ${failures} failed`);
  console.log(`CHECK: ${ran} checks · ${failures} failed`);
  process.exit(1);
}
console.log("\nsplit-parts-check: any two parts of a file work side by side, the focus follows the hand without re-rendering, and the split gives way when it should");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
