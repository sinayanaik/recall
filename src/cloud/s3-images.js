// Figures in the reader's bucket.
//
// Papers moved out of Supabase into an S3-compatible bucket because they spent
// the free tier's gigabyte. Figures are smaller one at a time and far more
// numerous — an EPUB brings hundreds — and they spend the same gigabyte, so
// they follow the papers into the same bucket.
//
// ── The URL in a note does not change ─────────────────────────────────────
//
// Every figure ever pasted is referenced from markdown by its canonical
// Supabase URL, `…/storage/v1/object/public/images/<path>`. That string already
// stopped being fetchable when the bucket went private — it is an IDENTIFIER,
// resolved to something loadable just before an <img> needs it (see
// storage-urls.js). So moving the bytes needs no edit to any note:
//
//   canonical  https://<host>/storage/v1/object/public/images/<path>
//   bucket     recall-images/<host>/<path>
//
// The host rides in the key for the service worker's sake. A worker that has
// been stopped and restarted — which browsers do to idle workers constantly —
// has no memory of anything the page told it, and a figure loaded from the
// bucket has to be cached under its canonical identifier or it is not there
// offline. With the host in the key, the canonical URL can be rebuilt from the
// bucket URL alone, and there is nothing to remember. And a prefix of its own,
// beside `recall/` rather than inside it, so that counting the papers never has
// to page past thousands of figures.
//
// The bucket key is a pure function of the identifier. Nothing is rewritten,
// nothing can be rewritten wrong, the offline cache keeps one key per figure,
// and every tool that already understands the identifier — backup, the unused-
// image check, delete, the broken-image scan — keeps understanding it. New
// uploads are filed the same way, so a figure's identifier never says which
// storage holds it; this module is how the app finds out.
//
// ── Which storage holds a figure ──────────────────────────────────────────
//
// An in-memory index of the paths in the bucket, read with one LIST per
// thousand figures and topped up by every upload and copy this device makes.
// A figure in the index is loaded from the bucket; anything else is asked of
// Supabase first, and the bucket second (storage-urls.js). The index is a
// hint, never a verdict: a path it lacks is still tried in the bucket when
// Supabase has no answer, and nothing is ever deleted on its say-so.
//
// ── Why a presigned GET, and why dated to the day ─────────────────────────
//
// The bucket is private, and signing is local: no session, no round trip —
// which is why a device signed out of Supabase, but holding the bucket keys,
// still shows every figure the bucket has. A signature normally carries the
// minute it was made, so every render would mint a new URL, the <img> would
// see a new src, and the browser would fetch the figure again. Dating the
// signature to the start of the UTC day, valid for the seven days SigV4 allows,
// gives each figure ONE url a day.

import { canReachS3, loadS3Config } from "./s3-config.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "./net.js?v=__BUILD__";
import { deleteS3File, listS3Objects, putS3Object, s3FileHasSize, statS3File } from "./s3-files.js?v=__BUILD__";
import { presignS3Url, s3UriEncode } from "./s3-sign.js?v=__BUILD__";

export const S3_IMAGE_PREFIX = "recall-images";

// Written on every figure the app puts in the bucket. The key names one path
// for ever and a path is never written with different bytes, so a browser may
// keep it as long as it likes.
export const S3_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// SigV4's own ceiling for a presigned URL.
export const S3_IMAGE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

// The canonical identifier's shape. Read off the STRING, not through the
// Supabase client: a device whose client is not set up yet (or ever) can still
// load every figure the bucket holds, and the service worker — which has no
// client at all — rebuilds the same string from the other direction.
export const CANONICAL_IMAGE_PATH = "/storage/v1/object/public/images/";

