// The snapshot shape a deck is saved and loaded as.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "../cards/study.js?v=__BUILD__";
import { applyDeckMetaCategories, quickNoteCategoryForCard } from "../cloud/web-decks.js?v=__BUILD__";
import { deckStorageKey } from "../core/constants.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { revokeLocalImageUrls } from "../images/outbox.js?v=__BUILD__";
import { humanizeSourceTitle, sourceFileTitle } from "../import/parse-cards.js?v=__BUILD__";
import { importTargetCategory } from "../import/staging.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { isQuickNotesDeck, state } from "../main.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { discardNotesEditingForDeckSwap } from "../notes/notes-view.js?v=__BUILD__";
import { currentDeckKey, currentReadingAnchor, currentReadingAnchorDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { setDeckAutosaveStorageFailed } from "./quota.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

export function deckSnapshot() {
  return {
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: state.deckTitle || "",
    deckCategory: normalizeDeckCategory(state.deckCategory),
    notes: state.notes || "",
    sourceTitle: state.sourceTitle || state.deckTitle || "",
    importTitleHint: state.importTitleHint || "",
    deckId: state.deckId,
    current: Number.isFinite(state.current) ? state.current : 0,
    // Deck-level bag: whatever this deck's meta already carried (a synced
    // reading position, etc.), plus the quick_notes category set overlaid on
    // top when this is that deck — autosave must carry both, or saving the
    // deck erases the names/colours every card chip resolves against, or
    // drops per-deck fields set elsewhere back to nothing.
    ...(() => {
      const metaBag = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}) };
      if (isQuickNotesDeck(state.deckId, state.deckTitle) && state.quickNoteCategories.length) {
        metaBag.quickNoteCategories = state.quickNoteCategories;
      }
      // Cross-device reading-position resume: piggyback whatever the in-memory
      // scroll tracker last captured, IF it was captured for THIS deck — a
      // stale anchor from a deck scrolled away from must never leak into a
      // different deck's meta (see captureCurrentReadingAnchor). No dedicated
      // write schedule: this only ever rides along when a save is already
      // happening for some other reason, per the deliberately simple sync
      // strategy — "whenever the sync happens just sync the current location."
      if (currentReadingAnchor && currentReadingAnchorDeckKey === currentDeckKey()) {
        metaBag.readingPosition = currentReadingAnchor;
      }
      return Object.keys(metaBag).length ? { meta: metaBag } : {};
    })(),
    cards: state.masterCards.map((card, index) => {
      const id = card.id || `${index}-${card.question.slice(0, 32)}`;
      return {
        id,
        question: card.question,
        answer: card.answer,
        status: normalizeCardStatus(state.statusById[card.id]),
        // Quick-note subject label. Must round-trip: without it every autosave
        // rewrote the snapshot with no category, and the next reconcile pushed
        // those blanks over the cloud — silently clearing the board.
        category: quickNoteCategoryForCard(card),
        // Preserve the note-link so "Go to notes" survives a save/reload.
        ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
      };
    })
  };
}

export function clearBrowserPersistence() {
  try {
    // themeStorageKey is intentionally kept — setTheme saves the user's theme
    // choice there and initAppForUser restores it on the next boot.
    localStorage.removeItem("flashcards_style_cache");
    // deckStorageKey is cleared on every boot — a refresh should start on the
    // clean home screen, not reopen the last deck. Only credentials, the saved
    // deck library (LOCAL_DECKS_INDEX_KEY / LOCAL_DECK_PREFIX), and styles persist.
    localStorage.removeItem(deckStorageKey);
    // styleStorageKey is intentionally kept — styles persist locally across sessions
  } catch (error) {
    console.warn("Could not clear browser persistence", error);
  }
}

