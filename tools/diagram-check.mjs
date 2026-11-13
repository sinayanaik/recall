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
//   C. Several at once: a box drawn round three things picks them, the bar
//      lines them up as one undo step, a drag on one moves them all and the
//      line between them follows, Shift-click adds one, Ctrl+C / Ctrl+V copies
//      them with the line re-tied to the copies, a group is picked whole, and
//      with the Select tool a press on a box shape moves it.
//   D. Guides and the grid: a block dragged near another's edge settles onto
//      it with a guide drawn while it is held, Alt skips that, a block near
//      nothing settles onto the squares of grid paper, ⋯ → Snap turns it all
//      off, and a group moved together snaps as one box.

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
    "/src/documents/blank-pdf.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/block-style.js?v=__BUILD__",
    "/src/documents/pdf-block-editor.js?v=__BUILD__",
    "/src/documents/pdf-shapes.js?v=__BUILD__",
    "/src/documents/pdf-connectors.js?v=__BUILD__",
    "/src/documents/canvas-selection.js?v=__BUILD__",
    "/src/documents/pdf-guides.js?v=__BUILD__",
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
    // Exact distances are what A to C measure: the guides and the grid are D's.
    api.writeDiagramSnapPreference(false);

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

  // ── C. Several at once ─────────────────────────────────────────────────
  const many = await page.evaluate(`async () => {
    const { api, settle, raf, drag, press, mouse } = window.__recall;
    const out = {};
    const key = (k, extra = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
    const blockNode = (id) => document.querySelector('[data-pdf-block="' + id + '"]');
    const find = (id) => api.documentBlocks().find((b) => b.id === id);
    const viewport = api.pdfPageViewport(1);
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    const toClient = (x, y) => { const [sx, sy] = viewport.convertToViewportPoint(x, y); const box = pageEl.getBoundingClientRect(); return [box.left + sx, box.top + sy]; };
    api.selectBlock(null);
    api.selectShape(null);
    // Three boxes high on the page, out of the way of everything above, and a
    // line from the first to the second.
    const p = api.addDocumentBlock(1, { x: 120, y: 720 }, { style: { fit: false }, w: 80, h: 40, edit: false });
    const q = api.addDocumentBlock(1, { x: 260, y: 690 }, { style: { fit: false }, w: 80, h: 40, edit: false });
    const r = api.addDocumentBlock(1, { x: 420, y: 740 }, { style: { fit: false }, w: 80, h: 40, edit: false });
    api.selectBlock(null);
    const line = api.createConnector(1, api.resolveConnector({ ...api.newConnectorBase(), type: "arrow", p: [[0, 0], [1, 1]],
      ends: [{ id: p.id, side: "auto" }, { id: q.id, side: "auto" }] }, api.diagramNodes(1)));
    api.selectShape(null);
    await settle(80);
    // C1. With the Select tool, a box drawn on bare paper round all four.
    api.chooseInkTool("text");
    await settle(30);
    const from = toClient(60, 800);
    const to = toClient(500, 630);
    const target = document.elementFromPoint(from[0], from[1]);
    await drag(target, from, to);
    await settle(80);
    out.picked = api.pickedIds().slice().sort();
    out.wanted = [p.id, q.id, r.id, line.id].sort();
    out.frame = Boolean(document.querySelector(".pdf-diagram-layer .pdf-picked-all"));
    out.bar = api.isArrangeBarOpen();
    // C2. Line up their left edges: one press, one step.
    press(document.querySelector(".diagram-arrange-bar [data-arrange='left']"));
    await settle(80);
    out.lefts = [p, q, r].map((b) => find(b.id).x);
    api.undoBlocks();
    await settle(80);
    out.leftsBack = [p, q, r].map((b) => find(b.id).x);
    // C3. A drag on one moves them all; the line between two of them follows.
    const lineBefore = api.documentHighlightById(line.id).shape.p.map((pt) => pt.slice());
    const qc = blockNode(q.id).getBoundingClientRect();
    const scale = viewport.scale || 1;
    await drag(blockNode(q.id), [qc.left + qc.width / 2, qc.top + qc.height / 2], [qc.left + qc.width / 2 + 30 * scale, qc.top + qc.height / 2 + 20 * scale]);
    await settle(150);
    out.moved = [p, q, r].map((b) => [find(b.id).x - b.x, find(b.id).y - b.y]);
    const lineAfter = api.documentHighlightById(line.id).shape.p;
    out.lineMoved = [lineAfter[0][0] - lineBefore[0][0], lineAfter[0][1] - lineBefore[0][1]];
    out.stillPicked = api.pickedIds().length;
    // C4. Shift-click a fourth block in.
    const s4 = api.addDocumentBlock(1, { x: 120, y: 560 }, { style: { fit: false }, w: 60, h: 30, edit: false });
    api.pickIds(1, [p.id, q.id, r.id, line.id]);
    await settle(30);
    const sc = blockNode(s4.id).getBoundingClientRect();
    mouse(blockNode(s4.id), "pointerdown", sc.left + 5, sc.top + 5, { shiftKey: true, pointerId: 5 });
    mouse(document, "pointerup", sc.left + 5, sc.top + 5, { shiftKey: true, pointerId: 5 });
    await settle(60);
    out.afterShift = api.pickedIds().length;
    // C5. Copy and paste: three blocks and the line, the line tied to the copies.
    api.pickIds(1, [p.id, q.id, line.id]);
    const blocksBefore = api.documentBlocks().length;
    const shapesBefore = api.documentShapes().length;
    key("c", { ctrlKey: true });
    key("v", { ctrlKey: true });
    await settle(120);
    const pastedIds = api.pickedIds();
    const pastedLine = pastedIds.map((id) => api.documentHighlightById(id)).find((rec) => rec?.shape?.ends);
    out.pasted = { blocks: api.documentBlocks().length - blocksBefore, shapes: api.documentShapes().length - shapesBefore,
      tiedToCopies: Boolean(pastedLine) && pastedLine.shape.ends.every((end) => end && pastedIds.includes(end.id)) };
    // C6. Group them; a press on one picks all three; ungroup.
    api.pickIds(1, [p.id, q.id, line.id]);
    key("g", { ctrlKey: true });
    await settle(60);
    out.grouped = Boolean(find(p.id).group) && find(p.id).group === find(q.id).group && api.documentHighlightById(line.id).group === find(p.id).group;
    api.clearPick();
    api.selectBlock(null);
    const pc = blockNode(p.id).getBoundingClientRect();
    mouse(blockNode(p.id), "pointerdown", pc.left + 5, pc.top + 5, { pointerId: 6 });
    mouse(document, "pointerup", pc.left + 5, pc.top + 5, { pointerId: 6 });
    await settle(60);
    out.groupPicked = api.pickedIds().length;
    key("G", { ctrlKey: true, shiftKey: true });
    await settle(60);
    out.ungrouped = !find(p.id).group && !find(q.id).group;
    // C7. Delete the pick, and one undo brings it all back.
    api.pickIds(1, [r.id, s4.id]);
    key("Delete");
    await settle(60);
    out.deleted = !find(r.id) && !find(s4.id);
    api.undoBlocks();
    await settle(60);
    out.undeleted = Boolean(find(r.id)) && Boolean(find(s4.id));
    // C8. Ctrl+A picks everything on the page.
    api.clearPick();
    key("a", { ctrlKey: true });
    await settle(60);
    out.all = api.pickedIds().length === api.documentBlocks(1).length + api.documentShapes(1).length;
    key("Escape");
    // C9. With the Select tool, a press on a box shape picks it up and moves it.
    const box = api.addDocumentShape(1, { type: "rect", p: [[300, 560], [360, 600]] });
    api.selectShape(null);
    await settle(60);
    const [bx, by] = toClient(300, 580);
    const under = document.elementFromPoint(bx, by);
    await drag(under, [bx, by], [bx + 25 * scale, by]);
    await settle(80);
    const movedBox = api.documentHighlightById(box.id).shape.p;
    out.boxMoved = Math.round(movedBox[0][0] - 300);
    out.boxSelected = api.selectedShapeRecord()?.id === box.id;
    api.chooseInkTool("pen");
    out.errors = window.__errs.slice();
    return out;
  }`);

  check("C1. a box drawn on bare paper picks the three blocks and the line inside it",
    JSON.stringify(many.picked) === JSON.stringify(many.wanted) && many.frame, `${many.picked.length} picked`);
  check("...and the bar to arrange them comes up", many.bar);
  check("C2. Line up left edges puts them at one x, and one undo puts them back",
    new Set(many.lefts).size === 1 && new Set(many.leftsBack).size === 3, JSON.stringify([many.lefts, many.leftsBack]));
  check("C3. a drag on one of them moves them all by the same amount",
    many.moved.every(([dx, dy]) => Math.abs(dx - 30) < 1.5 && Math.abs(dy + 20) < 1.5), JSON.stringify(many.moved));
  check("...the line between them goes with them, and they stay picked",
    Math.abs(many.lineMoved[0] - 30) < 1.5 && Math.abs(many.lineMoved[1] + 20) < 1.5 && many.stillPicked === 4, JSON.stringify(many.lineMoved));
  check("C4. Shift-click adds a block to the pick", many.afterShift === 5, `(${many.afterShift})`);
  check("C5. Ctrl+C, Ctrl+V copies two blocks and the line, the line tied to the copies",
    many.pasted.blocks === 2 && many.pasted.shapes === 1 && many.pasted.tiedToCopies, JSON.stringify(many.pasted));
  check("C6. Ctrl+G groups them; a press on one picks the whole group; Ctrl+Shift+G ungroups",
    many.grouped && many.groupPicked === 3 && many.ungrouped, `(${many.grouped} · ${many.groupPicked} · ${many.ungrouped})`);
  check("C7. Delete takes the pick, and one undo brings it all back", many.deleted && many.undeleted);
  check("C8. Ctrl+A picks everything on the page", many.all);
  check("C9. with the Select tool, a press on a box shape picks it up and drags it", many.boxMoved === 25 && many.boxSelected,
    `(moved ${many.boxMoved} · selected ${many.boxSelected})`);
  check("C. no page errors", !many.errors.length, many.errors.join(" | "));

  // ── D. Guides and the grid ─────────────────────────────────────────────
  const guides = await page.evaluate(`async () => {
    const { api, settle, raf, drag, press, mouse } = window.__recall;
    const out = {};
    const key = (k, extra = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
    const blockNode = (id) => document.querySelector('[data-pdf-block="' + id + '"]');
    const find = (id) => api.documentBlocks().find((b) => b.id === id);
    // A clean page, and the guides and the grid back on.
    api.writeDiagramSnapPreference(true);
    api.chooseInkTool("pen");
    api.clearPick();
    key("a", { ctrlKey: true });
    key("Delete");
    await settle(100);
    out.cleared = api.documentBlocks(1).length + api.documentShapes(1).length;
    out.paper = api.notebookPaper();
    const scale = api.pdfPageViewport(1).scale || 1;
    const y = api.addDocumentBlock(1, { x: 340, y: 520 }, { style: { fit: false }, w: 80, h: 40, edit: false });
    const x = api.addDocumentBlock(1, { x: 140, y: 300 }, { style: { fit: false }, w: 80, h: 40, edit: false });
    api.selectBlock(null);
    await settle(60);
    const centre = (id) => { const r = blockNode(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    // Dragged so its left edge lands 3pt short of the other's: held there, a
    // guide; let go, the edges are one.
    const startX = find(x.id).x;
    const want = find(y.id).x - 3 - startX;
    const c = centre(x.id);
    const pid = 120;
    mouse(blockNode(x.id), "pointerdown", c[0], c[1], { pointerId: pid });
    for (let i = 1; i <= 6; i += 1) { mouse(document, "pointermove", c[0] + (want * scale * i) / 6, c[1], { pointerId: pid }); await raf(); }
    await raf();
    out.guideWhileHeld = Boolean(document.querySelector(".pdf-diagram-layer .pdf-guide"));
    mouse(document, "pointerup", c[0] + want * scale, c[1], { pointerId: pid });
    await settle(80);
    out.snappedX = find(x.id).x;
    out.targetX = find(y.id).x;
    out.guideAfter = Boolean(document.querySelector(".pdf-diagram-layer .pdf-guide"));
    // ...with Alt held, it goes exactly where it was put.
    api.undoBlocks();
    await settle(60);
    const c2 = centre(x.id);
    await drag(blockNode(x.id), c2, [c2[0] + want * scale, c2[1]], { altKey: true });
    out.altX = find(x.id).x - startX;
    out.want = want;
    // Near nothing, on grid paper: onto the squares.
    api.undoBlocks();
    await settle(60);
    const c3 = centre(x.id);
    await drag(blockNode(x.id), c3, [c3[0] + 37 * scale, c3[1] - 53 * scale]);
    const g = find(x.id);
    out.grid = [g.x % 16, g.y % 16];
    // ⋯ → Snap to guides and grid, off: nothing settles.
    const toggle = document.querySelector("#documentInkRail [data-ink-action='diagram-snap']");
    press(toggle);
    await settle(40);
    out.toggleOff = toggle.getAttribute("aria-checked");
    const before = find(x.id);
    const c4 = centre(x.id);
    // 12pt: past the four pixels a block takes for a tap at this zoom, and not
    // on a square of the grid from where it starts.
    await drag(blockNode(x.id), c4, [c4[0] + 12 * scale, c4[1]]);
    out.freeMove = find(x.id).x - before.x;
    press(toggle);
    await settle(40);
    out.toggleOn = toggle.getAttribute("aria-checked");
    // A group moved together snaps as one box: two blocks picked, dragged so
    // the pair's left edge comes 2pt short of the other block's.
    const z = api.addDocumentBlock(1, { x: 140, y: 200 }, { style: { fit: false }, w: 60, h: 30, edit: false });
    api.selectBlock(null);
    await settle(40);
    api.pickIds(1, [x.id, z.id]);
    await settle(40);
    const left = Math.min(find(x.id).x, find(z.id).x);
    const shift = find(y.id).x - 2 - left;
    const c5 = centre(z.id);
    await drag(blockNode(z.id), c5, [c5[0] + shift * scale, c5[1]]);
    out.groupLeft = Math.min(find(x.id).x, find(z.id).x);
    api.clearPick();
    out.errors = window.__errs.slice();
    return out;
  }`);

  check("D. the page was cleared for it", guides.cleared === 0 && guides.paper === "grid", `(${guides.cleared} left · ${guides.paper})`);
  check("D1. a block dragged near another's edge shows a guide while held", guides.guideWhileHeld);
  check("...and settles onto that edge when let go, the guide gone",
    Math.abs(guides.snappedX - guides.targetX) < 0.01 && !guides.guideAfter, `(${guides.snappedX} vs ${guides.targetX})`);
  check("D2. with Alt held it goes exactly where it was put", Math.abs(guides.altX - guides.want) < 0.6, `(${guides.altX} vs ${guides.want})`);
  check("D3. near nothing, on grid paper, it settles onto the squares", guides.grid.every((n) => Math.abs(n) < 0.01 || Math.abs(n - 16) < 0.01),
    JSON.stringify(guides.grid));
  check("D4. ⋯ → Snap to guides and grid turns it off, and back on",
    guides.toggleOff === "false" && Math.abs(guides.freeMove - 12) < 0.6 && guides.toggleOn === "true", JSON.stringify([guides.toggleOff, guides.freeMove, guides.toggleOn]));
  check("D5. several moved together snap as one box", Math.abs(guides.groupLeft - guides.targetX) < 0.01, `(${guides.groupLeft} vs ${guides.targetX})`);
  check("D. no page errors", !guides.errors.length, guides.errors.join(" | "));
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
