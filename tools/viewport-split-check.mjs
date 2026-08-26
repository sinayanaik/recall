// Does building a note SPAN BY SPAN give the same note as lexing it whole?
//
//   node tools/viewport-split-check.mjs
//   node tools/viewport-split-check.mjs --timing   # ...and print the numbers
//
// src/render/block-cache.js no longer lexes a large note on open. It cuts the
// prepared source at the points findSafeLexerBoundaries proves are safe, puts an
// empty chunk in the document for each span, and lexes a span only when the
// reader comes near it. That makes opening a 20MB note cost a screenful instead
// of a book — and it is also the change in this repo most able to render a note
// that is quietly WRONG: a span lexed with the wrong neighbours, a link
// reference definition dropped from the document-wide prelude, a heading the
// contents cannot see, an edit that moves a cut point nobody re-derived.
//
// Project memory carries a warning that an earlier incremental lexer here was
// "attempted and reverted after a fuzzer found corruption bugs". No trace of
// that attempt exists in git — it never reached a commit — so there is nothing
// to read and nothing to learn from except the warning itself. This file is the
// answer to it: every property the viewport-driven path rests on is asserted
// against a corpus, in plain Node, with the real code lifted out of
// block-cache.js as text.
//
// Six properties, and none of them subsumes another:
//
//   A  span equivalence      concatenating the blocks of every span, lexed
//                            independently, equals splitPreparedBlocks() of the
//                            whole document — byte for byte, in order
//   B  scan resumption       findSafeLexerBoundaries resumed AT a safe boundary
//                            reports exactly the boundaries the full scan found
//                            after that point. This is what lets an edit
//                            re-derive one cut without re-scanning the note,
//                            and it is the load-bearing claim in
//                            patchNotesLazyPlanLocally
//   C  prelude equivalence   the prelude built from only the spans that could
//                            hold a link reference definition equals the one a
//                            whole-document lex produces
//   D  heading index         scanPreparedHeadings finds exactly the headings
//                            marked's own lexer does, at the right levels, with
//                            the text the DOM would have shown
//   E  edit equivalence      after patchNotesLazyPlanLocally accepts an edit,
//                            the patched span list still tiles the new document
//                            and still lexes to the full re-lex's blocks
//   F  coverage floor        ...and it accepts ordinary edits often enough to be
//                            worth having. A patcher that always refused would
//                            satisfy A-E perfectly and deliver nothing
//
// Same corpus as tools/incremental-split-check.mjs (tools/note-shapes.mjs), and
// the same reason for needing no browser: every function involved is a pure
// function of a string whose only free name is `marked`, and marked is vendored.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls } from "./js-scan.mjs";
import { AT, DISRUPTIVE, EDITS, SHAPES } from "./note-shapes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMING = process.argv.includes("--timing");
const require = createRequire(import.meta.url);
const marked = require("../vendor/marked-14.1.2/marked.min.js");

const BLOCK_CACHE = path.join(ROOT, "src/render/block-cache.js");

// scanPreparedHeadings asks preprocess.js what a list item looks like, so that a
// run of dashes under a BULLET is read as the list's thematic break rather than
// as a setext underline. One shared answer, so the scanner and the renderer
// cannot drift about it — which means this file has to lift it too.
const PREPROCESS = path.join(ROOT, "src/render/preprocess.js");

const PREPROCESS_WANTED = ["LIST_ITEM_SOURCE"];

const WANTED = [
  "isBlockToken",
  "definitionPrelude",
  "splitPreparedBlocks",
  "findSafeLexerBoundaries",
  "AFFIX_SCAN_STEP_CHARS",
  "preparedEditRange",
  "sameLinkDefinitions",
  "NOTES_LAZY_SPAN_SEGMENTS",
  "NOTES_LAZY_SPAN_MAX_CHARS",
  "NOTES_LAZY_DEFINITION_RE",
  "NOTES_LAZY_PRELUDE_MAX_CHARS",
  "planNotesLazySpans",
  "notesLazySpanAt",
  "notesLazyDefinitionSpans",
  "lexNotesLazySpan",
  "notesLazyPrelude",
  "rebuildNotesLazySpan",
  "patchNotesLazyPlanLocally",
  "HEADING_ATX_RE",
  "HEADING_SETEXT_RE",
  "HEADING_QUOTE_RE",
  "HEADING_ENTITIES",
  "plainHeadingText",
  "stripAtxClosing",
  "scanPreparedHeadings",
];

