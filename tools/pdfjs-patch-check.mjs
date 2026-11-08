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
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFJS_VERSION, patchedPdfjsWorkerPath, pdfjsSources } from "./pdfjs-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";
import { patchPdfjsSource, patchPdfjsWorkerSource, PDFJS_PATCHES, PDFJS_WORKER_PATCHES } from "../src/core/pdfjs-patches.js";

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
check("ensurePdfJs runs the patched worker", /patchPdfjsWorkerSource\(await response\.text\(\)\)/.test(loader)
  && /new Blob\(\[text\], \{ type: "text\/javascript" \}\)/.test(loader));

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

// ── The worker: glyphs with marks have width; items say where their characters are
let rawWorker = null;
try {
  rawWorker = pdfjsSources().rawWorker;
} catch (_) { /* reported above */ }
if (rawWorker) {
  const once = patchPdfjsWorkerSource(rawWorker);
  check("every worker patch applies to the pinned build",
    once.missing.length === 0 && once.applied.length === PDFJS_WORKER_PATCHES.length,
    `applied ${once.applied.join(", ") || "none"}${once.missing.length ? `; missing ${once.missing.join(", ")}` : ""}`);
  const twice = patchPdfjsWorkerSource(once.text);
  check("patching the worker twice changes nothing", twice.text === once.text && twice.applied.length === PDFJS_WORKER_PATCHES.length);
  check("text that is not the worker is left alone", patchPdfjsWorkerSource("nope").text === "nope");

  // The fixed category test, lifted out: a glyph that is only marks is an
  // accent; one that carries a letter AND a mark (a half form, a conjunct) is
  // not.
  const regex = (once.text.match(/new RegExp\("(\^\(\\\\s\)[^"]*)","u"\)/) || [])[1];
  if (regex) {
    const re = new RegExp(regex.replace(/\\\\/g, "\\"), "u");
    const zeroWidth = (s) => Boolean(s.match(re)?.[2]);
    check("a lone combining mark is still zero-width", zeroWidth("\u0947") && zeroWidth("\u0947\u0902"));
    check("a half form or conjunct is not", !zeroWidth("\u0915\u094D") && !zeroWidth("\u091C\u094D\u091E") && !zeroWidth("e\u0301"));
  } else {
    check("the patched category test is in the worker", false);
  }

  // ...and run: every item of an ordinary text PDF says where its characters
  // start, ending at its width.
  const require = createRequire(import.meta.url);
  const pdfjs = require("/tmp/recall-pdfjs/package/legacy/build/pdf.min.js");
  pdfjs.GlobalWorkerOptions.workerSrc = patchedPdfjsWorkerPath();
  const fixture = buildFixturePdf({ pages: 1, annotate: false, outline: false });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fixture.bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  const texty = content.items.filter((item) => item.str && item.str.trim());
  const withX = texty.filter((item) => Array.isArray(item.charX) && item.charX.length === item.str.length + 1);
  check("every text item carries charX, one entry per character and one for the end", texty.length > 0 && withX.length === texty.length,
    `${withX.length} of ${texty.length}`);
  const ends = withX.every((item) => Math.abs(item.charX[item.charX.length - 1] - item.width) < 0.01 && item.charX[0] >= 0);
  const rising = withX.every((item) => item.charX.every((x, i) => i === 0 || x >= item.charX[i - 1] - 0.01));
  check("...starting at the item's origin, rising, and ending at its width", ends && rising);
  await doc.destroy();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
