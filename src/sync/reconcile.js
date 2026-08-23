// The whole two-way sync: pull each cloud deck in, push each local deck up,
// and decide what to do when both sides changed.
//
// The deletion rules here are the highest-consequence code in the app. An
// empty cloud read is never treated as "everything was deleted"; a deletion is
// never inferred from a single absence; and a large removal always asks first.

import { LAST_USER_STORAGE_KEY } from "../boot.js?v=__BUILD__";
import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { SESSION_EXPIRED_MESSAGE, isSessionExpiredError, refreshSessionOnce, verifiedCloudUserId } from "../cloud/auth.js?v=__BUILD__";
import { CARD_FETCH_DECK_CHUNK, DECK_SYNC_INDEX_COLUMNS, deckTombstoneTableMissing, fetchCardsForDecks, fetchCloudDeckIndex, fetchCloudDeckRows, fetchDeletedDeckIds, isMissingNotesColumnError, isMissingRelationError } from "../cloud/deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, isTransientCloudError, mapWithConcurrency, withRetry, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { flushPendingStyleSync } from "../cloud/style-sync.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { laterIsoTimestamp } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeCardStatus, slugifyFileName } from "../export/markdown.js?v=__BUILD__";
import { flushPendingImageUploads } from "../images/outbox.js?v=__BUILD__";
import { splitHighlightNotesTail } from "../format/notes-fence.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { beginIndexBatch, deleteDeckFromLibrary, endIndexBatch, loadDeckFromLibrary, readLocalDeckIndex, saveDeckToLibrary, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { TOMBSTONE_ORIGIN_INFERRED, TOMBSTONE_ORIGIN_USER, clearDeckTombstone, deckTombstoneOrigin, flushPendingUntombstones, isDeckTombstoned, readDeckTombstones, removeDecksMissingFromCloud, resetActiveDeckAfterDelete, tombstoneDeck } from "../library/tombstones.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { warmDeckImageCache } from "../pwa/service-worker-client.js?v=__BUILD__";
import { flushPendingQuickNoteAnchors } from "../quick-notes/anchors.js?v=__BUILD__";
import { flushPendingQuickNoteCategories } from "../quick-notes/categories.js?v=__BUILD__";
import { QUICK_NOTES_DECK_TITLE } from "../quick-notes/palette.js?v=__BUILD__";
import { noteLinkAliasesFor } from "../render/note-links.js?v=__BUILD__";
import { deckStoreUnreadable, deleteDeckSnapshot, readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { ADOPT_DELETION_MAX_FRACTION, ADOPT_DELETION_MIN_CAP, LAST_GLOBAL_SYNC_ERROR_KEY, LAST_GLOBAL_SYNC_KEY, MISSING_DECK_MIN_AGE_MS, MISSING_DECK_MIN_SIGHTINGS, NOTES_CONFLICT_SUFFIX, clearBackgroundSyncProblem, clearMissingDeckWatch, readMissingDeckWatch, reportBackgroundSyncProblem, writeMissingDeckWatch } from "../storage/keys.js?v=__BUILD__";
import { deckAutosaveTimer, describeSyncError, isQuotaExceededError, persistWorkingDeck, setDeckAutosaveTimer } from "../storage/quota.js?v=__BUILD__";
import { rearmAutoSync } from "./auto-sync.js?v=__BUILD__";
import { cardIsDirty, cardSyncSignature, mergeCloudCardsIntoSnapshot, readCardTombstones, reconcileCardsBeforePush } from "./cards.js?v=__BUILD__";
import { calculateSyncDiff, syncTextChanged } from "./diff.js?v=__BUILD__";
import { mergeDeckMeta, mergeDocumentAnnotations, reconcileDeckBeforePush } from "./document-sync.js?v=__BUILD__";
import { refreshSyncIndicatorBaseline, renderDeckEmptyState, setSyncIndicator, updateDeckEmptyStatus } from "./indicator.js?v=__BUILD__";
import { pushDeckRowsToCloud } from "./push.js?v=__BUILD__";
import { showSyncReport } from "./report.js?v=__BUILD__";
import { describeSyncStats, emptySyncStats, isNoOpStats, quickNoteCategoriesDiffer, totalSyncStats, tsMs } from "./stats.js?v=__BUILD__";
import { commitEditIfActive } from "../ui/edit-mode.js?v=__BUILD__";
import { setButtonLoading, setStatus, showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { setStyleStatus } from "../ui/style-settings.js?v=__BUILD__";

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
async function stashLosingNotes(localId, deckTitle, losing, previous = null) {
  const prior = previous || await readDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  const carried = prior && String(prior.notes || "").trim() ? String(prior.notes) : "";
  const when = prior?.savedAt ? new Date(prior.savedAt).toLocaleString() : "an earlier sync";
  writeDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX, {
    savedAt: new Date().toISOString(),
    deckTitle: deckTitle || "",
    notes: carried && carried.trim() !== losing.trim()
      ? `${losing}\n\n---\n\n## Also replaced, on ${when}\n\n${carried}\n`
      : losing
  });
}

// Pulls one cloud deck (metadata already in hand) plus its cards into the local
// library, WITHOUT disturbing the active in-memory deck. Stamps the local copy
// with the cloud's `updated_at` so they read as in sync afterwards.
// `prefetchedCards`: this deck's cloud rows in position order if the caller
// already batch-fetched them (see fetchCardsForDecks), else null to fetch here.
export async function pullCloudDeckToLibrary(cloud, prefetchedCards = null) {
  let cards = prefetchedCards;
  if (!cards) {
    const { data, error } = await supabaseClient
      .from("cards")
      .select("*")
      .eq("deck_id", cloud.id)
      .order("position", { ascending: true });
    if (error) throw error;
    cards = data;
  }
  // Everything below merges this device's copy with the cloud's and writes the
  // result, so it must not interleave with another writer for the same deck —
  // an autosave or a quick-note pin landing mid-merge would be computed away.
  // The network fetch above is deliberately OUTSIDE the lock: it can take
  // seconds, and holding a deck lock across it would stall editing.
  // The lock id matches the localId resolved inside (both fall back to the
  // same deterministic `ld_cloud_<id>`), so they can't diverge.
  const lockId = readLocalDeckIndex().find((m) => String(m.deckId) === String(cloud.id))?.id || `ld_cloud_${cloud.id}`;
  return withDeckLock(lockId, () => pullCloudDeckIntoLibraryLocked(cloud, cards));
}

// The merge itself. Only ever called while holding this deck's lock, so it may
// assume nothing else rewrites this deck's snapshot or index entry between its
// read and its write. Must not call any other locked operation (deadlock).
export async function pullCloudDeckIntoLibraryLocked(cloud, cards) {
  const existing = readLocalDeckIndex().find((m) => String(m.deckId) === String(cloud.id));
  // Derived from cloud.id rather than a random generateLocalDeckId() when no
  // local entry exists yet: this "find existing, else create" isn't atomic
  // (read the index, then write it back), so two overlapping reconciles for
  // the SAME cloud deck — most commonly two tabs of the app open at once,
  // each with its own independent in-memory reconcile guard — can both miss
  // seeing each other's in-progress write and each mint a DIFFERENT random
  // id. Whichever's index write lands last "wins"; the other's snapshot is
  // never referenced by the index again and leaks in localStorage forever.
  // A deterministic id means both racing calls converge on the same key —
  // one just overwrites the other with equivalent data, no orphan created.
  const localId = existing?.id || `ld_cloud_${cloud.id}`;

  // Read whatever this device already holds BEFORE building the new snapshot —
  // it's both the merge base and the diff base for the sync report. Note this
  // now genuinely throws (not returns null) on a real read failure, and that
  // is deliberately allowed to abort this deck's pull (via this function's own
  // caller, which already catches per-deck) rather than treated as "no local
  // copy" — pretending a read failure means the deck never existed here would
  // merge the cloud copy in as if this device had nothing local to protect,
  // discarding any of THIS device's dirty cards for the deck in the process.
  const oldSnapshot = existing ? await readDeckSnapshot(localId) : null;

  // Distinguish "the cloud says these notes are empty" from "this row never
  // carried a notes column". Both look like a falsy `cloud.notes`, and the
  // second one used to be written as an empty string — silently destroying
  // every note in the deck. `in` is the discriminator that works: a real deck
  // row from select("*") always HAS the key (null if the user cleared it),
  // while a slim index row (DECK_INDEX_COLUMNS) has no such key at all.
  // Deliberately not a throw: keeping what this device already holds is always
  // the safe outcome, and the deck's cards can still merge normally.
  const cloudCarriesBody = Object.prototype.hasOwnProperty.call(cloud, "notes");
  if (!cloudCarriesBody) {
    console.warn(`Deck ${cloud.id} arrived without a notes column — keeping this device's notes and meta instead of blanking them.`);
  }
  const cloudNotes = cloudCarriesBody ? String(cloud.notes || "") : String(oldSnapshot?.notes || "");
  const cloudMeta = cloudCarriesBody
    ? (cloud.meta && typeof cloud.meta === "object" ? cloud.meta : {})
    : (oldSnapshot?.meta && typeof oldSnapshot.meta === "object" ? oldSnapshot.meta : {});
  // The meta bag stays cloud-wins for any key without a rule of its own — the
  // cloud row is the newer one, which is why we are pulling it. What it is NOT
  // is authoritative about the keys where every device holds a piece of the
  // truth, and taking those whole destroyed this device's copy exactly as the
  // push destroyed the other device's. linkIds was the one key that had been
  // noticed; mergeDeckMeta settles the rest of them (the paper, the bookmark, the
  // reader's place, the quick-note categories and anchors) on the same terms as
  // the push, with the preference the other way round.
  //
  // linkIds still goes through noteLinkAliasesFor afterwards, because the merge
  // cannot do the half that matters most here: adding the localId being resolved
  // right now, and sorting and capping so all devices converge on one array.
  const incomingMeta = mergeDeckMeta(cloudMeta, oldSnapshot?.meta, { prefer: "cloud" });
  incomingMeta.linkIds = noteLinkAliasesFor(incomingMeta, localId);
  // ── The document's annotations ──────────────────────────────────────────
  //
  // The second place where every device holds part of the truth. Highlighting a
  // paper on a phone in the morning and on a laptop in the afternoon writes two
  // different sets, and cloud-wins would silently throw one of them away — an
  // afternoon of reading, gone with no error and no way to tell.
  //
  // Both halves are merged, not just the records: a highlight is a record in
  // meta.pdfHighlights, but its NOTE is an entry in the fenced block at the end
  // of `notes`, and merging one without the other is what left every reader with
  // their highlights intact and the words they wrote about them replaced. See
  // src/sync/document-sync.js.
  //
  // The reader's own prose — the body above the block — is untouched by this and
  // stays cloud-wins, with the stash below catching whatever it replaces.
  //
  // The stash is read only for a deck that is actually advertising a conflict. The flag is
  // recomputed and written on every pull, so it is a reliable index of "there is
  // a stash worth looking at" — and an unconditional read here would be one more
  // IndexedDB round trip per deck per sync, on a library that can be hundreds.
  const stashed = existing?.notesConflicted ? await readDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX) : null;
  const documentMerge = mergeDocumentAnnotations({
    cloudNotes,
    cloudMeta,
    localNotes: String(oldSnapshot?.notes || ""),
    localMeta: oldSnapshot?.meta,
    body: "cloud",
    // Repair, not just prevention. A device that has been diverging since before
    // this existed has annotations stranded in its conflict stash; folding the
    // stash in as one more source is what brings them back. The stash itself is
    // only cleared below, and only when its BODY turns out to match — a stash
    // holding genuinely different prose is left exactly as it is, for its
    // existing resolver in src/sync/notes-conflict.js.
    extraTails: stashed?.notes ? [splitHighlightNotesTail(String(stashed.notes)).tail] : []
  });
  const incomingNotes = documentMerge.notes;
  if (documentMerge.pdfHighlights) incomingMeta.pdfHighlights = documentMerge.pdfHighlights;
  if (Object.keys(documentMerge.deletedHighlightIds).length) incomingMeta.deletedHighlightIds = documentMerge.deletedHighlightIds;
  else delete incomingMeta.deletedHighlightIds;

  const cloudIso = cloud.updated_at || new Date().toISOString();
  // The merge — not a replacement. See mergeCloudCardsIntoSnapshot: cards this
  // device changed and hasn't pushed yet survive the pull instead of being
  // silently destroyed by the cloud copy.
  const { cards: mergedCards, keptLocal, blockedResurrections, deletedCardIds } =
    mergeCloudCardsIntoSnapshot(oldSnapshot, cards, cloudIso);

  const snapshot = {
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: cloud.title || "",
    deckCategory: normalizeDeckCategory(cloud.category),
    notes: incomingNotes,
    sourceTitle: cloud.title || "",
    importTitleHint: cloud.title || "",
    deckId: cloud.id,
    current: Number.isFinite(cloud.current_card_index) ? cloud.current_card_index : 0,
    // Deck-level bag (quick_notes' managed category set) — a pull that dropped
    // it left every pulled note pointing at categories this device no longer
    // knew the name or colour of.
    meta: incomingMeta,
    cards: mergedCards,
    localDeckId: localId
  };
  // Deletions this device made and the cloud hasn't honoured yet. Dropping them
  // here would let the very next pull adopt the cards straight back.
  if (Object.keys(deletedCardIds).length) snapshot.deletedCardIds = deletedCardIds;

  // Deck notes are free markdown, so the card-level merge has nothing to say
  // about them and they stay last-write-wins. But losing an edit outright is
  // what this whole change exists to stop: if this device changed the notes
  // since its last confirmed sync and the cloud's copy differs, keep the losing
  // text under a sibling key so it's recoverable, and flag it in the report.
  //
  // ── Asked of the BODY only ──────────────────────────────────────────────
  //
  // A note's string is two things joined: what the reader wrote, and the fenced
  // block of highlight notes at the end of it (src/format/notes-fence.js). The
  // block is merged entry by entry above, so it is never "replaced" and there is
  // nothing to rescue — but it IS a difference, and testing the whole string
  // meant a sync whose only news was "your annotations merged" stashed a copy
  // and raised a conflict. On a PDF deck, whose body is empty because the paper
  // is the document, that is EVERY sync between two devices being read on: the
  // reported bug, exactly. So the question is put to the body.
  //
  // Through splitHighlightNotesTail rather than readerNotesBody, which is the
  // same answer by a different route: readerNotesBody memoizes ONE input, and
  // that memo belongs to the render path, where two surfaces use the returned
  // string's IDENTITY to decide "is this the same document I last painted?" on
  // every repaint of a book-sized note. A sync walking hundreds of decks through
  // it would evict that entry on every one of them.
  const oldBody = splitHighlightNotesTail(String(oldSnapshot?.notes || "")).body;
  const newBody = splitHighlightNotesTail(snapshot.notes).body;
  let notesConflicted = false;
  if (oldSnapshot && syncTextChanged(oldBody, newBody)) {
    const localNotesEdited = tsMs(existing?.updatedAt) > tsMs(existing?.lastSyncedAt);
    // Notes going from "something" to "nothing" is the destructive case, and it
    // used to be stashed only when this device had unsynced edits — so the
    // ordinary path (notes fully synced, then wiped by a bad pull) left no copy
    // at all. Whatever emptied them, a deck's entire notes body disappearing is
    // worth one recoverable copy.
    const notesBeingEmptied = oldBody.trim() && !newBody.trim();
    if ((localNotesEdited || notesBeingEmptied) && oldBody.trim()) {
      notesConflicted = true;
      // There is one stash slot per deck, and this used to write straight over
      // it — so a second conflict arriving before the first was answered
      // silently destroyed the copy the first one had rescued, which is the one
      // thing this whole mechanism exists to prevent. An unanswered stash is
      // kept and the new losing copy appended below it, so the slot only ever
      // grows until the reader resolves it.
      // `stashed` above is only read when the flag was already set; a stash can
      // outlive its flag (the resolver that accepts the synced copy clears one
      // without deleting the other), and writing over one unseen is the single
      // thing this whole mechanism exists to prevent. So look again here, where
      // the extra read is worth it and rare.
      await stashLosingNotes(localId, oldSnapshot.deckTitle || "", String(oldSnapshot.notes || ""), stashed);
    }
  } else if (stashed && !syncTextChanged(splitHighlightNotesTail(String(stashed.notes || "")).body, newBody)) {
    // ── The repair ────────────────────────────────────────────────────────
    //
    // A stash whose BODY matches what this device now holds was never a conflict
    // about prose — it is annotations, stranded by the last-write-wins this
    // change removes, and they have just been folded back in above (see
    // extraTails). So the slot is emptied and the flag cleared, which is what
    // takes a deck that has been raising a conflict on every single sync back to
    // a clean one. A stash whose body genuinely differs falls into neither
    // branch and is left exactly where it is.
    deleteDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  }

  // Diff the merged result against whatever was on this device before, for the
  // detailed sync report — a brand-new-to-this-device deck just reports its
  // total card count instead of an add/edit/delete breakdown.
  let stats;
  if (oldSnapshot) {
    const oldStatusById = Object.fromEntries((oldSnapshot.cards || []).map((c) => [String(c.id), c.status]));
    // calculateSyncDiff(local, web) reports "added" as local-only and
    // "deleted" as web-only. Here "local"=old snapshot (the outgoing side) and
    // "web"=the merged result (what this device now holds), so from the pull's
    // point of view those two are swapped: merged-only cards are what just
    // arrived, and old-only cards are what's now gone. `position` is supplied
    // because the merged cards carry none of their own — the array order IS
    // the position, and without it no reorder would ever be reported.
    const mergedForDiff = mergedCards.map((card, index) => ({ ...card, position: index }));
    const diff = calculateSyncDiff(oldSnapshot.cards || [], mergedForDiff, oldStatusById, { fuzzy: false });
    // calculateSyncDiff already separates edits from restacks, moves and
    // recategorisations — keep them apart rather than summing them into one
    // "updated" count the report can't explain.
    stats = {
      ...emptySyncStats(),
      cardsAdded: diff.deleted,
      cardsDeleted: diff.added,
      cardsEdited: diff.edited,
      cardsMoved: diff.moved,
      statusChanges: diff.statusChanges,
      categoryChanges: diff.categoryChanges,
      cardsKeptLocal: keptLocal,
      // The BODY, separately from the annotations below it. "Your notes were
      // replaced" and "your highlights merged" are not the same news, and
      // reporting them as one line meant a sync that only moved annotations read
      // as an edit to the reader's own writing.
      notesChanged: syncTextChanged(oldBody, newBody),
      highlightsMerged: documentMerge.highlightsAdopted,
      highlightsRemovedHere: documentMerge.highlightsRemoved,
      highlightNotesMerged: documentMerge.highlightNotesMerged + documentMerge.highlightNotesAdopted,
      notesConflicted,
      titleChanged: syncTextChanged(oldSnapshot.deckTitle || "", snapshot.deckTitle || ""),
      deckCategoryChanged: normalizeDeckCategory(oldSnapshot.deckCategory) !== normalizeDeckCategory(snapshot.deckCategory),
      // The quick-note category DEFINITIONS live in decks.meta, so a rename or
      // recolour on another device arrives here and nowhere else.
      noteCategoriesChanged: quickNoteCategoriesDiffer(oldSnapshot.meta, snapshot.meta),
      // Symmetric with the push side's readingPositionSynced (see
      // pushLibraryDeckToCloud): another device's reading position can be the
      // ONLY thing that moved, and it touches neither a card nor the notes
      // text, so none of the diffs above would ever notice it on their own.
      // Compared by offset, not `at` — `at` is a fresh timestamp on every
      // capture even when the position didn't actually move.
      readingPositionSynced: Boolean(snapshot.meta?.readingPosition)
        && snapshot.meta.readingPosition.offset !== oldSnapshot.meta?.readingPosition?.offset
    };
  } else {
    stats = { ...emptySyncStats(), cardsAdded: snapshot.cards.length, notesChanged: Boolean(newBody.trim()) };
  }

  writeDeckSnapshot(localId, snapshot);

  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory,
    cardCount: snapshot.cards.length,
    hasNotes: Boolean(snapshot.notes.trim()),
    // Persisted (not just in the one-off sync report) so the "Synced" pill and
    // the My Decks table keep reflecting it after the report modal is closed.
    // A pull recomputes notesConflicted authoritatively, but it says nothing
    // about whether this device's notes ever reached the cloud — only a push
    // can establish or clear that, so carry it rather than dropping it.
    notesConflicted,
    notesSyncFailed: existing?.notesSyncFailed || false,
    // Normally the cloud's timestamp, so the two read as in sync. But when the
    // merge KEPT local cards, this deck still owes the cloud a push — stamping
    // it with the cloud's time would make the push pass skip it and those
    // rescued cards would sit here forever, never reaching the other devices.
    // Same for a blocked resurrection: the cloud still holds a card this device
    // deleted, and only a push will remove it there.
    updatedAt: (keptLocal || blockedResurrections) ? new Date().toISOString() : cloudIso,
    createdAt: cloud.created_at || existing?.createdAt || cloudIso,
    // Distinct from updatedAt (which also bumps on plain local edits) — this
    // specifically means "last confirmed match with the cloud", surfaced in
    // the sync indicator pill.
    lastSyncedAt: cloudIso,
    // Take whichever "last opened" is more recent — this device's own record,
    // or the cloud's (another device may have opened it more recently).
    accessedAt: laterIsoTimestamp(existing?.accessedAt, cloud.last_accessed_at),
    deckId: String(cloud.id),
    // The merged alias set computed above — see incomingMeta. Mirrored onto the
    // index for the same reason the save path does it: the link index reads
    // this, not snapshots.
    linkIds: incomingMeta.linkIds,
  };
  writeLocalDeckIndex([meta, ...readLocalDeckIndex().filter((m) => m.id !== localId)]);
  // A deck pulled on wifi should be fully readable on the train — including its
  // images, which live on the Storage origin and are otherwise only cached once
  // they've actually been displayed.
  warmDeckImageCache(snapshot);
  return { localId, meta, stats };
}

