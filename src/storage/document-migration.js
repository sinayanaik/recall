// Moving the papers that are already somewhere else into the reader's bucket.
//
// This exists because a change of backend, on its own, does nothing for the
// problem that prompted it. New papers go to the bucket from the moment
// src/documents/pdf-store.js was switched over — but the gigabyte that is
// already spent stays spent, and nothing in the app could spend it back. A
// reader would have watched the number stay exactly where it was.
//
// ── Two sources now ────────────────────────────────────────────────────────
//
// Papers have moved twice: Supabase Storage → Google Drive → an S3-compatible
// bucket. So a library can hold records naming either of the older two, and a
// reader who never ran the first migration would be stranded by a tool that
// only understood the second. Both are planned and both are moved; a job says
// which source it came from, and everything after that is identical, because
// the five steps below never cared where the bytes started.
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
// A move is: read the bytes, upload them to the bucket, write the new key into
// the deck, SAVE the deck, and only then delete the copy at the old source.
//
// Saving before deleting is what makes this safe to interrupt. Crash between
// the save and the delete and the paper exists in both places — wasteful for
// as long as it takes to run the move again, and completely harmless, because
// getDocument prefers the bucket copy and the next run finds the orphan and
// finishes the job. Do it the other way round, and a crash in the same window
// loses the file: the bytes are gone from the old source and no record anywhere
// names where they went.
//
// Every step is also idempotent. Step one finds the device copy before it asks
// the network, and step five is a no-op on an object that is already gone —
// so a half-finished move is re-run rather than repaired.

