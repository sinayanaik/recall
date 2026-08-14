// What is actually stored, and the destructive tools for reclaiming it.
//
// Every irreversible action here is behind a type-the-word confirmation, and
// the orphan sweep only deletes objects no deck references — computed by
// reading the whole library first, not inferred.

import { BACKUP_IMAGE_REF_RE, decodeImageRefEntities } from "../backup/backup.js?v=__BUILD__";
import { getCachedSession } from "../cloud/auth.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, allOutboxImages, deleteOutboxImage, revokeLocalImageUrls } from "../images/outbox.js?v=__BUILD__";
import { IMAGE_BUCKET, OFFLINE_IMAGE_CACHE } from "../images/upload.js?v=__BUILD__";
import { readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { resetActiveDeckAfterDelete } from "../library/tombstones.js?v=__BUILD__";
import { allDeckSnapshotIds, clearAllDeckSnapshots, forEachDeckSnapshot, storagePersisted } from "./deck-store.js?v=__BUILD__";
import { LOCAL_DECKS_INDEX_KEY } from "./keys.js?v=__BUILD__";
import { setDeckAutosaveStorageFailed } from "./quota.js?v=__BUILD__";
import { showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export const STORAGE_LIST_PAGE = 100;

// Storage's remove() takes a path array; keep each request modest so one slow
// batch can't stall the whole cleanup.
export const STORAGE_DELETE_BATCH = 100;

export let storageReport = null;

export let storageBusy = false;

export function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Every object under one prefix, walking into subfolders. Storage's list() is
// one level at a time and pages at `limit`, and a folder entry is distinguished
// from a file by having no `id` — an EPUB import alone can nest hundreds of
// figures under books/<slug>--<run>/, so the recursion is not optional.
export async function listStorageObjects(prefix, onProgress, out = []) {
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE) {
    const { data, error } = await withTimeout(
      supabaseClient.storage.from(IMAGE_BUCKET).list(prefix, {
        limit: STORAGE_LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" }
      }),
      CLOUD_TIMEOUT_MS,
      "list images"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (row.id) {
        out.push({
          path,
          name: row.name,
          size: Number(row.metadata?.size) || 0,
          mimetype: row.metadata?.mimetype || "",
          updatedAt: row.updated_at || row.created_at || null
        });
        onProgress?.(out.length);
      } else {
        // A folder. `.emptyFolderPlaceholder` rows come back as files with a
        // real id and are counted like any other object — they're tiny, and
        // pretending they don't exist would make the count disagree with the
        // dashboard.
        await listStorageObjects(path, onProgress, out);
      }
    }
    if (rows.length < STORAGE_LIST_PAGE) break;
  }
  return out;
}

// Every storage path the library still points at. Read from the CLOUD (the
// authoritative copy — a deck may exist only there) unioned with this device's
// local snapshots (which may hold decks not pushed yet). Throws rather than
// returning a partial set: an incomplete reference list would mark live images
// as orphans, and this is the input to a delete.
export async function collectReferencedStoragePaths(onProgress) {
  const paths = new Set();
  const add = (text) => {
    for (const match of String(text || "").matchAll(BACKUP_IMAGE_REF_RE)) {
      const ref = decodeImageRefEntities(match[1] || match[2] || match[3] || match[4] || "");
      const path = ref && !ref.startsWith(LOCAL_IMAGE_SCHEME) ? supabaseImagePathFromUrl(ref) : null;
      if (path) paths.add(path);
    }
  };

  // Streamed via a cursor (see forEachDeckSnapshot), not the index: this also
  // catches a stashed notes-conflict copy (see NOTES_CONFLICT_SUFFIX), which
  // has its own `notes` field and isn't listed in the index at all — a real
  // image referenced only from an unresolved conflict used to be able to
  // read as orphaned and get deleted out from under it.
  await forEachDeckSnapshot((id, snapshot) => {
    add(snapshot.notes);
    for (const card of snapshot.cards || []) { add(card.question); add(card.answer); }
  });

  onProgress?.("Reading decks in the cloud…");
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("decks").select("id, notes").range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "read deck notes"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) add(row.notes);
    if (rows.length < pageSize) break;
  }

  onProgress?.("Reading cards in the cloud…");
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("cards").select("id, question, answer").range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "read cards"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) { add(row.question); add(row.answer); }
    if (rows.length < pageSize) break;
  }

  return paths;
}

