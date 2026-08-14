// The My Decks list: which decks are selected, what they are called, and what
// category they are in.

import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { applyWebDeckCategory, fetchWebDeckPayload, normalizeWebDeckPayload, updateWebDeckTitle } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { categoriesFromDecks, setKnownWebDeckCategories, webDeckCategories } from "./categories.js?v=__BUILD__";
import { decksUnderFolder } from "./folder-tree.js?v=__BUILD__";
import { normalizeDeckCategory } from "./folders.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "./local-library.js?v=__BUILD__";
import { renderMyDecksList } from "./my-decks-render.js?v=__BUILD__";
import { renameDeckInLibrary } from "./tombstones.js?v=__BUILD__";
import { readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";

export function formatLocalDeckSavedDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

// A phone row can't spare 120px for "Jul 25, 2026, 10:11 PM". The compact form
// rides along on the cell as data-short and the ≤720px CSS swaps to it, so the
// full timestamp is still what's rendered (and read out) at every other width.
export function formatLocalDeckSavedDateShort(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function myDecksEmptyRow(message) {
  return `<tr><td colspan="7" class="web-decks-empty">${escapeHtml(message)}</td></tr>`;
}

export async function localDeckPayload(localId) {
  try {
    const snapshot = await readDeckSnapshot(localId);
    if (!snapshot) return null;
    const meta = readLocalDeckIndex().find((m) => m.id === localId) || {};
    return normalizeWebDeckPayload({
      id: snapshot.deckId || localId,
      title: snapshot.deckTitle || meta.title || "Untitled",
      category: snapshot.deckCategory || meta.category,
      notes: snapshot.notes || "",
      // The deck-level bag — the quick_notes managed category set, plus the
      // pinned-from source anchors. myDeckPayload PREFERS this local path, so
      // dropping it here is what made every backup/export write `meta: {}` and
      // lose the names and colours each note's label resolves against.
      meta: snapshot.meta,
      current_card_index: snapshot.current || 0,
      created_at: meta.createdAt || null,
      updated_at: meta.updatedAt || null,
      last_accessed_at: meta.accessedAt || meta.updatedAt || null
    }, (snapshot.cards || []).map((card, index) => ({
      id: card.id,
      deck_id: snapshot.deckId || localId,
      question: card.question,
      answer: card.answer,
      position: index,
      status: card.status,
      // Quick-note subject label — same reason as `meta` above. Without it a
      // backup restores every note as Uncategorized, and an exported .sql
      // (whose UPDATE sets category = EXCLUDED.category) would clear the
      // labels outright if it were ever run against a live database.
      category: card.category || null,
      updated_at: card.updatedAt || null
    })));
  } catch (error) {
    console.warn("Could not read local deck snapshot", localId, error);
    return null;
  }
}

export async function myDeckPayload({ localId = null, deckId = null } = {}) {
  if (localId) {
    const payload = await localDeckPayload(localId);
    if (payload) return payload;
  }
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    return fetchWebDeckPayload(deckId);
  }
  throw new Error("Deck data unavailable — cloud-only decks need a connection");
}

// The single source of truth for the title search, shared by the renderer
// (paintMyDecks) and by folder selection below. They MUST agree: the folder
// tree, its "N decks" label, and what checking that folder selects are all
// derived from this — if selection saw decks the render had filtered out, a
// folder Delete would destroy decks the user could neither see nor count.
export function myDecksSearchTerm() {
  return (state.myDecksSearch || "").trim().toLowerCase();
}

export function myDeckMatchesSearch(deck) {
  const search = myDecksSearchTerm();
  if (!search) return true;
  return String(deck.title || "").toLowerCase().includes(search);
}

// Checking a folder is equivalent to checking every deck inside it (recursively,
// via decksUnderFolder — same helper folder rename/move/delete already use) — so
// bulk actions Just Work on folders without exportSelectedMyDecks/deleteSelectedMyDecks/
// etc. needing to know folders exist at all. Deduped so a deck both individually
// checked AND covered by a checked ancestor folder isn't acted on twice.
export function selectedMyDecks() {
  const host = el.myDecksBody || el.myDecksListTable;
  const direct = Array.from(host?.querySelectorAll(".my-deck-row-checkbox:checked") || [])
    .map((checkbox) => ({
      localId: checkbox.dataset.localId || null,
      deckId: checkbox.dataset.deckId || null
    }));
  const fromFolders = Array.from(host?.querySelectorAll(".my-folder-row-checkbox:checked") || [])
    .map((checkbox) => checkbox.dataset.folderPath)
    .filter(Boolean)
    // Search-filtered to match the folder row the user actually clicked: while a
    // search is active that row is built from — and counts — only the matching
    // decks, so selecting it must not reach the ones hiding behind the filter.
    .flatMap((path) => decksUnderFolder(path).filter(myDeckMatchesSearch).map((entry) => entry.sel));

  const seen = new Set();
  const merged = [];
  [...direct, ...fromFolders].forEach((sel) => {
    const key = `${sel.localId || ""}\u0000${sel.deckId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(sel);
  });
  return merged;
}

// The checked folders themselves. selectedMyDecks() above flattens them away
// into decks, which is all Export/Load/Categorize need — but Delete also has to
// remove the folder, so it needs the paths that selection came from.
export function selectedMyFolders() {
  const host = el.myDecksBody || el.myDecksListTable;
  return Array.from(host?.querySelectorAll(".my-folder-row-checkbox:checked") || [])
    .map((checkbox) => checkbox.dataset.folderPath)
    .filter(Boolean);
}

export function myDeckSelKey(sel) {
  return `${sel.localId || ""} ${sel.deckId || ""}`;
}

export function updateMyDecksBulkBar() {
  // Query the whole body host, not just the table — tiles live in a sibling grid.
  const host = el.myDecksBody || el.myDecksListTable;
  const allBoxes = host?.querySelectorAll(".my-deck-row-checkbox, .my-folder-row-checkbox") || [];
  const checkedBoxes = host?.querySelectorAll(".my-deck-row-checkbox:checked, .my-folder-row-checkbox:checked") || [];
  // Counts what a bulk action will actually touch — a checked folder stands in
  // for the decks inside it — rather than the raw number of ticked boxes. The
  // folder count is spelled out separately because it isn't derivable from the
  // deck count: an empty folder contributes 0 decks but is still deletable.
  const deckCount = selectedMyDecks().length;
  const folderCount = selectedMyFolders().length;
  if (el.myDecksSelectedCount) {
    const bits = [];
    if (folderCount) bits.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    bits.push(`${deckCount} deck${deckCount === 1 ? "" : "s"}`);
    el.myDecksSelectedCount.textContent = folderCount ? bits.join(" · ") : String(deckCount);
  }
  if (el.myDecksBulkActions) el.myDecksBulkActions.hidden = checkedBoxes.length === 0;
  if (el.myDecksSelectAllCheckbox) {
    el.myDecksSelectAllCheckbox.checked = allBoxes.length > 0 && checkedBoxes.length === allBoxes.length;
    el.myDecksSelectAllCheckbox.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < allBoxes.length;
  }
}

// The bare selection checkbox, shared by table rows (wrapped in a <td>) and grid
// tiles. Both keep the same `.my-deck-row-checkbox` class + data-* so bulk
// selection works identically regardless of how the deck is drawn.
export function createDeckSelectControl({ localId = null, deckId = null, title = "" } = {}) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "my-deck-row-checkbox web-deck-row-checkbox";
  if (localId) checkbox.dataset.localId = localId;
  if (deckId) checkbox.dataset.deckId = deckId;
  checkbox.setAttribute("aria-label", `Select ${title || "deck"}`);
  checkbox.addEventListener("change", updateMyDecksBulkBar);
  return checkbox;
}

export function createDeckSelectCell({ localId = null, deckId = null, title = "" } = {}) {
  const td = document.createElement("td");
  td.dataset.label = "Select";
  td.className = "web-deck-select-cell";
  td.appendChild(createDeckSelectControl({ localId, deckId, title }));
  return td;
}

// Folder counterpart to createDeckSelectControl — same class family (so
// select-all and the bulk-bar counters see it) plus data-folder-path instead
// of a deck id, which selectedMyDecks() expands via decksUnderFolder().
export function createFolderSelectControl(path, name = "") {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "my-folder-row-checkbox web-deck-row-checkbox";
  checkbox.dataset.folderPath = path;
  checkbox.setAttribute("aria-label", `Select folder ${name || path}`);
  // Stop click/dragstart from bubbling to the row/tile's own handlers (enter
  // folder, start a re-parent drag) — checking the box should only check it.
  checkbox.addEventListener("click", (e) => e.stopPropagation());
  checkbox.addEventListener("change", updateMyDecksBulkBar);
  return checkbox;
}

// Offline / not-yet-uploaded path: update the local library only. Bumping
// updatedAt counts as an edit, so the next reconcile pushes the new category.
export async function setLocalDeckCategory(localId, category) {
  const normalized = normalizeDeckCategory(category);
  return withDeckLock(localId, async () => {
    const index = readLocalDeckIndex();
    const entry = index.find((e) => e.id === localId);
    if (!entry) return;
    entry.category = normalized;
    entry.updatedAt = new Date().toISOString();
    writeLocalDeckIndex(index);
    const snapshot = await readDeckSnapshot(localId);
    if (snapshot) {
      snapshot.deckCategory = normalized;
      writeDeckSnapshot(localId, snapshot);
    }
  });
}

export async function setMyDeckCategory({ localId = null, deckId = null } = {}, category) {
  const normalized = normalizeDeckCategory(category);
  setKnownWebDeckCategories([...webDeckCategories, normalized]);
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    // Updates the cloud row and keeps the local mirror's meta/timestamp aligned.
    await applyWebDeckCategory(deckId, normalized);
  } else if (localId) {
    await setLocalDeckCategory(localId, normalized);
    if (state.localDeckId === localId) {
      state.deckCategory = normalized;
      updateMeta();
    }
  } else {
    throw new Error("Offline — a cloud-only deck can't be categorized right now");
  }
  return normalized;
}

export function createDeckCategoryControl(sel, currentCategory, categories, deckTitle) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-category-editor";

  const select = document.createElement("select");
  select.className = "web-deck-category-select";
  select.setAttribute("aria-label", `Category for ${deckTitle || "Untitled"}`);

  categoriesFromDecks([], [...categories, currentCategory]).forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "+ New category";
  select.appendChild(newOption);
  select.value = normalizeDeckCategory(currentCategory);

  const newRow = document.createElement("div");
  newRow.className = "web-deck-category-new";
  newRow.hidden = true;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New category";
  input.autocomplete = "off";
  input.spellcheck = false;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";

  const commit = async (nextCategory) => {
    select.disabled = true;
    saveBtn.disabled = true;
    try {
      setStatus("Updating deck category...");
      const normalized = await setMyDeckCategory(sel, nextCategory);
      setStatus("Deck category updated.");
      showToast(`Category set to "${normalized}"`);
      renderMyDecksList();
    } catch (error) {
      console.error("Failed to update deck category", error);
      setStatus("Failed to update deck category.", "error");
      showToast("Couldn't update category", "error");
      select.disabled = false;
      saveBtn.disabled = false;
      select.value = normalizeDeckCategory(currentCategory);
    }
  };

  select.addEventListener("change", () => {
    if (select.value === "__new__") {
      newRow.hidden = false;
      input.value = "";
      input.focus();
      return;
    }
    const nextCategory = normalizeDeckCategory(select.value);
    if (nextCategory === normalizeDeckCategory(currentCategory)) return;
    commit(nextCategory);
  });

  const saveNewCategory = () => {
    if (!input.value.trim()) {
      setStatus("Category cannot be empty.", "error");
      input.focus();
      return;
    }
    commit(input.value);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveNewCategory();
    if (event.key === "Escape") {
      newRow.hidden = true;
      select.value = normalizeDeckCategory(currentCategory);
    }
  });
  saveBtn.addEventListener("click", saveNewCategory);
  cancelBtn.addEventListener("click", () => {
    newRow.hidden = true;
    select.value = normalizeDeckCategory(currentCategory);
  });

  newRow.append(input, saveBtn, cancelBtn);
  wrap.append(select, newRow);
  return wrap;
}

export function renameMyDeck({ localId = null, deckId = null } = {}, currentTitle = "") {
  showPromptModal("Rename Deck", "", currentTitle || "Untitled", async (nextTitle) => {
    const title = nextTitle.trim();
    if (!title) {
      setStatus("Deck title cannot be empty.", "error");
      return;
    }
    try {
      if (localId) await renameDeckInLibrary(localId, title);
      if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
        // Best-effort immediate cloud rename (also re-aligns the local
        // mirror's timestamp); on failure the local rename, whose updatedAt
        // was just bumped, is pushed by the next reconcile anyway.
        try {
          await updateWebDeckTitle(deckId, title);
        } catch (error) {
          console.warn("Cloud rename failed — the next sync will push it", error);
        }
      }
      if ((localId && state.localDeckId === localId) || (deckId && state.deckId && String(state.deckId) === String(deckId))) {
        state.deckTitle = title;
        state.sourceTitle = title;
        updateMeta();
      }
      renderMyDecksList();
      setStatus("Deck renamed.");
      showToast(`Renamed to "${title}"`);
    } catch (error) {
      console.error("Failed to rename deck", error);
      setStatus("Failed to rename deck.", "error");
      showToast("Couldn't rename deck", "error");
    }
  });
}
