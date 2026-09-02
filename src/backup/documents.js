// The papers themselves, inside the archive.
//
// This is the hole the whole change was about. A PDF deck is the file plus a set
// of highlights that are COORDINATES INTO THAT FILE — quads in PDF user space,
// measured against those exact bytes (see src/documents/pdf-store.js). The deck
// JSON carried `meta.pdf` (a name, a page count, a sha256 and a Storage path)
// and `meta.pdfHighlights`, and the bytes were left behind: they live in an
// IndexedDB store of this device's, and in a PRIVATE bucket in the owner's own
// Supabase project. So a "full backup" of a paper-heavy library restored decks
// and annotations pointing into a file that only the original owner's project
// could serve — the precise failure the module comment on backup.js says images
// were inlined to avoid: "a backup that referenced them would stop working the
// moment that project went away, which is exactly when a backup matters."
//
// It was worse than that on the SAME device. The local store is keyed by the
// deck's local id, and a restore mints a new one (deterministicRestoreLocalId),
// so restoring your own backup onto the machine holding the bytes still gave you
// a paper the reader could not open. Nothing was gone; the two halves had simply
// stopped knowing about each other. planBackupDocumentRestore's "rebind" branch
// is that case, and it costs no bytes at all.
//
// Structured as pack → plan → commit, the same three phases the images take, so
// restore drives both the same way and a cancelled restore leaves no trace of
// either.

import { getDocument, putDocument, readDocument, sha256 } from "../documents/pdf-store.js?v=__BUILD__";
import { BACKUP_DOCUMENT_INDEX, BACKUP_DOCUMENT_SCHEMA, backupDocumentFolderPath } from "./archive-format.js?v=__BUILD__";

// A paper is packed STORED rather than deflated. A PDF is already a compressed
// container: measured on real papers, DEFLATE at level 6 saves low single-digit
// percent and costs seconds of main-thread time per file — so on a library of
// forty papers it is minutes of a frozen tab bought for nothing. The images in
// assets/ are the same argument and were already being deflated with the rest of
// the archive; leaving that alone keeps this change to the one file where the
// numbers are large enough for it to matter.
export const BACKUP_DOCUMENT_COMPRESSION = { compression: "STORE" };

// The reasons a paper can be missing from an archive, as the index records them.
// Named rather than free text so a restore, and the check, can tell them apart:
// "this device does not have it and could not reach the cloud for it" is a
// different situation from "the file is gone".
export const DOCUMENT_MISSING_UNREACHABLE = "unreachable";

export const DOCUMENT_MISSING_OFFLOADED = "offloaded";

