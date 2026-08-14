// Move declarations out of src/main.js into a module, and wire the imports.
//
//   node tools/extract-module.mjs src/render/math.js protectMath findMathRanges …
//   node tools/extract-module.mjs --plan plans/render.json
//   node tools/extract-module.mjs … --dry
//
// Splitting 1,665 declarations across ~50 files by hand is not a careful job,
// it is a typing job with 1,665 chances to drop a line. So the moves are
// mechanical: this takes a target file and a list of top-level symbols, lifts
// each declaration WITH the comment block above it, writes them out with
// `export`, and computes every import both sides now need from the symbol table.
//
// It never edits a declaration's body. That is what lets tools/split-parity.mjs
// prove afterwards that the code is byte-identical to the baseline — a
// guarantee no amount of careful hand-editing could offer.
//
// Cycles are expected during the transition: main.js imports the new module,
// and the new module imports what it still needs back from main.js. That is
// safe here because an extracted module contains only DECLARATIONS — nothing
// runs at import time, so a function body that reaches back into main.js is
// evaluated at call time, long after both modules are initialised. The tool
// refuses to move a declaration that would break that (see --dry output).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  topLevelDecls, blankLiterals, referencedIdentifiers, parseImports, locallyBound, GLOBALS
} from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const MAIN = path.join(SRC, "main.js");
const STAMP = "?v=__BUILD__";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const args = argv.filter((a) => a !== "--dry");

const FIX_IMPORTS = args.includes("--fix-imports");

let jobs = [];
const planIdx = args.indexOf("--plan");
if (FIX_IMPORTS) {
  jobs = [];
} else if (planIdx !== -1) {
  // [{ target, symbols }] or [{ target, from, to, except? }] — applied in order.
  jobs = JSON.parse(readFileSync(path.resolve(ROOT, args[planIdx + 1]), "utf8"));
} else {
  const [target, ...symbols] = args;
  if (!target || !symbols.length) {
    console.error("usage: extract-module.mjs <src/dir/file.js> <symbol...> [--dry]");
    console.error("       extract-module.mjs --plan <plan.json> [--dry]");
    console.error("       extract-module.mjs --fix-imports [--dry]");
    process.exit(2);
  }
  jobs = [{ target, symbols }];
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".js")) out.push(full);
  }
  return out;
}

// A declaration's comment block: the run of comment lines immediately above it,
// stopping at a blank line, at code, or at the previous declaration's end. This
// is why the moves stay readable — the comments in this codebase carry most of
// the reasoning, and a symbol that arrives without its explanation has lost the
// thing that made it maintainable.
function commentStart(src, declStart, floor) {
  const before = src.slice(0, declStart);
  const lines = before.split("\n");
  // lines[lines.length-1] is the (empty) partial line the decl starts on.
  let i = lines.length - 2;
  let taken = 0;
  let inBlock = false;
  while (i >= 0) {
    const line = lines[i];
    const t = line.trim();
    if (inBlock) {
      taken++;
      if (t.startsWith("/*")) inBlock = false;
      i--;
      continue;
    }
    if (t.endsWith("*/")) { inBlock = true; taken++; i--; continue; }
    if (t.startsWith("//")) { taken++; i--; continue; }
    break;
  }
  if (!taken) return declStart;
  const start = lines.slice(0, lines.length - 1 - taken).join("\n").length + (lines.length - 1 - taken > 0 ? 1 : 0);
  return Math.max(start, floor);
}

// Import lines for `needed`, grouped by owning file, as text.
function importLines(fromFile, needed, owner) {
  const byFile = new Map();
  for (const name of [...needed].sort()) {
    const own = owner.get(name);
    if (!own) continue;
    if (!byFile.has(own.file)) byFile.set(own.file, []);
    byFile.get(own.file).push(name);
  }
  const out = [];
  for (const [file, names] of [...byFile].sort()) {
    let rel = path.relative(path.dirname(fromFile), path.join(ROOT, file)).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    out.push(`import { ${names.sort().join(", ")} } from "${rel}${STAMP}";`);
  }
  return out;
}

const IMPORT_LINE = /^import\s.+from\s*["'][^"']+["'];\s*$/;

