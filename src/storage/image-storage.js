// The figures' two homes, and moving them from one to the other.
//
// Figures were uploaded to the Supabase `images` bucket for as long as this app
// has had uploads. They go to the reader's own S3-compatible bucket now (see
// src/cloud/s3-images.js), and this module is what moves the ones already
// uploaded — and, separately and only when asked, frees the Supabase copies.
//
// Two panels read and change these objects: Storage & Data (the Supabase image
// census, its orphan sweep and its repair) and the Cloud bucket panel (the move
// and the clean-up). They are deliberately independent — neither waits for the
// other — but they must never CHANGE images at the same time: a census sweep
// deleting "unused" Supabase objects while a copy is reading them would copy
// fewer figures than it planned and report nothing wrong. So both take the one
// lock below for anything that writes or deletes, and say who holds it.
//
// ── Nothing here deletes a figure that is not safely elsewhere ─────────────
//
// The copy deletes nothing. The clean-up deletes a Supabase object only when,
// at the moment of deleting, a fresh listing of the bucket shows the same path
// at the same size — and only objects the reader already saw counted and
// confirmed. The offline cache is left alone throughout: it is keyed by the
// canonical identifier, which the bucket copy shares.

import { getCachedSession } from "../cloud/auth.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, mapWithConcurrency, withRetry, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { canReachS3 } from "../cloud/s3-config.js?v=__BUILD__";
import { listS3Images, noteS3Image, s3ImageHasSize, uploadS3Image } from "../cloud/s3-images.js?v=__BUILD__";
import { forgetSignedUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { IMAGE_BUCKET, IMAGE_STORAGE_EXT, OFFLINE_IMAGE_CACHE, imageStorageHost } from "../images/upload.js?v=__BUILD__";

// ── One lock for changing images, across both panels ───────────────────────

let imageStorageWork = "";

// The label of whatever is changing images right now, or "".
export function imageStorageBusyLabel() {
  return imageStorageWork;
}

// Takes the lock for `label`. False when something else holds it — the caller
// says so to the reader rather than silently doing nothing.
export function claimImageStorage(label) {
  if (imageStorageWork) return false;
  imageStorageWork = String(label || "Working on images");
  return true;
}

export function releaseImageStorage() {
  imageStorageWork = "";
}

// ── Supabase: listing and deleting ─────────────────────────────────────────

export const STORAGE_LIST_PAGE = 100;

// Storage's remove() takes a path array; keep each request modest so one slow
// batch can't stall the whole cleanup.
export const STORAGE_DELETE_BATCH = 100;

// Every object under one prefix, walking into subfolders. Storage's list() is
// one level at a time and pages at `limit`, and a folder entry is distinguished
// from a file by having no `id` — an EPUB import alone can nest hundreds of
// figures under books/<slug>--<run>/, so the recursion is not optional.
export async function listStorageObjects(prefix, onProgress, out = []) {
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE) {
    // A stalled connection or a transient Supabase hiccup on one page used to
    // fail the whole survey outright. Retried like every other idempotent
    // cloud read in this codebase (see net.js) — the error is checked and
    // thrown INSIDE the retried operation so a Supabase-returned error object,
    // not just a timeout, gets the same second chance.
    const { data } = await withRetry(async () => {
      const result = await withTimeout(
        supabaseClient.storage.from(IMAGE_BUCKET).list(prefix, {
          limit: STORAGE_LIST_PAGE,
          offset,
          sortBy: { column: "name", order: "asc" }
        }),
        CLOUD_TIMEOUT_MS,
        "list images"
      );
      if (result.error) throw result.error;
      return result;
    }, { label: "list images" });
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

// The canonical URL for one object path — the string a note holds, and the key
// both the service worker's image cache and cacheUploadedImageOffline use.
export function canonicalImageUrl(path) {
  try {
    return supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path).data?.publicUrl || "";
  } catch (_) {
    return "";
  }
}

// Deletes Supabase objects, a batch at a time. `keepCached` decides whose
// offline copies go with them: by default every one does (the object is gone,
// so its cached bytes describe nothing) — except a path in `keepCached`, or
// every path when it is `true`. A figure whose Supabase copy is removed
// because the bucket holds it is still a live figure, and its cached bytes
// are what shows it offline.
export async function deleteStorageObjects(paths, onProgress, { keepCached = null } = {}) {
  let deleted = 0;
  for (let i = 0; i < paths.length; i += STORAGE_DELETE_BATCH) {
    const batch = paths.slice(i, i + STORAGE_DELETE_BATCH);
    // Retried, like the listing above — a delete-by-path is idempotent (see
    // this module's header), so replaying it after a transient failure lands
    // in the same final state.
    await withRetry(async () => {
      const result = await withTimeout(
        supabaseClient.storage.from(IMAGE_BUCKET).remove(batch),
        CLOUD_TIMEOUT_MS,
        "delete images"
      );
      if (result.error) throw result.error;
      return result;
    }, { label: "delete images" });
    deleted += batch.length;
    onProgress?.(`Deleting images ${deleted}/${paths.length}…`);
  }
  if (keepCached === true) return deleted;
  // The offline cache still holds copies of files that no longer exist.
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      // Built with getPublicUrl per path rather than by joining a prefix: the
      // cache is keyed by the URL, and getPublicUrl percent-encodes it, so a
      // name holding a space or an accent is stored under a key the raw join
      // never produces and its copy outlived the delete.
      for (const path of paths) {
        if (keepCached?.has?.(path)) continue;
        await cache.delete(canonicalImageUrl(path), { ignoreVary: true });
      }
    }
  } catch (error) {
    console.warn("Could not drop deleted images from the offline cache", error);
  }
  return deleted;
}

