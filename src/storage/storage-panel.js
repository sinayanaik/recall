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
import { canReachS3 } from "../cloud/s3-config.js?v=__BUILD__";
import { s3DocumentKey, s3FileHasSize } from "../cloud/s3-files.js?v=__BUILD__";
import { listS3Images, noteS3Image, s3ImageHasSize, uploadS3Image } from "../cloud/s3-images.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml, formatStorageBytes } from "../core/text.js?v=__BUILD__";
import { deckPdfs, PDF_PRIMARY_ID } from "../documents/pdf-multi.js?v=__BUILD__";
import { clearAllLocalDocuments, deleteRemoteDocument, documentUsage, localDocumentUsage } from "../documents/pdf-store.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME, allOutboxImages, deleteOutboxImage, revokeLocalImageUrls } from "../images/outbox.js?v=__BUILD__";
import { findSourceImages, sourceMayHaveImages } from "../images/surface-controls.js?v=__BUILD__";
import { IMAGE_BUCKET, IMAGE_STORAGE_EXT, OFFLINE_IMAGE_CACHE, imageStorageHost, supabaseImagePathFromUrl } from "../images/upload.js?v=__BUILD__";
import { readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { resetActiveDeckAfterDelete } from "../library/tombstones.js?v=__BUILD__";
import { allDeckSnapshotIds, clearAllDeckSnapshots, forEachDeckSnapshot, storagePersisted } from "./deck-store.js?v=__BUILD__";
import { canonicalImageUrl, claimImageStorage, deleteStorageObjects, imageStorageBusyLabel, listStorageObjects, releaseImageStorage } from "./image-storage.js?v=__BUILD__";
import { LOCAL_DECKS_INDEX_KEY, NOTES_CONFLICT_SUFFIX } from "./keys.js?v=__BUILD__";
import { setDeckAutosaveStorageFailed } from "./quota.js?v=__BUILD__";
import { showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export let storageReport = null;

export let storageBusy = false;

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

  // A PDF deck's image blocks (`src`) and text blocks (`md`) point at figures
  // too, and this scan used to read neither — so every picture placed on a
  // page read as referenced by nothing, sat in the Unused tile, and went with
  // the next "Delete unused images". Read here and from the cloud below.
  const addBlocks = (blocks) => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.src === "string" && block.src && !block.src.startsWith(LOCAL_IMAGE_SCHEME)) {
        const path = supabaseImagePathFromUrl(decodeImageRefEntities(block.src));
        if (path) paths.add(path);
      }
      add(block.md);
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
    addBlocks(snapshot.meta?.pdfBlocks);
  });

  // Ordered by id, every page. Without an order Postgres is free to return the
  // rows of consecutive pages in different orders, so a row can fall between
  // two pages and never be read — and a row not read is a picture that looks
  // unused, which this list exists to prevent.
  onProgress?.("Reading decks in the cloud…");
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("decks").select("id, notes, pdfBlocks:meta->pdfBlocks").order("id", { ascending: true }).range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "read deck notes"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      add(row.notes);
      addBlocks(row.pdfBlocks);
    }
    if (rows.length < pageSize) break;
  }

  onProgress?.("Reading cards in the cloud…");
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("cards").select("id, question, answer").order("id", { ascending: true }).range(from, from + pageSize - 1),
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
    device: await deviceStorageStats()
  };

  // The bucket used to be read here too, and that is the coupling this split
  // removed: the bucket, its keys, the papers still elsewhere and the figures
  // in it are the Cloud bucket panel's (storage/bucket-panel.js), which reads
  // and refreshes on its own and never waits for — or is blocked by — the
  // census below.

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
    let missingError = "";
    try {
      onProgress?.("Checking which images are still used…");
      const referenced = await collectReferencedStoragePaths(onProgress);
      orphans = objects.filter((object) => !referenced.has(object.path));
      const objectPaths = new Set(objects.map((object) => object.path));
      missingRefs = [...referenced].filter((path) => !objectPaths.has(path));
      // A figure the reader's bucket holds is not missing — it simply lives
      // there now. Read in full or not at all: a partial listing would call
      // figures the bucket DOES hold missing, and offer to "restore" them.
      if (missingRefs.length && canReachS3()) {
        onProgress?.("Checking the bucket…");
        const host = imageStorageHost();
        const inBucket = host ? await listS3Images({ strict: true, host, dir: userId }) : null;
        if (!inBucket) {
          missingError = "Could not read the bucket, so which images are missing is not known.";
          missingRefs = [];
        } else {
          const held = new Set(inBucket.map((object) => object.path));
          missingRefs = missingRefs.filter((path) => !held.has(path));
        }
      }
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
      missingRefs,
      missingError
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

// deleteStorageObjects and canonicalImageUrl live in ./image-storage.js now,
// beside the listing, so the Cloud bucket panel can use them without reaching
// into this one.

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

  // Into the reader's bucket when there is one — where every new figure goes
  // now — at the same path, so the identifier in every note that names it
  // resolves there. Into Supabase otherwise, exactly as before.
  const host = canReachS3() ? imageStorageHost() : "";
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
    if (host) {
      try {
        await uploadS3Image(host, path, blob, { contentType });
        if (!(await s3ImageHasSize(host, path, blob.size))) throw new Error("the bucket copy did not check out");
        noteS3Image(host, path);
        repaired.push(path);
      } catch (error) {
        console.warn("Could not restore a missing image into the bucket", path, error);
        unrecoverable.push(path);
      }
      continue;
    }
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
         ${storageStatTile(store.orphanError || store.missingError ? "?" : store.missingRefs.length, "Missing", store.missingRefs?.length ? "is-warn" : "")}
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
       ${store.missingError ? `<p class="storage-note is-warning">${escapeHtml(store.missingError)}</p>` : ""}
       ${store.missingRefs.length
          ? `<p class="storage-note is-warning">${store.missingRefs.length} image${store.missingRefs.length === 1 ? "" : "s"} referenced by your decks ${store.missingRefs.length === 1 ? "is" : "are"} in neither Supabase nor your bucket, so ${store.missingRefs.length === 1 ? "it" : "they"} can't be shown or backed up. Deleting unused images will not help — this is the opposite problem. <strong>Restore missing images</strong> below puts back any this device still has a copy of; My Decks → More → Check for broken images shows which decks they're in.</p>
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

  // The three cards below are the CENSUS, and on a first open they are not
  // read yet — see buildStorageReport. They say so rather than showing a zero,
  // because a zero is a claim and "still counting" is the truth.
  const counting = `<div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
    <p class="storage-note">Counting… this walks every image, deck and card, so it takes a moment. Nothing above is waiting on it.</p>`;

  body.innerHTML = `
    <div class="storage-card">
      <h2>Your Cloud bucket</h2>
      <p class="storage-sub">Papers and images in your own S3-compatible bucket, the keys for it, and moving what is still in Supabase or Google Drive into it, are in their own panel: <strong>☰ → Cloud bucket</strong>. It loads and works on its own, so nothing there waits for the counting below.</p>
      <button type="button" class="storage-action" data-storage-action="open-bucket">Open the Cloud bucket panel</button>
    </div>

    <div class="storage-card">
      <h2>Cloud database</h2>
      <p class="storage-sub">Your decks, cards and cross-device delete records.</p>
      ${report.censusPending ? counting : cloudSection}
    </div>

    <div class="storage-card">
      <h2>Images in Supabase</h2>
      <p class="storage-sub">Files in the Supabase <code>images</code> bucket, under your own folder. Images you add now go to your Cloud bucket when one is set up; the ones already here move across from the Cloud bucket panel.</p>
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

// What the library knows about one object in the old `documents` bucket:
// which records name it, and whether each of those is safely in the bucket.
async function describeDocumentObject(path) {
  const records = [];
  await forEachDeckSnapshot((id, snapshot) => {
    if (String(id).includes(NOTES_CONFLICT_SUFFIX)) return;
    const meta = snapshot?.meta;
    if (!meta || typeof meta !== "object") return;
    const consider = (entry, pdfId) => {
      if (entry && typeof entry === "object" && entry.path === path) records.push({ entry, pdfId, title: snapshot.deckTitle || snapshot.title || "Untitled" });
    };
    deckPdfs(meta).forEach((entry) => consider(entry, entry.id || PDF_PRIMARY_ID));
    consider(meta.notebook, "notebook");
  });
  let inBucket = records.length > 0;
  for (const { entry, pdfId } of records) {
    const key = entry.sha256 ? (entry.s3Key || s3DocumentKey({ pdfId, sha256: entry.sha256 })) : "";
    if (!key || !canReachS3() || !(Number(entry.size) > 0 && await s3FileHasSize(key, Number(entry.size)))) {
      inBucket = false;
      break;
    }
  }
  return { records, inBucket };
}

// One document's cloud copy, deleted from the panel rather than from the deck.
//
// The deck's own meta.pdf.offloaded is NOT flipped here — this panel does not
// know which deck an object belongs to without reading the whole library, and
// getDocument already treats a 404 exactly as it treats an offloaded document:
// it falls back to the device copy, and to the re-attach prompt if there is
// none. The flag is a hint for the reader, not the mechanism.
//
// It used to delete on one click. For a paper not yet moved into the bucket,
// that object is the only copy in any cloud, and every device without the file
// would ask for it to be re-attached — so it now says which case this is, and
// asks.
export async function offloadStorageDocument(path) {
  if (!path) return;
  if (storageBusy) {
    showToast("Still counting — try again in a moment", "info");
    return;
  }
  const { records, inBucket } = await describeDocumentObject(path);
  const names = records.map((row) => row.entry.name || row.title).filter(Boolean);
  const which = names.length ? `“${names[0]}”${names.length > 1 ? ` (and ${names.length - 1} more)` : ""}` : "This file";
  const message = inBucket
    ? `${which} is safely in your Cloud bucket, so removing this Supabase copy frees its space and nothing else. Highlights, notes and cards stay.`
    : records.length
      ? `${which} is NOT in your Cloud bucket yet, so this may be the only copy in any cloud. Devices that do not already hold the file will ask for it to be re-attached. Move it from ☰ → Cloud bucket first to keep a copy. Remove it anyway?`
      : "No deck on this device names this file, so it may belong to a deck that is only on another device. Removing it cannot be undone. Remove it anyway?";
  showConfirmModal(message, async () => {
    if (storageBusy) return;
    storageBusy = true;
    renderStoragePanel("Removing the document from the cloud…");
    let removed = false;
    try {
      removed = await deleteRemoteDocument(path);
    } finally {
      storageBusy = false;
    }
    if (!removed) {
      showToast("Could not remove that document", "error");
      renderStoragePanel();
      return;
    }
    showToast("Removed from cloud", "success");
    await refreshStorageReport();
  }, { confirmLabel: "Remove", danger: !inBucket });
}

// Set by main.js: the Cloud bucket panel is opened from here without this
// module importing it (and so without the two panels' modules depending on
// each other).
let bucketPanelOpener = null;

export function setBucketPanelOpener(open) {
  bucketPanelOpener = typeof open === "function" ? open : null;
}

export async function runStorageAction(action) {
  if (action !== "open-bucket" && storageBusy) {
    // Said, not swallowed: a button that does nothing when pressed reads as
    // broken, and pressing it again does nothing again.
    showToast("Still counting — try again in a moment", "info");
    return;
  }
  const report = storageReport;
  const store = report?.storage;
  const device = report?.device;

  // `touchesImages`: the run changes Supabase image objects, and so takes the
  // image lock the Cloud bucket panel's copy and clean-up take too (see
  // storage/image-storage.js). Checked again here, after whatever confirmation
  // came first, because the other panel may have started something while the
  // dialog was open — and a second press of the same button may have too.
  const run = async (label, work, { touchesImages = false } = {}) => {
    if (storageBusy) {
      showToast("Still working — try again in a moment", "info");
      return;
    }
    if (touchesImages && !claimImageStorage(label)) {
      showToast(`Images are busy: ${imageStorageBusyLabel()}. Try again when that finishes.`, "info");
      return;
    }
    storageBusy = true;
    renderStoragePanel(label);
    let outcome;
    try {
      // What `work` returns, when it returns anything, replaces the flat
      // "Done": a repair's outcome is a count and a remainder, and "Done" over
      // the top of it would bury the only part a reader has to act on.
      outcome = await work((text) => renderStoragePanel(text));
    } catch (error) {
      console.error("Storage cleanup failed", error);
      storageBusy = false;
      if (touchesImages) releaseImageStorage();
      renderStoragePanel(`Failed: ${error?.message || "unknown error"}`);
      showToast("Cleanup failed", "error");
      return;
    }
    // Released exactly once, and before the recount: the recount can take a
    // while, and the lock is for CHANGING images, which is over.
    storageBusy = false;
    if (touchesImages) releaseImageStorage();
    await refreshStorageReport();
    showToast(outcome?.message || "Done", outcome?.tone || "success");
  };

  // The bucket's copies of these figures, for the deletes below: a figure the
  // bucket holds keeps its offline copy when its Supabase object goes, because
  // it is still a live figure. Null when there is no bucket or it cannot be
  // read in full — then every offline copy is kept, which only ever costs space.
  const bucketHeldPaths = async () => {
    if (!canReachS3()) return new Set();
    const host = imageStorageHost();
    const listed = host && store?.userId ? await listS3Images({ strict: true, host, dir: store.userId }) : null;
    return listed ? new Set(listed.map((object) => object.path)) : null;
  };

  // The bucket's own actions — its keys, the backfill, the paper move and the
  // figures — are the Cloud bucket panel's (storage/bucket-panel.js), with a
  // busy state of their own, so nothing here can hold them up.
  if (action === "open-bucket") {
    closeStoragePanel();
    bucketPanelOpener?.();
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
      }, { touchesImages: true }),
      { confirmLabel: "Restore" }
    );
    return;
  }

  if (action === "orphans") {
    if (!store?.orphans.length) return;
    const paths = store.orphans.map((object) => object.path);
    showConfirmModal(
      `Delete ${paths.length} unused image${paths.length === 1 ? "" : "s"} (${formatStorageBytes(store.orphanBytes)})? No deck or note points at ${paths.length === 1 ? "it" : "them"}.`,
      () => run("Deleting unused images…", (progress) => deleteStorageObjects(paths, progress), { touchesImages: true }),
      { confirmLabel: "Delete", danger: true }
    );
    return;
  }

  if (action === "images") {
    if (!store?.count) return;
    if (!await confirmByTyping("DELETE", "Delete every image in Supabase?",
      `All ${store.count} images (${formatStorageBytes(store.bytes)}) will be removed from your Supabase storage. Decks and notes stay; any picture that is not also in your Cloud bucket becomes a broken link. Your Cloud bucket is not touched. Type DELETE to confirm.`)) return;
    await run("Deleting images…", async (progress) => {
      const keepCached = await bucketHeldPaths();
      return deleteStorageObjects(store.objects.map((object) => object.path), progress, { keepCached: keepCached || true });
    }, { touchesImages: true });
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
      "Deletes every deck, card and image in your Supabase account AND this device's copy. Tables, buckets, policies and your login all stay, so the app keeps working — it just starts empty. Your Cloud bucket is not touched. This cannot be undone. Type RESET to confirm.")) return;
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
    }, { touchesImages: true });
    return;
  }
}
