// Where each quick note was pinned from, so it can jump back to its source.

import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { notesAnchorPlainText } from "../notes/anchors.js?v=__BUILD__";
import { ensureQuickNotesDeck, qnBoard, renderQuickNotesBoard } from "./board.js?v=__BUILD__";
import { cachedUserId, ensureLocalQuickNotesSnapshot, getQuickNotesDeckId, isQuickNotesDeck, quickNotesLocalId } from "./categories.js?v=__BUILD__";
import { forEachDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { dropTombstonesForLiveCards } from "../sync/cards.js?v=__BUILD__";

// Keep the stored anchor small — meta is one JSON blob for the whole deck, and
// only these fields are needed to find the spot again.
export function trimNoteAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const text = String(anchor.text || "").slice(0, 300);
  const trimmed = {
    offset: Number.isFinite(anchor.offset) ? anchor.offset : null,
    source: String(anchor.source || "").slice(0, 120),
    text,
    deckId: anchor.deckId || null,
    deckLocalId: anchor.deckLocalId || null,
    deckTitle: String(anchor.deckTitle || "").slice(0, 120),
    // Set when the anchor was recovered by searching for the note's text rather
    // than captured at pin time — the UI says so, since it's a best guess.
    ...(anchor.guessed ? { guessed: true } : {})
  };
  // Nothing to jump to without either a locator or a target deck.
  if (!trimmed.text && !trimmed.source && !trimmed.deckId && !trimmed.deckLocalId) return null;
  return trimmed;
}

export function noteAnchorsFromMeta(meta) {
  let bag = meta;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  const anchors = bag && typeof bag === "object" ? bag.noteAnchors : null;
  return anchors && typeof anchors === "object" && !Array.isArray(anchors) ? anchors : {};
}

// Merge anchor patches into the quick_notes deck's meta.noteAnchors. Read-merge
// -write so sibling meta keys (quickNoteCategories) are never clobbered.
// `keepIds`, when given, also drops anchors whose card no longer exists — the
// re-read happens inside this call, so a card deleted elsewhere can't strand its
// anchor in the bag forever.
// Anchor writes are read-merge-write, and two of them run per board open (the
// local backfill and the source recovery). Serialised through one chain so they
// can't interleave — overlapping reads would silently drop one side's anchors.
// EVERY writer of decks.meta must go through this chain. meta is a single JSON
// blob and each writer read-merge-writes the whole of it, so two overlapping
// writes race: the second one's read predates the first one's write, and its
// write puts the stale copy back. Anchors were already serialised here; the
// category writer was NOT, despite touching the same blob — so recolouring a
// category while the board's anchor backfill was in flight could drop either
// side's work. One chain, all writers.
export let qnMetaWriteChain = Promise.resolve();

export function serialiseQuickNoteMetaWrite(task) {
  qnMetaWriteChain = qnMetaWriteChain.catch(() => {}).then(task);
  return qnMetaWriteChain;
}

// ── Pending anchor writes ────────────────────────────────────────
// Anchors are queued rather than written when they're made, for the same two
// reasons the categories are: a pin shouldn't cost a read-merge-write round trip
// of its own, and offline the write simply vanished. The queue holds a PATCH
// ({ [cardId]: anchor }) plus an optional prune set — never the resolved map,
// which would say "these are all the anchors that exist" and delete whatever
// another device pinned while this one was offline.
export const PENDING_QN_ANCHORS_KEY = "recall:pendingQuickNoteAnchors";

export function readPendingQuickNoteAnchors() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_QN_ANCHORS_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const patch = raw.patch && typeof raw.patch === "object" ? raw.patch : {};
    const keepIds = Array.isArray(raw.keepIds) ? raw.keepIds.map(String) : null;
    if (!Object.keys(patch).length && !keepIds) return null;
    return { deckId: String(raw.deckId || ""), patch, keepIds };
  } catch {
    return null;
  }
}

