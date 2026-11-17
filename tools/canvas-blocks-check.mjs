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
//      impossible: every press on it was a drag. A double-tap (or Enter)
//      opens it in place, where words select and the Notes selection bar
//      styles them. A single tap never does: "I am just clicking on a block
//      and the text cursor starts blinking, but I haven't started writing."
//   5. A block is typed at the width it was given and drawn in to its longest
//      line once put down; its height follows the words. It is typed from the
//      left, whatever its alignment.

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
    "/src/format/ink-strokes.js?v=__BUILD__",
    "/src/ui/theme.js?v=__BUILD__",
    "/src/ui/style-settings.js?v=__BUILD__"
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
    const addMenu = document.getElementById("documentInsertMenu");
    out.addRows = [...addMenu.querySelectorAll("[data-hw-action]")].map((b) => b.dataset.hwAction);
    out.textRow = Boolean(addMenu.querySelector('[data-hw-action="add-text"]'));
    // Insert, beside the pen in the top row, and its Block row.
    const button = document.getElementById("documentInsertBtn");
    const blockRow = addMenu.querySelector('[data-hw-action="add-block"]');
    // A press is a pointerdown AND its pointerup: one left without the other
    // reads, to the Notes selection code, as a drag still going on.
    const pressRow = () => {
      blockRow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      blockRow.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    };
    out.buttonLabel = button.getAttribute("aria-label");
    out.inPenBar = Boolean(document.getElementById("documentInkRail").querySelector("[data-hw-action]"));
    const before = api.documentBlocks().length;
    const strokes = inkStrokes();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle(80);
    out.menuOpen = !addMenu.hidden;
    pressRow();
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
    // Armed, then Insert pressed again: put away, nothing placed.
    pressRow();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    out.toggledOff = !api.isBlockPlacementArmed() && api.documentBlocks().length === before;
    // The keyboard's press (a click with no pointer, detail 0) has nothing to
    // tap with: the block goes in the middle of the view, open, at once.
    blockRow.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await settle(150);
    out.keyboardPlaced = api.documentBlocks().length === before + 1 && api.isInlineBlockEditorOpen() && !api.isBlockPlacementArmed();
    api.commitBlockEdit();
    await settle(150);
    out.keyboardEmptyGone = api.documentBlocks().length === before;
    return out;
  }`);
  check("Insert, in the top row and not the pen's bar, has Block, the shapes and Picture — no Text row", !place.textRow && place.addRows.includes("add-block") && !place.inPenBar, JSON.stringify(place.addRows));
  check("Insert → Block arms a block, Insert lit", place.menuOpen && place.armed && place.lit && place.buttonLabel === "Insert", JSON.stringify(place));
  check("a tap puts one block at the tap, with no ink, and the button goes out", place.made === 1 && place.inked === 0 && place.nearCorner && place.disarmed, JSON.stringify(place));
  check("...open in place to type in, no window over the page", place.open && place.inBlock && place.focused && place.noSheet, JSON.stringify(place));
  check("...with a three-button strip: Style, Full editor, Done", place.strip === "style,full-editor,done", place.strip);
  check("a block put down empty goes again; Insert pressed while armed places nothing", place.emptyGone && place.toggledOff, JSON.stringify(place));
  check("from the keyboard, Block puts a block in the middle of the view at once", place.keyboardPlaced && place.keyboardEmptyGone, JSON.stringify(place));

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
    // ...beside the Block and its strip, never over either.
    const meets = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const pillBox = pill?.getBoundingClientRect();
    out.pillShown = out.pill && !pill.classList.contains("is-offscreen") && pillBox.width > 0;
    out.pillOnBlock = meets(pillBox, node().getBoundingClientRect());
    out.pillOnStrip = meets(pillBox, document.querySelector(".pdf-block-actions-pop")?.getBoundingClientRect());
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
    // ...and a second tap, a moment later, still only picks it up: no caret.
    // (Measured again: picking a block up puts its actions on the pen's bar,
    // which can push the page down a row.)
    await settle(450);
    r = node().getBoundingClientRect();
    await tap(r.left + 20, r.top + r.height / 2, { pointerType: "mouse" });
    await settle(100);
    out.secondTapStays = api.selectedBlockId() === block.id && !api.isInlineBlockEditorOpen()
      && !node().querySelector(".pdf-block-inline textarea");
    // Enter on a picked-up block opens it; Escape puts it down again.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(100);
    out.enterOpens = api.isInlineBlockEditorOpen() && api.inlineBlockEditorId() === block.id;
    api.commitBlockEdit();
    await settle(450);
    // A double-tap opens it in place.
    r = node().getBoundingClientRect();
    await tap(r.left + 20, r.top + r.height / 2, { pointerType: "mouse" });
    await tap(r.left + 20, r.top + r.height / 2, { pointerType: "mouse" });
    await settle(100);
    out.doubleTapOpens = api.isInlineBlockEditorOpen() && api.inlineBlockEditorId() === block.id;
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
    // A picked-up block's strip: one slim row, the restack verbs behind Arrange.
    const strip = document.querySelector(".pdf-block-actions-pop");
    out.stripHeight = strip ? Math.round(strip.getBoundingClientRect().height) : -1;
    out.stripRow = [...(strip?.querySelectorAll(":scope > [data-block-popover-action], :scope > .block-actions-arrange > [data-block-popover-action]") || [])].map((b) => b.dataset.blockPopoverAction).join(",");
    const menu = strip?.querySelector(".block-actions-menu");
    out.menuShut = Boolean(menu?.hidden);
    strip?.querySelector('[data-block-popover-action="arrange"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    out.menuOpen = Boolean(menu) && !menu.hidden;
    out.menuItems = [...(menu?.querySelectorAll("[data-block-popover-action]") || [])].map((b) => b.dataset.blockPopoverAction).join(",");
    return out;
  }`);
  check("selecting words in a block being typed raises the Notes selection bar", edit.pill, JSON.stringify(edit));
  check("...clear of the block and of its Style / Full editor / Done strip", edit.pillShown && !edit.pillOnBlock && !edit.pillOnStrip, JSON.stringify(edit));
  check("...whose B makes them bold", edit.typed === "hello **world**", JSON.stringify(edit));
  check("Ctrl+Enter puts the words down, written and rendered", edit.closed && edit.md === "hello **world**" && edit.strong === "world", JSON.stringify(edit));
  check("a tap picks a block up, and a second tap later does not open it to type in", edit.firstTapSelects && edit.secondTapStays, JSON.stringify(edit));
  check("...a double-tap, or Enter, opens it in place", edit.doubleTapOpens && edit.enterOpens, JSON.stringify(edit));
  check("dragging across the words being typed selects them, not the block", edit.selectingDoesNotMove, JSON.stringify(edit));
  check("a press on the paper puts the words down; a drag on a picked-up block moves it", edit.paperCommits && edit.dragMoves, JSON.stringify(edit));
  check("a picked-up block's strip is one slim row: Style, Edit, Duplicate, Copy, Card, Arrange, Delete", edit.stripHeight > 0 && edit.stripHeight < 48 && edit.stripRow === "style,edit,duplicate,copy,card,arrange,delete", JSON.stringify(edit));
  check("...and Arrange opens the four restack verbs, a quarter turn and Cut", edit.menuShut && edit.menuOpen && edit.menuItems === "restack-forward,restack-back,to-front,to-back,turn,cut", JSON.stringify(edit));

  // ── 5. The width hugs the words once down; the height follows them ─────
  const size = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const block = api.addDocumentBlock(1, { x: 120, y: 300 }, { edit: false });
    await settle(200);
    const read = () => api.documentBlocks().find((b) => b.id === block.id);
    const write = async (md) => {
      api.editBlock(block.id);
      await settle(50);
      const ta = document.querySelector('[data-pdf-block="' + block.id + '"] .pdf-block-inline textarea');
      const scale = api.pdfPageViewport(block.page)?.scale || 1;
      const liveW0 = document.querySelector('[data-pdf-block="' + block.id + '"]').getBoundingClientRect().width / scale;
      ta.value = md;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(50);
      const liveH = document.querySelector('[data-pdf-block="' + block.id + '"]').getBoundingClientRect().height;
      api.commitBlockEdit();
      for (let i = 0; i < 20; i += 1) await settle(60);
      const node = document.querySelector('[data-pdf-block="' + block.id + '"]');
      const body = node.querySelector(".pdf-block-body");
      return { ...read(), liveH, liveW0, overflow: body.scrollHeight - body.clientHeight, overflowX: body.scrollWidth - body.clientWidth };
    };
    const w0 = read().w;
    const short = await write("one");
    const long = await write("A first paragraph that runs on for a while, long enough to wrap over more than one line of the block.\\n\\nA second paragraph, also of some length, so that the block has to grow.\\n\\nAnd a third.");
    const back = await write("one");
    return {
      w0,
      short: { w: short.w, h: short.h, wSet: short.wSet, overflowX: short.overflowX },
      long: { w: long.w, h: long.h, liveH: long.liveH, liveW0: long.liveW0, overflow: long.overflow, wSet: long.wSet },
      back: { w: back.w, h: back.h }
    };
  }`);
  check("a block is drawn in to a short word once it is put down, and nothing is cut off", size.short.w < size.w0 / 2 && size.short.wSet === size.w0 && size.short.overflowX <= 1, JSON.stringify(size));
  check("...opens out to the width it was given to be typed in again, and keeps it for a paragraph", Math.abs(size.long.liveW0 - size.w0) <= 2 && size.long.w === size.w0 && !size.long.wSet && size.back.w === size.short.w, JSON.stringify(size));
  check("...and its height follows the words, while typed and once put down, with nothing cut off", size.long.h > size.short.h * 2 && size.long.liveH > 60 && size.long.overflow <= 1 && Math.abs(size.back.h - size.short.h) <= 3, JSON.stringify(size));

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

  // ...a width dragged by hand is the reader's from then on: what the block
  // opens out to the next time it is typed in, not the one it was drawn in from.
  const dragged = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { fire } = window.__h;
    const block = api.addDocumentBlock(1, { x: 120, y: 560 }, { edit: false });
    await settle(200);
    const read = () => api.documentBlocks().find((b) => b.id === block.id);
    const node = () => document.querySelector('[data-pdf-block="' + block.id + '"]');
    api.editBlock(block.id);
    await settle(50);
    const ta = node().querySelector(".pdf-block-inline textarea");
    ta.value = "label";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    api.commitBlockEdit();
    for (let i = 0; i < 20; i += 1) await settle(60);
    const drawnIn = { w: read().w, wSet: read().wSet };
    api.selectBlock(block.id);
    await settle(100);
    const grip = node().querySelector('.pdf-block-grip[data-edge="se"]');
    const g = grip.getBoundingClientRect();
    const x0 = g.left + g.width / 2;
    const y0 = g.top + g.height / 2;
    fire(grip, "pointerdown", x0, y0, { pointerType: "mouse" });
    for (let i = 1; i <= 6; i += 1) { fire(grip, "pointermove", x0 + i * 10, y0, { pointerType: "mouse" }); await settle(16); }
    fire(grip, "pointerup", x0 + 60, y0, { pointerType: "mouse", buttons: 0 });
    await settle(200);
    const after = { w: read().w, wSet: read().wSet };
    return { drawnIn, after };
  }`);
  check("a width dragged by hand drops the width the block was drawn in from", dragged.drawnIn.wSet > dragged.drawnIn.w && dragged.after.w > dragged.drawnIn.w && dragged.after.wSet === undefined, JSON.stringify(dragged));

  // A block set to the centre is typed from the left, and centred once down.
  const aligned = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const block = api.addDocumentBlock(1, { x: 300, y: 650 }, { style: { align: "center" }, edit: false });
    await settle(200);
    const node = () => document.querySelector('[data-pdf-block="' + block.id + '"]');
    api.editBlock(block.id);
    await settle(50);
    const ta = node().querySelector(".pdf-block-inline textarea");
    ta.value = "A centred line, typed from the left";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(50);
    const typing = getComputedStyle(ta).textAlign;
    const mirror = getComputedStyle(node().querySelector(".pdf-block-inline .highlight-textarea-backdrop")).textAlign;
    api.commitBlockEdit();
    for (let i = 0; i < 10; i += 1) await settle(60);
    const down = getComputedStyle(node().querySelector(".pdf-block-body")).textAlign;
    return { typing, mirror, down };
  }`);
  check("a centred block is typed left-aligned, and shows centred once put down", aligned.typing === "left" && aligned.mirror === "left" && aligned.down === "center", JSON.stringify(aligned));

  // ── 6. What goes on the page is beside the pen, not inside it ─────────
  const tools = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.selectBlock(null);
    api.toggleInkRail(false);
    await settle(100);
    const boxed = (node) => { const r = node?.getBoundingClientRect(); return Boolean(r && r.width > 0 && r.height > 0); };
    const out = {
      shapes: boxed(document.getElementById("documentShapesBtn")),
      insert: boxed(document.getElementById("documentInsertBtn")),
      penBarShapes: Boolean(document.querySelector('#documentInkRail [data-ink-tool="shape"]')),
      penBarAdd: Boolean(document.querySelector("#documentInkRail [data-hw-action]")),
      addPage: boxed(document.getElementById("documentAddPageBtn"))
    };
    // Shapes, with the pen's bar shut: the Shapes tool, and its menu.
    document.getElementById("documentShapesBtn").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle(150);
    out.armed = api.isInkArmed() && api.inkTool() === "shape";
    out.menu = !document.getElementById("documentShapesMenu").hidden;
    out.lit = document.getElementById("documentShapesBtn").getAttribute("aria-pressed") === "true";
    const ellipse = document.querySelector('#documentShapesMenu [data-shape-type="ellipse"]');
    ellipse.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    ellipse.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    ellipse.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle(150);
    out.picked = api.shapeType() === "ellipse" && document.getElementById("documentShapesMenu").hidden;
    api.chooseInkTool?.("pen");
    api.setInkTool("pen");
    api.toggleInkRail(false);
    await settle(100);
    return out;
  }`);
  check("Shapes and Insert are in the top row; the pen's bar has neither", tools.shapes && tools.insert && !tools.penBarShapes && !tools.penBarAdd, JSON.stringify(tools));
  check("Shapes arms the Shapes tool and opens its menu; a row picks the shape", tools.armed && tools.menu && tools.lit && tools.picked, JSON.stringify(tools));
  check("the Canvas's pager has a + for a page", tools.addPage, JSON.stringify(tools));

  // ── 7. A block turns, and resizes in both directions ─────────────────────
  const turn = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { drag } = window.__h;
    api.commitBlockEdit?.();
    const keep = api.documentBlocks().filter((b) => b.page !== 1);
    api.writeDocumentBlocks([...keep,
      { id: "turnme", page: 1, x: 120, y: 560, w: 150, h: 60, md: "Turn me" },
      { id: "tallme", page: 1, x: 120, y: 400, w: 150, h: 60, md: "Make me taller" }
    ]);
    await settle(300);
    document.querySelector('[data-pdf-block="turnme"]').scrollIntoView({ block: "center" });
    await settle(300);
    const read = (id) => api.documentBlocks().find((b) => b.id === id);
    const out = {};
    api.selectBlock("turnme");
    await settle(200);
    const knob = document.querySelector(".pdf-block-turn");
    out.knob = Boolean(knob);
    if (!knob) return out;
    const k = knob.getBoundingClientRect();
    const b = document.querySelector('[data-pdf-block="turnme"]').getBoundingClientRect();
    // Dragged round to the right of the middle: a quarter turn clockwise.
    await drag(k.left + k.width / 2, k.top + k.height / 2, b.left + b.width / 2 + 120, b.top + b.height / 2 + 2, { pointerType: "mouse" });
    await settle(250);
    out.rot = read("turnme").rot;
    out.drawnTurned = document.querySelector('[data-pdf-block="turnme"]').style.transform;
    api.undoBlocks();
    await settle(200);
    out.undone = !read("turnme").rot;
    // The quarter turn from Arrange, and Straighten.
    api.rotateBlockBy("turnme", 90);
    out.quarter = read("turnme").rot;
    api.setBlockRotation("turnme", 0);
    out.straight = !("rot" in read("turnme"));
    // The top edge of a block whose height follows its words: drag it up.
    api.selectBlock("tallme");
    await settle(200);
    const before = read("tallme");
    out.fitBefore = !before.style || before.style.fit !== false;
    const n = document.querySelector('[data-pdf-block="tallme"] .pdf-block-edge-n').getBoundingClientRect();
    out.nShown = n.width > 0 && n.height > 0;
    await drag(n.left + n.width / 2, n.top + 2, n.left + n.width / 2, n.top - 50, { pointerType: "mouse" });
    await settle(400);
    const after = read("tallme");
    out.tall = [before.h, after.h, before.y, after.y];
    out.fitAfter = after.style?.fit;
    api.selectBlock(null);
    return out;
  }`);
  check("a picked-up block wears a turning handle, and dragging it round turns the block", turn.knob && turn.rot === -90 && /rotate\(90deg\)/.test(turn.drawnTurned), JSON.stringify(turn));
  check("...one undo step; a quarter turn and Straighten from its actions", turn.undone && turn.quarter === 90 && turn.straight, JSON.stringify(turn));
  check("a block whose height follows its words has a top edge, and dragging it makes it taller, its bottom kept", turn.fitBefore && turn.nShown && turn.tall[1] > turn.tall[0] + 15 && turn.tall[3] === turn.tall[2], JSON.stringify(turn));
  check("...and the height is the reader's from then on", turn.fitAfter === false, JSON.stringify(turn));

  // ── 8. A Canvas's pages: duplicated with what is on them, and moved ──────
  const pages = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const wait = async () => { for (let i = 0; i < 30; i += 1) await settle(100); };
    const out = { start: api.notebookPageCount() };
    api.writeDocumentBlocks([...api.documentBlocks().filter((b) => b.page !== 1),
      { id: "p1a", page: 1, x: 60, y: 600, w: 120, h: 50, md: "A" },
      { id: "p1b", page: 1, x: 300, y: 600, w: 120, h: 50, md: "B" }
    ]);
    api.addDocumentShape(1, { type: "arrow", p: [[0, 0], [1, 1]], stroke: "#000000", width: 1.5, ends: [{ id: "p1a", side: "auto" }, { id: "p1b", side: "auto" }] });
    await settle(200);
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(300);
    api.runHandwritingMenuAction("hw-page-duplicate");
    await wait();
    out.pages = api.notebookPageCount();
    const copies = api.documentBlocks().filter((b) => b.page === 2).map((b) => b.id);
    out.copies = copies.length;
    // The copy of the one connector made above (earlier sections left other
    // lines on page 1, tied to blocks no longer there).
    const line = api.documentHighlights().find((r) => r.kind === "shape" && r.page === 2 && r.shape.ends?.some((e) => e && copies.includes(e.id)));
    out.tied = Boolean(line) && line.shape.ends.every((e) => e && copies.includes(e.id));
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(300);
    api.runHandwritingMenuAction("hw-page-down");
    await wait();
    out.moved = api.documentBlocks().find((b) => b.id === "p1a")?.page;
    out.copiesUp = api.documentBlocks().filter((b) => copies.includes(b.id)).every((b) => b.page === 1);
    return out;
  }`);
  check("Duplicate this page puts a copy after it, its connector tied to the copies", pages.pages === pages.start + 1 && pages.copies === 2 && pages.tied, JSON.stringify(pages));
  check("Move this page down swaps it with the next, everything on both with it", pages.moved === 2 && pages.copiesUp, JSON.stringify(pages));

  // ── 9. What is written on the page looks like the page it is on ────────
  //
  // "The canvas only half-follows the theme": a Block's card and words followed
  // the paper while its headings, links and quote bar kept the theme's accent —
  // AMOLED's pale cyan h1 on White paper — and its code was a dark panel on
  // every paper. And "a font change only reaches the plain words": headings,
  // code, tables and the page numbers had no face of their own to be given.
  // Read off computed styles, on two papers under two themes.
  const look = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // A computed colour in any of the three forms a browser hands back: #hex
    // (a custom property), rgb() and color(srgb …) (a color-mix()).
    const rgbOf = (css) => {
      const text = String(css).trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(text);
      if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
      const srgb = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/i.exec(text);
      if (srgb) return [srgb[1], srgb[2], srgb[3]].map((v) => Number(v) * 255);
      const m = text.match(/\\d+(\\.\\d+)?/g);
      return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
    };
    const lum = (css) => {
      const c = rgbOf(css).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const stage = document.getElementById("documentStage");
    const paperBg = () => getComputedStyle(stage).getPropertyValue("--paper-bg").trim();
    api.selectBlock(null);
    api.setTheme("dark-amoled");
    api.setPaperTone("white");
    await settle(600);
    const md = "# Heading one\\n\\n### Heading three\\n\\nWords with a [link](https://example.com) and \`inline\`.\\n\\n> A quote\\n\\n\`\`\`js\\nconst x = 1; // note\\n\`\`\`\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |";
    const block = api.addDocumentBlock(1, { x: 60, y: 780 }, { anchor: "top-left", edit: false, w: 300, md });
    window.__h.pageEl(1).scrollIntoView({ block: "start" });
    await settle(1200);
    const node = () => document.querySelector('[data-pdf-block="' + block.id + '"]');
    const body = () => node().querySelector(".pdf-block-body");
    const css = (sel, prop, pseudo) => { const n = sel ? body().querySelector(sel) : body(); return n ? getComputedStyle(n, pseudo)[prop] : ""; };
    const out = { id: block.id };
    out.white = { bg: paperBg(), h1: css("h1", "color"), h3: css("h3", "color"), a: css("a", "color"), pre: css("pre", "backgroundColor"), p: css("p", "color") };
    out.white.h1Contrast = contrast(out.white.h1, out.white.bg);
    out.white.h3Contrast = contrast(out.white.h3, out.white.bg);
    out.white.linkContrast = contrast(out.white.a, out.white.bg);
    out.white.preLum = lum(out.white.pre);
    api.setPaperTone("black");
    await settle(600);
    out.black = { bg: paperBg(), h1: css("h1", "color"), pre: css("pre", "backgroundColor"), code: css("pre code", "color") };
    out.black.h1Contrast = contrast(out.black.h1, out.black.bg);
    out.black.preLum = lum(out.black.pre);
    out.black.codeContrast = contrast(out.black.code, out.black.pre);
    // A theme change reaches the headings without the Block being touched.
    api.setPaperTone("white");
    await settle(400);
    const h1Amoled = css("h1", "color");
    api.setTheme("light-snow");
    await settle(600);
    out.themed = { before: h1Amoled, after: css("h1", "color"), bg: paperBg() };
    out.themed.contrast = contrast(out.themed.after, out.themed.bg);
    // ...and nothing outside a page changes: a code panel in a note is the dark one.
    const note = document.createElement("div");
    note.className = "rendered";
    note.innerHTML = "<pre><code>x</code></pre>";
    document.body.appendChild(note);
    out.noteCode = getComputedStyle(note.querySelector("pre")).backgroundColor;
    note.remove();

    // ◐ Canvas: the faces, the table size and the heading colour.
    const before = { ...api.state.styleSettings };
    api.applyStyleSettings({ ...before, canvasBlockFontFamily: "serif", canvasHeadingFontFamily: "mono", canvasCodeFontFamily: "rounded", canvasLabelFontFamily: "serif", canvasTableFontScale: "0.5", canvasHeadingColor: "text", canvasCodeLook: "dark" });
    await settle(500);
    out.type = {
      p: css("p", "fontFamily"), h1: css("h1", "fontFamily"), code: css("pre code", "fontFamily"), inline: css("p code", "fontFamily"),
      table: parseFloat(css("table", "fontSize")), words: parseFloat(css("p", "fontSize")),
      h1Colour: css("h1", "color"), pColour: css("p", "color"), pre: css("pre", "backgroundColor"),
      number: getComputedStyle(window.__h.pageEl(1), "::after").fontFamily,
      numberColour: getComputedStyle(window.__h.pageEl(1), "::after").color
    };
    out.type.preLum = lum(out.type.pre);

    // A Block's own Style wins over ◐ Canvas.
    api.writeBlockStyle(block.id, { headFont: "rounded", headInk: "red", codeFont: "serif", weight: 600, lineHeight: 2, letterSpacing: 1 });
    await settle(500);
    out.own = {
      h1: css("h1", "fontFamily"), h1Colour: css("h1", "color"), code: css("pre code", "fontFamily"),
      weight: css(null, "fontWeight"), lh: parseFloat(css(null, "lineHeight")) / parseFloat(css(null, "fontSize")),
      spacing: parseFloat(css(null, "letterSpacing")),
      stored: Object.keys(api.documentBlocks().find((b) => b.id === block.id)?.style || {}).sort().join(",")
    };
    // The words being typed in place are set exactly as they are put down.
    const bodyMetrics = { size: css(null, "fontSize"), lh: css(null, "lineHeight"), face: css(null, "fontFamily"), weight: css(null, "fontWeight") };
    api.editBlock(block.id);
    await settle(400);
    const ta = node().querySelector(".pdf-block-inline textarea");
    const tas = ta ? getComputedStyle(ta) : null;
    out.inline = { body: bodyMetrics, ta: tas ? { size: tas.fontSize, lh: tas.lineHeight, face: tas.fontFamily, weight: tas.fontWeight } : null };
    api.commitBlockEdit();
    await settle(300);

    api.applyStyleSettings(before);
    api.setTheme("dark-amoled");
    api.writeDocumentBlocks(api.documentBlocks().filter((b) => b.id !== block.id));
    await settle(400);
    return out;
  }`);
  check("on White paper under a dark theme, a Block's h1, h3 and links read (≥ 4.5:1) in the theme's accent",
    look.white.h1Contrast >= 4.5 && look.white.h3Contrast >= 4.5 && look.white.linkContrast >= 4.5, JSON.stringify(look.white));
  check("...its code panel is a light one on White paper and a dark one on Black",
    look.white.preLum > 0.8 && look.black.preLum < 0.02 && look.black.codeContrast >= 4.5, JSON.stringify({ white: look.white.pre, black: look.black }));
  check("...the h1 reads on Black paper too", look.black.h1Contrast >= 4.5, JSON.stringify(look.black));
  check("a theme change reaches a Block's headings without the Block being touched",
    look.themed.before !== look.themed.after && look.themed.contrast >= 4.5, JSON.stringify(look.themed));
  check("...and a code panel in a note is the dark one it always was", /rgb\(11, 17, 16\)/.test(look.noteCode), look.noteCode);
  check("◐ Canvas sets the face of a Block's words, headings, code and the page numbers",
    /Georgia/.test(look.type.p) && /Consolas|SFMono/.test(look.type.h1) && /ui-rounded/.test(look.type.code)
      && /ui-rounded/.test(look.type.inline) && /Georgia/.test(look.type.number), JSON.stringify(look.type));
  check("...a table's size as a share of the words around it",
    look.type.table > 0 && Math.abs(look.type.table / look.type.words - 0.5) < 0.06, JSON.stringify(look.type));
  check("...headings in the words' colour, and code always dark",
    look.type.h1Colour === look.type.pColour && look.type.preLum < 0.05, JSON.stringify(look.type));
  check("a Block's own heading face, heading colour, code face, weight, lines and letters win over ◐ Canvas",
    /ui-rounded/.test(look.own.h1) && /rgb\(220, 38, 38\)/.test(look.own.h1Colour) && /Georgia/.test(look.own.code)
      && look.own.weight === "600" && Math.abs(look.own.lh - 2) < 0.02 && look.own.spacing > 0, JSON.stringify(look.own));
  check("...stored as only what was set", !/(^|,)(fill|ink|frame|fit|shape)(,|$)/.test(look.own.stored) && /headFont/.test(look.own.stored), look.own.stored);
  check("the words typed in place are set in the face, size, spacing and weight they are put down in",
    look.inline.ta && look.inline.ta.size === look.inline.body.size && look.inline.ta.lh === look.inline.body.lh
      && look.inline.ta.face === look.inline.body.face && look.inline.ta.weight === look.inline.body.weight, JSON.stringify(look.inline));

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
    await page.evaluate(`async () => { window.__recall.api.armBlockPlacement(true); await window.__recall.settle(150); document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove()); }`);
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
    // Its strip's Arrange, open.
    await page.evaluate(`async () => {
      document.querySelector('.pdf-block-actions-pop [data-block-popover-action="arrange"]')
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
      await window.__recall.settle(150);
    }`);
    await snap("4-picked-up-arrange-open.png");
    // A one-word hexagon block, its word selected: the bar above it, the strip below.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.selectBlock(null);
      await settle(150);
      const block = api.addDocumentBlock(1, { x: 260, y: 640 }, { anchor: "top-left" });
      await settle(200);
      api.writeBlockStyle(block.id, { shape: "hexagon" });
      await settle(200);
      const ta = document.querySelector(".pdf-block-inline textarea");
      ta.focus();
      ta.value = "Inheritance";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.setSelectionRange(0, 11);
      ta.dispatchEvent(new Event("select", { bubbles: true }));
      ta.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await settle(500);
    }`);
    await snap("5-hexagon-word-selected.png");
    // A Block of every kind of markdown, under three themes and three papers,
    // then in ◐ Canvas's own type — the theme reaching the WHOLE Block.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.selectBlock(null);
      api.writeDocumentBlocks([]);
      const md = "# Heading one\\n\\n## Heading two\\n\\n### Heading three\\n\\nWords with **bold**, a [link](https://example.com) and \\\`inline code\\\`.\\n\\n> A quote, with its bar.\\n\\n\\\`\\\`\\\`js\\nfunction add(a, b) {\\n  return a + b; // sum\\n}\\n\\\`\\\`\\\`\\n\\n| Term | Meaning |\\n|---|---|\\n| key | value |";
      // A plain Block, whatever the cases above left remembered for the next one.
      api.addDocumentBlock(1, { x: 40, y: 800 }, { anchor: "top-left", edit: false, w: 330, md, style: { fill: "paper" } });
      api.state.meta.pdfHighlights = (api.state.meta.pdfHighlights || []).filter((r) => r.kind !== "shape");
      api.repaintDocumentShapes?.();
      await settle(900);
      window.__h.pageEl(1).scrollIntoView({ block: "start" });
      await settle(300);
    }`);
    for (const [theme, paper] of [["dark-amoled", "white"], ["dark-amoled", "theme"], ["light-snow", "black"], ["dark-navy", "theme"], ["dark-bronze", "sepia"]]) {
      await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        api.setTheme(${JSON.stringify(theme)});
        api.setPaperTone(${JSON.stringify(paper)});
        await settle(900);
        document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
      }`);
      await snap(`6-theme-${theme}-on-${paper}.png`);
    }
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.applyStyleSettings({ ...api.state.styleSettings, canvasBlockFontFamily: "serif", canvasHeadingFontFamily: "rounded", canvasCodeFontFamily: "mono", canvasLabelFontFamily: "serif", canvasHeadingColor: "accent" });
      await settle(800);
    }`);
    await snap("7-canvas-type-serif-rounded-mono.png");
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
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
