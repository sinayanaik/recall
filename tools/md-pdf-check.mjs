// Markdown → PDF (src/documents/md-pdf/): the layout, the page breaks, the
// bytes, the markdown kept in the file, and pages spliced into another PDF.
//
//   node tools/md-pdf-check.mjs
//
// No browser: the modules are pure, and pdf-lib, fontkit and the fonts are the
// versions the app loads, from npm (tools/pdflib-source.mjs,
// tools/fontkit-source.mjs). What comes out is read back with the pdf.js the
// app ships (tools/pdfjs-source.mjs) — the text, the bookmarks, the links —
// because "the PDF has real text" means a PDF reader finds it.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdflibSource } from "./pdflib-source.mjs";
import { fontkitSource, fontFile } from "./fontkit-source.mjs";
import { patchedPdfjsWorkerPath, pdfjsSources } from "./pdfjs-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// preprocess.js reaches the DOM through modules it imports, at load only.
globalThis.document = new Proxy({}, { get() { return () => null; } });
globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const load = (src) => {
  const m = { exports: {} };
  new Function("module", "exports", "self", "globalThis", "window", src)(m, m.exports, {}, {}, {});
  return m.exports;
};
const PDFLib = load(pdflibSource());
const fontkit = load(fontkitSource());
const { marked } = load(readFileSync(path.join(ROOT, "vendor/marked-14.1.2/marked.min.js"), "utf8"));
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const pre = await mod("src/render/preprocess.js");
const fc = await mod("src/documents/md-pdf/fonts-core.js");
const L = await mod("src/documents/md-pdf/layout.js");
const B = await mod("src/documents/md-pdf/breaks.js");
const W = await mod("src/documents/md-pdf/writer.js");
const P = await mod("src/documents/md-pdf/parts.js");
const A = await mod("src/documents/md-pdf/anchors.js");
const { woffToSfnt } = await mod("src/documents/md-pdf/woff.js");
// As md-pdf/fonts.js does in the browser: fontkit's Indic shaper needs it.
fc.installRegeneratorShim(globalThis);

pdfjsSources();
const require = createRequire(import.meta.url);
// (pdf.js warns at load that it cannot draw without node-canvas: this check
// only reads text, bookmarks and links, so that is expected.)
const pdfjs = require("/tmp/recall-pdfjs/package/legacy/build/pdf.min.js");
// The worker as the app runs it (src/core/pdfjs-patches.js): a half form or a
// conjunct has its width, and every item says where its characters are.
pdfjs.GlobalWorkerOptions.workerSrc = patchedPdfjsWorkerPath();
// How the reader puts a Recall export's Hindi back in typed order
// (src/documents/pdf-selection.js), loaded with its browser-only imports
// stubbed — as tools/pdf-text-probe.mjs loads it.
const readingRules = await import(`data:text/javascript;base64,${Buffer.from(
  readFileSync(path.join(ROOT, "src/documents/pdf-selection.js"), "utf8").replace(/^import .*$/gm, "")
  + "\nfunction stripInvalidUnicode(value) { return value; }\nfunction pdfPageElement() { return null; }\nfunction pdfPageViewport() { return null; }\n"
).toString("base64")}`);

const results = [];
async function must(name, fn) {
  try {
    const answer = await fn();
    results.push([answer === true, name, answer === true ? "" : String(answer)]);
  } catch (error) {
    results.push([false, name, error?.stack || String(error)]);
  }
}

const inflate = async (bytes) => new Uint8Array(zlib.inflateSync(bytes));
const fontCache = new Map();
async function faceBytes(face) {
  if (!fontCache.has(face)) {
    const woff = fontFile(fc.facePath(face));
    fontCache.set(face, woff ? await woffToSfnt(woff, inflate) : null);
  }
  return fontCache.get(face);
}

// The same steps md-pdf/build.js takes in the browser, minus the pictures.
async function build(markdown, options = {}, { cuts = null, part = null, defer = false } = {}) {
  const o = L.normalizeMdPdfOptions(options);
  const blocks = L.blocksFromTokens(marked.lexer(pre.preprocessSpecialBlocks(markdown)));
  const needs = L.collectNeeds(blocks);
  const faces = new Set();
  for (const t of needs.text) fc.facesNeeded(t.text, t.family === "body" ? o.font : t.family, t.bold, t.italic, faces);
  const bytes = new Map();
  const fonts = new Map();
  for (const face of faces) {
    const b = await faceBytes(face);
    if (b) { bytes.set(face, b); fonts.set(face, fontkit.create(b)); }
  }
  const fontSet = fc.createFontSet(fonts);
  const flow = L.layoutMarkdown({ blocks, fontSet, options: o, geometry: L.pageGeometry(o) });
  const plan = B.planPages(flow, { cuts });
  const out = await W.writeMarkdownPdf({ PDFLib, fontkit, flow, plan, fontBytes: bytes, title: "Check", part, deferInternalLinks: defer });
  return { flow, plan, out, fontSet };
}

