// The bucket keys, carried between the reader's devices through their own
// Supabase project.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// "It says successfully connected to bucket but the pdfs are not syncing multi
// device." Both halves were true. The keys were pasted on one device and lived
// in that device's localStorage and nowhere else (s3-config.js said so, and so
// did the panel: "never synced"). The upload worked; the paper was in the
// bucket. The phone had simply never been told where the bucket was, so every
// paper on it read as missing and asked to be re-attached.
//
// So the four values now ride one row per account in `app_storage_settings`,
// and every device that syncs picks them up. localStorage stays the place a
// request reads them from — signing a request must never wait on the network,
// and a device that is offline still has to open the papers it already holds.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// Last writer wins, on a timestamp the CLIENT writes (there is no trigger on
// updated_at, for the same reason decks and cards have none: the value is
// compared, not displayed). Three refinements, each for a way that rule alone
// would hand the wrong keys to the wrong place:
//
//   • An untested config is never published. The panel saves the typed values
//     before it tests them, so the reader can fix one field without retyping
//     four; publishing that half-right copy would break every other device on
//     the next sync. Only a config that passed Save and test goes up.
//   • Forget is a value, not an absence. A NULL row says "removed at T", which
//     is what lets the removal reach the other devices. An absent row would
//     read as "never set up", and the next device to sync would push its own
//     copy straight back.
//   • A config saved under ANOTHER account is never published, and is dropped
//     when this account's row says otherwise. On a shared device the previous
//     reader's secret must not be filed into the next reader's row.
//
// A config that predates all of this (no timestamp, no owner, no verdict) is
// treated as the oldest thing there is: it loses to any row, and fills an
// account that has none. That second half is what lets a device that was set
// up before this change publish its keys without anybody retyping them.

import { verifiedCloudUserId } from "./auth.js?v=__BUILD__";
import { isMissingRelationError } from "./deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, isTransientCloudError, withTimeout } from "./net.js?v=__BUILD__";
import {
  cleanS3Config, clearS3Config, isCompleteS3Config, loadS3Config, markS3ConfigVerified, readS3ConfigRecord, saveS3Config, setS3ConfigOwner
} from "./s3-config.js?v=__BUILD__";
import { testS3Connection } from "./s3-files.js?v=__BUILD__";
import { supabaseClient } from "./supabase-client.js?v=__BUILD__";

export const S3_CONFIG_TABLE = "app_storage_settings";

// What the last pass concluded, for the Storage panel's one line of status.
//
//   synced       this device and the account agree
//   unverified   the keys here have not passed a test yet, so they wait
//   unavailable  the table is missing or refused — re-run supabase_setup.sql
//   signed-out   no verified session to write the row as
//   offline      no connection, or it dropped mid-request
//   failed       anything else
let s3ConfigSyncState = { state: "idle", at: 0, detail: "" };

export function s3ConfigSyncStatus() {
  return { ...s3ConfigSyncState };
}

function settleS3ConfigSync(outcome, detail = "", extra = {}) {
  s3ConfigSyncState = { state: outcome, at: Date.now(), detail };
  return { status: outcome, detail, ...extra };
}

// Told when the keys on this device were replaced or removed from the cloud,
// so the app can redraw what depended on them — the Storage panel, and a paper
// that was showing "this device hasn't been given the keys". Registered rather
// than imported, because the listeners live in modules that import this one.
const s3ConfigListeners = new Set();

export function onS3ConfigAdopted(listener) {
  if (typeof listener !== "function") return () => {};
  s3ConfigListeners.add(listener);
  return () => s3ConfigListeners.delete(listener);
}

function announceS3Config(change) {
  for (const listener of s3ConfigListeners) {
    try {
      listener(change);
    } catch (error) {
      console.warn("A bucket-keys listener failed", error);
    }
  }
}

