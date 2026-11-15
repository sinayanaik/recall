// Cards from the Canvas.
//
//   node tools/canvas-cards-check.mjs
//
// "The make cards feature is completely missing from the canvas." On a PDF a
// card is a live picture of a spot of the page (a `pdfref:`); on a Canvas there
// was no way to make one — ▣ was hidden there, the lasso's bar, a picked-up
// Block's strip and the bar over several picked had no card, and a region drawn
// on the Canvas made a ref to page N of the file's PDF. Now:
//
//   1. a `pdfref:` can name the Canvas (`:canvas`), old refs parse as before,
//      and remapCanvasRefs moves them with the Canvas's pages;
//   2. Card on the lasso's bar, a picked-up Block's strip and the bar over
//      several picked each open a card whose answer is a ref to that spot of
//      the Canvas page;
//   3. ▣ is on the Canvas, and its box's Make a card is a Canvas ref;
//   4. a Canvas ref shows a live picture, not the fallback, and its p. N ↗
//      opens the Canvas;
//   5. tearing a page out moves the refs in the cards with their pages.

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
    "/src/documents/pdf-region-embed.js?v=__BUILD__",
    "/src/documents/region-card.js?v=__BUILD__",
    "/src/documents/canvas-selection.js?v=__BUILD__",
    "/src/notes/frame-card.js?v=__BUILD__",
    "/src/documents/pdf-region.js?v=__BUILD__"
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
    from: () => { throw new Error("canvas-cards-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Canvas cards fixture", notesMode: true });
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
if (!chrome) { console.log("canvas-cards-check: no Chrome on this machine — skipping."); process.exit(0); }

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

// The newest "Make a card" panel's answer, and the panel closed again.
const TAKE_CARD_SRC = `async () => {
  const { api, settle } = window.__recall;
  await settle(150);
  const panels = [...document.querySelectorAll("#frameCardLayer .frame-card-panel")];
  const panel = panels[panels.length - 1];
  const answer = panel ? (panel.querySelector(".frame-card-answer-editor textarea")?.value || "") : null;
  api.cancelFrontFrameCard();
  await settle(100);
  return { panels: panels.length, answer };
}`;

