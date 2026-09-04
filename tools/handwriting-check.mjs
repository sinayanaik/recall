// Does the pen still write when the hand pauses, and does a notebook keep what
// was written on it?
//
//   node tools/handwriting-check.mjs
//
// Every case here is a fault that was REPORTED rather than one that was
// imagined, and every one of them is invisible to the checks that already
// exist. tools/ink-check.mjs is pure Node: it can ask whether a stroke survives
// being encoded and whether the straightener refuses a written word, and it
// cannot ask whether the line follows the nib. That question needs a stylus, a
// compositor and a clock, so it needs a browser — which is also the only
// instrument that could have caught any of these in the first place.
//
// Driven through tools/cdp.mjs rather than puppeteer, for the reason
// tools/notes-menu-check.mjs gives: a check that skips itself wherever a package
// is missing is a check that never catches anything.
//
// ── The five questions ────────────────────────────────────────────────────
//
//   1. A stroke held still mid-word and then continued. The straightener fires
//      on a hold, and a hold is very often someone thinking; once it had fired
//      every later sample was discarded and the fitted shape was committed
//      instead. So the line stopped following the nib and the writing after the
//      pause was gone. This is the case the whole file exists for.
//   2. Whether the finished stroke is on the dry canvas BEFORE the wet layer
//      gives it up. The wet pair is `desynchronized` — it may present ahead of
//      the compositor — so clearing it first put a one-frame hole where the
//      stroke had just been, at every pen lift.
//   3. Whether the 200th stroke on a page costs what the 2nd did. Three
//      separate things used to be O(everything on the page) per stroke, and the
//      symptom of all three was the same: writing got slower the more you had
//      written.
//   4. A notebook's pages: added, drawn on, torn out, and read back from
//      IndexedDB. Ink on the right page, and a torn-out page that stays torn
//      out — which is the tombstone, not the absence.
//   5. A text box dragged, resized, typed into, and still where it was put
//      after a reload; and the same notebook edited on two devices at once,
//      merged.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 180000;

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
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/notebook-migrate.js?v=__BUILD__",
    "/src/documents/blank-pdf.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/notes/ink-sheet.js?v=__BUILD__",
    "/src/format/ink-strokes.js?v=__BUILD__",
    "/src/format/ink-svg.js?v=__BUILD__",
    "/src/render/ink-paint.js?v=__BUILD__",
    "/src/sync/document-sync.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/storage/deck-snapshot.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// A storage bucket that actually stores, so the drawing sheet's Done reaches
// the end of the ordinary image path rather than its offline branch. Modelled
// on tools/image-sync-check.mjs, which is where this shape comes from.
const SETUP_SRC = `async (apiSrc, pdfjsSrc, workerSrc) => {
  // Injected rather than fetched: see tools/pdfjs-source.mjs. It also means this
  // exercises ensurePdfJs's "already on window" path instead of a network call.
  const tag = document.createElement("script");
  tag.textContent = pdfjsSrc;
  document.head.appendChild(tag);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  window.__recall = { api, settle, raf };
  window.__errs = [];
  window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @ " + String(e.filename).split("/").pop() + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => window.__errs.push("reject: " + String((e.reason && e.reason.stack) || e.reason)));
  window.__stored = new Map();
  const bucket = {
    upload: async (p, blob) => { window.__stored.set(p, blob.size); return { data: { path: p }, error: null }; },
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
    from: () => { throw new Error("handwriting-check does not touch the database"); },
    storage: { from: () => bucket }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Handwriting fixture", notesMode: true });
  await settle(400);
  // A dark app theme, which is what seven of the ten are — the case the colour
  // assertions below are about. The OS is emulated to LIGHT by the runner, so
  // the two deliberately disagree.
  document.documentElement.setAttribute("data-theme", "dark-amoled");
  await settle(100);
  return true;
}`;

// A stylus, dispatched at the element the surface listens on. `pressure` is
// varied so the pressure path is the one under test — that is the path a real
// pen takes.
const PEN_SRC = `(target, type, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
  bubbles: true, pointerId: 1, pointerType: "pen", isPrimary: true,
  clientX: x, clientY: y, buttons, pressure: buttons ? 0.55 : 0
}))`;

const chrome = findChrome();
if (!chrome) { console.log("handwriting-check: no Chrome on this machine — skipping."); process.exit(0); }

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
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