function liftFrom(file, label, wanted) {
  const decls = new Map(topLevelDecls(readFileSync(file, "utf8")).map((d) => [d.name, d]));
  const missing = wanted.filter((name) => !decls.has(name));
  if (missing.length) {
    console.log(`viewport-split-check: ${label} has no ${missing.join(", ")} — nothing to check.`);
    process.exit(1);
  }
  return wanted
    .map((name) => decls.get(name))
    .sort((a, b) => a.start - b.start)
    .map((d) => (d.kind === "function" || d.kind === "class" ? d.text : `${d.kind} ${d.text}`.replace(/^(const|let|var) (const|let|var) /, "$1 ")))
    .join("\n\n");
}

function loadLazySplitters() {
  // preprocess.js first: block-cache's scanner reads LIST_ITEM_SOURCE, so the
  // declaration has to already be initialised when the scanner's body runs.
  const body = [
    liftFrom(PREPROCESS, "preprocess.js", PREPROCESS_WANTED),
    liftFrom(BLOCK_CACHE, "block-cache.js", WANTED)
  ].join("\n\n");
  const names = [...PREPROCESS_WANTED, ...WANTED];
  const factory = new Function("marked", `${body}\nreturn { ${names.join(", ")} };`);
  return factory(marked);
}

const api = loadLazySplitters();
const failures = [];

// A plan with no DOM behind it. patchNotesLazyPlanLocally only touches chunks
// for spans that are BUILT, and nothing here is built, so the whole span/offset
// half of it runs exactly as it does in the browser while the DOM half never
// engages. That is the part worth asserting: the certificates decide whether an
// edit may be taken locally, and everything after them is bookkeeping.
function planFor(prepared, segments) {
  const boundaries = api.findSafeLexerBoundaries(prepared);
  const spans = segments == null
    ? api.planNotesLazySpans(prepared, boundaries)
    : cutEvery(prepared, boundaries, segments);
  const links = new Array(spans.length).fill(null);
  const candidates = api.notesLazyDefinitionSpans(prepared, spans);
  const prelude = api.notesLazyPrelude(prepared, spans, candidates, links);
  for (let i = 0; i < links.length; i += 1) if (!links[i]) links[i] = {};
  return { prepared, prelude, spans, candidates, links, chunks: [], blocks: new Array(spans.length).fill(null), groups: new Array(spans.length).fill(null), starts: new Array(spans.length).fill(null), built: new Uint8Array(spans.length) };
}

// The shipped planner groups by NOTES_LAZY_SPAN_SEGMENTS, which on a corpus this
// size would give one span and prove nothing. Cutting every `segments`
// boundaries walks the cut points across the whole document instead, so every
// safe boundary in every fixture gets to be a span edge in some run.
function cutEvery(prepared, boundaries, segments) {
  const spans = [];
  let start = 0;
  boundaries.forEach((at, i) => {
    if ((i + 1) % segments) return;
    spans.push({ start, end: at });
    start = at;
  });
  spans.push({ start, end: prepared.length });
  return spans;
}

function spanBlocks(prepared, spans) {
  const blocks = [];
  for (const span of spans) {
    const lexed = api.lexNotesLazySpan(prepared, span);
    if (!lexed) return null;
    lexed.blocks.forEach((raw) => blocks.push(raw));
  }
  return blocks;
}

function sameBlocks(label, got, want) {
  if (!got) {
    failures.push(`${label}: a span failed to lex`);
    return false;
  }
  if (got.length !== want.length || got.some((b, k) => b !== want[k])) {
    const firstBad = got.findIndex((b, k) => b !== want[k]);
    failures.push(
      `${label}: ${got.length} blocks vs ${want.length}` +
      (firstBad === -1 ? "" : `, first difference at ${firstBad}:\n` +
        `      got  ${JSON.stringify((got[firstBad] || "").slice(0, 70))}\n` +
        `      want ${JSON.stringify((want[firstBad] || "").slice(0, 70))}`)
    );
    return false;
  }
  return true;
}

// ── A + C: a note built span by span is the same note ──────────────────────

const SEGMENT_SIZES = [1, 2, 3, 5, 8, 13];
let planCases = 0;
let spanCount = 0;

