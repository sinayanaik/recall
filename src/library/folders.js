// Deck folders. A folder IS a deck's category string: a "/"-delimited path
// like 'Math/Calculus/Derivatives', so a legacy flat category is simply a
// single-segment path and no data migration was ever needed to introduce them.
//
// Empty folders have nowhere to live in that scheme, which is why there is a
// separate per-device list of known folder paths.

import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { setMyDecksCwd } from "./my-decks-prefs.js?v=__BUILD__";

// A deck's `category` is a "/"-delimited folder path (e.g. "Math/Calculus"):
// each segment is a folder, nesting is arbitrary depth. Legacy flat categories
// (no "/") are simply single-segment paths, so this stays backward compatible.
export const FOLDER_SEP = "/";

// Splits a category into its trimmed, non-empty folder segments.
export function folderSegments(value) {
  return String(value || "")
    .split(FOLDER_SEP)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function normalizeDeckCategory(value) {
  const segments = folderSegments(value);
  return segments.length ? segments.join(FOLDER_SEP) : defaultDeckCategory;
}

// True when `path` is `ancestor` itself or nested beneath it.
export function isCategoryUnder(path, ancestor) {
  const p = normalizeDeckCategory(path);
  const a = normalizeDeckCategory(ancestor);
  return p === a || p.startsWith(a + FOLDER_SEP);
}

// Rewrites a category whose path is `fromPath` (or nested under it) so its
// `fromPath` prefix becomes `toPath`; returns it unchanged otherwise.
export function rewriteCategoryPrefix(category, fromPath, toPath) {
  const current = normalizeDeckCategory(category);
  const from = normalizeDeckCategory(fromPath);
  if (current === from) return normalizeDeckCategory(toPath);
  if (current.startsWith(from + FOLDER_SEP)) {
    return normalizeDeckCategory(toPath + current.slice(from.length));
  }
  return current;
}

export function categorySortValue(value) {
  const category = normalizeDeckCategory(value);
  return category === defaultDeckCategory ? "" : category.toLowerCase();
}

// ── Empty-folder registry ──────────────────────────────────────────────────
// Folders only exist implicitly, as prefixes of deck categories — so a folder
// with no decks yet has nowhere to live. This device-local list keeps such
// freshly-created (or emptied) folders visible until a deck lands in them; once
// one does, the folder persists everywhere via that deck's synced category.
export const KNOWN_FOLDERS_KEY = "flashcards_folders_v1";

export const COLLAPSED_FOLDERS_KEY = "flashcards_folder_collapsed_v1";

export function readKnownFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(KNOWN_FOLDERS_KEY) || "[]");
    return Array.isArray(list) ? list.map(normalizeDeckCategory).filter((p) => p !== defaultDeckCategory) : [];
  } catch (error) {
    console.warn("Could not read known folders", error);
    return [];
  }
}

// `stamp`: record what this write added and removed in the folder sync map
// below, so the change reaches the account's other devices. Off only for the
// write that APPLIES a merge from the cloud — that is not a change made here.
export function writeKnownFolders(list, { stamp = true } = {}) {
  const unique = Array.from(new Set((list || []).map(normalizeDeckCategory)))
    .filter((p) => p !== defaultDeckCategory);
  const before = stamp ? readKnownFolders() : null;
  try { localStorage.setItem(KNOWN_FOLDERS_KEY, JSON.stringify(unique)); } catch (_) {}
  if (stamp) {
    const now = Date.now();
    const map = readFolderSyncMap();
    const next = new Set(unique);
    const was = new Set(before);
    let changed = false;
    unique.forEach((path) => {
      if (was.has(path) && map[path] && !map[path].deleted) return;
      map[path] = { at: now, deleted: false };
      changed = true;
    });
    was.forEach((path) => {
      if (next.has(path)) return;
      map[path] = { at: now, deleted: true };
      changed = true;
    });
    if (changed) {
      writeFolderSyncMap(map);
      knownFoldersChangedHook();
    }
  }
  return unique;
}

// ── Empty folders across devices ───────────────────────────────────────────
// The list above was this device's alone, so a folder made here with nothing
// in it yet never reached another device — and was lost with this browser's
// storage. This side map records WHEN each folder was made or removed:
//
//   { "<path>": { at: <ms>, deleted: <bool> } }
//
// src/cloud/folder-sync.js merges it with the account's copy (the
// library_folders table) path by path, newer `at` winning, and hands the result
// back through applyFolderSyncMap. A path in the known list with no entry here
// (from before this existed) counts as made at time 0: kept and uploaded, but
// any deletion of it on another device wins.
export const FOLDER_SYNC_KEY = "flashcards_folders_sync_v1";

// How long a deleted folder's tombstone is kept. A device away for longer than
// this could bring a deleted empty folder back — an empty folder, and a cost
// worth paying for a row that does not grow forever.
export const FOLDER_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

let knownFoldersChangedHook = () => {};

// Told after every write that changed the list (src/main.js asks for a sync).
export function setKnownFoldersChangedHook(fn) {
  knownFoldersChangedHook = typeof fn === "function" ? fn : () => {};
}

