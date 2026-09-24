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
// only understood the second. Both are planned and both are moved.
//
// Deliberately MANUAL. An automatic sweep was the obvious design and the wrong
// one: it would delete things out of a bucket while nobody was looking, on a
// schedule nobody chose, and the first time it got something wrong it would
// have got it wrong in bulk. This runs when a reader presses a button, and says
// what it did with every paper.
//
// ── Why "Papers still elsewhere" never emptied ─────────────────────────────
//
// The first version of this file moved papers perfectly well and could not
// tell that it had. The old locator (`path`, `driveId`) is never cleared — it
// is the record of where the bytes were, and the sync's merge refills a
// cleared one from the other side anyway — and the planner offered every
// record that still named one. So every moved paper came back as a "sweep
// only" job, on every press, for ever: a Supabase sweep "succeeded" again on
// an object that was already gone, and a Drive sweep failed again because
// Google no longer lets this app delete anything. The count never moved.
//
// A record now says which old locators are DONE, by value, in
// `retiredLocators` (see documents/pdf-multi.js), and the planner skips those.
// The sync carries that marker the same way it carries the locators.
//
// ── Two phases, and the second is the only one that deletes ───────────────
//
// COPY, per paper: read the bytes (this device first), hash THEM — never trust
// the record's hash for bytes nobody has checked — put them in the bucket
// unless the bucket already holds exactly that many bytes under that key, check
// the bucket's answer, and write the key and hash into the deck.
//
// Then the panel runs an ordinary sync, so the deck carrying the new key and
// hash reaches the cloud.
//
// RETIRE, per paper, and only when every one of these holds:
//
//   • the bucket still holds the object, at the size of the bytes copied;
//   • the deck's row IN THE CLOUD already carries the hash. That hash is what
//     lets every other device find the paper in the bucket. Deleting the old
//     copy while only this device knew it — a record from before hashing, a
//     device that dies before its next push — would leave every other device
//     holding a record that names nothing it can open;
//   • no other record in the library still relies on the same old copy. Two
//     decks can name one object (a copied deck); the old copy goes only when
//     the last of them has moved.
//
// Anything short of that is "moved, waiting" — the paper is already safe in the
// bucket, nothing has been deleted, and the next press finishes it. Drive is
// the one source that is retired WITHOUT a delete when the delete is refused:
// Google turns this app away now, so the file is left in the reader's Drive
// and the panel names it, for the reader to remove by hand if they want the
// space. Nothing about that can lose a paper; there are simply two copies.
//
// Every step is idempotent. A copy that finds its object already there does not
// upload again; a retire that finds nothing left to delete still writes the
// marker. A half-finished move is re-run rather than repaired.

