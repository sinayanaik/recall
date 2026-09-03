// Can a PDF still stop a deck from ever reaching the cloud?
//
//   node tools/text-sanitize-check.mjs
//
// The reported failure was one book: "Modern Robotics Mechanics, Planning, and
// Control — sync failed — unsupported Unicode escape sequence". That message is
// Postgres 22P05, and the cause was U+0000 inside the deck's own title, put
// there by pdf.js decoding a UTF-16BE document string that carried no BOM. It
// is invisible in the library, invisible in the report, and fatal to the whole
// deck's push, because PostgREST parses the entire request body as JSON.
//
// So the assertions here are about the WIRE FORM, not about JavaScript strings:
// what JSON.stringify emits is what Postgres has to accept. And the second half
// is about the repair rather than the strip — sanitizing only what goes on the
// wire fixes the upload and leaves this device holding text the cloud does not
// have, which makes syncTextChanged report every card as edited on every sync,
// forever. Both halves are checked, and the second one fails against the
// wire-only version of this fix, deliberately.
//
// Pure Node, like tools/document-sync-check.mjs: src/core/text.js imports
// nothing and src/sync/text-repair.js imports only that, precisely so this can
// drive them with no browser and no baseline tag. The one accommodation is the
// same — every import in src/ carries `?v=__BUILD__`, which the static server
// understands and Node's ESM resolver does not, so the tree is copied to a temp
// directory with the stamp removed.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-textsan-"));

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

const NUL = "\u0000";
const HIGH = "\uD83D";           // the first half of a thumbs-up emoji
const LOW = "\uDC4D";            // the second half
const THUMB = HIGH + LOW;