for (const [shapeName, build] of Object.entries(SHAPES)) {
  const prepared = build();
  const full = api.splitPreparedBlocks(prepared);
  if (!full) {
    failures.push(`${shapeName}: splitPreparedBlocks returned null on the fixture itself`);
    continue;
  }
  for (const segments of SEGMENT_SIZES) {
    const plan = planFor(prepared, segments);
    planCases += 1;
    spanCount += plan.spans.length;
    // Spans must TILE: no gap, no overlap, no reordering. Everything else here
    // assumes it, and a hole would silently delete part of the note.
    let tiled = plan.spans[0]?.start === 0 && plan.spans[plan.spans.length - 1]?.end === prepared.length;
    for (let i = 1; tiled && i < plan.spans.length; i += 1) {
      if (plan.spans[i].start !== plan.spans[i - 1].end) tiled = false;
    }
    if (!tiled) {
      failures.push(`${shapeName} / every ${segments}: the spans do not tile the document`);
      continue;
    }
    sameBlocks(`${shapeName} / every ${segments} boundaries`, spanBlocks(prepared, plan.spans), full.blocks);
    if (plan.prelude !== full.prelude) {
      failures.push(`${shapeName} / every ${segments}: prelude ${JSON.stringify(plan.prelude)} vs ${JSON.stringify(full.prelude)}`);
    }
    // notesLazySpanAt has to agree with the tiling it searches, or a jump lands
    // in the wrong chapter and a local edit patches the wrong span.
    for (let i = 0; i < plan.spans.length; i += 1) {
      const span = plan.spans[i];
      const probes = [span.start, Math.floor((span.start + span.end) / 2), span.end - 1].filter((at) => at >= span.start && at < span.end);
      for (const at of probes) {
        if (api.notesLazySpanAt(plan, at) !== i) {
          failures.push(`${shapeName} / every ${segments}: offset ${at} resolved to span ${api.notesLazySpanAt(plan, at)}, not ${i}`);
          break;
        }
      }
    }
  }
}

// ── B: a boundary scan resumed at a safe boundary ──────────────────────────
//
// The claim patchNotesLazyPlanLocally rests on. At a safe boundary the scanner's
// state is canonical — outside every fence, no blank run open, previous line not
// safe — so a scan STARTED there sees exactly what the full scan saw from there
// on. If that ever stops being true, an edit could keep a cut point the new
// document no longer has, and every span after it would be lexed at the wrong
// offsets.
let resumptions = 0;
for (const [shapeName, build] of Object.entries(SHAPES)) {
  const prepared = build();
  const boundaries = api.findSafeLexerBoundaries(prepared);
  if (!boundaries.length) continue;
  const step = Math.max(1, Math.floor(boundaries.length / 12));
  for (let i = 0; i < boundaries.length; i += step) {
    const at = boundaries[i];
    const want = boundaries.filter((b) => b > at).map((b) => b - at);
    const got = api.findSafeLexerBoundaries(prepared.slice(at));
    resumptions += 1;
    if (got.length !== want.length || got.some((b, k) => b !== want[k])) {
      failures.push(`${shapeName}: a scan resumed at ${at} found ${got.length} boundaries, not ${want.length}`);
      break;
    }
  }
}

// ── D: the heading index ───────────────────────────────────────────────────
//
// Compared against marked's own heading tokens rather than against a second
// regex, because the contents is now derived from the source and the source is
// not what the reader sees — the lexer is the authority on which lines are
// headings and at what level.
//
// Top level and inside blockquotes, which is what scanPreparedHeadings claims.
// A heading nested in a LIST ITEM is deliberately out of scope (`- ## thing`
// renders as a heading but reads as a list item, and the contents is better
// without it); the count below reports any the corpus contains so the exclusion
// stays a decision rather than an accident.
function lexedHeadings(tokens, out = [], nested = false) {
  for (const token of tokens || []) {
    if (token.type === "heading") out.push({ level: token.depth, text: api.plainHeadingText(token.text), nested });
    if (token.type === "blockquote") lexedHeadings(token.tokens, out, nested);
    if (token.type === "list") token.items?.forEach((item) => lexedHeadings(item.tokens, out, true));
  }
  return out;
}

