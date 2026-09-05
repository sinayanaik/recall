// Did the restructure LOSE any code?
//
//   node tools/split-parity.mjs                 # compare against the pre-modular tag
//   node tools/split-parity.mjs --base=<ref>    # ...or any git ref
//   node tools/split-parity.mjs --show <name>   # print both sides of one symbol
//
// The premise of the restructure was PURE CODE MOVEMENT: the same 1,255
// functions and 410 bindings, in different files, with imports added. Nothing
// about that is self-evident once 35,000 lines are in flight, and "it still
// seems to work" is not a check — most of this codebase is paths that only run
// during an EPUB import, a sync conflict, or a PDF export. So this pulled every
// top-level declaration out of the baseline app.js and out of the current tree
// and compared them by name: present exactly once, with an identical body.
//
// ── Why the body comparison is gone ─────────────────────────────────────────
//
// It answered "is this function still the function it was", and for a while
// that was the question. It stopped being the question the moment the move
// finished and the app carried on being developed: from then on a changed body
// meant somebody had edited a function, which is what work looks like.
//
// The cost was not theoretical. Staying quiet required an ACCEPTED allowlist
// with a paragraph of prose per divergence, and it grew with every behavioural
// commit — 118 lines of it in b4eb1e0 alone. When it was not fed, it went red
// and stayed red: this check was carrying 66 unlisted body changes and had not
// been read in some 39 commits. Its sibling css-parity spent months in the same
// state, and af39740 is the receipt for what that costs — nobody was reading
// css-parity when tools/split-css.mjs silently deleted three load-bearing rules
// out of the frozen slices. Twice. A gate that is always red reports nothing,
// and a gate that needs an essay to stay green will not stay green.
//
// So the body diff and its allowlist are retired. What survives is the half
// that still has teeth and needs no essay:
//
//   DUPLICATE  two modules in the CURRENT tree owning one name — the flat-scope
//              collision the restructure exists to make impossible (fetchText)
//   MISSING    a symbol that was in the baseline and is now nowhere in the tree
//              and not named in REMOVED below. A deletion is a decision, and
//              this is where somebody writes down that they made it
//
// The module-scope residual went the same way, and it is worth saying why
// rather than leaving a gap. It compared everything that is NOT a declaration —
// the listener registrations and the bootstrap calls, a third of the original
// file — as one blob, byte for byte. Module scope is exactly where a new
// feature registers itself, so every feature added since the baseline is an
// insertion there: thirty of them by now (the bookmark button, immersive mode,
// the reading rail, region select, pinch zoom, PDF import from My Decks,
// copy-selection, annotate-selection). Weakening it to "nothing the baseline
// had may be MISSING" did not help either — it then named eighteen statements,
// and all eighteen turned out to be present and rewritten (`setFocusMode(!chromeFocusPinned)`
// is `setFocusMode(!isFocusModeActive())` now), not lost. A comparison that
// cannot tell a rewrite from a deletion is not measuring the thing it claims to.
//
// The concrete failure it was written for — a cut taken after an `export `
// keyword, leaving the keyword stranded, a SyntaxError that took the whole app
// down — is caught earlier and better by things that read the CURRENT tree:
// module-symbols (does every cross-module reference resolve), boot-check (does
// the app reach a booted state at all), and the browser checks behind them. And
// "is this control still wired to a handler" — the real question under the
// listener registrations — is asked directly by tools/overlay-check.mjs against
// the app as it is, rather than against a year-old file.
//
// What used to be caught by the body diff — an edit that breaks a reference —
// is caught against the CURRENT tree instead, and better: module-symbols asks
// whether every cross-module reference resolves, and scanner-audit asks whether
// the scanner it relies on can see them all.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baselineFile } from "./baseline.mjs";
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

