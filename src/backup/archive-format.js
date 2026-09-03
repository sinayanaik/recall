// What a backup archive IS, as a set of shapes and rules — and the one table
// that says which of the app's data a backup is supposed to carry.
//
// A leaf, deliberately: it imports nothing from the rest of the app, so
// tools/backup-check.mjs can drive every function here from plain Node with no
// browser, no network and no baseline tag. Same reasoning, and the same
// precedent, as src/format/merged-notes.js and src/sync/document-sync.js — the
// checks that could only run in a browser were the checks that skipped, and a
// check that skips verifies nothing.
//
// It exists because the archive had no reader for its own manifest. The manifest
// was written, and then restore globbed `decks/**.json` out of the zip and never
// opened it — so `folders` (the empty ones, which have nowhere else to live) was
// decorative, the version was declared informational in a comment, and a zip
// that had lost half its entries in transit restored the half that was left and
// reported success. Nothing anywhere compared what the archive SAID it held
// against what it actually held.

// The manifest's own identity. Restore reads the schema to know it is looking at
// one of ours; anything else is treated as an unstructured zip, exactly as
// before this file existed.
export const BACKUP_SCHEMA = "recall-backup";

// 1: decks only. 2: images packed into assets/ as real files. 3: the PDFs
// themselves under documents/, the folder tree and reading state under
// library.json, and a `contents` inventory the reader can check the zip against.
//
// Still not a switch: a restore branches on what it FINDS in the archive, never
// on this number, so every version restores through one path and an archive
// written by a build that does not exist yet degrades to the parts this build
// understands. The number is what a person reads when something has gone wrong,
// and what the check pins so the format cannot change without someone saying so.
export const BACKUP_VERSION = 3;

export const BACKUP_MANIFEST_FILE = "manifest.json";

export const BACKUP_DECK_DIR = "decks";

export const BACKUP_ASSET_DIR = "assets";

export const BACKUP_ASSET_INDEX = `${BACKUP_ASSET_DIR}/index.json`;

export const BACKUP_ASSET_SCHEMA = "recall-backup-assets";

// Where a paper's actual bytes go. `documents/` rather than under `assets/`
// because the two are accounted for separately everywhere else in the app for
// the same reason — "what is my 1GB holding" has a very different answer when
// one PDF is the size of two hundred figures (see DOCUMENT_BUCKET) — and because
// an older build's restore ignores an unknown top-level folder outright, which
// is what keeps a v3 archive readable by a build that predates it.
export const BACKUP_DOCUMENT_DIR = "documents";

export const BACKUP_DOCUMENT_INDEX = `${BACKUP_DOCUMENT_DIR}/index.json`;

export const BACKUP_DOCUMENT_SCHEMA = "recall-backup-documents";

// The device's own library shape: folders that hold no decks yet, which fold is
// open, and where you had got to in each note. One file rather than a key per
// concern, so a restore reads it in one go and an archive opened by hand shows
// the whole of it on one screen.
export const BACKUP_LIBRARY_FILE = "library.json";

export const BACKUP_LIBRARY_SCHEMA = "recall-backup-library";

// ── The coverage table ──────────────────────────────────────────────────────
//
// The reason this whole area needed work. A deck's `meta` is one bag shared by
// every feature that has ever wanted somewhere to put something, and the app
// grew papers, highlights, highlight notes, bookmarks, note links, quick notes
// and reading positions into it without anyone once asking whether a backup
// carries them — because nothing asked. Adding a key is a one-line change in a
// feature's own module, and until now it was invisible from here.
//
// So every key is named, on one side or the other, with the reason. A key in
// neither table fails tools/backup-check.mjs, which means adding one is a
// decision someone makes on purpose rather than a thing that quietly happens.
// The tables are prose on purpose: "why is this not in my backup" is a question
// a person asks at the worst possible moment, and the answer should be readable
// where the omission is.
export const BACKED_UP_META_KEYS = {
  pdf:
    "The paper's identity — name, page count, sha256, and the Storage path the "
    + "bytes were uploaded to. Rides in the deck JSON; the bytes themselves are "
    + "packed under documents/ (see BACKUP_DOCUMENT_DIR), which is what makes a "
    + "restored paper readable when the project it came from is gone.",
  pdfHighlights:
    "Every highlight on the paper, as quads in PDF user space — and every mark "
    + "made with a pen, which is a record in this same array with kind:\"ink\" "
    + "and its strokes encoded on it, so handwriting is carried by this entry "
    + "rather than by one of its own. Merged on restore by "
    + "mergeDocumentAnnotations rather than taken wholesale, so a backup can "
    + "repair a PARTIAL loss instead of only a total one.",
  deletedHighlightIds:
    "Highlight tombstones. Carried and unioned on restore precisely so a "
    + "restore cannot resurrect a highlight the reader deleted on purpose — a "
    + "union of the live records alone would do exactly that.",
  pdfToc:
    "The contents read out of the type on the paper's pages, cached on the "
    + "deck. Derivable again from the file, but it costs a full pass over every "
    + "page to rebuild, so it is worth the bytes.",
  bookmark:
    "The place the reader marked. Settled on restore by its own `at`, never by "
    + "which side is newer as a whole.",
  readingPosition:
    "Where the reader had got to, as it travels between devices. The device's "
    + "own local store of the same thing is in library.json.",
  linkIds:
    "The ids this deck answers to for [[links]], one minted per device. Unioned "
    + "on restore: every device holds a piece of the truth.",
  quickNoteCategories:
    "The names and colours every quick note's label resolves against. Without "
    + "them a restored board reads as entirely Uncategorized.",
  noteAnchors:
    "Where each pinned note was pinned from, per card."
};

