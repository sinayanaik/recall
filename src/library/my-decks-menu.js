// The My Decks overflow menu, and importing straight into a folder.

import { backupNudgeDue, describeLastBackup, readLastBackup } from "../backup/history.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { readLocalDeckIndex } from "./local-library.js?v=__BUILD__";

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
  if (willOpen) paintBackupStatusRow();
}

// "Last backup: 3 days ago", above the row that takes one.
//
// The app recorded nothing at all before this, so it could not tell you and
// could not ask: a backup happened when someone remembered, and whether that was
// yesterday or never was a question only their Downloads folder could answer.
//
// Written when the menu OPENS rather than kept in sync, because it is one line
// of text nobody sees until then — and read out of the deck index the menu is
// already sitting on top of, so it costs nothing. Deliberately not a toast, a
// modal or a badge on anything: a backup is a thing you decide to do, and a
// reminder you have to dismiss is a reminder you turn off.
export function paintBackupStatusRow() {
  const row = document.getElementById("myDecksBackupStatus");
  if (!row) return;
  const record = readLastBackup();
  const index = readLocalDeckIndex();
  const changedAt = index.reduce((newest, meta) => Math.max(newest, Date.parse(meta.updatedAt || "") || 0), 0);
  const due = backupNudgeDue({ record, changedAt, deckCount: index.length });
  row.textContent = due
    ? `${describeLastBackup(record)} — worth taking a new one`
    : describeLastBackup(record);
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

// Title search (debounced) — filters the cached set, no refetch.
export let myDecksSearchTimer = null;

// Setter: an imported binding is read-only, and the search box listener in main.js debounces through it.
export function setMyDecksSearchTimer(value) {
  myDecksSearchTimer = value;
}
