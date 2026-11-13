// Does a Canvas draw like draw.io — boxes of any shape, joined by lines that
// follow them, picked up several at a time and snapped into line?
//
//   node tools/diagram-check.mjs
//
// Every geometric rule underneath this is checked in pure Node
// (tools/diagram-geometry-check.mjs, tools/annot-shapes-check.mjs). What only a
// browser can say is whether the PAGE does what the geometry says: whether a
// diamond is drawn as a diamond and keeps its words inside it, whether a press
// on a block's top edge resizes it from the top, whether an edit that made a
// block and a line together is taken back by one press of ↶.
//
// Driven through tools/cdp.mjs, as every browser check here is.
//
// ── The questions ─────────────────────────────────────────────────────────
//
//   A. Blocks as a diagram's boxes: the + Add palette, a shaped block's outline
//      and insets, the top edge and corners, Shift keeping a box's shape, the
//      style bar's Shape row, To front / To back, one undo step for an edit that
//      is blocks and shapes together (and the bar's ↶ taking it), and the
//      outline in the static copy every export is drawn from.
//   B. Connectors: the four arrows a picked-up block wears, one dragged to
//      another block making a line tied to both, the line following a block
//      WHILE it is dragged and in its record after, a press making a connected
//      copy as one undo step, square corners, words on a line, Delete leaving
//      the lines tied and Ctrl+Delete taking them, and the Shapes tool's arrow
//      tying itself to the block it is drawn onto.

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
    "/src/documents/block-style.js?v=__BUILD__",
    "/src/documents/pdf-block-editor.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/pdf-connectors.js?v=__BUILD__",
    "/src/render/annot-shapes.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-ink.js?v=__BUILD__",
    "/src/ui/ink-rail.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
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

