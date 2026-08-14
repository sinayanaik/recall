// Cut styles.css into ordered files, without changing the cascade.
//
//   node tools/split-css.mjs          # split, then verify
//   node tools/split-css.mjs --check  # verify only
//
// styles.css is 13,784 lines with three section comments in it, which makes
// finding anything a scroll. Splitting it is worth doing, but a stylesheet is
// not a set of independent parts: later rules beat earlier ones at equal
// specificity, so ANY reordering is a behaviour change that shows up as a
// subtly wrong colour or a broken layout at one viewport width.
//
// So the cut is strictly contiguous. Each file is a slice of the original in
// its original order, loaded by ordered <link> tags, and the verification is
// exact: concatenating the parts must reproduce styles.css byte for byte.
//
// Deliberately NOT done: moving each feature's @media rules next to its base
// rules. There are 34 of them scattered through the file and gathering them
// would read far better — but it reorders the cascade, which is the one thing
// this cannot do while claiming to change nothing.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "styles.css");
const OUT_DIR = path.join(ROOT, "styles");
const CHECK_ONLY = process.argv.includes("--check");

// [start line (1-based, inclusive), file name, what it holds].
// Every start line is the first line of a TOP-LEVEL rule, found with
// tools/css-rules (see the boundaries in the commit that introduced this).
const SECTIONS = [
  [1,     "01-tokens.css",      "Custom properties and the ten themes"],
  [417,   "02-shell.css",       "App shell, layout, and the boot screens"],
  [845,   "03-toolbar.css",     "Top bar, toolbar and the mobile drawer"],
  [1141,  "04-import.css",      "The import panel and its staging preview"],
  [1966,  "05-study.css",       "The quiz panel and the card itself"],
  [2304,  "06-rendered.css",    "Rendered markdown: headings, tables, code, math, diagrams"],
  [3619,  "07-library.css",     "My Decks: rows, tiles, folders, drag and drop"],
  [4400,  "08-panels.css",      "Style panel, cloze panel, restore preview, EPUB preview"],
  [6192,  "09-all-cards.css",   "The All Cards panel and the Cornell layouts"],
  [8541,  "10-editor.css",      "Raw editor, its mirror, and the formatting toolbars"],
  [10230, "11-chrome.css",      "Empty states, Help, App Info, storage"],
  [11612, "12-notes.css",       "Highlights, note links, table of contents, backlinks"],
  [12988, "13-quick-notes.css", "The Quick Notes board"],
];

// styles.css itself is gone once the split has been applied, so the baseline
// comes from git — the point of the check is that styles/ still reassembles to
// the stylesheet the app shipped with before any of this began.
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const BASE_REF = (process.argv.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);
const source = existsSync(SOURCE)
  ? readFileSync(SOURCE, "utf8")
  : execFileSync("git", ["show", `${BASE_REF}:styles.css`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
const lines = source.split("\n");

// A boundary should carry the comment block sitting directly above it — that
// comment explains the rule it precedes, and leaving it at the end of the
// previous file strands it.
function pullBackComments(startLine) {
  let i = startLine - 1;               // 0-based index of the boundary line
  let j = i;
  while (j > 0) {
    const prev = lines[j - 1].trim();
    if (!prev) { j--; continue; }
    if (prev.startsWith("/*") || prev.startsWith("*") || prev.endsWith("*/")) { j--; continue; }
    break;
  }
  // Don't drag a trailing blank line along with it.
  while (j < i && !lines[j].trim()) j++;
  return j + 1;
}

const bounds = SECTIONS.map(([line], k) => (k === 0 ? 1 : pullBackComments(line)));
for (let k = 1; k < bounds.length; k++) {
  if (bounds[k] <= bounds[k - 1]) {
    console.error(`Section ${SECTIONS[k][1]} starts at or before the previous one.`);
    process.exit(2);
  }
}

const parts = SECTIONS.map(([, name, blurb], k) => {
  const from = bounds[k];
  const to = k + 1 < bounds.length ? bounds[k + 1] - 1 : lines.length;
  return { name, blurb, body: lines.slice(from - 1, to).join("\n"), from, to };
});

// The whole point: the parts must reassemble into exactly the original.
const rebuilt = parts.map((p) => p.body).join("\n");
if (rebuilt !== source) {
  console.error("Reassembly does not match styles.css — refusing to write.");
  let i = 0;
  while (i < rebuilt.length && rebuilt[i] === source[i]) i++;
  console.error(`first difference at byte ${i}:`);
  console.error(`  original: ${JSON.stringify(source.slice(i - 60, i + 60))}`);
  console.error(`  rebuilt : ${JSON.stringify(rebuilt.slice(i - 60, i + 60))}`);
  process.exit(1);
}

if (CHECK_ONLY) {
  if (!existsSync(OUT_DIR)) { console.log("styles/ does not exist yet."); process.exit(0); }
  const onDisk = readdirSync(OUT_DIR).sort().filter((f) => f.endsWith(".css"));
  // Each file carries a three-line banner that is not part of the stylesheet.
  const joined = onDisk
    .map((f) => readFileSync(path.join(OUT_DIR, f), "utf8").replace(/^\/\*[\s\S]*?\*\/\n/, ""))
    .join("\n");
  const ok = joined === source;
  console.log(ok
    ? `styles/ reassembles to ${BASE_REF}:styles.css exactly (${onDisk.length} files, ${source.split("\n").length} lines)`
    : `styles/ does NOT reassemble to ${BASE_REF}:styles.css`);
  if (!ok) {
    let i = 0;
    while (i < joined.length && joined[i] === source[i]) i++;
    console.log(`  first difference at byte ${i}`);
    console.log(`    expected: ${JSON.stringify(source.slice(i - 50, i + 50))}`);
    console.log(`    got     : ${JSON.stringify(joined.slice(i - 50, i + 50))}`);
  }
  process.exit(ok ? 0 : 1);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const p of parts) {
  const banner = `/* ${p.blurb}\n * Part of the split styles.css — see tools/split-css.mjs. Order matters.\n */\n`;
  writeFileSync(path.join(OUT_DIR, p.name), banner + p.body);
  console.log(`  ${p.name.padEnd(20)} lines ${String(p.from).padStart(6)}–${String(p.to).padEnd(6)} (${p.to - p.from + 1})`);
}
console.log(`\n${parts.length} files, ${lines.length} lines, reassembly verified byte-for-byte.`);