try {
  // The operating system set to LIGHT, deliberately, while the app runs a dark
  // theme. That disagreement is the ordinary case and it is what the drawing
  // colours used to be decided by.
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);

  // ── 1. The pen that stopped when the hand paused ────────────────────────
  const paused = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    document.getElementById("handwritingBtn").click();
    // Generating the paper, attaching it, and letting pdf.js lay it out. Longer
    // than a DOM settle because a real document is being opened.
    for (let i = 0; i < 60 && !document.querySelector("#hwStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    const pageEl = document.querySelector("#hwStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();

    // A straight, slow run — then a REST longer than the straightener's hold
    // (INK_SHAPE_HOLD_MS is 600ms) — then more of the same line. A straight run
    // is chosen deliberately: it is the shape most likely to be snapped, so it
    // is the case where losing the rest of the stroke was most likely.
    pen(document.getElementById("documentView"), "pointerdown", box.left + 40, box.top + 60, 1);
    for (let i = 1; i <= 10; i += 1) pen(document.getElementById("documentView"), "pointermove", box.left + 40 + (i * 10), box.top + 60, 1);
    await settle(750);
    const halfway = box.left + 140;
    for (let i = 1; i <= 10; i += 1) pen(document.getElementById("documentView"), "pointermove", halfway + (i * 10), box.top + 60, 1);
    await settle(80);
    pen(document.getElementById("documentView"), "pointerup", halfway + 100, box.top + 60, 0);
    await settle(200);

    // The strokes, out of the ink records the paper carries — the same place
    // they live on anybody else's PDF, because this IS the Document surface.
    const marks = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const strokes = marks.flatMap((r) => api.decodeInkStrokes(r.ink?.s || []));
    const bounds = api.inkStrokesBounds(strokes);
    const viewport = api.pdfPageViewport(1);
    // Where the pen finished, in the page's own points.
    const wanted = viewport ? viewport.convertToPdfPoint((halfway + 100) - box.left, 0)[0] : 0;
    return {
      strokes: strokes.length,
      notebook: Boolean(api.state.meta.pdf?.notebook),
      rendered: Boolean(pageEl.querySelector("canvas.pdf-canvas")),
      maxX: bounds ? bounds.maxX : 0,
      wanted,
      errs: window.__errs.slice(0, 4)
    };
  }`, PEN_SRC);

  check("the notebook's paper is a real PDF, laid out by pdf.js",
    paused.notebook && paused.rendered,
    `notebook=${paused.notebook}, page 1 rendered=${paused.rendered}`);
  check("a stroke held still for 750ms keeps following the nib afterwards",
    paused.strokes > 0 && paused.maxX >= paused.wanted - 12,
    `reached ${paused.maxX.toFixed(0)} of ${paused.wanted.toFixed(0)} points across the page`);
  check("...and the pause did not throw the stroke away", paused.strokes > 0,
    `${paused.strokes} stroke(s) committed`);
  check("...with nothing thrown on the way", paused.errs.length === 0, paused.errs.join(" | "));

  // ── 2. The blink at every pen lift ──────────────────────────────────────
  const handover = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const pageEl = document.querySelector("#hwStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    const dry = pageEl.querySelector(".pdf-ink-layer .is-ink-dry");
    const inked = () => {
      const ctx = dry.getContext("2d");
      const px = ctx.getImageData(0, 0, dry.width, dry.height).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n += 1;
      return n;
    };
    const before = inked();
    pen(document.getElementById("documentView"), "pointerdown", box.left + 60, box.top + 300, 1);
    for (let i = 1; i <= 14; i += 1) pen(document.getElementById("documentView"), "pointermove", box.left + 60 + (i * 9), box.top + 300 + (i * 4), 1);
    await settle(120);
    // Read SYNCHRONOUSLY after the lift, before any frame can run. If the dry
    // canvas already carries the new stroke at this instant, then the repaint
    // happened before the wet layer was cleared — which is the whole of the
    // ordering fix, and the only moment at which it can be observed.
    pen(document.getElementById("documentView"), "pointerup", box.left + 186, box.top + 356, 0);
    const atLift = inked();
    await settle(150);
    const after = inked();
    return { before, atLift, after };
  }`, PEN_SRC);

  // ── 2b. Is the committed stroke actually ON SCREEN? ─────────────────────
  //
  // The check above reads the dry canvas's own bitmap, which proves the stroke
  // was PAINTED. It cannot prove it is visible, and those came apart: the wet
  // pair is `desynchronized`, which asks to be taken out of the normal
  // compositing path, and on Chrome/Android that can mean a hardware overlay
  // plane that does not blend with what is beneath it. Left mounted after the
  // stroke it covered the dry canvas, so the ink was painted, present, and
  // invisible — "I can see the strokes while drawing but they disappear once
  // drawn".
  //
  // A bitmap read cannot see that and a screenshot comparison would be brittle,
  // so this asks the one question that actually distinguishes the two: after the
  // pen lifts, is anything of that pair still in the document?
  const mounted = await page.evaluate(`() => {
    const page = document.querySelector("#hwStage .pdf-page[data-page-number='1']");
    return {
      wet: page.querySelectorAll(".is-ink-wet").length,
      tip: page.querySelectorAll(".is-ink-tip").length,
      dry: page.querySelectorAll(".is-ink-dry").length
    };
  }`);
  check("the low-latency pair comes off the page once the stroke is committed",
    mounted.wet === 0 && mounted.tip === 0,
    `${mounted.wet} wet, ${mounted.tip} tip, ${mounted.dry} dry canvas(es) left mounted`);
  check("...leaving the dry canvas to be the thing on top", mounted.dry === 1,
    `${mounted.dry} dry canvas(es)`);

  check("the dry canvas has the finished stroke at the instant the pen lifts",
    handover.atLift > handover.before,
    `${handover.before} → ${handover.atLift} inked pixel(s) with no frame in between`);
  check("...and still has it a frame later", handover.after >= handover.atLift,
    `${handover.after} inked pixel(s)`);

  // ── 3. Does writing get slower the more you have written? ───────────────
  const cost = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const pageEl = document.querySelector("#hwStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    // One short stroke, timed from pointerdown to the return of pointerup —
    // which is where every one of the three O(page) faults was paid.
    const stroke = (n) => {
      const y = box.top + 40 + ((n % 90) * 8);
      const x = box.left + 30 + ((n % 7) * 40);
      const t0 = performance.now();
      pen(document.getElementById("documentView"), "pointerdown", x, y, 1);
      for (let i = 1; i <= 6; i += 1) pen(document.getElementById("documentView"), "pointermove", x + (i * 4), y + i, 1);
      pen(document.getElementById("documentView"), "pointerup", x + 24, y + 6, 0);
      return performance.now() - t0;
    };
    const early = [];
    for (let n = 0; n < 5; n += 1) { early.push(stroke(n)); await settle(4); }
    for (let n = 5; n < 180; n += 1) { stroke(n); if (n % 20 === 0) await settle(2); }
    await settle(60);
    const late = [];
    for (let n = 180; n < 190; n += 1) { late.push(stroke(n)); await settle(4); }
    const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const marks = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    return {
      strokes: marks.flatMap((r) => api.decodeInkStrokes(r.ink?.s || [])).length,
      early: median(early),
      late: median(late)
    };
  }`, PEN_SRC);

  // Generous, and deliberately so: this is a ratio on a shared machine, and the
  // fault it guards against was not 3x — it was linear in the page, which at
  // 180 strokes is orders of magnitude. A regression here will not be subtle.
  const ratio = cost.late / Math.max(0.05, cost.early);
  check("the 185th stroke on a page costs about what the 3rd did",
    ratio < 6,
    `${cost.early.toFixed(2)}ms → ${cost.late.toFixed(2)}ms (${ratio.toFixed(1)}x) over ${cost.strokes} stroke(s)`);

  // ── 4. Pages, added and torn out of a real document ─────────────────────
  //
  // Adding a page regenerates the PDF; tearing one out regenerates it AND
  // renumbers every record after the gap, because a highlight naming page 7 of a
  // six-page document can never be painted or jumped to again. Both are asked
  // here against the live pdf.js document as well as against meta, since the two
  // disagreeing is exactly the failure — meta says three pages, the file has two.
  const pages = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const board = document.getElementById("handwritingBoard");
    const inkOn = (n) => (api.state.meta.pdfHighlights || [])
      .filter((r) => r.kind === "ink" && Number(r.page) === n).length;

    const before = { meta: api.state.meta.pdf.pages, doc: api.currentPdfPageCount(), inkPage1: inkOn(1) };

    board.querySelector('[data-hw-action="add-page"]').click();
    for (let i = 0; i < 60 && api.currentPdfPageCount() < before.doc + 1; i += 1) await settle(100);
    const added = { meta: api.state.meta.pdf.pages, doc: api.currentPdfPageCount(), inkPage1: inkOn(1) };

    // Something on the NEW page, so the renumbering below has a record that has
    // to move and one that has to stay.
    api.scrollToDocumentPage(2, 0, { smooth: false });
    await api.whenDocumentPageReady(2);
    await settle(200);
    const two = document.querySelector("#hwStage .pdf-page[data-page-number='2']");
    const box = two.getBoundingClientRect();
    const view = document.getElementById("documentView");
    const pen = (t, x, y, b) => view.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 3, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, buttons: b, pressure: 0.6 }));
    pen("pointerdown", box.left + 50, box.top + 60, 1);
    for (let i = 1; i <= 12; i += 1) pen("pointermove", box.left + 50 + (i * 8), box.top + 60 + (i * 4), 1);
    await settle(150);
    pen("pointerup", box.left + 146, box.top + 108, 0);
    await settle(400);
    const drawnOnTwo = inkOn(2);

    // Tear out page 1. Everything on page 2 has to become page 2 - 1.
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(200);
    board.querySelector('[data-hw-action="delete-page"]').click();
    await settle(200);
    document.getElementById("confirmModalOkBtn").click();
    for (let i = 0; i < 60 && api.currentPdfPageCount() > added.doc - 1; i += 1) await settle(100);
    await settle(300);

    await api.flushPendingDeckAutosave();
    await settle(300);
    const entry = api.readLocalDeckIndex()[0];
    const snapshot = await api.readDeckSnapshot(entry.id);
    const savedInk = (snapshot.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    return {
      before, added, drawnOnTwo,
      afterMeta: api.state.meta.pdf.pages,
      afterDoc: api.currentPdfPageCount(),
      inkPage1: inkOn(1),
      inkPage2: inkOn(2),
      buried: Object.keys(api.state.meta.deletedHighlightIds || {}).length,
      savedInkPages: savedInk.map((r) => Number(r.page)),
      savedQuadPages: savedInk.flatMap((r) => (r.quads || []).map((q) => Number(q.page))),
      pageCount: entry.pageCount
    };
  }`);

  check("adding a page rewrites the document, not just the record of it",
    pages.added.meta === pages.before.meta + 1 && pages.added.doc === pages.before.doc + 1,
    `meta ${pages.before.meta}→${pages.added.meta}, pdf.js ${pages.before.doc}→${pages.added.doc}`);
  check("...and the ink already on the paper stays where it was",
    pages.added.inkPage1 === pages.before.inkPage1 && pages.before.inkPage1 > 0,
    `${pages.added.inkPage1} mark(s) still on page 1`);
  check("the pen writes on a page that did not exist a moment ago",
    pages.drawnOnTwo > 0, `${pages.drawnOnTwo} mark(s) on page 2`);
  check("tearing out a page shortens the document",
    pages.afterMeta === pages.added.meta - 1 && pages.afterDoc === pages.added.doc - 1,
    `meta ${pages.added.meta}→${pages.afterMeta}, pdf.js ${pages.added.doc}→${pages.afterDoc}`);
  check("...and what was on the torn-out page is buried", pages.buried > 0,
    `${pages.buried} tombstone(s)`);
  check("...while what was AFTER it is renumbered onto the page it is now on",
    pages.inkPage1 === pages.drawnOnTwo && pages.inkPage2 === 0,
    `${pages.inkPage1} mark(s) on page 1, ${pages.inkPage2} on page 2`);
  check("...quads included, which are what a paint and a Go-to resolve against",
    pages.savedQuadPages.length > 0 && pages.savedQuadPages.every((n) => n === 1),
    `quad pages: ${pages.savedQuadPages.join(", ") || "none"}`);
  check("the notebook survives a round trip through IndexedDB",
    pages.savedInkPages.length > 0 && pages.savedInkPages.every((n) => n === 1),
    `stored ink on page(s): ${pages.savedInkPages.join(", ") || "none"}`);
  check("...and the library row knows it is a notebook", pages.pageCount === pages.afterMeta,
    `pageCount = ${pages.pageCount}`);

  // ── 5. A markdown block, moved, and a second device ─────────────────────
  //
  // A block is a rectangle in PDF POINTS, for the reason a highlight is: a
  // position in the document survives a zoom and a second device, and a position
  // on the glass survives neither. So the assertions are about points, and the
  // drag is measured in pixels — which is the conversion that can be wrong, and
  // wrong in a direction, because PDF y runs up the page and the screen's runs
  // down.
  const blocks = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const board = document.getElementById("handwritingBoard");
    board.querySelector('[data-hw-action="add-block"]').click();
    await settle(400);
    const node = document.querySelector(".pdf-block");
    const id = node.dataset.pdfBlock;
    const first = { ...api.state.meta.pdfBlocks[0] };

    const area = node.querySelector(".pdf-block-edit");
    const editorOpen = Boolean(area && !area.hidden);
    if (area) area.value = "**Bernoulli** along a streamline";
    document.getElementById("documentView").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 8, pointerType: "mouse", isPrimary: true, clientX: 4, clientY: 4, buttons: 1 }));
    await settle(300);
    const typed = { ...api.state.meta.pdfBlocks[0] };
    const rendered = document.querySelector(".pdf-block-body")?.innerHTML.includes("<strong>");

    const drag = (target, from, to) => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "mouse", isPrimary: true, clientX: from.x, clientY: from.y, buttons: 1 }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: to.x, clientY: to.y, buttons: 1 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: to.x, clientY: to.y, buttons: 0 }));
    };
    const barBox = node.querySelector(".pdf-block-bar").getBoundingClientRect();
    // Right and DOWN the screen, which is right and DOWN the page — so x goes up
    // and y goes down in points. A sign error here reads as a block that runs
    // away from the finger.
    drag(node.querySelector(".pdf-block-bar"), { x: barBox.left + 4, y: barBox.top + 4 }, { x: barBox.left + 64, y: barBox.top + 48 });
    await settle(300);
    const moved = { ...api.state.meta.pdfBlocks[0] };

    const gripBox = node.querySelector(".pdf-block-grip").getBoundingClientRect();
    drag(node.querySelector(".pdf-block-grip"), { x: gripBox.left + 2, y: gripBox.top + 2 }, { x: gripBox.left + 54, y: gripBox.top + 40 });
    await settle(300);
    const sized = { ...api.state.meta.pdfBlocks[0] };

    await api.flushPendingDeckAutosave();
    await settle(300);
    const entry = api.readLocalDeckIndex()[0];
    const snapshot = await api.readDeckSnapshot(entry.id);
    const stored = (snapshot.meta.pdfBlocks || [])[0];

    // Two devices, one notebook: this one moved and typed into a block while the
    // other added one of its own. Neither may take the other's work.
    const other = {
      pdf: api.state.meta.pdf,
      pdfBlocks: [{ ...first, x: 999, y: 999, md: "stale", at: first.at - 5000 },
                  { id: "bk-other", page: 1, x: 30, y: 30, w: 120, h: 40, z: 0, md: "from elsewhere", at: Date.now() }]
    };
    const merged = api.mergeDeckMeta(other, api.state.meta, { prefer: "local" });
    return {
      editorOpen, rendered, md: typed.md,
      first: { x: first.x, y: first.y, w: first.w, h: first.h },
      moved: { x: moved.x, y: moved.y },
      sized: { x: sized.x, y: sized.y, w: sized.w, h: sized.h },
      stored: stored ? { x: stored.x, y: stored.y, w: stored.w, h: stored.h, md: stored.md } : null,
      mergedIds: (merged.pdfBlocks || []).map((b) => b.id).sort(),
      mergedMine: (merged.pdfBlocks || []).find((b) => b.id === id)?.x
    };
  }`);

  check("a markdown block can be added to a page and typed into",
    blocks.editorOpen && blocks.md === "**Bernoulli** along a streamline" && blocks.rendered,
    `editor=${blocks.editorOpen}, rendered as markdown=${blocks.rendered}`);
  check("...dragged, in the page's own points and in the right direction",
    blocks.moved.x > blocks.first.x && blocks.moved.y < blocks.first.y,
    `(${blocks.first.x}, ${blocks.first.y}) → (${blocks.moved.x}, ${blocks.moved.y}) — x up, y down the page`);
  check("...and resized", blocks.sized.w > blocks.first.w && blocks.sized.h > blocks.first.h,
    `${blocks.first.w}x${blocks.first.h} → ${blocks.sized.w}x${blocks.sized.h} points`);
  // Compared against the state AFTER the resize, and the y is the reason this is
  // worth spelling out: growing a block downward on the screen grows it downward
  // on the page, and because PDF y runs UP, that moves the origin down by exactly
  // the height gained. A resize that left y alone would be a block whose top edge
  // crept upward every time it was made taller.
  check("...and is where it was put after a round trip through the store",
    Boolean(blocks.stored) && blocks.stored.x === blocks.sized.x && blocks.stored.y === blocks.sized.y
      && blocks.stored.w === blocks.sized.w && blocks.stored.h === blocks.sized.h
      && blocks.stored.md === blocks.md,
    blocks.stored ? `(${blocks.stored.x}, ${blocks.stored.y}) ${blocks.stored.w}x${blocks.stored.h}` : "nothing stored");
  check("...with the top edge of the block held still as it grew taller",
    blocks.sized.y === blocks.moved.y - (blocks.sized.h - blocks.first.h),
    `y ${blocks.moved.y} → ${blocks.sized.y} as the height went ${blocks.first.h} → ${blocks.sized.h}`);
  check("a block added on the other device survives this one's push",
    blocks.mergedIds.includes("bk-other"), `merged: ${blocks.mergedIds.join(", ")}`);
  check("...and this device's newer copy wins over the other's older one",
    blocks.mergedMine === blocks.moved.x, `x = ${blocks.mergedMine}, this device had ${blocks.moved.x}`);
  // ── 5b. An older notebook, carried across ───────────────────────────────
  //
  // The conversion itself is arithmetic and is checked in tools/ink-check.mjs,
  // where it can be driven with no browser. What only a browser can answer is
  // whether the whole exchange is SAFE: whether a deck saved by the old build
  // still loads at all, whether opening it converts what is in it once and only
  // once, and whether what comes back out of the store afterwards is the same
  // handwriting.
  //
  // The first of those is the one that would have hurt most. A legacy notebook
  // has no cards, an empty note and no document, so a save predicate that does
  // not know about `meta.pages` calls it empty — and that predicate gates the
  // LOAD as well, which means the deck would have reported itself corrupted
  // with an afternoon of handwriting sitting intact in the file.
  const migrated = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    document.querySelector('#handwritingBoard [data-hw-action="close"]')?.click();
    await settle(200);

    // A deck exactly as the previous build wrote one: pages in meta, a typed box
    // on the second, no cards, no note, no document.
    //
    // The confirm is not optional. createNewDeck asks before replacing an open
    // deck, and a check that skips the answer does not get a new deck — it gets
    // the previous one, still open, and then writes this fixture's meta over it.
    // Which is what happened, and it read as a pass until the page count didn't
    // match.
    api.createNewDeck({ title: "An older notebook", notesMode: true });
    await settle(120);
    document.getElementById("confirmModalOkBtn")?.click();
    await settle(400);
    if (api.state.deckTitle !== "An older notebook") throw new Error("the fixture deck was not created: still on " + api.state.deckTitle);
    const ink = api.encodeInkStrokes([{ w: 2, c: "ink", p: [40, 40, 0.6, 300, 500, 0.5, 600, 900, 0.55] }]);
    api.state.notes = "";
    api.state.meta = {
      pages: [
        { id: "hp-one", order: 0, w: 794, h: 1123, paper: "ruled", ink, at: 1 },
        { id: "hp-two", order: 1, w: 794, h: 1123, paper: "ruled", ink: [], at: 1 }
      ],
      textBoxes: [{ id: "hb-one", page: "hp-two", x: 100, y: 200, w: 300, h: 120, z: 0, md: "**carried across**", at: 1 }],
      deletedPageIds: { "hp-gone": "2027-01-01T00:00:00.000Z" }
    };
    const saved = await api.saveDeckToLibrary({ silent: true });
    const entry = api.readLocalDeckIndex()[0];

    // Does a deck in the OLD shape still come back out of the store at all?
    // Through the door a person actually uses — My Decks — because that path
    // swallows a load failure and reports it in the status bar rather than
    // throwing, so a check that only watched for an exception would have called
    // the corrupted case a pass.
    const opened = await api.loadDeckFromLibrary(entry.id);
    await settle(300);
    const loadedPages = opened ? (api.state.meta?.pages || []).length : -1;
    const loadError = opened ? "" : (document.getElementById("statusText")?.textContent || "the open was refused");

    document.getElementById("handwritingBtn").click();
    for (let i = 0; i < 80 && !document.querySelector("#hwStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(400);

    const marks = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const first = { ...api.state.meta };
    const pdfPages = api.currentPdfPageCount();

    // Once and only once: closing and re-opening must not convert again.
    document.querySelector('#handwritingBoard [data-hw-action="close"]').click();
    await settle(300);
    document.getElementById("handwritingBtn").click();
    for (let i = 0; i < 80 && !document.querySelector("#hwStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(600);
    const marksAgain = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const pdfPagesAgain = api.currentPdfPageCount();

    await api.flushPendingDeckAutosave();
    await settle(400);
    const entry2 = api.readLocalDeckIndex()[0];
    const snapshot2 = await api.readDeckSnapshot(entry2.id);
    const storedInk = (snapshot2.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const strokes = storedInk.flatMap((r) => api.decodeInkStrokes(r.ink?.s || []));
    const ys = strokes.flatMap((st) => st.p.filter((_, i) => i % 3 === 1));

    // ...and a device that has NOT migrated pushing its legacy keys back.
    const stale = { pages: first.pages || [{ id: "hp-one", order: 0, ink: [], at: 1 }], pdf: first.pdf };
    const merged = api.mergeDeckMeta(stale, api.state.meta, { prefer: "local" });

    return {
      saved: Boolean(saved),
      loadError,
      loadedPages,
      notebook: Boolean(api.state.meta.pdf?.notebook),
      pdfPages,
      pdfPagesAgain,
      metaPages: api.state.meta.pdf?.pages,
      paper: api.state.meta.pdf?.paper,
      marks: marks.length,
      marksAgain: marksAgain.length,
      blocks: (api.state.meta.pdfBlocks || []).length,
      blockMd: (api.state.meta.pdfBlocks || [])[0]?.md,
      blockPage: (api.state.meta.pdfBlocks || [])[0]?.page,
      legacyLeft: ["pages", "textBoxes", "deletedPageIds", "deletedTextBoxIds"].filter((k) => k in api.state.meta),
      storedMarks: storedInk.length,
      storedPages: storedInk.map((r) => Number(r.page)),
      maxY: ys.length ? Math.max(...ys) : 0,
      mergedLegacy: ["pages", "textBoxes", "deletedPageIds", "deletedTextBoxIds"].filter((k) => k in merged),
      errs: window.__errs.slice(0, 4)
    };
  }`);

  check("a deck saved by the previous build still loads",
    migrated.saved && !migrated.loadError && migrated.loadedPages === 2,
    migrated.loadError ? `it reported: ${migrated.loadError}` : `${migrated.loadedPages} legacy page(s) read back`);
  check("opening it puts its pages onto real paper",
    migrated.notebook && migrated.pdfPages === 2 && migrated.metaPages === 2,
    `notebook=${migrated.notebook}, pdf.js ${migrated.pdfPages} page(s), meta ${migrated.metaPages}`);
  check("...keeping the paper it was written on", migrated.paper === "ruled", `paper = ${migrated.paper}`);
  check("...with the handwriting on it", migrated.marks === 1, `${migrated.marks} ink mark(s)`);
  check("...the right way up", migrated.maxY > 800,
    `the topmost point is at y=${migrated.maxY.toFixed(0)} of 842 — a flip would put it near 0`);
  check("...and the typed box on the page it was on",
    migrated.blocks === 1 && migrated.blockMd === "**carried across**" && migrated.blockPage === 2,
    `${migrated.blocks} block(s), page ${migrated.blockPage}`);
  check("the old keys are gone in the same step that added the new ones",
    migrated.legacyLeft.length === 0, `left behind: ${migrated.legacyLeft.join(", ") || "nothing"}`);
  check("...so opening it a second time converts nothing again",
    migrated.marksAgain === migrated.marks && migrated.pdfPagesAgain === migrated.pdfPages,
    `${migrated.marks} → ${migrated.marksAgain} ink mark(s), ${migrated.pdfPages} → ${migrated.pdfPagesAgain} page(s)`);
  check("what was converted is what comes back out of the store",
    migrated.storedMarks === 1 && migrated.storedPages.every((n) => n === 1),
    `${migrated.storedMarks} mark(s) on page(s) ${migrated.storedPages.join(", ")}`);
  check("...and a device that has not migrated cannot push the old keys back",
    migrated.mergedLegacy.length === 0, `merge kept: ${migrated.mergedLegacy.join(", ") || "nothing"}`);
  check("nothing threw while converting", migrated.errs.length === 0, migrated.errs.join(" | "));

  // ── 6. The drawing sheet's last mile ────────────────────────────────────
  const sheet = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    document.querySelector('#handwritingBoard [data-hw-action="close"]').click();
    await settle(200);
    api.setViewMode("notes");
    await settle(300);
    const ta = document.getElementById("notesEdit");
    api.insertInkDrawing(ta, 0);
    await settle(400);
    const shell = document.getElementById("inkSheet");
    const drawOn = (el) => {
      const box = el.getBoundingClientRect();
      pen(el, "pointerdown", box.left + 40, box.top + 40, 1);
      for (let i = 1; i <= 10; i += 1) pen(el, "pointermove", box.left + 40 + (i * 8), box.top + 40 + (i * 5), 1);
      pen(el, "pointerup", box.left + 120, box.top + 90, 0);
    };
    drawOn(shell.querySelector(".hw-page"));
    await settle(150);
    shell.querySelector('[data-ink-action="add-page"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9 }));
    await settle(300);
    const twoPages = shell.querySelectorAll(".hw-page").length;
    drawOn(shell.querySelectorAll(".hw-page")[1]);
    await settle(150);
    shell.querySelector(".ink-sheet-done").click();
    await settle(1400);
    // The file itself, before it goes anywhere: what colour are the strokes,
    // does it carry its own page, and does it still ask the OS anything?
    const svg = api.inkStrokesToSvg([{ w: 2, c: "ink", p: [0, 0, 0.5, 40, 20, 0.6, 90, 10, 0.5] }]);
    return {
      twoPages,
      closed: shell.hidden,
      images: ta.value.split("![](").length - 1,
      uploads: window.__stored.size,
      penColour: (svg.match(/\.p-ink\{fill:([^}]+)\}/) || [])[1] || "",
      hasPaper: svg.includes("<rect "),
      usesOsScheme: svg.includes("prefers-color-scheme"),
      errs: window.__errs.slice(0, 4)
    };
  }`, PEN_SRC);

  check("the drawing sheet takes a second page", sheet.twoPages === 2, `${sheet.twoPages} page(s)`);
  // The colour a drawing comes out as, asked with the operating system set to
  // LIGHT and the app on a dark theme — which is the ordinary case (seven of the
  // ten themes are dark, and a machine is usually left on light) and the one
  // that produced "the SVG drawings are always looking black". The file used to
  // carry two palettes with `prefers-color-scheme` between them, and that
  // question is answered by the OS, which knows nothing about the app's theme.
  check("a drawing is written in the colours the reader was actually looking at",
    sheet.penColour && sheet.penColour.toLowerCase() !== "#16181d",
    `strokes filled ${sheet.penColour} on a dark theme, OS set to light`);
  check("...and carries the paper it was drawn on, so it stays legible anywhere",
    sheet.hasPaper, `background rect present=${sheet.hasPaper}`);
  check("...and asks the operating system nothing", !sheet.usesOsScheme,
    sheet.usesOsScheme ? "the file still contains a prefers-color-scheme rule" : "no media query in the file");
  check("...and Done puts one picture per drawn page into the note",
    sheet.images === 2, `${sheet.images} image(s) in the note, ${sheet.uploads} file(s) uploaded`);
  check("...and closes", sheet.closed);
  check("nothing threw anywhere in this run", sheet.errs.length === 0, sheet.errs.join(" | "));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

if (failures) {
  console.log(`\nhandwriting-check: ${failures} failed`);
  process.exit(1);
}
console.log("\nhandwriting-check: the pen keeps writing through a pause, the lift does not blink, and a notebook keeps its pages");
