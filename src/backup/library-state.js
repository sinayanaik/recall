// The library's own shape, as opposed to the decks in it.
//
// A restore used to put every deck back and leave the app looking like a fresh
// install of it. None of this is deck data, so none of it was in the archive:
//
//   • a folder you made and have not filled yet has nowhere to live — a folder
//     IS a deck's category prefix, so one with no decks exists only in a
//     device-local list (KNOWN_FOLDERS_KEY). The manifest has always written the
//     folder names down and the restore has never once read them, so every empty
//     folder in a library was lost by design;
//   • which folds were open, so a restored library opens as one flat wall;
//   • and where you had got to in each note. A deck's `meta.readingPosition` is
//     the copy that travels between DEVICES, and it only reaches disk as a
//     passenger on a save that happened for some other reason — so a reader who
//     reads and does nothing else has their place recorded in the local store
//     alone (see src/notes/reading-position.js), which is exactly the copy a
//     backup did not carry. Restore a library of books and every one of them
//     reopens at page one.
//
// One file, `library.json`, rather than a key per concern: a restore reads it in
// one go, and someone opening the archive by hand sees the whole of it on one
// screen.
//
// Deliberately NOT carried: credentials (`flashcards_supabase_config`, any
// `sb-*-auth-token`) — a backup is a file people mail to themselves — and the
// sync's own bookkeeping (tombstones, the missing-deck watch, the last-sync
// stamps), whose entire meaning is "what THIS device has seen" and which would
// be actively wrong on another one.

import {
  readCollapsedFolders, readExpandedFolders, readKnownFolders,
  writeCollapsedFolders, writeExpandedFolders, writeKnownFolders
} from "../library/folders.js?v=__BUILD__";
import { readAllBookmarkPrompts, recordBookmarkPrompted } from "../notes/bookmark-prompt-store.js?v=__BUILD__";
import { readAllReadingPositions, writeStoredReadingPosition } from "../notes/reading-position.js?v=__BUILD__";
import { BACKUP_LIBRARY_FILE, BACKUP_LIBRARY_SCHEMA } from "./archive-format.js?v=__BUILD__";

// A reading-position key is currentDeckKey(): JSON.stringify([deckId,
// localDeckId, folderKey]). The local id in the middle is this device's, and a
// restore mints a different one — so a key carried across verbatim names a deck
// that will never be asked about again, and every restored position would be
// dead weight. Splitting the key on the way out and rebuilding it on the way in
// is the whole of the remap.
export function splitDeckKey(key) {
  try {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts)) return null;
    return { deckId: parts[0] || null, localDeckId: parts[1] || null, folderKey: parts[2] || null };
  } catch {
    return null;
  }
}

export function buildDeckKey({ deckId = null, localDeckId = null, folderKey = null } = {}) {
  return JSON.stringify([deckId || null, localDeckId || null, folderKey || null]);
}

function splitKeyedBag(bag, valueName) {
  const out = [];
  for (const [key, value] of Object.entries(bag || {})) {
    const parts = splitDeckKey(key);
    if (!parts) continue;
    out.push({ ...parts, [valueName]: value });
  }
  return out;
}

export function collectBackupLibraryState() {
  return {
    schema: BACKUP_LIBRARY_SCHEMA,
    version: 1,
    note: "The library's own shape: folders that hold no decks yet, which folds "
      + "are open, and where you had got to in each note. Restore merges this in "
      + "additively and never overwrites a place you have been since.",
    capturedAt: new Date().toISOString(),
    folders: {
      known: readKnownFolders(),
      collapsed: Array.from(readCollapsedFolders()),
      expanded: Array.from(readExpandedFolders())
    },
    // Stored split rather than keyed, so the local id can be swapped for the one
    // the restore resolves. See splitDeckKey.
    readingPositions: splitKeyedBag(readAllReadingPositions(), "anchor"),
    bookmarkPrompts: splitKeyedBag(readAllBookmarkPrompts(), "at")
  };
}

export async function readBackupLibraryState(zip, findFile) {
  const path = findFile(Object.keys(zip.files), BACKUP_LIBRARY_FILE);
  if (!path || zip.files[path]?.dir) return null;
  try {
    const parsed = JSON.parse(await zip.files[path].async("string"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (error) {
    // Costs the folders and the reading positions, never the decks.
    console.warn("Backup library state is unreadable — restoring decks only", error);
    return null;
  }
}

// Additive, in every direction. Folders are unioned — a restore that removed a
// fold this device had would be a restore that deleted something — and a reading
// position is written only where this device has NONE for that deck. That rule
// is the important one: the archive's position is by definition older than
// wherever the reader has been since, and a backup restored to recover a deleted
// deck must not throw the reader back twenty pages in every book they still had.
export function applyBackupLibraryState(libraryState, { localIdByArchiveId = new Map() } = {}) {
  const applied = { folders: 0, readingPositions: 0, bookmarkPrompts: 0 };
  if (!libraryState) return applied;

  const known = Array.isArray(libraryState.folders?.known) ? libraryState.folders.known : [];
  if (known.length) {
    const before = new Set(readKnownFolders());
    writeKnownFolders([...before, ...known]);
    applied.folders = known.filter((path) => !before.has(path)).length;
  }
  const mergeSet = (values, read, write) => {
    if (!Array.isArray(values) || !values.length) return;
    const set = read();
    values.forEach((path) => set.add(path));
    write(set);
  };
  mergeSet(libraryState.folders?.collapsed, readCollapsedFolders, writeCollapsedFolders);
  mergeSet(libraryState.folders?.expanded, readExpandedFolders, writeExpandedFolders);

  // The remap. An entry whose local id the restore did not resolve keeps the id
  // it arrived with: on the device that WROTE the backup that is still the right
  // key, and on any other it simply names a deck nothing asks about — which
  // costs one unused entry, where guessing would cost a wrong position.
  const remap = (entry) => buildDeckKey({
    deckId: entry.deckId,
    localDeckId: localIdByArchiveId.get(String(entry.localDeckId || "")) || entry.localDeckId,
    folderKey: entry.folderKey
  });

  const existingPositions = readAllReadingPositions();
  for (const entry of Array.isArray(libraryState.readingPositions) ? libraryState.readingPositions : []) {
    const key = remap(entry);
    if (existingPositions[key]) continue;
    if (!entry.anchor || !Number.isFinite(Number(entry.anchor.offset))) continue;
    writeStoredReadingPosition(key, entry.anchor);
    applied.readingPositions += 1;
  }

  const existingPrompts = readAllBookmarkPrompts();
  for (const entry of Array.isArray(libraryState.bookmarkPrompts) ? libraryState.bookmarkPrompts : []) {
    const key = remap(entry);
    if (existingPrompts[key] !== undefined) continue;
    recordBookmarkPrompted(key, entry.at);
    applied.bookmarkPrompts += 1;
  }
  return applied;
}