const SETUP_SRC = `async (apiSrc, pdfjsSrc, workerSrc) => {
  const tag = document.createElement("script");
  tag.textContent = pdfjsSrc;
  document.head.appendChild(tag);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  // A mouse, dispatched where a real one would land: the press on the element
  // under it, the moves and the release on the document (where a gesture that
  // has left its element still hears them).
  let nextPointer = 20;
  const mouse = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true,
    pointerId: extra.pointerId || 1, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, button: 0, ...extra
  }));
  const drag = async (target, from, to, extra = {}) => {
    const pointerId = nextPointer++;
    mouse(target, "pointerdown", from[0], from[1], { ...extra, pointerId });
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const x = from[0] + ((to[0] - from[0]) * i) / steps;
      const y = from[1] + ((to[1] - from[1]) * i) / steps;
      mouse(document, "pointermove", x, y, { ...extra, pointerId });
      await raf();
    }
    mouse(document, "pointerup", to[0], to[1], { ...extra, pointerId });
    await raf();
    await settle(30);
  };
  const press = (button) => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true, pointerId: 99, buttons: 1 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  };
  window.__recall = { api, settle, raf, mouse, drag, press };
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
    from: () => { throw new Error("diagram-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Diagram fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

const chrome = findChrome();
if (!chrome) { console.log("diagram-check: no Chrome on this machine — skipping."); process.exit(0); }

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
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}`
  });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens with a page to draw on", opened === true);

  // ── A. Blocks as a diagram's boxes ──────────────────────────────────────
  const boxes = await page.evaluate(`async () => {
    const { api, settle, raf, drag, press } = window.__recall;
    const out = {};
    const view = document.getElementById("documentView");
    const pageEl = () => document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    const blockNode = (id) => document.querySelector('[data-pdf-block="' + id + '"]');
    const find = (id) => api.documentBlocks().find((b) => b.id === id);

    // A1. + Add → the diamond in the palette.
    const palette = [...document.querySelectorAll("#inkRailAddShapes [data-hw-action='add-shape']")];
    out.paletteCount = palette.length;
    const diamondButton = palette.find((b) => b.dataset.blockShape === "diamond");
    press(diamondButton);
    await settle(150);
    api.commitBlockEdit();
    await settle(100);
    const diamond = api.documentBlocks().find((b) => b.style?.shape === "diamond");
    out.diamond = diamond ? { w: diamond.w, h: diamond.h, fit: api.blockStyle(diamond).fit, valign: api.blockStyle(diamond).valign } : null;
    const dNode = diamond && blockNode(diamond.id);
    const outline = dNode?.querySelector("svg.pdf-block-outline .pdf-block-outline-edge");
    out.outlinePath = outline?.getAttribute("d") || "";
    out.outlineFill = outline ? getComputedStyle(outline).fill : "";
    const body = dNode?.querySelector(".pdf-block-body");
    out.bodyPadLeft = body ? parseFloat(getComputedStyle(body).paddingLeft) : 0;
    out.nodeWidth = dNode?.getBoundingClientRect().width || 0;
    out.cardBg = dNode ? getComputedStyle(dNode).backgroundColor : "";

    // A2. A plain block, pulled up by its top edge: taller, bottom where it was.
    const plain = api.addDocumentBlock(1, { x: 300, y: 300 }, { style: { fit: false }, w: 160, h: 60, edit: false });
    await settle(80);
    const pNode = blockNode(plain.id);
    const top = pNode.querySelector(".pdf-block-edge-n");
    out.hasTopEdge = Boolean(top);
    const scale = api.pdfPageViewport(1).scale || 1;
    const tb = top.getBoundingClientRect();
    await drag(top, [tb.left + tb.width / 2, tb.top + 2], [tb.left + tb.width / 2, tb.top + 2 - 30 * scale]);
    const tall = find(plain.id);
    out.topResize = { h: tall.h, y: tall.y, was: { h: 60, y: plain.y } };

    // A3. The top-left corner with Shift: the box keeps its shape.
    const nw = blockNode(plain.id).querySelector(".pdf-block-edge-nw");
    const nb = nw.getBoundingClientRect();
    const before = find(plain.id);
    await drag(nw, [nb.left + 4, nb.top + 4], [nb.left + 4 - 40 * scale, nb.top + 4 - 5 * scale], { shiftKey: true });
    const after = find(plain.id);
    out.shiftRatio = { before: before.w / before.h, after: after.w / after.h, grew: after.w > before.w };

    // A4. The style bar's Shape row, on the plain block.
    api.selectBlock(plain.id);
    await settle(30);
    api.openSelectedBlockStyle();
    await settle(60);
    const shapeButtons = [...document.querySelectorAll(".pdf-block-style-pop [data-bstyle-key='shape']")];
    out.shapeButtons = shapeButtons.length;
    shapeButtons.find((b) => b.dataset.bstyleValue === "ellipse")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(80);
    out.plainShape = api.blockStyle(find(plain.id)).shape;
    out.plainHasOutline = Boolean(blockNode(plain.id)?.querySelector("svg.pdf-block-outline"));
    api.closeBlockStylePopover?.();

    // A5. To front, then to back.
    api.selectBlock(null);
    const order = () => [...api.documentBlocks()].sort((a, b) => a.z - b.z).map((b) => b.id);
    api.restackBlock(-Infinity, plain.id);
    out.toBack = order()[0] === plain.id;
    api.restackBlock(Infinity, plain.id);
    out.toFront = order().at(-1) === plain.id;
    const zs = api.documentBlocks().map((b) => b.z);
    out.zUnique = new Set(zs).size === zs.length;

    // A6. A block and a shape made in ONE diagram edit: one step back, one forward —
    // from the bar's ↶ and ↷, which used to reach the pen's ring alone.
    const blocksBefore = api.documentBlocks().length;
    const shapesBefore = api.documentShapes().length;
    let made = null;
    api.runDiagramEdit(() => {
      const id = api.freshDocumentBlockId();
      api.writeDocumentBlocks([...api.documentBlocks(), { id, page: 1, x: 80, y: 80, w: 100, h: 50, z: 99, kind: "text", md: "made", at: Date.now() }]);
      made = api.addDocumentShape(1, { type: "arrow", p: [[60, 60], [200, 60]] }, { undo: false });
    });
    await settle(50);
    out.compoundMade = [api.documentBlocks().length - blocksBefore, api.documentShapes().length - shapesBefore];
    const undoBtn = document.querySelector("#documentInkRail [data-ink-action='undo']");
    const redoBtn = document.querySelector("#documentInkRail [data-ink-action='redo']");
    press(undoBtn);
    await settle(80);
    out.compoundUndone = [api.documentBlocks().length - blocksBefore, api.documentShapes().length - shapesBefore];
    out.arrowTombstoned = Boolean(api.state?.meta?.deletedHighlightIds?.[made?.id]);
    press(redoBtn);
    await settle(80);
    out.compoundRedone = [api.documentBlocks().length - blocksBefore, api.documentShapes().length - shapesBefore];
    out.arrowRevived = !api.state?.meta?.deletedHighlightIds?.[made?.id];

    // A7. The static copy every export and picture is drawn from carries the outline.
    const viewport = api.pdfPageViewport(1);
    const copy = await api.buildStaticBlock(find(diamond.id), viewport);
    out.staticOutline = Boolean(copy.querySelector("svg.pdf-block-outline path.pdf-block-outline-edge[d]"));
    out.errors = window.__errs.slice();
    return out;
  }`);

  check("A1. + Add carries a palette of nine block shapes", boxes.paletteCount === 9, `(${boxes.paletteCount})`);
  check("A1. the diamond is a block of its own size, holding its words in the middle",
    boxes.diamond && boxes.diamond.w === 140 && boxes.diamond.h === 92 && boxes.diamond.fit === false && boxes.diamond.valign === "middle",
    JSON.stringify(boxes.diamond));
  check("A1. ...drawn by its outline, not the card", /^M70\.\d+ 0\.\d+L139/.test(boxes.outlinePath) && /rgba?\(0, 0, 0, 0\)|transparent/.test(boxes.cardBg),
    `(${boxes.outlinePath.slice(0, 40)} · ${boxes.cardBg})`);
  check("A1. ...whose fill is the block's", Boolean(boxes.outlineFill) && boxes.outlineFill !== "none", `(${boxes.outlineFill})`);
  check("A1. ...and whose words keep inside the diamond", boxes.bodyPadLeft >= boxes.nodeWidth * 0.24,
    `(padding ${boxes.bodyPadLeft.toFixed(1)}px of ${boxes.nodeWidth.toFixed(1)}px)`);
  check("A2. a block has a top edge, and pulling it up grows the block upward",
    boxes.hasTopEdge && Math.abs(boxes.topResize.h - 90) <= 1 && boxes.topResize.y === boxes.topResize.was.y,
    JSON.stringify(boxes.topResize));
  check("A3. Shift on a corner keeps the box's shape", boxes.shiftRatio.grew && Math.abs(boxes.shiftRatio.after - boxes.shiftRatio.before) < 0.05,
    JSON.stringify(boxes.shiftRatio));
  check("A4. the style bar offers the nine shapes, and a press reshapes the block",
    boxes.shapeButtons === 9 && boxes.plainShape === "ellipse" && boxes.plainHasOutline,
    `(${boxes.shapeButtons} · ${boxes.plainShape})`);
  check("A5. To back and To front go all the way, and no two blocks share a place in the stack",
    boxes.toBack && boxes.toFront && boxes.zUnique);
  check("A6. a block and a shape made in one diagram edit", JSON.stringify(boxes.compoundMade) === "[1,1]", JSON.stringify(boxes.compoundMade));
  check("A6. ...are both taken back by one press of the bar's ↶ (the shape buried)",
    JSON.stringify(boxes.compoundUndone) === "[0,0]" && boxes.arrowTombstoned, JSON.stringify(boxes.compoundUndone));
  check("A6. ...and both put back by one press of ↷", JSON.stringify(boxes.compoundRedone) === "[1,1]" && boxes.arrowRevived,
    JSON.stringify(boxes.compoundRedone));
  check("A7. the static copy an export draws carries the outline", boxes.staticOutline);
  check("A. no page errors", !boxes.errors.length, boxes.errors.join(" | "));

  // ── B. Connectors ───────────────────────────────────────────────────────
  const links = await page.evaluate(`async () => {
    const { api, settle, raf, drag, press, mouse } = window.__recall;
    const out = {};
    const view = document.getElementById("documentView");
    const blockNode = (id) => document.querySelector('[data-pdf-block="' + id + '"]');
    const find = (id) => api.documentBlocks().find((b) => b.id === id);
    const record = (id) => api.documentHighlightById(id);
    const centre = (node) => { const r = node.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    // A clean page: two boxes, side by side, low on the page.
    api.selectBlock(null);
    api.selectShape(null);
    const a = api.addDocumentBlock(1, { x: 140, y: 200 }, { style: { fit: false }, w: 100, h: 50, edit: false });
    const b = api.addDocumentBlock(1, { x: 420, y: 200 }, { style: { fit: false }, w: 100, h: 50, edit: false });
    api.selectBlock(a.id);
    await settle(80);
    const arrows = [...document.querySelectorAll(".pdf-diagram-layer .pdf-connect-arrow")];
    out.arrows = arrows.map((n) => n.dataset.side).sort().join(",");
    const east = arrows.find((n) => n.dataset.side === "e");
    const shapesBefore = api.documentShapes().length;
    // B1. Drag the east arrow onto B.
    await drag(east, centre(east), centre(blockNode(b.id)));
    await settle(80);
    const made = api.documentShapes().filter((r) => r.shape?.ends).at(-1);
    out.connector = made ? { ends: made.shape.ends, p: made.shape.p } : null;
    out.shapesAdded = api.documentShapes().length - shapesBefore;
    out.bWest = b.x;
    out.aEast = a.x + a.w;
    // B2. Drag B down the page: the line follows WHILE dragging, and after.
    const pathOf = () => document.querySelector('.pdf-shape[data-highlight-id="' + made.id + '"] path')?.getAttribute("d") || "";
    const before = pathOf();
    const bNode = blockNode(b.id);
    const from = centre(bNode);
    const scale = api.pdfPageViewport(1).scale || 1;
    const pid = 77;
    mouse(bNode, "pointerdown", from[0], from[1], { pointerId: pid });
    for (let i = 1; i <= 5; i += 1) { mouse(document, "pointermove", from[0], from[1] + i * 12 * scale, { pointerId: pid }); await raf(); }
    await raf();
    out.midDrag = pathOf() !== before;
    mouse(document, "pointerup", from[0], from[1] + 60 * scale, { pointerId: pid });
    await settle(120);
    const moved = find(b.id);
    const after = record(made.id).shape;
    out.follows = { bY: moved.y, endY: after.p[1][1], bTop: moved.y + moved.h, bBottom: moved.y };
    // B3. A press on A's south arrow: a connected copy, opened to type in.
    api.selectBlock(a.id);
    await settle(60);
    const south = document.querySelector(".pdf-diagram-layer .pdf-connect-arrow[data-side='s']");
    const blocksBefore = api.documentBlocks().length;
    const tiedBefore = api.documentShapes().filter((r) => r.shape?.ends).length;
    const sc = centre(south);
    mouse(south, "pointerdown", sc[0], sc[1], { pointerId: 81 });
    mouse(document, "pointerup", sc[0], sc[1], { pointerId: 81 });
    await settle(150);
    out.editorOpen = Boolean(document.getElementById("pdfBlockEditor") && !document.getElementById("pdfBlockEditor").hidden);
    api.commitBlockEdit();
    await settle(60);
    const copy = api.documentBlocks().at(-1);
    out.copy = { added: api.documentBlocks().length - blocksBefore, below: copy.y + copy.h < a.y, sameSize: copy.w === a.w && copy.h === a.h,
      tied: api.documentShapes().filter((r) => r.shape?.ends).length - tiedBefore };
    press(document.querySelector("#documentInkRail [data-ink-action='undo']"));
    await settle(100);
    out.copyUndone = { blocks: api.documentBlocks().length - blocksBefore, tied: api.documentShapes().filter((r) => r.shape?.ends).length - tiedBefore };
    // B4. Square corners.
    api.selectBlock(null);
    api.selectShape(made.id);
    await settle(30);
    api.setShapeSettings({ route: "elbow" });
    await settle(120);
    const routed = record(made.id).shape;
    const path = api.connectorPath(routed);
    out.elbow = { route: routed.route, exits: routed.exits, points: path.length,
      square: path.every((p, i) => i === 0 || Math.abs(p[0] - path[i - 1][0]) < 0.01 || Math.abs(p[1] - path[i - 1][1]) < 0.01) };
    out.bendHandle = Boolean(document.querySelector('.pdf-shape-handle[data-handle="bend"]'));
    api.setShapeSettings({ route: "straight" });
    // B5. Words on the line.
    api.selectShape(null);
    out.labelOpened = api.openConnectorLabelEditor(made.id);
    await raf();
    const editor = document.querySelector(".pdf-connector-label-editor");
    editor.value = "yes";
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(120);
    out.label = record(made.id).shape.text;
    out.labelDrawn = Boolean(document.querySelector('.pdf-shape-text[data-highlight-id="' + made.id + '"]'));
    // B6. Delete B: the line stays, tied; undo brings B back onto it.
    api.deleteBlock(b.id);
    await settle(80);
    out.afterDelete = { line: Boolean(record(made.id)), stillTied: record(made.id)?.shape?.ends?.[1]?.id === b.id };
    api.undoBlocks();
    await settle(80);
    out.bBack = Boolean(find(b.id));
    // ...and Ctrl+Delete takes B with its line, as one step.
    api.selectBlock(b.id);
    await settle(30);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(100);
    out.afterDeleteAll = { block: Boolean(find(b.id)), line: Boolean(record(made.id)) };
    press(document.querySelector("#documentInkRail [data-ink-action='undo']"));
    await settle(100);
    out.afterUndoAll = { block: Boolean(find(b.id)), line: Boolean(record(made.id)) };
    // B7. The Shapes tool's arrow, drawn onto A, ties itself to A.
    api.selectBlock(null);
    api.toggleInkRail?.(true);
    api.chooseInkTool("shape");
    api.setShapeType("arrow");
    await settle(50);
    const aBox = blockNode(a.id).getBoundingClientRect();
    const pen = (type, x, y) => view.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, pressure: 0.5 }));
    const start = [aBox.left + aBox.width / 2, aBox.top - 80];
    pen("pointerdown", start[0], start[1]);
    for (let i = 1; i <= 6; i += 1) { pen("pointermove", start[0], start[1] + (i * 80 + 25) / 6); await raf(); }
    pen("pointerup", start[0], start[1] + 105);
    await settle(120);
    const drawn = api.documentShapes().at(-1);
    out.drawnTied = drawn?.shape?.ends?.[1]?.id === a.id && !drawn?.shape?.ends?.[0];
    out.drawnEndOnTop = drawn ? Math.abs(drawn.shape.p[1][1] - (a.y + a.h + 2)) < 1 : false;
    api.chooseInkTool("pen");
    // B8. Settled: a page with tied lines on it writes nothing while it sits
    // still — the stored ends agree with their ties, so bringing them up to date
    // changes nothing and does not ask again.
    await settle(300);
    const marks = api.state.meta.pdfHighlights;
    const blocksArray = api.state.meta.pdfBlocks;
    api.scheduleConnectorRelink();
    await settle(600);
    out.settled = api.state.meta.pdfHighlights === marks && api.state.meta.pdfBlocks === blocksArray;
    out.errors = window.__errs.slice();
    return out;
  }`);

  check("B1. a picked-up block wears four connect arrows", links.arrows === "e,n,s,w", links.arrows);
  check("B1. dragging one onto another block makes ONE connector tied to both",
    links.shapesAdded === 1 && links.connector?.ends?.[0]?.side === "e" && links.connector?.ends?.[1] && !links.connector.ends[1].side.match(/^[nsw]$/),
    JSON.stringify(links.connector?.ends));
  check("...its ends on the two blocks' facing edges",
    links.connector && Math.abs(links.connector.p[0][0] - (links.aEast + 2)) < 1 && Math.abs(links.connector.p[1][0] - (links.bWest - 2)) < 1,
    JSON.stringify(links.connector?.p));
  check("B2. the line follows a block WHILE it is dragged", links.midDrag);
  check("...and its record follows it after", links.follows.endY < links.follows.bTop && links.follows.endY > links.follows.bBottom,
    JSON.stringify(links.follows));
  check("B3. a press on an arrow makes a connected copy beside the block, open to type in",
    links.editorOpen && links.copy.added === 1 && links.copy.below && links.copy.sameSize && links.copy.tied === 1, JSON.stringify(links.copy));
  check("...and ONE press of ↶ takes the copy and its line back", links.copyUndone.blocks === 0 && links.copyUndone.tied === 0,
    JSON.stringify(links.copyUndone));
  check("B4. a connector routed with square corners runs only across and down, with a middle to hold",
    links.elbow.route === "elbow" && links.elbow.square && links.elbow.points >= 2 && links.bendHandle, JSON.stringify(links.elbow));
  check("B5. words typed on a line are kept and drawn", links.labelOpened && links.label === "yes" && links.labelDrawn,
    `(${links.label})`);
  check("B6. Delete leaves a block's lines, still tied — and undo puts the block back onto them",
    links.afterDelete.line && links.afterDelete.stillTied && links.bBack, JSON.stringify(links.afterDelete));
  check("...Ctrl+Delete takes the block AND its lines, and one ↶ brings both back",
    !links.afterDeleteAll.block && !links.afterDeleteAll.line && links.afterUndoAll.block && links.afterUndoAll.line,
    JSON.stringify([links.afterDeleteAll, links.afterUndoAll]));
  check("B7. an arrow drawn with the Shapes tool onto a block ties itself to it, its tip on the block's edge",
    links.drawnTied && links.drawnEndOnTop);
  check("B8. a page of tied lines, left alone, writes nothing", links.settled);
  check("B. no page errors", !links.errors.length, links.errors.join(" | "));
} catch (error) {
  check("the check itself ran", false, String(error?.stack || error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\nCHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
