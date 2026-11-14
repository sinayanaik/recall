// Putting things on a page where the mouse is — a pasted picture, Text, a
// Block — on a Canvas.
//
//   node tools/page-place-check.mjs
//
// What it asks, with trusted mouse and key input from the browser itself
// (Input.dispatchMouseEvent / dispatchKeyEvent), because pointerType and the
// order of keydown, paste and dblclick are exactly what is being tested:
//
//   1. Ctrl+V of a picture, with focus left on a button of the pen's bar (the
//      case that used to paste nothing), lands on the page under the mouse
//      with its top-left corner at the pointer.
//   2. After Blocks were copied on the page, a picture pasted later still
//      pastes as a picture once the reader has been to another window — and a
//      Ctrl+V the browser fires no paste event for still pastes the Blocks.
//   3. T with the mouse over a page opens Text there, typed into at once, and
//      putting the words down puts the Text tool away.
//   4. B opens a Block there, its top-left corner at the pointer; a "t" typed
//      into its editor is a letter, not a new piece of Text.
//   5. A mouse double-click on bare paper makes a Block there and leaves no
//      ink; a pen's double tap makes no Block.
//   6. + Add has a Paste picture row.
//   7. Ctrl+V of words onto the page makes a Block of them at the mouse — not
//      for this app's own clipboard token, and not into a Block's editor.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";
import { htmlToImageSource } from "./htmltoimage-source.mjs";

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
    "/src/documents/page-pointer.js?v=__BUILD__",
    "/src/documents/page-clipboard.js?v=__BUILD__",
    "/src/documents/pdf-guides.js?v=__BUILD__",
    "/src/documents/pdf-annot-export.js?v=__BUILD__",
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
    from: () => { throw new Error("page-place-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Place fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;


const chrome = findChrome();
if (!chrome) { console.log("page-place-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome, [], { windowSize: "1280,900" });
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mouseMove = (x, y) => page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
const mouseClick = async (x, y, clickCount, pointerType = "mouse") => {
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount, pointerType });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount, pointerType });
};
const KEYS = { t: 84, b: 66, v: 86, c: 67, Escape: 27 };
const key = async (k, modifiers = 0) => {
  const code = KEYS[k];
  const text = k.length === 1 && !modifiers ? k : undefined;
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, modifiers });
  if (text) await page.call("Input.dispatchKeyEvent", { type: "char", key: k, text, unmodifiedText: text, windowsVirtualKeyCode: code });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, modifiers });
};

// The screen point of a point on page 1, in the page's own points.
const screenOf = (x, y) => page.evaluate(`(x, y) => {
  const { api } = window.__recall;
  const box = document.querySelector("#documentStage .pdf-page[data-page-number='1']").getBoundingClientRect();
  const [vx, vy] = api.pdfPageViewport(1).convertToViewportPoint(x, y);
  return [box.left + vx, box.top + vy];
}`, x, y);

