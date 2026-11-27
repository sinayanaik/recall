// The offline viewer inside a backup, opened the way a person opens it: the
// zip extracted into a folder and index.html double-clicked — a file://
// address, no server, no network, no Recall.
//
//   node tools/backup-viewer-check.mjs
//   VIEWER_SHOTS=<dir> node tools/backup-viewer-check.mjs   (and pictures of it)
//
// The viewer is written in the app (src/backup/viewer-pack.js) through the
// app's own Markdown pipeline (src/backup/viewer-render.js), so this builds one
// IN the app — math, code, a cloze, a highlight with a note, a picture, cards,
// a Canvas with pen, a shape, a connector and a Block, a PDF — zips it with the
// app's own writer, unzips it on disk and opens it from there. Then the server
// that served the picture is stopped, so a picture that still shows is one the
// backup holds.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 180000;
const SHOTS = process.env.VIEWER_SHOTS || "";

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

// Runs in the app page: a file's worth of everything, through the real
// viewer writer, into a zip. Returns the zip as base64.
const BUILD_SRC = `async (base) => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && (typeof marked === "undefined" || typeof DOMPurify === "undefined" || typeof katex === "undefined"); i += 1) await settle(50);
  const pack = await import("/src/backup/viewer-pack.js?v=__BUILD__");
  const render = await import("/src/backup/viewer-render.js?v=__BUILD__");
  const { LiteZip } = await import("/src/backup/zip-lite.js?v=__BUILD__");
  const { encodeInkStrokes } = await import("/src/format/ink-strokes.js?v=__BUILD__");
  const picture = base + "/icons/icon-192.png";
  const pictureBlob = await (await fetch(picture)).blob();
  const zip = new LiteZip();
  const written = [];
  const addText = async (file, text) => { zip.file(file, text); written.push(file); };
  const addBlob = async (file, blob) => { zip.file(file, blob); written.push(file); };
  // What the images and PDFs passes would have packed.
  zip.file("assets/Cells--a1/0001-icon.png", pictureBlob);
  const pdfBytes = await (await fetch(base + "/tools/viewer-fixture.pdf")).blob().catch(() => null);
  if (pdfBytes) zip.file("documents/Cells--a1/paper.pdf", pdfBytes);
  const stroke = [];
  for (let i = 0; i <= 30; i += 1) stroke.push(100 + i * 5, 700 + Math.sin(i / 3) * 20, 0.6);
  const notes = [
    "# Cell division",
    "",
    "Mitosis makes two cells. Energy: $E = mc^2$ and",
    "",
    "$$\\\\int_0^1 x^2\\\\,dx = \\\\frac{1}{3}$$",
    "",
    "## The phases",
    "",
    "The first phase is {{prophase}}, then metaphase.",
    "",
    '<mark data-color="yellow" data-note="hn-abc123">Spindle fibres pull</mark> the chromatids apart.',
    "",
    "![a cell](" + picture + ")",
    "",
    "\`\`\`js",
    "const phases = ['pro', 'meta'];",
    "\`\`\`",
    "",
    "<!--recall:highlight-notes-->",
    "<!--hn:hn-abc123 Spindle fibres pull-->",
    "They attach at the kinetochore.",
    "<!--/recall:highlight-notes-->"
  ].join("\\n");
  const snapshot = {
    deckTitle: "Cells",
    deckCategory: "Biology/Year 1",
    updatedAt: "2026-11-01T10:00:00.000Z",
    notes,
    cards: [
      { id: "c1", question: "What does **mitosis** make?", answer: "Two identical cells", status: "known" },
      { id: "c2", question: "First phase?", answer: "Prophase", status: "review" },
      { id: "c3", question: "Picture card ![x](" + picture + ")", answer: "An icon", status: null }
    ],
    meta: {
      pdf: { name: "paper.pdf", pages: 1, sha256: "x" },
      notebook: { name: "Canvas", pages: 2, paper: "grid", notebook: true },
      pdfHighlights: [
        { id: "h1", page: 1, kind: "text", color: "green", text: "A highlighted sentence", note: "my note on the PDF" },
        { id: "i1", page: 1, doc: "notebook", kind: "ink", ink: { v: 1, s: encodeInkStrokes([{ w: 2, c: "ink", p: stroke }]) } },
        { id: "s1", page: 1, doc: "notebook", kind: "shape", shape: { type: "rect", p: [[300, 600], [420, 520]], stroke: "#2563eb", width: 2, text: "" } },
        { id: "s2", page: 1, doc: "notebook", kind: "shape", shape: { type: "arrow", p: [[200, 500], [300, 560]], stroke: "#dc2626", width: 2, heads: ["none", "filled"] } },
        { id: "s3", page: 2, doc: "notebook", kind: "shape", shape: { type: "text", p: [[80, 760], [260, 730]], text: "Typed words on page two", font: { size: 14 } } }
      ],
      pdfBlocks: [
        { id: "b1", doc: "notebook", page: 1, x: 80, y: 380, w: 200, h: 80, kind: "md", md: "**A Block** with $x^2$" },
        { id: "b2", doc: "notebook", page: 1, x: 320, y: 300, w: 120, h: 80, kind: "md", md: "Decide", style: { shape: "diamond", fill: "yellow" } },
        { id: "b3", doc: "notebook", page: 2, x: 300, y: 500, w: 100, h: 100, kind: "image", src: picture }
      ]
    }
  };
  const entries = [{ snapshot, deckFile: "decks/Biology/Year 1/Cells-a1.json", title: "Cells" },
    { snapshot: { deckTitle: "Empty one", deckCategory: "", notes: "", cards: [], meta: {} }, deckFile: "decks/Empty-b2.json", title: "Empty one" }];
  const result = await pack.packOfflineViewer({
    entries,
    packed: { assets: [{ url: picture, file: "assets/Cells--a1/0001-icon.png" }], missing: [], missingExternal: [] },
    documents: { documents: pdfBytes ? [{ deckFile: "decks/Biology/Year 1/Cells-a1.json", slot: "doc", pdfId: "primary", file: "documents/Cells--a1/paper.pdf", pages: 1 }] : [], missing: [] },
    addText, addBlob,
    renderer: render.createAppViewerRenderer(),
    title: "Viewer check", kind: "library", exportedAt: new Date().toISOString(), folders: ["Biology/Year 1", "Empty folder"]
  });
  const bytes = await zip.generateAsync({ type: "uint8array" });
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ok: result.ok, renderer: result.renderer, math: result.math, appCss: result.appCss, katexFiles: result.katexFiles, written, zip: btoa(bin) };
}`;