// The corpus in note-shapes.mjs is built out of well-formed prose, so it never
// once asked the scanner about the lines that made the CONTENTS point at the
// wrong heading. Each of these produced a row the rendered note has no heading
// for, and a phantom row does not merely add itself: the rows are paired with
// the rendered elements in document order, so one of them shifts every real
// heading after it by one and the reader is taken to the previous section.
const HEADING_EDGE_SHAPES = {
  listThenRule: "# A\n\n- foo\n- bar\n---\n\n## B\n",
  orderedListThenRule: "# A\n\n1. foo\n---\n\n## B\n",
  quotedListThenRule: "# A\n\n> - foo\n> ---\n\n## B\n",
  // Written in pieces so this file does not itself contain a comment that its
  // own reader has to skip past.
  commentedOutSection: `# A\n\n${"<!--"}\n## Draft\n${"-->"}\n\n## B\n`,
  inlineComment: `# A\n\n${"<!--"} ## Draft ${"-->"}\n\n## B\n`,
  // The app's own highlight-notes markers open and close within one line, so
  // they must leave the comment state exactly as they found it.
  highlightNotesMarkers: `# A\n\n${"<!--"}recall:highlight-notes${"-->"}\n\n## B\n`,
  fenceHoldingAComment: `# A\n\n\`\`\`\n${"<!--"}\n\`\`\`\n\n## B\n`,
  // Not a phantom — a real setext heading, here so the fix above cannot pass by
  // simply refusing every dash underline.
  paragraphThenRule: "# A\n\nfoo\n---\n\n## B\n",
  setextH1: "Overview\n========\n\n## B\n",
  setextH2: "Overview\n--------\n\n## B\n",
  // An escaped marker is TEXT. Stripping emphasis before undoing the escape read
  // this as "a \\ b", so the row said one thing and the page said another.
  escapedEmphasis: "# A\n\n## a \\* b\n"
};

let headingCases = 0;
let headingsSeen = 0;
let headingsInLists = 0;
const headingShapes = Object.entries(SHAPES)
  .map(([name, build]) => [name, build])
  .concat(Object.entries(HEADING_EDGE_SHAPES).map(([name, text]) => [name, () => text]));
for (const [shapeName, build] of headingShapes) {
  const prepared = build();
  const want = lexedHeadings(marked.lexer(prepared)).filter((h) => h.text);
  headingsInLists += want.filter((h) => h.nested).length;
  const wanted = want.filter((h) => !h.nested);
  const got = api.scanPreparedHeadings(prepared);
  headingCases += 1;
  headingsSeen += got.length;
  if (got.length !== wanted.length) {
    failures.push(`${shapeName}: scanned ${got.length} headings, marked found ${wanted.length}`);
    continue;
  }
  for (let i = 0; i < got.length; i += 1) {
    if (got[i].level !== wanted[i].level || got[i].text !== wanted[i].text) {
      failures.push(
        `${shapeName}: heading ${i} scanned as h${got[i].level} ${JSON.stringify(got[i].text)}, ` +
        `marked says h${wanted[i].level} ${JSON.stringify(wanted[i].text)}`
      );
      break;
    }
    if (!(got[i].offset >= 0 && got[i].offset < prepared.length)) {
      failures.push(`${shapeName}: heading ${i} claims offset ${got[i].offset} in a ${prepared.length}-char document`);
      break;
    }
    if (i && got[i].offset <= got[i - 1].offset) {
      failures.push(`${shapeName}: heading offsets are not increasing at ${i}`);
      break;
    }
  }
}

// ── E + F: an edit, taken locally ──────────────────────────────────────────

let editCases = 0;
let editAccepted = 0;
let editBailed = 0;
const perEdit = new Map();

// Three span sizes, because they test different things. At 3 boundaries a span
// the fixtures have dozens of cuts and nearly every edit lands next to one, which
// is the stress case for the certificates; at NOTES_LAZY_SPAN_SEGMENTS the spans
// are the size they really are, which is the only size at which the coverage
// floor below means anything. The identity property has to hold at all of them.
const EDIT_SEGMENT_SIZES = [3, 12, api.NOTES_LAZY_SPAN_SEGMENTS];

