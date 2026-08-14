// Port-drift check for the two files that duplicate Recall's own code.
//
//   node tools/port-sync.mjs          # fail on any drift
//   node tools/port-sync.mjs --show   # print the full text of anything that drifted
//
// content/recall-math.js and content/recall-render.js exist so that "what counts
// as math" and "what a note looks like" mean the same thing in the extension as
// in the app. MV3 forbids importing across the boundary and there is no build
// step, so the functions are copied by hand — and a hand copy rots silently. A
// stale render port doesn't crash, it just makes the preview quietly lie about
// what a deck will show, which is the one thing the preview exists to prevent.
//
// So: pull each function out of both files and compare them modulo whitespace.
// The ports are kept formatted the same way app.js formats them, precisely so
// this comparison can be strict and anything it reports is real.
//
// When app.js legitimately changes, update the port and this stays quiet. When
// the extension needs to differ on purpose, add it to DIVERGENCES with a reason.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// extract/extractConst/normalize used to live in this file. They now live in
// tools/js-scan.mjs, shared with the checks that police the modular split, so
// there is one copy of the hard part rather than three. The functions are
// unchanged, so what this reports is unchanged.
import { extract, extractConst, normalize } from "../../tools/js-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const SHOW = process.argv.includes("--show");

// The app used to be one app.js. It is now src/**/*.js, and a ported function
// can live in any of them — so search the concatenation. Reading them in sorted
// order keeps the result stable; the extractors match by name, not position, so
// nothing here depends on which file a function ended up in.
function appSource() {
  const single = path.join(REPO, "app.js");
  const srcDir = path.join(REPO, "src");
  const parts = [];
  if (existsSync(single)) parts.push(readFileSync(single, "utf8"));
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(srcDir);
  if (!parts.length) {
    console.error("Found neither app.js nor src/**/*.js to check the ports against.");
    process.exit(2);
  }
  return parts.join("\n");
}

const app = appSource();
const files = {
  "content/recall-math.js": readFileSync(path.join(ROOT, "content/recall-math.js"), "utf8"),
  "content/recall-render.js": readFileSync(path.join(ROOT, "content/recall-render.js"), "utf8")
};

// Functions that must match app.js exactly.
const PORTED = {
  "content/recall-math.js": [
    "isEscaped", "findUnescaped", "canOpenInlineDollar", "findInlineDollarClose",
    "healEscapedTex", "mathSpanAt", "findMathRanges", "codeRegionEnd",
    "repairEscapedMathMarkdown", "relaxEscapedBrackets", "flattenTextForMath",
    "protectMathInDom"
  ],
  "content/recall-render.js": [
    "escapeHtml", "encodeAttribute", "isEscaped", "isSingleDollarLine", "healEscapedTex",
    "findSingleDollarLine", "findUnescaped", "canOpenInlineDollar",
    "findInlineDollarClose", "normalizeDisplayMathIndentation", "protectMath",
    "applyClozeMarkup", "protectInline", "imageMarkupToTag", "renderImageRows",
    "normalizeCitations", "parseDiagramWidth", "diagramOpenTag",
    "normalizeMarkdown", "normalizeImageUrl", "markdownTableColumnCount",
    "tableCellWeight", "applyMarkdownTableColumns", "markdownTableHeaderCells",
    "markdownTableHeaders", "applyMarkdownTableLabels", "wrapMarkdownTable"
  ]
};

// Top-level constants that must match too. A function body can be a perfect
// copy and still behave differently because the bound it reads changed — the
// 1000-character inline-math span, the sanitiser allowlist, the citation
// regexes. Those are the values, not decoration.
const CONSTANTS = {
  "content/recall-math.js": [
    "RAW_MATH_ATTR", "INLINE_MATH_MAX_SPAN", "MATH_OPAQUE_MARK", "MATH_BLOCK_LEVEL"
  ],
  "content/recall-render.js": [
    "LINE_SPACE_RE", "INLINE_MATH_MAX_SPAN", "IMG_TOKEN_SOURCE", "CITE_INNER",
    "CITE_HREF_FRAG", "CITATION_LINK_RE", "CITATION_ESCAPED_RE",
    "FOOTNOTE_BACKREF_LINK_RE", "FOOTNOTE_BACKREF_ARROW_RE",
    "DIAGRAM_WIDTH_MIN", "DIAGRAM_WIDTH_MAX", "SANITIZE_CONFIG",
    "codeLanguageAliases"
  ]
};