export function cleanFolderSyncMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((key) => {
    const path = normalizeDeckCategory(key);
    if (path === defaultDeckCategory) return;
    const entry = raw[key];
    const at = Number(entry?.at);
    if (!entry || typeof entry !== "object" || !Number.isFinite(at) || at < 0) return;
    const clean = { at, deleted: entry.deleted === true };
    if (!out[path] || out[path].at < clean.at) out[path] = clean;
  });
  return out;
}

export function readFolderSyncMap() {
  try {
    return cleanFolderSyncMap(JSON.parse(localStorage.getItem(FOLDER_SYNC_KEY) || "{}"));
  } catch (_) {
    return {};
  }
}

function writeFolderSyncMap(map) {
  try { localStorage.setItem(FOLDER_SYNC_KEY, JSON.stringify(map)); } catch (_) {}
}

// This device's side of a sync: the map, with every known folder that has no
// entry yet seeded at time 0.
export function localFolderSyncMap() {
  const map = readFolderSyncMap();
  readKnownFolders().forEach((path) => {
    if (!map[path]) map[path] = { at: 0, deleted: false };
  });
  return map;
}

// Path by path, the newer change wins; on a tie, a deletion does (it was
// meant). Tombstones older than the TTL are dropped. Pure, for the checks.
export function mergeFolderSyncMaps(local, cloud, now = Date.now()) {
  const a = cleanFolderSyncMap(local);
  const b = cleanFolderSyncMap(cloud);
  const merged = {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((path) => {
    const x = a[path];
    const y = b[path];
    let pick = x || y;
    if (x && y) pick = x.at !== y.at ? (x.at > y.at ? x : y) : (x.deleted ? x : y);
    if (pick.deleted && now - pick.at > FOLDER_TOMBSTONE_TTL_MS) return;
    merged[path] = { at: pick.at, deleted: pick.deleted };
  });
  return merged;
}

export function sameFolderSyncMap(a, b) {
  const left = cleanFolderSyncMap(a);
  const right = cleanFolderSyncMap(b);
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((path) => right[path] && right[path].at === left[path].at && right[path].deleted === left[path].deleted);
}

// The merge, made this device's truth: the map as it came, and the known list
// as its live paths. Returns whether the visible list of folders changed.
export function applyFolderSyncMap(merged) {
  const map = cleanFolderSyncMap(merged);
  const before = readKnownFolders();
  const live = Object.keys(map).filter((path) => !map[path].deleted).sort();
  writeFolderSyncMap(map);
  writeKnownFolders(live, { stamp: false });
  const after = readKnownFolders();
  return before.length !== after.length || before.some((path) => !after.includes(path));
}

export function addKnownFolder(path) {
  const normalized = normalizeDeckCategory(path);
  if (normalized === defaultDeckCategory) return;
  writeKnownFolders([...readKnownFolders(), normalized]);
}

// Forgets a folder and every subfolder under it: drops them from the
// known-folder registry and from the collapsed/expanded UI state, and lifts
// the Folder-view cwd out if it pointed inside. A folder has no record of its
// own — it is a deck-category prefix plus a registry entry — so once its decks
// are gone this is the only thing still holding it on screen, which is exactly
// how a deleted folder used to linger as an empty "0 decks" shell.
export function forgetFolderTree(path) {
  const target = normalizeDeckCategory(path);
  if (target === defaultDeckCategory) return;

  writeKnownFolders(readKnownFolders().filter((p) => !isCategoryUnder(p, target)));

  const prune = (set) => {
    const next = new Set();
    set.forEach((p) => { if (!isCategoryUnder(p, target)) next.add(p); });
    return next;
  };
  writeCollapsedFolders(prune(readCollapsedFolders()));
  writeExpandedFolders(prune(readExpandedFolders()));

  if (state.myDecksCwd && isCategoryUnder(state.myDecksCwd, target)) {
    setMyDecksCwd(folderSegments(target).slice(0, -1).join(FOLDER_SEP));
  }
}

export function readCollapsedFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.map(normalizeDeckCategory) : []);
  } catch (error) {
    console.warn("Could not read collapsed folders", error);
    return new Set();
  }
}

export function writeCollapsedFolders(set) {
  try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
}

// Folders are FOLDED BY DEFAULT: a folder is expanded only if its path is in this
// set (the inverse of a "collapsed" list), so a fresh library shows everything
// folded. Supersedes COLLAPSED_FOLDERS_KEY for the tree view.
export const EXPANDED_FOLDERS_KEY = "flashcards_folder_expanded_v1";

export function readExpandedFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(EXPANDED_FOLDERS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.map(normalizeDeckCategory) : []);
  } catch (error) {
    console.warn("Could not read expanded folders", error);
    return new Set();
  }
}

export function writeExpandedFolders(set) {
  try { localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
}

export function isFolderCollapsed(path) {
  return !readExpandedFolders().has(normalizeDeckCategory(path));
}
