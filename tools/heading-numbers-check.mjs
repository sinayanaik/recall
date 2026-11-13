// Section numbers on a note's headings, and the section filter on its highlights.
//
//   node tools/heading-numbers-check.mjs
//
// src/notes/heading-numbers.js counts 1, 1.1, 1.2, 1.2.1 … by nesting, and is
// pure, so it is loaded straight from src/. The two things built on it are not
// — sectionHeadingIndexFor (src/notes/chapters.js) and the section filter
// (src/panels/highlight-sections.js) live in modules that reach the DOM — so
// their declarations are lifted out as text, the way viewport-split-check does,
// with the scanner they rely on.
//
// The question that matters most is the third one below: a highlight listed
// under "2.3" must be under the heading the NOTE shows as 2.3. The note numbers
// what marked renders; the highlight lists number what the source scan finds.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { topLevelDecls } from "./js-scan.mjs";
import { SHAPES } from "./note-shapes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const marked = require("../vendor/marked-14.1.2/marked.min.js");
const numbersModule = await import(pathToFileURL(path.join(ROOT, "src/notes/heading-numbers.js")).href);
const { headingNumbersForLevels, headingParentsForLevels, typedHeadingNumbers, stripTypedHeadingNumbersFromMarkdown, withoutTypedNumber } = numbersModule;

function liftFrom(file, wanted) {
  const decls = new Map(topLevelDecls(readFileSync(path.join(ROOT, file), "utf8")).map((d) => [d.name, d]));
  const missing = wanted.filter((name) => !decls.has(name));
  if (missing.length) {
    console.log(`heading-numbers-check: ${file} has no ${missing.join(", ")} — nothing to check.`);
    process.exit(1);
  }
  return wanted
    .map((name) => decls.get(name))
    .sort((a, b) => a.start - b.start)
    .map((d) => (d.kind === "function" || d.kind === "class" ? d.text : `${d.kind} ${d.text}`.replace(/^(const|let|var) (const|let|var) /, "$1 ")))
    .join("\n\n");
}

const LIFTED = [
  ["src/render/preprocess.js", ["LIST_ITEM_SOURCE"]],
  ["src/render/block-cache.js", ["HEADING_ATX_RE", "HEADING_SETEXT_RE", "HEADING_QUOTE_RE", "HEADING_ENTITIES", "plainHeadingText", "stripAtxClosing", "scanPreparedHeadings"]],
  ["src/notes/chapters.js", ["cachedSectionSource", "cachedSectionIndex", "sectionHeadingIndexFor", "sectionIndexForOffset"]],
  ["src/panels/highlight-sections.js", ["SECTION_BEFORE_KEY", "withSectionDepths", "beforeFirstSection", "documentSectionModel", "sectionParentKeys", "sectionCoveredBy", "sectionFilterFor", "sectionCounts"]]
];
// The PDF's contents, as documentOutlineEntries would hand them over — set per
// case below.
let outline = [];
const documentOutlineEntries = () => outline;
const names = LIFTED.flatMap(([, wanted]) => wanted);
const body = LIFTED.map(([file, wanted]) => liftFrom(file, wanted)).join("\n\n");
const api = new Function("marked", "headingNumbersForLevels", "headingParentsForLevels", "typedHeadingNumbers", "documentOutlineEntries", `${body}\nreturn { ${names.join(", ")} };`)(
  marked, headingNumbersForLevels, headingParentsForLevels, typedHeadingNumbers, documentOutlineEntries);

const results = [];
function must(name, fn) {
  try {
    const answer = fn();
    results.push([answer === true, name, answer === true ? "" : String(answer)]);
  } catch (error) {
    results.push([false, name, error?.stack || String(error)]);
  }
}

const numbered = (levels) => headingNumbersForLevels(levels).join(" ");

// ── 1. The counting ─────────────────────────────────────────────────────────

must("nested headings count 1, 1.1, 1.2, 1.2.1, 2", () => {
  const got = numbered([1, 2, 2, 3, 1]);
  return got === "1 1.1 1.2 1.2.1 2" || `got ${got}`;
});

must("a skipped level collapses: # then ### is 1, 1.1", () => {
  const got = numbered([1, 3, 3, 2]);
  return got === "1 1.1 1.2 1.3" || `got ${got}`;
});