const CANONICAL_IMAGE_RE = /^https:\/\/([^/?#]+)\/storage\/v1\/object\/public\/images\/([^?#]+)$/;

// { host, path } for a canonical image URL, or null when it is not one. The
// path comes back as the object's real name (decodeURI, exactly as
// decodeStoragePath does), because getPublicUrl spelled it with encodeURI.
export function canonicalImageParts(url) {
  const match = CANONICAL_IMAGE_RE.exec(String(url || ""));
  if (!match) return null;
  let path = match[2];
  try {
    path = decodeURI(path);
  } catch (_) {
    // A stray % that is not an escape: the encoded form is the better answer.
  }
  return path ? { host: match[1], path } : null;
}

export function canonicalImageUrlFor(host, path) {
  if (!host || !path) return "";
  return `https://${host}${CANONICAL_IMAGE_PATH}${encodeURI(path)}`;
}

// One figure's identity in this module: the host its identifier names, and the
// object's path. Also the index's key.
export function s3ImageId(host, path) {
  const clean = String(path || "").replace(/^\/+/, "");
  return host && clean ? `${host}/${clean}` : "";
}

export function s3ImageKey(host, path) {
  const id = s3ImageId(host, path);
  return id ? `${S3_IMAGE_PREFIX}/${id}` : "";
}

// recall-images/<host>/<path> back to { host, path }.
export function s3ImagePartsFromKey(key) {
  const prefix = `${S3_IMAGE_PREFIX}/`;
  const value = String(key || "");
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const cut = rest.indexOf("/");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { host: rest.slice(0, cut), path: rest.slice(cut + 1) };
}

// Which bucket the current keys point at. The index and the signed URLs are
// both facts about ONE bucket, and are dropped the moment the keys name another.
function s3ImageBucketSignature() {
  const config = loadS3Config();
  return config ? `${config.endpoint}\n${config.bucket}\n${config.accessKeyId}` : "";
}

function bucketOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// ── The index ───────────────────────────────────────────────────────────────

// How long a LIST is trusted before the next render may ask again. Uploads and
// copies made HERE are added as they happen; this bounds how long a figure
// another device put in the bucket goes unnoticed — and even then it still
// loads, through the bucket fallback in storage-urls.js.
export const S3_IMAGE_INDEX_TTL_MS = 10 * 60 * 1000;

// How long a render waits for the first LIST before it resolves figures without
// it. The render itself never waits: this is the image-resolution pass that
// runs after it, and a figure resolved without the index still loads.
export const S3_IMAGE_INDEX_WAIT_MS = 4000;

let s3ImageIds = new Set();
let s3ImageIndexFor = "";
let s3ImageIndexAt = 0;
let s3ImageIndexRun = null;
const s3ImageIndexListeners = new Set();

export function onS3ImageIndexChange(listener) {
  if (typeof listener !== "function") return () => {};
  s3ImageIndexListeners.add(listener);
  return () => s3ImageIndexListeners.delete(listener);
}

function announceS3ImageIndex() {
  for (const listener of s3ImageIndexListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("A bucket-image listener failed", error);
    }
  }
}

function currentS3ImageIndex() {
  const signature = s3ImageBucketSignature();
  if (!signature || signature !== s3ImageIndexFor) return null;
  return s3ImageIds;
}

export function s3ImageIndexHas(host, path) {
  const id = s3ImageId(host, path);
  return Boolean(id) && Boolean(currentS3ImageIndex()?.has(id));
}

export function s3ImageIndexSize() {
  return currentS3ImageIndex()?.size || 0;
}

// Added by this device the moment it knows — an upload that just landed, a
// figure just copied across. Not a guess: every caller has checked the object.
export function noteS3Image(host, path) {
  const id = s3ImageId(host, path);
  const signature = s3ImageBucketSignature();
  if (!id || !signature) return;
  if (signature !== s3ImageIndexFor) {
    s3ImageIds = new Set();
    s3ImageIndexFor = signature;
    s3ImageIndexAt = 0;
  }
  s3ImageIds.add(id);
}

export function forgetS3Image(host, path) {
  const id = s3ImageId(host, path);
  if (id && currentS3ImageIndex()) s3ImageIds.delete(id);
}

// Re-read the index from the bucket. Resolves true when the index is current
// afterwards. A LIST that fails leaves the previous index exactly as it was: a
// short list here would send figures that ARE in the bucket to Supabase first,
// which still works, but for no reason.
export function refreshS3ImageIndex({ force = false } = {}) {
  if (!canReachS3() || bucketOffline()) return Promise.resolve(false);
  const signature = s3ImageBucketSignature();
  const fresh = signature === s3ImageIndexFor && s3ImageIndexAt && Date.now() - s3ImageIndexAt < S3_IMAGE_INDEX_TTL_MS;
  if (fresh && !force) return Promise.resolve(true);
  if (s3ImageIndexRun) return s3ImageIndexRun;
  s3ImageIndexRun = (async () => {
    try {
      const objects = await listS3Objects(`${S3_IMAGE_PREFIX}/`, { strict: true });
      if (!objects) return false;
      // The keys changed while the LIST was out: this answer is about the old
      // bucket, and is dropped rather than filed under the new one.
      if (s3ImageBucketSignature() !== signature) return false;
      const next = new Set();
      for (const object of objects) {
        const parts = s3ImagePartsFromKey(object.key);
        if (parts) next.add(s3ImageId(parts.host, parts.path));
      }
      // Figures this device added while the LIST was in flight are kept: they
      // were checked in the bucket, and a listing can lag a write.
      if (signature === s3ImageIndexFor) for (const id of s3ImageIds) next.add(id);
      const changed = signature !== s3ImageIndexFor || next.size !== s3ImageIds.size
        || [...next].some((id) => !s3ImageIds.has(id));
      s3ImageIds = next;
      s3ImageIndexFor = signature;
      s3ImageIndexAt = Date.now();
      if (changed) announceS3ImageIndex();
      return true;
    } catch (error) {
      console.warn("Could not read which images are in the bucket", error);
      return false;
    } finally {
      s3ImageIndexRun = null;
    }
  })();
  return s3ImageIndexRun;
}

// Resolves once the index can be used — at once when it already can, after the
// first LIST (bounded by S3_IMAGE_INDEX_WAIT_MS) when it has never been read,
// and at once when there is no bucket to ask. Never rejects.
export function s3ImageIndexReady() {
  if (!canReachS3() || bucketOffline()) return Promise.resolve(false);
  if (currentS3ImageIndex() && s3ImageIndexAt) {
    // Stale is still usable; the refresh happens behind it.
    if (Date.now() - s3ImageIndexAt >= S3_IMAGE_INDEX_TTL_MS) refreshS3ImageIndex();
    return Promise.resolve(true);
  }
  const run = refreshS3ImageIndex();
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), S3_IMAGE_INDEX_WAIT_MS); });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// ── Loadable URLs ───────────────────────────────────────────────────────────