for (const [shapeName, build] of Object.entries(SHAPES)) {
  const prepared = build();
  for (const [editName, apply] of Object.entries(EDITS)) {
    for (const fraction of AT) {
      const next = apply(prepared, fraction);
      if (next === prepared) continue;
      for (const segments of EDIT_SEGMENT_SIZES) {
      const plan = planFor(prepared, segments);
      editCases += 1;
      const outcome = api.patchNotesLazyPlanLocally(null, plan, next);
      // Counted at the production span size only: a floor measured on spans of
      // three blocks would be measuring the fixture, not the splitter.
      if (segments === api.NOTES_LAZY_SPAN_SEGMENTS) {
        const row = perEdit.get(editName) || { tried: 0, accepted: 0 };
        row.tried += 1;
        if (outcome === "patched") row.accepted += 1;
        perEdit.set(editName, row);
      }
      if (outcome !== "patched") {
        editBailed += 1;
        continue;
      }
      editAccepted += 1;
      if (plan.prepared !== next) {
        failures.push(`${shapeName} / ${editName} @${fraction}: the plan did not take the new source`);
        continue;
      }
      let tiled = plan.spans[0].start === 0 && plan.spans[plan.spans.length - 1].end === next.length;
      for (let i = 1; tiled && i < plan.spans.length; i += 1) {
        if (plan.spans[i].start !== plan.spans[i - 1].end) tiled = false;
      }
      if (!tiled) {
        failures.push(`${shapeName} / ${editName} @${fraction}: the patched spans do not tile the edited document`);
        continue;
      }
      const full = api.splitPreparedBlocks(next);
      if (!sameBlocks(`${shapeName} / ${editName} @${fraction}`, spanBlocks(next, plan.spans), full ? full.blocks : [])) continue;
      // The prelude is not recomputed by a local patch — the link-definition
      // certificate is what says it did not need to be. So it has to still be
      // the right one for the edited document.
      if (full && plan.prelude !== full.prelude) {
        failures.push(`${shapeName} / ${editName} @${fraction}: prelude ${JSON.stringify(plan.prelude)} vs ${JSON.stringify(full.prelude)}`);
      }
      // Every cut the patch kept must still be a real boundary of the NEW
      // document. This is property B applied to the outcome rather than to the
      // rule, and it is the assertion that would have caught the whole class of
      // "the certificate passed but the cut moved" bug.
      const trueCuts = new Set(api.findSafeLexerBoundaries(next));
      for (let i = 1; i < plan.spans.length; i += 1) {
        if (!trueCuts.has(plan.spans[i].start)) {
          failures.push(`${shapeName} / ${editName} @${fraction} / every ${segments}: span ${i} starts at ${plan.spans[i].start}, which is not a safe boundary of the edited document`);
          break;
        }
      }
      }
    }
  }
}

export const COVERAGE_FLOOR = 0.85;

const ordinary = [...perEdit.entries()].filter(([name]) => !DISRUPTIVE.has(name));
const lowCoverage = ordinary.filter(([, row]) => row.tried && row.accepted / row.tried < COVERAGE_FLOOR);

if (TIMING) {
  const big = SHAPES["headings, prose and bullets"]().repeat(24);
  api.findSafeLexerBoundaries(big); // warm
  let t0 = performance.now();
  const full = api.splitPreparedBlocks(big);
  const fullMs = performance.now() - t0;
  t0 = performance.now();
  const boundaries = api.findSafeLexerBoundaries(big);
  const scanMs = performance.now() - t0;
  const spans = api.planNotesLazySpans(big, boundaries);
  t0 = performance.now();
  api.lexNotesLazySpan(big, spans[0]);
  const spanMs = performance.now() - t0;
  console.log(
    `  timing  ${Math.round(big.length / 1000)}KB / ${full.blocks.length} blocks · ` +
    `whole-document lex ${fullMs.toFixed(1)}ms · boundary scan ${scanMs.toFixed(1)}ms · one span ${spanMs.toFixed(1)}ms · ` +
    `${spans.length} spans`
  );
}

for (const [name, row] of [...perEdit.entries()].sort()) {
  const rate = row.tried ? Math.round((row.accepted / row.tried) * 100) : 0;
  const flag = DISRUPTIVE.has(name) ? " (disruptive, no floor)" : "";
  console.log(`  ${String(rate).padStart(3)}%  ${name}${flag}  ·  ${row.accepted}/${row.tried}`);
}

for (const [name, row] of lowCoverage) {
  failures.push(`coverage: "${name}" was patched locally ${row.accepted}/${row.tried} times, under the ${Math.round(COVERAGE_FLOOR * 100)}% floor — an edit to a note built this way would re-plan the whole document every time`);
}

console.log("");
if (failures.length) {
  failures.slice(0, 20).forEach((f) => console.log(`  FAIL  ${f}`));
  if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
}
console.log(
  `${planCases} span plans · ${spanCount} spans · ${resumptions} resumed scans · ` +
  `${headingsSeen} headings over ${headingCases} shapes (${headingsInLists} in list items, out of scope) · ` +
  `${editCases} edits · ${editAccepted} patched locally · ${editBailed} re-planned · ${failures.length} failed`
);
process.exit(failures.length ? 1 : 0);