// A Canvas ref's page and box, or null.
const parseRef = (text) => {
  const match = /pdfref:(\d+):([-\d.,]+):canvas\b/.exec(String(text || ""));
  return match ? { page: Number(match[1]), rect: match[2].split(",").map(Number) } : null;
};
const near = (a, b, slack = 4) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && a.every((n, i) => Math.abs(n - b[i]) <= slack);

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

  // ── 1. The ref itself ──────────────────────────────────────────────────
  const refs = await page.evaluate(`() => {
    const { api } = window.__recall;
    const p = (s) => JSON.stringify(api.parsePdfRef(s));
    const move = ({ page }) => (page === 1 ? null : page > 1 ? page - 1 : page);
    return {
      plain: p("pdfref:3:1,2,3,4"),
      other: p("pdfref:3:1,2,3,4:pdfB"),
      widthOnly: p("pdfref:3:1,2,3,4::480"),
      canvas: p("pdfref:3:1,2,3,4:canvas"),
      canvasWidth: p("pdfref:3:1,2,3,4:canvas:480"),
      written: api.pdfRegionRefMarkdown(2, [1, 2, 3, 4], api.CANVAS_REF_ID),
      remapped: api.remapCanvasRefs("a ![](pdfref:3:1,2,3,4:canvas:480) b ![](pdfref:1:5,6,7,8:canvas) c ![](pdfref:3:1,2,3,4)", move),
      untouched: api.remapCanvasRefs("![](pdfref:3:1,2,3,4)", move)
    };
  }`);
  check("an old ref parses as before", refs.plain === JSON.stringify({ page: 3, rect: [1, 2, 3, 4], pdfId: null, width: null })
    && refs.other === JSON.stringify({ page: 3, rect: [1, 2, 3, 4], pdfId: "pdfB", width: null })
    && refs.widthOnly === JSON.stringify({ page: 3, rect: [1, 2, 3, 4], pdfId: null, width: 480 }), JSON.stringify(refs));
  check("a Canvas ref parses, with and without a width",
    refs.canvas === JSON.stringify({ page: 3, rect: [1, 2, 3, 4], pdfId: "canvas", width: null })
    && refs.canvasWidth === JSON.stringify({ page: 3, rect: [1, 2, 3, 4], pdfId: "canvas", width: 480 }), `${refs.canvas} ${refs.canvasWidth}`);
  check("a Canvas ref is written with :canvas", refs.written === "![](pdfref:2:1,2,3,4:canvas)", refs.written);
  check("remapCanvasRefs moves Canvas refs, marks a torn-out page and leaves a PDF's alone",
    refs.remapped === "a ![](pdfref:2:1,2,3,4:canvas:480) b *Canvas · page 1 (torn out)* c ![](pdfref:3:1,2,3,4)"
    && refs.untouched === "![](pdfref:3:1,2,3,4)", refs.remapped);

  // ── 2a. The lasso's bar ────────────────────────────────────────────────
  const lasso = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { drag, fire, pageEl } = window.__h;
    api.setInkArmed(true);
    api.setInkTool("pen");
    api.refreshInkRail();
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(400);
    const box = pageEl(1).getBoundingClientRect();
    const x = box.left + box.width * 0.3;
    const y = box.top + 140;
    await drag(x, y, x + 120, y + 20);
    await drag(x, y + 50, x + 100, y + 70);
    await settle(300);
    api.setInkTool("lasso");
    api.refreshInkRail();
    await settle(100);
    // A loop round both strokes.
    const pts = [[x - 30, y - 30], [x + 160, y - 30], [x + 160, y + 110], [x - 30, y + 110], [x - 30, y - 28]];
    const at = (px, py) => document.elementFromPoint(px, py) || window.__h.view;
    fire(at(...pts[0]), "pointerdown", pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) {
      for (let k = 1; k <= 6; k += 1) {
        const px = pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / 6;
        const py = pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / 6;
        fire(at(px, py), "pointermove", px, py);
        await settle(12);
      }
    }
    fire(at(...pts[pts.length - 1]), "pointerup", pts[4][0], pts[4][1], { buttons: 0 });
    await settle(250);
    api.refreshInkRail();
    const area = api.inkSelectionArea();
    const button = document.querySelector('#inkRailSelection [data-ink-action="card"]');
    const shown = Boolean(button && button.getClientRects().length && !button.disabled);
    button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    return { count: api.inkSelectionCount(), area, shown };
  }`);
  const lassoCard = await page.evaluate(TAKE_CARD_SRC);
  const lassoRef = parseRef(lassoCard.answer);
  check("the lasso holds the two strokes and its bar shows Card", lasso.count === 2 && lasso.shown, JSON.stringify(lasso));
  check("Card on the lasso's bar opens a card of that spot of the Canvas",
    lassoRef?.page === 1 && lasso.area && near(lassoRef.rect, [lasso.area.rect[0] - 3, lasso.area.rect[1] - 3, lasso.area.rect[2] + 3, lasso.area.rect[3] + 3], 0.05),
    JSON.stringify({ answer: lassoCard.answer, area: lasso.area }));

  // ── 2b. A picked-up Block's strip ──────────────────────────────────────
  const block = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.clearInkSelection?.();
    api.setInkTool("pen");
    api.refreshInkRail();
    const made = api.addDocumentBlock(1, { x: 120, y: 420 }, { style: { fit: false }, w: 160, h: 60, edit: false });
    await settle(250);
    api.selectBlock(made.id);
    await settle(250);
    const button = document.querySelector('.pdf-block-actions-pop [data-block-popover-action="card"]');
    const b = api.documentBlocks().find((entry) => entry.id === made.id);
    button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    return { id: made.id, button: Boolean(button), rect: b ? [b.x, b.y, b.x + b.w, b.y + b.h] : null };
  }`);
  const blockCard = await page.evaluate(TAKE_CARD_SRC);
  const blockRef = parseRef(blockCard.answer);
  check("a picked-up Block's strip has Card", block.button, JSON.stringify(block));
  check("Card on the Block's strip opens a card of the Block's spot of the Canvas",
    blockRef?.page === 1 && near(blockRef.rect, [block.rect[0] - 3, block.rect[1] - 3, block.rect[2] + 3, block.rect[3] + 3], 0.05),
    JSON.stringify({ answer: blockCard.answer, rect: block.rect }));

  // ── 2c. The bar over several picked ────────────────────────────────────
  const picked = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.selectBlock(null);
    const other = api.addDocumentBlock(1, { x: 360, y: 520 }, { style: { fit: false }, w: 100, h: 50, edit: false });
    await settle(250);
    api.pickIds(1, [${JSON.stringify(block.id)}, other.id]);
    await settle(250);
    const button = document.querySelector('.diagram-arrange-bar:not([hidden]) [data-arrange="card"]');
    const o = api.documentBlocks().find((entry) => entry.id === other.id);
    button?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    return { button: Boolean(button), other: o ? [o.x, o.y, o.x + o.w, o.y + o.h] : null };
  }`);
  const pickedCard = await page.evaluate(TAKE_CARD_SRC);
  const pickedRef = parseRef(pickedCard.answer);
  const union = picked.other && block.rect ? [
    Math.min(block.rect[0], picked.other[0]) - 3, Math.min(block.rect[1], picked.other[1]) - 3,
    Math.max(block.rect[2], picked.other[2]) + 3, Math.max(block.rect[3], picked.other[3]) + 3
  ] : null;
  check("the bar over several picked has Card", picked.button, JSON.stringify(picked));
  check("Card on that bar opens a card of the box round everything picked",
    pickedRef?.page === 1 && near(pickedRef.rect, union, 0.05), JSON.stringify({ answer: pickedCard.answer, union }));

  // ── 3. ▣ on the Canvas ─────────────────────────────────────────────────
  // Trusted mouse input: ▣ takes the pointer and captures it, which a
  // synthetic event from inside the page does not go through.
  const prep = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const { pageEl } = window.__h;
    api.clearPick();
    api.selectBlock(null);
    await settle(150);
    const btn = document.getElementById("documentRegionBtn");
    const visible = Boolean(btn && getComputedStyle(btn).display !== "none" && btn.getClientRects().length);
    btn?.click();
    await settle(150);
    pageEl(1).scrollIntoView({ block: "start" });
    await settle(300);
    const box = pageEl(1).getBoundingClientRect();
    return { visible, armed: api.isRegionSelectArmed(), x: Math.round(box.left + box.width * 0.55), y: Math.round(Math.min(box.top + 160, window.innerHeight - 160)) };
  }`);
  const mouse = (type, x, y, buttons) => page.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "mouse" });
  await mouse("mouseMoved", prep.x, prep.y, 0);
  await mouse("mousePressed", prep.x, prep.y, 1);
  for (let i = 1; i <= 10; i += 1) {
    await mouse("mouseMoved", prep.x + 12 * i, prep.y + 8 * i, 1);
    await new Promise((r) => setTimeout(r, 16));
  }
  await mouse("mouseReleased", prep.x + 120, prep.y + 80, 0);
  const region = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    await settle(300);
    const records = api.state.meta.pdfHighlights || [];
    const made = records.find((r) => r.kind === "area" && r.doc === "notebook");
    const action = document.querySelector('.mark-menu [data-mark-action="card"]');
    action?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    await settle(200);
    return { visible: ${JSON.stringify(prep.visible)}, armed: ${JSON.stringify(prep.armed)}, made: Boolean(made), menu: Boolean(action), rect: made?.quads?.[0]?.rect || null, page: made?.page || null };
  }`);
  const regionCard = await page.evaluate(TAKE_CARD_SRC);
  const regionRef = parseRef(regionCard.answer);
  check("▣ is on the Canvas, and arms", region.visible && region.armed, JSON.stringify(region));
  check("a box drawn with ▣ on the Canvas is a Canvas region with a menu", region.made && region.menu, JSON.stringify(region));
  check("its Make a card is a ref to the Canvas, not to a PDF",
    regionRef?.page === region.page && /:canvas\b/.test(regionCard.answer || "") && near(regionRef.rect, region.rect, 0.05),
    JSON.stringify({ answer: regionCard.answer, rect: region.rect }));

  // ── 4. A Canvas ref, shown ─────────────────────────────────────────────
  const shown = await page.evaluate(`async (ref) => {
    const { api, settle } = window.__recall;
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed; left:0; top:0; width:480px; z-index:99999; background:#fff";
    const img = document.createElement("img");
    img.setAttribute("src", ref.slice(4, -1));
    holder.appendChild(img);
    document.body.appendChild(holder);
    api.mountPdfRegionEmbed(img);
    for (let i = 0; i < 60 && holder.querySelector(".pdf-region-embed.is-loading"); i += 1) await settle(100);
    const wrapper = holder.querySelector(".pdf-region-embed");
    const out = {
      canvas: Boolean(wrapper?.querySelector("canvas.pdf-region-embed-canvas")),
      fallback: Boolean(wrapper?.classList.contains("is-fallback")),
      goTitle: wrapper?.querySelector(".pdf-region-embed-btn")?.title || ""
    };
    // Its p. N ↗, from the Notes.
    document.querySelector('#viewModeToggle [data-view-mode="notes"]')?.click();
    await settle(300);
    const go = wrapper?.querySelector(".pdf-region-embed-btn");
    go?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && api.state.viewMode !== "handwriting"; i += 1) await settle(100);
    await settle(400);
    out.viewAfterGo = api.state.viewMode;
    holder.remove();
    return out;
  }`, "![](pdfref:1:100,100,300,300:canvas)");
  check("a Canvas ref shows a live picture of the Canvas page", shown.canvas && !shown.fallback, JSON.stringify(shown));
  check("its p. N ↗ says Canvas and opens the Canvas", /Canvas/.test(shown.goTitle) && shown.viewAfterGo === "handwriting", JSON.stringify(shown));

  // ── 5. Pages renumbered ────────────────────────────────────────────────
  const torn = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    await api.addNotebookPage();
    await settle(600);
    const card = { id: "card-canvas-remap", question: "Where?", answer: "![](pdfref:2:10,10,50,50:canvas)\\n\\n![](pdfref:1:10,10,50,50:canvas)" };
    api.state.masterCards.push(card);
    const pagesBefore = api.notebookPageCount();
    await api.deleteNotebookPage(1);
    await settle(600);
    const after = api.state.masterCards.find((c) => c.id === card.id)?.answer || "";
    return { pagesBefore, pagesAfter: api.notebookPageCount(), after };
  }`);
  check("tearing out page 1 moves a ref to page 2 onto page 1, and marks one to page 1",
    torn.pagesBefore === 2 && torn.pagesAfter === 1
    && torn.after.includes("![](pdfref:1:10,10,50,50:canvas)") && torn.after.includes("Canvas · page 1 (torn out)"),
    JSON.stringify(torn));

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

console.log(`\ncanvas-cards-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