must("the shallowest level used is 1: a note of ## is 1, 2, 3", () => {
  const got = numbered([2, 2, 3, 2]);
  return got === "1 2 2.1 3" || `got ${got}`;
});

must("a deeper first heading is still 1, and a shallower one after it is 2", () => {
  const got = numbered([3, 1, 2]);
  return got === "1 2 2.1" || `got ${got}`;
});

must("every level is numbered, down to six deep", () => {
  const got = numbered([1, 2, 3, 4, 5, 6, 6]);
  return got === "1 1.1 1.1.1 1.1.1.1 1.1.1.1.1 1.1.1.1.1.1 1.1.1.1.1.2" || `got ${got}`;
});

must("a sub-count restarts under each new parent", () => {
  const got = numbered([1, 2, 3, 2, 3, 1, 2]);
  return got === "1 1.1 1.1.1 1.2 1.2.1 2 2.1" || `got ${got}`;
});

must("no headings, no numbers", () => headingNumbersForLevels([]).length === 0 || "not empty");

must("parents follow the same nesting", () => {
  const got = headingParentsForLevels([1, 3, 2, 3, 1]).join(",");
  return got === "-1,0,0,2,-1" || `got ${got}`;
});

// ── 2. The section index ────────────────────────────────────────────────────

const NOTE = [
  "Intro before any heading.",
  "",
  "# Alpha",
  "",
  "text a",
  "",
  "## Beta",
  "",
  "text b",
  "",
  "#### Gamma",
  "",
  "text g",
  "",
  "Delta",
  "-----",
  "",
  "text d",
  "",
  "<!--",
  "## Draft",
  "-->",
  "",
  "```",
  "# not a heading",
  "```",
  "",
  "# Alpha",
  "",
  "text a2"
].join("\n");

must("sections carry numbers, parents and keys that survive a repeat title", () => {
  const sections = api.sectionHeadingIndexFor(NOTE);
  const got = sections.map((s) => `${s.number}|${s.title}|${s.parent}|${s.key}`).join(" / ");
  const want = "1|Alpha|-1|1:Alpha / 1.1|Beta|0|2:Beta / 1.1.1|Gamma|1|4:Gamma / 1.2|Delta|0|2:Delta / 2|Alpha|-1|1:Alpha#2";
  return got === want || `got ${got}`;
});

must("an offset finds the section it is in, and -1 before the first", () => {
  const sections = api.sectionHeadingIndexFor(NOTE);
  const at = (needle) => api.sectionIndexForOffset(sections, NOTE.indexOf(needle));
  const got = [at("Intro"), at("text a"), at("text g"), at("text d"), at("not a heading"), at("text a2")].join(",");
  return got === "-1,0,2,3,3,4" || `got ${got}`;
});

// ── 3. The lists and the note agree ─────────────────────────────────────────
//
// What the note draws: marked's own top-level headings (blockquotes included,
// list items not — the same choice the contents makes), numbered.
function renderedNumbers(text) {
  const out = [];
  const walk = (tokens) => {
    for (const token of tokens || []) {
      if (token.type === "heading" && api.plainHeadingText(token.text)) out.push(token.depth);
      if (token.type === "blockquote") walk(token.tokens);
    }
  };
  walk(marked.lexer(text));
  return headingNumbersForLevels(out).join(" ");
}

// A note pasted from a numbered PDF: typed numbers on every heading, some of
// them stale or doubled.
const TYPED_NOTE = [
  "# 1 Introduction", "", "text", "",
  "## 1.1 Background", "", "text", "",
  "## **1.2** Setup", "", "text", "",
  "### (a) Data", "", "text", "",
  "# 2. 2. Results", "", "text", "",
  "Discussion", "==========", "", "text"
].join("\n");

const CORPUS = Object.entries(SHAPES).map(([name, build]) => [name, build()]).concat([["mixed note", NOTE], ["typed-number note", TYPED_NOTE]]);
for (const [name, text] of CORPUS) {
  must(`${name}: the highlight lists number its sections as the note does`, () => {
    const got = api.sectionHeadingIndexFor(text).map((s) => s.number).join(" ");
    const want = renderedNumbers(text);
    return got === want || `lists say [${got.slice(0, 120)}], note says [${want.slice(0, 120)}]`;
  });
}

// ── 3b. Numbers typed into headings ─────────────────────────────────────────
//
// typedHeadingNumbers decides which leading markers are a number the drawn one
// replaces. Every case here is one title on its own unless it says otherwise —
// so a BARE number ("1 Intro") is kept, having no numbered neighbours.

