// The per-deck and bulk actions on the My Decks list: open, categorise,
// delete.

import { closeWebDeckExportMenus, loadWebDeck, touchLocalDeckAccess } from "../cloud/web-decks.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { exportMyDeck } from "../export/decks.js?v=__BUILD__";
import { forgetFolderTree, normalizeDeckCategory } from "./folders.js?v=__BUILD__";
import { mdIcon } from "./my-decks-icons.js?v=__BUILD__";
import { myDeckPayload, myDeckSelKey, setMyDeckCategory } from "./my-decks-selection.js?v=__BUILD__";
import { closeAllCardsPanel, decksUnderFolder, deleteDeckEverywhere, flushWorkingDeck, loadDeckFromLibrary, normalizeCardStatus, renderMyDecksList, resetStudyDeck, setViewMode, showCard, state, syncResults } from "../main.js?v=__BUILD__";
import { closeMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { chooseDeckCategory } from "../ui/pickers.js?v=__BUILD__";

export function createDeckExportControl(sel, deckTitle, { compact = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-export-wrap";

  const button = document.createElement("button");
  button.className = compact ? "bulk-action-btn bulk-export icon-action" : "bulk-action-btn bulk-export";
  button.type = "button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = "Export deck";
  button.setAttribute("aria-label", `Export ${deckTitle || "Untitled"}`);
  button.innerHTML = mdIcon("download");
  if (!compact) {
    const label = document.createElement("span");
    label.className = "md-btn-label";
    label.textContent = "Export";
    button.append(label);
  }

  const menu = document.createElement("div");
  menu.className = "web-deck-export-menu";
  menu.hidden = true;

  [
    ["pdf", "Cornell PDF"],
    ["html", "Standalone HTML"],
    ["doc", "Word (.docx)"],
    ["markdown", "Markdown"],
    ["json", "JSON"],
    ["sql", "SQL"]
  ].forEach(([format, label]) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      exportMyDeck(sel, format);
    });
    menu.appendChild(item);
  });

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldOpen = menu.hidden;
    closeWebDeckExportMenus(menu);
    menu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
  });

  wrap.append(button, menu);
  return wrap;
}

