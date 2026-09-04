// Known / review / uncategorised, and the counts shown for the open deck.

import { syncResults, uncategorizedCards } from "./study.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { deckHasHandwrittenPages } from "../documents/doc-slot.js?v=__BUILD__";
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
  // Several decks open as one document are not a deck: there is no record to
  // rename and no category of its own, so both pencils would be editing
  // something that does not exist. The decks it is made of are renamed from
  // their own rows in My Decks — or, for the title, by editing the section's
  // `#` heading, which saveFolderDeck writes back as that deck's new name.
  const isFolder = Boolean(state.folderDeck);
  el.editDeckTitleBtn.disabled = !hasDeck || isFolder;
  el.editDeckTitleBtn.title = isFolder ? "Rename each deck from its own row in My Decks" : "Edit deck title";
  if (el.deckCategory) {
    el.deckCategory.textContent = isFolder
      ? (state.folderDeck.path ? "FOLDER" : "MERGED")
      : normalizeDeckCategory(state.deckCategory);
    el.deckCategory.title = isFolder
      ? (state.folderDeck.path
        ? `Reading every deck in ${state.folderDeck.path} as one document`
        : `Reading ${state.folderDeck.members.length} decks as one document — edits are saved back to each of them`)
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
  // Was el.exportBtn, the ☰ drawer's "⇓ Export Cards…" row, which no longer
  // exists — its menu was row for row what the ⇓ beside the tabs already
  // offers. Same predicate, pointed at that ⇓: nothing to export is nothing to
  // export whichever button asks.
  if (el.viewExportBtn) {
    el.viewExportBtn.disabled = !hasDeck && state.results.known.length === 0 && state.results.review.length === 0;
  }
  el.replayKnownBtn.disabled = state.results.known.length === 0;
  el.replayReviewBtn.disabled = state.results.review.length === 0;
  el.replayUncategorizedBtn.disabled = uncategorizedCards().length === 0;
  el.replayAllBtn.disabled = state.masterCards.length === 0;
  if (el.viewModeToggle) el.viewModeToggle.hidden = !hasDeck;
  refreshDocumentTab();
  refreshHandwritingTab();
  // No second disable for the notes export. That line drove el.exportNotesBtn,
  // the drawer's own row, and the ⇓ that replaced it is not per-surface — it
  // carries the cards, the notes and the document, so greying it out for an
  // empty NOTE would take the other two with it. The empty case is answered
  // where it always was, by exportNotesFlat's "No notes to export."
  if (!hasDeck && state.viewMode !== "cards") setViewMode("cards");
}

// The Document tab, on every deck that is open.
//
// It used to be shown from meta.pdf and nothing else, on the argument that a tab
// present on every deck and empty on all but a handful is a worse answer than a
// tab that appears when it means something. The argument was sound and its cost
// turned out to be the thing readers actually hit: the Document surface owns
// every route to a PDF — Re-attach, and now Attach — so a deck WITHOUT one had
// no panel in which to be offered one, and "attach a paper to this deck" ended
// up as a row in the ☰ drawer, under Decks, between Import and Sync Now. You
// have to be told it is there.
//
// So the tab is always on a deck, and an empty one is not an empty surface: it
// opens to the offer (renderAttachDocumentPrompt in src/documents/pdf-view.js).
// A tab that says "you could read a paper alongside this" is worth its place in
// a way that a blank one would not be.
//
// Called from updateMeta, which every deck load, import and swap already runs,
// so there is no second place that has to remember to keep this in step.
//
// ── The drawer row is still here, and still the inverse ──────────────────
//
// It is a second route to the same function now rather than the only one, and
// that is fine — it is where someone who learned it will look. It stays hidden
// on a deck that already HAS a document, because there Re-attach is the right
// control: it checks the file's hash against the highlights measured on it, and
// attach cannot, having nothing to check against.
export function refreshDocumentTab() {
  const button = el.viewModeToggle?.querySelector('[data-view-mode="document"]');
  if (!button) return;
  const hasDocument = Boolean(state.meta?.pdf);
  const showTab = hasActiveDeck();
  button.hidden = !showTab;
  // The reading rail's own Document icon, in the same pass. Two controls saying
  // the same thing have to be hidden by the same line, or the one nobody
  // remembered opens a surface the other one says is not there.
  const railButton = el.readingRailTray?.querySelector('[data-view-mode="document"]');
  if (railButton) railButton.hidden = !showTab;
  // Published on the stage so CSS can stand the document's own controls down on
  // a deck that has none — ☰ contents, ◐ dark page, ▣ region and ⋯ are lifted
  // into the view-mode row for the whole session and shown from "is the Document
  // stage visible", which is now true for a deck with nothing to read. Four inert
  // controls over an "Attach a PDF" panel is exactly the fault
  // styles/37-document-chrome.css opens by describing, the other way round.
  el.documentStage?.classList.toggle("has-no-document", !hasDocument);
  // The ☰ drawer's "Attach a PDF" row was shown and hidden here, from exactly
  // these two facts. The row is gone: the attach panel this class reveals says
  // the same thing on the surface the paper is about to appear on, with the
  // same picker and the same attachPdfToOpenDeck behind it, so the drawer row
  // was a second door onto one room — in the app menu, for something scoped to
  // one open deck.
  // Closing the deck must still take the reader off the surface — there is no
  // tab to leave by once the toggle itself is hidden. A deck whose document went
  // away underneath the open view (offloaded on another device and pulled down)
  // no longer needs this: it lands on the attach panel, which explains itself.
  if (!showTab && state.viewMode === "document") setViewMode("notes");
}

// ── ...and the Write tab, by the same rule ─────────────────────────────────
//
// On every open deck, for the reason above: handwriting used to be a row in the
// ☰ drawer opening a full page, which is a surface you have to be TOLD is there.
// A deck with no pages yet is not an empty surface either — it opens to the
// offer of a notebook (renderStartNotebookPrompt in src/documents/pdf-view.js),
// which is one press, because there is no state of this surface that is not a
// page.
export function refreshHandwritingTab() {
  const button = el.viewModeToggle?.querySelector('[data-view-mode="handwriting"]');
  if (!button) return;
  const showTab = hasActiveDeck();
  button.hidden = !showTab;
  const railButton = el.readingRailTray?.querySelector('[data-view-mode="handwriting"]');
  if (railButton) railButton.hidden = !showTab;
  // The same published fact the Document surface uses for its own controls: a
  // deck with no notebook has nothing to add a page to, nothing to tear out and
  // no paper to change, so those controls stand down rather than sitting inert
  // over the offer of a notebook. A deck still carrying its notebook in the
  // document slot counts as having one — it is migrated the moment the tab is
  // opened (ensureNotebookDocument), and a control that flickered off and back
  // on across that would be worse than one that was simply right.
  el.documentStage?.classList.toggle("has-no-notebook", !deckHasHandwrittenPages());
  if (!showTab && state.viewMode === "handwriting") setViewMode("notes");
}
