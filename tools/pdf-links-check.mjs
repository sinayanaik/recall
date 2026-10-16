// Do the links inside a PDF work, can a reader make the contents their own,
// and does the PDF keep the reader's place?
//
//   node tools/pdf-links-check.mjs
//
//   0. the pages are fitted to the scroller as it is once they are in it, so a
//      scrollbar arriving does not leave the reading position unsaveable;
// Driven through the browser's own input pipeline (CDP mouse events), not
// dispatchEvent inside the page, because both features are about which layer a
// real press reaches: a link's words sit under the text layer, the pen, the
// highlight menu and the region tool, and a click synthesised on a chosen
// element would be testing the one path no reader takes.
//
//   1. a press on a link to another page in the PDF lands there — at the
//      height the link names, not the top of the page — and leaves a way back;
//   2. a press on a web link opens it, and one on a javascript: link does not;
//   3. a drag that selects a link's words is a selection, not a jump;
//   4. right-click on a page or a row of the contents is the browser's own
//      menu; 🔖 in the drawer bookmarks the place on screen, titled from the
//      first line there, nested in its section and VISIBLE in the drawer (it
//      used to land inside a branch the edit had just folded);
//   5. dragging a row onto the middle of another nests it there, with what is
//      under it, and the arrangement survives the file being re-read from disk;
//   6. a bookmark row jumps to its own place, and Reset brings back the PDF's
//      own contents;
//   7. going Home with the PDF open (which hides the reader with display:none
//      rather than closing it) records neither the last page as the reading
//      position nor the end of the PDF as the progress — and the reader is on
//      the same page when they come back.
//
// Shares its harness with tools/pdf-preview-check.mjs (the same local pdf.js,
// the same offline sign-in), cut down to what these cases need.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { FONT_SIZE, buildFixturePdf, fixtureLineOrigin, fixturePageLines } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 4 * 60 * 1000;

const chrome = findChrome();
if (!chrome) { console.log("pdf-links-check: no Chrome on this machine — skipping."); process.exit(0); }

