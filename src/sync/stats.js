// Counting what a sync did, so the report can say it in words.

import { quickNoteCategoriesFromMeta } from "../quick-notes/categories.js?v=__BUILD__";
import { canonicalJson } from "./merge3.js?v=__BUILD__";

// Normalizes any ISO / timestamptz string to epoch ms so timestamps written by
// the JS client and read back from Postgres compare correctly.
export function tsMs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// ── Two clocks, and no server to arbitrate ──────────────────────────────────
//
// Every timestamp the sync decides on is written by the CLIENT. That is
// deliberate and cannot simply be changed: supabase_setup.sql (section 5)
// explains why `decks` and `cards` carry no `updated_at` trigger — the push
// writes the deck row stamped at the UNIX epoch and only rewrites it with the
// real time once every card has landed, so a trigger would overwrite that
// crash-recovery sentinel and defeat the per-card merge besides.
//
// What that leaves is a system whose every safety net is a comparison between
// two devices' clocks, with nothing compensating for them disagreeing. With one
// device two hours fast:
//
//   • it pushes, and the row is stamped two hours in the future;
//   • the other device pulls, and its index entry inherits that stamp;
//   • it edits, stamping the edit with the TRUE time — which is older than the
//     deck's own baseline, so the push gate never fires and the pull gate does;
//   • the pull's stash gate is `updatedAt > lastSyncedAt`, which is false for
//     the same reason, so the edit is replaced with no copy kept and no flag.
//
// The two helpers below are what the call sites use instead of a bare
// `new Date().toISOString()`.

// A stamp that is strictly later than `after`, using the clock when the clock is
// already ahead of it. This is what makes a write MONOTONIC with respect to the
// copy it supersedes: a local edit always outranks the deck's own baseline, and
// a push always outranks the cloud row it merged against, whichever way the two
// clocks happen to disagree. Without it a device with a slow clock can neither
// push its work nor stop its work being pulled over.
export function nextSyncStamp(clockIso, after) {
  const clockMs = tsMs(clockIso);
  const afterMs = tsMs(after);
  if (!afterMs || clockMs > afterMs) return clockIso;
  return new Date(afterMs + 1).toISOString();
}

// How far ahead of this device a timestamp may be before it stops being evidence
// of anything. Generous: ordinary skew between two NTP-synced devices is
// milliseconds, and the round trip that produced the stamp is seconds, so
// anything past this is a genuinely wrong clock rather than noise.
export const SYNC_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

// True when `iso` is stamped beyond this device's own clock by more than the
// tolerance — i.e. the two edits CANNOT be ordered, so any rule that picks a
// winner by comparing them is guessing. Callers respond by keeping the losing
// copy rather than discarding it; a stash costs a little storage, and the
// alternative is silent loss.
export function clockSkewedAhead(iso, nowIso = new Date().toISOString()) {
  const stamp = tsMs(iso);
  if (!stamp) return false;
  return stamp > tsMs(nowIso) + SYNC_CLOCK_SKEW_TOLERANCE_MS;
}

// ── Which way a deck goes: by who edited, not by whose clock is later ──────
//
// The direction used to be `cloud.updated_at > local updatedAt` → pull, and the
// reverse → push: a comparison of two devices' clocks. Any local write that
// moved updatedAt — including a window saving a STALE copy of a deck another
// device had just changed — therefore turned the old copy into "the newer one"
// and pushed it over the edit. That is the "I opened the note on my other
// device and my change disappeared" report.
//
// The question is really two questions, and neither needs a clock:
//
//   did THIS device change the deck since it last agreed with the cloud?
//       updatedAt is stamped monotonically past lastSyncedAt by every real
//       edit (nextSyncStamp) and set equal to it by every sync, so "later than"
//       here compares two stamps this device wrote itself.
//   did the CLOUD change since then?
//       lastSyncedAt holds the exact updated_at the cloud row had when they
//       agreed, so any different value means somebody wrote it. Equality, not
//       ordering — a wrong clock elsewhere cannot fake it either way.
//
//   only the cloud moved   → pull
//   this device edited     → push, which merges whatever the cloud has first
//   neither                → nothing to do
export function deckHasLocalEdits(entry) {
  if (!entry) return false;
  if (entry.dirty === true) return true;
  return tsMs(entry.updatedAt) > tsMs(entry.lastSyncedAt);
}