try {
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}`
  });
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflibSource() });
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImageSource() });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens with a page to draw on", opened === true);
  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.writeDiagramSnapPreference?.(false);
    // The page in view, with room around the point used below.
    document.querySelector("#documentStage .pdf-page[data-page-number='1']").scrollIntoView({ block: "start" });
    await settle(300);
    window.__recall.png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8//8/AzJgYkAFAB8FAv3EhrhCAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
    window.__recall.pastePicture = (target) => {
      const data = new DataTransfer();
      data.items.add(new File([window.__recall.png], "screenshot.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      (target || document.activeElement || document.body).dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.__recall.confirmCompression = async () => {
      const waitFor = async (test) => { for (let i = 0; i < 60 && !test(); i += 1) await settle(100); return Boolean(test()); };
      const asked = await waitFor(() => document.querySelector(".image-compress-modal [data-compress-confirm]:not([disabled])"));
      document.querySelector(".image-compress-modal [data-compress-confirm]")?.click();
      return asked;
    };
    window.__recall.images = () => api.documentBlocks().filter((b) => b.kind === "image");
    window.__recall.clearBlocks = async () => { api.commitBlockEdit?.(); api.documentBlocks().forEach((b) => api.deleteBlock(b.id)); await settle(150); };
  }`);

  // ── 1. A picture pasted with focus on the pen's bar ─────────────────────
  const [px, py] = await screenOf(180, 760);
  await mouseMove(px, py);
  await pause(80);
  const pasted = await page.evaluate(`async () => {
    const { api, settle, pastePicture, confirmCompression, images } = window.__recall;
    const before = images().map((b) => b.id);
    const button = document.getElementById("inkRailAddBtn");
    button.focus();
    const focused = document.activeElement === button;
    const taken = pastePicture(button);
    const asked = await confirmCompression();
    for (let i = 0; i < 60 && images().length === before.length; i += 1) await settle(100);
    await settle(200);
    const made = images().find((b) => !before.includes(b.id));
    return { focused, taken, asked, made: made ? { page: made.page, x: made.x, top: made.y + made.h } : null };
  }`);
  check("Ctrl+V of a picture with focus on a button of the pen's bar puts it on the page",
    pasted.focused && pasted.taken && pasted.asked && pasted.made?.page === 1, JSON.stringify(pasted));
  check("...with its top-left corner where the mouse is",
    pasted.made && Math.abs(pasted.made.x - 180) <= 2 && Math.abs(pasted.made.top - 760) <= 2, JSON.stringify(pasted.made));

  await page.evaluate(`() => window.__recall.clearBlocks()`);

  // ── 2. Blocks copied here, then a picture copied elsewhere ──────────────
  const copied = await page.evaluate(`async () => {
    const { api, settle, pastePicture, confirmCompression, images } = window.__recall;
    api.commitBlockEdit?.();
    const block = api.addDocumentBlock(1, { x: 420, y: 300 }, { edit: false });
    await settle(80);
    api.selectBlock(block.id);
    await settle(30);
    const copiedOk = api.copyPicked();
    await settle(60);
    const blocksBefore = api.documentBlocks().filter((b) => b.kind !== "image").length;
    const imagesBefore = images().length;
    // The reader goes to another window and copies a screenshot there.
    window.dispatchEvent(new Event("blur"));
    document.body.focus();
    document.activeElement?.blur?.();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
    const taken = pastePicture(document.body);
    const asked = await confirmCompression();
    for (let i = 0; i < 60 && images().length === imagesBefore; i += 1) await settle(100);
    await settle(200);
    const afterPicture = { blocks: api.documentBlocks().filter((b) => b.kind !== "image").length - blocksBefore, images: images().length - imagesBefore };
    // Ctrl+V with no paste event at all (a browser that fires none on a page
    // that is not editable): the Blocks still paste.
    api.selectBlock(block.id);
    api.copyPicked();
    await settle(60);
    const blocksBefore2 = api.documentBlocks().filter((b) => b.kind !== "image").length;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(200);
    const fallback = api.documentBlocks().filter((b) => b.kind !== "image").length - blocksBefore2;
    return { copiedOk, taken, asked, afterPicture, fallback };
  }`);
  check("after copying Blocks, a picture copied in another window pastes as the picture",
    copied.copiedOk && copied.taken && copied.asked && copied.afterPicture.images === 1 && copied.afterPicture.blocks === 0, JSON.stringify(copied));
  check("...and a Ctrl+V that fires no paste event still pastes the Blocks", copied.fallback === 1, JSON.stringify(copied));

  await page.evaluate(`() => window.__recall.clearBlocks()`);

  // ── 3. T: Text at the mouse ─────────────────────────────────────────────
  await page.evaluate(`async () => { document.activeElement?.blur?.(); window.__recall.api.clearPick?.(); await window.__recall.settle(50); }`);
  const [tx, ty] = await screenOf(120, 700);
  await mouseMove(tx, ty);
  await pause(60);
  const shapesBefore = await page.evaluate(`() => window.__recall.api.documentShapes(1).length`);
  await key("t");
  await pause(250);
  const typing = await page.evaluate(`() => {
    const { api } = window.__recall;
    const id = api.editingShapeTextId();
    const record = id ? api.documentShapes(1).find((r) => r.id === id) : null;
    return { id, armed: api.isTypewriterArmed(), count: api.documentShapes(1).length, shape: record?.shape || null, focused: document.activeElement?.isContentEditable || /TEXTAREA|INPUT/.test(document.activeElement?.tagName || "") };
  }`);
  check("T over a page opens Text there, ready to type", Boolean(typing.id) && typing.armed && typing.count === shapesBefore + 1 && typing.focused, JSON.stringify(typing));
  await page.call("Input.insertText", { text: "hello" });
  await pause(100);
  await key("Escape");
  await pause(300);
  const typed = await page.evaluate(`(id) => {
    const { api } = window.__recall;
    const record = api.documentShapes(1).find((r) => r.id === id);
    return { text: record?.shape?.text || "", armed: api.isTypewriterArmed(), editing: api.editingShapeTextId() };
  }`, typing.id);
  check("...the words are kept and the Text tool puts itself away", typed.text.includes("hello") && !typed.armed && !typed.editing, JSON.stringify(typed));
  const firstPoint = typing.shape?.p?.[0] || typing.shape?.points?.[0] || null;
  check("...where the mouse was", !firstPoint || (Math.abs(firstPoint[0] - 120) < 8 && Math.abs(firstPoint[1] - 700) < 16), JSON.stringify(typing.shape));

  // ── 4. B: a Block at the mouse ──────────────────────────────────────────
  const [bx, by] = await screenOf(300, 700);
  await mouseMove(bx, by);
  await pause(60);
  const blocksBeforeB = await page.evaluate(`() => window.__recall.api.documentBlocks().length`);
  await key("b");
  await pause(300);
  const bBlock = await page.evaluate(`() => {
    const { api } = window.__recall;
    const made = api.documentBlocks().slice(-1)[0];
    return { count: api.documentBlocks().length, editing: api.isEditingBlock(), x: made.x, top: made.y + made.h, page: made.page };
  }`);
  check("B over a page makes a Block there, its editor open", bBlock.count === blocksBeforeB + 1 && bBlock.editing, JSON.stringify(bBlock));
  check("...its top-left corner at the mouse", Math.abs(bBlock.x - 300) <= 2 && Math.abs(bBlock.top - 700) <= 2, JSON.stringify(bBlock));
  const shapesBeforeLetter = await page.evaluate(`() => window.__recall.api.documentShapes(1).length`);
  await key("t");
  await pause(150);
  const letter = await page.evaluate(`() => {
    const { api } = window.__recall;
    const field = document.querySelector(".pdf-block-editor:not([hidden]) textarea") || document.activeElement;
    const value = field?.value || "";
    return { value, shapes: api.documentShapes(1).length, editing: api.isEditingBlock() };
  }`);
  check("a t typed into the Block's editor is a letter, not new Text", letter.value.includes("t") && letter.shapes === shapesBeforeLetter && letter.editing, JSON.stringify(letter));
  await page.evaluate(`() => window.__recall.clearBlocks()`);

  // ── 5. Double-click ─────────────────────────────────────────────────────
  const inkCount = `() => window.__recall.api.documentHighlights().filter((r) => r.kind === "ink" || r.kind === "stroke" || Array.isArray(r.strokes)).length`;
  await page.evaluate(`async () => { const { api, settle } = window.__recall; if (!api.isInkArmed()) api.setInkArmed(true); api.setInkTool("pen"); await settle(100); }`);
  const [dx, dy] = await screenOf(200, 760);
  const before5 = await page.evaluate(`() => ({ blocks: window.__recall.api.documentBlocks().length, ink: (${inkCount})() })`);
  await mouseMove(dx, dy);
  await mouseClick(dx, dy, 1);
  await mouseClick(dx, dy, 2);
  await pause(300);
  const after5 = await page.evaluate(`() => {
    const { api } = window.__recall;
    const made = api.documentBlocks().slice(-1)[0];
    return { blocks: api.documentBlocks().length, ink: (${inkCount})(), editing: api.isEditingBlock(), x: made.x, top: made.y + made.h, armed: api.isInkArmed(), tool: api.inkTool() };
  }`);
  check("a mouse double-click on bare paper (pen armed) makes a Block there",
    after5.blocks === before5.blocks + 1 && after5.editing && Math.abs(after5.x - 200) <= 2 && Math.abs(after5.top - 760) <= 2, JSON.stringify({ before5, after5 }));
  check("...and leaves no ink behind", after5.ink === before5.ink, JSON.stringify({ before5, after5 }));
  await page.evaluate(`async () => { window.__recall.api.commitBlockEdit(); await window.__recall.settle(150); }`);

  const [ex, ey] = await screenOf(450, 640);
  const before6 = await page.evaluate(`() => window.__recall.api.documentBlocks().length`);
  await page.penDown(ex, ey); await page.penUp(ex, ey);
  await pause(60);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: ex, y: ey, button: "left", buttons: 1, clickCount: 2, pointerType: "pen", force: 0.5 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", buttons: 0, clickCount: 2, pointerType: "pen" });
  await pause(300);
  const after6 = await page.evaluate(`() => ({ blocks: window.__recall.api.documentBlocks().length, editing: window.__recall.api.isEditingBlock(), ink: (${inkCount})(), dots: window.__recall.api.inkTapDots() })`);
  check("a pen's double tap makes no Block", after6.blocks === before6 && !after6.editing, JSON.stringify({ before6, after6 }));
  check("...and is still writing: it leaves its dots", !after6.dots || after6.ink > after5.ink, JSON.stringify({ after5, after6 }));

  // ── 7. Words pasted onto the page ───────────────────────────────────────
  await page.evaluate(`() => window.__recall.clearBlocks()`);
  const [wx, wy] = await screenOf(100, 600);
  await mouseMove(wx, wy);
  await pause(60);
  const words = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const pasteText = (target, text, html = "") => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (html) data.setData("text/html", html);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    document.activeElement?.blur?.();
    const before = api.documentBlocks().length;
    const text = "First line of the copied words\\nand a second, rather longer, line that follows it";
    const taken = pasteText(document.body, text);
    await settle(300);
    const made = api.documentBlocks().slice(-1)[0];
    const node = made && document.querySelector('[data-pdf-block="' + made.id + '"]');
    const result = {
      taken, count: api.documentBlocks().length - before,
      md: made?.md || "", x: made?.x, top: made ? made.y + made.h : null, w: made?.w,
      editing: api.isEditingBlock(), shown: (node?.textContent || "").includes("First line")
    };
    // A token of an in-app copy is not words.
    const before2 = api.documentBlocks().length;
    pasteText(document.body, "recall-objects:abc123def4");
    await settle(150);
    result.tokenIgnored = api.documentBlocks().length === before2;
    // Words pasted into a Block's editor are the editor's.
    const host = api.addDocumentBlock(1, { x: 300, y: 300 });
    await settle(200);
    const field = document.querySelector(".pdf-block-editor:not([hidden]) textarea");
    const before3 = api.documentBlocks().length;
    if (field) { field.focus(); pasteText(field, "inside"); }
    await settle(150);
    result.editorKeeps = Boolean(field) && api.documentBlocks().length === before3;
    api.commitBlockEdit();
    await settle(100);
    return result;
  }`);
  check("Ctrl+V of words onto the page makes a Block holding them", words.taken && words.count === 1 && words.md.includes("First line") && words.md.includes("second") && words.shown && !words.editing, JSON.stringify(words));
  check("...with its top-left corner where the mouse is, wider for a long line", Math.abs(words.x - 100) <= 2 && Math.abs(words.top - 600) <= 2 && words.w > 240, JSON.stringify(words));
  check("...but not this app's own clipboard token, and not a paste into a Block's editor", words.tokenIgnored && words.editorKeeps, JSON.stringify(words));

  // ── 6. The row for a keyboard-less device ───────────────────────────────
  const row = await page.evaluate(`() => Boolean(document.querySelector("#inkRailAddMenu [data-hw-action='paste-picture']"))`);
  check("+ Add has a Paste picture row", row);

  const errs = await page.evaluate(`() => window.__errs`);
  check("no page errors", !errs.length, errs.join(" | "));
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the check itself: ${error.message}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\nCHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
