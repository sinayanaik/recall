// Uploading a pasted or dropped image to the user's own Supabase Storage.
//
// Images are downscaled and re-encoded before they get here — a phone photo is
// several megabytes and nothing here needs that — at a level the person doing
// the uploading picks and confirms (src/images/compress.js and its dialog).
// Animated GIFs are left alone, since re-encoding one loses the animation.

import { getCachedSession } from "../cloud/auth.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";

// ----- Image upload (Supabase Storage) -------------------------------------
// Insert `text` at the textarea's caret and fire an input event so card state saves.
// `atPos` overrides the live caret — needed for the toolbar image button, where the
// file picker blurs the textarea and resets its selection before insertion.
export function insertAtCursor(textarea, text, atPos) {
  textarea.focus();
  if (typeof atPos === "number") {
    const p = Math.max(0, Math.min(atPos, textarea.value.length));
    textarea.selectionStart = textarea.selectionEnd = p;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.substring(0, start) + text + val.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Replace the first occurrence of `find` with `replace` in the textarea (used to swap the
// "uploading…" placeholder for the final markdown once the upload resolves).
// Used to swap an "uploading…" placeholder for the final markdown once an
// async image upload resolves. The caret is preserved relative to the
// replaced region rather than always snapped to right after the replacement
// — the upload is async, so the user may have kept typing further down in
// the textarea while it was in flight; without this, the caret would jump
// back and split their in-progress typing as soon as the upload finished.
export function replaceInTextarea(textarea, find, replace) {
  const idx = textarea.value.indexOf(find);
  if (idx === -1) return;
  const findEnd = idx + find.length;
  const delta = replace.length - find.length;
  const adjust = (pos) => {
    if (pos <= idx) return pos;
    if (pos >= findEnd) return pos + delta;
    return idx + replace.length; // caret was inside the placeholder itself
  };
  const newStart = adjust(textarea.selectionStart);
  const newEnd = adjust(textarea.selectionEnd);

  textarea.value = textarea.value.slice(0, idx) + replace + textarea.value.slice(findEnd);
  textarea.selectionStart = newStart;
  textarea.selectionEnd = newEnd;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Storage bucket for uploaded images (see supabase_setup.sql, section 7).
// PRIVATE: read, write and delete are all scoped per-user by RLS, keyed on the
// user.id folder prefix used below.
//
// getPublicUrl is still what an upload returns, and still what goes in the
// markdown — it just stopped being fetchable and became an IDENTIFIER. That is
// deliberate and is what let the buckets be locked down without rewriting a
// single note, re-keying the offline image cache, or touching
// supabaseImagePathFromUrl. A signed URL is resolved at render time instead —
// see src/cloud/storage-urls.js, which is also where the offline fallback back
// to this canonical form lives.
export const IMAGE_BUCKET = "images";

// Extension for the stored object's filename. Superset of IMAGE_MIME_EXT (which
// only ever sees optimized webp/jpeg/png blobs) so GIF/SVG — passed through
// un-optimized — get a real extension instead of ".img". Purely cosmetic:
// Storage serves the content-type set at upload, not one inferred from the name.
export const IMAGE_STORAGE_EXT = {
  "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png",
  "image/gif": "gif", "image/svg+xml": "svg"
};

// ── Where an uploaded image lands in the bucket ────────────────────────────
// Everything used to go straight into one flat `{uid}/` folder with a
// timestamp-random filename, which made a bucket of thousands of images
// impossible to read: you couldn't tell which book or deck any object came
// from, and you couldn't clear out one import without picking objects off
// one at a time. Uploads are now filed as:
//
//   {uid}/books/{book-slug}--{importId}/{NNN}-{original-name}.{ext}
//   {uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.{ext}
//   {uid}/unfiled/{ts}-{rand}.{ext}
//
// The `--{id}` suffix is what makes each folder unique: two imports of the
// same book, or two same-titled decks, never share a folder, so one can be
// deleted without touching the other. It's a suffix (not a prefix) so a
// rename-tolerant lookup can still find every folder belonging to one deck by
// matching on the id, while the human-readable slug stays in front where it's
// useful in the Storage browser.
//
// Only NEW uploads are affected. Images already in notes are absolute URLs and
// keep working wherever they sit — supabaseImagePathFromUrl below reads a path
// of any depth, so deleting an old flat-path image still works too.
export const UNFILED_IMAGE_FOLDER = "unfiled";

export const MAX_STORAGE_SLUG_LENGTH = 48;

// One path segment, safe for a Storage object key and readable in the Storage
// browser: lowercase a-z0-9 and dashes only. Storage accepts more than this,
// but spaces and non-ASCII turn into percent-escapes in every URL and log line
// that mentions the object, which defeats the point of naming the folder.
export function storageFolderSlug(value, fallback = "untitled") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STORAGE_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || fallback;
}

// Short, collision-resistant id for one upload group (one EPUB import run).
// Timestamp-first so folders sort chronologically in the Storage browser.
export function storageGroupId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Folder for images pasted/dropped into a deck's notes. Keyed on the deck's
// local id, which is stable for the deck's whole life, so every image a deck
// accumulates stays together. Returns null before the deck has ever been saved
// (no id to key on yet) — those go to `unfiled/`.
export function deckImageFolder() {
  const localId = state.localDeckId;
  if (!localId) return null;
  const slug = storageFolderSlug(state.deckTitle || state.sourceTitle, "untitled-deck");
  return `decks/${slug}--${localId}`;
}

// Resolves a canonical Supabase storage URL back to its object path within
// IMAGE_BUCKET, or null if `url` isn't one of ours (a legacy ImgBB/Drive/
// external link) — the signal deleteSupabaseImage uses to know whether
// there's anything it can actually delete.
export function supabaseImagePathFromUrl(url) {
  if (!supabaseClient || !url) return null;
  const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl("");
  const prefix = data?.publicUrl || "";
  if (!prefix || !url.startsWith(prefix)) return null;
  return url.slice(prefix.length).replace(/^\/+/, "");
}

// Best-effort delete of an uploaded image's underlying storage object. A no-op
// for URLs we didn't host (nothing to delete) or once the reference is already
// gone — this only ever runs after the note-side removal already succeeded, so
// a failure here is logged, not surfaced, rather than undoing that removal.
export async function deleteSupabaseImage(url) {
  const path = supabaseImagePathFromUrl(url);
  if (!path) return;
  try {
    const { error } = await supabaseClient.storage.from(IMAGE_BUCKET).remove([path]);
    if (error) console.warn("Could not delete image from storage", error);
  } catch (error) {
    console.warn("Could not delete image from storage", error);
  }
}

// Upload an image File/Blob to the signed-in user's own Supabase Storage
// bucket, returning its permanent public URL. Unlike ImgBB there's no separate
// API key to manage — the same login that unlocks sync also unlocks uploads,
// and because it's the user's own project, the image can later be deleted too
// (deleteSupabaseImage), which ImgBB's plain public-link API never allowed.
//
// `folder` is the per-book / per-deck subfolder the object is filed under (see
// the path scheme above); null means "no known owner" and lands in unfiled/.
// `name` is an optional extension-less basename — the EPUB importer passes the
// book's own image filename so a figure is recognisable in the bucket instead
// of being another anonymous timestamp.
export async function uploadImageToSupabase(file, { folder = null, name = null } = {}) {
  if (!navigator.onLine) throw new Error("OFFLINE");
  if (!supabaseClient || !isSignedIn) throw new Error("NOT_SIGNED_IN");
  // Read the id from the cached session (no network) rather than getUser()
  // (a round-trip per call) — a bulk EPUB import is hundreds of uploads
  // back-to-back, and one auth request each would dominate the import time.
  const session = await getCachedSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("NOT_SIGNED_IN");
  const ext = IMAGE_STORAGE_EXT[file.type] || "img";
  // The first segment stays the raw auth.uid() — the storage RLS policies match
  // on (storage.foldername(name))[1], so anything else here is rejected. Deeper
  // segments are unconstrained, which is why this nesting needs no SQL change.
  const dir = `${userId}/${folder || UNFILED_IMAGE_FOLDER}`;
  const base = name || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const path = `${dir}/${base}.${ext}`;
  const { error } = await withTimeout(
    supabaseClient.storage.from(IMAGE_BUCKET).upload(path, file, {
      contentType: file.type || "application/octet-stream",
      // Without this Supabase serves max-age=3600, so the browser re-fetched
      // every image in any session more than an hour after the last one. The
      // path above is random and never overwritten (upsert: false), so the
      // bytes at this URL cannot change and the cache can be permanent.
      cacheControl: "31536000, immutable",
      upsert: false
    }),
    CLOUD_TIMEOUT_MS,
    "upload image"
  );
  if (error) {
    const err = new Error(error.message || "Upload failed");
    // An RLS rejection is permanent for this session the same way a bad ImgBB
    // key was — retrying identically-forbidden uploads would just burn through
    // the rest of an EPUB import's images for nothing.
    err.authFailed = /permission|policy|not.*authoriz|row-level security/i.test(error.message || "");
    throw err;
  }
  // The canonical URL — an identifier now, not a fetchable address (see
  // IMAGE_BUCKET above). Returned unchanged so the markdown, the offline cache
  // key and supabaseImagePathFromUrl all keep agreeing on one string per image.
  const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  await cacheUploadedImageOffline(data.publicUrl, file);
  return data.publicUrl;
}

// The service worker's image cache is populated by FETCHING images — which
// means an image the user just added was the one image guaranteed to be missing
// from it: the markdown now points at a public URL, but the only copy that ever
// existed on this device was the file they picked, and it was uploaded, never
// downloaded. Going offline right after adding an image showed it as broken.
// We already hold the bytes, so write them straight into the same cache the
// worker reads (same name as sw.js's IMAGE_CACHE_NAME — it is deliberately not
// versioned, so this survives app updates). Best-effort: a failure here costs a
// re-download later, nothing more.
export const OFFLINE_IMAGE_CACHE = "recall-images-v1";

export async function cacheUploadedImageOffline(url, blob) {
  if (!url || !blob || typeof caches === "undefined") return;
  try {
    const cache = await caches.open(OFFLINE_IMAGE_CACHE);
    await cache.put(url, new Response(blob, {
      headers: { "Content-Type": blob.type || "application/octet-stream" }
    }));
  } catch (error) {
    console.warn("Could not pre-cache the uploaded image for offline use", error);
  }
}

// True while the toolbar image file picker is open. Opening the native file dialog
// blurs the textarea; without this guard the blur handler would exit edit mode before
// the picked image is inserted, so the insertion would land in a reset textarea.
export let imagePickerActive = false;

// Setter: an imported binding is read-only, and the file-input listeners in main.js open and close the picker.
export function setImagePickerActive(value) {
  imagePickerActive = value;
}
