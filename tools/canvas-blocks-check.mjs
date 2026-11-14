// The Canvas, as a place you put blocks on.
//
//   node tools/canvas-blocks-check.mjs
//
// What a reader of a Canvas reported, case by case:
//
//   1. "I am just dragging the block, but why is a pen mark coming?" — a pen
//      press on something already on the page (a block, typed words, a
//      selected shape's handles, a connect arrow) moved it AND drew a stroke
//      across the page, because the pen's own listener stood down only for a
//      block's or a label's body, and the handles were neither.
//   2. Black chosen for typed words read light on a dark page when rendered,
//      and black — invisible — while being typed.
//   3. Text and Block were two things to add that did the same job. There is
//      one now: the Block button (and T) arms "tap where it goes", and the
//      block opens to type in, in place.
//   4. Once a block was made, selecting some of its words to style them was
//      impossible: every press on it was a drag. A tap on a selected block (or
//      a double-tap) opens it in place, where words select and the Notes
//      selection bar styles them.
//   5. A block keeps the width it was given; its height follows the words.

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
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/pdf-shape-text.js?v=__BUILD__",
    "/src/documents/paper-menu.js?v=__BUILD__",
    "/src/format/paper-tones.js?v=__BUILD__",
    "/src/ui/ink-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__",
    "/src/notes/selection.js?v=__BUILD__",
    "/src/documents/pdf-block-inline.js?v=__BUILD__",
    "/src/documents/block-place.js?v=__BUILD__",
    "/src/format/ink-strokes.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  // A copy of the inks, decoded: a record's \`s\` is an encoded string.
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
    from: () => { throw new Error("canvas-blocks-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Canvas blocks fixture", notesMode: true });
  await settle(400);
  document.documentElement.setAttribute("data-theme", "dark-amoled");
  await settle(100);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  await settle(300);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

// Helpers every case below shares, installed once on the page.
const HELPERS_SRC = `() => {
  const { api, settle } = window.__recall;
  const view = document.getElementById("documentView");
  const fire = (target, type, x, y, { pointerType = "pen", buttons = 1, pointerId = 1 } = {}) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId, pointerType, isPrimary: true,
    clientX: x, clientY: y, buttons, button: type === "pointermove" ? -1 : 0, pressure: buttons ? 0.55 : 0
  }));
  // A press, a run of moves and a lift, each at whatever is under the point
  // — what a real pointer is delivered to.
  const drag = async (x0, y0, x1, y1, opts = {}) => {
    const at = (x, y) => document.elementFromPoint(x, y) || view;
    fire(at(x0, y0), "pointerdown", x0, y0, opts);
    for (let i = 1; i <= 8; i += 1) {
      const x = x0 + ((x1 - x0) * i) / 8;
      const y = y0 + ((y1 - y0) * i) / 8;
      fire(at(x, y), "pointermove", x, y, opts);
      await settle(16);
    }
    fire(at(x1, y1), "pointerup", x1, y1, { ...opts, buttons: 0 });
    await settle(120);
  };
  const tap = async (x, y, opts = {}) => {
    const target = document.elementFromPoint(x, y) || view;
    fire(target, "pointerdown", x, y, opts);
    fire(target, "pointerup", x, y, { ...opts, buttons: 0 });
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }));
    await settle(120);
  };
  const inkStrokes = () => api.__inkCount();
  const pageEl = (n = 1) => document.querySelector('#documentStage .pdf-page[data-page-number="' + n + '"]');
  window.__h = { fire, drag, tap, inkStrokes, pageEl, view };
  return true;
}`;

