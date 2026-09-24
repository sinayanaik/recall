// Turning a canonical Storage URL into one a private bucket will actually
// serve.
//
// Both buckets are private now (see supabase_setup.sql, section 7): anonymous
// read is gone, and a bare `.../object/public/images/{uid}/…` answers 400. What
// did NOT change is the string sitting in every note ever written — that URL is
// still exactly what `![](…)` holds, still what deleteSupabaseImage resolves a
// path from, and still the key the service worker's image cache is written
// under. It stopped being fetchable and became an IDENTIFIER, which is the whole
// trick: nothing already stored had to be rewritten, and nothing in the offline
// cache had to be re-keyed.
//
// What this module adds is the last step, taken as late as possible: just before
// an <img> loads, its canonical src is swapped for a signed URL of the same
// object. Signatures expire, so they are deliberately NOT written anywhere a
// note can see — only into the live DOM, and into a small localStorage map that
// is a cache, not a record.
//
// Offline or signed out, there is no signature to be had and the canonical URL
// is left exactly where it is. That is not a failure mode: sw.js answers it from
// `recall-images-v1`, which is why the normalisation in sw.js (a signed request
// is cached under its canonical URL) is load-bearing rather than tidiness.

import { isSignedIn, supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { canReachS3 } from "./s3-config.js?v=__BUILD__";
import { canonicalImageParts, isS3ImageUrl, s3ImageIndexHas, s3ImageIndexReady, s3ImageUrl } from "./s3-images.js?v=__BUILD__";
import { IMAGE_BUCKET, decodeStoragePath } from "../images/upload.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";

// A week. The upper bound Storage allows for a signed URL is far higher, but a
// week is already longer than any reading session and short enough that a
// signature leaked in a screenshot or a shared devtools log is not a permanent
// grant. Refreshed lazily at 80% of it, so a URL is never handed to an <img>
// with seconds left on it.
export const SIGNED_URL_TTL_SECONDS = 604800;

export const SIGNED_URL_REFRESH_AT = 0.8;

// createSignedUrls takes a path array; a book's chapter can reference dozens of
// figures and a whole-book note hundreds, so they are signed in batches rather
// than one request per image.
export const SIGNED_URL_BATCH = 100;

// The cache survives a reload, which matters more than it sounds: without it,
// opening the app offline right after a restart would have no signatures at all
// AND no way to mint them, and every image would fall back to the canonical URL
// — correct, but only because the worker's cache happens to hold it. With it,
// an image that was signed within the week renders from its signed URL whether
// or not this device can currently reach Supabase.
export const SIGNED_URL_CACHE_KEY = "recall:signedUrls";

// A cap, for the same reason readAllReadingPositions has one: this is one
// localStorage key for a whole library, and a signed URL is ~200 characters.
// Evicted oldest-expiry-first, which is also least-recently-signed.
export const SIGNED_URL_CACHE_MAX = 600;

// `${bucket}\n${path}` -> { url, expiresAt }. The in-memory half is the hot
// path (a render asks for every image in the note); localStorage is the copy
// that survives a reload.
const signedUrls = new Map();

let cacheLoaded = false;

function cacheKey(bucket, path) {
  return `${bucket}\n${path}`;
}

function loadSignedUrlCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = localStorage.getItem(SIGNED_URL_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const now = Date.now();
    Object.entries(parsed).forEach(([key, entry]) => {
      if (entry?.url && Number.isFinite(entry.expiresAt) && entry.expiresAt > now) {
        signedUrls.set(key, entry);
      }
    });
  } catch (_) {
    // A corrupt bag costs one round of re-signing, nothing more.
  }
}

let writeCacheTimer = 0;

// Debounced: one render signs every image in a note, and writing the whole map
// out per image would serialise it dozens of times in a frame.
function scheduleSignedUrlCacheWrite() {
  if (writeCacheTimer) return;
  writeCacheTimer = setTimeout(() => {
    writeCacheTimer = 0;
    writeSignedUrlCache();
  }, 500);
}