export function cloudMovedSince(cloudRow, entry) {
  if (!entry?.lastSyncedAt) return true;
  return tsMs(cloudRow?.updated_at) !== tsMs(entry.lastSyncedAt);
}

// A row stamped at the epoch is another device's push still uploading its cards
// (see PENDING_TS in ./push.js). Reading it now would merge against half a deck;
// leave it this run. A row stuck there past the grace period is a push that died
// part-way, and is treated as any other change.
export const PENDING_PUSH_GRACE_MS = 5 * 60 * 1000;

export function cloudPushInFlight(cloudRow, nowMs = Date.now()) {
  if (!cloudRow || tsMs(cloudRow.updated_at) !== 0) return false;
  const started = tsMs(cloudRow.last_accessed_at);
  return Boolean(started) && nowMs - started < PENDING_PUSH_GRACE_MS;
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
    // The document's three, and the reason they are separate from notesChanged:
    // a paper's highlights and the notes written on them ride in the same deck
    // as the reader's own prose, but they are merged per record (see
    // src/sync/document-sync.js) rather than replaced wholesale. Rolling them
    // into "notes edited" said the wrong thing in both directions — a sync that
    // only carried annotations claimed the reader's writing had been replaced,
    // and a sync that genuinely replaced it said nothing about the annotations
    // that arrived with it.
    highlightsMerged: 0,        // highlights this device did not have
    highlightsRemovedHere: 0,   // highlights deleted on another device
    highlightNotesMerged: 0,    // notes on highlights, arrived or reconciled
    notesChanged: false,
    titleChanged: false,
    deckCategoryChanged: false,
    noteCategoriesChanged: false,  // the deck's category DEFINITIONS (decks.meta)
    // A pull replaced the reader's own notes BODY, which this device had also
    // edited. Free markdown can't be merged card-wise, so the losing copy is
    // stashed (see NOTES_CONFLICT_SUFFIX) and flagged here. Deliberately asked
    // of the body alone: the fenced highlight-note block below it is merged
    // entry by entry, so there is nothing there to rescue and nothing to flag.
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
    deckRemovedHere: false,
    // The typed blocks dropped onto a paper's pages — markdown and pictures,
    // meta.pdfBlocks. Merged by id exactly as the highlights beside them are
    // (mergeRecordsById, ./diff.js), and until now with nothing to report it by:
    // a sync whose only news was "somebody added a paragraph to page 4 on the
    // other device" scored all-zero, and isNoOpStats — which is derived from
    // describeSyncStats — therefore called it a no-op. The deck was pushed onto
    // `alreadyMatched`, the active deck was never reloaded, and the summary said
    // "Already up to date — everything already matches the cloud" over a snapshot
    // that had just changed on disk. The reported "it says synced but it is not
    // displaying the correct content", exactly.
    blocksMerged: 0,
    blocksRemovedHere: 0,
    // ...and the PAPER those blocks and marks are positions in. Three separate
    // things, because they are three different pieces of news and the middle one
    // is the one a reader of a notebook sees most: a document arriving, a
    // document's pages changing under them (a page added or torn out on another
    // device rewrites the file and its sha256), and a document going away.
    //
    // Flags rather than counts: a deck has two document slots and neither of them
    // is a quantity. `documentRemovedHere` is also what tells the surface to move
    // the reader off a tab whose paper no longer exists — see loadDeckSnapshot.
    documentAttached: false,
    documentPagesChanged: false,
    documentRemovedHere: false,
    // Two devices genuinely edited the notes body and the three-way merge put
    // them together without asking. Reported for the same reason a silent pull
    // is: a merge nobody was told about is indistinguishable from a sync that
    // did nothing, right up until the reader notices a sentence they did not
    // write. Distinct from notesConflicted, which means the merge could NOT do
    // it and the reader has to choose.
    notesMerged: false,
    // A push that lost a race with another device and re-merged rather than
    // overwriting it. Zero on every ordinary sync; when it is not zero it is the
    // only evidence the reader will ever have that concurrent editing is being
    // handled rather than silently resolved in somebody's favour.
    pushRetried: 0,
    // Cards another device edited since this one last synced, which this one
    // took (or merged field by field) instead of sending its older copy back.
    cardsUpdatedHere: 0,
    // Cards both devices changed in the same field, differently — this device's
    // text kept, the other's waiting in the conflict resolver.
    cardConflicts: 0,
    // What a push actually SENT beyond cards and prose, so a deck uploaded for a
    // highlight does not report itself as "reading position synced" (or as
    // nothing at all). Counted against the cloud row the push replaced.
    highlightsSent: 0,
    blocksSent: 0,
    bookmarkSent: false,
    documentSent: false,
    // A rename or folder move made on another device, taken here rather than
    // overwritten by this device's older title on the way up.
    titleAdoptedHere: false,
    categoryAdoptedHere: false,
    // meta.readingPosition (where paged/continuous reading last left off) moved.
    // This can be the ONLY thing a push actually changed — reading a book edits
    // no card and no note text — and without its own flag that push's stats
    // come back all-zero and get reported as "already up to date", which is
    // false: a write did just happen, and it's the write another device needs
    // to pick up the reader's place. See reconcile.js's pushLibraryDeckToCloud.
    readingPositionSynced: false
  };
}

