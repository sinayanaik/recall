// The same picture is stored once.
//
// Every upload gets a path of its own (src/images/upload.js), so the same bytes
// sent twice used to become two objects in the bucket — a screenshot pasted
// twice, the same GIF dropped on two pages, a picture copied off one Canvas
// page through the system clipboard and pasted onto another. Copying a Block
// in the app never did (the copy is the same record, with the same address),
// but those other ways round did.
//
// So each upload's bytes are hashed (SHA-256) and remembered, on this device,
// against the address they went to — keyed by the FILE's folder, never across
// files: removing a picture from a file's Notes deletes its object once that
// file no longer shows it (removeSourceImage, src/images/surface-controls.js),
// and an object shared with another file would be deleted from under it. The
// next upload of the same bytes into the same file is handed the first one's
// address instead, once the object is confirmed to be there still
// (uploadImage, src/images/upload.js, does the asking). Any kind of picture —
// a still, a GIF, an animated WebP — is the same here: what is hashed is the
// bytes that would be uploaded.
//
// What is remembered is a cache, not a record: losing it costs one more upload
// and nothing else, so every failure here is "not known" and nobody waits on it.
//
// A leaf: no imports of the upload or outbox modules, which both use it.

export const MEDIA_HASH_DB = "recall-media-hashes";
const MEDIA_HASH_STORE = "hashes";
// Never more than this many remembered: the oldest go first.
const MEDIA_HASH_KEEP = 4000;

function openMediaHashes() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(MEDIA_HASH_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_HASH_STORE)) {
        const store = db.createObjectStore(MEDIA_HASH_STORE, { keyPath: "key" });
        store.createIndex("at", "at");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function mediaHashRequest(mode, run) {
  return openMediaHashes().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_HASH_STORE, mode);
    const request = run(tx.objectStore(MEDIA_HASH_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
  }));
}

// The bytes' SHA-256, as hex — or "" when they cannot be read or hashed.
export async function mediaHash(blob) {
  try {
    if (!blob || typeof blob.arrayBuffer !== "function" || !globalThis.crypto?.subtle) return "";
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

export function mediaHashKey(folder, hash) {
  return hash ? `${folder || ""}|${hash}` : "";
}

// What was remembered for these bytes in this file's folder: { url, size,
// type, at }, or null.
export async function recallMediaUpload(folder, hash) {
  const key = mediaHashKey(folder, hash);
  if (!key) return null;
  try {
    const entry = await mediaHashRequest("readonly", (store) => store.get(key));
    return entry?.url ? entry : null;
  } catch {
    return null;
  }
}

// After an upload: these bytes are at `url`.
export async function rememberMediaUpload(folder, hash, { url, size = 0, type = "" } = {}) {
  const key = mediaHashKey(folder, hash);
  if (!key || !url) return;
  try {
    await mediaHashRequest("readwrite", (store) => store.put({ key, url, size: Number(size) || 0, type: String(type || ""), at: Date.now() }));
    pruneMediaHashesSoon();
  } catch {
    /* not remembered: the next copy uploads, as it always did */
  }
}

// The address is no good any more (the object is gone): forget it.
export async function forgetMediaUpload(folder, hash) {
  const key = mediaHashKey(folder, hash);
  if (!key) return;
  try {
    await mediaHashRequest("readwrite", (store) => store.delete(key));
  } catch {
    /* nothing to forget */
  }
}

let pruneTimer = 0;

function pruneMediaHashesSoon() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = 0;
    pruneMediaHashes().catch(() => {});
  }, 5000);
}

async function pruneMediaHashes() {
  const count = await mediaHashRequest("readonly", (store) => store.count());
  if (!(count > MEDIA_HASH_KEEP)) return;
  let extra = count - MEDIA_HASH_KEEP;
  const db = await openMediaHashes();
  await new Promise((resolve) => {
    const tx = db.transaction(MEDIA_HASH_STORE, "readwrite");
    const cursor = tx.objectStore(MEDIA_HASH_STORE).index("at").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at || extra <= 0) return;
      at.delete();
      extra -= 1;
      at.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); resolve(); };
  });
}
