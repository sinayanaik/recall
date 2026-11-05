// Static checks for the browser extensions (no browser needed):
//
//  - every manifest parses, and every file a manifest, a background script or
//    the popup names is on disk;
//  - the fixed extension IDs (from each manifest's "key") are the ones the
//    other extension and the checks message;
//  - Recall Page Cleaner's rule engine and Recall Web to PDF's copy of it are
//    byte-identical;
//  - lib/pdf-info.js writes a well-formed incremental update;
//  - lib/options.js turns options into the right page geometry and file names.
//
//   node tools/extensions-check.mjs
//
// tools/extensions-browser-check.mjs drives both extensions in Chromium.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = ["recall-clipper", "recall-web-to-pdf", "recall-page-cleaner"];

const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------- manifests & files

function idFromKey(key) {
  const der = Buffer.from(key, "base64");
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
    .split("").map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
}

const ids = {};
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
  for (const script of [manifest.background && manifest.background.service_worker, manifest.action && manifest.action.default_popup].filter(Boolean)) {
    const src = read(`${ext}/${script}`);
    for (const m of src.matchAll(/["']((?:content|vendor|lib|icons)\/[\w./-]+\.(?:js|css|png|html))["']/g)) named.add(m[1]);
    for (const m of src.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css|png))"/g)) named.add(m[1]);
    for (const m of src.matchAll(/from\s+"\.\/([\w./-]+\.js)"/g)) named.add(m[1]);
  }
  const missing = [...named].filter((f) => !existsSync(path.join(ROOT, ext, f)));
  check(`${ext}: every file its manifest and scripts name exists (${named.size})`, missing.length === 0, missing.join(", "));
  if (manifest.key) ids[ext] = idFromKey(manifest.key);
}

check("Web to PDF has a fixed ID", Boolean(ids["recall-web-to-pdf"]));
check("Page Cleaner has a fixed ID", Boolean(ids["recall-page-cleaner"]));
const cleanerBg = read("recall-page-cleaner/background.js");
const pdfBg = read("recall-web-to-pdf/background.js");
const browserCheck = read("tools/extensions-browser-check.mjs");
check("the Cleaner messages Web to PDF's real ID", cleanerBg.includes(`"${ids["recall-web-to-pdf"]}"`));
check("Web to PDF trusts the Cleaner's real ID", pdfBg.includes(`"${ids["recall-page-cleaner"]}"`));
check("the browser check uses both real IDs", browserCheck.includes(ids["recall-web-to-pdf"]) && browserCheck.includes(ids["recall-page-cleaner"]));

const coreA = read("recall-page-cleaner/content/cleaner-core.js");
const coreB = read("recall-web-to-pdf/content/cleaner-core.js");
check("cleaner-core.js is byte-identical in both extensions", coreA === coreB,
  "copy recall-page-cleaner/content/cleaner-core.js over recall-web-to-pdf/content/cleaner-core.js");

// ---------------------------------------------------------------- pdf-info

const { setPdfInfo, readTrailer, countPages, pdfString } = await import(pathToFileURL(path.join(ROOT, "recall-web-to-pdf/lib/pdf-info.js")).href);
const { imagesToPdf } = await import(pathToFileURL(path.join(ROOT, "recall-web-to-pdf/lib/image-pdf.js")).href);

// A tiny real JPEG is not needed for structure: the image bytes are opaque here.
const base = imagesToPdf([{ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 20 }, { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 10 }]);
const latin = (bytes) => Buffer.from(bytes).toString("latin1");
check("image-pdf: two pages", countPages(base) === 2, String(countPages(base)));
const t0 = readTrailer(base);
check("image-pdf: its trailer reads back", t0.root === "1 0 R" && t0.size === 9, JSON.stringify(t0));

const stamped = setPdfInfo(base, {
  Title: "Tides — “how they work”", Subject: "https://example.org/a?b=1&c=(2)", Creator: "Recall Web to PDF",
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

// ---------------------------------------------------------------- options

const { normalize, geometry, fileNameFor, folderFor, DEFAULTS, BUILTIN_PRESETS } = await import(pathToFileURL(path.join(ROOT, "recall-web-to-pdf/lib/options.js")).href);
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const d = geometry(normalize({}));
check("defaults: A4 width, continuous, left/right 12 mm", close(d.paperWidthIn, 210 / 25.4) && close(d.margin.left, 12 / 25.4) && d.margin.top === 0 && DEFAULTS.layout === "continuous");
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
check("normalize clamps and rejects nonsense", n.scale === 200 && n.imageQuality === "high" && n.layout === "continuous" && n.margins.top === 0);
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
