// The fixes src/core/pdfjs-patches.js makes to pdf.js, without a browser.
//
//   node tools/pdfjs-patch-check.mjs
//
// Asserted:
//
//   • every patch applies, exactly once, to the pdf.js LIB_URLS.pdfjs names —
//     a version bump that moves the minified text fails here, not as a quietly
//     unpatched library in the app;
//   • patching twice changes nothing;
//   • text that is not that build is left untouched and reported missing;
//   • the patched TilingPattern.getSizeAndScale, lifted out and run:
//       – a tile as big as a tall page, drawn into a band's canvas, is drawn
//         WHOLE at the scale that fits (the "page breaks" in a tall page);
//       – a tile under the clamp, and a tile whose step is huge but whose
//         content is small, get exactly what pdf.js gave them before;
//   • src/core/lib-loader.js loads pdf.js through the patch, for the page and
//     for the page renderer's worker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFJS_VERSION, pdfjsSources } from "./pdfjs-source.mjs";
import { patchPdfjsSource, PDFJS_PATCHES } from "../src/core/pdfjs-patches.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const loader = readFileSync(path.join(ROOT, "src/core/lib-loader.js"), "utf8");
check("LIB_URLS.pdfjs is the version the patches were written for",
  loader.includes(`pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.js`), PDFJS_VERSION);
check("ensurePdfJs loads the patched copy", /patchPdfjsSource\(await response\.text\(\)\)/.test(loader)
  && /loadScriptOnce\(patched\)/.test(loader));
check("the page renderer is handed the same patched copy", /pdfjsWorkerSources\(\)[\s\S]{0,200}patchedPdfjsBlobUrl\(\)/.test(loader));

const sw = readFileSync(path.join(ROOT, "sw.js"), "utf8");
check("the service worker precaches the patch module", sw.includes("./src/core/pdfjs-patches.js?v=${STAMP}"));

const untouched = patchPdfjsSource("not pdf.js at all");
check("text that is not that build is left alone", untouched.text === "not pdf.js at all"
  && untouched.missing.length === PDFJS_PATCHES.length && !untouched.applied.length);

let raw = null;
try {
  raw = pdfjsSources().raw;
} catch (error) {
  console.log(`  (could not obtain pdf.js ${PDFJS_VERSION}: ${error?.message || error} — skipping the source checks)`);
}

if (raw) {
  const once = patchPdfjsSource(raw);
  check("every patch applies to the pinned build", once.missing.length === 0 && once.applied.length === PDFJS_PATCHES.length,
    `applied ${once.applied.join(", ") || "none"}${once.missing.length ? `; missing ${once.missing.join(", ")}` : ""}`);
  const twice = patchPdfjsSource(once.text);
  check("patching twice changes nothing", twice.text === once.text && twice.applied.length === PDFJS_PATCHES.length);

  // Lift the patched method out and run it as pdf.js would.
  const body = (once.text.match(/getSizeAndScale\(t,e,n,w\)\{[^]*?return\{scale:n,size:r\}\}/) || [])[0];
  check("the patched getSizeAndScale is in the library", Boolean(body));
  if (body) {
    const TilingPattern = { MAX_PATTERN_SIZE: 3000 };
    // eslint-disable-next-line no-new-func
    const size = new Function("TilingPattern", `return ({ ${body} }).getSizeAndScale;`)(TilingPattern);

    // A web page saved as one tall page (the report): a tile 23 065 units
    // tall, its content 23 063, drawn at 0.528 px a unit into a band 874 px
    // tall. Unpatched: a 3000 px canvas at the full scale — the tile cut off
    // and repeated. Patched: the whole tile, at the scale 3000 px allows.
    const band = size(23065, 874, 0.528, 23063);
    check("a page-sized tile in a band is drawn whole", band.size === 3000 && Math.abs(band.size / band.scale - 23065) < 1e-6,
      `size ${band.size}, scale ${band.scale.toFixed(4)}`);
    // The same tile into a canvas as tall as the page: no clamp, as before.
    const full = size(23065, 12200, 0.528, 23063);
    check("...and into a whole-page canvas as before", full.size === Math.ceil(23065 * 0.528) && Math.abs(full.size / full.scale - 23065) < 1e-6);
    // A small tile: untouched.
    const small = size(40, 874, 2, 40);
    check("a small tile is untouched", small.size === 80 && small.scale === 2);
    // A sparse pattern: a huge step, content that fits. Exactly what the
    // unpatched build did — clamped canvas, full scale, content sharp.
    const sparse = size(100000, 874, 1, 200);
    check("a sparse huge-step tile keeps its full scale", sparse.size === 3000 && sparse.scale === 1);
    // Called without the bbox (any other caller): the old behaviour.
    const legacy = size(23065, 874, 0.528);
    check("called without a bbox: as before", legacy.size === 3000 && legacy.scale === 0.528);
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