// Counts straight out of the database, as cheaply as PostgREST allows: a
// head-only select with count returns the number without the rows.
export async function countCloudRows(table) {
  const { count, error } = await withTimeout(
    supabaseClient.from(table).select("*", { count: "exact", head: true }),
    CLOUD_TIMEOUT_MS,
    `count ${table}`
  );
  if (error) throw error;
  return count || 0;
}

export async function localLibraryStats() {
  const index = readLocalDeckIndex();
  // Card count comes from the index (already maintained there) — no need to
  // touch a single snapshot body for it.
  const cards = index.reduce((n, meta) => n + (Number(meta.cardCount) || 0), 0);
  // Bytes, though, means measuring actual snapshot content — streamed via a
  // cursor (see forEachDeckSnapshot) rather than reading each by id, and this
  // also picks up stashed notes-conflict copies the index doesn't list, which
  // is arguably more accurate: they really are bytes on this device.
  let bytes = 0;
  try {
    await forEachDeckSnapshot((id, snapshot) => {
      bytes += JSON.stringify(snapshot).length;
    });
  } catch (error) {
    console.warn("Could not measure local library size", error);
  }
  return { decks: index.length, cards, bytes };
}

export async function deviceStorageStats() {
  const stats = { ...(await localLibraryStats()), queuedImages: 0, cachedImages: 0, quotaUsed: 0, quota: 0 };
  try {
    stats.queuedImages = (await allOutboxImages())?.length || 0;
  } catch { /* no outbox yet */ }
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      stats.cachedImages = (await cache.keys()).length;
    }
  } catch { /* cache storage unavailable (private window) */ }
  try {
    const estimate = await navigator.storage?.estimate?.();
    stats.quotaUsed = estimate?.usage || 0;
    stats.quota = estimate?.quota || 0;
  } catch { /* not supported */ }
  return stats;
}

// One pass over everything, so the panel's numbers all describe the same
// moment. Cloud-side failures are captured per section rather than thrown:
// being offline should still show what this device holds.
export async function buildStorageReport(onProgress) {
  const report = {
    at: new Date(),
    signedIn: Boolean(supabaseClient && isSignedIn),
    online: navigator.onLine,
    cloud: null,
    cloudError: "",
    storage: null,
    storageError: "",
    device: await deviceStorageStats()
  };

  if (!report.signedIn) {
    report.cloudError = "Not signed in — cloud figures unavailable.";
    report.storageError = report.cloudError;
    return report;
  }
  if (!report.online) {
    report.cloudError = "This device is offline — cloud figures unavailable.";
    report.storageError = report.cloudError;
    return report;
  }

  try {
    onProgress?.("Counting decks and cards…");
    const [decks, cards, tombstones] = await Promise.all([
      countCloudRows("decks"),
      countCloudRows("cards"),
      countCloudRows("deleted_decks").catch(() => 0)
    ]);
    report.cloud = { decks, cards, tombstones };
  } catch (error) {
    report.cloudError = error?.message || "Could not read the database.";
  }

  try {
    const session = await getCachedSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("no session");
    onProgress?.("Listing images…");
    const objects = await listStorageObjects(userId, (n) => onProgress?.(`Listing images… ${n}`));
    const bytes = objects.reduce((sum, object) => sum + object.size, 0);

    // Grouped the way uploads are filed: books/<book>, decks/<deck>, unfiled/,
    // and whatever sits directly in {uid}/ from before the subfolder scheme.
    const groups = new Map();
    for (const object of objects) {
      const rest = object.path.slice(userId.length + 1);
      const parts = rest.split("/");
      const label = parts.length > 2 ? `${parts[0]}/${parts[1]}`
        : parts.length === 2 ? parts[0]
          : "(loose files)";
      const group = groups.get(label) || { label, count: 0, bytes: 0 };
      group.count += 1;
      group.bytes += object.size;
      groups.set(label, group);
    }

    let orphans = [];
    let orphanError = "";
    try {
      onProgress?.("Checking which images are still used…");
      const referenced = await collectReferencedStoragePaths(onProgress);
      orphans = objects.filter((object) => !referenced.has(object.path));
    } catch (error) {
      // Never guess here: an incomplete reference scan would present live
      // images as deletable.
      orphanError = error?.message || "Could not check which images are in use.";
    }

    report.storage = {
      userId,
      objects,
      count: objects.length,
      bytes,
      groups: Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes),
      orphans,
      orphanBytes: orphans.reduce((sum, object) => sum + object.size, 0),
      orphanError
    };
  } catch (error) {
    report.storageError = error?.message || "Could not read the image bucket.";
  }

  return report;
}

