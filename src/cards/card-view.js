// Showing a card, and the transition between two of them.

import { hasActiveDeck, updateMeta } from "./card-status.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "./question-fit.js?v=__BUILD__";
import { syncResults } from "./study.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { resetClozeButton } from "../editor/toolbars.js?v=__BUILD__";
import { cardHasNoteLink } from "../notes/anchors.js?v=__BUILD__";
import { hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { renderDeckEmptyState } from "../sync/indicator.js?v=__BUILD__";
import { maybeShowSwipeHint } from "../ui/deck-header.js?v=__BUILD__";
import { commitEditIfActive, setCardRawModePreferred } from "../ui/edit-mode.js?v=__BUILD__";

export function transitionClassFor(direction, phase) {
  if (!direction) return "";
  const suffix = phase === "in" ? "in" : "out";
  if (direction === "known") return `transition-right-${suffix}`;
  if (direction === "review") return `transition-left-${suffix}`;
  if (direction === "next") return `transition-left-${suffix}`;
  if (direction === "prev") return `transition-right-${suffix}`;
  if (direction > 0) return `transition-down-${suffix}`;
  if (direction < 0) return `transition-up-${suffix}`;
  return "";
}

export function clearCardTransitionClasses() {
  el.card.classList.remove(
    "transition-left-out",
    "transition-left-in",
    "transition-right-out",
    "transition-right-in",
    "transition-up-out",
    "transition-up-in",
    "transition-down-out",
    "transition-down-in"
  );
}

export function buildDeckSummaryHtml() {
  syncResults();
  const total = state.masterCards.length;
  const known = state.results.known.length;
  const review = state.results.review.length;
  const uncategorized = total - known - review;

  const knownPct   = total ? Math.round((known / total) * 100) : 0;
  const reviewPct  = total ? Math.round((review / total) * 100) : 0;
  const uncatPct   = total ? (100 - knownPct - reviewPct) : 0;

  // SVG pie chart using stroke-dasharray on a circle (r=15.9, circumference≈100)
  const r = 15.9155;
  const circ = 2 * Math.PI * r; // ≈100
  const knownArc   = (known / total) * circ || 0;
  const reviewArc  = (review / total) * circ || 0;
  const uncatArc   = (uncategorized / total) * circ || 0;

  // Rotation offsets so segments start at top (-90deg = top)
  const knownOffset   = circ * 0.25; // start at top
  const reviewOffset  = knownOffset - knownArc;
  const uncatOffset   = reviewOffset - reviewArc;

  const isEmpty = total === 0;

  const pieSlices = isEmpty ? `
    <circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--line)" stroke-width="8" stroke-dasharray="${circ} 0"/>
  ` : `
    ${known > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--known,#22c55e)" stroke-width="8"
      stroke-dasharray="${knownArc} ${circ - knownArc}"
      stroke-dashoffset="${knownOffset}"
      class="pie-segment pie-known"/>` : ""}
    ${review > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--review,#f59e0b)" stroke-width="8"
      stroke-dasharray="${reviewArc} ${circ - reviewArc}"
      stroke-dashoffset="${reviewOffset}"
      class="pie-segment pie-review"/>` : ""}
    ${uncategorized > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--muted,#94a3b8)" stroke-width="8"
      stroke-dasharray="${uncatArc} ${circ - uncatArc}"
      stroke-dashoffset="${uncatOffset}"
      class="pie-segment pie-uncat"/>` : ""}
  `;

  return `<div class="deck-summary">
    <div class="deck-summary-header">
      <div class="deck-summary-icon">🎉</div>
      <h2 class="deck-summary-title">Deck Complete!</h2>
      <p class="deck-summary-subtitle">${escapeHtml(state.deckTitle || "All cards reviewed")}</p>
    </div>
    <div class="deck-summary-body">
      <div class="deck-summary-chart-wrap">
        <svg class="deck-summary-pie" viewBox="0 0 42 42" role="img" aria-label="Score breakdown">
          ${pieSlices}
          <text x="21" y="19.5" class="pie-center-num">${total}</text>
          <text x="21" y="24.5" class="pie-center-label">cards</text>
        </svg>
      </div>
      <div class="deck-summary-stats">
        <div class="deck-stat deck-stat-known">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Known</span>
          <span class="deck-stat-count">${known}</span>
          <span class="deck-stat-pct">${knownPct}%</span>
        </div>
        <div class="deck-stat deck-stat-review">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Review</span>
          <span class="deck-stat-count">${review}</span>
          <span class="deck-stat-pct">${reviewPct}%</span>
        </div>
        <div class="deck-stat deck-stat-uncat">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Uncategorized</span>
          <span class="deck-stat-count">${uncategorized}</span>
          <span class="deck-stat-pct">${uncatPct}%</span>
        </div>
      </div>
    </div>
    <div class="deck-summary-actions">
      <button class="deck-summary-btn deck-summary-btn-primary" data-replay="all">↺ Restart All</button>
      <button class="deck-summary-btn deck-summary-btn-review" data-replay="review" ${review === 0 ? "disabled" : ""}>❌ Review (${review})</button>
      <button class="deck-summary-btn deck-summary-btn-uncat" data-replay="uncategorized" ${uncategorized === 0 ? "disabled" : ""}>? Uncategorized (${uncategorized})</button>
      <button class="deck-summary-btn deck-summary-btn-known" data-replay="known" ${known === 0 ? "disabled" : ""}>✅ Known (${known})</button>
    </div>
  </div>`;
}

export async function showCard(direction = 0) {
  hideNotesSelectionButton();
  scheduleDeckAutosave();
  // A raw/rendered choice belongs to the card it was made on — arriving at a
  // different card (navigate, shuffle, replay, deck load) starts rendered again
  // rather than dropping you into a textarea on every card.
  setCardRawModePreferred(false);
  const token = state.transitionToken;
  state.previewCard = null;
  state.flipped = false;
  el.card.classList.remove("is-flipped", "swipe-left", "swipe-right", "is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  clearCardTransitionClasses();
  el.card.style.transform = "";
  const enterClass = transitionClassFor(direction, "in");
  if (enterClass) el.card.classList.add(enterClass);

  const card = state.cards[state.current];
  if (!card) {
    if (state.cards.length > 0) {
      // Deck finished — show rich summary overlay covering the whole card
      if (el.deckSummary) {
        el.deckSummary.innerHTML = buildDeckSummaryHtml();
        el.deckSummary.hidden = false;
      }
      if (el.deckEmptyState) el.deckEmptyState.hidden = true;
      el.card.hidden = false;
      el.card.closest(".quiz-panel")?.classList.add("deck-complete");
    } else {
      // Zero cards — either a freshly created/loaded deck waiting for its
      // first card, or truly nothing loaded. Same container, different copy.
      if (el.deckSummary) el.deckSummary.hidden = true;
      if (el.deckEmptyState) el.deckEmptyState.hidden = false;
      renderDeckEmptyState(hasActiveDeck() ? "active" : "none");
      el.card.hidden = true;
      el.card.closest(".quiz-panel")?.classList.remove("deck-complete");
      el.card.closest(".quiz-panel")?.classList.add("is-deck-empty");
    }
    updateMeta();
    return;
  }

  // Normal card — hide summary overlay and empty state
  if (el.deckSummary) el.deckSummary.hidden = true;
  if (el.deckEmptyState) el.deckEmptyState.hidden = true;
  el.card.hidden = false;
  el.card.closest(".quiz-panel")?.classList.remove("deck-complete", "is-deck-empty");
  maybeShowSwipeHint();
  if (el.goToNotesBtn) el.goToNotesBtn.hidden = !cardHasNoteLink(card);
  await renderMarkdown(el.questionView, card.question, true);
  await renderMarkdown(el.answerView, card.answer, true);
  // Fresh spans render hidden; reset the bulk button label to "Reveal clozes".
  resetClozeButton(el.clozeToggleBtn);
  scheduleLiveQuestionFit();
  updateMeta();
  if (enterClass) {
    window.setTimeout(() => {
      if (state.transitionToken !== token) return;
      el.card.classList.remove(enterClass);
    }, 280);
  }
}

// Next / Prev / Known / Review all land here.
//
// There is deliberately no exit phase. This used to add a `transition-*-out`
// class and then wait a full 210ms before even computing the new card — and the
// 280ms `card-enter` animation still ran afterwards, so a press was ~490ms from
// settled content, the first 210ms of which was nothing happening at all. On
// the four most-pressed buttons in the app that is the whole "the controls feel
// laggy" complaint. The enter animation on its own reads as the same motion
// while the new card is on screen in the same frame as the press. (The card
// flip already refused this exact trade — see the comment there.)
export function animateToCard(direction, updateState) {
  // Still bumped: it invalidates the enter-class cleanup timer showCard sets,
  // so a fast run of presses can't have an earlier one strip the newest class.
  state.transitionToken += 1;
  clearCardTransitionClasses();
  el.card.classList.remove("swipe-left", "swipe-right", "is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
  commitEditIfActive();
  updateState();
  showCard(direction);
}