// Pushes one library deck (by its local metadata) to the cloud, WITHOUT
// disturbing the active in-memory deck. Mints a stable cloud id if the deck has
// never been synced, then records it locally and aligns the timestamp.
export async function pushLibraryDeckToCloud(localMeta, { cloudExists = false, cloudDeck = null, webCards = null } = {}) {
  const snapshot = await readDeckSnapshot(localMeta.id);
  if (!snapshot) throw new Error("Local deck snapshot missing");

  let deckId = snapshot.deckId || localMeta.deckId || null;
  let isNewDeck = !cloudExists;
  if (!deckId) {
    const base = slugifyFileName(snapshot.deckTitle || "deck") || "deck";
    deckId = `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    isNewDeck = true;
  }

  const now = new Date().toISOString();
  const title = snapshot.deckTitle || "Untitled Deck";
  const deckCategory = normalizeDeckCategory(snapshot.deckCategory);

  // Reconcile against the deck's actual cloud rows BEFORE sending anything. The
  // push is authoritative — it prunes every cloud card missing from what we send
  // — but the copy we hold may be stale, and a stale copy pushed as-is both
  // resurrects cards other devices deleted and deletes cards they added. The
  // reconcile is only possible when we genuinely know the cloud's card list:
  // `webCards` is null for a deck the cloud doesn't have yet (nothing to
  // reconcile against) and fetchCardsForDecks now count-verifies its read and
  // throws on a short/shifted one rather than returning it, so an array here
  // is always complete. See reconcileCardsBeforePush.
  let cardsRemovedHere = 0;
  let cardsAdoptedHere = 0;
  // Ids this push is about to delete from the cloud on a tombstone's say-so.
  // Once the push lands they've served their purpose and are retired below.
  let tombstonesBeingPruned = [];
  if (cloudExists && Array.isArray(webCards)) {
    const reconciled = reconcileCardsBeforePush(snapshot, webCards);
    cardsRemovedHere = reconciled.dropped;
    cardsAdoptedHere = reconciled.adopted;
    tombstonesBeingPruned = Object.keys(reconciled.deletedCardIds);
    const tombstonesRetired = Object.keys(readCardTombstones(snapshot)).length !== tombstonesBeingPruned.length;
    snapshot.cards = reconciled.cards;
    if (tombstonesBeingPruned.length) snapshot.deletedCardIds = reconciled.deletedCardIds;
    else delete snapshot.deletedCardIds;
    // Persist it now, not after the push: the merged list is the truth about
    // this device from this moment on, and a push that fails halfway must not
    // leave the resurrections it was about to re-upload sitting in the snapshot.
    // Only when something actually moved, though — most syncs change nothing
    // here, and rewriting every deck's snapshot on every sync is pure quota
    // churn on the device where quota is already the binding constraint.
    if (cardsRemovedHere || cardsAdoptedHere || tombstonesRetired) {
      writeDeckSnapshot(localMeta.id, snapshot);
    }
  }

  // ── And the same for `notes` and `meta` ─────────────────────────────────
  //
  // The half that was missing. Both columns were sent WHOLE, so a device that
  // pushed without having pulled overwrote the cloud's highlights, every word
  // written about them, and every other key in the shared meta bag — which,
  // because the pull gate is a timestamp comparison, is exactly what a device
  // with any local edit at all does. See reconcileDeckBeforePush and
  // mergeDeckMeta.
  //
  // The merged result is written back into the snapshot too, not just sent: a
  // device that only ever pushes would otherwise never hold the other's work,
  // since its own push makes it the newest and the next sync pushes again.
  const documentPush = cloudExists ? reconcileDeckBeforePush(snapshot, cloudDeck) : null;
  // ── A cloud row we cannot read from is not a cloud row we may write over ──
  //
  // reconcileDeckBeforePush returns null for a `cloudDeck` with no `notes` key,
  // which is the slim index row (DECK_SYNC_INDEX_COLUMNS carries neither notes
  // nor meta) that the push loop falls back to when fetchCloudDeckRows had no
  // body for this deck. It refuses correctly — merging against a column it has
  // never seen would delete it — and the push then sent both columns whole
  // anyway, which is the exact outcome the refusal exists to prevent.
  //
  // The pull side has answered this since fetchCloudDeckRows was chunked: a deck
  // whose body is missing is SKIPPED rather than written from what we do not
  // know (see the `No cloud body for deck` warning below). This is the same
  // answer on the same terms. Nothing is lost — the local copy is untouched and
  // still stamped as needing a push, so the next sync carries it.
  if (cloudExists && !documentPush) {
    throw new Error("No cloud body for this deck — skipping the push rather than sending notes and meta blind");
  }
  let documentTombstonesBeingPruned = [];
  // ── The push's own stash ────────────────────────────────────────────────
  //
  // The pull has rescued a notes body it was about to replace since the day the
  // stash existed; the push had no equivalent, and it needed one for the same
  // reason with the devices the other way round.
  //
  // A push happens because this device's updatedAt is NEWER than the cloud row's.
  // That does not mean the cloud row is stale — it means both sides were edited
  // and this one was edited last. The notes body is free prose and stays
  // last-write-wins (merging two people's writing is a different problem, and
  // src/sync/notes-conflict.js is the answer to it), so this push is about to
  // replace whatever the other device wrote with whatever this one wrote, and
  // nothing anywhere kept a copy.
  //
  // Gated on the cloud row having moved since this device last confirmed a sync.
  // Without that gate every push of a deck whose body this device had legitimately
  // edited would stash the copy it is correctly superseding — a conflict raised on
  // every ordinary edit, which is the failure the pull side spent three rounds
  // learning to avoid. The BODY only, for the same reason the pull asks about the
  // body: the fenced highlight-note block is merged entry by entry above, so it is
  // never replaced and there is nothing there to rescue.
  //
  // DECIDED here, WRITTEN below — because the decision is synchronous and the
  // write is not. Everything from the `readDeckSnapshot` at the top of this
  // function down to the two writeDeckSnapshot calls is deliberately free of
  // `await`, which is what makes that read-modify-write atomic under JS's single
  // thread and is why this function does not take the deck lock (see the note on
  // the re-read further down). Awaiting the stash here would open that window,
  // and a save landing in it would be overwritten by the stale `snapshot` on the
  // very next line. The stash lives under a different key, so it is just as
  // correct a moment later.
  let notesToStash = null;
  if (documentPush && cloudDeck) {
    const cloudBody = splitHighlightNotesTail(String(cloudDeck.notes || "")).body;
    const pushedBody = splitHighlightNotesTail(String(documentPush.notes || "")).body;
    const cloudMovedSinceWeSynced = tsMs(cloudDeck.updated_at) > tsMs(localMeta.lastSyncedAt);
    if (cloudBody.trim() && cloudMovedSinceWeSynced && syncTextChanged(cloudBody, pushedBody)) {
      notesToStash = String(cloudDeck.notes || "");
    }
  }
  if (documentPush) {
    snapshot.notes = documentPush.notes;
    snapshot.meta = documentPush.meta;
    documentTombstonesBeingPruned = documentPush.tombstonesBeingPruned;
    // Same quota rule as the cards above: only when something actually moved.
    if (documentPush.changed) writeDeckSnapshot(localMeta.id, snapshot);
  }
  // Out of the critical section, and before the network write rather than after
  // it: a push that fails partway must still leave the copy it was going to
  // replace recoverable.
  const notesStashed = Boolean(notesToStash);
  if (notesToStash !== null) {
    await stashLosingNotes(localMeta.id, cloudDeck.title || snapshot.deckTitle || "", notesToStash);
  }

  // What we're about to put in the cloud, captured before the await so the
  // write-back below can tell "still the same card" from "edited during the
  // push" without trusting the snapshot object we're holding.
  const pushedCards = (snapshot.cards || []).map((c) => ({
    id: c.id, question: c.question, answer: c.answer, status: normalizeCardStatus(c.status), category: c.category || null
  }));
  const pushedSignatureById = new Map(pushedCards.map((c) => [String(c.id), cardSyncSignature(c)]));

  const pushStats = await pushDeckRowsToCloud({
    deckId,
    title,
    category: deckCategory,
    notes: snapshot.notes || "",
    meta: snapshot.meta,
    currentIndex: snapshot.current,
    cards: pushedCards,
    isNewDeck,
    overwrite: false,
    now,
    webCards
  });

  // Re-read rather than writing back the copy captured before the push. The
  // push is a multi-second network round trip and the user keeps editing during
  // it; persisting the stale in-memory snapshot silently discarded every edit
  // made in that window. Patch only what the push actually establishes. A
  // genuine read failure here throws (propagating out of this whole push) —
  // silently falling back to the pre-push `snapshot` would reintroduce exactly
  // that lost-update bug the re-read exists to prevent.
  //
  // Deliberately NOT wrapped in withDeckLock, unlike every other
  // read-modify-write of a snapshot — and that is safe, precisely because
  // there is no `await` between this read and the writes below: nothing else
  // can interleave inside the critical section. Taking the lock here would
  // mean holding it across the network call above, stalling every edit and pin
  // for the duration of a sync, which is the behaviour this app most needs to
  // avoid. The worst a concurrent locked writer can do is overwrite the
  // dirty-flag clearing below, which costs one redundant re-push and loses
  // nothing. Do not "fix" this by wrapping the whole function.
  const liveSnapshot = (await readDeckSnapshot(localMeta.id)) || snapshot;
  liveSnapshot.deckId = deckId;
  // The cloud now holds exactly `pushedCards`, so every card still matching what
  // we sent is confirmed clean. A card whose signature changed mid-push stays
  // dirty and gets picked up by the next sync — that's the point of re-reading.
  let stillDirty = false;
  for (const card of liveSnapshot.cards || []) {
    const pushedSignature = pushedSignatureById.get(String(card.id));
    if (pushedSignature !== undefined && pushedSignature === cardSyncSignature(card)) {
      card.dirty = false;
    } else if (cardIsDirty(card)) {
      stillDirty = true;
    }
  }
  // The push deleted these rows from the cloud, so the tombstones that asked for
  // it are spent. Retired one id at a time, off the RE-READ map: a card deleted
  // while this push was in flight has its own fresh tombstone that must survive.
  if (tombstonesBeingPruned.length && liveSnapshot.deletedCardIds) {
    for (const id of tombstonesBeingPruned) delete liveSnapshot.deletedCardIds[id];
    if (!Object.keys(liveSnapshot.deletedCardIds).length) delete liveSnapshot.deletedCardIds;
  }
  // The document's tombstones, retired on exactly the same terms: the meta bag
  // this push sent no longer carries those highlights, so the ids that asked for
  // it are spent. One at a time, off the re-read snapshot, so a highlight deleted
  // while the push was in flight keeps its own fresh tombstone.
  if (documentTombstonesBeingPruned.length && liveSnapshot.meta?.deletedHighlightIds) {
    for (const id of documentTombstonesBeingPruned) delete liveSnapshot.meta.deletedHighlightIds[id];
    if (!Object.keys(liveSnapshot.meta.deletedHighlightIds).length) delete liveSnapshot.meta.deletedHighlightIds;
  }
  writeDeckSnapshot(localMeta.id, liveSnapshot);

  const index = readLocalDeckIndex();
  const entry = index.find((m) => m.id === localMeta.id);
  if (entry) {
    entry.deckId = deckId;
    // Only claim "this deck now matches the cloud" if nothing changed while the
    // push was in flight. `localMeta.updatedAt` is the value the sync decided to
    // push from, so an entry that still carries it saw no edit in between.
    // Overwriting a newer stamp with `now` would make an in-flight edit read as
    // already synced, and it would never be pushed at all.
    const untouchedDuringPush = entry.updatedAt === localMeta.updatedAt;
    if (!stillDirty && untouchedDuringPush) entry.updatedAt = now;
    entry.lastSyncedAt = now;
    // Persisted onto the index (not just the one-off sync report) so the
    // "Synced" pill and the My Decks table still reflect it the next time
    // this deck is opened or listed, long after the toast is gone.
    entry.notesSyncFailed = pushStats.notesSyncFailed || false;
    // ...and the same for a body this push replaced in the cloud. The flag is
    // what src/sync/notes-conflict.js reads to offer the copy back, and it is
    // what makes the pull's `stashed` read above happen at all — a stash written
    // here with the flag left false would sit in the slot unmentioned and
    // unreachable. Only ever set, never cleared here: the pull recomputes it
    // authoritatively and the resolver clears it when the reader answers.
    if (notesStashed) entry.notesConflicted = true;
    // The push wrote every card in the snapshot, so the count is authoritative
    // — and a quick note pinned into a stub deck would otherwise keep the 0 it
    // was created with.
    entry.cardCount = (liveSnapshot.cards || []).length;
    writeLocalDeckIndex(index);
  }
  // If we just pushed the active deck (first sync), adopt its new cloud id.
  if (state.localDeckId === localMeta.id && !state.deckId) state.deckId = deckId;
  // Deck-level changes ride along on the same upsert as the cards, so they'd
  // otherwise go unreported — a rename or a notes edit on its own looked
  // identical to "nothing happened".
  const stats = { ...pushStats };
  // What the pre-push reconcile changed on THIS device, as opposed to in the
  // cloud — a deletion or an addition made on another device, landing here.
  stats.cardsRemovedHere = cardsRemovedHere;
  stats.cardsAdoptedHere = cardsAdoptedHere;
  // What the pre-push document merge picked up from the cloud — annotations made
  // on another device that this device did not have, and would have deleted by
  // sending its own copy whole.
  stats.highlightsMerged = documentPush?.highlightsAdopted || 0;
  stats.highlightsRemovedHere = documentPush?.highlightsRemoved || 0;
  stats.highlightNotesMerged = (documentPush?.highlightNotesMerged || 0) + (documentPush?.highlightNotesAdopted || 0);
  // A body this push replaced in the cloud, kept in the stash. Reported by the
  // same line the pull's is (describeSyncStats), and with the same offer to put
  // it back — the reader has just overwritten something another device wrote,
  // which is worth being told about whichever direction the sync was going.
  stats.notesConflicted = notesStashed;
  if (isNewDeck) {
    stats.notesChanged = Boolean(splitHighlightNotesTail(String(snapshot.notes || "")).body.trim());
    stats.readingPositionSynced = Boolean(snapshot.meta?.readingPosition);
  } else {
    // The reader's own body, not the fenced highlight-note block below it — the
    // block is merged rather than replaced, and counting it here made every sync
    // of a paper being read on two devices claim the notes had been edited.
    stats.notesChanged = syncTextChanged(splitHighlightNotesTail(snapshot.notes).body, splitHighlightNotesTail(String(cloudDeck?.notes || "")).body);
    stats.titleChanged = syncTextChanged(title, cloudDeck?.title || "");
    stats.deckCategoryChanged = normalizeDeckCategory(cloudDeck?.category) !== deckCategory;
    // The reader's place moved — a change no card/notes diff above would ever
    // catch, since it touches neither. Compared by offset, not by `at`: `at`
    // is a fresh Date.now() on every capture even when the reader hasn't
    // scrolled at all, which would make this true on every push.
    const localPosition = snapshot.meta?.readingPosition;
    const cloudPosition = cloudDeck?.meta?.readingPosition;
    stats.readingPositionSynced = Boolean(localPosition)
      && localPosition.offset !== cloudPosition?.offset;
  }
  // `localCardsChanged` tells the caller the on-device card list moved under the
  // user's feet, so an open deck has to be reloaded to show it (the same reason
  // a pull reloads the active deck).
  return { now, stats, localId: localMeta.id, localCardsChanged: cardsRemovedHere > 0 || cardsAdoptedHere > 0 };
}

export let reconcileInFlight = false;

// Most recent background (non-explicit) sync's report, or null once nothing's
// left to show — rendered inline on the welcome screen, never as a modal.
export let lastStartupSyncReport = null;

// The promise of the sync currently running, so an explicit "Sync Now" that
// lands during a background sync can wait for it and then run, instead of
// hitting the in-flight guard and silently doing nothing at all.
export let reconcilePromise = null;

// The full bidirectional sync. Pulls every cloud deck that's missing locally or
// newer in the cloud; pushes every local deck that's new or newer locally.
// Run a READ phase, and if it fails only because the sign-in lapsed, get a new
// token and run it once more.
//
// isTransientCloudError deliberately refuses to retry a coded PostgREST error,
// and it is right to — replaying the same request with the same dead token just
// fails again, twice as slowly. But the answer to THIS error was never to
// replay it, it was to refresh first, and nothing did. So an access token
// expiring partway through a long sync (they last about an hour; a large
// library takes minutes, and a Restore takes longer) aborted the whole run —
// and then the next run, and the one after, because each started from the same
// expired token until something happened to reload the page.
//
// READS ONLY, and deliberately. A push that fails leaves its deck stamped
// PENDING_TS (see pushDeckRowsToCloud) and is re-pushed by the next sync, which
// is the safer of the two recoveries; re-running a half-finished write pass
// after a token refresh is not something worth being clever about.
async function withSessionRetry(label, run) {
  try {
    return await run();
  } catch (error) {
    if (!isSessionExpiredError(error)) throw error;
    console.warn(`Sign-in expired during "${label}" — refreshing and retrying once`);
    if (!(await refreshSessionOnce())) throw error;
    return run();
  }
}

export async function reconcileAllDecks({ explicit = false } = {}) {
  if (!supabaseClient || !isSignedIn) {
    if (explicit) showToast("Sign in to sync with the cloud", "info");
    return;
  }
  if (!navigator.onLine) {
    if (explicit) showToast("Offline — your decks are safe on this device", "info");
    setSyncIndicator("offline");
    updateDeckEmptyStatus();
    return;
  }
  if (reconcileInFlight) {
    // A background sync was already running. Tapping the button used to return
    // right here, before any UI feedback at all — so the button didn't even
    // flicker and the sync looked broken. Wait for the run in progress, then do
    // the user's one, which is the only way to be sure it covers edits made
    // since that run started reading.
    if (!explicit) return;
    showToast("Sync already running — finishing that first", "info");
    try {
      await reconcilePromise;
    } catch (_) { /* its own handler already reported it */ }
    if (reconcileInFlight) return; // a third caller beat us to the re-run
    return reconcileAllDecks({ explicit });
  }
  reconcileInFlight = true;
  let settleReconcile;
  reconcilePromise = new Promise((resolve) => { settleReconcile = resolve; });

  if (el.syncNowBtn) setButtonLoading(el.syncNowBtn, true, "Syncing…");
  setSyncIndicator("saving");
  updateDeckEmptyStatus();

  // Says what the sync is doing RIGHT NOW, not just that it's doing something.
  // On a slow connection the old single "Syncing all decks…" sat there for the
  // whole run, so a sync that was working through 12 decks was indistinguishable
  // from one that had hung. Writes the button text directly rather than calling
  // setButtonLoading again, which would capture "Syncing…" as the label to
  // restore and leave the button stuck on it.
  //
  // The BUTTON is written on every run, background ones included. It used to be
  // explicit-only, which meant setButtonLoading's bare "Syncing…" was the first
  // and last thing a background sync ever said — and on a large library (a
  // restore leaves every deck needing a pull, then a push) that one word sat
  // there for many minutes, indistinguishable from a sync that had hung. It is
  // the only thing on screen reporting the job, so it has to report it.
  //
  // The STATUS LINE stays explicit-only: it is the app's reply to something the
  // user just did, and a background job writing over it would erase the answer
  // to whatever they were actually working on.
  // Wall clock per phase, attributed by the progress() call that opened it.
  //
  // Free — one Date.now() per phase change, of which there are about a dozen —
  // and it is the difference between "sync is slow" being a complaint and being
  // a bug report. The phases are the ones the user already sees in the button,
  // so a line in the report always corresponds to something they watched happen.
  const timings = [];
  let phaseLabel = null;
  let phaseStartedAt = Date.now();
  // Idempotent: it clears phaseLabel, so calling it before the report is built
  // AND again in the finally cannot double-count the last phase.
  const closePhase = () => {
    if (!phaseLabel) return;
    const ms = Date.now() - phaseStartedAt;
    // Same phase re-announced with a changed counter ("… (7 of 40)") is one
    // phase, not forty — accumulate rather than appending a row per deck.
    const existing = timings.find(([label]) => label === phaseLabel);
    if (existing) existing[1] += ms;
    else timings.push([phaseLabel, ms]);
    phaseLabel = null;
  };

  const progress = (message, phase = message) => {
    if (el.syncNowBtn) el.syncNowBtn.textContent = message;
    if (phase !== phaseLabel) {
      closePhase();
      phaseLabel = phase;
      phaseStartedAt = Date.now();
    }
    if (!explicit) return;
    setStatus(message);
  };
  progress("Checking the cloud…");

  // Commit any open card editor into state first. Card edit text lives only in
  // the textarea (there's no live input listener, unlike the notes editor) until
  // a blur/commit event — and a background reconcile (the auto-sync when
  // connectivity returns) fires with no such event. Left uncommitted, the edit
  // isn't in state, so the flush below can't save it: if the cloud copy then
  // reads as "newer", the pull would reload the active deck and silently drop
  // the in-progress edit. Committing lands it in state so the flush persists it
  // and it wins the last-write-wins comparison. (Mirrors flushWorkingDeck, which
  // already does this on pagehide/visibilitychange for the same reason.)
  let committedActiveEdit = false;
  try {
    committedActiveEdit = commitEditIfActive();
  } catch (error) {
    console.warn("Could not commit active edit before sync", error);
  }

  // Flush any pending debounced autosave. Without this, an edit made in the last
  // ~400ms lives only in memory (deckAutosaveTimer hasn't fired), so the library
  // copy's `updatedAt` is stale — a cloud copy could then read as "newer" and
  // the pull below would overwrite and reload the deck, silently discarding that
  // in-flight edit. Flushing writes it out and bumps the timestamp so local
  // edits correctly win the last-write-wins comparison. Also runs when we just
  // committed an editor edit above, which schedules no timer of its own.
  if (deckAutosaveTimer || committedActiveEdit) {
    if (deckAutosaveTimer) {
      clearTimeout(deckAutosaveTimer);
      setDeckAutosaveTimer(null);
    }
    persistWorkingDeck();
    await saveDeckToLibrary({ silent: true });
  }
  // commitEditIfActive updates state but doesn't re-render the card (it's
  // display-agnostic), so re-render the current card to show the committed text
  // rather than the stale pre-edit render left behind when the editor closed.
  // Local now wins last-write-wins, so the active deck won't be pulled/reloaded.
  if (committedActiveEdit) showCard();

  // A brand-new deck that's only in memory (never auto-saved) still belongs in
  // the mirror — add it so it gets pushed. Decks already in the library keep
  // their accurate timestamps and are left untouched here.
  if ((state.masterCards.length || state.notes.trim()) && !state.localDeckId) {
    await saveDeckToLibrary({ silent: true });
  }

  const activeDeckId = state.deckId;
  let activePulledLocalId = null;
  let pulled = 0, pushed = 0, failed = 0;
  // Decks whose timestamp said "newer" but whose content already matched the
  // cloud. Not nothing: it's what a live write (e.g. recategorising a quick
  // note, which saves to the cloud the moment you tap it) looks like by the
  // time the sync runs — so the summary can say the changes are already safe
  // instead of the bare, alarming "nothing to sync".
  const alreadyMatched = [];
  // Per-deck breakdown for the detailed sync report — every deck actually
  // touched (or that failed) gets an entry naming it, its direction, and
  // exactly what changed (cards added/updated/deleted, notes).
  const deckLog = [];

  try {
    // Local integrity before anything else: if this device's deck bodies could
    // not be read (see deckStoreUnreadable), every deck looks empty here while
    // the real contents sit intact on disk. Syncing on that reading is how a
    // one-off read failure becomes permanent loss — the push would send empty
    // decks and prune the cloud's cards to match. Same rule the cloud side
    // already follows: absence that can't be trusted is not a fact.
    if (deckStoreUnreadable) {
      console.warn("Sync skipped — this device's deck contents could not be read this session.");
      setSyncIndicator("error");
      if (explicit) {
        setStatus("Couldn't read this device's decks — reload the app before syncing. Nothing was changed.", "error");
        showToast("Couldn't read this device's decks — reload before syncing", "error");
      }
      return;
    }

    // Identity next, before a single byte is read or written. Every table is
    // RLS-scoped to auth.uid(), so a query made without a valid user token comes
    // back EMPTY AND SUCCESSFUL — and the deletion rules further down read an
    // empty cloud as "deleted on another device". Sync as nobody, lose the
    // library. See verifiedCloudUserId.
    progress("Checking your sign-in…");
    const cloudUserId = await verifiedCloudUserId();
    if (!cloudUserId) {
      // Not an error state to shout about: a lapsed token on a phone that's been
      // in a pocket for a week is routine. It is, however, an absolute bar on
      // syncing — treat it exactly like being offline, which is the one state
      // this app already handles by leaving every local deck alone.
      console.warn("Sync skipped — no verified session; refusing to sync as an unauthenticated user.");
      // "signedout", not "offline". Refusing to sync here is correct and stays;
      // what was wrong was reporting it as a network problem, which left the
      // user with nothing to act on and no reason to think signing in would
      // help. See the labels in setSyncIndicator.
      setSyncIndicator("signedout");
      if (explicit) {
        setStatus("Couldn't confirm you're signed in — sign in again to sync. Your decks are safe on this device.", "error");
        showToast("Couldn't confirm your sign-in — your decks are safe on this device", "error");
      } else {
        // Background runs used to say nothing at all here, so a session that
        // lapsed while the app was closed simply stopped syncing, silently,
        // until the user happened to press Sign Now. Reported once per lapse.
        reportBackgroundSyncProblem(
          "signed-out",
          "Signed out — sign in again to resume syncing. Your decks are safe on this device."
        );
      }
      return;
    }
    // The local library mirrors exactly one account. If the verified user isn't
    // the one this library belongs to, every comparison below is meaningless:
    // the other account's (correctly empty-for-us) deck list would read as a
    // mass deletion. ensureLocalLibraryOwner normally resets the library on an
    // account switch; this is the backstop for when it didn't run.
    const libraryOwner = (() => {
      try { return localStorage.getItem(LAST_USER_STORAGE_KEY); } catch { return null; }
    })();
    if (libraryOwner && libraryOwner !== cloudUserId) {
      console.warn("Sync skipped — the signed-in account doesn't own this device's deck library.");
      setSyncIndicator("error");
      if (explicit) {
        setStatus("This device's decks belong to a different account — sign out and back in to sync them.", "error");
        showToast("Signed-in account doesn't match this device's decks", "error");
      }
      return;
    }

    // Deliver every queued decks.meta edit — quick-note categories and source
    // anchors — BEFORE reading the deck list. Order is the whole point: the pull
    // below replaces the local snapshot's meta with the cloud's copy, so
    // flushing afterwards would be racing the very thing that erases the edit.
    // Flushing first also means the pull reads a cloud that already agrees with
    // us, and so reports no spurious category change. Sequential, not parallel:
    // both read-merge-write the same JSON blob (serialiseQuickNoteMetaWrite
    // enforces it anyway, but pretending they're independent here would be
    // misleading).
    progress("Sending queued note changes…");
    const noteCategoriesFlushed = await flushPendingQuickNoteCategories();
    const noteAnchorsFlushed = await flushPendingQuickNoteAnchors();
    // Retire the delete tombstones of any deck a restore explicitly brought
    // back. Ordering is load-bearing: this MUST land before the tombstone list
    // is read below, or the passes that act on it would re-delete the very deck
    // the user just restored. See flushPendingUntombstones.
    await flushPendingUntombstones();
    // Independent of the deck data and of the meta blob, so these don't need to
    // hold up the deck list — just don't let a failure sink the whole sync.
    const styleFlush = flushPendingStyleSync().catch((error) => {
      console.warn("Could not deliver the queued style", error);
      return false;
    });
    // Images queued while offline. Awaited BEFORE the deck list is read: each
    // upload rewrites its recall-img: placeholder in the owning deck's snapshot
    // and bumps that deck's updatedAt, and the push pass below is what carries
    // the rewritten markdown up. Flushing later would miss this run entirely.
    //
    // Counted WHILE it runs, not just afterwards. A backlog here is real
    // uploading — potentially hundreds of megabytes of it — happening before a
    // single deck has been looked at, and reporting it only on completion is
    // what made a working sync read as a stuck one.
    let imagesUploaded = 0;
    try {
      imagesUploaded = await flushPendingImageUploads((done, total) => {
        progress(`Uploading queued images… (${done} of ${total})`, "Uploading queued images");
      });
      if (imagesUploaded) {
        progress(`Uploaded ${imagesUploaded} queued image${imagesUploaded === 1 ? "" : "s"}…`);
        // The rewrite touched state as well as the snapshots, so repaint — the
        // on-screen copy is otherwise still pointing at the blob placeholder.
        showCard();
        renderNotesViewPinned();
      }
    } catch (error) {
      console.warn("Could not deliver queued images", error);
    }

    // The deck index and the deletion tombstones don't depend on each other, so
    // fetch them together — serially they cost two full round trips before any
    // real work could start. The INDEX, not the full list: this pass only
    // compares timestamps, and pulling every deck's notes body to do that was
    // the single largest thing a sync transferred (see fetchCloudDeckIndex).
    // This pair is also the reachability probe. navigator.onLine only reports
    // whether there's a network interface, so on a phone it reads `true` on a
    // dead cell or behind a captive portal — and the sync would then grind
    // through a 20-second timeout per deck before giving up. If the very first
    // request can't get out, treat the cloud as unreachable and stop here.
    progress("Reading the deck list…");
    let cloudDecks, remoteDeletedIds;
    try {
      [cloudDecks, remoteDeletedIds] = await withSessionRetry("deck list", () => Promise.all([
        withRetry(() => fetchCloudDeckIndex(DECK_SYNC_INDEX_COLUMNS), { label: "deck index" }),
        withRetry(() => fetchDeletedDeckIds(), { label: "tombstones" })
      ]));
    } catch (error) {
      if (!isTransientCloudError(error)) throw error;
      setSyncIndicator("offline");
      if (explicit) {
        setStatus("Couldn't reach the cloud — your decks are safe on this device.", "error");
        showToast("Couldn't reach the cloud — check your connection", "error");
      }
      return;
    }
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudIdSet = new Set(cloudDecks.map((d) => String(d.id)));

    // Without the tombstone table, deleting a deck is a one-device-only event:
    // every other device still holding it pushes it back on its next sync and
    // the deck reappears everywhere. The user can't diagnose that from the app,
    // so say it — once per explicit sync, with the fix.
    // A missing table is not a transient fault — it is permanent until somebody
    // runs the SQL, so a background sync staying quiet about it meant the user
    // could go on deleting decks that silently came back forever. Reported on
    // background runs too, once, via the same per-kind gate.
    if (deckTombstoneTableMissing) {
      if (explicit) {
        showToast("Deck deletions can't sync — run supabase_setup.sql in Supabase", "error");
      } else {
        reportBackgroundSyncProblem(
          "tombstones-missing",
          "Deck deletions can't sync — run supabase_setup.sql in Supabase"
        );
      }
    }

    // Cross-device delete: a deck this device never tombstoned locally, but
    // that another device deleted (and recorded in the shared deleted_decks
    // table). Adopt the tombstone and remove the stale local copy now, before
    // the push loop below would otherwise see "no cloud row, so mine must be
    // newer" and re-create it.
    const remoteDeletedSet = new Set(remoteDeletedIds.map(String));
    // The cap applies here too, and not out of theoretical tidiness: the bug this
    // guard replaced PUBLISHED its bad guesses to deleted_decks, so a project can
    // still be carrying real tombstones for decks nobody ever deleted. Those rows
    // outlive the code that wrote them, and a device that still holds the only
    // surviving copies would otherwise honour them on its very next sync — losing
    // the data a second time, from the one place it survived. A handful of
    // tombstones is an ordinary cross-device delete and still applies instantly;
    // a mass one is a question for the user.
    const localIndexBeforeDeletes = readLocalDeckIndex();
    const syncedLocalCount = localIndexBeforeDeletes.filter((m) => m.deckId && m.lastSyncedAt).length;
    const removalCap = Math.max(ADOPT_DELETION_MIN_CAP, Math.floor(syncedLocalCount * ADOPT_DELETION_MAX_FRACTION));

    const remoteTombstoneRemovals = [];
    for (const deckId of remoteDeletedIds) {
      if (isDeckTombstoned(deckId)) continue;
      const staleLocal = localIndexBeforeDeletes.find((m) => String(m.deckId) === String(deckId));
      remoteTombstoneRemovals.push({
        deckId: String(deckId),
        meta: staleLocal || null,
        title: staleLocal?.title || "Untitled deck",
        origin: TOMBSTONE_ORIGIN_USER
      });
    }
    // Only removals that actually cost the user a deck count toward the cap —
    // a tombstone for a deck this device never had is free to adopt.
    const remoteTombstoneWithLocalCopy = remoteTombstoneRemovals.filter((entry) => entry.meta);
    // Decks whose removal is deferred to the confirmation prompt; the passes
    // below must leave them completely alone in the meantime.
    let deferredRemoteRemovals = [];
    if (remoteTombstoneWithLocalCopy.length > removalCap) {
      deferredRemoteRemovals = remoteTombstoneWithLocalCopy;
      console.warn(
        `${deferredRemoteRemovals.length} decks are tombstoned in the cloud (cap ${removalCap}) — ` +
        "held on this device pending confirmation. Nothing was removed."
      );
    }
    const deferredRemoteIds = new Set(deferredRemoteRemovals.map((entry) => entry.deckId));
    for (const entry of remoteTombstoneRemovals) {
      if (deferredRemoteIds.has(entry.deckId)) continue;
      // A shared record is positive evidence that a human deleted this deck, so
      // the tombstone is "user"-grade: it's echoing a real deletion, not guessing.
      tombstoneDeck(entry.deckId, TOMBSTONE_ORIGIN_USER);
      if (entry.meta) {
        const wasActive = state.deckId && String(state.deckId) === entry.deckId;
        deleteDeckFromLibrary(entry.meta.id);
        if (wasActive) resetActiveDeckAfterDelete();
      }
    }

    // ── Decks missing from the cloud ────────────────────────────────────────
    // A deck this device confirmed in the cloud (deckId + lastSyncedAt) that is
    // no longer in the cloud's list was PROBABLY deleted on another device —
    // and acting on "probably" is what cost this app a library.
    //
    // The rule used to be one-shot: absent once, deleted forever, local copy
    // removed and a permanent shared tombstone published for every device. That
    // is only sound if a missing deck can ONLY mean a deletion, and it can't. An
    // unauthenticated read (RLS returns zero rows, no error), a half-delivered
    // page, a project whose rows lost their user_id — every one of them looks
    // identical to "the user deleted everything", and the damage is unbounded
    // and unrecoverable.
    //
    // So absence is now treated as evidence to be corroborated, not a fact:
    //
    //   1. an empty cloud list is never evidence of anything (see below);
    //   2. a deck must be seen missing by two separate syncs, minutes apart,
    //      before its absence counts — one bad read can no longer delete;
    //   3. removals above the blast-radius cap need the user to say yes;
    //   4. nothing derived this way is ever published to deleted_decks.
    //
    // Until a deck's absence is corroborated it is HELD: not deleted, and not
    // pushed either (the push pass skips heldDeckIds). Holding rather than
    // pushing is what stops a genuine cross-device delete from bouncing back
    // during the wait, so the slower rule costs correctness nothing.
    const localIndexNow = readLocalDeckIndex();
    const syncedLocalDecks = localIndexNow.filter((m) => m.deckId && m.lastSyncedAt);
    const missingFromCloud = syncedLocalDecks.filter(
      (m) => !cloudIdSet.has(String(m.deckId)) &&
             !isDeckTombstoned(m.deckId) &&
             // Already awaiting the user's decision on the tombstone pass above.
             // They're missing from the cloud too (that's what a tombstone means),
             // so without this they'd be counted a second time here.
             !deferredRemoteIds.has(String(m.deckId))
    );

    // An empty deck list from a device that is holding synced decks is the exact
    // signature of the bug this guard exists for. It is technically also what
    // "the user deleted every last deck elsewhere" looks like — but that is rare,
    // recoverable (the decks are still here, and get re-pushed), and explicitly
    // recorded in deleted_decks when it really happens, which the pass above
    // already honours. Guessing wrong the other way is unrecoverable. Never
    // delete a library on a zero-row read.
    const cloudListLooksBlank = cloudDecks.length === 0 && syncedLocalDecks.length > 0;
    if (cloudListLooksBlank) {
      console.warn(
        `Cloud returned 0 decks while this device holds ${syncedLocalDecks.length} synced deck(s) — ` +
        "refusing to treat that as deletions. Nothing was removed."
      );
    }

    // Watchlist of "seen missing, not yet acted on", persisted so the two
    // observations can span app launches — the common case is a phone that syncs
    // once on open and is put away again.
    const missingWatch = readMissingDeckWatch();
    const nowMs = Date.now();
    const heldDeckIds = new Set();      // don't delete, and don't push, this run
    const qualifiedForRemoval = [];     // absence corroborated; eligible to act on

    if (cloudListLooksBlank) {
      // Hold everything, and keep the watchlist untouched: a blank read is not an
      // observation, and must not count as one of the two sightings.
      for (const meta of missingFromCloud) heldDeckIds.add(String(meta.deckId));
    } else {
      for (const meta of missingFromCloud) {
        const deckId = String(meta.deckId);
        const seen = missingWatch[deckId];
        const firstMissingAt = seen?.firstMissingAt ? tsMs(seen.firstMissingAt) : nowMs;
        const sightings = (seen?.sightings || 0) + 1;
        missingWatch[deckId] = {
          firstMissingAt: seen?.firstMissingAt || new Date(nowMs).toISOString(),
          sightings,
          title: meta.title || "Untitled deck"
        };
        const corroborated =
          sightings >= MISSING_DECK_MIN_SIGHTINGS &&
          nowMs - firstMissingAt >= MISSING_DECK_MIN_AGE_MS;
        if (corroborated) qualifiedForRemoval.push({ title: meta.title || "Untitled deck", deckId, id: meta.id });
        else heldDeckIds.add(deckId);
      }
      // Anything present again (or already gone from the library) leaves the
      // watchlist, so a deck has to be missing on CONSECUTIVE syncs to count.
      const stillMissing = new Set(missingFromCloud.map((m) => String(m.deckId)));
      for (const deckId of Object.keys(missingWatch)) {
        if (!stillMissing.has(deckId)) delete missingWatch[deckId];
      }
    }
    writeMissingDeckWatch(missingWatch);

    // Blast-radius cap. Losing a deck to a wrong guess is bad; losing a library
    // to one is the reported disaster. Past the cap this stops being a routine
    // sync outcome and becomes something a human should look at, so the decks
    // are held intact and the user is asked. Small removals (the everyday "I
    // deleted a deck on my laptop") still just work.
    let removalNeedsConfirmation = deferredRemoteRemovals.length ? deferredRemoteRemovals.slice() : null;
    for (const entry of deferredRemoteRemovals) heldDeckIds.add(entry.deckId);
    if (qualifiedForRemoval.length > removalCap) {
      console.warn(
        `${qualifiedForRemoval.length} decks are missing from the cloud (cap ${removalCap}) — ` +
        "held on this device pending confirmation. Nothing was removed."
      );
      for (const entry of qualifiedForRemoval) heldDeckIds.add(entry.deckId);
      removalNeedsConfirmation = (removalNeedsConfirmation || []).concat(qualifiedForRemoval);
      qualifiedForRemoval.length = 0;
    }

    const adoptedDeletions = [];
    for (const entry of qualifiedForRemoval) {
      adoptedDeletions.push({ title: entry.title, deckId: entry.deckId });
      // Local-only tombstone: it stops THIS device re-pushing the deck, without
      // publishing a guess that no device could ever undo. See tombstoneDeck.
      tombstoneDeck(entry.deckId, TOMBSTONE_ORIGIN_INFERRED);
      const wasActive = state.deckId && String(state.deckId) === entry.deckId;
      deleteDeckFromLibrary(entry.id);
      if (wasActive) resetActiveDeckAfterDelete();
      delete missingWatch[entry.deckId];
    }
    if (adoptedDeletions.length) {
      writeMissingDeckWatch(missingWatch);
      // Named in the report rather than counted silently — decks vanishing is
      // the correct outcome here, but it must never be a surprise.
      for (const entry of adoptedDeletions) {
        deckLog.push({ title: entry.title, direction: "removed", ...emptySyncStats(), deckRemovedHere: true });
      }
    }

    // Reconcile local tombstones against the cloud. A tombstone may only be
    // forgotten once the deck row is gone AND its durable cross-device record
    // (deleted_decks) is in place. Pruning on "row is gone" alone is unsafe:
    // if the original delete's deleted_decks write failed, another device that
    // still holds a copy would re-push it and resurrect the deck. When the row
    // is gone but that shared record is missing, re-assert it here and keep the
    // local tombstone until it lands.
    const tombstonesToReassert = [];
    for (const tid of Object.keys(readDeckTombstones())) {
      // Deck row still present (or re-pushed by another device) — the pull loop
      // below re-deletes it; keep blocking so it can't be adopted back locally.
      if (cloudIdSet.has(String(tid))) continue;
      if (remoteDeletedSet.has(String(tid))) {
        clearDeckTombstone(tid); // fully propagated — safe to forget
      } else if (deckTombstoneOrigin(tid) === TOMBSTONE_ORIGIN_INFERRED) {
        // Nobody deleted this deck here — this device only concluded it was
        // gone. Publishing that conclusion is what turned one device's bad read
        // into a permanent, cross-device deletion, so an inferred tombstone
        // stays local. It keeps doing its real job (never re-push this deck)
        // and every other device can observe the same absence for itself.
        continue;
      } else {
        tombstonesToReassert.push({ deck_id: tid });
      }
    }
    if (tombstonesToReassert.length) {
      // One upsert for every outstanding tombstone rather than a round trip
      // each. supabase-js reports failures via the returned `error`, not by
      // throwing — check it, or a failed write looks like success.
      const { error: retryError } = await withTimeout(abortable((signal) => supabaseClient.from("deleted_decks").upsert(tombstonesToReassert).abortSignal(signal)), CLOUD_TIMEOUT_MS, "reassert tombstones");
      if (retryError) console.warn("Retry of cross-device delete tombstones failed", retryError);
    }

    // 1) Cloud → local: pull anything missing locally or newer in the cloud.
    //    Decide the whole list up front so the cards for every deck being
    //    pulled can be fetched in one request instead of one per deck.
    const localByDeckId = new Map(
      readLocalDeckIndex().filter((m) => m.deckId).map((m) => [String(m.deckId), m])
    );
    const toPull = [];
    const tombstonedInCloud = [];
    for (const cloud of cloudDecks) {
      // A deck deleted here but still (or again) present in the cloud — e.g. a
      // race with an in-flight sync, or another device that re-pushed it. Don't
      // pull it back; re-assert the deletion in the cloud instead.
      if (isDeckTombstoned(cloud.id)) {
        // ...unless the tombstone was only ever a guess. This device concluded
        // the deck was deleted because the cloud didn't list it; the cloud is
        // now listing it, which means the conclusion was wrong (or another
        // device has a copy it believes in). Letting a guess reach the delete
        // below would destroy the cloud row — the guess would come true. Retract
        // it instead and let the deck be pulled back. If it really was deleted,
        // the device that deleted it holds a real tombstone and will re-delete
        // it; a deck that bounces once is recoverable, a deleted one is not.
        if (deckTombstoneOrigin(cloud.id) === TOMBSTONE_ORIGIN_INFERRED) {
          console.warn(`Deck ${cloud.id} is back in the cloud — retracting this device's inferred deletion.`);
          clearDeckTombstone(cloud.id);
          clearMissingDeckWatch(cloud.id);
        } else {
          tombstonedInCloud.push(cloud.id);
          continue;
        }
      }
      const localMeta = localByDeckId.get(String(cloud.id));
      if (!localMeta) {
        toPull.push(cloud);
        continue;
      }
      // Never pushed and never pulled, yet the cloud already has this id. The
      // local copy is a stub someone started here (a quick note pinned on a
      // device that had never synced quick_notes, say) — pushing it FIRST would
      // treat its handful of cards as the complete deck and prune every cloud
      // card missing from it. Pull-and-merge first; the merge keeps the local
      // additions, bumps updatedAt, and the push pass below then sends the union.
      if (!localMeta.lastSyncedAt) {
        toPull.push(cloud);
        continue;
      }
      if (tsMs(cloud.updated_at) > tsMs(localMeta.updatedAt)) toPull.push(cloud);
    }
    if (tombstonedInCloud.length) {
      // Record the durable cross-device tombstones BEFORE deleting the rows,
      // and for every id — not just the ones the loop above found missing from
      // the cloud. A deck deleted while offline reaches this branch with its
      // row still present and no deleted_decks entry, so skipping the write
      // here left a whole sync cycle in which another device holding a copy
      // would see a live-looking deck and push it straight back.
      const missingRecords = tombstonedInCloud
        .filter((id) => !remoteDeletedSet.has(String(id)))
        .map((id) => ({ deck_id: id }));
      if (missingRecords.length) {
        const { error: recordError } = await withTimeout(abortable((signal) => supabaseClient.from("deleted_decks").upsert(missingRecords).abortSignal(signal)), CLOUD_TIMEOUT_MS, "record delete tombstones");
        if (recordError) console.warn("Could not record cross-device delete tombstones", recordError);
        else for (const row of missingRecords) remoteDeletedSet.add(String(row.deck_id));
      }
      // CHUNKED, for the reason CARD_FETCH_DECK_CHUNK spells out at length: an
      // `.in()` list becomes part of the request URL, a uuid costs ~46
      // characters percent-encoded, and past a few hundred ids the request line
      // crosses the 8KB ceiling nginx and most proxies ship with. The server
      // answers 414 and this silently stops working — at a library size the
      // developer is unlikely to have, and which one Restore reaches in a single
      // step. Sequential: these are deletes, and there is no hurry.
      for (let i = 0; i < tombstonedInCloud.length; i += CARD_FETCH_DECK_CHUNK) {
        const chunk = tombstonedInCloud.slice(i, i + CARD_FETCH_DECK_CHUNK);
        const { error: redeleteError } = await withTimeout(abortable((signal) => supabaseClient.from("decks").delete().in("id", chunk).abortSignal(signal)), CLOUD_TIMEOUT_MS, "re-delete decks");
        if (redeleteError) console.warn("Tombstone re-delete failed", chunk, redeleteError);
      }
    }

    if (toPull.length) progress(`Downloading ${toPull.length} deck${toPull.length === 1 ? "" : "s"} from the cloud…`, "Downloading decks");
    // Cards and deck BODIES together: the index rows above carry no notes or
    // meta, and the pull needs both. Two requests in parallel, for only the
    // decks actually being pulled, instead of every deck's notes up front.
    const [pullCardsByDeck, pullBodyById] = toPull.length
      ? await withSessionRetry("download decks", () => Promise.all([
          withRetry(() => fetchCardsForDecks(toPull.map((d) => d.id)), { label: "deck cards" }),
          withRetry(() => fetchCloudDeckRows(toPull.map((d) => d.id)), { label: "deck bodies" })
        ]))
      : [new Map(), new Map()];

    // Counted as well as announced. The one-line "Downloading 721 decks…" above
    // covers the two batched requests; the merge loop below is per deck, awaits
    // a lock and a snapshot read/write each time, and on a restored library is
    // by far the longer half of the two. The original note here said the loop
    // never yields so a counter could not paint — it awaits pullCloudDeckToLibrary
    // on every iteration, so it does, and without the counter this is exactly
    // where a long sync looks stopped.
    // Batch the deck-index writes for the length of this loop. Each iteration
    // rewrites the WHOLE index — one localStorage.setItem of the entire library
    // per deck — so a 700-deck pull did 700 synchronous ~200KB disk writes on
    // the main thread. That, not the network, is what made a large sync feel
    // like the app had locked up. endIndexBatch is in the finally below.
    beginIndexBatch();
    let pullDone = 0;
    for (const indexRow of toPull) {
      progress(`Saving decks from the cloud… (${++pullDone} of ${toPull.length})`, "Saving decks from the cloud");
      // The full row, and ONLY the full row. This used to fall back to the index
      // row when the body was missing, so that a deck deleted between the two
      // requests still pulled "what we know" instead of throwing. But
      // DECK_INDEX_COLUMNS selects no `notes` and no `meta`, so what we knew was
      // a deck with no notes — and the pull wrote that over the real ones,
      // destroying every note in the deck (and the quick-note category
      // definitions with them). Skipping is the only safe reading of a missing
      // body: nothing is written, the local copy stands, and the deck pulls
      // normally on the next sync if it does still exist.
      const cloud = pullBodyById.get(String(indexRow.id));
      if (!cloud) {
        console.warn(`No cloud body for deck ${indexRow.id} — skipping the pull rather than writing a deck with no notes.`);
        continue;
      }
      try {
        const res = await pullCloudDeckToLibrary(cloud, pullCardsByDeck.get(String(cloud.id)) || []);
        if (!isNoOpStats(res.stats)) {
          pulled++;
          // localId rides along so the report's "Restore my notes" button knows
          // which deck's stash to put back.
          deckLog.push({ title: cloud.title || "Untitled deck", direction: "pulled", localId: res.localId, ...res.stats });
          // Only reload the on-screen deck when the pull actually changed its
          // content. A no-op pull (cloud read "newer" purely from a timestamp
          // artifact, with identical cards/notes) must NOT reload — doing so
          // would reset the user's live study position to the cloud's index
          // for no real reason.
          if (activeDeckId && String(cloud.id) === String(activeDeckId)) activePulledLocalId = res.localId;
        } else {
          alreadyMatched.push(cloud.title || "Untitled deck");
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: cloud.title || "Untitled deck", direction: "failed", error: describeSyncError(e) });
        console.warn("Reconcile pull failed", cloud.id, e);
      }
    }

    // 2) Local → cloud: push anything not in the cloud or newer locally.
    //    Re-read the index because the pull pass may have rewritten it, and
    //    again decide the whole list up front so every deck's existing cloud
    //    rows (which the push diffs against) come back in one request.
    const toPush = [];
    for (const localMeta of readLocalDeckIndex()) {
      // Never re-upload a deck that was deleted here (a stray local copy that
      // outlived the delete) — that's exactly how a deleted deck comes back.
      if (isDeckTombstoned(localMeta.deckId)) continue;
      // Missing from the cloud, but not yet believed to be deleted (see the
      // missing-decks block above). Sit this run out entirely: pushing would
      // resurrect a deck another device may genuinely have deleted, and would
      // also erase the very evidence being gathered — the deck would be present
      // again next sync, resetting the count forever. Held, not lost: the local
      // copy is untouched and it pushes as normal the moment it's cleared.
      if (localMeta.deckId && heldDeckIds.has(String(localMeta.deckId))) continue;
      const cloud = localMeta.deckId ? cloudById.get(String(localMeta.deckId)) : null;
      if (!cloud || tsMs(localMeta.updatedAt) > tsMs(cloud.updated_at)) toPush.push({ localMeta, cloud });
    }

    // Only decks that already exist in the cloud have rows to diff against; a
    // brand-new deck's push writes every card regardless. Bodies are fetched
    // alongside the cards because pushLibraryDeckToCloud compares against
    // cloudDeck.notes/title/category to report what changed — the slim index
    // rows have no notes, so without this every push would claim "notes edited".
    const pushDiffIds = toPush.filter((e) => e.cloud).map((e) => e.localMeta.deckId);
    const [pushCardsByDeck, pushBodyById] = pushDiffIds.length
      ? await withSessionRetry("read decks to diff", () => Promise.all([
          withRetry(() => fetchCardsForDecks(pushDiffIds, "id, deck_id, question, answer, position, status, category"), { label: "push diff cards" }),
          withRetry(() => fetchCloudDeckRows(pushDiffIds), { label: "push diff bodies" })
        ]))
      : [new Map(), new Map()];

    // Bounded concurrency, not one deck at a time. Each push is ≥3 sequential
    // round trips, so a 20-deck sync used to spend almost all of its wall clock
    // waiting on a phone's latency rather than transferring anything. Three at a
    // time keeps well inside the browser's per-host connection limit while
    // cutting the total wait by roughly the same factor.
    //
    // Safe to parallelise because the read-modify-write of the shared deck index
    // inside pushLibraryDeckToCloud contains no `await` between its read and its
    // write, so it is atomic under JS's single thread. Do not add one.
    // Same for the push pass, which rewrites the index once per deck too.
    // Reentrant with the pull batch above, and the flush is in the same finally.
    beginIndexBatch();

    // Re-confirm the sign-in before writing anything.
    //
    // verifiedCloudUserId ran once at the top, and everything since then — the
    // image uploads, the deck list, the pull of every changed deck — can take
    // minutes on a large library. An access token lasts about an hour, so on a
    // Restore it can genuinely lapse in between, and the writes about to start
    // are the half where running as nobody is expensive: an RLS-scoped write
    // that matches nothing succeeds and does nothing, so a push would report
    // success, stamp every deck as synced, and have uploaded none of it.
    //
    // Free when the token is live (getSession reads local storage), and it
    // refreshes when it can rather than giving up.
    if (toPush.length) {
      let stillSignedIn = await verifiedCloudUserId();
      if (!stillSignedIn && await refreshSessionOnce()) stillSignedIn = await verifiedCloudUserId();
      if (!stillSignedIn) {
        // Not a failure of the pull that already succeeded — say what happened
        // and stop, leaving every local deck exactly as it is. Everything still
        // needing a push is still marked as needing one, so the next sync after
        // a sign-in carries it.
        console.warn("Sync stopped before pushing — the sign-in lapsed mid-run.");
        setSyncIndicator("signedout");
        if (explicit) {
          setStatus(SESSION_EXPIRED_MESSAGE, "error");
          showToast("Your sign-in expired — sign in again", "error");
        } else {
          reportBackgroundSyncProblem("signed-out", SESSION_EXPIRED_MESSAGE);
        }
        return;
      }
    }

    let pushDone = 0;
    await mapWithConcurrency(toPush, 3, async ({ localMeta, cloud }) => {
      try {
        // The full row, and ONLY the full row — the same rule, and the same
        // reason, as the pull loop above. This used to fall back to the slim
        // index row (`|| cloud`), and DECK_SYNC_INDEX_COLUMNS selects neither
        // `notes` nor `meta`: the pre-push merge cannot run against a row that
        // carries neither, so it correctly refused, and the push then sent both
        // columns whole — overwriting the cloud's highlights, the words written
        // about them and every other key in the shared meta bag with whatever
        // this device happened to hold. Skipping is the only safe reading of a
        // missing body: nothing is sent, the local copy is untouched and still
        // stamped as needing a push, and the deck goes up on the next sync.
        const cloudBody = cloud ? pushBodyById.get(String(localMeta.deckId)) : null;
        if (cloud && !cloudBody) {
          console.warn(`No cloud body for deck ${localMeta.deckId} — skipping the push rather than sending its notes and meta blind.`);
          pushDone++;
          progress(`Uploading decks… (${pushDone} of ${toPush.length})`, "Uploading decks");
          return;
        }
        const res = await pushLibraryDeckToCloud(localMeta, {
          cloudExists: Boolean(cloud),
          cloudDeck: cloudBody,
          webCards: cloud ? (pushCardsByDeck.get(String(localMeta.deckId)) || []) : null
        });
        if (!isNoOpStats(res.stats)) {
          pushed++;
          // localId rides along for the same reason it does on the pull rows: a
          // push can stash a cloud body it replaced now, and the report's
          // "Restore my notes" button needs to know whose stash to put back.
          deckLog.push({ title: localMeta.title || "Untitled deck", direction: "pushed", localId: res.localId, ...res.stats });
        } else {
          alreadyMatched.push(localMeta.title || "Untitled deck");
        }
        // The pre-push merge rewrote this deck's card list on this device. If
        // it's the deck on screen, the in-memory copy is now the stale one — and
        // the next autosave would write it straight back, undoing the merge. Same
        // reload a pull does, for the same reason.
        if (res.localCardsChanged && state.localDeckId && res.localId === state.localDeckId) {
          activePulledLocalId = res.localId;
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: localMeta.title || "Untitled deck", direction: "failed", error: describeSyncError(e) });
        console.warn("Reconcile push failed", localMeta.id, e);
      }
      // Counted as decks finish rather than as they start — with three in flight
      // a "3 of 12" that meant "started" would race ahead of what's actually done.
      pushDone++;
      progress(`Uploading decks… (${pushDone} of ${toPush.length})`, "Uploading decks");
    });

    // A flushed meta edit (categories or source anchors) is real sync work and
    // has to show up in the report. Fold it into the quick_notes deck's own row
    // if the loops above already logged one, so a single deck never appears
    // twice. Anchors have no stat of their own — they're invisible plumbing
    // behind the "Go to notes" button — so they only get a row when nothing
    // else about the deck moved, purely so the sync doesn't claim it did
    // nothing.
    if (await styleFlush) setStyleStatus("Style synced");

    if (noteCategoriesFlushed || noteAnchorsFlushed) {
      const row = deckLog.find((e) => e.direction !== "failed" && e.title === QUICK_NOTES_DECK_TITLE);
      if (row) {
        if (noteCategoriesFlushed) row.noteCategoriesChanged = true;
      } else if (noteCategoriesFlushed) {
        deckLog.push({ title: QUICK_NOTES_DECK_TITLE, direction: "pushed", ...emptySyncStats(), noteCategoriesChanged: true });
        pushed++;
      } else {
        alreadyMatched.push(QUICK_NOTES_DECK_TITLE);
      }
    }

    // If the on-screen deck was refreshed from the cloud, reload it so the user
    // sees the newer content. (Local edits bump the timestamp, so this only
    // happens when the cloud copy genuinely won the last-write-wins.)
    if (activePulledLocalId) {
      await loadDeckFromLibrary(activePulledLocalId);
    } else {
      refreshSyncIndicatorBaseline();
    }
    if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    localStorage.setItem(LAST_GLOBAL_SYNC_KEY, new Date().toISOString());
    localStorage.removeItem(LAST_GLOBAL_SYNC_ERROR_KEY);
    clearBackgroundSyncProblem();

    // Lead with the direction (how many decks moved, which way), then name the
    // actual changes — "2 decks uploaded" alone never said WHAT was uploaded.
    const parts = [];
    if (pulled) parts.push(`${pulled} deck${pulled === 1 ? "" : "s"} downloaded from the cloud`);
    if (pushed) parts.push(`${pushed} deck${pushed === 1 ? "" : "s"} uploaded to the cloud`);
    // Deliberately its own clause rather than folded into the change detail:
    // decks disappearing from this device is the one sync outcome the user most
    // needs to see stated plainly.
    if (adoptedDeletions.length) {
      parts.push(`${adoptedDeletions.length} deck${adoptedDeletions.length === 1 ? "" : "s"} removed here (deleted on another device)`);
    }
    // Decks the sync deliberately left alone. Worth saying out loud: the user
    // asked for a sync and some of their decks were skipped, and the old silent
    // behaviour here — delete first, explain never — is what made the failure so
    // expensive. "Kept" is the message; nothing was lost.
    if (heldDeckIds.size && !removalNeedsConfirmation) {
      parts.push(`${heldDeckIds.size} deck${heldDeckIds.size === 1 ? "" : "s"} missing from the cloud kept here for now`);
    }
    // Before the report reads `timings`: the finally below also closes the open
    // phase, but that runs after this, so without this call the last (often
    // largest) phase would be missing from every successful run's report.
    closePhase();
    if (imagesUploaded) parts.push(`${imagesUploaded} image${imagesUploaded === 1 ? "" : "s"} uploaded`);
    const changes = describeSyncStats(totalSyncStats(deckLog), { asTotals: true });
    const detail = changes.length ? ` — ${changes.join(", ")}` : "";
    // Name the decks that failed. "See console" asked the user to open devtools
    // to learn WHICH of their decks didn't make it — on a phone, where this app
    // mostly runs, that's not an option at all.
    const failedTitles = deckLog.filter((e) => e.direction === "failed").map((e) => e.title);
    const failedNote = failed
      ? `${failed} deck${failed === 1 ? "" : "s"} failed: ${failedTitles.slice(0, 2).join(", ")}` +
        `${failedTitles.length > 2 ? ` and ${failedTitles.length - 2} more` : ""}`
      : "";
    // "Nothing to sync" was the single most misleading string in the app: it's
    // also what you got right after recategorising a quick note, because that
    // change is written to the cloud the instant you make it, leaving the sync
    // genuinely nothing to carry. Say which of the two actually happened.
    const nothingMoved = alreadyMatched.length
      ? `Already up to date — ${alreadyMatched.length} deck${alreadyMatched.length === 1 ? "" : "s"} checked, ` +
        `everything already matches the cloud (board edits save as you make them)`
      : "Already up to date — nothing changed here or in the cloud since the last sync";
    const summary = parts.length
      ? `Sync complete — ${parts.join(", ")}${detail}${failed ? `. ${failedNote}` : ""}`
      : failed
        ? `Sync incomplete — ${failedNote}`
        : nothingMoved;
    if (explicit) {
      setStatus(summary);
      showToast(summary, failed ? "error" : "success");
      // Detailed report modal — only for the explicit "Sync Now" click, and
      // only when there's actually something to report.
      if (deckLog.length) showSyncReport(deckLog, { pulled, pushed, failed, timings });
    } else {
      // Silent startup/reconnect sync never pops a modal — its report is
      // rendered inline on the welcome screen instead (see
      // renderWelcomeSyncReport), so it's only ever seen if that screen is
      // already what the user is looking at.
      lastStartupSyncReport = deckLog.length ? { deckLog, pulled, pushed, failed, timings } : null;
      if (el.deckEmptyState && !el.deckEmptyState.hidden) renderDeckEmptyState(hasActiveDeck() ? "active" : "none");
    }

    // A removal too large to make on this app's own authority. The decks are all
    // still here — this asks whether they should go. Deliberately last, after
    // the summary and the report, so it never pre-empts them; and deliberately a
    // question, because the honest answer to "were these deleted elsewhere?" is
    // that only the user knows. Declining costs nothing: they stay, and the next
    // sync asks again.
    if (removalNeedsConfirmation) {
      const names = removalNeedsConfirmation.slice(0, 3).map((entry) => entry.title).join(", ");
      const more = removalNeedsConfirmation.length > 3 ? ` and ${removalNeedsConfirmation.length - 3} more` : "";
      const count = `${removalNeedsConfirmation.length} deck${removalNeedsConfirmation.length === 1 ? "" : "s"}`;
      if (explicit) {
        showConfirmModal(
          `${count} on this device are no longer in the cloud: ${names}${more}.\n\n` +
          "If you deleted them on another device, remove them here too. If not — this can also happen " +
          "when the cloud can't be read properly — keep them, and they'll be uploaded again on the next sync.",
          () => {
            const removed = removeDecksMissingFromCloud(removalNeedsConfirmation);
            showToast(`${removed} deck${removed === 1 ? "" : "s"} removed from this device`, "success");
            if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
            updateDeckEmptyStatus();
          },
          { confirmLabel: "Remove them here", danger: true }
        );
      } else {
        showToast(`${count} missing from the cloud — kept on this device. Tap Sync Now to review.`, "info");
      }
    }
  } catch (error) {
    console.error("Reconcile failed", error);
    // A lapsed sign-in is not a broken sync, and reporting it as one is what
    // put the provider's own words on screen — "Sync failed — JWT expired",
    // which names nothing anybody can act on and reads like the app is
    // defective. It gets the pill that says what to do about it instead.
    const sessionLapsed = isSessionExpiredError(error);
    setSyncIndicator(sessionLapsed ? "signedout" : "error");
    localStorage.setItem(LAST_GLOBAL_SYNC_ERROR_KEY, "1");
    const offlineNow = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(error?.message || "");
    if (!explicit) {
      // A background failure used to leave nothing but a console line and a pill
      // the user may not have on screen — so a sync that had been broken for
      // weeks looked exactly like one that had never needed to do anything.
      // Classified so a persistent schema fault reports once, not hourly.
      if (sessionLapsed) {
        reportBackgroundSyncProblem("signed-out", SESSION_EXPIRED_MESSAGE);
      } else if (!offlineNow) {
        reportBackgroundSyncProblem(
          isMissingRelationError(error) || isMissingNotesColumnError(error) ? "schema" : "failed",
          `Sync failed — ${isQuotaExceededError(error) ? describeSyncError(error) : (error?.message || "unknown error")}. Your decks are safe on this device.`
        );
      }
    }
    if (explicit) {
      if (sessionLapsed) {
        setStatus(SESSION_EXPIRED_MESSAGE, "error");
        showToast("Your sign-in expired — sign in again", "error");
      } else {
        // A dropped connection mid-sync is by far the most common failure, and
        // the raw error for it ("Failed to fetch") reads like a bug rather than
        // "your network went away" — say so in words the user can act on.
        const reason = offlineNow
          ? "Couldn't reach the cloud — check your connection"
          : (isQuotaExceededError(error) ? describeSyncError(error) : error?.message || "Unknown error");
        setStatus(`Sync failed — ${reason}. Your decks are safe on this device.`, "error");
        showToast(`Sync failed — ${reason}`, "error");
      }
    }
  } finally {
    // Unconditionally, before anything else in here: the batches above are
    // opened inside the try, so a throw anywhere between them and here would
    // otherwise leave one open for the life of the page — and every subsequent
    // deck save would then live in memory and never reach disk. endIndexBatch
    // is reentrant and a no-op when nothing is open, and the outermost call
    // flushes what is pending.
    //
    // Twice, matching the two beginIndexBatch calls. A count that drifts is the
    // one way this can go wrong, so they are paired here rather than each being
    // closed at the end of its own pass — where an early `return` or a throw
    // between the two would skip one.
    try {
      endIndexBatch();
      endIndexBatch();
    } catch (error) {
      console.warn("Could not flush the deck index after syncing", error);
    }
    // Close whatever phase was open, so the last one (and a run that ended in
    // an error) is measured too rather than silently missing from the report.
    closePhase();
    reconcileInFlight = false;
    // Release anyone waiting on this run before they re-run. Resolved, never
    // rejected — the catch above has already reported whatever went wrong, and
    // an unhandled rejection here would be noise on top of it.
    if (settleReconcile) settleReconcile();
    reconcilePromise = null;
    if (el.syncNowBtn) setButtonLoading(el.syncNowBtn, false);
    updateDeckEmptyStatus();
    // The next auto-sync is a full interval from the end of THIS one, whoever
    // started it — so an explicit Sync Now isn't followed seconds later by a
    // scheduled one, and the pill's countdown always reads from the last sync
    // that actually happened.
    rearmAutoSync();
  }
}
