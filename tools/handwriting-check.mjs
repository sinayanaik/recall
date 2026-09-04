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
import { buildFixturePdf } from "./pdf-fixture.mjs";

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
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/images/outbox.js?v=__BUILD__",
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
    "/src/ui/ink-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/ui/theme.js?v=__BUILD__",
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
    const openWrite = async () => {
      // The Write TAB, beside Cards / Notes / Document — there is no ☰ row and no
      // full-page panel any more. A deck with no notebook opens it to the offer
      // of one, so the press below is the reader's "Start a notebook"; on a deck
      // that already has one there is no prompt and the click finds nothing.
      document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
      await settle(250);
      document.querySelector("#documentView .pdf-missing-pick")?.click();
      for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    };
    // Generating the paper, attaching it, and letting pdf.js lay it out. Longer
    // than a DOM settle because a real document is being opened.
    await openWrite();
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
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
      notebook: Boolean(api.state.meta.notebook),
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
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
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
    const page = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    return {
      wet: page.querySelectorAll(".is-ink-wet").length,
      tip: page.querySelectorAll(".is-ink-tip").length,
      dry: page.querySelectorAll(".is-ink-dry").length
    };
  }`);
  check("the low-latency layer comes off the page once the stroke is committed",
    mounted.wet === 0 && mounted.tip === 0,
    `${mounted.wet} live, ${mounted.tip} tip, ${mounted.dry} dry canvas(es) left mounted`);
  check("...leaving the dry canvas to be the thing on top", mounted.dry === 1,
    `${mounted.dry} dry canvas(es)`);
  // ── 2c. Is the whole stroke visible WHILE it is being drawn? ────────────
  //
  // "When I am writing, the tip of the stroke is visible, and when I release,
  // the rest of it then shows."
  //
  // Every check above reads the dry canvas, which only ever holds committed ink
  // — so all of them passed while the surface a reader actually looks at
  // mid-stroke showed a stub under the nib and nothing behind it. Two causes,
  // both of them live at once: a second desynchronized layer over the first, and
  // an append-only layer that assumed a low-latency swap chain preserves what
  // was drawn on it last frame.
  //
  // So this asks the question none of them could: with the pen still DOWN, is
  // there ink on the live layer near where the stroke STARTED? Not near the nib
  // — the nib is the half that never broke.
  const midStroke = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const view = document.getElementById("documentView");
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();

    // A long, slow stroke across the page, with a settle between runs so several
    // frames really do go by — the fault only shows once a frame boundary has
    // been crossed, because everything up to the first one is "the tip".
    const x0 = box.left + 40;
    const y0 = box.top + 420;
    pen(view, "pointerdown", x0, y0, 1);
    for (let i = 1; i <= 10; i += 1) pen(view, "pointermove", x0 + (i * 10), y0 + (i * 2), 1);
    await settle(120);
    for (let i = 11; i <= 30; i += 1) pen(view, "pointermove", x0 + (i * 10), y0 + (i * 2), 1);
    await settle(120);
    for (let i = 31; i <= 50; i += 1) pen(view, "pointermove", x0 + (i * 10), y0 + (i * 2), 1);
    await settle(200);

    // Still down. Count what is stacked over the page at this instant, and read
    // the live layer's own bitmap.
    const live = pageEl.querySelector(".pdf-ink-layer .is-ink-wet");
    const lowLatency = pageEl.querySelectorAll(".pdf-ink-layer .is-ink-wet, .pdf-ink-layer .is-ink-tip").length;
    const layers = pageEl.querySelectorAll(".pdf-ink-layer canvas").length;
    let head = 0;
    let tail = 0;
    let total = 0;
    if (live) {
      const ctx = live.getContext("2d");
      const px = ctx.getImageData(0, 0, live.width, live.height).data;
      const w = live.width;
      // The stroke runs left to right across the page. "head" is the third of
      // the canvas the stroke STARTED in, "tail" the third the nib is in now.
      for (let i = 3, p = 0; i < px.length; i += 4, p += 1) {
        if (px[i] <= 8) continue;
        total += 1;
        const x = p % w;
        if (x < w / 3) head += 1;
        else if (x > (w * 2) / 3) tail += 1;
      }
    }
    pen(view, "pointerup", x0 + 500, y0 + 100, 0);
    await settle(200);
    return { hasLive: Boolean(live), lowLatency, layers, head, tail, total, errs: window.__errs.slice(0, 4) };
  }`, PEN_SRC);

  check("the live layer is on the page while the pen is down",
    midStroke.hasLive && midStroke.total > 0,
    `live canvas present=${midStroke.hasLive}, ${midStroke.total} inked pixel(s)`);
  // ...and there is exactly ONE of it. This is the assertion that actually
  // catches the reported fault, and it is structural rather than a bitmap read
  // for a reason: the fault is a COMPOSITING one — desynchronized asks to be
  // taken out of the normal path, and on Chrome/Android that can mean promotion
  // to a hardware overlay plane, which does not blend with what is beneath it.
  // Headless Chrome does not promote and does preserve, so it renders the old
  // two-layer engine perfectly; the pixels below pass either way. What does not
  // pass either way is the count. Two low-latency layers stacked is the bug, on
  // any machine that promotes them, so the count is the thing to hold.
  check("...and it is the ONLY low-latency layer over the page",
    midStroke.lowLatency === 1 && midStroke.layers === 2,
    `${midStroke.lowLatency} low-latency canvas(es) and ${midStroke.layers} in total mid-stroke — `
      + `a plane over a plane hides the one beneath, which is "only the tip of the stroke is visible"`);
  check("...carrying the START of the stroke, not only the nib",
    midStroke.head > 0,
    `${midStroke.head} inked pixel(s) where the stroke began, ${midStroke.tail} under the nib `
      + `— zero at the head is exactly "only the tip is visible while writing"`);
  check("...and the line is continuous rather than a stub",
    midStroke.head > 0 && midStroke.tail > 0 && midStroke.total > midStroke.head + midStroke.tail,
    `head ${midStroke.head}, middle ${midStroke.total - midStroke.head - midStroke.tail}, nib ${midStroke.tail}`);
  check("...with nothing thrown mid-stroke", midStroke.errs.length === 0, midStroke.errs.join(" | "));

  // ── 2d. A stroke longer than the live layer's bound ─────────────────────
  //
  // Repainting the stroke whole every frame is what makes the live layer immune
  // to being hidden and to not being preserved, and it costs a fill over the
  // whole stroke. Past INK_LIVE_MAX_POINTS samples the engine hands everything
  // but the tail to the dry canvas and carries on with the rest, so the frame
  // cost stops growing.
  //
  // That hand-off is the one piece of new machinery here, and it has two ways to
  // be wrong that a reader would see: the stroke could commit in pieces, or the
  // line could break at the seam. A thousand samples in one gesture crosses the
  // bound comfortably.
  const longStroke = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const view = document.getElementById("documentView");
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    // Counted in SAMPLES, not in marks. pdf-ink.js joins strokes drawn in quick
    // succession into one mark (inkStrokesJoinMark), which is what it is for, so
    // "did a new mark appear" is a question about the grouping rule rather than
    // about the hand-off. How many samples reached the record is the question
    // this case is actually asking.
    const inkSamples = () => (api.state.meta.pdfHighlights || [])
      .filter((r) => r.kind === "ink")
      .reduce((n, r) => n + api.decodeInkStrokes(r.ink?.s || [])
        .reduce((m, stroke) => m + Math.floor((stroke.p || []).length / 3), 0), 0);
    const inkRuns = () => (api.state.meta.pdfHighlights || [])
      .filter((r) => r.kind === "ink")
      .reduce((n, r) => n + api.decodeInkStrokes(r.ink?.s || []).length, 0);
    // The runs already on this page, keyed by their own points, so the one this
    // gesture adds can be picked out afterwards. Measuring the bounds of ALL the
    // ink on the page would let an earlier stroke satisfy the assertion below.
    const decodedRuns = () => (api.state.meta.pdfHighlights || [])
      .filter((r) => r.kind === "ink")
      .flatMap((r) => api.decodeInkStrokes(r.ink?.s || []));
    const keysBefore = new Set(decodedRuns().map((run) => JSON.stringify(run.p)));
    const before = inkSamples();
    const runsBefore = inkRuns();

    // A long flat zig-zag inside the page, so a thousand samples stay on paper.
    const inkedOn = (canvas) => {
      if (!canvas) return 0;
      const px = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n += 1;
      return n;
    };
    const liveInk = () => inkedOn(pageEl.querySelector(".pdf-ink-layer .is-ink-wet"));

    const x0 = box.left + 30;
    const y0 = box.top + 120;
    const w = Math.max(60, box.width - 60);
    const stepTo = async (n, from) => {
      for (let i = from; i <= n; i += 1) {
        const t = i / 1000;
        pen(view, "pointermove", x0 + (w * t), y0 + (Math.sin(i / 6) * 24) + (t * 60), 1);
        // A settle every so often, so real frames run and the hand-off is
        // actually reached rather than everything arriving in one queue.
        if (i % 100 === 0) await settle(40);
      }
      await settle(120);
    };
    pen(view, "pointerdown", x0, y0, 1);
    // Read once BELOW the bound and once well above it. The live layer is
    // repainted whole every frame, so without the hand-off its ink grows with
    // the stroke without limit — which is the cost the bound exists to stop. A
    // fifth of the samples should not be carrying a fifth of the pixels once the
    // hand-off has run; past it the layer carries only the tail.
    await stepTo(200, 1);
    const liveEarly = liveInk();
    await stepTo(1000, 201);
    const liveLate = liveInk();
    const dryMid = inkedOn(pageEl.querySelector(".pdf-ink-layer .is-ink-dry"));

    pen(view, "pointerup", x0 + w, y0 + 60, 0);
    await settle(300);

    // Where the committed run actually reaches, in the page's own points, against
    // where the pen actually went. This is the question the sample COUNT cannot
    // answer: the stored format simplifies a stroke on the way in, so a thousand
    // samples legitimately come back as a few hundred — but a hand-off that lost
    // the front of the line shows as a stroke that starts halfway across.
    const fresh = decodedRuns().filter((run) => !keysBefore.has(JSON.stringify(run.p)));
    const bounds = api.inkStrokesBounds(fresh);
    const viewport = api.pdfPageViewport(1);
    const atX = (clientX) => (viewport ? viewport.convertToPdfPoint(clientX - box.left, 0)[0] : 0);
    return {
      dryMid,
      liveEarly,
      liveLate,
      samples: inkSamples() - before,
      runs: inkRuns() - runsBefore,
      drawnFrom: atX(x0),
      drawnTo: atX(x0 + w),
      inkFrom: bounds ? bounds.minX : 0,
      inkTo: bounds ? bounds.maxX : 0,
      errs: window.__errs.slice(0, 4)
    };
  }`, PEN_SRC);

  check("a stroke past the live layer's bound commits as ONE run, not several",
    longStroke.runs === 1,
    `the gesture added ${longStroke.runs} stroke(s) — the hand-off must not split what the reader drew`);
  // Not a sample count: the stored format simplifies on the way in, so a
  // thousand reported samples legitimately come back as a few hundred. What must
  // survive is the LINE — a hand-off that dropped the part it handed to the dry
  // canvas would commit a stroke that starts where the hand-off happened.
  check("...spanning the whole line the pen drew, head included",
    longStroke.inkFrom <= longStroke.drawnFrom + 12
      && longStroke.inkTo >= longStroke.drawnTo - 12,
    `the committed line runs ${longStroke.inkFrom.toFixed(0)}→${longStroke.inkTo.toFixed(0)} points `
      + `where the pen ran ${longStroke.drawnFrom.toFixed(0)}→${longStroke.drawnTo.toFixed(0)} `
      + `(${longStroke.samples} sample(s) after the format's own simplification)`);
  check("...and the live layer stops growing once the bound is passed",
    longStroke.liveLate > 0 && longStroke.liveLate < longStroke.liveEarly * 3,
    `the live layer held ${longStroke.liveEarly} inked pixel(s) at 200 samples and ${longStroke.liveLate} at 1000 `
      + `— growing in step with the stroke means the hand-off never ran, and the per-frame fill grows without limit`);
  check("...with the handed-over head painted on the dry canvas beneath it",
    longStroke.dryMid > 0,
    `${longStroke.dryMid} inked pixel(s) on the dry canvas mid-stroke`);
  check("...and nothing thrown by the hand-off", longStroke.errs.length === 0, longStroke.errs.join(" | "));

  check("the dry canvas has the finished stroke at the instant the pen lifts",
    handover.atLift > handover.before,
    `${handover.before} → ${handover.atLift} inked pixel(s) with no frame in between`);
  check("...and still has it a frame later", handover.after >= handover.atLift,
    `${handover.after} inked pixel(s)`);

  // ── 3. Does writing get slower the more you have written? ───────────────
  const cost = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
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
    // The page group is on the pen's RAIL now, not in the tab row: that row is a
    // nowrap line and five more controls in it clipped the tab labels mid-word.
    // Pressed with pointerdown, which is what the rail listens for.
    const board = document.getElementById("documentInkRail");
    const press = (sel) => board.querySelector(sel).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 31, cancelable: true }));
    const inkOn = (n) => (api.state.meta.pdfHighlights || [])
      .filter((r) => r.kind === "ink" && Number(r.page) === n).length;

    const before = { meta: api.state.meta.notebook.pages, doc: api.currentPdfPageCount(), inkPage1: inkOn(1) };

    press('[data-hw-action="add-page"]');
    for (let i = 0; i < 60 && api.currentPdfPageCount() < before.doc + 1; i += 1) await settle(100);
    const added = { meta: api.state.meta.notebook.pages, doc: api.currentPdfPageCount(), inkPage1: inkOn(1) };

    // Something on the NEW page, so the renumbering below has a record that has
    // to move and one that has to stay.
    api.scrollToDocumentPage(2, 0, { smooth: false });
    await api.whenDocumentPageReady(2);
    await settle(200);
    const two = document.querySelector("#documentStage .pdf-page[data-page-number='2']");
    const box = two.getBoundingClientRect();
    const view = document.getElementById("documentView");
    const pen = (t, x, y, b) => view.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 3, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, buttons: b, pressure: 0.6 }));
    pen("pointerdown", box.left + 50, box.top + 60, 1);
    for (let i = 1; i <= 12; i += 1) pen("pointermove", box.left + 50 + (i * 8), box.top + 60 + (i * 4), 1);
    await settle(150);
    pen("pointerup", box.left + 146, box.top + 108, 0);
    await settle(400);
    const drawnOnTwo = inkOn(2);

    // ── ...and a BLOCK on each page, which is the half that was missing ────
    //
    // Tearing a page out renumbered the highlights and stopped, so a text block
    // on the torn-out page survived onto whichever page inherited its number and
    // every block below the gap stayed one page too far down. One block on the
    // page about to go and one on the page that has to move, so the case can
    // tell a renumber from a bury.
    api.addDocumentBlock(2, { x: 120, y: 200 });
    api.commitBlockEdit();
    api.addDocumentBlock(1, { x: 120, y: 300 });
    api.commitBlockEdit();
    await settle(200);
    const blockOnPage = (n) => api.documentBlocks().filter((b) => Number(b.page) === n).length;
    const blocksBefore = { one: blockOnPage(1), two: blockOnPage(2) };
    const blockIdOnTwo = (api.documentBlocks().find((b) => Number(b.page) === 2) || {}).id;

    // Tear out page 1. Everything on page 2 has to become page 2 - 1.
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(200);
    // Tearing a page out is a ⋯ row now — a thing you do once a session does not
    // need to be on screen for the whole of it.
    document.querySelector('#documentMoreMenu [data-document-action="hw-tear-out"]').click();
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
      afterMeta: api.state.meta.notebook.pages,
      afterDoc: api.currentPdfPageCount(),
      inkPage1: inkOn(1),
      inkPage2: inkOn(2),
      buried: Object.keys(api.state.meta.deletedHighlightIds || {}).length,
      savedInkPages: savedInk.map((r) => Number(r.page)),
      savedQuadPages: savedInk.flatMap((r) => (r.quads || []).map((q) => Number(q.page))),
      pageCount: entry.pageCount,
      blocksBefore,
      blocksAfter: { one: blockOnPage(1), two: blockOnPage(2) },
      // The block that WAS on page 2 has to be alive and on page 1 now.
      movedBlockPage: Number((api.documentBlocks().find((b) => b.id === blockIdOnTwo) || {}).page || 0),
      blocksBuried: Object.keys(api.state.meta.deletedBlockIds || {}).length,
      savedBlockPages: (snapshot.meta.pdfBlocks || []).map((b) => Number(b.page))
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
  check("...and the blocks on the page go with it, exactly as the marks do",
    pages.blocksBefore.one === 1 && pages.blocksBefore.two === 1
      && pages.blocksAfter.one === 1 && pages.blocksAfter.two === 0
      && pages.movedBlockPage === 1,
    `blocks were ${JSON.stringify(pages.blocksBefore)}, are ${JSON.stringify(pages.blocksAfter)}, `
      + `the one from page 2 is on page ${pages.movedBlockPage}`);
  check("...with a tombstone for the one that was ON the torn-out page",
    pages.blocksBuried > 0, `${pages.blocksBuried} block tombstone(s)`);
  check("...and the saved snapshot says the same, not the page numbers it had",
    pages.savedBlockPages.length === 1 && pages.savedBlockPages[0] === 1,
    `saved block pages: ${JSON.stringify(pages.savedBlockPages)}`);
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
    const board = document.getElementById("documentInkRail");
    // Which ids existed BEFORE the press, so the one this case is about can be
    // named rather than assumed to be the only one. It used to reach for the
    // first .pdf-block in the DOM and the first record in the array — true only
    // while nothing else had ever put a block on this deck, and the tear-out
    // case above now deliberately leaves a survivor behind.
    const had = new Set((api.state.meta.pdfBlocks || []).map((b) => b.id));
    board.querySelector('[data-hw-action="add-block"]')
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 32, cancelable: true }));
    await settle(400);
    const record = (id) => ({ ...(api.state.meta.pdfBlocks || []).find((b) => b.id === id) });
    const id = (api.state.meta.pdfBlocks || []).map((b) => b.id).find((b) => !had.has(b));
    const node = document.querySelector('[data-pdf-block="' + id + '"]');
    const first = record(id);

    const area = node.querySelector(".pdf-block-edit");
    const editorOpen = Boolean(area && !area.hidden);
    if (area) area.value = "**Bernoulli** along a streamline";
    document.getElementById("documentView").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 8, pointerType: "mouse", isPrimary: true, clientX: 4, clientY: 4, buttons: 1 }));
    await settle(300);
    const typed = record(id);
    const rendered = node.querySelector(".pdf-block-body")?.innerHTML.includes("<strong>");

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
    const moved = record(id);

    const gripBox = node.querySelector(".pdf-block-grip").getBoundingClientRect();
    drag(node.querySelector(".pdf-block-grip"), { x: gripBox.left + 2, y: gripBox.top + 2 }, { x: gripBox.left + 54, y: gripBox.top + 40 });
    await settle(300);
    const sized = record(id);

    await api.flushPendingDeckAutosave();
    await settle(300);
    const entry = api.readLocalDeckIndex()[0];
    const snapshot = await api.readDeckSnapshot(entry.id);
    const stored = (snapshot.meta.pdfBlocks || []).find((b) => b.id === id);

    // Two devices, one notebook: this one moved and typed into a block while the
    // other added one of its own. Neither may take the other's work.
    const other = {
      notebook: api.state.meta.notebook,
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
    api.setViewMode("notes");
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

    const openWrite = async () => {
      // The Write TAB, beside Cards / Notes / Document — there is no ☰ row and no
      // full-page panel any more. A deck with no notebook opens it to the offer
      // of one, so the press below is the reader's "Start a notebook"; on a deck
      // that already has one there is no prompt and the click finds nothing.
      document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
      await settle(250);
      document.querySelector("#documentView .pdf-missing-pick")?.click();
      for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    };
    await openWrite();
    await settle(400);

    const marks = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const first = { ...api.state.meta };
    const pdfPages = api.currentPdfPageCount();

    // Once and only once: closing and re-opening must not convert again.
    api.setViewMode("notes");
    await settle(300);
    await openWrite();
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
    const stale = { pages: first.pages || [{ id: "hp-one", order: 0, ink: [], at: 1 }], notebook: first.notebook };
    const merged = api.mergeDeckMeta(stale, api.state.meta, { prefer: "local" });

    return {
      saved: Boolean(saved),
      loadError,
      loadedPages,
      notebook: Boolean(api.state.meta.notebook),
      pdfPages,
      pdfPagesAgain,
      metaPages: api.state.meta.notebook?.pages,
      paper: api.state.meta.notebook?.paper,
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
    api.setViewMode("notes");
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
  // ── 7. A paper to read AND pages to write on, on one deck ───────────────
  //
  // The report this exists for: "if a deck already had a pdf then if I'm open on
  // Handwritten notes it says it already has pdf". It did — one deck, one
  // document slot, and somebody else's paper was in it — so the app refused, and
  // a reader marking up a preprint had nowhere to work.
  //
  // What has to be true now is not just that it stops refusing. The two
  // documents have to be genuinely separate: separate files with their own page
  // counts, and separate marks, so that a stroke made on notebook page 1 never
  // appears on page 1 of somebody's preprint — which is exactly what one array
  // of highlights shared by both would do if the `doc` field were not honoured.
  const both = await page.evaluate(`async (bytes, penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    api.setViewMode("notes");
    await settle(150);
    // The confirm is not optional — see the migration block above, which learned
    // this the expensive way: without the press this is the PREVIOUS deck, and
    // every assertion below is then made about a notebook that was already there.
    api.createNewDeck({ title: "A paper and a notebook", notesMode: true });
    await settle(150);
    document.getElementById("confirmModalOkBtn")?.click();
    await settle(400);
    if (api.state.deckTitle !== "A paper and a notebook") throw new Error("the fixture deck was not created: still on " + api.state.deckTitle);

    const file = new File([new Uint8Array(bytes)], "preprint.pdf", { type: "application/pdf" });
    const attached = await api.attachPdfToOpenDeck(file);
    api.setViewMode("document");
    for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page[data-page-number='1'] canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(400);
    const paperPages = api.currentPdfPageCount();

    // "Attached" and "Saved here" both raise a toast, and a toast is a
    // fixed-position box in the top corner — elementFromPoint finds IT, the pen
    // never lands on a page, and the stroke this case is about is never made.
    // Waited out rather than pressed around, because where the toast sits is not
    // this check's business.
    const untoasted = async () => {
      for (let i = 0; i < 60 && document.querySelector(".toast"); i += 1) await settle(100);
    };
    const scribble = async (n) => {
      await untoasted();
      const view = document.getElementById("documentView");
      const box = document.querySelector("#documentStage .pdf-page[data-page-number='" + n + "']").getBoundingClientRect();
      pen(view, "pointerdown", box.left + 60, box.top + 120, 1);
      for (let i = 1; i <= 12; i += 1) pen(view, "pointermove", box.left + 60 + (i * 7), box.top + 120 + (i * 3), 1);
      await settle(120);
      pen(view, "pointerup", box.left + 144, box.top + 156, 0);
      await settle(200);
    };
    await scribble(1);
    const onPaper = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink").length;

    // ...and now the Write tab, on the same deck. There is no toast and no
    // refusal: it opens to the offer of a notebook and one press makes it.
    document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
    await settle(300);
    const offered = document.querySelector("#documentView .pdf-missing-pick")?.textContent || "";
    document.querySelector("#documentView .pdf-missing-pick")?.click();
    for (let i = 0; i < 80 && api.currentPdfPageCount() !== 1; i += 1) await settle(100);
    await settle(300);
    const notebookPages = api.currentPdfPageCount();
    await scribble(1);

    const ink = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink");
    const mine = ink.filter((r) => r.doc === "notebook").length;
    const theirs = ink.filter((r) => !r.doc).length;

    // What each surface SHOWS, which is the half a doc field on the record does
    // not settle on its own.
    const paintedNow = document.querySelectorAll("#documentStage .pdf-ink-layer .is-ink-dry").length;
    api.setViewMode("document");
    for (let i = 0; i < 80 && api.currentPdfPageCount() !== paperPages; i += 1) await settle(100);
    await settle(400);
    // Ink only. The fixture PDF carries annotations of its own, which attaching
    // it imports as highlights — real, wanted, and not what this is asking about.
    const inkHere = () => api.documentHighlights().filter((r) => r.kind === "ink").length;
    const backOnPaper = { pages: api.currentPdfPageCount(), marks: inkHere() };
    api.setViewMode("handwriting");
    for (let i = 0; i < 80 && api.currentPdfPageCount() !== 1; i += 1) await settle(100);
    await settle(400);
    const backOnNotebook = { pages: api.currentPdfPageCount(), marks: inkHere() };

    // ── Does drawing move the stamp the sync pushes on? ───────────────────
    //
    // The end of the pipe deckContentMatches sits in the middle of. A stroke is
    // saved on the device either way; what decides whether it is ever SENT is
    // whether the library index entry advances its updatedAt, because the push
    // gate is updatedAt > lastSyncedAt. Read off the real index, twice, either
    // side of one more scribble.
    const entryNow = () => api.readLocalDeckIndex().find((e) => e.id === api.state.localDeckId);
    await api.flushPendingDeckAutosave();
    const stampBefore = entryNow()?.updatedAt || "";
    // A stamp is monotonic but has millisecond resolution, so a draw in the same
    // millisecond as the previous save would be indistinguishable from no draw
    // at all — a false PASS. Waited out rather than argued about.
    await settle(1100);
    await scribble(1);
    await api.flushPendingDeckAutosave();
    const stampAfter = entryNow()?.updatedAt || "";
    // ...and a save that draws nothing must NOT move it, or every deck in the
    // library pushes on every autosave for ever.
    await settle(1100);
    await api.saveDeckToLibrary({ silent: true });
    const stampIdle = entryNow()?.updatedAt || "";

    return {
      attached, offered, paperPages, notebookPages, onPaper, mine, theirs, paintedNow,
      hasPdf: Boolean(api.state.meta.pdf), hasNotebook: Boolean(api.state.meta.notebook),
      backOnPaper, backOnNotebook,
      stampBefore, stampAfter, stampIdle,
      errs: window.__errs.slice(0, 4)
    };
  }`, Array.from(buildFixturePdf({ pages: 3 }).bytes), PEN_SRC);

  check("a deck that already has a PDF is offered a notebook, not a refusal",
    both.hasPdf && both.hasNotebook && /notebook/i.test(both.offered),
    `pdf=${both.hasPdf}, notebook=${both.hasNotebook}, the surface offered "${both.offered}"`);
  check("...and the two are different documents, with their own page counts",
    both.paperPages === 3 && both.notebookPages === 1,
    `the paper has ${both.paperPages} page(s), the notebook ${both.notebookPages}`);
  check("...and a mark says which of them it is on",
    both.onPaper === 1 && both.theirs === 1 && both.mine === 1,
    `${both.theirs} on the paper, ${both.mine} in the notebook`);
  check("...so neither surface shows the other's handwriting",
    both.backOnPaper.marks === 1 && both.backOnNotebook.marks === 1
      && both.backOnPaper.pages === 3 && both.backOnNotebook.pages === 1,
    `Document: ${both.backOnPaper.marks} mark(s) over ${both.backOnPaper.pages} page(s); `
    + `Write: ${both.backOnNotebook.marks} over ${both.backOnNotebook.pages}`);
  check("...with nothing thrown while both were open", both.errs.length === 0, both.errs.join(" | "));

  // The reported sync failure, end to end: "there's a sync issue even if I'm
  // drawing something in device A and sync the same is not being reflected in
  // multi device."
  //
  // Nothing was wrong with the merge — a stroke that reaches the cloud arrives
  // intact, and section 5 proves it. What was wrong is that it never left. A
  // stroke changes meta.pdfHighlights and nothing else: no cards, no notes body
  // (the pages ARE the deck), no page count, no hash. deckContentMatches
  // (src/library/local-library.js) read none of that array, so the save was a
  // no-op as far as updatedAt was concerned, and a deck whose updatedAt has not
  // moved is one the push gate never fires for. Stored for ever, sent never,
  // with no error to notice.
  check("drawing moves the stamp the push gate reads",
    Boolean(both.stampAfter) && both.stampAfter > both.stampBefore,
    `updatedAt was ${both.stampBefore || "(none)"} and is ${both.stampAfter || "(none)"} — `
    + "equal means the stroke would never be pushed to another device");
  check("...and a save that changed nothing leaves it alone",
    both.stampIdle === both.stampAfter,
    `an idle save moved updatedAt from ${both.stampAfter} to ${both.stampIdle} — every deck would push on every save`);

  // ── 8. Ink that follows the theme ───────────────────────────────────────
  //
  // "I've written something in white in dark theme and it gets disappeared in
  // light theme." A stroke stores a pen TOKEN and the token resolves per theme,
  // so this was never a storage fault — but the dry canvas is a BITMAP, and it
  // held the colour the stroke had been painted in. Nothing cleared the colour
  // cache on a theme change and nothing repainted the canvases, so the ink
  // stayed near-white on a page that had just become white.
  //
  // Read off the canvas's own pixels, because that is the thing that was wrong.
  const themed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const dry = document.querySelector("#documentStage .pdf-ink-layer .is-ink-dry");
    // The brightness of the ink itself: the darkest pixel the stroke put down,
    // ignoring everything transparent around it.
    const darkest = () => {
      const px = dry.getContext("2d").getImageData(0, 0, dry.width, dry.height).data;
      let best = 255;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 200) continue;
        const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
        if (lum < best) best = lum;
      }
      return best;
    };
    api.setTheme("dark-amoled");
    await settle(400);
    const onDark = darkest();
    api.setTheme("light-paper");
    await settle(400);
    const onLight = darkest();
    // ...and the paper under it, which is the other half: a notebook page is a
    // white PDF page, so on a dark theme a near-white pen on it would be
    // invisible before any theme was ever switched.
    api.setTheme("dark-amoled");
    await settle(400);
    const darkPaper = document.getElementById("documentStage").classList.contains("is-pdf-inverted");
    api.setTheme("light-paper");
    await settle(400);
    const lightPaper = document.getElementById("documentStage").classList.contains("is-pdf-inverted");
    return { onDark, onLight, darkPaper, lightPaper, errs: window.__errs.slice(0, 4) };
  }`);

  check("ink drawn on a dark theme is repainted dark when the theme goes light",
    themed.onLight < 120 && themed.onDark > 160,
    `darkest inked pixel: ${themed.onDark.toFixed(0)} on dark, ${themed.onLight.toFixed(0)} on light`);
  check("...and the paper under it follows the theme too",
    themed.darkPaper && !themed.lightPaper,
    `dark page on a dark theme=${themed.darkPaper}, on a light theme=${themed.lightPaper}`);
  check("...with nothing thrown by the switch", themed.errs.length === 0, themed.errs.join(" | "));

  // ── 9. A picture on the page ────────────────────────────────────────────
  //
  // "the handwritten note is something like one note where in a canvas multiple
  // things can be there like markdown blocks, handwritten strokes, images". A
  // picture is a block with a kind, so it inherits the geometry, the drag, the
  // resize, the tombstone and the merge the text blocks already have — and what
  // is worth asserting is the part that is NOT inherited: that it survives the
  // round trip through the store as a picture rather than as a paragraph.
  const picture = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const page = api.currentDocumentPage();
    // A 2x1 PNG, so the block is sized from a real aspect ratio rather than a
    // fallback.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8//8/AzJgYkAFAB8FAv3EhrhCAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
    const file = new File([png], "board.png", { type: "image/png" });
    let failed = "";
    let added = null;
    try {
      added = await api.addDocumentImageBlock(page, file, { x: 120, y: 500 });
    } catch (error) {
      failed = String(error?.message || error);
    }
    await settle(300);
    if (!added) {
      return { added: false, failed: failed || "addDocumentImageBlock returned nothing", errs: window.__errs.slice(0, 4) };
    }
    const node = document.querySelector('.pdf-block[data-pdf-block-kind="image"]');
    const img = node?.querySelector("img.pdf-block-img");
    const wide = added.w > added.h;

    // Resized by its own grip, in the page's own points.
    const grip = node.querySelector(".pdf-block-grip");
    const box = grip.getBoundingClientRect();
    const at = (t, x, y, b) => grip.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 21, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, buttons: b }));
    at("pointerdown", box.left + 4, box.top + 4, 1);
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 21, clientX: box.left + 44, clientY: box.top + 34, buttons: 1 }));
    await settle(120);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 21, clientX: box.left + 44, clientY: box.top + 34, buttons: 0 }));
    await settle(250);
    const sized = api.documentBlocks().find((b) => b.id === added.id);

    await api.flushPendingDeckAutosave();
    await settle(400);
    const entry = api.readLocalDeckIndex().find((row) => row.title === "A paper and a notebook");
    const snapshot = await api.readDeckSnapshot(entry.id);
    const stored = (snapshot.meta.pdfBlocks || []).find((b) => b.id === added.id);

    return {
      added: Boolean(added), wide,
      mounted: Boolean(img && img.getAttribute("src")),
      grew: sized ? sized.w > added.w : false,
      stored: stored ? { kind: stored.kind, hasSrc: Boolean(stored.src), doc: stored.doc, w: stored.w } : null,
      errs: window.__errs.slice(0, 4)
    };
  }`);

  check("an image dropped on a page becomes a block of its own",
    picture.added && picture.mounted,
    `added=${picture.added}${picture.failed ? ` — ${picture.failed}` : ""}, <img> on the page=${picture.mounted}`);
  check("...sized from the picture's own shape rather than a paragraph's",
    picture.wide, "a 2:1 image came out wider than it is tall");
  check("...and can be dragged out by its grip", picture.grew,
    `${picture.stored ? picture.stored.w : "?"} points wide after the drag`);
  check("...and comes back out of the store as a picture, on the notebook's pages",
    picture.stored?.kind === "image" && picture.stored?.hasSrc && picture.stored?.doc === "notebook",
    JSON.stringify(picture.stored));
  // ── ...and the same picture, added with no connection ───────────────────
  //
  // The report: an image on a page of handwriting showed on the tablet it was
  // added on and nowhere else. Not a rendering fault — a reference one.
  //
  // storeImageOrQueue parks the bytes in this device's outbox and hands back a
  // recall-img token when it cannot upload, which is right. The pass that later
  // uploads them then rewrites every reference to the real URL —
  // rewriteLocalImageReferences — and that pass looked in the notes and in the
  // cards and stopped. A block keeps its picture in a RECORD, in its own `src`
  // field, so the token was never settled: on every other device that is an
  // image whose bytes live in one browser's IndexedDB, permanently, because the
  // upload that would have fixed it had already happened.
  //
  // The queueing half is driven through the real offline branch
  // (navigator.onLine, which is what uploadImageToSupabase asks). The settling
  // half is driven by handing rewriteLocalImageReferences the token->url map,
  // which is exactly and only what flushPendingImageUploads does once an upload
  // succeeds — deliberately, so this case is about the rewrite that was wrong
  // rather than about this harness's stubbed bucket.
  const offlinePicture = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")
      || Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });

    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8//8/AzJgYkAFAB8FAv3EhrhCAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
    const file = new File([png], "whiteboard.png", { type: "image/png" });
    const added = await api.addDocumentImageBlock(api.currentDocumentPage() || 1, file, { x: 140, y: 420 });
    await settle(300);
    if (onLine) Object.defineProperty(navigator, "onLine", onLine);
    const srcWhileOffline = api.documentBlocks().find((b) => b.id === (added || {}).id)?.src || "";
    const token = srcWhileOffline.startsWith("recall-img:") ? srcWhileOffline.slice("recall-img:".length) : "";

    const url = "https://fixture.supabase.co/storage/v1/object/public/images/u1/decks/x/whiteboard.png";
    if (token) await api.rewriteLocalImageReferences(new Map([[token, url]]));
    await settle(300);
    const settled = api.documentBlocks().find((b) => b.id === (added || {}).id)?.src || "";

    await api.flushPendingDeckAutosave();
    await settle(400);
    const entry = api.readLocalDeckIndex().find((row) => row.title === "A paper and a notebook");
    const snapshot = await api.readDeckSnapshot(entry.id);
    const stored = (snapshot.meta.pdfBlocks || []).find((b) => b.id === (added || {}).id);
    // Scoped to the token that was actually settled, not to "any token at all":
    // earlier cases in this file queue images that this harness's stubbed bucket
    // can never confirm, so the saved bag legitimately still holds theirs.
    const tokensLeft = Boolean(token)
      && JSON.stringify(snapshot.meta.pdfBlocks || []).includes("recall-img:" + token);

    return {
      added: Boolean(added),
      queued: Boolean(token),
      settled,
      storedSrc: (stored || {}).src || "",
      tokensLeft,
      errs: window.__errs.slice(0, 4)
    };
  }`);

  check("an image added with no connection is parked under a local token",
    offlinePicture.added && offlinePicture.queued,
    `added=${offlinePicture.added}, parked under a token=${offlinePicture.queued}`);
  check("...and the upload that follows rewrites the BLOCK, not only the notes",
    offlinePicture.settled.startsWith("http"),
    `the block still points at "${offlinePicture.settled}" — on any other device that is a picture with no bytes`);
  check("...in the saved snapshot too, which is what the other device is handed",
    offlinePicture.storedSrc.startsWith("http") && !offlinePicture.tokensLeft,
    `stored src "${offlinePicture.storedSrc}", this image's token still in the saved bag=${offlinePicture.tokensLeft}`);

  // ── 10. The four faults reported off a phone ────────────────────────────
  //
  // Every one of these was true of a shipped build, and three of them were
  // invisible to every check in this file because the checks drove the app
  // through its API rather than through what a reader can actually see.
  const reported = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const boxed = (node) => {
      const box = node?.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.height > 0);
    };

    // (a) THE PEN RAIL, on a deck whose only document is a notebook.
    //
    // #documentStage.has-no-document is written from !meta.pdf alone, and it
    // carried "display: none" for the rail. So on precisely this deck — the
    // common one, a notebook and nothing else — pressing the pen armed it, lit
    // its button, and showed nothing: no colour, no nib, no eraser, no lasso, no
    // undo. And a mouse could not draw at all, because arming is the only way a
    // mouse says it meant ink.
    api.setViewMode("handwriting");
    for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(400);
    const rail = document.getElementById("documentInkRail");
    const railOnArrival = boxed(rail);
    const pens = rail.querySelectorAll("[data-ink-pen]").length;
    const nibs = rail.querySelectorAll("[data-ink-width]").length;
    const lasso = boxed(rail.querySelector('[data-ink-tool="lasso"]'));
    const armedForMouse = api.isInkArmed();

    // ...and closing it is remembered, rather than re-opened on the next visit.
    document.getElementById("documentInkBtn").click();
    await settle(200);
    const shut = !boxed(rail);
    api.setViewMode("notes");
    await settle(300);
    api.setViewMode("handwriting");
    for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(400);
    const stayedShut = !boxed(rail);
    document.getElementById("documentInkBtn").click();
    await settle(300);

    // (b) DARK PAGE, which has no business on paper that follows the theme.
    const darkShown = boxed(document.getElementById("documentDarkBtn"));
    const invertedBefore = document.getElementById("documentStage").classList.contains("is-pdf-inverted");
    api.togglePdfInvert();
    await settle(200);
    const invertedAfter = document.getElementById("documentStage").classList.contains("is-pdf-inverted");

    // (c) SELECT, DRAG AND RESIZE — all three already existed and all three were
    // behind the rail nobody could open. A lasso round a stroke gives a dashed
    // box with a corner grip: inside it drags, on it scales.
    const view = document.getElementById("documentView");
    const box = document.querySelector("#documentStage .pdf-page[data-page-number='1']").getBoundingClientRect();
    for (let i = 0; i < 60 && document.querySelector(".toast"); i += 1) await settle(100);
    pen(view, "pointerdown", box.left + 80, box.top + 260, 1);
    for (let i = 1; i <= 12; i += 1) pen(view, "pointermove", box.left + 80 + (i * 6), box.top + 260 + (i * 3), 1);
    await settle(120);
    pen(view, "pointerup", box.left + 152, box.top + 296, 0);
    await settle(250);
    const drawn = api.inkPageHasStrokes(1);

    rail.querySelector('[data-ink-tool="lasso"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 41, cancelable: true }));
    await settle(150);
    pen(view, "pointerdown", box.left + 60, box.top + 240, 1);
    [[220, 240], [220, 320], [40, 320], [40, 240]].forEach(([dx, dy]) => pen(view, "pointermove", box.left + dx, box.top + dy, 1));
    await settle(120);
    pen(view, "pointerup", box.left + 60, box.top + 240, 0);
    await settle(250);
    const selected = api.inkSelectionCount();
    const selectionTools = boxed(document.getElementById("inkRailSelection"));

    return {
      railOnArrival, pens, nibs, lasso, armedForMouse, shut, stayedShut,
      darkShown, invertedBefore, invertedAfter,
      drawn, selected, selectionTools,
      errs: window.__errs.slice(0, 4)
    };
  }`, PEN_SRC);

  check("the pen's rail is on the page when a notebook opens",
    reported.railOnArrival, `rail has a box=${reported.railOnArrival}`);
  check("...with the colours, the nibs and the lasso on it",
    reported.pens >= 5 && reported.nibs >= 4 && reported.lasso,
    `${reported.pens} pen(s) · ${reported.nibs} nib(s) · lasso=${reported.lasso}`);
  check("...and armed, which is the only way a mouse can draw at all",
    reported.armedForMouse, `armed=${reported.armedForMouse}`);
  check("...and closing it is remembered rather than undone on the way back",
    reported.shut && reported.stayedShut,
    `shut=${reported.shut}, still shut after a tab round-trip=${reported.stayedShut}`);
  check("dark page is not offered on paper that follows the theme",
    !reported.darkShown, `the ◐ button has a box=${reported.darkShown}`);
  check("...and cannot be reached round the back of the missing button either",
    reported.invertedBefore === reported.invertedAfter,
    `togglePdfInvert took the page from ${reported.invertedBefore} to ${reported.invertedAfter}`);
  check("a lasso selects the strokes it was drawn round",
    reported.drawn && reported.selected > 0,
    `${reported.selected} stroke(s) selected`);
  check("...and offers what can be done with them", reported.selectionTools,
    `the selection group has a box=${reported.selectionTools}`);
  check("nothing threw while the reported faults were exercised",
    reported.errs.length === 0, reported.errs.join(" | "));

  // ── 11. Paper that reads as paper ───────────────────────────────────────
  //
  // "The grids in the pages are not properly styled." A4 is 595pt and a portrait
  // phone is ~390px, so the page is laid out at about 63%: a 5mm square lands at
  // 10px with a 0.5pt line drawn at a third of a pixel, and that is a grey wash
  // rather than a grid. Squared paper solves this the way squared paper has
  // always solved it — a heavier line every fourth square — and that is what
  // this asks of the rendered page rather than of the source that drew it.
  //
  // Read off one scanline across the middle of the page. The paper is the
  // brightest value on it; every dip below that is a vertical rule, and the
  // question is whether some of those dips are decisively deeper than the rest.
  const paper = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("handwriting");
    for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    await settle(400);
    const canvas = document.querySelector("#documentStage .pdf-page[data-page-number='1'] canvas.pdf-canvas");
    if (!canvas) return { lines: 0 };
    const y = Math.floor(canvas.height / 2);
    const row = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, y, canvas.width, 1).data;
    const lum = [];
    for (let i = 0; i < row.length; i += 4) lum.push((row[i] + row[i + 1] + row[i + 2]) / 3);
    const sheet = Math.max(...lum);
    // One depth per run of pixels below the paper — the deepest pixel of each,
    // so an antialiased line is measured by its core rather than by its edge.
    const depths = [];
    let run = 0;
    for (let i = 0; i < lum.length; i += 1) {
      const dip = sheet - lum[i];
      if (dip > 3) { run = Math.max(run, dip); continue; }
      if (run) { depths.push(run); run = 0; }
    }
    if (run) depths.push(run);
    depths.sort((a, b) => a - b);
    const at = (q) => depths[Math.min(depths.length - 1, Math.floor(depths.length * q))] || 0;
    return {
      lines: depths.length,
      sheet: Math.round(sheet),
      // The minor lines are most of them; the major ones are the deepest quarter.
      minor: Math.round(at(0.4)),
      major: Math.round(at(0.95))
    };
  }`);

  // Enough rules across a page for it to be squared paper at all — 595pt at a
  // 16pt pitch is ~36, and the scanline sees every one it is wide enough to.
  check("a grid page is drawn as squared paper, not as a texture",
    paper.lines >= 20, `${paper.lines} rule(s) across the page`);
  // Both readings matter and only one can be measured: an invert preserves the
  // arithmetic difference, so this number is the same on a dark theme — what
  // changes is how much of it the eye gets, which is why the floor is set where
  // it is rather than at the smallest visible step.
  check("...with a minor rule that is actually there",
    paper.minor >= 20, `the minor rules sit ${paper.minor} below the paper's ${paper.sheet}`);
  check("...and a heavier one every fourth square, which is what makes it legible small",
    paper.major >= paper.minor * 1.5,
    `major ${paper.major} vs minor ${paper.minor}`);

  // ── The rail and the pager, at every width ──────────────────────────────
  //
  // Reported off a tablet: "the edit options and the page indicators are
  // clashing". Both used to be absolutely positioned at the foot of the stage on
  // the same z-index, and the rail WRAPS — so the wider it grows, the further it
  // reaches into the pager's corner.
  //
  // There was a fix and it was `@media (max-width: 720px)`, which is to say it
  // covered a phone and nothing else. A tablet is the width where the rail has
  // room to wrap into a long band AND the pager is still in the corner, which is
  // exactly why that is the device it was reported from.
  //
  // So this asks the question at three widths rather than at the one the old fix
  // had thought about, and it asks it geometrically: do the two boxes intersect?
  // A rule that moves one of them by the wrong amount still fails.
  const railWidths = [];
  for (const [label, width, height] of [["phone", 390, 844], ["tablet", 1024, 768], ["desktop", 1440, 900]]) {
    await page.call("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width <= 720
    });
    railWidths.push(await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      // Open, which is the state that can collide — and the state a notebook
      // starts in (RAIL_OPEN_DEFAULT).
      api.toggleInkRail(true);
      await settle(250);
      const rail = document.getElementById("documentInkRail");
      const pager = document.getElementById("documentPager");
      const box = (node) => {
        const r = node?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0
          ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height }
          : null;
      };
      const scroller = document.getElementById("documentView");
      const topOf = (n) => {
        const el = document.querySelector("#documentStage .pdf-page[data-page-number='" + n + "']");
        return el ? el.getBoundingClientRect().top : null;
      };
      // At rest, and then after a JUMP. The two are different questions and only
      // the first is answered by the scroller's padding: a jump lands the page
      // flush with the scroller's own top edge, which is under the rail, so
      // "go to page N and write on it" put the first line under the controls and
      // a pen press meant for the paper hit the rail. See scrollerTopInset.
      // Genuinely at rest: the previous width's iteration ends on a jump, and a
      // jump leaves the scroller wherever it landed.
      if (scroller) scroller.scrollTop = 0;
      await settle(150);
      const atRest = { top: topOf(1), scrollTop: scroller ? scroller.scrollTop : null };
      const last = api.currentPdfPageCount ? api.currentPdfPageCount() : 1;
      api.scrollToDocumentPage(last, 0, { smooth: false });
      await settle(400);
      const afterJump = topOf(last);
      api.scrollToDocumentPage(1, 0, { smooth: false });
      await settle(300);
      return { rail: box(rail), pager: box(pager), atRest, afterJump, last };
    }`));
  }

  ["phone", "tablet", "desktop"].forEach((label, i) => {
    const { rail, pager } = railWidths[i];
    const overlap = Boolean(rail && pager)
      && rail.left < pager.right && rail.right > pager.left
      && rail.top < pager.bottom && rail.bottom > pager.top;
    check(`the pen's rail and the page indicator do not overlap on a ${label}`,
      Boolean(rail) && Boolean(pager) && !overlap,
      rail && pager
        ? `rail ${rail.left.toFixed(0)},${rail.top.toFixed(0)}→${rail.right.toFixed(0)},${rail.bottom.toFixed(0)} `
          + `vs pager ${pager.left.toFixed(0)},${pager.top.toFixed(0)}→${pager.right.toFixed(0)},${pager.bottom.toFixed(0)}`
        : `rail box=${Boolean(rail)}, pager box=${Boolean(pager)}`);
  });

  ["phone", "tablet", "desktop"].forEach((label, i) => {
    const { rail, atRest } = railWidths[i];
    check(`...and the first line of the page is not under it on a ${label}`,
      Boolean(rail) && atRest.top !== null && atRest.scrollTop === 0 && atRest.top >= rail.bottom,
      `page 1 starts at ${atRest.top === null ? "?" : atRest.top.toFixed(0)}, the rail ends at ${rail ? rail.bottom.toFixed(0) : "?"}`);
  });

  ["phone", "tablet", "desktop"].forEach((label, i) => {
    const { rail, afterJump, last } = railWidths[i];
    check(`...nor after jumping to a page, on a ${label}`,
      Boolean(rail) && afterJump !== null && afterJump >= rail.bottom - 1,
      `page ${last} landed at ${afterJump === null ? "?" : afterJump.toFixed(0)} with the rail ending at `
        + `${rail ? rail.bottom.toFixed(0) : "?"} — a press meant for that line would hit the rail`);
  });

  check("nothing threw anywhere in this run",
    sheet.errs.length === 0 && picture.errs.length === 0,
    [...sheet.errs, ...picture.errs].join(" | "));
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
