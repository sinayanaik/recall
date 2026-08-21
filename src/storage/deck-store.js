// Deck bodies live in IndexedDB, not localStorage.
//
// localStorage is synchronous, ~5MB, and reported "storage full" for a library
// that was nowhere near a real quota. The write journal exists because an
// IndexedDB write can be interrupted by the tab closing: the journal is what a
// later session replays, and it is deliberately capped so it cannot itself
// overflow the storage it is protecting.

import { state } from "../core/state.js?v=__BUILD__";
import { deckHasNothingToSave, readLocalDeckIndex, saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { LOCAL_DECK_PREFIX } from "./keys.js?v=__BUILD__";
import { deckAutosaveStorageFailed, deckAutosaveTimer, handleDeckStorageQuotaError, persistWorkingDeck, setDeckAutosaveTimer } from "./quota.js?v=__BUILD__";
import { setSyncIndicator } from "../sync/indicator.js?v=__BUILD__";

// ── Deck snapshot storage — IndexedDB, not localStorage ─────────────────────
// localStorage is capped by browsers at a fixed ~5-10MB per origin, entirely
// unrelated to the device's actual free disk space (the number
// navigator.storage.estimate() reports, and what the Storage & Data panel
// shows as "available"). A library of thousands of decks — cards AND notes,
// which is what actually fills this up — blows that ceiling long before the
// user's real storage is anywhere near full, and the resulting
// QuotaExceededError reads as "the app is broken", not "an unrelated,
// arbitrary browser limit was hit". IndexedDB's quota IS the disk-relative
// one, so moving the bulk data here is what actually removes the ceiling.
//
// deckSnapshotCache is LAZY, not a full mirror: nothing loads at boot (see
// initDeckStorage), and a deck enters the cache the first time it's read or
// written. So RAM scales with how much of the library THIS session has
// actually touched, not with total library size: opening one 20MB note out
// of a 500MB library costs roughly 20MB (plus the small library index), not
// 500MB. It also means readDeckSnapshot is ASYNC — a cold read costs one
// IndexedDB round trip — which is the one contract change every call site
// had to absorb; see its own comment for the failure semantics that matter
// most (a failed read must never be reported as "this deck doesn't exist").
// Writes update the cache immediately — so a read right after a write is
// never stale — and persist to IndexedDB in the background; a persist
// failure routes through handleDeckStorageQuotaError above, the same path
// saveDeckToLibrary already used, so there's one messaging surface, not two.
//
// ── Why residency is now bounded ───────────────────────────────────────────
// This cache used to keep every deck it ever saw for the whole session, on the
// grounds that eviction bookkeeping is its own source of bugs. The cost of that
// showed up as "the app gets laggy after it's been open a while": each entry is
// a whole deck body (notes up to ~1MB, plus every card), so a session that
// browses twenty or thirty decks holds tens of MB it will never read again, and
// the heap only ever grows — longer and more frequent major GCs, worse locality,
// no recovery short of a reload.
//
// The bookkeeping is safe here because this is purely a READ cache: an evicted
// key is simply a cache miss, and readDeckSnapshot already handles a miss by
// re-reading IndexedDB. Two kinds of key are never evictable, and those are the
// only invariants worth remembering —
//   • anything in pendingDeckWrites: its newest version is not on disk yet, so
//     dropping it would let the next read return the older stored copy;
//   • the deck currently open: it's the one guaranteed to be read again.
// Map iteration order is insertion order, so re-inserting on every hit
// (touchDeckSnapshotCache) makes that order recency and the eviction a plain
// walk from the front.
export const DECK_STORE_DB = "recall-decks";

export const DECK_STORE_NAME = "snapshots";

export const deckSnapshotCache = new Map();

// Enough for the working set — the open deck, the one before it, and whatever a
// sync pass is reconciling — without keeping a browsing session's whole history.
export const DECK_SNAPSHOT_CACHE_MAX = 6;

export let deckStoreDbPromise = null;

export function deckSnapshotCachePinned(key) {
  if (pendingDeckWrites.has(key)) return true;
  return key === String(state.localDeckId || "") || key === String(state.deckId || "");
}

// Mark `key` as the most recently used entry and evict the oldest evictable
// entries beyond the cap. Called after every set and every cache hit.
export function touchDeckSnapshotCache(key) {
  if (deckSnapshotCache.has(key)) {
    const value = deckSnapshotCache.get(key);
    deckSnapshotCache.delete(key);
    deckSnapshotCache.set(key, value);
  }
  if (deckSnapshotCache.size <= DECK_SNAPSHOT_CACHE_MAX) return;
  for (const candidate of deckSnapshotCache.keys()) {
    if (deckSnapshotCache.size <= DECK_SNAPSHOT_CACHE_MAX) break;
    if (candidate === key || deckSnapshotCachePinned(candidate)) continue;
    deckSnapshotCache.delete(candidate);
  }
}

// ── Unload durability journal ───────────────────────────────────────────────
// The one thing localStorage did better: its writes were SYNCHRONOUS, so an
// edit saved in the pagehide handler was on disk before the page went away.
// An IndexedDB put is async, and this app's main home is a phone PWA that gets
// backgrounded and then killed by the OS — precisely the moment the last edit
// is still in flight. Losing it would be a data-loss regression traded for a
// quota fix, which is no trade at all.
//
// So: every write not yet CONFIRMED by IndexedDB stays in `pendingDeckWrites`,
// and flushWorkingDeck (pagehide / visibilitychange→hidden) mirrors that map
// into one synchronous localStorage key. initDeckStorage replays it at
// the next boot. Normally the map is empty within a few ms of a save, so the
// journal is usually a no-op and never approaches the localStorage cap — it
// holds in-flight writes only, not the library.
export const DECK_WRITE_JOURNAL_KEY = "flashcards_deck_write_journal_v1";

export const pendingDeckWrites = new Map();

// Whether a journal is currently sitting on disk. Tracked so the journal can be
// cleared the moment it's provably unnecessary — a stale journal is worse than
// no journal, because replaying it would resurrect a deck deleted after the
// journal was written.
export let deckWriteJournalOnDisk = false;

// ── Cross-tab cache coherence ───────────────────────────────────────────────
// localStorage had one property this cache gives up for free: it was SHARED.
// Two tabs read and wrote the same bytes, so a read-modify-write helper
// (renameDeckInLibrary, appendCardToLocalLibraryDeck, setLocalDeckCategory,
// syncLocalLibraryMetaForDeck, setQuickNoteCardCategory) always re-read what
// the other tab had just written. An in-memory cache is per-tab, so without
// this a second tab would keep serving a snapshot from ITS boot, and the next
// rename there would write that stale copy back over the other tab's edits —
// silently losing, say, a quick note pinned moments earlier in tab A.
//
// Each tab announces a committed write/delete; the others refresh just that id
// from IndexedDB. BroadcastChannel never echoes to the sender, so no loop.
// This narrows the window to "between another tab's commit and this tab's
// refresh" rather than "forever", which is the best a synchronous-read design
// can do without making every call site async.
export let deckStoreChannel = null;

// Setter: an imported binding is read-only, and main.js opens the channel lazily.
export function setDeckStoreChannel(value) {
  deckStoreChannel = value;
}

export function announceDeckStoreChange(type, id) {
  if (!deckStoreChannel) return;
  try {
    deckStoreChannel.postMessage({ type, id: String(id) });
  } catch (error) {
    console.warn("Could not announce a deck store change to other tabs", error);
  }
}

// Total characters the journal is allowed to occupy. localStorage gives an
// origin roughly 5MB for everything, and the deck library shares it, so this
// stays well under that — the journal is short-lived insurance, not storage.
export const DECK_JOURNAL_MAX_CHARS = 2_000_000;

// Synchronous by design — the whole point is to complete before the page dies.
export function journalPendingDeckWrites() {
  // The fallback path already writes synchronously to localStorage, so there
  // is nothing in flight to protect.
  if (indexedDbUnavailable) return;
  try {
    if (!pendingDeckWrites.size) {
      if (deckWriteJournalOnDisk) {
        localStorage.removeItem(DECK_WRITE_JOURNAL_KEY);
        deckWriteJournalOnDisk = false;
      }
      return;
    }
    // Serialized deck by deck, biggest dropped first if the whole set won't
    // fit. localStorage caps an origin at a few MB, so one large deck used to
    // make this setItem throw — and the catch below then deletes the journal
    // entirely, taking every OTHER in-flight deck's insurance down with it. A
    // deck too big to journal is unlucky; the small ones sitting behind it in
    // the same Map should not be.
    const entries = [];
    let budget = DECK_JOURNAL_MAX_CHARS;
    for (const [id, snapshot] of pendingDeckWrites) {
      const body = JSON.stringify(snapshot);
      if (body.length > budget) {
        console.warn(`Deck ${id} is too large to journal (${body.length} chars) — its IndexedDB write still stands`);
        continue;
      }
      budget -= body.length;
      entries.push(`${JSON.stringify(String(id))}:${body}`);
    }
    if (!entries.length) {
      if (deckWriteJournalOnDisk) {
        localStorage.removeItem(DECK_WRITE_JOURNAL_KEY);
        deckWriteJournalOnDisk = false;
      }
      return;
    }
    localStorage.setItem(DECK_WRITE_JOURNAL_KEY, `{${entries.join(",")}}`);
    deckWriteJournalOnDisk = true;
  } catch (error) {
    // Journalling is best-effort insurance; failing it must never break the
    // save that already succeeded in memory and is on its way to IndexedDB.
    console.warn("Could not journal in-flight deck writes", error);
    // A journal we failed to UPDATE is worse than none: replaying a stale one
    // could resurrect a deck deleted since it was written. Drop it and rely on
    // what IndexedDB confirmed.
    try {
      localStorage.removeItem(DECK_WRITE_JOURNAL_KEY);
      deckWriteJournalOnDisk = false;
    } catch { /* nothing more to try */ }
  }
}

// True only if IndexedDB itself is unavailable (e.g. Safari private
// browsing) — not a per-write failure. Falls back to the old
// LOCAL_DECK_PREFIX + localStorage behavior for the rest of the session
// rather than losing access to the library.
export let indexedDbUnavailable = false;

// Stronger than indexedDbUnavailable: the deck store holds this library and we
// could not read it. Every deck reads as empty while the real data is intact
// on disk, so any write derived from that emptiness — a push, a pull that
// merges against "no local cards", an autosave — is a way to turn a temporary
// read failure into permanent loss. Set only by initDeckStorage, and it
// bars syncing outright (see reconcileAllDecks). A reload is the fix.
export let deckStoreUnreadable = false;

export function openDeckStore() {
  if (deckStoreDbPromise) return deckStoreDbPromise;
  deckStoreDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DECK_STORE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DECK_STORE_NAME)) {
        db.createObjectStore(DECK_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return deckStoreDbPromise;
}

// Unlike imageOutboxRequest's sibling pattern (which opens a fresh connection
// per call and closes it after), openDeckStore's connection is cached and
// reused for the whole session — this runs on nearly every save, so reopening
// every time would be real overhead. That means it must NOT be closed here:
// closing after the first transaction left every later request calling
// .transaction() on an already-closed IDBDatabase, which throws
// InvalidStateError — caught by writeDeckSnapshot's .catch, so every write
// after the very first appeared to succeed (the in-memory cache still updated)
// while silently never reaching IndexedDB at all. Found by driving this
// against a real browser IndexedDB, not just a stubbed one.
export function deckStoreRequest(mode, run) {
  return openDeckStore().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DECK_STORE_NAME, mode);
    const request = run(tx.objectStore(DECK_STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

// Boot-time setup: NOT a bulk load. deckSnapshotCache starts (and stays)
// empty until something is actually read or written — see readDeckSnapshot.
// This one probe read plus the migration and journal replay below are the
// only IndexedDB traffic at boot; RAM after this returns is just the library
// INDEX (small — title/category/counts), not the library's content.
//
// Sweeps any snapshot still sitting in localStorage from before this store
// existed (or left behind by an interrupted migration on a prior boot) into
// IndexedDB, then removes it from localStorage. Freeing that quota needs no
// user action. Idempotent: a fully-migrated device finds no legacy keys and
// does no work, so this is safe to run every boot rather than needing a
// "migrated" flag that could itself go stale. Migrated snapshots are NOT
// cached here either — the whole point is that boot doesn't scale with
// library size, so the first read of each just warms it lazily like any
// other.
export async function initDeckStorage() {
  deckSnapshotCache.clear();
  try {
    // Cheap (counts, doesn't fetch bodies) but still exercises the exact read
    // path every later get() will use, so a broken store is caught here in
    // one place instead of piecemeal as decks are touched during the session.
    await deckStoreRequest("readonly", (store) => store.count());
  } catch (error) {
    console.warn("IndexedDB unavailable — deck snapshots will stay in localStorage this session", error);
    indexedDbUnavailable = true;
    // Two very different situations look identical from here, and only one is
    // safe. Private browsing / a blocked IndexedDB means this device never had
    // a deck store, and localStorage IS the library — degraded but correct.
    // A store that exists and holds the library but couldn't be READ this once
    // is something else entirely: every deck would come back empty while the
    // real data sits intact on disk. Tell them apart by whether the library
    // index describes decks that localStorage cannot account for.
    const indexedDecks = readLocalDeckIndex().length;
    const localSnapshots = Object.keys(localStorage).filter((key) => key.startsWith(LOCAL_DECK_PREFIX)).length;
    if (indexedDecks > 0 && localSnapshots === 0) {
      deckStoreUnreadable = true;
      console.error(
        `Deck store could not be read, but the library index lists ${indexedDecks} deck(s). ` +
        "Their contents are still on this device — refusing to sync so nothing overwrites them."
      );
    }
    return;
  }

  const legacyKeys = Object.keys(localStorage).filter((key) => key.startsWith(LOCAL_DECK_PREFIX));
  let migrated = 0;
  for (const key of legacyKeys) {
    const id = key.slice(LOCAL_DECK_PREFIX.length);
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      const snapshot = JSON.parse(raw);
      await deckStoreRequest("readwrite", (store) => store.put({ id, snapshot }));
      localStorage.removeItem(key);
      migrated++;
    } catch (error) {
      // Left in place on purpose — it's picked up again (and retried) next
      // boot instead of being silently dropped.
      console.warn(`Could not migrate deck snapshot ${id} to IndexedDB — left in localStorage, will retry next boot`, error);
    }
  }
  if (migrated) console.log(`Migrated ${migrated} deck snapshot(s) from localStorage to IndexedDB.`);

  // Writes that were still in flight when the app was last closed (see
  // journalPendingDeckWrites). Applied LAST so they win over both IndexedDB
  // and any legacy key — by definition they are the newest thing this device
  // knows about that deck. Also seeded into the cache (not just IndexedDB):
  // a deck that was mid-edit when the app died is exactly the deck the user
  // is about to resume, so warming it costs nothing and saves the first read
  // a round trip.
  try {
    const journalRaw = localStorage.getItem(DECK_WRITE_JOURNAL_KEY);
    if (journalRaw) {
      const journal = JSON.parse(journalRaw);
      let replayed = 0;
      for (const [id, snapshot] of Object.entries(journal || {})) {
        if (!id || !snapshot) continue;
        deckSnapshotCache.set(id, snapshot);
        await deckStoreRequest("readwrite", (store) => store.put({ id, snapshot }));
        replayed++;
      }
      localStorage.removeItem(DECK_WRITE_JOURNAL_KEY);
      deckWriteJournalOnDisk = false;
      if (replayed) console.log(`Recovered ${replayed} deck edit(s) that were still saving when the app last closed.`);
    }
  } catch (error) {
    // A journal we can't read is not worth failing the boot over — the app
    // still has everything IndexedDB confirmed.
    console.warn("Could not replay the deck write journal", error);
  }
}

// Best-effort: reduces the chance the browser evicts this origin's storage
// under disk pressure. Never called anywhere before this. Non-blocking —
// boot doesn't wait on it, and a denial just means the (pre-existing) risk
// of eviction under real disk pressure is unchanged.
export let storagePersisted = null;

export function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  navigator.storage.persist()
    .then((granted) => { storagePersisted = granted; })
    .catch((error) => console.warn("Could not request persistent storage", error));
}

// One copy routine for both directions. structuredClone is the fast path, but
// it throws on anything non-cloneable (a stray function or DOM node that
// JSON.stringify would have quietly dropped) and doesn't exist at all on
// pre-2022 browsers — either of which, unguarded, would break saving outright.
// The JSON round-trip is exactly what the old localStorage code did, so the
// fallback is a return to previous behaviour, not a new risk.
// ── Per-deck serialisation ─────────────────────────────────────────────────
// Reading a deck used to be synchronous, so every read-modify-write of a
// snapshot (a pull merging cloud cards, an autosave, pinning a quick note, a
// rename) ran start-to-finish with no yield point — atomic against the rest of
// the app by construction. Making reads async (see readDeckSnapshot) removed
// that guarantee, and the gap is genuinely reachable: pinning a note while a
// background sync pulls the same deck let the pull write back a merge computed
// from the pre-pin copy, DESTROYING a card another device had just added, and
// leaving the index's cardCount disagreeing with the snapshot.
//
// This restores the old guarantee explicitly: operations that read-modify-write
// one deck queue behind each other per deck id. Different decks never block
// each other, and nothing here holds a lock across a network call — only across
// local storage work — so a slow cloud round trip can't stall editing.
//
// MUST NOT NEST: a locked operation calling another locked operation for the
// same deck would deadlock. Helpers meant to be called from inside a lock
// (ensureLocalQuickNotesSnapshot, readLocalSnapshotByDeckId) are deliberately
// left unlocked.
export const deckWriteLocks = new Map();

export function withDeckLock(id, fn) {
  const key = String(id || "");
  if (!key) return Promise.resolve(fn());
  const previous = deckWriteLocks.get(key) || Promise.resolve();
  // Runs after the previous holder settles either way — one operation failing
  // must never wedge the queue for that deck.
  const result = previous.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  deckWriteLocks.set(key, tail);
  tail.then(() => { if (deckWriteLocks.get(key) === tail) deckWriteLocks.delete(key); });
  return result;
}

export function cloneSnapshot(snapshot) {
  try {
    return structuredClone(snapshot);
  } catch (error) {
    try {
      return JSON.parse(JSON.stringify(snapshot));
    } catch (jsonError) {
      console.error("Could not copy a deck snapshot", jsonError);
      return null;
    }
  }
}

// ASYNC — this is the one contract change the lazy cache forces on every
// caller. Warm reads (the deck already touched this session) resolve on the
// next microtask, same latency class as before; a cold read costs one
// IndexedDB round trip (sub-millisecond to a few ms for a warm connection).
//
// Failure contract matters as much as the happy path: a `get()` that THROWS
// must never be reported the same way as "confirmed absent" (a `get()` that
// resolved with nothing). Collapsing those two into one `null` is exactly the
// shape of bug that once turned an unauthenticated cloud read into a mass
// deletion (see sync-deletion-safety) — a caller here could just as easily
// read a failed local read as "this deck doesn't exist" and delete/overwrite
// accordingly. So a real failure THROWS; only a confirmed-empty result
// returns null. Most callers already sit inside error handling (sync's
// per-deck catch, or a try/catch around the old localStorage.getItem this
// replaced) and only need `await` added — this is called out explicitly at
// each call site rather than swallowed here.
export async function readDeckSnapshot(id) {
  if (!id) return null;
  const key = String(id);
  if (indexedDbUnavailable) {
    try {
      const raw = localStorage.getItem(LOCAL_DECK_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  if (deckSnapshotCache.has(key)) {
    const hit = cloneSnapshot(deckSnapshotCache.get(key));
    touchDeckSnapshotCache(key);
    return hit;
  }
  let row;
  try {
    row = await deckStoreRequest("readonly", (store) => store.get(key));
  } catch (error) {
    console.error(`Could not read deck snapshot ${key} from IndexedDB`, error);
    throw error;
  }
  // A write for this deck landed while our read was in flight, so what came
  // back from disk is already history. Returning it would hand the caller a
  // stale base to modify — and, worse, caching it would replace a newer
  // in-memory snapshot with an older one for every later reader. The live
  // value always wins.
  if (deckSnapshotCache.has(key)) {
    const live = cloneSnapshot(deckSnapshotCache.get(key));
    touchDeckSnapshotCache(key);
    return live;
  }
  if (!row || !row.snapshot) return null; // confirmed absent — not a failure
  // Warm the cache — as the most recently used entry, which may evict the
  // coldest deck past the cap (see the block comment above).
  deckSnapshotCache.set(key, row.snapshot);
  touchDeckSnapshotCache(key);
  // A clone, never the cache's own object. Call sites throughout the app read
  // a snapshot, mutate it in memory, and only SOMETIMES call writeDeckSnapshot
  // to persist the result (e.g. a pre-push reconcile that decides nothing
  // actually changed). Handing out the live object would let that in-memory
  // mutation silently corrupt what every other reader of this deck sees for
  // the rest of the session, even though nothing was ever saved — exactly
  // what the old fresh JSON.parse-per-read made impossible by construction.
  return cloneSnapshot(row.snapshot);
}

// Synchronous from the caller's point of view — the cache (and therefore
// every subsequent readDeckSnapshot) is updated before this returns. The
// IndexedDB persist itself is fire-and-forget; see the block comment above
// for why that's an acceptable trade for keeping ~48 call sites synchronous.
// Clones before storing too, so a caller that keeps mutating its own
// `snapshot` variable after calling this can't reach back into the cache.
export function writeDeckSnapshot(id, snapshot) {
  if (!id) return;
  const key = String(id);
  if (indexedDbUnavailable) {
    try {
      localStorage.setItem(LOCAL_DECK_PREFIX + key, JSON.stringify(snapshot));
    } catch (error) {
      handleDeckStorageQuotaError(error);
    }
    return;
  }
  const stored = cloneSnapshot(snapshot);
  if (!stored) return;
  deckSnapshotCache.set(key, stored);
  pendingDeckWrites.set(key, stored);
  // After pendingDeckWrites, so this key is pinned against its own eviction.
  touchDeckSnapshotCache(key);
  deckStoreRequest("readwrite", (store) => store.put({ id: key, snapshot: stored })).then(() => {
    // Identity-compared: a newer write for the same deck may have replaced this
    // one while the transaction was open, and that one is still unconfirmed.
    if (pendingDeckWrites.get(key) === stored) pendingDeckWrites.delete(key);
    // Provably nothing in flight — drop the journal rather than leave a stale
    // copy that a later boot would replay over newer truth.
    if (!pendingDeckWrites.size && deckWriteJournalOnDisk) journalPendingDeckWrites();
    // Announced only once COMMITTED, so a tab that reacts by reading IndexedDB
    // is guaranteed to find this version rather than the one it replaced.
    announceDeckStoreChange("write", key);
  }).catch((error) => {
    console.warn("Could not persist deck snapshot to IndexedDB", key, error);
    handleDeckStorageQuotaError(error);
  });
}

export function deleteDeckSnapshot(id) {
  if (!id) return;
  const key = String(id);
  if (indexedDbUnavailable) {
    localStorage.removeItem(LOCAL_DECK_PREFIX + key);
    return;
  }
  deckSnapshotCache.delete(key);
  const wasPending = pendingDeckWrites.delete(key);
  // Rewrite the journal immediately if this deck could still be sitting in it.
  // Waiting until the next pagehide would leave a window where a crash replays
  // a journal entry for a deck the user just deleted — resurrecting it.
  if (wasPending && deckWriteJournalOnDisk) journalPendingDeckWrites();
  deckStoreRequest("readwrite", (store) => store.delete(key))
    .then(() => announceDeckStoreChange("delete", key))
    .catch((error) => {
      console.warn("Could not delete deck snapshot from IndexedDB", key, error);
    });
}

// Every id currently holding a snapshot (main deck bodies AND notes-conflict
// stashes, which share this namespace via the NOTES_CONFLICT_SUFFIX-suffixed
// id — see pruneOrphanedDeckSnapshots). ASYNC and reads IndexedDB directly
// (getAllKeys, not getAll — ids only, no bodies): with a lazy cache,
// deckSnapshotCache.keys() would only list decks touched THIS session, not
// everything on disk, which is exactly wrong for "find every id" callers
// (pruning orphans, counting the library).
export async function allDeckSnapshotIds() {
  if (indexedDbUnavailable) {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(LOCAL_DECK_PREFIX))
      .map((key) => key.slice(LOCAL_DECK_PREFIX.length));
  }
  const keys = await deckStoreRequest("readonly", (store) => store.getAllKeys());
  return keys.map(String);
}

// Streams every {id, snapshot} pair to `visit` via an IndexedDB cursor —
// one record resident at a time, not the whole store — for the read-only
// passes that touch every deck (the storage report's byte count, the
// image-reference scan, the quick-note source search). Using readDeckSnapshot
// per id in a loop would work too, but it's N separate transactions where
// this is one; on the large library this whole change exists to support,
// that difference is the collection finishing in a reasonable time at all.
// `visit` may be async and may return `false` to stop early.
//
// Deliberately reads the object store directly rather than checking the
// cache first: a cache hit would still need cloning to be scan-safe, at
// which point there is no saving left over a cursor row. The one accepted
// cost is that a deck with a write still in flight (see pendingDeckWrites)
// may be seen here at its previous, still-durable value until that write
// lands a moment later — fine for these informational/search uses, where a
// user browsing while a scan runs is not staking data safety on the result.
export async function forEachDeckSnapshot(visit) {
  if (indexedDbUnavailable) {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LOCAL_DECK_PREFIX)) continue;
      const id = key.slice(LOCAL_DECK_PREFIX.length);
      let snapshot = null;
      try { snapshot = JSON.parse(localStorage.getItem(key) || "null"); } catch { continue; }
      if (snapshot && (await visit(id, snapshot)) === false) return;
    }
    return;
  }
  const db = await openDeckStore();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DECK_STORE_NAME, "readonly");
    const request = tx.objectStore(DECK_STORE_NAME).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      Promise.resolve(visit(cursor.value.id, cursor.value.snapshot))
        .then((keepGoing) => {
          if (keepGoing === false) resolve();
          else cursor.continue();
        })
        .catch(reject);
    };
  });
}