async function pdfText(bytes, { logical = false } = {}) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = logical ? await readingRules.readPageTextContent(page, doc) : await page.getTextContent();
    pages.push(content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join(""));
  }
  const outline = await doc.getOutline();
  const annots = [];
  for (let i = 1; i <= doc.numPages; i += 1) annots.push(await (await doc.getPage(i)).getAnnotations());
  await doc.destroy();
  return { pages, outline, annots };
}

const flat = (s) => s.replace(/\s+/g, " ");

const SAMPLE = `# Title of the note

Plain words with **bold**, *italic*, \`code\` and a [link](https://example.com) and a [jump](#the-second-part).
Greek αβγ and arrows → ≤ ∑ ∞, café.

## A list

- one
- two
  - nested
- [x] done

## The second part

| a | b |
|---|---|
| 1 | 2 |

\`\`\`js
// comment => arrow
const x = 1;
\`\`\`
`;

const LONG = Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}\n\n- item a\n- item b\n\n\`\`\`\nline one\nline two\n\`\`\`\n`).join("\n");

// ── the text is real, and complete ─────────────────────────────────────────
const sample = await build(SAMPLE);
const read = await pdfText(sample.out.bytes);
await must("every word of the markdown is text in the PDF, in order", () => {
  const text = flat(read.pages.join(" "));
  const want = ["Title of the note", "Plain words with bold, italic, code and a link and a jump.", "Greek αβγ and arrows → ≤ ∑ ∞, café.", "one", "nested", "The second part", "// comment => arrow", "const x = 1;"];
  let at = 0;
  for (const w of want) {
    const i = text.indexOf(w, at);
    if (i < 0) return `missing or out of order: ${JSON.stringify(w)} in ${JSON.stringify(text.slice(0, 400))}`;
    at = i;
  }
  return true;
});
await must("one smart page, trimmed to its content (shorter than A4)", () => (
  sample.out.pageCount === 1 && sample.out.pageSizes[0][1] < 842 && sample.out.pageSizes[0][1] > 200
) || `pages ${sample.out.pageCount}, sizes ${JSON.stringify(sample.out.pageSizes)}`);
await must("small: a page of text is under 30KB with its fonts", () => sample.out.bytes.length < 30000 || `${sample.out.bytes.length} bytes`);
await must("the headings are the PDF's bookmarks, nested by level", () => {
  const o = read.outline || [];
  return (o.length === 1 && o[0].title === "Title of the note" && o[0].items.map((i) => i.title).join("|") === "A list|The second part")
    || JSON.stringify(o.map((i) => [i.title, i.items.map((j) => j.title)]));
});
await must("a URL link opens, a #heading link jumps", () => {
  const links = read.annots[0].filter((a) => a.subtype === "Link");
  const url = links.find((a) => a.url === "https://example.com/" || a.url === "https://example.com");
  const jump = links.find((a) => Array.isArray(a.dest));
  return Boolean(url && jump) || JSON.stringify(links.map((a) => ({ url: a.url, dest: a.dest })));
});
await must("the code font's ligatures are off (// and => stay two glyphs)", () => {
  const text = read.pages.join("");
  return text.includes("// comment => arrow") || "code line lost";
});

