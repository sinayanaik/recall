// Did the restructure change any code?
//
//   node tools/split-parity.mjs                 # compare against the pre-modular tag
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
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const baseRef = (args.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);
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
    "calls fetchReleaseText, the update-check half of the split fetchText — see REMOVED",
  showUpdateBanner:
    "the Reload button now waits for controllerchange before reloading, instead " +
    "of reloading the instant it has asked the waiting worker to skip waiting. " +
    "Fixes a pre-existing race (measured: 1-2 extra navigations every run) that " +
    "130 module requests make considerably worse. See tools/release-check.mjs.",
  DOCX_HEADING_STYLE_BY_LEVEL:
    "h5 and h6 now map to Heading5/Heading6 instead of both folding into " +
    "Heading4. They only shared a style because size told the levels apart, " +
    "and it no longer does — see buildDocxStylesXml.",
  buildDocxStylesXml:
    "One heading SIZE, in the .docx too. Heading1-4 were 16/14/12/11pt while " +
    "every other surface has rendered h1-h6 at a single size since the " +
    "underline ladder replaced the size ladder (styles/06-rendered.css:5). All " +
    "six are now 11pt, with the hierarchy in weight, colour and a bottom " +
    "border whose weight and dash pattern track the on-screen ladder — Word " +
    "cannot draw a partial-width rule, so width is the one cue that is lost.",
  // ── Reading a whole folder as one deck (src/library/folder-deck.js) ──────
  // A folder open as one document is not a deck and has no record of its own,
  // so the field below is what stops the ordinary save path inventing one.
  state:
    "One field added: folderDeck, non-null only while a whole folder is open " +
    "as one document. It is what routes a save back into the decks the " +
    "document was built from instead of minting a new library entry for the " +
    "merged blob and syncing it to every device.",
  saveDeckToLibrary:
    "Hands over to saveFolderDeck when a folder is the thing open. " +
    "resolveSaveTarget falls through to generateLocalDeckId, so a null " +
    "localDeckId does NOT mean ephemeral — it means 'mint one'.",
  saveDeckToLibrarySync:
    "Same gate as its async twin, and the load-bearing one: flushWorkingDeck " +
    "calls THIS from pagehide/visibilitychange, so without it switching tabs " +
    "while reading a folder would create the merged deck.",
  createNewDeck:
    "Clears state.folderDeck alongside localDeckId, or the new deck's first " +
    "save would be routed into the previous folder's member decks.",
  loadDeckSnapshot:
    "Clears state.folderDeck. Every path that replaces the open deck — " +
    "library, cloud, import, restore — comes through here, so it is the one " +
    "place that has to remember.",
  updateMeta:
    "The deck-title and category pencils are disabled while a folder is open " +
    "as one document: there is no record to rename, and the chip says FOLDER " +
    "rather than a category the merged view does not have.",
  currentDeckKey:
    "Includes the folder path. A folder document has NEITHER id, which is the " +
    "same key an unattached working deck has — so without it a reading anchor " +
    "captured in a folder could be attached to a new deck.",
  currentNavLocation:
    "Records a folder document as kind:'folder'. It has no id, so the deck " +
    "branch would never record it and Back out of a deck opened from the " +
    "folder view would walk straight past the folder.",
  sameNavLocation:
    "Compares kind:'folder' entries by path, the only identity they have.",
  goToNavLocation:
    "Restores a kind:'folder' entry by RE-MERGING from the decks as they are " +
    "now, not from a cached document — a stale merge would be written back " +
    "over decks that have since changed.",
  buildFolderActionCluster:
    "One button added: Read, which opens every deck under the folder as a " +
    "single document. First in the cluster because it is the only one of the " +
    "six about reading rather than about managing the folder.",
  buildNotesToc:
    "Foldable sections. The list stays flat — the tree is still drawn by the " +
    "rail spans — so the build now also derives the parent/child relation that " +
    "flat DOM cannot carry (notesTocParent / notesTocBranch), carries the fold " +
    "state across a rebuild by heading SLUG rather than by index, and appends a " +
    "twisty <button> as a SIBLING of each branch row's <a>.",
  updateNotesTocActive:
    "When the section being read is folded away, the scroll-spy now lights its " +
    "nearest visible ancestor instead of a row nobody can see. Deliberately " +
    "not 'unfold the ancestors': that would re-open the tree a branch at a " +
    "time as you scrolled, undoing the fold the reader asked for.",
  OVERLAY_LAYERS:
    "One entry added, in the popover group: the notes header's phone-only ⋯ " +
    "menu (src/notes/notes-head-overflow.js). Without it a Back press aimed at " +
    "the open menu falls through to goNavBack() and loads another deck.",
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
  // `export function nextX() { return ++y; }` — a counter claimed from another
  // module, where `++y` on the import would throw.
  for (const m of text.matchAll(/export function ([A-Za-z0-9_$]+)\(\s*\)\s*\{\s*return \+\+([A-Za-z0-9_$]+);\s*\}/g)) {
    SETTER_ROUTED.set(m[1], { name: m[2], kind: "preinc" });
  }
}


