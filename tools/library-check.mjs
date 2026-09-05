// A folder is a string. Does the arithmetic on it hold?
//
//   node tools/library-check.mjs
//
// src/library/folders.js is the whole of the folder model: a deck's folder IS
// its category, a "/"-delimited path, and every folder operation the library
// offers — create, rename, move, nest, sort, "is this deck inside that folder"
// — is a string operation in this one leaf module.
//
// It had no check. `backup-check` imports it to restore a deck three folders
// deep, which exercises it incidentally; `sync-parity` and `ui-smoke` touched
// the library above it and both skipped themselves for months. Nothing had ever
// asked whether renaming a folder to something nested inside itself does
// something sane, or what a segment made entirely of spaces becomes.
//
// Two data-loss bugs have already landed in this area — 8e1a552 (bulk Load
// setting state.notes to "" and minting a synced "Combined:" deck) and 9e0291b
// (joining annotated decks made all but one deck's notes unfindable) — and
// tools/merged-notes-check.mjs was written after them, for the document side.
// This is the path side.
//
// Pure Node: folders.js imports only core/constants.js, core/state.js and a
// preferences setter, so it needs no browser, no network and no baseline tag.
// The half that writes to localStorage (the empty-folder registry) is named at
// the end rather than left as a silence.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CASES, TITLE_CASES } from "./adversarial-corpus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-library-"));

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

