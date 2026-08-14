// Creating a deck, in the library or in a folder.

import { closeAllCardsPanel } from "./all-cards-edit.js?v=__BUILD__";
import { hasActiveDeck } from "./card-status.js?v=__BUILD__";
import { showCard } from "./card-view.js?v=__BUILD__";
import { resetStudyDeck } from "./study.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { setDeckAutosaveStorageFailed } from "../storage/quota.js?v=__BUILD__";
import { closeImportPanel, closeMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

export function createNewDeck({ title = "New Deck", category = defaultDeckCategory, notesMode = false } = {}) {
  const name = String(title || "New Deck").trim() || "New Deck";
  const cat = normalizeDeckCategory(category);
  const doCreate = () => {
    setDeckAutosaveStorageFailed(false);
    state.deckId = null;
    // Detach from any previously-loaded library entry so this new deck saves as
    // its own entry rather than overwriting the deck that was just open.
    state.localDeckId = null;
    state.deckTitle = name;
    state.deckCategory = cat;
    state.notes = "";
    state.sourceTitle = name;
    state.importTitleHint = name;
    state.masterCards = [];
    resetStudyDeck(state.masterCards);
    setViewMode(notesMode ? "notes" : "cards");
    closeImportPanel();
    closeAllCardsPanel();
    showCard();
    setStatus("Created new deck.");
  };
  if (hasActiveDeck()) {
    showConfirmModal("Create a new deck? Unsaved local progress will be lost.", doCreate, { confirmLabel: "Create New" });
  } else {
    doCreate();
  }
}

// Creates a deck inside a folder from the My Decks library: prompts for a title,
// files it under `folderPath`, closes the panel, and drops the user into the new
// deck in notes mode ready to write. The deck is filed under `folderPath` (set on
// state.deckCategory) and persists to the library + cloud on the first edit via
// autosave — the library never stores a truly empty deck.
export function newDeckInFolder(folderPath = "") {
  const cat = normalizeDeckCategory(folderPath);
  const where = cat === defaultDeckCategory ? "" : ` in "${cat}"`;
  showPromptModal("New deck", `Name your new deck${where}. Start adding notes and cards right away.`, "", (title) => {
    // Empty field, "New Deck" placeholder — falls back to that indicative name
    // if left blank, so the field never needs clearing before typing.
    const name = String(title || "").trim() || "New Deck";
    createNewDeck({ title: name, category: cat, notesMode: true });
    closeMyDecksPanel();
    showToast(`New deck "${name}"${where} — add notes or cards to save it`);
  }, { placeholder: "New Deck" });
}