// The counted stats (summed across decks), as opposed to the deck-level
// booleans below them, which are counted as "how many decks".
export const SYNC_COUNT_STATS = ["cardsAdded", "cardsDeleted", "cardsEdited", "statusChanges", "cardsMoved", "categoryChanges", "cardsKeptLocal", "cardsRemovedHere", "cardsAdoptedHere", "cardsUpdatedHere", "cardConflicts", "highlightsMerged", "highlightsRemovedHere", "highlightNotesMerged", "highlightsSent", "blocksMerged", "blocksRemovedHere", "blocksSent", "pushRetried"];

// Every field of emptySyncStats belongs to exactly one of these two lists, and a
// field in neither is dropped silently by totalSyncStats — reported per deck and
// then missing from the summary, which is how a stat ends up half-wired. There
// is an assertion for exactly that in tools/sync-reconcile-check.mjs.
export const SYNC_FLAG_STATS = ["notesChanged", "titleChanged", "deckCategoryChanged", "noteCategoriesChanged", "notesConflicted", "notesMerged", "notesSyncFailed", "deckRemovedHere", "documentAttached", "documentPagesChanged", "documentRemovedHere", "bookmarkSent", "documentSent", "titleAdoptedHere", "categoryAdoptedHere", "readingPositionSynced"];

