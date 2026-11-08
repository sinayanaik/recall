// Markdown → PDF, in the app: the dialog, its preview and page breaks, and the
// three ways the pages go into a file.
//
//   node tools/md-pdf-browser-check.mjs [--shot=dir]
//
// The layout, the planner and the bytes are checked on their own by
// tools/md-pdf-check.mjs. This is the rest, through a real browser and the
// generated fixture paper (setup as tools/pdf-margins-browser-check.mjs):
//
//   • PDF ⋯ → New PDF from Markdown… opens the sheet; pasted markdown is laid
//     out and previewed with its page breaks; a break added by clicking the page
//     is there and Undo takes it away;
//   • Make PDF puts a new PDF in the file's PDFs list whose text is real text;
//   • on the fixture, Insert Markdown pages… before page 2 puts the pages in and
//     a highlight on the fixture's page 3 moves with its page;
//   • Edit markdown… opens on the markdown kept in the PDF, and Remake pages
//     changes the pages;
//   • the sheet fits a phone.
//
// fontkit and the fonts come from npm (tools/fontkit-source.mjs), pdf.js and
// pdf-lib from disk; nothing goes to a CDN.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources } from "./pdfjs-source.mjs";
import { PDFLIB_VERSION, pdflibSource } from "./pdflib-source.mjs";
import { fontkitSource, fontFile } from "./fontkit-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";
import { HTMLTOIMAGE_VERSION, htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-multi.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
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
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ }
      await settle(100);
    }
    return null;
  };
  window.__recall = { api, settle, until };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("md-pdf-browser-check does not touch the network"); },
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
  return true;
}`;

const SHOT = (process.argv.slice(2).find((a) => a.startsWith("--shot=")) || "").slice(7);
const WATCHDOG_MS = 5 * 60 * 1000;

const chrome = findChrome();
if (!chrome) {
  console.error("md-pdf-browser-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}
let sources;
let pdflib;
let fontkit;
let htmlToImage = null;
try {
  sources = pdfjsSources();
  pdflib = pdflibSource();
  fontkit = fontkitSource();
} catch (error) {
  console.log(`md-pdf-browser-check: could not obtain pdf.js ${PDFJS_VERSION} / pdf-lib ${PDFLIB_VERSION} / fontkit (${error?.message || error}) — skipping.`);
  process.exit(0);
}
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`md-pdf-browser-check: no html-to-image ${HTMLTOIMAGE_VERSION} — formulas will be drawn as text.`);
}

const fixture = buildFixturePdf({ pages: 3 });
const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);
const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
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

async function shot(name) {
  if (!SHOT) return;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(SHOT, { recursive: true });
  const data = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOT, name), Buffer.from(data.data, "base64"));
  console.log(`  shot  ${path.join(SHOT, name)}`);
}

// pdf.js (the app fetches it) and the @fontsource fonts, answered from disk.
async function serveFromDisk() {
  const pdfjsBody = {
    main: Buffer.from(sources.raw ?? sources.main, "utf8").toString("base64"),
    worker: Buffer.from(sources.rawWorker ?? sources.worker, "utf8").toString("base64")
  };
  client.on((message) => {
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== page.sessionId) return;
    const { requestId, request } = message.params;
    const cors = { name: "Access-Control-Allow-Origin", value: "*" };
    if (request.url.includes("@fontsource/")) {
      const rel = request.url.split("@fontsource/")[1].split("?")[0];
      const bytes = fontFile(rel);
      if (!bytes) {
        page.call("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [cors], body: "" }).catch(() => {});
        return;
      }
      page.call("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "font/woff" }, cors],
        body: Buffer.from(bytes).toString("base64")
      }).catch(() => {});
      return;
    }
    const file = /pdf\.worker(\.min)?\.js/.test(request.url) ? pdfjsBody.worker : pdfjsBody.main;
    page.call("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, cors],
      body: file
    }).catch(() => {});
  });
  await page.call("Fetch.enable", { patterns: [{ urlPattern: `*pdfjs-dist@${PDFJS_VERSION}*` }, { urlPattern: "*@fontsource/*" }] });
}

const MARKDOWN = `# Markdown in a PDF

