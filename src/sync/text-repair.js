// Taking the characters the cloud cannot store back out of a deck.
//
// The report was a book that would not sync: "Modern Robotics Mechanics,
// Planning, and Control — sync failed — unsupported Unicode escape sequence".
// That message is Postgres 22P05, and the cause was U+0000 inside the deck's
// own title: pdf.js decodes a document string with no UTF-16 BOM byte-by-byte,
// so a UTF-16BE title comes back with a NUL between every letter. Invisible in
// the library, invisible in the report, and fatal to the whole deck's push,
// because PostgREST parses the entire request body as JSON.
//
// ── Why the local copy is REPAIRED, not merely cleaned on the wire ────────
//
// Stripping in push.js alone would have got that book uploaded, and left this
// device holding text that no longer matched what it had sent. syncTextChanged
// (src/sync/diff.js) compares the two through normalizeMarkdown, which does not
// touch NUL — so every card in the deck would have read as edited on every sync
// from then on, re-uploading the whole book forever. Repairing the snapshot
// makes the two sides identical instead: one bump the first time, silence after.
//
// The alternative, making normalizeSyncText NUL-insensitive, was rejected: it
// hides the divergence rather than fixing it. The text stays corrupt in local
// storage, every exporter keeps carrying it, and cardSyncSignature stops being
// able to tell two genuinely different strings apart.
//
// Pure functions of plain objects, importing only core/text.js, deliberately —
// tools/text-sanitize-check.mjs drives this in plain Node with no browser, the
// same contract src/sync/document-sync.js keeps.

import { sanitizeUnicodeDeep, stripInvalidUnicode } from "../core/text.js?v=__BUILD__";

// Every persisted string field of a deck snapshot that can carry text a PDF
// produced. `meta` covers the derived table of contents, the highlights and
// their notes in one pass (see sanitizeUnicodeDeep), including its keys.
const REPAIRED_DECK_FIELDS = ["deckTitle", "deckCategory", "notes", "sourceTitle", "importTitleHint"];
const REPAIRED_CARD_FIELDS = ["question", "answer", "category"];

// Repairs a snapshot IN PLACE and returns how many fields it changed — 0 for a
// clean deck, which is every deck but the affected ones. Callers fold that count
// into their own "did anything actually move" test rather than writing the
// snapshot unconditionally: rewriting every deck's snapshot on every save and
// every sync is pure quota churn on the device where quota is already the
// binding constraint.
//
// Idempotent by construction: a repaired snapshot passed back through this
// returns 0 and is not touched.
export function repairSnapshotText(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return 0;
  let changed = 0;

  for (const field of REPAIRED_DECK_FIELDS) {
    const value = snapshot[field];
    if (typeof value !== "string") continue;
    const clean = stripInvalidUnicode(value);
    if (clean !== value) {
      snapshot[field] = clean;
      changed += 1;
    }
  }

  if (snapshot.meta && typeof snapshot.meta === "object") {
    // Assigned only when the walk actually rewrote something — sanitizeUnicodeDeep
    // hands back the SAME reference for a clean bag, so a 400-entry contents
    // cache costs one scan per string and no allocation at all.
    const cleanMeta = sanitizeUnicodeDeep(snapshot.meta);
    if (cleanMeta !== snapshot.meta) {
      snapshot.meta = cleanMeta;
      changed += 1;
    }
  }

  for (const card of Array.isArray(snapshot.cards) ? snapshot.cards : []) {
    if (!card || typeof card !== "object") continue;
    for (const field of REPAIRED_CARD_FIELDS) {
      const value = card[field];
      if (typeof value !== "string") continue;
      const clean = stripInvalidUnicode(value);
      if (clean !== value) {
        card[field] = clean;
        changed += 1;
      }
    }
    // The note-link is a small object of strings ("Go to notes" would break on
    // one that no longer matches the note it points at, and the note itself is
    // repaired above).
    if (card.noteAnchor && typeof card.noteAnchor === "object") {
      const cleanAnchor = sanitizeUnicodeDeep(card.noteAnchor);
      if (cleanAnchor !== card.noteAnchor) {
        card.noteAnchor = cleanAnchor;
        changed += 1;
      }
    }
  }

  return changed;
}