const chrome = findChrome();
if (!chrome) { console.log("canvas-blocks-check: no Chrome on this machine — skipping."); process.exit(0); }

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
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}`
  });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));
  await page.evaluate(HELPERS_SRC);

  // ── 1. A pen press on something on the page never inks ─────────────────
  const noInk = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { drag, inkStrokes, pageEl } = window.__h;
    api.setInkArmed(true);
    api.setInkTool("pen");
    api.refreshInkRail();
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(400);
    const out = {};
    // Words typed with the old Text tool, selected so its handles are up.
    const record = api.addDocumentShape(1, {
      type: "text", p: [[80, 700], [260, 660]], fit: false, width: 0.3, stroke: "#16181d",
      font: { size: 13, bold: false, align: "left", color: "#000000" },
      text: "Where we left the language thread"
    });
    await settle(300);
    api.selectShape(record.id);
    await settle(300);
    const box = pageEl(1).getBoundingClientRect();
    const vp = api.pdfPageViewport(1);
    const toScreen = (x, y) => { const [sx, sy] = vp.convertToViewportPoint(x, y); return [box.left + sx, box.top + sy]; };
    // The right edge's middle handle, dragged right.
    const [ex, ey] = toScreen(260, 680);
    let before = inkStrokes();
    await drag(ex, ey, ex + 120, ey + 10);
    out.textHandle = inkStrokes() - before;
    // The words' body, dragged.
    api.selectShape(record.id);
    await settle(200);
    const [bx, by] = toScreen(120, 682);
    before = inkStrokes();
    await drag(bx, by, bx + 60, by + 80);
    out.textBody = inkStrokes() - before;
    api.selectShape(null);
    // A block, its body and its corner grip.
    const block = api.addDocumentBlock(1, { x: 300, y: 400 }, { edit: false });
    await settle(300);
    const node = document.querySelector('[data-pdf-block="' + block.id + '"]');
    const r = node.getBoundingClientRect();
    before = inkStrokes();
    await drag(r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 50, r.top + r.height / 2 + 40);
    out.blockBody = inkStrokes() - before;
    api.selectBlock(block.id);
    await settle(200);
    const r2 = node.getBoundingClientRect();
    before = inkStrokes();
    await drag(r2.right - 3, r2.top + r2.height / 2, r2.right + 60, r2.top + r2.height / 2);
    out.blockEdge = inkStrokes() - before;
    // A connect arrow beside the selected block.
    api.selectBlock(block.id);
    await settle(300);
    const arrow = document.querySelector(".pdf-connect-arrow");
    if (arrow) {
      const a = arrow.getBoundingClientRect();
      before = inkStrokes();
      await drag(a.left + a.width / 2, a.top + a.height / 2, a.left + 160, a.top + 90);
      out.connectArrow = inkStrokes() - before;
    } else {
      out.connectArrow = "no arrow";
    }
    // ...and bare paper still inks, or none of the above means anything.
    api.selectBlock(null);
    api.selectShape(null);
    await settle(200);
    before = inkStrokes();
    const low = Math.min(box.bottom, innerHeight) - 60;
    await drag(box.left + 40, low, box.left + 200, low + 10);
    out.paper = inkStrokes() - before;
    return out;
  }`);
  check("a pen drag on typed words' handle draws nothing", noInk.textHandle === 0, JSON.stringify(noInk));
  check("...nor on the words themselves", noInk.textBody === 0, JSON.stringify(noInk));
  check("...nor on a block's body or its edge", noInk.blockBody === 0 && noInk.blockEdge === 0, JSON.stringify(noInk));
  check("...nor on a connect arrow", noInk.connectArrow === 0, JSON.stringify(noInk));
  check("...while a drag on bare paper still writes", noInk.paper === 1, JSON.stringify(noInk));

  // ── 2. Black typed words are readable on a black page while typed ─────
  const colour = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setPaperTone("black");
    await settle(600);
    const record = api.addDocumentShape(1, {
      type: "text", p: [[80, 600], [260, 570]], fit: false, width: 0.3, stroke: "#000000",
      font: { size: 13, bold: false, align: "left", color: "#000000" },
      text: "black words"
    });
    await settle(300);
    api.openShapeTextEditor(record.id);
    await settle(200);
    const editor = document.querySelector(".pdf-shape-editor");
    const rgb = editor ? getComputedStyle(editor).color : "";
    const lum = (rgb.match(/\\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    api.commitShapeTextEditor?.();
    api.selectShape(null);
    api.setPaperTone("theme");
    await settle(400);
    return { rgb, lum, found: Boolean(editor) };
  }`);
  check("black typed words are light while typed on a black page, as they are once put down", colour.found && colour.lum > 150, JSON.stringify(colour));

  // ── 3. One thing to add: a Block, put where the reader taps ─────────────
  const place = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { tap, inkStrokes, pageEl } = window.__h;
    const out = {};
    const addMenu = document.getElementById("inkRailAddMenu");
    out.addRows = [...addMenu.querySelectorAll("[data-hw-action]")].map((b) => b.dataset.hwAction);
    out.textRow = Boolean(addMenu.querySelector('[data-hw-action="add-text"]'));
    const button = document.getElementById("documentTextBtn");
    out.buttonLabel = button.getAttribute("aria-label");
    const before = api.documentBlocks().length;
    const strokes = inkStrokes();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle(80);
    out.armed = api.isBlockPlacementArmed();
    out.lit = button.getAttribute("aria-pressed") === "true";
    const box = pageEl(1).getBoundingClientRect();
    const x = box.left + 120;
    const y = Math.min(box.bottom, innerHeight) - 220;
    await tap(x, y, { pointerType: "pen" });
    await settle(200);
    const blocks = api.documentBlocks();
    out.made = blocks.length - before;
    out.inked = inkStrokes() - strokes;
    out.disarmed = !api.isBlockPlacementArmed() && button.getAttribute("aria-pressed") !== "true";
    const made = blocks[blocks.length - 1];
    const node = made && document.querySelector('[data-pdf-block="' + made.id + '"]');
    const r = node?.getBoundingClientRect();
    // The tap is just inside the block's top-left corner.
    out.nearCorner = Boolean(r) && Math.abs(r.left - x) < 30 && Math.abs(r.top - y) < 30;
    out.open = api.isInlineBlockEditorOpen() && api.inlineBlockEditorId() === made?.id;
    out.inBlock = Boolean(node?.querySelector(".pdf-block-inline textarea"));
    out.focused = document.activeElement === node?.querySelector(".pdf-block-inline textarea");
    out.noSheet = !document.querySelector(".pdf-block-editor:not([hidden])");
    out.strip = [...document.querySelectorAll(".pdf-block-actions-pop [data-block-popover-action]")].map((b) => b.dataset.blockPopoverAction).join(",");
    // Put down with nothing typed: it goes again.
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(200);
    out.emptyGone = api.documentBlocks().length === before;
    // Pressed twice: armed, then put away, nothing placed.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    out.toggledOff = !api.isBlockPlacementArmed() && api.documentBlocks().length === before;
    // The keyboard's press (a click with no pointer, detail 0) has nothing to
    // tap with: the block goes in the middle of the view, open, at once.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await settle(150);
    out.keyboardPlaced = api.documentBlocks().length === before + 1 && api.isInlineBlockEditorOpen() && !api.isBlockPlacementArmed();
    api.commitBlockEdit();
    await settle(150);
    out.keyboardEmptyGone = api.documentBlocks().length === before;
    return out;
  }`);
  check("+ Add has no Text row — Block, the shapes, Picture and a page", !place.textRow && place.addRows.includes("add-block"), JSON.stringify(place.addRows));
  check("the Block button arms a block, lit", place.armed && place.lit && place.buttonLabel === "Add a block", JSON.stringify(place));
  check("a tap puts one block at the tap, with no ink, and the button goes out", place.made === 1 && place.inked === 0 && place.nearCorner && place.disarmed, JSON.stringify(place));
  check("...open in place to type in, no window over the page", place.open && place.inBlock && place.focused && place.noSheet, JSON.stringify(place));
  check("...with a three-button strip: Style, Full editor, Done", place.strip === "style,full-editor,done", place.strip);
  check("a block put down empty goes again; the button pressed twice places nothing", place.emptyGone && place.toggledOff, JSON.stringify(place));
  check("from the keyboard, the button puts a block in the middle of the view at once", place.keyboardPlaced && place.keyboardEmptyGone, JSON.stringify(place));

  // ── 4. Typing, styling words, and the taps that open and move a block ───
  const edit = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { tap, drag, fire } = window.__h;
    const out = {};
    const block = api.addDocumentBlock(1, { x: 200, y: 520 }, { anchor: "top-left" });
    await settle(150);
    const node = () => document.querySelector('[data-pdf-block="' + block.id + '"]');
    const ta = node().querySelector(".pdf-block-inline textarea");
    ta.focus();
    ta.value = "hello world";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.setSelectionRange(6, 11);
    ta.dispatchEvent(new Event("select", { bubbles: true }));
    ta.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle(400);
    const pill = document.getElementById("selectionFloat");
    out.pill = pill && !pill.hidden;
    const bold = pill?.querySelector('[data-render-action="bold"]');
    if (bold) {
      bold.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      bold.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      bold.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    }
    await settle(200);
    out.typed = ta.value;
    // Ctrl+Enter puts it down; the words render.
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await settle(700);
    const stored = api.documentBlocks().find((b) => b.id === block.id);
    out.md = stored?.md;
    out.strong = node()?.querySelector(".pdf-block-body strong")?.textContent || "";
    out.closed = !api.isInlineBlockEditorOpen();
    // A first tap on a block not picked up only picks it up.
    api.selectBlock(null);
    await settle(100);
    let r = node().getBoundingClientRect();
    await tap(r.left + 20, r.top + r.height / 2, { pointerType: "mouse" });
    out.firstTapSelects = api.selectedBlockId() === block.id && !api.isInlineBlockEditorOpen();
    // ...a second opens it in place. (Measured again: picking a block up puts
    // its actions on the pen's bar, which can push the page down a row.)
    r = node().getBoundingClientRect();
    await tap(r.left + 20, r.top + r.height / 2, { pointerType: "mouse" });
    await settle(100);
    out.secondTapOpens = api.isInlineBlockEditorOpen() && api.inlineBlockEditorId() === block.id;
    // A press inside the words being typed does not move the block.
    const before = api.documentBlocks().find((b) => b.id === block.id);
    const t = node().querySelector(".pdf-block-inline textarea").getBoundingClientRect();
    await drag(t.left + 6, t.top + 6, t.left + 60, t.top + 8, { pointerType: "mouse" });
    const after = api.documentBlocks().find((b) => b.id === block.id);
    out.selectingDoesNotMove = before.x === after.x && before.y === after.y && api.isInlineBlockEditorOpen();
    // A press on bare paper puts the words down.
    const pageBox = window.__h.pageEl(1).getBoundingClientRect();
    await tap(pageBox.left + 30, pageBox.top + 30, { pointerType: "mouse" });
    await settle(300);
    out.paperCommits = !api.isInlineBlockEditorOpen();
    // A drag on a picked-up block moves it, and does not open it.
    api.selectBlock(block.id);
    await settle(100);
    r = node().getBoundingClientRect();
    const was = api.documentBlocks().find((b) => b.id === block.id);
    await drag(r.left + 20, r.top + r.height / 2, r.left + 80, r.top + r.height / 2 + 30, { pointerType: "mouse" });
    await settle(150);
    const moved = api.documentBlocks().find((b) => b.id === block.id);
    out.dragMoves = moved.x !== was.x && !api.isInlineBlockEditorOpen();
    return out;
  }`);
  check("selecting words in a block being typed raises the Notes selection bar", edit.pill, JSON.stringify(edit));
  check("...whose B makes them bold", edit.typed === "hello **world**", JSON.stringify(edit));
  check("Ctrl+Enter puts the words down, written and rendered", edit.closed && edit.md === "hello **world**" && edit.strong === "world", JSON.stringify(edit));
  check("a first tap picks a block up, a second opens it in place", edit.firstTapSelects && edit.secondTapOpens, JSON.stringify(edit));
  check("dragging across the words being typed selects them, not the block", edit.selectingDoesNotMove, JSON.stringify(edit));
  check("a press on the paper puts the words down; a drag on a picked-up block moves it", edit.paperCommits && edit.dragMoves, JSON.stringify(edit));

  // ── 5. The width stays; the height follows the words ───────────────────
  const size = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const block = api.addDocumentBlock(1, { x: 120, y: 300 }, { edit: false });
    await settle(200);
    const read = () => api.documentBlocks().find((b) => b.id === block.id);
    const write = async (md) => {
      api.editBlock(block.id);
      await settle(50);
      const ta = document.querySelector('[data-pdf-block="' + block.id + '"] .pdf-block-inline textarea');
      ta.value = md;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(50);
      const liveH = document.querySelector('[data-pdf-block="' + block.id + '"]').getBoundingClientRect().height;
      api.commitBlockEdit();
      for (let i = 0; i < 20; i += 1) await settle(60);
      const node = document.querySelector('[data-pdf-block="' + block.id + '"]');
      const body = node.querySelector(".pdf-block-body");
      return { ...read(), liveH, overflow: body.scrollHeight - body.clientHeight };
    };
    const w0 = read().w;
    const short = await write("one");
    const long = await write("A first paragraph that runs on for a while, long enough to wrap over more than one line of the block.\\n\\nA second paragraph, also of some length, so that the block has to grow.\\n\\nAnd a third.");
    const back = await write("one");
    return { w0, short: { w: short.w, h: short.h }, long: { w: long.w, h: long.h, liveH: long.liveH, overflow: long.overflow }, back: { w: back.w, h: back.h } };
  }`);
  check("a block keeps its width whatever is written in it", size.short.w === size.w0 && size.long.w === size.w0 && size.back.w === size.w0, JSON.stringify(size));
  check("...and its height follows the words, while typed and once put down, with nothing cut off", size.long.h > size.short.h * 2 && size.long.liveH > 60 && size.long.overflow <= 1 && size.back.h === size.short.h, JSON.stringify(size));

  // ...and a box that keeps a height of its own (a diagram's diamond) keeps it
  // as the least it can be, and still grows to hold its words.
  const shaped = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const block = api.addDocumentBlock(1, { x: 380, y: 250 }, { style: { shape: "diamond", fit: false, align: "center", valign: "middle", frame: "outline" }, w: 140, h: 92, edit: false });
    await settle(200);
    const read = () => api.documentBlocks().find((b) => b.id === block.id);
    const set = { w: read().w, h: read().h };
    api.editBlock(block.id);
    await settle(50);
    const ta = document.querySelector('[data-pdf-block="' + block.id + '"] .pdf-block-inline textarea');
    ta.value = "Is the reading inside the band the instrument promises, and was it taken at the temperature the method asks for?";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    api.commitBlockEdit();
    for (let i = 0; i < 20; i += 1) await settle(60);
    const grown = { w: read().w, h: read().h };
    const body = document.querySelector('[data-pdf-block="' + block.id + '"] .pdf-block-body');
    return { set, grown, overflow: body.scrollHeight - body.clientHeight };
  }`);
  check("a diamond keeps its width and its height as the least, and grows to hold its words", shaped.grown.w === shaped.set.w && shaped.grown.h > shaped.set.h && shaped.overflow <= 1, JSON.stringify(shaped));

  // ── Pictures of it, on request: CANVAS_SHOTS=<dir> ──────────────────────
  const SHOTS = process.env.CANVAS_SHOTS || "";
  if (SHOTS) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOTS, { recursive: true });
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 2, mobile: false });
    const snap = async (name) => {
      const shot = await page.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, "base64"));
      console.log(`  shot  ${path.join(SHOTS, name)}`);
    };
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.state.meta.pdfBlocks = [];
      api.repaintDocumentBlocks();
      api.selectBlock(null);
      api.setPaperTone("black");
      api.toggleInkRail(true);
      await settle(700);
      window.__h.pageEl(1).scrollIntoView({ block: "start" });
      document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
      await settle(300);
    }`);
    // The Block button armed.
    await page.evaluate(`async () => { document.getElementById("documentTextBtn").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await window.__recall.settle(150); document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove()); }`);
    await snap("1-block-button-armed.png");
    // A tap, and words typed in place, some of them selected: the Notes bar.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const box = window.__h.pageEl(1).getBoundingClientRect();
      await window.__h.tap(box.left + 120, Math.max(box.top, 0) + 330, { pointerType: "mouse" });
      await settle(200);
      const ta = document.querySelector(".pdf-block-inline textarea");
      ta.value = "## Where we left the language thread\\n\\nA **transformer** works out relationships between pieces of a sequence: $\\\\text{softmax}(QK^T)V$.\\nGPT predicted the next chunk of text, over and over, at scale.";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      const at = ta.value.indexOf("over and over");
      ta.setSelectionRange(at, at + 13);
      ta.dispatchEvent(new Event("select", { bubbles: true }));
      ta.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle(500);
    }`);
    await snap("2-typing-in-place-with-selection-bar.png");
    // Put down: rendered, black ink drawn light on the black page.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const id = api.inlineBlockEditorId();
      api.writeBlockStyle(id, { ink: "ink" });
      api.commitBlockEdit();
      await settle(900);
      api.selectBlock(id);
      await settle(300);
    }`);
    await snap("3-put-down-and-picked-up.png");
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

console.log(`\ncanvas-blocks-check: ${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
