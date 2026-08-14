// Moving through the deck: flip, next/previous, known/review, shuffle, replay.

import { animateToCard, showCard } from "./card-view.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "./study.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { applyCardRawModePreference, commitEditIfActive, resetCardDrag, scheduleDeckAutosave, state } from "../main.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

export function flipCard() {
  if (!state.previewCard && !state.cards[state.current]) return;
  state.flipped = !state.flipped;
  el.card.classList.toggle("is-flipped", state.flipped);
  applyCardRawModePreference();
}

export function navigateCard(direction, animationDirection = direction) {
  if (state.previewCard || !state.cards.length) return;

  // Allow going one step past the last card to show the end-of-deck summary
  if (direction > 0 && state.current >= state.cards.length - 1) {
    if (state.current >= state.cards.length) {
      return; // Already on summary, don't try to go past it
    }
    animateToCard(animationDirection, () => {
      state.current = state.cards.length; // triggers summary in showCard
      state.previewCard = null;
      state.flipped = false;
    });
    return;
  }

  const nextIndex = Math.min(Math.max(state.current + direction, 0), state.cards.length - 1);
  if (nextIndex === state.current) return;
  setStatus(direction > 0 ? "Moved to next card." : "Moved to previous card.");
  animateToCard(animationDirection, () => {
    state.current = nextIndex;
    state.previewCard = null;
    state.flipped = false;
  });
}

export function moveCard(result) {
  const card = state.previewCard || state.cards[state.current];
  if (!card) return;
  el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
  state.statusById[card.id] = result;
  syncResults();
  scheduleDeckAutosave();

  if (state.previewCard) {
    commitEditIfActive();
    state.previewCard = null;
    setStatus(`Moved card to ${result}.`);
    showCard();
    return;
  }

  animateToCard(result, () => {
    state.current += 1;
  });
}

export function shuffleCards() {
  // Clear any active inline edit and reset gesture/drag state first, so the
  // freshly shown card is immediately tappable/swipeable — matches what
  // resetQuiz/replayDeck do before re-rendering.
  commitEditIfActive();
  resetCardDrag();
  for (let index = state.cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [state.cards[index], state.cards[swap]] = [state.cards[swap], state.cards[index]];
  }
  state.current = 0;
  setStatus("Deck shuffled.");
  showCard();
}

// The toolbar's ⟳ Restart. A SESSION reset — back to the first card in the
// deck's own order — and nothing more. It must NOT clear the Known/Review
// marks: showCard() below schedules an autosave, so a wipe here is written to
// the library within 400ms and pushed to the cloud (and every other device) by
// the next reconcile, with no confirmation and no undo. The deck-summary's
// "↺ Restart All" goes through replayDeck("all"), which has always preserved
// them — the two restarts used to disagree about what "restart" means.
export function resetQuiz() {
  commitEditIfActive();
  resetStudyDeck(state.masterCards, { keepStatuses: true });
  setStatus("Studying all cards.");
  showCard();
}

export function replayDeck(scope) {
  commitEditIfActive();
  syncResults();
  const selected = scope === "known"
    ? state.results.known.slice()
    : scope === "review"
      ? state.results.review.slice()
      : scope === "uncategorized"
        ? uncategorizedCards()
        : state.masterCards.slice();

  if (!selected.length) {
    setStatus(scope === "uncategorized" ? "No uncategorized cards to replay." : `No ${scope} cards to replay.`, "error");
    return;
  }

  state.cards = selected;
  state.current = 0;
  state.previewCard = null;
  setStatus(scope === "all" ? "Studying all cards." : `Studying ${scope} cards.`);
  showCard();
}
