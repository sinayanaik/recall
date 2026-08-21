// The device's own deck library: the index, saving, loading, renaming.
//
// A save is guarded by a load token — a slow load of a big note could
// otherwise resolve after a faster later one and overwrite it, so the last
// deck REQUESTED always wins, not the last one to arrive.

import { activeDeckLoadToken, nextDeckLoadToken } from "../cloud/web-decks.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { setPendingImportFolder } from "../import/staging.js?v=__BUILD__";
import { isFolderDeckActive, saveFolderDeck, saveFolderDeckSync } from "./folder-deck.js?v=__BUILD__";
import { normalizeDeckCategory } from "./folders.js?v=__BUILD__";
import { invalidateNoteLinkIndex } from "../notes/note-links.js?v=__BUILD__";
import { repairEscapedMathMarkdown } from "../render/math.js?v=__BUILD__";
import { noteLinkAliasesFor } from "../render/note-links.js?v=__BUILD__";
import { deckSnapshot, loadDeckSnapshot } from "../storage/deck-snapshot.js?v=__BUILD__";
import { allDeckSnapshotIds, cloneSnapshot, deckSnapshotCache, deckStoreUnreadable, deleteDeckSnapshot, flushPendingDeckAutosave, forEachDeckSnapshot, indexedDbUnavailable, readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { LOCAL_DECKS_INDEX_KEY, LOCAL_DECK_PREFIX, NOTES_CONFLICT_SUFFIX } from "../storage/keys.js?v=__BUILD__";
import { handleDeckStorageQuotaError, persistWorkingDeck, setDeckAutosaveStorageFailed, setLastSaveErrorWasQuota } from "../storage/quota.js?v=__BUILD__";
import { cardSyncSignature, dropTombstonesForLiveCards, recordDeletedCardIds, stampCardSyncState } from "../sync/cards.js?v=__BUILD__";
import { normalizeSyncText } from "../sync/diff.js?v=__BUILD__";
import { refreshSyncIndicatorBaseline } from "../sync/indicator.js?v=__BUILD__";
import { resetChromeAutoHide } from "../ui/chrome.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { recordNavHistory, refreshNavBack } from "../ui/nav-history.js?v=__BUILD__";

// ── Batched index writes ────────────────────────────────────────────────────
//
// The deck index is one localStorage key holding the whole library, and every
// deck a sync touches rewrites all of it. That is fine for one deck and
// quadratic for a library: a sync that pulls 700 decks called
// localStorage.setItem 700 times with a ~200KB string each time — a synchronous
// disk write per deck, on the main thread, on a phone. Measured against a
// restored library it was the largest single cost in a sync, larger than the
// network, and it presented as the app freezing rather than as sync being slow.
//
// So the reconcile passes open a batch. Writes go to a string held in memory,
// and reach localStorage on a checkpoint and at the end.
//
// What is deliberately NOT changed: readLocalDeckIndex still returns a FRESH
// PARSE on every call, exactly as before — it just reads the pending string
// when there is one. Handing callers a live shared array would have been faster
// still and is not worth it: there are 48 call sites, some of which mutate what
// they get, and a mutation that silently became visible to everyone else is
// precisely the class of bug this file cannot afford.
let pendingIndexJson = null;
let indexBatchDepth = 0;
let writesSinceCheckpoint = 0;

// How many deck writes may accumulate before the batch touches localStorage.
// This is the crash budget, not a tuning knob: a tab killed mid-sync loses at
// most this many index entries — and even then the deck BODIES are already in
// IndexedDB, so what is lost is the listing, which the next sync rebuilds from
// the cloud. 25 keeps the setItem count down by more than an order of magnitude
// while keeping that window small enough to be uninteresting.
export const INDEX_CHECKPOINT_EVERY = 25;

// Reentrant, because the pull pass calls into functions that open their own
// batches; only the outermost flush actually ends it.
export function beginIndexBatch() {
  indexBatchDepth++;
}

export function endIndexBatch() {
  if (indexBatchDepth === 0) return;
  indexBatchDepth--;
  if (indexBatchDepth === 0) flushIndexBatch();
}

// Push whatever is pending to localStorage. Safe to call at any time, including
// when no batch is open.
export function flushIndexBatch() {
  if (pendingIndexJson === null) return;
  const json = pendingIndexJson;
  // Cleared BEFORE the write, not after. If setItem throws (a full quota is the
  // realistic case), leaving the pending copy in place would mean every
  // subsequent read kept returning an index that is not on disk and never will
  // be — the app would look correct and persist nothing.
  pendingIndexJson = null;
  writesSinceCheckpoint = 0;
  try {
    localStorage.setItem(LOCAL_DECKS_INDEX_KEY, json);
  } catch (error) {
    console.warn("Could not save the local deck index", error);
    throw error;
  }
}

// Throw the batch away without writing it. For the one caller that deletes the
// key outright (resetLocalLibrary, on an account switch or a sign-out): a
// pending copy would otherwise be flushed straight back over the removal and
// restore the previous account's library, which is the exact thing that reset
// exists to prevent.
export function discardIndexBatch() {
  pendingIndexJson = null;
  writesSinceCheckpoint = 0;
  indexBatchDepth = 0;
}

export function readLocalDeckIndex() {
  try {
    const raw = pendingIndexJson ?? localStorage.getItem(LOCAL_DECKS_INDEX_KEY) ?? "[]";
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Rethrows on failure (unlike most small localStorage writers in this file,
// which swallow-and-warn) so saveDeckToLibrary's caller-facing "could not
// save" messaging actually fires instead of the error going uncaught.
export function writeLocalDeckIndex(list) {
  try {
    const json = JSON.stringify(list);
    if (indexBatchDepth > 0) {
      pendingIndexJson = json;
      // Still invalidated on every write, batched or not: it is an in-memory
      // cache of "what decks exist and what are they called", and a reader
      // during the batch must see the same answer readLocalDeckIndex would give.
      invalidateNoteLinkIndex();
      if (++writesSinceCheckpoint >= INDEX_CHECKPOINT_EVERY) flushIndexBatch();
      return;
    }
    localStorage.setItem(LOCAL_DECKS_INDEX_KEY, json);
    // The one choke point for "what decks exist and what are they called", so
    // it is also the one place the [[note]] link index can be invalidated
    // without having to find every rename, delete, import and sync by hand.
    invalidateNoteLinkIndex();
  } catch (error) {
    console.warn("Could not save the local deck index", error);
    throw error;
  }
}

// Set once the stored-text repair below has run on this device.
export const MATH_ESCAPE_REPAIR_KEY = "flashcards_math_escape_repair_v1";

// Every note captured before htmlToMarkdown learned to protect math is sitting
// in storage with the damage baked into its text — "x_k" saved as "x\_k",
// "\int" saved as "\\int". Repair the saved markdown itself, once per device,
// so the ✎ raw view, exports, backups and the cloud copy all come good; a fix
// that only ran at render time would leave every one of those still wrong.
//
// Cheap on a clean library: decks that need nothing are never rewritten, and
// repairEscapedMathMarkdown returns its input by identity when it found no
// damage, so "did this change?" costs no comparison.
export async function repairEscapedMathInLibrary() {
  try {
    if (localStorage.getItem(MATH_ESCAPE_REPAIR_KEY)) return 0;
  } catch {
    return 0;
  }

  const stampIso = new Date().toISOString();

  // CURSOR-STREAMED, and that is load-bearing rather than tidy: this runs at
  // BOOT, and reading every deck by id would pull the entire library into the
  // cache — undoing the whole reason the cache is lazy, with a first-launch
  // memory spike proportional to library size on the one boot that can least
  // afford it. Streaming touches one record at a time and leaves the cache
  // empty for decks that need nothing (the overwhelming majority).
  //
  // Repairs are collected and applied AFTER the scan: the cursor runs inside a
  // readonly transaction, so writing back mid-iteration isn't allowed. The
  // held set is bounded by how much damage there actually is, not by library
  // size — and every deck in it has to be rewritten anyway.
  const damaged = [];
  await forEachDeckSnapshot((id, snapshot) => {
    // Never repair a notes-conflict stash in place: it isn't a deck, it has no
    // index entry, and the sibling deck's own repair is what matters.
    if (String(id).endsWith(NOTES_CONFLICT_SUFFIX)) return;
    let changed = false;

    const notes = repairEscapedMathMarkdown(snapshot.notes || "");
    if (notes !== (snapshot.notes || "")) {
      snapshot.notes = notes;
      changed = true;
    }

    for (const card of snapshot.cards || []) {
      const question = repairEscapedMathMarkdown(card.question || "");
      const answer = repairEscapedMathMarkdown(card.answer || "");
      if (question === (card.question || "") && answer === (card.answer || "")) continue;
      card.question = question;
      card.answer = answer;
      // The repair is a real content edit, so it has to travel: leave the card
      // clean and the next pull hands the damaged cloud copy straight back.
      card.dirty = true;
      card.updatedAt = stampIso;
      changed = true;
    }

    // `snapshot` here is IndexedDB's own structured clone of the record, not
    // the shared cache object, so mutating it above is safe to keep.
    if (changed) damaged.push({ id: String(id), snapshot });
  });

  const repairedIds = new Set(damaged.map((d) => d.id));
  for (const { id, snapshot } of damaged) writeDeckSnapshot(id, snapshot);
  const repaired = damaged.length;

  try {
    if (repaired) {
      // Deck notes are deck-level, not per-card, so this timestamp is what
      // carries a notes-only repair to the cloud. Read the index HERE, after
      // the scan, so nothing that changed during it is reverted.
      writeLocalDeckIndex(readLocalDeckIndex().map(
        (entry) => (repairedIds.has(String(entry.id)) ? { ...entry, updatedAt: stampIso } : entry)
      ));
    }
    localStorage.setItem(MATH_ESCAPE_REPAIR_KEY, stampIso);
  } catch (error) {
    console.warn("Could not record math-escape repair", error);
  }
  return repaired;
}

// Repair math that older builds saved with Markdown escapes still in it.
// Called from bootApp the moment the deck cache is loaded, so it lands before
// any deck can be opened — the deck a user picks must already hold repaired
// text, not get repaired underneath them.
export async function runEscapedMathRepair() {
  // The repair stamps itself as done even when it finds nothing, so running it
  // against an unreadable store would permanently skip it for this device.
  if (deckStoreUnreadable) return;
  try {
    const repaired = await repairEscapedMathInLibrary();
    if (repaired) console.info(`Repaired escaped math in ${repaired} deck(s)`);
  } catch (error) {
    // A library that cannot be repaired is still a library worth opening.
    console.warn("Escaped-math repair failed", error);
  }
}

export function generateLocalDeckId() {
  return `ld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Mirrors a card that was appended straight to a cloud deck (currently only
// saveQuickNote) into the matching local library entry, if one exists. Without
// this the local quick_notes snapshot's updatedAt stays behind the cloud's, so
// the next reconcile treats the cloud as newer and pulls it over any
// not-yet-synced local edit to that same deck — silently dropping it (see
// commit b72c48a for the conflict this is a partial, additive-only fix for).
export async function appendCardToLocalLibraryDeck(deckId, card, now) {
  if (!deckId) return;
  const localId = readLocalDeckIndex().find((e) => e.deckId === deckId)?.id;
  if (!localId) return;
  const resolvedNow = now || new Date().toISOString();
  // Serialised per deck — pinning is the single most common thing to do while
  // a background sync is running, which is exactly the collision this prevents.
  return withDeckLock(localId, async () => {
    const snapshot = await readDeckSnapshot(localId);
    if (!snapshot) return;
    snapshot.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    // Written straight into the snapshot, so it never passes through
    // saveDeckToLibrary's stamping — mark it here or the next pull would treat
    // this brand-new card as "clean and absent from the cloud" and delete it.
    snapshot.cards.push({ ...card, dirty: true, updatedAt: resolvedNow });
    dropTombstonesForLiveCards(snapshot);
    writeDeckSnapshot(localId, snapshot);

    // Re-read the index HERE, after the await — never write back an array
    // captured before it. writeLocalDeckIndex replaces the WHOLE list, so a
    // stale copy doesn't just lose this entry's newer fields, it silently
    // deletes any deck a concurrent reconcile added in the meantime and reverts
    // every deckId/lastSyncedAt that pass recorded.
    const index = readLocalDeckIndex();
    const entry = index.find((e) => e.id === localId);
    if (!entry) return; // deck was deleted during the await — nothing to update
    // Counted from the snapshot rather than incremented, so this can never
    // drift out of step with what the deck actually holds (a concurrent pull
    // adding cards used to leave cardCount and the snapshot disagreeing).
    entry.cardCount = snapshot.cards.length;
    entry.updatedAt = resolvedNow;
    writeLocalDeckIndex(index);
  });
}

// Keeps the local library mirror in step with a deck-metadata write that went
// straight to Supabase (a title/category edit from the active-deck menu, a
// list-row rename, or a bulk category change) — without this, the local
// copy's updatedAt stays behind the cloud's, so the next reconcile sees the
// cloud as "newer" and pulls it over any not-yet-synced local card edits,
// silently discarding them. Only patches title/category + updatedAt; leaves
// card content alone so it doesn't clobber other pending local edits.
export async function syncLocalLibraryMetaForDeck(deckId, { title, category, now } = {}) {
  if (!deckId) return;
  const localId = readLocalDeckIndex().find((e) => e.deckId === deckId)?.id;
  if (!localId) return;
  const resolvedNow = now || new Date().toISOString();
  return withDeckLock(localId, async () => {
    const index = readLocalDeckIndex();
    const entry = index.find((e) => e.id === localId);
    if (!entry) return;
    if (title !== undefined) entry.title = title;
    if (category !== undefined) entry.category = category;
    entry.updatedAt = resolvedNow;
    writeLocalDeckIndex(index);

    const snapshot = await readDeckSnapshot(localId);
    if (snapshot) {
      if (title !== undefined) {
        snapshot.deckTitle = title;
        // Keep the title mirrors in step so a later loadDeckFromLibrary (which
        // reads sourceTitle first) can't resurrect the old name.
        snapshot.sourceTitle = title;
        snapshot.importTitleHint = title;
      }
      if (category !== undefined) snapshot.deckCategory = category;
      writeDeckSnapshot(localId, snapshot);
    }
  });
}

// Newest first.
export function listLocalDecks() {
  return readLocalDeckIndex()
    .slice()
    .sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || "")));
}

// A content fingerprint of everything that counts as a real edit — title,
// category, notes, and each card's id/question/answer/status in order — but NOT
// the current-card position or the export timestamp. `updatedAt` (the field the
// whole two-way sync compares on) must bump ONLY when this changes; otherwise
// merely viewing or paging through a deck would make it read as "newer" than the
// cloud and overwrite a genuinely newer cloud edit on the next reconcile.
// Compares two snapshots on that fingerprint WITHOUT building it. The previous
// version rendered each snapshot to one big JSON string and compared the
// strings — which on a large deck means two full serializations of every note
// and every card (plus an intermediate array of per-card signature strings)
// every time anything is saved, i.e. continuously while typing, just to answer
// a question that is almost always "no, nothing changed". Field by field with
// an early exit answers it with no allocation at all, and bails on the first
// difference when the answer is "yes".
//
// Per-card fields come from cardSyncSignature so "what counts as a card edit"
// is defined in exactly one place. `category` used to be missing here, which
// meant a card recategorisation never bumped the deck's updatedAt and so was
// never pushed — it only reached the cloud because setQuickNoteCardCategory
// bumped the index entry by hand.
export function deckContentMatches(a, b) {
  if (!a || !b) return false;
  if (normalizeSyncText(a.deckTitle) !== normalizeSyncText(b.deckTitle)) return false;
  if (normalizeDeckCategory(a.deckCategory) !== normalizeDeckCategory(b.deckCategory)) return false;
  if (normalizeSyncText(a.notes) !== normalizeSyncText(b.notes)) return false;
  // Unlike meta.readingPosition (deliberately ignored here — see
  // reading-position.js), a bookmark is a deliberate user action and should
  // count as real content: compared on its own `.at` (not deep-equality) so
  // it changes exactly once per bookmark click, the same way readingPosition
  // is compared by offset elsewhere to avoid a fresh timestamp alone reading
  // as a change.
  if ((a.meta?.bookmark?.at || null) !== (b.meta?.bookmark?.at || null)) return false;
  const aCards = a.cards || [];
  const bCards = b.cards || [];
  if (aCards.length !== bCards.length) return false;
  for (let i = 0; i < aCards.length; i += 1) {
    if (String(aCards[i].id) !== String(bCards[i].id)) return false;
    if (cardSyncSignature(aCards[i]) !== cardSyncSignature(bCards[i])) return false;
  }
  return true;
}

// Save the current deck into the local library. Re-saving the same deck (matched
// by local id, or by cloud deckId for decks pulled from the web) updates in place
// rather than creating a duplicate. Returns the stored metadata, or null on failure.
// `updatedAt` may be overridden to align the local copy's timestamp with the
// cloud's after a successful push (so two-way reconcile sees them in sync).
// `synced: true` means the snapshot being saved is known to already match the
// cloud (mirroring a deck just loaded from the web), so its cards are stamped
// clean instead of dirty and the next reconcile has nothing to re-push.
// Resolves localId the same way every save has always: an explicit override,
// else the deck already open, else an existing library entry matching this
// deck's cloud id, else a brand-new id. Split out because it has to run
// BEFORE either flavour of previousSnapshot lookup below can even ask "for
// which id?".
export function resolveSaveTarget(id) {
  const snapshot = deckSnapshot();
  let localId = id || state.localDeckId;
  if (!localId && snapshot.deckId) {
    const existing = readLocalDeckIndex().find((entry) => entry.deckId === snapshot.deckId);
    if (existing) localId = existing.id;
  }
  localId = localId || generateLocalDeckId();
  snapshot.localDeckId = localId;
  // Record the id THIS device knows the deck by, inside the deck's own meta bag
  // so it syncs with everything else in there. Links written on this device
  // carry this id (older ones certainly do — see the note-reference header), and
  // no other device can resolve it without being told. Done here rather than in
  // deckSnapshot() because this is where `localId` is authoritative: a
  // first-ever save mints it a line above, and state.localDeckId is still null.
  const aliases = noteLinkAliasesFor(snapshot.meta, localId);
  snapshot.meta = { ...(snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : {}), linkIds: aliases };
  // Deliberately does NOT return the index entry: the async save awaits a read
  // after this, and anything captured here would be stale by the time the
  // entry is rebuilt. finishSaveDeckToLibrary re-reads it instead.
  return { snapshot, localId };
}

// Everything from here on is synchronous once previousSnapshot is in hand —
// shared by the normal async save and the sync emergency-flush save below, so
// the two can never drift into different behaviour. Returns the new index
// entry, or null on a genuine failure.
// `loadToken` is the value activeDeckLoadToken held when the caller decided
// which deck it was saving. Omit it when the caller is fully synchronous (see
// saveDeckToLibrarySync) — with no await in between there is nothing that could
// have moved the user, and the check would only cost a comparison.
export function finishSaveDeckToLibrary({ snapshot, localId, previousSnapshot, silent, updatedAt, lastSyncedAt, synced, loadToken }) {
  // Read the index entry HERE, not before the caller's await. Everything from
  // this line to writeLocalDeckIndex below is synchronous, so this is the only
  // point at which "what the index currently says" can be trusted to still be
  // true when the new entry is written. Capturing it earlier (as this used to)
  // meant a sync or a second save landing during the await would be silently
  // reverted by the fields carried over below — regressing lastSyncedAt, and
  // re-clearing the very notesSyncFailed/notesConflicted warnings that are
  // deliberately carried rather than recomputed.
  const previousEntry = readLocalDeckIndex().find((entry) => entry.id === localId);
  if (!snapshot.deckId) snapshot.deckId = previousSnapshot?.deckId || previousEntry?.deckId || null;

  // Only advance updatedAt when the content actually changed (or on an explicit
  // caller-supplied timestamp, e.g. aligning to the cloud after a push). A pure
  // navigation/position save keeps the deck's existing updatedAt so it stays in
  // sync with the cloud instead of falsely winning last-write-wins.
  const nowIso = new Date().toISOString();
  const contentChanged = !previousSnapshot
    || !deckContentMatches(previousSnapshot, snapshot);
  const resolvedUpdatedAt = updatedAt
    || (contentChanged ? nowIso : (previousEntry?.updatedAt || nowIso));

  // Mark exactly the cards this save changed, so a later pull can tell "I edited
  // this and haven't pushed it" apart from "this is just what the cloud gave me"
  // and merge instead of overwrite. Must run AFTER contentChanged is computed —
  // it mutates snapshot.cards, and deckContentMatches ignores these fields but
  // there's no reason to depend on that.
  stampCardSyncState(snapshot, previousSnapshot, updatedAt || nowIso, { synced });
  // Every local card deletion funnels through here (the delete handlers mutate
  // state and let the autosave persist it), so this diff is where a deletion
  // becomes a durable fact rather than just an absence the next push can't
  // distinguish from "never had it". See recordDeletedCardIds.
  recordDeletedCardIds(snapshot, previousSnapshot, updatedAt || nowIso);

  // Updates the in-memory cache synchronously — everything below sees this
  // deck as saved — and persists to IndexedDB in the background. A genuine
  // quota error surfaces asynchronously via handleDeckStorageQuotaError
  // rather than failing this call; see the block comment on writeDeckSnapshot.
  setLastSaveErrorWasQuota(false);
  writeDeckSnapshot(localId, snapshot);

  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory || defaultDeckCategory,
    cardCount: snapshot.cards.length,
    hasNotes: Boolean(String(snapshot.notes || "").trim()),
    updatedAt: resolvedUpdatedAt,
    createdAt: previousEntry?.createdAt || new Date().toISOString(),
    lastSyncedAt: lastSyncedAt !== undefined ? lastSyncedAt : (previousEntry?.lastSyncedAt || null),
    // Preserved as-is here — only touchLocalDeckAccess (called on a genuine
    // open, not on every autosave) advances this.
    accessedAt: previousEntry?.accessedAt || null,
    // Carried over, NOT recomputed. These say "the cloud copy of this deck's
    // notes is wrong/contested", which only a sync can establish or clear
    // (pullCloudDeckToLibrary and pushLibraryDeckToCloud each rewrite them
    // authoritatively). Dropping them here meant the very next autosave — 400ms
    // after the user typed one character — silently cleared the warning while
    // the notes were still missing from the cloud.
    notesConflicted: previousEntry?.notesConflicted || false,
    notesSyncFailed: previousEntry?.notesSyncFailed || false,
    deckId: snapshot.deckId || null,
    // Mirrored out of the snapshot's meta bag purely so the link index can see
    // it: loadNoteLinkIndex is built from this index (localStorage) and never
    // reads snapshots, and making it read one per deck would turn opening the
    // "[[" picker into a full library scan. See noteLinkEntryMatchesId.
    linkIds: Array.isArray(snapshot.meta?.linkIds) ? snapshot.meta.linkIds : [],
  };
  try {
    writeLocalDeckIndex([meta, ...readLocalDeckIndex().filter((entry) => entry.id !== localId)]);
  } catch (error) {
    console.warn("Could not save deck index", error);
    const isQuota = handleDeckStorageQuotaError(error);
    if (!silent) {
      setStatus(
        isQuota
          ? "Could not save deck — device storage is full. Delete some old decks to free space."
          : `Could not save deck: ${error?.message || error?.name || "unknown error"}`,
        "error"
      );
    }
    return null;
  }
  // "The deck just saved is the deck now open" — true for an ordinary autosave,
  // and false for a save that resolved after the user navigated. localId was
  // captured before this call's caller awaited (a queued withDeckLock, a cold
  // readDeckSnapshot), so assigning it unconditionally used to YANK the active
  // deck id back to the note being left while the screen showed the new one —
  // after which every autosave wrote the new note's body into the old note's
  // record. loadWebDeck already guards its own call to this effect with the
  // same token; the assignment itself was the hole.
  if (loadToken === undefined || loadToken === activeDeckLoadToken) {
    state.localDeckId = localId;
    persistWorkingDeck();
  }
  return meta;
}

// Whether there is genuinely nothing here to write.
//
// It used to be "no cards and no notes", which was complete right up until a
// deck could BE a document. A freshly imported paper is exactly that shape —
// no cards yet, an empty note (it is yours to write in), and a PDF plus a
// growing list of highlights in meta — so under the old test every autosave a
// PDF deck ever scheduled was a no-op, and an afternoon of highlighting was
// discarded on reload with the sync pill cheerfully reading "saved".
//
// meta.pdf is the discriminator, not meta.pdfHighlights: a paper with no
// highlights on it yet is still a deck worth having.
export function deckHasNothingToSave() {
  return !state.masterCards.length && !state.notes.trim() && !state.meta?.pdf;
}

export async function saveDeckToLibrary({ id = null, silent = false, updatedAt = null, lastSyncedAt = undefined, synced = false } = {}) {
  // A whole folder is open as one document. There is no such deck, and
  // resolveSaveTarget below would happily invent one — mint a local id, write
  // every deck in the folder glued together into IndexedDB, and let the next
  // reconcile push that to every device. The edits belong to the decks the
  // document was built from; saveFolderDeck puts them there.
  if (!id && isFolderDeckActive()) return saveFolderDeck({ silent });
  if (deckHasNothingToSave()) {
    if (!silent) setStatus("Add some cards or notes before saving a deck.", "error");
    return null;
  }
  // The deck bodies on this device couldn't be read this session (see
  // deckStoreUnreadable). Writing now would persist whatever partial state the
  // app managed to assemble over a deck whose real contents are intact but
  // invisible — the one way a read failure becomes a write failure. Refuse,
  // and say so; a reload restores normal operation.
  if (deckStoreUnreadable) {
    if (!silent) setStatus("Couldn't read this device's decks — reload the app before editing. Nothing was changed.", "error");
    return null;
  }
  const { snapshot, localId } = resolveSaveTarget(id);
  // Captured together with localId, before either await below. The snapshot and
  // the id are a matched pair describing the deck open RIGHT NOW; this records
  // which "right now" that was, so finishSaveDeckToLibrary can tell whether the
  // user has since opened something else.
  const loadToken = activeDeckLoadToken;
  // Serialised per deck: read-then-write, and a pull merging cloud cards into
  // the same deck must not land in between (see withDeckLock).
  return withDeckLock(localId, async () => {
    // Read the copy we're about to overwrite, BEFORE writing, so we can tell a
    // real content edit apart from a position-only / no-op save and keep the cloud
    // id from ever being dropped.
    const previousSnapshot = await readDeckSnapshot(localId);
    return finishSaveDeckToLibrary({ snapshot, localId, previousSnapshot, silent, updatedAt, lastSyncedAt, synced, loadToken });
  });
}

// Synchronous, cache-only version of readDeckSnapshot: never touches
// IndexedDB, returns null if this id isn't currently resident. Exists for
// exactly one caller — the emergency flush below — where there is no reliable
// guarantee a real IndexedDB round trip (a task-queue turn, not just a
// microtask) completes before the page is torn down; an OS killing a
// backgrounded phone app doesn't wait for pending disk I/O the way the JS
// engine lets queued microtasks drain first. Safe specifically because the
// ACTIVE deck (the only thing this flush ever saves) is already
// cache-resident by construction: state.localDeckId is only ever set by
// loadDeckFromLibrary or saveDeckToLibrary itself, and both warm the cache for
// that id before returning. A miss here means "this deck has never been
// saved before", which is the correct previousSnapshot for that case anyway.
export function cachedDeckSnapshotSync(id) {
  if (!id) return null;
  if (indexedDbUnavailable) {
    try {
      const raw = localStorage.getItem(LOCAL_DECK_PREFIX + String(id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  const entry = deckSnapshotCache.get(String(id));
  return entry === undefined ? null : cloneSnapshot(entry);
}

// The emergency-flush twin of saveDeckToLibrary — see flushWorkingDeck. Fully
// synchronous, start to finish, so a pagehide handler can call it and be
// certain the write (and therefore journalPendingDeckWrites right after it)
// has actually happened before the function returns, with no dependency on
// the event loop getting another turn. Must stay behaviourally identical to
// the async path for anything already cache-resident — that's the entire
// reason finishSaveDeckToLibrary is shared rather than duplicated.
export function saveDeckToLibrarySync({ id = null, silent = true } = {}) {
  // Same gate as the async twin, and the load-bearing one of the two:
  // flushWorkingDeck() calls THIS from pagehide/visibilitychange, so without it
  // simply switching tabs while reading a folder would mint the merged deck.
  if (!id && isFolderDeckActive()) return saveFolderDeckSync();
  if (deckHasNothingToSave()) return null;
  if (deckStoreUnreadable) return null;
  const { snapshot, localId } = resolveSaveTarget(id);
  const previousSnapshot = cachedDeckSnapshotSync(localId);
  return finishSaveDeckToLibrary({ snapshot, localId, previousSnapshot, silent, updatedAt: null, lastSyncedAt: undefined, synced: false });
}

export async function loadDeckFromLibrary(id) {
  // Opening a saved deck is never an import, so it must not adopt a folder left
  // over from an "Import here" whose file picker was dismissed — that would
  // silently refile an existing deck.
  setPendingImportFolder(null);
  // Shares the counter with loadWebDeck: whichever deck the user opened MOST
  // RECENTLY wins, regardless of which one's read/fetch happens to resolve
  // first. A big note can take a moment to come off IndexedDB (cold read) or
  // still be mid-fetch from the web — without this, that slower response
  // lands after a faster subsequent open and silently overwrites it.
  const loadToken = nextDeckLoadToken();
  // The READ is caught separately from everything after it, because the two
  // failures mean opposite things and only one is the user's problem. A throw
  // here is IndexedDB failing to answer — the deck is fine, this attempt
  // wasn't — and telling someone their deck is "corrupted" for a transient
  // read error is how a good library gets deleted and re-imported for no
  // reason. Only a throw from parsing/loading the payload below is real damage.
  let payload;
  try {
    payload = await readDeckSnapshot(id);
  } catch (error) {
    console.warn("Could not read saved deck from storage", id, error);
    setStatus("Couldn't read that deck from this device's storage — reload the app and try again. Nothing was changed.", "error");
    return false;
  }
  if (!payload) {
    setStatus("That saved deck could not be found.", "error");
    return false;
  }
  // A newer deck open (local or web) has taken over the view since this read
  // started — applying this one now would yank the screen back to it.
  if (loadToken !== activeDeckLoadToken) return false;
  // The deck we're about to leave may have unsaved keystrokes sitting in the
  // 400ms debounce. Flush them HERE, while `state` still describes that deck —
  // once loadDeckSnapshot runs there is no longer anywhere to save them to.
  await flushPendingDeckAutosave();
  // The flush is an await, so re-check: the user may have opened something else
  // while it was writing.
  if (loadToken !== activeDeckLoadToken) return false;
  try {
    // A navigation door: remember where the user was before this deck replaces
    // it. Recorded only once the deck is known to exist — a failed open doesn't
    // move anyone.
    recordNavHistory();
    loadDeckSnapshot(payload, payload.sourceTitle || payload.deckTitle || "");
    state.localDeckId = id;
    persistWorkingDeck();
    refreshSyncIndicatorBaseline();
    refreshNavBack(); // arrived — now the button knows where "here" is
    resetChromeAutoHide(); // a new deck starts at the top, header showing
    return true;
  } catch (error) {
    console.warn("Could not load saved deck", error);
    setStatus("That saved deck is corrupted and could not be loaded.", "error");
    return false;
  }
}

export function deleteDeckFromLibrary(id) {
  deleteDeckSnapshot(id);
  // The deck is gone, so its stashed notes conflict has nothing left to be
  // recovered into — and leaving it behind would keep eating quota invisibly.
  deleteDeckSnapshot(id + NOTES_CONFLICT_SUFFIX);
  writeLocalDeckIndex(readLocalDeckIndex().filter((entry) => entry.id !== id));
  if (state.localDeckId === id) state.localDeckId = null;
  // Deleting a deck is the natural "free up space" action after a quota
  // failure latched autosave off — give the next edit a chance to retry
  // instead of requiring a full new-deck/page reload to recover.
  setDeckAutosaveStorageFailed(false);
}

// One-time cleanup for snapshots orphaned by the race in pullCloudDeckToLibrary
// (see its comment) — a deck snapshot written under some id but never
// referenced by the index again after a losing race, so it sits in the deck
// store forever, invisible in My Decks, silently eating quota. Removes any
// snapshot id that isn't in the current index. Safe: a snapshot only ever
// exists there if it was written alongside a matching index entry, so "not
// in the index" means nothing currently references it.
export async function pruneOrphanedDeckSnapshots() {
  const validIds = new Set(readLocalDeckIndex().map((entry) => String(entry.id)));
  // readLocalDeckIndex() returns [] both when the library is genuinely empty
  // AND when the index key is corrupt/unparseable (its own catch-and-return-[]).
  // Treating the latter as "nothing is valid" would delete every real
  // snapshot on the device. If the index is legitimately empty there's
  // nothing to prune anyway, so skipping costs nothing either way.
  if (!validIds.size) return 0;
  let removed = 0;
  for (const key of await allDeckSnapshotIds()) {
    let id = key;
    // A stashed notes conflict is a sibling entry on the same namespace, so it
    // has to be resolved back to its owning deck id — otherwise this sweep
    // would read it as an orphan and throw away the one copy of the user's
    // replaced notes on the very next boot.
    if (id.endsWith(NOTES_CONFLICT_SUFFIX)) id = id.slice(0, -NOTES_CONFLICT_SUFFIX.length);
    if (!validIds.has(id)) {
      deleteDeckSnapshot(key);
      removed++;
    }
  }
  if (removed) console.log(`Cleaned up ${removed} orphaned local deck snapshot(s).`);
  return removed;
}