// Postgres reads the JSON body, so this is the only shape that matters: is
// there a \u0000 escape, or a \udXXX escape without its partner, in the text
// that actually goes over the wire?
function wireIsAcceptable(json) {
  if (json.includes("\\u0000")) return "the body carries a \\u0000 escape";
  const escapes = [...json.matchAll(/\\u([dD][0-9a-fA-F]{3})/g)];
  for (let i = 0; i < escapes.length; i += 1) {
    const code = parseInt(escapes[i][1], 16);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00) return `a low surrogate \\u${escapes[i][1]} with no high surrogate before it`;
    const next = escapes[i + 1];
    const nextCode = next ? parseInt(next[1], 16) : 0;
    if (!next || nextCode < 0xdc00 || nextCode > 0xdfff) return `a high surrogate \\u${escapes[i][1]} with no low surrogate after it`;
    i += 1;
  }
  return true;
}

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  // ── The smallest possible browser ────────────────────────────────────────
  //
  // Same scaffolding, and the same reasoning, as tools/document-sync-check.mjs:
  // the modules under test touch none of this, but src/sync/cards.js reaches
  // src/core/dom.js a few hops up, and that runs a hundred querySelector calls
  // at module scope. Every stub returns the empty answer and nothing here
  // asserts on one — a stub that were actually CALLED would make this a check
  // of its own scaffolding.
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => noElement, addEventListener: () => {}, documentElement: noElement, body: noElement
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};

  const load = (rel) => import(path.join(stage, rel));
  const { sanitizeUnicodeDeep, stripInvalidUnicode } = await load("src/core/text.js");
  const { repairSnapshotText } = await load("src/sync/text-repair.js");
  const { calculateSyncDiff } = await load("src/sync/diff.js");
  const { cardSyncSignature } = await load("src/sync/cards.js");

  // ── 1. What comes out, and what stays in ─────────────────────────────────

  const paddedTitle = `${NUL}M${NUL}o${NUL}d${NUL}e${NUL}r${NUL}n`;
  must("a NUL between every letter is removed", () =>
    stripInvalidUnicode(paddedTitle) === "Modern" || `got ${JSON.stringify(stripInvalidUnicode(paddedTitle))}`);

  must("newlines, tabs and the rest of C0 are kept", () => {
    const body = "a\nb\tc\r\nde";
    return stripInvalidUnicode(body) === body
      || "the strip is wider than Postgres needs — every markdown card would be rewritten";
  });

  must("a valid surrogate pair survives byte for byte", () => {
    const body = `${THUMB} \u{1D465} \u{20000}`;
    return stripInvalidUnicode(body) === body || `mangled an astral character: ${JSON.stringify(stripInvalidUnicode(body))}`;
  });

  must("a lone high surrogate is removed", () =>
    stripInvalidUnicode(`a${HIGH}b`) === "ab" || `got ${JSON.stringify(stripInvalidUnicode(`a${HIGH}b`))}`);

  must("a lone low surrogate is removed", () =>
    stripInvalidUnicode(`a${LOW}b`) === "ab" || `got ${JSON.stringify(stripInvalidUnicode(`a${LOW}b`))}`);

  must("two high surrogates in a row are both removed", () =>
    stripInvalidUnicode(`${HIGH}${HIGH}x`) === "x" || `got ${JSON.stringify(stripInvalidUnicode(`${HIGH}${HIGH}x`))}`);

  must("clean text comes back as the same string", () => {
    const body = "Modern Robotics";
    return stripInvalidUnicode(body) === body || "a clean string was rewritten";
  });

  must("the prefilter has no lastIndex to carry", () => {
    const dirty = `x${NUL}y`;
    return (stripInvalidUnicode(dirty) === "xy" && stripInvalidUnicode(dirty) === "xy")
      || "consecutive calls disagree — a /g regex is being reused for the test";
  });

  // ── 2. The property Postgres actually enforces ───────────────────────────

  const corruptBag = () => ({
    [`pdf${NUL}Toc`]: {
      v: 3,
      entries: [
        { t: `${NUL}C${NUL}h${NUL}a${NUL}p${NUL}t${NUL}e${NUL}r 2`, p: 12, d: 0 },
        { t: `Grübler's formula ${HIGH}`, p: 14, d: 1 }
      ]
    },
    pdfHighlights: [{ id: "hn-1", text: `a rigid body ${NUL}in space ${LOW}`, at: 1 }],
    pdf: { name: "modern-robotics.pdf", pages: 642 }
  });

  must("a sanitized bag is a body Postgres can accept", () =>
    wireIsAcceptable(JSON.stringify(sanitizeUnicodeDeep(corruptBag()))));

  must("...and the unsanitized one is not — this is the reported bug", () =>
    wireIsAcceptable(JSON.stringify(corruptBag())) !== true
    || "the fixture no longer reproduces the failure this check exists for");

  must("a key with a NUL in it is repaired too", () => {
    const clean = sanitizeUnicodeDeep(corruptBag());
    return (Object.keys(clean).includes("pdfToc") && !Object.keys(clean).some((key) => key.includes(NUL)))
      || `keys came back as ${JSON.stringify(Object.keys(clean))}`;
  });

  must("the entries themselves are readable afterwards", () => {
    const clean = sanitizeUnicodeDeep(corruptBag());
    return clean.pdfToc.entries[0].t === "Chapter 2" || `got ${JSON.stringify(clean.pdfToc.entries[0].t)}`;
  });

  // The no-clone contract: this runs over every deck of every sync, and a book's
  // contents cache is four hundred rows. A future refactor to a naive deep clone
  // fails here rather than in a profile.
  must("a clean meta bag is returned by reference, not copied", () => {
    const bag = {
      pdfToc: { v: 3, entries: Array.from({ length: 400 }, (_, i) => ({ t: `Section ${i}`, p: i, d: 1 })) },
      pdfHighlights: Array.from({ length: 200 }, (_, i) => ({ id: `hn-${i}`, text: `words ${i}`, at: i }))
    };
    return sanitizeUnicodeDeep(bag) === bag || "a clean bag was cloned — this allocates on every deck of every sync";
  });

  // ── 3. Repairing a deck that is already corrupt ──────────────────────────

  const corruptSnapshot = () => ({
    deckTitle: `${NUL}M${NUL}o${NUL}d${NUL}e${NUL}r${NUL}n Robotics`,
    deckCategory: "Books",
    notes: `## Highlight Notes\n\n- hn-1: a rigid body ${NUL}in space`,
    sourceTitle: `${NUL}Modern Robotics`,
    meta: corruptBag(),
    cards: [
      { id: "c1", question: `What is a ${NUL}screw axis?`, answer: `A line${LOW} plus a pitch`, category: null },
      { id: "c2", question: "Grübler's formula?", answer: "N = 6(L - 1 - J) + Σf", category: null }
    ]
  });

  must("the repair changes every field that carries one", () => {
    const snapshot = corruptSnapshot();
    const changed = repairSnapshotText(snapshot);
    if (!changed) return "the repair reported nothing to do on a corrupt deck";
    return (snapshot.deckTitle === "Modern Robotics"
      && snapshot.sourceTitle === "Modern Robotics"
      && !snapshot.notes.includes(NUL)
      && snapshot.cards[0].question === "What is a screw axis?"
      && snapshot.cards[0].answer === "A line plus a pitch"
      && wireIsAcceptable(JSON.stringify(snapshot.meta)) === true)
      || `left something behind: ${JSON.stringify(snapshot.deckTitle)}`;
  });

  must("the whole repaired snapshot is a body Postgres can accept", () => {
    const snapshot = corruptSnapshot();
    repairSnapshotText(snapshot);
    return wireIsAcceptable(JSON.stringify(snapshot));
  });

  must("running it twice changes nothing the second time", () => {
    const snapshot = corruptSnapshot();
    repairSnapshotText(snapshot);
    const before = JSON.stringify(snapshot);
    const again = repairSnapshotText(snapshot);
    return (again === 0 && JSON.stringify(snapshot) === before)
      || `a repaired snapshot was rewritten again (${again} fields)`;
  });

  must("a clean deck is left completely alone", () => {
    const snapshot = {
      deckTitle: "Modern Robotics",
      notes: `Notes with an emoji ${THUMB} and a newline\nand a tab\t.`,
      meta: { pdfToc: { v: 3, entries: [{ t: "Chapter 2", p: 12, d: 0 }] } },
      cards: [{ id: "c1", question: "A question", answer: "An answer", category: "Kinematics" }]
    };
    const before = JSON.stringify(snapshot);
    const metaRef = snapshot.meta;
    const changed = repairSnapshotText(snapshot);
    return (changed === 0 && JSON.stringify(snapshot) === before && snapshot.meta === metaRef)
      || "a clean deck was rewritten — every save and every sync would pay for it";
  });

  // ── 4. Why the repair is local and not only on the wire ──────────────────
  //
  // The trap this check exists to keep shut. Sanitizing the payload alone gets
  // the book uploaded and leaves the device holding different text, and
  // normalizeSyncText does not touch NUL — so the deck re-uploads every card,
  // every sync, for as long as it exists.

  const cloudRowsFrom = (cards) => cards.map((card, index) => ({
    id: card.id, question: stripInvalidUnicode(card.question), answer: stripInvalidUnicode(card.answer),
    position: index, status: "", category: null
  }));

  must("a repaired deck diffs clean against the cloud rows it pushed", () => {
    const snapshot = corruptSnapshot();
    repairSnapshotText(snapshot);
    const diff = calculateSyncDiff(snapshot.cards, cloudRowsFrom(snapshot.cards));
    return diff.edited === 0 || `${diff.edited} cards read as edited straight after their own push`;
  });

  must("...and an UNrepaired one does not — the churn this prevents", () => {
    const snapshot = corruptSnapshot();
    const diff = calculateSyncDiff(snapshot.cards, cloudRowsFrom(snapshot.cards));
    return diff.edited > 0
      || "the fixture stopped demonstrating the wire-only failure, so this check no longer guards anything";
  });

  must("a card's sync signature survives its own push", () => {
    const snapshot = corruptSnapshot();
    repairSnapshotText(snapshot);
    const card = snapshot.cards[0];
    const pushed = { ...card, question: stripInvalidUnicode(card.question), answer: stripInvalidUnicode(card.answer) };
    return cardSyncSignature(card) === cardSyncSignature(pushed)
      || "the card would be re-pushed as dirty on the next sync";
  });

  // ── 5. The chokepoint, and the sentinels it must not swallow ─────────────

  const pushSrc = readFileSync(path.join(ROOT, "src/sync/push.js"), "utf8");
  const deckData = pushSrc.match(/const deckData = \{[\s\S]*?\n  \};/)[0];
  for (const field of ["title", "notes", "category", "meta"]) {
    must(`push.js still sanitizes the deck's ${field}`, () =>
      new RegExp(`${field}:[^\\n]*(stripInvalidUnicode|sanitizeUnicodeDeep)`).test(deckData)
      || `deckData.${field} goes to the cloud unsanitized — the chokepoint only holds while every field passes through it`);
  }
  must("push.js still sanitizes card text", () =>
    (/const question = stripInvalidUnicode\(/.test(pushSrc) && /const answer = stripInvalidUnicode\(/.test(pushSrc))
    || "a card's question/answer reaches the upsert unsanitized");

  // U+0000 is used DELIBERATELY as an in-memory join sentinel in four places —
  // a flat string during a render, three dedupe/selection keys. None of them is
  // ever persisted or pushed, which is exactly why the sanitizer is scoped to
  // snapshot fields and the cloud payload rather than applied globally. If a
  // later change "tidies" one of them away, that is a different decision and it
  // should be made deliberately, not discovered here.
  for (const file of [
    "src/render/math-dom.js",
    "src/import/parse-cards.js",
    "src/library/my-decks-selection.js",
    "src/backup/restore.js"
  ]) {
    must(`${path.basename(file)} still uses its own NUL sentinel`, () =>
      /\\u0000/.test(readFileSync(path.join(ROOT, file), "utf8"))
      || "the deliberate in-memory sentinel is gone — the sanitizer is scoped to persisted fields precisely so these could stay");
  }

  must("no source file carries a raw NUL byte of its own", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".js") && readFileSync(full).includes(0)) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, "src"));
    return offenders.length === 0 || `a literal NUL is in ${offenders.join(", ")} — write it as an escape, not a byte`;
  });

  console.log("── text sanitize ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
