// The known/review split of the current deck, and resetting it.

import { resetCardUndoHistory, setCurrentReadingAnchor, setCurrentReadingAnchorDeckKey, state } from "../main.js?v=__BUILD__";

export function syncResults() {
  state.results = {
    known: state.masterCards.filter((card) => state.statusById[card.id] === "known"),
    review: state.masterCards.filter((card) => state.statusById[card.id] === "review")
  };
  state.known = state.results.known.length;
  state.review = state.results.review.length;
}

export function uncategorizedCards() {
  return state.masterCards.filter((card) => !state.statusById[card.id]);
}

// Clears every per-card map that belongs to the deck being replaced. Only ever
// reached from resetStudyDeck's !keepStatuses path, i.e. a genuine deck change —
// each loader assigns the incoming deck's own maps immediately afterwards.
export function resetResults() {
  state.statusById = {};
  // The quick-note label map is deck-scoped exactly like statusById. Left
  // behind, a combined/imported/new deck inherits the previous deck's labels
  // and the next autosave writes them back out as if they were its own.
  state.categoryById = {};
  // Same reasoning for the deck's meta bag (readingPosition, etc.) — a genuine
  // deck change must not carry it over. loadDeckSnapshot/loadWebDeck assign
  // the real value for the incoming deck right after calling resetStudyDeck.
  state.meta = {};
  // The in-memory reading-position tracker is keyed by deck (see
  // currentDeckKey/deckSnapshot), so this isn't strictly required for
  // correctness — but clearing it here too means "belongs to no deck or the
  // currently open one" holds without having to reason about the key check.
  setCurrentReadingAnchor(null);
  setCurrentReadingAnchorDeckKey(null);
  state.previewCard = null;
  state.results = {
    known: [],
    review: []
  };
  state.known = 0;
  state.review = 0;
}

// Resets the study SESSION: original order, back to the first card, nothing
// flipped or previewed. `keepStatuses` decides whether the deck's Known/Review
// marks survive it — they are real user data, not session state, so anything
// that is merely restarting the CURRENT deck must pass true. Every deck-LOAD
// caller leaves it false: those want a clean statusById and assign the incoming
// deck's own immediately afterwards.
export function resetStudyDeck(cards = state.masterCards, { keepStatuses = false } = {}) {
  state.transitionToken += 1;
  state.cards = cards.slice();
  state.current = 0;
  state.previewCard = null;
  state.flipped = false;
  if (keepStatuses) syncResults();
  else resetResults();
  resetCardUndoHistory();
}
