// Reading stats between the reader's devices, through their own project.
//
// One row per (account, device) in `reading_stats`. Each device upserts ONLY
// its own row and reads everybody's, so there is no merge on the way in and no
// write can lose another device's minutes — the folding happens on read, in
// src/stats/combine.js. Everything is measured and computed on the device; this
// only carries the result.
//
// Never throws, and never fails a sync: a project that has not re-run
// supabase_setup.sql simply has no table, and Home then says "this device
// only" until it does.

import { verifiedCloudUserId } from "../cloud/auth.js?v=__BUILD__";
import { isMissingRelationError } from "../cloud/deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, isTransientCloudError, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { deviceId, deviceLabel } from "../sync/device.js?v=__BUILD__";
import {
  flushReadingStats, markReadingStatsPushed, readOtherDeviceStats, readReadingStats, readingStatsDirty, writeOtherDeviceStats
} from "./reading-stats-store.js?v=__BUILD__";

export const READING_STATS_TABLE = "reading_stats";

// What the last pass concluded, for Home's one line about devices.
//
//   synced       this device's row is up and the others are down
//   unavailable  the table is missing or refused — re-run supabase_setup.sql
//   offline      no connection, or it dropped mid-request
//   failed       anything else
//   signed-out   nobody to write the row as
let lastOutcome = { state: "idle", at: 0 };

export function readingStatsSyncStatus() {
  return { ...lastOutcome };
}

function settleReadingStatsSync(outcome, detail = "") {
  lastOutcome = { state: outcome, at: Date.now(), detail };
  return lastOutcome;
}

function readingStatsTableUnusable(error) {
  if (isMissingRelationError(error)) return true;
  const code = String(error?.code || "");
  if (code === "PGRST205" || code === "42501") return true;
  return /schema cache|permission denied/i.test(String(error?.message || ""));
}

let inFlight = null;

export function syncReadingStatsWithCloud(userId) {
  if (inFlight) return inFlight;
  inFlight = runReadingStatsSync(userId).finally(() => { inFlight = null; });
  return inFlight;
}

async function runReadingStatsSync(userId) {
  if (!userId || !supabaseClient) return settleReadingStatsSync("signed-out");
  if (typeof navigator !== "undefined" && navigator.onLine === false) return settleReadingStatsSync("offline");
  const ownId = deviceId();
  try {
    if (readingStatsDirty()) {
      flushReadingStats();
      const own = readReadingStats();
      const stamp = own.updatedAt || Date.now();
      const { pushedAt: _pushed, ...body } = own;
      const { error } = await withTimeout(
        abortable((signal) => supabaseClient
          .from(READING_STATS_TABLE)
          .upsert({
            user_id: userId,
            device_id: ownId,
            device_label: deviceLabel(),
            stats: { ...body, deviceId: ownId, label: deviceLabel() },
            updated_at: new Date(stamp).toISOString()
          }, { onConflict: "user_id,device_id" })
          .abortSignal(signal)),
        CLOUD_TIMEOUT_MS,
        "save reading stats"
      );
      if (error) throw error;
      markReadingStatsPushed(stamp);
    }

    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient
        .from(READING_STATS_TABLE)
        .select("device_id, device_label, stats, updated_at")
        .eq("user_id", userId)
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "read reading stats"
    );
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : [])
      .filter((row) => row && row.device_id && row.device_id !== ownId && row.stats && typeof row.stats === "object")
      .map((row) => ({ deviceId: row.device_id, label: row.device_label || "", stats: row.stats, updatedAt: Date.parse(row.updated_at || "") || 0 }));
    writeOtherDeviceStats(rows, "synced");
    return settleReadingStatsSync("synced");
  } catch (error) {
    if (readingStatsTableUnusable(error)) {
      writeOtherDeviceStats(readOtherDeviceStats().rows, "unavailable");
      return settleReadingStatsSync("unavailable", String(error?.message || ""));
    }
    if (isTransientCloudError(error)) return settleReadingStatsSync("offline", String(error?.message || ""));
    console.warn("Could not sync reading stats", error);
    return settleReadingStatsSync("failed", String(error?.message || ""));
  }
}

// The app going to the background: one best-effort push, so a phone put down
// mid-chapter has its minutes on the desk's screen before the next timed sync.
// At most every two minutes; the request may not finish, and that is fine —
// the row is still dirty, and the next sync sends it.
export const READING_STATS_BACKGROUND_PUSH_MS = 2 * 60 * 1000;
let lastBackgroundPushAt = 0;

export function pushReadingStatsInBackground() {
  if (!supabaseClient || !isSignedIn || !readingStatsDirty()) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const now = Date.now();
  if (now - lastBackgroundPushAt < READING_STATS_BACKGROUND_PUSH_MS) return;
  lastBackgroundPushAt = now;
  verifiedCloudUserId()
    .then((userId) => (userId ? syncReadingStatsWithCloud(userId) : null))
    .catch((error) => console.warn("Could not send reading stats", error));
}