export async function loadSelectedMyDecks(selections) {
  if (!selections.length) return;

  if (selections.length === 1) {
    const sel = selections[0];
    // Persist the outgoing deck before its in-memory state is replaced (see
    // the per-row Load handler for why the flush matters).
    flushWorkingDeck();
    if (sel.localId) {
      if (await loadDeckFromLibrary(sel.localId)) {
        touchLocalDeckAccess(sel.localId);
        closeMyDecksPanel();
        showToast("Deck loaded");
      }
    } else if (sel.deckId) {
      closeMyDecksPanel();
      loadWebDeck(sel.deckId);
    }
    return;
  }

  setStatus(`Loading ${selections.length} decks...`);
  try {
    const payloads = [];
    for (const sel of selections) payloads.push(await myDeckPayload(sel));
    flushWorkingDeck();

    const combinedCards = [];
    const combinedStatusById = {};
    const usedIds = new Set();
    const titles = [];
    let combinedCategory = "";
    payloads.forEach((payload) => {
      titles.push(payload.deck.title || "Untitled");
      if (!combinedCategory) combinedCategory = normalizeDeckCategory(payload.deck.category);
      payload.cards.forEach((card) => {
        // Older decks may carry deterministic ids that collide across decks —
        // remint on collision so statuses/navigation stay per-card.
        let id = String(card.id);
        while (usedIds.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
        usedIds.add(id);
        combinedCards.push({ id, question: card.question, answer: card.answer });
        const status = normalizeCardStatus(card.status);
        if (status) combinedStatusById[id] = status;
      });
    });

    state.deckId = null;
    // Fresh combined deck — detach from any previously-loaded library entry so
    // its first autosave creates a NEW deck instead of overwriting that one.
    state.localDeckId = null;
    state.masterCards = combinedCards;
    resetStudyDeck(state.masterCards);
    state.statusById = combinedStatusById;
    state.current = 0;
    state.deckTitle = `Combined: ${titles.join(", ")}`.slice(0, 80);
    state.deckCategory = combinedCategory || defaultDeckCategory;
    state.sourceTitle = state.deckTitle;
    state.importTitleHint = state.deckTitle;
    state.notes = "";
    setViewMode("cards");

    syncResults();
    closeAllCardsPanel();
    closeMyDecksPanel();
    showCard();
    setStatus(`Loaded ${selections.length} decks.`);
    showToast(`Loaded ${selections.length} decks · ${combinedCards.length} cards`);
  } catch (error) {
    console.error("Failed to load selected decks", error);
    setStatus("Failed to load selected decks.", "error");
    showToast("Couldn't load selected decks", "error");
  }
}

export async function categorizeSelectedMyDecks(selections) {
  if (!selections.length) return;
  const category = await chooseDeckCategory();
  if (category === null) return;

  setStatus(`Updating category for ${selections.length} deck${selections.length === 1 ? "" : "s"}...`);
  let failed = 0;
  for (const sel of selections) {
    try {
      await setMyDeckCategory(sel, category);
    } catch (error) {
      failed += 1;
      console.error("Failed to update deck category", sel, error);
    }
  }
  renderMyDecksList();
  if (failed) {
    setStatus(`Category updated, but ${failed} deck${failed === 1 ? "" : "s"} failed.`, "error");
    showToast(`Couldn't update ${failed} deck${failed === 1 ? "" : "s"}`, "error");
  } else {
    setStatus("Deck categories updated.");
    showToast(`Set category "${normalizeDeckCategory(category)}" on ${selections.length} deck${selections.length === 1 ? "" : "s"}`);
  }
}

// `folders` are the checked folder paths (see selectedMyFolders). Their decks
// are already flattened into `selections`; the paths are needed on top of that
// so the folder itself goes away instead of lingering as an empty "0 decks"
// shell. An empty folder is a valid delete on its own, hence no deck guard.
export function deleteSelectedMyDecks(selections, folders = []) {
  if (!selections.length && !folders.length) return;

  const deckPart = `${selections.length} ${selections.length === 1 ? "deck" : "decks"}`;
  const folderPart = `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`;
  const what = folders.length
    ? (selections.length ? `${folderPart} and ${deckPart}` : folderPart)
    : deckPart;

  showConfirmModal(
    `Delete ${what} from this device and the cloud? This cannot be undone.`,
    async () => {
      setStatus(`Deleting ${what}...`);
      // Snapshot which decks are being removed BEFORE deleting, so a folder is
      // only forgotten when the delete empties it. Under an active search a
      // folder keeps decks the filter hid, and those still imply the folder.
      const deletedKeys = new Set(selections.map(myDeckSelKey));
      const emptiedByThisDelete = folders.filter((path) =>
        decksUnderFolder(path).every((entry) => deletedKeys.has(myDeckSelKey(entry.sel)))
      );

      let cloudFailures = 0;
      for (const sel of selections) {
        const { cloudError } = await deleteDeckEverywhere({ localId: sel.localId, deckId: sel.deckId });
        if (cloudError) cloudFailures += 1;
      }
      emptiedByThisDelete.forEach(forgetFolderTree);

      renderMyDecksList();
      if (cloudFailures) {
        showToast("Deleted here — cloud delete will retry on next sync", "info");
      } else {
        showToast(`Deleted ${what} everywhere`, "info");
      }
      setStatus(`Deleted ${what}.`);
    },
    { confirmLabel: "Delete All", danger: true }
  );
}

// Shared deck helpers used by both the table rows and the grid tiles, so the two
// presentations stay in lock-step. `kind` is "local" | "cloud".
export function deckSelOf(deck, kind) {
  return kind === "cloud"
    ? { localId: null, deckId: String(deck.id) }
    : { localId: deck.id, deckId: deck.deckId || null };
}

export function deckCardInfo(deck, kind) {
  const count = kind === "cloud"
    ? (Array.isArray(deck.cards) ? deck.cards[0]?.count : deck.cardCount)
    : deck.cardCount;
  const hasNotes = kind === "cloud" ? Boolean(String(deck.notes || "").trim()) : Boolean(deck.hasNotes);
  return { count: count ?? null, hasNotes };
}

// Loads a deck into the study view. Persists the outgoing deck first — the
// autosave debounce resets on every edit, so a pending timer can hold all
// edits/marks since the last pause; without this flush, switching decks before it
// fires would drop them.
export async function loadDeckEntry(deck, kind) {
  flushWorkingDeck();
  // Closed BEFORE the load in both branches. The cloud branch always did; the
  // local one — the common path — closed it only after `await
  // loadDeckFromLibrary`, which itself awaits an IndexedDB read and an
  // autosave flush. So pressing Load on a local deck left the panel sitting
  // there, unchanged, for the whole load: the press looked ignored right up
  // until the deck appeared. Nothing about the load needs the panel open, and
  // the failure path below re-reports through the same toast either way.
  closeMyDecksPanel();
  if (kind === "cloud") {
    loadWebDeck(deck.id);
  } else if (await loadDeckFromLibrary(deck.id)) {
    touchLocalDeckAccess(deck.id);
    showToast(`Loaded "${deck.title || "deck"}"`);
  }
}
