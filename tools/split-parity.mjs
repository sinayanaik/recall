// Did the restructure change any code?
//
//   node tools/split-parity.mjs                 # compare against main
//   node tools/split-parity.mjs --base=<ref>    # ...or any git ref
//   node tools/split-parity.mjs --show <name>   # print both sides of one symbol
//
// The whole premise of the restructure is that it is PURE CODE MOVEMENT: the
// same 1,255 functions and 410 bindings, in different files, with imports added.
// Nothing about that premise is self-evident once 35,000 lines are in flight,
// and "it still seems to work" is not a check — most of this codebase is paths
// that only run during an EPUB import, a sync conflict, or a PDF export.
//
// So: pull every top-level declaration out of the baseline app.js and out of the
// current tree, and compare them by name, modulo whitespace and comments. A
// correct split reports every symbol present exactly once with an identical
// body. Anything else is a lost function, a duplicated one, or an edit that
// sneaked in with the move.
//
// The corollary is a working rule: BUG FIXES GO IN THEIR OWN COMMITS, after the
// move that carried the code. A fix buried inside a 3,000-line file move is
// invisible to review and to this tool. A fix in its own commit is a two-line
// diff that anyone can read.
//
// Intentional changes are recorded in ACCEPTED below, with the reason.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls, normalize } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baseRef = (args.find((a) => a.startsWith("--base=")) || "--base=main").slice(7);
const showIdx = args.indexOf("--show");
const showName = showIdx !== -1 ? args[showIdx + 1] : null;

// Declarations that are ALLOWED to differ, and why. Keep this short — every
// entry is a place where the "pure movement" guarantee was deliberately spent.
const ACCEPTED = {
  // name: "reason"
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// The baseline: app.js as it stood before any of this began.
let baseSrc;
try {
  baseSrc = execFileSync("git", ["show", `${baseRef}:app.js`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
} catch (_) {
  console.error(`Could not read app.js at '${baseRef}'. Pass --base=<ref> for the pre-restructure commit.`);
  process.exit(2);
}

// The current tree: whatever is in src/, plus app.js if it is still there (it is,
// until phase 1 moves it).
const currentFiles = walk(path.join(ROOT, "src"));
if (existsSync(path.join(ROOT, "app.js"))) currentFiles.push(path.join(ROOT, "app.js"));
if (!currentFiles.length) {
  console.error("Nothing to compare: no src/**/*.js and no app.js.");
  process.exit(2);
}

const baseDecls = new Map();
const baseDupes = [];
for (const d of topLevelDecls(baseSrc)) {
  if (baseDecls.has(d.name)) baseDupes.push(`${d.name} (lines ${baseDecls.get(d.name).line} and ${d.line})`);
  baseDecls.set(d.name, d);
}

const currentDecls = new Map();
const currentDupes = [];
for (const file of currentFiles) {
  const rel = path.relative(ROOT, file);
  for (const d of topLevelDecls(readFileSync(file, "utf8"))) {
    d.file = rel;
    if (currentDecls.has(d.name)) {
      const first = currentDecls.get(d.name);
      currentDupes.push(`${d.name} — ${first.file}:${first.line} and ${rel}:${d.line}`);
    }
    currentDecls.set(d.name, d);
  }
}

if (showName) {
  const a = baseDecls.get(showName);
  const b = currentDecls.get(showName);
  console.log(`--- ${baseRef}:app.js ---\n${a ? a.text : "(absent)"}`);
  console.log(`\n--- current (${b ? b.file : "absent"}) ---\n${b ? b.text : "(absent)"}`);
  process.exit(0);
}

const missing = [];
const changed = [];
const added = [];
const accepted = [];

for (const [name, base] of baseDecls) {
  const cur = currentDecls.get(name);
  if (!cur) { missing.push(name); continue; }
  if (normalize(base.text) === normalize(cur.text)) continue;
  if (ACCEPTED[name]) { accepted.push(`${name} — ${ACCEPTED[name]}`); continue; }
  // Where do they first diverge? Far more useful than "these differ".
  const na = normalize(base.text), nb = normalize(cur.text);
  let i = 0;
  while (i < na.length && na[i] === nb[i]) i++;
  changed.push(
    `${name}  (${cur.file}:${cur.line})\n` +
    `    was: …${na.slice(Math.max(0, i - 40), i + 70)}\n` +
    `    now: …${nb.slice(Math.max(0, i - 40), i + 70)}`
  );
}
for (const name of currentDecls.keys()) {
  if (!baseDecls.has(name)) added.push(`${name} (${currentDecls.get(name).file})`);
}

const report = (label, list, verbose = true) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length})`);
  for (const line of (verbose ? list : list.slice(0, 40))) console.log(`  ${line}`);
  if (!verbose && list.length > 40) console.log(`  … and ${list.length - 40} more`);
};

// Duplicate names in the CURRENT tree are the headline failure: two modules each
// owning a symbol of the same name is exactly the flat-scope collision this
// restructure exists to make impossible (see fetchText).
report("DUPLICATE in current tree — two modules own the same name", currentDupes);
report("MISSING — in the baseline, gone from the tree", missing, false);
report("CHANGED — body differs from the baseline", changed);
report("ADDED — new since the baseline (expected: setters, module glue)", added, false);
report("accepted differences", accepted);

if (baseDupes.length) {
  console.log(`\nnote: the baseline itself declares these twice — ${baseDupes.join(", ")}`);
}

const fail = currentDupes.length + missing.length + changed.length;
console.log(
  `\n${baseDecls.size} baseline symbols · ${currentDecls.size} current · ` +
  `${currentDecls.size - added.length - missing.length} matched · ${fail} problem(s)`
);
process.exit(fail ? 1 : 0);
