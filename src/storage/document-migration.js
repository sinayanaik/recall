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
import { canReachS3 } from "../cloud/s3-config.js?v=__BUILD__";
import { headS3File, s3DocumentKey } from "../cloud/s3-files.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, documentStoreKey } from "../documents/doc-slot.js?v=__BUILD__";
import { deckPdfs, PDF_PRIMARY_ID, pdfStoreKey, withDeckPdfs } from "../documents/pdf-multi.js?v=__BUILD__";
import { deleteRemoteDocument, documentEntryMatches, documentS3Key, getDocument, putDocument, readDocument, sha256, uploadDocument } from "../documents/pdf-store.js?v=__BUILD__";
import { storageFolderSlug } from "../images/upload.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { nextSyncStamp } from "../sync/stats.js?v=__BUILD__";
import { forEachDeckSnapshot, rewriteDeckSnapshot } from "./deck-store.js?v=__BUILD__";
import { NOTES_CONFLICT_SUFFIX } from "./keys.js?v=__BUILD__";

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

// The record a job names, on whichever shelf it lives.
function entryForJob(meta, job) {
  if (!meta || typeof meta !== "object") return null;
  if (job.slot === DOC_SLOT_NOTEBOOK) return meta.notebook || null;
  const wanted = job.pdfId || PDF_PRIMARY_ID;
  return deckPdfs(meta).find((entry) => (entry.id || PDF_PRIMARY_ID) === wanted) || null;
}