export function writeSignedUrlCache() {
  try {
    const now = Date.now();
    let entries = [...signedUrls.entries()].filter(([, entry]) => entry.expiresAt > now);
    if (entries.length > SIGNED_URL_CACHE_MAX) {
      entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      entries = entries.slice(entries.length - SIGNED_URL_CACHE_MAX);
    }
    localStorage.setItem(SIGNED_URL_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (error) {
    // Out of quota, or private mode. A signature that doesn't survive a reload
    // is re-minted on the next render; not worth a word to the user.
    console.warn("Could not store signed storage URLs", error);
  }
}

// Everything, for a device wipe. A signed URL is a bearer token for one
// account's object — leaving the bag behind after "sign out and remove all
// decks" would leave those objects readable to whoever signs in next.
// One object's signature, dropped. A cached signature is normally right until
// it nears expiry, but "the browser could not load this URL" is evidence that
// it is not — a signature minted before a session change, or one this device
// cached and then slept through, answers 400 and there is nothing in the entry
// itself that says so. Forgetting it is what lets the next signedUrlsFor() mint
// a fresh one rather than hand back the same dead string (see the retry in
// src/images/broken.js).
export function forgetSignedUrl(bucket, path) {
  if (!path) return;
  loadSignedUrlCache();
  if (!signedUrls.delete(cacheKey(bucket, path))) return;
  scheduleSignedUrlCacheWrite();
}

export function forgetSignedUrls() {
  signedUrls.clear();
  try {
    localStorage.removeItem(SIGNED_URL_CACHE_KEY);
  } catch (error) {
    console.warn("Could not clear the signed URL cache", error);
  }
}

function cachedSignedUrl(bucket, path) {
  loadSignedUrlCache();
  const entry = signedUrls.get(cacheKey(bucket, path));
  if (!entry) return null;
  // Refreshed at 80% of the TTL rather than at expiry, so an image is never
  // handed a URL that dies while it is still on screen.
  if (entry.expiresAt - Date.now() < SIGNED_URL_TTL_SECONDS * 1000 * (1 - SIGNED_URL_REFRESH_AT)) return null;
  return entry.url;
}

function rememberSignedUrl(bucket, path, url) {
  loadSignedUrlCache();
  signedUrls.set(cacheKey(bucket, path), { url, expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000 });
  scheduleSignedUrlCacheWrite();
}

// ── Everything below fails soft, on purpose ─────────────────────────────────
//
// resolveStorageImages runs after EVERY render, so anything in this file that
// can throw is something that can take the whole notes view down with it. And
// the client it leans on is not guaranteed to be the shape supabase-js
// currently ships: an older version, a project that was never configured, a
// stand-in in a check — each of those has some part of `storage.from(…)`
// missing. None of them is a reason to show a reader a blank note.
//
// So every call into the client is guarded, and every failure resolves to "no
// signature available", which the callers already treat correctly: the
// canonical URL stays where it is, and the service worker answers it from
// cache. That is the same degradation as being offline, which is a state this
// module is built to handle anyway.
function storageApi(bucket) {
  try {
    return supabaseClient?.storage?.from?.(bucket) || null;
  } catch (_) {
    return null;
  }
}

// The canonical, never-expiring identifier for an object — what goes in a note
// and what the offline cache is keyed by. Deliberately still getPublicUrl even
// though the bucket is private: this is a name, not a promise that a GET works.
export function canonicalStorageUrl(bucket, path) {
  if (!path) return "";
  try {
    const { data } = storageApi(bucket)?.getPublicUrl?.(path) || {};
    return data?.publicUrl || "";
  } catch (_) {
    return "";
  }
}

// The prefix every canonical URL for `bucket` starts with, computed once per
// bucket (getPublicUrl builds a string, but it is called per image otherwise).
const publicPrefixes = new Map();

export function canonicalStoragePrefix(bucket) {
  if (publicPrefixes.has(bucket)) return publicPrefixes.get(bucket);
  let prefix = "";
  try {
    prefix = storageApi(bucket)?.getPublicUrl?.("")?.data?.publicUrl || "";
  } catch (_) {
    prefix = "";
  }
  // Only a real answer is memoised — an empty one means the client was not
  // ready yet, and caching that would make every later call wrong for the life
  // of the session.
  if (prefix) publicPrefixes.set(bucket, prefix);
  return prefix;
}

// A canonical URL back to its object path, or null when `url` is not one of
// ours. The generic form of supabaseImagePathFromUrl (which stays where it is,
// as the images bucket's own answer, because deleteSupabaseImage's contract is
// "null means there is nothing here I can delete").
export function storagePathFromUrl(bucket, url) {
  const prefix = canonicalStoragePrefix(bucket);
  if (!prefix || !url || !url.startsWith(prefix)) return null;
  return decodeStoragePath(url.slice(prefix.length).replace(/^\/+/, ""));
}

// Whether signing is possible at all right now. Signed out, offline, or with no
// client, every caller below resolves to the canonical URL — see the module
// comment for why that is the right answer rather than an error.
export function canSignStorageUrls() {
  return Boolean(supabaseClient && isSignedIn && navigator.onLine);
}

// ...and whether the client in hand actually implements signing. Separate from
// the question above, because "offline" and "this client cannot do this" want
// the same fallback but are not the same fact.
export function storageSigningAvailable(bucket) {
  return typeof storageApi(bucket)?.createSignedUrls === "function";
}

// Sign many paths in one round trip. Returns a Map(path -> signed URL) holding
// only what actually signed: a caller with a path missing from the map keeps
// whatever it had.
export async function signedUrlsFor(bucket, paths) {
  const out = new Map();
  const wanted = [];
  for (const path of new Set(paths)) {
    if (!path) continue;
    const cached = cachedSignedUrl(bucket, path);
    if (cached) out.set(path, cached);
    else wanted.push(path);
  }
  if (!wanted.length || !canSignStorageUrls() || !storageSigningAvailable(bucket)) return out;

  for (let i = 0; i < wanted.length; i += SIGNED_URL_BATCH) {
    const batch = wanted.slice(i, i + SIGNED_URL_BATCH);
    try {
      const { data, error } = await storageApi(bucket).createSignedUrls(batch, SIGNED_URL_TTL_SECONDS);
      if (error) throw error;
      (data || []).forEach((row) => {
        // createSignedUrls reports per-path failures inline rather than
        // rejecting the batch — one deleted object must not cost the other 99
        // their signatures.
        if (!row || row.error || !row.signedUrl) return;
        const path = String(row.path || "").replace(/^\/+/, "");
        const url = absoluteSignedUrl(bucket, row.signedUrl);
        if (!path || !url) return;
        out.set(path, url);
        rememberSignedUrl(bucket, path, url);
      });
    } catch (error) {
      // Left to the canonical URL, which the worker's cache can still answer.
      console.warn("Could not sign storage URLs", error);
    }
  }
  return out;
}

export async function signedUrlFor(bucket, path) {
  if (!path) return "";
  const signed = await signedUrlsFor(bucket, [path]);
  return signed.get(path) || canonicalStorageUrl(bucket, path);
}

// supabase-js has returned both an absolute URL and a project-relative one
// ("/storage/v1/object/sign/…") across versions. Normalised here so the rest of
// the app — and sw.js's cache-key rewrite, which matches on the pathname — only
// ever sees one shape.
export function absoluteSignedUrl(bucket, signedUrl) {
  if (!signedUrl) return "";
  if (/^https?:\/\//i.test(signedUrl)) return signedUrl;
  const prefix = canonicalStoragePrefix(bucket);
  if (!prefix) return signedUrl;
  try {
    return new URL(signedUrl, prefix).toString();
  } catch (_) {
    return signedUrl;
  }
}

// ── Which storage a figure comes from ───────────────────────────────────────
//
// Figures can now be in the reader's own bucket as well as in Supabase — see
// src/cloud/s3-images.js. The identifier in the note is the same either way,
// so the choice is made here, per figure, just before it is loaded:
//
//   1. the bucket, when the bucket's index says it holds the figure;
//   2. otherwise Supabase, signed as before;
//   3. and when Supabase has no signature to give — it said the object is not
//      there, or this device is signed out — the bucket after all, because a
//      figure another device put there since the index was read is still a
//      figure the bucket holds.
//
// Offline, the bucket is not consulted at all: the canonical URL (or a cached
// Supabase signature) is left for the service worker, whose cache is keyed by
// the canonical identifier whichever storage the bytes first came from.
export async function resolveImageUrls(canonicalUrls) {
  const urls = new Map();
  const bucket = canReachS3() && navigator.onLine !== false;
  if (bucket) await s3ImageIndexReady();
  const viaSupabase = new Map();
  for (const url of new Set(canonicalUrls)) {
    // `parts` is null for an identifier outside the usual shape — a
    // self-hosted Supabase served under a path prefix, say. The bucket never
    // held those (its keys are made from the usual shape), but Supabase still
    // signs them exactly as it always did.
    const parts = canonicalImageParts(url);
    if (bucket && parts && s3ImageIndexHas(parts.host, parts.path)) {
      const signed = await s3ImageUrl(parts.host, parts.path);
      if (signed) {
        urls.set(url, signed);
        continue;
      }
    }
    const path = storagePathFromUrl(IMAGE_BUCKET, url);
    if (path) viaSupabase.set(url, path);
    else if (bucket && parts) {
      // A figure whose identifier this device's Supabase client does not
      // recognise (no client yet, or never): the bucket is the only place left.
      const signed = await s3ImageUrl(parts.host, parts.path);
      if (signed) urls.set(url, signed);
    }
  }
  if (viaSupabase.size) {
    const signed = await signedUrlsFor(IMAGE_BUCKET, [...viaSupabase.values()]);
    for (const [url, path] of viaSupabase) {
      const hit = signed.get(path);
      if (hit) {
        urls.set(url, hit);
        continue;
      }
      if (!bucket) continue;
      const parts = canonicalImageParts(url);
      const fallback = parts ? await s3ImageUrl(parts.host, parts.path) : "";
      if (fallback) urls.set(url, fallback);
    }
  }
  return urls;
}

// A URL that can actually be fetched right now for one canonical image URL:
// the bucket's or Supabase's signed form when one can be had, the canonical
// form otherwise. Used by the exports, the backup and the broken-image scan,
// which fetch bytes rather than handing a URL to an <img>.
//
// `method` matters for the bucket only. A bucket URL is signed for one verb —
// SigV4 signs the method — so a HEAD sent to a URL signed for GET is refused
// with 403, and the broken-image scan would call every figure there gone. So
// the storage is chosen exactly as a GET would choose it, and only a BUCKET
// answer is signed again for the verb actually being sent. A Supabase signed
// URL answers either verb as it is.
export async function fetchableStorageUrl(url, { method = "GET" } = {}) {
  if (!canonicalImageParts(url) && !storagePathFromUrl(IMAGE_BUCKET, url)) return url; // not ours — an ImgBB/Drive/external link, or a data: URI
  const resolved = (await resolveImageUrls([url])).get(url) || url;
  if (method === "GET" || !isS3ImageUrl(resolved)) return resolved;
  const parts = canonicalImageParts(url);
  return (parts && await s3ImageUrl(parts.host, parts.path, { method })) || resolved;
}

// ── The render-time swap ────────────────────────────────────────────────────
//
// Modelled on — and called beside — hydrateLocalImages (src/images/outbox.js),
// which solves the same "the markdown holds a token, the DOM needs a loadable
// URL" problem for images that have not been uploaded yet. Same signature, same
// place in the pipeline, same tolerance for being handed either a container or
// the list of freshly rendered nodes the incremental renderer just built.
//
// The canonical URL is kept on the element as data-canonical-src so a second
// pass over an already-resolved node (a re-render of a cached chunk, an export
// mounting the same nodes) can re-derive the path without parsing a signature.
export const CANONICAL_SRC_ATTR = "data-canonical-src";

// ── "Not signed yet" is not the same fact as "will not load" ────────────────
//
// An image left holding its canonical URL because this device could not sign
// ANYTHING at that moment — the session was still being confirmed, or the
// connection was gone — has not failed. It has not been asked yet. The
// distinction is load-bearing: bootApp renders this device's decks before the
// session answer arrives (see the signing-state block in cloud/supabase-client.js),
// so on every device except the one that uploaded the picture, that window is
// where every image in the note gets a canonical URL a private bucket answers
// 400 to. Marked here, read by images/broken.js, cleared by the re-resolve
// below when the answer finally lands.
export const STORAGE_UNRESOLVED_ATTR = "data-storage-unresolved";

// Every canonical image URL contains this, whatever host it names — the
// selector's fallback for a device whose Supabase client cannot say its own
// prefix, which can still load every figure the bucket holds.
const CANONICAL_IMAGE_SELECTOR = "/storage/v1/object/public/images/";

export async function resolveStorageImages(root = document) {
  const prefix = canonicalStoragePrefix(IMAGE_BUCKET);
  // Nothing to resolve with: no Supabase client to recognise or sign, and no
  // bucket either. Exactly the old early return.
  if (!prefix && !canReachS3()) return;
  const selector = prefix
    ? `img[src^="${prefix}"], img[${CANONICAL_SRC_ATTR}]`
    : `img[src*="${CANONICAL_IMAGE_SELECTOR}"], img[${CANONICAL_SRC_ATTR}]`;
  const nodes = Array.isArray(root)
    ? scopedQueryAll(root, selector)
    : root.querySelectorAll?.(selector);
  if (!nodes || !nodes.length) return;

  const byUrl = new Map();
  Array.from(nodes).forEach((node) => {
    const canonical = node.getAttribute(CANONICAL_SRC_ATTR) || node.getAttribute("src") || "";
    if (!storagePathFromUrl(IMAGE_BUCKET, canonical) && !canonicalImageParts(canonical)) return;
    node.setAttribute(CANONICAL_SRC_ATTR, canonical);
    const list = byUrl.get(canonical) || [];
    list.push(node);
    byUrl.set(canonical, list);
  });
  if (!byUrl.size) return;

  // Read ONCE, before the await: whether this device could ask at all is a fact
  // about the attempt, and re-reading it after the round trip would attribute a
  // sign-out that happened meanwhile to the images this pass was resolving.
  // The bucket counts as asking: its URLs are signed on this device, so a
  // figure it could serve is never left "waiting for a signature".
  const couldAsk = (canSignStorageUrls() && storageSigningAvailable(IMAGE_BUCKET))
    || (canReachS3() && navigator.onLine !== false);
  const resolved = await resolveImageUrls([...byUrl.keys()]);
  byUrl.forEach((elements, canonical) => {
    const url = resolved.get(canonical);
    elements.forEach((node) => {
      if (!url) {
        // No signature. If we never got to ask, this is unresolved and will be
        // retried; if we asked and the server declined for this one object, it
        // is a real answer and images/broken.js should be free to say so.
        if (couldAsk) node.removeAttribute(STORAGE_UNRESOLVED_ATTR);
        else node.setAttribute(STORAGE_UNRESOLVED_ATTR, "1");
        return;
      }
      node.removeAttribute(STORAGE_UNRESOLVED_ATTR);
      // Only when it actually differs: writing an identical src is still a DOM
      // write, and this runs after every render.
      if (node.getAttribute("src") !== url) node.setAttribute("src", url);
    });
  });
}

// Every image still waiting for a signature, asked again.
//
// Called when the session question is answered and when the connection comes
// back (see the subscription in src/main.js). Document-wide on purpose: the
// point is to reach surfaces that were rendered minutes ago and are still on
// screen, which is exactly what the per-render `root` cannot do. Cheap when
// there is nothing to do — one querySelectorAll that usually matches nothing.
//
// Returns the elements it re-resolved, so the caller can re-judge just those
// rather than re-walking every image on the page.
export async function resolveUnresolvedStorageImages(root = document) {
  const scope = root || document;
  const nodes = Array.isArray(scope)
    ? scopedQueryAll(scope, `img[${STORAGE_UNRESOLVED_ATTR}]`)
    : scope.querySelectorAll?.(`img[${STORAGE_UNRESOLVED_ATTR}]`);
  const waiting = nodes ? Array.from(nodes) : [];
  if (!waiting.length) return [];
  // The one retry images/broken.js allows was never spent — retrySignedImage
  // returns at its own canSignStorageUrls() guard before marking — but an image
  // that failed for some other reason earlier in the session may have spent it.
  // A fresh signature is a fresh chance, so give it back.
  for (const node of waiting) {
    delete node.dataset.signRetried;
    delete node.dataset.bucketRetried;
  }
  await resolveStorageImages(waiting);
  return waiting;
}