// ── the break planner ──────────────────────────────────────────────────────
const long = await build(LONG);
await must("smart pages: every page at most the page length, never cut inside a code block", () => {
  const { flow, plan } = long;
  for (const page of plan.pages) if (page.contentHeight > flow.geometry.pageContent + 0.5) return `page over length: ${page.contentHeight}`;
  for (const cut of plan.cuts) {
    const row = flow.rows[cut];
    const prev = flow.rows[cut - 1];
    if (row.decos?.some((d) => d.kind === "bg") && prev.decos?.some((d) => row.decos.some((e) => e.id === d.id))) return `cut inside a code block at row ${cut}`;
  }
  return plan.pages.length > 2 || `only ${plan.pages.length} pages`;
});
await must("smart pages: a cut prefers the place before a heading", () => {
  const { flow, plan } = long;
  const before = plan.cuts.filter((i) => flow.rows[i].heading).length;
  return before >= plan.cuts.length * 0.6 || `${before} of ${plan.cuts.length} cuts before a heading`;
});
await must("no page ends on a heading", () => {
  const { flow, plan } = long;
  for (const cut of plan.cuts) if (flow.rows[cut - 1].heading) return `heading left at a page foot (row ${cut - 1})`;
  return true;
});
const paper = await build(LONG, { layout: "paper", breakBefore: "h2", pageNumbers: true });
await must("paper pages + break before H2: one section per A4 sheet, numbered", async () => {
  const sizes = paper.out.pageSizes;
  if (!sizes.every(([w, h]) => Math.round(w) === 595 && Math.round(h) === 842)) return `sizes ${JSON.stringify(sizes.slice(0, 3))}`;
  if (paper.out.pageCount !== 30) return `${paper.out.pageCount} pages for 30 sections`;
  const t = await pdfText(paper.out.bytes);
  return (t.pages[4].includes("Section 5") && t.pages[4].includes("5 / 30")) || JSON.stringify(t.pages[4].slice(0, 200));
});
const longPage = await build(LONG, { layout: "long" });
await must("one long page: a single page as tall as the content", () => (
  longPage.out.pageCount === 1 && longPage.out.pageSizes[0][1] > 3000 && longPage.out.pageSizes[0][1] <= 14400
) || JSON.stringify(longPage.out.pageSizes));
const huge = await build(Array.from({ length: 6 }, () => LONG).join("\n"), { layout: "long" });
await must("one long page past 200 inches is split, never over the PDF limit", () => (
  huge.out.pageCount > 1 && huge.out.pageSizes.every(([, h]) => h <= 14400)
) || JSON.stringify(huge.out.pageSizes));
const cols = await build(LONG, { columns: 2, layout: "paper" });
await must("two columns: half the pages of one, both columns used", async () => {
  const one = await build(LONG, { layout: "paper" });
  const ok = cols.out.pageCount <= Math.ceil(one.out.pageCount / 2) + 1;
  const places = cols.out.places.filter(Boolean);
  const right = places.some((p) => p.column === 1);
  return (ok && right) || `${cols.out.pageCount} vs ${one.out.pageCount}; right column used: ${right}`;
});
await must("page breaks placed by hand are kept, by key, through an edit elsewhere", async () => {
  const keys = long.plan.keys.slice(0, 2);
  const edited = LONG.replace("## Section 20", "## Section twenty, renamed");
  const again = await build(edited, {}, { cuts: keys });
  const kept = again.plan.keys;
  return (keys.every((k) => kept.includes(k)) && again.plan.cuts.length >= 2) || `wanted ${keys}, got ${kept.slice(0, 4)}`;
});