A paragraph with **bold**, *italic*, \`code\` and Greek αβγ → ≤ ∑.

## A table

| Name | Value |
|------|------:|
| one  | 1 |
| two  | 22 |

## Some code

\`\`\`js
const add = (a, b) => a + b; // sum
\`\`\`

Inline maths $x^2 + y^2$ and the end of the note.
`;

const HINDI_WORDS = "चार्वाक दर्शन भारतीय दर्शन की एक नास्तिक शाखा है जो प्रत्यक्ष प्रमाण को ही एकमात्र प्रमाण मानती है लोकायत शरीर चेतना आत्मा परलोक".split(" ");
const HINDI = Array.from({ length: 30 }, (_, i) => `## भाग ${i + 1}\n\n${Array.from({ length: 60 }, (_, j) => HINDI_WORDS[(i * 7 + j) % HINDI_WORDS.length] + (j % 9 === 0 ? String.fromCharCode(0x915 + ((i + j) % 30)) + "ी" : "")).join(" ")}।\n`).join("\n");

const LONG = Array.from({ length: 12 }, (_, i) => `## Part ${i + 1}\n\n${"Words that fill a page. ".repeat(40)}\n`).join("\n");

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
  await serveFromDisk();
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: pdflib });
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: fontkit });
  if (htmlToImage) await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  // The fixture paper, open on its PDF tab, with a highlight on page 3.
  const opened = await page.evaluate(`async (bytes) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], "fixture.pdf", { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const entry = api.readLocalDeckIndex()[0];
    if (!entry) return { error: "no file was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(400);
    api.closeMyDecksPanel();
    api.setViewMode("document");
    await api.openDocumentView();
    await settle(500);
    const record = api.addDocumentHighlight({ page: 3, text: "fixture words", quads: [{ page: 3, rect: [72, 700, 200, 714] }] }, "yellow");
    await settle(200);
    return { highlight: record?.id, pages: api.currentPdfPageCount() };
  }`, Array.from(fixture.bytes));
  if (opened.error) throw new Error(opened.error);
  check("the fixture opens on its PDF tab, with a highlight on page 3", Boolean(opened.highlight) && opened.pages === 3, JSON.stringify(opened));

  // ⋯ → New PDF from Markdown…
  const sheet = await page.evaluate(`async (markdown) => {
    const { settle, until } = window.__recall;
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    const row = document.querySelector('#documentMoreMenu [data-document-action="md-new"]');
    if (!row) return { error: "no New PDF from Markdown… row" };
    const visible = row.getClientRects().length > 0;
    const editRow = document.querySelector('#documentMoreMenu [data-document-action="md-edit"]');
    const editHidden = editRow?.hidden;
    row.click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    if (!modal) return { error: "the sheet did not open" };
    const text = modal.querySelector("[data-md-text]");
    text.value = markdown;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    const canvas = await until(() => modal.querySelector(".md-pdf-canvas"), 30000);
    const meter = await until(() => /page/.test(modal.querySelector("[data-md-meter]").textContent) && modal.querySelector("[data-md-meter]").textContent, 30000);
    return {
      visible,
      editHidden,
      canvas: Boolean(canvas),
      bands: modal.querySelectorAll(".md-pdf-band").length,
      meter,
      status: modal.querySelector("[data-md-status]").textContent
    };
  }`, MARKDOWN);
  if (sheet.error) throw new Error(sheet.error);
  check("PDF ⋯ has New PDF from Markdown…, and Edit markdown… is hidden on a paper with none", sheet.visible && sheet.editHidden === true, JSON.stringify(sheet));
  check("pasted markdown is previewed with its pages shaded", sheet.canvas && sheet.bands >= 1, JSON.stringify(sheet));
  check("the size of the PDF is shown, and it is small", /^1 page · \d+ KB$/.test(sheet.meter || "") && Number(sheet.meter.match(/(\d+) KB/)[1]) < 120, sheet.meter);
  await shot("sheet.png");

  // Page breaks by hand: a click on the page adds one; Undo takes it away.
  const breaks = await page.evaluate(`async (long) => {
    const { settle, until } = window.__recall;
    const modal = document.getElementById("mdPdfModal");
    const text = modal.querySelector("[data-md-text]");
    text.value = long;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => modal.querySelectorAll(".md-pdf-cut").length >= 1 && !/Laying/.test(modal.querySelector("[data-md-status]").textContent), 30000);
    await settle(400);
    const before = modal.querySelectorAll(".md-pdf-cut").length;
    const overlay = modal.querySelector("[data-md-overlay]");
    const box = overlay.getBoundingClientRect();
    const first = modal.querySelector(".md-pdf-cut").getBoundingClientRect().top;
    // Halfway down the first page.
    const y = box.top + (first - box.top) / 2;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: box.left + 60, clientY: y }));
    await settle(300);
    const added = modal.querySelectorAll(".md-pdf-cut").length;
    modal.querySelector('[data-md-action="undo"]').click();
    await settle(300);
    const undone = modal.querySelectorAll(".md-pdf-cut").length;
    return { before, added, undone };
  }`, LONG);
  check("a long note is planned into several pages", breaks.before >= 2, JSON.stringify(breaks));
  check("clicking the page adds a page break; Undo takes it away", breaks.added === breaks.before + 1 && breaks.undone === breaks.before, JSON.stringify(breaks));
  await shot("breaks.png");

  // Make PDF: a new PDF in the file, with real text.
  const made = await page.evaluate(`async (markdown) => {
    const { api, settle, until } = window.__recall;
    const modal = document.getElementById("mdPdfModal");
    const text = modal.querySelector("[data-md-text]");
    text.value = markdown;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && !/Laying|Loading|Drawing/.test(modal.querySelector("[data-md-status]").textContent), 30000);
    modal.querySelector('[data-md-action="save"]').click();
    const closed = await until(() => modal.hidden, 30000);
    await settle(800);
    const pdfs = api.deckPdfs(api.state.meta);
    const made = pdfs[pdfs.length - 1];
    const doc = api.currentPdfDocument();
    const content = doc ? await (await doc.getPage(1)).getTextContent() : null;
    return {
      closed: Boolean(closed),
      count: pdfs.length,
      label: made?.label,
      md: made?.md,
      text: content ? content.items.map((i) => i.str).join(" ") : ""
    };
  }`, MARKDOWN);
  check("Make PDF puts a second PDF in the file, named after its heading", made.closed && made.count === 2 && made.label === "Markdown in a PDF" && made.md?.parts === 1, JSON.stringify({ ...made, text: undefined }));
  check("...whose words are real text in the PDF", /Markdown in a PDF/.test(made.text) && /bold/.test(made.text) && /αβγ/.test(made.text), made.text.slice(0, 160));

  // Back to the fixture: Insert Markdown pages… before page 2.
  const inserted = await page.evaluate(`async (markdown) => {
    const { api, settle, until } = window.__recall;
    await api.switchToPdf(api.PDF_PRIMARY_ID);
    await settle(600);
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="md-insert"]').click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    const at = modal.querySelector("[data-md-at]");
    at.value = "2";
    at.dispatchEvent(new Event("input", { bubbles: true }));
    const text = modal.querySelector("[data-md-text]");
    text.value = markdown;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && /page/.test(modal.querySelector("[data-md-meter]").textContent), 30000);
    const meter = modal.querySelector("[data-md-meter]").textContent;
    const matched = modal.querySelector('[data-md-opt="paper"][aria-pressed="true"]')?.dataset.value;
    modal.querySelector('[data-md-action="save"]').click();
    await until(() => modal.hidden, 30000);
    await settle(800);
    const entry = api.deckPdfById(api.state.meta, api.PDF_PRIMARY_ID);
    const highlight = api.documentHighlights().find((h) => h.text === "fixture words");
    const doc = api.currentPdfDocument();
    const page2 = doc ? await (await doc.getPage(2)).getTextContent() : null;
    return {
      meter,
      matched,
      pages: api.currentPdfPageCount(),
      entryPages: entry?.pages,
      md: entry?.md,
      highlightPage: highlight?.page,
      quadPage: highlight?.quads?.[0]?.page,
      page2: page2 ? page2.items.map((i) => i.str).join(" ") : ""
    };
  }`, MARKDOWN);
  const added = inserted.pages - 3;
  check("Insert Markdown pages… matches the paper's page size by default", inserted.matched === "match", JSON.stringify(inserted.matched));
  check("the pages go in before page 2 of the paper", added >= 1 && /Markdown in a PDF/.test(inserted.page2) && inserted.entryPages === inserted.pages && inserted.md?.parts === 1, JSON.stringify({ ...inserted, page2: inserted.page2.slice(0, 60) }));
  check("a highlight on the paper's page 3 moved with its page", inserted.highlightPage === 3 + added && inserted.quadPage === 3 + added, JSON.stringify({ highlightPage: inserted.highlightPage, quadPage: inserted.quadPage, added }));

  // Edit markdown… on the paper: the inserted part, changed and remade.
  const edited = await page.evaluate(`async () => {
    const { api, settle, until } = window.__recall;
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    const row = document.querySelector('#documentMoreMenu [data-document-action="md-edit"]');
    const visible = row && !row.hidden && row.getClientRects().length > 0;
    row.click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    const text = modal.querySelector("[data-md-text]");
    const loaded = text.value.startsWith("# Markdown in a PDF");
    const removeShown = !modal.querySelector('[data-md-action="remove-part"]').hidden;
    text.value = "# Changed heading\\n\\nOnly one short paragraph now.";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && /page/.test(modal.querySelector("[data-md-meter]").textContent), 30000);
    modal.querySelector('[data-md-action="save"]').click();
    await until(() => modal.hidden, 30000);
    await settle(800);
    const doc = api.currentPdfDocument();
    const page2 = doc ? await (await doc.getPage(2)).getTextContent() : null;
    const highlight = api.documentHighlights().find((h) => h.text === "fixture words");
    return {
      visible,
      loaded,
      removeShown,
      pages: api.currentPdfPageCount(),
      page2: page2 ? page2.items.map((i) => i.str).join(" ") : "",
      highlightPage: highlight?.page
    };
  }`);
  check("Edit markdown… is offered on the paper now, and opens on the markdown kept in it", edited.visible && edited.loaded && edited.removeShown, JSON.stringify(edited));
  check("Remake pages changes the inserted pages, and the paper's highlight follows its page", /Changed heading/.test(edited.page2) && edited.pages === 4 && edited.highlightPage === 4, JSON.stringify({ ...edited, page2: edited.page2.slice(0, 60) }));

  // The markdown PDF itself: a highlight on its words, then its markdown
  // edited (a paragraph above them) — the highlight is found on its words again.
  const whole = await page.evaluate(`async () => {
    const { api, settle, until } = window.__recall;
    const pdfs = api.deckPdfs(api.state.meta);
    await api.switchToPdf(pdfs[pdfs.length - 1].id);
    await settle(700);
    const doc = api.currentPdfDocument();
    const content = await (await doc.getPage(1)).getTextContent();
    const item = content.items.find((i) => i.str.includes("bold"));
    if (!item) return { error: "no 'bold' on the markdown PDF" };
    const [, , , , x, y] = item.transform;
    const record = api.addDocumentHighlight({ page: 1, text: "bold", quads: [{ page: 1, rect: [x, y - 2, x + item.width, y + item.height] }] }, "green");
    // From the top of the page: a smart page grows downward with its content,
    // and PDF space measures y from the foot, so that is where "lower" shows.
    const heightBefore = (await doc.getPage(1)).view[3];
    const before = heightBefore - record.quads[0].rect[3];
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="md-edit"]').click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    const removeHidden = modal.querySelector('[data-md-action="remove-part"]').hidden;
    const text = modal.querySelector("[data-md-text]");
    text.value = text.value.replace("# Markdown in a PDF", "# Markdown in a PDF\\n\\nA new first paragraph, long enough to push the next one down by a line or two on the page.");
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && /page/.test(modal.querySelector("[data-md-meter]").textContent), 30000);
    modal.querySelector('[data-md-action="save"]').click();
    await until(() => modal.hidden, 30000);
    await settle(800);
    const after = api.documentHighlights().find((h) => h.id === record.id);
    const doc2 = api.currentPdfDocument();
    const outline = await doc2.getOutline();
    const heightAfter = (await doc2.getPage(1)).view[3];
    return { removeHidden, before, after: after?.quads?.[0] ? heightAfter - after.quads[0].rect[3] : null, words: after?.text, page: after?.page, outline: (outline || []).map((o) => o.title) };
  }`);
  if (whole.error) throw new Error(whole.error);
  check("Edit markdown… on a PDF made wholly from markdown offers no 'take out' (it is the whole PDF)", whole.removeHidden === true, JSON.stringify(whole.removeHidden));
  check("...remaking it finds a highlight on its words again, lower on the page", typeof whole.after === "number" && whole.after > whole.before + 5 && whole.page === 1 && whole.words === "bold", JSON.stringify({ fromTopBefore: whole.before, fromTopAfter: whole.after }));
  check("...and keeps the headings as bookmarks", whole.outline.includes("Markdown in a PDF"), JSON.stringify(whole.outline));

  // Back on the paper: take the inserted pages out again.
  const removed = await page.evaluate(`async () => {
    const { api, settle, until } = window.__recall;
    await api.switchToPdf(api.PDF_PRIMARY_ID);
    await settle(700);
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="md-edit"]').click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    await settle(300);
    modal.querySelector('[data-md-action="remove-part"]').click();
    const ok = await until(() => { const c = document.getElementById("confirmModal"); return c && !c.hidden && document.getElementById("confirmModalOkBtn"); });
    ok?.click();
    await until(() => modal.hidden, 30000);
    await settle(800);
    const entry = api.deckPdfById(api.state.meta, api.PDF_PRIMARY_ID);
    const highlight = api.documentHighlights().find((h) => h.text === "fixture words");
    return { pages: api.currentPdfPageCount(), md: entry?.md || null, highlightPage: highlight?.page };
  }`);
  check("Take these pages out leaves the paper as it was, its highlight back on page 3", removed.pages === 3 && !removed.md && removed.highlightPage === 3, JSON.stringify(removed));

  // A picture in the markdown is put in the PDF.
  const picture = await page.evaluate(`async () => {
    const { api, settle, until } = window.__recall;
    const canvas = document.createElement("canvas");
    canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 120, 80);
    g.addColorStop(0, "#c33"); g.addColorStop(1, "#33c");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 120, 80);
    const src = canvas.toDataURL("image/png");
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="md-new"]').click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    const text = modal.querySelector("[data-md-text]");
    text.value = "# Pictures\\n\\n![a gradient](" + src + ")\\n\\nAfter the picture.";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(500);
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && /page/.test(modal.querySelector("[data-md-meter]").textContent), 30000);
    const out = await (await import("/src/documents/md-pdf/build.js?v=__BUILD__")).createMdPdfSession();
    const laid = await out.layout(text.value, {});
    const images = laid.flow.rows.flatMap((r) => r.ops.filter((o) => o.t === "image"));
    modal.querySelector('[data-md-action="cancel"]').click();
    return { images: images.length, w: images[0] ? Math.round(images[0].w) : 0 };
  }`);
  check("a picture in the markdown is laid out at its size", picture.images === 1 && picture.w === 90, JSON.stringify(picture));

  // A phone: the sheet fills the screen, one pane at a time.
  await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const phone = await page.evaluate(`async () => {
    const { settle, until } = window.__recall;
    document.getElementById("documentMoreBtn")?.click();
    await settle(150);
    document.querySelector('#documentMoreMenu [data-document-action="md-new"]').click();
    const modal = await until(() => { const m = document.getElementById("mdPdfModal"); return m && !m.hidden && m; });
    await settle(300);
    const sheet = modal.querySelector(".md-pdf-sheet").getBoundingClientRect();
    const preview = modal.querySelector(".md-pdf-preview");
    const tabs = modal.querySelector(".md-pdf-tabs");
    const result = {
      width: Math.round(sheet.width),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      tabs: getComputedStyle(tabs).display !== "none",
      previewHidden: getComputedStyle(preview).display === "none"
    };
    return result;
  }`);
  check("on a phone the sheet is the screen's width, with Markdown / Preview tabs", phone.width === 390 && phone.tabs && phone.previewHidden && !phone.overflow, JSON.stringify(phone));
  await shot("phone.png");
  const phonePreview = await page.evaluate(`async (markdown) => {
    const { settle, until } = window.__recall;
    const modal = document.getElementById("mdPdfModal");
    const text = modal.querySelector("[data-md-text]");
    modal.querySelector("[data-md-pages]").innerHTML = "";
    text.value = markdown;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    // Typed in the Markdown tab and laid out THERE first — the order a phone
    // is used in — and only then the Preview tab opened.
    await until(() => !modal.querySelector('[data-md-action="save"]').disabled && /page/.test(modal.querySelector("[data-md-meter]").textContent), 30000);
    await settle(300);
    const drawnWhileHidden = Boolean(modal.querySelector(".md-pdf-canvas"));
    modal.querySelector('[data-md-tab="preview"]').click();
    const canvas = await until(() => modal.querySelector(".md-pdf-canvas"), 30000);
    await settle(400);
    const box = canvas?.getBoundingClientRect();
    const page = modal.querySelector(".md-pdf-page")?.getBoundingClientRect();
    return {
      shown: Boolean(canvas),
      drawnWhileHidden,
      right: box ? Math.round(box.right) : 0,
      pageRight: page ? Math.round(page.right) : 0,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  }`, LONG);
  check("...and the Preview tab, opened after typing, shows the pages inside the screen", phonePreview.shown && phonePreview.right <= 390 && phonePreview.pageRight <= 390 && !phonePreview.overflow, JSON.stringify(phonePreview));
  check("...and no preview is drawn while the Markdown tab hides it", phonePreview.drawnWhileHidden === false, JSON.stringify(phonePreview));
  await shot("phone-preview.png");

  // Every break line between two rows' words, never across one.
  const lines = await page.evaluate(`async () => {
    const modal = document.getElementById("mdPdfModal");
    const host = modal.querySelector("[data-md-pages]").getBoundingClientRect();
    const cuts = [...modal.querySelectorAll(".md-pdf-cut")];
    return { count: cuts.length, tops: cuts.map((c) => c.getBoundingClientRect().top - host.top) };
  }`);
  check("...with its page breaks drawn", lines.count >= 1, JSON.stringify(lines));

  // A finger drags a break by its handle.
  const grip = await page.evaluate(`() => {
    const scroll = document.querySelector("[data-md-scroll]");
    const cut = document.querySelector(".md-pdf-cut");
    scroll.scrollTop = Math.max(0, cut.offsetTop - scroll.clientHeight / 2);
    const g = cut.querySelector(".md-pdf-cut-grip").getBoundingClientRect();
    return { x: g.x + g.width / 2, y: g.y + g.height / 2, key: cut.dataset.cutKey };
  }`);
  const touch = (x, y) => [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
  await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(grip.x, grip.y) });
  for (let i = 1; i <= 10; i += 1) {
    await page.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(grip.x, grip.y - i * 12) });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const dragged = await page.evaluate(`() => ({
    keys: [...document.querySelectorAll(".md-pdf-cut")].map((c) => c.dataset.cutKey),
    undo: !document.querySelector('[data-md-action="undo"]').disabled
  })`);
  check("a finger dragging a break's handle moves the break", !dragged.keys.includes(grip.key) && dragged.undo, JSON.stringify({ from: grip.key, ...dragged }));

  // Hindi: real text, not pictures — fast, small, and in the PDF's text.
  const hindi = await page.evaluate(`async (markdown) => {
    const { until } = window.__recall;
    const modal = document.getElementById("mdPdfModal");
    const text = modal.querySelector("[data-md-text]");
    modal.querySelector("[data-md-meter]").textContent = "";
    const t0 = performance.now();
    text.value = markdown;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    const meter = await until(() => /page/.test(modal.querySelector("[data-md-meter]").textContent) && modal.querySelector("[data-md-meter]").textContent, 60000);
    const ms = Math.round(performance.now() - t0);
    const session = (await import("/src/documents/md-pdf/build.js?v=__BUILD__")).createMdPdfSession();
    const laid = await session.layout(markdown, {});
    const ops = laid.flow.rows.flatMap((r) => r.ops);
    return {
      meter,
      ms,
      pictures: ops.filter((o) => o.t === "image").length,
      deva: ops.filter((o) => o.t === "text" && /^deva\|/.test(o.face)).length
    };
  }`, HINDI);
  const hindiKb = Number((hindi.meter || "").match(/(\d+) KB/)?.[1] || 1e9);
  check("Hindi is laid out as real text, not pictures of words", hindi.pictures === 0 && hindi.deva > 50, JSON.stringify(hindi));
  check("...and a long Hindi note makes a small PDF quickly", hindiKb < 150 && hindi.ms < 15000, JSON.stringify(hindi));
} catch (error) {
  check("the check ran to the end", false, error?.stack || String(error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
}

console.log(`CHECK: ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