export async function deleteStorageObjects(paths, onProgress) {
  let deleted = 0;
  for (let i = 0; i < paths.length; i += STORAGE_DELETE_BATCH) {
    const batch = paths.slice(i, i + STORAGE_DELETE_BATCH);
    const { error } = await withTimeout(
      supabaseClient.storage.from(IMAGE_BUCKET).remove(batch),
      CLOUD_TIMEOUT_MS,
      "delete images"
    );
    if (error) throw error;
    deleted += batch.length;
    onProgress?.(`Deleting images ${deleted}/${paths.length}…`);
  }
  // The offline cache still holds copies of files that no longer exist.
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl("");
      const prefix = (data?.publicUrl || "").replace(/\/+$/, "");
      for (const path of paths) await cache.delete(`${prefix}/${path}`);
    }
  } catch (error) {
    console.warn("Could not drop deleted images from the offline cache", error);
  }
  return deleted;
}

// Delete every deck row for this account. Cards go with them (cards.deck_id is
// ON DELETE CASCADE), and RLS confines the delete to rows this user owns, so
// the `neq` filter below is only there because PostgREST refuses an unfiltered
// DELETE outright.
export async function deleteAllCloudDecks() {
  const { error } = await withTimeout(
    supabaseClient.from("decks").delete().neq("id", " "),
    CLOUD_TIMEOUT_MS,
    "delete decks"
  );
  if (error) throw error;
}

export async function deleteAllCloudTombstones() {
  const { error } = await withTimeout(
    supabaseClient.from("deleted_decks").delete().neq("deck_id", " "),
    CLOUD_TIMEOUT_MS,
    "delete tombstones"
  );
  if (error) throw error;
}

// Everything this device keeps: the deck index and every snapshot, the queued
// image outbox, and the offline image cache. Deliberately does NOT touch the
// Supabase config or the session — clearing those would sign the user out and
// make them re-enter the project URL and key, which is a different (and much
// more annoying) action than emptying the library.
export async function wipeLocalLibrary() {
  const snapshotCount = (await allDeckSnapshotIds()).length;
  await clearAllDeckSnapshots();
  localStorage.removeItem(LOCAL_DECKS_INDEX_KEY);
  // Clearing the device is the explicit "free up space" action — the same
  // reason deleteDeckFromLibrary resets this — so a quota latch from before
  // must not keep blocking autosave after the library that caused it is gone.
  setDeckAutosaveStorageFailed(false);
  try {
    for (const entry of await allOutboxImages()) await deleteOutboxImage(entry.token);
  } catch { /* nothing queued */ }
  revokeLocalImageUrls();
  try {
    if (typeof caches !== "undefined") await caches.delete(OFFLINE_IMAGE_CACHE);
  } catch { /* nothing cached */ }
  resetActiveDeckAfterDelete();
  await renderMyDecksList();
  return snapshotCount + 1;
}

export function openStoragePanel() {
  lockPageScroll();
  el.storagePanel.hidden = false;
  renderStoragePanel();
  refreshStorageReport();
}

export function closeStoragePanel() {
  el.storagePanel.hidden = true;
  unlockPageScroll();
}

export async function refreshStorageReport() {
  if (storageBusy) return;
  storageBusy = true;
  renderStoragePanel("Reading…");
  try {
    storageReport = await buildStorageReport((text) => renderStoragePanel(text));
  } catch (error) {
    console.error("Storage report failed", error);
    storageReport = null;
    renderStoragePanel(`Could not read storage: ${error?.message || "unknown error"}`);
    storageBusy = false;
    return;
  }
  storageBusy = false;
  renderStoragePanel();
}

