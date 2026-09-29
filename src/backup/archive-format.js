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
//
// 4: the `.recall` package. Same layout as 3 — every reader of a v3 archive
// reads a v4 one — plus a `kind` ("library" for a whole-library backup, "share"
// for decks handed to someone else), a real UTF-8 size and a sha256 for every
// file in `contents`, the identity each deck travels under (`origin`, `ids`)
// so a recipient can recognise it the second time, `skipped` for the decks the
// writer could not read, and `settings.json` beside library.json.
export const BACKUP_VERSION = 4;

// The file a package travels as. A zip underneath, so any zip tool can open one
// by hand and every reader this app has ever had can read it — the extension is
// what lets the app, the OS and the person holding it tell a Recall package
// apart from any other zip.
export const PACKAGE_EXT = ".recall";

export const PACKAGE_MIME = "application/vnd.recall+zip";

// What a package is FOR. A library backup is restored into the library it came
// from (merged by deck id, additive); a share is imported by somebody else, as
// decks of their own. The kind picks the default; the person importing can
// always choose the other.
export const PACKAGE_KIND_LIBRARY = "library";

export const PACKAGE_KIND_SHARE = "share";

export const BACKUP_SETTINGS_FILE = "settings.json";

export const BACKUP_SETTINGS_SCHEMA = "recall-backup-settings";

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
  notebook:
    "The handwritten notebook's paper, in the same shape as `pdf` above and "
    + "under a slot of its own so a deck can have both — somebody else's PDF to "
    + "read, and blank pages to write on beside it. These bytes are GENERATED "
    + "(src/documents/blank-pdf.js), so they are also the one document in this "
    + "table that can be remade from its own record if the file is ever lost.",
  pdfHighlights:
    "Every highlight on the paper, as quads in PDF user space — and every mark "
    + "made with a pen, which is a record in this same array with kind:\"ink\" "
    + "and its strokes encoded on it, so handwriting is carried by this entry "
    + "rather than by one of its own. A record's `doc` says which of the deck's "
    + "two documents it is a coordinate into — absent means the deck's own "
    + "paper, which is what every record written before notebooks had a slot of "
    + "their own already meant. Merged on restore by mergeDocumentAnnotations "
    + "rather than taken wholesale, so a backup can repair a PARTIAL loss "
    + "instead of only a total one.",
  deletedHighlightIds:
    "Highlight tombstones. Carried and unioned on restore precisely so a "
    + "restore cannot resurrect a highlight the reader deleted on purpose — a "
    + "union of the live records alone would do exactly that.",
  pdfToc:
    "The contents read out of the type on the paper's pages, cached on the "
    + "deck. Derivable again from the file, but it costs a full pass over every "
    + "page to rebuild, so it is worth the bytes.",
  pdfs:
    "Every PDF the doc slot carries, when there is more than one — id, name, "
    + "size, page count, sha256, Storage path and an optional label. Absent "
    + "for the ordinary deck that has only ever had one PDF, whose identity "
    + "still rides in `pdf` above (the entry here whose id is \"primary\" is "
    + "always a live mirror of that same key). The bytes themselves are "
    + "packed under documents/ per PDF, exactly as a single PDF's already are.",
  deletedPdfIds:
    "PDF tombstones, carried for the reason deletedHighlightIds is: a restore "
    + "that unioned the live PDFs alone would put back one the reader removed "
    + "from the deck on purpose.",
  pdfReadingPositions:
    "Where the reader had got to in each PDF beyond the primary, one entry "
    + "per pdf id. The primary's own position still rides in "
    + "readingPositionPdf below, which this does not replace.",
  pdfTocByPdfId:
    "The contents read out of each PDF beyond the primary, cached the same "
    + "way pdfToc above caches the primary's, and for the same reason.",
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
    "Where each pinned note was pinned from, per card.",
  pdfBlocks:
    "The blocks a reader has dropped onto a paper's pages — markdown text, or an "
    + "image — each with the page it is on, its rectangle in that page's own "
    + "points, and its content. In points rather than pixels for the reason the "
    + "highlights are: a position in the document survives a zoom and a second "
    + "device and a position on the glass survives neither. `doc` says which of "
    + "the deck's two documents it sits on, exactly as it does on a highlight.",
  deletedBlockIds:
    "Block tombstones, carried for the reason deletedHighlightIds is: a restore "
    + "that unioned the live blocks alone would put back every block the reader "
    + "had deleted.",
  readingPositionPdf:
    "Where the reader had got to in the deck's primary PDF, as it travels "
    + "between devices. Named by a computed key (docSlotPositionKey), which is "
    + "why the scan below never saw it and it rode in every archive unlisted.",
  readingPositionNotebook:
    "The same, for the handwritten notebook.",
  pdfActiveId:
    "Which of a deck's several PDFs was open. Validated on every read, so a "
    + "value naming a PDF that did not come back is simply ignored.",
  importedFrom:
    "Where a deck that arrived in somebody's .recall package came from — the "
    + "package it was in and the identity it travelled under. It is how a "
    + "second copy of the same package is recognised as an UPDATE to decks "
    + "already here rather than a second set of them.",

  // ── The four keys of an older notebook ───────────────────────────────────
  //
  // A notebook used to be pages in `meta` rather than pages of a document. It is
  // not any more, and these are still carried — deliberately, and this is the
  // reason: an archive taken on the old build has to restore into something the
  // migration can still convert (src/documents/notebook-migrate.js). Dropping
  // them here would mean a backup made yesterday restores a deck with no
  // handwriting in it at all, which is the exact failure a backup exists to
  // prevent. They cost nothing on a deck that never had them and disappear from
  // one the moment it is opened.
  pages:
    "LEGACY. An older notebook's paper — one record per page, with the strokes "
    + "on it. Converted to pages of a generated PDF the first time that deck's "
    + "Handwritten Notes surface is opened, and carried until then so an archive "
    + "taken before that conversion still restores something to convert.",
  textBoxes:
    "LEGACY. The typed boxes on those pages. Converted alongside them, into "
    + "pdfBlocks, and carried for the same reason.",
  deletedPageIds:
    "LEGACY. Tombstones for the two above. Carried so a restore of an older "
    + "archive cannot resurrect a page the reader tore out before migrating.",
  deletedTextBoxIds:
    "LEGACY. The same, for boxes."
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

