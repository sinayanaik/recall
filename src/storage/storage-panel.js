// What is actually stored, and the destructive tools for reclaiming it.
//
// Every irreversible action here is behind a type-the-word confirmation, and
// the orphan sweep only deletes objects no deck references — computed by
// reading the whole library first, not inferred.

import { BACKUP_IMAGE_REF_RE, decodeImageRefEntities } from "../backup/backup.js?v=__BUILD__";
import { backupNudgeDue, describeLastBackup, readLastBackup } from "../backup/history.js?v=__BUILD__";
import { getCachedSession } from "../cloud/auth.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml, formatStorageBytes } from "../core/text.js?v=__BUILD__";
import { S3_DEFAULT_REGION, canReachS3, canSignS3Requests, clearS3Config, isS3Configured, loadS3Config, markS3ConfigVerified, readS3ConfigRecord, s3CorsPolicy, saveS3Config } from "../cloud/s3-config.js?v=__BUILD__";
import { pushS3ConfigNow, s3ConfigSyncStatus } from "../cloud/s3-config-sync.js?v=__BUILD__";
import { s3Usage, testS3Connection } from "../cloud/s3-files.js?v=__BUILD__";
import { clearAllLocalDocuments, deleteRemoteDocument, documentUsage, localDocumentUsage } from "../documents/pdf-store.js?v=__BUILD__";
import { countBackfillOnDevice, documentBackfillStatus, migrateDocumentsToS3, planDocumentBackfill, planDocumentMigration, scheduleDocumentBackfill } from "./document-migration.js?v=__BUILD__";
import { cachedUserId } from "../quick-notes/categories.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, allOutboxImages, deleteOutboxImage, revokeLocalImageUrls } from "../images/outbox.js?v=__BUILD__";
import { findSourceImages, sourceMayHaveImages } from "../images/surface-controls.js?v=__BUILD__";
import { IMAGE_BUCKET, IMAGE_STORAGE_EXT, OFFLINE_IMAGE_CACHE, supabaseImagePathFromUrl } from "../images/upload.js?v=__BUILD__";
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

// ── Two scanners, unioned, because a MISS here deletes a live picture ──────
//
// BACKUP_IMAGE_REF_RE alone was not enough, and the shapes it misses are the
// ones src/render/inline.js already documents as ordinary in pasted, clipped
// and imported notes:
//
//   ![see [1]](url)          alt is `[^\]]*`, so this matches nothing at all
//   ![](…/Foo_(1).png)       the url is `[^)\s<>"']+`, so it yields `…/Foo_(1`
//   ![a][label]              the reference form is not in that pattern at all
//
// Each of those makes a LIVE object read as referenced by nothing, which puts
// it in the Unused tile and hands it to "Delete unused images" — a batch
// delete, so several live pictures go at once. src/images/upload.js names this
// exact failure: "A live picture, deletable by a tidy-up."
//
// findSourceImages is the control layer's own answer to "where is an image
// reference", including all three shapes above. It is unioned with the old
// pattern rather than replacing it: this set is the input to a deletion, so an
// extra path costs one image that is never swept, and a missing one costs a
// picture the reader still uses.
//
// skipCode is off deliberately. An `![](…)` inside a fence renders nothing, so
// no control may act on it — but counting its URL as referenced only ever
// PREVENTS a delete, which is the safe direction for this question.
export function referencedImageRefsIn(text) {
  const value = String(text || "");
  const refs = new Set();
  for (const match of value.matchAll(BACKUP_IMAGE_REF_RE)) {
    refs.add(decodeImageRefEntities(match[1] || match[2] || match[3] || match[4] || ""));
  }
  if (sourceMayHaveImages(value)) {
    for (const image of findSourceImages(value, { skipCode: false })) {
      refs.add(decodeImageRefEntities(image.url));
    }
  }
  return refs;
}

