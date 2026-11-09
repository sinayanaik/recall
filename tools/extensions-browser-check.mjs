// Recall Web Clipper, driven in a real Chromium with the extension loaded unpacked:
//
//   Clean this page — Auto (Balanced) marks the clutter on a fixture page and
//   none of the article; marked blocks are blurred under a red box; Manual
//   marks the clicked block; Apply removes, Undo puts back exactly.
//
//   Save as PDF — smart pages (the default) cut a long page before its
//   headings into pages no taller than one A4 page, each trimmed to its own
//   content, never through the table, the code or the figure; the on-page
//   break editor removes a cut and adds one, and Save PDF there prints what
//   it shows. A continuous job with left/right margins and High images prints
//   ONE page of the right width, carries Recall's metadata (read back with
//   pdf.js, as the app reads it), and Recall imports it. A paged A4 job prints
//   several A4 pages. Every job leaves the page as it was.
//
//   Videos and embeds — a playing video, an embed and a WebGL canvas print as
//   pictures of what they showed, each linked to the real thing; a YouTube
//   embed that cannot load is a link box to its watch page, never Chrome's
//   error page; a moving GIF links to its original.
//
//   Never stuck — the editor's Save PDF stays in view and clickable on a page
//   that tries to hide it; the popup's Save PDF now and Cancel work; Esc
//   leaves no listener behind; a page frozen mid-job ends the job on its own
//   and frees the tab; a failed download says so and Save again saves it.
//
//   node tools/extensions-browser-check.mjs

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, findChrome, launchChrome, openPage } from "./cdp.mjs";
import { pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "recall-clipper");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = findChrome();
if (!chromePath) {
  console.log("FAIL no Chrome found (set CHROME_PATH)");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

// A static server for the fixture page (the extensions refuse file:// URLs).
const server = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), ROOT, "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
const FIXTURE = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/clutter.html`;
const LONG = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/long.html`;

const downloads = mkdtempSync(path.join(tmpdir(), "recall-ext-dl-"));
// A profile whose download folder is a temporary one, so the PDFs land
// somewhere this check owns, under the names the extension gave them.
const profile = mkdtempSync(path.join(tmpdir(), "recall-ext-profile-"));
mkdirSync(path.join(profile, "Default"), { recursive: true });
writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: downloads }
}));
const chrome = await launchChrome(chromePath, [
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`
], { windowSize: "1280,900", profile });
const client = await connect(chrome.wsUrl);

async function finish(code) {
  try { client.close(); } catch { /* gone */ }
  await chrome.close();
  server.kill();
  if (process.env.KEEP_PDFS) console.log(`PDFs kept in ${downloads}`);
  else rmSync(downloads, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length} checks · ${failed} failed`);
  console.log(`CHECK: ${results.length} checks · ${failed} failed`);
  process.exit(code ?? (failed ? 1 : 0));
}

