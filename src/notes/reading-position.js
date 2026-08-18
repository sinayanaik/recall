// Where you were reading, written down.
//
// The anchor itself is captured in scroll-anchor.js and lives in memory. Until
// now that was the whole story: it only ever reached disk as a passenger on a
// deck save that happened for some other reason (an edit, a card change, the
// pagehide flush). A reader who reads — and does nothing else — therefore saved
// nothing at all, and a reload or an OS reclaiming a backgrounded phone tab put
// them back at the top of the book.
//
// Writing it through the deck record is not an option on the scroll path: that
// serialises the whole note (a 4MB string, plus a read of the previous snapshot
// to compare against) and would fire every time the reader stopped moving. So
// the position gets a store of its own — one small localStorage key for the
// whole library, holding nothing but a position per deck.
//
// The deck's own `meta.readingPosition` is unchanged and still what travels
// between devices (see deckSnapshot). This store is the local truth, and the
// two are reconciled by timestamp on open — see betterReadingPosition.

import { deckReadingPositionsKey } from "../core/constants.js?v=__BUILD__";

// How long after the reader stops moving the position is written. Long enough
// that a scroll through a chapter is one write rather than twenty, short enough
// that a phone killed by the OS a couple of seconds later still has it.
export const READING_POSITION_SAVE_MS = 2000;

// A cap on the store, so a big library cannot grow one localStorage key without
// limit. Evicted oldest-first by the timestamp already on every entry — the
// deck you last read is the one you are most likely to reopen.
export const READING_POSITION_MAX_DECKS = 300;

export let pendingReadingPosition = null;

export let readingPositionTimer = 0;

export function readAllReadingPositions() {
  try {
    const raw = localStorage.getItem(deckReadingPositionsKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    // A corrupt bag is not worth a failure: the position is a convenience, and
    // the next write replaces it wholesale.
    return {};
  }
}

// The stored position for one deck, or null. `key` is currentDeckKey() — the
// caller's, deliberately, so this module never has to reach back into
// scroll-anchor.js and make a cycle out of it.
export function readStoredReadingPosition(key) {
  if (!key) return null;
  const entry = readAllReadingPositions()[key];
  return entry && Number.isFinite(entry.offset) ? entry : null;
}

export function writeStoredReadingPosition(key, anchor) {
  if (!key || !anchor || !Number.isFinite(anchor.offset)) return;
  const all = readAllReadingPositions();
  all[key] = { ...anchor, at: anchor.at || Date.now() };
  const keys = Object.keys(all);
  if (keys.length > READING_POSITION_MAX_DECKS) {
    keys
      .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0))
      .slice(0, keys.length - READING_POSITION_MAX_DECKS)
      .forEach((stale) => delete all[stale]);
  }
  try {
    localStorage.setItem(deckReadingPositionsKey, JSON.stringify(all));
  } catch (error) {
    // Out of quota, or private mode. Losing a reading position is not worth a
    // toast, and the deck's own meta still carries it on the next real save.
    console.warn("Could not store the reading position", error);
  }
}

// Everything, for a device wipe. The entries carry an 80-character snippet of
// each note, so this store belongs to the library it describes — leaving it
// behind after "sign out and remove all decks" would leave one account's note
// text readable to whoever signs in next.
export function forgetAllReadingPositions() {
  pendingReadingPosition = null;
  if (readingPositionTimer) {
    clearTimeout(readingPositionTimer);
    readingPositionTimer = 0;
  }
  try {
    localStorage.removeItem(deckReadingPositionsKey);
  } catch (error) {
    console.warn("Could not clear the stored reading positions", error);
  }
}

export function forgetStoredReadingPosition(key) {
  if (!key) return;
  const all = readAllReadingPositions();
  if (!(key in all)) return;
  delete all[key];
  try {
    localStorage.setItem(deckReadingPositionsKey, JSON.stringify(all));
  } catch (error) {
    console.warn("Could not clear the reading position", error);
  }
}

// Queue a write. Both arguments are captured now rather than read at flush
// time, so a flush that lands after the reader has opened something else still
// writes the position against the deck it was measured in.
export function scheduleReadingPositionSave(key, anchor) {
  if (!key || !anchor) return;
  pendingReadingPosition = { key, anchor };
  if (readingPositionTimer) clearTimeout(readingPositionTimer);
  readingPositionTimer = setTimeout(() => {
    readingPositionTimer = 0;
    flushReadingPositionSave();
  }, READING_POSITION_SAVE_MS);
}

// Write an armed-but-unfired save immediately. Synchronous, start to finish:
// the callers are pagehide and visibilitychange, where an awaited anything is a
// promise nobody is left to keep.
export function flushReadingPositionSave() {
  if (readingPositionTimer) {
    clearTimeout(readingPositionTimer);
    readingPositionTimer = 0;
  }
  if (!pendingReadingPosition) return null;
  const { key, anchor } = pendingReadingPosition;
  pendingReadingPosition = null;
  writeStoredReadingPosition(key, anchor);
  return { key, anchor };
}

// Which of the two positions for a deck is the one to reopen at.
//
// `meta.readingPosition` is what the last device to push knew; the local store
// is what THIS device saw. Neither is authoritative on its own: read on the
// phone, then open on the laptop, and the cloud's copy is the newer one; read
// on the laptop offline and its own is. So compare the timestamps, and treat a
// position with no timestamp at all — written by a build from before this
// existed — as older than one that has one.
export function betterReadingPosition(metaPosition, key) {
  const stored = readStoredReadingPosition(key);
  if (!stored) return metaPosition || null;
  if (!metaPosition || !Number.isFinite(metaPosition.offset)) return stored;
  return (stored.at || 0) >= (metaPosition.at || 0) ? stored : metaPosition;
}
