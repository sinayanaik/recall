// One row of the My Decks list: its buttons, its card count, its notes marker.

import { deckSyncStatus, deckSyncStatusCell } from "../cloud/deck-list.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { webDeckCategories } from "./categories.js?v=__BUILD__";
import { buildDeckOverflowMenu } from "./folder-tree.js?v=__BUILD__";
import { createDeckExportControl, deckCardInfo, deckSelOf, loadDeckEntry } from "./my-decks-actions.js?v=__BUILD__";
import { mdIcon } from "./my-decks-icons.js?v=__BUILD__";
import { renderMyDecksList } from "./my-decks-render.js?v=__BUILD__";
import { createDeckCategoryControl, createDeckSelectCell, formatLocalDeckSavedDate, formatLocalDeckSavedDateShort, renameMyDeck } from "./my-decks-selection.js?v=__BUILD__";
import { TOMBSTONE_REFUSED_MESSAGE, deleteDeckEverywhere } from "./tombstones.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

// Tile actions carry an icon plus a label the phone layout drops, so a tile
// stays usable at the ~130px track width two columns leave on a 360px screen.
export function buildDeckLoadButton(deck, kind) {
  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "bulk-action-btn bulk-load";
  loadBtn.innerHTML = mdIcon("play");
  const label = document.createElement("span");
  label.className = "md-btn-label";
  label.textContent = "Load";
  loadBtn.append(label);
  loadBtn.title = "Load deck";
  loadBtn.setAttribute("aria-label", `Load ${deck.title || "deck"}`);
  loadBtn.addEventListener("click", () => loadDeckEntry(deck, kind));
  return loadBtn;
}

export function buildDeckRenameButton(sel, deck) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bulk-action-btn bulk-category";
  b.textContent = "Rename";
  b.addEventListener("click", () => renameMyDeck(sel, deck.title || ""));
  return b;
}

// Confirms and deletes a deck (from device and/or cloud as appropriate).
export function deleteDeckEntry(deck, kind) {
  if (kind === "cloud") {
    showConfirmModal(`Delete "${deck.title || "this deck"}" from the cloud? This cannot be undone.`, async () => {
      const { cloudError, refused } = await deleteDeckEverywhere({ localId: null, deckId: deck.id });
      renderMyDecksList();
      if (refused) showToast(TOMBSTONE_REFUSED_MESSAGE, "error");
      else showToast(cloudError ? "Delete failed — will retry on next sync" : "Deck deleted everywhere", "info");
    }, { confirmLabel: "Delete", danger: true });
  } else {
    const inCloud = Boolean(deck.deckId);
    const scope = inCloud ? "from this device and the cloud" : "from this device";
    showConfirmModal(`Delete "${deck.title || "this deck"}" ${scope}? This cannot be undone.`, async () => {
      const { cloudError, refused } = await deleteDeckEverywhere({ localId: deck.id, deckId: deck.deckId || null });
      renderMyDecksList();
      if (refused) showToast(TOMBSTONE_REFUSED_MESSAGE, "error");
      else if (cloudError) showToast("Deleted here — cloud delete will retry on next sync", "info");
      else showToast(inCloud ? "Deck deleted everywhere" : "Deck deleted from device", "info");
    }, { confirmLabel: "Delete", danger: true });
  }
}

export function buildDeckDeleteButton(deck, kind) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bulk-action-btn bulk-delete";
  b.textContent = "Delete";
  b.addEventListener("click", () => deleteDeckEntry(deck, kind));
  return b;
}

