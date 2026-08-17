// Render an EPUB exactly the way the app's import pipeline would — the real
// parseEpub*/planEpubChapters/convertEpubChapters code running in a real
// browser against the real app — and dump each chapter's Markdown and rendered
// HTML for inspection.
//
//   node tools/epub-preview-check.mjs <file.epub> [more.epub…] [--out dir]
//
// The point is fidelity: this is NOT a reimplementation. The page boots the
// app, dynamic-imports src/import/epub.js and src/render/*, and runs the same
// functions importEpubFile runs, minus the network (images resolve to the
// preview's inert markers; the CDN is cut and the libraries the pipeline needs
// are injected from the clipper's vendored copies + a cached jszip).
//
// Prints corruption indicators per chapter (TeX leaked outside math spans,
// MathML glyph-soup characters, KaTeX errors) so a broken run stands out
// without anyone opening the dump files.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : "/tmp/epubtest/out";
const epubs = args.filter((a, i) => a.endsWith(".epub") && (outIdx === -1 || i !== outIdx + 1));

if (!epubs.length) {
  console.error("usage: node tools/epub-preview-check.mjs <file.epub>… [--out dir]");
  process.exit(2);
}

const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);

function loadPuppeteer() {
  const candidates = [
    ROOT,
    "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/",
    "/usr/lib/node_modules/@mermaid-js/mermaid-cli/"
  ];
  for (const base of candidates) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}

const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) {
  console.error("epub-preview-check: needs puppeteer and Chrome (see tools/boot-check.mjs).");
  process.exit(1);
}

// Libraries the pipeline touches, in evaluation order. turndown's gfm plugin
// must come after turndown itself; jszip is the one lib the clipper does not
// vendor, cached once at /tmp/epubtest/jszip.min.js.
const LIBS = [
  path.join(ROOT, "recall-clipper/vendor/marked.min.js"),
  path.join(ROOT, "recall-clipper/vendor/purify.min.js"),
  path.join(ROOT, "recall-clipper/vendor/turndown.js"),
  path.join(ROOT, "recall-clipper/vendor/turndown-plugin-gfm.js"),
  path.join(ROOT, "recall-clipper/vendor/katex/katex.min.js"),
  path.join(ROOT, "recall-clipper/vendor/katex/auto-render.min.js"),
  "/tmp/epubtest/jszip.min.js"
].filter(existsSync);

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const server = await serveOn(ROOT);
const browser = await puppeteer.launch({
  headless: "new",
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

try {
  const page = await browser.newPage();
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
  for (const lib of LIBS) await page.evaluateOnNewDocument(readFileSync(lib, "utf8"));
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.message}`));

  await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("app-booting"),
    { timeout: 30000 }
  );

  for (const epubPath of epubs) {
    const slug = path.basename(epubPath, ".epub").replace(/[^\w-]+/g, "-").slice(0, 80);
    const bytes = readFileSync(epubPath).toString("base64");
    const result = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const epub = await import("/src/import/epub.js?v=__BUILD__");
      const pre = await import("/src/render/preprocess.js?v=__BUILD__");
      const enh = await import("/src/render/enhance.js?v=__BUILD__");

      const zip = await JSZip.loadAsync(bytes);
      const opf = await epub.parseEpubContainer(zip);
      const pkg = await epub.parseEpubPackage(zip, opf);
      const tocEntries = await epub.parseEpubToc(zip, pkg);
      const markers = epub.planEpubChapters(pkg.spine, tocEntries);
      await epub.resolveEpubMarkerTitles(zip, pkg.spine, markers);
      const imageEntries = Array.from(pkg.manifest.values()).filter((e) => e.mediaType.startsWith("image/"));
      const chapters = await epub.convertEpubChaptersForPreview(zip, pkg.spine, markers, imageEntries);

      const out = [];
      for (const chapter of chapters) {
        const host = document.createElement("div");
        let renderError = "";
        try {
          host.innerHTML = pre.markdownToSafeHtml(chapter.markdown || "");
          await enh.enhanceRenderedMarkdown(host);
        } catch (error) {
          renderError = String(error && error.message || error);
        }
        out.push({ title: chapter.title, markdown: chapter.markdown, html: host.innerHTML, renderError });
      }
      return {
        book: pkg.title, author: pkg.author,
        spineCount: pkg.spine.length, tocCount: tocEntries.length,
        markerCount: markers.length, imageCount: imageEntries.length,
        chapters: out
      };
    }, bytes);

    const dir = path.join(OUT, slug);
    mkdirSync(dir, { recursive: true });
    console.log(`\n══ ${path.basename(epubPath)}`);
    console.log(`   book: "${result.book}" by ${result.author || "?"}`);
    console.log(`   spine: ${result.spineCount}, toc entries: ${result.tocCount}, markers/chapters: ${result.markerCount}/${result.chapters.length}, images: ${result.imageCount}`);

    // Corruption indicators. MATHGLYPH_RE = Unicode Mathematical Alphanumeric
    // Symbols (the 𝛕 𝐪 𝟎 of serialized MathML) — they should never survive
    // into Markdown. TEX_LEAK counts TeX control words OUTSIDE $…$/$$…$$
    // spans, the signature of an <annotation> leaking as prose.
    const MATHGLYPH_RE = /[\uD835-\uD837]/g;
    let bookProblems = 0;
    result.chapters.forEach((ch, i) => {
      const noMath = ch.markdown.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "");
      const texLeaks = noMath.match(/\\[a-zA-Z]{2,}/g) || [];
      const glyphs = (ch.markdown.match(MATHGLYPH_RE) || []).length;
      const inlineMath = (ch.markdown.match(/\$[^$\n]+\$/g) || []).length;
      const displayMath = (ch.markdown.match(/\$\$/g) || []).length / 2;
      const katex = (ch.html.match(/class="katex"/g) || []).length;
      const katexErr = (ch.html.match(/katex-error/g) || []).length;
      const imgs = (ch.html.match(/<img/g) || []).length;
      const words = ch.markdown.split(/\s+/).length;

      const flags = [];
      if (texLeaks.length) flags.push(`TeX-leak×${texLeaks.length} (e.g. ${texLeaks.slice(0, 3).join(" ")})`);
      if (glyphs) flags.push(`mathglyph×${glyphs}`);
      if (katexErr) flags.push(`katex-error×${katexErr}`);
      if (ch.renderError) flags.push(`render: ${ch.renderError}`);
      if (flags.length) bookProblems += flags.length;

      console.log(`   [${String(i + 1).padStart(2, "0")}] ${ch.title.slice(0, 60)}`);
      console.log(`       words:${words} math:${inlineMath}+${displayMath}disp katex:${katex} img:${imgs}${flags.length ? "  ⚠ " + flags.join(" | ") : ""}`);

      const num = String(i + 1).padStart(2, "0");
      writeFileSync(path.join(dir, `${num}.md`), ch.markdown);
      writeFileSync(path.join(dir, `${num}.html`), ch.html);
    });
    console.log(`   → dumped to ${dir}  (${bookProblems ? "⚠ problems found" : "clean"})`);
  }
  if (pageErrors.length) console.log("\npage errors:\n  " + pageErrors.slice(0, 5).join("\n  "));
} finally {
  await browser.close();
  server.proc.kill();
}