export function storageStatTile(value, label, tone = "") {
  return `<div class="storage-stat${tone ? ` ${tone}` : ""}"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

export function renderStoragePanel(busyText = "") {
  const body = el.storageBody;
  if (!body) return;
  const report = storageReport;

  if (busyText || !report) {
    body.innerHTML = `
      <div class="storage-card">
        <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
        <p class="storage-busy">${escapeHtml(busyText || "Reading…")}</p>
      </div>`;
    return;
  }

  const cloud = report.cloud;
  const store = report.storage;
  const device = report.device;

  const cloudSection = cloud
    ? `<div class="storage-stats">
         ${storageStatTile(cloud.decks, "Decks")}
         ${storageStatTile(cloud.cards, "Cards")}
         ${storageStatTile(cloud.tombstones, "Delete records")}
       </div>`
    : `<p class="storage-note is-warning">${escapeHtml(report.cloudError || "No cloud data.")}</p>`;

  const storageSection = store
    ? `<div class="storage-stats">
         ${storageStatTile(store.count, "Images")}
         ${storageStatTile(formatStorageBytes(store.bytes), "Used")}
         ${storageStatTile(store.orphanError ? "?" : store.orphans.length, "Unused", store.orphans.length ? "is-warn" : "")}
       </div>
       ${store.groups.length ? `<ul class="storage-groups">${store.groups.map((group) => `
         <li><span class="storage-group-name">${escapeHtml(group.label)}</span>
             <span class="storage-group-count">${group.count} file${group.count === 1 ? "" : "s"}</span>
             <span class="storage-group-size">${escapeHtml(formatStorageBytes(group.bytes))}</span></li>`).join("")}</ul>` : ""}
       ${store.orphanError
        ? `<p class="storage-note is-warning">${escapeHtml(store.orphanError)} Unused-image cleanup is disabled until this succeeds.</p>`
        : store.orphans.length
          ? `<p class="storage-note">${store.orphans.length} image${store.orphans.length === 1 ? " is" : "s are"} no longer referenced by any deck or note (${escapeHtml(formatStorageBytes(store.orphanBytes))}). These are what deleting an image or a deck leaves behind.</p>`
          : `<p class="storage-note">Every stored image is still in use.</p>`}`
    : `<p class="storage-note is-warning">${escapeHtml(report.storageError || "No image data.")}</p>`;

  body.innerHTML = `
    <div class="storage-card">
      <h2>Cloud database</h2>
      <p class="storage-sub">Your decks, cards and cross-device delete records.</p>
      ${cloudSection}
    </div>

    <div class="storage-card">
      <h2>Image storage</h2>
      <p class="storage-sub">Files in the <code>images</code> bucket, under your own folder.</p>
      ${storageSection}
    </div>

    <div class="storage-card">
      <h2>This device</h2>
      <p class="storage-sub">The local copy that makes the app work offline.</p>
      <div class="storage-stats">
        ${storageStatTile(device.decks, "Decks")}
        ${storageStatTile(formatStorageBytes(device.bytes), "On this device")}
        ${storageStatTile(device.cachedImages, "Cached images")}
        ${storageStatTile(device.queuedImages, "Queued uploads", device.queuedImages ? "is-warn" : "")}
      </div>
      ${device.quota ? `<p class="storage-note">Browser storage used by this site: ${escapeHtml(formatStorageBytes(device.quotaUsed))} of about ${escapeHtml(formatStorageBytes(device.quota))} available${storagePersisted === false ? " (not persisted — the browser may reclaim some of this under disk pressure)" : storagePersisted ? " (persisted)" : ""}.</p>` : ""}
      ${device.queuedImages ? `<p class="storage-note is-warning">${device.queuedImages} image${device.queuedImages === 1 ? "" : "s"} still waiting to upload. Sync before clearing this device, or those images are lost.</p>` : ""}
    </div>

    <div class="storage-card is-danger">
      <h2>Clean up</h2>
      <p class="storage-sub">Nothing here drops a table, a bucket or your account — it only empties contents, and only for your account.</p>
      <div class="storage-actions">
        <button type="button" class="storage-action" data-storage-action="orphans"
          ${store && !store.orphanError && store.orphans.length ? "" : "disabled"}>
          Delete unused images${store && !store.orphanError && store.orphans.length ? ` (${store.orphans.length})` : ""}
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="images" ${store && store.count ? "" : "disabled"}>
          Delete all images
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="decks" ${cloud && (cloud.decks || cloud.tombstones) ? "" : "disabled"}>
          Delete all cloud decks &amp; cards
        </button>
        <button type="button" class="storage-action" data-storage-action="device" ${device.decks || device.cachedImages || device.queuedImages ? "" : "disabled"}>
          Clear this device
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="everything">
          Reset everything
        </button>
      </div>
      <p class="storage-note">Take a backup first — <strong>My Decks → ⋯ → Export All → Backup (.zip)</strong> holds every deck, note and image.</p>
    </div>

    <p class="storage-timestamp">Counted ${escapeHtml(report.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }))}${report.online ? "" : " · offline"}</p>
  `;
}

// A destructive action has to be typed out, not just clicked past.
export function confirmByTyping(word, title, hint) {
  return new Promise((resolve) => {
    showPromptModal(title, hint, "", (value) => {
      resolve(String(value || "").trim().toUpperCase() === word.toUpperCase());
    }, { placeholder: word });
  });
}

export async function runStorageAction(action) {
  if (storageBusy) return;
  const report = storageReport;
  const store = report?.storage;
  const device = report?.device;

  const run = async (label, work) => {
    storageBusy = true;
    renderStoragePanel(label);
    try {
      await work((text) => renderStoragePanel(text));
      storageBusy = false;
      await refreshStorageReport();
      showToast("Done", "success");
    } catch (error) {
      console.error("Storage cleanup failed", error);
      storageBusy = false;
      renderStoragePanel(`Failed: ${error?.message || "unknown error"}`);
      showToast("Cleanup failed", "error");
    }
  };

  if (action === "orphans") {
    if (!store?.orphans.length) return;
    const paths = store.orphans.map((object) => object.path);
    showConfirmModal(
      `Delete ${paths.length} unused image${paths.length === 1 ? "" : "s"} (${formatStorageBytes(store.orphanBytes)})? No deck or note points at ${paths.length === 1 ? "it" : "them"}.`,
      () => run("Deleting unused images…", (progress) => deleteStorageObjects(paths, progress)),
      { confirmLabel: "Delete", danger: true }
    );
    return;
  }

  if (action === "images") {
    if (!store?.count) return;
    if (!await confirmByTyping("DELETE", "Delete every image?",
      `All ${store.count} images (${formatStorageBytes(store.bytes)}) will be removed from your storage. Decks and notes stay, but the pictures in them become broken links. Type DELETE to confirm.`)) return;
    await run("Deleting images…", (progress) => deleteStorageObjects(store.objects.map((object) => object.path), progress));
    return;
  }

  if (action === "decks") {
    if (!await confirmByTyping("DELETE", "Delete all cloud decks and cards?",
      `${report.cloud.decks} deck${report.cloud.decks === 1 ? "" : "s"} and ${report.cloud.cards} card${report.cloud.cards === 1 ? "" : "s"} will be deleted from the database. Every device that has synced them will drop its copy on its next sync. Type DELETE to confirm.`)) return;
    await run("Deleting decks…", async (progress) => {
      await deleteAllCloudDecks();
      progress("Clearing delete records…");
      await deleteAllCloudTombstones().catch((error) => console.warn("Could not clear tombstones", error));
    });
    return;
  }

  if (action === "device") {
    const warning = device.queuedImages
      ? ` ${device.queuedImages} image${device.queuedImages === 1 ? "" : "s"} still waiting to upload will be lost.`
      : "";
    showConfirmModal(
      `Clear this device's copy of the library? Your cloud data is untouched and syncs back down.${warning} You stay signed in.`,
      () => run("Clearing this device…", () => wipeLocalLibrary()),
      { confirmLabel: "Clear device", danger: true }
    );
    return;
  }

  if (action === "everything") {
    if (!await confirmByTyping("RESET", "Reset everything?",
      "Deletes every deck, card and image in your account AND this device's copy. Tables, buckets, policies and your login all stay, so the app keeps working — it just starts empty. This cannot be undone. Type RESET to confirm.")) return;
    await run("Resetting…", async (progress) => {
      if (store?.objects.length) await deleteStorageObjects(store.objects.map((object) => object.path), progress);
      progress("Deleting decks and cards…");
      await deleteAllCloudDecks();
      progress("Clearing delete records…");
      await deleteAllCloudTombstones().catch((error) => console.warn("Could not clear tombstones", error));
      progress("Clearing this device…");
      await wipeLocalLibrary();
    });
    return;
  }
}