// Merges into whatever is already queued — several pins between two syncs must
// all be delivered, not just the last one.
export function queuePendingQuickNoteAnchors(patch, { keepIds = null } = {}) {
  const deckId = getQuickNotesDeckId() || "";
  const existing = readPendingQuickNoteAnchors();
  const sameDeck = existing && existing.deckId === deckId;
  const merged = { ...(sameDeck ? existing.patch : {}), ...(patch || {}) };
  // A prune is a statement about the whole bag, so the newest one wins outright
  // rather than intersecting with an older, staler view of what still exists.
  let keep = keepIds ? Array.from(keepIds).map(String) : (sameDeck ? existing.keepIds : null);
  if (!Object.keys(merged).length && !keep) return;
  try {
    localStorage.setItem(PENDING_QN_ANCHORS_KEY, JSON.stringify({
      deckId, patch: merged, keepIds: keep, savedAt: new Date().toISOString()
    }));
  } catch (_) { /* storage full — the anchor is still on the card locally */ }
}

export function clearPendingQuickNoteAnchors() {
  try { localStorage.removeItem(PENDING_QN_ANCHORS_KEY); } catch (_) {}
}

// Kept as the queueing entry point so every existing caller keeps working — it
// just no longer touches the network.
export function saveQuickNoteAnchors(patch, options) {
  queuePendingQuickNoteAnchors(patch, options);
}

// Deliver queued anchors. Called from reconcileAllDecks (before the pull, so the
// cloud already agrees with us by the time it's read back). Returns true only
// when something actually landed, so the sync report can say so.
export async function flushPendingQuickNoteAnchors() {
  const pending = readPendingQuickNoteAnchors();
  if (!pending) return false;
  const deckId = getQuickNotesDeckId();
  if (!deckId) return false;
  // Queued against a different account's deck — not ours to deliver.
  if (pending.deckId && pending.deckId !== deckId) {
    clearPendingQuickNoteAnchors();
    return false;
  }
  const keepIds = pending.keepIds ? new Set(pending.keepIds) : null;
  const delivered = await serialiseQuickNoteMetaWrite(
    () => writeQuickNoteAnchors(deckId, pending.patch, { keepIds })
  );
  if (delivered) clearPendingQuickNoteAnchors();
  return delivered;
}

// The cloud half. Always call through serialiseQuickNoteMetaWrite — decks.meta
// is one JSON blob and every writer read-merge-writes the whole of it.
export async function writeQuickNoteAnchors(deckId, patch, { keepIds = null } = {}) {
  if (!deckId) return false;
  const hasPatch = patch && Object.keys(patch).length;
  if (!hasPatch && !keepIds) return false;
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return false;
  try {
    // BOUNDED, like every other cloud call — and this one more than most: it
    // runs from flushPendingQuickNoteAnchors, which reconcileAllDecks awaits
    // BEFORE it reads the deck list. Unbounded, a stalled connection here hung
    // the entire sync before a single deck had been looked at, with the button
    // still showing its first label.
    const { data: existing } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle().abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "read quick-note anchors"
    );
    const base = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
    let anchors = { ...noteAnchorsFromMeta(base), ...(patch || {}) };
    if (keepIds) {
      anchors = Object.fromEntries(Object.entries(anchors).filter(([id]) => keepIds.has(String(id))));
    }
    const meta = { ...base, noteAnchors: anchors };
    // `.select()` because an UPDATE matching no row is not an error — it just
    // does nothing, which is exactly what happens on an account whose
    // quick_notes deck row doesn't exist yet. Same trap the category writer hit.
    let { data: updated, error } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id").abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "write quick-note anchors"
    );
    if (error) throw error;
    if (!updated || !updated.length) {
      const userId = cachedUserId();
      if (!userId) return false;
      await ensureQuickNotesDeck(userId);
      ({ data: updated, error } = await withTimeout(
        abortable((signal) => supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id").abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "write quick-note anchors"
      ));
      if (error) throw error;
      if (!updated || !updated.length) return false;
    }
    return true;
  } catch (error) {
    console.warn("Could not sync quick-note source anchors to cloud", error);
    return false;
  }
}