// Recompute, for one file's text, which foreign symbols it references.
//
// Called on text with the import lines ALREADY STRIPPED, deliberately. Deriving
// the full set every time is what keeps main.js's import block correct as
// symbols leave it: an earlier version excluded anything already imported and so
// silently dropped the build.js import the moment a second module was extracted.
// "Bound" here means declared AT TOP LEVEL of this file — deliberately not the
// file-wide locallyBound(), which counts every nested parameter and local.
//
// locallyBound has no idea about scope, so one `list.forEach((el) => …)`
// anywhere in 31,000 lines made it believe `el` was this file's own, and the
// import of the DOM map was never written. The app died on `el is not defined`
// in a module-scope listener.
//
// Importing a name that some inner scope also binds is harmless: the local
// shadows the import inside that scope, exactly as it shadowed the old
// script-wide binding, and every outer reference resolves to the import. The
// only thing that genuinely cannot coexist with an import is a TOP-LEVEL
// declaration of the same name, which is a duplicate-declaration SyntaxError.
// So erring toward more imports is both safe and correct; the cost is the
// occasional unused one, which `module-symbols --unused` lists.
function neededBy(text, ownNames, owner, selfFile) {
  const bound = new Set(topLevelDecls(text).map((d) => d.name));
  for (const n of ownNames) bound.add(n);
  const need = new Set();
  for (const name of referencedIdentifiers(text)) {
    if (bound.has(name) || GLOBALS.has(name)) continue;
    const own = owner.get(name);
    if (own && own.file !== selfFile) need.add(name);
  }
  return need;
}

// Put the import block below the file's opening comment BANNER and above
// everything else.
//
// "Banner" means a leading comment block followed by a blank line — a note about
// the file. A leading comment with no blank line after it is not a banner, it is
// the explanation of the first declaration, and imports must go ABOVE it.
// Getting that distinction wrong is how two earlier versions of this function
// wedged an import (and then a stray blank line) between a comment and the thing
// it documents, which is precisely the readability the comments exist for.
function withImports(text, importLines) {
  const lines = text.split("\n").filter((l) => !IMPORT_LINE.test(l));
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("//")) i++;
  const isBanner = i > 0 && i < lines.length && !lines[i].trim();
  if (!isBanner) i = 0;
  const head = lines.slice(0, i);
  let rest = lines.slice(i);
  while (head.length && !head[head.length - 1].trim()) head.pop();
  while (rest.length && !rest[0].trim()) rest.shift();
  if (!importLines.length) {
    return [...head, ...(head.length ? [""] : []), ...rest].join("\n");
  }
  return [...head, ...(head.length ? [""] : []), ...importLines, "", ...rest].join("\n");
}

// Add `export` to every declaration some other module imports.
//
// Computing an import is only half of it: `import { configureMermaid } from
// "../main.js"` against a main.js that never exported it is a SyntaxError at
// instantiation — "does not provide an export named…" — and the static checks
// missed it entirely because the import was present and correct. Only loading
// the page found it. So the two halves are now done together, always.
function ensureExports() {
  const files = walk(SRC);
  const wantedFrom = new Map();   // file -> Set(names other modules import from it)
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    for (const [name, source] of parseImports(raw).names) {
      if (!source.startsWith(".")) continue;
      const abs = path.resolve(path.dirname(f), source.replace(/\?.*$/, ""));
      const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
      if (!wantedFrom.has(rel)) wantedFrom.set(rel, new Set());
      wantedFrom.get(rel).add(name);
    }
  }
  let added = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const wanted = wantedFrom.get(rel);
    if (!wanted?.size) continue;
    let raw = readFileSync(f, "utf8");
    // Walk backwards so earlier offsets stay valid.
    const todo = topLevelDecls(raw).filter((d) => wanted.has(d.name) && !d.exported);
    for (const d of todo.sort((a, b) => b.start - a.start)) {
      raw = raw.slice(0, d.start) + "export " + raw.slice(d.start);
      added++;
    }
    if (todo.length && !DRY) writeFileSync(f, raw);
    if (todo.length) console.log(`${DRY ? "[dry] " : ""}${rel}: +export on ${todo.length} declaration(s)`);
  }
  return added;
}

