// The two web extensions, driven in a real Chromium with both loaded unpacked:
//
//   Recall Page Cleaner — Auto (Balanced) marks the clutter on a fixture page
//   and none of the article; marked blocks are blurred under a red box;
//   Manual marks the clicked block; Apply removes, Undo puts back exactly.
//
//   Recall Web to PDF — a continuous-page job with left/right margins and High
//   images prints ONE page of the right width, carries Recall's metadata
//   (read back with pdf.js, as the app reads it), and leaves the page as it was.
//   A paged A4 job prints several A4 pages. The Cleaner's "Save as PDF"
//   hand-off reaches it by its fixed ID.
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
const CLEANER = path.join(ROOT, "recall-page-cleaner");
const WEBPDF = path.join(ROOT, "recall-web-to-pdf");
const CLEANER_ID = "klhlbnklncdmdlgepekhegakilnccgji";
const WEBPDF_ID = "jcggbcoegkedmplddimgefonccicnihb";

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
const FIXTURE = `http://127.0.0.1:${port}/recall-page-cleaner/tools/fixtures/clutter.html`;

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
  `--disable-extensions-except=${CLEANER},${WEBPDF}`,
  `--load-extension=${CLEANER},${WEBPDF}`
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

  // Both service workers come up on their fixed IDs (the manifest "key").
  let targets = [];
  for (let i = 0; i < 50; i += 1) {
    ({ targetInfos: targets } = await client.send("Target.getTargets"));
    if (targets.some((t) => t.url.startsWith(`chrome-extension://${CLEANER_ID}/`)) && targets.some((t) => t.url.startsWith(`chrome-extension://${WEBPDF_ID}/`))) break;
    await sleep(100);
  }
  check("Page Cleaner loads with its fixed ID", targets.some((t) => t.url.startsWith(`chrome-extension://${CLEANER_ID}/`)));
  check("Web to PDF loads with its fixed ID", targets.some((t) => t.url.startsWith(`chrome-extension://${WEBPDF_ID}/`)));

  // ------------------------------------------------------------ Page Cleaner

  const page = await openPage(client);
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(FIXTURE);
  const core = readFileSync(path.join(CLEANER, "content/cleaner-core.js"), "utf8");
  const ui = readFileSync(path.join(CLEANER, "content/cleaner-ui.js"), "utf8");
  const css = readFileSync(path.join(CLEANER, "content/cleaner.css"), "utf8");
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

  // ------------------------------------------------------------ Web to PDF

  const { targetInfos } = await client.send("Target.getTargets");
  const tabTarget = targetInfos.find((t) => t.type === "page" && t.url === FIXTURE);
  // The fixture tab's chrome.tabs id, read from an extension page.
  const popup = await openPage(client);
  await popup.goto(`chrome-extension://${WEBPDF_ID}/popup.html`);
  // chrome.tabs hides URLs without the "tabs" permission; the debugger's
  // target list (which this extension holds) has both.
  const tabId = await popup.evaluate(async (url) => {
    const targets = await chrome.debugger.getTargets();
    const hit = targets.find((t) => t.type === "page" && t.url === url && t.tabId != null);
    return hit ? hit.tabId : null;
  }, FIXTURE);
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

  let lastJob = null;
  async function job(options, label) {
    const res = await popup.evaluate(async (tabId, options) => chrome.runtime.sendMessage({ type: "rwp-start", tabId, options }), tabId, options);
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
    check("metadata: Creator names the extension", r.info.Creator === "Recall Web to PDF", r.info.Creator);
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

  // The hand-off: the Cleaner's background asks Web to PDF (by its fixed ID)
  // to print the tab. No activeTab grant is involved — the debugger covers it.
  const sw = targetInfos.find((t) => t.url === `chrome-extension://${CLEANER_ID}/background.js`)
    || (await client.send("Target.getTargets")).targetInfos.find((t) => t.url === `chrome-extension://${CLEANER_ID}/background.js`);
  if (sw) {
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const r = await client.send("Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage(${JSON.stringify(WEBPDF_ID)}, { type: "recall-print", tabId: ${tabId} })`,
      awaitPromise: true, returnByValue: true
    }, sessionId);
    const value = r.result && r.result.value;
    check("Cleaner → Web to PDF hand-off prints the tab", value && value.ok === true, JSON.stringify(value || r.exceptionDetails?.text));
  } else {
    check("Cleaner → Web to PDF hand-off prints the tab", false, "no Cleaner service worker");
  }
  // And a stranger is refused: the popup page is Web to PDF itself, not the Cleaner.
  const stranger = await popup.evaluate(async (id, tabId) => {
    try { return await chrome.runtime.sendMessage(id, { type: "recall-print", tabId }); } catch (e) { return { refused: String(e.message || e) }; }
  }, WEBPDF_ID, tabId);
  check("only the Cleaner may ask for a print", !stranger || stranger.ok !== true, JSON.stringify(stranger));
} catch (err) {
  check("ran to the end", false, err && err.stack || String(err));
}
await finish();
