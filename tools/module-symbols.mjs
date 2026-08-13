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
import { topLevelDecls, blankLiterals, referencedIdentifiers } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const SHOW_UNUSED = process.argv.includes("--unused");

// Real globals: the platform, plus the CDN libraries index.html loads and the
// ones core/lib-loader.js injects on demand. Anything here is never "missing".
const GLOBALS = new Set([
  // language
  "globalThis", "undefined", "NaN", "Infinity", "Object", "Array", "String", "Number",
  "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "SyntaxError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy",
  "Reflect", "Intl", "Function", "parseInt", "parseFloat", "isNaN", "isFinite", "escape",
  "unescape", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "ArrayBuffer", "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "DataView", "TextEncoder", "TextDecoder",
  "structuredClone", "queueMicrotask", "AggregateError",
  // DOM / BOM
  "window", "document", "navigator", "location", "history", "screen", "console",
  "localStorage", "sessionStorage", "indexedDB", "caches", "crypto", "performance",
  "fetch", "Request", "Response", "Headers", "FormData", "URL", "URLSearchParams",
  "Blob", "File", "FileReader", "FileList", "AbortController", "AbortSignal",
  "Image", "Audio", "Option", "Node", "Element", "HTMLElement", "HTMLInputElement",
  "HTMLTextAreaElement", "HTMLCanvasElement", "HTMLImageElement", "DocumentFragment",
  "Range", "Selection", "NodeFilter", "DOMParser", "XMLSerializer", "XMLHttpRequest",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "CustomEvent", "Event",
  "PointerEvent", "MouseEvent", "KeyboardEvent", "TouchEvent", "DragEvent", "WheelEvent",
  "BroadcastChannel", "MessageChannel", "Worker", "OffscreenCanvas", "CSS", "matchMedia",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
  "getComputedStyle", "alert", "confirm", "prompt", "atob", "btoa", "isSecureContext",
  "visualViewport", "getSelection", "customElements", "IDBKeyRange", "StorageManager",
  // CDN libraries (index.html up front, or core/lib-loader.js on demand)
  "marked", "DOMPurify", "katex", "renderMathInElement", "Prism", "mermaid",
  "JSZip", "TurndownService", "turndownPluginGfm", "nomnoml", "graphre", "supabase"
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Names this module's `import` statements bring into scope, and the specifiers
// they came from.
function parseImports(blanked, raw) {
  const names = new Map(); // local name -> source
  const sources = [];
  const re = /^\s*import\s+([^;]*?)\s+from\s*$/gm;
  // Work off the raw text for the specifier, the blanked text for structure.
  const stmt = /^\s*import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/gm;
  let m;
  while ((m = stmt.exec(raw))) {
    const [, def, ns, braced, source] = m;
    sources.push({ source, index: m.index });
    if (def) names.set(def, source);
    if (ns) names.set(ns, source);
    if (braced) {
      for (const part of braced.split(",")) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        names.set((as[1] || as[0]).trim(), source);
      }
    }
  }
  void re; void blanked;
  return { names, sources };
}

// Every name bound anywhere in the file, at any nesting level: declarations,
// destructuring, function and catch parameters, arrow parameters, loop bindings.
// Over-inclusive on purpose — see the note at the top.
function locallyBound(blanked) {
  const bound = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) bound.add(n); };
  const addPattern = (text) => {
    // `{ a, b: c, d = 1, ...rest }` / `[a, , b]` / `a`
    for (const t of text.split(/[,{}[\]]/)) {
      const name = t.replace(/\.\.\./, "").split(/[:=]/).pop().trim();
      // For `a: b` the BOUND name is b; for `a = 1` it is a. Add both halves —
      // over-inclusion is the safe direction here.
      const first = t.replace(/\.\.\./, "").split(/[:=]/)[0].trim();
      add(name);
      add(first);
    }
  };

  // const/let/var/function/class at any indentation
  for (const m of blanked.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // destructuring declarations
  for (const m of blanked.matchAll(/\b(?:const|let|var)\s*([{[][^;=]*?[}\]])\s*=/g)) addPattern(m[1]);
  // function / method parameter lists
  for (const m of blanked.matchAll(/(?:function\s*[A-Za-z_$\w$]*\s*|\b[A-Za-z_$][\w$]*\s*)\(([^()]*)\)\s*(?:\{|=>)/g)) addPattern(m[1]);
  // single-argument arrows: `x => …`
  for (const m of blanked.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[2]);
  // catch (e)
  for (const m of blanked.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // for (const x of …) / labels
  for (const m of blanked.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) add(m[1]);
  return bound;
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
  const { names: imported, sources } = parseImports(blanked, raw);
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