// Recompute every module's import block from the symbol table, moving nothing.
// Needed whenever the graph changes without an extraction — adding a setter,
// renaming a symbol, hand-editing a module — because an import block that is
// merely stale fails at instantiation, not at the line that got it wrong.
if (FIX_IMPORTS) {
  const files = walk(SRC);
  const owner = new Map();
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    for (const d of topLevelDecls(readFileSync(f, "utf8"))) {
      if (!owner.has(d.name)) owner.set(d.name, { file: rel, line: d.line });
    }
  }
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const raw = readFileSync(f, "utf8");
    const stripped = raw.split("\n").filter((l) => !IMPORT_LINE.test(l)).join("\n");
    const own = new Set(topLevelDecls(stripped).map((d) => d.name));
    const lines = importLines(f, neededBy(stripped, own, owner, rel), owner);
    const next = withImports(raw, lines);
    if (next !== raw) {
      if (!DRY) writeFileSync(f, next);
      console.log(`${DRY ? "[dry] " : ""}${rel}: ${lines.length} import line(s)`);
    }
  }
  ensureExports();
  syncAppShell();
  syncPreloads();
  process.exit(0);
}

for (const job of jobs) {
  const targetAbs = path.resolve(ROOT, job.target);
  const targetRel = path.relative(ROOT, targetAbs).replace(/\\/g, "/");
  // `source` lets a job move symbols BETWEEN modules, not only out of main.js.
  // Source order in the original file grouped some things wrongly — fitLiveQuestion
  // sits between two export functions and is not an export function — and
  // correcting that is a move from one module to another.
  const SOURCE = job.source ? path.resolve(ROOT, job.source) : MAIN;
  const sourceRel = path.relative(ROOT, SOURCE).replace(/\\/g, "/");
  let main = readFileSync(SOURCE, "utf8");
  const decls = topLevelDecls(main);
  const byName = new Map(decls.map((d) => [d.name, d]));

  // A job is either an explicit symbol list, or a REGION: every top-level
  // declaration from `from` to `to` inclusive, in source order. Regions are how
  // most of this split is expressed — app.js was already grouped by feature, so
  // a feature is nearly always one contiguous run, and naming its two ends is
  // both shorter and far less error-prone than listing sixty symbols. `except`
  // drops individual symbols that belong elsewhere.
  let wanted;
  if (job.from) {
    const a = decls.findIndex((d) => d.name === job.from);
    const b = decls.findIndex((d) => d.name === job.to);
    if (a === -1) { console.error(`  ! ${targetRel}: no top-level '${job.from}' in ${sourceRel}`); process.exit(1); }
    if (b === -1) { console.error(`  ! ${targetRel}: no top-level '${job.to}' in ${sourceRel}`); process.exit(1); }
    if (b < a) { console.error(`  ! ${targetRel}: '${job.to}' comes before '${job.from}'`); process.exit(1); }
    const except = new Set(job.except || []);
    wanted = decls.slice(a, b + 1).filter((d) => !except.has(d.name));
  } else {
    wanted = [];
    for (const name of job.symbols) {
      const d = byName.get(name);
      if (!d) { console.error(`  ! ${targetRel}: '${name}' is not a top-level declaration of ${sourceRel}`); process.exit(1); }
      wanted.push(d);
    }
  }
  wanted.sort((a, b) => a.start - b.start);

  // Slice each declaration out with its comment block, walking backwards so
  // earlier offsets stay valid.
  const pieces = [];
  const cuts = [];
  let floor = 0;
  for (const d of wanted) {
    // fullStart, not start: a declaration that is already exported begins at the
    // `export ` keyword, and cutting from `start` leaves that keyword stranded
    // on its own line in the source module — a SyntaxError that takes the whole
    // app down, and one split-parity cannot see because an orphan token is not a
    // declaration.
    const cStart = commentStart(main, d.fullStart, floor);
    pieces.push({ name: d.name, kind: d.kind, text: main.slice(cStart, d.end) });
    cuts.push([cStart, d.end]);
    floor = d.end;
  }
  for (let i = cuts.length - 1; i >= 0; i--) {
    const [a, b] = cuts[i];
    // Swallow one trailing blank line so the file doesn't fill with gaps.
    let end = b;
    while (main[end] === "\n" && main[end + 1] === "\n") end++;
    main = main.slice(0, a) + main.slice(end);
  }
  main = main.replace(/\n{4,}/g, "\n\n\n");

  const movedNames = new Set(pieces.map((p) => p.name));
  const body = pieces
    .map((p) => p.text.replace(/^(async function|function|const|let|var|class)\b/m, "export $1"))
    .join("\n\n");

  // Rebuild the symbol table with the move applied, so both sides' imports are
  // computed against where things actually are now.
  const owner = new Map();
  for (const f of walk(SRC)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const text = rel === sourceRel ? main : readFileSync(f, "utf8");
    for (const d of topLevelDecls(text)) {
      if (movedNames.has(d.name) && rel === sourceRel) continue;
      if (!owner.has(d.name)) owner.set(d.name, { file: rel, line: d.line });
    }
  }
  for (const name of movedNames) owner.set(name, { file: targetRel, line: 0 });

  // Extracting into a module that already exists APPENDS. Overwriting it lost
  // three functions outright the first time this ran twice against one target —
  // caught by split-parity, which is the entire reason that check exists.
  const existing = existsSync(targetAbs) ? readFileSync(targetAbs, "utf8") : "";
  const existingBody = existing.split("\n").filter((l) => !IMPORT_LINE.test(l)).join("\n").trim();
  const header = job.header ? `${job.header.trimEnd()}\n\n` : "";
  const combined = existingBody ? `${existingBody}\n\n${body}` : `${header}${body}`;
  const targetOwn = new Set(topLevelDecls(combined).map((d) => d.name));
  const targetNeeds = neededBy(combined, targetOwn, owner, targetRel);
  const targetImports = importLines(targetAbs, targetNeeds, owner);
  const targetText = withImports(combined, targetImports).replace(/\n*$/, "\n");

  // main.js must now import back whatever it still uses of what left — and its
  // whole import block is recomputed from scratch, not appended to.
  const mainStripped = main.split("\n").filter((l) => !IMPORT_LINE.test(l)).join("\n");
  const mainOwn = new Set(topLevelDecls(mainStripped).map((d) => d.name));
  const mainNeeds = neededBy(mainStripped, mainOwn, owner, sourceRel);
  const mainText = withImports(main, importLines(SOURCE, mainNeeds, owner));

  console.log(`${DRY ? "[dry] " : ""}${targetRel}  ${pieces.length} symbols, ${targetImports.length} import line(s)`);
  for (const l of targetImports) console.log(`    ${l}`);
  if (!DRY) {
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, targetText);
    writeFileSync(SOURCE, mainText);
  }
}

