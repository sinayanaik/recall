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
//     the file. That copy now lives in an S3-compatible bucket the reader
//     supplies — see src/cloud/s3-config.js for why it moved off Google Drive,
//     which in turn had moved off a private `documents` bucket in the reader's
//     Supabase project when PDFs filled the free tier's 1GB.
//
//     ALL THREE are read, and that is the whole design of getDocument below.
//     Nothing already uploaded was rewritten or moved by either change: a
//     record written before Drive still carries its Storage `path`, a record
//     written during Drive still carries its `driveId`, and both still open
//     from where they are. Neither field is ever cleared, for the same reason
//     offloadCurrentDocument does not clear one — it is the record of where
//     those bytes actually are. New uploads carry an `s3Key`, which getDocument
//     prefers. The Storage panel is where a reader moves the older ones across
//     and gets the space back.
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
import { deleteDriveFile, downloadDriveFile, findDriveFileByProperties } from "../cloud/drive-files.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { canReachS3, isS3Configured } from "../cloud/s3-config.js?v=__BUILD__";
import { ensureS3ConfigFromCloud } from "../cloud/s3-config-sync.js?v=__BUILD__";
import { deleteS3File, downloadS3File, s3DocumentKey, uploadS3File } from "../cloud/s3-files.js?v=__BUILD__";
import { canSignStorageUrls, signedUrlFor } from "../cloud/storage-urls.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK } from "./doc-slot.js?v=__BUILD__";
import { PDF_PRIMARY_ID } from "./pdf-multi.js?v=__BUILD__";

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

  // The bucket first, then Drive, then Supabase Storage — newest backend to
  // oldest, which is also most-likely-to-answer to least. Each branch returns
  // null rather than throwing when its backend is not configured, so a record
  // naming only one of them costs nothing for the other two.
  //
  // All three branches end the same way: the bytes are written into the device
  // store on the way past, so a download happens once per device rather than
  // once per open. That write-back is also what makes the migration cheap — a
  // paper the reader has opened since the change is already local when the move
  // comes to read it.
  const blob = (await s3DocumentBlob(pdfMeta))
    || (await driveDocumentBlob(pdfMeta))
    || (await storageDocumentBlob(pdfMeta));
  if (!blob) return null;
  if (deckLocalId) {
    await putDocument({ deckLocalId, blob, sha256: pdfMeta.sha256 || "", name: pdfMeta.name || "", at: Date.now() })
      .catch((error) => console.warn("Could not cache the document on this device", error));
  }
  return blob;
}

// The bucket half of getDocument, and the way home when a sync has taken the
// key off the record.
//
// meta.pdfs merges by whole record, last writer wins (mergeRecordsById in
// src/sync/diff.js) — it does not merge fields. So a device that rewrites its
// copy of a PDF record while holding an older version of it carries the s3Key
// away with it, and the record is left naming nothing.
//
// Drive answered this with a metadata search. Here there is nothing to search:
// the key is `recall/<pdfId>/<sha256>.pdf` and both halves are ON the record
// already, so a missing key is simply recomputed. That is the practical payoff
// of content-addressing — the lookup that cost Drive a query and an index costs
// this one string concatenation, and it cannot go stale.
//
// Two things about WHICH key, both of which were wrong:
//
//   • A record with no `id` is not "unfiled". The deck's first paper is written
//     as a bare meta.pdf with no id, and the notebook never has one; they were
//     uploaded under "primary" and "notebook" respectively, so that is what the
//     rebuild has to say too — or a notebook whose key a merge carried off was
//     looked for at recall/unfiled/…, where nothing has ever been put.
//   • A stored s3Key that names DIFFERENT bytes from the record's hash is not
//     believed. A notebook rewritten while its upload could not get through
//     kept the previous pages' key, and following it downloaded the old pages
//     and cached them on the device labelled with the NEW hash — which then
//     passed every check that exists to catch exactly that.
//
// And one thing about WHETHER: a device that has not been given the bucket
// keys yet asks the account for them once before giving up. That is the first
// open on a new phone, before its first sync has run.
export function documentS3Key(pdfMeta) {
  if (!pdfMeta) return "";
  const hash = String(pdfMeta.sha256 || "");
  const pdfId = pdfMeta.id || (pdfMeta.notebook ? DOC_SLOT_NOTEBOOK : PDF_PRIMARY_ID);
  const derived = hash ? s3DocumentKey({ pdfId, sha256: hash }) : "";
  const stored = String(pdfMeta.s3Key || "");
  if (stored && (!hash || stored.endsWith(`/${hash}.pdf`))) return stored;
  return derived;
}

