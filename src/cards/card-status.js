// Known / review / uncategorised, and the counts shown for the open deck.

import { syncResults, uncategorizedCards } from "./study.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
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
  // A folder open as one document is not a deck: it has no record to rename and
  // no category of its own, so both pencils would be editing something that
  // does not exist. The decks it is made of are renamed from their own rows in
  // My Decks — or, for the title, by editing the section's `#` heading, which
  // saveFolderDeck writes back as that deck's new name.
  const isFolder = Boolean(state.folderDeck);
  el.editDeckTitleBtn.disabled = !hasDeck || isFolder;
  el.editDeckTitleBtn.title = isFolder ? "Rename each deck from its own row in My Decks" : "Edit deck title";
  if (el.deckCategory) {
    el.deckCategory.textContent = isFolder ? "FOLDER" : normalizeDeckCategory(state.deckCategory);
    el.deckCategory.title = isFolder
      ? `Reading every deck in ${state.folderDeck.path} as one document`
      : `Category: ${normalizeDeckCategory(state.deckCategory)}`;
  }
  if (el.editDeckCategoryBtn) {
    el.editDeckCategoryBtn.disabled = !hasDeck || isFolder;
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
  refreshDocumentTab();
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = !hasDeck || !state.notes.trim();
  if (!hasDeck && state.viewMode !== "cards") setViewMode("cards");
}

// The Document tab exists only for a deck that HAS a document. Shown from
// meta.pdf and nothing else — a tab that is present on every deck and empty on
// all but a handful is a worse answer than a tab that appears when it means
// something.
//
// Called from updateMeta, which every deck load, import and swap already runs,
// so there is no second place that has to remember to keep this in step.
//
// ── ...and the way IN, for a deck that has none ──────────────────────────
//
// The same rule, inverted, decides the drawer's "Attach a PDF" row. That
// question — "once a deck has been created without a PDF there is no option to
// attach one again" — was exactly right: importing a PDF makes a NEW deck, and
// "Re-attach the PDF…" lives inside the Document surface, which does not exist
// until meta.pdf does. So a deck with no document had no route to one at all,
// and a deck WITH one has a better route than this (Re-attach checks the hash;
// this cannot, having nothing to check against). One flag, two controls, and
// they are never both offered.
export function refreshDocumentTab() {
  const button = el.viewModeToggle?.querySelector('[data-view-mode="document"]');
  if (!button) return;
  const hasDocument = Boolean(state.meta?.pdf);
  button.hidden = !hasDocument;
  // The reading rail's own Document icon, in the same pass. Two controls saying
  // the same thing have to be hidden by the same line, or the one nobody
  // remembered opens an empty surface on a deck that has no document.
  const railButton = el.readingRailTray?.querySelector('[data-view-mode="document"]');
  if (railButton) railButton.hidden = !hasDocument;
  // Only for a deck that is actually open: attaching a paper to nothing is not a
  // thing to offer, and the row would sit there on the welcome screen.
  if (el.attachPdfBtn) el.attachPdfBtn.hidden = hasDocument || !hasActiveDeck();
  // A deck whose document has gone away underneath the open view (offloaded on
  // another device and pulled down) must not leave the reader parked on a
  // surface with no tab to leave by.
  if (!hasDocument && state.viewMode === "document") setViewMode("notes");
}