// ── What a SHARE does with each key ─────────────────────────────────────────
//
// A backup carries the bag as it is, because it goes back to the person it came
// from. A share goes to somebody else, and every key has to answer a different
// question: is this the deck, is this the sender's own progress through it, or
// is this a pointer into the sender's ACCOUNT that means nothing — or worse,
// something wrong — anywhere else? A key in BACKED_UP_META_KEYS with no answer
// here fails tools/backup-check.mjs, for the reason the table above exists.
//
//   keep      the deck's content; travels as it is.
//   progress  the sender's place in the deck. Travels only when the sender
//             ticked "include my progress".
//   account   a record whose IDENTITY travels (name, pages, sha256) but whose
//             storage locators — a path in the sender's bucket, their Drive
//             file id, their S3 key — are stripped. The recipient's own device
//             uploads the bytes to the recipient's own storage.
//   remap     ids that name things in the sender's library, rewritten by the
//             importer to name the same things in the recipient's.
export const SHARE_POLICY_KEEP = "keep";

export const SHARE_POLICY_PROGRESS = "progress";

export const SHARE_POLICY_ACCOUNT = "account";

export const SHARE_POLICY_REMAP = "remap";

export const SHARE_META_POLICY = {
  pdf: SHARE_POLICY_ACCOUNT,
  notebook: SHARE_POLICY_ACCOUNT,
  pdfs: SHARE_POLICY_ACCOUNT,
  pdfHighlights: SHARE_POLICY_KEEP,
  deletedHighlightIds: SHARE_POLICY_KEEP,
  pdfToc: SHARE_POLICY_KEEP,
  deletedPdfIds: SHARE_POLICY_KEEP,
  pdfTocByPdfId: SHARE_POLICY_KEEP,
  pdfActiveId: SHARE_POLICY_KEEP,
  pdfReadingPositions: SHARE_POLICY_PROGRESS,
  readingPositionPdf: SHARE_POLICY_PROGRESS,
  readingPositionNotebook: SHARE_POLICY_PROGRESS,
  bookmark: SHARE_POLICY_PROGRESS,
  readingPosition: SHARE_POLICY_PROGRESS,
  linkIds: SHARE_POLICY_REMAP,
  noteAnchors: SHARE_POLICY_REMAP,
  importedFrom: SHARE_POLICY_REMAP,
  quickNoteCategories: SHARE_POLICY_KEEP,
  pdfBlocks: SHARE_POLICY_KEEP,
  deletedBlockIds: SHARE_POLICY_KEEP,
  pages: SHARE_POLICY_KEEP,
  textBoxes: SHARE_POLICY_KEEP,
  deletedPageIds: SHARE_POLICY_KEEP,
  deletedTextBoxIds: SHARE_POLICY_KEEP
};