const chrome = findChrome();
if (!chrome) { console.log("backup-viewer-check: no Chrome on this machine — skipping."); process.exit(0); }

const work = mkdtempSync(path.join(tmpdir(), "recall-viewer-"));
// A one-page PDF for the PDFs part, made by the app's own blank-paper writer
// would need the app; any small valid PDF does.
const fixturePdf = path.join(ROOT, "tools/viewer-fixture.pdf");
const madeFixture = !existsSync(fixturePdf);
if (madeFixture) {
  const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  writeFileSync(fixturePdf, pdf);
}

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome, ["--allow-file-access-from-files"], { windowSize: "1280,900" });
const client = await connect(launched.wsUrl);
const page = await openPage(client);

function cleanup() {
  try { client.close(); } catch (_) { /* gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* gone */ }
  if (madeFixture) rmSync(fixturePdf, { force: true });
  rmSync(work, { recursive: true, force: true });
}

const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  cleanup();
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let ran = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `  ${detail}` : ""}`);
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.goto(`${server.base}/index.html`);
  const built = await page.evaluate(BUILD_SRC, server.base);
  check("the viewer is written in the app, with the app's renderer", built.ok && built.renderer === "app", JSON.stringify({ ok: built.ok, renderer: built.renderer }));
  check("math in a file brings KaTeX's stylesheet and fonts", built.math && built.katexFiles > 0 && built.written.includes("viewer/katex/katex.min.css"), JSON.stringify({ math: built.math, fonts: built.katexFiles }));
  check("Recall's own content stylesheets are copied in", built.appCss && built.written.includes("viewer/recall-content.css"));
  for (const file of ["index.html", "viewer/recall-viewer.js", "viewer/recall-viewer.css", "viewer/library.js", "viewer/files/0001.js", "viewer/files/0002.js"]) {
    check(`the package holds ${file}`, built.written.includes(file));
  }

  // Unzip on disk, as a person would, and stop the server.
  const zipPath = path.join(work, "backup.zip");
  writeFileSync(zipPath, Buffer.from(built.zip, "base64"));
  const dir = path.join(work, "extracted");
  mkdirSync(dir);
  execFileSync("unzip", ["-q", zipPath, "-d", dir]);
  server.proc.kill("SIGKILL");
  const indexUrl = pathToFileURL(path.join(dir, "index.html")).href;

  await page.goto(indexUrl);
  await settle(300);
  const home = await page.evaluate(`() => ({
    title: document.querySelector(".rv-top h1")?.textContent || "",
    files: Array.from(document.querySelectorAll(".rv-file .rv-file-title")).map((n) => n.textContent),
    folders: Array.from(document.querySelectorAll(".rv-folder > summary")).map((n) => n.textContent),
    boot: Boolean(document.querySelector(".rv-boot"))
  })`);
  check("index.html opens from disk and lists the files", !home.boot && home.files.includes("Cells") && home.files.includes("Empty one"), JSON.stringify(home));
  check("the folder tree is there, empty folders too", home.folders.some((f) => f.includes("Biology")) && home.folders.some((f) => f.includes("Year 1")) && home.folders.some((f) => f.includes("Empty folder")), JSON.stringify(home.folders));
  await shot("1-home");

  const search = await page.evaluate(`async () => {
    const input = document.querySelector(".rv-search");
    input.value = "identical";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 100));
    const hits = Array.from(document.querySelectorAll(".rv-file .rv-file-title")).map((n) => n.textContent);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    return hits;
  }`);
  check("search finds a file by a card's words", search.length === 1 && search[0] === "Cells", JSON.stringify(search));

  await page.evaluate(`() => document.querySelector('.rv-file[data-file="0001"]').click()`);
  await page.waitFor(`() => Boolean(document.querySelector('[data-pane="notes"] .rv-rendered'))`, { label: "the Notes" });
  await settle(400);
  const notes = await page.evaluate(`async () => {
    const body = document.querySelector('[data-pane="notes"] .rv-rendered');
    const img = body.querySelector("img");
    const cloze = body.querySelector(".cloze");
    const before = cloze ? getComputedStyle(cloze).color : "";
    cloze?.click();
    // The reveal is a short colour transition.
    await new Promise((r) => setTimeout(r, 400));
    const after = cloze ? getComputedStyle(cloze).color : "";
    const mark = body.querySelector("mark[data-note]");
    mark?.click();
    const pop = document.querySelector(".rv-pop")?.textContent || "";
    return {
      tabs: Array.from(document.querySelectorAll(".rv-tab")).map((n) => n.dataset.part),
      katex: body.querySelectorAll(".katex").length,
      katexFont: body.querySelector(".katex") ? getComputedStyle(body.querySelector(".katex")).fontFamily : "",
      prism: body.querySelectorAll("pre code .token").length,
      img: img ? img.getAttribute("src") : "",
      imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
      clozeRevealed: cloze ? cloze.classList.contains("is-revealed") && before !== after : false,
      clozeDebug: cloze ? cloze.outerHTML + " " + before + " → " + after : "no cloze",
      pop,
      toc: document.querySelectorAll(".rv-toc a").length,
      tail: body.textContent.includes("hn:")
    };
  }`);
  check("a file shows the parts it has", JSON.stringify(notes.tabs) === JSON.stringify(["cards", "notes", "pdfs", "canvas"]), JSON.stringify(notes.tabs));
  check("Notes render their math with KaTeX, in KaTeX's own font", notes.katex >= 2 && /KaTeX/.test(notes.katexFont), JSON.stringify({ katex: notes.katex, font: notes.katexFont }));
  check("code is highlighted", notes.prism > 0, String(notes.prism));
  check("a picture is the copy inside the backup, and loads with no server", notes.img === "assets/Cells--a1/0001-icon.png" && notes.imgLoaded, JSON.stringify({ src: notes.img, loaded: notes.imgLoaded }));
  check("a cloze reveals on a click", notes.clozeRevealed, notes.clozeDebug);
  check("a highlight's note shows on a click", /kinetochore/.test(notes.pop), notes.pop);
  check("the contents list the headings", notes.toc >= 2, String(notes.toc));
  check("the highlight notes' storage block is not shown as text", !notes.tail);
  await shot("2-notes");

  await page.evaluate(`() => document.querySelector('.rv-tab[data-part="cards"]').click()`);
  await page.waitFor(`() => Boolean(document.querySelector('[data-pane="cards"] .rv-card'))`, { label: "the Cards" });
  const cards = await page.evaluate(`async () => {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = document.querySelectorAll('[data-pane="cards"] .rv-card').length;
    const bold = Boolean(document.querySelector('[data-pane="cards"] .rv-card-q strong'));
    const cardImg = document.querySelector('[data-pane="cards"] .rv-card img')?.getAttribute("src") || "";
    document.querySelector('[data-pane="cards"] [data-mode="study"]').click();
    await settle(50);
    const hidden = !document.querySelector('[data-study] .rv-card-a');
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await settle(50);
    const shown = document.querySelector('[data-study] .rv-card-a')?.textContent || "";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle(50);
    const second = document.querySelector('[data-study] .rv-card-q')?.textContent || "";
    return { list, bold, cardImg, hidden, shown, second };
  }`);
  check("Cards list every card, rendered", cards.list === 3 && cards.bold, JSON.stringify(cards));
  check("a card's picture comes from the backup", cards.cardImg === "assets/Cells--a1/0001-icon.png", cards.cardImg);
  check("Study shows the question, Space the answer, → the next card", cards.hidden && /identical/.test(cards.shown) && /First phase/.test(cards.second), JSON.stringify(cards));
  await shot("3-study");

  await page.evaluate(`() => document.querySelector('.rv-tab[data-part="pdfs"]').click()`);
  await settle(200);
  const pdfs = await page.evaluate(`() => ({
    frame: document.querySelector('[data-pane="pdfs"] iframe')?.getAttribute("src") || "",
    marks: Array.from(document.querySelectorAll('[data-pane="pdfs"] .rv-mark')).map((n) => n.textContent)
  })`);
  check("a PDF opens from the backup's documents folder", pdfs.frame.startsWith("documents/Cells--a1/paper.pdf"), pdfs.frame);
  check("the PDF's highlights and their notes are listed by page", pdfs.marks.length === 1 && /page 1/.test(pdfs.marks[0]) && /my note on the PDF/.test(pdfs.marks[0]), JSON.stringify(pdfs.marks));

  await page.evaluate(`() => document.querySelector('.rv-tab[data-part="canvas"]').click()`);
  await settle(400);
  const canvas = await page.evaluate(`() => {
    const pages = Array.from(document.querySelectorAll('[data-pane="canvas"] .rv-page'));
    const first = pages[0];
    const ink = first?.querySelector(".viewer-ink path");
    const paperLines = first?.querySelectorAll(".viewer-paper path").length || 0;
    const block = Array.from(first?.querySelectorAll(".rv-box") || []).find((n) => /A Block/.test(n.textContent));
    const diamond = first?.querySelector(".rv-box.is-shaped svg path");
    const pic = pages[1]?.querySelector(".rv-box.is-picture img");
    const words = pages[1]?.querySelector(".rv-words")?.textContent || "";
    const r = first?.getBoundingClientRect();
    const br = block?.getBoundingClientRect();
    return {
      pages: pages.length, ink: Boolean(ink), paperLines,
      // Each shape in its own <g data-shape-id> (src/export/canvas-data.js names them so).
      shapes: first?.querySelectorAll("svg.viewer-page-svg > path, svg.viewer-page-svg > g[data-shape-id] > path").length || 0,
      block: Boolean(block), blockMath: Boolean(block?.querySelector(".katex")),
      blockInside: Boolean(r && br && br.left >= r.left && br.right <= r.right && br.top >= r.top && br.bottom <= r.bottom),
      diamond: Boolean(diamond),
      pic: pic ? pic.getAttribute("src") : "", picLoaded: pic ? pic.complete && pic.naturalWidth > 0 : false,
      words,
      numbers: Array.from(document.querySelectorAll(".rv-page-number")).map((n) => n.textContent)
    };
  }`);
  check("the Canvas shows every page, on its paper", canvas.pages === 2 && canvas.paperLines > 0, JSON.stringify(canvas));
  check("pen strokes are drawn", canvas.ink);
  check("shapes and connectors are drawn", canvas.shapes >= 2, String(canvas.shapes));
  check("a Block sits on its page, its math rendered", canvas.block && canvas.blockMath && canvas.blockInside, JSON.stringify(canvas));
  check("a diagram Block is drawn in its outline", canvas.diamond);
  check("a Picture on a page is the backup's copy", canvas.pic === "assets/Cells--a1/0001-icon.png" && canvas.picLoaded, JSON.stringify({ pic: canvas.pic, loaded: canvas.picLoaded }));
  check("typed words on a page are there", /Typed words/.test(canvas.words), canvas.words);
  check("pages are numbered k / n", JSON.stringify(canvas.numbers) === JSON.stringify(["1 / 2", "2 / 2"]), JSON.stringify(canvas.numbers));
  await shot("4-canvas");

  const split = await page.evaluate(`async () => {
    const select = document.querySelector("[data-beside]");
    select.value = "notes";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 300));
    return { split: document.querySelector(".rv-body")?.classList.contains("is-split"), panes: Array.from(document.querySelectorAll("[data-pane]")).map((n) => n.dataset.pane), hash: location.hash };
  }`);
  check("two parts side by side", split.split && JSON.stringify(split.panes) === JSON.stringify(["canvas", "notes"]), JSON.stringify(split));
  check("the address keeps the place", /file=0001/.test(split.hash) && /part=canvas/.test(split.hash) && /beside=notes/.test(split.hash), split.hash);
  await shot("5-side-by-side");

  await page.goto("about:blank");
  await page.goto(indexUrl + "#file=0001&part=notes");
  await settle(400);
  const reopened = await page.evaluate(`() => document.querySelector(".rv-tab[aria-selected='true']")?.dataset.part || ""`);
  check("opening the saved address goes straight back there", reopened === "notes", reopened);

  const dark = await page.evaluate(`async () => {
    const select = document.querySelector('.rv-select[aria-label="Theme"]');
    select.value = "dark-graphite";
    select.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 50));
    return { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor };
  }`);
  check("a dark theme can be picked", dark.theme === "dark-graphite" && dark.bg !== "rgb(244, 242, 236)", JSON.stringify(dark));
  await shot("6-dark");

  // The page opened from inside the zip without extracting: no viewer/ beside it.
  const lonely = path.join(work, "lonely");
  mkdirSync(lonely);
  writeFileSync(path.join(lonely, "index.html"), readFileSync(path.join(dir, "index.html")));
  await page.goto(pathToFileURL(path.join(lonely, "index.html")).href);
  await settle(200);
  const lone = await page.evaluate(`() => document.body.textContent`);
  check("index.html alone says to extract the whole backup", /Extract \(unzip\) the whole backup/.test(lone));
} catch (error) {
  check("the check ran to the end", false, String(error?.stack || error));
} finally {
  clearTimeout(watchdog);
  cleanup();
}

console.log(`\n  ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
