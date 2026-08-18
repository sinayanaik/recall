// Deck deletions, and the guards around them.
//
// A tombstone records that a deck was deleted ON PURPOSE, so another device
// holding a stale copy does not re-create it. Its origin matters: a deletion
// the user asked for is authoritative, one merely INFERRED from an absence is
// not, and only the former is ever published.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { resetStudyDeck } from "../cards/study.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { deckStorageKey, defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { deleteDeckFromLibrary, readLocalDeckIndex, writeLocalDeckIndex } from "./local-library.js?v=__BUILD__";
import { readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { LOCAL_DECK_TOMBSTONES_KEY, clearMissingDeckWatch } from "../storage/keys.js?v=__BUILD__";
import { deckAutosaveTimer, persistWorkingDeck, setDeckAutosaveTimer } from "../storage/quota.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

export function readDeckTombstones() {
  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_DECK_TOMBSTONES_KEY) || "{}");
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

export function writeDeckTombstones(map) {
  localStorage.setItem(LOCAL_DECK_TOMBSTONES_KEY, JSON.stringify(map));
}

export function isDeckTombstoned(deckId) {
  return deckId ? Boolean(readDeckTombstones()[String(deckId)]) : false;
}

// Where a tombstone came from, which decides whether it may be PUBLISHED to the
// shared deleted_decks table:
//
//   "user"     — someone deleted this deck on this device. A real, intentional
//                deletion, and the only kind that earns a permanent shared
//                record telling every other device to drop its copy.
//   "inferred" — nobody deleted anything here; this device merely observed the
//                deck missing from the cloud and concluded it must have been
//                deleted elsewhere. That conclusion is a guess, and publishing a
//                guess is how a local misread became global, permanent loss:
//                the shared record is never pruned, so it goes on suppressing
//                the deck on every device forever, including after a restore.
//                Kept local-only — it still stops THIS device from re-pushing,
//                and any other device can derive the same absence for itself.
export const TOMBSTONE_ORIGIN_USER = "user";

export const TOMBSTONE_ORIGIN_INFERRED = "inferred";

// Entries were plain ISO strings before origins existed. Those all predate the
// inference path being distrusted, and every one of them was written by an
// explicit delete, so read a bare string as "user".
export function deckTombstoneOrigin(deckId) {
  const entry = readDeckTombstones()[String(deckId)];
  if (!entry) return null;
  if (typeof entry === "string") return TOMBSTONE_ORIGIN_USER;
  return entry.origin === TOMBSTONE_ORIGIN_INFERRED ? TOMBSTONE_ORIGIN_INFERRED : TOMBSTONE_ORIGIN_USER;
}

export function tombstoneDeck(deckId, origin = TOMBSTONE_ORIGIN_USER) {
  if (!deckId) return;
  const map = readDeckTombstones();
  map[String(deckId)] = { at: new Date().toISOString(), origin };
  writeDeckTombstones(map);
}

export function clearDeckTombstone(deckId) {
  if (!deckId) return;
  const map = readDeckTombstones();
  if (map[String(deckId)] !== undefined) {
    delete map[String(deckId)];
    writeDeckTombstones(map);
  }
}

// ── Un-deleting a deck (restore from backup) ────────────────────────────────
// A tombstone is designed to be permanent, and rows in the shared deleted_decks
// table are never pruned — which is exactly right for a deletion and exactly
// wrong for a restore. Bringing a deleted deck back therefore used to fail in a
// way that looked like the restore had worked: sync 1 saw the shared record,
// dropped the local tombstone as "fully propagated" and re-pushed the deck;
// sync 2 read that same still-present shared record, re-adopted the tombstone
// and deleted the local copy for good.
//
// Retiring the tombstone means clearing BOTH records, and clearing them in the
// right order: dropping only the local one lets the reassert pass re-create the
// shared one, and dropping only the shared one lets the local one re-delete the
// deck. So the shared row goes first, and the local tombstone is only forgotten
// once that has actually landed. If the cloud is unreachable the ids stay
// queued and both records stay put — the deck survives locally, it just doesn't
// sync until the queue drains.
//
// Caveat: this retires the tombstones THIS device holds. Another device that
// independently deleted the same deck still holds its own local tombstone and
// will re-delete the deck when it next syncs — a genuine conflict (one device
// says restore, the other says delete) that no local record can settle.
export const PENDING_UNTOMBSTONE_KEY = "recall:pendingUntombstone";

