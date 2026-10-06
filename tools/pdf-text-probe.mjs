// What does copying text off this PDF give, and why?
//
//   node tools/pdf-text-probe.mjs paper.pdf            # page 1
//   node tools/pdf-text-probe.mjs paper.pdf 3 --seams  # page 3, every seam listed
//   node tools/pdf-text-probe.mjs book.pdf 16 --stamps # ...every overprint listed
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
// "Every underlined word comes out eleven times": a book that draws a word
// several times on top of itself (see textItemShadows). Those stamps are left
// out of the text exactly as the text layer leaves them out, and counted.
//
// The text is joined with the app's own textItemGap and textItemShadows —
// pdf-selection.js is loaded here with its browser-only imports stubbed out,
// rather than copied, so this can never report on a rule the app no longer
// uses. pdf.js is the version the app ships
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
const STAMPS = args.includes("--stamps");
if (!file) {
  console.log("usage: node tools/pdf-text-probe.mjs paper.pdf [page] [--seams] [--stamps]");
  process.exit(2);
}

// The app's own text rules, out of its own module. Its imports are the one
// thing that cannot load in Node (pdf-view.js wants a DOM), and nothing this
// uses touches them, so they are stubbed.
async function appTextRules() {
  const source = readFileSync(path.join(ROOT, "src/documents/pdf-selection.js"), "utf8")
    .replace(/^import .*$/gm, "")
    + "\nfunction stripInvalidUnicode(value) { return value; }"
    + "\nfunction pdfPageElement() { return null; }"
    + "\nfunction pdfPageViewport() { return null; }\n";
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

pdfjsSources(); // makes sure the npm copy is unpacked
const require = createRequire(import.meta.url);
const pdfjs = require("/tmp/recall-pdfjs/package/legacy/build/pdf.min.js");
pdfjs.GlobalWorkerOptions.workerSrc = "/tmp/recall-pdfjs/package/legacy/build/pdf.worker.min.js";

const { keptTextItem, textItemGap, textItemShadows } = await appTextRules();
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(pageNumber);
const { items, styles } = await page.getTextContent();

let joined = "";
let previous = null;
const seams = [];
const shadows = textItemShadows(items);
const stamps = [];
let leftOut = 0;
let partly = 0;
for (const [index, source] of items.entries()) {
  if (!source.str) continue;
  const item = keptTextItem(items, index, shadows);
  if (item !== source) {
    if (item) partly += 1;
    else leftOut += 1;
    stamps.push(`#${index} ${JSON.stringify(source.str)}`
      + (item ? `  keeps ${JSON.stringify(item.str)}` : `  stamps #${shadows.origin[index]}`));
  }
  if (!item) {
    if (source.hasEOL && previous) previous = source;
    continue;
  }
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
console.log(`overprinted: ${leftOut} item(s) left out, ${partly} partly`);
console.log("\n── as the app copies it ──");
console.log(joined.slice(0, 3000));
if (STAMPS) {
  console.log("\n── overprints ──");
  stamps.forEach((line) => console.log(line));
}
if (SEAMS) {
  console.log("\n── seams ──");
  seams.forEach((line) => console.log(line));
}
process.exit(0);