const TYPED = [
  // stripped: [title, prefix]
  ["1.2 Methods", "1.2 "], ["1.2.3. Deep", "1.2.3. "], ["1) Paren", "1) "], ["(1) Both", "(1) "],
  ["[2] Square", "[2] "], ["a) Letter", "a) "], ["(b) Letter", "(b) "], ["A. Outline", "A. "],
  ["A.1 Appendix part", "A.1 "], ["IV. Roman", "IV. "], ["iv) roman", "iv) "], ["II. Methods", "II. "],
  ["§ 2.3 Section sign", "§ 2.3 "], ["2 - Dash", "2 - "], ["3 — Em dash", "3 — "], ["1: Colon", "1: "],
  ["1 : Spaced colon", "1 : "], ["2.3.b Sub-letter", "2.3.b "], ["1.Introduction", "1."],
  ["1.2 1.2 Doubled", "1.2 1.2 "], ["1. 1.1 Two numberings", "1. 1.1 "], ["(a) 1. Mixed", "(a) 1. "],
  ["1 1.1 Bare then dotted", "1 1.1 "],
  // kept
  ["1 Bare on its own", ""], ["IV Bare roman", ""], ["3D Printing", ""], ["A Tale", ""], ["I Am", ""],
  ["X Factor", ""], ["V for Vendetta", ""], ["Chapter 3: Words stay", ""], ["Part II Words stay", ""],
  ["Appendix A. Words stay", ""], ["2024", ""], ["1.2", ""], ["e.g. Abbreviation", ""], ["100% Percent", ""],
  ["2024 Review", ""], ["J. K. Rowling", ""], ["E. coli growth", ""], ["U.S. Policy", ""], ["1.2Intro", ""]
];
for (const [title, want] of TYPED) {
  must(`typed number: ${JSON.stringify(title)} → ${want ? `hides ${JSON.stringify(want)}` : "kept"}`, () => {
    const got = typedHeadingNumbers([title])[0];
    return got === want || `got ${JSON.stringify(got)}`;
  });
}

must("a bare number is taken when the note is numbered", () => {
  const got = typedHeadingNumbers(["1 Introduction", "2 Methods", "2.1 Data", "References"]).join("|");
  return got === "1 |2 |2.1 |" || `got ${got}`;
});

must("...and not when one or two headings happen to start with one", () => {
  const got = typedHeadingNumbers(["10 Things", "Why", "How", "When"]).join("|")
    + " / " + typedHeadingNumbers(["10 Things", "5 Tips", "Why", "How", "When"]).join("|");
  return got === "||| / ||||" || `got ${got}`;
});

must("a label drops its typed number only by the exact prefix", () => {
  const got = [withoutTypedNumber("3.1 Methods", "3.1 "), withoutTypedNumber("Methods", "3.1 "), withoutTypedNumber("3.1 Methods", "")].join("|");
  return got === "Methods|Methods|3.1 Methods" || `got ${got}`;
});

must("the section index carries the typed number of each section", () => {
  const got = api.sectionHeadingIndexFor(TYPED_NOTE).map((s) => `${s.number}=${JSON.stringify(s.typedNumber)}`).join(" ");
  const want = '1="1 " 1.1="1.1 " 1.2="1.2 " 1.2.1="(a) " 2="2. 2. " 3=""';
  return got === want || `got ${got}`;
});

// What pasted and imported markdown loses.
const STRIP = [
  ["ATX", "# 1 Intro\n\n## 1.1 Back\n\n## 1.2 More", "# Intro\n\n## Back\n\n## More"],
  ["Turndown's escape", "## 2\\. Escaped", "## Escaped"],
  ["emphasis around the number", "## **1.2** Bold", "## Bold"],
  ["emphasis around the heading", "## **1.3 All bold**", "## **All bold**"],
  ["closing hashes", "## (a) Thing ##", "## Thing ##"],
  ["setext", "1.4 Setext\n----------", "Setext\n----------"],
  ["a quoted heading", "> ## 3.1 Quoted", "> ## Quoted"],
  ["fenced code untouched", "```\n## 3.1 code\n```", "```\n## 3.1 code\n```"],
  ["commented out untouched", "<!--\n## 4.1 hidden\n-->", "<!--\n## 4.1 hidden\n-->"],
  ["prose and lists untouched", "1.2 is a number\n\n- 1. item\n\n1. first", "1.2 is a number\n\n- 1. item\n\n1. first"],
  ["a heading that is only a number", "## 1.2", "## 1.2"],
  ["a lone bare number", "## 10 Things", "## 10 Things"],
  ["words kept", "## Chapter 3: Words", "## Chapter 3: Words"]
];
for (const [name, input, want] of STRIP) {
  must(`pasted markdown: ${name}`, () => {
    const got = stripTypedHeadingNumbersFromMarkdown(input);
    return got === want || `got ${JSON.stringify(got)}`;
  });
}