// Every storage path the library still points at. Read from the CLOUD (the
// authoritative copy — a deck may exist only there) unioned with this device's
// local snapshots (which may hold decks not pushed yet). Throws rather than
// returning a partial set: an incomplete reference list would mark live images
// as orphans, and this is the input to a delete.
export async function collectReferencedStoragePaths(onProgress) {
  const paths = new Set();
  const add = (text) => {
    for (const ref of referencedImageRefsIn(text)) {
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
  const stats = {
    ...(await localLibraryStats()),
    queuedImages: 0, cachedImages: 0, quotaUsed: 0, quota: 0,
    // A PDF deck keeps the whole file on the device (that is what makes it
    // readable offline), so on a library with papers in it this is by far the
    // largest number on this panel — and leaving it out would make the "on this
    // device" figure look like a mystery.
    documents: 0, documentBytes: 0
  };
  try {
    const documents = await localDocumentUsage();
    stats.documents = documents.length;
    stats.documentBytes = documents.reduce((sum, entry) => sum + entry.bytes, 0);
  } catch { /* no document store yet */ }
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
//
// ── Why this splits in two ─────────────────────────────────────────────────
//
// It used to be one pass, and opening the panel cost all of it. The expensive
// half is the Supabase CENSUS: a recursive listing of every object in the
// images bucket, then a second walk of every deck snapshot plus every
// decks.notes and cards.question/answer row at 500 a page, running two regex
// scanners over each field. That is O(everything) and it ran twice — once on
// open, and again after any action that called refreshStorageReport.
//
// Pressing a button in the storage card therefore paid for a full image census
// before the storage card could redraw, which is the single slowest thing in
// the app and had nothing whatsoever to do with what was pressed.
//
// So `census: false` returns everything that is cheap — what this device holds,
// what is in the bucket, what is still waiting to be migrated — and the caller
// paints that first. The census follows on its own, quietly, and lands
// underneath. Nothing that touches the credential card waits on it at all.
export async function buildStorageReport(onProgress, { census = true } = {}) {
  const report = {
    at: new Date(),
    signedIn: Boolean(supabaseClient && isSignedIn),
    online: navigator.onLine,
    cloud: null,
    cloudError: "",
    storage: null,
    storageError: "",
    censusPending: !census,
    s3: null,
    s3Error: "",
    migration: [],
    // Papers with no key in the bucket: how many this device could send up,
    // and how many are waiting on the device that imported them.
    backfill: { here: 0, elsewhere: 0, unknown: 0 },
    device: await deviceStorageStats()
  };

  // The bucket, and what is still waiting to leave an older backend. BEFORE
  // the sign-in and offline checks below, because neither applies to it: the
  // bucket has no Supabase session, and planDocumentMigration reads local deck
  // snapshots rather than the network. A reader who is signed out of Supabase,
  // or on a train, must still be able to see and fix their PDF storage.
  try {
    if (canReachS3()) {
      onProgress?.("Reading the bucket…");
      report.s3 = await s3Usage();
    }
  } catch (error) {
    report.s3Error = error?.message || "Could not read the bucket.";
  }
  try {
    report.migration = await planDocumentMigration();
  } catch (error) {
    console.warn("Could not plan the document migration", error);
  }
  try {
    // Papers still in Drive or the old Supabase bucket are already counted by
    // the card below, and can already be read from there; these are the ones
    // that are in NO cloud, which is what "only on one device" means.
    const unsent = (await planDocumentBackfill()).filter((job) => !job.legacy);
    report.backfill = await countBackfillOnDevice(unsent);
  } catch (error) {
    console.warn("Could not count the papers waiting to upload", error);
  }

  if (!census) return report;

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
    // The other direction. `orphans` are files nothing points at — harmless,
    // and deletable. These are the opposite and far worse: a deck still points
    // at a storage path that no longer HAS a file, so the image is simply gone
    // wherever that deck is read (and cannot be packed into a backup, which is
    // where people first notice). Free to compute — both sets are already here
    // — and it needs no per-image request, unlike probing each url over the
    // network. Reported, never acted on: the fix is to remove the reference or
    // re-add the picture, and only the reader knows which.
    let missingRefs = [];
    try {
      onProgress?.("Checking which images are still used…");
      const referenced = await collectReferencedStoragePaths(onProgress);
      orphans = objects.filter((object) => !referenced.has(object.path));
      const objectPaths = new Set(objects.map((object) => object.path));
      missingRefs = [...referenced].filter((path) => !objectPaths.has(path));
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
      orphanError,
      missingRefs
    };
  } catch (error) {
    report.storageError = error?.message || "Could not read the image bucket.";
  }

  // Documents last, and in a try of its own: a project set up before the
  // `documents` bucket existed answers with an error here, and that must not
  // take the image figures down with it.
  try {
    onProgress?.("Listing documents…");
    report.documents = await documentUsage();
  } catch (error) {
    report.documentsError = error?.message || "Could not read the documents bucket.";
  }

  return report;
}

// How many missing images get named before the list turns into a count. A
// count on its own is not actionable — "which picture is gone" is the question
// — but a storage path is long and there can be hundreds, so the list is the
// basenames and it stops.
export const MISSING_REF_PREVIEW = 8;

// Not decoded here: supabaseImagePathFromUrl already hands back the object's
// real name, so a second pass would turn a filename that genuinely contains
// "%20" into one with a space in it that matches nothing in the bucket.
export function missingRefPreview(paths) {
  return (paths || []).slice(0, MISSING_REF_PREVIEW)
    .map((path) => String(path).split("/").filter(Boolean).pop() || path);
}

// The 1GB Supabase free tier, which is the budget this panel exists to make
// legible. Not read from the project (there is no API for it) and not enforced
// anywhere — it is a denominator, so a reader can see "310MB of about 1GB"
// rather than a number with nothing to compare it to.
export const FREE_TIER_BYTES = 1024 * 1024 * 1024;

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
      // Built with getPublicUrl per path rather than by joining a prefix: the
      // cache is keyed by the URL, and getPublicUrl percent-encodes it, so a
      // name holding a space or an accent is stored under a key the raw join
      // never produces and its copy outlived the delete.
      for (const path of paths) await cache.delete(canonicalImageUrl(path), { ignoreVary: true });
    }
  } catch (error) {
    console.warn("Could not drop deleted images from the offline cache", error);
  }
  return deleted;
}

// The canonical URL for one object path — the string a note holds, and the key
// both the service worker's image cache and cacheUploadedImageOffline use.
export function canonicalImageUrl(path) {
  try {
    return supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path).data?.publicUrl || "";
  } catch (_) {
    return "";
  }
}

