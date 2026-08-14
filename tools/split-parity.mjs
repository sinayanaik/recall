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
  requestedAppVersion:
    "reads the ?v= off its own <script src>, which moved from app.js to src/main.js",
  RELEASE_STAMP_RE:
    "matches the <script src> in fetched HTML, which moved from app.js to src/main.js",
  fetchUrl:
    "calls fetchImportText, the URL-import half of the split fetchText — see REMOVED",
  fetchLiveRelease:
    "calls fetchReleaseText, the update-check half of the split fetchText — see REMOVED"
};

// Functions whose ONLY change is that a write to a module-level binding now goes
// through that binding's setter.
//
// This is the one edit the split forces on function bodies. `import { x }` makes
// x read-only in the importing module — assigning to it is an early SyntaxError
// that stops the whole graph instantiating — so a binding written from a module
// other than the one declaring it needs `setX(v)`. Reads are untouched: a live
// binding still shows every reader the current value, exactly as the shared
// script scope did.
//
// Listed by name rather than waved through, so a body that changed for any
// OTHER reason still fails. The check below verifies that the only difference is
// the setter rewrite; anything more is reported as a real change.
// Discovered, not hand-listed: every `export function setX(value) { x = value; }`
// in the tree, plus the bump helpers. Registering these by hand meant forgetting
// one and getting a spurious "body differs" report for a routing that was
// entirely mechanical.
const SETTER_ROUTED = new Map();
for (const f of walk(path.join(ROOT, "src"))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/export function (set[A-Za-z0-9_$]*)\(\s*([A-Za-z0-9_$]+)\s*\)\s*\{\s*([A-Za-z0-9_$]+) = \2;\s*\}/g)) {
    SETTER_ROUTED.set(m[1], { name: m[3], kind: "set" });
  }
  for (const m of text.matchAll(/export function (bump[A-Za-z0-9_$]*)\(\s*\)\s*\{\s*([A-Za-z0-9_$]+) \+= 1;/g)) {
    SETTER_ROUTED.set(m[1], { name: m[2], kind: "bump" });
  }
}


// Undo the setter rewrite on the CURRENT text; if it then matches the baseline,
// the setter routing was the whole of the difference.
function unroute(code) {
  let out = code;
  for (const [setter, { name, kind }] of SETTER_ROUTED) {
    if (kind === "bump") out = out.replaceAll(`${setter}();`, `${name} += 1;`);
    else out = out.replace(new RegExp(`\\b${setter}\\(([^;]*)\\);`, "g"), `${name} = $1;`);
  }
  return out;
}


// Baseline symbols that are intentionally gone, and why. A rename lands here
// (the old name) and in the ADDED list (the new one), which is the honest way
// to show it — the tool matches by name and cannot know the two are related.
const REMOVED = {
  fetchText:
    "declared TWICE in the baseline (app.js:25472 and app.js:29556). Legal in a " +
    "classic script, where the second silently won for every caller; a hard " +
    "SyntaxError in a module, so the app did not boot at all. Split into " +
    "fetchImportText (URL import, 45s) and fetchReleaseText (update check, 8s)."
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
const baseAllDecls = topLevelDecls(baseSrc);
const baseDupes = [];
for (const d of baseAllDecls) {
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
  if (!cur) {
    if (REMOVED[name]) accepted.push(`${name} (removed) — ${REMOVED[name]}`);
    else missing.push(name);
    continue;
  }
  if (normalize(base.text) === normalize(cur.text)) continue;
  if (ACCEPTED[name]) { accepted.push(`${name} — ${ACCEPTED[name]}`); continue; }
  if (normalize(base.text) === unroute(normalize(cur.text))) {
    accepted.push(`${name} — writes a moved binding through its setter`);
    continue;
  }
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

// ── The residual: everything that is NOT a top-level declaration ───────────
//
// Comparing declarations misses a third of the file. What is left over is the
// module-scope code — the event-listener registrations, the ~10 bootstrap calls
// — plus comments and blank lines. That residual is real behaviour, and an
// extraction can damage it: cutting an already-exported declaration from after
// its `export ` keyword left the keyword stranded on its own line, which is a
// SyntaxError that took the whole app down and which this file, comparing only
// declarations, reported as perfectly fine.
//
// So: strip every declaration, drop comments and whitespace, and compare what
// remains as one blob.
function residual(text, decls) {
  const cuts = [...decls].sort((a, b) => b.fullStart - a.fullStart);
  let out = text;
  for (const d of cuts) out = out.slice(0, d.fullStart) + out.slice(d.end);
  return normalize(out).replace(/\s+/g, " ").trim();
}

// Intentional module-scope changes, applied to the BASELINE so the comparison
// stays meaningful instead of being switched off. Each entry is a rewrite the
// restructure made on purpose, spelled out.
const RESIDUAL_REWRITES = [
  // Phase 1: a deferred module script sees readyState "interactive", so the
  // old inline `else` branch fired mid-file. See onDomReady in src/main.js.
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+)\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+), \{ once: true \}\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
];

let baseResidual = residual(baseSrc, baseAllDecls);
for (const [re, to] of RESIDUAL_REWRITES) baseResidual = baseResidual.replace(re, to);
// unroute() undoes the setter rewrite, so module-scope listeners that write a
// moved binding compare equal without weakening anything else.
const currentResidual = currentFiles
  .map((f) => {
    const text = readFileSync(f, "utf8");
    // Import statements are new by construction; they are not "leftover code".
    const stripped = text.split("\n").filter((l) => !/^import\s.+from\s*["'][^"']+["'];\s*$/.test(l)).join("\n");
    return residual(stripped, topLevelDecls(stripped));
  })
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const currentResidualUnrouted = unroute(currentResidual);

const residualDrift = [];
if (baseResidual !== currentResidualUnrouted) {
  let i = 0;
  while (i < baseResidual.length && baseResidual[i] === currentResidualUnrouted[i]) i++;
  residualDrift.push(
    "module-scope code differs from the baseline\n" +
    `    was: …${baseResidual.slice(Math.max(0, i - 60), i + 90)}\n` +
    `    now: …${currentResidualUnrouted.slice(Math.max(0, i - 60), i + 90)}`
  );
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
report("MODULE-SCOPE DRIFT", residualDrift);
report("accepted differences", accepted);

if (baseDupes.length) {
  console.log(`\nnote: the baseline itself declares these twice — ${baseDupes.join(", ")}`);
}

const fail = currentDupes.length + missing.length + changed.length + residualDrift.length;
console.log(
  `\n${baseDecls.size} baseline symbols · ${currentDecls.size} current · ` +
  `${currentDecls.size - added.length - missing.length} matched · ${fail} problem(s)`
);
process.exit(fail ? 1 : 0);
