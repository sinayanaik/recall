// Does an edit re-split the note into the SAME blocks a full re-lex would?
//
//   node tools/incremental-split-check.mjs
//   node tools/incremental-split-check.mjs --timing   # ...and print the numbers
//
// src/render/block-cache.js patches the previous block array instead of lexing
// the whole note again on every edit (incrementalSplitPreparedBlocks). That is
// the largest single cost on the path between tapping "highlight" and seeing the
// mark — 159ms of marked.lexer on a 2.4MB note, and past
// NOTES_PARSE_CHUNK_MIN_CHARS not even one task but twelve chunks with eleven
// yields between them — and it is also the change in this repo that can most
// quietly produce a WRONG note. A block array that is off by one renders the
// wrong text, shifts every chapter boundary in paged mode, and invalidates every
// cached block.
//
// So the property is asserted directly, on a corpus, in plain Node:
//
//   for every note shape x every edit shape,
//   incrementalSplitPreparedBlocks(base, next) returns either null — "I could
//   not prove it, take the full path" — or a blocks array IDENTICAL to
//   splitPreparedBlocks(next).blocks, with the same prelude.
//
// Plus a coverage floor. A splitter that always returned null would satisfy the
// identity property perfectly and deliver nothing, and that is not a theoretical
// failure: the comment above patchRenderedBlocks records exactly that outcome for
// the streaming path ("measured: the streaming path was never once taken by a
// reader opening a note"). So ordinary edits have to be ACCEPTED at a floor, and
// the floor is asserted.
//
// ── Why this needs no browser ──────────────────────────────────────────────
//
// Every function involved is a pure function of a string whose only free name is
// `marked`, and marked is vendored. tools/cdp.mjs exists because a check that
// skips is a check that never catches anything; this one goes further and needs
// no Chrome at all, so it runs in any checkout on any machine.
//
// The `?v=__BUILD__` query on every import specifier stops Node importing
// block-cache.js directly (and it reaches the DOM through core/dom.js anyway), so
// the declarations are lifted out as TEXT with the same scanner split-parity uses
// and evaluated in a scope holding `marked`. If one of them ever grows a
// non-pure dependency this throws on the first call, loudly, which is right.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { topLevelDecls } from "./js-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMING = process.argv.includes("--timing");
const require = createRequire(import.meta.url);
const marked = require("../vendor/marked-14.1.2/marked.min.js");

// ── Lifting the real code out of block-cache.js ────────────────────────────

const BLOCK_CACHE = path.join(ROOT, "src/render/block-cache.js");

const WANTED = [
  "isBlockToken",
  "definitionPrelude",
  "splitPreparedBlocks",
  "AFFIX_SCAN_STEP_CHARS",
  "INCREMENTAL_SPLIT_MARGIN_BLOCKS",
  "INCREMENTAL_SPLIT_MAX_WINDOW_CHARS",
  "INCREMENTAL_SPLIT_MAX_WINDOW_BLOCKS",
  "preparedEditRange",
  "blockStartOffsets",
  "lastBlockAtOrBefore",
  "lexWindowBlocks",
  "sameLinkDefinitions",
  "incrementalSplitPreparedBlocks",
];

function loadSplitters() {
  const src = readFileSync(BLOCK_CACHE, "utf8");
  const decls = new Map(topLevelDecls(src).map((d) => [d.name, d]));
  const missing = WANTED.filter((name) => !decls.has(name));
  if (missing.length) {
    console.log(`incremental-split-check: block-cache.js has no ${missing.join(", ")} — nothing to check.`);
    process.exit(1);
  }
  // Declaration ORDER as written, so a const referenced by a later const is
  // already initialised. `text` skips the `export ` keyword, which is exactly
  // what makes these evaluable outside a module.
  const body = WANTED
    .map((name) => decls.get(name))
    .sort((a, b) => a.start - b.start)
    .map((d) => (d.kind === "function" || d.kind === "class" ? d.text : `${d.kind} ${d.text}`.replace(/^(const|let|var) (const|let|var) /, "$1 ")))
    .join("\n\n");
  const factory = new Function("marked", `${body}\nreturn { ${WANTED.join(", ")} };`);
  return factory(marked);
}

const api = loadSplitters();

// ── The corpus ─────────────────────────────────────────────────────────────
//
// These are PREPARED strings, which is what incrementalSplitPreparedBlocks is
// contracted on — the design deliberately makes no claim about
// preprocessSpecialBlocks and diffs its output instead. So the fixtures carry the
// shapes preprocess really emits (a cloze span, a math div, a diagram div) rather
// than their markdown sources.

