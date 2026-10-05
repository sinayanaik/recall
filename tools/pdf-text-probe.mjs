// What does copying text off this PDF give, and why?
//
//   node tools/pdf-text-probe.mjs paper.pdf            # page 1
//   node tools/pdf-text-probe.mjs paper.pdf 3 --seams  # page 3, every seam listed
//
// "I'm seeing gibberish": a LaTeX paper copied as "Man y app li ca ti ons".
// There are two places a stray space can come from, and they need different
// fixes, so this reports them separately:
//
//   • inside an item: pdf.js itself put a space in item.str, because it judged
//     two glyphs to be a word apart. Nothing in the text layer can undo that.
//   • between items: the separator the text layer writes between two spans,
//     which is textItemGap() in src/documents/pdf-selection.js.
//
// The text is joined with the app's own textItemGap — its source is read out
// of pdf-selection.js and evaluated here, rather than copied, so this can never
// report on a rule the app no longer uses. pdf.js is the version the app ships
// (tools/pdfjs-source.mjs), run in Node through its legacy build.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pdfjsSources } from "./pdfjs-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find((a) => a.toLowerCase().endsWith(".pdf"));
const pageNumber = Number(args.find((a) => /^\d+$/.test(a)) || 1);
const SEAMS = args.includes("--seams");
if (!file) {
  console.log("usage: node tools/pdf-text-probe.mjs paper.pdf [page] [--seams]");
  process.exit(2);
}

// The app's own separator, lifted out of its module by source.
function appTextItemGap() {
  const source = readFileSync(path.join(ROOT, "src/documents/pdf-selection.js"), "utf8");
  const start = source.indexOf("export function textItemGap(");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("textItemGap not found in pdf-selection.js");
  const body = source.slice(start, end + 2).replace(/^export /, "");
  return new Function(`${body}\nreturn textItemGap;`)();
}

pdfjsSources(); // makes sure the npm copy is unpacked
const require = createRequire(import.meta.url);
const pdfjs = require("/tmp/recall-pdfjs/package/legacy/build/pdf.min.js");
pdfjs.GlobalWorkerOptions.workerSrc = "/tmp/recall-pdfjs/package/legacy/build/pdf.worker.min.js";

const textItemGap = appTextItemGap();
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(pageNumber);
const { items, styles } = await page.getTextContent();

let joined = "";
let previous = null;
const seams = [];
for (const item of items) {
  if (!item.str) continue;
  if (previous) {
    const gap = textItemGap(previous, item);
    const sameLine = Math.abs(item.transform[5] - previous.transform[5]) < (previous.height || 1) * 0.5;
    if (sameLine && !/\s$/.test(previous.str) && !/^\s/.test(item.str)) {
      const size = previous.height || 1;
      const dx = item.transform[4] - (previous.transform[4] + previous.width);
      seams.push(`${JSON.stringify(previous.str.slice(-8))} | ${JSON.stringify(item.str.slice(0, 8))}`
        + `  gap ${(dx / size).toFixed(3)}em  → ${JSON.stringify(gap)}`
        + `  fonts ${styles[previous.fontName]?.fontFamily || previous.fontName} → ${styles[item.fontName]?.fontFamily || item.fontName}`);
    }
    joined += gap;
  }
  joined += item.str;
  previous = item;
}

console.log(`${path.basename(file)} · page ${pageNumber} of ${doc.numPages} · ${items.length} text items`);
// A seam is where two items meet on one line with no whitespace between them:
// the only place the app's separator decides anything. A stray space that
// shows up in the copied text but at no seam was written by pdf.js itself.
console.log(`same-line seams with no whitespace: ${seams.length}`);
console.log("\n── as the app copies it ──");
console.log(joined.slice(0, 3000));
if (SEAMS) {
  console.log("\n── seams ──");
  seams.forEach((line) => console.log(line));
}
process.exit(0);
