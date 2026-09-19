// Where a PDF deck's actual bytes live.
//
// Two copies, and both are load-bearing:
//
//   • the DEVICE copy, in an IndexedDB store of its own, keyed by the deck's
//     local id. This is what the reader opens; it is also what makes a paper
//     readable with no connection, which the Cache API could not give us
//     (a PDF is fetched by the app as an ArrayBuffer, not by the browser as a
//     subresource, so the service worker's caches never see it).
//   • the CLOUD copy, so the same paper opens on a phone that has never seen
//     the file. That copy lives in the reader's own Google Drive now. It used
//     to live in a private `documents` bucket in their Supabase project, and
//     PDFs are what filled the free tier's 1GB — one paper outweighs a hundred
//     figures. Drive is 15GB, costs nothing, and needs no secret kept (see
//     src/cloud/drive-client.js).
//
//     Both are read. Nothing already uploaded was rewritten or moved: a record
//     written before this change still carries its Storage `path` and still
//     opens from it, exactly as it did. `path` is never cleared, for the same
//     reason offloadCurrentDocument does not clear it — it is the record of
//     where those bytes are. New uploads carry a `driveId` instead, and
//     getDocument below prefers it. The Storage panel is where a reader moves
//     the old ones across and gets their Supabase quota back.
//
// Modelled on src/images/outbox.js, which solves the same shape of problem for
// images pasted offline — same IndexedDB idiom, same one-store-one-database
// layout, same "a failure here costs a re-download, not the data" tolerance.
//
// The file is never re-encoded, re-rendered or extracted. A highlight is a
// coordinate into THIS file (see pdf-selection.js), which only holds if the
// bytes never change — hence the sha256, and hence re-attach refusing a file
// whose hash does not match.

import { getCachedSession } from "../cloud/auth.js?v=__BUILD__";
import { canReachDrive, isDriveConfigured, requestDriveToken } from "../cloud/drive-client.js?v=__BUILD__";
import { deleteDriveFile, downloadDriveFile, findDriveFileByProperties, uploadDriveFile } from "../cloud/drive-files.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { canSignStorageUrls, signedUrlFor } from "../cloud/storage-urls.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";

// Separate from `images` so a paper is never anonymously readable (the images
// bucket was public until this change, and old objects in it are the reason
// that history matters), and so the storage panel can account for the two
// independently — "what is my 1GB holding" has a very different answer when one
// PDF is the size of two hundred figures.
export const DOCUMENT_BUCKET = "documents";

export const DOCUMENT_DB = "recall-documents";

export const DOCUMENT_STORE = "documents";

export function openDocumentStore() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DOCUMENT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENT_STORE)) {
        db.createObjectStore(DOCUMENT_STORE, { keyPath: "deckLocalId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function documentRequest(mode, run) {
  return openDocumentStore().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DOCUMENT_STORE, mode);
    const request = run(tx.objectStore(DOCUMENT_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  }));
}

export const putDocument = (entry) => documentRequest("readwrite", (store) => store.put(entry));

export const readDocument = (deckLocalId) => documentRequest("readonly", (store) => store.get(deckLocalId));

export const deleteLocalDocument = (deckLocalId) => documentRequest("readwrite", (store) => store.delete(deckLocalId));

export const allLocalDocuments = () => documentRequest("readonly", (store) => store.getAll());

// The content hash of the file, as hex. This is the identity of the PDF a
// deck's highlights were measured against — see the module comment.
export async function sha256(blob) {
  if (!crypto?.subtle) return "";
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    // A page served over plain http has no crypto.subtle. Losing the hash costs
    // the re-attach check its certainty, not the feature its function.
    console.warn("Could not hash the document", error);
    return "";
  }
}

// ── Is the copy on this device still the copy the deck means? ──────────────
//
// For a paper somebody handed us the answer is always yes, and that is the
// assumption this store was built on: a highlight is a coordinate into THIS
// file, so the bytes never change and a local copy can never go stale.
//
// A NOTEBOOK breaks it. Its pages are a PDF this app writes itself
// (src/documents/notebook.js), and it is rewritten every time a page is added,
// a page is torn out, or the paper changes — new bytes, new sha256, new upload
// path, same store key. So "there is a blob under that key" stopped being the
// same question as "there is the RIGHT blob under that key", and the difference
// is a page somebody tore out on one device sitting there for ever on another.
//
// Both hashes have to be known for a mismatch to mean anything. An entry
// written before this store recorded a hash, or a meta whose record carries
// none, is not evidence of anything and is left alone — the old behaviour, for
// the old rows it was correct for.
export function documentEntryMatches(entry, pdfMeta) {
  const wanted = String(pdfMeta?.sha256 || "");
  const held = String(entry?.sha256 || "");
  if (!wanted || !held) return true;
  return wanted === held;
}

