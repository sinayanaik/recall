// PDF pages, kept as pictures on the device.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Nine rounds of work went into drawing a page faster, and the phone readout
// after the last of them (4GB, dpr 2.625, a 6-page paper of figures) still said
// "draw one page: median 536ms · p90 4.8s", "zoom: 7.0s (to 33%)", frames of six
// seconds under the finger. Every one of those rounds tuned HOW a page is
// redrawn — a queue, a second pass, a pause, a GPU canvas, a worker, a software
// canvas — and none asked whether it needed redrawing at all. It did not: a
// zoom redrew every nearby page, a zoom OUT redrew every page on screen, a
// scroll back redrew every page it had trimmed, and opening the same paper
// tomorrow redrew all of it again.
//
// A page's pixels are a function of five things: the file, the page, how wide
// it is drawn, the paper (light or dark), and the reader's marks on it. So they
// are drawn once, encoded, and kept here — and the reader shows an <img>, which
// is the one thing a browser is built to scroll: decoded off the main thread,
// held in memory the browser can discard and decode again, scaled on the GPU,
// never re-uploaded while it is unchanged and never lost with a GPU context.
//
// ── What is kept ────────────────────────────────────────────────────────────
//
// One record per picture, in a database of its own (not DOCUMENT_DB: a picture
// is a cache, and the paper is the one thing on this device that must never be
// evicted to make room for one). Keyed by
//
//     sha256 | page | width | paper | kind | stamp | recipe
//
// where `kind` is "plain" (the paper alone) or "marked" (with the reader's
// highlights and ink baked in, identified by `stamp`, a hash of exactly what was
// drawn). Marks are only ever composed onto a PLAIN picture, so no page is more
// than two JPEG generations from the PDF.
//
// The recipe carries the pdf.js version and this file's own drawing version: a
// picture drawn by an older pdf.js, or by a recipe that has since changed, is
// not a match for anything and is the first to go when room is needed.
//
// Least recently used goes first, under PDF_PICTURES_MAX_BYTES or a tenth of the
// quota, whichever is smaller. Listed and cleared in ☰ → Storage, and kept out of
// backups: every byte of it can be drawn again from the paper.
//
// Imports only what it must (the pdf.js URL, for the version), because the
// storage panel imports it too.

import { LIB_URLS } from "../core/lib-loader.js?v=__BUILD__";

export const PDF_PICTURES_DB = "recall-pdf-pictures";
const STORE = "pictures";

// Bump when what a picture LOOKS like changes for the same inputs — the encode
// quality, the dark bake, how marks are painted.
export const PDF_PICTURE_RECIPE = 1;

export const PDF_PICTURES_MAX_BYTES = 200 * 1024 * 1024;
export const PDF_PICTURES_QUOTA_FRACTION = 0.1;

// `recall:pdfPictures` = "0" turns picture pages off on this device, so the
// canvas path can be compared with them from App Info on the phone itself.
export const PDF_PICTURES_KEY = "recall:pdfPictures";

// Read when first asked, not at import: lib-loader.js sits on an import cycle
// with this module, and a const read across a cycle at load time can be read
// before it exists.
let pictureVersionCache = "";
export function pdfPictureVersion() {
  if (!pictureVersionCache) {
    const pdfjs = (String(LIB_URLS.pdfjs).match(/pdfjs-dist@([^/]+)/) || [])[1] || "?";
    pictureVersionCache = `${pdfjs}.r${PDF_PICTURE_RECIPE}`;
  }
  return pictureVersionCache;
}

export function pdfPicturesTurnedOff() {
  try { return localStorage.getItem(PDF_PICTURES_KEY) === "0"; } catch (_) { return false; }
}

export function setPdfPicturesTurnedOff(off) {
  try {
    if (off) localStorage.setItem(PDF_PICTURES_KEY, "0");
    else localStorage.removeItem(PDF_PICTURES_KEY);
  } catch (_) { /* private mode: for this session only, via the caller */ }
}

export function pictureKey({ sha, page, width, paper, kind = "plain", stamp = "" }) {
  return `${sha}|${page}|${width}|${paper}|${kind}|${stamp}|${pdfPictureVersion()}`;
}

