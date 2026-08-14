// The All Cards panel's editing model: undo/redo over whole-deck snapshots,
// insert and delete, and drag-to-reorder against the master card order.

import { allCardsRenderId, bumpAllCardsRenderId, ensureAllCardAnswer, openAllCardEditor, renderAllCards, updateAllCardEditButton, updateAllCardStatuses } from "./all-cards.js?v=__BUILD__";
import { updateMeta } from "./card-status.js?v=__BUILD__";
import { showCard } from "./card-view.js?v=__BUILD__";
import { syncResults } from "./study.js?v=__BUILD__";
import { closestElement } from "./swipe.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { draggedAllCardId, setDraggedAllCardId, state } from "../main.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus, showConfirmModal } from "../ui/feedback.js?v=__BUILD__";
import { unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export function closeAllCardsPanel() {
  bumpAllCardsRenderId();
  el.allCardsPanel.hidden = true;
  unlockPageScroll();
}

export function goToCard(cardId) {
  let index = state.cards.findIndex(c => c.id === cardId);
  if (index === -1) {
    // Revert to studying all master cards
    state.cards = state.masterCards.slice();
    index = state.cards.findIndex(c => c.id === cardId);
  }
  if (index !== -1) {
    state.current = index;
    state.previewCard = null;
    showCard();
    closeAllCardsPanel();
  } else {
    setStatus("Card not found.", "error");
  }
}

// ── Structural card undo/redo (add / delete / reorder) ─────────────────────
// Deliberately scoped to the card array only, not text edits — question/answer/
// notes textareas already get native per-keystroke undo from the browser, and
// folding those into this stack would replace that fine-grained undo with
// coarse snapshot jumps. Reset whenever a different deck's cards are loaded
// (see resetStudyDeck) so Ctrl+Z can't reach across decks.
export const CARD_UNDO_LIMIT = 50;

export let cardUndoStack = [];

export let cardRedoStack = [];

export function snapshotCardsState() {
  return {
    masterCards: state.masterCards.map((c) => ({ ...c })),
    cards: state.cards.map((c) => ({ ...c })),
    statusById: { ...state.statusById },
    current: state.current,
  };
}

export function pushCardUndoSnapshot(snapshot) {
  cardUndoStack.push(snapshot);
  if (cardUndoStack.length > CARD_UNDO_LIMIT) cardUndoStack.shift();
  cardRedoStack = [];
}

export function resetCardUndoHistory() {
  cardUndoStack = [];
  cardRedoStack = [];
}

export function restoreCardsState(snapshot) {
  state.masterCards = snapshot.masterCards.map((c) => ({ ...c }));
  state.cards = snapshot.cards.map((c) => ({ ...c }));
  state.statusById = { ...snapshot.statusById };
  state.current = state.cards.length ? Math.min(snapshot.current, state.cards.length - 1) : 0;
  state.previewCard = null;
  syncResults();
  updateMeta();
  showCard();
  bumpAllCardsRenderId();
  renderAllCards();
}

export function undoCardAction() {
  if (!cardUndoStack.length) {
    setStatus("Nothing to undo.");
    return;
  }
  cardRedoStack.push(snapshotCardsState());
  restoreCardsState(cardUndoStack.pop());
  scheduleDeckAutosave();
  setStatus("Undid last card change.");
}

export function redoCardAction() {
  if (!cardRedoStack.length) {
    setStatus("Nothing to redo.");
    return;
  }
  cardUndoStack.push(snapshotCardsState());
  restoreCardsState(cardRedoStack.pop());
  scheduleDeckAutosave();
  setStatus("Redid card change.");
}

export function deleteAllCard(cardId) {
  showConfirmModal("Delete this card?", () => {
    pushCardUndoSnapshot(snapshotCardsState());
    state.masterCards = state.masterCards.filter(c => c.id !== cardId);
    state.cards = state.cards.filter(c => c.id !== cardId);
    delete state.statusById[cardId];
    if (state.current >= state.cards.length) {
      state.current = Math.max(0, state.cards.length - 1);
    }
    showCard();
    renderAllCards();
    setStatus(state.deckId ? "Card deleted locally. Sync to update the web deck." : "Card deleted. Ctrl+Z to undo.");
  }, { confirmLabel: "Delete", danger: true });
}

export function setAllCardStatus(cardId, status) {
  if (state.statusById[cardId] === status) {
    delete state.statusById[cardId];
  } else {
    state.statusById[cardId] = status;
  }
  syncResults();
  updateMeta();
  updateAllCardStatuses();
  scheduleDeckAutosave();
}

export function createBlankCard() {
  // Random suffix: bare Date.now() collides when two cards are added within
  // the same millisecond (rapid double-click on Add), and card ids must be
  // globally unique in the cloud (see parseCards).
  return { id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, question: '', answer: '' };
}

export function refreshAllCardsAround(cardId, side = "question") {
  bumpAllCardsRenderId();
  const renderId = allCardsRenderId;
  return renderAllCards().then(async () => {
    if (renderId !== allCardsRenderId) return null;
    const item = Array.from(el.allCardsList.querySelectorAll(".all-card"))
      .find((node) => node.dataset.cardId === cardId);
    if (item && side === "answer") {
      item.classList.add("is-flipped");
      await ensureAllCardAnswer(item);
    }
    if (item) updateAllCardEditButton(item);
    item?.scrollIntoView({ block: "nearest" });
    item?.focus({ preventScroll: true });
    return item || null;
  });
}

export function insertCardAfter(cardId) {
  if (!state.masterCards.length && !state.deckTitle) {
    setStatus("Create a new deck or import one first.", "error");
    return;
  }

  const insertAfterIndex = state.masterCards.findIndex((card) => card.id === cardId);
  if (insertAfterIndex < 0) return;

  const currentCardId = state.cards[state.current]?.id || null;
  const shouldRefreshActiveDeck = activeDeckMatchesMasterOrder();
  pushCardUndoSnapshot(snapshotCardsState());
  const newCard = createBlankCard();
  state.masterCards.splice(insertAfterIndex + 1, 0, newCard);

  if (shouldRefreshActiveDeck) {
    state.cards = state.masterCards.slice();
    state.current = currentCardId
      ? Math.max(0, state.cards.findIndex((item) => item.id === currentCardId))
      : 0;
  }

  state.previewCard = null;
  updateMeta();
  showCard();
  refreshAllCardsAround(newCard.id).then((item) => {
    if (item) openAllCardEditor(item, "question");
  });
  setStatus(state.deckId ? "Card inserted locally. Sync to update the web deck." : "Card inserted.");
}

export function activeDeckMatchesMasterOrder() {
  if (state.cards.length !== state.masterCards.length) return false;
  return state.cards.every((card, index) => card.id === state.masterCards[index]?.id);
}

export function clearAllCardDropTargets() {
  el.allCardsList.querySelectorAll(".all-card").forEach((item) => {
    item.classList.remove("is-dragging", "drop-before", "drop-after");
  });
}

export function finishMasterCardReorder(cardId, shouldRefreshActiveDeck, currentCardId) {
  if (shouldRefreshActiveDeck) {
    state.cards = state.masterCards.slice();
    state.current = currentCardId
      ? Math.max(0, state.cards.findIndex((item) => item.id === currentCardId))
      : Math.min(state.current, Math.max(state.cards.length - 1, 0));
  }

  state.previewCard = null;
  syncResults();
  updateMeta();
  showCard();

  bumpAllCardsRenderId();
  const renderId = allCardsRenderId;
  renderAllCards().then(() => {
    if (renderId !== allCardsRenderId) return;
    const movedItem = Array.from(el.allCardsList.querySelectorAll(".all-card"))
      .find((item) => item.dataset.cardId === cardId);
    movedItem?.scrollIntoView({ block: "nearest" });
    movedItem?.focus({ preventScroll: true });
  });
  setStatus(state.deckId ? "Card order updated locally. Sync to update the web deck." : "Card order updated.");
}

export function reorderMasterCard(cardId, targetCardId, placement) {
  if (!cardId || !targetCardId || cardId === targetCardId) return;

  const fromIndex = state.masterCards.findIndex((card) => card.id === cardId);
  const targetIndex = state.masterCards.findIndex((card) => card.id === targetCardId);

  if (fromIndex < 0 || targetIndex < 0) return;

  const currentCardId = state.cards[state.current]?.id || null;
  const shouldRefreshActiveDeck = activeDeckMatchesMasterOrder();
  const beforeSnapshot = snapshotCardsState();
  const [card] = state.masterCards.splice(fromIndex, 1);
  let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  if (fromIndex < insertIndex) insertIndex -= 1;
  insertIndex = Math.min(Math.max(insertIndex, 0), state.masterCards.length);

  if (insertIndex === fromIndex) {
    state.masterCards.splice(fromIndex, 0, card);
    return;
  }

  state.masterCards.splice(insertIndex, 0, card);
  pushCardUndoSnapshot(beforeSnapshot);
  finishMasterCardReorder(cardId, shouldRefreshActiveDeck, currentCardId);
}

export function allCardDropPlacement(item, event) {
  const rect = item.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

export function markAllCardDropTarget(item, placement) {
  clearAllCardDropTargets();
  item.classList.add(placement === "after" ? "drop-after" : "drop-before");
  const draggedItem = Array.from(el.allCardsList.querySelectorAll(".all-card"))
    .find((node) => node.dataset.cardId === draggedAllCardId);
  draggedItem?.classList.add("is-dragging");
}

export function handleAllCardDragStart(event) {
  const item = closestElement(event.target, ".all-card");
  if (!item || closestElement(event.target, "button, a, input, textarea")) {
    event.preventDefault();
    return;
  }

  setDraggedAllCardId(item.dataset.cardId);
  item.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedAllCardId);
}

export function handleAllCardDragOver(event) {
  if (!draggedAllCardId) return;
  const item = closestElement(event.target, ".all-card");
  if (!item) return;
  if (item.dataset.cardId === draggedAllCardId) {
    clearAllCardDropTargets();
    item.classList.add("is-dragging");
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  markAllCardDropTarget(item, allCardDropPlacement(item, event));
}

export function handleAllCardDrop(event) {
  if (!draggedAllCardId) return;
  const item = closestElement(event.target, ".all-card");
  if (!item || item.dataset.cardId === draggedAllCardId) return;

  event.preventDefault();
  const placement = allCardDropPlacement(item, event);
  const droppedCardId = draggedAllCardId;
  setDraggedAllCardId("");
  clearAllCardDropTargets();
  reorderMasterCard(droppedCardId, item.dataset.cardId, placement);
}
