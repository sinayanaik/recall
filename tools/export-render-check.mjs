// Does what you see in the app come out in the file?
//
// The report: exported notes lost their pictures, the formatting changed on
// the way out, and a Canvas exported with things missing and things it should
// not have had, at the wrong size. Each of those had a cause in src/export/
// that no check could see, because nothing ever ran an export and looked
// inside the file:
//
//   - the notes and highlights PDFs never inlined a picture, and the bucket is
//     private, so a picture printed only if the service worker had it cached;
//   - a picture still waiting to upload (`recall-img:`) resolved nowhere;
//   - a region from a PDF was a live <canvas>, serialised empty;
//   - Word ignored a resized picture's width and every highlight's colour;
//   - the print frame dropped the reader's fonts;
//   - a Canvas page printed without its typed text and pictures, and its
//     highlights export pictured every pen stroke, blown up to 520px.
//
// So this builds each export the way the ⇓ menu does, stops short of the print
// dialog (which a headless browser cannot dismiss), and opens what it made.
//
//   node tools/export-render-check.mjs
//   SHOT_DIR=/some/dir node tools/export-render-check.mjs   # ...and keep a
//     screenshot of the notes PDF in each look, and the Word files

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources } from "./pdfjs-source.mjs";
import { HTMLTOIMAGE_VERSION, htmlToImageSource } from "./htmltoimage-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 5 * 60 * 1000;
const SHOT_DIR = process.env.SHOT_DIR || "";

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
    "/src/export/run.js?v=__BUILD__",
    "/src/export/pdf.js?v=__BUILD__",
    "/src/export/html.js?v=__BUILD__",
    "/src/export/notes-body.js?v=__BUILD__",
    "/src/export/docx.js?v=__BUILD__",
    "/src/export/images.js?v=__BUILD__",
    "/src/export/themes.js?v=__BUILD__",
    "/src/export/theme-dialog.js?v=__BUILD__",
    "/src/backup/zip-lite.js?v=__BUILD__",
    "/src/images/outbox.js?v=__BUILD__",
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/documents/pdf-blocks.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/notebook.js?v=__BUILD__",
    "/src/render/enhance.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
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
  window.__recall = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("export-render-check does not touch the database"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      list: async () => ({ data: [], error: null }),
      remove: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Export fixture", notesMode: true });
  await settle(400);
  // A dark app theme: the one whose colours must NOT reach white paper.
  document.documentElement.setAttribute("data-theme", "dark-amoled");
  // A reader's own face, set the way the style panel sets it — on <html>.
  document.documentElement.style.setProperty("--notes-font-family", '"Courier New", monospace');
  await settle(100);
  return true;
}`;

// Every kind of thing a note can hold that an export has to carry.
const NOTE_SRC = `async () => {
  const { api } = window.__recall;
  // A picture added offline: the bytes are in the outbox under a token, and
  // the note says recall-img:<token>.
  const png = await (await fetch("/icons/icon-192.png")).blob();
  await api.putOutboxImage({ token: "exportcheck1", blob: png, name: "offline.png", type: "image/png", at: Date.now() });
  return [
    "# Chapter one",
    "",
    "Some text with a <mark>yellow highlight</mark>, a <mark data-color=\\"green\\">green one</mark> and <span style=\\"color: #cc0000\\">red words</span>.",
    "",
    "## A section",
    "",
    "Inline maths $a^2 + b^2 = c^2$ in a sentence, and a picture ![inline](/icons/icon-192.png) in one too.",
    "",
    "$$\\\\int_0^1 x\\\\,dx = \\\\tfrac12$$",
    "",
    "### A subsection",
    "",
    "<img src=\\"/icons/icon-512.png\\" alt=\\"resized\\" class=\\"has-custom-size\\" style=\\"--notes-img-w:120px; width:120px\\">",
    "",
    "![offline](recall-img:exportcheck1)",
    "",
    "> A quote.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- [x] done",
    "- [ ] not yet",
    "",
    "\\u0060\\u0060\\u0060js",
    "const veryLongLineThatWouldRunOffThePrintedPage = 'x'.repeat(200) + 'and keeps going well past any margin';",
    "\\u0060\\u0060\\u0060"
  ].join("\\n");
}`;

const chrome = findChrome();
if (!chrome) { console.log("export-render-check: no Chrome on this machine — skipping."); process.exit(0); }

let pdfjs;
try {
  pdfjs = pdfjsSources();
} catch (error) {
  console.log(`export-render-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}
