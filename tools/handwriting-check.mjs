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
    "/src/handwriting/pages.js?v=__BUILD__",
    "/src/handwriting/paper.js?v=__BUILD__",
    "/src/notes/ink-sheet.js?v=__BUILD__",
    "/src/format/ink-strokes.js?v=__BUILD__",
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
const SETUP_SRC = `async (apiSrc) => {
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
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  // ── 1. The pen that stopped when the hand paused ────────────────────────
  const paused = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    document.getElementById("handwritingBtn").click();
    await settle(400);
    const pageEl = document.querySelector("#hwScroll .hw-page");
    const box = pageEl.getBoundingClientRect();

    // A straight, slow run — then a REST longer than the straightener's hold
    // (INK_SHAPE_HOLD_MS is 600ms) — then more of the same line. A straight run
    // is chosen deliberately: it is the shape most likely to be snapped, so it
    // is the case where losing the rest of the stroke was most likely.
    pen(pageEl, "pointerdown", box.left + 40, box.top + 60, 1);
    for (let i = 1; i <= 10; i += 1) pen(pageEl, "pointermove", box.left + 40 + (i * 10), box.top + 60, 1);
    await settle(750);
    const halfway = box.left + 140;
    for (let i = 1; i <= 10; i += 1) pen(pageEl, "pointermove", halfway + (i * 10), box.top + 60, 1);
    await settle(80);
    pen(pageEl, "pointerup", halfway + 100, box.top + 60, 0);
    await settle(200);

    const strokes = api.decodeInkStrokes(api.state.meta.pages[0].ink || []);
    const bounds = api.inkStrokesBounds(strokes);
    const scale = box.width / 794;
    // Where the pen finished, in the page's own units.
    const wanted = ((halfway + 100) - box.left) / scale;
    return { strokes: strokes.length, maxX: bounds ? bounds.maxX : 0, wanted, errs: window.__errs.slice(0, 4) };
  }`, PEN_SRC);

  check("a stroke held still for 750ms keeps following the nib afterwards",
    paused.strokes > 0 && paused.maxX >= paused.wanted - 12,
    `reached ${paused.maxX.toFixed(0)} of ${paused.wanted.toFixed(0)} page units`);
  check("...and the pause did not throw the stroke away", paused.strokes > 0,
    `${paused.strokes} stroke(s) committed`);
  check("...with nothing thrown on the way", paused.errs.length === 0, paused.errs.join(" | "));

  // ── 2. The blink at every pen lift ──────────────────────────────────────
  const handover = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const pageEl = document.querySelector("#hwScroll .hw-page");
    const box = pageEl.getBoundingClientRect();
    const dry = pageEl.querySelector(".hw-page-ink .hw-page-canvas");
    const inked = () => {
      const ctx = dry.getContext("2d");
      const px = ctx.getImageData(0, 0, dry.width, dry.height).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n += 1;
      return n;
    };
    const before = inked();
    pen(pageEl, "pointerdown", box.left + 60, box.top + 300, 1);
    for (let i = 1; i <= 14; i += 1) pen(pageEl, "pointermove", box.left + 60 + (i * 9), box.top + 300 + (i * 4), 1);
    await settle(120);
    // Read SYNCHRONOUSLY after the lift, before any frame can run. If the dry
    // canvas already carries the new stroke at this instant, then the repaint
    // happened before the wet layer was cleared — which is the whole of the
    // ordering fix, and the only moment at which it can be observed.
    pen(pageEl, "pointerup", box.left + 186, box.top + 356, 0);
    const atLift = inked();
    await settle(150);
    const after = inked();
    return { before, atLift, after };
  }`, PEN_SRC);

  check("the dry canvas has the finished stroke at the instant the pen lifts",
    handover.atLift > handover.before,
    `${handover.before} → ${handover.atLift} inked pixel(s) with no frame in between`);
  check("...and still has it a frame later", handover.after >= handover.atLift,
    `${handover.after} inked pixel(s)`);

  // ── 3. Does writing get slower the more you have written? ───────────────
  const cost = await page.evaluate(`async (penSrc) => {
    const { api, settle } = window.__recall;
    const pen = (0, eval)(penSrc);
    const pageEl = document.querySelector("#hwScroll .hw-page");
    const box = pageEl.getBoundingClientRect();
    // One short stroke, timed from pointerdown to the return of pointerup —
    // which is where every one of the three O(page) faults was paid.
    const stroke = (n) => {
      const y = box.top + 40 + ((n % 90) * 8);
      const x = box.left + 30 + ((n % 7) * 40);
      const t0 = performance.now();
      pen(pageEl, "pointerdown", x, y, 1);
      for (let i = 1; i <= 6; i += 1) pen(pageEl, "pointermove", x + (i * 4), y + i, 1);
      pen(pageEl, "pointerup", x + 24, y + 6, 0);
      return performance.now() - t0;
    };
    const early = [];
    for (let n = 0; n < 5; n += 1) { early.push(stroke(n)); await settle(4); }
    for (let n = 5; n < 180; n += 1) { stroke(n); if (n % 20 === 0) await settle(2); }
    await settle(60);
    const late = [];
    for (let n = 180; n < 190; n += 1) { late.push(stroke(n)); await settle(4); }
    const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];
    return {
      strokes: api.decodeInkStrokes(api.state.meta.pages[0].ink || []).length,
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

  // ── 4. Pages, torn out, and read back ───────────────────────────────────
  const pages = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const board = document.getElementById("handwritingBoard");
    board.querySelector('[data-hw-action="add-page"]').click();
    await settle(300);
    const ids = api.state.meta.pages.map((p) => p.id);
    const survivor = ids[1];
    const doomed = ids[0];
    const inkOnDoomed = (api.state.meta.pages[0].ink || []).length;

    // Tear out the first page. The confirm is a real modal — pressed rather
    // than bypassed, because the dialog is part of the path.
    const pageEl = document.querySelector('.hw-page[data-hw-page="' + doomed + '"]');
    pageEl.querySelector('[data-hw-page-action="delete"]').click();
    await settle(200);
    document.getElementById("confirmModalOkBtn").click();
    await settle(300);

    const left = api.state.meta.pages.map((p) => p.id);
    const buried = Object.keys(api.state.meta.deletedPageIds || {});

    // ...and back through the store, which is the only thing that proves it was
    // written rather than merely shown.
    await api.flushPendingDeckAutosave();
    await settle(300);
    const entry = api.readLocalDeckIndex()[0];
    const snapshot = await api.readDeckSnapshot(entry.id);
    const saved = api.readHandwritingPages(snapshot.meta);
    return {
      inkOnDoomed,
      left,
      survivor,
      doomed,
      buried,
      savedIds: saved.map((p) => p.id),
      savedOrder: saved.map((p) => p.order),
      savedInk: saved.map((p) => (p.ink || []).length),
      pageCount: entry.pageCount
    };
  }`);

  check("tearing out a page leaves the others", pages.left.length === 1 && pages.left[0] === pages.survivor,
    `${pages.left.length} page(s) left`);
  check("...and gives the one that went a tombstone", pages.buried.includes(pages.doomed),
    `buried: ${pages.buried.join(", ") || "none"}`);
  check("the notebook survives a round trip through IndexedDB",
    pages.savedIds.length === 1 && pages.savedIds[0] === pages.survivor,
    `stored: ${pages.savedIds.join(", ") || "nothing"}`);
  check("...renumbered from zero", pages.savedOrder.join(",") === "0", `order: ${pages.savedOrder.join(",")}`);
  check("...and the library row knows it is a notebook", pages.pageCount === 1, `pageCount = ${pages.pageCount}`);

  // ── 5. A text box, moved, and a second device ───────────────────────────
  const boxes = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const board = document.getElementById("handwritingBoard");
    board.querySelector('[data-hw-action="add-box"]').click();
    await settle(250);
    const el = document.querySelector(".hw-box");
    const id = el.dataset.hwBox;
    const first = { ...api.state.meta.textBoxes[0] };

    const drag = (target, from, to) => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "mouse", isPrimary: true, clientX: from.x, clientY: from.y, buttons: 1 }));
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientX: to.x, clientY: to.y, buttons: 1 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: to.x, clientY: to.y, buttons: 0 }));
    };
    const barBox = el.querySelector(".hw-box-bar").getBoundingClientRect();
    drag(el.querySelector(".hw-box-bar"), { x: barBox.left + 4, y: barBox.top + 4 }, { x: barBox.left + 84, y: barBox.top + 64 });
    await settle(250);
    const moved = { ...api.state.meta.textBoxes[0] };

    const gripBox = el.querySelector(".hw-box-grip").getBoundingClientRect();
    drag(el.querySelector(".hw-box-grip"), { x: gripBox.left + 2, y: gripBox.top + 2 }, { x: gripBox.left + 62, y: gripBox.top + 42 });
    await settle(250);
    const sized = { ...api.state.meta.textBoxes[0] };

    await api.flushPendingDeckAutosave();
    await settle(300);
    const entry = api.readLocalDeckIndex()[0];
    const snapshot = await api.readDeckSnapshot(entry.id);
    const stored = api.readHandwritingBoxes(snapshot.meta)[0];

    // Two devices, one notebook: this one's box moved, the other one added a
    // page while it was happening. Neither may take the other's work.
    const other = {
      pages: [...api.state.meta.pages, { id: "hp-elsewhere", order: 1, w: 794, h: 1123, paper: "grid", ink: [], at: Date.now() }],
      textBoxes: [{ ...first, x: 999, y: 999, at: first.at - 5000 }]
    };
    const merged = api.mergeDeckMeta(other, api.state.meta, { prefer: "local" });
    return {
      id,
      first: { x: first.x, y: first.y, w: first.w, h: first.h },
      moved: { x: moved.x, y: moved.y },
      sized: { w: sized.w, h: sized.h },
      stored: stored ? { x: stored.x, y: stored.y, w: stored.w, h: stored.h } : null,
      mergedPages: merged.pages.map((p) => p.id),
      mergedBoxX: merged.textBoxes[0].x
    };
  }`);

  check("a text box can be dragged", boxes.moved.x > boxes.first.x && boxes.moved.y > boxes.first.y,
    `(${boxes.first.x}, ${boxes.first.y}) → (${boxes.moved.x}, ${boxes.moved.y})`);
  check("...and resized", boxes.sized.w > boxes.first.w && boxes.sized.h > boxes.first.h,
    `${boxes.first.w}x${boxes.first.h} → ${boxes.sized.w}x${boxes.sized.h}`);
  check("...and is where it was put after a round trip through the store",
    Boolean(boxes.stored) && boxes.stored.x === boxes.moved.x && boxes.stored.y === boxes.moved.y
      && boxes.stored.w === boxes.sized.w && boxes.stored.h === boxes.sized.h,
    boxes.stored ? `(${boxes.stored.x}, ${boxes.stored.y}) ${boxes.stored.w}x${boxes.stored.h}` : "nothing stored");
  check("a page added on the other device survives this one's push",
    boxes.mergedPages.includes("hp-elsewhere"),
    `merged: ${boxes.mergedPages.join(", ")}`);
  check("...and this device's newer box wins over the other's older copy",
    boxes.mergedBoxX === boxes.moved.x,
    `x = ${boxes.mergedBoxX}, this device had ${boxes.moved.x}`);

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
    return {
      twoPages,
      closed: shell.hidden,
      images: ta.value.split("![](").length - 1,
      uploads: window.__stored.size,
      errs: window.__errs.slice(0, 4)
    };
  }`, PEN_SRC);

  check("the drawing sheet takes a second page", sheet.twoPages === 2, `${sheet.twoPages} page(s)`);
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
