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

// A URL that can actually be fetched right now for one canonical image URL:
// the signed form when we can mint one, the canonical form otherwise. Used by
// the exports, which fetch bytes rather than handing a URL to an <img>.
export async function fetchableStorageUrl(url) {
  const path = storagePathFromUrl(IMAGE_BUCKET, url);
  if (!path) return url; // not ours — an ImgBB/Drive/external link, or a data: URI
  const signed = await signedUrlsFor(IMAGE_BUCKET, [path]);
  return signed.get(path) || url;
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

export async function resolveStorageImages(root = document) {
  const prefix = canonicalStoragePrefix(IMAGE_BUCKET);
  if (!prefix) return;
  const selector = `img[src^="${prefix}"], img[${CANONICAL_SRC_ATTR}]`;
  const nodes = Array.isArray(root)
    ? scopedQueryAll(root, selector)
    : root.querySelectorAll?.(selector);
  if (!nodes || !nodes.length) return;

  const byPath = new Map();
  Array.from(nodes).forEach((node) => {
    const canonical = node.getAttribute(CANONICAL_SRC_ATTR) || node.getAttribute("src") || "";
    const path = storagePathFromUrl(IMAGE_BUCKET, canonical);
    if (!path) return;
    node.setAttribute(CANONICAL_SRC_ATTR, canonical);
    const list = byPath.get(path) || [];
    list.push(node);
    byPath.set(path, list);
  });
  if (!byPath.size) return;

  // Read ONCE, before the await: whether this device could ask at all is a fact
  // about the attempt, and re-reading it after the round trip would attribute a
  // sign-out that happened meanwhile to the images this pass was resolving.
  const couldAsk = canSignStorageUrls() && storageSigningAvailable(IMAGE_BUCKET);
  const signed = await signedUrlsFor(IMAGE_BUCKET, [...byPath.keys()]);
  byPath.forEach((elements, path) => {
    const url = signed.get(path);
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
  for (const node of waiting) delete node.dataset.signRetried;
  await resolveStorageImages(waiting);
  return waiting;
}
