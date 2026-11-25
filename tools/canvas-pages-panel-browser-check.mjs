// The Canvas's Pages panel, and the pills in the gap under each page, on a
// real Canvas in a real browser.
//
//   node tools/canvas-pages-panel-browser-check.mjs
//   CANVAS_PAGES_SHOTS=<dir> node tools/canvas-pages-panel-browser-check.mjs   (and pictures)
//
// What a reader asked for: the page control in the corner covered "Page 2 ⋯",
// export always took every page, and they wanted every Canvas page down the
// side "how PowerPoint displays", to pick, reorder and export from. So:
//
//   1. "＋ Page │ Page k ⋯" is one cluster in the middle of the gap, and the
//      floating pager never covers it, panel open or not;
//   2. ▤ in the pager opens the panel: a picture of every page, the page in
//      view outlined, the pages pushed aside rather than covered;
//   3. Ctrl-click picks pages; ⇓ and the panel's Export… take only those, the
//      PDF numbered "1 / 2", "2 / 2" and the web page with just those pages;
//   4. a page dragged to the top takes what is on it — and a card's picture of
//      it — with it; Duplicate and Delete act on the pages picked.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { pdflibSource } from "./pdflib-source.mjs";
import { htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 240000;
const SHOTS = process.env.CANVAS_PAGES_SHOTS || "";

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
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/documents/view-only.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/documents/canvas-setup.js?v=__BUILD__",
    "/src/documents/canvas-setup-dialog.js?v=__BUILD__",
    "/src/documents/canvas-pages-panel.js?v=__BUILD__",
    "/src/export/canvas-html.js?v=__BUILD__",
    "/src/documents/blank-pdf.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/cloud/s3-files.js?v=__BUILD__",
    "/src/storage/ink-prefs.js?v=__BUILD__",
    "/src/core/lib-loader.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
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
    from: () => { throw new Error("canvas-pages-panel-browser-check does not touch the database"); },
    storage: { from: () => ({ upload: async (p) => ({ data: { path: p }, error: null }), createSignedUrls: async () => ({ data: [], error: null }), list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Pages panel fixture", notesMode: true });
  await settle(400);
  document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
  await settle(250);
  document.querySelector("#documentView .pdf-missing-pick")?.click();
  for (let i = 0; i < 80 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
  await settle(300);
  return Boolean(document.querySelector("#documentStage .pdf-page[data-page-number='1']"));
}`;

const chrome = findChrome();
if (!chrome) { console.log("canvas-pages-panel-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

// pdf-lib for the Canvas PDF case, from disk as the other checks take it; with
// no way to fetch it, that one case is skipped rather than the whole check.
let pdflib = null;
try {
  pdflib = pdflibSource();
} catch (error) {
  console.log(`canvas-pages-panel-browser-check: no pdf-lib (${error?.message || error}) — the Canvas PDF case will be skipped.`);
}

// html-to-image draws the Blocks into the page pictures, as it does for the
// export; with no copy of it, the picture-of-a-Block case is skipped.
let htmlToImage = null;
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`canvas-pages-panel-browser-check: no html-to-image (${error?.message || error}) — Blocks in the pictures will not be checked.`);
}

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

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const picture = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, name), Buffer.from(picture.data, "base64"));
  console.log(`  shot  ${path.join(SHOTS, name)}`);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: SHOTS ? 2 : 1, mobile: false });
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await servePdfjsFromDisk(client, page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("recall:pdfPictures", "0"); localStorage.removeItem("recall:view-only-v1"); localStorage.removeItem("recall:canvas-pages-panel-v1"); } catch (e) {}`
  });
  if (pdflib) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  await page.goto(`${server.base}/index.html`);
  const pdfjs = pdfjsSources();
  const opened = await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  check("a Canvas opens", opened === true, JSON.stringify(opened));

  // Four pages, a Block on pages 2 and 3, and a note showing a spot of page 3.
  const made = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const painted = async (sha) => {
      for (let i = 0; i < 100; i += 1) {
        if (api.state.meta.notebook.sha256 !== sha && document.querySelector("#documentStage .pdf-page canvas.pdf-canvas")) break;
        await settle(80);
      }
      await settle(400);
    };
    window.__painted = painted;
    for (let k = 0; k < 3; k += 1) {
      const sha = api.state.meta.notebook.sha256;
      await api.addNotebookPage();
      await painted(sha);
    }
    const onPage = async (n, md) => {
      api.scrollToDocumentPage(n, 0, { smooth: false });
      for (let i = 0; i < 40 && !api.pdfPageViewport(n); i += 1) await settle(100);
      return api.addDocumentBlock(n, { x: 80, y: 700 }, { md, edit: false });
    };
    const two = await onPage(2, "On page two");
    const three = await onPage(3, "On page three");
    api.state.notes = "A spot: ![](pdfref:3:10,10,200,200:canvas)";
    await settle(300);
    window.__ids = { two: two.id, three: three.id };
    return { pages: api.notebookPageCount(), two: Boolean(two), three: Boolean(three) };
  }`);
  check("a four-page Canvas with Blocks on pages 2 and 3", made.pages === 4 && made.two && made.three, JSON.stringify(made));

  // ── 1. The gap's cluster and the pager ─────────────────────────────────
  const overlap = async () => page.evaluate(`async () => {
    const { settle } = window.__recall;
    const view = document.getElementById("documentView");
    const pager = document.getElementById("documentPager");
    const gap = document.querySelector('#documentStage .pdf-page[data-page-number="1"] .canvas-page-gap');
    if (!gap || !pager) return { missing: true };
    // The gap under page 1 brought level with the pager — the corner where
    // "Page 2 ⋯" used to hide.
    view.scrollTop += gap.getBoundingClientRect().top - pager.getBoundingClientRect().top;
    await settle(400);
    const a = gap.getBoundingClientRect();
    const b = pager.getBoundingClientRect();
    const hits = (r) => !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
    const pills = [...gap.children].map((node) => node.getBoundingClientRect());
    const page1 = document.querySelector('#documentStage .pdf-page[data-page-number="1"]').getBoundingClientRect();
    return {
      pills: gap.children.length,
      hit: pills.some(hits),
      centred: Math.abs((a.left + a.right) / 2 - (page1.left + page1.right) / 2) < 2,
      level: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 40
    };
  }`);
  const gap1 = await overlap();
  check("＋ Page and Page k ⋯ are one cluster, centred under the page", gap1.pills === 2 && gap1.centred, JSON.stringify(gap1));
  check("...and the pager does not cover them, level with it", gap1.level && !gap1.hit, JSON.stringify(gap1));
  await shot("gap-cluster.png");

  // ── 2. The panel ───────────────────────────────────────────────────────
  const panel = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(300);
    const pageW = document.querySelector('#documentStage .pdf-page[data-page-number="1"]').getBoundingClientRect().width;
    document.getElementById("canvasPagesBtn").click();
    await settle(600);
    const root = document.getElementById("canvasPagesPanel");
    for (let i = 0; i < 80 && root.querySelectorAll(".cpp-thumb canvas").length < 4; i += 1) await settle(150);
    const scroller = document.getElementById("documentView").getBoundingClientRect();
    const box = root.getBoundingClientRect();
    return {
      shown: Boolean(root && !root.hidden && root.offsetParent),
      inStage: root.parentElement?.id,
      items: root.querySelectorAll(".cpp-item").length,
      drawn: root.querySelectorAll(".cpp-thumb canvas").length,
      current: root.querySelector(".cpp-item.is-current")?.dataset.page,
      pushed: scroller.left >= box.right - 1,
      pageW,
      pageWAfter: document.querySelector('#documentStage .pdf-page[data-page-number="1"]').getBoundingClientRect().width,
      pressed: document.getElementById("canvasPagesBtn").getAttribute("aria-pressed"),
      stored: localStorage.getItem("recall:canvas-pages-panel-v1")
    };
  }`);
  check("▤ opens the Pages panel in the Canvas's stage", panel.shown && panel.inStage === "documentStage" && panel.pressed === "true", JSON.stringify(panel));
  check("...with a picture of every page", panel.items === 4 && panel.drawn === 4, JSON.stringify(panel));
  check("...the page in view outlined", panel.current === "1", JSON.stringify(panel));
  check("...the pages made room for it, not covered", panel.pushed, JSON.stringify(panel));
  check("...remembered on this device", panel.stored === "open", panel.stored);
  if (htmlToImage) {
    // Page 2's picture has its Block on it; page 4's is bare paper.
    const ink = await page.evaluate(`() => {
      const data = (n) => {
        const c = document.querySelector('#canvasPagesPanel .cpp-item[data-page="' + n + '"] .cpp-thumb canvas');
        return c ? c.getContext("2d").getImageData(0, 0, c.width, c.height).data : null;
      };
      const two = data(2);
      const four = data(4);
      if (!two || !four || two.length !== four.length) return { missing: true };
      let differ = 0;
      for (let i = 0; i < two.length; i += 4) {
        if (Math.abs(two[i] - four[i]) + Math.abs(two[i + 1] - four[i + 1]) + Math.abs(two[i + 2] - four[i + 2]) > 60) differ += 1;
      }
      return { differ };
    }`);
    check("a page's picture shows what is on it (page 2's Block)", ink.differ > 40, JSON.stringify(ink));
  }
  const gap2 = await overlap();
  check("with the panel open the pager still covers no pill", !gap2.hit, JSON.stringify(gap2));
  await shot("panel-open.png");

  // ── 3. Pick pages 2 and 4, export only those ──────────────────────────
  const centre = async (n) => page.evaluate(`() => {
    const r = document.querySelector('#canvasPagesPanel .cpp-item[data-page="${n}"] .cpp-thumb').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }`);
  const mouse = async (type, at, modifiers = 0) => page.call("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers });
  const clickAt = async (at, modifiers = 0) => { await mouse("mousePressed", at, modifiers); await mouse("mouseReleased", at, modifiers); };
  const scrollPanelTo = async (n) => page.evaluate(`async () => { document.querySelector('#canvasPagesPanel .cpp-item[data-page="${n}"]').scrollIntoView({ block: "center" }); await window.__recall.settle(200); }`);
  // A plain press only goes to the page: nothing is picked, ⇓ still every page.
  await scrollPanelTo(3);
  await clickAt(await centre(3));
  const plain = await page.evaluate(`async () => { await window.__recall.settle(500); return { selection: window.__recall.api.canvasExportSelection(), inView: window.__recall.api.documentPageInFocus() }; }`);
  check("a plain press goes to the page and picks nothing", plain.selection === null && plain.inView === 3, JSON.stringify(plain));
  await scrollPanelTo(2);
  await clickAt(await centre(2), 2 /* Ctrl */);
  await scrollPanelTo(4);
  await clickAt(await centre(4), 2 /* Ctrl */);
  const picked = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    await settle(200);
    const out = { selection: api.canvasExportSelection(), bar: document.querySelector("#canvasPagesPanel .cpp-picked")?.textContent };
    document.getElementById("viewExportBtn")?.click();
    await settle(200);
    out.menuHead = document.querySelector("#viewExportMenu .md-menu-head")?.textContent || "";
    document.getElementById("viewExportBtn")?.click();
    await settle(100);
    const html = await api.buildCanvasHtml({ pages: out.selection });
    out.htmlPages = (html.html.match(/class="cx-page"/g) || []).length;
    out.htmlNumbers = ["1 / 2", "2 / 2"].every((label) => html.html.includes(label));
    out.htmlNoThree = !html.html.includes("On page three") && !html.html.includes(">3 / ");
    out.htmlName = html.name;
    out.htmlHasTwo = html.html.includes("On page two");
    if (window.PDFLib) {
      const pdf = await api.buildCanvasPdfBytes({ pages: out.selection });
      const doc = await window.pdfjsLib.getDocument({ data: pdf.bytes.slice() }).promise;
      out.pdfPages = doc.numPages;
      out.pdfName = pdf.name;
      const words = [];
      for (let n = 1; n <= doc.numPages; n += 1) {
        const text = await (await doc.getPage(n)).getTextContent();
        words.push(text.items.map((item) => item.str).join(" "));
      }
      out.pdfWords = words;
    }
    return out;
  }`);
  check("Ctrl-click picks pages 2 and 4", JSON.stringify(picked.selection) === "[2,4]" && /2 picked/.test(picked.bar), JSON.stringify(picked));
  check("⇓ says it exports those pages", /2 pages/.test(picked.menuHead), picked.menuHead);
  check("the web page holds just those two, numbered 1 / 2 and 2 / 2", picked.htmlPages === 2 && picked.htmlNumbers && picked.htmlNoThree && picked.htmlHasTwo, JSON.stringify(picked));
  check("...and its name says which pages", /\(pages 2, 4\)\.html$/.test(picked.htmlName), picked.htmlName);
  if (picked.pdfPages !== undefined) {
    check("the PDF holds just those two pages", picked.pdfPages === 2 && /\(pages 2, 4\)\.pdf$/.test(picked.pdfName), JSON.stringify(picked));
    check("...numbered within the export", /1 \/ 2/.test(picked.pdfWords[0]) && /2 \/ 2/.test(picked.pdfWords[1]), JSON.stringify(picked.pdfWords));
  }
  await shot("panel-picked.png");

  // ── 4. Drag page 3 to the top ──────────────────────────────────────────
  await scrollPanelTo(1);
  await page.evaluate(`async () => { document.querySelector('#canvasPagesPanel .cpp-list').scrollTop = 0; await window.__recall.settle(150); }`);
  const from = await centre(3);
  const top = await page.evaluate(`() => { const r = document.querySelector('#canvasPagesPanel .cpp-item[data-page="1"] .cpp-thumb').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6) }; }`);
  await mouse("mousePressed", from);
  for (let k = 1; k <= 8; k += 1) {
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: Math.round(from.y + ((top.y - from.y) * k) / 8), button: "left", buttons: 1 });
  }
  const line = await page.evaluate(`() => !document.querySelector('#canvasPagesPanel .cpp-drop-line').hidden`);
  await mouse("mouseReleased", top);
  const moved = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    for (let i = 0; i < 60 && api.notebookPagesBusy(); i += 1) await settle(100);
    await settle(800);
    const block = (id) => api.documentBlocks().find((b) => b.id === id)?.page;
    return {
      three: block(window.__ids.three),
      two: block(window.__ids.two),
      notes: api.state.notes,
      selection: [...document.querySelectorAll("#canvasPagesPanel .cpp-item.is-picked")].map((n) => n.dataset.page),
      items: document.querySelectorAll("#canvasPagesPanel .cpp-item").length
    };
  }`);
  check("the drop line shows while a page is dragged", line === true, String(line));
  check("page 3 dragged to the top takes its Block to page 1", moved.three === 1 && moved.two === 3, JSON.stringify(moved));
  check("...and the note's picture of it follows to page 1", /pdfref:1:/.test(moved.notes), moved.notes);
  check("...not picked by the drag, and the pages that were picked (2, 4) still are, where they went", JSON.stringify(moved.selection) === '["3","4"]', JSON.stringify(moved));

  // ── 5. Duplicate and Delete the pages picked ──────────────────────────
  await page.evaluate(`async () => { [...document.querySelectorAll("#canvasPagesPanel .cpp-bar .cpp-btn")].find((b) => b.textContent.trim() === "Clear")?.click(); await window.__recall.settle(150); }`);
  await scrollPanelTo(1);
  await clickAt(await centre(1), 2 /* Ctrl */);
  const dupDel = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const wait = async () => { await settle(200); for (let i = 0; i < 80 && api.notebookPagesBusy(); i += 1) await settle(100); await settle(800); };
    const press = (label) => [...document.querySelectorAll("#canvasPagesPanel .cpp-bar .cpp-btn")].find((b) => b.textContent.trim() === label)?.click();
    press("Duplicate");
    await wait();
    const afterDup = { pages: api.notebookPageCount(), onTwo: api.documentBlocks().filter((b) => b.page === 2).map((b) => b.md), picked: [...document.querySelectorAll("#canvasPagesPanel .cpp-item.is-picked")].map((n) => n.dataset.page), items: document.querySelectorAll("#canvasPagesPanel .cpp-item").length };
    press("Delete");
    await settle(300);
    const confirm = [...document.querySelectorAll("button")].find((b) => b.offsetParent && /^Delete page/.test(b.textContent.trim()));
    confirm?.click();
    await wait();
    return { afterDup, confirmed: Boolean(confirm), pages: api.notebookPageCount(), items: document.querySelectorAll("#canvasPagesPanel .cpp-item").length };
  }`);
  check("Duplicate copies the picked page straight after it, and picks the copy", dupDel.afterDup.pages === 5 && dupDel.afterDup.onTwo.includes("On page three") && JSON.stringify(dupDel.afterDup.picked) === '["2"]' && dupDel.afterDup.items === 5, JSON.stringify(dupDel));
  check("Delete asks, then deletes the picked page", dupDel.confirmed && dupDel.pages === 4 && dupDel.items === 4, JSON.stringify(dupDel));

  // ── 6. Closed again ────────────────────────────────────────────────────
  const closed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    document.querySelector("#canvasPagesPanel .cpp-close").click();
    await settle(300);
    return { hidden: document.getElementById("canvasPagesPanel").hidden, stored: localStorage.getItem("recall:canvas-pages-panel-v1"), selection: api.canvasExportSelection() };
  }`);
  check("× closes it, and ⇓ exports every page again", closed.hidden && closed.stored === "closed" && closed.selection === null, JSON.stringify(closed));

  if (SHOTS) {
    await page.evaluate(`async () => { document.getElementById("canvasPagesBtn").click(); await window.__recall.settle(800); }`);
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(`async () => { await window.__recall.settle(1200); }`);
    await shot("panel-phone.png");
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

console.log(`\ncanvas-pages-panel-browser-check: ${ran - failures}/${ran} passed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