// ── the markdown kept in the file, and splicing ───────────────────────────
const partData = { source: SAMPLE, options: L.normalizeMdPdfOptions({}), cuts: null, title: "Check" };
const tagged = await build(SAMPLE, {}, { part: { id: "main", data: partData } });
await must("the markdown is kept inside the PDF, and every page names its part", async () => {
  const doc = await PDFLib.PDFDocument.load(tagged.out.bytes);
  const parts = P.readParts(PDFLib, doc);
  return (parts.length === 1 && parts[0].id === "main" && parts[0].data.source === SAMPLE && parts[0].pages.join() === "0") || JSON.stringify(parts);
});
const baseBytes = buildFixturePdf({ pages: 3 }).bytes;
const baseCount = (await PDFLib.PDFDocument.load(baseBytes)).getPageCount();
const insert = await build(LONG.slice(0, 1500), {}, { defer: true });
for (const [label, at] of [["the start", 0], ["the middle", 1], ["the end", baseCount]]) {
  await must(`inserting markdown pages at ${label} of somebody's PDF`, async () => {
    const result = await P.splicePart(PDFLib, baseBytes, insert.out.bytes, { at, part: { id: "ins1", data: partData } });
    const doc = await PDFLib.PDFDocument.load(result.bytes);
    const parts = P.readParts(PDFLib, doc);
    const want = Array.from({ length: insert.out.pageCount }, (_, k) => at + k).join();
    if (result.pageCount !== baseCount + insert.out.pageCount) return `page count ${result.pageCount}`;
    if (parts.length !== 1 || parts[0].pages.join() !== want) return `parts ${JSON.stringify(parts.map((p) => p.pages))} want ${want}`;
    const t = await pdfText(result.bytes);
    return t.pages[at].includes("Section 1") || JSON.stringify(t.pages[at].slice(0, 120));
  });
}
await must("copying pages in does not drag the generated file's page tree along (size)", async () => {
  const result = await P.splicePart(PDFLib, baseBytes, insert.out.bytes, { at: 1, part: { id: "ins1", data: partData } });
  return result.bytes.length < baseBytes.length + insert.out.bytes.length + 4000 || `${result.bytes.length} vs ${baseBytes.length}+${insert.out.bytes.length}`;
});
await must("a #heading link on inserted pages points at the inserted page", async () => {
  const md = "# Top\n\n[to bottom](#bottom)\n\n" + "para\n\n".repeat(140) + "# Bottom\n\nend";
  const gen = await build(md, {}, { defer: true });
  const result = await P.splicePart(PDFLib, baseBytes, gen.out.bytes, { at: 1, part: { id: "x", data: partData } });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(result.bytes), verbosity: 0 }).promise;
  const annots = await (await doc.getPage(2)).getAnnotations();
  const link = annots.find((a) => a.subtype === "Link" && Array.isArray(a.dest));
  if (!link) return "no internal link";
  const index = await doc.getPageIndex(link.dest[0]);
  await doc.destroy();
  return index === 1 + gen.out.pageCount - 1 || `points at page index ${index}`;
});
await must("rebuilding a part replaces exactly its pages; removing takes them out", async () => {
  const first = await P.splicePart(PDFLib, baseBytes, insert.out.bytes, { at: 1, part: { id: "ins1", data: partData } });
  const shorter = await build("# Short\n\none line", {}, { defer: true });
  const second = await P.splicePart(PDFLib, first.bytes, shorter.out.bytes, { replaceId: "ins1", part: { id: "ins1", data: { ...partData, source: "# Short" } } });
  if (second.from !== 1 || second.removed !== insert.out.pageCount || second.added !== 1) return JSON.stringify({ from: second.from, removed: second.removed, added: second.added });
  if (second.pageCount !== baseCount + 1) return `count ${second.pageCount}`;
  const parts = P.readParts(PDFLib, await PDFLib.PDFDocument.load(second.bytes));
  if (parts[0]?.data?.source !== "# Short") return "part data not replaced";
  const third = await P.splicePart(PDFLib, second.bytes, null, { removeId: "ins1" });
  return (third.pageCount === baseCount && P.readParts(PDFLib, await PDFLib.PDFDocument.load(third.bytes)).length === 0) || `count ${third.pageCount}`;
});

// ── finding a highlight's words again ──────────────────────────────────────
await must("a highlight's words are found on the remade pages, with quads over them", async () => {
  // Paper pages: a fixed sheet, so "moved down" is a smaller y (PDF space
  // runs upward). A smart page grows with its content instead.
  const before = await build(SAMPLE, { layout: "paper" });
  const edited = SAMPLE.replace("# Title of the note", "# Title of the note\n\nA new opening paragraph pushes everything down a little.");
  const again = await build(edited, { layout: "paper" });
  const quads = A.locateText(again.out.textRuns, "arrows → ≤ ∑ ∞, café", again.fontSet.measure);
  if (!quads || !quads.length) return "not found";
  const old = A.locateText(before.out.textRuns, "arrows → ≤ ∑ ∞, café", before.fontSet.measure);
  const moved = old && Math.abs(old[0].rect[1] - quads[0].rect[1]) > 5;
  const wide = quads[0].rect[2] - quads[0].rect[0] > 40;
  return (moved && wide) || JSON.stringify({ old, quads });
});
await must("a highlight across two styled runs on one line is one quad", () => {
  const quads = A.locateText(sample.out.textRuns, "with bold, italic", sample.fontSet.measure);
  return (quads && quads.length === 1) || JSON.stringify(quads);
});
await must("words that are gone are reported as not found", () => A.locateText(sample.out.textRuns, "nowhere in this text", sample.fontSet.measure) === null);

