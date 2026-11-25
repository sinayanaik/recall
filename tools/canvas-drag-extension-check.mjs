// The Recall Drag to Canvas extension (recall-canvas-drag/), loaded into a real
// Chrome, end to end: a part of a web page picked with Alt held, dragged by its
// ⠿ grip with trusted input, and dropped onto a Canvas page in the app on
// another origin.
//
//   node tools/canvas-drag-extension-check.mjs
//   CANVAS_SHOTS=<dir> node tools/canvas-drag-extension-check.mjs   (pictures)
//
// The drag is started on the web page and intercepted over the DevTools
// protocol (Input.setInterceptDrags), which hands back exactly the data Chrome
// would carry; that data is then dropped onto the app's Canvas page with
// Input.dispatchDragEvent — the same thing a person does across two windows,
// which a headless browser has no screen to do. The web page and the app are on
// two different ports, so two origins: what reaches the app is what a real
// cross-site drag would bring.
//
// Covers the content script's pick, its cleaned HTML, the pictures it carries,
// the picture of the part, and the app reading all of it
// (src/documents/web-clip-drop.js): Blocks with the pictures stored as the
// reader's own, and with Shift held, a picture Block. And that the extension
// stays out of Recall's own page.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = path.join(ROOT, "recall-canvas-drag");
const MIME = "application/x-recall-web-clip";
const WATCHDOG_MS = 150000;

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
    "/src/documents/doc-scrollers.js?v=__BUILD__",
    "/src/import/web-images.js?v=__BUILD__",
    "/src/documents/web-clip-drop.js?v=__BUILD__"
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
    from: () => { throw new Error("canvas-drag-extension-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  // Pictures are "stored" at an address that says what was stored, so the
  // check can tell a carried picture from one fetched again.
  window.__stored = [];
  api.setWebImageTransport({
    online: () => true,
    upload: async (file, options) => { window.__stored.push({ name: file.name, type: file.type, size: file.size, folder: options && options.folder }); return "https://stored.test/" + window.__stored.length + "/" + encodeURIComponent(file.name); },
    fetch: async (url) => { window.__fetched = (window.__fetched || []).concat(url); throw new Error("no network in this check"); }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Drag to Canvas fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  await settle(300);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

const chrome = findChrome();
if (!chrome) { console.log("canvas-drag-extension-check: no Chrome on this machine — skipping."); process.exit(0); }

const app = await serveOn(ROOT);
const site = await serveOn(ROOT); // a second port: another origin
const launched = await launchChrome(chrome, [
  `--disable-extensions-except=${EXTENSION}`,
  `--load-extension=${EXTENSION}`
], { windowSize: "1400,950" });
const client = await connect(launched.wsUrl);

const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.close(); } catch (_) { /* already gone */ }
  try { app.proc.kill("SIGKILL"); site.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
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
const SHOTS = process.env.CANVAS_SHOTS || "";
async function snap(target, name) {
  if (!SHOTS) return;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(SHOTS, { recursive: true });
  const shot = await target.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}
const ALT = 1;
const SHIFT = 8;

function keys(page, type, key, modifiers) {
  const code = key === "Alt" ? "AltLeft" : key === "Shift" ? "ShiftLeft" : key;
  const vk = key === "Alt" ? 18 : key === "Shift" ? 16 : 0;
  return page.call("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

function mouse(page, type, x, y, { buttons = 0, modifiers = 0 } = {}) {
  return page.call("Input.dispatchMouseEvent", {
    type, x, y, modifiers, buttons, clickCount: 1, button: type === "mouseMoved" && !buttons ? "none" : "left"
  });
}

try {
  // The extension's worker is up before any page loads.
  for (let i = 0; i < 50; i += 1) {
    const { targetInfos } = await client.send("Target.getTargets");
    if (targetInfos.some((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) break;
    await pause(100);
  }

  // ── 1. On a web page: Alt, point, drag the grip ────────────────────────
  const web = await openPage(client);
  await web.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await web.goto(`${site.base}/recall-canvas-drag/tools/fixtures/page.html`);
  await pause(600);
  const card = await web.evaluate(() => { const r = document.getElementById("card").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  const noneYet = await web.evaluate(() => !document.querySelector("recall-canvas-drag"));
  // Over the card's own padding, not one of its children.
  const over = { x: card.left + 6, y: card.top + card.height / 2 };
  await mouse(web, "mouseMoved", over.x, over.y);
  await keys(web, "rawKeyDown", "Alt", ALT);
  await mouse(web, "mouseMoved", over.x + 1, over.y, { modifiers: ALT });
  await pause(200);
  const shown = await web.evaluate(() => Boolean(document.querySelector("recall-canvas-drag")));
  check("holding Alt over a part of a web page outlines it (and nothing is there before)", noneYet && shown, JSON.stringify({ noneYet, shown }));
  // Let go of Alt: the outline is kept while the pointer stays on it.
  await keys(web, "keyUp", "Alt", 0);
  await pause(2200); // the HTML, its pictures, and the picture of the part
  const kept = await web.evaluate(() => Boolean(document.querySelector("recall-canvas-drag")));
  check("...and letting go of Alt keeps it while the pointer is on it", kept);
  await snap(web, "1-web-page-outlined.png");

  // Its grip sits above the part's top-left corner (content/drag.js, place()).
  const grip = { x: Math.max(2, card.left - 3) + 16, y: card.top - 3 - 24 + 12 };
  await mouse(web, "mouseMoved", grip.x, card.top + 4);
  await mouse(web, "mouseMoved", grip.x, grip.y);
  await web.call("Input.setInterceptDrags", { enabled: true });
  let data = null;
  const off = client.on((m) => { if (m.sessionId === web.sessionId && m.method === "Input.dragIntercepted") data = m.params.data; });
  await mouse(web, "mousePressed", grip.x, grip.y, { buttons: 1 });
  for (let i = 1; i <= 8 && !data; i += 1) {
    await mouse(web, "mouseMoved", grip.x + i * 5, grip.y + i * 4, { buttons: 1 });
    await pause(40);
  }
  off();
  await mouse(web, "mouseReleased", grip.x + 40, grip.y + 30);
  await web.call("Input.setInterceptDrags", { enabled: false });
  const types = data ? data.items.map((item) => item.mimeType) : [];
  check("dragging the grip starts a drag carrying the part, as HTML and words too", types.includes(MIME) && types.includes("text/html") && types.includes("text/plain"), JSON.stringify(types));
  let clip = null;
  try { clip = JSON.parse(data.items.find((item) => item.mimeType === MIME).data); } catch (_) { clip = null; }
  const html = clip?.html || "";
  check("...the whole card: heading, words, list, table, code", /<h2/.test(html) && /<strong>timed<\/strong>/.test(html) && /<li>Short gaps first<\/li>/.test(html) && /<table/.test(html) && /<pre><code class="language-python">/.test(html), html.slice(0, 160));
  check("...without what the page hides, its icons or its styles", !/Secret hidden/.test(html) && !/<svg/.test(html) && !/style=/.test(html), html.length);
  check("...a button as its words, a drawn canvas as a picture", /<span>Press me<\/span>/.test(html) && /<img src="data:image\/png;base64,/.test(html));
  const iconUrl = `${site.base}/recall-canvas-drag/icons/icon-128.png`;
  check("...links and picture addresses made whole", html.includes(`href="${site.base}/docs/more.html"`) && html.includes(`src="${iconUrl}"`));
  check("...the picture's own bytes carried with it", /^data:image\/png;base64,/.test(clip?.images?.[iconUrl] || ""), Object.keys(clip?.images || {}).join(", "));
  check("...and a picture of the card as it looks", /^data:image\/png;base64,/.test(clip?.picture?.dataUrl || "") && Math.abs((clip?.picture?.cssWidth || 0) - Math.round(card.width)) <= 2 && clip?.picture?.cut === false, JSON.stringify(clip?.picture && { w: clip.picture.cssWidth, h: clip.picture.cssHeight, cut: clip.picture.cut }));
  check("...with where it came from", clip?.title === "Fixture article" && /fixtures\/page\.html$/.test(clip?.url || ""));

  // ── 2. In Recall, on another origin ─────────────────────────────────────
  const page = await openPage(client);
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("recall:pdfPictures", "0"); } catch (e) {}` });
  await page.goto(`${app.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens in Recall", opened === true);

  // The extension stays out of Recall itself.
  await mouse(page, "mouseMoved", 300, 300);
  await keys(page, "rawKeyDown", "Alt", ALT);
  await mouse(page, "mouseMoved", 302, 300, { modifiers: ALT });
  await pause(300);
  await keys(page, "keyUp", "Alt", 0);
  check("the extension does nothing on Recall's own page", await page.evaluate(() => !document.querySelector("recall-canvas-drag")));

  const pageBox = await page.evaluate(() => { const r = document.querySelector("#documentStage .pdf-page[data-page-number='1']").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const dropAt = async (fx, fy, modifiers = 0) => {
    const x = pageBox.x + pageBox.w * fx;
    const y = pageBox.y + pageBox.h * fy;
    const before = await page.evaluate(() => window.__recall.api.documentBlocks().map((b) => b.id));
    await page.call("Input.dispatchDragEvent", { type: "dragEnter", x, y, data, modifiers });
    await page.call("Input.dispatchDragEvent", { type: "dragOver", x, y, data, modifiers });
    await pause(100);
    await page.call("Input.dispatchDragEvent", { type: "dragOver", x, y, data, modifiers });
    const ghost = await page.evaluate(() => document.querySelector(".canvas-drop-ghost")?.textContent || "");
    await page.call("Input.dispatchDragEvent", { type: "drop", x, y, data, modifiers });
    // Any dialog asking how to compress a picture: its default.
    for (let i = 0; i < 30; i += 1) {
      await pause(150);
      const pressed = await page.evaluate(() => {
        const ok = document.querySelector(".image-compress-modal [data-compress-confirm]:not([disabled])");
        if (ok) { ok.click(); return true; }
        return false;
      });
      if (!pressed && i > 8) break;
    }
    await pause(1500);
    return page.evaluate((ids) => {
      const seen = new Set(ids);
      return { made: window.__recall.api.documentBlocks().filter((b) => !seen.has(b.id)), stored: window.__stored.slice(), fetched: window.__fetched || [] };
    }, before).then((result) => ({ ...result, ghost }));
  };

  const asBlocks = await dropAt(0.1, 0.12);
  const block = asBlocks.made[0];
  const md = block?.md || "";
  check("dropped on a Canvas page, the card is a Block there, previewed as words while over it", asBlocks.made.length === 1 && asBlocks.ghost === "Words", JSON.stringify({ n: asBlocks.made.length, ghost: asBlocks.ghost }));
  check("...as markdown: heading, bold, list, table and code kept", /^#+ Spaced repetition/m.test(md) && /\*\*timed\*\*/.test(md) && /^\s*[-*+]\s+Short gaps first/m.test(md) && /\|\s*Review\s*\|\s*Gap\s*\|/.test(md) && /```python/.test(md), JSON.stringify(md.slice(0, 300)));
  check("...without the page's hidden words", !/Secret hidden/.test(md));
  check("...its pictures stored as the reader's own from the bytes it carried, not fetched again", asBlocks.stored.length === 2 && !asBlocks.fetched.length && asBlocks.stored.every((s) => /^web\//.test(s.folder || "")), JSON.stringify({ stored: asBlocks.stored, fetched: asBlocks.fetched }));
  check("...and the Block points at the stored copies, not the web page", /https:\/\/stored\.test\/\d+\//.test(md) && !md.includes(iconUrl) && !/data:image/.test(md), JSON.stringify(md.match(/!\[[^\]]*\]\([^)]{0,80}/g)));

  const asPicture = await dropAt(0.6, 0.3, SHIFT);
  const picture = asPicture.made[0];
  check("with Shift held at the drop, previewed and put on as a picture of it", asPicture.ghost === "Picture" && asPicture.made.length === 1 && picture?.kind === "image", JSON.stringify({ ghost: asPicture.ghost, made: asPicture.made.map((b) => ({ kind: b.kind, w: b.w, h: b.h })) }));
  check("...at the size it was on the page", picture && Math.abs(picture.w - Math.round(card.width * 0.75)) <= 3, `w=${picture?.w} expected≈${Math.round(card.width * 0.75)}`);

  await snap(page, "2-on-the-canvas.png");
  const errs = await page.evaluate(() => window.__errs);
  check("no page errors in Recall", !errs.length, JSON.stringify(errs));
} catch (error) {
  failures += 1;
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  await launched.close();
  app.proc.kill();
  site.proc.kill();
}

console.log(`\ncanvas-drag-extension-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