import { CLOUD_TIMEOUT_MS, mapWithConcurrency, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { deleteDriveFile } from "../cloud/drive-files.js?v=__BUILD__";
import { canReachS3 } from "../cloud/s3-config.js?v=__BUILD__";
import { downloadS3File, headS3File, s3DocumentKey, s3FileHasSize, statS3File } from "../cloud/s3-files.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_DOC, DOC_SLOT_NOTEBOOK, documentStoreKey } from "../documents/doc-slot.js?v=__BUILD__";
import { deckPdfs, isLocatorRetired, LEGACY_LOCATOR_FIELDS, liveLegacyLocators, PDF_PRIMARY_ID, pdfStoreKey, withDeckPdfs, withRetiredLocator } from "../documents/pdf-multi.js?v=__BUILD__";
import { deleteRemoteDocument, deleteStorageDocument, documentEntryMatches, documentS3Key, getDocument, readDocument, sha256, storedDocumentSize, uploadDocument } from "../documents/pdf-store.js?v=__BUILD__";
import { storageFolderSlug } from "../images/upload.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { nextSyncStamp } from "../sync/stats.js?v=__BUILD__";
import { deckWriteSettled, flushPendingDeckAutosave, forEachDeckSnapshot, pendingDeckWrites, readDeckSnapshot, rewriteDeckSnapshot } from "./deck-store.js?v=__BUILD__";
import { NOTES_CONFLICT_SUFFIX } from "./keys.js?v=__BUILD__";

// One at a time. A paper is tens of megabytes and is fully resident while it
// is being read, uploaded and hashed; running five of those at once is not
// five times faster, it is five times the peak memory, on the device least
// able to spare it. packBackupDocuments went sequential for the same reason
// and said so.
export const MIGRATION_CONCURRENCY = 1;

// A notes-conflict stash is a second copy of a real deck's snapshot, meta and
// all (in the shape older builds wrote it). Planned as a job of its own it was
// a paper counted twice — and a stash job could retire, and delete, the old copy
// the REAL deck's record still pointed at.
function isConflictStashId(id) {
  return String(id).includes(NOTES_CONFLICT_SUFFIX);
}

// A paper that still names an old location this app owes a move.
//
// `offloaded` entries are skipped: the reader has already said they do not
// want that file in the cloud, and quietly putting it in a different cloud is
// not what they asked for. Retired locators are skipped: those are done. What
// is left is `sources` — the old locators still live on this record — which is
// exactly what the retire step deals with.
function migrationJobsFromSnapshot(deckLocalId, snapshot) {
  const jobs = [];
  const meta = snapshot?.meta;
  if (!meta || typeof meta !== "object") return jobs;
  const consider = (entry, slot, pdfId) => {
    if (!entry || typeof entry !== "object" || entry.offloaded) return;
    const sources = liveLegacyLocators(entry);
    if (!sources.length) return;
    jobs.push({
      deckLocalId: String(deckLocalId),
      deckTitle: snapshot?.title || snapshot?.deckTitle || "Untitled",
      slot,
      pdfId: pdfId || null,
      name: entry.name || "document.pdf",
      bytes: Number(entry.size || 0),
      path: entry.path || "",
      driveId: entry.driveId || "",
      sources,
      // For the panel's "Drive · Supabase" tile: a record naming both is
      // counted where the harder half of it lives.
      source: sources.includes("driveId") ? "drive" : "storage",
      sha256: entry.sha256 || "",
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

// Every paper in the library that still owes a move, biggest first — which is
// the order the question "what do I move" is actually asked in.
export async function planDocumentMigration() {
  const jobs = [];
  await forEachDeckSnapshot((id, snapshot) => {
    if (isConflictStashId(id)) return;
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

// The meta with this job's entry replaced by what `stamp` makes of it, or null
// when `stamp` says there is nothing to write.
function metaWithJobEntry(meta, job, stamp) {
  if (!meta || typeof meta !== "object") return null;
  if (job.slot === DOC_SLOT_NOTEBOOK) {
    const notebook = stamp(meta.notebook);
    return notebook ? { ...meta, notebook } : null;
  }
  const wanted = job.pdfId || PDF_PRIMARY_ID;
  const next = stamp(entryForJob(meta, job));
  if (!next) return null;
  return withDeckPdfs(meta, deckPdfs(meta).map((entry) => ((entry.id || PDF_PRIMARY_ID) === wanted ? next : entry)));
}

// Writes one change onto the one entry this job names, under the deck's own
// lock and against a FRESH read of the snapshot. Resolves true when something
// was written.
//
// The lock matters more than it looks. forEachDeckSnapshot reads the object
// store directly, so the copy the plan was built from may already be stale by
// the time the upload finishes — a long upload is a long time for the reader
// to have carried on working. rewriteDeckSnapshot re-reads inside the lock,
// so what gets written back is the current deck with one field changed, not
// the plan's copy of it.
//
// Two more things, both of which an earlier version skipped, and both of which
// meant what it wrote never left the device:
//
//   • the deck's updatedAt is BUMPED, the same way the image outbox bumps a deck
//     it rewrote. The push gate reads updatedAt and nothing else, so a snapshot
//     that changed without it is a snapshot the cloud never hears about.
//   • the OPEN deck is patched in memory too. Its next autosave rebuilds the
//     snapshot from `state`, so a change written only to the store was reverted
//     400ms after the reader's next keystroke.
async function rewriteJobEntry(job, stamp) {
  const wrote = await rewriteDeckSnapshot(job.deckLocalId, (snapshot) => {
    const next = metaWithJobEntry(snapshot?.meta, job, stamp);
    if (!next) return null;
    snapshot.meta = next;
    return snapshot;
  });
  if (!wrote) return false;
  if (state.localDeckId && String(state.localDeckId) === String(job.deckLocalId)) {
    const live = metaWithJobEntry(state.meta, job, stamp);
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
    // The change is on the snapshot either way; what is lost is only the
    // prompt to push it, and the next edit to this deck supplies that.
    console.warn("Could not mark the deck for sync after recording its bucket copy", error);
  }
  return true;
}

// The entry pointing at `s3Key`, or null when there is nothing to write: the
// entry is gone, it already says exactly this, or it now names DIFFERENT bytes.
// The last one is a notebook rewritten while its old pages were uploading —
// tagging the new record with the old pages' key would hand every other device
// the page count this one just replaced.
function entryWithS3Key(entry, s3Key, hash) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.sha256 && entry.sha256 !== hash) return null;
  if (entry.s3Key === s3Key && entry.sha256 === hash) return null;
  return { ...entry, s3Key, sha256: hash, at: Date.now() };
}

async function readJobEntry(job) {
  try {
    return entryForJob((await readDeckSnapshot(job.deckLocalId))?.meta, job);
  } catch (error) {
    console.warn("Could not read the deck back", error);
    return null;
  }
}

// Resolves true when the entry names this very object afterwards — written now,
// or already written by another pass (the backfill, or an earlier run).
async function recordS3Key(job, s3Key, hash) {
  if (await rewriteJobEntry(job, (entry) => entryWithS3Key(entry, s3Key, hash))) return true;
  const entry = await readJobEntry(job);
  return Boolean(entry && entry.s3Key === s3Key && (!entry.sha256 || entry.sha256 === hash));
}

// ── Phase 1: copy ───────────────────────────────────────────────────────────

// The bytes this job means, and their hash — from this device when it holds
// them, from the bucket when the record already names a key there, and from
// the old location otherwise. Resolves { blob, hash } or { reason }.
//
// Nothing read from the network is written to this device. A move of a whole
// library would otherwise fill a phone with every paper in it, most of which
// the reader will never open there.
async function readJobBytes(job) {
  // This device first: the fast path, and usually the only one needed.
  try {
    const local = await readDocument(migrationStoreKey(job));
    if (local?.blob && documentEntryMatches(local, { sha256: job.sha256 })) {
      const hash = await sha256(local.blob);
      // A device copy that turns out not to be this file is passed over, not
      // trusted and not refused for ever: the copies in the cloud get a turn.
      if (hash && (!job.sha256 || hash === job.sha256)) return { blob: local.blob, hash };
    }
  } catch (error) {
    console.warn("Could not read the local document store", error);
  }
  // The bucket, when the record already names bytes there — read and HASHED,
  // which proves the object is the file rather than inferring it from a size.
  const key = job.sha256 ? s3DocumentKey({ pdfId: job.pdfId, sha256: job.sha256 }) : "";
  if (key) {
    const fromBucket = await downloadS3File(key);
    if (fromBucket) {
      const hash = await sha256(fromBucket);
      if (hash && hash === job.sha256) return { blob: fromBucket, hash };
    }
  }
  // The old locations. No device key, so getDocument neither reads nor writes
  // this device's store; no hash or key, so it does not ask the bucket again;
  // and no pdf id, so Drive is asked for THIS record's file by its id and never
  // searched by properties — a search by pdf id alone ("primary") can answer
  // with a different deck's paper, and for a record with no hash to check it
  // against, that paper would be moved in under this deck's name.
  const blob = await getDocument(null, { path: job.path, driveId: job.driveId, name: job.name });
  if (!blob) {
    return {
      reason: job.sources.includes("driveId") && !job.sources.includes("path")
        ? "it is in Google Drive, which this device cannot reach. Move it from a device that has the file, or re-attach the file here"
        : job.sources.includes("path") && !isSignedIn
          ? "sign in to read the copy in Supabase"
          : "could not read the file"
    };
  }
  const hash = await sha256(blob);
  if (!hash) return { reason: "could not check the file's contents" };
  // An old copy that is not the file this deck means (a notebook's previous
  // pages, say) is refused here — before anything is uploaded under a key it
  // has no right to, and long before anything is deleted.
  if (job.sha256 && hash !== job.sha256) {
    return { reason: "the copy found is not the version this deck uses, so nothing was changed" };
  }
  return { blob, hash };
}

// One paper into the bucket, checked, and recorded. Deletes nothing.
// Resolves { copied: true, s3Key, hash, size } or { copied: false, reason }.
export async function copyDocumentToS3(job) {
  if (!canReachS3()) return { copied: false, reason: "the bucket is not set up on this device" };

  // 1 & 2. The bytes, and the hash OF THOSE BYTES. A record written before this
  //    store hashed papers has none, and the key IS the hash; a record that has
  //    one is believed only once the bytes agree with it.
  const read = await readJobBytes(job);
  if (!read.blob) return { copied: false, reason: read.reason || "could not read the file" };
  const { blob, hash } = read;
  const size = Number(blob.size);
  if (!Number.isFinite(size) || size <= 0) return { copied: false, reason: "the file read back empty" };

  // 3. Up to the bucket — unless it already holds exactly this many bytes
  //    under the key these bytes' hash names. An object there at a DIFFERENT
  //    size is not this file (an earlier build could upload under a record's
  //    hash without checking the bytes), and is overwritten with the bytes
  //    just proved.
  const key = s3DocumentKey({ pdfId: job.pdfId, sha256: hash });
  if (!key) return { copied: false, reason: "no key" };
  const before = await statS3File(key);
  if (!(before.exists && before.size === size)) {
    try {
      await uploadDocument(blob, {
        name: storageFolderSlug(job.name.replace(/\.pdf$/i, ""), "document"),
        pdfId: job.pdfId,
        sha256: hash
      });
    } catch (error) {
      return { copied: false, reason: error?.message || "upload failed" };
    }
    // 4. ...and checked. "The PUT came back 200" and "the bucket holds this
    //    file" are two different facts, and only the second may ever justify
    //    deleting another copy.
    if (!(await s3FileHasSize(key, size))) {
      return { copied: false, reason: "the bucket copy did not check out, so nothing was deleted" };
    }
  }

  // 5. Into the deck.
  if (!(await recordS3Key(job, key, hash))) {
    // Nothing is lost: the record still names the old copy, so the paper
    // still opens, and the object in the bucket is found by its hash on the
    // next run rather than uploaded again.
    return { copied: false, reason: "could not update the deck" };
  }
  return { copied: true, s3Key: key, hash, size };
}

// ── Between the phases: what the CLOUD knows ────────────────────────────────

// The deck rows' document records, straight from the cloud — for the named
// decks, or with no ids for EVERY deck in the account (paged, in a stable
// order, so no row is skipped between pages). A Map(cloud deck id →
// { pdf, pdfs, notebook }), or null when this device cannot ask (signed out,
// offline, a refusal) — which the retire step treats as "not yet", never "yes".
//
// A light select: only the three document fields, never the notes, which can
// be megabytes a deck.
export const CLOUD_DOCUMENT_PAGE = 500;

export async function readCloudDocumentMeta(deckIds = null) {
  const out = new Map();
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return null;
  const columns = "id, pdf:meta->pdf, pdfs:meta->pdfs, notebook:meta->notebook";
  const keep = (rows) => {
    for (const row of rows || []) {
      out.set(String(row.id), { pdf: row.pdf || undefined, pdfs: row.pdfs || undefined, notebook: row.notebook || undefined });
    }
  };
  try {
    if (Array.isArray(deckIds)) {
      const ids = [...new Set(deckIds.filter(Boolean).map(String))];
      for (let i = 0; i < ids.length; i += 50) {
        const { data, error } = await withTimeout(
          supabaseClient.from("decks").select(columns).in("id", ids.slice(i, i + 50)),
          CLOUD_TIMEOUT_MS,
          "read deck documents"
        );
        if (error) throw error;
        keep(data);
      }
      return out;
    }
    for (let from = 0; ; from += CLOUD_DOCUMENT_PAGE) {
      const { data, error } = await withTimeout(
        supabaseClient.from("decks").select(columns).order("id", { ascending: true })
          .range(from, from + CLOUD_DOCUMENT_PAGE - 1),
        CLOUD_TIMEOUT_MS,
        "read deck documents"
      );
      if (error) throw error;
      keep(data);
      if ((data || []).length < CLOUD_DOCUMENT_PAGE) break;
    }
  } catch (error) {
    console.warn("Could not read the decks' document records from the cloud", error);
    return null;
  }
  return out;
}

function cloudDeckIdFor(deckLocalId) {
  try {
    return readLocalDeckIndex().find((row) => String(row.id) === String(deckLocalId))?.deckId || "";
  } catch {
    return "";
  }
}

// Every deck write this device still has in flight, landed — so the scan below
// sees what the reader last did rather than the version before it.
async function settleDeckWrites() {
  try {
    await flushPendingDeckAutosave();
  } catch (error) {
    console.warn("Could not flush the open deck before the move", error);
  }
  await Promise.all([...pendingDeckWrites.keys()].map((id) => deckWriteSettled(id).catch(() => {})));
}

// ── Phase 2: retire the old copy ────────────────────────────────────────────

// Every live old locator, by value, and who names it — so the retire step can
// tell whether an old object is still somebody else's only way home. From this
// device's library, and from the CLOUD for every deck this device does not
// hold: a deck that exists only on another device names its old copies too,
// and deleting one out from under it would leave that deck unopenable there.
// Offloaded records count: they still NAME the object, and this step never
// deletes out from under a record. `cloudMeta` null means the cloud could not
// be read, and the answer is marked incomplete — nothing may be deleted on it.
async function legacyLocatorHolders(cloudMeta) {
  const holders = new Map();
  const note = (holder, entry) => {
    for (const field of liveLegacyLocators(entry)) {
      const key = `${field}\n${entry[field]}`;
      const list = holders.get(key) || [];
      list.push(holder);
      holders.set(key, list);
    }
  };
  const visitMeta = (prefix, meta) => {
    if (!meta || typeof meta !== "object") return;
    deckPdfs(meta).forEach((entry) => note(`${prefix}\n${DOC_SLOT_DOC}\n${entry.id || PDF_PRIMARY_ID}`, entry));
    note(`${prefix}\n${DOC_SLOT_NOTEBOOK}\n${DOC_SLOT_NOTEBOOK}`, meta.notebook);
  };
  await forEachDeckSnapshot((id, snapshot) => {
    if (isConflictStashId(id)) return;
    visitMeta(String(id), snapshot?.meta);
  });
  if (cloudMeta) {
    const heldHere = new Set();
    try {
      for (const row of readLocalDeckIndex()) if (row?.deckId) heldHere.add(String(row.deckId));
    } catch { /* an unreadable index: every cloud deck counts, which only keeps more */ }
    for (const [deckId, meta] of cloudMeta) {
      if (!heldHere.has(String(deckId))) visitMeta(`cloud:${deckId}`, meta);
    }
  }
  holders.complete = Boolean(cloudMeta);
  return holders;
}

function jobHolderId(job) {
  return `${job.deckLocalId}\n${job.slot}\n${job.slot === DOC_SLOT_NOTEBOOK ? DOC_SLOT_NOTEBOOK : (job.pdfId || PDF_PRIMARY_ID)}`;
}

// One paper's old copies, retired — after the checks in the header. Resolves
// { status, reason, freed, leftInDrive } where status is:
//   "moved"    every old locator is retired, and every old copy this app could
//              safely delete is gone (or kept because something else needs it)
//   "left"     as moved, but the Drive file was left where it is
//   "waiting"  nothing deleted yet; the paper is safe in the bucket and the
//              next run finishes it (reason says what it is waiting for)
export async function retireDocumentSources(job, copied, { cloudMeta = null, holders = null } = {}) {
  // Against the record as it is NOW, not as it was planned.
  const entry = await readJobEntry(job);
  if (!entry || entry.sha256 !== copied.hash) return { status: "waiting", reason: "the deck changed while it was moving" };
  const sources = liveLegacyLocators(entry);
  if (!sources.length) return { status: "moved", reason: "", freed: 0 };

  // The bucket still holds it, whole.
  if (!(await s3FileHasSize(copied.s3Key, copied.size))) {
    return { status: "waiting", reason: "the bucket copy could not be confirmed just now" };
  }

  // Every other device can find it: the cloud's copy of this record carries
  // the hash the bucket key is made of. A deck with no cloud row has no other
  // device to tell.
  const deckId = cloudDeckIdFor(job.deckLocalId);
  if (deckId) {
    if (!cloudMeta) return { status: "waiting", reason: isSignedIn ? "waiting for the deck to sync" : "sign in so your other devices hear where it went" };
    const row = cloudMeta.get(String(deckId));
    const cloudEntry = row ? entryForJob(row, job) : null;
    if (!cloudEntry || cloudEntry.sha256 !== copied.hash) return { status: "waiting", reason: "waiting for the deck to sync" };
  }

  const complete = Boolean(holders?.complete);
  let retired = entry;
  let freed = 0;
  let leftInDrive = "";
  let kept = "";
  const waiting = [];
  for (const field of sources) {
    const value = entry[field];
    const others = (holders?.get(`${field}\n${value}`) || []).filter((holder) => holder !== jobHolderId(job));
    if (others.length) {
      // Another record still names this object and has not moved. This one no
      // longer needs it; the object stays until the last of them goes.
      retired = withRetiredLocator(retired, field);
      continue;
    }
    if (field === "path") {
      if (!complete) {
        waiting.push(isSignedIn ? "the other decks in the cloud could not be checked, so the old Supabase copy was kept for now" : "sign in to remove the old Supabase copy");
        continue;
      }
      // The object has to BE this file. For a record that was never hashed,
      // nothing else has ever compared the two.
      const stored = await storedDocumentSize(value);
      if (stored === undefined) {
        waiting.push("the old Supabase copy could not be checked just now");
        continue;
      }
      if (stored === null) {
        retired = withRetiredLocator(retired, field);
        continue;
      }
      if (stored !== copied.size) {
        kept = "the old Supabase copy was not the same file, so it was kept";
        retired = withRetiredLocator(retired, field);
        continue;
      }
      if (await deleteStorageDocument(value)) {
        retired = withRetiredLocator(retired, field);
        freed = job.bytes || copied.size;
      } else {
        waiting.push(isSignedIn ? "the old Supabase copy could not be removed" : "sign in to remove the old Supabase copy");
      }
    } else if (field === "driveId") {
      // Only for a record that named its bytes before the move: then the Drive
      // file was uploaded as exactly those bytes, and this is a copy. For one
      // that did not, nothing proves it, and a file left in the reader's Drive
      // costs nothing but space.
      const deleted = complete && job.sha256 ? await deleteDriveFile(value) : false;
      if (deleted) freed = job.bytes || copied.size;
      else leftInDrive = value;
      // Retired either way: the paper is in the bucket and the cloud says so.
      // A Drive file this app is no longer allowed to delete is the reader's
      // to remove, and is named for them rather than offered again for ever.
      retired = withRetiredLocator(retired, field);
    }
  }

  const retiredNow = legacyFieldsRetiredBy(retired, entry);
  if (retiredNow.length) {
    // No new `at`: the merge carries this marker whichever copy of the record
    // wins (withCarriedLocators), and bumping `at` would let this device's copy
    // beat an offload or a rename made on another device since the last pull.
    const wrote = await rewriteJobEntry(job, (current) => {
      if (!current || current.sha256 !== copied.hash) return null;
      let next = current;
      for (const field of retiredNow) if (current[field] === entry[field]) next = withRetiredLocator(next, field);
      return next === current ? null : next;
    });
    if (!wrote) {
      // Whatever was deleted is deleted, and the bucket copy is confirmed and
      // known to the cloud — so the paper is safe. The marker is what failed,
      // and the next run finds nothing left to delete and writes it then.
      return { status: "waiting", reason: "could not update the deck", freed };
    }
    for (const field of retiredNow) {
      const key = `${field}\n${entry[field]}`;
      holders?.set(key, (holders.get(key) || []).filter((holder) => holder !== jobHolderId(job)));
    }
  }
  if (waiting.length) return { status: "waiting", reason: waiting[0], freed };
  if (leftInDrive) return { status: "left", reason: kept, freed, leftInDrive };
  return { status: "moved", reason: kept, freed };
}

// The fields `after` has retired that `before` had not.
function legacyFieldsRetiredBy(after, before) {
  return liveLegacyLocators(before).filter((field) => isLocatorRetired(after, field));
}

// ── The whole run ───────────────────────────────────────────────────────────

// Syncs, copies everything, syncs again, then retires what may be retired.
// `sync` is the panel's: an ordinary sync, run BEFORE the copy so this device
// starts from what the other devices last did (an offload, a rename), and
// again BETWEEN the phases so the decks carrying the new keys reach the cloud
// before the cloud is asked about them. It is passed in rather than imported,
// because the sync imports this module.
//
// Resolves a summary with one row per paper:
//   { moved, left, waiting, failed, bytes, results: [{ name, deckTitle, status, reason, driveId }] }
export async function migrateDocumentsToS3(jobs, {
  onProgress = null,
  isCancelled = () => false,
  sync = null,
  readCloudMeta = readCloudDocumentMeta
} = {}) {
  const summary = { moved: 0, left: 0, waiting: 0, failed: 0, bytes: 0, results: [] };
  const runSync = async () => {
    if (!sync || isCancelled()) return;
    onProgress?.("sync", 0, 1, "");
    try {
      await sync();
    } catch (error) {
      console.warn("The sync around the move failed", error);
    }
  };
  await runSync();

  // Re-read after the sync: it may have brought a paper that another device
  // already moved, or an offload that means this one must not be.
  const planned = new Set(jobs.map(jobHolderId));
  const current = (await planDocumentMigration()).filter((job) => planned.has(jobHolderId(job)));

  const copies = [];
  let done = 0;
  await mapWithConcurrency(current, MIGRATION_CONCURRENCY, async (job) => {
    if (isCancelled()) return;
    onProgress?.("copy", done, current.length, job.name);
    const copied = await copyDocumentToS3(job);
    done += 1;
    if (copied.copied) copies.push({ job, copied });
    else {
      summary.failed += 1;
      summary.results.push({ name: job.name, deckTitle: job.deckTitle, status: "failed", reason: copied.reason });
    }
  });
  if (!copies.length) return summary;

  await runSync();
  await settleDeckWrites();
  const cloudMeta = await readCloudMeta(null);
  const holders = await legacyLocatorHolders(cloudMeta);
  let retiredCount = 0;
  for (const { job, copied } of copies) {
    if (isCancelled()) {
      summary.waiting += 1;
      summary.results.push({ name: job.name, deckTitle: job.deckTitle, status: "waiting", reason: "stopped before the old copy was removed" });
      continue;
    }
    onProgress?.("retire", retiredCount, copies.length, job.name);
    const outcome = await retireDocumentSources(job, copied, { cloudMeta, holders });
    retiredCount += 1;
    summary.bytes += outcome.freed || 0;
    if (outcome.status === "moved") summary.moved += 1;
    else if (outcome.status === "left") summary.left += 1;
    else summary.waiting += 1;
    summary.results.push({
      name: job.name,
      deckTitle: job.deckTitle,
      status: outcome.status,
      reason: outcome.reason || "",
      driveId: outcome.leftInDrive || ""
    });
  }
  return summary;
}

// One paper, both phases, for a caller holding a single job. The same checks:
// nothing is retired unless the cloud already knows where the paper went.
export async function migrateDocumentToS3(job, options = {}) {
  const summary = await migrateDocumentsToS3([job], options);
  const row = summary.results[0] || { status: "failed", reason: "not planned any more" };
  return { ...row, moved: row.status === "moved" || row.status === "left", bytes: summary.bytes };
}

// The last run's per-paper outcome, for the panel — so a paper that is waiting
// on a sync, or left in Drive, is named rather than summed into a toast.
let lastMigrationSummary = null;

export function rememberMigrationSummary(summary) {
  lastMigrationSummary = summary ? { ...summary, at: Date.now() } : null;
}

export function migrationSummary() {
  return lastMigrationSummary ? { ...lastMigrationSummary } : null;
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
      // one device" — the panel counts those under the migration instead. A
      // RETIRED old locator does not count: that copy is gone, or is no
      // longer this app's to rely on.
      legacy: liveLegacyLocators(entry).length > 0
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
//
// The same question is asked of the OLD locators too. A copied deck names the
// same Supabase path or Drive file as the deck it was copied from, and
// "Remove from cloud" on one of them used to delete that object out from under
// the other — which, for a paper not yet moved into the bucket, was its only
// copy in any cloud.
async function legacyLocatorsInUseElsewhere(record, { deckLocalId = "", slot = DOC_SLOT_DOC, pdfId = PDF_PRIMARY_ID } = {}) {
  const wanted = LEGACY_LOCATOR_FIELDS.filter((field) => record[field]);
  const used = new Set();
  if (!wanted.length) return used;
  await forEachDeckSnapshot((id, snapshot) => {
    if (String(id).includes(NOTES_CONFLICT_SUFFIX)) return;
    const meta = snapshot?.meta;
    if (!meta || typeof meta !== "object") return;
    const check = (other, entrySlot, entryPdfId) => {
      if (!other || typeof other !== "object" || other.offloaded) return;
      if (String(id) === String(deckLocalId) && entrySlot === slot && entryPdfId === pdfId) return;
      for (const field of wanted) {
        if (other[field] && other[field] === record[field] && !isLocatorRetired(other, field)) used.add(field);
      }
    };
    deckPdfs(meta).forEach((other) => check(other, DOC_SLOT_DOC, other.id || PDF_PRIMARY_ID));
    check(meta.notebook, DOC_SLOT_NOTEBOOK, DOC_SLOT_NOTEBOOK);
    return used.size === wanted.length ? false : undefined;
  });
  return used;
}

export async function deleteDocumentCopies(entry, { deckLocalId = "", slot = DOC_SLOT_DOC, pdfId = PDF_PRIMARY_ID } = {}) {
  const record = entry && typeof entry === "object" ? entry : {};
  const key = String(record.s3Key || "");
  const sharedKey = key ? await s3KeyInUseElsewhere(key, { deckLocalId, slot, pdfId }) : false;
  const sharedLegacy = await legacyLocatorsInUseElsewhere(record, { deckLocalId, slot, pdfId });
  const target = { ...record };
  if (sharedKey) target.s3Key = "";
  for (const field of sharedLegacy) target[field] = "";
  const shared = sharedKey || sharedLegacy.size > 0;
  const removed = await deleteRemoteDocument(target);
  return { removed: removed || shared, shared };
}
