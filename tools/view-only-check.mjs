// View only on the PDFs and the Canvas, and a pinch that never moves a Block.
//
//   node tools/view-only-check.mjs
//   VIEW_ONLY_SHOTS=<dir> node tools/view-only-check.mjs   (and pictures of the row)
//
// What a reader reported: "The Canvas needs a view only mode too, because on a
// phone or a laptop, when I zoom in and out, the blocks get displaced."
//
//   1. A finger on a Block when a second finger landed — the start of a pinch —
//      dragged the Block with the first finger while the page zoomed, and the
//      drop wrote it wherever that left it. The drag is now called off: the
//      Block is put back, and nothing is written.
//   2. Typed words were worse: a finger carrying them held the pen-down flag,
//      so the pinch took the second finger for a palm and never zoomed at all.
//   3. View only (✎ | 👁 in the tab row, src/documents/view-only.js): nothing
//      on the page is drawn, moved, added, pasted or undone; the tools that
//      would only be refused leave the row; a finger on a Block scrolls; the
//      PDFs and the Canvas keep separate settings, remembered on this device.
//   4. A real two-finger pinch (Input.dispatchTouchEvent) that starts on a
//      Block zooms the page and leaves the Block where it is stored.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";

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
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/view-only.js?v=__BUILD__",
    "/src/documents/block-place.js?v=__BUILD__",
    "/src/core/gesture.js?v=__BUILD__",
    "/src/ui/ink-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/pdf-shape-text.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/format/ink-strokes.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  api.__inkCount = () => (api.state.meta.pdfHighlights || []).reduce((n, r) => n + (r.ink ? api.decodeInkStrokes(r.ink.s || []).length : 0), 0);
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
    from: () => { throw new Error("view-only-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "View only fixture", notesMode: true });
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
  const view = document.getElementById("documentView");
  const fire = (target, type, x, y, { pointerType = "pen", buttons = 1, pointerId = 1, isPrimary = true } = {}) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId, pointerType, isPrimary,
    clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pressure: buttons ? 0.55 : 0
  }));
  const at = (x, y) => document.elementFromPoint(x, y) || view;
  const drag = async (x0, y0, x1, y1, opts = {}) => {
    fire(at(x0, y0), "pointerdown", x0, y0, opts);
    for (let i = 1; i <= 8; i += 1) {
      const x = x0 + ((x1 - x0) * i) / 8;
      const y = y0 + ((y1 - y0) * i) / 8;
      fire(at(x, y), "pointermove", x, y, opts);
      await settle(16);
    }
    fire(at(x1, y1), "pointerup", x1, y1, { ...opts, buttons: 0 });
    await settle(150);
  };
  const pageEl = (n = 1) => document.querySelector('#documentStage .pdf-page[data-page-number="' + n + '"]');
  const shown = (id) => { const node = document.getElementById(id); return Boolean(node && node.getClientRects().length); };
  const blockNode = (id) => document.querySelector('[data-pdf-block="' + id + '"]');
  const blockMid = (id) => { const r = blockNode(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const stored = (id) => api.documentBlocks().find((b) => b.id === id);
  // Bare paper in view, clear of the blocks this check puts near the top.
  const paperPoint = () => {
    const box = pageEl(1).getBoundingClientRect();
    return [box.left + 40, Math.min(box.bottom, innerHeight) - 50];
  };
  window.__h = { fire, at, drag, pageEl, shown, blockNode, blockMid, stored, paperPoint, view };
  return true;
}`;

const chrome = findChrome();
if (!chrome) { console.log("view-only-check: no Chrome on this machine — skipping."); process.exit(0); }

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

try {
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); localStorage.removeItem("recall:view-only-v1"); } catch (e) {}`
  });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));
  await page.evaluate(HELPERS_SRC);

  // ── 1. A second finger calls a finger's drag of a Block off ─────────────
  const finger = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { fire, at, pageEl, blockNode, blockMid, stored } = window.__h;
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(400);
    const out = {};
    const block = api.addDocumentBlock(1, { x: 200, y: 560 }, { edit: false });
    await settle(300);
    api.selectBlock(null);
    const touch = (pointerId, isPrimary = true) => ({ pointerType: "touch", pointerId, isPrimary });
    // The control: one finger alone still drags it, or the rest means nothing.
    let [x, y] = blockMid(block.id);
    let before = { ...stored(block.id) };
    fire(blockNode(block.id), "pointerdown", x, y, touch(11));
    for (let i = 1; i <= 6; i += 1) { fire(at(x, y + i * 8), "pointermove", x, y + i * 8, touch(11)); await settle(16); }
    fire(at(x, y + 48), "pointerup", x, y + 48, { ...touch(11), buttons: 0 });
    await settle(250);
    out.aloneDy = stored(block.id).y - before.y;
    // The pinch: the first finger on the block travels, and the second lands.
    [x, y] = blockMid(block.id);
    before = { ...stored(block.id) };
    const topBefore = blockNode(block.id).getBoundingClientRect().top;
    fire(blockNode(block.id), "pointerdown", x, y, touch(21));
    for (let i = 1; i <= 4; i += 1) { fire(at(x, y + i * 10), "pointermove", x, y + i * 10, touch(21)); await settle(16); }
    out.carriedMidway = Math.round(blockNode(block.id).getBoundingClientRect().top - topBefore);
    fire(pageEl(1), "pointerdown", x + 90, y + 140, touch(22, false));
    for (let i = 5; i <= 8; i += 1) { fire(at(x, y + i * 10), "pointermove", x, y + i * 10, touch(21)); await settle(16); }
    fire(at(x, y + 80), "pointerup", x, y + 80, { ...touch(21), buttons: 0 });
    fire(pageEl(1), "pointerup", x + 90, y + 140, { ...touch(22, false), buttons: 0 });
    await settle(250);
    const after = stored(block.id);
    out.pinchDx = after.x - before.x;
    out.pinchDy = after.y - before.y;
    out.drawnBack = Math.round(blockNode(block.id).getBoundingClientRect().top - topBefore);
    out.live = Boolean(api.liveBlockGesture());
    // A second finger landing ON a block starts nothing there either.
    const other = api.addDocumentBlock(1, { x: 60, y: 420 }, { edit: false });
    await settle(300);
    api.selectBlock(null);
    const otherBefore = { ...stored(other.id) };
    [x, y] = blockMid(block.id);
    const [ox, oy] = blockMid(other.id);
    fire(blockNode(block.id), "pointerdown", x, y, touch(31));
    fire(blockNode(other.id), "pointerdown", ox, oy, touch(32, false));
    for (let i = 1; i <= 6; i += 1) { fire(at(ox, oy + i * 10), "pointermove", ox, oy + i * 10, touch(32, false)); await settle(16); }
    fire(at(ox, oy + 60), "pointerup", ox, oy + 60, { ...touch(32, false), buttons: 0 });
    fire(at(x, y), "pointerup", x, y, { ...touch(31), buttons: 0 });
    await settle(250);
    out.secondOnBlockDy = stored(other.id).y - otherBefore.y;
    out.blockId = block.id;
    return out;
  }`);
  check("one finger alone still drags a Block (the control)", finger.aloneDy < -10, JSON.stringify(finger));
  check("...and while it is carried, it follows the finger", finger.carriedMidway > 10, JSON.stringify(finger));
  check("a second finger landing calls the drag off: the Block's record is not moved", finger.pinchDx === 0 && finger.pinchDy === 0, JSON.stringify(finger));
  check("...it is drawn back where it was, and no gesture is left live", Math.abs(finger.drawnBack) <= 1 && !finger.live, JSON.stringify(finger));
  check("a second finger that lands on another Block does not drag that one", finger.secondOnBlockDy === 0, JSON.stringify(finger));

  // ── 2. ...and of typed words, which also freed the pinch ─────────────────
  const words = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { fire, at, pageEl } = window.__h;
    const out = {};
    const record = api.addDocumentShape(1, {
      type: "text", p: [[300, 760], [480, 730]], fit: false, width: 0.3, stroke: "#16181d",
      font: { size: 13, bold: false, align: "left", color: "#000000" },
      text: "pinch over these words"
    });
    await settle(300);
    api.selectShape(null);
    const box = () => document.querySelector('.pdf-shape-text[data-highlight-id="' + record.id + '"]');
    const where = () => JSON.stringify(api.documentHighlightById(record.id).shape.p);
    const touch = (pointerId, isPrimary = true) => ({ pointerType: "touch", pointerId, isPrimary });
    let r = box().getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    // The control.
    let before = where();
    fire(box(), "pointerdown", x, y, touch(41));
    for (let i = 1; i <= 6; i += 1) { fire(at(x + i * 8, y), "pointermove", x + i * 8, y, touch(41)); await settle(16); }
    fire(at(x + 48, y), "pointerup", x + 48, y, { ...touch(41), buttons: 0 });
    await settle(250);
    out.aloneMoved = where() !== before;
    api.selectShape(null);
    await settle(150);
    r = box().getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
    before = where();
    fire(box(), "pointerdown", x, y, touch(51));
    for (let i = 1; i <= 4; i += 1) { fire(at(x + i * 10, y), "pointermove", x + i * 10, y, touch(51)); await settle(16); }
    out.penDownWhileCarried = api.inkPenIsDown();
    fire(pageEl(1), "pointerdown", x - 60, y - 120, touch(52, false));
    out.penDownAfterSecond = api.inkPenIsDown();
    for (let i = 5; i <= 8; i += 1) { fire(at(x + i * 10, y), "pointermove", x + i * 10, y, touch(51)); await settle(16); }
    fire(at(x + 80, y), "pointerup", x + 80, y, { ...touch(51), buttons: 0 });
    fire(pageEl(1), "pointerup", x - 60, y - 120, { ...touch(52, false), buttons: 0 });
    await settle(250);
    out.pinchMoved = where() !== before;
    api.selectShape(null);
    return out;
  }`);
  check("one finger alone still moves typed words (the control)", words.aloneMoved, JSON.stringify(words));
  check("a second finger frees the pinch: no pen-down left once it lands", words.penDownWhileCarried === true && words.penDownAfterSecond === false, JSON.stringify(words));
  check("...and the words stay where they are stored", words.pinchMoved === false, JSON.stringify(words));

  // ── 3. View only, on the Canvas ──────────────────────────────────────────
  const editPaste = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const n = api.documentBlocks().length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted while editing");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await settle(400);
    const added = api.documentBlocks().length - n;
    api.commitBlockEdit?.();
    api.selectBlock(null);
    await settle(200);
    return { added };
  }`);
  check("words pasted onto the Canvas make a Block while editing (the control)", editPaste.added === 1, JSON.stringify(editPaste));

  const viewOnly = await page.evaluate(`async (blockId) => {
    const { api, settle } = window.__recall;
    const { fire, drag, pageEl, shown, blockNode, blockMid, stored, paperPoint } = window.__h;
    const out = {};
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(200);
    out.pillShownEditing = shown("documentEditBtn");
    out.inkShownEditing = shown("documentInkBtn");
    // Pressed, as a reader would.
    document.getElementById("documentEditBtn").click();
    await settle(300);
    const pill = document.getElementById("documentEditBtn");
    out.on = api.documentViewOnly("notebook");
    out.pdfsOn = api.documentViewOnly("doc");
    out.bodyClass = document.body.classList.contains("view-only-notebook");
    out.pill = { pressed: pill.getAttribute("aria-pressed"), editing: pill.classList.contains("is-editing"), shown: shown("documentEditBtn") };
    out.toolsLeft = ["documentInkBtn", "documentShapesBtn", "documentInsertBtn", "documentAddPageBtn"].filter(shown);
    out.highlightKept = shown("documentRegionBtn");
    out.railShown = shown("documentInkRail");
    // The pen, on bare paper.
    const [px, py] = paperPoint();
    let ink = api.__inkCount();
    await drag(px, py, px + 160, py + 6, { pointerType: "pen" });
    out.penInk = api.__inkCount() - ink;
    // A mouse and a finger on a Block.
    let b0 = { ...stored(blockId) };
    let [x, y] = blockMid(blockId);
    await drag(x, y, x + 60, y + 50, { pointerType: "mouse" });
    out.mouseMoved = stored(blockId).x !== b0.x || stored(blockId).y !== b0.y;
    out.mouseSelected = api.selectedBlockId();
    [x, y] = blockMid(blockId);
    await drag(x, y, x + 30, y + 70, { pointerType: "touch", pointerId: 61 });
    out.fingerMoved = stored(blockId).x !== b0.x || stored(blockId).y !== b0.y;
    out.touchAction = getComputedStyle(blockNode(blockId)).touchAction;
    out.innerTouchAction = getComputedStyle(blockNode(blockId).querySelector(".pdf-block-body") || blockNode(blockId)).touchAction;
    // T where the mouse is, and a double-click on bare paper.
    const n = api.documentBlocks().length;
    fire(pageEl(1), "pointermove", px + 20, py - 40, { pointerType: "mouse", buttons: 0 });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true }));
    await settle(250);
    out.tKey = api.documentBlocks().length - n;
    fire(pageEl(1), "pointerdown", px + 20, py - 40, { pointerType: "mouse" });
    fire(pageEl(1), "pointerup", px + 20, py - 40, { pointerType: "mouse", buttons: 0 });
    pageEl(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: px + 20, clientY: py - 40, button: 0, detail: 2 }));
    await settle(250);
    out.dblclick = api.documentBlocks().length - n;
    // Insert's "tap where it goes", and words pasted.
    out.placementArmed = api.armBlockPlacement(true, { toast: false });
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted while viewing");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await settle(300);
    out.paste = api.documentBlocks().length - n;
    // Ctrl+Z: there is a Block step to undo (the ones made above), and it stays.
    const snapshot = JSON.stringify(api.documentBlocks());
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(250);
    out.undoKept = JSON.stringify(api.documentBlocks()) === snapshot;
    // Remembered, per part.
    out.stored = localStorage.getItem("recall:view-only-v1");
    api.reloadDocumentViewOnly();
    out.afterReload = api.documentViewOnly("notebook") && !api.documentViewOnly("doc");
    return out;
  }`, finger.blockId);
  check("✎ | 👁 is in the row on the Canvas, with ✎ beside it", viewOnly.pillShownEditing && viewOnly.inkShownEditing, JSON.stringify(viewOnly));
  check("pressed, the Canvas is View only and the PDFs are not", viewOnly.on && !viewOnly.pdfsOn && viewOnly.bodyClass, JSON.stringify(viewOnly));
  check("...the pill says 👁 (aria-pressed, not editing) and stays in the row", viewOnly.pill.pressed === "true" && !viewOnly.pill.editing && viewOnly.pill.shown, JSON.stringify(viewOnly.pill));
  check("...✎, Shapes, Insert, +□ and the pen's bar leave; ▣ stays", !viewOnly.toolsLeft.length && !viewOnly.railShown && viewOnly.highlightKept, JSON.stringify(viewOnly));
  check("...a pen on bare paper draws nothing", viewOnly.penInk === 0, JSON.stringify(viewOnly));
  check("...a mouse or a finger on a Block neither moves nor picks it up", !viewOnly.mouseMoved && !viewOnly.fingerMoved && !viewOnly.mouseSelected, JSON.stringify(viewOnly));
  check("...a finger on a Block scrolls the page (touch-action), inside it too", viewOnly.touchAction === "pan-x pan-y" && viewOnly.innerTouchAction === "pan-x pan-y", JSON.stringify(viewOnly));
  check("...T and a double-click make no Block", viewOnly.tKey === 0 && viewOnly.dblclick === 0, JSON.stringify(viewOnly));
  check("...Insert does not arm, and pasted words make no Block", viewOnly.placementArmed === false && viewOnly.paste === 0, JSON.stringify(viewOnly));
  check("...Ctrl+Z takes nothing back", viewOnly.undoKept, JSON.stringify(viewOnly));
  check("...remembered on this device, the Canvas's apart from the PDFs'", viewOnly.afterReload && /"notebook":true/.test(viewOnly.stored || ""), JSON.stringify(viewOnly));

  // ── Pictures of the row, on request: VIEW_ONLY_SHOTS=<dir> ───────────────
  const SHOTS = process.env.VIEW_ONLY_SHOTS || "";
  const snap = async (name) => {
    if (!SHOTS) return;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOTS, { recursive: true });
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, "base64"));
    console.log(`  shot  ${path.join(SHOTS, name)}`);
  };
  const rowFits = `() => {
    const row = document.getElementById("viewModeRow");
    const r = row.getBoundingClientRect();
    const tabs = [...document.querySelectorAll("#viewModeToggle button:not([hidden]) .vm-label")];
    return {
      overflow: row.scrollWidth - row.clientWidth,
      right: Math.round(r.right),
      width: innerWidth,
      clipped: tabs.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent)
    };
  }`;
  const sizes = [[360, 740, true], [390, 844, true], [1100, 760, false]];
  for (const [width, height, mobile] of sizes) {
    await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
    await page.evaluate(`async () => { await window.__recall.settle(500); }`);
    const fit = await page.evaluate(rowFits);
    check(`at ${width}px in 👁, the row fits and no tab's word is cut`, fit.overflow <= 0 && fit.right <= fit.width && !fit.clipped.length, JSON.stringify(fit));
    await snap(`view-only-${width}.png`);
    await page.evaluate(`async () => { document.getElementById("documentEditBtn").click(); await window.__recall.settle(400); }`);
    const fitEdit = await page.evaluate(rowFits);
    check(`at ${width}px in ✎, the row fits and no tab's word is cut`, fitEdit.overflow <= 0 && fitEdit.right <= fitEdit.width && !fitEdit.clipped.length, JSON.stringify(fitEdit));
    await snap(`edit-${width}.png`);
    await page.evaluate(`async () => { document.getElementById("documentEditBtn").click(); await window.__recall.settle(400); }`);
  }
  await page.call("Emulation.clearDeviceMetricsOverride", {});

  // ── 4. Back to ✎ ─────────────────────────────────────────────────────────
  const back = await page.evaluate(`async (blockId) => {
    const { api, settle } = window.__recall;
    const { drag, pageEl, shown, blockMid, stored, paperPoint } = window.__h;
    await settle(300);
    document.getElementById("documentEditBtn").click();
    await settle(300);
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(300);
    const out = {};
    out.on = api.documentViewOnly("notebook");
    out.pressed = document.getElementById("documentEditBtn").getAttribute("aria-pressed");
    out.tools = ["documentInkBtn", "documentShapesBtn", "documentInsertBtn"].every(shown);
    const [px, py] = paperPoint();
    const ink = api.__inkCount();
    await drag(px, py, px + 160, py + 6, { pointerType: "pen" });
    out.penInk = api.__inkCount() - ink;
    const b0 = { ...stored(blockId) };
    const [x, y] = blockMid(blockId);
    await drag(x, y, x + 60, y + 50, { pointerType: "mouse" });
    out.mouseMoved = stored(blockId).x !== b0.x || stored(blockId).y !== b0.y;
    api.selectBlock(null);
    return out;
  }`, finger.blockId);
  check("pressed again, the Canvas is editable: ✎, Shapes and Insert are back", !back.on && back.pressed === "false" && back.tools, JSON.stringify(back));
  check("...the pen draws and a Block moves again", back.penInk === 1 && back.mouseMoved, JSON.stringify(back));

  // ── 5. A real pinch that starts with a finger on a Block ─────────────────
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const spot = await page.evaluate(`async (blockId) => {
    const { api, settle } = window.__recall;
    const { pageEl, blockMid, stored } = window.__h;
    api.fitDocumentToWidth?.();
    await settle(500);
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(400);
    const [x, y] = blockMid(blockId);
    return { x: Math.round(x), y: Math.round(y), scale: api.pdfPageViewport(1).scale, block: stored(blockId) };
  }`, finger.blockId);
  const point = (x, y, id) => ({ x, y, radiusX: 8, radiusY: 8, force: 1, id });
  const touch = (type, touchPoints) => page.call("Input.dispatchTouchEvent", { type, touchPoints });
  const p1 = { x: spot.x, y: spot.y };
  const p2 = { x: spot.x + 60, y: spot.y + 110 };
  await touch("touchStart", [point(p1.x, p1.y, 1)]);
  for (let i = 1; i <= 3; i += 1) await touch("touchMove", [point(p1.x, p1.y + i * 6, 1)]);
  await touch("touchStart", [point(p1.x, p1.y + 18, 1), point(p2.x, p2.y, 2)]);
  for (let i = 1; i <= 8; i += 1) {
    await touch("touchMove", [point(p1.x - i * 6, p1.y + 18 - i * 8, 1), point(p2.x + i * 6, p2.y + i * 8, 2)]);
  }
  await touch("touchEnd", []);
  const pinched = await page.evaluate(`async (blockId) => {
    const { api, settle } = window.__recall;
    await settle(900);
    return { scale: api.pdfPageViewport(1).scale, block: window.__h.stored(blockId), live: Boolean(api.liveBlockGesture()) };
  }`, finger.blockId);
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  check("a real two-finger pinch that starts on a Block zooms the page", pinched.scale > spot.scale * 1.1, JSON.stringify({ before: spot.scale, after: pinched.scale }));
  check("...and the Block stays exactly where it is stored", pinched.block.x === spot.block.x && pinched.block.y === spot.block.y && !pinched.live,
    JSON.stringify({ before: [spot.block.x, spot.block.y], after: [pinched.block.x, pinched.block.y] }));

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

console.log(`\nview-only-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