const s3ImageUrls = new Map();

// The signature's date: the start of the UTC day it was an hour ago. An hour
// back so that a device whose clock runs a little fast does not, just after
// midnight, date a request in the bucket's future and have it refused.
export function s3ImageSigningDay(now = Date.now()) {
  const day = new Date(now - 60 * 60 * 1000);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

// A URL the browser can use right now for one figure, or "" when there is no
// bucket. Local HMAC only — no network — so it answers offline too; whether
// the bytes arrive is for the network or the service worker's cache to say.
//
// Signed for ONE method, because SigV4 signs the method: a HEAD against a URL
// signed for GET is refused with 403, which the broken-image scan would read
// as "this picture is gone".
export async function s3ImageUrl(host, path, { method = "GET" } = {}) {
  const key = s3ImageKey(host, path);
  const config = loadS3Config();
  if (!key || !config || !canReachS3()) return "";
  const day = s3ImageSigningDay();
  const memo = `${s3ImageBucketSignature()}\n${day.getTime()}\n${method}\n${key}`;
  const hit = s3ImageUrls.get(memo);
  if (hit) return hit;
  try {
    const url = await presignS3Url(config, { method, key, expiresIn: S3_IMAGE_URL_TTL_SECONDS, now: day });
    // A day's worth of figures, then it starts again: an old day's URLs are
    // never asked for once the date has moved on.
    if (s3ImageUrls.size > 4000) s3ImageUrls.clear();
    s3ImageUrls.set(memo, url);
    return url;
  } catch (error) {
    console.warn("Could not sign a bucket image URL", error);
    return "";
  }
}

// What every bucket image URL starts with, spelled exactly as the signer
// spells it: path-style, each segment encoded.
export function s3ImageUrlPrefix() {
  const config = loadS3Config();
  if (!config) return "";
  return `${config.endpoint}/${s3UriEncode(config.bucket)}/${S3_IMAGE_PREFIX}/`;
}

export function isS3ImageUrl(url) {
  const prefix = s3ImageUrlPrefix();
  return Boolean(prefix) && String(url || "").startsWith(prefix);
}

// ── Write, read back, delete ────────────────────────────────────────────────

// One figure into the bucket, at the key its identifier names. Throws the same
// vocabulary as the paper upload (OFFLINE, NO_STORAGE, `authFailed`,
// `corsLikely`, `quotaExceeded`); resolves once the bucket took it.
export async function uploadS3Image(host, path, blob, { contentType = "" } = {}) {
  const key = s3ImageKey(host, path);
  if (!key) throw new Error("NO_IMAGE_PATH");
  if (bucketOffline()) throw new Error("OFFLINE");
  if (!canReachS3()) throw new Error("NO_STORAGE");
  await withTimeout(putS3Object(key, blob, {
    contentType: contentType || blob?.type || "application/octet-stream",
    cacheControl: S3_IMAGE_CACHE_CONTROL
  }), CLOUD_TIMEOUT_MS, "upload image to the bucket");
}

// { exists, size, answered } for one figure — see statS3File.
export function statS3Image(host, path) {
  return statS3File(s3ImageKey(host, path));
}

export function s3ImageHasSize(host, path, bytes) {
  return s3FileHasSize(s3ImageKey(host, path), bytes);
}

export async function deleteS3Image(host, path) {
  const removed = await deleteS3File(s3ImageKey(host, path));
  if (removed) forgetS3Image(host, path);
  return removed;
}

// Every figure in the bucket under one host — or one folder of it — as
// { host, path, size }. `strict` resolves null when the listing could not be
// read in full: see listS3Objects.
export async function listS3Images({ strict = false, host = "", dir = "" } = {}) {
  const scope = [host, String(dir || "").replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
  const objects = await listS3Objects(scope ? `${S3_IMAGE_PREFIX}/${scope}/` : `${S3_IMAGE_PREFIX}/`, { strict });
  if (!objects) return null;
  const out = [];
  for (const object of objects) {
    const parts = s3ImagePartsFromKey(object.key);
    if (parts) out.push({ ...parts, size: object.size });
  }
  return out;
}

// The names stored directly under one folder, or null when the bucket could not
// say — the bucket half of storedImageNames (images/upload.js), for the EPUB
// importer's single read-back of a whole book.
export async function storedS3ImageNames(host, dir) {
  const clean = String(dir || "").replace(/^\/+|\/+$/g, "");
  if (!host || !clean) return null;
  const objects = await listS3Images({ strict: true, host, dir: clean });
  if (!objects) return null;
  const names = new Set();
  for (const object of objects) {
    const rest = object.path.slice(clean.length + 1);
    if (object.path.startsWith(`${clean}/`) && rest && !rest.includes("/")) names.add(rest);
  }
  return names;
}
