// How this device likes its My Decks library shown: tree/grid/folder, tiles or
// list, sort order, current folder. Per device on purpose — a phone and a
// laptop want different answers — so none of it syncs.

import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeDeckCategory } from "./folders.js?v=__BUILD__";

// ── My Decks view + display preferences (persisted per device) ──────────────
export const MYDECKS_VIEW_KEY = "flashcards_mydecks_view_v1";

export const MYDECKS_DISPLAY_KEY = "flashcards_mydecks_display_v1";

export const MYDECKS_CWD_KEY = "flashcards_mydecks_cwd_v1";

export const MYDECKS_SORT_KEY = "flashcards_mydecks_sort_v1";

export const MYDECKS_SORT_OPTIONS = ["recent", "title-asc", "title-desc", "updated-desc", "created-desc", "size-desc"];

export function setMyDecksView(view) {
  if (!["grid", "folder", "tree"].includes(view)) return;
  state.myDecksView = view;
  try { localStorage.setItem(MYDECKS_VIEW_KEY, view); } catch (_) {}
}

export function setMyDecksDisplay(display) {
  if (!["tiles", "list"].includes(display)) return;
  state.myDecksDisplay = display;
  try { localStorage.setItem(MYDECKS_DISPLAY_KEY, display); } catch (_) {}
}

export function setMyDecksSort(sort) {
  if (!MYDECKS_SORT_OPTIONS.includes(sort)) return;
  state.myDecksSort = sort;
  try { localStorage.setItem(MYDECKS_SORT_KEY, sort); } catch (_) {}
}

export function setMyDecksCwd(path) {
  state.myDecksCwd = normalizeDeckCategory(path) === defaultDeckCategory ? "" : normalizeDeckCategory(path);
  try { localStorage.setItem(MYDECKS_CWD_KEY, state.myDecksCwd); } catch (_) {}
}