function prose(n, tag = "P") {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${tag}${String(i).padStart(4, "0")} ${words.join(" ")} and some more words to make a real line.`);
    out.push("");
  }
  return out.join("\n");
}

const SHAPES = {
  "uniform prose": () => prose(120),

  "headings, prose and bullets": () => {
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      out.push(`## Section ${i}`, "", prose(2, `S${i}`), "- one item", "- two item", "- three item", "");
    }
    return out.join("\n");
  },

  "fenced code with blank lines in it": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `F${i}`), "```js", `const a${i} = 1;`, "", `const b${i} = 2;`, "```", "");
    }
    return out.join("\n");
  },

  "a loose list": () => {
    const out = [prose(2, "LL")];
    for (let i = 0; i < 30; i += 1) out.push(`- loose item ${i} with a sentence after it`, "");
    out.push(prose(2, "LT"));
    return out.join("\n");
  },

  "a tight list": () => {
    const out = [prose(2, "TL"), ""];
    for (let i = 0; i < 30; i += 1) out.push(`${i + 1}. tight item ${i} with a sentence after it`);
    out.push("", prose(2, "TT"));
    return out.join("\n");
  },

  "blockquotes with lazy continuation": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(`> quoted line ${i} opening the quote`, `lazily continued line ${i} with no marker`, "", prose(1, `Q${i}`));
    }
    return out.join("\n");
  },

  "GFM tables": () => {
    const out = [];
    for (let i = 0; i < 20; i += 1) {
      out.push(prose(1, `T${i}`), "| Element | Symbol |", "| --- | --- |", `| Hydrogen ${i} | H |`, `| Helium ${i} | He |`, "");
    }
    return out.join("\n");
  },

  "link definitions in four positions": () => {
    const out = ["[top]: http://example.com/top", "", prose(20, "LD")];
    out.push("[mid]: http://example.com/mid", "");
    out.push("A paragraph with no blank line under it");
    out.push("[absorbed]: http://example.com/absorbed", "");
    out.push(prose(20, "LE"));
    out.push("[last]: http://example.com/last");
    return out.join("\n");
  },

  "setext headings": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(`Setext heading ${i}`, "================", "", prose(1, `X${i}`));
    }
    return out.join("\n");
  },

  "indented code after paragraphs": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `I${i}`), `    indented code line ${i}`, `    more indented code ${i}`, "");
    }
    return out.join("\n");
  },

  "inline cloze, math and diagram HTML": () => {
    const out = [];
    for (let i = 0; i < 25; i += 1) {
      out.push(`Paragraph M${i} with a <span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">hidden ${i}</span> in it.`, "");
      out.push(`<div class="math-display" data-tex="x%5E${i}"></div>`, "");
      out.push(`<div class="mermaid" data-diagram="graph%20TD%3B%20A${i}--%3EB${i}%3B"></div>`, "");
      out.push(prose(1, `M${i}`));
    }
    return out.join("\n");
  },

  "thematic breaks and raw html": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `H${i}`), "---", `<div class="notes-img-row"><img src="a${i}.png" alt=""></div>`, "");
    }
    return out.join("\n");
  },

  "no trailing newline": () => prose(60, "N").trimEnd(),

  "one block": () => "Just the one paragraph, nothing else at all in this note.",
};

// ── The edits ──────────────────────────────────────────────────────────────
//
// `at` is a fraction of the document, so every edit is tried near the top, in
// the middle and near the end — the head and tail of a note are where the
// window has to clamp rather than bail, and that was worth 10% of all accepted
// cases on its own.

function spliceAt(text, fraction, remove, insert) {
  const want = Math.floor(text.length * fraction);
  // Land on a word boundary inside a line rather than mid-token: an edit that
  // cuts a word in half is a fine test of the guard but a poor test of anything
  // a reader actually does.
  let at = text.indexOf(" ", want);
  if (at === -1) at = want;
  at = Math.min(at + 1, text.length);
  return text.slice(0, at) + insert + text.slice(at + remove);
}