// ── fonts ──────────────────────────────────────────────────────────────────
await must("WOFF is unwrapped, and Noto Sans Math's hinting taken out", async () => {
  const woff = fontFile(fc.facePath("math|math|400|normal"));
  const ttf = await woffToSfnt(woff, inflate);
  const font = fontkit.create(ttf);
  return (font.maxp.maxFunctionDefs === 0 && font.hasGlyphForCodePoint(0x2192) && !font.directory.tables.fpgm) || `maxFn ${font.maxp.maxFunctionDefs}`;
});
await must("a character no font has is left out, not drawn as a box", async () => {
  const r = await build("Emoji 😀 here");
  const t = await pdfText(r.out.bytes);
  return flat(t.pages[0]).includes("Emoji here") || JSON.stringify(t.pages[0]);
});

// ── Devanagari: real, shaped text ──────────────────────────────────────────
const HINDI = `# चार्वाक दर्शन

चार्वाक दर्शन भारतीय दर्शन की एक **नास्तिक** शाखा है। *प्रत्यक्ष* ही प्रमाण है — mixed with English words.

- श्री क्षत्रिय हिंदी

\`\`\`js
const tattva = ["पृथ्वी", "जल"];
\`\`\`
`;
const hindi = await build(HINDI);
const hindiText = flat((await pdfText(hindi.out.bytes)).pages.join(" "));
const hindiOps = hindi.flow.rows.flatMap((row) => row.ops);

await must("Devanagari is text in the PDF, not pictures of words", () => {
  const atoms = hindiOps.filter((op) => op.t === "image");
  const deva = hindiOps.filter((op) => op.t === "text" && String(op.face).startsWith("deva|devanagari|"));
  return (!atoms.length && deva.length > 5) || JSON.stringify({ atoms: atoms.length, deva: deva.length });
});
await must("...shaped: a conjunct is one glyph, not a halant between two letters", () => {
  const font = hindi.fontSet.fonts.get("deva|devanagari|400|normal");
  if (!font) return "no Devanagari face was loaded";
  const glyphs = font.layout("क्ष", fc.mdFontFeatures()).glyphs;
  return glyphs.length === 1 || `${glyphs.length} glyphs`;
});
await must("...bold and italic Hindi use the bold and italic Devanagari faces", () => {
  const faces = new Set(hindiOps.filter((op) => op.t === "text").map((op) => op.face));
  return (faces.has("deva|devanagari|700|normal") && faces.has("deva|devanagari|400|italic")) || JSON.stringify([...faces]);
});
// pdf.js reads shaped Devanagari back in drawing order (a ि or a reph comes
// out where it is drawn, not where it was typed) — so the words checked here
// are ones without a reordered sign, and spaces are ignored. The reader puts
// the order back; that is checked further down, against the whole text.
const hindiSolid = hindiText.replace(/\s+/g, "");
await must("...its letters can be read back out of the PDF", () => (
  ["भारतीय", "शाखा", "प्रत्यक्ष", "mixedwithEnglish"].every((word) => hindiSolid.includes(word)) || hindiText
));
await must("...Hindi inside code is drawn, not dropped", () => (
  hindiSolid.includes('tattva=["पृथ्वी","जल"]') || hindiText
));
await must("...and the PDF stays small (under 60KB)", () => hindi.out.bytes.length < 60000 || `${hindi.out.bytes.length} bytes`);

