// Does the Help guide say what the app does now?
//
//   node tools/help-coverage-check.mjs
//
// Nothing checked it. Features landed with their own checks and their own
// commit messages, and the Help guide (☰ → Help & Guide, the #helpModal in
// index.html) — the only manual a person using the app ever reads — learnt of
// them or did not, by chance. A pass over the last thirty commits found seven
// it had never been told about (the middle mouse button that pans the page,
// copies pasted where the mouse is, the ＋ Page pill, page numbers, the widest
// a Block grows, bare numbers in the style boxes, the Canvas PDF's selectable
// words) and two things it still described that had gone (the ◢ corner of a
// Block, a Block growing "up to the page's right edge").
//
// So: one row per feature — the module that does it, and a phrase the guide
// must contain for it. A feature whose module is gone fails here too, so a row
// cannot outlive what it describes. And one row per RETIRED phrase: words that
// described something the app no longer does. NOMENCLATURE.md and README.md
// are held to the names they own the same way.
//
// When you add a feature a person has to be told about, add its row.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
const nomenclature = readFileSync(path.join(ROOT, "NOMENCLATURE.md"), "utf8");
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");

// The guide alone: from #helpModal to the end of its section.
const start = html.indexOf('id="helpModal"');
const end = html.indexOf('id="appInfoModal"');
const help = start >= 0 && end > start
  ? html.slice(start, end)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#43;/g, "+").replace(/&#9633;/g, "□").replace(/&#8943;/g, "⋯").replace(/&hellip;/g, "…")
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
  : "";

// [what, module that does it, phrases the guide must hold (all of them)]
const FEATURES = [
  ["Section lines in Notes", "src/notes/section-lines.js", ["Section lines"]],
  ["The middle mouse button pans a page", "src/documents/middle-pan.js", ["middle mouse button", "drag"]],
  ["Copied Blocks, shapes and ink paste at the mouse", "src/documents/canvas-selection.js", ["where the mouse is", "lassoed ink"]],
  ["Insert → Paste blocks", "src/documents/block-place.js", ["Paste blocks"]],
  ["＋ Page between Canvas pages", "src/documents/pdf-view.js", ["＋ Page"]],
  ["Canvas page numbers and their switch", "src/documents/notebook.js", ["page number", "Page numbers"]],
  ["Page setup", "src/documents/canvas-setup-dialog.js", ["Page setup"]],
  ["The widest a Block grows", "src/documents/block-measure.js", ["Widest a Block grows", "62%"]],
  ["Connectors pinned to a Block's edge", "src/documents/pdf-connectors.js", ["Let go on the edge"]],
  ["Dragging onto another page", "src/documents/page-handoff.js", ["over another page"]],
  ["View only", "src/documents/view-only.js", ["View only"]],
  ["Bare numbers in the style boxes", "src/ui/style-settings.js", ["a bare number is enough"]],
  ["The Canvas PDF's words are words", "src/documents/pdf-export.js", ["select, copy and search"]],
  ["Back up one file, a folder, ticked files or the library", "src/backup/share-dialog.js", ["whole library", "one file", "one folder", "Back up this folder"]],
  ["The offline viewer in every backup", "src/backup/viewer-pack.js", ["index.html", "offline viewer", "read-only"]],
  [".zip or .recall", "src/backup/backup.js", ["Save as .zip"]],
  ["Web pictures downloaded into a backup", "src/backup/backup.js", ["Download pictures from other websites too", "wsrv.nl"]],
  ["Web pictures saved into a file", "src/images/keep-web-images.js", ["Save web pictures into this file"]]
];

// Words that described something the app no longer does.
const RETIRED = [
  ["◢ corner", "a Block's resize corner is no longer painted (9084466)"],
  ["up to the page's right edge, then taller", "a Canvas Block grows to the reading width, not the page's edge (d81b270)"],
  ["Export → Share (.recall — everything)", "the menu item is Back up or share now"]
];

// [file text, file name, phrases it must hold]
const OWNED = [
  [nomenclature, "NOMENCLATURE.md", ["Offline viewer", "Web pictures", "middle-pan.js", "viewer-pack.js", "keep-web-images.js", "Paste blocks"]],
  [readme, "README.md", ["index.html", "viewer/files/0001.js", "wsrv.nl", "keep-web-images.js", "backup-viewer", "help-coverage"]]
];

let ran = 0;
let failed = 0;
function check(label, ok, detail = "") {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

check("the Help guide is found in index.html", help.length > 20000, `${help.length} characters`);
for (const [what, module, phrases] of FEATURES) {
  const gone = phrases.filter((phrase) => !help.includes(phrase));
  check(`Help tells of: ${what}`, existsSync(path.join(ROOT, module)) && !gone.length,
    !existsSync(path.join(ROOT, module)) ? `${module} no longer exists — retire or update this row` : `missing ${gone.map((p) => `“${p}”`).join(", ")}`);
}
for (const [phrase, why] of RETIRED) {
  check(`Help no longer says “${phrase}”`, !help.includes(phrase), why);
}
for (const [text, name, phrases] of OWNED) {
  const gone = phrases.filter((phrase) => !text.includes(phrase));
  check(`${name} names what it owns`, !gone.length, `missing ${gone.map((p) => `“${p}”`).join(", ")}`);
}

console.log(`\n  ${ran} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