// Paths chosen for the ways a "/"-delimited string can be strange, on top of
// the shared corpus. Each one is something a person can actually type into the
// folder field.
const PATHS = [
  "", "   ", "/", "//", "///",
  "Math", " Math ", "Math/", "/Math", "/Math/",
  "Math//Calculus", "Math/ /Calculus", "Math/\t/Calculus",
  "Math/Calculus/Derivatives",
  "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p",
  "Math/Calculus", "math/calculus",
  "Folder with spaces/And another",
  "Folder  with  doubled  spaces",
  "Über/Notizen",
  "  /  /  ",
  "one/two/", "one//two", "one/ /two"
];

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const load = (rel) => import(path.join(stage, rel));

  const folders = await load("src/library/folders.js");
  const constants = await load("src/core/constants.js");
  const DEFAULT = constants.defaultDeckCategory;

  const all = [...PATHS, ...TITLE_CASES.map((c) => c.text), ...ALL_CASES.map((c) => c.text)];

  // ── The floor ───────────────────────────────────────────────────────────
  must("nothing in this module throws, whatever it is handed", () => {
    const broke = [];
    const entries = [
      ["folderSegments", (v) => folders.folderSegments(v)],
      ["normalizeDeckCategory", (v) => folders.normalizeDeckCategory(v)],
      ["categorySortValue", (v) => folders.categorySortValue(v)],
      ["isCategoryUnder", (v) => folders.isCategoryUnder(v, "Math")],
      ["isCategoryUnder, as the ancestor", (v) => folders.isCategoryUnder("Math/Calculus", v)],
      ["rewriteCategoryPrefix", (v) => folders.rewriteCategoryPrefix(v, "Math", "Science")]
    ];
    for (const [label, fn] of entries) {
      for (const value of [...all, undefined, null, 0, false, {}, []]) {
        try { fn(value); } catch (error) { broke.push(`${label}(${show(value)}): ${error?.message || error}`); }
      }
    }
    return broke.length ? `${broke.length} threw — first: ${broke[0]}` : true;
  });

  must("normalizeDeckCategory always returns a non-empty string", () => {
    for (const value of [...all, undefined, null, 0, false]) {
      const got = folders.normalizeDeckCategory(value);
      if (typeof got !== "string" || !got) return `${show(value)} produced ${show(got)}`;
    }
    return true;
  });

  // ── The path algebra ────────────────────────────────────────────────────
  must("a path with nothing in it is the default folder", () => {
    for (const empty of ["", "   ", "/", "//", "///", "  /  /  ", "\t", null, undefined]) {
      const got = folders.normalizeDeckCategory(empty);
      if (got !== DEFAULT) return `${show(empty)} became ${show(got)}, not ${show(DEFAULT)}`;
    }
    return true;
  });

  must("a leading, trailing or doubled separator is not a folder", () => {
    const same = folders.normalizeDeckCategory("Math/Calculus");
    for (const variant of ["/Math/Calculus", "Math/Calculus/", "/Math/Calculus/", "Math//Calculus", "Math/ /Calculus"]) {
      const got = folders.normalizeDeckCategory(variant);
      if (got !== same) return `${show(variant)} became ${show(got)}, not ${show(same)}`;
    }
    return true;
  });

  must("normalizeDeckCategory is idempotent", () => {
    for (const value of all) {
      const once = folders.normalizeDeckCategory(value);
      const twice = folders.normalizeDeckCategory(once);
      if (once !== twice) return `${show(value)}: ${show(once)} then ${show(twice)}`;
    }
    return true;
  });

  must("folderSegments and normalizeDeckCategory agree", () => {
    for (const value of all) {
      const segments = folders.folderSegments(value);
      const normalized = folders.normalizeDeckCategory(value);
      const rejoined = segments.length ? segments.join(folders.FOLDER_SEP) : DEFAULT;
      if (rejoined !== normalized) return `${show(value)}: segments give ${show(rejoined)}, normalize gives ${show(normalized)}`;
    }
    return true;
  });

  must("no segment is empty or carries its own separator", () => {
    for (const value of all) {
      for (const segment of folders.folderSegments(value)) {
        if (!segment.trim()) return `${show(value)} produced an empty segment`;
        if (segment.includes(folders.FOLDER_SEP)) return `${show(value)} produced ${show(segment)}, which contains a separator`;
      }
    }
    return true;
  });

  // ── "is this deck inside that folder" ───────────────────────────────────
  must("a folder contains itself", () => {
    for (const value of all) {
      const normalized = folders.normalizeDeckCategory(value);
      if (!folders.isCategoryUnder(normalized, normalized)) return `${show(normalized)} is not under itself`;
    }
    return true;
  });

  must("a child is under its parent, and a parent is not under its child", () => {
    const pairs = [
      ["Math/Calculus", "Math"],
      ["Math/Calculus/Derivatives", "Math"],
      ["Math/Calculus/Derivatives", "Math/Calculus"],
      ["Über/Notizen", "Über"]
    ];
    for (const [child, parent] of pairs) {
      if (!folders.isCategoryUnder(child, parent)) return `${show(child)} is not under ${show(parent)}`;
      if (folders.isCategoryUnder(parent, child)) return `${show(parent)} is wrongly under ${show(child)}`;
    }
    return true;
  });

  // The one a prefix test gets wrong, and the reason this is a case of its own:
  // "Mathematics" starts with "Math", but it is not inside it.
  must("a folder whose NAME merely starts with another is not inside it", () => {
    const pairs = [
      ["Mathematics", "Math"],
      ["Math2", "Math"],
      ["Mathematics/Calculus", "Math"],
      ["Notes-old", "Notes"]
    ];
    for (const [outsider, folder] of pairs) {
      if (folders.isCategoryUnder(outsider, folder)) return `${show(outsider)} was reported as inside ${show(folder)}`;
    }
    return true;
  });

  must("containment does not care how the path was spelled", () => {
    const spellings = ["Math/Calculus", "/Math/Calculus", "Math//Calculus", " Math / Calculus ", "Math/Calculus/"];
    for (const spelling of spellings) {
      if (!folders.isCategoryUnder(spelling, "Math")) return `${show(spelling)} was not under Math`;
      if (!folders.isCategoryUnder(spelling, " /Math/ ")) return `${show(spelling)} was not under a scruffily-spelled Math`;
    }
    return true;
  });

  // ── Renaming and moving a folder ────────────────────────────────────────
  must("renaming a folder moves everything nested under it", () => {
    const before = ["Math", "Math/Calculus", "Math/Calculus/Derivatives", "Mathematics", "Other"];
    const after = before.map((c) => folders.rewriteCategoryPrefix(c, "Math", "Science"));
    const wanted = ["Science", "Science/Calculus", "Science/Calculus/Derivatives", "Mathematics", "Other"];
    for (let i = 0; i < before.length; i += 1) {
      if (after[i] !== wanted[i]) return `${show(before[i])} became ${show(after[i])}, expected ${show(wanted[i])}`;
    }
    return true;
  });

  must("...and leaves a folder that merely shares a prefix alone", () => {
    const got = folders.rewriteCategoryPrefix("Mathematics/Analysis", "Math", "Science");
    return got === "Mathematics/Analysis" ? true : show(got);
  });

  must("renaming to the same name changes nothing", () => {
    for (const value of all) {
      const normalized = folders.normalizeDeckCategory(value);
      const got = folders.rewriteCategoryPrefix(normalized, normalized, normalized);
      if (got !== normalized) return `${show(normalized)} became ${show(got)}`;
    }
    return true;
  });

  must("a rename is idempotent once it has happened", () => {
    const once = folders.rewriteCategoryPrefix("Math/Calculus", "Math", "Science");
    const twice = folders.rewriteCategoryPrefix(once, "Math", "Science");
    return once === twice ? true : `${show(once)} then ${show(twice)}`;
  });

  // A folder cannot be moved inside itself: the result would be a path that
  // grows on every rename, and a tree with no root. Whatever the module does
  // here, it must not produce a path that keeps growing.
  must("moving a folder into itself does not produce a runaway path", () => {
    let current = "Math";
    for (let i = 0; i < 5; i += 1) {
      current = folders.rewriteCategoryPrefix(current, "Math", "Math/Sub");
      if (folders.folderSegments(current).length > 8) {
        return `after ${i + 1} rename(s) the path is ${show(current)}`;
      }
    }
    return true;
  });

  must("every rewrite returns a normalised path", () => {
    for (const value of all) {
      const got = folders.rewriteCategoryPrefix(value, "Math", "Science");
      if (got !== folders.normalizeDeckCategory(got)) return `${show(value)} produced un-normalised ${show(got)}`;
    }
    return true;
  });

  // ── Sorting ─────────────────────────────────────────────────────────────
  must("the default folder sorts before every named one", () => {
    const named = ["Math", "aaa", "Zebra", "0", "Über"].map((c) => folders.categorySortValue(c));
    const fallback = folders.categorySortValue(DEFAULT);
    for (const value of named) {
      if (!(fallback < value)) return `${show(fallback)} does not sort before ${show(value)}`;
    }
    return true;
  });

  must("sorting does not care about case", () => {
    const a = folders.categorySortValue("Math/Calculus");
    const b = folders.categorySortValue("math/CALCULUS");
    return a === b ? true : `${show(a)} vs ${show(b)}`;
  });

  must("categorySortValue always returns a string", () => {
    for (const value of [...all, undefined, null, 0, false]) {
      if (typeof folders.categorySortValue(value) !== "string") return `${show(value)} produced a non-string`;
    }
    return true;
  });

  // ── A floor ─────────────────────────────────────────────────────────────
  //
  // Most of the above is of the form "nothing is wrong", which an empty module
  // satisfies. This says what has to be there.
  must("the module still does the work these cases describe", () => {
    if (folders.FOLDER_SEP !== "/") return `separator is ${show(folders.FOLDER_SEP)}`;
    if (folders.folderSegments("a/b/c").length !== 3) return "folderSegments no longer splits";
    if (folders.normalizeDeckCategory(" a / b ") !== "a/b") return "normalizeDeckCategory no longer tidies";
    if (!folders.isCategoryUnder("a/b", "a")) return "isCategoryUnder no longer nests";
    if (folders.rewriteCategoryPrefix("a/b", "a", "c") !== "c/b") return "rewriteCategoryPrefix no longer rewrites";
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
// Named rather than left as a silence: the empty-folder registry
// (readKnownFolders and friends) writes to localStorage, so it belongs to a
// browser check. tools/backup-check.mjs already round-trips an empty folder
// through an archive, which is the part that can lose one.
console.log("\nnot covered here: the empty-folder registry, which needs localStorage");
console.log(`\n${results.length} checks · ${failures} failed`);
console.log(`CHECK: ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