// Keep sw.js's APP_SHELL in step with what is actually on disk. Doing this by
// hand ~50 times is a guaranteed omission, and an omitted module is invisible
// until someone opens the app offline for the first time.
// index.html lists every module as <link rel="modulepreload">, so a cold load
// fetches them in parallel instead of walking a 66-deep import chain one
// round trip at a time.
function syncPreloads() {
  const htmlPath = path.join(ROOT, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const start = "<!-- modulepreload:start -->";
  const end = "<!-- modulepreload:end -->";
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1) { console.error("  ! index.html has no modulepreload block"); return; }
  const links = walk(SRC)
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
    .filter((rel) => rel !== "src/main.js")   // the <script type="module"> already asks for it
    .sort()
    .map((rel) => `    <link rel="modulepreload" href="${rel}${STAMP}">`)
    .join("\n");
  const next = html.slice(0, a + start.length) + "\n" + links + "\n    " + html.slice(b);
  if (next !== html) writeFileSync(htmlPath, next);
  console.log(`index.html: ${links.split("\n").length} modulepreload link(s)`);
}

function syncAppShell() {
  const swPath = path.join(ROOT, "sw.js");
  const sw = readFileSync(swPath, "utf8");
  const entries = walk(SRC)
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
    .sort((a, b) => (a === "src/main.js" ? -1 : b === "src/main.js" ? 1 : a.localeCompare(b)))
    .map((rel) => "  `./" + rel + "?v=${STAMP}`,");
  const block = /(\n)(  `\.\/src\/[^\n]*\n)+/;
  if (!block.test(sw)) { console.error("  ! could not find the src/ block in sw.js APP_SHELL"); return; }
  const next = sw.replace(block, "\n" + entries.join("\n") + "\n");
  if (next !== sw) writeFileSync(swPath, next);
  console.log(`sw.js APP_SHELL: ${entries.length} module(s)`);
}

if (!DRY) {
  ensureExports();
  syncAppShell();
  syncPreloads();
  console.log("Now run: node tools/split-parity.mjs && node tools/module-symbols.mjs");
}
