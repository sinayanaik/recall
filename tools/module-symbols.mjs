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
import { topLevelDecls, blankLiterals, referencedIdentifiers, parseImports, locallyBound, stripFunctionBodies, GLOBALS } from "./js-scan.mjs";

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
const assignedImports = [];
const shadowed = [];

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

  // Does the module we import from actually EXPORT the name we ask for?
  //
  // This gap shipped once: lib-loader.js imported configureMermaid from main.js,
  // which declared it but never exported it. The import was present, correct and
  // resolvable, so nothing here objected — and the page died at instantiation
  // with "does not provide an export named 'configureMermaid'". Only loading it
  // in a browser found that, which is one round trip too many.
  for (const [name, source] of imported) {
    if (!source.startsWith(".")) continue;
    const abs = path.resolve(path.dirname(path.join(ROOT, rel)), source.replace(/\?.*$/, ""));
    const from = path.relative(ROOT, abs);
    const target = parsed.get(from);
    if (!target) { badSpecifiers.push(`${rel} imports from "${source}", which does not exist`); continue; }
    const decl = target.decls.find((d) => d.name === name);
    if (!decl) notExported.push(`${from} has no '${name}' at all, but ${rel} imports it`);
    else if (!decl.exported) notExported.push(`${from}:${decl.line} declares '${name}' but does not export it (${rel} imports it)`);
  }

  // An imported binding is READ-ONLY in the importing module: `foo = 1` where
  // foo came from an import is an early SyntaxError, so the whole module fails
  // to instantiate. That matters here because app.js had 115 top-level `let`s,
  // many written from what will become a different module — so this is the
  // single most likely way an otherwise-correct extraction breaks. Either the
  // binding moves in with its writer, or it needs an exported setter.
  for (const m of blanked.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|\+\+|--|\+=|-=|\*=|\/=|%=|\|\|=|&&=|\?\?=)/g)) {
    if (!imported.has(m[2])) continue;
    const line = raw.slice(0, m.index).split("\n").length;
    assignedImports.push(`${rel}:${line} assigns to ${m[2]}, which it imports from ${imported.get(m[2])}`);
  }

  // Two levels of "is this name this file's own?".
  //
  // topBound — declared at top level here — is the only thing that genuinely
  // rules out an import (a top-level declaration and an import of the same name
  // is a duplicate-declaration SyntaxError). `bound` is the file-wide,
  // scope-blind set, which counts every nested parameter and local.
  //
  // Judging by `bound` alone is what let `el` go unimported: one
  // `list.forEach((el) => …)` somewhere in the file was enough to mark the DOM
  // map as local, and the page died on "el is not defined". So a name that is
  // only nested-bound is still reported — as a WARNING, since a genuinely local
  // variable that happens to share a name with another module's export is
  // common and harmless.
  const topBound = new Set(decls.map((d) => d.name));
  const used = new Set();
  for (const name of referencedIdentifiers(raw)) {
    if (imported.has(name)) { used.add(name); continue; }
    if (topBound.has(name) || GLOBALS.has(name)) continue;
    const own = owner.get(name);
    if (!own || own.file === rel) continue;
    if (!own.exported) notExported.push(`${own.file}:${own.line} — ${name} is referenced by ${rel} but not exported`);
    if (bound.has(name)) shadowed.push(`${rel} references ${name} (owned by ${own.file}) but also binds it locally — check no outer use needs the import`);
    else missing.push(`${rel} uses ${name}, owned by ${own.file}:${own.line}`);
  }
  if (SHOW_UNUSED) {
    for (const name of imported.keys()) if (!used.has(name)) unused.push(`${rel} imports ${name} but never uses it`);
  }
}

// ── Pass 3: top-level initialisers that read across an import CYCLE ────────
//
// A module's top-level `const X = f(Y)` runs the moment the module is
// evaluated. If Y is imported from a module that has not been evaluated yet,
// the read hits the temporal dead zone and throws — not undefined, a hard
// ReferenceError that aborts the whole graph.
//
// That only happens inside a cycle, and cycles are normal and safe here: almost
// everything crossing a module edge is a function declaration, hoisted and
// called long after both sides are live. So the check is narrow — flag a
// top-level INITIALISER that reads an imported name whose source module can
// reach back to this one.
//
// Twice now this shipped and the browser was the only thing that noticed:
// categories.js initialising webDeckCategories from main.js's
// defaultDeckCategory, and render-toolbar.js seeding its default from
// highlight.js's MARK_HIGHLIGHT_HEX. Both fixes were the same — move the value
// into a leaf module that imports nothing.
const cycleReads = [];
{
  const edges = new Map();
  for (const [rel, { raw }] of parsed) {
    const out = new Set();
    for (const { source } of parseImports(raw).sources) {
      if (!source.startsWith(".")) continue;
      const abs = path.resolve(path.dirname(path.join(ROOT, rel)), source.replace(/\?.*$/, ""));
      out.add(path.relative(ROOT, abs));
    }
    edges.set(rel, out);
  }
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of edges.get(from) || []) if (reaches(next, to, seen)) return true;
    return false;
  };

  for (const [rel, { raw, decls }] of parsed) {
    const { names: imported } = parseImports(raw);
    if (!imported.size) continue;
    for (const d of decls) {
      if (d.kind !== "const" && d.kind !== "let") continue;
      const eq = d.text.indexOf("=");
      if (eq === -1) continue;
      // Only what runs at import time: nested function bodies are deferred.
      const init = stripFunctionBodies(d.text.slice(eq + 1));
      for (const name of referencedIdentifiers(init)) {
        const source = imported.get(name);
        if (!source || !source.startsWith(".")) continue;
        const abs = path.resolve(path.dirname(path.join(ROOT, rel)), source.replace(/\?.*$/, ""));
        const from = path.relative(ROOT, abs);
        if (!reaches(from, rel)) continue;   // no cycle: evaluation order is fine

        // Only const/let/class have a temporal dead zone. A FUNCTION
        // declaration is hoisted into the module environment during
        // instantiation — before any module body runs — so reading an imported
        // function at import time is safe even around a cycle. Without this
        // distinction the check reported 26 problems on a tree that boots
        // perfectly, nearly all of them tables of function references like
        // OVERLAY_LAYERS and RENDER_INLINE_FORMATS, and a check that cries wolf
        // is a check nobody reads.
        const decl = parsed.get(from)?.decls.find((x) => x.name === name);
        if (!decl || decl.kind === "function") continue;

        cycleReads.push(
          `${rel}:${d.line} — \`${d.name}\` reads ${name} (a ${decl.kind}) from ${from} at import ` +
          `time, and ${from} can reach back to ${rel}. Move ${name} into a module that imports nothing.`
        );
      }
    }
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
report("ASSIGNS TO AN IMPORT — read-only binding; move it or add a setter", assignedImports, 40);
report("TDZ RISK — top-level initialiser reads across an import cycle", [...new Set(cycleReads)], 30);
if (SHOW_UNUSED) report("shadowed (warning, not counted)", shadowed, 30);
else if (shadowed.length) console.log(`\n${shadowed.length} shadowed-name warning(s) — run with --unused to list them`);
if (SHOW_UNUSED) report("unused imports", unused, 60);

const fail = duplicates.length + missing.length + badSpecifiers.length
  + assignedImports.length + notExported.length + new Set(cycleReads).size;
console.log(`\n${files.length} modules · ${owner.size} symbols · ${fail} problem(s)`);
process.exit(fail ? 1 : 0);
