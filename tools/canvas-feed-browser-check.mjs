// To the Canvas (src/documents/canvas-feed.js), in the app: the Notes'
// highlights, the Cards and a PDF's highlights put on the Canvas as Blocks —
// sized, stacked at the end, onto new pages — the picker, a drag from beside,
// and the balanced width a pasted paragraph now takes.
//
//   node tools/canvas-feed-browser-check.mjs
//   CANVAS_SHOTS=<dir> node tools/canvas-feed-browser-check.mjs   (pictures)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
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
    "/src/ui/style-settings.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
    "/src/documents/page-handoff.js?v=__BUILD__",
    "/src/documents/pdf-timing.js?v=__BUILD__",
    "/src/documents/canvas-selection.js?v=__BUILD__",
    "/src/documents/block-measure.js?v=__BUILD__",
    "/src/documents/canvas-feed.js?v=__BUILD__",
    "/src/documents/canvas-feed-dialog.js?v=__BUILD__",
    "/src/documents/canvas-flow.js?v=__BUILD__",
    "/src/documents/card-canvas-style.js?v=__BUILD__",
    "/src/documents/notes-grip.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/documents/doc-slot.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/documents/doc-scrollers.js?v=__BUILD__"
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
  // Turndown (HTML to markdown) loads from a CDN in the app; here, the copy the
  // clipper ships, as tools/highlight-check.mjs does.
  if (typeof TurndownService === "undefined") {
    (0, eval)(await (await fetch("/recall-clipper/vendor/turndown.js")).text());
    (0, eval)(await (await fetch("/recall-clipper/vendor/turndown-plugin-gfm.js")).text());
  }
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
    from: () => { throw new Error("canvas-feed-browser-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Canvas feed fixture", notesMode: true });
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


