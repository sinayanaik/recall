// Moving the papers that are already in Supabase Storage into Drive.
//
// This exists because the change of backend, on its own, does nothing for the
// problem that prompted it. New papers go to Drive from the moment
// src/documents/pdf-store.js was switched over — but the gigabyte that is
// already spent stays spent, and nothing in the app could spend it back. A
// reader would have watched the number stay exactly where it was.
//
// Deliberately MANUAL, and deliberately per-paper. An automatic sweep was the
// obvious design and the wrong one: it would delete things out of a bucket
// while nobody was looking, on a schedule nobody chose, and the first time it
// got something wrong it would have got it wrong in bulk. This runs when a
// reader presses a button, on files they can see and sort, and it says what it
// is going to free before it frees it.
//
// ── The order of the five steps is the whole design ────────────────────────
//
// A move is: read the bytes, upload them to Drive, write the new id into the
// deck, SAVE the deck, and only then delete the object from Storage.
//
// Saving before deleting is what makes this safe to interrupt. Crash between
// the save and the delete and the paper exists in both places — wasteful for
// as long as it takes to run the move again, and completely harmless, because
// getDocument prefers the Drive copy and the next run finds the orphan and
// finishes the job. Do it the other way round, and a crash in the same window
// loses the file: the bytes are gone from Storage and no record anywhere names
// where they went.
//
// Every step is also idempotent. Step one finds the device copy before it asks
// the network, and step five is a no-op on an object that is already gone —
// so a half-finished move is re-run rather than repaired.

import { mapWithConcurrency } from "../cloud/net.js?v=__BUILD__";
import { findDriveFileByProperties } from "../cloud/drive-files.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, documentStoreKey } from "../documents/doc-slot.js?v=__BUILD__";
import { deckPdfs, PDF_PRIMARY_ID, pdfStoreKey, withDeckPdfs } from "../documents/pdf-multi.js?v=__BUILD__";
import { deleteStorageDocument, getDocument, putDocument, uploadDocument } from "../documents/pdf-store.js?v=__BUILD__";
import { storageFolderSlug } from "../images/upload.js?v=__BUILD__";
import { forEachDeckSnapshot, rewriteDeckSnapshot } from "./deck-store.js?v=__BUILD__";

// One at a time. A paper is tens of megabytes and is fully resident while it
// is being read, uploaded and hashed; running five of those at once is not
// five times faster, it is five times the peak memory, on the device least
// able to spare it. packBackupDocuments went sequential for the same reason
// and said so.
export const MIGRATION_CONCURRENCY = 1;

// A paper that still lives in the bucket and has nowhere else to be.
//
// `offloaded` entries are skipped: the reader has already said they do not
// want that file in the cloud, and quietly putting it in a different cloud is
// not what they asked for. Entries that already carry a driveId are skipped
// too — apart from the ones that still carry a `path` as well, which are the
// half-finished moves described above and are exactly what needs finishing.
function migrationJobsFromSnapshot(deckLocalId, snapshot) {
  const jobs = [];
  const meta = snapshot?.meta;
  if (!meta || typeof meta !== "object") return jobs;
  const consider = (entry, slot, pdfId) => {
    if (!entry?.path || entry.offloaded) return;
    jobs.push({
      deckLocalId: String(deckLocalId),
      deckTitle: snapshot?.title || snapshot?.deckTitle || "Untitled",
      slot,
      pdfId: pdfId || null,
      name: entry.name || "document.pdf",
      bytes: Number(entry.size || 0),
      path: entry.path,
      sha256: entry.sha256 || "",
      // Set when the upload already happened and only the sweep is left.
      driveId: entry.driveId || ""
    });
  };
  deckPdfs(meta).forEach((entry) => consider(entry, DOC_SLOT_DOC, entry.id || PDF_PRIMARY_ID));
  consider(meta.notebook, DOC_SLOT_NOTEBOOK, DOC_SLOT_NOTEBOOK);
  return jobs;
}

// Which device-store key holds this job's bytes. The notebook lives in a slot
// of its own and a second paper under its pdf id, so the two helpers are not
// interchangeable — see src/documents/doc-slot.js.
export function migrationStoreKey(job) {
  if (job.slot === DOC_SLOT_NOTEBOOK) return documentStoreKey(job.deckLocalId, DOC_SLOT_NOTEBOOK);
  return pdfStoreKey(job.deckLocalId, job.pdfId || PDF_PRIMARY_ID);
}

// Every paper in the library that is still in the bucket, biggest first —
// which is the order the question "what do I move" is actually asked in.
export async function planDocumentMigration() {
  const jobs = [];
  await forEachDeckSnapshot((id, snapshot) => {
    migrationJobsFromSnapshot(id, snapshot).forEach((job) => jobs.push(job));
  });
  return jobs.sort((a, b) => b.bytes - a.bytes);
}