export function readPendingUntombstones() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_UNTOMBSTONE_KEY) || "[]");
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function queuePendingUntombstones(deckIds) {
  const ids = (deckIds || []).map(String).filter(Boolean);
  if (!ids.length) return;
  const merged = Array.from(new Set([...readPendingUntombstones(), ...ids]));
  try { localStorage.setItem(PENDING_UNTOMBSTONE_KEY, JSON.stringify(merged)); } catch (_) {}
}

export function clearPendingUntombstones() {
  try { localStorage.removeItem(PENDING_UNTOMBSTONE_KEY); } catch (_) {}
}

// Returns how many ids were retired. Called from reconcileAllDecks BEFORE the
// deck index and tombstone list are read, so the un-delete is already in place
// by the time the passes that act on tombstones run.
// Ids per delete request. Same reasoning and roughly the same size as
// CARD_FETCH_DECK_CHUNK; kept local rather than imported so this module does
// not depend on the cloud deck-list reader for a constant about URL length.
export const UNTOMBSTONE_CHUNK = 50;

export async function flushPendingUntombstones() {
  const ids = readPendingUntombstones();
  if (!ids.length) return 0;
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return 0;
  try {
    // CHUNKED, same 8KB request-line ceiling as every other `.in()` in this
    // app (see CARD_FETCH_DECK_CHUNK). A Restore is what gets you here with
    // hundreds of ids at once, and a 414 would leave every restored deck still
    // tombstoned — which the next sync would honour by deleting it again.
    for (let i = 0; i < ids.length; i += UNTOMBSTONE_CHUNK) {
      const { error } = await withTimeout(
        abortable((signal) => supabaseClient.from("deleted_decks").delete().in("deck_id", ids.slice(i, i + UNTOMBSTONE_CHUNK)).abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "clear delete tombstones"
      );
      if (error) throw error;
    }
  } catch (error) {
    // Keep the queue: replaying a delete-by-id is idempotent, and until it
    // lands the local tombstone has to stay too (see the ordering note above).
    console.warn("Could not retire the delete tombstones for restored decks", error);
    return 0;
  }
  ids.forEach(clearDeckTombstone);
  // A restored deck starts with a clean slate: any lingering "seen missing"
  // observations would otherwise carry over and count toward deleting the deck
  // the user just went to the trouble of bringing back.
  ids.forEach(clearMissingDeckWatch);
  clearPendingUntombstones();
  return ids.length;
}

// Clear the currently-open deck back to the empty home screen and cancel any
// pending autosave. Used when the deck you're looking at is deleted — without
// this, the lingering debounced save (or the next navigation on the still-
// visible deck) would call saveDeckToLibrary and re-create it as a brand-new
// local deck, resurrecting exactly what was just deleted.
export function resetActiveDeckAfterDelete() {
  if (deckAutosaveTimer) {
    clearTimeout(deckAutosaveTimer);
    setDeckAutosaveTimer(null);
  }
  state.deckId = null;
  state.localDeckId = null;
  state.deckTitle = "";
  state.deckCategory = defaultDeckCategory;
  state.notes = "";
  state.sourceTitle = "";
  state.importTitleHint = "";
  state.masterCards = [];
  state.statusById = {};
  state.current = 0;
  resetStudyDeck(state.masterCards);
  try { localStorage.removeItem(deckStorageKey); } catch { /* storage may be unavailable */ }
  setViewMode("cards");
  closeAllCardsPanel();
  showCard();
}

// Remove local decks the user has CONFIRMED were deleted elsewhere, after the
// sync declined to do it on its own (see the blast-radius cap in
// reconcileAllDecks). Local-only, on purpose: it deletes no cloud row — there is
// nothing there to delete, that being the whole reason we're here — and writes
// no shared tombstone, because "they're missing from my cloud list" is still an
// inference even once a user has agreed with it. Returns how many were removed.
export function removeDecksMissingFromCloud(entries) {
  let removed = 0;
  for (const entry of entries || []) {
    const deckId = String(entry.deckId || "");
    if (!deckId) continue;
    // Re-resolve the local row: the index has been rewritten several times since
    // the entry was built, so a stale local id could delete the wrong snapshot.
    const meta = readLocalDeckIndex().find((m) => String(m.deckId) === deckId);
    // Entries backed by a shared deleted_decks record are a real deletion the
    // user has now confirmed, so they tombstone as "user" — that record already
    // exists in the cloud, and matching it keeps the deck from bouncing back.
    // Entries derived purely from absence stay "inferred" and local-only.
    tombstoneDeck(deckId, entry.origin === TOMBSTONE_ORIGIN_USER ? TOMBSTONE_ORIGIN_USER : TOMBSTONE_ORIGIN_INFERRED);
    clearMissingDeckWatch(deckId);
    if (!meta) continue;
    const wasActive = state.deckId && String(state.deckId) === deckId;
    deleteDeckFromLibrary(meta.id);
    if (wasActive) resetActiveDeckAfterDelete();
    removed++;
  }
  return removed;
}

// Delete a deck from EVERYWHERE it lives — the on-device library AND the cloud
// mirror — and tombstone its cloud id so a background reconcile (or another
// device still holding a copy) can't resurrect it. This is the only correct way
// to delete in a two-way mirror; deleting just one side always lets sync bring
// the deck back. `localId` and/or `deckId` may be given; a missing `deckId` is
// resolved from the local index. Returns { cloudError } (best-effort: the
// tombstone still blocks re-pull if the cloud delete fails and is retried later).
export async function deleteDeckEverywhere({ localId = null, deckId = null } = {}) {
  if (localId && !deckId) {
    const meta = readLocalDeckIndex().find((m) => m.id === localId);
    deckId = meta?.deckId || null;
  }

  // Capture this BEFORE deleteDeckFromLibrary nulls state.localDeckId.
  const wasActiveDeck =
    (localId && state.localDeckId && String(localId) === String(state.localDeckId)) ||
    (deckId && state.deckId && String(deckId) === String(state.deckId));

  if (deckId) tombstoneDeck(deckId);
  if (localId) deleteDeckFromLibrary(localId);
  if (state.deckId && String(state.deckId) === String(deckId)) state.deckId = null;
  if (wasActiveDeck) resetActiveDeckAfterDelete();

  let cloudError = null;
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    // Record the durable cross-device tombstone FIRST — it's the signal every
    // other device relies on to not re-push its still-held copy (see
    // supabase_setup.sql). Writing it before the row delete is
    // strictly safer: if the delete below fails, a device that adopts this
    // tombstone re-deletes the row (see the pull loop in reconcileAllDecks),
    // whereas the reverse order can delete the row but leave no record — and a
    // later reconcile would then prune the local tombstone and let the deck
    // resurrect. A failed write here (offline blip, or unmigrated project with
    // no deleted_decks table) is retried by reconcileAllDecks while the local
    // tombstone persists, so the deletion still eventually propagates.
    // supabase-js reports failures via the returned `error`, not by throwing.
    // A failed write here is retried by reconcileAllDecks while the local
    // tombstone persists, so the deletion still eventually propagates.
    const { error: tombstoneError } = await withTimeout(abortable((signal) => supabaseClient.from("deleted_decks").upsert({ deck_id: deckId }).abortSignal(signal)), CLOUD_TIMEOUT_MS, "record delete tombstone");
    if (tombstoneError) console.warn("Could not record cross-device delete tombstone", tombstoneError);
    const { error } = await withTimeout(abortable((signal) => supabaseClient.from("decks").delete().eq("id", deckId).abortSignal(signal)), CLOUD_TIMEOUT_MS, "delete deck");
    cloudError = error || null;
  }
  return { cloudError };
}

export async function renameDeckInLibrary(id, title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return;
  return withDeckLock(id, async () => {
    const index = readLocalDeckIndex();
    const entry = index.find((e) => e.id === id);
    if (entry) {
      entry.title = trimmed;
      entry.updatedAt = new Date().toISOString();
      writeLocalDeckIndex(index);
    }
    const payload = await readDeckSnapshot(id);
    if (payload) {
      payload.deckTitle = trimmed;
      // Keep sourceTitle in sync so the snapshot is self-consistent — without
      // this, loadDeckFromLibrary reads the stale sourceTitle and the card's
      // header reverts to the old name even though the index shows the new one.
      payload.sourceTitle = trimmed;
      payload.importTitleHint = trimmed;
      writeDeckSnapshot(id, payload);
    }
    if (state.localDeckId === id) {
      state.deckTitle = trimmed;
      state.sourceTitle = trimmed;
      persistWorkingDeck();
    }
  });
}
