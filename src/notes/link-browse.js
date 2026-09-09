// Browsing the library from inside the `[[` picker.
//
// Typing "[[" with nothing after it used to produce eight titles in alphabetical
// order and no way to see any of the rest — which only helps if you already know
// the name you are reaching for. This turns that same popup into a small
// browser: where you have been recently, the folders, and what is in the one you
// are standing in.
//
// There is no folder tree to read. A deck's `category` IS its path
// ("Math/Calculus/Derivatives"), so the tree is derived from the categories in
// the index every time it is drawn — the same way My Decks does it, and the
// reason folders needed no migration when they were introduced. See
// src/library/folders.js.

import { state } from "../core/state.js?v=__BUILD__";
import { FOLDER_SEP, folderSegments, isCategoryUnder, normalizeDeckCategory, readKnownFolders } from "../library/folders.js?v=__BUILD__";
import { listLocalDecks } from "../library/local-library.js?v=__BUILD__";

// Browse rows are not search results: a folder holding thirty notes has to be
// readable, and the popup already scrolls (max-height + overflow-y in
// styles/12-notes.css). Search stays at NOTE_LINK_PICKER_LIMIT — eight ranked
// guesses is a different job from a directory listing.
export const NOTE_LINK_BROWSE_LIMIT = 60;

export const NOTE_LINK_RECENT_LIMIT = 5;

// ── How the notes in a folder are ordered ──────────────────────────────────
//
// Newest first by default. A folder listing sorted by name is a phone book, and
// a phone book is only useful to someone who knows the name — which is the one
// thing the person who just typed "[[" does not have. What they DO have is a
// sense of when: the note they are reaching for is nearly always one they were
// writing this week. Alphabetical stays one keystroke away (Alt+S, or the chip
// in the breadcrumb) for when the library is large and the name IS known.
//
// Per device, like every other view preference — see my-decks-prefs.js.
export const NOTE_LINK_SORT_KEY = "flashcards_note_link_sort_v1";

export const NOTE_LINK_SORT_OPTIONS = ["modified", "title"];

let noteLinkSort = null;

export function noteLinkBrowseSort() {
  if (noteLinkSort) return noteLinkSort;
  let stored = null;
  try { stored = localStorage.getItem(NOTE_LINK_SORT_KEY); } catch (_) {}
  noteLinkSort = NOTE_LINK_SORT_OPTIONS.includes(stored) ? stored : "modified";
  return noteLinkSort;
}

export function setNoteLinkBrowseSort(sort) {
  if (!NOTE_LINK_SORT_OPTIONS.includes(sort)) return noteLinkBrowseSort();
  noteLinkSort = sort;
  try { localStorage.setItem(NOTE_LINK_SORT_KEY, sort); } catch (_) {}
  return noteLinkSort;
}

export function toggleNoteLinkBrowseSort() {
  return setNoteLinkBrowseSort(noteLinkBrowseSort() === "modified" ? "title" : "modified");
}

export function noteLinkSortLabel(sort = noteLinkBrowseSort()) {
  return sort === "title" ? "A\u2013Z" : "Recent";
}

// Newest first, falling back to the title so two notes saved in the same second
// (an import, a first sync) never swap places between two draws of the same
// list. A missing timestamp sorts last for the same reason it is tolerated at
// all: an old index entry is still a note you may want to link to.
export function compareNotesByModified(a, b) {
  const at = String(a.updatedAt || "");
  const bt = String(b.updatedAt || "");
  if (at !== bt) {
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  }
  return a.title.localeCompare(b.title);
}

export function compareBrowseNotes(a, b) {
  return noteLinkBrowseSort() === "title" ? a.title.localeCompare(b.title) : compareNotesByModified(a, b);
}

// Where the picker opens. The note you are writing is far more likely to link to
// one of its neighbours than to something across the library, so browsing starts
// in its own folder with the breadcrumb offering the way out — rather than at a
// root you would have to walk back down every time.
export function noteLinkHomeFolder() {
  return normalizeDeckCategory(state.deckCategory);
}

// The path one level up, or "" for the root (which shows every top-level folder).
export function parentFolder(path) {
  const segments = folderSegments(path);
  segments.pop();
  return segments.join(FOLDER_SEP);
}

export function folderCrumbs(path) {
  const segments = folderSegments(path);
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join(FOLDER_SEP) }));
}