// Writes the new locator onto the one entry this job names, under the deck's
// own lock and against a FRESH read of the snapshot.
//
// The lock matters more than it looks. forEachDeckSnapshot reads the object
// store directly, so the copy the plan was built from may already be stale by
// the time the upload finishes — a long upload is a long time for the reader
// to have carried on working. rewriteDeckSnapshot re-reads inside the lock,
// so what gets written back is the current deck with one field changed, not
// the plan's copy of it.
async function recordDriveId(job, driveId) {
  return rewriteDeckSnapshot(job.deckLocalId, (snapshot) => {
    const meta = snapshot?.meta;
    if (!meta || typeof meta !== "object") return null;
    if (job.slot === DOC_SLOT_NOTEBOOK) {
      if (!meta.notebook) return null;
      snapshot.meta = { ...meta, notebook: { ...meta.notebook, driveId, at: Date.now() } };
      return snapshot;
    }
    const wanted = job.pdfId || PDF_PRIMARY_ID;
    const entries = deckPdfs(meta);
    if (!entries.some((entry) => (entry.id || PDF_PRIMARY_ID) === wanted)) return null;
    snapshot.meta = withDeckPdfs(meta, entries.map((entry) => (
      (entry.id || PDF_PRIMARY_ID) === wanted ? { ...entry, driveId, at: Date.now() } : entry
    )));
    return snapshot;
  });
}

// One paper, moved. Returns { moved, bytes, reason }.
export async function migrateDocumentToDrive(job) {
  const storeKey = migrationStoreKey(job);

  // Step 5 on its own, for a move that was interrupted after the deck was
  // saved. The bytes are already in Drive; all that is left is the sweep.
  if (job.driveId) {
    const swept = await deleteStorageDocument(job.path);
    return swept
      ? { moved: true, bytes: job.bytes, reason: "" }
      : { moved: false, bytes: 0, reason: "could not remove the old copy" };
  }

  // 1. The bytes. getDocument tries this device first and only then the
  //    bucket, so a paper the reader has open costs no download at all.
  const blob = await getDocument(storeKey, { path: job.path, sha256: job.sha256, name: job.name });
  if (!blob) return { moved: false, bytes: 0, reason: "could not read the file" };

  // Written back to the device store on the way past. A migration that had to
  // download the file should not then throw it away — the next open would
  // fetch the very same bytes again, now from Drive.
  await putDocument({ deckLocalId: storeKey, blob, sha256: job.sha256, name: job.name, at: Date.now() })
    .catch((error) => console.warn("Could not cache the document on this device", error));

  // 2. Up to Drive — unless it is already there.
  //
  // The one case this catches: an earlier run uploaded the file and then
  // failed to write the id into the deck, so the record still looks
  // unmigrated and the plan offers it again. Without this check that second
  // run uploads a second copy, and a third run a third. The hash names the
  // exact bytes, so finding one is proof it is the same file.
  let driveId = await findDriveFileByProperties({ pdfId: job.pdfId, sha256: job.sha256 });
  if (!driveId) {
    try {
      const locator = await uploadDocument(blob, {
        name: storageFolderSlug(job.name.replace(/\.pdf$/i, ""), "document"),
        pdfId: job.pdfId,
        sha256: job.sha256
      });
      driveId = locator?.driveId || "";
    } catch (error) {
      return { moved: false, bytes: 0, reason: error?.message || "upload failed" };
    }
  }
  if (!driveId) return { moved: false, bytes: 0, reason: "upload failed" };

  // 3 & 4. Into the deck, and saved — BEFORE anything is deleted.
  if (!(await recordDriveId(job, driveId))) {
    // The upload succeeded and the deck could not be told. Leaving the bucket
    // copy exactly where it is is the only safe answer: the record still
    // points at it, so the paper still opens. The file now in Drive is not
    // orphaned either — the next run finds it by its hash at step 2 and
    // carries on from here rather than uploading it again.
    return { moved: false, bytes: 0, reason: "could not update the deck" };
  }

  // 5. And only now.
  const swept = await deleteStorageDocument(job.path);
  return swept
    ? { moved: true, bytes: job.bytes, reason: "" }
    : { moved: true, bytes: 0, reason: "moved, but the old copy could not be removed" };
}

// The whole library, or whatever of it the reader picked.
export async function migrateDocumentsToDrive(jobs, { onProgress = null, isCancelled = () => false } = {}) {
  const summary = { moved: 0, failed: 0, bytes: 0, failures: [] };
  let done = 0;
  await mapWithConcurrency(jobs, MIGRATION_CONCURRENCY, async (job) => {
    if (isCancelled()) return;
    onProgress?.(done, jobs.length, job.name);
    const result = await migrateDocumentToDrive(job);
    done += 1;
    if (result.moved) {
      summary.moved += 1;
      summary.bytes += result.bytes;
    } else {
      summary.failed += 1;
      summary.failures.push({ name: job.name, reason: result.reason });
    }
    onProgress?.(done, jobs.length, job.name);
  });
  return summary;
}
