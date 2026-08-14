// Counting what a sync did, so the report can say it in words.

import { quickNoteCategoriesFromMeta } from "../main.js?v=__BUILD__";

// Normalizes any ISO / timestamptz string to epoch ms so timestamps written by
// the JS client and read back from Postgres compare correctly.
export function tsMs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// The one shape every push/pull reports its diff in. Both directions fill the
// same fields so the report can describe them with one vocabulary — and so a
// change kind can never be silently invisible just because the side that
// detected it had nowhere to put it (recategorising a quick note used to land
// in exactly that gap, and the sync then claimed "nothing to sync").
export function emptySyncStats() {
  return {
    cardsAdded: 0,
    cardsDeleted: 0,
    cardsEdited: 0,      // question/answer text
    cardsMoved: 0,       // reordered within the deck
    statusChanges: 0,    // known / review / unsorted
    categoryChanges: 0,  // a card's quick-note subject label
    // Cards a pull kept because this device had changed them and the cloud copy
    // was older — the merge's whole reason to exist. Reported so a conflict is
    // visible rather than something the user has to notice by its absence.
    cardsKeptLocal: 0,
    // The push side of the same conflict: cards another device deleted (so this
    // device dropped its stale copy instead of re-uploading it) and cards
    // another device added (so this device adopted them instead of pruning
    // them). See reconcileCardsBeforePush.
    cardsRemovedHere: 0,
    cardsAdoptedHere: 0,
    notesChanged: false,
    titleChanged: false,
    deckCategoryChanged: false,
    noteCategoriesChanged: false,  // the deck's category DEFINITIONS (decks.meta)
    // A pull replaced deck notes this device had also edited. Notes are free
    // markdown and can't be merged card-wise, so the losing copy is stashed
    // (see NOTES_CONFLICT_SUFFIX) and flagged here.
    notesConflicted: false,
    // A push's deck-row write failed specifically on the notes column (see
    // isMissingNotesColumnError) — cards may still have gone through, but the
    // notes text itself never reached the cloud. Without this flag the push
    // still reports as a plain success, which is exactly the "shows Synced
    // but notes didn't sync" failure mode this exists to close.
    notesSyncFailed: false,
    // The whole deck was deleted on another device, so this device dropped its
    // copy instead of re-uploading it. A deck-level flag, not a card count —
    // there is no card detail to report once the deck is gone.
    deckRemovedHere: false
  };
}

// The counted stats (summed across decks), as opposed to the deck-level
// booleans below them, which are counted as "how many decks".
export const SYNC_COUNT_STATS = ["cardsAdded", "cardsDeleted", "cardsEdited", "statusChanges", "cardsMoved", "categoryChanges", "cardsKeptLocal", "cardsRemovedHere", "cardsAdoptedHere"];

export const SYNC_FLAG_STATS = ["notesChanged", "titleChanged", "deckCategoryChanged", "noteCategoriesChanged", "notesConflicted", "notesSyncFailed", "deckRemovedHere"];

// Human phrases for a diff, most consequential first. Returns an array so
// callers can join, count, or truncate it. With `asTotals`, the deck-level
// booleans have been summed into deck counts by totalSyncStats and say so.
export function describeSyncStats(stats = {}, { asTotals = false } = {}) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (stats.cardsAdded) parts.push(`${plural(stats.cardsAdded, "card", "cards")} added`);
  if (stats.cardsDeleted) parts.push(`${plural(stats.cardsDeleted, "card", "cards")} deleted`);
  if (stats.cardsEdited) parts.push(`${plural(stats.cardsEdited, "card", "cards")} edited`);
  if (stats.statusChanges) parts.push(`${plural(stats.statusChanges, "card", "cards")} restacked (known/review)`);
  if (stats.cardsMoved) parts.push(`${plural(stats.cardsMoved, "card", "cards")} reordered`);
  if (stats.categoryChanges) parts.push(`${plural(stats.categoryChanges, "note", "notes")} recategorised`);
  if (stats.cardsKeptLocal) parts.push(`${plural(stats.cardsKeptLocal, "card", "cards")} kept from this device (newer than the cloud)`);
  if (stats.cardsRemovedHere) parts.push(`${plural(stats.cardsRemovedHere, "card", "cards")} removed here (deleted on another device)`);
  if (stats.cardsAdoptedHere) parts.push(`${plural(stats.cardsAdoptedHere, "card", "cards")} picked up here (added on another device)`);
  const flag = (value, label) => {
    if (!value) return;
    parts.push(asTotals && value > 1 ? `${label} on ${value} decks` : label);
  };
  flag(stats.notesChanged, "notes edited");
  flag(stats.titleChanged, "deck renamed");
  flag(stats.deckCategoryChanged, "deck category changed");
  flag(stats.noteCategoriesChanged, "note categories added/renamed/removed");
  flag(stats.notesConflicted, "your notes edit was replaced by a newer one (a copy was kept)");
  flag(stats.notesSyncFailed, "notes could NOT be synced — run supabase_setup.sql in Supabase");
  flag(stats.deckRemovedHere, "removed here (deleted on another device)");
  return parts;
}

// Did the deck's quick-note category DEFINITIONS change (added, renamed,
// recoloured, removed, reordered)? Compares through quickNoteCategoriesFromMeta
// so both sides are normalised the same way and a meta bag that's a JSON string
// on one side and a parsed object on the other doesn't read as a change.
export function quickNoteCategoriesDiffer(metaA, metaB) {
  const key = (meta) => JSON.stringify(quickNoteCategoriesFromMeta(meta).map((c) => [c.id, c.name, c.color]));
  return key(metaA) !== key(metaB);
}

// A pull/push whose diff stats are all-zero is just a timestamp-alignment
// artifact (e.g. clock granularity between an edit-time stamp and a push-time
// stamp) — nothing actually moved, so it shouldn't be counted or reported as
// user-visible sync activity. Derived from describeSyncStats so a newly added
// stat can never be counted by one and ignored by the other.
export function isNoOpStats(stats) {
  return describeSyncStats(stats).length === 0;
}

// Sums each change kind across every deck the sync touched, for the one-line
// summary. Booleans count the DECKS affected ("notes edited on 2 decks").
export function totalSyncStats(deckLog) {
  const totals = emptySyncStats();
  for (const entry of deckLog) {
    if (entry.direction === "failed") continue;
    for (const key of SYNC_COUNT_STATS) totals[key] += entry[key] || 0;
    for (const key of SYNC_FLAG_STATS) {
      if (entry[key]) totals[key] = (totals[key] || 0) + 1;
    }
  }
  return totals;
}