// ── Putting back an image the bucket has lost ───────────────────────────────
//
// `missingRefs` is the opposite of an orphan: a deck points at a storage path
// with no object behind it, so the picture is gone wherever that deck is read.
// It used to be reported and nothing more, on the reasoning that only the
// reader knows whether to remove the reference or re-add the picture. That is
// true when the bytes are gone — and often they are not.
//
// A device that ever displayed the image, and the device that uploaded it in
// the first place (cacheUploadedImageOffline writes the bytes there before the
// URL is even handed out), still hold it in the service worker's image cache.
// Re-uploading from there to the SAME path fixes every note that points at it,
// on every device, with no edit to any markdown — the reference was never
// wrong, only unfulfilled.
//
// upsert:true because this is a repair: if the object turns out to be there
// after all, writing identical bytes over it costs nothing, where a 409 would
// abandon the run.
export async function repairMissingStorageObjects(paths, onProgress) {
  const repaired = [];
  const unrecoverable = [];
  const cache = typeof caches !== "undefined" ? await caches.open(OFFLINE_IMAGE_CACHE).catch(() => null) : null;
  const mimeByExt = new Map(Object.entries(IMAGE_STORAGE_EXT).map(([type, ext]) => [ext, type]));

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    onProgress?.(`Restoring images ${i + 1}/${paths.length}…`);
    let blob = null;
    try {
      // ignoreVary, for the same reason the worker matches with it: Storage
      // answers a CORS request with `Vary: Origin`, and the entry would not
      // match a lookup that carries no Origin at all.
      const hit = cache ? await cache.match(canonicalImageUrl(path), { ignoreVary: true }) : null;
      if (hit) blob = await hit.blob();
    } catch (error) {
      console.warn("Could not read a cached copy of a missing image", path, error);
    }
    if (!blob?.size) { unrecoverable.push(path); continue; }
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const contentType = blob.type || mimeByExt.get(ext) || "application/octet-stream";
    try {
      const { error } = await withTimeout(
        supabaseClient.storage.from(IMAGE_BUCKET).upload(path, blob, {
          contentType,
          cacheControl: "31536000, immutable",
          upsert: true
        }),
        CLOUD_TIMEOUT_MS,
        "restore image"
      );
      if (error) throw error;
      repaired.push(path);
    } catch (error) {
      console.warn("Could not restore a missing image", path, error);
      unrecoverable.push(path);
    }
  }
  return { repaired, unrecoverable };
}

// Delete every deck row for this account. Cards go with them (cards.deck_id is
// ON DELETE CASCADE), and RLS confines the delete to rows this user owns, so
// the `neq` filter below is only there because PostgREST refuses an unfiltered
// DELETE outright.
export async function deleteAllCloudDecks() {
  const { error } = await withTimeout(
    supabaseClient.from("decks").delete().neq("id", "\u0000"),
    CLOUD_TIMEOUT_MS,
    "delete decks"
  );
  if (error) throw error;
}

