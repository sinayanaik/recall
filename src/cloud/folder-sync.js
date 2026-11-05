// The folders of My Files, carried across the account's devices.
//
// A folder has no row of its own in `decks` — it is the category path of the
// files inside it — so a folder with nothing in it yet lived only in the
// browser that made it (src/library/folders.js, KNOWN_FOLDERS_KEY). It never
// reached another device, and it was gone with that browser's storage.
//
// One row per account in library_folders (supabase_setup.sql, section 4d)
// holds { path: { at, deleted } }. Each pass reads it, merges it with this
// device's map path by path (newer `at` wins, see mergeFolderSyncMaps), keeps
// the result here, and writes it back if the account's copy was behind. Two
// devices writing at once can each miss the other's newest entry for one pass;
// both still hold their own, so the next pass puts it back. Nothing is lost.
//
// A project whose SQL predates the table carries on as before: empty folders
// stay on the device they were made on, and nothing is reported as a failure.

import { verifiedCloudUserId } from "./auth.js?v=__BUILD__";
import { isMissingRelationError } from "./deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, isTransientCloudError, withTimeout } from "./net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { applyFolderSyncMap, cleanFolderSyncMap, localFolderSyncMap, mergeFolderSyncMaps, sameFolderSyncMap } from "../library/folders.js?v=__BUILD__";

export const FOLDER_SYNC_TABLE = "library_folders";

// Fired on window when a sync changed the folders on screen, so My Files can
// repaint (src/main.js) without this module importing the library's renderer.
export const FOLDERS_SYNCED_EVENT = "recall:folders-synced";

let tableUnusable = false;
let folderSyncInFlight = null;

function folderTableUnusable(error) {
  if (isMissingRelationError(error)) return true;
  const code = String(error?.code || "");
  if (code === "PGRST205" || code === "42501") return true;
  return /schema cache|permission denied/i.test(String(error?.message || ""));
}

async function readFolderRow(userId) {
  const { data, error } = await withTimeout(
    abortable((signal) => supabaseClient
      .from(FOLDER_SYNC_TABLE)
      .select("folders, updated_at")
      .eq("user_id", userId)
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "read folders"
  );
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row : null;
}

async function writeFolderRow(userId, folders) {
  const { error } = await withTimeout(
    abortable((signal) => supabaseClient
      .from(FOLDER_SYNC_TABLE)
      .upsert({ user_id: userId, folders, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "save folders"
  );
  if (error) throw error;
}

// One pass. Never throws: it runs beside the deck sync, which must carry on
// whatever this concludes. Returns "synced", "unavailable", "offline",
// "signed-out" or "failed".
export function syncFoldersWithCloud(userId) {
  if (!userId || !supabaseClient) return Promise.resolve("signed-out");
  if (tableUnusable) return Promise.resolve("unavailable");
  if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve("offline");
  // One at a time: a folder made while a pass is reading would otherwise race
  // it to the write. The second caller waits and then runs its own pass.
  const run = async () => {
    try {
      const row = await readFolderRow(userId);
      const cloud = cleanFolderSyncMap(row?.folders);
      const local = localFolderSyncMap();
      const merged = mergeFolderSyncMaps(local, cloud);
      if (!sameFolderSyncMap(merged, local)) {
        const visibleChange = applyFolderSyncMap(merged);
        if (visibleChange && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FOLDERS_SYNCED_EVENT));
      }
      if (!row || !sameFolderSyncMap(merged, cloud)) await writeFolderRow(userId, merged);
      return "synced";
    } catch (error) {
      if (folderTableUnusable(error)) {
        tableUnusable = true;
        console.info("Empty folders stay on this device: re-run supabase_setup.sql to add the library_folders table.");
        return "unavailable";
      }
      if (isTransientCloudError(error)) return "offline";
      console.warn("Could not sync folders", error);
      return "failed";
    }
  };
  const next = (folderSyncInFlight || Promise.resolve()).then(run, run);
  folderSyncInFlight = next.finally(() => { if (folderSyncInFlight === next) folderSyncInFlight = null; });
  return next;
}

// A folder made, renamed or deleted here goes up shortly after, rather than at
// the next timed sync — so it is on the reader's other device by the time they
// pick it up. Debounced, because a rename writes the list more than once.
let pushTimer = null;

export function pushFoldersSoon(delayMs = 1500) {
  if (!supabaseClient || tableUnusable) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    if (!isSignedIn) return;
    const userId = await verifiedCloudUserId();
    if (userId) await syncFoldersWithCloud(userId);
  }, delayMs);
}