// The bytes for a deck, wherever they are. Device first — that is both the fast
// path and the offline path — then the cloud, and a successful download is
// written straight back into the local store so the next open is free.
//
// Returns null rather than throwing when the document is simply not reachable
// (offloaded and not on this device, signed out, offline). The reader is shown
// the re-attach prompt for that case; an exception would only turn a
// recoverable state into an error banner.
export async function getDocument(deckLocalId, pdfMeta) {
  if (deckLocalId) {
    try {
      const local = await readDocument(deckLocalId);
      // ...and the copy has to be the copy this deck means. Without the second
      // half, a notebook regenerated on another device opened here at whatever
      // page count this one happened to be holding — for ever, since a local hit
      // never falls through to the download that would have corrected it.
      if (local?.blob && documentEntryMatches(local, pdfMeta)) return local.blob;
    } catch (error) {
      console.warn("Could not read the local document store", error);
    }
  }
  if (pdfMeta?.offloaded) return null;

  // Drive first, and the Storage bucket only for a record that predates it.
  // Both branches end the same way — the bytes are written into the device
  // store on the way past, so a download happens once per device rather than
  // once per open.
  const blob = (await driveDocumentBlob(pdfMeta)) || (await storageDocumentBlob(pdfMeta));
  if (!blob) return null;
  if (deckLocalId) {
    await putDocument({ deckLocalId, blob, sha256: pdfMeta.sha256 || "", name: pdfMeta.name || "", at: Date.now() })
      .catch((error) => console.warn("Could not cache the document on this device", error));
  }
  return blob;
}

// The Drive half of getDocument, including the way home when a sync has taken
// the id off the record.
//
// meta.pdfs merges by whole record, last writer wins (mergeRecordsById in
// src/sync/diff.js) — it does not merge fields. So a device that rewrites its
// copy of a PDF record while holding an older version of it carries the
// driveId away with it, and the record is left naming a file it can no longer
// find. The file itself still knows: every upload stamps the deck id, the pdf
// id and the content hash onto it as appProperties. So a missing id is looked
// up rather than mourned.
//
// The recovered id is NOT written back from here, and that is deliberate
// rather than unfinished. This runs inside a render and the deck may not be
// the open one, so a write would have to reach the whole autosave path from a
// code path whose only job is handing back bytes. The cost of not doing it is
// one extra request on each open of a record in that state — and only when
// the device has no copy, since the device is tried first. The paper opens
// either way, which is the part that matters.
async function driveDocumentBlob(pdfMeta) {
  if (!pdfMeta) return null;
  if (!isDriveConfigured()) return null;
  if (!navigator.onLine) return null;
  // A token this device has not been given yet is worth asking for once,
  // silently: the reader has a Google session more often than not, and the
  // alternative is a re-attach prompt for a paper that is sitting right there.
  if (!canReachDrive() && !(await requestDriveToken({ interactive: false }))) return null;
  let driveId = pdfMeta.driveId || "";
  if (!driveId) {
    if (!pdfMeta.sha256 && !pdfMeta.id) return null;
    driveId = await findDriveFileByProperties({
      deckId: pdfMeta.deckId || null,
      pdfId: pdfMeta.id || null,
      sha256: pdfMeta.sha256 || null
    });
    if (!driveId) return null;
  }
  return downloadDriveFile(driveId);
}

// The Storage half: read-only, and only for the records that still point at it.
// Nothing uploads here any more.
async function storageDocumentBlob(pdfMeta) {
  const path = pdfMeta?.path;
  if (!path) return null;
  if (!canSignStorageUrls()) return null;
  try {
    const url = await signedUrlFor(DOCUMENT_BUCKET, path);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
  } catch (error) {
    console.warn("Could not download the document", error);
    return null;
  }
}

