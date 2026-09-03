// Storage keys, and the guards that stop an absent cloud deck being mistaken
// for a deleted one.
//
// A deck missing from a cloud read is ambiguous. Treating absence as deletion
// once wiped every device: a read without a valid session succeeds and matches
// nothing, which the old sync read as "everything was deleted elsewhere". An
// absence must now be seen repeatedly, minutes apart, before it counts.

import { showToast } from "../ui/feedback.js?v=__BUILD__";

// ---------------------------------------------------------------------------
// Offline persistence — all plain localStorage, so it works with no network.
//   • deckStorageKey            : the single "working" deck, saved during a session
//                                 but NOT auto-restored on boot (cleared on launch,
//                                 see clearBrowserPersistence) so a refresh starts
//                                 on the clean home screen
//   • LOCAL_DECKS_INDEX_KEY     : array of saved-deck metadata (the "My Decks" list)
//   • LOCAL_DECK_PREFIX + <id>  : the full snapshot for one saved deck
// ---------------------------------------------------------------------------
export const LOCAL_DECKS_INDEX_KEY = "flashcards_local_decks_index_v1";

export const LOCAL_DECK_PREFIX = "flashcards_local_deck_v1:";

// Suffix for the sibling key holding a deck-notes body that a pull replaced
// while this device had unsynced edits of its own. Deck notes are free markdown
// and stay last-write-wins (the per-card merge can't help there), so the losing
// text is stashed here rather than destroyed. See pullCloudDeckToLibrary.
export const NOTES_CONFLICT_SUFFIX = ":notes-conflict";

// Timestamp of the last reconcile that completed without throwing (whether or
// not it found anything to change) — survives reloads so the startup screen
// can say "last checked Xm ago" even before the next reconcile finishes.
export const LAST_GLOBAL_SYNC_KEY = "flashcards_last_global_sync_at";

// Set when a reconcile throws, cleared the next time one completes cleanly —
// lets the welcome screen show "Sync failed" the same way the per-deck pill
// (setSyncIndicator) would, even though no deck is loaded to attach it to.
export const LAST_GLOBAL_SYNC_ERROR_KEY = "flashcards_last_global_sync_error";

// Which KIND of problem the last background sync hit. Every user-facing message
// inside reconcileAllDecks was gated on `if (explicit)`, so a user who never
// pressed "Sync Now" was told nothing at all — and the two states that most
// needed saying (a lapsed session, a half-migrated schema) are exactly the ones
// that persist across every subsequent attempt. Keyed by kind so the message
// fires once per new problem rather than on every tick, which is what made
// staying silent look like the lesser evil in the first place.
export const LAST_BG_SYNC_PROBLEM_KEY = "recall:lastBackgroundSyncProblem";

export function reportBackgroundSyncProblem(kind, message) {
  let previous = null;
  try { previous = localStorage.getItem(LAST_BG_SYNC_PROBLEM_KEY); } catch (_) {}
  if (previous === kind) return;
  try { localStorage.setItem(LAST_BG_SYNC_PROBLEM_KEY, kind); } catch (_) {}
  showToast(message, "error");
}

// Called when a sync gets all the way through, so the next occurrence of the
// same problem is reported again rather than suppressed forever.
export function clearBackgroundSyncProblem() {
  try { localStorage.removeItem(LAST_BG_SYNC_PROBLEM_KEY); } catch (_) {}
}

// Cloud deck ids that were explicitly deleted on this device, mapped to the
// time of deletion. A two-way mirror with no deletion record can never make a
// delete "stick": deleting only the local copy lets the next pull re-download
// it, and deleting only the cloud copy lets the next push re-upload it. These
// tombstones let reconcileAllDecks re-assert the deletion (delete the cloud row
// again, never pull it back) until the cloud copy is confirmed gone.
export const LOCAL_DECK_TOMBSTONES_KEY = "flashcards_deleted_deck_ids_v1";

// Decks seen missing from the cloud but NOT yet acted on: { deckId: { firstMissingAt,
// sightings, title } }. A deck vanishing from the cloud list is the only signal
// this app has for "deleted on another device" — and it is also what a bad read
// looks like (an unauthenticated query returns zero rows and no error, because
// every table is RLS-scoped). Acting on the first sighting is what let a single
// bad read delete a whole library, so absence has to be observed repeatedly,
// over time, before it counts. Persisted because those observations must span
// app launches. See the missing-decks block in reconcileAllDecks.
export const MISSING_DECK_WATCH_KEY = "flashcards_missing_deck_watch_v1";

// Two independent syncs, at least this far apart, before an absence is believed.
// Both matter: the count rules out one bad response, the age rules out a burst
// of syncs inside a single bad session (reconnect, tab focus, manual retry).
export const MISSING_DECK_MIN_SIGHTINGS = 2;

export const MISSING_DECK_MIN_AGE_MS = 5 * 60 * 1000;

// Blast-radius cap on removals inferred from absence (deletions with a real
// shared tombstone are exempt — those are recorded human decisions). Below the
// cap, removal is silent and immediate, which keeps the everyday "I deleted a
// deck on my laptop" working. Above it, the decks are held intact and the user
// is asked, because at that scale a wrong guess is the difference between a
// nuisance and losing everything.
export const ADOPT_DELETION_MIN_CAP = 3;

export const ADOPT_DELETION_MAX_FRACTION = 0.25;

export function readMissingDeckWatch() {
  try {
    const map = JSON.parse(localStorage.getItem(MISSING_DECK_WATCH_KEY) || "{}");
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

export function writeMissingDeckWatch(map) {
  try {
    localStorage.setItem(MISSING_DECK_WATCH_KEY, JSON.stringify(map || {}));
  } catch (error) {
    // Quota, most likely. Failing to persist means an absence has to be
    // re-observed from scratch, which delays a deletion — never causes one.
    console.warn("Could not record missing-deck observations", error);
  }
}

export function clearMissingDeckWatch(deckId) {
  if (!deckId) return;
  const map = readMissingDeckWatch();
  if (map[String(deckId)] !== undefined) {
    delete map[String(deckId)];
    writeMissingDeckWatch(map);
  }
}

// The pen, the nib and the tool the ink rail was last left on. Per device —
// see src/storage/ink-prefs.js for why this is not in the deck's meta bag.
export const inkPreferencesKey = "recall:ink-prefs-v1";