export async function deleteAllCloudTombstones() {
  const { error } = await withTimeout(
    supabaseClient.from("deleted_decks").delete().neq("deck_id", "\u0000"),
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
  // The PDFs are the single largest thing this device holds, so a wipe that
  // left them behind would not be a wipe. Whatever is still in the cloud comes
  // back down on the next open; whatever was offloaded asks to be re-attached,
  // which is the same answer any other device gives for it.
  await clearAllLocalDocuments();
  try {
    if (typeof caches !== "undefined") await caches.delete(OFFLINE_IMAGE_CACHE);
  } catch { /* nothing cached */ }
  resetActiveDeckAfterDelete();
  await renderMyDecksList();
  return snapshotCount + 1;
}

// Opening is now three paints rather than one wait:
//
//   1. whatever was read last time, immediately — a slightly stale number the
//      reader can see beats a spinner while it is recounted;
//   2. the cheap half — this device, the bucket, what is left to migrate;
//   3. the census, quietly, landing underneath.
//
// Only the first open of a session shows a spinner at all, and even then only
// for step 2, which touches no Supabase table and lists no images.
export function openStoragePanel() {
  lockPageScroll();
  el.storagePanel.hidden = false;
  renderStoragePanel();
  const quiet = Boolean(storageReport);
  refreshStorageReport({ census: false, quiet })
    .then(() => refreshStorageReport({ census: true, quiet: true }));
}

export function closeStoragePanel() {
  el.storagePanel.hidden = true;
  unlockPageScroll();
}

// `quiet` is what makes the second pass invisible: without it every refresh
// blanks the panel back to a progress bar, so the census landing would rip
// away the card the reader was already reading. With it, the numbers simply
// appear.
export async function refreshStorageReport({ census = true, quiet = false } = {}) {
  if (storageBusy) return;
  storageBusy = true;
  if (!quiet) renderStoragePanel("Reading…");
  try {
    storageReport = await buildStorageReport((text) => { if (!quiet) renderStoragePanel(text); }, { census });
  } catch (error) {
    console.error("Storage report failed", error);
    storageBusy = false;
    // A report already on screen is KEPT. Since opening the panel is two
    // passes, throwing away the first one's numbers because the census behind
    // it failed would blank a card the reader was already reading — and the
    // cheap pass is the one that answers "is my PDF storage working", which is
    // exactly what they would be looking at when it happened.
    if (storageReport) {
      renderStoragePanel();
      showToast(`Could not finish counting: ${error?.message || "unknown error"}`, "error");
      return;
    }
    storageReport = null;
    renderStoragePanel(`Could not read storage: ${error?.message || "unknown error"}`);
    return;
  }
  storageBusy = false;
  renderStoragePanel();
}

export function storageStatTile(value, label, tone = "") {
  return `<div class="storage-stat${tone ? ` ${tone}` : ""}"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

// One sentence on whether the bucket keys have reached the account. Nothing at
// all when there are no keys anywhere to talk about.
export function bucketKeysSyncLine(report) {
  const record = readS3ConfigRecord();
  const sync = s3ConfigSyncStatus();
  if (!record.config && sync.state !== "unavailable") return "";
  const note = (text, warn = false) => `<p class="storage-note${warn ? " is-warning" : ""}">${text}</p>`;
  if (record.config && record.verified === false) {
    return note("These keys have not passed <strong>Save and test</strong> yet, so they stay on this device and are not sent to your other devices.", true);
  }
  if (!report?.signedIn) return note("The keys are on this device only until you sign in — then every device on your account gets them.");
  switch (sync.state) {
    case "synced":
      return note("Keys synced to your account — every device you sign in on can open these papers.");
    case "unavailable":
      return note("The keys are on this device only: your Supabase project has no <code>app_storage_settings</code> table yet. Re-run <code>supabase_setup.sql</code> and they sync to your other devices.", true);
    case "offline":
      return note("The keys sync to your other devices when you are back online.");
    case "failed":
      return note(`The keys could not be synced to your account${sync.detail ? ` — ${escapeHtml(sync.detail)}` : ""}. They are still used on this device.`, true);
    default:
      return note("The keys sync to your account at the next sync.");
  }
}

// A backfill run's stop reason, in the reader's terms. The raw tokens are what
// the upload path throws; a CORS or refusal message is already a sentence.
export function describeBackfillStop(reason) {
  if (reason === "NO_STORAGE") return "the bucket is not set up on this device.";
  if (reason === "OFFLINE") return "this device went offline.";
  return reason;
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

  // When the library was last copied out of here. It belongs on this panel more
  // than anywhere else: every other card on it says how much of your work lives
  // in one place, and this is the only line that says whether it lives in two.
  const lastBackup = readLastBackup();
  const index = readLocalDeckIndex();
  const changedAt = index.reduce((newest, meta) => Math.max(newest, Date.parse(meta.updatedAt || "") || 0), 0);
  const backupDue = backupNudgeDue({ record: lastBackup, changedAt, deckCount: index.length });

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
         ${storageStatTile(store.orphanError ? "?" : store.missingRefs.length, "Missing", store.missingRefs?.length ? "is-warn" : "")}
       </div>
       ${store.groups.length ? `<ul class="storage-groups">${store.groups.map((group) => `
         <li><span class="storage-group-name">${escapeHtml(group.label)}</span>
             <span class="storage-group-count">${group.count} file${group.count === 1 ? "" : "s"}</span>
             <span class="storage-group-size">${escapeHtml(formatStorageBytes(group.bytes))}</span></li>`).join("")}</ul>` : ""}
       ${store.orphanError
        ? `<p class="storage-note is-warning">${escapeHtml(store.orphanError)} Unused-image cleanup is disabled until this succeeds.</p>`
        : `${store.orphans.length
          ? `<p class="storage-note">${store.orphans.length} image${store.orphans.length === 1 ? " is" : "s are"} no longer referenced by any deck or note (${escapeHtml(formatStorageBytes(store.orphanBytes))}). These are what deleting an image or a deck leaves behind.</p>`
          : `<p class="storage-note">Every stored image is still in use.</p>`}
       ${store.missingRefs.length
          ? `<p class="storage-note is-warning">${store.missingRefs.length} image${store.missingRefs.length === 1 ? "" : "s"} referenced by your decks ${store.missingRefs.length === 1 ? "is" : "are"} no longer in storage, so ${store.missingRefs.length === 1 ? "it" : "they"} can't be shown or backed up. Deleting unused images will not help — this is the opposite problem. <strong>Restore missing images</strong> below puts back any this device still has a copy of; My Decks → More → Check for broken images shows which decks they're in.</p>
             <ul class="storage-groups">${missingRefPreview(store.missingRefs).map((name) => `
               <li><span class="storage-group-name">${escapeHtml(name)}</span></li>`).join("")}${
              store.missingRefs.length > MISSING_REF_PREVIEW
                ? `<li><span class="storage-group-name">…and ${store.missingRefs.length - MISSING_REF_PREVIEW} more</span></li>`
                : ""}</ul>`
          : ""}`}`
    : `<p class="storage-note is-warning">${escapeHtml(report.storageError || "No image data.")}</p>`;

  // Sorted biggest first and shown per file, because the action this section
  // exists to prompt is "which paper do I offload" — and that question is
  // answered by size, not by name.
  const documents = report.documents;
  const documentRows = documents
    ? documents.objects.slice().sort((a, b) => b.size - a.size).slice(0, 40)
    : [];
  const totalCloudBytes = (store?.bytes || 0) + (documents?.bytes || 0);
  const documentsSection = documents
    ? `<div class="storage-stats">
         ${storageStatTile(documents.count, "Documents")}
         ${storageStatTile(formatStorageBytes(documents.bytes), "Used")}
         ${storageStatTile(`${Math.round((totalCloudBytes / FREE_TIER_BYTES) * 100)}%`, "Of 1GB free tier", totalCloudBytes > FREE_TIER_BYTES * 0.8 ? "is-warn" : "")}
       </div>
       ${documentRows.length ? `<ul class="storage-groups">${documentRows.map((object) => `
         <li><span class="storage-group-name">${escapeHtml(object.name)}</span>
             <span class="storage-group-size">${escapeHtml(formatStorageBytes(object.size))}</span>
             <button type="button" class="storage-offload" data-storage-offload="${escapeHtml(object.path)}" title="Delete this file from the cloud — highlights, notes and cards all stay, and so does any copy on a device that has one">Offload</button></li>`).join("")}</ul>
         <p class="storage-note">Offloading deletes the cloud copy only. The deck keeps its highlights, notes and cards, and any device that already downloaded the file keeps reading it — other devices ask for it to be re-attached.</p>`
        : `<p class="storage-note">No documents stored. Import a PDF and the file itself lands here.</p>`}`
    : `<p class="storage-note is-warning">${escapeHtml(report.documentsError || report.storageError || "No document data.")}</p>`;

  // ── The bucket ───────────────────────────────────────────────────────────
  //
  // The form is shown whenever the bucket is NOT actually reachable, prefilled
  // with whatever is saved — not only when nothing is configured. Hiding it the
  // moment a value is stored was a trap the Drive card fell into: paste one
  // with a typo, watch the connect fail, and there is no longer anywhere to
  // correct it.
  //
  // The secret is rendered into a password field and never into the panel's
  // prose. It is not much of a defence — anything that can read the DOM can
  // read localStorage too — but it does cover the case this panel is genuinely
  // likely to meet, which is a screenshot or a shared screen.
  const s3 = report.s3;
  const s3Config = loadS3Config();
  const s3Reachable = canReachS3();
  const saved = s3Config || { endpoint: "", bucket: "", region: "", accessKeyId: "", secretAccessKey: "" };
  const s3Form = `
    <label class="storage-field" for="s3Endpoint">Endpoint</label>
    <input id="s3Endpoint" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="https://<account>.r2.cloudflarestorage.com" value="${escapeHtml(saved.endpoint)}">
    <label class="storage-field" for="s3Bucket">Bucket</label>
    <input id="s3Bucket" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="recall-papers" value="${escapeHtml(saved.bucket)}">
    <label class="storage-field" for="s3Region">Region</label>
    <input id="s3Region" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="${escapeHtml(S3_DEFAULT_REGION)}" value="${escapeHtml(saved.region || "")}">
    <label class="storage-field" for="s3KeyId">Access key ID</label>
    <input id="s3KeyId" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="" value="${escapeHtml(saved.accessKeyId)}">
    <label class="storage-field" for="s3Secret">Secret access key</label>
    <input id="s3Secret" class="storage-input" type="password" autocomplete="new-password" spellcheck="false"
           placeholder="" value="${escapeHtml(saved.secretAccessKey)}">
    <button type="button" class="storage-action" data-storage-action="s3-save">${isS3Configured() ? "Save and test again" : "Save and test"}</button>
    <button type="button" class="storage-action" data-storage-action="s3-cors">Copy the CORS policy</button>
    ${isS3Configured() ? `<button type="button" class="storage-action" data-storage-action="s3-forget">Forget these keys everywhere</button>` : ""}
    <p class="storage-note">Cloudflare R2 gives 10GB free with no charge for downloads; Backblaze B2 and anything else speaking S3 work the same way. Mint the token for <strong>this one bucket</strong> with object read &amp; write and nothing else.</p>
    <p class="storage-note is-warning">The secret key really is a secret. Once it passes the test it is kept in this browser <em>and</em> in your own Supabase project, so every device you sign in on gets it without pasting it again. Row Level Security keeps it to your account; whoever administers the Supabase project can still read it, and so can anyone using this browser profile — which is why the token should reach this one bucket and nothing else.</p>
    <p class="storage-note">Before the first upload works, the bucket needs a CORS policy allowing this site. <strong>Copy the CORS policy</strong> puts the exact JSON on your clipboard; paste it into the bucket's settings.</p>`;
  // Whether the keys have reached the account, which is the whole of whether a
  // second device can open anything. Said in one line, and said as a warning
  // when the answer is "no" — that was the silent half of "connected, but the
  // papers are not on my phone".
  const keysLine = bucketKeysSyncLine(report);
  const backfill = report.backfill || { here: 0, elsewhere: 0, unknown: 0 };
  const backfillRun = documentBackfillStatus();
  const backfillFailure = backfillRun.last?.stopped || backfillRun.last?.failures?.[0]?.reason || "";
  const one = backfill.here === 1;
  const backfillLine = backfill.here
    ? `<p class="storage-note${s3Reachable ? "" : " is-warning"}">${backfill.here} paper${one ? " is" : "s are"} on this device and not in the bucket yet, so no other device can open ${one ? "it" : "them"}. ${s3Reachable
        ? (backfillRun.running ? "Uploading now…" : `${one ? "It uploads by itself" : "They upload by themselves"} at every sync.`)
        : `${one ? "It uploads by itself" : "They upload by themselves"} once the bucket is set up.`}</p>
       ${s3Reachable && !backfillRun.running ? `<button type="button" class="storage-action" data-storage-action="s3-backfill">Upload ${one ? "it" : "them"} now</button>` : ""}
       ${backfillFailure && s3Reachable ? `<p class="storage-note is-warning">The last attempt stopped: ${escapeHtml(describeBackfillStop(backfillFailure))}</p>` : ""}`
    : "";
  const waitingLine = backfill.elsewhere
    ? `<p class="storage-note">${backfill.elsewhere} paper${backfill.elsewhere === 1 ? " is" : "s are"} not in the bucket and not on this device either. ${backfill.elsewhere === 1 ? "It uploads" : "They upload"} from the device that imported ${backfill.elsewhere === 1 ? "it" : "them"}, the next time that device syncs with the bucket set up.</p>`
    : "";
  const s3Section = !canSignS3Requests()
    ? `<p class="storage-note is-warning">This page is not being served over https, so the browser will not let it sign bucket requests. Papers stay on this device until it is.</p>`
    : s3Reachable
      ? `<div class="storage-stats">
           ${storageStatTile(s3 ? s3.count : "—", "Papers in the bucket")}
           ${storageStatTile(s3 ? formatStorageBytes(s3.bytes) : "—", "Used by Recall")}
           ${storageStatTile(s3Config.bucket, "Bucket")}
         </div>
         <p class="storage-note">Set up. New papers go here, deleting one gives the space straight back, and no sign-in is ever asked for.</p>
         ${keysLine}
         ${backfillLine}
         ${waitingLine}
         ${report.s3Error ? `<p class="storage-note is-warning">${escapeHtml(report.s3Error)}</p>` : ""}
         <details class="storage-details"><summary>Change the keys</summary>${s3Form}</details>`
      : `<p class="storage-note">Not set up. Papers you import are kept on this device and nowhere else until a bucket is added. If you already set one up on another device, sign in and sync — the keys come across by themselves.</p>
         ${keysLine}
         ${backfillLine}
         ${waitingLine}
         ${s3Form}`;

  // ── What has not moved across yet ────────────────────────────────────────
  //
  // Counted from the LOCAL deck snapshots, not from either old backend. That
  // is deliberate and it is why this line is free: it needs no Drive token, no
  // Supabase session and no network, so it is honest on a train and honest on
  // a device that was never connected to the Google account in question.
  const pending = report.migration || [];
  const pendingBytes = pending.reduce((sum, job) => sum + (job.bytes || 0), 0);
  const fromDrive = pending.filter((job) => job.source === "drive").length;
  const migrationSection = pending.length
    ? `<div class="storage-stats">
         ${storageStatTile(pending.length, "Papers to move")}
         ${storageStatTile(formatStorageBytes(pendingBytes), "Still elsewhere")}
         ${storageStatTile(`${fromDrive} · ${pending.length - fromDrive}`, "Drive · Supabase")}
       </div>
       <button type="button" class="storage-action" data-storage-action="migrate" ${s3Reachable ? "" : "disabled"}>
         Move them to the bucket${s3Reachable ? "" : " — add a bucket first"}
       </button>
       <p class="storage-note">Each paper is copied across and its deck updated <em>before</em> the old copy is deleted, so an interrupted move leaves a duplicate rather than a hole. Take a backup first if you want a belt as well as braces.</p>
       ${fromDrive ? `<p class="storage-note is-warning">${fromDrive} of these ${fromDrive === 1 ? "is" : "are"} in Google Drive. Reading them needs the Google account that holds them, so run this on a device that can still reach it — or re-attach the file by hand.</p>` : ""}`
    : `<p class="storage-note">Nothing left to move. Every paper in this library is either in the bucket or on this device alone.</p>`;

  // The three cards below are the CENSUS, and on a first open they are not
  // read yet — see buildStorageReport. They say so rather than showing a zero,
  // because a zero is a claim and "still counting" is the truth.
  const counting = `<div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
    <p class="storage-note">Counting… this walks every image, deck and card, so it takes a moment. Nothing above is waiting on it.</p>`;

  body.innerHTML = `
    <div class="storage-card">
      <h2>PDF storage</h2>
      <p class="storage-sub">Where papers are kept. Your own S3-compatible bucket — four values, pasted once on any device, and every device you sign in on gets them.</p>
      ${s3Section}
    </div>

    <div class="storage-card">
      <h2>Papers still elsewhere</h2>
      <p class="storage-sub">PDFs uploaded before the bucket, in Google Drive or the old Supabase <code>documents</code> bucket.</p>
      ${migrationSection}
    </div>

    <div class="storage-card">
      <h2>Cloud database</h2>
      <p class="storage-sub">Your decks, cards and cross-device delete records.</p>
      ${report.censusPending ? counting : cloudSection}
    </div>

    <div class="storage-card">
      <h2>Image storage</h2>
      <p class="storage-sub">Files in the <code>images</code> bucket, under your own folder.</p>
      ${report.censusPending ? counting : storageSection}
    </div>

    <div class="storage-card">
      <h2>Documents still in Supabase</h2>
      <p class="storage-sub">The objects themselves, as the bucket sees them. These are the big files — one paper can outweigh a hundred figures — and they are what filled the 1GB.</p>
      ${report.censusPending ? counting : documentsSection}
    </div>

    <div class="storage-card">
      <h2>This device</h2>
      <p class="storage-sub">The local copy that makes the app work offline.</p>
      <div class="storage-stats">
        ${storageStatTile(device.decks, "Decks")}
        ${storageStatTile(formatStorageBytes(device.bytes), "On this device")}
        ${storageStatTile(device.cachedImages, "Cached images")}
        ${storageStatTile(device.queuedImages, "Queued uploads", device.queuedImages ? "is-warn" : "")}
        ${storageStatTile(`${device.documents} · ${formatStorageBytes(device.documentBytes)}`, "PDFs held here")}
      </div>
      ${device.quota ? `<p class="storage-note">Browser storage used by this site: ${escapeHtml(formatStorageBytes(device.quotaUsed))} of about ${escapeHtml(formatStorageBytes(device.quota))} available${storagePersisted === false ? " (not persisted — the browser may reclaim some of this under disk pressure)" : storagePersisted ? " (persisted)" : ""}.</p>` : ""}
      ${device.queuedImages ? `<p class="storage-note is-warning">${device.queuedImages} image${device.queuedImages === 1 ? "" : "s"} still waiting to upload. Sync before clearing this device, or those images are lost.</p>` : ""}
    </div>

    <div class="storage-card">
      <h2>Backups</h2>
      <p class="storage-sub">A backup <code>.zip</code> is the only copy that does not depend on this device or on your cloud project still being there.</p>
      <p class="storage-note">${escapeHtml(describeLastBackup())}${lastBackup?.bytes ? ` · ${escapeHtml(formatStorageBytes(lastBackup.bytes))}` : ""}.</p>
      ${backupDue ? `<p class="storage-note is-warning">Your library has changed since then. My Decks → ⋯ → Export All → Backup (.zip) writes a new one — decks, notes, images and the PDFs themselves.</p>` : ""}
    </div>

    <div class="storage-card is-danger">
      <h2>Clean up</h2>
      <p class="storage-sub">Nothing here drops a table, a bucket or your account — it only empties contents, and only for your account.</p>
      <div class="storage-actions">
        <button type="button" class="storage-action" data-storage-action="repair"
          ${store && !store.orphanError && store.missingRefs.length ? "" : "disabled"}>
          Restore missing images${store && !store.orphanError && store.missingRefs.length ? ` (${store.missingRefs.length})` : ""}
        </button>
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

// One document's cloud copy, deleted from the panel rather than from the deck.
//
// The deck's own meta.pdf.offloaded is NOT flipped here — this panel does not
// know which deck an object belongs to without reading the whole library, and
// getDocument already treats a 404 exactly as it treats an offloaded document:
// it falls back to the device copy, and to the re-attach prompt if there is
// none. The flag is a hint for the reader, not the mechanism.
export async function offloadStorageDocument(path) {
  if (storageBusy || !path) return;
  storageBusy = true;
  renderStoragePanel("Removing the document from the cloud…");
  const removed = await deleteRemoteDocument(path);
  storageBusy = false;
  if (!removed) {
    showToast("Could not remove that document", "error");
    renderStoragePanel();
    return;
  }
  showToast("Removed from cloud", "success");
  await refreshStorageReport();
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
      // What `work` returns, when it returns anything, replaces the flat
      // "Done": a repair's outcome is a count and a remainder, and "Done" over
      // the top of it would bury the only part a reader has to act on.
      const outcome = await work((text) => renderStoragePanel(text));
      storageBusy = false;
      await refreshStorageReport();
      showToast(outcome?.message || "Done", outcome?.tone || "success");
    } catch (error) {
      console.error("Storage cleanup failed", error);
      storageBusy = false;
      renderStoragePanel(`Failed: ${error?.message || "unknown error"}`);
      showToast("Cleanup failed", "error");
    }
  };

  // Saving the keys does NOT go through `run`, and does not refresh the whole
  // report either. This is the fix for the complaint that started all of this:
  // the old drive-connect handler ended in a bare refreshStorageReport(), so
  // pressing Connect paid for a full recursive listing of every image in the
  // bucket, plus a scan of every deck and card, before the card the reader had
  // just used could redraw. It listed the entire library to tell you whether
  // four values were correct.
  //
  // Now it tests the credential, which is one HEAD-sized LIST against the
  // reader's own bucket, and re-renders. The census is not involved.
  if (action === "s3-save") {
    const typed = {
      endpoint: document.getElementById("s3Endpoint")?.value || "",
      bucket: document.getElementById("s3Bucket")?.value || "",
      region: document.getElementById("s3Region")?.value || "",
      accessKeyId: document.getElementById("s3KeyId")?.value || "",
      secretAccessKey: document.getElementById("s3Secret")?.value || ""
    };
    // Saved UNVERIFIED: kept here so a failed test leaves every field in the
    // form, but not fit to publish to the other devices until it passes.
    saveS3Config(typed, { ownerId: cachedUserId() || "", verified: false });
    if (!isS3Configured()) {
      showToast("Fill in the endpoint, bucket, key ID and secret", "error");
      renderStoragePanel();
      return;
    }
    renderStoragePanel("Testing the bucket…");
    const result = await testS3Connection();
    if (!result.ok) {
      // The config is deliberately LEFT SAVED on a failure. A reader who has
      // one field wrong needs the other four still in the form to fix it, and
      // clearing them on a bad test is how the Drive card used to lose a
      // Client ID that was one character out.
      showToast(result.reason, "error");
      // Only the bucket's own numbers are re-read; the census, which may have
      // landed already, is left exactly as it was.
      await refreshStorageReport({ census: false, quiet: true });
      return;
    }
    markS3ConfigVerified(cachedUserId() || "");
    renderStoragePanel("Sharing the keys with your other devices…");
    const shared = await pushS3ConfigNow();
    const where = shared.status === "synced"
      ? "your other devices get the keys at their next sync"
      : shared.status === "unavailable"
        ? "on this device only until supabase_setup.sql is re-run"
        : shared.status === "signed-out"
          ? "on this device only until you sign in"
          : "the keys reach your other devices at the next sync";
    showToast(`Bucket connected — ${where}`, shared.status === "unavailable" ? "info" : "success");
    if (result.warning) showToast(result.warning, "info");
    // Anything imported before this moment is still only on this device.
    scheduleDocumentBackfill({ force: true });
    await refreshStorageReport({ census: false, quiet: true });
    return;
  }

  if (action === "s3-backfill") {
    if (!canReachS3()) {
      showToast("Add a bucket first", "error");
      return;
    }
    // Not through `run`: a paper can take minutes, and the panel should not
    // sit behind a progress bar for it. The run reports back when it lands
    // (see onDocumentBackfillDone in main.js).
    scheduleDocumentBackfill({ force: true });
    showToast("Uploading in the background — you can carry on", "info");
    renderStoragePanel();
    return;
  }

  if (action === "s3-cors") {
    const policy = JSON.stringify(s3CorsPolicy(), null, 2);
    try {
      await navigator.clipboard.writeText(policy);
      showToast("CORS policy copied — paste it into the bucket's settings", "success");
    } catch {
      // A clipboard the browser will not hand over is not a dead end: the
      // policy is short, and a prompt the reader can select from beats a toast
      // saying it failed.
      showPromptModal(
        "Copy this into the bucket's CORS settings",
        "Your browser would not let the page write to the clipboard, so here it is to select and copy.",
        policy,
        () => {}
      );
    }
    return;
  }

  if (action === "s3-forget") {
    // Everywhere, now that the keys are the account's rather than this
    // device's: forgetting them here alone would last until the next sync
    // brought them straight back.
    showConfirmModal(
      "Forget the bucket keys on every device? Papers already downloaded keep opening, and nothing in the bucket is deleted — but new papers stay on the device they were imported on until keys are added again.",
      async () => {
        clearS3Config({ ownerId: cachedUserId() || "" });
        const shared = await pushS3ConfigNow();
        showToast(shared.status === "synced"
          ? "Keys forgotten on every device — papers already downloaded still open"
          : "Keys forgotten here — your other devices drop them once this one syncs", "info");
        await refreshStorageReport({ census: false, quiet: true });
      },
      { confirmLabel: "Forget everywhere", danger: true }
    );
    return;
  }

  if (action === "migrate") {
    if (!canReachS3()) {
      showToast("Add a bucket first", "error");
      return;
    }
    const jobs = await planDocumentMigration();
    if (!jobs.length) {
      showToast("Nothing left to move", "info");
      return;
    }
    const total = jobs.reduce((sum, job) => sum + job.bytes, 0);
    showConfirmModal(
      `${jobs.length} paper${jobs.length === 1 ? "" : "s"} (${formatStorageBytes(total)}) will be copied to your bucket, and removed from Google Drive or Supabase once each one is safely across. Your highlights, notes and cards are untouched, and so is every copy on this device.`,
      () => run("Moving papers to the bucket…", async (say) => {
        const summary = await migrateDocumentsToS3(jobs, {
          onProgress: (done, count, name) => say(`Moving ${done + 1} of ${count} — ${name}`)
        });
        if (summary.failed) {
          return {
            message: `Moved ${summary.moved}, freed ${formatStorageBytes(summary.bytes)} · ${summary.failed} could not be moved`,
            tone: "info"
          };
        }
        return { message: `Moved ${summary.moved} · ${formatStorageBytes(summary.bytes)} freed`, tone: "success" };
      }),
      { confirmLabel: "Move to the bucket" }
    );
    return;
  }

  if (action === "repair") {
    if (!store?.missingRefs.length) return;
    const paths = [...store.missingRefs];
    // Not behind a typed confirmation: this is the one action in the panel that
    // only ever ADDS. Nothing is deleted, nothing is overwritten but a path that
    // is already empty, and a run that finds no cached bytes changes nothing at
    // all.
    showConfirmModal(
      `Restore ${paths.length} missing image${paths.length === 1 ? "" : "s"} from this device's cache? Any this device no longer has a copy of are left alone and reported.`,
      () => run("Restoring images…", async (progress) => {
        const { repaired, unrecoverable } = await repairMissingStorageObjects(paths, progress);
        // Said plainly rather than as "Done": a partial repair is the normal
        // outcome — only a device that displayed or uploaded a picture still
        // holds its bytes — and the number that could not be restored is what
        // tells the reader which decks still need attention.
        return {
          message: repaired.length
            ? `Restored ${repaired.length} image${repaired.length === 1 ? "" : "s"}${unrecoverable.length ? `, ${unrecoverable.length} not held on this device` : ""}`
            : "No copies of those images are held on this device",
          tone: repaired.length ? "success" : "info"
        };
      }),
      { confirmLabel: "Restore" }
    );
    return;
  }

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
      if (report.documents?.objects.length) {
        progress("Deleting documents…");
        for (const object of report.documents.objects) await deleteRemoteDocument(object.path);
      }
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