// ── Upload ──────────────────────────────────────────────────────────────────

// How many times an upload is retried, and the base of the backoff. Same shape
// and the same reasoning as uploadEpubImageWithRetry (src/import/epub.js): a
// single transient refusal must not lose a whole import, and an error that
// retrying cannot fix (signed out, an RLS rejection) fails out immediately.
export const DOCUMENT_UPLOAD_ATTEMPTS = 4;

export const DOCUMENT_RETRY_BASE_MS = 800;

// PDFs are uploaded whole and un-optimised — the entire point of this feature
// is that the file the author laid out is the file you read — so a cap matters
// in a way it does not for images. 100MB is well past any paper and still far
// enough below the 1GB free tier that one file cannot eat it.
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

// Long enough for a big paper on a bad connection — 100MB at 1Mbps is thirteen
// minutes — and paired with the rule below that a TIMEOUT is never retried.
// Without that pairing this is the worst number in the file: four attempts at
// ten minutes each is forty minutes of a progress modal the reader cannot get
// past, which is indistinguishable from the app being broken.
export const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// Kept because the records written before the move to Drive were built with
// it, and storageDocumentBlob still reads them. Nothing calls it to WRITE a
// path any more.
export function documentStoragePath(userId, folder, name) {
  return `${userId}/pdfs/${folder}/${name}.pdf`;
}

// One attempt, into the reader's Drive.
//
// The thrown errors are the same vocabulary the retry loop below already spoke
// — OFFLINE and NOT_SIGNED_IN by name, `authFailed` for a refusal that trying
// again cannot fix — so uploadDocument did not have to learn a new one when the
// backend changed. NOT_SIGNED_IN now means "no Drive token", which is the same
// situation from the reader's side: the paper is on this device and nowhere
// else, and they are told exactly that.
export async function uploadDocumentOnce(file, { name, deckId, pdfId, sha256 }) {
  if (!navigator.onLine) throw new Error("OFFLINE");
  if (!isDriveConfigured()) throw new Error("NO_DRIVE");
  // Asked for up front rather than inside driveFetch, so an upload that is
  // going to fail for want of a credential fails before the bytes move.
  if (!(await requestDriveToken({ interactive: false }))) throw new Error("NOT_SIGNED_IN");
  const driveId = await withTimeout(
    uploadDriveFile(file, { name: `${name || "document"}.pdf`, deckId, pdfId, sha256 }),
    // A paper is megabytes where an image is kilobytes, so the ordinary cloud
    // timeout — tuned for a row read — would fail a perfectly healthy upload on
    // a slow connection. See UPLOAD_TIMEOUT_MS.
    Math.max(CLOUD_TIMEOUT_MS, UPLOAD_TIMEOUT_MS),
    "upload document"
  );
  if (!driveId) throw new Error("Upload failed");
  return { driveId };
}

export function documentUploadDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns a LOCATOR — `{ driveId }` — rather than a path string, because the
// record it is written into now names a file rather than an object in a
// bucket. Callers spread it into the meta entry, which is what keeps a
// pre-existing `path` on that entry untouched.
export async function uploadDocument(file, destination, progress = null) {
  for (let attempt = 1; ; attempt++) {
    // Checked before the attempt as well as after it: a reader who pressed
    // Cancel during the backoff must not then sit through another full upload.
    if (progress?.cancelled()) throw new Error("CANCELLED");
    try {
      return await uploadDocumentOnce(file, destination);
    } catch (error) {
      // A TIMEOUT is not retried. It already cost UPLOAD_TIMEOUT_MS, the
      // connection has demonstrated it cannot carry this file, and trying the
      // same thing three more times only multiplies the wait the reader is
      // sitting through. Retries exist for a transient refusal — a rate limit,
      // a dropped socket — which fail fast and often succeed on the next go.
      const timedOut = /timed out/i.test(error?.message || "");
      const worthRetrying = error?.message !== "NOT_SIGNED_IN"
        && error?.message !== "OFFLINE"
        // Drive was never set up, or the account is full. Neither is a
        // transient refusal and neither improves on the fourth go.
        && error?.message !== "NO_DRIVE"
        && !error?.quotaExceeded
        && !error?.authFailed
        && !timedOut;
      if (!worthRetrying || attempt >= DOCUMENT_UPLOAD_ATTEMPTS) throw error;
      if (progress?.cancelled()) throw error;
      await documentUploadDelay(DOCUMENT_RETRY_BASE_MS * 2 ** (attempt - 1));
      if (progress?.cancelled()) throw error;
    }
  }
}

