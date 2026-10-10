// The conflict stash: one slot per deck, at `localId + NOTES_CONFLICT_SUFFIX`,
// holding whatever a merge could not put in the note itself — whole bodies from
// decks with no merge base, and (the common case now) just the paragraphs two
// devices or windows changed in different ways. Read by the resolver in
// ./notes-conflict.js. Shared by the sync and the local save path, which is why
// it lives in neither.

import { readDeckSnapshot, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { NOTES_CONFLICT_SUFFIX } from "../storage/keys.js?v=__BUILD__";

// ── Rescuing a notes body that is about to be replaced ──────────────────────
//
// One stash slot per deck, at `localId + NOTES_CONFLICT_SUFFIX`, and it is only
// ever added to. Writing straight over it would mean a second conflict arriving
// before the first was answered silently destroys the copy the first one
// rescued, which is the one thing this whole mechanism exists to prevent — so an
// unanswered stash is kept and the new losing copy goes above it.
//
// `previous` is the caller's already-read copy where it has one; otherwise this
// reads the slot itself. A stash can outlive its flag (the resolver that accepts
// the synced copy clears one without deleting the other), so the read is not
// optional — it is just worth skipping when the answer is already in hand.
//
// Shared by both directions since the push grew a stash of its own. It had none:
// the pull rescued the body it was about to overwrite and the push overwrote the
// CLOUD's body with nothing kept anywhere, which is the same loss with the
// devices the other way round.
export async function stashLosingNotes(localId, deckTitle, losing, previous = null) {
  const prior = previous || await readDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  const carried = prior && String(prior.notes || "").trim() ? String(prior.notes) : "";
  const when = prior?.savedAt ? new Date(prior.savedAt).toLocaleString() : "an earlier sync";
  writeDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX, {
    savedAt: new Date().toISOString(),
    deckTitle: deckTitle || "",
    notes: carried && carried.trim() !== losing.trim()
      ? `${losing}\n\n---\n\n## Also replaced, on ${when}\n\n${carried}\n`
      : losing,
    // Unanswered clashing paragraphs from a partial merge stay with the slot.
    ...(Array.isArray(prior?.hunks) && prior.hunks.length ? { hunks: prior.hunks } : {})
  });
}

// ── Rescuing just the paragraphs that clashed ──────────────────────────────
//
// The partial merge (src/sync/merge3.js) applies every change from both sides
// and leaves only the regions the two changed in different ways. Each of those
// is filed here as a hunk: the text the note now holds there (`kept`) and the
// text it does not (`other`). The resolver in src/sync/notes-conflict.js offers
// them one at a time. Unanswered hunks from an earlier sync are kept — the slot
// only ever grows until the reader answers, the same rule stashLosingNotes keeps.
export async function stashConflictHunks(localId, deckTitle, hunks, { otherFrom = "another device" } = {}, previous = null) {
  if (!hunks?.length) return;
  const prior = previous || await readDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  const savedAt = new Date().toISOString();
  const fresh = hunks.map((hunk, index) => ({
    id: `h${Date.now().toString(36)}${index}${Math.random().toString(36).slice(2, 6)}`,
    kept: String(hunk.kept ?? hunk.local ?? ""),
    other: String(hunk.other ?? hunk.remote ?? ""),
    base: String(hunk.base ?? ""),
    // A card field rather than a paragraph of the note: which card, which side.
    ...(hunk.kind === "card" ? { kind: "card", cardId: String(hunk.cardId), field: hunk.field, question: String(hunk.question ?? "") } : {}),
    otherFrom,
    savedAt
  }));
  const carried = Array.isArray(prior?.hunks) ? prior.hunks : [];
  // The same clash seen again on the next sync is one question, not two.
  const seen = new Set(carried.map((h) => `${h.cardId || ""}\u241f${h.kept}\u241f${h.other}`));
  const next = {
    savedAt,
    deckTitle: deckTitle || prior?.deckTitle || "",
    hunks: [...carried, ...fresh.filter((h) => !seen.has(`${h.cardId || ""}\u241f${h.kept}\u241f${h.other}`))]
  };
  // A whole-body stash from before (or from a deck with no merge base) rides
  // along untouched; the resolver offers both.
  if (prior && String(prior.notes || "").trim()) next.notes = prior.notes;
  writeDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX, next);
}


// A card field both devices changed in ways the word merge could not settle
// (src/sync/cards.js, mergeCardFields → `lost`), as a conflict hunk: the text the
// card now holds is `kept`, the other device's is `other`. `cards` is the merged
// card list, so `kept` is exactly what the reader will see on the card.
export function cardConflictHunks(lost, cards) {
  const byId = new Map((cards || []).map((card) => [String(card.id), card]));
  return (lost || []).map((item) => {
    const card = byId.get(String(item.id)) || {};
    return {
      kind: "card",
      cardId: String(item.id),
      field: item.field,
      question: String(card.question ?? ""),
      kept: String(card[item.field] ?? ""),
      other: String(item.text ?? "")
    };
  });
}
