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
    const made = await api.placeOnCanvas(api.notesHighlightItems(), { quiet: true });
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
    const marks = [...document.querySelectorAll("#notesView mark")];
    const mark = marks[1];
    if (!mark) return { marks: marks.length };
    const r = mark.getBoundingClientRect();
    mark.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
    const armed = mark.getAttribute("draggable") === "true";
    const dt = new DataTransfer();
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
    return { marks: marks.length, armed, carried, block, disarmed: !mark.hasAttribute("draggable") };
  }`);
  check("a Notes highlight pressed with the Canvas beside can be dragged", markDrag.armed === true && /Retrieval practice/.test(markDrag.carried || ""), JSON.stringify(markDrag));
  check("...and let go of on a Canvas page, it is a Block there, in its colour", markDrag.block?.style?.fill === "green" && /^notes:/.test(markDrag.block?.from || ""), JSON.stringify(markDrag.block));
  check("...and the highlight is not left draggable", markDrag.disarmed === true);

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