// Human phrases for a diff, most consequential first. Returns an array so
// callers can join, count, or truncate it. With `asTotals`, the deck-level
// booleans have been summed into deck counts by totalSyncStats and say so.
//
// ── Written to be read by someone who did not watch the sync ───────────────
//
// Every phrase names the thing and says which way it went: "3 cards added",
// "2 highlights sent", "1 card updated from another device". What a phrase must
// never do is describe bookkeeping as news — the reading position moving is
// not a change anybody asked about, and reporting it ("reading position
// synced") is what made a deck uploaded for a highlight look like it had
// uploaded nothing. It is still synced; it is simply not announced.
export function describeSyncStats(stats = {}, { asTotals = false } = {}) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  const flag = (value, label) => {
    if (!value) return;
    parts.push(asTotals && value > 1 ? `${label} (${value} decks)` : label);
  };
  // What needs the reader first.
  flag(stats.notesSyncFailed, "notes could NOT be synced — run supabase_setup.sql in Supabase");
  flag(stats.notesConflicted, "a paragraph was changed differently on both devices — both versions kept, tap to choose");
  if (stats.cardConflicts) parts.push(`${plural(stats.cardConflicts, "card was", "cards were")} changed differently on both devices — tap to choose`);
  flag(stats.deckRemovedHere, "removed here (deleted on another device)");
  // The reader's own writing.
  flag(stats.notesMerged, "notes edits from both devices combined");
  flag(stats.notesChanged, "notes edited");
  flag(stats.titleChanged, "renamed");
  flag(stats.titleAdoptedHere, "renamed on another device");
  flag(stats.deckCategoryChanged, "moved to another folder");
  flag(stats.categoryAdoptedHere, "moved to another folder on another device");
  // Cards.
  if (stats.cardsAdded) parts.push(`${plural(stats.cardsAdded, "card", "cards")} added`);
  if (stats.cardsEdited) parts.push(`${plural(stats.cardsEdited, "card", "cards")} edited`);
  if (stats.cardsDeleted) parts.push(`${plural(stats.cardsDeleted, "card", "cards")} deleted`);
  if (stats.cardsUpdatedHere) parts.push(`${plural(stats.cardsUpdatedHere, "card", "cards")} updated from another device`);
  if (stats.cardsAdoptedHere) parts.push(`${plural(stats.cardsAdoptedHere, "card", "cards")} added on another device`);
  if (stats.cardsRemovedHere) parts.push(`${plural(stats.cardsRemovedHere, "card", "cards")} deleted on another device`);
  if (stats.cardsKeptLocal) parts.push(`${plural(stats.cardsKeptLocal, "card", "cards")} with newer edits here kept`);
  if (stats.statusChanges) parts.push(`${plural(stats.statusChanges, "card", "cards")} marked known/review`);
  if (stats.cardsMoved) parts.push(`${plural(stats.cardsMoved, "card", "cards")} reordered`);
  if (stats.categoryChanges) parts.push(`${plural(stats.categoryChanges, "quick note", "quick notes")} recategorised`);
  // The paper and what is written on it.
  if (stats.highlightsSent) parts.push(`${plural(stats.highlightsSent, "highlight or ink mark", "highlights and ink marks")} sent`);
  if (stats.highlightsMerged) parts.push(`${plural(stats.highlightsMerged, "highlight or ink mark", "highlights and ink marks")} from another device`);
  if (stats.highlightsRemovedHere) parts.push(`${plural(stats.highlightsRemovedHere, "highlight", "highlights")} deleted on another device`);
  if (stats.highlightNotesMerged) parts.push(`${plural(stats.highlightNotesMerged, "highlight note", "highlight notes")} combined`);
  // "text block" is the app's own word for a meta.pdfBlocks record — the + Text
  // button's own tooltip says "Add a markdown text block to the page you are
  // looking at" — so the report calls it what the control that made it calls it.
  if (stats.blocksSent) parts.push(`${plural(stats.blocksSent, "text block", "text blocks")} sent`);
  if (stats.blocksMerged) parts.push(`${plural(stats.blocksMerged, "text block", "text blocks")} from another device`);
  if (stats.blocksRemovedHere) parts.push(`${plural(stats.blocksRemovedHere, "text block", "text blocks")} deleted on another device`);
  flag(stats.documentSent, "document updated");
  flag(stats.documentAttached, "document attached on another device");
  flag(stats.documentPagesChanged, "document pages changed on another device");
  flag(stats.documentRemovedHere, "document removed on another device");
  flag(stats.bookmarkSent, "bookmark saved");
  flag(stats.noteCategoriesChanged, "quick-note categories updated");
  if (stats.pushRetried) parts.push(`${plural(stats.pushRetried, "deck", "decks")} re-merged because another device saved at the same moment`);
  return parts;
}