// ── Both sides, counted ─────────────────────────────────────────────────────

async function signedInUserId() {
  if (!supabaseClient || !isSignedIn) return "";
  try {
    return (await getCachedSession())?.user?.id || "";
  } catch {
    return "";
  }
}

// Which figures are where, from fresh listings of both. Resolves
//   { supabase: {count, bytes}, bucket: {count, bytes},
//     toCopy: [object], inBoth: [object] }
// where `toCopy` are Supabase objects the bucket does not hold at the same size,
// and `inBoth` are ones it does. Throws when either listing cannot be read in
// full — a partial answer here is exactly what would make a later delete
// unsafe, so there is no partial answer.
export async function surveyImageStorage(onProgress) {
  if (!canReachS3()) throw new Error("The bucket is not set up on this device.");
  const userId = await signedInUserId();
  if (!userId) throw new Error("Sign in to read the images in Supabase.");
  if (!navigator.onLine) throw new Error("This device is offline.");
  const host = imageStorageHost();
  if (!host) throw new Error("Supabase is not set up on this device.");
  onProgress?.("Listing the images in Supabase…");
  const supabaseObjects = await listStorageObjects(userId, (n) => onProgress?.(`Listing the images in Supabase… ${n}`));
  onProgress?.("Listing the images in the bucket…");
  const bucketObjects = await listS3Images({ strict: true, host, dir: userId });
  if (!bucketObjects) throw new Error("Could not list the images in the bucket.");
  const bucketSize = new Map(bucketObjects.map((object) => [object.path, object.size]));
  const toCopy = [];
  const inBoth = [];
  for (const object of supabaseObjects) {
    if (bucketSize.get(object.path) === object.size && object.size > 0) inBoth.push(object);
    else toCopy.push(object);
  }
  const sum = (list, pick) => list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
  return {
    at: Date.now(),
    host,
    supabase: { count: supabaseObjects.length, bytes: sum(supabaseObjects, (object) => object.size) },
    bucket: { count: bucketObjects.length, bytes: sum(bucketObjects, (object) => object.size) },
    toCopy,
    inBoth
  };
}

// ── The copy ────────────────────────────────────────────────────────────────

// A few at a time: figures are small, and one at a time would make a library
// of thousands an afternoon.
export const IMAGE_COPY_CONCURRENCY = 4;

const imageMimeByExt = new Map(Object.entries(IMAGE_STORAGE_EXT).map(([type, ext]) => [ext, type]));

// The object's bytes, straight from Supabase. storage.download goes to the
// AUTHENTICATED endpoint, which the service worker does not intercept — so a
// copy of the whole library reads nothing through, and evicts nothing from,
// the offline image cache the reader relies on.
async function downloadSupabaseImage(path) {
  const { data } = await withRetry(async () => {
    const result = await withTimeout(
      supabaseClient.storage.from(IMAGE_BUCKET).download(path),
      CLOUD_TIMEOUT_MS,
      "download image"
    );
    if (result.error) throw result.error;
    return result;
  }, { label: "download image" });
  return data || null;
}

// Copies each object into the bucket at the same path, and checks it there.
// Deletes nothing, anywhere. Resolves { copied, failed, failures: [{path, reason}] }.
export async function copyImagesToS3(objects, host, { onProgress = null, isCancelled = () => false } = {}) {
  const summary = { copied: 0, failed: 0, failures: [] };
  let done = 0;
  await mapWithConcurrency(objects, IMAGE_COPY_CONCURRENCY, async (object) => {
    if (isCancelled()) return;
    try {
      const blob = await downloadSupabaseImage(object.path);
      if (!blob?.size) throw new Error("the download was empty");
      if (object.size && blob.size !== object.size) throw new Error(`the download was incomplete (${blob.size} of ${object.size} bytes)`);
      const ext = object.path.split(".").pop()?.toLowerCase() || "";
      const contentType = object.mimetype || (blob.type && blob.type !== "application/octet-stream" ? blob.type : "") || imageMimeByExt.get(ext) || "application/octet-stream";
      await uploadS3Image(host, object.path, blob, { contentType });
      if (!(await s3ImageHasSize(host, object.path, blob.size))) throw new Error("the bucket copy did not check out");
      noteS3Image(host, object.path);
      summary.copied += 1;
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({ path: object.path, reason: error?.message || "failed" });
    } finally {
      done += 1;
      onProgress?.(done, objects.length, object.path);
    }
  });
  return summary;
}

// ── The clean-up ────────────────────────────────────────────────────────────

// Deletes the Supabase copy of each path in `confirmed` — the set the reader
// was shown and agreed to — that a FRESH survey, taken now, still finds in the
// bucket at the same size. Anything that has changed since the reader looked
// is left alone. Offline copies are kept: they are the figure's, not the
// Supabase object's. Resolves { removed, bytes, skipped }.
export async function removeSupabaseImageCopies(confirmed, { onProgress = null } = {}) {
  const survey = await surveyImageStorage(onProgress);
  const wanted = confirmed instanceof Set ? confirmed : new Set(confirmed || []);
  const safe = survey.inBoth.filter((object) => wanted.has(object.path));
  const paths = safe.map((object) => object.path);
  if (paths.length) {
    await deleteStorageObjects(paths, onProgress, { keepCached: true });
    // Any signature this device cached for them now names nothing.
    for (const path of paths) forgetSignedUrl(IMAGE_BUCKET, path);
  }
  return {
    removed: paths.length,
    bytes: safe.reduce((total, object) => total + (Number(object.size) || 0), 0),
    skipped: wanted.size - paths.length
  };
}
