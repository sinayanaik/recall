// Does what comes out of an export go back in?
//
//   node tools/export-check.mjs
//
// src/export/ had no live check. tools/ui-smoke.mjs pressed Export and compared
// the markdown against the pre-modular build — a useful thing, but it skipped
// itself on every machine but one, and comparing against a baseline is not the
// same as asking whether the file WORKS.
//
// The question this asks is the one an export is for: if you export a deck and
// import the file back, do you get the same deck? Nothing had ever asked. The
// escaping alone makes it a real question — a card's question or answer may
// legitimately contain a standalone "---", which is also the separator the
// format uses between the two sides, so export has to escape it and import has
// to unescape it. Those two rules live in different modules
// (src/export/markdown.js and src/import/parse-cards.js) and nothing compared
// them.
//
// Driven against tools/adversarial-corpus.mjs, so the round trip is asked of
// text with fences, NULs, CRLF, RTL overrides and a 100,000-character line in
// it rather than of "hello world".
//
// Pure Node. The three export modules that need a DOM (docx, html, sql) are not
// here and are named at the end, so their absence is a fact somebody can read
// rather than a silence.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_CASES, GROUPS, TITLE_CASES } from "./adversarial-corpus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-export-"));

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

const show = (text) => JSON.stringify(String(text).slice(0, 160));

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));
  const load = (rel) => import(path.join(stage, rel));

  const md = await load("src/export/markdown.js");
  const zip = await load("src/export/zip.js");
  const zipLite = await load("src/backup/zip-lite.js");
  const cards = await load("src/import/parse-cards.js");

  // One case is excluded, by name, and has a case of its own below rather than
  // being folded into a count: an unbalanced fence is a real and unfixed data
  // loss, and it is worth a line somebody reads rather than a number.
  const KNOWN_ROUND_TRIP_LOSS = "an unbalanced opening fence";

  // ── The round trip ──────────────────────────────────────────────────────
  //
  // formatCardList writes the "::" delimited form; parseDelimitedCards reads
  // it. The whole value of an export is that this holds.
  const roundTrip = (list) => {
    const text = md.formatCardList("Cards", list);
    return cards.parseCards(text).map((c) => ({ question: c.question, answer: c.answer }));
  };

  must("a plain deck survives export and re-import", () => {
    const original = [
      { question: "What is the capital of France?", answer: "Paris." },
      { question: "And of Italy?", answer: "Rome." }
    ];
    const back = roundTrip(original);
    if (back.length !== original.length) return `${original.length} cards out, ${back.length} back`;
    for (let i = 0; i < original.length; i += 1) {
      if (back[i].question.trim() !== original[i].question.trim()) return `q${i}: ${show(back[i].question)}`;
      if (back[i].answer.trim() !== original[i].answer.trim()) return `a${i}: ${show(back[i].answer)}`;
    }
    return true;
  });

  // The one the escaping exists for. A horizontal rule in a card is
  // indistinguishable from the separator between its two sides, so without the
  // escape the question is truncated at the rule and the rest is lost.
  // The normalisation the format is allowed to apply, and no more: CRLF and
  // NBSP folded (normalizeMarkdown), trailing whitespace stripped per line,
  // three or more blank lines collapsed to one, and the whole thing trimmed
  // (cleanToggleContent). Anything else the round trip does to the text is a
  // loss, and comparing against this is what makes these cases able to see it.
  const normalised = (text) => String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  must("a card containing a horizontal rule is not truncated by the round trip", () => {
    const question = "Before the rule\n\n---\n\nAfter the rule";
    const back = roundTrip([{ question, answer: "The answer." }]);
    if (back.length !== 1) return `${back.length} cards came back`;
    // Character for character, against the normalised original. Asserting that
    // "After the rule" is merely PRESENT is not enough: with the unescape
    // disabled on the import side the text comes back carrying a literal
    // "\\---" and every keyword is still there. Verified by disabling it.
    if (back[0].question !== normalised(question)) {
      return `question came back as ${show(back[0].question)}, not ${show(normalised(question))}`;
    }
    if (back[0].answer !== "The answer.") return `answer: ${show(back[0].answer)}`;
    return true;
  });

  // ...and the exception to the escape, which is easy to get wrong in the
  // other direction: a rule inside a fenced code block is content. YAML
  // frontmatter in a code sample must come back out unescaped.
  must("...while a rule inside a code fence comes back unescaped", () => {
    const sample = "```yaml\n---\ntitle: A document\n---\n```";
    const back = roundTrip([{ question: sample, answer: "yaml" }]);
    if (back.length !== 1) return `${back.length} cards came back`;
    if (back[0].question !== normalised(sample)) {
      return `came back as ${show(back[0].question)}, not ${show(normalised(sample))}`;
    }
    return true;
  });

  // Every ordinary shape, character for character. The two cases above name the
  // two interesting ones; this is the floor under them.
  must("every card comes back exactly as it went in, character for character", () => {
    const wrong = [];
    for (const c of ALL_CASES) {
      if (!c.text.trim()) continue;
      if (c.name === KNOWN_ROUND_TRIP_LOSS) continue;
      const back = roundTrip([{ question: c.text, answer: "an answer" }]);
      if (back.length !== 1) { wrong.push(`${c.name}: ${back.length} card(s) back`); continue; }
      const want = normalised(c.text);
      if (back[0].question !== want) {
        wrong.push(`${c.name}: ${back[0].question.length} chars back, ${want.length} expected`);
      }
    }
    return wrong.length ? `${wrong.length} differ — first: ${wrong[0]}` : true;
  });

  must("escapeCardSideSeparator is idempotent on its own output", () => {
    for (const c of ALL_CASES) {
      const once = md.escapeCardSideSeparator(c.text);
      const twice = md.escapeCardSideSeparator(once);
      if (once !== twice) return `${c.name}: escaping twice changed it`;
    }
    return true;
  });

  must("every shape in the corpus survives the round trip as one card", () => {
    const lost = [];
    for (const c of ALL_CASES) {
      // An empty or whitespace-only side is not a card; skip those rather than
      // asserting something the format does not promise.
      if (!c.text.trim()) continue;
      if (c.name === KNOWN_ROUND_TRIP_LOSS) continue;
      const back = roundTrip([{ question: c.text, answer: "an answer" }]);
      if (back.length !== 1) { lost.push(`${c.name}: came back as ${back.length} card(s)`); continue; }
      if (!/an answer/.test(back[0].answer)) lost.push(`${c.name}: the answer did not survive`);
    }
    return lost.length ? `${lost.length} lost — first: ${lost[0]}` : true;
  });

  // ── The one that is really lost ─────────────────────────────────────────
  //
  // A card whose question leaves a code fence open is DELETED by export and
  // re-import, and it takes the rest of the file with it.
  //
  // Both sides track fences, and they agree: escapeCardSideSeparator does not
  // escape a "---" inside a fence, and parseDelimitedCards does not read one as
  // the front/back separator inside a fence. Symmetric, and right — as long as
  // the fence closes.
  //
  // When it does not, the exporter writes its separator while the importer is
  // still inside the question's unterminated fence. So:
  //
  //   • the "---" between the two sides is read as content, `side` never
  //     becomes "back", and flush() requires BOTH a question and an answer —
  //     so the card is dropped
  //   • the closing "::" is guarded by !inFence too, so the card boundary is
  //     missed as well, and everything after it in the file is swallowed into
  //     the card that is about to be thrown away
  //
  // Not fixed here, because every fix is a decision about the format rather
  // than a bug to correct: making "::" a boundary regardless of fence state
  // breaks a card whose content legitimately contains a bare "::" line inside
  // a fence (reStructuredText, Nim), and having the exporter close what the
  // author left open changes the card's content. See
  // EXPORT_EXPECTED_FAILURES in tools/check.mjs.
  must("a card whose question leaves a code fence open survives the round trip", () => {
    const original = [
      { question: "```js\nconst a = 1;\n\nand prose after it, forever", answer: "the answer" },
      { question: "an ordinary second card", answer: "its answer" }
    ];
    const back = roundTrip(original);
    if (back.length !== 2) {
      return `${back.length} of 2 cards came back — the unterminated fence swallowed the rest of the file`;
    }
    if (!/the answer/.test(back[0].answer)) return `card 1 lost its answer: ${show(back[0].answer)}`;
    return true;
  });

  // The property that matters when a note is a book: nothing is dropped. Not
  // "byte-identical" — normalisation is allowed to change CRLF and NBSP, and
  // does — but the WORDS have to be there.
  must("no word is lost in the round trip", () => {
    const lost = [];
    for (const c of GROUPS.shapes.concat(GROUPS.fences, GROUPS.links)) {
      if (!c.text.trim()) continue;
      if (c.name === KNOWN_ROUND_TRIP_LOSS) continue;   // see the case above
      const back = roundTrip([{ question: c.text, answer: "x" }]);
      if (!back.length) { lost.push(`${c.name}: nothing came back`); continue; }
      const words = (s) => String(s).match(/[A-Za-z]{4,}/g) || [];
      const wanted = new Set(words(c.text));
      const got = new Set(words(back[0].question));
      const missing = [...wanted].filter((w) => !got.has(w));
      if (missing.length) lost.push(`${c.name}: lost ${missing.slice(0, 4).join(", ")}`);
    }
    return lost.length ? `${lost.length} case(s) lost words — first: ${lost[0]}` : true;
  });

  // ── The filename an export gets ─────────────────────────────────────────
  must("slugifyFileName never returns something a filesystem refuses", () => {
    const bad = [];
    for (const c of [...TITLE_CASES, ...ALL_CASES]) {
      const name = md.slugifyFileName(c.text, "recall");
      if (!name) { bad.push(`${c.name}: empty`); continue; }
      // The set the function's own regex removes, plus a path separator, which
      // is the one that turns a download into a directory traversal.
      if (/[<>:"/\\|?*]/.test(name)) bad.push(`${c.name}: ${show(name)}`);
      // eslint-disable-next-line no-control-regex
      else if (/[\x00-\x1f]/.test(name)) bad.push(`${c.name}: control character in ${show(name)}`);
    }
    return bad.length ? `${bad.length} bad name(s) — first: ${bad[0]}` : true;
  });

  must("...and always returns the fallback rather than nothing", () => {
    for (const value of ["", "   ", null, undefined, "///", " "]) {
      const name = md.slugifyFileName(value, "recall");
      if (name !== "recall" && !name.trim()) return `${show(value)} produced ${show(name)}`;
      if (!name) return `${show(value)} produced an empty name`;
    }
    return true;
  });

  must("slugifyFileName is idempotent", () => {
    for (const c of [...TITLE_CASES, ...ALL_CASES]) {
      const once = md.slugifyFileName(c.text, "recall");
      const twice = md.slugifyFileName(once, "recall");
      if (once !== twice) return `${c.name}: ${show(once)} then ${show(twice)}`;
    }
    return true;
  });

  // Two decks whose titles differ only in a character the slug strips end up
  // wanting the same file. That is not a bug in slugify — it is a fact about
  // it — but a caller that writes both without noticing loses one, so the
  // collision is recorded here rather than discovered later.
  must("titles that collide after slugging are collisions, and are named", () => {
    const byName = new Map();
    for (const c of TITLE_CASES) {
      const name = md.slugifyFileName(c.text, "recall");
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(c.name);
    }
    const collisions = [...byName.entries()].filter(([, list]) => list.length > 1);
    // Asserted as a KNOWN set rather than as "none": "My Deck"/"my deck" and
    // "?!?"/"   ---   " genuinely do collide, and the value of the assertion is
    // that the set does not GROW without somebody noticing.
    const names = collisions.map(([name]) => name).sort();
    const expected = ["recall"];
    const unexpected = names.filter((n) => !expected.includes(n));
    return unexpected.length
      ? `new collision(s) on ${JSON.stringify(unexpected)} — ${JSON.stringify(collisions)}`
      : true;
  });

  must("normalizeCardStatus only ever returns known, review or nothing", () => {
    const inputs = ["known", "review", "", null, undefined, "KNOWN", "unknown", 0, false, {}, "learning"];
    const allowed = new Set(["known", "review", ""]);
    for (const input of inputs) {
      const got = md.normalizeCardStatus(input);
      if (!allowed.has(got)) return `${show(input)} produced ${show(got)}`;
    }
    return true;
  });

  // ── The zip an export writes ────────────────────────────────────────────
  //
  // Read back with src/backup/zip-lite.js — the app's own reader, which
  // tools/backup-check.mjs already drives a whole backup through, so a
  // disagreement between the two is a real disagreement rather than a quirk of
  // some third-party unzipper.
  // The same shape tools/backup-check.mjs opens an archive with: LiteZip exposes
  // its members as a plain object keyed by path, because JSZip does and the
  // backup code indexes straight into it.
  const readBack = async (bytes) => {
    const archive = await zipLite.LiteZip.loadAsync(bytes);
    const out = new Map();
    for (const name of Object.keys(archive.files)) {
      out.set(name, await archive.files[name].async("string"));
    }
    return out;
  };

  const ZIP_FILES = [
    { name: "plain.md", body: "# A deck\n\nBody.\n" },
    { name: "unicode.md", body: `# ${GROUPS.unicode[4].text}\n` },
    { name: "nested/inside/a/folder.md", body: "nested\n" },
    { name: "empty.md", body: "" },
    { name: "big.md", body: "x".repeat(300000) }
  ];

  const encoder = new TextEncoder();
  let archiveBytes = null;
  must("buildZipArchive produces something zip-lite can read", () => {
    archiveBytes = zip.buildZipArchive(ZIP_FILES.map((f) => ({ name: f.name, data: encoder.encode(f.body) })));
    if (!(archiveBytes instanceof Uint8Array) && !(archiveBytes instanceof ArrayBuffer) && !archiveBytes?.byteLength) {
      return `produced ${Object.prototype.toString.call(archiveBytes)}`;
    }
    // Local file header signature, first four bytes. If this is wrong nothing
    // downstream will even try.
    const view = new Uint8Array(archiveBytes.buffer || archiveBytes);
    const sig = view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04;
    return sig ? true : `first bytes are ${[...view.slice(0, 4)].join(",")}, not PK\\x03\\x04`;
  });

  const entries = archiveBytes ? await readBack(archiveBytes) : new Map();

  must("...with every file in it, under the name it was given", () => {
    const missing = ZIP_FILES.map((f) => f.name).filter((n) => !entries.has(n));
    return missing.length ? `missing: ${missing.join(", ")}` : true;
  });

  must("...and every file's bytes come back unchanged", () => {
    const wrong = [];
    for (const f of ZIP_FILES) {
      const got = entries.get(f.name);
      if (got === undefined) continue;   // reported by the case above
      if (got !== f.body) wrong.push(`${f.name}: ${got.length} chars back, ${f.body.length} in`);
    }
    return wrong.length ? wrong.join("; ") : true;
  });

  must("crc32 matches a value computed independently", () => {
    // "The quick brown fox jumps over the lazy dog" has a well-known CRC-32 of
    // 0x414FA339. A checksum function that agrees with the rest of the world is
    // the difference between an archive every tool opens and one only this app
    // does.
    const bytes = encoder.encode("The quick brown fox jumps over the lazy dog");
    const got = zip.crc32(bytes) >>> 0;
    return got === 0x414fa339 ? true : `0x${got.toString(16)} rather than 0x414fa339`;
  });

  must("utf8Bytes round-trips every string in the corpus", () => {
    // ignoreBOM, because TextDecoder strips a leading U+FEFF by default and
    // that is a fact about TextDecoder rather than about utf8Bytes. Without it
    // the BOM case reports a byte lost that was never lost.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    for (const c of ALL_CASES) {
      const back = decoder.decode(zip.utf8Bytes(c.text));
      // A lone surrogate cannot survive UTF-8 and comes back as U+FFFD. That is
      // correct, and asserted as such rather than skipped.
      const expected = c.name.includes("lone") ? decoder.decode(encoder.encode(c.text)) : c.text;
      if (back !== expected) return `${c.name}: ${back.length} chars back, ${expected.length} expected`;
    }
    return true;
  });

  // ── A coverage floor ────────────────────────────────────────────────────
  must("the round trip still exercises the escaping it is here for", () => {
    const withRules = ALL_CASES.filter((c) => /^\s*---(?!-)/m.test(c.text)).length;
    const escaped = ALL_CASES.filter((c) => md.escapeCardSideSeparator(c.text) !== c.text).length;
    if (!withRules) return "no case in the corpus contains a horizontal rule any more";
    if (!escaped) return "the escaper no longer changes any case in the corpus";
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
// Said out loud rather than left as a gap: three of the export modules import
// something that touches `document` at module scope (docx.js, html.js, sql.js
// via web-decks), so they cannot be driven here. They are the browser half's
// job, and tools/pdf-preview-check.mjs already loads run.js and pdf.js.
console.log("\nnot covered here: docx.js, html.js and sql.js reach `document` at import time");
console.log(`\n${results.length} checks · ${failures} failed`);
console.log(`CHECK: ${results.length} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