let sources;
try {
  sources = pdfjsSources();
} catch (error) {
  console.log(`pdf-links-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}

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
    const deadline = setTimeout(() => reject(new Error("static server did not start")), 10000);
    proc.stdout.on("data", () => clearTimeout(deadline));
    proc.on("error", (error) => { clearTimeout(deadline); reject(error); });
  });
}

const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-links.js?v=__BUILD__",
    "/src/documents/pdf-outline.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/ui/home-state.js?v=__BUILD__",
    "/src/stats/reading-progress.js?v=__BUILD__",
    "/src/stats/reading-stats-store.js?v=__BUILD__",
    "/src/notes/reading-position.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("pdf-links-check does not touch the network"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/images/" + p } })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  // Every web link the app opens, kept instead of opened.
  window.__opened = [];
  window.open = (url) => { window.__opened.push(String(url)); return null; };
  return true;
}`;

const fixture = buildFixturePdf({ pages: 4, links: true });
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

const failures = [];
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (ok) console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
  else {
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
    failures.push(label);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mouse(type, x, y, { button = "left", buttons = 0, clickCount = 1 } = {}) {
  // A move with no button held has to say "none": CDP reads `button` on a move
  // as the one being held, and a hover would arrive as a drag.
  const held = type === "mouseMoved" && !buttons ? "none" : button;
  await page.call("Input.dispatchMouseEvent", { type, x, y, button: held, buttons, clickCount, pointerType: "mouse" });
}

async function click(x, y, button = "left") {
  const pressed = button === "right" ? 2 : 1;
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, { button, buttons: pressed });
  await mouse("mouseReleased", x, y, { button, buttons: 0 });
}

async function dragMouse(from, to, steps = 12) {
  await mouse("mouseMoved", from.x, from.y);
  await mouse("mousePressed", from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", to.x, to.y, { buttons: 0 });
}

// Where a fixture line is on screen: scrolled into view, then measured through
// the page's live viewport — the same conversion the app makes the other way.
async function linePoint(pageNumber, line, dx = 60) {
  const { x0, baseline } = fixtureLineOrigin(line);
  return page.evaluate(`async (pageNumber, x, y) => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(pageNumber, Math.max(0, (792 - y) / 792 - 0.15), { smooth: false });
    await api.whenDocumentPageReady(pageNumber);
    await settle(250);
    const viewport = api.pdfPageViewport(pageNumber);
    const box = api.pdfPageElement(pageNumber).getBoundingClientRect();
    const [vx, vy] = viewport.convertToViewportPoint(x, y);
    return { x: Math.round(box.left + vx * (box.width / viewport.width)), y: Math.round(box.top + vy * (box.height / viewport.height)) };
  }`, pageNumber, x0 + dx, baseline + FONT_SIZE * 0.35);
}

async function where() {
  return page.evaluate(`() => {
    const { api } = window.__recall;
    return { page: api.currentDocumentPage(), ratio: api.currentDocumentRatio() };
  }`);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
  });
  await servePdfjsFromDisk(client, page, sources);
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const opened = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], "linked.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const index = api.readLocalDeckIndex();
    const entry = index.find((m) => m.title && m.title !== "Untitled file") || index[0];
    if (!entry) return { error: "no file was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(300);
    // Loading leaves My Files over the page, and every press below is aimed at
    // what is on screen.
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView({ force: true });
    await api.whenDocumentPageReady(1);
    // The page-painted hook fetches a page's links; wait for page 1's.
    const links = await api.documentPageLinks(1);
    await settle(200);
    return { id: entry.id, links: links.map((link) => link.url || (link.dest ? "dest" : link.action)) };
  }`, Array.from(fixture.bytes));
  if (opened.error) throw new Error(opened.error);

  // ── 0. The pages fit the scroller they are in ───────────────────────────
  //
  // Fit width is measured on the empty scroller, and the pages that go in a
  // moment later bring a scrollbar with them on any screen whose scrollbars
  // take room (this Chrome's do: 15px). A scroller left narrower than the
  // width the pages were fitted to reads as a resize still waiting for its
  // refit, and every save of the reading position is turned away while one is.
  const fitted = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    await settle(500);
    const view = document.getElementById("documentView");
    return { width: view.clientWidth, fitted: api.documentFittedWidth(), scrollbar: view.offsetWidth - view.clientWidth };
  }`);
  check("the pages are fitted to the scroller with its scrollbar in it", fitted.width === fitted.fitted, JSON.stringify(fitted));

  // ── 1. A link to another place in the PDF ────────────────────────────────
  check("the page's link annotations are read, and the javascript: one is dropped",
    opened.links.join(",") === `dest,${fixture.links.external.url}`, opened.links.join(", "));

  const internal = await linePoint(1, fixture.links.internal.line);
  await mouse("mouseMoved", internal.x, internal.y);
  await sleep(120);
  const hover = await page.evaluate(`() => ({
    over: document.getElementById("documentView").classList.contains("is-over-pdf-link"),
    cursor: getComputedStyle(document.elementFromPoint(${internal.x}, ${internal.y})).cursor
  })`);
  check("a mouse over a link says so", hover.over && hover.cursor === "pointer", JSON.stringify(hover));

  await click(internal.x, internal.y);
  await sleep(900);
  const landed = await where();
  // The link names the middle of page 3 (y = 396 of 792), and the scroll puts
  // that at the top of the screen.
  check("pressing a link to page 3 lands on page 3", landed.page === fixture.links.internal.toPage, JSON.stringify(landed));
  check("...at the height the link names, not the top of the page",
    Math.abs(landed.ratio - 0.5) < 0.04, `ratio ${landed.ratio.toFixed(3)}`);
  const back = await page.evaluate(`() => {
    const button = document.getElementById("documentLinkBackBtn");
    return { shown: !button.hidden, text: button.textContent };
  }`);
  check("...and offers the way back", back.shown && /p\. 1/.test(back.text), JSON.stringify(back));
  await page.evaluate(`() => document.getElementById("documentLinkBackBtn").click()`);
  await sleep(900);
  const returned = await where();
  check("...which returns to page 1", returned.page === 1, JSON.stringify(returned));

  // ── 2. Web links ─────────────────────────────────────────────────────────
  const external = await linePoint(1, fixture.links.external.line);
  await click(external.x, external.y);
  await sleep(300);
  const unsafe = await linePoint(1, fixture.links.unsafe.line);
  await click(unsafe.x, unsafe.y);
  await sleep(300);
  const openedUrls = await page.evaluate(`() => window.__opened.slice()`);
  check("pressing a web link opens it", openedUrls[0] === fixture.links.external.url, JSON.stringify(openedUrls));
  check("...and a javascript: link opens nothing", openedUrls.length === 1, JSON.stringify(openedUrls));

  // ── 3. Selecting a link's words is not a press on it ────────────────────
  const selectFrom = await linePoint(1, fixture.links.internal.line, 2);
  const selectTo = await linePoint(1, fixture.links.internal.line, 150);
  const beforeSelect = await where();
  await dragMouse(selectFrom, selectTo);
  await sleep(700);
  const afterSelect = await where();
  const selected = await page.evaluate(`() => String(window.getSelection()).trim()`);
  check("a drag across a link's words selects them and does not follow the link",
    selected.length > 3 && afterSelect.page === beforeSelect.page, `"${selected}" · page ${beforeSelect.page} → ${afterSelect.page}`);
  await page.evaluate(`() => window.getSelection().removeAllRanges()`);

  // ── 4. A bookmark from the contents drawer ──────────────────────────────
  const bookmarkLine = 3;
  const bookmarkAt = await linePoint(2, bookmarkLine);
  await click(bookmarkAt.x, bookmarkAt.y, "right");
  await sleep(200);
  const pageMenu = await page.evaluate(`() => document.querySelectorAll(".pdf-context-menu").length`);
  check("right-click on a page opens no menu of the app's own", pageMenu === 0, `${pageMenu} menu(s)`);
  await page.evaluate(`() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

  // The top of the screen just above line 3 of page 2, so the place on screen
  // starts at that line — the bookmark is named after it.
  const { baseline: bookmarkBaseline } = fixtureLineOrigin(bookmarkLine);
  const prompt = await page.evaluate(`async (ratio) => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(2, ratio, { smooth: false });
    await settle(400);
    if (!document.getElementById("documentOutlineDrawer").classList.contains("is-open")) {
      document.getElementById("documentTocBtn").click();
      await settle(400);
    }
    document.getElementById("documentTocBookmarkBtn").click();
    await settle(200);
    return {
      shown: document.getElementById("promptModal")?.hidden === false,
      value: document.getElementById("promptModalInput")?.value || ""
    };
  }`, (792 - (bookmarkBaseline + FONT_SIZE * 1.2)) / 792);
  const expectedTitle = fixturePageLines(2, fixture.linesPerPage)[bookmarkLine];
  check("🔖 bookmarks the place on screen, titled from its first line", prompt.shown && prompt.value === expectedTitle, `"${prompt.value}" vs "${expectedTitle}"`);
  await page.evaluate(`() => document.getElementById("promptModalOkBtn").click()`);
  await sleep(700);
  const afterBookmark = await page.evaluate(`() => {
    const { api } = window.__recall;
    const saved = api.state.meta?.pdfUserToc?.primary || null;
    const rows = Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-item")).map((li) => ({
      text: li.querySelector(".notes-toc-text")?.textContent || "",
      depth: Number(li.style.getPropertyValue("--toc-depth")),
      bookmark: li.dataset.tocBookmark === "true",
      visible: li.offsetParent !== null && li.getBoundingClientRect().height > 0
    }));
    return {
      saved: saved ? saved.entries.map((e) => e.t + "@" + e.d + (e.b ? "*" : "")) : null,
      rows,
      drawerOpen: document.getElementById("documentOutlineDrawer").classList.contains("is-open")
    };
  }`);
  check("...which is saved as the file's own contents, nested in its section",
    afterBookmark.saved?.join("|") === `Section 1@0|Section 2@0|${expectedTitle}@1*|Section 3@0|Section 4@0`,
    JSON.stringify(afterBookmark.saved));
  check("...and shown in the drawer as a bookmark, unfolded so it can be seen",
    afterBookmark.drawerOpen && afterBookmark.rows.some((row) => row.bookmark && row.text === expectedTitle && row.depth === 1 && row.visible),
    JSON.stringify(afterBookmark.rows));

  // A second bookmark, in another section: the first one's branch stays open.
  const second = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(4, 0.3, { smooth: false });
    await settle(400);
    document.getElementById("documentTocBookmarkBtn").click();
    await settle(200);
    document.getElementById("promptModalOkBtn").click();
    await settle(700);
    return Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-item"))
      .filter((li) => li.dataset.tocBookmark === "true")
      .map((li) => ({ text: li.querySelector(".notes-toc-text")?.textContent || "", visible: li.offsetParent !== null && li.getBoundingClientRect().height > 0 }));
  }`);
  check("a second bookmark is visible too, and the first stays unfolded",
    second.length === 2 && second.every((row) => row.visible), JSON.stringify(second));
  // Back to one bookmark, for the cases below.
  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const index = api.documentOutlineEntries().findIndex((e) => e.bookmark && e.page === 4);
    if (index >= 0) await api.deleteDocumentOutlineEntry(index);
    await settle(300);
  }`);

  // A row of the contents: no menu of the app's own on right-click; F2 renames.
  const rowAt = await page.evaluate(`() => {
    const link = Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-link"))
      .find((item) => item.querySelector(".notes-toc-text")?.textContent === "Section 1");
    const box = link?.getBoundingClientRect();
    return box ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } : null;
  }`);
  if (rowAt) {
    await click(rowAt.x, rowAt.y, "right");
    await sleep(200);
  }
  const rowMenu = await page.evaluate(`() => document.querySelectorAll(".pdf-context-menu").length`);
  check("right-click on a row of the contents opens no menu of the app's own", Boolean(rowAt) && rowMenu === 0, `${rowMenu} menu(s)`);
  const renamePrompt = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const link = Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-link"))
      .find((item) => item.querySelector(".notes-toc-text")?.textContent === "Section 1");
    link.focus();
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));
    await settle(200);
    const shown = document.getElementById("promptModal")?.hidden === false;
    const value = document.getElementById("promptModalInput")?.value || "";
    document.getElementById("promptModalCancelBtn")?.click();
    await settle(200);
    return { shown, value };
  }`);
  check("...and F2 on a row renames it", renamePrompt.shown && renamePrompt.value === "Section 1", JSON.stringify(renamePrompt));

  // ── 5. Dragging a row into another ──────────────────────────────────────
  const rowBox = async (title) => page.evaluate(`(title) => {
    const li = Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-item"))
      .find((item) => item.querySelector(".notes-toc-text")?.textContent === title);
    const box = li?.querySelector(".notes-toc-link").getBoundingClientRect();
    return box ? { x: Math.round(box.left + box.width * 0.6), y: Math.round(box.top + box.height / 2), top: box.top, bottom: box.bottom } : null;
  }`, title);
  const dragged = await rowBox("Section 2");
  const into = await rowBox("Section 4");
  check("the drawer's rows can be found to drag", Boolean(dragged && into));
  if (dragged && into) {
    await dragMouse(dragged, into, 16);
    await sleep(700);
  }
  const afterDrag = await page.evaluate(`() => {
    const { api } = window.__recall;
    return {
      saved: (api.state.meta?.pdfUserToc?.primary?.entries || []).map((e) => e.t + "@" + e.d),
      page: api.currentDocumentPage(),
      leftovers: document.querySelectorAll(".document-toc-ghost, .document-toc-drop").length
    };
  }`);
  check("dropping a row on the middle of another nests it there, with its bookmark",
    afterDrag.saved.join("|") === `Section 1@0|Section 3@0|Section 4@0|Section 2@1|${expectedTitle}@2`,
    afterDrag.saved.join(" | "));
  check("...the drop is not also a press on the row, and leaves nothing behind",
    afterDrag.leftovers === 0, `${afterDrag.leftovers} drag element(s) left`);

  // Re-read off disk: the deck dropped, the document torn down, the file loaded again.
  const reloaded = await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    await settle(900);
    for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
    await settle(300);
    api.tearDownDocumentView();
    api.state.meta = {};
    await settle(100);
    await api.loadDeckFromLibrary(id);
    await settle(300);
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView({ force: true });
    await api.whenDocumentPageReady(1);
    await settle(400);
    return api.documentOutlineEntries().map((e) => e.title + "@" + e.depth);
  }`, opened.id);
  check("...and the arrangement is still there when the file is read back from disk",
    reloaded.join("|") === `Section 1@0|Section 3@0|Section 4@0|Section 2@1|${expectedTitle}@2`, reloaded.join(" | "));

  // ── 6. A bookmark row goes to its own place; Reset brings the PDF's back ─
  const jump = await page.evaluate(`async (title) => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(4, 0, { smooth: false });
    await settle(300);
    if (!document.getElementById("documentOutlineDrawer").classList.contains("is-open")) {
      document.getElementById("documentTocBtn").click();
      await settle(400);
    }
    const link = Array.from(document.querySelectorAll("#documentOutlineList .notes-toc-link"))
      .find((item) => item.querySelector(".notes-toc-text")?.textContent === title);
    link?.click();
    await settle(900);
    return { page: api.currentDocumentPage(), ratio: api.currentDocumentRatio() };
  }`, expectedTitle);
  // The bookmark was made with the top of the screen just above line 3 of page 2.
  check("a bookmark row goes to its page, partway down it", jump.page === 2 && jump.ratio > 0.05 && jump.ratio < 0.3,
    `page ${jump.page} · ratio ${jump.ratio.toFixed(3)}`);

  const reset = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    if (!document.getElementById("documentOutlineDrawer").classList.contains("is-open")) {
      document.getElementById("documentTocBtn").click();
      await settle(400);
    }
    const button = document.getElementById("documentTocResetBtn");
    const shown = !button.hidden;
    button.click();
    await settle(150);
    document.getElementById("confirmModalOkBtn")?.click();
    await settle(600);
    return {
      shown,
      rows: api.documentOutlineEntries().map((e) => e.title + "@" + e.depth),
      saved: api.state.meta?.pdfUserToc?.primary || null,
      hiddenAfter: button.hidden
    };
  }`);
  check("Reset contents is offered once the contents have been changed", reset.shown);
  check("...and brings back the PDF's own contents",
    reset.rows.join("|") === "Section 1@0|Section 2@0|Section 3@0|Section 4@0" && reset.saved?.reset === 1 && reset.hiddenAfter,
    `${reset.rows.join(" | ")} · ${JSON.stringify(reset.saved)}`);

  // ── 7. Home over an open PDF is not the end of the PDF ──────────────────
  //
  // Home hides the reader with display:none and leaves it open, and every
  // offset inside a display:none subtree reads 0 — which the page lookup used
  // to answer with the LAST page. The heartbeat then filed that as the
  // progress, and the sync that going Home starts saved it as the place to
  // resume.
  const home = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const fileKey = api.statsFileKey({ deckId: api.state.deckId || null, localDeckId: api.state.localDeckId || null });
    const pct = () => api.readReadingStats().files[fileKey]?.parts?.["doc:primary"]?.pct ?? null;
    api.scrollToDocumentPage(2, 0.5, { smooth: false });
    await settle(500);
    api.tickReadingProgress(0);
    api.flushReadingProgress();
    api.flushReadingPositionSave();
    const before = { page: api.currentDocumentPage(), pct: pct(), saved: api.state.meta?.readingPosition?.pdfPage ?? null };
    api.showHome({ explicit: true });
    await settle(200);
    // What the reader's absence used to write down: a heartbeat, and the
    // position save the in-place reload after a sync makes.
    api.tickReadingProgress(0);
    api.flushReadingProgress();
    api.scheduleDocumentPositionSave();
    api.flushReadingPositionSave();
    const hidden = {
      layoutGone: document.getElementById("documentView").getClientRects().length === 0,
      page: api.currentDocumentPage(),
      ratio: api.currentDocumentRatio(),
      pct: pct(),
      saved: api.state.meta?.readingPosition?.pdfPage ?? null,
      stored: api.readStoredReadingPosition(api.documentPositionKey("doc"))?.pdfPage ?? null
    };
    api.hideHome();
    await settle(400);
    return { before, hidden, after: { page: api.currentDocumentPage(), ratio: api.currentDocumentRatio() }, pages: api.currentPdfPageCount() };
  }`);
  check("scrolling saves the reading position", home.before.saved === 2, JSON.stringify(home.before));
  check("going Home hides the reader without closing it (the case under test)", home.hidden.layoutGone, JSON.stringify(home.hidden));
  check("...the page is still the reader's while Home is up",
    home.hidden.page === 2 && Math.abs(home.hidden.ratio - 0.5) < 0.05, `page ${home.hidden.page} · ratio ${home.hidden.ratio}`);
  check("...the progress is not recorded as the end of the PDF",
    home.before.pct != null && Math.abs(home.hidden.pct - home.before.pct) < 0.01 && home.hidden.pct < 0.6,
    `${home.before.pct} → ${home.hidden.pct} of ${home.pages} pages`);
  check("...the place to resume is not the last page",
    home.hidden.saved === 2 && home.hidden.stored === 2, `meta ${home.hidden.saved} · stored ${home.hidden.stored}`);
  check("...and coming back finds the reader where they were",
    home.after.page === 2 && Math.abs(home.after.ratio - 0.5) < 0.05, JSON.stringify(home.after));
} catch (error) {
  console.log(`  FAIL  the check itself: ${error?.stack || error}`);
  failures.push("the check itself");
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\n  ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