export function loadDeckSnapshot(payload, titleHint = "", append = false) {
  setDeckAutosaveStorageFailed(false);
  if (!payload || !Array.isArray(payload.cards)) {
    throw new Error("Invalid flashcard JSON");
  }

  const usedIds = new Set(append ? state.masterCards.map(c => c.id) : []);
  const statusById = append ? { ...state.statusById } : {};
  const categoryById = append ? { ...state.categoryById } : {};
  const cards = payload.cards
    .map((rawCard, index) => {
      const question = String(rawCard?.question || "").trim();
      const answer = String(rawCard?.answer || "").trim();
      // A card only needs a question — a blank answer is valid (front-only
      // "capture now, fill later" cards, e.g. every quick_notes pin). Dropping
      // answer-blank cards here silently emptied the quick_notes deck on load,
      // while the cloud loader (loadWebDeck) kept them; this aligns the two.
      if (!question) return null;

      let id = String(rawCard.id || `${index}-${question.slice(0, 32)}`);
      while (usedIds.has(id)) id = `${index}-${Math.random().toString(36).slice(2, 6)}-${id}`;
      usedIds.add(id);

      const status = normalizeCardStatus(rawCard?.status || payload.statusById?.[id]);
      if (status) statusById[id] = status;

      const card = { id, question, answer };
      // Quick-note subject label, mirrored into categoryById so the board and
      // the next autosave both see it.
      if (rawCard?.category) {
        card.category = String(rawCard.category);
        categoryById[id] = card.category;
      }
      // Carry the note-link through the snapshot round-trip so cards keep their
      // "Go to notes" jump after a reload or a My Decks re-open.
      if (rawCard?.noteAnchor && typeof rawCard.noteAnchor === "object") card.noteAnchor = rawCard.noteAnchor;
      return card;
    })
    .filter(Boolean);

  const payloadNotes = String(payload.notes || "");
  if (!cards.length && !payloadNotes.trim()) {
    throw new Error("No cards in flashcard JSON");
  }

  if (append) {
    state.cards = state.cards.concat(cards);
    state.masterCards = state.masterCards.concat(cards);
    state.statusById = statusById;
    state.categoryById = categoryById;
  } else {
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
    // Reset with the deck — a stale map from the previously open deck would
    // otherwise leak its labels onto same-id cards and get pushed to the cloud.
    state.categoryById = categoryById;
    applyDeckMetaCategories(payload.meta, payload.deckId, payload.deckTitle);
    // Carry the whole meta bag forward — see the loadWebDeck sibling of this
    // line for why (per-deck fields beyond quick_notes categories).
    state.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    state.current = Math.min(Math.max(Number(payload.current) || 0, 0), cards.length);
    state.deckTitle = String(payload.deckTitle || "").trim() || humanizeSourceTitle(titleHint);
    // Importing a JSON snapshot INTO a folder overrides the category the
    // snapshot itself carries — the folder you aimed the import at is the more
    // recent, more explicit instruction. importTargetCategory is a no-op (it
    // returns the fallback) for every other caller, including loadDeckFromLibrary.
    state.deckCategory = importTargetCategory(normalizeDeckCategory(payload.deckCategory || payload.category));
    state.deckId = payload.deckId || null;
    // Detach from any previously-loaded library entry. loadDeckFromLibrary sets
    // the correct localDeckId immediately after this returns; every other caller
    // (file open, snapshot import) genuinely wants a fresh, unattached deck so
    // its first autosave doesn't overwrite the deck that was open before.
    state.localDeckId = null;
    state.sourceTitle = String(payload.sourceTitle || "").trim() || sourceFileTitle(titleHint) || state.deckTitle;
    state.importTitleHint = String(payload.importTitleHint || "").trim() || titleHint;
    // MUST come before state.notes is replaced. The raw editor's <textarea> is
    // not part of `state` and survives a deck swap holding the note being left;
    // the next keystroke then copies it into state.notes and the autosave
    // writes the OLD note's body over the NEW deck's record. See the block
    // comment on discardNotesEditingForDeckSwap.
    discardNotesEditingForDeckSwap();
    // See the identical call in loadWebDeck: the outgoing deck's queued-image
    // blob URLs are released here rather than held until pagehide.
    revokeLocalImageUrls();
    state.notes = payloadNotes;
    setViewMode("notes");
    // Cross-device resume — see the identical call in loadWebDeck for why
    // flash/smooth are both off. Only reached on this non-append branch, so
    // merge-importing more cards into an already-open deck never triggers it.
    if (state.meta?.readingPosition) scheduleNoteJump(state.meta.readingPosition, { flash: false, smooth: false });
  }
  syncResults();
  closeAllCardsPanel();
  showCard();
}