// ── The database ────────────────────────────────────────────────────────────

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let request;
    try {
      request = indexedDB.open(PDF_PICTURES_DB, 1);
    } catch (_) {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("sha", "sha", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab clearing the store must not be held up by this one.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function pictureTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function metaOf(record) {
  const { blob, ...meta } = record;
  return meta;
}

// ── What this device holds, per paper, in memory ────────────────────────────
//
// Read once per paper (an index scan; the blobs stay on disk), so the reader can
// ask "is there a picture at least this wide" synchronously, per page, per zoom.
const paperPictureIndex = new Map();

export function loadPaperPictures(sha) {
  if (!sha) return Promise.resolve(null);
  const known = paperPictureIndex.get(sha);
  if (known) return known.ready;
  const entry = { metas: new Map(), ready: null };
  entry.ready = (async () => {
    const db = await openDb();
    if (!db) return entry.metas;
    try {
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index("sha");
      await new Promise((resolve, reject) => {
        const cursor = index.openCursor(IDBKeyRange.only(sha));
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) { resolve(); return; }
          const meta = metaOf(at.value);
          if (meta.version === pdfPictureVersion()) entry.metas.set(meta.key, meta);
          at.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    } catch (error) {
      console.warn("Could not read the stored pictures of this paper", error);
    }
    return entry.metas;
  })();
  paperPictureIndex.set(sha, entry);
  return entry.ready;
}

function paperMetas(sha) {
  return paperPictureIndex.get(sha)?.metas || null;
}

// The narrowest stored picture of this page at least `minWidth` wide — the one
// that is sharp enough and costs least to decode. Null when there is none (or
// the paper's pictures have not been read yet).
export function storedPicture({ sha, page, paper, kind = "plain", stamp = "", minWidth = 0 }) {
  const metas = paperMetas(sha);
  if (!metas) return null;
  let best = null;
  metas.forEach((meta) => {
    if (meta.page !== page || meta.paper !== paper || meta.kind !== kind || meta.stamp !== stamp) return;
    if (meta.width < minWidth) return;
    if (!best || meta.width < best.width) best = meta;
  });
  return best;
}

// The widest stored picture of this page — what a compose works from when no
// picture is wide enough for the zoom: still better than drawing from scratch
// if nothing else is going to be drawn.
export function widestStoredPicture({ sha, page, paper, kind = "plain", stamp = "" }) {
  const metas = paperMetas(sha);
  if (!metas) return null;
  let best = null;
  metas.forEach((meta) => {
    if (meta.page !== page || meta.paper !== paper || meta.kind !== kind || meta.stamp !== stamp) return;
    if (!best || meta.width > best.width) best = meta;
  });
  return best;
}

// Every page of the paper with a plain picture at least `minWidth` wide, for
// the prerender to skip.
export function pagesWithPictures(sha, paper, minWidth) {
  const out = new Set();
  paperMetas(sha)?.forEach((meta) => {
    if (meta.paper === paper && meta.kind === "plain" && meta.width >= minWidth) out.add(meta.page);
  });
  return out;
}

export async function getPictureBlob(key) {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, "readonly");
    const record = await new Promise((resolve, reject) => {
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return record?.blob || null;
  } catch (error) {
    console.warn("Could not read a stored picture", error);
    return null;
  }
}

// A picture that will not decode (a write cut short by the OS, a disk that
// lied) is dropped, and the page is drawn again in its place.
export async function dropPicture(key) {
  if (!key) return;
  paperPictureIndex.forEach((entry) => entry.metas.delete(key));
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await pictureTxDone(tx);
  } catch (_) { /* gone already */ }
}

let trimTimer = 0;

export async function putPicture(meta, blob) {
  if (!meta?.sha || !blob) return null;
  const record = {
    ...meta,
    key: pictureKey(meta),
    version: pdfPictureVersion(),
    bytes: blob.size,
    usedAt: Date.now(),
    blob
  };
  const metas = paperMetas(meta.sha);
  metas?.set(record.key, metaOf(record));
  const db = await openDb();
  if (!db) return record.key;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(record);
    // A marked picture of a page supersedes every other marked picture of that
    // page on that paper: the stamp it was drawn for is gone, and nothing will
    // ever ask for it again.
    if (record.kind === "marked" && metas) {
      metas.forEach((other) => {
        if (other.key === record.key || other.kind !== "marked" || other.page !== record.page
          || other.paper !== record.paper) return;
        store.delete(other.key);
        metas.delete(other.key);
      });
    }
    await pictureTxDone(tx);
  } catch (error) {
    // A full disk is the likeliest reason. The picture is still shown — it is
    // in hand — it just is not kept.
    metas?.delete(record.key);
    console.warn("Could not keep a page picture", error);
  }
  clearTimeout(trimTimer);
  trimTimer = setTimeout(() => { trimPictures().catch(() => {}); }, 4000);
  return record.key;
}

// ── Least recently used ─────────────────────────────────────────────────────
//
// Shown pictures are touchedPictureKeys in memory and written back in one transaction, a
// while later: a scroll through forty pages is one write, not forty.
const touchedPictureKeys = new Set();
let touchTimer = 0;

export function touchPicture(meta) {
  if (!meta?.key) return;
  meta.usedAt = Date.now();
  touchedPictureKeys.add(meta.key);
  if (touchTimer) return;
  touchTimer = setTimeout(flushTouches, 30000);
}

async function flushTouches() {
  touchTimer = 0;
  const keys = [...touchedPictureKeys];
  touchedPictureKeys.clear();
  if (!keys.length) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const now = Date.now();
    keys.forEach((key) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return;
        record.usedAt = now;
        store.put(record);
      };
    });
    await pictureTxDone(tx);
  } catch (_) { /* a touch is a hint */ }
}