// Every paper the library holds, into `documents/`.
//
// Sequential, deliberately, where packBackupAssets fans out five at a time: a
// figure is kilobytes and latency-bound, a paper is tens of megabytes and each
// one is fully resident while it is being hashed and written. Five of those in
// flight is not five times faster, it is five times the peak memory, on the
// device least able to spare it.
export async function packBackupDocuments(zip, entries, onProgress, isCancelled = () => false) {
  const papers = entries.filter((entry) => entry.snapshot?.meta?.pdf);
  const documents = [];
  const missing = [];
  if (!papers.length) return { documents, missing, bytes: 0 };

  let done = 0;
  onProgress?.(0, papers.length);
  for (const entry of papers) {
    if (isCancelled()) break;
    const meta = entry.snapshot.meta.pdf;
    const name = String(meta.name || "document.pdf").replace(/[\\/]/g, "-");
    const describe = { deckFile: entry.deckFile, deckId: entry.deckId || null, deckTitle: entry.title, name };
    try {
      // The device copy first — it costs nothing, it is what the reader is
      // actually looking at, and it means a backup taken offline still carries
      // its papers. getDocument tries exactly that before reaching for the
      // cloud, and re-caches what it downloads on the way past, so a paper this
      // device had only ever synced is on it afterwards.
      const local = await readDocument(entry.localId);
      const blob = local?.blob || (await getDocument(entry.localId, meta));
      if (!blob) {
        missing.push({ ...describe, reason: meta.offloaded ? DOCUMENT_MISSING_OFFLOADED : DOCUMENT_MISSING_UNREACHABLE });
      } else {
        const path = `${backupDocumentFolderPath(entry.pathSegment, entry.idPart)}/${name}`;
        zip.file(path, blob, BACKUP_DOCUMENT_COMPRESSION);
        // Hashed HERE rather than trusted from meta.pdf. The two are supposed to
        // be the same file and the restore refuses them when they are not, so
        // the archive has to record what it actually holds — copying the deck's
        // claim across would make that check compare a number with itself.
        documents.push({
          file: path,
          deckFile: entry.deckFile,
          deckId: entry.deckId || null,
          deckLocalId: entry.localId || null,
          deckTitle: entry.title,
          name,
          bytes: blob.size,
          sha256: await sha256(blob),
          // The deck's own claim, kept beside it. Where the two disagree the
          // archive is the record of a file that had already drifted from the
          // highlights measured against it, and that is worth being able to see.
          metaSha256: String(meta.sha256 || ""),
          pages: Number(meta.pages) || 0,
          path: String(meta.path || "")
        });
      }
    } catch (error) {
      console.warn("Could not pack a document into the backup", entry.title, error);
      missing.push({ ...describe, reason: DOCUMENT_MISSING_UNREACHABLE });
    }
    done += 1;
    onProgress?.(done, papers.length);
  }

  zip.file(BACKUP_DOCUMENT_INDEX, `${JSON.stringify({
    schema: BACKUP_DOCUMENT_SCHEMA,
    version: 1,
    note: "One PDF per paper deck, the file exactly as it was imported. A deck's "
      + "highlights are coordinates into these bytes, so a restore refuses a file "
      + "whose hash does not match the deck's own record — the same rule "
      + "re-attaching a paper by hand already follows.",
    documents,
    missing
  }, null, 2)}\n`);

  return { documents, missing, bytes: documents.reduce((sum, doc) => sum + doc.bytes, 0) };
}

// ── The restore side ────────────────────────────────────────────────────────

export async function readBackupDocumentIndex(zip, findFile) {
  const path = findFile(Object.keys(zip.files), BACKUP_DOCUMENT_INDEX);
  const empty = { documents: [], missing: [] };
  if (!path || zip.files[path]?.dir) return empty;
  try {
    const parsed = JSON.parse(await zip.files[path].async("string"));
    return {
      documents: Array.isArray(parsed?.documents) ? parsed.documents : [],
      missing: Array.isArray(parsed?.missing) ? parsed.missing : []
    };
  } catch (error) {
    // An unreadable index costs the papers, not the restore. Every deck still
    // comes back; the reader gets the re-attach prompt on the ones whose bytes
    // could not be found, which is the state they were already in.
    console.warn("Backup document index is unreadable — restoring decks only", error);
    return empty;
  }
}