// Best-effort removal of the cloud copy. Used by "Remove from cloud", which is
// the offload half of the finish-a-paper loop — the device copy, the
// highlights, the notes and the cards all stay exactly where they are.
//
// Takes the RECORD rather than a path, because a record can name either
// backend and only it knows which. A record carrying both — one that has been
// moved to Drive but whose Storage object has not been swept yet — has both
// removed, which is what makes the move safe to interrupt: the duplicate is
// cleaned up by whichever pass gets there second.
export async function deleteRemoteDocument(pdfMeta) {
  // A bare path is still accepted. Callers written against the old signature
  // are the reason, and an object in the bucket is still an object in the
  // bucket.
  const entry = typeof pdfMeta === "string" ? { path: pdfMeta } : (pdfMeta || {});
  let removed = false;
  if (entry.driveId) removed = (await deleteDriveFile(entry.driveId)) || removed;
  if (entry.path) removed = (await deleteStorageDocument(entry.path)) || removed;
  return removed;
}

export async function deleteStorageDocument(path) {
  if (!path || !supabaseClient || !isSignedIn) return false;
  try {
    const { error } = await withTimeout(
      supabaseClient.storage.from(DOCUMENT_BUCKET).remove([path]),
      CLOUD_TIMEOUT_MS,
      "delete document"
    );
    if (error) throw error;
    return true;
  } catch (error) {
    console.warn("Could not delete the document from storage", error);
    return false;
  }
}

// ── Accounting, for the Storage panel ───────────────────────────────────────

export const DOCUMENT_LIST_PAGE = 100;

// Every PDF object under the user's folder, walking into the per-paper
// subfolders. Same recursive shape as listStorageObjects in
// src/storage/storage-panel.js, kept here rather than shared because that one
// is hardwired to IMAGE_BUCKET and untangling it would touch every one of its
// callers for no gain.
export async function listDocumentObjects(prefix, out = []) {
  for (let offset = 0; ; offset += DOCUMENT_LIST_PAGE) {
    const { data, error } = await withTimeout(
      supabaseClient.storage.from(DOCUMENT_BUCKET).list(prefix, {
        limit: DOCUMENT_LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" }
      }),
      CLOUD_TIMEOUT_MS,
      "list documents"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      // A folder entry has no id — that is Storage's own way of saying "this is
      // a prefix, not an object".
      if (!row.id) await listDocumentObjects(path, out);
      else out.push({ path, name: row.name, size: row.metadata?.size || 0, updatedAt: row.updated_at || null });
    }
    if (rows.length < DOCUMENT_LIST_PAGE) break;
  }
  return out;
}

// { objects, count, bytes } for the signed-in user, or null when there is no
// session to ask with. Read by the Storage panel's Documents section.
export async function documentUsage() {
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return null;
  const session = await getCachedSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  const objects = await listDocumentObjects(userId);
  return {
    userId,
    objects,
    count: objects.length,
    bytes: objects.reduce((sum, object) => sum + (object.size || 0), 0)
  };
}

// How many bytes of PDF this device is holding, and for which decks. Cheap
// enough to read whole: the store has one entry per PDF deck, not per page.
export async function localDocumentUsage() {
  try {
    const entries = await allLocalDocuments();
    return entries.map((entry) => ({
      deckLocalId: entry.deckLocalId,
      name: entry.name || "",
      bytes: entry.blob?.size || 0,
      at: entry.at || 0
    }));
  } catch (error) {
    console.warn("Could not read the local document store", error);
    return [];
  }
}

// For "clear this device": the PDFs are the single largest thing the app keeps
// locally, so a wipe that left them behind would not be a wipe.
export async function clearAllLocalDocuments() {
  try {
    const entries = await allLocalDocuments();
    for (const entry of entries) await deleteLocalDocument(entry.deckLocalId);
    return entries.length;
  } catch (error) {
    console.warn("Could not clear the local document store", error);
    return 0;
  }
}