export const NOT_BACKED_UP_META_KEYS = {
  // Nothing today. A key belongs here when carrying it would be wrong rather
  // than merely unimplemented — a cache keyed to this device, a credential, a
  // piece of sync bookkeeping whose whole meaning is "what THIS device has seen".
  // Leaving it empty is a claim, and backup-check holds us to it.
};

// The same question for whole stores. IndexedDB is where the large things live,
// and the largest of them — the PDFs — was outside the archive entirely.
export const BACKED_UP_STORES = {
  "recall-decks":
    "Deck snapshots: cards, notes and the meta bag above. One deck per file "
    + "under decks/, in its own folder path.",
  "recall-documents":
    "The PDF bytes. Packed under documents/ and written back on restore under "
    + "the local id the restore actually resolved — the store is keyed by local "
    + "id, and a restore mints a new one, so a restore that skipped this step "
    + "severed a paper from bytes sitting on the same disk.",
  "recall-outbox":
    "Images pasted while offline and not yet uploaded. Their bytes are packed "
    + "into assets/ like any other picture, and restore re-parks them in this "
    + "device's own outbox."
};

export const NOT_BACKED_UP_STORES = {
  // Same rule as the meta table: empty is a claim, not an oversight.
};

// ── Paths ───────────────────────────────────────────────────────────────────

// A deck's asset and document folders are named the same way (`<slug>--<id>`),
// so what you see in the zip matches what you see in the Storage bucket. Kept
// here rather than beside backupAssetFolderPath so the check can build a fixture
// archive without importing the module that talks to the DOM.
export function backupDocumentFolderPath(segment, id) {
  return `${BACKUP_DOCUMENT_DIR}/${segment}--${id}`;
}

// Is this one of the archive's own bookkeeping files, rather than content? The
// unstructured-zip path needs to know: a hand-made zip is scanned for anything
// deck-shaped, and our own index files are JSON that must not be mistaken for a
// deck with no cards.
export function isBackupIndexPath(path) {
  const lower = String(path || "").toLowerCase();
  return lower.endsWith(`/${BACKUP_MANIFEST_FILE}`) || lower === BACKUP_MANIFEST_FILE
    || lower.endsWith(`/${BACKUP_ASSET_INDEX}`) || lower === BACKUP_ASSET_INDEX
    || lower.endsWith(`/${BACKUP_DOCUMENT_INDEX}`) || lower === BACKUP_DOCUMENT_INDEX
    || lower.endsWith(`/${BACKUP_LIBRARY_FILE}`) || lower === BACKUP_LIBRARY_FILE;
}

// Some zip tools nest the whole archive one level deeper on extract-and-rezip,
// so every lookup here matches on the tail of the path rather than the whole of
// it. Returns the real key in `names`, or "" — the caller needs the key, not a
// boolean, because that is what it reads the entry back with.
export function findArchiveFile(names, wanted) {
  const target = String(wanted).toLowerCase();
  if (names.includes(wanted)) return wanted;
  return names.find((name) => {
    const lower = name.toLowerCase();
    return lower === target || lower.endsWith(`/${target}`);
  }) || "";
}

// ── The manifest ────────────────────────────────────────────────────────────

// One writer, so the manifest and the zip cannot describe different archives.
// `contents` is the whole point of the v3 manifest: an inventory of every file
// with its size, which is the only thing that makes verifyBackupArchive able to
// say "this archive is missing four decks" rather than restoring three and
// calling it done.
export function buildBackupManifest({
  exportedAt = new Date().toISOString(),
  build = "",
  decks = [],
  assets = [],
  assetsMissing = 0,
  documents = [],
  documentsMissing = 0,
  folders = [],
  contents = []
} = {}) {
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    app: "recall",
    // Which build wrote this. Nothing had one before, so an archive that
    // restores strangely could not be tied to the code that produced it — and
    // that is exactly the moment you want to know. Empty in an unstamped
    // checkout (see IS_DEV_BUILD), which is honest rather than misleading.
    build: String(build || ""),
    exportedAt,
    deckCount: decks.length,
    assetCount: assets.length,
    assetsMissing,
    documentCount: documents.length,
    documentBytes: documents.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
    documentsMissing,
    folders: Array.from(new Set(folders)).sort(),
    decks,
    contents
  };
}

export function normalizeBackupManifest(raw) {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.schema && parsed.schema !== BACKUP_SCHEMA) return null;
  return parsed;
}

