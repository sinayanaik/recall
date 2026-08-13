// Is every cross-module reference actually imported?
//
//   node tools/module-symbols.mjs           # fail on any problem
//   node tools/module-symbols.mjs --unused  # also list unused imports
//
// app.js was one classic script, so every one of its 1,665 top-level names was
// visible to every other. Splitting it into modules replaces that with explicit
// imports — and the failure mode of getting one wrong is a ReferenceError on a
// path that might only run during an EPUB import or a sync conflict. Waiting to
// find those by clicking is not a plan.
//
// So, statically:
//   1. Build symbol -> owning module across src/**. Two modules owning the same
//      name is a hard error: that is the flat-scope collision this restructure
//      exists to make impossible, and it is exactly how fetchText got declared
//      twice with the second silently winning for every caller.
//   2. Per module, every identifier that some OTHER module owns must appear in
//      that module's imports.
//
// Deliberately biased toward over-reporting. A name flagged that turns out to be
// a local is a few seconds to dismiss; a name MISSED is a crash in production.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls, blankLiterals, referencedIdentifiers, parseImports, locallyBound, GLOBALS } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const SHOW_UNUSED = process.argv.includes("--unused");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(SRC);
if (!files.length) {
  console.log("No modules under src/ yet — nothing to check.");
  process.exit(0);
}

// ── Pass 1: who owns what ──────────────────────────────────────────────────
const owner = new Map();
const duplicates = [];
const parsed = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const raw = readFileSync(file, "utf8");
  const blanked = blankLiterals(raw);
  const decls = topLevelDecls(raw);
  parsed.set(rel, { raw, blanked, decls });
  for (const d of decls) {
    if (owner.has(d.name)) {
      duplicates.push(`${d.name} — ${owner.get(d.name).file}:${owner.get(d.name).line} and ${rel}:${d.line}`);
    } else {
      owner.set(d.name, { file: rel, line: d.line, exported: d.exported });
    }
  }
}

// ── Pass 2: is every cross-module reference imported? ──────────────────────
const missing = [];
const notExported = [];
const unused = [];
const badSpecifiers = [];

for (const [rel, { raw, blanked, decls }] of parsed) {
  const { names: imported, sources } = parseImports(raw);
  const bound = locallyBound(blanked);
  for (const d of decls) bound.add(d.name);

  // Every relative import must carry the release stamp, or a deploy can serve a
  // new entry module against a cached old dependency. deploy.yml enforces this
  // too; catching it here means finding out before CI does.
  for (const { source } of sources) {
    if (source.startsWith(".") && !source.includes("?v=")) {
      badSpecifiers.push(`${rel} — "${source}" is missing ?v=__BUILD__`);
    }
  }

  const used = new Set();
  for (const name of referencedIdentifiers(raw)) {
    if (imported.has(name)) { used.add(name); continue; }
    if (bound.has(name) || GLOBALS.has(name)) continue;
    const own = owner.get(name);
    if (!own || own.file === rel) continue;
    missing.push(`${rel} uses ${name}, owned by ${own.file}:${own.line}`);
    if (!own.exported) notExported.push(`${own.file}:${own.line} — ${name} is referenced by ${rel} but not exported`);
  }
  if (SHOW_UNUSED) {
    for (const name of imported.keys()) if (!used.has(name)) unused.push(`${rel} imports ${name} but never uses it`);
  }
}

const report = (label, list, limit = Infinity) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length})`);
  for (const line of list.slice(0, limit)) console.log(`  ${line}`);
  if (list.length > limit) console.log(`  … and ${list.length - limit} more`);
};

report("DUPLICATE OWNER — two modules declare the same top-level name", duplicates);
report("MISSING IMPORT", missing, 60);
report("NOT EXPORTED", [...new Set(notExported)], 40);
report("UNSTAMPED IMPORT — relative import without ?v=__BUILD__", badSpecifiers, 40);
if (SHOW_UNUSED) report("unused imports", unused, 60);

const fail = duplicates.length + missing.length + badSpecifiers.length;
console.log(`\n${files.length} modules · ${owner.size} symbols · ${fail} problem(s)`);
process.exit(fail ? 1 : 0);
