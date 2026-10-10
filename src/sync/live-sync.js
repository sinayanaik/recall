// Noticing another device's change as it happens, instead of minutes later.
//
// The timer sync (./auto-sync.js) answers "has it been five minutes". That left
// a window — open a note on the tablet that the laptop changed a minute ago, and
// you are reading, and then editing, the old copy. The merges make that safe;
// this makes it rare:
//
//   • opening a deck asks the cloud about THAT deck (one tiny row) and syncs at
//     once if another device has written it since;
//   • coming back to the app does the same for the deck on screen;
//   • while signed in, a Supabase Realtime channel hears every write to the
//     user's decks and syncs a moment later — so the other device's edit simply
//     appears.
//
// Every path ends in the ordinary reconcileAllDecks, background flavour, so
// there is one sync and one set of rules; this only decides WHEN. Auto-sync
// switched Off means off here too: nothing in this file runs a sync then.

import { supabaseClient, isSignedIn } from "../cloud/supabase-client.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { getAutoSyncMinutes, rearmAutoSync } from "./auto-sync.js?v=__BUILD__";
import { reconcileAllDecks, reconcileInFlight } from "./reconcile.js?v=__BUILD__";
import { cloudMovedSince, cloudPushInFlight, tsMs } from "./stats.js?v=__BUILD__";

function liveSyncAllowed() {
  return Boolean(supabaseClient && isSignedIn && navigator.onLine && getAutoSyncMinutes());
}

let liveSyncTimer = null;

// One background sync, soon — coalescing a burst of triggers (a Realtime event
// per deck row write, a focus and an open together) into one run.
export function scheduleLiveSync(delayMs = 1500) {
  if (liveSyncTimer) clearTimeout(liveSyncTimer);
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    if (!liveSyncAllowed()) return;
    // A run already going will not see a change that landed after it read the
    // deck list, so try again once it is done rather than dropping this one.
    if (reconcileInFlight) { scheduleLiveSync(4000); return; }
    rearmAutoSync();
    reconcileAllDecks({ explicit: false });
  }, delayMs);
}

// Has the cloud copy of this one deck moved since this device last agreed with
// it? One row, two columns — cheap enough to ask on every open.
export async function checkDeckFreshness(localId = state.localDeckId) {
  if (!localId || !liveSyncAllowed()) return false;
  const entry = readLocalDeckIndex().find((e) => e.id === localId);
  if (!entry?.deckId || !entry.lastSyncedAt) return false;
  try {
    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient
        .from("decks").select("id, updated_at, last_accessed_at").eq("id", entry.deckId).abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "check deck freshness"
    );
    if (error || !Array.isArray(data) || !data.length) return false;
    const row = data[0];
    if (cloudPushInFlight(row)) { scheduleLiveSync(8000); return false; }
    // Re-read the entry: a sync may have finished while this was in flight.
    const now = readLocalDeckIndex().find((e) => e.id === localId);
    if (!now || !cloudMovedSince(row, now)) return false;
    scheduleLiveSync(0);
    return true;
  } catch (error) {
    console.warn("Could not check whether this deck changed elsewhere", error);
    return false;
  }
}

// ── Realtime ────────────────────────────────────────────────────────────────

let realtimeChannel = null;

function onRealtimeDeckChange(payload) {
  const row = payload?.new && Object.keys(payload.new).length ? payload.new : null;
  if (payload?.eventType === "DELETE" || !row) { scheduleLiveSync(2000); return; }
  // Our own push echoes back here too; by the time it does, this device's entry
  // already holds that exact stamp, and there is nothing to do. The epoch stamp
  // is a push still uploading — its final write will arrive as its own event.
  if (!tsMs(row.updated_at)) return;
  const entry = readLocalDeckIndex().find((e) => String(e.deckId) === String(row.id));
  if (entry && !cloudMovedSince(row, entry)) return;
  scheduleLiveSync(1500);
}

export function startRealtimeSync() {
  if (realtimeChannel || !supabaseClient?.channel) return;
  try {
    realtimeChannel = supabaseClient
      .channel("recall-decks")
      .on("postgres_changes", { event: "*", schema: "public", table: "decks" }, onRealtimeDeckChange)
      .subscribe((status) => {
        // A channel that cannot subscribe (Realtime not enabled for the table —
        // see supabase_setup.sql) costs nothing: the timer, the open check and
        // the focus check still run.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.info("Live sync unavailable — changes from other devices arrive on the next sync instead.");
        }
      });
  } catch (error) {
    console.warn("Could not start live sync", error);
    realtimeChannel = null;
  }
}

export function stopRealtimeSync() {
  if (!realtimeChannel) return;
  try { supabaseClient?.removeChannel?.(realtimeChannel); } catch { /* already gone */ }
  realtimeChannel = null;
}
