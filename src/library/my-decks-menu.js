// The My Decks overflow menu, and importing straight into a folder.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";

// ── The toolbar's "⋯" menu ──────────────────────────────────────────────────
// Holds Refresh, Expand all, Import EPUB, Restore and every Export All format,
// so the toolbar itself stays a single row at any width.
export function closeMyDecksMoreMenu() {
  if (!el.myDecksMoreMenu || el.myDecksMoreMenu.hidden) return;
  el.myDecksMoreMenu.hidden = true;
  el.myDecksMoreBtn?.setAttribute("aria-expanded", "false");
}

export function toggleMyDecksMoreMenu() {
  if (!el.myDecksMoreMenu) return;
  const willOpen = el.myDecksMoreMenu.hidden;
  el.myDecksMoreMenu.hidden = !willOpen;
  el.myDecksMoreBtn?.setAttribute("aria-expanded", String(willOpen));
}

// The folder new decks/folders are created under: the cwd in Folder view, else the
// scope-filter value (root when neither is set).
export function currentMyDecksFolder() {
  if (state.myDecksView === "folder") return state.myDecksCwd || "";
  return el.myDecksCategoryFilter?.value || "";
}

// ── Import into a folder ────────────────────────────────────────────────────
// The third way to put something in the folder you're looking at, alongside New
// deck and New folder — previously every import landed in Uncategorized no
// matter where you started it from, leaving you to drag the deck back. One
// shared <input type="file"> serves both the toolbar button and every folder
// row's own Import button; this records which folder opened it, since the change
// event can't tell them apart.
export let myDecksImportFolder = "";

export function importIntoFolder(folderPath = "") {
  const input = el.myDecksImportInput;
  if (!input) return;
  myDecksImportFolder = folderPath || "";
  closeMyDecksMoreMenu();
  input.value = ""; // re-picking the same file must still fire `change`
  input.click();
}