try {
  // Not Browser.setDownloadBehavior: under it Chrome names every download
  // "download.pdf", ignoring the extension's file name — the very thing to check.
  // The profile's own download directory is pointed at a temporary one instead.

  // The service worker comes up; its URL names the extension's ID. Chrome's
  // own component extensions run workers called background.js too, so each is
  // asked its name.
  let worker = null;
  const tried = new Set();
  for (let i = 0; i < 50 && !worker; i += 1) {
    const { targetInfos } = await client.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && !tried.has(t.targetId))) {
      let name = null;
      try {
        const { sessionId } = await client.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const r = await client.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, sessionId);
        await client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        name = r.result && typeof r.result.value === "string" ? r.result.value : null;
      } catch { /* still starting: asked again next time round */ }
      if (name) tried.add(t.targetId);
      if (name === "Recall Web Clipper") { worker = t; break; }
    }
    if (!worker) await sleep(100);
  }
  check("the extension's service worker starts", Boolean(worker));
  const EXT_ID = worker ? new URL(worker.url).host : "";

  // ------------------------------------------------------------ Page Cleaner

  const page = await openPage(client);
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(FIXTURE);
  const core = readFileSync(path.join(EXT, "content/cleaner-core.js"), "utf8");
  const ui = readFileSync(path.join(EXT, "content/cleaner-ui.js"), "utf8");
  const css = readFileSync(path.join(EXT, "content/cleaner.css"), "utf8");
  // Injected into the page world here — the toolbar click that grants
  // activeTab cannot be made from a script. chrome.storage is then absent,
  // which the cleaner tolerates (it is only a nicety).
  await page.evaluate((src, style) => {
    const s = document.createElement("style");
    s.textContent = style;
    document.head.append(s);
    (0, eval)(src);
  }, core, css);
  const main = await page.evaluate(() => __recallCleanerCore.findMainContent().id);
  check("finds the article as the main content", main === "article", main);

  const before = await page.evaluate(() => document.body.innerHTML.length);
  await page.evaluate((src) => (0, eval)(src), ui);
  await page.waitFor(() => window.__recallCleaner && window.__recallCleaner.active && window.__recallCleaner.state().marked.length > 0, { label: "auto marks" });
  const auto = await page.evaluate(() => window.__recallCleaner.state().marked.map((m) => ({ id: m.el.id, reason: m.reason })));
  const autoIds = new Set(auto.map((m) => m.id));
  const mustMark = ["cookieBanner", "popup", "backdrop", "adInArticle", "adSidebar", "siteHeader", "shareBar", "related", "comments", "newsletterBox"];
  const missed = mustMark.filter((id) => !autoIds.has(id));
  check("Auto (Balanced) marks every piece of clutter", missed.length === 0, missed.length ? `missed ${missed.join(", ")}` : `${auto.length} marked`);
  const keepIds = ["article", "headline", "p1", "p2", "p3", "p4", "figure", "table", "code"];
  const wrongly = keepIds.filter((id) => autoIds.has(id));
  check("Auto (Balanced) leaves the article alone", wrongly.length === 0, wrongly.join(", "));

  const look = await page.evaluate(() => {
    const el = document.getElementById("cookieBanner");
    const host = document.querySelector("recall-page-cleaner");
    const boxes = host ? host.shadowRoot.querySelectorAll(".box") : [];
    const box = boxes[0];
    return {
      filter: getComputedStyle(el).filter,
      boxes: boxes.length,
      border: box ? getComputedStyle(box).borderTopColor : "",
      bg: box ? getComputedStyle(box).backgroundColor : ""
    };
  });
  check("a marked block is blurred", /blur\(3px\)/.test(look.filter), look.filter);
  check("a marked block is covered in red", look.boxes > 0 && /229, 57, 53/.test(look.border) && /229, 57, 53/.test(look.bg), `${look.border} / ${look.bg}`);

  // Manual mode: a trusted click on the second paragraph marks it.
  await page.evaluate(() => { window.__recallCleaner.setMode("manual"); });
  const p2 = await page.evaluate(() => { const r = document.getElementById("p2").getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; });
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: p2.x, y: p2.y });
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: p2.x, y: p2.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: p2.x, y: p2.y, button: "left", clickCount: 1 });
  const manual = await page.evaluate(() => ({
    marked: window.__recallCleaner.state().marked.some((m) => m.el.id === "p2"),
    blurred: document.getElementById("p2").classList.contains("rpc-marked")
  }));
  check("Manual: clicking a block marks it blurred and red", manual.marked && manual.blurred);

  const applied = await page.evaluate(async () => {
    const n = await window.__recallCleaner.applyMarks();
    return { n, cookie: Boolean(document.getElementById("cookieBanner")), p2: Boolean(document.getElementById("p2")), p1: Boolean(document.getElementById("p1")), overflow: getComputedStyle(document.body).overflow };
  });
  check("Apply removes the marked blocks and keeps the rest", applied.n > 5 && !applied.cookie && !applied.p2 && applied.p1, `${applied.n} removed`);
  check("Apply unlocks a modal's scroll lock", applied.overflow !== "hidden", applied.overflow);
  const undone = await page.evaluate(() => {
    window.__recallCleaner.undo();
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const p2 = document.getElementById("p2");
    return { ids, order: p2 && p2.previousElementSibling && p2.previousElementSibling.id, body: getComputedStyle(document.body).overflow };
  });
  check("Undo puts every block back where it was", ["cookieBanner", "p2", "related", "siteHeader"].every((id) => undone.ids.includes(id)) && undone.order === "adInArticle", undone.order);
  check("Undo restores the scroll lock too", undone.body === "hidden", undone.body);
  const keepOnly = await page.evaluate(() => {
    window.__recallCleaner.keepOnly(document.getElementById("table"));
    return window.__recallCleaner.state().marked.map((m) => m.el.id);
  });
  check("K (keep only this) marks everything outside the block", keepOnly.includes("p1") && keepOnly.includes("sidebar") && !keepOnly.includes("table"));
  await page.evaluate(() => { window.__recallCleaner.restorePage(); window.__recallCleaner.close(); });
  const after = await page.evaluate(() => ({ len: document.body.innerHTML.replace(/ class=""/g, "").length, ui: Boolean(document.querySelector("recall-page-cleaner")), marked: document.querySelectorAll(".rpc-marked").length }));
  check("Restore page + close leaves the page as it was", Math.abs(after.len - before) < 40 && !after.ui && after.marked === 0, `${before} → ${after.len}`);

  // ------------------------------------------------------------ the popup

  const { targetInfos } = await client.send("Target.getTargets");
  const tabTarget = targetInfos.find((t) => t.type === "page" && t.url === FIXTURE);
  const popup = await openPage(client);
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await popup.waitFor(() => document.body.dataset.ready === "true", { label: "popup ready" });
  const face = await popup.evaluate(() => ({
    actions: [...document.querySelectorAll("button.action b")].map((b) => b.textContent),
    options: window.__rwcOptions()
  }));
  check("the popup offers the three jobs", JSON.stringify(face.actions) === JSON.stringify(["Clean this page", "Copy as Markdown", "Save as PDF"]), JSON.stringify(face.actions));
  check("Save as PDF starts on smart pages about one A4 long, breaks shown first",
    face.options.layout === "smart" && face.options.pageLength === "a4" && face.options.adjustBreaks === true, JSON.stringify([face.options.layout, face.options.pageLength, face.options.adjustBreaks]));
  // A tab's chrome.tabs id, read from an extension page: chrome.tabs hides
  // URLs without the "tabs" permission; the debugger's target list (which this
  // extension holds) has both.
  const tabIdOf = (url) => popup.evaluate(async (url) => {
    const targets = await chrome.debugger.getTargets();
    const hit = targets.find((t) => t.type === "page" && t.url === url && t.tabId != null);
    return hit ? hit.tabId : null;
  }, url);
  const tabId = await tabIdOf(FIXTURE);
  check("the popup sees the page's tab", tabId != null && tabTarget != null);

  // A page of its own to read the PDFs with pdf.js — the reader the app uses.
  const pdfjs = pdfjsSources();
  const reader = await openPage(client);
  await reader.goto(FIXTURE);
  await reader.evaluate((main, worker) => {
    (0, eval)(main);
    const blob = new Blob([worker], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  }, pdfjs.main, pdfjs.worker);
  async function readPdf(file) {
    const bytes = readFileSync(file);
    return reader.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      const meta = await doc.getMetadata();
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
      return { pages: doc.numPages, width: vp.width, height: vp.height, info: meta.info, text };
    }, bytes.toString("base64"));
  }

  // Each page's size and its first words, for the smart-pages checks.
  async function readPages(file) {
    const bytes = readFileSync(file);
    return reader.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      const out = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const items = (await page.getTextContent()).items.map((t) => t.str).filter((t) => t.trim());
        // pdf.js may hand a heading back in pieces ("S", "ection 2"): the
        // words are compared with the spaces taken out.
        const flat = items.join("").replace(/\s+/g, "");
        out.push({ width: vp.width, height: vp.height, first: items[0] || "", flat, text: items.join(" ") });
      }
      return out;
    }, bytes.toString("base64"));
  }

  // The bookmarks pdf.js reads, where "Section 12" leads, and whether the PDF is tagged.
  async function readOutline(file) {
    const bytes = readFileSync(file);
    return reader.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      const outline = (await doc.getOutline()) || [];
      const titles = [];
      let section12 = -1;
      const walk = async (items) => {
        for (const it of items) {
          titles.push(it.title);
          if (it.title === "Section 12" && Array.isArray(it.dest)) section12 = await doc.getPageIndex(it.dest[0]);
          await walk(it.items || []);
        }
      };
      await walk(outline);
      const tagged = Boolean((await doc.getMarkInfo())?.Marked);
      return { titles, section12, tagged };
    }, bytes.toString("base64"));
  }

  let lastJob = null;
  let lastUrl = "";
  // Started without waiting, so a check can work the page while the job runs.
  function startJob(tab, options) {
    return popup.evaluate((tabId, options) => {
      window.__job = chrome.runtime.sendMessage({ type: "rwc-start-pdf", tabId, options });
      return true;
    }, tab, options);
  }
  async function finishJob(label) {
    const res = await popup.evaluate(() => window.__job);
    if (!res || !res.ok) { check(`${label}: job finishes`, false, res && res.error); return null; }
    // Where Chrome put it, from the download record itself.
    let file = null;
    for (let i = 0; i < 100 && !file; i += 1) {
      const items = await popup.evaluate(async () => (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 }))
        .map((d) => ({ filename: d.filename, state: d.state, error: d.error || "", url: String(d.finalUrl || d.url).slice(0, 12) })));
      const hit = items.find((d) => d.state === "complete" && path.basename(d.filename).startsWith(res.name.replace(/\.pdf$/, "")));
      if (hit) { file = hit.filename; lastUrl = hit.url; }
      else if (items.some((d) => d.state === "interrupted")) { console.log(JSON.stringify(items)); break; }
      else await sleep(100);
    }
    check(`${label}: job finishes and downloads ${res.name}`, Boolean(file));
    lastJob = res;
    return file && existsSync(file) ? file : null;
  }
  async function job(options, label, tab = tabId) {
    await startJob(tab, options);
    return finishJob(label);
  }


  // The break editor's Save PDF: in view, uncovered, in the top layer — and
  // where to click it.
  const barCheck = (pg) => pg.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    if (!host) return null;
    const bar = host.shadowRoot.querySelector(".bar");
    const go = host.shadowRoot.querySelector(".go");
    const r = go.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = host.shadowRoot.elementFromPoint(x, y);
    let topLayer = false;
    try { topLayer = bar.matches(":popover-open"); } catch { /* no popovers */ }
    return {
      inView: r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      hit: Boolean(hit) && (hit === go || go.contains(hit)),
      topLayer, center: [Math.round(x), Math.round(y)], vw: innerWidth, vh: innerHeight
    };
  });
  const waitEditor = (pg) => pg.waitFor(() => [...document.querySelectorAll("[data-recall-pdf-ui]")].some((h) => h.shadowRoot && h.shadowRoot.querySelectorAll(".cut").length > 0), { label: "break editor", timeout: 20000 });
  const pageState = (pg) => pg.evaluate(() => ({
    len: document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length,
    ui: [...document.querySelectorAll("[data-recall-pdf-ui]")].filter((el) => el.tagName !== "RECALL-CLIPPER-TOAST").length,
    breaks: [...document.querySelectorAll("*")].filter((el) => el.style.breakBefore === "page").length
  }));
  async function waitStatus(tab, pred, label, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const s = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-get-status", tabId }), tab);
      if (pred(s)) return s;
      await sleep(150);
    }
    console.log(`(timed out: ${label})`);
    return null;
  }
  // An expression evaluated in the extension's service worker (its time
  // limits are shortened that way for the frozen-page check).
  async function sw(expression) {
    const { targetInfos } = await client.send("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "service_worker" && x.url.includes(EXT_ID));
    if (!t) return null;
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    try {
      const r = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      return r.result ? r.result.value : null;
    } finally {
      await client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ smart pages

  const long = await openPage(client);
  await long.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await long.goto(LONG);
  await long.waitFor(() => document.getElementById("section-12"), { label: "long fixture" });
  const longTab = await tabIdOf(LONG);
  const longPristine = await long.evaluate(() => document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length);
  const A4H = 841.89;
  const smart = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - smart" }, "smart pages", longTab);
  let smartPages = [];
  if (smart) {
    smartPages = await readPages(smart);
    const heights = smartPages.map((p) => Math.round(p.height));
    check("smart: a long page becomes several pages", smartPages.length >= 4, `${smartPages.length} pages`);
    check("saving: the PDF goes to downloads by blob: address", lastUrl.startsWith("blob:"), lastUrl);
    check("smart: every page A4 wide", smartPages.every((p) => Math.abs(p.width - 595.3) < 2));
    check("smart: no page taller than one A4 page", smartPages.every((p) => p.height <= A4H + 1), heights.join(", "));
    check("smart: each page trimmed to its content (not all the same height)", new Set(heights).size > 1, heights.join(", "));
    const starts = smartPages.slice(1).map((p) => p.flat.slice(0, 12));
    check("smart: every page after the first starts at a heading", starts.every((t) => /^Section\d/.test(t)), JSON.stringify(starts));
    const pageOf = (re) => smartPages.findIndex((p) => re.test(p.flat));
    check("smart: the table is not cut across pages", pageOf(/HarbourA/) >= 0 && pageOf(/HarbourA/) === pageOf(/HarbourH/));
    check("smart: the code block is not cut across pages", pageOf(/h\[0\]=/) >= 0 && pageOf(/h\[0\]=/) === pageOf(/h\[7\]=/));
    const found = new Set(smartPages.flatMap((p) => [...p.flat.matchAll(/Section(\d+)(?=[A-Za-z])/g)].map((m) => Number(m[1]))));
    const missing = Array.from({ length: 24 }, (_, i) => i + 1).filter((n) => !found.has(n));
    check("smart: nothing lost — every section is in the PDF", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");
    check("smart: every page trimmed where the PDF says its content ends", lastJob.markedPages >= smartPages.length - 1, `${lastJob.markedPages} of ${smartPages.length} pages`);
    const outline = await readOutline(smart);
    check("smart: bookmarks for the headings, without a tagged PDF", outline.titles.length >= 24 && outline.titles.includes("Section 12") && !outline.tagged,
      `${outline.titles.length} bookmarks${outline.tagged ? ", tagged" : ""}`);
    check("smart: a bookmark opens the page its heading is on", outline.section12 >= 0 && smartPages[outline.section12] && /Section12/.test(smartPages[outline.section12].flat), `page ${outline.section12 + 1}`);
  }
  const afterSmart = await long.evaluate(() => ({
    len: document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length,
    breaks: [...document.querySelectorAll("*")].filter((el) => el.style.breakBefore === "page").length
  }));
  check("smart: the page is put back afterwards", afterSmart.breaks === 0 && Math.abs(afterSmart.len - longPristine) < 80, `${longPristine} → ${afterSmart.len}, ${afterSmart.breaks} breaks left`);

  // The break editor: the cuts appear on the page as dashed lines over shaded
  // pages; one is removed with its ✕ (and the removal undone and redone),
  // one dragged with a real mouse to a new place, one added by clicking the
  // page, and Save PDF prints that.
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - edited" });
  const linesOf = () => long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    if (!host) return null;
    const root = host.shadowRoot;
    const cuts = [...root.querySelectorAll(".cut")].filter((c) => c.style.display !== "none");
    return {
      cuts: cuts.length,
      count: root.querySelector(".count").textContent,
      tops: cuts.map((c) => parseFloat(c.style.top)),
      bands: [...root.querySelectorAll(".band")].filter((b) => b.style.display !== "none").length
    };
  });
  const editorKey = (key, shift = false) => long.evaluate((key, shift) => {
    dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
  }, key, shift);
  await long.waitFor(() => [...document.querySelectorAll("[data-recall-pdf-ui]")].some((h) => h.shadowRoot && h.shadowRoot.querySelectorAll(".cut").length > 0), { label: "break editor", timeout: 20000 });
  const shown = await linesOf();
  check("editor: the planned cuts are shown on the page", shown && shown.cuts === Math.max(0, smartPages.length - 1), JSON.stringify(shown && shown.count));
  check("editor: every page is shown as a band", shown && shown.bands === shown.cuts + 1, `${shown && shown.bands} bands`);
  const barSeen = await barCheck(long);
  check("editor: Save PDF is in view and nothing covers it", barSeen && barSeen.inView && barSeen.hit, JSON.stringify(barSeen));
  check("editor: the bar is in the top layer", barSeen && barSeen.topLayer);
  await long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    host.shadowRoot.querySelectorAll(".cut")[1].querySelector(".x").click();
  });
  const removed = await linesOf();
  check("editor: ✕ removes that cut", removed && removed.cuts === shown.cuts - 1, JSON.stringify(removed && removed.count));
  await editorKey("z");
  const unremoved = await linesOf();
  await editorKey("z", true);
  const redone = await linesOf();
  check("editor: Ctrl+Z puts the cut back, Ctrl+Shift+Z removes it again", unremoved.cuts === shown.cuts && redone.cuts === removed.cuts, `${unremoved.cuts}, ${redone.cuts}`);

  // A real drag: press on the first cut, move down, let go.
  const grip = await long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    const cut = host.shadowRoot.querySelectorAll(".cut")[0];
    cut.scrollIntoView({ block: "center" });
    const r = cut.querySelector(".grip").getBoundingClientRect();
    return { x: r.left + 12, y: r.top + r.height / 2 };
  });
  const mouse = (type, y, buttons = 1) => long.call("Input.dispatchMouseEvent", { type, x: grip.x, y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  await mouse("mouseMoved", grip.y, 0);
  await mouse("mousePressed", grip.y);
  for (let dy = 20; dy <= 220; dy += 20) await mouse("mouseMoved", grip.y + dy);
  await mouse("mouseReleased", grip.y + 220, 0);
  const dragged = await linesOf();
  check("editor: dragging a cut moves it to another place", dragged.cuts === redone.cuts && Math.abs(dragged.tops[0] - redone.tops[0]) > 40, `${redone.tops[0]} → ${dragged.tops[0]}`);
  const removedCount = dragged;
  await long.evaluate(() => {
    const p = document.querySelector("#section-2 + p + p");
    p.scrollIntoView({ block: "center" });
    const r = p.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2 }));
  });
  const added = await linesOf();
  check("editor: clicking the page adds a cut", added && added.cuts === removedCount.cuts + 1, JSON.stringify(added && added.count));
  await long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    host.shadowRoot.querySelector(".go").click();
  });
  const edited = await finishJob("edited breaks");
  if (edited) {
    const pages = await readPages(edited);
    check("editor: the PDF has the pages the editor showed", pages.length === added.cuts + 1, `${pages.length} pages, ${added.cuts} cuts`);
    check("editor: the added cut starts a page at a paragraph", pages.slice(1).some((p) => !/^Section\d/.test(p.flat)), JSON.stringify(pages.map((p) => p.flat.slice(0, 12))));
  }
  const status = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-get-status", tabId }), longTab);
  check("the background reports the finished job", status && status.done === true, JSON.stringify(status));

  // ------------------------------------------------------------ never stuck

  // The Save PDF bar on a page that does its best to hide it: a transform on
  // <html> (position: fixed then follows the document), a bar of its own at
  // the top at the highest z-index, and a modal dialog (which makes the rest
  // of the page inert). The bar is still in view, uncovered, and a real mouse
  // click on it saves; the dialog is back afterwards.
  await long.evaluate(() => {
    document.documentElement.style.transform = "translateZ(0)";
    const cover = document.createElement("div");
    cover.id = "hostile-cover";
    cover.style.cssText = "position:fixed;left:0;right:0;top:0;height:140px;z-index:2147483647;background:rgba(200,0,0,.4)";
    document.body.append(cover);
    const dlg = document.createElement("dialog");
    dlg.id = "hostile-dialog";
    dlg.textContent = "Accept our cookies";
    document.body.append(dlg);
    dlg.showModal();
  });
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - hostile" });
  await waitEditor(long);
  const hostile = await barCheck(long);
  check("hostile page: Save PDF is in view and nothing covers it", hostile && hostile.inView && hostile.hit, JSON.stringify(hostile));
  const dialogAside = await long.evaluate(() => !document.getElementById("hostile-dialog").open);
  check("hostile page: a modal dialog is put aside while the breaks are shown", dialogAside);
  if (hostile) {
    const at = { x: hostile.center[0], y: hostile.center[1] };
    await long.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none", buttons: 0 });
    await long.call("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
    await long.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
  }
  await finishJob("hostile page, a real click on Save PDF");
  const hostileAfter = await long.evaluate(() => {
    const dlg = document.getElementById("hostile-dialog");
    const out = { dialogBack: dlg.open && dlg.matches(":modal"), transform: document.documentElement.style.transform };
    dlg.close(); dlg.remove();
    document.getElementById("hostile-cover").remove();
    document.documentElement.style.removeProperty("transform");
    if (!document.documentElement.getAttribute("style")) document.documentElement.removeAttribute("style");
    return out;
  });
  check("hostile page: the dialog is back afterwards", hostileAfter.dialogBack, JSON.stringify(hostileAfter));

  // "Save PDF now" in the popup does what Save PDF on the page does.
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - from the popup" });
  const waiting = await waitStatus(longTab, (s) => s && s.running && s.phase === "waiting-breaks", "waiting for the breaks");
  check("the popup is told the page waits for the reader", Boolean(waiting) && /Save PDF/.test(waiting.step), JSON.stringify(waiting));
  const finished = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-finish-pdf", tabId }), longTab);
  check("popup: Save PDF now is accepted", finished && finished.ok, JSON.stringify(finished));
  await finishJob("popup: Save PDF now");

  // Cancel from the popup: the job ends, the page is put back, the tab is free.
  const beforeCancel = await long.evaluate(() => document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length);
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "balanced", banner: true, filename: "{title} - cancelled" });
  await waitEditor(long);
  await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-cancel-pdf", tabId }), longTab);
  const cancelled = await popup.evaluate(() => window.__job);
  check("popup: Cancel ends the job", cancelled && !cancelled.ok && /Cancelled/.test(cancelled.error), JSON.stringify(cancelled));
  const afterCancel = await pageState(long);
  check("popup: Cancel puts the page back", afterCancel.ui === 0 && afterCancel.breaks === 0 && Math.abs(afterCancel.len - beforeCancel) < 80, JSON.stringify({ ...afterCancel, before: beforeCancel }));
  const cancelStatus = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-get-status", tabId }), longTab);
  check("popup: after Cancel the tab is free (not running, marked cancelled)", cancelStatus && !cancelStatus.running && cancelStatus.cancelled, JSON.stringify(cancelStatus));

  // Esc on the page cancels too, and leaves nothing listening: a click then
  // reaches the page's own handler, as if the clipper had never been there.
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - esc" });
  await waitEditor(long);
  await long.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  const escaped = await popup.evaluate(() => window.__job);
  check("Esc on the page cancels the job", escaped && !escaped.ok && /Cancelled/.test(escaped.error), JSON.stringify(escaped));
  const clickAfter = await long.evaluate(() => {
    let got = 0;
    const p = document.querySelector("#section-3 + p");
    const on = () => { got += 1; };
    p.addEventListener("click", on);
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    p.dispatchEvent(e);
    p.removeEventListener("click", on);
    return { got, prevented: e.defaultPrevented };
  });
  check("after Esc, clicks reach the page again", clickAfter.got === 1 && !clickAfter.prevented, JSON.stringify(clickAfter));

  // A page that freezes while the breaks are shown (its JavaScript paused):
  // the job gives up on its own, frees the tab, and once the page runs again
  // the editor takes itself away. The next job then works.
  const savedLimits = await sw("JSON.stringify(globalThis.__rwcLimits)");
  await sw("Object.assign(globalThis.__rwcLimits, { poll: 1500, missedPolls: 2, cleanupStep: 1500, pageStale: 4000 }), true");
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - frozen" });
  await waitStatus(longTab, (s) => s && s.running && s.phase === "waiting-breaks", "waiting for the breaks (frozen)");
  await long.call("Debugger.enable");
  await long.call("Debugger.pause");
  const t0 = Date.now();
  const frozen = await Promise.race([popup.evaluate(() => window.__job), sleep(30000).then(() => "hung")]);
  const frozenMs = Date.now() - t0;
  await long.call("Debugger.resume").catch(() => {});
  await long.call("Debugger.disable").catch(() => {});
  check("a frozen page: the job stops on its own", frozen !== "hung" && frozen && !frozen.ok && /stopped responding/i.test(frozen.error), `${JSON.stringify(frozen)} after ${frozenMs} ms`);
  const frozenStatus = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-get-status", tabId }), longTab);
  check("a frozen page: the tab is free afterwards", frozenStatus && !frozenStatus.running, JSON.stringify(frozenStatus));
  let editorGone = false;
  for (let i = 0; i < 60 && !editorGone; i += 1) {
    editorGone = await long.evaluate(() => ![...document.querySelectorAll("[data-recall-pdf-ui]")].some((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines")));
    if (!editorGone) await sleep(250);
  }
  check("a frozen page: once it runs again, the editor takes itself away", editorGone);
  await sw(`Object.assign(globalThis.__rwcLimits, ${savedLimits}), true`);
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - after frozen" });
  await finishJob("after a frozen page, the next job");

  // A save that fails is reported as failed (not "Saved"), and Save again
  // saves the same PDF without making it again.
  await sw("globalThis.__rwcLimits.failDownloads = 1, true");
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - save again" });
  const failedSave = await popup.evaluate(() => window.__job);
  check("a failed save is reported as failed", failedSave && !failedSave.ok && /Could not save/.test(failedSave.error), JSON.stringify(failedSave));
  const failedStatus = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "rwc-get-status", tabId }), longTab);
  check("…and the popup offers Save again", failedStatus && failedStatus.canSaveAgain && !failedStatus.running, JSON.stringify(failedStatus));
  await popup.evaluate((tabId) => { window.__job = chrome.runtime.sendMessage({ type: "rwc-save-again", tabId }); return true; }, longTab);
  const again = await finishJob("Save again");
  check("Save again saves it, by blob: address", Boolean(again) && lastUrl.startsWith("blob:"), lastUrl);
  await client.send("Target.closeTarget", { targetId: long.targetId });

  const pristine = await page.evaluate(() => document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length);
  const continuous = await job({ layout: "continuous", paper: "A4", marginPreset: "sides", marginSize: 12, imageQuality: "high", clean: "balanced", filename: "{title} - continuous" }, "continuous");
  if (continuous) {
    const r = await readPdf(continuous);
    check("continuous: one page", r.pages === 1, `${r.pages} pages`);
    check("continuous: High quality resized the oversized image", lastJob && lastJob.resized >= 1, `${lastJob && lastJob.resized} resized`);
    check("continuous: A4 wide (595 pt)", Math.abs(r.width - 595.3) < 2, `${r.width} pt`);
    check("continuous: text is selectable", /harmonic analysis/.test(r.text));
    check("continuous: Balanced clean left the comments out", !/First comment here/.test(r.text) && !/We use cookies/.test(r.text));
    check("metadata: title", r.info.Title === "How Tides Work", r.info.Title);
    check("metadata: source address in Subject and RecallSourceURL", r.info.Subject === "https://example.org/science/how-tides-work" && r.info.Custom?.RecallSourceURL === r.info.Subject);
    check("metadata: author, site and capture time", r.info.Author === "Ada Example" && r.info.Custom?.RecallSiteName === "The Daily Example" && /^\d{4}-\d\d-\d\dT/.test(r.info.Custom?.RecallCapturedAt || ""));
    check("metadata: Creator names the extension", r.info.Creator === "Recall Web Clipper", r.info.Creator);
  }
  // ------------------------------------------------------------ into Recall
  //
  // The PDF the extension just made, imported by the app itself: the file is
  // named after the page, remembers its source, and its Notes link back.
  if (continuous) {
    const app = await openPage(client);
    await app.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await app.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `${pdfjs.main}\n;(function () { try { var b = new Blob([${JSON.stringify(pdfjs.worker)}], { type: "text/javascript" }); window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(b); } catch (e) {} })();`
    });
    await servePdfjsFromDisk(client, app, pdfjs);
    await app.goto(`http://127.0.0.1:${port}/index.html`);
    const imported = await app.evaluate(async (b64) => {
      const paths = ["/src/import/pdf.js?v=__BUILD__", "/src/cloud/supabase-client.js?v=__BUILD__", "/src/ui/boot-screens.js?v=__BUILD__",
        "/src/boot.js?v=__BUILD__", "/src/core/state.js?v=__BUILD__", "/src/library/local-library.js?v=__BUILD__", "/src/storage/deck-store.js?v=__BUILD__"];
      const api = {};
      for (const m of await Promise.all(paths.map((p) => import(p)))) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));
      api.setSupabaseClient({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
          getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null })
        },
        from: () => { throw new Error("offline in this check"); },
        storage: { from: () => ({
          upload: async () => ({ error: { message: "offline in this check" } }),
          remove: async () => ({ error: null }),
          list: async () => ({ data: [], error: null }),
          createSignedUrls: async () => ({ data: [], error: null }),
          getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/" + p } })
        }) }
      });
      for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
      api.setSignedIn(true);
      api.showAuthenticatedUI();
      api.initAppForUser();
      await settle(600);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await api.importPdfFile(new File([bytes], "How Tides Work - continuous.pdf", { type: "application/pdf" }), null);
      await settle(400);
      const entry = api.readLocalDeckIndex().find((m) => m.title === "How Tides Work");
      if (!entry) return { error: `no file named after the page: ${JSON.stringify(api.readLocalDeckIndex().map((m) => m.title))}` };
      await api.loadDeckFromLibrary(entry.id);
      await settle(300);
      return { title: api.state.deckTitle, source: api.state.meta?.pdf?.source || null, notes: api.state.notes };
    }, readFileSync(continuous).toString("base64"));
    check("Recall: the imported file is named after the page", imported.title === "How Tides Work", imported.error || imported.title);
    check("Recall: the file remembers where the PDF came from", imported.source && imported.source.url === "https://example.org/science/how-tides-work"
      && imported.source.site === "The Daily Example" && imported.source.author === "Ada Example", JSON.stringify(imported.source));
    check("Recall: its Notes start with a link back to the page",
      typeof imported.notes === "string" && imported.notes.startsWith("Source: [How Tides Work](https://example.org/science/how-tides-work) · The Daily Example · by Ada Example · published 1 Oct 2026 · saved "),
      JSON.stringify(String(imported.notes).slice(0, 160)));
    await client.send("Target.closeTarget", { targetId: app.targetId });
  }

  const restored = await page.evaluate(() => ({
    len: document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length,
    cookie: Boolean(document.getElementById("cookieBanner")),
    title: document.title
  }));
  check("the page is put back after the job", restored.cookie && restored.title === "How Tides Work | The Daily Example" && Math.abs(restored.len - pristine) < 80, `${pristine} → ${restored.len}`);

  const paged = await job({ layout: "paged", paper: "A4", marginPreset: "all", marginSize: 15, textSize: 180, clean: "off", footer: "page", filename: "{title} - paged" }, "paged");
  if (paged) {
    const r = await readPdf(paged);
    check("paged: several A4 pages", r.pages >= 2 && Math.abs(r.width - 595.3) < 2 && Math.abs(r.height - 841.9) < 2, `${r.pages} × ${r.width}×${r.height}`);
  }

  // ------------------------------------------------------------ a heavy page
  //
  // What made a printed page slow to open: shadows, full-size WebP and PNG
  // pictures from another site, a variable font, a tagged PDF. The pictures
  // are made here by Chrome itself (noise, so they do not compress away) and
  // served from a second origin that sends no CORS headers; the font is
  // served with CORS, as a font must be.
  const pictures = await reader.evaluate(async () => {
    const make = async (w, h, type, opaque = true) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext("2d");
      const img = x.createImageData(w, h);
      let seed = w * 7 + h;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const v = (seed >>> 16) & 255;
        img.data[i] = v; img.data[i + 1] = (v * 3 + i / 4 / w) & 255; img.data[i + 2] = 255 - v; img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      if (!opaque) {
        x.clearRect(0, 0, w, h);
        x.fillStyle = "#4f5bd5"; x.fillRect(40, 40, w / 2, h / 2);
        x.fillStyle = "#222"; x.font = "48px sans-serif"; x.fillText("diagram", 60, h - 60);
      }
      const blob = await c.convertToBlob({ type, quality: 0.8 });
      const b = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return {
      "photo-1.webp": await make(2400, 1600, "image/webp"),
      "photo-2.webp": await make(2000, 1400, "image/webp"),
      "photo-3.png": await make(1800, 1200, "image/png"),
      "diagram.png": await make(900, 500, "image/png", false)
    };
  });
  const http = await import("node:http");
  const assets = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("?")[0].slice(1));
    if (name === "variable-font.woff2") {
      res.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" });
      res.end(readFileSync(path.join(EXT, "tools/fixtures/variable-font.woff2")));
    } else if (pictures[name]) {
      res.writeHead(200, { "content-type": name.endsWith(".png") ? "image/png" : "image/webp" });
      res.end(Buffer.from(pictures[name], "base64"));
    } else { res.writeHead(404); res.end(); }
  });
  const assetPort = await new Promise((resolve) => assets.listen(0, "127.0.0.1", function () { resolve(this.address().port); }));
  // localhost against the page's 127.0.0.1: another origin.
  const HEAVY = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/heavy.html?assets=${encodeURIComponent(`http://localhost:${assetPort}`)}`;
  const heavyPage = await openPage(client);
  await heavyPage.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await heavyPage.goto(HEAVY);
  await heavyPage.waitFor(() => document.getElementById("table") && [...document.images].every((i) => i.complete && i.naturalWidth > 0)
    && document.fonts.check('16px "Recall Test Variable"'), { label: "heavy fixture", timeout: 20000 });
  const heavyPristine = await heavyPage.evaluate(() => document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length);
  const heavyTab = await tabIdOf(HEAVY);

  // The PDF's own objects: every picture in it, its fonts, and whether it is tagged.
  const pdfFacts = (file) => {
    const text = readFileSync(file).toString("latin1");
    const images = [];
    for (const m of text.matchAll(/<<((?:(?!>>\s*stream)[\s\S]){0,600}?\/Subtype\s*\/Image[\s\S]{0,600}?)>>\s*stream/g)) {
      const d = m[1];
      const num = (k) => Number((new RegExp(`/${k}\\s+(\\d+)`).exec(d) || [])[1] || 0);
      images.push({ width: num("Width"), height: num("Height"), filter: (/\/Filter\s*\/(\w+)/.exec(d) || [])[1] || "", mask: /\/DeviceGray/.test(d) });
    }
    return { images, type3: /\/Subtype\s*\/Type3/.test(text), tagged: /\/StructTreeRoot/.test(text), size: text.length };
  };

  const heavyStart = Date.now();
  const heavy = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - heavy" }, "heavy page", heavyTab);
  const heavyMs = Date.now() - heavyStart;
  if (heavy) {
    const f = pdfFacts(heavy);
    // The 24 px icon's invert() filter is drawn as a small picture: filters
    // other than blur and drop-shadow are left alone.
    const photos = f.images.filter((i) => !i.mask && i.width > 100);
    const big = f.images.filter((i) => i.width > 100);
    console.log(`     heavy page: ${(f.size / 1048576).toFixed(2)} MB, ${f.images.length} pictures, ${heavyMs} ms`);
    check("heavy: no shadow turned into a picture (only the 5 pictures shown, and the diagram's mask)", big.length <= 6, JSON.stringify(big));
    check("heavy: photos from another site are sized for print (≤ 200 DPI at A4 width)", photos.every((i) => i.width <= 1700), photos.map((i) => i.width).join(", "));
    check("heavy: photos are JPEG, the diagram stays lossless", photos.filter((i) => i.filter === "DCTDecode").length === 3 && photos.some((i) => i.filter === "FlateDecode" && i.width <= 900),
      photos.map((i) => `${i.width}:${i.filter}`).join(", "));
    check("heavy: the variable font is not embedded as a Type 3 font", !f.type3 && lastJob.fonts >= 1, `${lastJob.fonts} elements changed`);
    check("heavy: not tagged by default", !f.tagged);
    check("heavy: the PDF is small", f.size < 2.5 * 1048576, `${(f.size / 1048576).toFixed(2)} MB`);
    const hp = await readPages(heavy);
    const pageOf = (re) => hp.findIndex((p) => re.test(p.flat));
    check("heavy: a list longer than a page is cut between its items", pageOf(/Item1:/) >= 0 && pageOf(/Item120:/) > pageOf(/Item1:/), `${pageOf(/Item1:/)} → ${pageOf(/Item120:/)}`);
    check("heavy: a table longer than a page is cut between its rows", pageOf(/Row1Pictures/) >= 0 && pageOf(/Row80/) > pageOf(/Row1Pictures/), `${pageOf(/Row1Pictures/)} → ${pageOf(/Row80/)}`);
    const all = hp.map((p) => p.flat).join("");
    const lost = Array.from({ length: 120 }, (_, i) => i + 1).filter((n) => !all.includes(`Item${n}:`));
    check("heavy: nothing of the list lost", lost.length === 0, lost.join(", "));
    const rowsLost = Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => !new RegExp(`Row${n}(?!\\d)`).test(all));
    check("heavy: nothing of the table lost (its header repeats on the next page)", rowsLost.length === 0, rowsLost.join(", "));
    const cardsLost = Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => !new RegExp(`Card${n}(?!\\d)`).test(all));
    check("heavy: nothing of the cards lost", cardsLost.length === 0, cardsLost.join(", "));
    check("heavy: no page taller than one A4 page", hp.every((p) => p.height <= A4H + 1), hp.map((p) => Math.round(p.height)).join(", "));
  }
  const heavyAfter = await heavyPage.evaluate(() => ({
    len: document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length,
    blobs: [...document.images].filter((i) => i.src.startsWith("blob:")).length,
    shadow: getComputedStyle(document.querySelector(".card")).boxShadow,
    icon: getComputedStyle(document.getElementById("icon")).filter,
    font: getComputedStyle(document.querySelector("p")).fontFamily
  }));
  check("heavy: the page is put back (pictures, shadows, fonts)", Math.abs(heavyAfter.len - heavyPristine) < 80 && heavyAfter.blobs === 0
    && heavyAfter.shadow !== "none" && /Recall Test Variable/.test(heavyAfter.font), JSON.stringify({ ...heavyAfter, pristine: heavyPristine }));

  // The same page with everything the old defaults did: shadows, page fonts,
  // pictures as served, tagged — for the numbers.
  const oldStart = Date.now();
  const heavyOld = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, effects: true, fonts: "page", tagged: true, imageQuality: "original", filename: "{title} - heavy as before" }, "heavy page, old defaults", heavyTab);
  if (heavyOld && heavy) {
    const a = pdfFacts(heavyOld);
    const b = pdfFacts(heavy);
    console.log(`     as before: ${(a.size / 1048576).toFixed(2)} MB, ${a.images.length} pictures, ${Date.now() - oldStart} ms`);
    check("heavy: the new defaults make a far smaller PDF than the old ones", b.size * 3 < a.size, `${(a.size / 1048576).toFixed(2)} MB → ${(b.size / 1048576).toFixed(2)} MB`);
  }
  assets.close();
  await client.send("Target.closeTarget", { targetId: heavyPage.targetId });

  // ------------------------------------------------------------ videos, embeds and moving pictures
  //
  // A video, an embed, a WebGL canvas and a moving GIF: each must reach the
  // PDF as a picture of what the page showed — not a grey box with a link —
  // and a tap on it must lead to the real thing (a link annotation, which
  // Recall's PDFs tab follows). The YouTube embed cannot load here, so it
  // falls back to the link box, but its link is the video's own page.

  const MEDIA = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/media.html`;
  const GIF = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/moving.gif`;
  const THIRDS = `http://127.0.0.1:${port}/recall-clipper/tools/fixtures/thirds.webm`;
  const mediaPage = await openPage(client);
  await mediaPage.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await mediaPage.goto(MEDIA);
  await mediaPage.waitFor(() => {
    const v = document.getElementById("vid");
    const t = document.getElementById("thirds");
    const g = document.getElementById("moving");
    return v && v.readyState >= 2 && t && t.readyState >= 1 && g.complete && g.naturalWidth > 0;
  }, { label: "media fixture", timeout: 20000 });
  const mediaPristine = await mediaPage.evaluate(() => document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length);
  const mediaTab = await tabIdOf(MEDIA);

  // Every link a reader could tap, and every page's text.
  async function readLinks(file) {
    const bytes = readFileSync(file);
    return reader.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      const links = [];
      let text = "";
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        for (const a of await page.getAnnotations()) {
          if (a.subtype === "Link" && (a.url || a.unsafeUrl)) {
            links.push({ url: a.url || a.unsafeUrl, w: Math.round(a.rect[2] - a.rect[0]), h: Math.round(a.rect[3] - a.rect[1]) });
          }
        }
        text += (await page.getTextContent()).items.map((t) => t.str).join(" ");
      }
      // pdf.js hands some runs back a few letters at a time ("S uns e t"):
      // words are compared with the spaces taken out.
      return { links, text: text.replace(/\s+/g, "") };
    }, bytes.toString("base64"));
  }

  // The colour a picture in the PDF shows: the largest link to `url` is the
  // picture itself; sampled a fifth of the way in from its left, clear of the
  // ▶ in its middle. "red" | "green" | "blue" | the RGB when it is none.
  async function colourOf(file, url) {
    const bytes = readFileSync(file);
    return reader.evaluate(async (b64, url) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      let best = null;
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        for (const a of await page.getAnnotations()) {
          if (a.subtype !== "Link" || (a.url || a.unsafeUrl) !== url) continue;
          const area = Math.abs((a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]));
          if (!best || area > best.area) best = { page, rect: a.rect, area };
        }
      }
      if (!best) return "no link";
      const vp = best.page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      await best.page.render({ canvasContext: ctx, viewport: vp }).promise;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(best.rect);
      const x = Math.round(Math.min(x1, x2) + Math.abs(x2 - x1) * 0.2);
      const y = Math.round((y1 + y2) / 2);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r > 180 && g < 80 && b < 80) return "red";
      if (g > 120 && r < 80 && b < 80) return "green";
      if (b > 180 && r < 80 && g < 80) return "blue";
      return `rgb(${r}, ${g}, ${b})`;
    }, bytes.toString("base64"), url);
  }

  const media = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - media" }, "media page", mediaTab);
  if (media) {
    const f = pdfFacts(media);
    const { links, text } = await readLinks(media);
    const linkTo = (url) => links.filter((l) => l.url === url);
    console.log(`     media page: ${lastJob.frames} pictures of videos and embeds, ${lastJob.moving} moving picture(s), ${links.length} links`);
    check("media: the videos, the embed and the canvas each became a picture", lastJob.frames === 4, `${lastJob.frames}`);
    const thirds = await colourOf(media, THIRDS);
    check("media: a video's picture is its middle frame (green), not its first (red)", thirds === "green", thirds);
    const gif = await colourOf(media, GIF);
    check("media: a moving picture's still is its middle frame (green), not its first (red)", gif === "green", gif);
    check("media: the video's picture is a JPEG in the PDF", f.images.some((i) => i.filter === "DCTDecode" && i.width >= 400), f.images.map((i) => `${i.width}x${i.height}:${i.filter}`).join(", "));
    // The picture itself is the link (as big as the 480×270 video at print
    // scale), and so is the caption under it.
    check("media: tapping the video's picture opens the post it was in", linkTo("https://example.org/post/42").some((l) => l.w > 150 && l.h > 80), JSON.stringify(linkTo("https://example.org/post/42")));
    check("media: no grey link box for a video that played", !/Video:/.test(text), text.slice(0, 300));
    check("media: the caption names the video", /Sunsetoverthebay/.test(text));
    // youtube.com is out of reach here: Chrome shows its error page in the frame.
    check("media: an embed that could not load is the link box, not Chrome's error page", /Embeddedcontent:AYouTubevideo/.test(text) && lastJob.frames === 4, `${lastJob.frames} pictures`);
    check("media: a YouTube embed links to the video's own page", linkTo("https://www.youtube.com/watch?v=abc123XYZ00&t=30s").length > 0, JSON.stringify(links.map((l) => l.url)));
    check("media: a moving picture links to its moving original", linkTo(GIF).length > 0 && lastJob.moving >= 1, JSON.stringify(links.map((l) => l.url)));
    check("media: the page's own words are all there", /Textafterthevideo/.test(text) && /Theend/.test(text));
  }
  const mediaAfter = await mediaPage.evaluate(() => ({
    len: document.documentElement.outerHTML.replace(/<recall-clipper-toast[^>]*><\/recall-clipper-toast>/g, "").length,
    video: Boolean(document.querySelector("a > video#vid")) && Boolean(document.getElementById("vid").srcObject),
    // Taking it out of the page to put its picture in paused it.
    playing: !document.getElementById("vid").paused,
    // Moved to its middle and its controls put away for the picture; both back.
    thirds: (() => { const t = document.getElementById("thirds"); return t && t.currentTime === 0 && t.hasAttribute("controls") && t.paused; })(),
    canvas: Boolean(document.querySelector("canvas#gl")),
    frames: document.querySelectorAll("[data-recall-pdf-media], [data-recall-pdf-frame], [data-recall-pdf-moving]").length,
    blobs: [...document.images].filter((i) => i.src.startsWith("blob:")).length
  }));
  check("media: the page is put back (videos playing or not, where they were, canvas, picture, no marks)", Math.abs(mediaAfter.len - mediaPristine) < 80
    && mediaAfter.video && mediaAfter.playing && mediaAfter.thirds && mediaAfter.canvas
    && mediaAfter.frames === 0 && mediaAfter.blobs === 0, JSON.stringify({ ...mediaAfter, pristine: mediaPristine }));

  // "Replace with a link" is still there for whoever wants it.
  const mediaLinks = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, embeds: "link", filename: "{title} - media links" }, "media page, links only", mediaTab);
  if (mediaLinks) {
    const { text } = await readLinks(mediaLinks);
    check("media: Replace with a link prints the link box, no pictures of videos", /Video:/.test(text) && lastJob.frames === 0, `${lastJob.frames} pictures`);
  }

  // "The frame the page shows": the video file, at its start, stays red.
  const mediaShown = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, mediaFrame: "shown", filename: "{title} - media as shown" }, "media page, frames as shown", mediaTab);
  if (mediaShown) {
    const thirds = await colourOf(mediaShown, THIRDS);
    check("media: \"The frame the page shows\" keeps a video near its start (red)", thirds === "red", thirds);
  }
  await client.send("Target.closeTarget", { targetId: mediaPage.targetId });

} catch (err) {
  check("ran to the end", false, err && err.stack || String(err));
}
await finish();
