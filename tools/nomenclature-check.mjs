// Does every word a person READS use the app's names for things?
//
//   node tools/nomenclature-check.mjs
//
// The vocabulary is in NOMENCLATURE.md. In one line: the library holds FILES,
// and each file has four parts — Cards, Notes, PDFs and Canvas. Before that was
// written down, "deck" meant the whole file in one dialog and only its
// flashcards in the next, and the handwritten pages were "Handwriting" in the
// Help guide, "Write" on their tab and "notebook" in their toasts. A bug report
// that said "the deck" could be about any of five things.
//
// The CODE still says deck, notebook and handwriting, on purpose: those names
// are in the Supabase schema, in localStorage keys, in backup archives and in
// synced settings, and renaming any of them breaks somebody's existing library.
// So this check reads only what reaches the screen:
//
//   index.html  text between tags, and the title / aria-label / placeholder /
//               alt values — never comments, ids, classes or data-* values
//   src/**/*.js string and template-literal text that reads as prose (it has
//               a space in it, or starts with a capital), with HTML attribute
//               names like class="…" / id="…" removed first
//   manifests   the description a store or an install prompt shows
//
// A word glued to - _ . # / or a letter is an identifier, not prose, so
// "deck-meta", "deck_id", "#deck" and "my-decks" never match.
//
// Something that genuinely has to keep an old word (SQL that names the real
// `decks` table, say) goes in ALLOWED below with its reason.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blankLiterals, stringLiterals } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each old word, and what to say instead.
const TERMS = [
  { re: /(?<![\w\-.#/:$@])decks?(?![\w\-])/i, use: "file / files — or cards, when only the flashcards are meant" },
  { re: /(?<![\w\-.#/:$@])flash-?cards?(?![\w\-])/i, use: "card / cards" },
  // "Handwriting" is still the word for what a pen leaves ("ink that follows
  // your handwriting"); what is banned is naming the PART with it.
  { re: /(?<![\w\-.#/:$@])handwrit(?:ing|ten) (?:notes?|pages?|tab|view|surface)(?![\w\-])|^\s*handwriting\s*$/i, use: "canvas" },
  { re: /(?<![\w\-.#/:$@])notebooks?(?![\w\-])/i, use: "canvas" },
  { re: /(?<![\w\-.#/:$@])study notes(?![\w\-])/i, use: "notes" }
];

// [file, a substring of the offending text ("" for the whole file), why it stays]
const ALLOWED = [
  ["src/export/sql.js", "INSERT INTO decks", "SQL that names the real `decks` table — the schema keeps its name"],
  ["src/pwa/app-info.js", "Files table (decks)", "the health check names the real Supabase table it probed"],
  ["src/storage/document-migration.js", "notebook:meta->notebook", "a Supabase column list, not prose"],
  ["src/backup/backup.js", "decks/", "the archive's real folder name, which every older backup also uses"],
  ["src/backup/archive-format.js", "", "describes the archive's own data model for the code (decks/, meta.notebook, "
    + "localStorage keys) — none of it is shown, and every name in it is fixed by archives already written"],
  ["src/format/ink-svg.js", "Handwriting", "the SVG title of a drawing: what is on it, not the Canvas"],
  ["src/ui/theme-catalog.js", "Handwriting", "a font category (Caveat, Kalam, Patrick Hand)"]
];

const failures = [];
let checked = 0;

function allowed(file, text) {
  return ALLOWED.some(([f, needle]) => f === file && (needle === "" || text.includes(needle)));
}

// The name of the function a literal is an argument of — `console.warn` for
// the message in console.warn("…", error) — or "". Walks back over the code
// (literals blanked) to the nearest unmatched "(", then reads the callee.
function calleeOf(blanked, pos) {
  let depth = 0;
  for (let k = pos - 1; k >= 0 && pos - k < 4000; k--) {
    const c = blanked[k];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) {
        if (c !== "(") return "";
        let j = k;
        while (j > 0 && /\s/.test(blanked[j - 1])) j--;
        let e = j;
        while (e > 0 && /[\w$.]/.test(blanked[e - 1])) e--;
        return blanked.slice(e, j);
      }
      depth--;
    } else if (c === ";" && depth === 0) return "";
  }
  return "";
}

function test(file, line, text) {
  checked++;
  for (const { re, use } of TERMS) {
    const m = text.match(re);
    if (!m) continue;
    if (allowed(file, text)) return;
    failures.push({ file, line, word: m[0], use, text: text.replace(/\s+/g, " ").trim().slice(0, 140) });
    return;
  }
}

// Replace a matched region with spaces, keeping newlines, so offsets and line
// numbers computed against the result still point into the original.
function blank(src, re) {
  return src.replace(re, (s) => s.replace(/[^\n]/g, " "));
}

function lineOf(src, pos) {
  let n = 1;
  for (let k = 0; k < pos; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ");
}

// ── index.html ───────────────────────────────────────────────────────────────
{
  const file = "index.html";
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  let s = blank(src, /<!--[\s\S]*?-->/g);
  s = blank(s, /<script\b[\s\S]*?<\/script>/gi);
  s = blank(s, /<style\b[\s\S]*?<\/style>/gi);

  // Attribute values a person reads.
  const attrRe = /\s(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/gi;
  for (const tag of s.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const a of tag[0].matchAll(attrRe)) {
      test(file, lineOf(src, tag.index + a.index), decodeEntities(a[1]));
    }
  }
  // Text between tags. Each run is tested on its own, so a hit names the line.
  const text = blank(s, /<[^>]*>/g);
  const label = /\S[^\n]*/g;
  for (const m of text.matchAll(label)) {
    test(file, lineOf(src, m.index), decodeEntities(m[0]));
  }
  // The tabs. "Write" is a fine word in a sentence and only wrong as a name.
  for (const m of s.matchAll(/class="(?:vm-label|rr-label)">\s*Write\s*</g)) {
    failures.push({ file, line: lineOf(src, m.index), word: "Write", use: "Canvas", text: m[0] });
  }
}

// ── src/**/*.js ─────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}

for (const abs of walk(path.join(ROOT, "src"))) {
  const file = path.relative(ROOT, abs).split(path.sep).join("/");
  const src = fs.readFileSync(abs, "utf8");
  const blanked = blankLiterals(src);
  for (const { text, line, start } of stringLiterals(src)) {
    if (!/\s/.test(text) && !/^[A-Z]/.test(text)) continue;  // a key, an id, a selector
    // Developer messages describe the code, and the code says deck.
    if (/^console\./.test(calleeOf(blanked, start))) continue;
    // Markup inside a template: drop the attributes nobody reads.
    const prose = text
      .replace(/\b(?:class|id|for|name|href|src|type|role|data-[\w-]+)\s*=\s*(?:\\?"[^"]*\\?"|'[^']*')/g, " ")
      .replace(/<\/?[a-zA-Z][\w-]*/g, " ");
    test(file, line, decodeEntities(prose));
  }
}

// ── manifests ───────────────────────────────────────────────────────────────
for (const file of ["manifest.webmanifest", "recall-clipper/manifest.json"]) {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  for (const key of ["name", "short_name", "description"]) {
    if (typeof json[key] === "string") test(file, 0, json[key]);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
for (const f of failures) {
  console.log(`  FAIL ${f.file}:${f.line}  "${f.word}" → ${f.use}\n         ${f.text}`);
}
console.log(`CHECK: ${checked} checks · ${failures.length} failed`);
if (failures.length) {
  console.log("\nThe names a person reads are File, Cards, Notes, PDFs and Canvas — see NOMENCLATURE.md.");
  process.exit(1);
}