// Does the archive hold what its manifest says it holds?
//
// Never throws and never refuses on its own: an archive that is 90% intact is
// still worth restoring — losing the other 10% is the situation the user is
// already IN — but it must not be restored silently. The caller shows what this
// returns before anything is written, and the confirm button says so.
//
// A v1/v2 archive, or a hand-made zip, has no manifest to check against and
// comes back `{ ok: true, checked: false }`: nothing is claimed, so nothing can
// be contradicted.
export function verifyBackupArchive(fileNames, manifest) {
  const result = {
    ok: true,
    checked: false,
    missingFiles: [],
    shortFiles: [],
    counts: {},
    notes: []
  };
  const bag = normalizeBackupManifest(manifest);
  if (!bag) return result;
  result.checked = true;

  const names = Array.from(fileNames || []);
  const present = new Set(names);
  const lower = new Map(names.map((name) => [name.toLowerCase(), name]));
  const resolve = (path) => (present.has(path) ? path : lower.get(String(path).toLowerCase()) || "");

  for (const entry of Array.isArray(bag.contents) ? bag.contents : []) {
    const wanted = entry && entry.file;
    if (!wanted) continue;
    if (!resolve(wanted)) result.missingFiles.push(wanted);
  }

  // A manifest written before `contents` existed still names every deck file,
  // so the same check runs against `decks[]` — an archive that lost a deck in
  // transit is the case worth catching, and it is catchable in v2 too.
  for (const deck of Array.isArray(bag.decks) ? bag.decks : []) {
    const wanted = deck && deck.file;
    if (wanted && !resolve(wanted) && !result.missingFiles.includes(wanted)) {
      result.missingFiles.push(wanted);
    }
  }

  const countIn = (prefix, suffix) => names.filter((name) => {
    const path = name.toLowerCase();
    return path.includes(`${prefix}/`) && path.endsWith(suffix) && !isBackupIndexPath(name);
  }).length;

  const declared = {
    decks: Number(bag.deckCount) || 0,
    documents: Number(bag.documentCount) || 0
  };
  const found = {
    decks: countIn(BACKUP_DECK_DIR, ".json"),
    documents: names.filter((name) => name.toLowerCase().includes(`${BACKUP_DOCUMENT_DIR}/`) && !isBackupIndexPath(name)).length
  };
  result.counts = { declared, found };

  if (declared.decks && found.decks < declared.decks) {
    result.notes.push(`${declared.decks - found.decks} of ${declared.decks} deck files are missing from this archive.`);
  }
  if (declared.documents && found.documents < declared.documents) {
    result.notes.push(`${declared.documents - found.documents} of ${declared.documents} document files are missing from this archive.`);
  }
  if (result.missingFiles.length) {
    result.notes.push(`${result.missingFiles.length} file${result.missingFiles.length === 1 ? "" : "s"} named in the manifest ${result.missingFiles.length === 1 ? "is" : "are"} not in the archive.`);
  }
  result.ok = !result.notes.length;
  return result;
}

// A file's declared size and hash against its real ones. Split out from the loop
// above because it needs the BYTES, which the caller has to read entry by entry
// — and a file truncated in transit is the failure that most deserves saying out
// loud: the deck restores, the highlights restore, and the paper they are
// positions in opens to nothing.
//
// A hash is compared only when both sides have one. `sha256` in
// src/documents/pdf-store.js returns "" on a page served over plain http, where
// there is no crypto.subtle to hash with — so an archive written there carries
// no hashes at all, and treating that as a mismatch would condemn every one of
// its files. Same tolerance the document re-attach already shows for a
// meta.pdf.sha256 that was never computed.
export function mismatchedArchiveFiles(manifest, { sizeByPath = new Map(), hashByPath = new Map() } = {}) {
  const bag = normalizeBackupManifest(manifest);
  if (!bag || !Array.isArray(bag.contents)) return [];
  const bad = [];
  for (const entry of bag.contents) {
    if (!entry?.file) continue;
    const actualSize = sizeByPath.get(entry.file);
    if (actualSize !== undefined && Number.isFinite(Number(entry.bytes)) && actualSize !== Number(entry.bytes)) {
      bad.push({ file: entry.file, reason: "size", declared: Number(entry.bytes), actual: actualSize });
      continue;
    }
    const actualHash = hashByPath.get(entry.file);
    if (entry.sha256 && actualHash && entry.sha256 !== actualHash) {
      bad.push({ file: entry.file, reason: "hash", declared: entry.sha256, actual: actualHash });
    }
  }
  return bad;
}

// How many of the manifest's files could actually be hash-checked. The preview
// says this out loud rather than reporting a bare "verified": an archive whose
// hashes are all empty has been checked for PRESENCE and LENGTH and nothing
// more, and claiming otherwise is the kind of reassurance that costs someone a
// library.
export function archiveHashCoverage(manifest) {
  const bag = normalizeBackupManifest(manifest);
  const contents = bag && Array.isArray(bag.contents) ? bag.contents : [];
  return { total: contents.length, hashed: contents.filter((entry) => entry && entry.sha256).length };
}
