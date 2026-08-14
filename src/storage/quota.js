// Autosaving the working deck, and what to do when the device says it is full.

import { deckStorageKey } from "../core/constants.js?v=__BUILD__";
import { setSyncIndicator } from "../sync/indicator.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

export let deckAutosaveTimer = null;

// Setter: an imported binding is read-only, and the autosave scheduler and the sync both cancel it.
export function setDeckAutosaveTimer(value) {
  deckAutosaveTimer = value;
}

// ── Why this no longer writes anything ─────────────────────────────────────
// This used to do `localStorage.setItem(deckStorageKey, JSON.stringify(deckSnapshot()))`
// — the entire deck, serialized synchronously on the main thread — and
// scheduleDeckAutosave calls it on a 400ms debounce, so it ran continuously
// while typing. On a large deck that is a multi-megabyte string built several
// times a second, and localStorage's ~5MB cap meant the setItem then threw
// QuotaExceededError, which the catch below swallowed into a console.warn.
//
// The write was pointless even when it succeeded: NOTHING reads deckStorageKey
// back. clearBrowserPersistence() removes it on every boot on purpose (a
// refresh is meant to start on the clean home screen, not reopen the last
// deck), and there is no getItem for it anywhere in the app. The durable copy
// is the IndexedDB snapshot that saveDeckToLibrary/writeDeckSnapshot writes —
// see the storage note above, which is why bulk data moved off localStorage in
// the first place. This call site was simply left behind.
//
// Kept as a function (rather than deleted at its ~10 call sites) because the
// key still has to be cleared when the working deck empties out.
export function persistWorkingDeck() {
  try {
    localStorage.removeItem(deckStorageKey);
  } catch (error) {
    console.warn("Could not clear working deck key", error);
  }
}

// Debounced so the rapid-fire mutations during study don't thrash localStorage.
// Every change auto-persists into the "My Decks" library — so there is no
// longer a manual "Save to Device" step. Cloud sync is intentionally NOT
// triggered here: pushing to Supabase on every keystroke-ish edit was
// chatty and unnecessary. The cloud only gets touched at app startup, when
// connectivity returns, and via the explicit "Sync Now" button — all through
// reconcileAllDecks().
// True only for an actual DOMException quota failure — checked by name/code
// rather than assuming, since browsers vary (modern: "QuotaExceededError";
// legacy WebKit/Firefox: code 22 / 1014, or name "NS_ERROR_DOM_QUOTA_REACHED").
export function isQuotaExceededError(error) {
  if (!error) return false;
  return error.name === "QuotaExceededError"
    || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || error.code === 22
    || error.code === 1014;
}

// A per-deck sync failure's message is shown verbatim in the report, so a
// local quota DOMException reads as opaque browser-internal text ("Failed to
// execute 'setItem' on 'Storage'...") right next to what looks like a cloud
// sync failure — which is exactly why the user reads a local, on-device
// problem as a cloud/sync one. Label the one case this file can actually
// diagnose; leave everything else (network, RLS, timeouts) as the real
// message, since isTransientCloudError already handles retryable ones.
export function describeSyncError(error) {
  if (isQuotaExceededError(error)) return "This device's storage is full";
  return error?.message || String(error);
}

export let deckAutosaveStorageFailed = false;

// Setter: an imported binding is read-only, and several save paths clear or set this flag.
export function setDeckAutosaveStorageFailed(value) {
  deckAutosaveStorageFailed = value;
}

// Set whenever a deck write hits a genuine quota error (see
// handleDeckStorageQuotaError) so scheduleDeckAutosave and saveDeckToLibrary's
// callers can tell that apart from any other save error without changing
// saveDeckToLibrary's return contract (many callers just check truthiness).
export let lastSaveErrorWasQuota = false;

// Setter: an imported binding is read-only, and the save path in main.js records why the last write failed.
export function setLastSaveErrorWasQuota(value) {
  lastSaveErrorWasQuota = value;
}

// One place to react to a real quota DOMException from ANY deck-data write —
// the index (still localStorage) or a snapshot (IndexedDB, see below, or its
// localStorage fallback). Latches deckAutosaveStorageFailed and shows the
// toast at most once per failure streak; callers still do their own
// setStatus/return-null for the immediate action, since "which action failed"
// varies by call site but "the device is out of room" doesn't.
export function handleDeckStorageQuotaError(error) {
  if (!isQuotaExceededError(error)) return false;
  setLastSaveErrorWasQuota(true);
  if (!deckAutosaveStorageFailed) {
    setDeckAutosaveStorageFailed(true);
    setSyncIndicator("error");
    showToast("Device storage full — clear old decks to keep saving", "error");
  }
  return true;
}
