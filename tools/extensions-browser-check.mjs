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

  let lastJob = null;
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
        .map((d) => ({ filename: d.filename, state: d.state, error: d.error || "" })));
      const hit = items.find((d) => d.state === "complete" && path.basename(d.filename).startsWith(res.name.replace(/\.pdf$/, "")));
      if (hit) file = hit.filename;
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

  // ------------------------------------------------------------ smart pages

  const long = await openPage(client);
  await long.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await long.goto(LONG);
  await long.waitFor(() => document.getElementById("section-12"), { label: "long fixture" });
  const longTab = await tabIdOf(LONG);
  const longPristine = await long.evaluate(() => document.documentElement.outerHTML.length);
  const A4H = 841.89;
  const smart = await job({ layout: "smart", pageLength: "a4", adjustBreaks: false, clean: "off", banner: false, filename: "{title} - smart" }, "smart pages", longTab);
  let smartPages = [];
  if (smart) {
    smartPages = await readPages(smart);
    const heights = smartPages.map((p) => Math.round(p.height));
    check("smart: a long page becomes several pages", smartPages.length >= 4, `${smartPages.length} pages`);
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
  }
  const afterSmart = await long.evaluate(() => ({
    len: document.documentElement.outerHTML.length,
    breaks: [...document.querySelectorAll("*")].filter((el) => el.style.breakBefore === "page").length
  }));
  check("smart: the page is put back afterwards", afterSmart.breaks === 0 && Math.abs(afterSmart.len - longPristine) < 80, `${longPristine} → ${afterSmart.len}, ${afterSmart.breaks} breaks left`);

  // The break editor: the cuts appear on the page as dashed lines; one is
  // removed, one added by clicking the page, and Save PDF prints that.
  await startJob(longTab, { layout: "smart", pageLength: "a4", adjustBreaks: true, clean: "off", banner: false, filename: "{title} - edited" });
  const linesOf = () => long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    if (!host) return null;
    const root = host.shadowRoot;
    return { cuts: root.querySelectorAll(".cut").length, count: root.querySelector(".count").textContent };
  });
  await long.waitFor(() => [...document.querySelectorAll("[data-recall-pdf-ui]")].some((h) => h.shadowRoot && h.shadowRoot.querySelectorAll(".cut").length > 0), { label: "break editor", timeout: 20000 });
  const shown = await linesOf();
  check("editor: the planned cuts are shown on the page", shown && shown.cuts === Math.max(0, smartPages.length - 1), JSON.stringify(shown));
  await long.evaluate(() => {
    const host = [...document.querySelectorAll("[data-recall-pdf-ui]")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".lines"));
    host.shadowRoot.querySelectorAll(".cut")[1].click();
  });
  const removed = await linesOf();
  check("editor: clicking a line removes that cut", removed && removed.cuts === shown.cuts - 1, JSON.stringify(removed));
  await long.evaluate(() => {
    const p = document.querySelector("#section-2 + p + p");
    p.scrollIntoView({ block: "center" });
    const r = p.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2 }));
  });
  const added = await linesOf();
  check("editor: clicking the page adds a cut", added && added.cuts === removed.cuts + 1, JSON.stringify(added));
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
  await client.send("Target.closeTarget", { targetId: long.targetId });

  const pristine = await page.evaluate(() => document.documentElement.outerHTML.length);
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
    len: document.documentElement.outerHTML.length,
    cookie: Boolean(document.getElementById("cookieBanner")),
    title: document.title
  }));
  check("the page is put back after the job", restored.cookie && restored.title === "How Tides Work | The Daily Example" && Math.abs(restored.len - pristine) < 80, `${pristine} → ${restored.len}`);

  const paged = await job({ layout: "paged", paper: "A4", marginPreset: "all", marginSize: 15, textSize: 180, clean: "off", footer: "page", filename: "{title} - paged" }, "paged");
  if (paged) {
    const r = await readPdf(paged);
    check("paged: several A4 pages", r.pages >= 2 && Math.abs(r.width - 595.3) < 2 && Math.abs(r.height - 841.9) < 2, `${r.pages} × ${r.width}×${r.height}`);
  }

} catch (err) {
  check("ran to the end", false, err && err.stack || String(err));
}
await finish();