import { mapWithConcurrency } from "../cloud/net.js?v=__BUILD__";
import { headS3File, s3DocumentKey } from "../cloud/s3-files.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, documentStoreKey } from "../documents/doc-slot.js?v=__BUILD__";
import { deckPdfs, PDF_PRIMARY_ID, pdfStoreKey, withDeckPdfs } from "../documents/pdf-multi.js?v=__BUILD__";
import { deleteRemoteDocument, getDocument, putDocument, sha256, uploadDocument } from "../documents/pdf-store.js?v=__BUILD__";
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
// not what they asked for. Entries that already carry an `s3Key` are skipped
// too — apart from the ones that still name an older source as well, which are
// the half-finished moves described above and are exactly what needs finishing.
//
// A record can name a `path`, a `driveId`, or both (a library that went through
// the first migration but was interrupted). Either is a source, and `source`
// records which one is being moved so the sweep at step five knows what to
// remove — the record itself keeps every locator it had, because each one is
// the honest record of where those bytes actually were.
function migrationJobsFromSnapshot(deckLocalId, snapshot) {
  const jobs = [];
  const meta = snapshot?.meta;
  if (!meta || typeof meta !== "object") return jobs;
  const consider = (entry, slot, pdfId) => {
    if (entry?.offloaded) return;
    if (!entry?.path && !entry?.driveId) return;
    jobs.push({
      deckLocalId: String(deckLocalId),
      deckTitle: snapshot?.title || snapshot?.deckTitle || "Untitled",
      slot,
      pdfId: pdfId || null,
      name: entry.name || "document.pdf",
      bytes: Number(entry.size || 0),
      path: entry.path || "",
      driveId: entry.driveId || "",
      // Drive is the newer of the two old backends, so a record naming both is
      // read from there — it is the copy the first migration already proved.
      source: entry.driveId ? "drive" : "storage",
      sha256: entry.sha256 || "",
      // Set when the upload already happened and only the sweep is left.
      s3Key: entry.s3Key || ""
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

// Every paper in the library that is still at an older backend, biggest first
// — which is the order the question "what do I move" is actually asked in.
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
async function recordS3Key(job, s3Key, hash) {
  return rewriteDeckSnapshot(job.deckLocalId, (snapshot) => {
    const meta = snapshot?.meta;
    if (!meta || typeof meta !== "object") return null;
    if (job.slot === DOC_SLOT_NOTEBOOK) {
      if (!meta.notebook) return null;
      snapshot.meta = { ...meta, notebook: { ...meta.notebook, s3Key, sha256: hash, at: Date.now() } };
      return snapshot;
    }
    const wanted = job.pdfId || PDF_PRIMARY_ID;
    const entries = deckPdfs(meta);
    if (!entries.some((entry) => (entry.id || PDF_PRIMARY_ID) === wanted)) return null;
    snapshot.meta = withDeckPdfs(meta, entries.map((entry) => (
      (entry.id || PDF_PRIMARY_ID) === wanted ? { ...entry, s3Key, sha256: hash, at: Date.now() } : entry
    )));
    return snapshot;
  });
}

// Which locator this job is sweeping, and nothing else. Passing the whole
// record to deleteRemoteDocument would remove every copy it names — including
// the one at the source this job did NOT read from, which a second job may
// still be relying on.
function migrationSourceLocator(job) {
  return job.source === "drive" ? { driveId: job.driveId } : { path: job.path };
}

// One paper, moved. Returns { moved, bytes, reason }.
export async function migrateDocumentToS3(job) {
  const storeKey = migrationStoreKey(job);

  // Step 5 on its own, for a move that was interrupted after the deck was
  // saved. The bytes are already in the bucket; all that is left is the sweep.
  if (job.s3Key) {
    const swept = await deleteRemoteDocument(migrationSourceLocator(job));
    return swept
      ? { moved: true, bytes: job.bytes, reason: "" }
      : { moved: false, bytes: 0, reason: "could not remove the old copy" };
  }

  // 1. The bytes. getDocument tries this device first and only then the
  //    network, so a paper the reader has open costs no download at all. It is
  //    handed BOTH old locators plus the id, because it resolves them
  //    newest-first and only the record knows which one will answer.
  const blob = await getDocument(storeKey, {
    id: job.pdfId,
    path: job.path,
    driveId: job.driveId,
    sha256: job.sha256,
    name: job.name
  });
  if (!blob) return { moved: false, bytes: 0, reason: "could not read the file" };

  // A record written before this store recorded hashes has none, and the key
  // IS the hash — so without this, those papers could not be moved at all.
  // They are the OLDEST records in a library, which makes them exactly the
  // ones most likely to still be sitting in Supabase.
  //
  // Hashing here is safe in a way computing one from the record would not be:
  // it is taken from the bytes actually being uploaded, so it describes the
  // object the key names rather than asserting something about a file nobody
  // has read. It is written onto the record alongside the key at step 3, which
  // is what lets the lookup in pdf-store.js rebuild the key later if a merge
  // carries it off.
  const hash = job.sha256 || (await sha256(blob));

  // Written back to the device store on the way past. A migration that had to
  // download the file should not then throw it away — the next open would
  // fetch the very same bytes again, now from the bucket.
  await putDocument({ deckLocalId: storeKey, blob, sha256: hash, name: job.name, at: Date.now() })
    .catch((error) => console.warn("Could not cache the document on this device", error));

  // 2. Up to the bucket — unless it is already there.
  //
  // The one case this catches: an earlier run uploaded the file and then
  // failed to write the key into the deck, so the record still looks
  // unmigrated and the plan offers it again. Without this check that second
  // run uploads a second copy, and a third run a third.
  //
  // Drive needed a metadata query for this. Here the key IS the content hash
  // (s3DocumentKey), so the question is one HEAD against a key computed from
  // the job itself — and a hit is proof it is the same bytes, not merely a
  // file with the same name.
  let s3Key = s3DocumentKey({ pdfId: job.pdfId, sha256: hash });
  if (!s3Key || !(await headS3File(s3Key))) {
    try {
      const locator = await uploadDocument(blob, {
        name: storageFolderSlug(job.name.replace(/\.pdf$/i, ""), "document"),
        pdfId: job.pdfId,
        sha256: hash
      });
      s3Key = locator?.s3Key || "";
    } catch (error) {
      return { moved: false, bytes: 0, reason: error?.message || "upload failed" };
    }
  }
  if (!s3Key) return { moved: false, bytes: 0, reason: "upload failed" };

  // 3 & 4. Into the deck, and saved — BEFORE anything is deleted.
  if (!(await recordS3Key(job, s3Key, hash))) {
    // The upload succeeded and the deck could not be told. Leaving the old
    // copy exactly where it is is the only safe answer: the record still
    // points at it, so the paper still opens. The object now in the bucket is
    // not orphaned either — the next run finds it by its hash at step 2 and
    // carries on from here rather than uploading it again.
    return { moved: false, bytes: 0, reason: "could not update the deck" };
  }

  // 5. And only now.
  const swept = await deleteRemoteDocument(migrationSourceLocator(job));
  return swept
    ? { moved: true, bytes: job.bytes, reason: "" }
    : { moved: true, bytes: 0, reason: "moved, but the old copy could not be removed" };
}

// The whole library, or whatever of it the reader picked.
export async function migrateDocumentsToS3(jobs, { onProgress = null, isCancelled = () => false } = {}) {
  const summary = { moved: 0, failed: 0, bytes: 0, failures: [] };
  let done = 0;
  await mapWithConcurrency(jobs, MIGRATION_CONCURRENCY, async (job) => {
    if (isCancelled()) return;
    onProgress?.(done, jobs.length, job.name);
    const result = await migrateDocumentToS3(job);
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