// The fields of a document record that point into ONE account's storage. What
// SHARE_POLICY_ACCOUNT strips.
export const ACCOUNT_LOCATOR_FIELDS = ["path", "driveId", "s3Key", "retiredLocators", "offloaded"];

// A copy of a document record without the sender's locators.
export function stripAccountLocators(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const out = { ...record };
  for (const field of ACCOUNT_LOCATOR_FIELDS) delete out[field];
  return out;
}

// One deck's meta bag, as a SHARE carries it. Pure: the caller's bag is not
// touched. `remap` keys are left for the importer, which is the only side that
// knows what they should become.
export function shareMetaBag(meta, { includeProgress = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta && typeof meta === "object" ? meta : {})) {
    const policy = SHARE_META_POLICY[key] || SHARE_POLICY_KEEP;
    if (policy === SHARE_POLICY_PROGRESS && !includeProgress) continue;
    if (policy === SHARE_POLICY_ACCOUNT) {
      out[key] = Array.isArray(value) ? value.map(stripAccountLocators) : stripAccountLocators(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ── Settings ────────────────────────────────────────────────────────────────
//
// The device's own preferences, in a library backup only — a share never
// carries them, because nobody wants a friend's theme. The same rule as the
// tables above: a localStorage key the app writes and neither table names is a
// decision nobody has made yet.
export const BACKED_UP_SETTINGS_KEYS = {
  "swipe-notes-style-settings-v1": "Fonts, sizes, spacing and every other reading-surface choice.",
  "swipe-notes-theme": "The theme.",
  "recall:ink-prefs-v1": "Pens, colours and widths.",
  "recall:imageCompression": "How pasted images are compressed before upload.",
  "recall:pdfPageNotes": "Whether a paper's page notes are shown.",
  "recall:pdfInvert": "Whether papers are shown inverted for dark reading.",
  "recall:focusMode": "Focus mode.",
  "recall:screenOrientation": "The orientation lock.",
  "recall:splitRatio": "Where the split view's divider sits.",
  "recall:highlightNoteBox": "The size of the highlight-note editor.",
  "recall:renderHighlightDefault": "The default highlight colour.",
  "recall:renderColorDefault": "The default text colour.",
  "recall:allCardsFilter": "The All Cards panel's filter.",
  "recall:allCardsCompact": "The All Cards panel's density.",
  recall_autosync_minutes: "How often the library syncs by itself.",
  flashcards_mydecks_view_v1: "My Decks' view (list or folders).",
  flashcards_mydecks_sort_v1: "My Decks' sort order.",
  flashcards_mydecks_display_v1: "My Decks' display density.",
  flashcards_note_link_sort_v1: "How the note-link picker sorts."
};

export const NOT_BACKED_UP_SETTINGS_KEYS = {
  flashcards_supabase_config: "A credential. A backup is a file people mail to themselves.",
  "recall:driveConfig": "A credential, the same way.",
  "recall:lastBackup": "The record of the last backup — this device's history, not a preference."
};

// The settings a library backup carries, read off this device. Values are
// carried as the raw strings localStorage holds, so a restore writes back
// exactly what was read and no setting's own format has to be known here.
export function collectBackupSettings(storage = globalThis.localStorage) {
  const values = {};
  for (const key of Object.keys(BACKED_UP_SETTINGS_KEYS)) {
    try {
      const value = storage?.getItem(key);
      if (value !== null && value !== undefined) values[key] = String(value);
    } catch {
      // A storage that throws (private mode) has no settings to carry.
    }
  }
  return {
    schema: BACKUP_SETTINGS_SCHEMA,
    version: 1,
    note: "This device's preferences — theme, fonts, pens, and how the panels are laid out. "
      + "Restored only when asked to, and never part of a shared package.",
    values
  };
}

// Write a settings file back. Only keys the table names are ever written: a
// hand-edited file cannot be used to plant a credential or anything else.
export function applyBackupSettings(settings, storage = globalThis.localStorage) {
  const values = settings && typeof settings === "object" && settings.values && typeof settings.values === "object" ? settings.values : {};
  let applied = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(BACKED_UP_SETTINGS_KEYS, key) || typeof value !== "string") continue;
    try {
      storage?.setItem(key, value);
      applied += 1;
    } catch {
      // Out of space: a setting is the first thing worth losing.
    }
  }
  return applied;
}

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
    || lower.endsWith(`/${BACKUP_LIBRARY_FILE}`) || lower === BACKUP_LIBRARY_FILE
    || lower.endsWith(`/${BACKUP_SETTINGS_FILE}`) || lower === BACKUP_SETTINGS_FILE;
}