const chrome = findChrome();
if (!chrome) { console.log("canvas-feed-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

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

const SHOTS = process.env.CANVAS_SHOTS || "";
async function snap(name) {
  if (!SHOTS) return;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(SHOTS, { recursive: true });
  const shot = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}

const PARAGRAPH = "Spaced repetition works because each review is timed to land just as the memory begins to fade, so the effort of recalling it strengthens the trace more than an easy review would; the intervals grow with each success and shrink after a lapse, which keeps the total time spent small while the material stays within reach for months or years.";

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}`
  });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));

  // ── 1. A pasted paragraph is a balanced box, not a strip ───────────────
  const widths = await page.evaluate(`async (para) => {
    const { api, settle } = window.__recall;
    const vp = api.pdfPageViewport(1);
    const measure = api.canvasBlockMeasure(vp, "notebook");
    const long = api.addHandwritingTextBlock(para, { page: 1, x: 60, y: 780 });
    const short = api.addHandwritingTextBlock("A short label", { page: 1, x: 60, y: 300 });
    await settle(1500);
    const find = (id) => api.documentBlocks().find((b) => b.id === id);
    const out = { measure, long: find(long.id), short: find(short.id) };
    api.setCanvasBlockWidthMode("longest");
    const old = api.addHandwritingTextBlock(para, { page: 1, x: 60, y: 200 });
    await settle(1500);
    out.old = find(old.id);
    api.setCanvasBlockWidthMode("auto");
    api.writeDocumentBlocks(api.documentBlocks().filter((b) => b.id !== old.id && b.id !== short.id && b.id !== long.id), { removed: [old.id, short.id, long.id] });
    await settle(300);
    return out;
  }`, PARAGRAPH);
  const lw = widths.long?.w || 0;
  const lh = widths.long?.h || 1;
  check("a pasted paragraph is narrower than the widest a Block grows", lw > 0 && lw < widths.measure - 40, `w=${lw} measure=${widths.measure}`);
  check("...in a box near 3:2, not a strip", lw / lh > 0.9 && lw / lh < 2.6, `w/h=${(lw / lh).toFixed(2)}`);
  check("...and it is a balanced Block (wBal)", widths.long?.wBal === true && widths.long?.wFit === true);
  check("a short line keeps its own width", (widths.short?.w || 999) < 140, `w=${widths.short?.w}`);
  check("Block width: Longest line keeps the old strip", (widths.old?.w || 0) >= widths.measure - 4, `w=${widths.old?.w}`);

  // ── 1b. Typed in: balanced while it is written, not a strip till put down ─
  const typed = await page.evaluate(`async (para) => {
    const { api, settle } = window.__recall;
    const vp = api.pdfPageViewport(1);
    const scale = vp.scale || 1;
    const out = {};
    async function typeIn(label, text, y) {
      const made = api.addDocumentBlock(1, { x: 80, y }, { anchor: "top-left", edit: true });
      await settle(200);
      const node = () => document.querySelector('[data-pdf-block="' + made.id + '"]');
      const ta = node().querySelector(".pdf-block-inline textarea");
      // How often the width moved once the words had wrapped: each move
      // rewraps every line under the caret.
      let changes = 0; let last = 0; let wrapped = false; let oneLine = 0;
      for (let i = 1; i <= text.length; i += 1) {
        ta.value = text.slice(0, i);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        const w = Math.round(node().getBoundingClientRect().width);
        if (wrapped && w !== last) changes += 1;
        last = w;
        if (i === 1) oneLine = ta.scrollHeight;
        if (!wrapped && ta.scrollHeight > oneLine + parseFloat(getComputedStyle(ta).lineHeight) / 2) wrapped = true;
      }
      await settle(150);
      const typing = node().getBoundingClientRect().width / scale;
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      await settle(1200);
      const rec = api.documentBlocks().find((b) => b.id === made.id);
      out[label] = { typing: Math.round(typing), w: rec.w, h: rec.h, wBal: rec.wBal, changes, id: made.id };
    }
    await typeIn("para", para, 780);
    await typeIn("sentence", "A sixty character sentence that fits under the measure.", 420);
    await typeIn("label", "Retrieval practice", 300);
    // Opened again: typed in at the width it has.
    api.editBlock(out.para.id);
    await settle(300);
    const node = document.querySelector('[data-pdf-block="' + out.para.id + '"]');
    out.reopened = Math.round(node.getBoundingClientRect().width / scale);
    out.reopenedEditing = node.classList.contains("is-inline-editing");
    node.querySelector(".pdf-block-inline textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(600);
    out.afterReopen = api.documentBlocks().find((b) => b.id === out.para.id)?.w;
    out.measure = api.canvasBlockMeasure(vp, "notebook");
    api.writeDocumentBlocks(api.documentBlocks().filter((b) => ![out.para.id, out.sentence.id, out.label.id].includes(b.id)), { removed: [out.para.id, out.sentence.id, out.label.id] });
    await settle(300);
    return out;
  }`, PARAGRAPH);
  const em = 14;
  check("a paragraph typed in is balanced while it is typed, not a strip the measure wide", typed.para.typing < typed.measure - 60, `typing=${typed.para.typing} measure=${typed.measure}`);
  check("...within an em of the width it is put down at", Math.abs(typed.para.typing - typed.para.w) <= em, `typing=${typed.para.typing} put down=${typed.para.w}`);
  check("...near 3:2 once down, and balanced (wBal)", typed.para.w / typed.para.h > 1.2 && typed.para.w / typed.para.h < 2.1 && typed.para.wBal === true, `w=${typed.para.w} h=${typed.para.h}`);
  check("...its width moved only a few times once its words wrapped", typed.para.changes <= 12, `moves=${typed.para.changes} over ${PARAGRAPH.length} keys`);
  check("a sentence shorter than the measure wraps at a comfortable line, not one strip", typed.sentence.w < typed.measure * 0.7 && typed.sentence.h > 40, `w=${typed.sentence.w} h=${typed.sentence.h}`);
  check("...typed at about the width it is put down at", Math.abs(typed.sentence.typing - typed.sentence.w) <= em, `typing=${typed.sentence.typing} put down=${typed.sentence.w}`);
  check("a short label keeps its own line", typed.label.w < 140 && typed.label.h < 40, `w=${typed.label.w} h=${typed.label.h}`);
  check("a balanced Block opened again is typed in at its own width", typed.reopenedEditing && Math.abs(typed.reopened - typed.para.w) <= 1 && Math.abs(typed.afterReopen - typed.para.w) <= 1, `w=${typed.para.w} reopened=${typed.reopened} after=${typed.afterReopen}`);

  // ── 2. The Notes' highlights, the Cards and a PDF's, as items ──────────
  const items = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.state.notes = "# Memory\\n\\nThe <mark>forgetting curve falls steeply</mark> in the first day.\\n\\n## Practice\\n\\n<mark data-color=\\"green\\">Retrieval practice beats rereading</mark>, and <mark data-color=\\"blue\\">spacing beats massing</mark>.\\n";
    api.state.masterCards = [
      { id: "card-a", question: "What does the forgetting curve show?", answer: "Memory falls steeply at first, then levels off." },
      { id: "card-b", question: "Spacing or massing?", answer: "Spacing." }
    ];
    api.state.meta = { ...api.state.meta, pdfHighlights: [...(api.state.meta.pdfHighlights || []),
      { id: "hn-pdftext", color: "pink", page: 3, text: "A *starred* passage of the PDF", kind: "text", quads: [{ page: 3, rect: [50, 600, 300, 612] }], at: 1 },
      { id: "hn-pdfarea", color: "yellow", page: 2, kind: "area", quads: [{ page: 2, rect: [40, 300, 240, 420] }], at: 1 }
    ] };
    return {
      notes: api.notesHighlightItems(),
      cards: api.cardItems(),
      pdf: api.pdfHighlightItems(null)
    };
  }`);
  check("three Notes highlights, in order", items.notes.length === 3 && /forgetting/.test(items.notes[0].md) && /spacing/.test(items.notes[2].md), JSON.stringify(items.notes.map((i) => i.md)));
  check("...each under its heading, in its colour", items.notes[1].label === "Practice" && items.notes[1].color === "green", JSON.stringify(items.notes[1]));
  check("two cards as pairs", items.cards.length === 2 && items.cards[0].kind === "pair" && items.cards[0].from === "card:card-a");
  check("a PDF's text highlight is its words, escaped", items.pdf.some((i) => i.from === "pdf:hn-pdftext" && i.md === "A \\*starred\\* passage of the PDF"), JSON.stringify(items.pdf));
  check("a PDF's region is a reference to its spot", items.pdf.some((i) => i.from === "pdf:hn-pdfarea" && i.kind === "ref" && /^!\[\]\(pdfref:2:40,300,240,420\)$/.test(i.md)));
  check("...page by page", items.pdf[0]?.from === "pdf:hn-pdfarea");

  // ── 3. To the Canvas, at the end, stacked under what is there ──────────
  const placed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const existing = api.addHandwritingTextBlock("Already here", { page: 1, x: 60, y: 760 });
    await settle(800);
    const before = api.documentBlocks().find((b) => b.id === existing.id);
    const made = await api.placeOnCanvas(api.notesHighlightItems(), { quiet: true, colours: true });
    await settle(1200);
    const blocks = api.documentBlocks().filter((b) => made.blocks.includes(b.id));
    return { before, blocks, keys: [...api.keysOnCanvas()] };
  }`);
  const nb = placed.blocks;
  check("three Blocks made", nb.length === 3);
  check("...all below what was already on the page", nb.every((b) => b.y + b.h <= placed.before.y), `existing bottom ${placed.before.y}`);
  check("...stacked without overlapping", nb.every((b, i) => i === 0 || b.y + b.h <= nb[i - 1].y), JSON.stringify(nb.map((b) => [b.y, b.h])));
  check("...each carrying where it came from", nb.every((b) => /^notes:/.test(b.from || "")) && placed.keys.length >= 3);
  check("...in its highlight's colour", nb[1]?.style?.fill === "green", JSON.stringify(nb[1]?.style));

  // ── 4. A card: question → arrow → answer, grouped ──────────────────────
  const card = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const made = await api.placeOnCanvas([api.cardItem("card-a")], { quiet: true });
    await settle(1000);
    const blocks = api.documentBlocks().filter((b) => made.blocks.includes(b.id));
    const arrow = api.documentHighlights().find((r) => made.arrows.includes(r.id));
    return { blocks, arrow };
  }`);
  const [qb, ab] = card.blocks;
  check("a card is two Blocks side by side", card.blocks.length === 2 && ab.x > qb.x + qb.w && Math.abs((qb.y + qb.h) - (ab.y + ab.h)) < 2, JSON.stringify(card.blocks.map((b) => [b.x, b.y, b.w, b.h])));
  check("...joined by an arrow from question to answer", card.arrow?.shape?.ends?.[0]?.id === qb.id && card.arrow?.shape?.ends?.[1]?.id === ab.id, JSON.stringify(card.arrow?.shape?.ends));
  check("...and grouped", qb.group && qb.group === ab.group && card.arrow?.group === qb.group);

  // ── 5. More than a page fills new pages ────────────────────────────────
  const flowed = await page.evaluate(`async (para) => {
    const { api, settle } = window.__recall;
    const pagesBefore = api.notebookPageCount();
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: "text", md: "**" + (i + 1) + ".** " + para, from: "test:" + i }));
    const made = await api.placeOnCanvas(many, { quiet: true });
    await settle(2500);
    const blocks = api.documentBlocks().filter((b) => made.blocks.includes(b.id));
    return { pagesBefore, pagesAfter: api.notebookPageCount(), pages: blocks.map((b) => b.page), boxes: blocks.map((b) => [b.page, b.y, b.h]) };
  }`, PARAGRAPH);
  check("a long run adds pages at the end", flowed.pagesAfter > flowed.pagesBefore, `${flowed.pagesBefore} → ${flowed.pagesAfter}`);
  check("...and its Blocks go onto them in order", flowed.pages.every((p, i) => i === 0 || p >= flowed.pages[i - 1]) && flowed.pages[flowed.pages.length - 1] > flowed.pagesBefore, JSON.stringify(flowed.pages));
  check("...none below a page's foot", flowed.boxes.every(([, y]) => y >= 30), JSON.stringify(flowed.boxes));

  // ── 6. The picker: new ticked, ones on the Canvas marked ───────────────
  const picker = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.openCanvasFeedDialog("notes");
    await settle(200);
    const rows = [...document.querySelectorAll("#canvasFeedModal .canvas-feed-row")];
    const out = {
      rows: rows.length,
      onCanvas: rows.filter((r) => r.classList.contains("is-on-canvas")).length,
      ticked: rows.filter((r) => r.querySelector("input").checked).length,
      add: document.querySelector('#canvasFeedModal [data-cf-action="add"]').textContent
    };
    document.querySelector('#canvasFeedModal [data-cf-action="cancel"]').click();
    api.openCanvasFeedDialog("cards");
    await settle(200);
    const cardRows = [...document.querySelectorAll("#canvasFeedModal .canvas-feed-row")];
    out.cardTicked = cardRows.filter((r) => r.querySelector("input").checked).length;
    out.cardAdd = document.querySelector('#canvasFeedModal [data-cf-action="add"]').textContent;
    return out;
  }`);
  check("the picker lists every highlight", picker.rows === 3);
  check("...marks the ones on the Canvas and leaves them unticked", picker.onCanvas === 3 && picker.ticked === 0, JSON.stringify(picker));
  check("the Cards' picker ticks the card not on the Canvas", picker.cardTicked === 1 && picker.cardAdd === "Add 2 Blocks", JSON.stringify(picker));
  await snap("1-picker.png");
  const added = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = api.documentBlocks().length;
    document.querySelector('#canvasFeedModal [data-cf-action="add"]').click();
    await settle(2000);
    return { before, after: api.documentBlocks().length, open: api.isCanvasFeedDialogOpen() };
  }`);
  check("Add puts them on the Canvas and closes", added.after === added.before + 2 && !added.open, JSON.stringify(added));
  await snap("2-cards-on-canvas.png");

  // ── 7. Side by side: dragged from the Notes onto a Canvas page ─────────
  const dropped = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("notes");
    await settle(800);
    const opened = api.openSplitPart("handwriting");
    for (let i = 0; i < 60 && !document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1'] canvas"); i += 1) await settle(100);
    await settle(800);
    const pageEl = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']");
    pageEl.scrollIntoView({ block: "start" });
    await settle(600);
    const box = pageEl.getBoundingClientRect();
    const x = box.left + box.width * 0.55;
    const y = box.top + box.height * 0.3;
    const target = document.elementFromPoint(x, y);
    const dt = new DataTransfer();
    dt.setData("application/x-recall-item", JSON.stringify({ kind: "text", md: "Dropped **here**", from: "" }));
    dt.setData("text/plain", "Dropped here");
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
    target.dispatchEvent(over);
    const before = api.documentBlocks().length;
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    await settle(1500);
    const block = api.documentBlocks().find((b) => b.md === "Dropped **here**");
    // Words from elsewhere: plain text.
    const dt2 = new DataTransfer();
    dt2.setData("text/plain", "Plain words from another app");
    const y2 = box.top + box.height * 0.6;
    document.elementFromPoint(x, y2).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y2, dataTransfer: dt2 }));
    await settle(1500);
    const plain = api.documentBlocks().find((b) => b.md === "Plain words from another app");
    const stage = pageEl.closest("#documentStage, #documentStageAlt");
    window.__dbg = { targetCls: target?.className?.baseVal ?? target?.className, inPage: Boolean(target?.closest?.(".pdf-page")), slot: stage?.dataset.docSlot, stageId: stage?.id, types: [...dt.types] };
    return { dbg: window.__dbg, opened, accepted: over.defaultPrevented, before, after: api.documentBlocks().length, block, plain, pageW: box.width, x: (x - box.left) / box.width * 595 };
  }`);
  check("the Canvas opens beside the Notes", dropped.opened === true);
  check("a Canvas page takes a drag from beside", dropped.accepted === true, JSON.stringify(dropped.dbg));
  check("a dropped item is a Block where it was let go", dropped.block && dropped.block.page === 1 && Math.abs(dropped.block.x - dropped.x) < 16, JSON.stringify(dropped.block));
  check("words dragged from another app are a Block too", Boolean(dropped.plain));
  await snap("3-beside.png");

  // ── 7b. A highlight of the Notes, pressed and dragged across ───────────
  const markDrag = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const source = api.state.notes;
    const editor = document.getElementById("notesEdit");
    if (api.isNotesEditing()) { editor.value = source; api.commitNotesEditIfActive(); }
    api.renderNotesView();
    await settle(800);
    // The last Block styled on this device: what a dragged Block takes.
    api.writeBlockStylePreference("text", { fill: "violet", size: 14, frame: "outline" });
    const marks = [...document.querySelectorAll("#notesView mark")];
    const mark = marks[1];
    if (!mark) return { marks: marks.length };
    const r = mark.getBoundingClientRect();
    mark.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
    const armed = mark.getAttribute("draggable") === "true";
    const dt = new DataTransfer();
    let dragImage = null;
    dt.setDragImage = (image) => { dragImage = image; };
    mark.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const carried = dt.getData("application/x-recall-item");
    const pageEl = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    const x = box.left + box.width * 0.6;
    const y = box.top + box.height * 0.75;
    document.elementFromPoint(x, y).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    mark.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    await settle(1500);
    const block = api.documentBlocks().find((b) => b.md === "Retrieval practice beats rereading" && b.page === 1 && b.x > 300);
    return { marks: marks.length, armed, carried, block, disarmed: !mark.hasAttribute("draggable"), blankImage: Boolean(dragImage && dragImage.width <= 1 && String(dragImage.src).startsWith("data:image/gif")) };
  }`);
  check("a Notes highlight pressed with the Canvas beside can be dragged", markDrag.armed === true && /Retrieval practice/.test(markDrag.carried || ""), JSON.stringify(markDrag));
  check("...and let go of on a Canvas page, it is a Block there in the last Block's look", markDrag.block?.style?.fill === "violet" && markDrag.block?.style?.size === 14 && markDrag.block?.style?.frame === "outline" && /^notes:/.test(markDrag.block?.from || ""), JSON.stringify(markDrag.block));
  check("...and the browser's own faded picture of it is swapped for an empty one", markDrag.blankImage === true);
  check("...and the highlight is not left draggable", markDrag.disarmed === true);

  // ── 7c. Whole things of the Notes, by the grip, with the drop preview ──
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAAGklEQVR42mNk+M9Qz0AEYBxVSF+FAAHnA/0CsoRHAAAAAElFTkSuQmCC";
  const grip = await page.evaluate(`async (png) => {
    const { api, settle } = window.__recall;
    api.state.notes = api.state.notes + "\\n## Figures\\n\\nA figure and a table.\\n\\n<img src=\\"" + png + "\\" alt=\\"dot\\" class=\\"has-custom-size\\" style=\\"--notes-img-w:640px; width:640px\\">\\n\\n| Term | Gap |\\n|---|---|\\n| one | 1 day |\\n\\n## After\\n\\nNot in the section.\\n";
    api.renderNotesView();
    await settle(1200);
    const pageEl = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    const scale = box.width / 595;
    const dragOnto = async (thing, fx, fy) => {
      const r = thing.getBoundingClientRect();
      thing.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: r.left + 10, clientY: r.top + 6 }));
      const grip = document.querySelector(".notes-canvas-grip");
      const shown = Boolean(grip && !grip.hidden);
      const dt = new DataTransfer();
      grip?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const carried = dt.getData("application/x-recall-item");
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      const target = document.elementFromPoint(x, y);
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      for (let i = 0; i < 40 && document.querySelector(".canvas-drop-ghost.is-guess"); i += 1) {
        await settle(100);
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      }
      for (let i = 0; i < 30 && !document.querySelector(".canvas-drop-ghost.is-rendered .pdf-block .pdf-block-body *"); i += 1) await settle(100);
      const ghost = document.querySelector(".canvas-drop-ghost");
      const rendered = Boolean(ghost?.classList.contains("is-rendered") && ghost.querySelector(".pdf-block .pdf-block-body *"));
      const ghostFill = ghost?.querySelector(".pdf-block")?.dataset.blockFill || ghost?.querySelector(".pdf-block")?.getAttribute("data-fill") || "";
      const g = ghost?.getBoundingClientRect();
      const preview = g ? { x: (g.left - box.left) / scale, top: 842 - (g.top - box.top) / scale, w: g.width / scale, measured: !ghost.classList.contains("is-guess") && !ghost.classList.contains("is-outline") } : null;
      const before = new Set(api.documentBlocks().map((b) => b.id));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      grip?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      await settle(1500);
      const block = api.documentBlocks().find((b) => !before.has(b.id));
      return { shown, carried: carried ? JSON.parse(carried) : null, preview, rendered, ghostFill, ghostHtml: ghost?.innerHTML.slice(0, 200), block, ghostGone: !document.querySelector(".canvas-drop-ghost") };
    };
    const figures = [...document.querySelectorAll("#notesView h1, #notesView h2, #notesView h3")].find((h) => /Figures/.test(h.textContent));
    const notes = api.state.notes;
    const exact = notes.slice(notes.indexOf("## Figures"), notes.indexOf("## After")).trim();
    const sliced = figures ? api.notesElementMarkdown(figures) === exact : false;
    const shell = document.querySelector("#notesView .diagram-shell") || document.querySelector("#notesView img");
    const picture = shell ? await dragOnto(shell, 0.1, 0.12) : null;
    const heading = [...document.querySelectorAll("#notesView h1, #notesView h2, #notesView h3")].find((h) => /Figures/.test(h.textContent));
    const section = heading ? await dragOnto(heading, 0.1, 0.55) : null;
    return { picture, section, sliced, pageWidth: 595 };
  }`, PNG);
  const pic = grip.picture;
  check("a grip comes up beside a picture of the Notes", pic?.shown === true, JSON.stringify(pic && { shown: pic.shown }));
  check("...and carries the picture without its Notes width", /^!\[dot\]\(data:image\/png/.test(pic?.carried?.md || "") || /dot/.test(pic?.carried?.md || ""), JSON.stringify(pic?.carried?.md?.slice(0, 80)));
  check("while dragged, the preview is the Block itself, drawn as the page draws it", pic?.rendered === true && grip.section?.rendered === true, JSON.stringify({ pic: pic?.ghostHtml, sec: grip.section?.ghostHtml }));
  check("...in the last Block's look", grip.section?.block?.style?.fill === "violet" && grip.section?.block?.style?.size === 14, JSON.stringify(grip.section?.block?.style));
  check("while dragged, a preview shows the Block at its size", pic?.preview?.measured === true && Math.abs((pic?.preview?.w || 0) - (pic?.block?.w || -99)) < 3, JSON.stringify({ preview: pic?.preview, w: pic?.block?.w }));
  check("...and the Block lands where the preview was", pic?.block && Math.abs(pic.block.x - pic.preview.x) < 2 && Math.abs((pic.block.y + pic.block.h) - pic.preview.top) < 2 && pic.ghostGone, JSON.stringify({ block: pic?.block && [pic.block.x, pic.block.y + pic.block.h], preview: pic?.preview }));
  check("a picture lands at ◐ Canvas → Pictures land at (40%), not its 640px", pic?.block && Math.abs(pic.block.w - Math.floor(595 * 0.4)) <= 2 && !/640/.test(pic.block.md) && pic.block.style?.imageWidth === 100, JSON.stringify(pic?.block && { w: pic.block.w, md: pic.block.md.slice(0, 40), style: pic.block.style }));
  const sec = grip.section;
  check("a heading's section is the Notes' own markdown, as written", grip.sliced === true);
  check("a heading's grip takes its whole section and stops at the next heading", /^#+ Figures/.test(sec?.block?.md || "") && /\| Term/.test(sec?.block?.md || "") && !/Not in the section/.test(sec?.block?.md || ""), JSON.stringify(sec?.block?.md));
  check("...without the picture's Notes width", sec?.block && !/640px/.test(sec.block.md), JSON.stringify(sec?.block?.md));
  check("...a table's Block no wider than Tables and code land at (80%)", sec?.block && sec.block.w <= Math.floor(595 * 0.8) + 1, `w=${sec?.block?.w}`);
  await snap("5-grip-drop.png");

  // ── 7c'. The grips dragged with real input ────────────────────────────
  // What is above dispatches made-up DragEvents, which cannot tell whether a
  // drag starts at all from a pressed grip, or whether anything follows the
  // pointer while it goes. These are trusted input, a mouse and a pen. Chrome
  // starts its own HTML5 drag from a mouse, and sometimes from a pen; that drag
  // is intercepted over the DevTools protocol (as a browser automation library
  // drives one) and carried on as drag events with its own data. A pen it does
  // not start one for is followed by the grip's own pointer drag.
  {
    const mouse = (type, x, y, buttons, pointerType = "mouse") => page.call("Input.dispatchMouseEvent", {
      type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, pointerType
    });
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const pageBox = () => page.evaluate(`() => { const r = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }`);
    const blockCount = () => page.evaluate(`() => window.__recall.api.documentBlocks().length`);
    const chipText = () => page.evaluate(`() => document.querySelector(".canvas-drag-chip")?.textContent || ""`);
    const ghostDrawn = () => page.evaluate(`() => Boolean(document.querySelector(".canvas-drop-ghost.is-rendered"))`);
    const realDrag = async (x, y, tx, ty, pointerType = "mouse") => {
      await page.call("Input.setInterceptDrags", { enabled: true });
      let data = null;
      const off = client.on((m) => { if (m.sessionId === page.sessionId && m.method === "Input.dragIntercepted") data = m.params.data; });
      const step = async (px, py, entering) => {
        if (data) await page.call("Input.dispatchDragEvent", { type: entering ? "dragEnter" : "dragOver", x: px, y: py, data });
        else await mouse("mouseMoved", px, py, 1, pointerType);
      };
      await mouse("mouseMoved", x, y, 0, pointerType);
      await mouse("mousePressed", x, y, 1, pointerType);
      let chip = "";
      let entered = false;
      const steps = 14;
      for (let i = 1; i <= steps; i += 1) {
        const hadData = Boolean(data);
        await step(x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps, hadData && !entered);
        if (hadData) entered = true;
        await pause(30);
        if (i >= 5 && !chip) chip = await chipText();
      }
      let ghost = false;
      for (let i = 0; i < 20 && !ghost; i += 1) {
        await step(tx, ty, false);
        ghost = await ghostDrawn();
        if (!ghost) await pause(100);
      }
      const chipOverPage = await chipText();
      if (data) await page.call("Input.dispatchDragEvent", { type: "drop", x: tx, y: ty, data });
      await mouse("mouseReleased", tx, ty, 0, pointerType);
      off();
      // Interception stays on until the drop: turned off mid-drag, Chrome ends
      // the drag (dragend) there and then.
      await page.call("Input.setInterceptDrags", { enabled: false });
      await pause(1500);
      return { html5: Boolean(data), types: data ? data.items.map((i) => i.mimeType) : null, chip, ghost, chipOverPage, chipGone: !(await chipText()) };
    };
    const notesGripFor = async (pointerType) => {
      const at = await page.evaluate(`async () => {
        const { settle } = window.__recall;
        const heading = [...document.querySelectorAll("#notesView h1, #notesView h2, #notesView h3")].find((h) => /Figures/.test(h.textContent));
        heading.scrollIntoView({ block: "center" });
        await settle(300);
        const r = heading.getBoundingClientRect();
        return { x: r.left + 12, y: r.top + 8 };
      }`);
      await mouse("mouseMoved", at.x, at.y, 0, pointerType);
      await pause(150);
      return page.evaluate(`() => { const g = document.querySelector(".notes-canvas-grip"); if (!g || g.hidden) return null; const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }`);
    };

    // The Notes' grip, by mouse.
    let grip = await notesGripFor("mouse");
    let box = await pageBox();
    let before = await blockCount();
    const byMouse = grip ? await realDrag(grip.x, grip.y, box.x + box.w * 0.3, box.y + box.h * 0.7) : null;
    check("the Notes' grip, dragged with a real mouse, starts a drag carrying its item", byMouse?.html5 === true && byMouse.types.includes("application/x-recall-item"), JSON.stringify(byMouse));
    check("...a chip naming it follows the pointer away from the Canvas, and gives way to the preview over a page", /Figures/.test(byMouse?.chip || "") && byMouse?.ghost === true && byMouse?.chipOverPage === "" && byMouse?.chipGone === true, JSON.stringify(byMouse && { chip: byMouse.chip, over: byMouse.chipOverPage }));
    check("...and let go of on a Canvas page, it is a Block there", (await blockCount()) === before + 1);

    // The Notes' grip, by pen.
    grip = await notesGripFor("pen");
    box = await pageBox();
    before = await blockCount();
    const byPen = grip ? await realDrag(grip.x, grip.y, box.x + box.w * 0.6, box.y + box.h * 0.8, "pen") : null;
    check("the Notes' grip, dragged with a pen, is followed: the chip, then the preview over a page", /Figures/.test(byPen?.chip || "") && byPen?.ghost === true, JSON.stringify(byPen));
    check("...and let go of on a Canvas page, it is a Block there", (await blockCount()) === before + 1);

    // A card's grip, by mouse and by pen, with the Cards beside the Canvas.
    const cardGrip = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      window.__cardsBefore = [api.state.cards, api.state.current];
      api.state.cards = api.state.masterCards;
      api.state.current = 0;
      api.setViewMode("cards");
      await settle(600);
      api.openSplitPart("handwriting");
      for (let i = 0; i < 60 && !document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1'] canvas"); i += 1) await settle(100);
      await settle(600);
      const g = document.getElementById("cardCanvasGripBtn");
      const r = g.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }`);
    box = await pageBox();
    before = await blockCount();
    const cardByMouse = cardGrip ? await realDrag(cardGrip.x, cardGrip.y, box.x + box.w * 0.2, box.y + box.h * 0.2) : null;
    check("a card's grip, dragged with a real mouse, puts the card where it is let go of", cardByMouse?.html5 === true && /⠿/.test(cardByMouse.chip) && (await blockCount()) === before + 2, JSON.stringify({ cardByMouse, n: (await blockCount()) - before }));
    before = await blockCount();
    const cardByPen = cardGrip ? await realDrag(cardGrip.x, cardGrip.y, box.x + box.w * 0.25, box.y + box.h * 0.45, "pen") : null;
    check("...and with a pen, too — once, not also at the end as a press would", /⠿/.test(cardByPen?.chip || "") && (await blockCount()) === before + 2, JSON.stringify({ cardByPen, n: (await blockCount()) - before }));
    // A pen's press without a move is still a press: the card at the end.
    before = await blockCount();
    if (cardGrip) {
      await mouse("mousePressed", cardGrip.x, cardGrip.y, 1, "pen");
      await mouse("mouseReleased", cardGrip.x, cardGrip.y, 0, "pen");
      await pause(1500);
    }
    check("...and a pen's press on it, not moved, still puts the card at the end", (await blockCount()) === before + 2, `n=${(await blockCount()) - before}`);
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      [api.state.cards, api.state.current] = window.__cardsBefore;
      api.setViewMode("notes");
      await settle(500);
      api.openSplitPart("handwriting");
      await settle(1200);
    }`);
  }

  // ── 7d. The picker: New only / All / None, and the Colours row ────────
  const colours = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.openCanvasFeedDialog("notes");
    await settle(200);
    const q = (s) => document.querySelector("#canvasFeedModal " + s);
    const ticked = () => [...document.querySelectorAll("#canvasFeedModal .canvas-feed-row input")].filter((i) => i.checked).length;
    const rows = () => document.querySelectorAll("#canvasFeedModal .canvas-feed-row").length;
    const out = {};
    q('[data-cf-pick="all"]').click(); out.all = ticked();
    q('[data-cf-pick="none"]').click(); out.none = ticked();
    q('[data-cf-pick="new"]').click(); out.fresh = ticked();
    out.chips = [...document.querySelectorAll("#canvasFeedModal [data-cf-colour]")].map((b) => b.dataset.cfColour);
    q('[data-cf-colour="green"]').click(); out.greenRows = rows();
    q('[data-cf-colour="blue"]').click(); out.twoRows = rows();
    q('[data-cf-pick="all"]').click(); out.twoTicked = ticked(); out.add = q('[data-cf-action="add"]').textContent;
    q('[data-cf-colour=""]').click(); out.backToAll = rows();
    q('[data-cf-action="cancel"]').click();
    return out;
  }`);
  check("All ticks every row, None none, New only the new ones", colours.all === 3 && colours.none === 0 && colours.fresh === 0, JSON.stringify(colours));
  check("the Colours row has a chip per colour, uncoloured counted as yellow", ["", "yellow", "green", "blue"].every((c) => colours.chips.includes(c)), JSON.stringify(colours.chips));
  check("...one colour shows only its rows, two show both", colours.greenRows === 1 && colours.twoRows === 2, JSON.stringify(colours));
  check("...Add adds only what is on show", colours.twoTicked === 2 && colours.add === "Add 2 Blocks" && colours.backToAll === 3, JSON.stringify(colours));

  // ── 7e. A card's style, chosen in the picker ─────────────────────────
  const styled = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.openCanvasFeedDialog("cards");
    await settle(200);
    const q = (s) => document.querySelector("#canvasFeedModal " + s);
    q("[data-cf-style]").open = true;
    q('[data-cf-tab="q"]').click();
    const panelText = q("[data-cf-panel]").textContent;
    const sizeBox = q('[data-cf-panel] input[data-cf-input="size"]');
    const shown = {
      size: sizeBox?.value,
      vague: /\\bauto\\b|\\bDefault\\b/.test(panelText + q("[data-cf-panel]").innerHTML.replace(/<[^>]+>/g, " ")),
      fillFrom: [...document.querySelectorAll("#canvasFeedModal .cf-style-row")].find((r) => /Fill/.test(r.textContent))?.querySelector(".cf-src")?.textContent,
      fillPressed: q('[data-cf-set="fill"][aria-pressed="true"]')?.dataset.cfValue
    };
    q('[data-cf-tab="arrow"]').click();
    shown.arrowWidth = q('[data-cf-panel] input[data-cf-input="arrow.width"]')?.value;
    shown.arrowVague = /\\bauto\\b|\\bDefault\\b/.test(q("[data-cf-panel]").textContent);
    shown.arrowFrom = q("[data-cf-panel] .cf-src")?.textContent;
    q('[data-cf-tab="q"]').click();
    q('[data-cf-set="fill"][data-cf-value="yellow"]').click();
    q('[data-cf-tab="a"]').click();
    q('[data-cf-set="frame"][data-cf-value="outline"]').click();
    q('[data-cf-tab="arrow"]').click();
    q('[data-cf-set="arrow.dash"][data-cf-value="dash"]').click();
    q('[data-cf-set="arrow.color"][data-cf-value="red"]').click();
    q('[data-cf-layout="stacked"]').click();
    const preview = q("[data-cf-preview]").classList.contains("is-stacked") && /dasharray/.test(q("[data-cf-preview]").innerHTML);
    q('[data-cf-tab="q"]').click();
    shown.fillAfter = [...document.querySelectorAll("#canvasFeedModal .cf-style-row")].find((r) => /Fill/.test(r.textContent))?.querySelector(".cf-src")?.textContent;
    window.__closeFeed = () => q('[data-cf-action="cancel"]').click();
    await settle(300);
    return { preview, shown };
  }`);
  await snap("7-card-style.png");
  const styledMade = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    window.__closeFeed();
    const made = await api.placeOnCanvas([api.cardItem("card-b")], { quiet: true });
    await settle(1000);
    const [qb, ab] = made.blocks.map((id) => api.documentBlocks().find((b) => b.id === id));
    const arrow = api.documentHighlights().find((r) => made.arrows.includes(r.id));
    api.writeCardCanvasStyle(api.CARD_CANVAS_STYLE_DEFAULT);
    api.runDiagramEdit(() => {
      api.writeDocumentBlocks(api.documentBlocks().filter((b) => !made.blocks.includes(b.id)), { removed: made.blocks });
      api.applyDocumentRecordChanges({ remove: made.arrows });
    });
    await settle(300);
    return { qb, ab, arrow: arrow?.shape };
  }`);
  Object.assign(styled, styledMade);
  check("the card Style's preview follows what is chosen", styled.preview === true);
  check("the card Style shows the values in use — a size in points, no bare auto or Default", /^\d+(\.\d+)?$/.test(styled.shown?.size || "") && styled.shown?.vague === false && /^\d/.test(styled.shown?.arrowWidth || "") && styled.shown?.arrowVague === false, JSON.stringify(styled.shown));
  check("...and says where each comes from: the last Block, the Shapes tool, or set here", styled.shown?.fillFrom === "from the last Block" && styled.shown?.fillPressed === "violet" && /Shapes tool/.test(styled.shown?.arrowFrom || "") && /set here/.test(styled.shown?.fillAfter || ""), JSON.stringify(styled.shown));
  check("the question Block takes its fill, the answer its frame", styled.qb?.style?.fill === "yellow" && styled.ab?.style?.frame === "outline", JSON.stringify({ q: styled.qb?.style, a: styled.ab?.style }));
  check("...the arrow its colour and dashes", styled.arrow?.dash === "dash" && /^#dc2626$/i.test(styled.arrow?.stroke || ""), JSON.stringify(styled.arrow));
  check("...and Question above answer puts the answer under it", styled.qb && styled.ab && styled.ab.y + styled.ab.h < styled.qb.y && Math.abs(styled.ab.x - styled.qb.x) < 2, JSON.stringify([styled.qb && [styled.qb.x, styled.qb.y], styled.ab && [styled.ab.x, styled.ab.y, styled.ab.h]]));

  // ── 7f. From a web page, another PDF reader and a picture file ────────
  const outside = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const pageEl = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='2']") || document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']");
    pageEl.scrollIntoView({ block: "start" });
    await settle(500);
    const box = pageEl.getBoundingClientRect();
    const dropAt = async (dt, fx, fy) => {
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      const target = document.elementFromPoint(x, y);
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
      target.dispatchEvent(over);
      const ghost = document.querySelector(".canvas-drop-ghost");
      const shown = { accepted: over.defaultPrevented, ghost: Boolean(ghost), guess: ghost?.classList.contains("is-guess"), label: ghost?.textContent };
      const before = new Set(api.documentBlocks().map((b) => b.id));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      return { shown, before };
    };
    const html = new DataTransfer();
    html.setData("text/html", "<meta charset='utf-8'><h2 style='font-size:40px'>From the web</h2><p>Some <b>bold</b> words.</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><img src='https://example.org/pic.png' width='900' style='width:900px'>");
    html.setData("text/plain", "From the web Some bold words.");
    const a = await dropAt(html, 0.08, 0.1);
    for (let i = 0; i < 40 && !api.documentBlocks().some((b) => !a.before.has(b.id)); i += 1) await settle(100);
    await settle(600);
    const web = api.documentBlocks().find((b) => !a.before.has(b.id));
    const plain = new DataTransfer();
    plain.setData("text/plain", "Words copied out of a PDF reader run on\\nacross the line ends of its page and a hy-\\nphenated word.\\n\\nA second paragraph.");
    const b = await dropAt(plain, 0.08, 0.7);
    await settle(1500);
    const pdfWords = api.documentBlocks().find((x) => !b.before.has(x.id));
    // A picture file, onto the Canvas in focus.
    if (api.state.splitPart) api.closeSplitPart();
    api.setViewMode("handwriting");
    await settle(900);
    const canvasPage = document.querySelector("[data-doc-slot='notebook'] .pdf-page[data-page-number='1']");
    canvasPage.scrollIntoView({ block: "start" });
    await settle(500);
    const cbox = canvasPage.getBoundingClientRect();
    const blob = await new Promise((resolve) => { const c = document.createElement("canvas"); c.width = 80; c.height = 40; c.getContext("2d").fillRect(0, 0, 80, 40); c.toBlob(resolve, "image/png"); });
    const file = new File([blob], "shot.png", { type: "image/png" });
    const pic = new DataTransfer();
    pic.items.add(file);
    const x = cbox.left + cbox.width * 0.5;
    const y = cbox.top + cbox.height * 0.4;
    const target = document.elementFromPoint(x, y);
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: pic });
    target.dispatchEvent(over);
    const picGhost = document.querySelector(".canvas-drop-ghost")?.textContent || "";
    const before = new Set(api.documentBlocks().map((b2) => b2.id));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: pic }));
    for (let i = 0; i < 40 && !document.querySelector(".image-compress-modal [data-compress-confirm]:not([disabled])"); i += 1) await settle(100);
    document.querySelector(".image-compress-modal [data-compress-confirm]")?.click();
    for (let i = 0; i < 60 && !api.documentBlocks().some((b2) => !before.has(b2.id)); i += 1) await settle(100);
    const picture = api.documentBlocks().find((b2) => !before.has(b2.id));
    return { webShown: a.shown, web, plainShown: b.shown, pdfWords, picShown: over.defaultPrevented, picGhost, picture };
  }`);
  check("a drag from a web page shows a preview over the Canvas", outside.webShown?.accepted && outside.webShown?.ghost && outside.webShown?.guess, JSON.stringify(outside.webShown));
  check("...and lands as markdown: heading, bold, table and picture kept", /^## From the web/m.test(outside.web?.md || "") && /\*\*bold\*\*/.test(outside.web?.md || "") && /\| A/.test(outside.web?.md || "") && /!\[\]\(https:\/\/example\.org\/pic\.png\)/.test(outside.web?.md || ""), JSON.stringify(outside.web?.md));
  check("...without the site's sizes", outside.web && !/900|font-size|40px/.test(outside.web.md), JSON.stringify(outside.web?.md));
  check("words from another PDF reader join their line ends, paragraphs kept", outside.pdfWords?.md === "Words copied out of a PDF reader run on across the line ends of its page and a hyphenated word.\n\nA second paragraph.", JSON.stringify(outside.pdfWords?.md));
  check("a picture file over the Canvas in focus is previewed as a Picture", outside.picShown === true && outside.picGhost === "Picture", JSON.stringify({ shown: outside.picShown, ghost: outside.picGhost }));
  check("...and lands as a picture Block at the Pictures width", outside.picture?.kind === "image" && Math.abs(outside.picture.w - Math.floor(595 * 0.4)) <= 2, JSON.stringify(outside.picture && { kind: outside.picture.kind, w: outside.picture.w, h: outside.picture.h }));
  await snap("6-outside.png");
  // Back beside the Notes for what follows.
  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("notes");
    await settle(500);
    api.openSplitPart("handwriting");
    await settle(1200);
  }`);

  // ── 8. The toast's Undo, and one undo step ────────────────────────────
  const undo = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = api.documentBlocks().length;
    const made = await api.placeOnCanvas([api.cardItem("card-b")]);
    await settle(1000);
    const mid = api.documentBlocks().length;
    const button = [...document.querySelectorAll(".toast")].filter((t) => /2 Blocks on the Canvas/.test(t.textContent)).pop()?.querySelector(".toast-action");
    button?.click();
    await settle(800);
    const left = api.documentHighlights().filter((r) => made.arrows.includes(r.id)).map((r) => ({ id: r.id, ends: r.shape?.ends, doc: r.doc }));
    return { before, mid, after: api.documentBlocks().length, arrows: made.arrows, left, slot: api.activeDocSlot(), arrowGone: !left.length };
  }`);
  check("Undo in the toast takes the Blocks and the arrow back", undo.mid === undo.before + 2 && undo.after === undo.before && undo.arrowGone, JSON.stringify(undo));

  // ── 9. From a PDF, with no Canvas yet: never onto the PDF ─────────────
  const fromPdf = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    if (api.state.splitPart) api.closeSplitPart();
    const file = new File([new Uint8Array(bytes)], "reading.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const index = api.readLocalDeckIndex();
    const entry = index.find((e) => e.title !== "Canvas feed fixture");
    if (!entry) return { error: "no file was made from the PDF: " + JSON.stringify(index.map((e) => e.title)) };
    await api.loadDeckFromLibrary(entry.id);
    await settle(400);
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView();
    await settle(800);
    api.state.meta = { ...api.state.meta, pdfHighlights: [
      { id: "hn-words", color: "blue", page: 1, text: "Words highlighted on the PDF", kind: "text", quads: [{ page: 1, rect: [72, 700, 300, 714] }], at: 1 },
      { id: "hn-region", color: "yellow", page: 2, kind: "area", quads: [{ page: 2, rect: [72, 400, 300, 560] }], at: 1 }
    ] };
    const pdfBlocksBefore = (api.state.meta.pdfBlocks || []).filter((b) => !b.doc).length;
    const hadCanvas = api.deckHasHandwrittenPages();
    api.openCanvasFeedDialog("pdf");
    await settle(200);
    const rows = document.querySelectorAll("#canvasFeedModal .canvas-feed-row").length;
    const keep = document.querySelector("#canvasFeedModal [data-cf-keep-colours]");
    if (!keep.checked) keep.click();
    document.querySelector('#canvasFeedModal [data-cf-action="add"]').click();
    for (let i = 0; i < 80 && !(api.state.meta.pdfBlocks || []).some((b) => b.doc === "notebook" && /^pdf:/.test(b.from || "")); i += 1) await settle(100);
    await settle(1500);
    const all = api.state.meta.pdfBlocks || [];
    return {
      hadCanvas,
      hasCanvas: api.deckHasHandwrittenPages(),
      rows,
      pdfBlocksBefore,
      pdfBlocksAfter: all.filter((b) => !b.doc).length,
      canvasBlocks: all.filter((b) => b.doc === "notebook").map((b) => ({ from: b.from, md: b.md, w: b.w, h: b.h, fill: b.style?.fill })),
      focus: api.state.viewMode,
      beside: api.state.splitPart,
      slot: api.activeDocSlot()
    };
  }`, Array.from(buildFixturePdf({ pages: 3 }).bytes));
  check("a file made from a PDF opens on its PDFs tab", !fromPdf.error, fromPdf.error || "");
  if (fromPdf.error) throw new Error(fromPdf.error);
  check("the PDF's ⋯ picker lists its text and region highlights", fromPdf.rows === 2, JSON.stringify(fromPdf));
  check("with no Canvas yet, one is started", fromPdf.hadCanvas === false && fromPdf.hasCanvas === true);
  check("the Blocks go on the Canvas, never on the PDF", fromPdf.pdfBlocksAfter === fromPdf.pdfBlocksBefore && fromPdf.canvasBlocks.length === 2, JSON.stringify(fromPdf.canvasBlocks));
  check("...the words as words, the region as a live picture of its spot", fromPdf.canvasBlocks.some((b) => b.md === "Words highlighted on the PDF" && b.fill === "blue")
    && fromPdf.canvasBlocks.some((b) => /^!\[\]\(pdfref:2:72,400,300,560\)$/.test(b.md)), JSON.stringify(fromPdf.canvasBlocks));
  check("...and the Canvas is beside the PDF, in focus", fromPdf.focus === "handwriting" && fromPdf.beside === "document" && fromPdf.slot === "notebook", JSON.stringify({ focus: fromPdf.focus, beside: fromPdf.beside, slot: fromPdf.slot }));
  await snap("4-from-pdf.png");

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

console.log(`\ncanvas-feed-browser-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