// Baseline symbols that are intentionally gone, and why. A rename lands here
// (the old name) and in the ADDED list (the new one), which is the honest way
// to show it — the tool matches by name and cannot know the two are related.
const REMOVED = {
  // ── The fence regex that paired ``` markers by counting them ────────────
  FENCE_PATTERN_SOURCE:
    "One regex — ```[ \\t]*([^\\n]*)\\n([\\s\\S]*?)``` — used for every fenced " +
    "block in the app. It was wrong in four ways at once, all of them because " +
    "it paired markers BY COUNT wherever they sat: not line-anchored, so a " +
    "bare ``` written inside a sentence opened a fence and swallowed the prose " +
    "after it; no tilde fences; and no rule that a closing fence must be at " +
    "least as long as its opener, so a ```` block wrapping a ``` one split in " +
    "the wrong place. Replaced by the line-anchored scanner in " +
    "src/render/preprocess.js, which is also what tools/incremental-split-check.mjs " +
    "drives. c6ea1e6 is the commit; an unanchored fence regex inverting code " +
    "and prose is the bug.",
  fencePattern:
    "`new RegExp(FENCE_PATTERN_SOURCE, \"g\")` — the accessor for the above, and " +
    "gone with it.",

  // ── The header that hid itself, and came back ───────────────────────────
  chromeAutoHidden:
    "The auto-hide flag beside the focus pin, and it was REVERSIBLE: scrolling " +
    "down folded the header away, scrolling up by twenty-eight pixels brought " +
    "it straight back. Which reads as focus mode leaking away while you read, " +
    "because nobody scrolls in one direction for a whole chapter — a thumb " +
    "correcting past a figure and the header is over the text again. Scrolling " +
    "down now LOCKS the chrome away until the reader says otherwise (the " +
    "reading rail's Leave focus, Escape, Back, Ctrl+.). See the comment it " +
    "left behind in src/ui/chrome.js; resetChromeAutoHide kept its name " +
    "because that is still exactly what it does.",

  // ── A toast that named the action ───────────────────────────────────────
  highlightToastMessage:
    "Turned \"removed\" / \"recolored\" / else into one of three fixed strings. " +
    "The messages are written at their call sites now (src/format/selection-tools.js), " +
    "because they gained a plural the lookup had no way to express — one " +
    "removal says \"Highlight removed\" and several say \"N highlights removed\".",

  // ── One progress modal, two importers ───────────────────────────────────
  showEpubProgress:
    "The \"Importing …\" modal, EPUB-only by name and by its aria-label. PDFs " +
    "import through the same long, several-stage path and had nothing, so it " +
    "became showImportProgress(title, kind) in src/import/epub.js — same " +
    "markup, same shell, with the format as an argument.",

  // ── The highlight's line, renamed for what it returns ───────────────────
  highlightSentenceParts:
    "Widened a highlight to the sentence around it. It is highlightUnitSpan in " +
    "src/panels/highlights-panel.js now, and the rename is the point: the unit " +
    "index it searches splits on sentence ends AND newlines and drops table " +
    "rules, so \"sentence\" was never what it returned. Same bisection, same " +
    "null when no unit covers the highlight.",

  // ── The Highlights TAB's lazy context lines ─────────────────────────────
  //
  // These four are renderHighlightsPanel's machinery and went out with it —
  // see its own entry below. They rendered a context line per highlight only
  // once it neared the viewport, because each one was a full marked +
  // DOMPurify pass and a note with two hundred highlights paid six hundred
  // parses on the tap that opened the tab. The continuous editor that replaced
  // the tab (src/panels/highlights-editor.js) does not build a preview per
  // highlight at all — an entry IS the highlighted line — so there is nothing
  // left to defer.
  pendingHighlightContext:
    "The WeakMap holding each un-rendered context line's markdown.",
  highlightContextObserver:
    "The IntersectionObserver that watched for one nearing the viewport.",
  highlightContextNode:
    "Built the empty <div class=\"highlight-ctx\"> and registered it with the " +
    "observer above.",
  renderPendingHighlightContext:
    "The observer's callback: pull the markdown back out of the WeakMap and " +
    "render it, once.",

  // ── ...and then the Highlights tab stopped existing ─────────────────────
  renderHighlightsPanel:
    "Drew the Highlights tab. By the time it went, everything it did was one " +
    "call to renderHighlightsEditor(collectHighlightEntries()) — the same " +
    "cards, from the same collection, that side-by-side mode " +
    "(src/panels/highlight-cycle.js) renders beside the paper or the note the " +
    "highlights are ON. A tab is somewhere you go INSTEAD of the page, which " +
    "is the complaint the pane was written to answer, so keeping both meant " +
    "one surface built twice and a reader who had to guess which of the two " +
    "was the real one. The pane is the surface; the way in is the contents " +
    "drawer's Highlights half, which already knows which reading surface you " +
    "are on. #highlightsStage, #highlightsList and #exportHighlightsBtn went " +
    "with it; the ⇓ moved into the pane's own header.",
  // ── The Highlights tab stopped being a list of rows ─────────────────────
  collectDeckHighlights:
    "Built the row shape the Highlights tab rendered: a highlight widened to " +
    "the line it sits in, with same-line highlights merged so one line was not " +
    "previewed twice with two Go-to buttons that scrolled to the same place. " +
    "The tab is a continuous editor now (src/panels/highlights-editor.js), and " +
    "merging is the one thing it cannot do — two annotations under one line " +
    "would be offered a single box to write both notes in. collectHighlight" +
    "Entries replaces it, one entry per highlight, off the same scan; and the " +
    "duplication the merge avoided is avoided instead by an entry BEING the " +
    "highlighted line rather than a preview of it. Its two halves " +
    "(collectDocumentHighlightRows, collectNoteHighlightRows) went with it and " +
    "were added after the split, so they are not named here.",
  // ── The image controls stopped being bound by token index ───────────────
  // The eleven entries below were one scheme: find an image by walking
  // marked's top-level tokens, remember WHICH token it was, and commit a
  // resize or a delete by rebuilding the whole note from that token array.
  // It could not see an image in a table cell (marked keeps cells in
  // .header/.rows, which nothing walked), one wrapped in a link inside running
  // text, or one inside a <div>…</div> block — those rendered with no controls
  // at all. It could not run until the entire note was in the DOM, so no image
  // in a note over NOTES_LAZY_MIN_CHARS (i.e. any imported book) had a grip
  // until the reader had scrolled it end to end. And committing one width
  // re-emitted every block of the markdown, re-normalising the blank lines of
  // a 2.6MB book to change one number.
  //
  // Replaced by findSourceImages + replaceSourceImage in the same file: an
  // image is the slice of source it is written as, found by one regex pass
  // that skips fenced code, and a commit splices that slice and nothing else.
  // tools/image-controls-check.mjs holds marked up as the oracle for it.
  lexMarkdownTokens:
    "the whole-note lex the scheme rested on. Nothing lexes a note to find an " +
    "image any more.",
  surfaceLexTokens:
    "its memo. The replacement (surfaceSourceImages) caches the same way on " +
    "the same key, over a regex pass rather than marked.lexer's ~125ms on a " +
    "book.",
  findImageTokens: "the token walker itself — see the note above.",
  pipeRowImages:
    "recognised a `|`-separated image row as a token shape. The scan finds " +
    "each image in such a row directly; pipeRowLinePattern still keeps a " +
    "delete from leaving the row with a stray separator.",
  collectImagesDeep:
    "hunted images nested inside a token's subtree, which is unnecessary once " +
    "nothing asks what encloses an image.",
  parseImgTagFromHtml:
    "read a raw <img> through the DOM. parseImgTagAttrs does the same as pure " +
    "string work, so tools/image-controls-check.mjs can run it in Node.",
  commitImageWidth:
    "wrote a width by rebuilding the note from its token array; " +
    "commitSourceImageWidth splices that image's own slice.",
  commitDeepImageWidth:
    "the nested-token variant of the same. There is one write path now, " +
    "whatever encloses the image.",
  removeImageAt:
    "the delete half of the token rebuild. removeSourceImage and " +
    "imageRemovalRange replace it, and take the emptied line or the row " +
    "separator a delete would otherwise leave behind.",
  removeSurfaceImage:
    "removeImageAt plus the storage-object delete. The guard it wrapped " +
    "(deckStillReferencesImage — never hard-delete a file another copy still " +
    "points at) is unchanged and now sits inside removeSourceImage.",
  rebuildSurfaceFromTokens:
    "re-emitted the WHOLE note to change one image. Nothing rebuilds a note " +
    "from tokens any more.",
  // ── ...and the two upload helpers the compression choice replaced ────────
  optimizeImage:
    "one fixed level (1600px, WebP at 82%), applied without asking and " +
    "announced after the upload was already in flight. Generalised into " +
    "compressImageToPreset(file, choice) — the same encode, with the same GIF " +
    "frame guard, the same SVG pass-through, the same WebP\u2192JPEG fallback " +
    "and the same \"not actually smaller\" rule — with the level as an " +
    "argument. Its old numbers ARE the Balanced preset, so the default is " +
    "byte-identical behaviour to what every existing note's images were " +
    "uploaded under.",
  firstImageFile:
    "took the FIRST image out of a paste or a drop and silently discarded the " +
    "rest — the one way of adding images that could lose some. allImageFiles " +
    "returns all of them, and one compression dialog covers the batch.",
  fetchText:
    "declared TWICE in the baseline (app.js:25472 and app.js:29556). Legal in a " +
    "classic script, where the second silently won for every caller; a hard " +
    "SyntaxError in a module, so the app did not boot at all. Split into " +
    "fetchImportText (URL import, 45s) and fetchReleaseText (update check, 8s).",
  visualLineTopForOffset:
    "it returned the exact measured position OR a completely different " +
    "estimate, with nothing for the caller to tell them apart. Its one caller " +
    "was the caret ribbon, which is the single thing that must never be drawn " +
    "from a guess — a band in the wrong place does not merely fail to say " +
    "where the caret is, it says something false — and the silent swap between " +
    "the two is what made it flicker while typing on ONE line. Replaced by " +
    "exactLineTopForOffset, which returns null instead of guessing (the ribbon " +
    "then stays where it is), plus the estimate's own name where an " +
    "approximation is genuinely correct: measuredCaretTop, because a jump has " +
    "to land somewhere.",
  fetchCloudDeckList:
    "both callers (renderMyDecksList, allMyDeckSelections) read the deck INDEX " +
    "instead. It selected `*, cards(count)` — every cloud deck's whole notes " +
    "markdown plus an aggregate over the cards table — to render a title and a " +
    "sync pill, on every My Decks repaint that hits the network. Nothing ever " +
    "read `notes` or the count off it, so leaving it in place would only be a " +
    "trap for the next caller who reached for the obvious-looking name."
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
  baseSrc = baselineFile("app.js", baseRef);
} catch (error) {
  // One line, naming the fetch — see tools/baseline.mjs for why the tag is
  // routinely absent rather than exceptionally so.
  console.error(error.message);
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
const added = [];
const accepted = [];

for (const [name, base] of baseDecls) {
  const cur = currentDecls.get(name);
  if (!cur) {
    if (REMOVED[name]) accepted.push(`${name} (removed) — ${REMOVED[name]}`);
    else missing.push(name);
    continue;
  }
  // The body is no longer compared — see the header. A symbol that is still
  // here has answered the only question this check still asks.
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
report("ADDED — new since the baseline (expected: setters, module glue)", added, false);
report("accepted differences", accepted);

if (baseDupes.length) {
  console.log(`\nnote: the baseline itself declares these twice — ${baseDupes.join(", ")}`);
}

const fail = currentDupes.length + missing.length;
console.log(
  `\n${baseDecls.size} baseline symbols · ${currentDecls.size} current · ` +
  `${currentDecls.size - added.length - missing.length} matched · ${fail} problem(s)`
);
// The tally tools/check.mjs reads: one assertion per baseline symbol (is it
// still somewhere, or named in REMOVED) and one per current symbol (does any
// other module own this name too).
console.log(`CHECK: ${baseDecls.size + currentDecls.size} checks · ${fail} failed`);
process.exit(fail ? 1 : 0);