// Word's formulas and the Canvas's blocks are drawn by html-to-image. Without
// it those cases say so and the rest still run.
let htmlToImage = null;
try {
  htmlToImage = htmlToImageSource();
} catch (error) {
  console.log(`export-render-check: could not obtain html-to-image ${HTMLTOIMAGE_VERSION} (${error?.message || error}) — formula and block cases will be skipped.`);
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

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (htmlToImage) {
    await page.call("Page.addScriptToEvaluateOnNewDocument", { source: htmlToImage });
  }
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC, pdfjs.main, pdfjs.worker);
  const note = await page.evaluate(NOTE_SRC);
  await page.evaluate(`async (note) => {
    const { api, settle } = window.__recall;
    api.setViewMode("notes");
    await settle(200);
    api.state.notes = note;
    await api.renderNotesView();
    await settle(300);
  }`, note);

  // ── Notes → PDF, in each look ────────────────────────────────────────────
  //
  // exportNotesPdf up to printPreparedDocument: the same builder, the same
  // render, the same image step, then the HTML the print frame is given.
  const pdf = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const out = {};
    for (const theme of ["plain", "minimal", "fancy"]) {
      api.el.printRoot.innerHTML = api.buildNotesPrintDocument("Export fixture", api.notesForExport(), { theme });
      api.el.printRoot.classList.add("is-preparing");
      await api.enhanceRenderedMarkdown(api.el.printRoot);
      const failed = await api.prepareExportImages(api.el.printRoot, { mode: "pdf" });
      await settle(50);
      const root = api.el.printRoot;
      const h1 = root.querySelector(".rendered h1");
      const h3 = root.querySelector(".rendered h3");
      const doc = root.querySelector(".cornell-print-document");
      const pre = root.querySelector(".rendered pre");
      const imgs = [...root.querySelectorAll(".rendered img")];
      const resized = root.querySelector('img[alt="resized"]');
      out[theme] = {
        failed,
        classes: doc.className,
        srcs: imgs.map((img) => img.getAttribute("src").slice(0, 11)),
        imgCount: imgs.length,
        decoded: imgs.every((img) => img.complete && img.naturalWidth > 0),
        resizedWidth: resized ? Math.round(resized.getBoundingClientRect().width) : 0,
        h1Font: getComputedStyle(h1).fontFamily,
        h1Size: parseFloat(getComputedStyle(h1).fontSize),
        h3Size: parseFloat(getComputedStyle(h3).fontSize),
        h1Color: getComputedStyle(h1).color,
        bodyColor: getComputedStyle(root.querySelector(".rendered p")).color,
        redColor: getComputedStyle(root.querySelector('.rendered span[style*="color"]')).color,
        pageBg: getComputedStyle(doc).backgroundColor,
        preWraps: getComputedStyle(pre.querySelector("code") || pre).whiteSpace,
        frame: api.standalonePrintDocumentHtml()
      };
      root.innerHTML = "";
      root.classList.remove("is-preparing");
    }
    return out;
  }`);

  // What each look actually looks like: the print frame's own HTML, opened in
  // a second tab of the same server so its stylesheets resolve.
  if (SHOT_DIR) {
    for (const theme of ["plain", "minimal", "fancy"]) {
      const frame = pdf[theme].frame.replace(/<script>[^]*?<\/script>/, "");
      writeFileSync(path.join(ROOT, `.export-shot-${theme}.html`), frame);
      const shotPage = await openPage(client);
      await shotPage.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 1300, deviceScaleFactor: 1, mobile: false });
      await shotPage.goto(`${server.base}/.export-shot-${theme}.html`);
      await new Promise((r) => setTimeout(r, 1200));
      const { data } = await shotPage.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOT_DIR, `notes-pdf-${theme}.png`), Buffer.from(data, "base64"));
      await shotPage.call("Page.close").catch(() => {});
      rmSync(path.join(ROOT, `.export-shot-${theme}.html`), { force: true });
    }
  }

  for (const theme of ["plain", "minimal", "fancy"]) {
    const r = pdf[theme];
    check(`PDF (${theme}): the document wears its look`, r.classes.includes(`export-theme-${theme}`) && r.classes.includes("export-root"), r.classes);
    check(`PDF (${theme}): every picture is inside the file — none left at a storage, blob or pending address`,
      r.imgCount >= 3 && r.srcs.every((src) => src.startsWith("data:")) && r.failed === 0,
      `${r.imgCount} picture(s): ${r.srcs.join(", ")} · ${r.failed} not embedded`);
    check(`PDF (${theme}): ...and every one has decoded`, r.decoded);
    check(`PDF (${theme}): a resized picture keeps the width it was given`, r.resizedWidth === 120, `${r.resizedWidth}px`);
    check(`PDF (${theme}): on white paper, in dark ink, whatever the app's theme`,
      r.pageBg === "rgb(255, 255, 255)" && /^rgb\((\d+), (\d+), (\d+)\)$/.test(r.bodyColor)
        && r.bodyColor.match(/\d+/g).slice(0, 3).every((n) => Number(n) < 90),
      `page ${r.pageBg}, text ${r.bodyColor}`);
    check(`PDF (${theme}): long code wraps instead of running off the page`, r.preWraps === "pre-wrap", r.preWraps);
    check(`PDF (${theme}): the print frame keeps the reader's style settings and a white page`,
      r.frame.includes("--notes-font-family") && r.frame.includes("--print-bg: #ffffff"));
  }
  check("Plain sets a book face, and sizes headings by level",
    /Georgia/.test(pdf.plain.h1Font) && pdf.plain.h1Size > pdf.plain.h3Size,
    `${pdf.plain.h1Font} · h1 ${pdf.plain.h1Size}px, h3 ${pdf.plain.h3Size}px`);
  check("...Plain prints headings black",
    pdf.plain.h1Color === "rgb(17, 17, 17)", pdf.plain.h1Color);
  check("...and prints text the colour picker tinted in black, as Word does",
    pdf.plain.redColor === pdf.plain.bodyColor, `${pdf.plain.redColor} vs ${pdf.plain.bodyColor}`);
  check("...while Minimal and Fancy keep it", pdf.minimal.redColor === "rgb(204, 0, 0)" && pdf.fancy.redColor === "rgb(204, 0, 0)",
    `${pdf.minimal.redColor}, ${pdf.fancy.redColor}`);
  check("Minimal sets a sans face, and sizes headings by level",
    !/Georgia|Courier/.test(pdf.minimal.h1Font) && pdf.minimal.h1Size > pdf.minimal.h3Size,
    `${pdf.minimal.h1Font} · h1 ${pdf.minimal.h1Size}px, h3 ${pdf.minimal.h3Size}px`);
  check("Fancy uses the reader's own face from the style settings",
    /Courier/.test(pdf.fancy.h1Font), pdf.fancy.h1Font);
  check("...and keeps the heading colour the app gives h1",
    pdf.fancy.h1Color !== pdf.fancy.bodyColor, `h1 ${pdf.fancy.h1Color}, text ${pdf.fancy.bodyColor}`);

  // ── Notes → standalone HTML ──────────────────────────────────────────────
  const html = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const body = api.buildNotesExportBody("Export fixture", api.notesForExport());
    const { html, failedImageCount } = await api.prepareExportHtml(body);
    const file = await api.wrapStandaloneHtmlDocument(html, "Export fixture", { theme: "fancy" });
    const count = (needle) => file.split(needle).length - 1;
    return {
      failedImageCount,
      dataImages: count('src="data:image'),
      pending: count("recall-img:") + count("Waiting to upload") + count("data-local-token"),
      blobs: count('src="blob:'),
      themed: file.includes("export-theme-fancy") && file.includes("export-root"),
      styled: file.includes(".export-theme-fancy")
    };
  }`);
  check("HTML: every picture is inside the file", html.dataImages >= 3 && html.pending === 0 && html.blobs === 0 && html.failedImageCount === 0,
    `${html.dataImages} inlined · ${html.pending} pending · ${html.blobs} blob · ${html.failedImageCount} failed`);
  check("HTML: the file wears the chosen look, and carries its styles", html.themed && html.styled);

  // ── Notes → Word ─────────────────────────────────────────────────────────
  const docx = await page.evaluate(`async () => {
    const { api } = window.__recall;
    const out = {};
    for (const theme of ["plain", "minimal", "fancy"]) {
      const body = api.buildNotesExportBody("Export fixture", api.notesForExport());
      const { bytes, failedImageCount } = await api.buildDocxBytes(body, "Export fixture", { theme });
      const archive = await api.LiteZip.loadAsync(bytes);
      const read = (name) => archive.files[name] ? archive.files[name].async("string") : Promise.resolve("");
      const documentXml = await read("word/document.xml");
      const stylesXml = await read("word/styles.xml");
      const media = Object.keys(archive.files).filter((name) => name.startsWith("word/media/"));
      out[theme] = { failedImageCount, documentXml, stylesXml, media: media.length, hasHtmlToImage: Boolean(window.htmlToImage), base64: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")) };
    }
    return out;
  }`);
  if (SHOT_DIR) {
    for (const theme of ["plain", "minimal", "fancy"]) writeFileSync(path.join(SHOT_DIR, `notes-${theme}.docx`), Buffer.from(docx[theme].base64, "base64"));
  }
  const word = docx.minimal;
  const extents = [...word.documentXml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => Number(m[1]));
  check("Word: every picture is in the file", word.failedImageCount === 0 && word.media >= 3, `${word.media} media part(s), ${word.failedImageCount} failed`);
  check("Word: a resized picture keeps the width it was given (120px)", extents.includes(120 * 9525), `extents ${extents.map((e) => Math.round(e / 9525)).join(", ")}px`);
  check("Word: a picture never resized is capped at the width the Notes view shows it (420px)",
    extents.every((e) => e <= 420 * 9525), `widest ${Math.round(Math.max(...extents) / 9525)}px`);
  check("Word: highlights keep their colour — yellow and green",
    word.documentXml.includes('w:fill="F4E5A6"') && word.documentXml.includes('w:fill="B2ECCA"'));
  check("Word: coloured text keeps its colour", /<w:color w:val="CC0000"\/>/.test(word.documentXml));
  check("...but not in Plain, which prints black", !/<w:color w:val="CC0000"\/>/.test(docx.plain.documentXml));
  check("Word: a picture in a sentence gets its own centred line, as in the Notes view",
    /<w:t xml:space="preserve">Inline maths <\/w:t>[^]*?<\/w:p>\s*<w:p><w:pPr><w:spacing w:after="160"\/><w:jc w:val="center"\/><\/w:pPr><w:r><w:drawing>[^]*?<\/w:p>\s*<w:p>(<w:pPr>[^]*?<\/w:pPr>)?<w:r><w:t xml:space="preserve">in one too\.<\/w:t>/.test(word.documentXml));
  check("Word: a task list's boxes come through", word.documentXml.includes("\u2611") && word.documentXml.includes("\u2610"));
  if (word.hasHtmlToImage) {
    const formulas = (word.documentXml.match(/name="formula"/g) || []).length;
    const tex = word.documentXml.indexOf("a^2 + b^2");
    check("Word: maths is a picture of the formula, not its TeX", formulas >= 2 && tex === -1, `${formulas} formula picture(s)${tex === -1 ? "" : ` · TeX at …${word.documentXml.slice(Math.max(0, tex - 300), tex + 40)}`}`);
  } else {
    console.log("  skip  Word maths as pictures — html-to-image not available");
  }
  check("Word: rPr children are in schema order (no 'repair' prompt)",
    !/<w:rPr>[^]*?<w:u [^>]*\/>[^]*?<w:strike\/>/.test(word.documentXml)
      && !/<w:rPr><w:b\/>[^<]*<w:rFonts/.test(word.documentXml));
  check("Word: Plain is set in Georgia, Minimal and Fancy in Calibri",
    docx.plain.stylesXml.includes('w:ascii="Georgia"') && docx.minimal.stylesXml.includes('w:ascii="Calibri"') && docx.fancy.stylesXml.includes('w:ascii="Calibri"'));
  const h1Size = (xml) => Number((xml.match(/w:styleId="Heading1"[^]*?<w:sz w:val="(\d+)"\/>/) || [])[1]);
  const h3Size = (xml) => Number((xml.match(/w:styleId="Heading3"[^]*?<w:sz w:val="(\d+)"\/>/) || [])[1]);
  check("Word: Plain and Minimal size headings by level; Fancy keeps the app's one-size ladder",
    h1Size(docx.plain.stylesXml) > h3Size(docx.plain.stylesXml)
      && h1Size(docx.minimal.stylesXml) > h3Size(docx.minimal.stylesXml)
      && h1Size(docx.fancy.stylesXml) === h3Size(docx.fancy.stylesXml),
    `plain ${h1Size(docx.plain.stylesXml)}/${h3Size(docx.plain.stylesXml)}, minimal ${h1Size(docx.minimal.stylesXml)}/${h3Size(docx.minimal.stylesXml)}, fancy ${h1Size(docx.fancy.stylesXml)}/${h3Size(docx.fancy.stylesXml)}`);

  // ── The look is asked for, and remembered ────────────────────────────────
  const dialog = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.saveExportTheme("plain");
    const asked = api.askExportTheme({ title: "Export notes as PDF" });
    await settle(50);
    const modal = document.getElementById("exportThemeModal");
    const shown = !modal.hidden;
    const options = [...modal.querySelectorAll("input[type=radio]")].map((i) => i.value);
    const preselected = modal.querySelector("input:checked")?.value;
    const title = document.getElementById("exportThemeTitle").textContent;
    modal.querySelector('input[value="fancy"]').click();
    document.getElementById("exportThemeConfirmBtn").click();
    const chosen = await asked;
    const cancelled = api.askExportTheme();
    await settle(20);
    document.getElementById("exportThemeCancelBtn").click();
    return { shown, options, preselected, title, chosen, remembered: api.loadExportTheme(), cancelled: await cancelled, hiddenAfter: modal.hidden };
  }`);
  check("Exporting asks which look, with the last one already chosen",
    dialog.shown && dialog.options.join(",") === "plain,minimal,fancy" && dialog.preselected === "plain" && dialog.title === "Export notes as PDF",
    `${dialog.options.join(",")} · preselected ${dialog.preselected}`);
  check("...answers with the one picked, and remembers it", dialog.chosen === "fancy" && dialog.remembered === "fancy");
  check("...and Cancel exports nothing", dialog.cancelled === null && dialog.hiddenAfter);

  // ── The Canvas ───────────────────────────────────────────────────────────
  const canvas = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    document.querySelector('#viewModeToggle [data-view-mode="handwriting"]').click();
    await settle(250);
    document.querySelector("#documentView .pdf-missing-pick")?.click();
    for (let i = 0; i < 100 && !document.querySelector("#documentStage .pdf-page canvas.pdf-canvas"); i += 1) await settle(100);
    if (!api.currentPdfDocument()) return { error: "the Canvas did not open" };
    const pageEl = document.querySelector("#documentStage .pdf-page[data-page-number='1']");
    const box = pageEl.getBoundingClientRect();
    const view = document.getElementById("documentView");
    const pen = (t, x, y, b) => view.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, pointerType: "pen", isPrimary: true, clientX: x, clientY: y, buttons: b, pressure: 0.6 }));
    // Three separate strokes of handwriting.
    for (let s = 0; s < 3; s += 1) {
      pen("pointerdown", box.left + 60, box.top + 300 + s * 40, 1);
      for (let i = 1; i <= 10; i += 1) pen("pointermove", box.left + 60 + i * 12, box.top + 300 + s * 40 + (i % 2) * 6, 1);
      pen("pointerup", box.left + 180, box.top + 300 + s * 40, 0);
      await settle(250);
    }
    await settle(500);
    const inkMarks = (api.state.meta.pdfHighlights || []).filter((r) => r.kind === "ink" && r.doc === "notebook").length;

    // The page with no blocks...
    const without = await api.buildDocumentPrintDocument("Canvas", { annotatedOnly: false, theme: "minimal" });
    // ...and with a typed block on it.
    const made = api.addDocumentBlock(1, { x: 80, y: 120 });
    api.commitBlockEdit();
    await settle(200);
    const record = (api.state.meta.pdfBlocks || []).find((b) => b.id === made?.id);
    if (record) { record.md = "# TYPED ON THE CANVAS\\n\\nA block of words, **bold** and plain, that the page export has to draw."; record.w = 300; record.h = 160; }
    const withBlock = await api.buildDocumentPrintDocument("Canvas", { annotatedOnly: false, theme: "minimal" });
    const pageImage = (html) => (html.match(/<img src="(data:image[^"]+)" alt="Page 1">/) || [])[1];
    const pixels = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const a = await pixels(pageImage(without));
    const b = await pixels(pageImage(withBlock));
    let changed = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) changed += 1;
    }
    const items = api.collectDeckHighlightsForExport({});
    return {
      inkMarks,
      blockMade: Boolean(record),
      changed,
      themed: withBlock.includes("export-theme-minimal"),
      inkItems: items.filter((item) => item.region && item.region.kind === "ink").length
    };
  }`);
  if (canvas.error) {
    check("the Canvas opened", false, canvas.error);
  } else {
    check("the Canvas fixture has handwriting on it", canvas.inkMarks >= 1, `${canvas.inkMarks} ink mark(s)`);
    if (htmlToImage && canvas.blockMade) {
      check("Canvas PDF: a typed block on the page is drawn onto the exported page",
        canvas.changed > 400, `${canvas.changed} pixel(s) differ with the block`);
    } else {
      console.log(`  skip  Canvas blocks on the exported page — ${htmlToImage ? "no block was made" : "html-to-image not available"}`);
    }
    check("Canvas PDF: the page export wears the chosen look", canvas.themed);
    check("Canvas highlights: handwriting with no note on it is not exported as dozens of pictures",
      canvas.inkItems === 0, `${canvas.inkItems} ink item(s)`);
  }
} catch (error) {
  check("the check itself", false, String(error?.stack || error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
}

console.log(`\n${ran} checks · ${failures} failed`);
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
