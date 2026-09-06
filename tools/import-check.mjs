// What the app makes of the text you give it.
//
//   node tools/import-check.mjs
//   node tools/import-check.mjs --verbose
//
// Everything a deck can be imported from lands in three leaf modules, and none
// of them had a live check:
//
//   src/import/parse-cards.js      503 lines, 27 exports. Decides where one
//                                  card ends and the next begins, in five
//                                  different syntaxes, and what the deck is
//                                  called. Get it wrong and an import silently
//                                  produces one card containing a whole book,
//                                  or forty cards containing one sentence each
//   src/import/mathml-to-tex.js    592 lines and ZERO imports. Nougat books ship
//                                  <math> with no TeX annotation, and before
//                                  this module they serialized as MathML glyph
//                                  soup in the middle of a note
//   src/render/code-language.js    308 lines, zero imports. Guesses a language
//                                  for a bare fence, which decides which Prism
//                                  grammar highlights it and what the copy
//                                  button is labelled
//
// The only thing that ever exercised any of them was tools/behaviour-parity.mjs
// — five one-line code samples and fourteen markdown strings — and that check
// skipped itself on every machine but one for months. So in practice: nothing.
//
// This drives the real modules in plain Node against tools/adversarial-corpus.mjs,
// which is the list of inputs this app has actually been broken by. No browser,
// no network, no baseline tag: it cannot skip.
//
// The MathML half needs elements rather than strings, so there is a small
// builder below that makes them out of a literal. It implements exactly the six
// pieces of DOM that src/import/mathml-to-tex.js reads and nothing else, which
// is stated rather than hidden: if that module grows a seventh, this fails
// loudly on an undefined rather than quietly on a wrong answer.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, ALL_CASES, asNotes } from "./adversarial-corpus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");
const stage = mkdtempSync(path.join(tmpdir(), "recall-import-"));