// ── 4. Picking sections ─────────────────────────────────────────────────────

const MODEL = {
  sections: [
    { key: "A", parentKey: "" },
    { key: "A.1", parentKey: "A" },
    { key: "A.1.a", parentKey: "A.1" },
    { key: "B", parentKey: "" }
  ]
};
const ENTRIES = ["__before", "A", "A.1", "A.1.a", "A.1.a", "B"].map((section, i) => ({ id: i, section }));
const kept = (keys) => ENTRIES.filter(api.sectionFilterFor(MODEL, keys ? new Set(keys) : null)).map((e) => e.id).join(",");

must("no choice keeps everything", () => kept(null) === "0,1,2,3,4,5" || `got ${kept(null)}`);

must("a section brings its subsections with it", () => kept(["A"]) === "1,2,3,4" || `got ${kept(["A"])}`);

must("a subsection on its own is only that subsection", () => kept(["A.1.a"]) === "3,4" || `got ${kept(["A.1.a"])}`);

must("several sections together", () => kept(["A.1", "B"]) === "2,3,4,5" || `got ${kept(["A.1", "B"])}`);

must("what comes before the first heading can be picked like any section", () => kept(["__before"]) === "0" || `got ${kept(["__before"])}`);

must("a section that no longer exists keeps nothing rather than everything", () => kept(["gone"]) === "" || `got ${kept(["gone"])}`);

must("counts include subsections", () => {
  const counts = api.sectionCounts(MODEL, ENTRIES);
  const got = ["__before", "A", "A.1", "A.1.a", "B"].map((k) => counts.get(k) || 0).join(",");
  return got === "1,4,3,2,1" || `got ${got}`;
});

// ── 5. A PDF's sections ─────────────────────────────────────────────────────

must("a PDF's highlights go to the contents entry whose pages they are on", () => {
  outline = [
    { title: "Front", depth: 0, page: 1 },
    { title: "Ch 1", depth: 0, page: 3 },
    { title: "1.1", depth: 1, page: 5 },
    { title: "Ch 2", depth: 0, page: 9 },
    { title: "Broken", depth: 0, page: 0, dead: true }
  ];
  const model = api.documentSectionModel([]);
  const got = [1, 2, 3, 4, 5, 8, 9, 40].map((page) => model.keyForPage(page)).join(",");
  return got === "0:Front,0:Front,0:Ch 1,0:Ch 1,1:1.1,1:1.1,0:Ch 2,0:Ch 2" || `got ${got}`;
});

must("a contents entry's subsections come with it", () => {
  const model = api.documentSectionModel([]);
  const entries = [3, 5, 7, 9].map((page) => ({ section: model.keyForPage(page) }));
  const keptPages = entries.filter(api.sectionFilterFor(model, new Set(["0:Ch 1"]))).length;
  return keptPages === 3 || `kept ${keptPages}`;
});

must("a contents out of page order still places a page by page", () => {
  outline = [{ title: "Appendix", depth: 0, page: 30 }, { title: "Intro", depth: 0, page: 2 }];
  const model = api.documentSectionModel([]);
  const got = [1, 2, 29, 30].map((page) => model.keyForPage(page)).join(",");
  return got === "__before,0:Intro,0:Intro,0:Appendix" || `got ${got}`;
});

must("a PDF with no contents falls back to the pages that carry highlights", () => {
  outline = [];
  const model = api.documentSectionModel([7, 2, 7, 0]);
  const got = model.sections.map((s) => s.title).join(",") + " | " + model.keyForPage(7);
  return got === "Page 2,Page 7 | page:7" || `got ${got}`;
});

console.log("── heading numbers and sections ──");
for (const [ok, name, detail] of results) {
  if (!ok || process.argv.includes("--verbose")) console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
}
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n  ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