async function pictureCap() {
  let cap = PDF_PICTURES_MAX_BYTES;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) cap = Math.min(cap, estimate.quota * PDF_PICTURES_QUOTA_FRACTION);
  } catch (_) { /* no estimate: the fixed cap */ }
  return cap;
}

async function allMetas() {
  const db = await openDb();
  if (!db) return [];
  const out = [];
  const tx = db.transaction(STORE, "readonly");
  await new Promise((resolve, reject) => {
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) { resolve(); return; }
      out.push(metaOf(at.value));
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return out;
}

export async function trimPictures({ cap = null } = {}) {
  const limit = cap ?? await pictureCap();
  const metas = await allMetas();
  let total = metas.reduce((sum, meta) => sum + (meta.bytes || 0), 0);
  if (total <= limit && metas.every((meta) => meta.version === pdfPictureVersion())) return 0;
  // Pictures from another recipe first (nothing will match them), then the
  // least recently used.
  metas.sort((a, b) => {
    const staleA = a.version === pdfPictureVersion() ? 1 : 0;
    const staleB = b.version === pdfPictureVersion() ? 1 : 0;
    if (staleA !== staleB) return staleA - staleB;
    return (a.usedAt || 0) - (b.usedAt || 0);
  });
  const drop = [];
  for (const meta of metas) {
    if (meta.version === pdfPictureVersion() && total <= limit) break;
    if (heldUrls.has(meta.key)) continue;
    drop.push(meta);
    total -= meta.bytes || 0;
  }
  if (!drop.length) return 0;
  const db = await openDb();
  if (!db) return 0;
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  drop.forEach((meta) => {
    store.delete(meta.key);
    paperMetas(meta.sha)?.delete(meta.key);
  });
  await pictureTxDone(tx);
  return drop.length;
}

export async function pdfPictureStats() {
  try {
    const metas = await allMetas();
    return { pictures: metas.length, bytes: metas.reduce((sum, meta) => sum + (meta.bytes || 0), 0) };
  } catch (_) {
    return { pictures: 0, bytes: 0 };
  }
}

export async function clearAllPdfPictures() {
  paperPictureIndex.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await pictureTxDone(tx);
  } catch (error) {
    console.warn("Could not clear the stored page pictures", error);
  }
}

// ── Blob URLs, counted ──────────────────────────────────────────────────────
//
// One URL per stored picture, shared by every <img> showing it, revoked when the
// last of them has been taken off the page — never before, or an <img> still on
// screen would lose its source mid-decode.
const heldUrls = new Map();

export function holdPictureUrl(key, blob) {
  const held = heldUrls.get(key);
  if (held) {
    held.refs += 1;
    return held.url;
  }
  const url = URL.createObjectURL(blob);
  heldUrls.set(key, { url, refs: 1 });
  return url;
}

export function releasePictureUrl(key) {
  const held = heldUrls.get(key);
  if (!held) return;
  held.refs -= 1;
  if (held.refs > 0) return;
  heldUrls.delete(key);
  URL.revokeObjectURL(held.url);
}

export function heldPictureCount() {
  return heldUrls.size;
}