// The table is not there, or RLS will not let this account near its own row.
// Either way the remedy is re-running supabase_setup.sql, not a retry — so it
// is reported as its own state rather than as a failed sync.
function s3ConfigTableUnusable(error) {
  if (isMissingRelationError(error)) return true;
  const code = String(error?.code || "");
  if (code === "PGRST205" || code === "42501") return true;
  return /schema cache|permission denied/i.test(String(error?.message || ""));
}

export function sameS3Config(a, b) {
  if (!a || !b) return false;
  const left = cleanS3Config(a);
  const right = cleanS3Config(b);
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function readS3ConfigRow(userId) {
  const { data, error } = await withTimeout(
    abortable((signal) => supabaseClient
      .from(S3_CONFIG_TABLE)
      .select("s3_config, updated_at")
      .eq("user_id", userId)
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "read bucket keys"
  );
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row : null;
}

async function writeS3ConfigRow(userId, config, atMs) {
  const { error } = await withTimeout(
    abortable((signal) => supabaseClient
      .from(S3_CONFIG_TABLE)
      .upsert({
        user_id: userId,
        // Only the five values a signature is made from. The device-side
        // bookkeeping (owner, verdict) is about THIS device's copy.
        s3_config: config ? cleanS3Config(config) : null,
        updated_at: new Date(atMs).toISOString()
      }, { onConflict: "user_id" })
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "save bucket keys"
  );
  if (error) throw error;
}

// One pass. Never throws: the caller is either a sync that must carry on
// whatever this concludes, or a panel that reports the outcome in a sentence.
//
// `preferLocal` is for the moment the reader has just pressed Save and test or
// Forget on THIS device. Their intent is not in doubt, so their copy is stamped
// past the cloud's rather than trusted to be newer on its own clock: two
// devices a few minutes apart would otherwise let the one running fast undo a
// change made seconds ago on the other.
export async function syncS3ConfigWithCloud(userId, { preferLocal = false } = {}) {
  if (!userId || !supabaseClient) return settleS3ConfigSync("signed-out");
  if (typeof navigator !== "undefined" && navigator.onLine === false) return settleS3ConfigSync("offline");

  const local = readS3ConfigRecord();
  const foreign = Boolean(local.ownerId) && local.ownerId !== String(userId);
  const kind = local.config ? "config" : (local.forgottenAt ? "forgotten" : "none");
  const localAt = kind === "config" ? local.updatedAt : (kind === "forgotten" ? local.forgottenAt : 0);
  // Fit to go up: tested, or legacy (which is tested below before it goes
  // anywhere), or a deliberate Forget — and in every case this account's own.
  const publishable = !foreign && (kind === "forgotten" || (kind === "config" && local.verified !== false));

  try {
    const row = await readS3ConfigRow(userId);
    const cloudAt = row ? (Date.parse(row.updated_at || "") || 0) : -1;
    const cloudValue = row?.s3_config && typeof row.s3_config === "object" ? cleanS3Config(row.s3_config) : null;
    const cloudConfig = cloudValue && isCompleteS3Config(cloudValue) ? cloudValue : null;

    const push = async (stampMs) => {
      const at = Math.max(1, stampMs);
      await writeS3ConfigRow(userId, kind === "config" ? local.config : null, at);
      // The local copy takes the stamp that was written, so the next pass sees
      // the two sides as equal rather than this one as newer forever.
      if (kind === "config") {
        saveS3Config(local.config, { updatedAt: at, ownerId: userId, verified: local.verified !== false });
      } else {
        clearS3Config({ at, ownerId: userId });
      }
      return settleS3ConfigSync("synced", "", { change: "pushed" });
    };

    // An account with nothing yet takes whatever this device can vouch for.
    //
    // A config from before any of this carries no verdict: the old panel kept
    // what was typed whether or not its test passed, and that test only ever
    // LISTED, which a policy missing PUT passes. Publishing it untested could
    // hand every other device keys that cannot upload — or replace working
    // ones. So it is tested once, here, the same way Save and test does, and
    // the verdict is kept so the question is not asked again every sync.
    if (!row) {
      if (publishable && kind === "config" && local.verified === null) {
        const probe = await testS3Connection().catch(() => ({ ok: false }));
        if (typeof navigator !== "undefined" && navigator.onLine === false) return settleS3ConfigSync("offline");
        markS3ConfigVerified(userId, probe.ok);
        if (!probe.ok) return settleS3ConfigSync("unverified", probe.reason || "");
      }
      if (publishable) return await push(localAt || Date.now());
      if (foreign && kind === "config") {
        clearS3Config({ tombstone: false });
        announceS3Config({ kind: "cleared" });
        return settleS3ConfigSync("synced", "", { change: "cleared" });
      }
      if (kind === "config" && local.verified === false) return settleS3ConfigSync("unverified");
      return settleS3ConfigSync("synced");
    }

    if (preferLocal && publishable) return await push(Math.max(Date.now(), cloudAt + 1));

    if (!foreign && kind !== "none" && localAt > cloudAt) {
      // Newer here, but a config that has not passed its test yet waits
      // rather than going up — and is not overwritten either: the reader is
      // mid-edit, and the cloud's older copy is still what the others use.
      if (!publishable) return settleS3ConfigSync("unverified");
      return await push(localAt);
    }

    // The account is the authority from here.
    if (cloudConfig) {
      const unchanged = !foreign && sameS3Config(local.config, cloudConfig);
      saveS3Config(cloudConfig, { updatedAt: Math.max(1, cloudAt), ownerId: userId, verified: true });
      if (!unchanged) announceS3Config({ kind: "adopted" });
      return settleS3ConfigSync("synced", "", { change: unchanged ? "" : "adopted" });
    }
    // A NULL row: forgotten on another device (or this one, earlier).
    if (local.config) {
      clearS3Config({ at: Math.max(1, cloudAt), ownerId: userId });
      announceS3Config({ kind: "cleared" });
      return settleS3ConfigSync("synced", "", { change: "cleared" });
    }
    if (foreign) setS3ConfigOwner(userId);
    return settleS3ConfigSync("synced");
  } catch (error) {
    if (s3ConfigTableUnusable(error)) return settleS3ConfigSync("unavailable", String(error?.message || ""));
    if (isTransientCloudError(error)) return settleS3ConfigSync("offline", String(error?.message || ""));
    console.warn("Could not sync the bucket keys", error);
    return settleS3ConfigSync("failed", String(error?.message || ""));
  }
}

// After Save and test, or Forget: publish now rather than at the next sync, so
// the phone in the reader's other hand has the keys before they reach for it.
export async function pushS3ConfigNow() {
  if (!supabaseClient) return settleS3ConfigSync("signed-out");
  const userId = await verifiedCloudUserId();
  if (!userId) return settleS3ConfigSync("signed-out");
  return syncS3ConfigWithCloud(userId, { preferLocal: true });
}

// For a device that has no keys yet and is being asked for a paper right now —
// the first open after install, before the first sync has run. One pull, and
// not again for a minute whatever it concluded: getDocument runs inside a
// render, and a render must not turn into a request loop.
const S3_CONFIG_PULL_COOLDOWN_MS = 60 * 1000;
let s3ConfigPull = null;
let s3ConfigPulledAt = 0;

export async function ensureS3ConfigFromCloud() {
  if (loadS3Config()) return true;
  if (!supabaseClient) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (s3ConfigPull) return s3ConfigPull;
  if (Date.now() - s3ConfigPulledAt < S3_CONFIG_PULL_COOLDOWN_MS) return false;
  s3ConfigPull = (async () => {
    try {
      const userId = await verifiedCloudUserId();
      if (userId) await syncS3ConfigWithCloud(userId);
    } catch (error) {
      console.warn("Could not fetch the bucket keys", error);
    } finally {
      s3ConfigPulledAt = Date.now();
      s3ConfigPull = null;
    }
    return Boolean(loadS3Config());
  })();
  return s3ConfigPull;
}