// Deliberate differences, with the reason they exist. Anything here is reported
// as a note, never as drift.
const DIVERGENCES = {
  "content/recall-math.js:protectMathInDom":
    "declines an inline $…$ span whose content does not read as a formula " +
    "(looksLikeMath) — the clipper meets raw web prose, where two currency " +
    "amounts in one sentence are ordinary; app.js only sees text a user kept",
  "content/recall-render.js:healEscapedTex":
    "delegates to window.__recallMath, which owns the ported copy",
  "content/recall-render.js:normalizeMarkdown":
    "app.js's version is the deck-wide normaliser; the preview needs only the " +
    "CRLF and nbsp passes"
};


let drifted = 0;
let matched = 0;
let noted = 0;
const problems = [];
// A DIVERGENCES entry that never fires is a claim about the code that stopped
// being true — either the port was re-synced (delete the entry) or the function
// left the list (a coverage hole). Both are worth knowing about.
const usedDivergences = new Set();

for (const [file, names] of Object.entries(PORTED)) {
  for (const name of names) {
    const key = `${file}:${name}`;
    const a = extract(app, name);
    const b = extract(files[file], name);
    if (!a) { problems.push(`GONE   ${key} — no longer exists in app.js`); drifted++; continue; }
    if (!b) { problems.push(`ABSENT ${key} — missing from the port`); drifted++; continue; }
    if (normalize(a) === normalize(b)) { matched++; continue; }
    if (DIVERGENCES[key]) {
      noted++;
      usedDivergences.add(key);
      console.log(`note   ${key}\n       ${DIVERGENCES[key]}`);
      continue;
    }
    drifted++;
    problems.push(`DRIFT  ${key}`);
    if (SHOW) {
      problems.push(`--- app.js ---\n${a}\n--- port ---\n${b}\n`);
    } else {
      const na = normalize(a), nb = normalize(b);
      let i = 0;
      while (i < na.length && na[i] === nb[i]) i++;
      problems.push(`       app.js: …${na.slice(Math.max(0, i - 50), i + 80)}`);
      problems.push(`       port  : …${nb.slice(Math.max(0, i - 50), i + 80)}`);
    }
  }
}

for (const [file, names] of Object.entries(CONSTANTS)) {
  for (const name of names) {
    const key = `${file}:${name}`;
    const a = extractConst(app, name);
    const b = extractConst(files[file], name);
    if (!a) { problems.push(`GONE   ${key} — no longer exists in app.js`); drifted++; continue; }
    if (!b) { problems.push(`ABSENT ${key} — missing from the port`); drifted++; continue; }
    if (normalize(a) === normalize(b)) { matched++; continue; }
    if (DIVERGENCES[key]) {
      noted++;
      usedDivergences.add(key);
      console.log(`note   ${key}\n       ${DIVERGENCES[key]}`);
      continue;
    }
    drifted++;
    problems.push(`DRIFT  ${key}`);
    problems.push(`       app.js: ${normalize(a).slice(0, 150)}`);
    problems.push(`       port  : ${normalize(b).slice(0, 150)}`);
  }
}

for (const key of Object.keys(DIVERGENCES)) {
  if (usedDivergences.has(key)) continue;
  problems.push(`STALE  ${key} — listed as a deliberate divergence, but it now matches app.js (or isn't checked). Remove the entry, or add the function to PORTED.`);
  drifted++;
}

problems.forEach((line) => console.log(line));
console.log(`\n${matched} in sync · ${noted} deliberate · ${drifted} drifted`);
process.exit(drifted ? 1 : 0);
