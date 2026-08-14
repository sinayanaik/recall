// Known / review / uncategorised, and the counts shown for the open deck.

import { syncResults, uncategorizedCards } from "./study.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { setSyncIndicator } from "../sync/indicator.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

export function cardStatusLabel(status) {
  if (status === "known") return "Known";
  if (status === "review") return "Review";
  return "Uncategorized";
}

export function setCardStatusBadge(badge, status) {
  if (!badge) return;
  badge.dataset.status = status;
  badge.textContent = cardStatusLabel(status);
}

export function updateActiveCardStatusBadges() {
  const card = state.previewCard || state.cards[state.current] || null;
  const status = card ? normalizeCardStatus(state.statusById[card.id]) : "";
  setCardStatusBadge(el.questionStatusBadge, status);
  setCardStatusBadge(el.answerStatusBadge, status);
}

// A deck "exists" for UI purposes once it's been created/loaded (has a title),
// has cards, or has study notes — so a freshly created deck with zero cards
// still shows its title/toolbar instead of looking like nothing is loaded.
export function hasActiveDeck() {
  return Boolean(state.deckTitle) || state.masterCards.length > 0 || Boolean(state.notes.trim());
}

export function updateMeta() {
  const total = state.cards.length;
  const finished = Math.min(state.current, total);
  const hasDeck = hasActiveDeck();
  syncResults();
  updateActiveCardStatusBadges();
  el.deckTitle.textContent = state.deckTitle;
  el.deckTitle.title = state.deckTitle;
  el.deckTitleWrap.hidden = !hasDeck;
  if (el.deckMeta2Row) el.deckMeta2Row.hidden = !hasDeck;
  if (!hasDeck) setSyncIndicator("idle");
  el.editDeckTitleBtn.disabled = !hasDeck;
  if (el.deckCategory) {
    el.deckCategory.textContent = normalizeDeckCategory(state.deckCategory);
    el.deckCategory.title = `Category: ${normalizeDeckCategory(state.deckCategory)}`;
  }
  if (el.editDeckCategoryBtn) {
    el.editDeckCategoryBtn.disabled = !hasDeck;
  }
  el.positionText.textContent = state.previewCard ? "Preview" : total ? `${Math.min(state.current + 1, total)}/${total}` : "0/0";
  el.scoreText.textContent = `Known ${state.known} / Review ${state.review}`;
  const knownPct = total ? (state.results.known.length / state.masterCards.length) * 100 : 0;
  const reviewPct = total ? (state.results.review.length / state.masterCards.length) * 100 : 0;
  const remainingPct = total ? Math.max(0, (finished / total) * 100 - knownPct - reviewPct) : 0;
  if (el.progressKnown) el.progressKnown.style.width = `${knownPct}%`;
  if (el.progressReview) el.progressReview.style.width = `${reviewPct}%`;
  el.progressBar.style.width = `${remainingPct}%`;

  const disabled = !state.previewCard && (total === 0 || state.current >= total);
  el.prevCardBtn.disabled = Boolean(state.previewCard) || total === 0 || state.current <= 0;
  // Next stays enabled on the LAST card — one more step shows the end-of-deck
  // summary (same as swiping/arrow keys); it only disables on the summary itself.
  el.nextCardBtn.disabled = Boolean(state.previewCard) || total === 0 || state.current >= total;
  el.knownBtn.disabled = disabled;
  el.reviewBtn.disabled = disabled;
  el.shuffleBtn.disabled = total < 2;
  el.resetBtn.disabled = total === 0;
  el.allCardsBtn.disabled = state.masterCards.length === 0;
  el.exportBtn.disabled = !hasDeck && state.results.known.length === 0 && state.results.review.length === 0;
  el.replayKnownBtn.disabled = state.results.known.length === 0;
  el.replayReviewBtn.disabled = state.results.review.length === 0;
  el.replayUncategorizedBtn.disabled = uncategorizedCards().length === 0;
  el.replayAllBtn.disabled = state.masterCards.length === 0;
  if (el.viewModeToggle) el.viewModeToggle.hidden = !hasDeck;
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = !hasDeck || !state.notes.trim();
  if (!hasDeck && state.viewMode !== "cards") setViewMode("cards");
}