// Where the archive actually starts. A zip that was extracted and zipped up
// again by hand usually gains a folder around everything — `backup/manifest.json`
// — and every lookup that asked for `assets/index.json` by its exact path then
// found nothing: the decks came back (they were found by suffix) and every image
// and paper quietly did not. Worked out once, from where the manifest sits (or,
// for an archive with none, where the first decks/ folder does), so every lookup
// after it can use the path the writer used.
export function archiveRootPrefix(names) {
  const list = Array.from(names || []);
  // The shallowest one: a folder of deck files that happens to hold a file of
  // that name further down must not move the root into itself.
  const manifest = list.filter((name) => {
    const lower = name.toLowerCase();
    return lower === BACKUP_MANIFEST_FILE || lower.endsWith(`/${BACKUP_MANIFEST_FILE}`);
  }).sort((a, b) => a.length - b.length)[0];
  if (manifest) return manifest.slice(0, manifest.length - BACKUP_MANIFEST_FILE.length);
  const deck = list.find((name) => /(^|\/)decks\//i.test(name));
  if (!deck) return "";
  const at = deck.toLowerCase().search(/(^|\/)decks\//);
  return at <= 0 ? "" : deck.slice(0, at + 1);
}

// A view of a loaded zip whose `files` are keyed as if the prefix were not
// there. Everything else — the entries themselves — is the same objects, so a
// read through the view is a read of the archive.
export function rootedArchive(zip) {
  const names = Object.keys(zip?.files || {});
  const prefix = archiveRootPrefix(names);
  if (!prefix) return zip;
  const files = {};
  for (const name of names) {
    if (name.startsWith(prefix)) files[name.slice(prefix.length)] = zip.files[name];
    else if (!(name in files)) files[name] = zip.files[name];
  }
  return { files, prefix, source: zip };
}

// A random id, good enough to tell two packages apart.
export function newPackageId() {
  const bytes = new Uint8Array(9);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `pkg-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
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
  contents = [],
  kind = PACKAGE_KIND_LIBRARY,
  packageId = "",
  includesProgress = true,
  skipped = [],
  title = ""
} = {}) {
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    app: "recall",
    kind: kind === PACKAGE_KIND_SHARE ? PACKAGE_KIND_SHARE : PACKAGE_KIND_LIBRARY,
    packageId: String(packageId || ""),
    title: String(title || ""),
    includesProgress: Boolean(includesProgress),
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
    // Decks the writer could not read. A package that says "40 decks" when the
    // library had 42 is a package that has lied by omission; this is the part
    // that says so, and the preview repeats it.
    skipped: Array.isArray(skipped) ? skipped : [],
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
