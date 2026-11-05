// Static checks for Recall Web Clipper, the browser extension (no browser needed):
//
//  - its manifest parses, and every file the manifest, a background script,
//    the PDF job or the popup names is on disk;
//  - there is one extension: the three it replaced are gone;
//  - lib/pdf-info.js writes a well-formed incremental update;
//  - lib/pdf-pages.js gives each page its own height, the same way;
//  - lib/options.js turns options into the right page geometry, smart page
//    lengths and file names.
//
//   node tools/extensions-check.mjs
//
// tools/extensions-browser-check.mjs drives the extension in Chromium.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = ["recall-clipper"];

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const close2 = (a, b) => Math.abs(a - b) < 0.01;

// ---------------------------------------------------------------- manifests & files

for (const ext of EXTENSIONS) {
  let manifest = null;
  try { manifest = JSON.parse(read(`${ext}/manifest.json`)); } catch (err) { check(`${ext}: manifest.json parses`, false, err.message); continue; }
  check(`${ext}: manifest.json parses as Manifest V3`, manifest.manifest_version === 3);
  const named = new Set();
  Object.values(manifest.icons || {}).forEach((f) => named.add(f));
  Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((f) => named.add(f));
  if (manifest.action && manifest.action.default_popup) named.add(manifest.action.default_popup);
  if (manifest.background && manifest.background.service_worker) named.add(manifest.background.service_worker);
  // Files a script injects or fetches by path.
  for (const script of [manifest.background && manifest.background.service_worker, manifest.action && manifest.action.default_popup, "pdf-job.js", "popup.js"].filter((f) => f && existsSync(path.join(ROOT, ext, f)))) {
    const src = read(`${ext}/${script}`);
    for (const m of src.matchAll(/["']((?:content|vendor|lib|icons)\/[\w./-]+\.(?:js|css|png|html))["']/g)) named.add(m[1]);
    for (const m of src.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css|png))"/g)) named.add(m[1]);
    for (const m of src.matchAll(/from\s+"\.\/([\w./-]+\.js)"/g)) named.add(m[1]);
  }
  const missing = [...named].filter((f) => !existsSync(path.join(ROOT, ext, f)));
  check(`${ext}: every file its manifest and scripts name exists (${named.size})`, missing.length === 0, missing.join(", "));
  check(`${ext}: no fixed key (nothing messages it from outside)`, !manifest.key);
  check(`${ext}: at most four shortcuts (Chrome's limit)`, Object.values(manifest.commands || {}).filter((c) => c.suggested_key).length <= 4);
}

check("one extension: the separate Web to PDF and Page Cleaner folders are gone",
  !existsSync(path.join(ROOT, "recall-web-to-pdf")) && !existsSync(path.join(ROOT, "recall-page-cleaner")));
const bg = read("recall-clipper/background.js");
check("the background starts all three jobs", ["startClipper", "startCleaner", "runJob"].every((f) => bg.includes(f)));
const ui = read("recall-clipper/content/cleaner-ui.js");
check("the cleaner hands its page on inside the extension", ui.includes("rwc-save-pdf") && ui.includes("rwc-clip") && !/sendMessage\(\s*"[a-p]{32}"/.test(ui));

// ---------------------------------------------------------------- pdf-info

const { setPdfInfo, readTrailer, countPages, pdfString } = await import(pathToFileURL(path.join(ROOT, "recall-clipper/lib/pdf-info.js")).href);
const { imagesToPdf } = await import(pathToFileURL(path.join(ROOT, "recall-clipper/lib/image-pdf.js")).href);

// A tiny real JPEG is not needed for structure: the image bytes are opaque here.
const base = imagesToPdf([{ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 20 }, { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 10 }]);
const latin = (bytes) => Buffer.from(bytes).toString("latin1");
check("image-pdf: two pages", countPages(base) === 2, String(countPages(base)));
const t0 = readTrailer(base);
check("image-pdf: its trailer reads back", t0.root === "1 0 R" && t0.size === 9, JSON.stringify(t0));

const stamped = setPdfInfo(base, {
  Title: "Tides — “how they work”", Subject: "https://example.org/a?b=1&c=(2)", Creator: "Recall Web Clipper",
  CreationDate: new Date("2026-11-05T10:20:30Z"), custom: { RecallSourceURL: "https://example.org/a", "Bad Key": "x", Empty: "" }
});
const text = latin(stamped);
check("pdf-info: original bytes untouched", Buffer.compare(Buffer.from(stamped.subarray(0, base.length)), Buffer.from(base)) === 0);
const t1 = readTrailer(stamped);
check("pdf-info: new trailer points at a new Info object", t1.info === "9 0 R" && t1.size === 10 && t1.root === "1 0 R", JSON.stringify(t1));
const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
check("pdf-info: startxref points at the new xref section", text.startsWith("xref\n9 1\n", startxref));
const entry = /xref\n9 1\n(\d{10}) 00000 n /.exec(text.slice(startxref));
check("pdf-info: the xref entry points at the Info object", entry && text.startsWith("9 0 obj", Number(entry[1])));
check("pdf-info: /Prev names the old xref", new RegExp(`/Prev ${t0.startxref}\\b`).test(text.slice(startxref)));
check("pdf-info: strings are UTF-16BE hex", text.includes(`/Title ${pdfString("Tides — “how they work”")}`) && pdfString("A") === "<FEFF0041>");
check("pdf-info: custom keys written, invalid and empty ones dropped", text.includes("/RecallSourceURL <FEFF") && !text.includes("Bad Key") && !text.includes("/Empty"));
check("pdf-info: dates in PDF form", text.includes("/CreationDate (D:20261105102030Z)"));
const twice = setPdfInfo(stamped, { Title: "Again" });
check("pdf-info: a second update chains onto the first", readTrailer(twice).info === "10 0 R" && new RegExp(`/Prev ${t1.startxref}\\b`).test(latin(twice).slice(readTrailer(twice).startxref)));
let threw = false;
try { setPdfInfo(new TextEncoder().encode("not a pdf"), {}); } catch { threw = true; }
check("pdf-info: refuses something that is not a PDF", threw);

// ---------------------------------------------------------------- pdf-pages

const { trimPageHeights, readPages } = await import(pathToFileURL(path.join(ROOT, "recall-clipper/lib/pdf-pages.js")).href);
const before = readPages(base);
check("pdf-pages: reads the pages in order with their boxes", before && before.length === 2 && before.every((p) => p.mediaBox.length === 4), JSON.stringify(before && before.map((p) => p.mediaBox)));
const [, , , top0] = before[0].mediaBox;
const trimmed = trimPageHeights(base, [100, 0]);
check("pdf-pages: original bytes untouched", Buffer.compare(Buffer.from(trimmed.subarray(0, base.length)), Buffer.from(base)) === 0);
const after = readPages(trimmed);
check("pdf-pages: page 1 keeps its top and is 100 pt tall", after && close2(after[0].mediaBox[3], top0) && close2(after[0].mediaBox[3] - after[0].mediaBox[1], 100), JSON.stringify(after && after[0].mediaBox));
check("pdf-pages: a height of 0 leaves a page alone", after && JSON.stringify(after[1].mediaBox) === JSON.stringify(before[1].mediaBox));
check("pdf-pages: still two pages, counted once each", countPages(trimmed) === 2, String(countPages(trimmed)));
const tt = readTrailer(trimmed);
check("pdf-pages: the new trailer chains onto the old one", tt.root === t0.root && tt.size === t0.size && new RegExp(`/Prev ${t0.startxref}\\b`).test(latin(trimmed).slice(tt.startxref)));
const both = setPdfInfo(trimmed, { Title: "After a trim" });
check("pdf-pages: the metadata goes on after a trim", readTrailer(both).info && readPages(both)[0].mediaBox[1] === after[0].mediaBox[1]);
check("pdf-pages: wrong number of heights → bytes unchanged", trimPageHeights(base, [100]) === base);
check("pdf-pages: nothing to trim → bytes unchanged", trimPageHeights(base, [100000, 100000]) === base);

// ---------------------------------------------------------------- options

const { normalize, geometry, fileNameFor, folderFor, pageLengthIn, pageContentPx, SMART_SLACK_IN, DEFAULTS, BUILTIN_PRESETS } = await import(pathToFileURL(path.join(ROOT, "recall-clipper/lib/options.js")).href);

const d = geometry(normalize({}));
check("defaults: A4 width, smart pages, left/right 12 mm", close(d.paperWidthIn, 210 / 25.4) && close(d.margin.left, 12 / 25.4) && d.margin.top === 0 && DEFAULTS.layout === "smart");
check("defaults: about one A4 page per page, breaks shown first", DEFAULTS.pageLength === "a4" && DEFAULTS.adjustBreaks === true);
const sd = normalize({});
check("smart pages: one A4 is the paper's height", close(pageLengthIn(sd), 297 / 25.4));
check("smart pages: two A4, one screen", close(pageLengthIn(sd, geometry(sd), "2a4"), 2 * 297 / 25.4) && close(pageLengthIn(sd, geometry(sd), "screen"), 0.75 * 210 / 25.4));
check("smart pages: a custom length in the margin unit", close(pageLengthIn(normalize({ pageLength: "custom", customPageLength: 20, marginUnit: "in" })), 20));
check("smart pages: never past the tallest page a viewer shows", pageLengthIn(normalize({ pageLength: "custom", customPageLength: 9999, marginUnit: "in" })) === 200);
const tbm = normalize({ marginPreset: "all", marginSize: 1, marginUnit: "in" });
check("smart pages: content height leaves out the margins and the slack, in layout pixels", pageContentPx(tbm) === Math.round((297 / 25.4 - 2 - SMART_SLACK_IN) * 96 / geometry(tbm).scale));
check("smart pages: an unknown length falls back to A4", normalize({ pageLength: "huge" }).pageLength === "a4");
check("defaults: High images", DEFAULTS.imageQuality === "high");
const tb = geometry(normalize({ marginPreset: "topbottom", marginSize: 0.5, marginUnit: "in" }));
check("margins: top and bottom only, in inches", tb.margin.top === 0.5 && tb.margin.bottom === 0.5 && tb.margin.left === 0);
const custom = geometry(normalize({ marginPreset: "custom", margins: { top: 1, right: 2, bottom: 3, left: 4 }, marginUnit: "mm" }));
check("margins: custom per side", close(custom.margin.right, 2 / 25.4) && close(custom.margin.left, 4 / 25.4));
const hf = geometry(normalize({ marginPreset: "none", header: "title", footer: "page" }));
check("a header or footer makes room for itself", hf.margin.top >= 0.45 && hf.margin.bottom >= 0.45 && hf.margin.left === 0);
const land = geometry(normalize({ paper: "Letter", orientation: "landscape" }));
check("landscape swaps the paper", close(land.paperWidthIn, 11) && close(land.paperHeightIn, 8.5));
const wide = geometry(normalize({ scaleMode: "width", layoutWidth: "1280", marginPreset: "none" }));
check("layout width: A4 laid out at 1280 px", wide.layoutWidthPx === 1280 && close(wide.scale, (210 / 25.4 * 96) / 1280));
const n = normalize({ scale: 999, imageQuality: "bogus", layout: "x", margins: { top: -5 } });
check("normalize clamps and rejects nonsense", n.scale === 200 && n.imageQuality === "high" && n.layout === "smart" && n.margins.top === 0);
check("every built-in preset normalizes to valid options", Object.values(BUILTIN_PRESETS).every((p) => {
  const o = normalize({ ...DEFAULTS, ...p });
  return Object.keys(p).every((k) => JSON.stringify(o[k]) === JSON.stringify(p[k]));
}));
const name = fileNameFor("{title} - {site} {date}", { title: 'A/B: "C"?', site: "Site", url: "https://www.x.org/p" }, new Date(2026, 10, 5, 9, 7));
check("file names lose characters a file system refuses", name === "A B C - Site 2026-11-05", name);
check("an empty template still names the file", fileNameFor("", { title: "", url: "https://x.org" }) === "web page");
check("the folder keeps its levels and drops dot-dot", folderFor("Recall/../web\\clips") === "Recall/web/clips", folderFor("Recall/../web\\clips"));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length} checks · ${failed} failed`);
console.log(`CHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