// Used by wipeLocalLibrary / an account switch — every snapshot, gone.
export async function clearAllDeckSnapshots() {
  // Both paths: a journal that outlived the library it describes would replay
  // the wiped decks straight back on the next boot (and on an account switch,
  // into the WRONG account's library).
  pendingDeckWrites.clear();
  try {
    localStorage.removeItem(DECK_WRITE_JOURNAL_KEY);
    deckWriteJournalOnDisk = false;
  } catch { /* nothing journalled */ }
  if (indexedDbUnavailable) {
    Object.keys(localStorage).filter((key) => key.startsWith(LOCAL_DECK_PREFIX)).forEach((key) => localStorage.removeItem(key));
    return;
  }
  deckSnapshotCache.clear();
  try {
    await deckStoreRequest("readwrite", (store) => store.clear());
  } catch (error) {
    console.warn("Could not clear IndexedDB deck store", error);
  }
  announceDeckStoreChange("clear", "");
}

export function scheduleDeckAutosave() {
  // After a storage-quota failure, stop scheduling further writes — the
  // toast already told the user, and hammering a full store just wastes CPU
  // and fires more confusing errors.
  if (deckAutosaveStorageFailed) return;
  if (deckAutosaveTimer) clearTimeout(deckAutosaveTimer);
  setDeckAutosaveTimer(setTimeout(async () => {
    setDeckAutosaveTimer(null);
    persistWorkingDeck();
    // An empty deck (e.g. the last card was just deleted) has nothing to
    // save — saveDeckToLibrary correctly no-ops and returns null for this,
    // but that's not a storage failure, so don't treat it as one.
    //
    // Shares saveDeckToLibrary's own predicate rather than restating it: they
    // have to agree, and when they last disagreed a PDF deck's highlights were
    // silently dropped on every reload while this line reported "saved".
    if (deckHasNothingToSave()) {
      setSyncIndicator("saved");
      return;
    }
    // The save is async now, so a throw here would become an unhandled
    // rejection inside a timer — invisible, and it would leave the pill
    // claiming whatever it last said. Autosave is the single most important
    // background job in the app; it has to report its own failures.
    try {
      const savedMeta = await saveDeckToLibrary({ silent: true });
      // A genuine quota failure already latched deckAutosaveStorageFailed and
      // showed its toast inside saveDeckToLibrary (via handleDeckStorageQuotaError)
      // — nothing left to do here but reflect the outcome in the pill.
      setSyncIndicator(savedMeta ? "saved" : "error");
    } catch (error) {
      console.error("Autosave failed", error);
      setSyncIndicator("error");
    }
  }, 400));
}

// Write out an armed-but-unfired autosave for the deck that is open RIGHT NOW,
// before something replaces it.
//
// The 400ms debounce means the last stretch of typing lives only in memory.
// Nothing used to flush it on navigation, so following a wikilink (or pressing
// Back) within 400ms of the last keystroke silently dropped those edits: the
// timer fired afterwards, read a `state` that by then described a different
// deck, and saved that one instead.
//
// Callers MUST await this while `state` still describes the outgoing deck, and
// MUST re-check their load token afterwards — this introduces an await, and so
// a fresh window in which the user can open something else.
export async function flushPendingDeckAutosave() {
  if (!deckAutosaveTimer) return;
  clearTimeout(deckAutosaveTimer);
  setDeckAutosaveTimer(null);
  persistWorkingDeck();
  // Same no-op case the timer itself handles — an empty deck has nothing to
  // save and this is not a storage failure.
  if (!state.masterCards.length && !state.notes.trim()) return;
  try {
    const savedMeta = await saveDeckToLibrary({ silent: true });
    setSyncIndicator(savedMeta ? "saved" : "error");
  } catch (error) {
    // Never let a failed flush block the navigation the user asked for.
    console.error("Could not flush pending autosave before navigating", error);
    setSyncIndicator("error");
  }
}