async function s3DocumentBlob(pdfMeta) {
  if (!pdfMeta) return null;
  if (!navigator.onLine) return null;
  const key = documentS3Key(pdfMeta);
  if (!key) return null;
  if (!canReachS3() && !(await ensureS3ConfigFromCloud())) return null;
  if (!canReachS3()) return null;
  return downloadS3File(key);
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
// Read-only, exactly as storageDocumentBlob below is: nothing uploads to Drive
// any more. It stays because a paper that is in Drive and not on THIS device
// has nowhere else to come from until the reader runs the migration — and on a
// second device, they have not run it yet.
async function driveDocumentBlob(pdfMeta) {
  if (!pdfMeta) return null;
  if (!pdfMeta.driveId && !pdfMeta.sha256 && !pdfMeta.id) return null;
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

// One attempt, into the reader's bucket.
//
// The thrown errors are the same vocabulary the retry loop below already spoke
// — OFFLINE by name, `authFailed` for a refusal that trying again cannot fix —
// so uploadDocument did not have to learn a new one when the backend changed
// for the second time. NO_STORAGE replaces NO_DRIVE and means the same thing
// from the reader's side: nothing is set up, so the paper is on this device and
// nowhere else, and they are told exactly that.
//
// There is no NOT_SIGNED_IN any more. Nothing here has a session to be signed
// out of — that condition simply stopped existing, which was the point.
export async function uploadDocumentOnce(file, { name, deckId, pdfId, sha256 }) {
  if (!navigator.onLine) throw new Error("OFFLINE");
  // Checked up front rather than inside s3Fetch, so an upload that is going to
  // fail for want of a credential fails before the bytes move.
  if (!canReachS3()) throw new Error("NO_STORAGE");
  const s3Key = await withTimeout(
    uploadS3File(file, { pdfId, sha256 }),
    // A paper is megabytes where an image is kilobytes, so the ordinary cloud
    // timeout — tuned for a row read — would fail a perfectly healthy upload on
    // a slow connection. See UPLOAD_TIMEOUT_MS.
    Math.max(CLOUD_TIMEOUT_MS, UPLOAD_TIMEOUT_MS),
    "upload document"
  );
  if (!s3Key) throw new Error("Upload failed");
  return { s3Key };
}

export function documentUploadDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns a LOCATOR — `{ s3Key }` — rather than a path string. Callers spread
// it into the meta entry, which is what keeps a pre-existing `path` or
// `driveId` on that entry untouched: a record can name all three at once while
// a migration is half done, and getDocument reads them newest-first.
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
        // The bucket was never set up, or it is full, or the CORS policy does
        // not admit this site. None is a transient refusal and none improves on
        // the fourth go. NO_DRIVE is kept in the list because a record written
        // before the move can still reach the Drive path through the migration.
        && error?.message !== "NO_STORAGE"
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
// Takes the RECORD rather than a path, because a record can name any of three
// backends and only it knows which. A record carrying more than one — moved to
// the bucket but not yet swept from Drive, say — has every copy removed, which
// is what makes a move safe to interrupt: the duplicate is cleaned up by
// whichever pass gets there second.
export async function deleteRemoteDocument(pdfMeta) {
  // A bare path is still accepted. Callers written against the old signature
  // are the reason, and an object in the bucket is still an object in the
  // bucket.
  const entry = typeof pdfMeta === "string" ? { path: pdfMeta } : (pdfMeta || {});
  let removed = false;
  if (entry.s3Key) removed = (await deleteS3File(entry.s3Key)) || removed;
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

// The size of one object in the old `documents` bucket: a number when the
// bucket says, null when it says the object is not there, and undefined when
// nobody could ask (signed out, offline, a refusal). The move into the reader's
// bucket asks this before it deletes a paper's Supabase copy, so that a copy
// that is not the same file as the one now in the bucket — possible only for a
// record that was never hashed — is kept rather than deleted.
export async function storedDocumentSize(path) {
  if (!path || !supabaseClient || !isSignedIn || !navigator.onLine) return undefined;
  const cut = path.lastIndexOf("/");
  const dir = cut === -1 ? "" : path.slice(0, cut);
  const name = cut === -1 ? path : path.slice(cut + 1);
  try {
    const { data, error } = await withTimeout(
      supabaseClient.storage.from(DOCUMENT_BUCKET).list(dir, { limit: 100, search: name }),
      CLOUD_TIMEOUT_MS,
      "check document"
    );
    if (error) throw error;
    const row = (data || []).find((entry) => entry.name === name && entry.id);
    if (!row) return null;
    const size = Number(row.metadata?.size);
    return Number.isFinite(size) ? size : undefined;
  } catch (error) {
    console.warn("Could not check the document in storage", error);
    return undefined;
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