// ── ...and read back the way the reader reads it ────────────────────────────
//
// The report: on a Hindi export, a double-click selected part of a word and a
// highlight sat a word away from the one it named. pdf.js gave every half form
// and conjunct no width and read the glyphs in DRAWING order; the worker the
// app runs is patched for the first (src/core/pdfjs-patches.js), and the reader
// undoes the second for files this writer made (devanagariLogicalOrder).
const REPORT = "कि भारतीय दर्शन में कि एक दर्शन ऐसा है जो लोगों के लिए बड़ा विवाद का विषय रहा है उसका कारण भी है आज के भारत के लोग जो हैं वह अध्यात्मवादी हैं भारत के संस्कार ही ऐसे बने हैं वेद ने भारत को क्यों रास्ता दिखाया है उपनिषद में भी ब्रह्म ज्ञान का और अध्यात्म का आत्मा का सारा विवेचन किया गया है इसलिए भारतीय लोग जो कोई ऐसी चीज हो चार्वाक के प्रति एक दृष्टिकोण कर्म स्त्रियाँ पूर्णिमा शिक्षा आर्थिक क़िला प्रत्यक्ष क्षत्रिय ऐतिहासिक सिद्धार्थ विद्यार्थी दक्षिण पश्चिम निर्णय परिणाम कार्यक्रम स्थिति प्रक्रिया व्यक्ति शक्ति सिद्धि बुद्धि ऋषि दृष्टि सृष्टि फ़िल्म दिल्ली चिट्ठी किताबें बच्चियाँ लड़कियों तीर्थ सूर्य वर्ष पर्याप्त धार्मिक मार्ग स्वर्ग दुर्गा निर्मल शर्मा गर्मी वर्णन चर्चा अर्जुन क्रिकेट प्रिय त्रिकोण श्रीमती";
const report = await build(`${REPORT}\n`);
const reportLogical = flat((await pdfText(report.out.bytes, { logical: true })).pages.join(" ")).trim();
const reportRaw = flat((await pdfText(report.out.bytes)).pages.join(" ")).trim();
await must("the export's producer is the one the reader recognises", async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(report.out.bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const ok = await readingRules.isRecallExport(doc);
  await doc.destroy();
  return ok === true || "isRecallExport said no";
});
await must("Hindi from an export reads back in typed order, word for word", () => {
  const want = REPORT.split(" ");
  const got = reportLogical.split(" ");
  const wrong = want.map((word, i) => (word === got[i] ? null : `${word} ← ${got[i]}`)).filter(Boolean);
  return (!wrong.length && got.length === want.length) || `${wrong.length} word(s) wrong of ${want.length}: ${wrong.slice(0, 8).join(", ")}`;
});
await must("...where pdf.js alone reads it in drawing order", () => (
  (reportRaw.includes("िक") && reportRaw.includes("दशर्न")) || reportRaw.slice(0, 80)
));
await must("a line's item is as wide as the line the writer drew, and says where each word starts", async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(report.out.bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const content = await readingRules.readPageTextContent(await doc.getPage(1), doc);
  await doc.destroy();
  const runs = report.out.textRuns[0];
  const items = content.items.filter((item) => item.str);
  if (items.length !== runs.length) return `${items.length} items for ${runs.length} lines`;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const item = items[i];
    const drawn = report.fontSet.measure(run.text, run.face, run.size);
    if (Math.abs(item.width - drawn) > 0.05) return `line ${i + 1}: item ${item.width.toFixed(2)} wide, drawn ${drawn.toFixed(2)}`;
    if (item.str !== run.text) return `line ${i + 1} reads “${item.str.slice(0, 40)}…”`;
    let prefix = "";
    for (const word of run.text.split(" ")) {
      const at = item.charX[prefix.length];
      const want = report.fontSet.measure(prefix, run.face, run.size);
      if (Math.abs(at - want) > 0.05) return `“${word}” starts at ${at.toFixed(2)}, drawn at ${want.toFixed(2)}`;
      prefix += `${word} `;
    }
  }
  return true;
});

await must("a measured line is the line drawn: widths are the glyphs' own advances", () => {
  const font = hindi.fontSet.fonts.get("deva|devanagari|400|normal");
  const word = "प्रत्यक्ष";
  const drawn = font.layout(word, fc.mdFontFeatures()).glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / font.unitsPerEm * 10;
  const measured = hindi.fontSet.measure(word, "deva|devanagari|400|normal", 10);
  return Math.abs(drawn - measured) < 1e-6 || `${measured} vs ${drawn}`;
});

// ── page breaks inside long paragraphs ─────────────────────────────────────
const PARAS = Array.from({ length: 14 }, (_, i) => `${i % 4 === 0 ? `## Part ${i}\n\n` : ""}${`Sentence ${i} of a long paragraph that runs on for many lines. `.repeat(i % 2 ? 100 + i * 3 : 4)}`).join("\n\n");
await must("a cut inside a paragraph never leaves one of its lines alone on a page", async () => {
  const r = await build(PARAS);
  const bad = r.plan.cuts.map((i) => r.flow.rows[i]).filter((row) => row.lines > 1 && row.line > 0 && (row.line === 1 || row.lines - row.line === 1));
  return (r.plan.cuts.length > 1 && !bad.length) || JSON.stringify({ cuts: r.plan.cuts.length, bad: bad.map((row) => `${row.line}/${row.lines}`) });
});
await must("...and no page but the last is left less than half full", async () => {
  const r = await build(PARAS);
  const thin = r.plan.slices.slice(0, -1).filter((slice) => slice.h < r.plan.room * 0.5);
  return !thin.length || JSON.stringify(thin.map((slice) => Math.round((slice.h / r.plan.room) * 100)));
});

let failed = 0;
for (const [ok, name, detail] of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail.split("\n").slice(0, 6).join("\n      ")}`}`);
}
console.log(`\n${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