// The meta with this job's entry pointing at `s3Key`, or null when there is
// nothing to write: the entry is gone, it already says exactly this, or it now
// names DIFFERENT bytes. The last one is a notebook rewritten while its old
// pages were uploading — tagging the new record with the old pages' key would
// hand every other device the page count this one just replaced.
function metaWithS3Key(meta, job, s3Key, hash) {
  if (!meta || typeof meta !== "object") return null;
  const stamped = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    if (entry.sha256 && entry.sha256 !== hash) return null;
    if (entry.s3Key === s3Key && entry.sha256 === hash) return null;
    return { ...entry, s3Key, sha256: hash, at: Date.now() };
  };
  if (job.slot === DOC_SLOT_NOTEBOOK) {
    const notebook = stamped(meta.notebook);
    return notebook ? { ...meta, notebook } : null;
  }
  const wanted = job.pdfId || PDF_PRIMARY_ID;
  const next = stamped(entryForJob(meta, job));
  if (!next) return null;
  return withDeckPdfs(meta, deckPdfs(meta).map((entry) => ((entry.id || PDF_PRIMARY_ID) === wanted ? next : entry)));
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
//
// Two more things, both of which this used to skip, and both of which meant the
// key it wrote never left the device:
//
//   • the deck's updatedAt is BUMPED, the same way the image outbox bumps a deck
//     it rewrote. The push gate reads updatedAt and nothing else, so a snapshot
//     that changed without it is a snapshot the cloud never hears about.
//   • the OPEN deck is patched in memory too. Its next autosave rebuilds the
//     snapshot from `state`, so a key written only to the store was reverted
//     400ms after the reader's next keystroke.
async function recordS3Key(job, s3Key, hash) {
  let alreadyRecorded = false;
  const wrote = await rewriteDeckSnapshot(job.deckLocalId, (snapshot) => {
    const next = metaWithS3Key(snapshot?.meta, job, s3Key, hash);
    if (!next) {
      // Nothing to write is a success when the entry already names this very
      // object — another pass (the backfill, or an earlier run of this one) got
      // there first — and a refusal otherwise.
      alreadyRecorded = entryForJob(snapshot?.meta, job)?.s3Key === s3Key;
      return null;
    }
    snapshot.meta = next;
    return snapshot;
  });
  if (!wrote) return alreadyRecorded;
  if (state.localDeckId && String(state.localDeckId) === String(job.deckLocalId)) {
    const live = metaWithS3Key(state.meta, job, s3Key, hash);
    if (live) state.meta = live;
  }
  try {
    const index = readLocalDeckIndex();
    const entry = index.find((row) => String(row.id) === String(job.deckLocalId));
    if (entry) {
      entry.updatedAt = nextSyncStamp(new Date().toISOString(), entry.updatedAt);
      writeLocalDeckIndex(index);
    }
  } catch (error) {
    // The key is on the snapshot either way; what is lost is only the prompt to
    // push it, and the next edit to this deck supplies that.
    console.warn("Could not mark the deck for sync after recording its bucket key", error);
  }
  return true;
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

// ── Papers that never went up ───────────────────────────────────────────────
//
// The migration above moves papers that are in an OLDER cloud. This is for the
// ones that are in no cloud at all: imported before the bucket was set up,
// imported offline, or imported while the upload could not get through (a CORS
// policy missing PUT was the common one). Each of those was told "Sync once
// you're back to read it elsewhere" — and nothing, at any sync, ever uploaded
// it. The paper stayed on the device that imported it for good, and every
// other device showed the re-attach prompt for a file that was sitting in
// somebody's other hand.
//
// Unlike the migration this runs by itself, on every sync, and that is safe for
// the one reason the migration is not: it deletes NOTHING. It reads the device
// copy, puts it in the bucket if the bucket does not already have it, and
// records the key. The worst an interrupted run can leave is an object nobody
// has recorded yet — which the next run finds with a HEAD and records rather
// than uploading again.
//
// Only the device that HOLDS the bytes can do this, so a job whose bytes are
// not here is skipped without a request; some other device owns it. That is
// also what keeps this cheap on the devices that have nothing to do: a paper
// already recorded is never planned, and one that is not here costs one
// IndexedDB read.

// How long a paper that failed to go up is left alone before it is tried
// again. Short enough that a dropped connection costs one sync interval, long
// enough that a paper the connection genuinely cannot carry does not restart a
// fifteen-minute upload every time the app syncs.
export const DOCUMENT_BACKFILL_RETRY_MS = 10 * 60 * 1000;

const documentBackfillFailedAt = new Map();

let documentBackfillRun = null;

let documentBackfillSummary = null;

const documentBackfillListeners = new Set();

// The last run, for the Storage panel. Null until one has finished.
export function documentBackfillStatus() {
  return {
    running: Boolean(documentBackfillRun),
    last: documentBackfillSummary ? { ...documentBackfillSummary } : null
  };
}

// Told when a run finishes, with its summary — the panel redraws its count.
export function onDocumentBackfillDone(listener) {
  if (typeof listener !== "function") return () => {};
  documentBackfillListeners.add(listener);
  return () => documentBackfillListeners.delete(listener);
}

function backfillJobsFromSnapshot(deckLocalId, snapshot) {
  const jobs = [];
  const meta = snapshot?.meta;
  if (!meta || typeof meta !== "object") return jobs;
  const consider = (entry, slot, pdfId) => {
    if (!entry || typeof entry !== "object") return;
    // The reader removed it from the cloud on purpose. Putting it back behind
    // their back is not what "Remove from cloud" means.
    if (entry.offloaded) return;
    const hash = String(entry.sha256 || "");
    // Already recorded under the key its bytes would get — nothing owed. A
    // record naming a DIFFERENT key (a notebook rewritten since, say) is owed
    // the new one.
    if (hash && entry.s3Key && entry.s3Key === s3DocumentKey({ pdfId, sha256: hash })) return;
    jobs.push({
      deckLocalId: String(deckLocalId),
      deckTitle: snapshot?.title || snapshot?.deckTitle || "Untitled",
      slot,
      pdfId,
      name: entry.name || "document.pdf",
      bytes: Number(entry.size || 0),
      // May be empty for a record from before hashing: the run hashes the
      // device copy, and records the hash beside the key.
      sha256: hash,
      // Still readable from Drive or the old Supabase bucket, so not "only on
      // one device" — the panel counts those under the migration instead.
      legacy: Boolean(entry.path || entry.driveId)
    });
  };
  deckPdfs(meta).forEach((entry) => consider(entry, DOC_SLOT_DOC, entry.id || PDF_PRIMARY_ID));
  consider(meta.notebook, DOC_SLOT_NOTEBOOK, DOC_SLOT_NOTEBOOK);
  return jobs;
}

// Every paper in the library that has no key in the bucket yet, smallest
// first: several papers across beat one large one half-way.
export async function planDocumentBackfill() {
  const jobs = [];
  await forEachDeckSnapshot((id, snapshot) => {
    // A notes-conflict stash is a second copy of a real deck's snapshot, meta
    // and all. Its bytes are filed under the real deck, so as a job of its own
    // it could only ever be "not on this device" — a paper counted twice, the
    // second time as missing.
    if (String(id).includes(NOTES_CONFLICT_SUFFIX)) return;
    backfillJobsFromSnapshot(id, snapshot).forEach((job) => jobs.push(job));
  });
  return jobs.sort((a, b) => a.bytes - b.bytes);
}

// The bytes this device holds for a job, or null when they are not here or are
// not the bytes the record means.
async function backfillLocalCopy(job) {
  try {
    const local = await readDocument(migrationStoreKey(job));
    if (!local?.blob) return null;
    if (!documentEntryMatches(local, { sha256: job.sha256 })) return null;
    return local;
  } catch (error) {
    console.warn("Could not read the local document store", error);
    return null;
  }
}

// How many of the planned papers this device could upload, and how many are
// waiting on a device that holds them. For the panel — a sentence saying "3
// papers are only on this device" is the difference between a reader knowing
// why their phone is empty and guessing.
//
// A planned paper is one whose RECORD names no key, which is not the same as
// one the bucket lacks: the device that has it may have uploaded it with the
// key not yet recorded on this device's copy of the deck. So when the bucket
// can be asked, it is, and a paper already there is not counted at all. When
// it cannot be asked (no keys here yet, offline), a paper this device does not
// hold is `unknown` rather than called missing — a phone waiting on its keys
// must not be told its whole library is lost.
export const BACKFILL_COUNT_HEAD_LIMIT = 50;

export async function countBackfillOnDevice(jobs) {
  let here = 0;
  let elsewhere = 0;
  let unknown = 0;
  let asked = 0;
  const canAsk = canReachS3() && navigator.onLine;
  for (const job of jobs || []) {
    const local = await backfillLocalCopy(job);
    const hash = job.sha256 || local?.sha256 || "";
    const key = hash ? s3DocumentKey({ pdfId: job.pdfId, sha256: hash }) : "";
    if (canAsk && key && asked < BACKFILL_COUNT_HEAD_LIMIT) {
      asked += 1;
      if (await headS3File(key)) continue;
      if (local) here += 1;
      else elsewhere += 1;
      continue;
    }
    if (local) here += 1;
    else unknown += 1;
  }
  return { here, elsewhere, unknown };
}

// A failure that says nothing about the next paper stops only this one; one
// that will fail every paper the same way stops the run.
function backfillStopsRun(error) {
  const message = error?.message || "";
  return message === "NO_STORAGE" || message === "OFFLINE"
    || Boolean(error?.authFailed || error?.corsLikely || error?.quotaExceeded);
}

// One paper. Returns { status: "uploaded" | "recorded" | "skipped" | "failed",
// reason, stopsRun }.
export async function backfillDocumentToS3(job) {
  const local = await backfillLocalCopy(job);
  if (!local) return { status: "skipped", reason: "not on this device" };
  const hash = job.sha256 || local.sha256 || (await sha256(local.blob));
  if (!hash) return { status: "skipped", reason: "could not hash the file" };
  const key = s3DocumentKey({ pdfId: job.pdfId, sha256: hash });
  if (!key) return { status: "skipped", reason: "no key" };
  const failedAt = documentBackfillFailedAt.get(key) || 0;
  if (failedAt && Date.now() - failedAt < DOCUMENT_BACKFILL_RETRY_MS) {
    return { status: "skipped", reason: "waiting to retry" };
  }

  // Already there — uploaded by another device that holds the same paper, or
  // by an earlier run that could not record it. A HEAD, not a second copy.
  let uploaded = false;
  if (!(await headS3File(key))) {
    try {
      await uploadDocument(local.blob, {
        name: storageFolderSlug(String(job.name).replace(/\.pdf$/i, ""), job.slot === DOC_SLOT_NOTEBOOK ? "notebook" : "document"),
        pdfId: job.pdfId,
        sha256: hash
      });
      uploaded = true;
    } catch (error) {
      documentBackfillFailedAt.set(key, Date.now());
      return { status: "failed", reason: error?.message || "upload failed", stopsRun: backfillStopsRun(error) };
    }
  }
  documentBackfillFailedAt.delete(key);
  const recorded = await recordS3Key(job, key, hash);
  // An object in the bucket whose deck could not be told is still reachable:
  // other devices derive the key from the id and hash they already hold.
  return { status: uploaded ? "uploaded" : "recorded", reason: recorded ? "" : "could not update the deck" };
}

export async function backfillDocumentsToS3(jobs, { onProgress = null, isCancelled = () => false } = {}) {
  const summary = { at: 0, planned: jobs.length, uploaded: 0, recorded: 0, skipped: 0, failed: 0, stopped: "", failures: [] };
  let done = 0;
  for (const job of jobs) {
    if (isCancelled()) break;
    if (!canReachS3()) { summary.stopped = "NO_STORAGE"; break; }
    if (!navigator.onLine) { summary.stopped = "OFFLINE"; break; }
    onProgress?.(done, jobs.length, job.name);
    const result = await backfillDocumentToS3(job);
    done += 1;
    if (result.status === "uploaded") summary.uploaded += 1;
    else if (result.status === "recorded") summary.recorded += 1;
    else if (result.status === "skipped") summary.skipped += 1;
    else {
      summary.failed += 1;
      summary.failures.push({ name: job.name, reason: result.reason });
      if (result.stopsRun) { summary.stopped = result.reason; break; }
    }
  }
  summary.at = Date.now();
  return summary;
}

// How often the SYNC may start a run. Planning one reads every deck snapshot
// on the device, which is cheap once and not cheap on every background sync of
// a large library — and a paper that did not need uploading five minutes ago
// almost never needs it now. The moments that DO change the answer (keys
// saved or arriving, the panel's button) pass `force` and skip the wait.
export const DOCUMENT_BACKFILL_MIN_INTERVAL_MS = 10 * 60 * 1000;

let documentBackfillStartedAt = 0;

// Start a run unless one is going, or the bucket cannot be reached from here.
// Resolves with the summary (or null when nothing ran). Callers that are not
// waiting for it — the sync, the panel's save — simply drop the promise; it
// never rejects.
export function scheduleDocumentBackfill({ force = false } = {}) {
  if (documentBackfillRun) return documentBackfillRun;
  if (!canReachS3() || (typeof navigator !== "undefined" && navigator.onLine === false)) return Promise.resolve(null);
  if (!force && Date.now() - documentBackfillStartedAt < DOCUMENT_BACKFILL_MIN_INTERVAL_MS) return Promise.resolve(null);
  documentBackfillStartedAt = Date.now();
  documentBackfillRun = (async () => {
    try {
      const jobs = await planDocumentBackfill();
      const summary = jobs.length
        ? await backfillDocumentsToS3(jobs)
        : { at: Date.now(), planned: 0, uploaded: 0, recorded: 0, skipped: 0, failed: 0, stopped: "", failures: [] };
      documentBackfillSummary = summary;
      return summary;
    } catch (error) {
      console.warn("Could not upload the papers waiting on this device", error);
      return null;
    } finally {
      documentBackfillRun = null;
    }
  })();
  documentBackfillRun.then((summary) => {
    if (!summary) return;
    for (const listener of documentBackfillListeners) {
      try { listener(summary); } catch (error) { console.warn("A backfill listener failed", error); }
    }
  });
  return documentBackfillRun;
}

// ── One file, two decks ─────────────────────────────────────────────────────
//
// The key is recall/<pdfId>/<sha256>.pdf, and a deck's first paper is always
// pdfId "primary" — so two decks holding the same paper (imported twice, or a
// copy of a deck) name ONE object. "Remove from cloud" on either used to delete
// it out from under the other, which then showed the re-attach prompt on every
// device without a copy. Whether any other record still names the object is a
// question the library on this device can answer, so it is asked first.

// Does any record OTHER than the one named still point at this object?
// Offloaded records do not count: they have already let go of it.
export async function s3KeyInUseElsewhere(key, { deckLocalId = "", slot = DOC_SLOT_DOC, pdfId = PDF_PRIMARY_ID } = {}) {
  if (!key) return false;
  let used = false;
  await forEachDeckSnapshot((id, snapshot) => {
    if (String(id).includes(NOTES_CONFLICT_SUFFIX)) return;
    const meta = snapshot?.meta;
    if (!meta || typeof meta !== "object") return;
    const check = (entry, entrySlot, entryPdfId) => {
      if (used || !entry || typeof entry !== "object" || entry.offloaded) return;
      if (String(id) === String(deckLocalId) && entrySlot === slot && entryPdfId === pdfId) return;
      if (documentS3Key({ ...entry, id: entryPdfId }) === key) used = true;
    };
    deckPdfs(meta).forEach((entry) => check(entry, DOC_SLOT_DOC, entry.id || PDF_PRIMARY_ID));
    check(meta.notebook, DOC_SLOT_NOTEBOOK, DOC_SLOT_NOTEBOOK);
    return used ? false : undefined;
  });
  return used;
}

// deleteRemoteDocument, minus an S3 object another deck still needs. Resolves
// { removed, shared }: `removed` is true when this record no longer holds any
// cloud copy of its own — including when the object was KEPT because another
// deck shares it, since from this deck's side that is exactly what was asked.
export async function deleteDocumentCopies(entry, { deckLocalId = "", slot = DOC_SLOT_DOC, pdfId = PDF_PRIMARY_ID } = {}) {
  const record = entry && typeof entry === "object" ? entry : {};
  const key = String(record.s3Key || "");
  const shared = key ? await s3KeyInUseElsewhere(key, { deckLocalId, slot, pdfId }) : false;
  const removed = await deleteRemoteDocument(shared ? { ...record, s3Key: "" } : record);
  return { removed: removed || shared, shared };
}