// ── What a push sent, beyond the cards and the prose ───────────────────────
//
// Measured against the cloud row the push replaced, so it is what actually
// went up — not what this device happens to hold. Keys that are bookkeeping
// (the reading position, link aliases, tombstones, the paper's locators) are
// not news and are not counted.
export function metaSentDelta(cloudMeta, pushedMeta) {
  const before = cloudMeta && typeof cloudMeta === "object" ? cloudMeta : {};
  const after = pushedMeta && typeof pushedMeta === "object" ? pushedMeta : {};
  const records = (meta, key) => (Array.isArray(meta[key]) ? meta[key] : []);
  const changedRecords = (key) => {
    const was = new Map(records(before, key).map((r) => [String(r?.id ?? ""), canonicalJson(r)]));
    let n = 0;
    for (const record of records(after, key)) {
      const id = String(record?.id ?? "");
      if (!id || was.get(id) !== canonicalJson(record)) n += 1;
    }
    return n;
  };
  const slot = (meta, key) => (meta[key] && typeof meta[key] === "object" ? canonicalJson(meta[key]) : "");
  const documentSent = ["pdf", "pdfs", "notebook", "pdfOrder"].some((key) => slot(before, key) !== slot(after, key));
  return {
    highlights: changedRecords("pdfHighlights"),
    blocks: changedRecords("pdfBlocks"),
    bookmark: (before.bookmark?.at || null) !== (after.bookmark?.at || null) && Boolean(after.bookmark),
    document: documentSent
  };
}

// Did the deck's quick-note category DEFINITIONS change (added, renamed,
// recoloured, removed, reordered)? Compares through quickNoteCategoriesFromMeta
// so both sides are normalised the same way and a meta bag that's a JSON string
// on one side and a parsed object on the other doesn't read as a change.
export function quickNoteCategoriesDiffer(metaA, metaB) {
  const key = (meta) => JSON.stringify(quickNoteCategoriesFromMeta(meta).map((c) => [c.id, c.name, c.color]));
  return key(metaA) !== key(metaB);
}

// ── What moved in the meta bag, in words the report already speaks ─────────
//
// Both of these are the same kind of question quickNoteCategoriesDiffer above
// asks, about two other keys, and they live here for the same reason: they are
// plain object arithmetic with no surface behind them, so a Node check can drive
// them, and the pull and the push both need the identical answer from opposite
// directions.
//
// Deliberately NOT counters threaded out of mergeDeckMeta. That function returns
// a meta bag, both of its callers depend on that shape and so does
// tools/document-sync-check.mjs; and the pull already answers "what changed"
// by diffing against oldSnapshot, which is the same shape of comparison.

// Records merged by id (meta.pdfBlocks today, and anything else that grows the
// same shape). Positional order is not a change — mergeRecordsById rebuilds the
// array — and neither is a record whose BODY moved under the same id: that is an
// edit, which the record's own `at` already settles, and calling it "added" would
// report a paragraph somebody retyped as a paragraph somebody else wrote.
export function metaRecordDelta(metaBefore, metaAfter, key) {
  const ids = (meta) => new Set(
    (Array.isArray(meta?.[key]) ? meta[key] : [])
      .map((record) => String(record?.id || ""))
      .filter(Boolean)
  );
  const before = ids(metaBefore);
  const after = ids(metaAfter);
  let adopted = 0;
  let removed = 0;
  for (const id of after) if (!before.has(id)) adopted += 1;
  for (const id of before) if (!after.has(id)) removed += 1;
  return { adopted, removed };
}

// The two document slots — the paper somebody gave us and the notebook this app
// wrote (src/documents/doc-slot.js). Answered over both at once, because the
// report's sentence is about "the document" the reader is looking at and the
// surface only ever has one of them on it.
//
// A missing sha256 on EITHER side is not a change. Rows written before the store
// recorded one are the reason, and it is the same rule documentOpenKey states in
// src/documents/pdf-view.js — an unhashed record must not read as a different
// file every time it is compared, or every sync claims the pages moved.
export function documentSlotsChanged(metaBefore, metaAfter) {
  const out = { attached: false, removed: false, pagesChanged: false };
  for (const key of ["pdf", "notebook"]) {
    const before = metaBefore?.[key] && typeof metaBefore[key] === "object" ? metaBefore[key] : null;
    const after = metaAfter?.[key] && typeof metaAfter[key] === "object" ? metaAfter[key] : null;
    if (!before && after) { out.attached = true; continue; }
    if (before && !after) { out.removed = true; continue; }
    if (!before || !after) continue;
    const a = String(before.sha256 || "");
    const b = String(after.sha256 || "");
    if (a && b && a !== b) out.pagesChanged = true;
  }
  return out;
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