// A compact icon button for the My Decks list actions. Icon-only (with a tooltip
// and aria-label) so the whole row stays tight and never overflows.
// `icon` is an <svg> string from mdIcon() — every caller passes one of our own
// constants, so there is no untrusted markup reaching innerHTML here.
export function iconActionButton(icon, label, cls, deck, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bulk-action-btn icon-action ${cls}`;
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", `${label} ${deck.title || "deck"}`);
  b.addEventListener("click", handler);
  return b;
}

// The action cluster for list rows — self-explanatory icons with tooltips and
// aria-labels: play (load) · download (export) · pencil (rename) · trash (delete).
//
// Rename and Delete are also reachable from the "⋯" menu appended last. That
// looks like duplication, but it is what lets one row markup serve both widths:
// CSS hides the two inline icons below 720px (where four icons plus the meta
// line don't fit a phone row) and hides "⋯" above it. Building both up front
// keeps the row correct across a resize without any JS media-query plumbing.
export function buildDeckActions(deck, kind) {
  const sel = deckSelOf(deck, kind);
  const wrap = document.createElement("div");
  wrap.className = "my-deck-actions";
  const rename = iconActionButton(mdIcon("pencil"), "Rename", "bulk-category", deck, () => renameMyDeck(sel, deck.title || ""));
  const del = iconActionButton(mdIcon("trash"), "Delete", "bulk-delete", deck, () => deleteDeckEntry(deck, kind));
  rename.classList.add("md-row-wide-only");
  del.classList.add("md-row-wide-only");
  const overflow = buildDeckOverflowMenu(deck, kind, sel);
  overflow.classList.add("md-row-narrow-only");
  wrap.append(
    iconActionButton(mdIcon("play"), "Load", "bulk-load", deck, () => loadDeckEntry(deck, kind)),
    createDeckExportControl(sel, deck.title, { compact: true }),
    rename,
    del,
    overflow,
  );
  return wrap;
}

// One row for a deck stored in the on-device library. `cloudById` (Map or null)
// drives the Sync column — null renders a tentative state before the cloud
// fetch resolves.
// The Cards cell: a bare number, plus an optional "has notes" marker after it.
export function deckCardCountSpan(count) {
  const span = document.createElement("span");
  span.className = "deck-card-count-n";
  span.textContent = String(count ?? "—");
  return span;
}

export function deckNotesMarker() {
  const span = document.createElement("span");
  span.className = "deck-has-notes";
  span.textContent = "📝";
  span.title = "This deck has study notes";
  return span;
}

export function buildLocalDeckRow(deck, cloudById = null, categories = webDeckCategories) {
  const tr = document.createElement("tr");
  // Tagged here rather than in decorateDeckRow, which only the Tree renderer
  // calls — Grid and Folder view go through renderDeckRowInto and were leaving
  // their rows unclassed, so every `tr.my-deck-row` rule (row hover, the drag
  // cursor, the whole phone layout) silently skipped the default view.
  tr.classList.add("my-deck-row");
  if (deck.id === state.localDeckId) tr.classList.add("is-current-local-deck");
  const sel = deckSelOf(deck, "local");
  const { count, hasNotes } = deckCardInfo(deck, "local");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.appendChild(createDeckCategoryControl(sel, deck.category, categories, deck.title));

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  // The number lives in its own span so the phone layout can append " cards"
  // to it via ::after and still leave the notes marker last, rather than
  // rendering "24 📝 cards".
  tdCount.append(deckCardCountSpan(count));
  if (hasNotes) {
    tdCount.append(deckNotesMarker());
    tdCount.title = "This deck has study notes";
  }

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.dataset.short = formatLocalDeckSavedDateShort(deck.updatedAt);
  tdSaved.textContent = formatLocalDeckSavedDate(deck.updatedAt);

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  // The flex layout goes on an inner wrapper, not the <td> itself — a table
  // cell with display:flex stops participating in the table's column-track
  // sizing (it gets sized by its flex content instead), which was squeezing
  // this column down to a sliver regardless of its CSS width.
  tdActions.append(buildDeckActions(deck, "local"));

  tr.append(createDeckSelectCell({ ...sel, title: deck.title }), tdTitle, tdCategory, tdCount, tdSaved, deckSyncStatusCell(deck, cloudById), tdActions);
  return tr;
}

// One row for a deck that only exists in the cloud (not yet on this device).
export function buildCloudDeckRow(deck, categories = webDeckCategories) {
  const tr = document.createElement("tr");
  tr.classList.add("my-deck-row", "is-cloud-only-deck");
  const sel = deckSelOf(deck, "cloud");
  const { count, hasNotes } = deckCardInfo(deck, "cloud");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.appendChild(createDeckCategoryControl(sel, deck.category, categories, deck.title));

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  tdCount.append(deckCardCountSpan(count));
  if (hasNotes) tdCount.append(deckNotesMarker());

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.className = "my-deck-cloud-tag";
  tdSaved.textContent = "☁ Cloud";
  tdSaved.title = "In the cloud — tap Load to pull it onto this device";

  const status = deckSyncStatus(deck, null, true);
  const tdSync = document.createElement("td");
  tdSync.dataset.label = "Sync";
  tdSync.classList.add("my-deck-sync", status.cls);
  const syncPill = document.createElement("span");
  syncPill.textContent = status.label;
  tdSync.append(syncPill);
  tdSync.title = status.title;

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  tdActions.append(buildDeckActions(deck, "cloud"));

  tr.append(createDeckSelectCell({ ...sel, title: deck.title }), tdTitle, tdCategory, tdCount, tdSaved, tdSync, tdActions);
  return tr;
}