const EDITS = {
  "highlight": (t, f) => spliceAt(t, f, 8, '<mark data-color="yellow">selected</mark>'),
  "recolour a highlight": (t, f) => spliceAt(t, f, 8, '<mark data-color="green">selected</mark>'),
  "multi-block highlight": (t, f) => spliceAt(t, f, 0, '<mark>one</mark>\n\n<mark>two</mark>\n\n'),
  "cloze": (t, f) => spliceAt(t, f, 6, '<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">hidden</span>'),
  "erase a phrase": (t, f) => spliceAt(t, f, 30, ""),
  "erase a whole block": (t, f) => spliceAt(t, f, 200, ""),
  "insert a paragraph": (t, f) => spliceAt(t, f, 0, "\n\nAn inserted paragraph with several words in it.\n\n"),
  "insert a heading": (t, f) => spliceAt(t, f, 0, "\n\n### An inserted heading\n\n"),
  "insert a blank line": (t, f) => spliceAt(t, f, 0, "\n"),
  "join two blocks": (t, f) => {
    const want = Math.floor(t.length * f);
    const at = t.indexOf("\n\n", want);
    return at === -1 ? t : t.slice(0, at) + "\n" + t.slice(at + 2);
  },
  "open an unbalanced fence": (t, f) => spliceAt(t, f, 0, "\n\n```\n"),
  "close a fence": (t, f) => spliceAt(t, f, 0, "\n```\n"),
  "add a table row": (t, f) => spliceAt(t, f, 0, "\n| Lithium | Li |"),
  "add a setext underline": (t, f) => spliceAt(t, f, 0, "\n===="),
  "add a link definition": (t, f) => spliceAt(t, f, 0, "\n\n[added]: http://example.com/added\n\n"),
  "remove a link definition": (t) => t.replace(/^\[mid\]: .*$\n/m, ""),
  "edit at offset 0": (t) => "A brand new first paragraph.\n\n" + t,
  "edit at the very end": (t) => t + "\n\nA brand new last paragraph.\n",
  "length-preserving replacement": (t, f) => spliceAt(t, f, 8, "REPLACED"),
};

const AT = [0.05, 0.5, 0.93];

// Edits whose whole point is to disturb a block junction. They are expected to
// bail often, so they are exempt from the coverage floor — but never from the
// identity property.
const DISRUPTIVE = new Set([
  "join two blocks", "open an unbalanced fence", "close a fence", "add a setext underline",
  "add a link definition", "remove a link definition", "erase a whole block", "add a table row",
]);

// ── Running it ─────────────────────────────────────────────────────────────

let cases = 0;
let accepted = 0;
let bailed = 0;
const failures = [];
const perEdit = new Map();

function baseFor(prepared) {
  const split = api.splitPreparedBlocks(prepared);
  return split ? { prepared, split } : null;
}

function record(edit, ok) {
  const row = perEdit.get(edit) || { tried: 0, accepted: 0 };
  row.tried += 1;
  if (ok) row.accepted += 1;
  perEdit.set(edit, row);
}

for (const [shapeName, build] of Object.entries(SHAPES)) {
  const prepared = build();
  const base = baseFor(prepared);
  if (!base) {
    failures.push(`${shapeName}: splitPreparedBlocks returned null on the fixture itself`);
    continue;
  }
  for (const [editName, apply] of Object.entries(EDITS)) {
    for (const fraction of AT) {
      const next = apply(prepared, fraction);
      if (next === prepared) continue;
      cases += 1;
      // A fresh base each time: `starts` is memoized onto the entry, and one
      // edit must not be able to poison the next case's base.
      const entry = { prepared: base.prepared, split: base.split };
      const patched = api.incrementalSplitPreparedBlocks(entry, next);
      record(editName, Boolean(patched));
      if (!patched) {
        bailed += 1;
        continue;
      }
      accepted += 1;
      const full = api.splitPreparedBlocks(next);
      const want = full ? full.blocks : [];
      const got = patched.split.blocks;
      if (got.length !== want.length || got.some((b, k) => b !== want[k])) {
        const firstBad = got.findIndex((b, k) => b !== want[k]);
        failures.push(
          `${shapeName} / ${editName} @${fraction}: ${got.length} blocks vs ${want.length}` +
          (firstBad === -1 ? "" : `, first difference at ${firstBad}:\n` +
            `      got  ${JSON.stringify((got[firstBad] || "").slice(0, 70))}\n` +
            `      want ${JSON.stringify((want[firstBad] || "").slice(0, 70))}`)
        );
        continue;
      }
      if (full && patched.split.prelude !== full.prelude) {
        failures.push(`${shapeName} / ${editName} @${fraction}: prelude ${JSON.stringify(patched.split.prelude)} vs ${JSON.stringify(full.prelude)}`);
        continue;
      }
      // The offsets have to describe the blocks they were handed back with, or
      // the NEXT edit indexes into a document it does not match.
      const starts = patched.starts;
      if (!starts || starts.length !== got.length) {
        failures.push(`${shapeName} / ${editName} @${fraction}: ${starts ? starts.length : "no"} offsets for ${got.length} blocks`);
        continue;
      }
      for (let k = 0; k < got.length; k += 1) {
        if (!next.startsWith(got[k], starts[k])) {
          failures.push(`${shapeName} / ${editName} @${fraction}: block ${k} is not at offset ${starts[k]}`);
          break;
        }
        if (k && starts[k] <= starts[k - 1]) {
          failures.push(`${shapeName} / ${editName} @${fraction}: offsets are not increasing at ${k}`);
          break;
        }
      }
    }
  }
}