// Entries that can be linked to at all. Mirrors the two exclusions the picker
// has always applied: the note you are in is never a useful destination, and
// Quick Note pins are scraps rather than places — they have no folder to sit in,
// so they are searchable but not browsable.
export function linkableEntries(index) {
  return (index || []).filter((entry) => !entry.pinId && !(entry.localId && entry.localId === state.localDeckId));
}

// Immediate subfolders of `cwd`, with how many notes sit at or below each. The
// count is what makes an empty-looking folder worth stepping into, and it counts
// descendants rather than direct children for the same reason: "Math (12)" is
// the useful number even when all twelve are one level further down.
//
// readKnownFolders() is folded in so a folder created in My Decks but not yet
// used is still somewhere you can put a new note — it is exactly the case the
// empty-folder registry exists for.
export function subfoldersOf(entries, cwd) {
  // "" is the root — every folder in the library. Any other value is a real
  // path, and only what is at or under it is listed.
  const here = String(cwd || "").trim();
  const depth = folderSegments(here).length;
  const counts = new Map();
  const paths = new Set();
  for (const entry of entries) {
    const category = normalizeDeckCategory(entry.category);
    if (here && !isCategoryUnder(category, here)) continue;
    const segments = folderSegments(category);
    if (segments.length <= depth) continue;
    const path = segments.slice(0, depth + 1).join(FOLDER_SEP);
    paths.add(path);
    counts.set(path, (counts.get(path) || 0) + 1);
  }
  for (const known of readKnownFolders()) {
    if (here && !isCategoryUnder(known, here)) continue;
    const segments = folderSegments(known);
    if (segments.length <= depth) continue;
    paths.add(segments.slice(0, depth + 1).join(FOLDER_SEP));
  }
  return Array.from(paths)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      kind: "folder",
      path,
      title: folderSegments(path).pop() || path,
      count: counts.get(path) || 0
    }));
}

export function notesIn(entries, cwd) {
  const here = normalizeDeckCategory(cwd);
  if (!String(cwd || "").trim()) return [];
  return entries
    .filter((entry) => normalizeDeckCategory(entry.category) === here)
    .sort(compareBrowseNotes)
    .map((entry) => ({ ...entry, kind: "note" }));
}

// The notes you actually worked on, newest first. listLocalDecks() is already
// sorted on accessedAt || updatedAt, so this is a filter and a join rather than
// a sort — and it is the half of this feature that does the most work, because
// the note you want to link to is very often one you had open minutes ago.
//
// Cloud-only decks cannot appear here: they have never been opened on this
// device, which is precisely what "recent" means.
export function recentRows(entries, skip = new Set()) {
  const byLocalId = new Map(entries.filter((entry) => entry.localId).map((entry) => [entry.localId, entry]));
  const rows = [];
  for (const deck of listLocalDecks()) {
    if (rows.length >= NOTE_LINK_RECENT_LIMIT) break;
    if (deck.id === state.localDeckId || skip.has(deck.id)) continue;
    const entry = byLocalId.get(deck.id);
    if (entry) rows.push({ ...entry, kind: "note" });
  }
  return rows;
}

// The whole browse view, as one flat list of SELECTABLE rows.
//
// Flat and selectable-only is the contract: commitNoteLinkPicker indexes this
// array by number, so a section heading can never be an element of it. Each
// group's first row carries `sectionLabel` instead and the renderer draws the
// heading from that — see renderNoteLinkPicker.
export function browseRowsFor(index, cwd, { includeRecent = false } = {}) {
  const entries = linkableEntries(index);
  const rows = [];
  const at = String(cwd || "");

  if (at) rows.push({ kind: "up", path: parentFolder(at), title: folderSegments(at).slice(-2, -1)[0] || "All folders" });

  const notes = notesIn(entries, at);

  if (includeRecent) {
    // Anything the folder listing below is about to show is not also offered as
    // "recent". In a small library the two overlap almost entirely, and a popup
    // that lists the same four notes twice is harder to read than one that
    // lists them once.
    const shown = new Set(notes.map((row) => row.localId).filter(Boolean));
    const recent = recentRows(entries, shown);
    if (recent.length) {
      recent[0].sectionLabel = "Recent";
      rows.push(...recent);
    }
  }

  const folders = subfoldersOf(entries, at);
  if (folders.length) {
    folders[0].sectionLabel = at ? "Folders" : "All folders";
    rows.push(...folders);
  }

  if (notes.length) {
    notes[0].sectionLabel = folderSegments(at).pop() || "Notes";
    rows.push(...notes);
  }

  return rows.slice(0, NOTE_LINK_BROWSE_LIMIT);
}