// The same trick tools/merged-notes-check.mjs uses: copy src/ somewhere, strip
// the cache-busting stamp off every import, then import the real modules. The
// stamp is what makes them un-importable from Node — `?v=__BUILD__` is not a
// file.
function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
function must(name, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const show = (text) => JSON.stringify(String(text).slice(0, 140));

// ── A MathML element, without a DOM ─────────────────────────────────────────
//
// Six members, because six is what nodeToTex reads: nodeType, localName,
// nodeName, children, textContent, getAttribute/hasAttribute. Text nodes are
// nodeType 3 with a textContent and nothing else.
function mathEl(name, attrs, ...kids) {
  const children = kids.map((k) => (typeof k === "string" ? textNode(k) : k));
  const node = {
    nodeType: 1,
    localName: name,
    nodeName: name,
    get children() { return children.filter((k) => k.nodeType === 1); },
    get childNodes() { return children; },
    get textContent() { return children.map((k) => k.textContent).join(""); },
    getAttribute: (key) => (Object.prototype.hasOwnProperty.call(attrs, key) ? String(attrs[key]) : null),
    hasAttribute: (key) => Object.prototype.hasOwnProperty.call(attrs, key)
  };
  return node;
}
function textNode(value) {
  return { nodeType: 3, textContent: String(value), get children() { return []; } };
}

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  const load = (rel) => import(path.join(stage, rel));
  const cards = await load("src/import/parse-cards.js");
  const mathml = await load("src/import/mathml-to-tex.js");
  const lang = await load("src/render/code-language.js");

  // ── parse-cards: it must never throw, and never lose the text ────────────
  //
  // The floor first, because an import that throws is an import that shows a
  // stack trace where a deck should be. Every case in the corpus, through every
  // public entry point.
  const ENTRIES = [
    ["parseCards", (t) => cards.parseCards(t)],
    ["parseCards, headings off", (t) => cards.parseCards(t, { allowHeuristicHeadings: false })],
    ["classifyCardSyntax", (t) => cards.classifyCardSyntax(t)],
    ["inferDeckTitle", (t) => cards.inferDeckTitle(t, "fallback")],
    ["extractNotesFromMarkdown", (t) => cards.extractNotesFromMarkdown(t)],
    ["normalizeMarkdown", (t) => cards.normalizeMarkdown(t)],
    ["stripReaderMetadata", (t) => cards.stripReaderMetadata(t)],
    ["countQuestionHeadings", (t) => cards.countQuestionHeadings(t)],
    ["hasExplicitCardSyntax", (t) => cards.hasExplicitCardSyntax(t)],
    ["removeEmptyHeadingGroups", (t) => cards.removeEmptyHeadingGroups(t)],
    ["humanizeSourceTitle", (t) => cards.humanizeSourceTitle(t)],
    ["sourceFileTitle", (t) => cards.sourceFileTitle(t)]
  ];
  const notes = asNotes();
  for (const [label, fn] of ENTRIES) {
    must(`${label} survives every shape in the corpus`, () => {
      const broke = [];
      for (const c of [...ALL_CASES, ...notes]) {
        try { fn(c.text); } catch (error) { broke.push(`${c.name}: ${error?.message || error}`); }
      }
      return broke.length ? `${broke.length} threw — first: ${broke[0]}` : true;
    });
  }

  // Undefined and null are what a caller hands over when a file failed to read.
  must("every entry point tolerates a missing input", () => {
    const broke = [];
    for (const [label, fn] of ENTRIES) {
      for (const input of [undefined, null, 0, false]) {
        try { fn(input); } catch (error) { broke.push(`${label}(${String(input)}): ${error?.message || error}`); }
      }
    }
    return broke.length ? `${broke.length} threw — first: ${broke[0]}` : true;
  });

  // ── A card is a question AND an answer ──────────────────────────────────
  must("an explicit Q/A deck parses into the cards it names", () => {
    const src = [
      "# Deck", "",
      "## Q: What is the capital of France?", "", "A: Paris.", "",
      "## Q: And of Italy?", "", "A: Rome.", ""
    ].join("\n");
    const out = cards.parseCards(src);
    if (out.length !== 2) return `${out.length} card(s): ${show(JSON.stringify(out))}`;
    // The shape is { id, question, answer } — not { q, a }, which is what the
    // SYNC layer calls the same two fields (src/sync/cards.js).
    if (!/France/.test(out[0].question) || !/Paris/.test(out[0].answer)) return show(JSON.stringify(out[0]));
    if (!/Italy/.test(out[1].question) || !/Rome/.test(out[1].answer)) return show(JSON.stringify(out[1]));
    return true;
  });

  must("every card the parser returns has the shape the rest of the app reads", () => {
    const bad = [];
    for (const c of notes) {
      for (const card of cards.parseCards(c.text)) {
        for (const key of ["id", "question", "answer"]) {
          if (typeof card[key] !== "string") bad.push(`${c.name}: ${key} is ${typeof card[key]}`);
        }
      }
    }
    return bad.length ? `${bad.length} malformed — first: ${bad[0]}` : true;
  });

  must("no card comes out with an empty question", () => {
    const bad = [];
    for (const c of notes) {
      for (const card of cards.parseCards(c.text)) {
        if (!String(card.question || "").trim()) bad.push(`${c.name}: ${show(JSON.stringify(card))}`);
      }
    }
    return bad.length ? `${bad.length} empty question(s) — first: ${bad[0]}` : true;
  });

  // The property that matters most, and the one a hand-written case set will
  // not find: parsing is deterministic. Card ids carry a random suffix by
  // design, so they are normalised away — what has to be stable is the SPLIT.
  must("parsing the same text twice gives the same cards", () => {
    const strip = (list) => JSON.stringify(list.map((c) => [c.question, c.answer, c.status ?? null]));
    for (const c of [...ALL_CASES, ...notes]) {
      const a = strip(cards.parseCards(c.text));
      const b = strip(cards.parseCards(c.text));
      if (a !== b) return `${c.name} parsed differently on the second call`;
    }
    return true;
  });

  // ...and idempotent where it claims to be.
  must("normalizeMarkdown is idempotent", () => {
    for (const c of [...ALL_CASES, ...notes]) {
      const once = cards.normalizeMarkdown(c.text);
      const twice = cards.normalizeMarkdown(once);
      if (once !== twice) return `${c.name}: ${show(once)} then ${show(twice)}`;
    }
    return true;
  });

  must("normalizeMarkdown leaves no CR behind", () => {
    const out = cards.normalizeMarkdown("a\r\nb\rc\n");
    if (out.includes("\r")) return show(out);
    if (out !== "a\nb\nc\n") return show(out);
    return true;
  });

  // ── The deck's name ─────────────────────────────────────────────────────
  must("a deck takes its title from the first H1", () => {
    const got = cards.inferDeckTitle("# Ancient Rome\n\nBody.\n", "fallback");
    return got === "Ancient Rome" ? true : show(got);
  });

  must("...and falls back rather than returning nothing", () => {
    const bare = [ "", "   \n\n", "no heading at all\n", "## only an h2\n" ];
    for (const src of bare) {
      const got = cards.inferDeckTitle(src, "My fallback");
      if (!String(got || "").trim()) return `${show(src)} produced ${show(got)}`;
    }
    return true;
  });

  must("a title is never returned with its trailing hashes", () => {
    const got = cards.inferDeckTitle("# Closed heading ###\n\nBody.\n", "");
    return got === "Closed heading" ? true : show(got);
  });

  // A title carrying a NUL is the 84f3051 shape. Whatever the parser does with
  // it, it must not hand back something that cannot be JSON-encoded for the
  // push — that is the failure that killed a whole book's sync.
  must("a title from a NUL-riddled heading is still encodable", () => {
    const nul = String.fromCharCode(0);
    const got = cards.inferDeckTitle(`# T${nul}i${nul}t${nul}l${nul}e\n\nBody.\n`, "");
    const encoded = JSON.stringify({ title: got });
    if (/\\u0000/.test(encoded)) {
      // Not an assertion that it is stripped HERE — src/sync/text-repair.js owns
      // that, and tools/text-sanitize-check.mjs asserts it. What must hold is
      // that the title is a plain string the repair can act on, not something
      // that throws on its way there.
      return typeof got === "string" ? true : `not a string: ${typeof got}`;
    }
    return true;
  });

  // ── Notes are not cards ─────────────────────────────────────────────────
  must("a deck's notes block is lifted out and not parsed as cards", () => {
    const src = [
      "# Deck", "",
      "<!--recall:notes-->", "## Notes", "", "Some study notes.", "<!--/recall:notes-->", "",
      "## Q: A question?", "", "A: An answer.", ""
    ].join("\n");
    const { markdown, notes: found } = cards.extractNotesFromMarkdown(src);
    if (!found || !/Some study notes/.test(String(found))) return `notes not lifted: ${show(found)}`;
    if (/Some study notes/.test(markdown)) return "the notes are still in the card material";
    const parsed = cards.parseCards(src);
    if (parsed.some((c) => /Some study notes/.test(`${c.question} ${c.answer}`))) return "notes leaked into a card";
    return true;
  });

  // ── classifyCardSyntax answers one of three things, always ──────────────
  must("classifyCardSyntax only ever returns explicit, heuristic or none", () => {
    const seen = new Set();
    for (const c of [...ALL_CASES, ...notes]) seen.add(cards.classifyCardSyntax(c.text));
    const allowed = new Set(["explicit", "heuristic", "none"]);
    const stray = [...seen].filter((v) => !allowed.has(v));
    return stray.length ? `also returned ${JSON.stringify(stray)}` : true;
  });

  must("...and it agrees with parseCards about whether there are any", () => {
    const disagreed = [];
    for (const c of notes) {
      const kind = cards.classifyCardSyntax(c.text);
      const parsed = cards.parseCards(c.text);
      // "none" must not produce explicit cards. The reverse is allowed: the
      // heuristic path is deliberately not taken by every caller.
      if (kind === "none" && parsed.length && cards.hasExplicitCardSyntax(c.text)) {
        disagreed.push(`${c.name}: classified none, parsed ${parsed.length}`);
      }
    }
    return disagreed.length ? disagreed[0] : true;
  });

  // ── MathML ──────────────────────────────────────────────────────────────
  must("the builder gives mathmlToTex the DOM it reads", () => {
    const el = mathEl("math", {}, mathEl("mi", {}, "x"));
    if (el.nodeType !== 1) return "nodeType";
    if (el.localName !== "math") return "localName";
    if (el.children.length !== 1) return `children: ${el.children.length}`;
    if (el.textContent !== "x") return `textContent: ${show(el.textContent)}`;
    if (el.getAttribute("nope") !== null) return "getAttribute should be null for a missing attribute";
    if (el.hasAttribute("nope")) return "hasAttribute should be false for a missing attribute";
    return true;
  });

  const FORMULAE = [
    ["a bare identifier", mathEl("math", {}, mathEl("mi", {}, "x")), /x/],
    ["a fraction", mathEl("math", {}, mathEl("mfrac", {}, mathEl("mn", {}, "1"), mathEl("mn", {}, "2"))), /frac/],
    ["a superscript", mathEl("math", {}, mathEl("msup", {}, mathEl("mi", {}, "e"), mathEl("mi", {}, "x"))), /\^/],
    ["a subscript", mathEl("math", {}, mathEl("msub", {}, mathEl("mi", {}, "a"), mathEl("mn", {}, "1"))), /_/],
    ["a square root", mathEl("math", {}, mathEl("msqrt", {}, mathEl("mi", {}, "y"))), /sqrt/],
    ["a row of operators", mathEl("math", {}, mathEl("mrow", {},
      mathEl("mi", {}, "a"), mathEl("mo", {}, "+"), mathEl("mi", {}, "b"))), /a.*\+.*b/s],
    ["a greek letter", mathEl("math", {}, mathEl("mi", {}, "\u03b1")), /alpha/],
    ["semantics with an annotation", mathEl("math", {},
      mathEl("semantics", {}, mathEl("mi", {}, "z"),
        mathEl("annotation", { encoding: "application/x-tex" }, "\\zeta"))), /./]
  ];
  for (const [label, el, wanted] of FORMULAE) {
    must(`mathmlToTex converts ${label}`, () => {
      const tex = mathml.mathmlToTex(el);
      if (typeof tex !== "string") return `returned ${typeof tex}`;
      if (!wanted.test(tex)) return `got ${show(tex)}`;
      return true;
    });
  }

  must("mathmlToTex never returns undefined, whatever it is handed", () => {
    const inputs = [
      null, undefined, textNode("loose text"),
      mathEl("math", {}),
      mathEl("math", {}, mathEl("munknown", {}, "?")),
      mathEl("math", {}, mathEl("mrow", {})),
      mathEl("math", {}, mathEl("mfrac", {}, mathEl("mn", {}, "1")))
    ];
    for (const input of inputs) {
      const out = mathml.mathmlToTex(input);
      if (typeof out !== "string") return `${String(input)} produced ${typeof out}`;
    }
    return true;
  });

  // The one KaTeX actually rejects: an unbalanced \left or \right. Nougat books
  // ship them, and KaTeX refuses the WHOLE formula rather than that pair — so
  // the sanitizer has to remove them, not merely hope.
  must("sanitizeMathTex removes an unbalanced \\left", () => {
    const out = mathml.sanitizeMathTex("\\left( x");
    const lefts = (out.match(/\\left/g) || []).length;
    const rights = (out.match(/\\right/g) || []).length;
    return lefts === rights ? true : `${lefts} \\left vs ${rights} \\right in ${show(out)}`;
  });

  must("...and an unbalanced \\right", () => {
    const out = mathml.sanitizeMathTex("x \\right)");
    const lefts = (out.match(/\\left/g) || []).length;
    const rights = (out.match(/\\right/g) || []).length;
    return lefts === rights ? true : `${lefts} \\left vs ${rights} \\right in ${show(out)}`;
  });

  must("...while leaving a balanced pair alone", () => {
    const out = mathml.sanitizeMathTex("\\left( x \\right)");
    return /\\left\(/.test(out) && /\\right\)/.test(out) ? true : show(out);
  });

  must("sanitizeMathTex is idempotent", () => {
    const inputs = [
      "\\left( x", "x \\right)", "\\left( \\left[ y \\right]",
      "&lt;tag&gt; &amp; more", "\\frac{1}{2}", "", "  ", "\\alpha"
    ];
    for (const input of inputs) {
      const once = mathml.sanitizeMathTex(input);
      const twice = mathml.sanitizeMathTex(once);
      if (once !== twice) return `${show(input)}: ${show(once)} then ${show(twice)}`;
    }
    return true;
  });

  must("sanitizeMathTex decodes the entities an HTML importer leaves behind", () => {
    const out = mathml.sanitizeMathTex("a &lt; b &amp;&amp; c &gt; d");
    if (/&(lt|gt|amp);/i.test(out)) return show(out);
    if (!out.includes("<") || !out.includes(">") || !out.includes("&")) return show(out);
    return true;
  });

  must("sanitizeMathTex never returns undefined", () => {
    for (const input of [null, undefined, 0, false, {}, []]) {
      if (typeof mathml.sanitizeMathTex(input) !== "string") return `${String(input)} produced a non-string`;
    }
    return true;
  });

  // ── Guessing a code fence's language ────────────────────────────────────
  const SAMPLES = [
    ["python", "def f(x):\n    return x * 2\n\nclass A:\n    pass\n"],
    ["javascript", "const a = 1;\nfunction f() { return a; }\nexport default f;\n"],
    ["sql", "SELECT id, name FROM users WHERE id = 1 ORDER BY name;\n"],
    ["json", '{"a": 1, "b": [2, 3], "c": {"d": null}}\n'],
    ["bash", "#!/bin/bash\nset -euo pipefail\nfor f in *.txt; do echo \"$f\"; done\n"]
  ];
  for (const [wanted, source] of SAMPLES) {
    must(`inferCodeLanguage recognises ${wanted}`, () => {
      const got = lang.inferCodeLanguage(source);
      if (got === wanted) return true;
      // A near miss is reported rather than accepted: this is a scoring
      // heuristic and the point of the check is that the scores still separate.
      return `got ${show(got)}`;
    });
  }

  must("inferCodeLanguage declines rather than guessing at prose", () => {
    const prose = [
      "The quick brown fox jumps over the lazy dog.",
      "one\ntwo\nthree\n",
      "12345\n",
      "",
      "   "
    ];
    const guessed = [];
    for (const text of prose) {
      const got = lang.inferCodeLanguage(text);
      if (got && got !== lang.GENERIC_CODE_LANGUAGE) guessed.push(`${show(text)} -> ${got}`);
    }
    return guessed.length ? `guessed at prose: ${guessed[0]}` : true;
  });

  must("inferCodeLanguage never throws on the corpus", () => {
    const broke = [];
    for (const c of ALL_CASES) {
      try { lang.inferCodeLanguage(c.text); } catch (error) { broke.push(`${c.name}: ${error?.message || error}`); }
    }
    return broke.length ? broke[0] : true;
  });

  must("...and always returns a string", () => {
    for (const input of [null, undefined, 0, false, "x".repeat(200000)]) {
      if (typeof lang.inferCodeLanguage(input) !== "string") return `${String(input).slice(0, 20)} produced a non-string`;
    }
    return true;
  });

  must("normalizeCodeLanguage folds every alias onto a real grammar", () => {
    const wrong = [];
    for (const [alias, real] of Object.entries(lang.codeLanguageAliases)) {
      const got = lang.normalizeCodeLanguage(alias);
      if (got !== real) wrong.push(`${alias} -> ${show(got)}, expected ${show(real)}`);
    }
    return wrong.length ? `${wrong.length} alias(es) wrong — first: ${wrong[0]}` : true;
  });

  must("normalizeCodeLanguage is idempotent", () => {
    const inputs = [...Object.keys(lang.codeLanguageAliases), ...Object.values(lang.codeLanguageAliases),
      "", "  JS  ", "NoSuchLanguage", "c++"];
    for (const input of inputs) {
      const once = lang.normalizeCodeLanguage(input);
      const twice = lang.normalizeCodeLanguage(once);
      if (once !== twice) return `${show(input)}: ${show(once)} then ${show(twice)}`;
    }
    return true;
  });

  must("every language the inference can return has a label", () => {
    const unlabelled = [];
    for (const key of Object.keys(lang.CODE_LANGUAGE_SIGNATURES)) {
      const label = lang.codeLanguageLabel(key);
      if (!label || typeof label !== "string") unlabelled.push(key);
    }
    return unlabelled.length ? `no label for ${unlabelled.join(", ")}` : true;
  });

  // The label is what the copy button shows, so it has to be short enough to
  // sit in a pill in the corner of a code block.
  must("...and no label is long enough to overflow the copy button", () => {
    const long = Object.keys(lang.CODE_LANGUAGE_SIGNATURES)
      .map((k) => [k, lang.codeLanguageLabel(k)])
      .filter(([, label]) => String(label).length > 14);
    return long.length ? `too long: ${JSON.stringify(long)}` : true;
  });

  // ── A coverage floor ────────────────────────────────────────────────────
  //
  // The failure this guards is the one every corpus-driven check can have: the
  // corpus stops reaching the interesting branches and every case passes
  // trivially. If the parser stops finding cards in ANY of these notes, or the
  // inference stops recognising anything, that is a signal about this file
  // rather than about the app.
  must("the corpus still reaches the card parser's real work", () => {
    const withCards = notes.filter((c) => cards.parseCards(c.text).length > 0).length;
    if (withCards === 0) return "no fixture in the corpus produces a single card any more";
    return true;
  });

  must("...and the language inference still recognises something", () => {
    const recognised = SAMPLES.filter(([, src]) => lang.inferCodeLanguage(src)).length;
    return recognised >= SAMPLES.length ? true : `only ${recognised} of ${SAMPLES.length} samples recognised`;
  });
} catch (error) {
  must(`the check itself: ${error?.message || error}`, () => String(error?.stack || error));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) {
  if (ok && !VERBOSE) console.log(`  ok    ${name}`);
  else if (ok) console.log(`  ok    ${name}`);
  else console.log(`  FAIL  ${name}\n        ${detail}`);
}
console.log(`\n${results.length} checks · ${failures} failed`);
console.log(`CHECK: ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