// Deck notes indexed for searching, built once per board open (notes can be
// large; one pass beats re-fetching per card).
export let qnDeckNotesCache = null;

// Setter: an imported binding is read-only, and the board invalidates the cached deck notes when it reloads.
export function setQnDeckNotesCache(value) {
  qnDeckNotesCache = value;
}

export async function loadDeckNotesForSearch() {
  if (qnDeckNotesCache) return qnDeckNotesCache;
  const qid = getQuickNotesDeckId();
  const decks = [];
  const seen = new Set();

  // Local snapshots first: free, offline, and they carry the localId that makes
  // the jump instant. Streamed via a cursor (see forEachDeckSnapshot) rather
  // than reading each by id — the index is only consulted for its title
  // fallback, not to drive the loop, so a stashed notes-conflict entry
  // (which isn't in the index) is simply skipped by the `if (!indexEntry)`
  // below instead of needing to be filtered out explicitly.
  const indexById = new Map(readLocalDeckIndex().map((entry) => [String(entry.id), entry]));
  await forEachDeckSnapshot((id, snapshot) => {
    const indexEntry = indexById.get(String(id));
    if (!indexEntry) return;
    if (snapshot.deckId && snapshot.deckId === qid) return; // never match the board itself
    const plain = notesAnchorPlainText(snapshot.notes || "");
    if (!plain) return;
    if (snapshot.deckId) seen.add(String(snapshot.deckId));
    decks.push({
      localId: indexEntry.id,
      deckId: snapshot.deckId || null,
      title: snapshot.deckTitle || indexEntry.title || "source",
      plain
    });
  });

  // Then any cloud deck this device has no local copy of.
  if (supabaseClient && isSignedIn && navigator.onLine) {
    try {
      const { data, error } = await withTimeout(
        abortable((signal) => supabaseClient.from("decks").select("id, title, notes").abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "read deck notes"
      );
      if (error) throw error;
      for (const deck of data || []) {
        if (!deck || String(deck.id) === qid || seen.has(String(deck.id))) continue;
        const plain = notesAnchorPlainText(deck.notes || "");
        if (!plain) continue;
        decks.push({ localId: null, deckId: String(deck.id), title: deck.title || "source", plain });
      }
    } catch (error) {
      console.warn("Could not load deck notes to recover quick-note sources", error);
    }
  }

  setQnDeckNotesCache(decks);
  return decks;
}

// Find and persist source anchors for every note that lacks one. Runs in the
// background after the board paints, then re-renders so the buttons appear.
export async function resolveMissingQuickNoteSources() {
  const missing = qnBoard.cards.filter((c) => !c.noteAnchor);
  if (!missing.length) return;
  const decks = await loadDeckNotesForSearch();
  if (!decks.length) return;

  const patch = {};
  for (const card of missing) {
    const needle = notesAnchorPlainText(card.question);
    // Very short snippets match half the library; a wrong jump is worse than
    // no button.
    if (needle.length < 6) continue;
    const hit = decks.find((d) => d.plain.includes(needle));
    if (!hit) continue;
    const anchor = trimNoteAnchor({
      offset: null,
      source: "",
      text: needle,
      deckId: hit.deckId,
      deckLocalId: hit.localId,
      deckTitle: hit.title,
      guessed: true
    });
    if (!anchor) continue;
    card.noteAnchor = anchor;
    patch[String(card.id)] = anchor;
  }

  if (!Object.keys(patch).length) return;
  renderQuickNotesBoard();
  // One write for the whole batch, so this never runs again for these notes.
  saveQuickNoteAnchors(patch);
}

// Assign (or clear, when categoryId is falsy) a card's subject category.
// Local-only: patches the snapshot, marks the card dirty, and bumps updatedAt
// so the next reconcile carries it up with everything else. It used to fire an
// immediate `cards` UPDATE per tap, which on a phone meant a round trip for
// every chip you touched — and did nothing at all offline.
export async function setQuickNoteCardCategory(cardId, categoryId) {
  if (!cardId) return false;
  const value = categoryId ? String(categoryId) : null;
  const now = new Date().toISOString();
  const deckId = getQuickNotesDeckId();
  // Serialised per deck (see withDeckLock) — recategorising a note while a
  // background sync pulls quick_notes must not have either write computed away.
  const patched = deckId
    ? await withDeckLock(quickNotesLocalId(deckId), () => patchQuickNoteCardCategory(cardId, value, now))
    : await patchQuickNoteCardCategory(cardId, value, now);

  // Keep the active study deck in step if the quick_notes deck is open.
  // Outside the lock: this is pure in-memory UI state, no storage involved.
  if (isQuickNotesDeck(state.deckId, state.deckTitle)) {
    if (value) state.categoryById[cardId] = value;
    else delete state.categoryById[cardId];
    // The card's own field has to be cleared too. quickNoteCategoryForCard
    // falls back to it when categoryById has no entry, so leaving a stale value
    // behind made "Uncategorized" spring back to the old label on the next save.
    for (const list of [state.masterCards, state.cards]) {
      const card = Array.isArray(list) ? list.find((c) => String(c.id) === String(cardId)) : null;
      if (card) card.category = value;
    }
  }

  return patched;
}

// The storage half of setQuickNoteCardCategory. Only ever called while holding
// the quick_notes deck lock; must not take it again (deadlock).
export async function patchQuickNoteCardCategory(cardId, value, now) {
  // Local snapshot patch — the only write there is now, and the source of truth
  // the next reconcile pushes from.
  const local = await ensureLocalQuickNotesSnapshot();
  let patched = false;
  if (local && Array.isArray(local.snapshot.cards)) {
    let card = local.snapshot.cards.find((c) => String(c.id) === String(cardId));
    if (!card) {
      // The board reads the cloud directly, so it can show a note this device
      // has never pulled. Adopt it into the snapshot rather than dropping the
      // edit — with the write no longer going straight to the cloud, "not in
      // the local copy" would otherwise mean "silently ignored".
      const fromBoard = qnBoard.cards.find((c) => String(c.id) === String(cardId));
      if (fromBoard) {
        card = {
          id: String(fromBoard.id),
          question: fromBoard.question || "",
          answer: fromBoard.answer || "",
          status: normalizeCardStatus(fromBoard.status),
          category: fromBoard.category || null,
          ...(fromBoard.noteAnchor ? { noteAnchor: fromBoard.noteAnchor } : {})
        };
        local.snapshot.cards.push(card);
        // Adopting a card back into the snapshot must retire any tombstone for
        // it, or the invariant "a present card is not tombstoned" breaks and
        // the two rules fight: the push re-uploads this card while the pull
        // skips it as deleted, so the user's recategorisation flip-flops and
        // is ultimately lost. Same reason appendCardToLocalLibraryDeck and the
        // restore merge call this.
        dropTombstonesForLiveCards(local.snapshot);
      }
    }
    if (card) {
      patched = true;
      card.category = value;
      card.updatedAt = now;
      // Written straight into the snapshot rather than through
      // saveDeckToLibrary, so the dirty flag has to be set by hand — without it
      // the next pull would take the cloud's older category back.
      card.dirty = true;
      local.snapshot.updatedAt = now;
      writeDeckSnapshot(local.localId, local.snapshot);
      const index = readLocalDeckIndex();
      const entry = index.find((e) => e.id === local.localId);
      if (entry) {
        entry.updatedAt = now;
        entry.cardCount = local.snapshot.cards.length;
        writeLocalDeckIndex(index);
      }
    }
  }

  return patched;
}