// Which document goes with which restored deck, and what would have to be
// written. Nothing is written here: a restore shows a preview first, and a
// cancelled restore must leave nothing behind — the same contract
// planBackupAssetAdoption keeps.
//
// `localIdFor` is the caller's map from a backup deck to the local id the
// restore has resolved for it, which is the whole point: the store is keyed by
// local id and only the restore knows what that id is going to be.
export async function planBackupDocumentRestore(zip, index, decks, localIdFor) {
  const plan = { store: [], rebind: [], present: 0, refused: [], unmatched: [] };
  if (!index.documents.length) return plan;

  const byArchivePath = new Map();
  const byDeckId = new Map();
  for (const deck of decks) {
    if (deck.archivePath) byArchivePath.set(deck.archivePath, deck);
    if (deck.deckId) byDeckId.set(String(deck.deckId), deck);
  }

  for (const entry of index.documents) {
    const deck = byArchivePath.get(entry.deckFile)
      || (entry.deckId ? byDeckId.get(String(entry.deckId)) : null);
    if (!deck) {
      plan.unmatched.push(entry);
      continue;
    }
    const localId = localIdFor(deck);
    if (!localId) {
      plan.unmatched.push(entry);
      continue;
    }

    // A file whose hash disagrees with the deck's own record is not this deck's
    // paper, whatever it is. Storing it would put every highlight on the wrong
    // words of the wrong page — visibly, and with no way to tell which of the
    // two is wrong afterwards. Re-attaching a paper by hand already refuses on
    // exactly this test; a restore has no business being more permissive than
    // the reader is. Compared only when BOTH sides have a hash: a page served
    // over plain http has no crypto.subtle, and sha256 returns "" there.
    const claimed = String(deck.meta?.pdf?.sha256 || entry.metaSha256 || "");
    if (claimed && entry.sha256 && claimed !== entry.sha256) {
      plan.refused.push({ ...entry, deckTitle: deck.title });
      continue;
    }

    // Already here under the id the restore is going to use.
    const existing = await readDocument(localId).catch(() => null);
    if (existing?.blob && (!entry.sha256 || !existing.sha256 || existing.sha256 === entry.sha256)) {
      plan.present += 1;
      continue;
    }

    // Here under the id the OTHER device used — which, restoring your own backup
    // onto your own machine, is the ordinary case. Re-keying copies a blob
    // between two rows of the same store; unpacking would read forty megabytes
    // out of the zip to arrive at bytes already on the disk.
    if (entry.deckLocalId && entry.deckLocalId !== localId) {
      const sibling = await readDocument(entry.deckLocalId).catch(() => null);
      if (sibling?.blob && (!entry.sha256 || !sibling.sha256 || sibling.sha256 === entry.sha256)) {
        plan.rebind.push({ localId, from: entry.deckLocalId, entry, blob: sibling.blob, sha256: sibling.sha256 || entry.sha256 });
        continue;
      }
    }

    const file = zip.files[entry.file];
    if (!file || file.dir) {
      plan.unmatched.push(entry);
      continue;
    }
    plan.store.push({ localId, entry, file });
  }
  return plan;
}

// The writes the plan deferred. Best effort per paper, like the images: one that
// cannot be stored leaves the deck exactly where it was — annotated, with a
// re-attach prompt — rather than failing the restore around it.
export async function commitBackupDocuments(plan, onProgress) {
  const result = { stored: 0, rebound: 0, present: plan?.present || 0, failed: 0, refused: (plan?.refused || []).length };
  if (!plan) return result;
  const total = plan.rebind.length + plan.store.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  for (const item of plan.rebind) {
    try {
      await putDocument({ deckLocalId: item.localId, blob: item.blob, sha256: item.sha256 || "", name: item.entry.name || "", at: Date.now() });
      result.rebound += 1;
    } catch (error) {
      console.warn("Could not re-key a document onto the restored deck", item.localId, error);
      result.failed += 1;
    }
    tick();
  }
  for (const item of plan.store) {
    try {
      const raw = await item.file.async("blob");
      // JSZip hands back an octet-stream; the reader asks pdf.js to parse it and
      // the type is what the rest of the app checks it by.
      const blob = new Blob([raw], { type: "application/pdf" });
      // The integrity check for a paper happens HERE rather than in the
      // archive's verification pass, and deliberately: hashing needs the bytes,
      // and this is the one moment they are already in hand. Doing it up front
      // would mean decompressing a library of papers — hundreds of megabytes —
      // in front of a preview, to learn something that can be learned for free
      // at the only point it changes what happens.
      const actual = await sha256(blob);
      if (item.entry.sha256 && actual && actual !== item.entry.sha256) {
        console.warn("A document in this archive is damaged and was not stored", item.entry.file);
        result.refused += 1;
        tick();
        continue;
      }
      await putDocument({ deckLocalId: item.localId, blob, sha256: item.entry.sha256 || "", name: item.entry.name || "", at: Date.now() });
      result.stored += 1;
    } catch (error) {
      console.warn("Could not store a restored document on this device", item.entry.file, error);
      result.failed += 1;
    }
    tick();
  }
  return result;
}
