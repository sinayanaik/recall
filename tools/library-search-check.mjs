// Does the library's search box find files the way a person looks for them?
//
//   node tools/library-search-check.mjs
//
// src/library/library-search.js decides what the "Search files and folders…"
// box matches and in what order. It replaced `title.includes(term)`, which
// found nothing for one typo, words in another order, an accent, or a file
// remembered by its folder — and whose matches were then drawn as the folders
// they sat in, so a search for a file showed a folder. The drawing half is
// renderMyDecksSearchResults (a browser concern; tools/ui-smoke.mjs drives it);
// this is the matching half, which is pure and so runs in Node.
//
// Same staging trick as tools/library-check.mjs: copy src/, strip the
// ?v=__BUILD__ stamps, import from the copy.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CASES, TITLE_CASES } from "./adversarial-corpus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-library-search-"));

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

const show = (v) => JSON.stringify(String(v).slice(0, 120));

// A small library with the shapes that matter: files two folders deep, two
// files that share a word, an accented title, a camel-cased one, and a file at
// the top level (no folder).
const LIBRARY = [
  { title: "Chain Rule", category: "Math/Calculus" },
  { title: "Product Rule", category: "Math/Calculus" },
  { title: "Limits", category: "Math/Calculus/Foundations" },
  { title: "Eigenvalues", category: "Math/Linear Algebra" },
  { title: "Rule of chains", category: "Misc" },
  { title: "Résumé tips", category: "" },
  { title: "PageRank", category: "Reading/Papers" },
  { title: "Attention Is All You Need", category: "Reading/Papers" },
  { title: "The best sort of things", category: "Uncategorized" },
  { title: "Calculator manual", category: "Misc" }
];

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const search = await import(path.join(stage, "src/library/library-search.js"));
  const { scoreLibraryDeck, scoreLibraryFolder, parseLibraryQuery, foldForSearch, editDistance, libraryDeckMatches } = search;

  // Titles of the matches for `query`, best first.
  const find = (query) => LIBRARY
    .map((deck) => ({ deck, hit: scoreLibraryDeck(deck, query) }))
    .filter((row) => row.hit)
    .sort((a, b) => b.hit.score - a.hit.score)
    .map((row) => row.deck.title);
  const top = (query) => find(query)[0];
  const highlighted = (title, query) => {
    const hit = scoreLibraryDeck({ title, category: "" }, query);
    return hit ? hit.ranges.map(([s, e]) => title.slice(s, e)).join("|") : null;
  };

  // ── The floor ───────────────────────────────────────────────────────────
  must("nothing throws, whatever the title, folder or query is", () => {
    const strings = [...TITLE_CASES.map((c) => c.text), ...ALL_CASES.map((c) => c.text), "", " ", "/", undefined, null, 0, {}, []];
    const broke = [];
    for (const value of strings) {
      for (const [label, fn] of [
        ["title", () => scoreLibraryDeck({ title: value, category: "Math" }, "rule")],
        ["folder", () => scoreLibraryDeck({ title: "Chain Rule", category: value }, "math")],
        ["query", () => scoreLibraryDeck({ title: "Chain Rule", category: "Math" }, value)],
        ["folder path", () => scoreLibraryFolder(value, "math")],
        ["folder query", () => scoreLibraryFolder("Math/Calculus", value)],
        ["no deck", () => scoreLibraryDeck(value, "rule")]
      ]) {
        try { fn(); } catch (error) { broke.push(`${label} ${show(value)}: ${error?.message || error}`); }
      }
    }
    return broke.length ? `${broke.length} threw — first: ${broke[0]}` : true;
  });

  must("highlight ranges always lie inside the title and never overlap", () => {
    const queries = ["a", "e", "rule", "chnrl", "x y", "é", "  ", "🙂", "<b>", "the"];
    for (const c of [...TITLE_CASES, ...ALL_CASES]) {
      const title = String(c.text ?? "");
      for (const q of queries) {
        const hit = scoreLibraryDeck({ title, category: "" }, q);
        if (!hit) continue;
        let last = 0;
        for (const [s, e] of hit.ranges) {
          if (!(s >= last && e > s && e <= title.length)) return `${show(title)} / ${show(q)} → ${JSON.stringify(hit.ranges)}`;
          last = e;
        }
      }
    }
    return true;
  });

  must("folding keeps one character per character, so offsets line up", () => {
    for (const text of ["Résumé", "ÀÉÎÕÜ", "straße", "İstanbul", "ﬁle", "👍🏽 ok", "Ǆ", ...TITLE_CASES.map((c) => String(c.text ?? ""))]) {
      if (foldForSearch(text).length !== text.length) return `${show(text)} folded to ${show(foldForSearch(text))}`;
    }
    return foldForSearch("Résumé") === "resume" ? true : `Résumé folded to ${show(foldForSearch("Résumé"))}`;
  });

  must("an empty query matches every file", () => {
    for (const q of ["", "   ", "\t"]) {
      if (find(q).length !== LIBRARY.length) return `${show(q)} matched ${find(q).length}`;
    }
    return true;
  });

  // ── What it finds ───────────────────────────────────────────────────────
  must("a plain title fragment finds the file", () => top("eigen") === "Eigenvalues" || `got ${top("eigen")}`);
  must("case never matters", () => top("CHAIN RULE") === "Chain Rule" || `got ${top("CHAIN RULE")}`);
  must("accents never matter, either way round", () => {
    if (top("resume") !== "Résumé tips") return `"resume" → ${top("resume")}`;
    if (!scoreLibraryDeck({ title: "Resume tips", category: "" }, "résumé")) return `"résumé" missed "Resume tips"`;
    return true;
  });
  must("words in any order", () => {
    const got = find("rule chain");
    return (got.includes("Chain Rule") && got.includes("Rule of chains")) || `got ${JSON.stringify(got)}`;
  });
  must("every word has to be found (AND, not OR)", () => {
    const got = find("chain product");
    return got.length === 0 || `got ${JSON.stringify(got)}`;
  });
  must("a folder name finds every file inside it, however deep", () => {
    const got = find("calculus");
    for (const t of ["Chain Rule", "Product Rule", "Limits"]) if (!got.includes(t)) return `missing ${t}: ${JSON.stringify(got)}`;
    return got.includes("Eigenvalues") ? `Eigenvalues is not in Calculus: ${JSON.stringify(got)}` : true;
  });
  must("one word from the folder, one from the title", () => {
    const got = find("calculus product");
    return (got.length === 1 && got[0] === "Product Rule") || `got ${JSON.stringify(got)}`;
  });
  must("a typo still finds it", () => {
    if (top("eignvalues") !== "Eigenvalues") return `"eignvalues" → ${top("eignvalues")}`;
    if (top("atention") !== "Attention Is All You Need") return `"atention" → ${top("atention")}`;
    if (top("pagerakn") !== "PageRank") return `"pagerakn" (swapped letters) → ${top("pagerakn")}`;
    return true;
  });
  must("a different word is not a typo", () => {
    const got = find("calculus");
    return !got.includes("Calculator manual") || `"calculus" matched "Calculator manual"`;
  });
  must("a typo in a folder name still finds its files", () => {
    const got = find("calculsu");
    return (got.includes("Chain Rule") && got.includes("Limits")) || `got ${JSON.stringify(got)}`;
  });
  must("letters left out still find it", () => top("chnrl") === "Chain Rule" || `got ${top("chnrl")}`);
  must("a capital inside a word counts as the start of one", () => {
    const hit = scoreLibraryDeck({ title: "PageRank", category: "" }, "rank");
    const mid = scoreLibraryDeck({ title: "Frankly", category: "" }, "rank");
    return (hit && mid && hit.score > mid.score) || `PageRank ${hit?.score} vs Frankly ${mid?.score}`;
  });

  // ── What it does NOT find ──────────────────────────────────────────────
  must("a short word is never matched loosely", () => {
    const got = find("ab");
    return got.length === 0 || `"ab" matched ${JSON.stringify(got)}`;
  });
  must("scattered letters are not an abbreviation", () => {
    const got = find("test");
    return got.length === 0 || `"test" matched ${JSON.stringify(got)}`;
  });
  must("a typo in the first letter is not forgiven", () => {
    const got = find("best");
    const loose = find("vest");
    return (got.includes("The best sort of things") && loose.length === 0) || `"best" ${JSON.stringify(got)}, "vest" ${JSON.stringify(loose)}`;
  });
  must("a file with no folder does not match the word \"uncategorized\"", () => {
    const got = find("uncategorized");
    return got.length === 0 || `got ${JSON.stringify(got)}`;
  });

  // ── Ranking ─────────────────────────────────────────────────────────────
  must("the exact phrase beats the same words in another order", () => {
    const got = find("chain rule");
    return got[0] === "Chain Rule" || `got ${JSON.stringify(got)}`;
  });
  must("a title hit beats a folder hit", () => {
    // "calc": the title "Calculator manual" over files that are only filed in Calculus.
    const got = find("calc");
    return got[0] === "Calculator manual" || `got ${JSON.stringify(got)}`;
  });
  must("a folder hit beats a typo or an abbreviation", () => {
    const folder = scoreLibraryDeck({ title: "Notes", category: "Physics" }, "physics");
    const typo = scoreLibraryDeck({ title: "Physcis", category: "" }, "physics");
    return (folder && typo && folder.score > typo.score) || `folder ${folder?.score} vs typo ${typo?.score}`;
  });
  must("a prefix beats a word start beats the middle of a word", () => {
    const prefix = scoreLibraryDeck({ title: "Rules", category: "" }, "rule");
    const word = scoreLibraryDeck({ title: "The rules", category: "" }, "rule");
    const middle = scoreLibraryDeck({ title: "Prerules", category: "" }, "rule");
    return (prefix.score > word.score && word.score > middle.score) || `${prefix.score} / ${word.score} / ${middle.score}`;
  });

  // ── Highlighting ────────────────────────────────────────────────────────
  must("the matched letters are what gets highlighted", () => {
    const cases = [
      ["Chain Rule", "rule", "Rule"],
      ["Chain Rule", "chain rule", "Chain Rule"],
      ["Résumé tips", "resume", "Résumé"],
      ["Prerule Rule", "rule", "Rule"],
      ["Eigenvalues", "eignvalues", "Eigenvalues"],
      ["Chain Rule", "chnrl", "Ch|n|R|l"]
    ];
    for (const [title, q, want] of cases) {
      const got = highlighted(title, q);
      if (got !== want) return `${show(title)} / ${show(q)} highlighted ${show(got)}, wanted ${show(want)}`;
    }
    // Prerule Rule: the word-start "Rule" at 8, not the "rule" inside "Prerule".
    const hit = scoreLibraryDeck({ title: "Prerule Rule", category: "" }, "rule");
    return hit.ranges[0][0] === 8 || `Prerule Rule highlighted at ${hit.ranges[0][0]}`;
  });
  must("a match only in the folder highlights nothing in the title", () => {
    const hit = scoreLibraryDeck({ title: "Chain Rule", category: "Math/Calculus" }, "calculus");
    return (hit && hit.ranges.length === 0) || JSON.stringify(hit);
  });

  // ── Folders ─────────────────────────────────────────────────────────────
  must("a folder matches on its own name, not only its parent's", () => {
    if (!scoreLibraryFolder("Math", "math")) return "Math missed";
    if (scoreLibraryFolder("Math/Calculus", "math")) return "Math/Calculus matched \"math\", a word only in its parent";
    if (!scoreLibraryFolder("Math/Calculus", "calc")) return "Math/Calculus missed \"calc\"";
    if (!scoreLibraryFolder("Math/Calculus", "math calc")) return "Math/Calculus missed \"math calc\"";
    if (scoreLibraryFolder("Uncategorized", "uncat")) return "the no-folder bucket matched as a folder";
    return true;
  });
  must("if a folder matches, every file inside it matches too", () => {
    // The promise the selection code keeps: ticking a folder in the results
    // selects the matching files under it, so a folder that matched while its
    // files did not would select nothing, or (worse) less than it shows.
    const folders = ["Math", "Math/Calculus", "Math/Calculus/Foundations", "Math/Linear Algebra", "Reading/Papers", "Misc"];
    for (const query of ["math", "calc", "calculus", "math calc", "linear", "alg", "papers", "reading pap", "found", "misc", "a"]) {
      for (const folder of folders) {
        if (!scoreLibraryFolder(folder, query)) continue;
        for (const deck of LIBRARY.filter((d) => d.category === folder || String(d.category).startsWith(`${folder}/`))) {
          if (!scoreLibraryDeck(deck, query)) return `"${query}" matched folder ${folder} but not ${show(deck.title)} inside it`;
        }
      }
    }
    return true;
  });

  // ── Odds and ends ───────────────────────────────────────────────────────
  must("the query is split into distinct words", () => {
    const q = parseLibraryQuery("  Rule   rule  Chain ");
    return (q.phrase === "rule rule chain" && JSON.stringify(q.tokens) === '["rule","chain"]') || JSON.stringify(q);
  });
  must("edit distance counts a swap of two neighbours as one", () => {
    const cases = [["abcd", "abdc", 1], ["kitten", "sitten", 1], ["abc", "abc", 0], ["abc", "xyz", 3]];
    for (const [a, b, want] of cases) {
      const got = editDistance(a, b, 3);
      if (got !== want) return `${a}→${b} = ${got}, wanted ${want}`;
    }
    return true;
  });
  must("the shared matcher follows the term it is given", () => {
    const deck = { title: "Chain Rule", category: "Math" };
    if (!libraryDeckMatches(deck, "chain")) return "chain missed";
    if (libraryDeckMatches(deck, "zebra")) return "zebra matched (stale memo?)";
    if (!libraryDeckMatches(deck, "chain")) return "chain missed the second time";
    return true;
  });
} catch (error) {
  must(`the check itself: ${error?.message || error}`, () => String(error?.stack || error));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

for (const [ok, name, detail] of results) {
  console.log(ok ? `  ok    ${name}` : `  FAIL  ${name}\n        ${detail}`);
}
console.log(`\n${results.length} checks · ${failures} failed`);
console.log(`CHECK: ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
