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

export function writeKnownFolders(list) {
  const unique = Array.from(new Set((list || []).map(normalizeDeckCategory)))
    .filter((p) => p !== defaultDeckCategory);
  try { localStorage.setItem(KNOWN_FOLDERS_KEY, JSON.stringify(unique)); } catch (_) {}
  return unique;
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