// ── D: the boundary property the chunked lexer also rests on ───────────────
//
// src/render/block-cache.js cited a scripted diff named verify-chunked-lexer.cjs
// for this, and that file is not in the tree — the argument at
// findSafeLexerBoundaries rested on a citation nobody could run. It is asserted
// here instead, and it covers splitPreparedBlocksChunked at the same time:
// lexing a slice that runs from one block's start to another block's start must
// give back exactly the blocks in between.
let windows = 0;
for (const [shapeName, build] of Object.entries(SHAPES)) {
  const prepared = build();
  const split = api.splitPreparedBlocks(prepared);
  if (!split) continue;
  const starts = api.blockStartOffsets(prepared, split.blocks);
  if (!starts) {
    failures.push(`${shapeName}: blockStartOffsets could not place every block`);
    continue;
  }
  const n = split.blocks.length;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 12))) {
    for (const span of [1, 3, 8]) {
      const j = Math.min(n - 1, i + span);
      const from = i === 0 ? 0 : starts[i];
      const to = j === n - 1 ? prepared.length : starts[j + 1];
      const win = api.splitPreparedBlocks(prepared.slice(from, to));
      const want = split.blocks.slice(i, j + 1);
      const got = win ? win.blocks : [];
      windows += 1;
      if (got.length !== want.length || got.some((b, k) => b !== want[k])) {
        failures.push(`${shapeName}: lexing blocks [${i}, ${j}] on their own gave ${got.length} blocks, not ${want.length}`);
      }
    }
  }
}

// ── C: the coverage floor ──────────────────────────────────────────────────

export const COVERAGE_FLOOR = 0.85;

const ordinary = [...perEdit.entries()].filter(([name]) => !DISRUPTIVE.has(name));
const lowCoverage = ordinary.filter(([, row]) => row.tried && row.accepted / row.tried < COVERAGE_FLOOR);

if (TIMING) {
  const big = SHAPES["headings, prose and bullets"]().repeat(24);
  const split = api.splitPreparedBlocks(big);
  const entry = { prepared: big, split };
  const edited = spliceAt(big, 0.5, 8, '<mark data-color="yellow">selected</mark>');
  api.incrementalSplitPreparedBlocks({ prepared: big, split }, edited); // warm
  let t0 = performance.now();
  api.splitPreparedBlocks(edited);
  const fullMs = performance.now() - t0;
  t0 = performance.now();
  api.incrementalSplitPreparedBlocks(entry, edited);
  const incMs = performance.now() - t0;
  console.log(`  timing  ${Math.round(big.length / 1000)}KB / ${split.blocks.length} blocks · full split ${fullMs.toFixed(1)}ms · incremental ${incMs.toFixed(1)}ms`);
}

for (const [name, row] of [...perEdit.entries()].sort()) {
  const rate = row.tried ? Math.round((row.accepted / row.tried) * 100) : 0;
  const flag = DISRUPTIVE.has(name) ? " (disruptive, no floor)" : "";
  console.log(`  ${String(rate).padStart(3)}%  ${name}${flag}  ·  ${row.accepted}/${row.tried}`);
}

for (const [name, row] of lowCoverage) {
  failures.push(`coverage: "${name}" was accepted ${row.accepted}/${row.tried} times, under the ${Math.round(COVERAGE_FLOOR * 100)}% floor — the splitter is bailing on ordinary edits and delivering nothing`);
}

console.log("");
if (failures.length) {
  failures.slice(0, 20).forEach((f) => console.log(`  FAIL  ${f}`));
  if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
}
console.log(
  `${cases} cases · ${accepted} incremental · ${bailed} bailed to the full path · ` +
  `${windows} boundary windows · ${failures.length} failed`
);
process.exit(failures.length ? 1 : 0);