// Undo the setter rewrite on the CURRENT text; if it then matches the baseline,
// the setter routing was the whole of the difference.
function unroute(code) {
  // To a fixed point: a setter call routinely appears INSIDE another setter's
  // argument (`setX(requestAnimationFrame(() => { setX(0); … }))`), and one pass
  // hands the inner one through untouched as part of the outer's argument.
  let out = code;
  for (let pass = 0; pass < 5; pass++) {
    const before = out;
    for (const [setter, { name, kind }] of SETTER_ROUTED) {
      if (kind === "bump") { out = out.replaceAll(`${setter}();`, `${name} += 1;`); continue; }
    if (kind === "preinc") { out = out.replaceAll(`${setter}()`, `++${name}`); continue; }
      out = replaceCall(out, setter, (arg) => `${name} = ${arg};`);
    }
    if (out === before) break;
  }
  return out;
}

// Replace `setter(<balanced args>);` — matching parentheses rather than
// scanning to the next `;`. The argument is routinely a whole callback:
//
//   setChromeScrollFrame(requestAnimationFrame(() => { … ; … }));
//
// A `[^;]*` pattern stops at the first semicolon INSIDE that callback, fails to
// match, and reports a mechanical setter routing as a real code change.
function replaceCall(text, fn, build) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf(`${fn}(`, i);
    if (at === -1) return out + text.slice(i);
    // Only a standalone call, not a longer identifier ending in this name.
    const prev = text[at - 1];
    if (prev && /[\w$.]/.test(prev)) { out += text.slice(i, at + fn.length + 1); i = at + fn.length + 1; continue; }
    let depth = 0;
    let j = at + fn.length;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") { depth--; if (!depth) break; }
    }
    if (j >= text.length) return out + text.slice(i);
    const arg = text.slice(at + fn.length + 1, j);
    const semi = text[j + 1] === ";" ? j + 2 : j + 1;
    out += text.slice(i, at) + build(arg) + (text[j + 1] === ";" ? "" : "");
    i = semi;
  }
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
// stays meaningful instead of being switched off. Each entry is a change made
// on purpose — by the restructure, or by a fix landed since it — spelled out
// so that everything around it keeps being compared byte for byte.
const RESIDUAL_REWRITES = [
  // Phase 1: a deferred module script sees readyState "interactive", so the
  // old inline `else` branch fired mid-file. See onDomReady in src/main.js.
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+)\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
  [/if \(document\.readyState === "loading"\) \{ document\.addEventListener\("DOMContentLoaded", (\w+), \{ once: true \}\); \} else \{ \1\(\); \}/g,
   "onDomReady($1);"],
  // Landed after the split, so it is an ADDITION to the baseline rather than a
  // rewrite of it: the floating selection pill's container now cancels
  // pointerdown/mousedown, so a press that lands on the pill but on none of its
  // buttons can no longer place a caret in the note underneath and throw away
  // the selection the pill is there to act on. See tools/selection-check.mjs.
  [/(hideNotesSelectionButtonUnlessPinned, \{ passive: true \}\); \}\); )(el\.makeCardFromSelectionBtn\?\.addEventListener)/,
   '$1["pointerdown", "mousedown"].forEach((type) => { el.selectionFloat?.addEventListener(type, (event) => { event.preventDefault(); }); }); $2'],
  // Also an ADDITION rather than a rewrite: two more boot hooks next to the one
  // that fills #notesRenderToolbar. They set up the notes header's phone-only ⋯
  // overflow menu and the measurement that lets that header fold away with the
  // rest of the chrome — see src/notes/notes-head-overflow.js and
  // src/notes/notes-head-fold.js.
  [/(onDomReady\(initRenderToolbars\); )(document\.addEventListener\("pointerdown")/,
   "$1onDomReady(initNotesHeadOverflow); onDomReady(initNotesHeadFold); onDomReady(initNotesTocFolding); $2"],
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
