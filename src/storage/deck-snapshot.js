// The snapshot shape a deck is saved and loaded as.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "../cards/study.js?v=__BUILD__";
import { applyDeckMetaCategories, quickNoteCategoryForCard } from "../cloud/web-decks.js?v=__BUILD__";
import { deckStorageKey } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { revokeLocalImageUrls } from "../images/outbox.js?v=__BUILD__";
import { humanizeSourceTitle, sourceFileTitle } from "../import/parse-cards.js?v=__BUILD__";
import { importTargetCategory } from "../import/staging.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { maybePromptBookmarkJump } from "../notes/bookmark.js?v=__BUILD__";
import { discardNotesEditingForDeckSwap } from "../notes/notes-view.js?v=__BUILD__";
import { betterReadingPosition, newerReadingPosition } from "../notes/reading-position.js?v=__BUILD__";
import { currentDeckKey, currentReadingAnchor, currentReadingAnchorDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { isQuickNotesDeck } from "../quick-notes/categories.js?v=__BUILD__";
import { setDeckAutosaveStorageFailed } from "./quota.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";
import { activeDocSlot, documentTabForOpenDeck, hasDocSlot, onDocumentSurface } from "../documents/doc-slot.js?v=__BUILD__";
import { deckTabKey } from "../storage/deck-tab.js?v=__BUILD__";

// Is there anything in this deck at all?
//
// "Cards or notes" was a complete answer right up until a deck could BE a
// document. A freshly imported paper is neither: no cards yet, an empty note
// (it is yours to write in), and a PDF plus its highlights in meta. Under the
// old test that deck was indistinguishable from an empty one — and this
// predicate is consulted on BOTH sides of the round trip, so getting it wrong
// broke both:
//
//   saving  — every autosave a PDF deck scheduled was a silent no-op, so an
//             afternoon of highlighting was discarded on reload;
//   loading — loadDeckSnapshot threw "No cards in flashcard JSON", which
//             loadDeckFromLibrary reports as "That saved deck is corrupted and
//             could not be loaded". Clicking a freshly imported paper did
//             nothing but show that, on a deck that was completely intact.
//
// One function, both callers (see deckHasNothingToSave in local-library.js), so
// they cannot drift apart again — which is precisely how the second half of
// this survived the first half being fixed.
export function deckPayloadHasContent({ cards, notes, meta } = {}) {
  if (Array.isArray(cards) ? cards.length : cards) return true;
  if (String(notes || "").trim()) return true;
  // `pages` is the notebook that came before real paper, and this line is not
  // optional. Such a deck has no cards, an empty note and no document, so
  // without it this predicate calls it empty — and it is consulted on both
  // sides of the round trip, which means the deck would not merely stop
  // autosaving, it would refuse to LOAD, reporting itself corrupted. The reader
  // would be told an afternoon of handwriting was damaged when it is sitting
  // intact in the file. It stays until a deck cannot be carrying that key any
  // more, which is not a date anyone can name.
  if (Array.isArray(meta?.pages) && meta.pages.length) return true;
  // Either document. A notebook is a deck's own generated paper and lives in a
  // slot of its own (src/documents/doc-slot.js); a deck that has one and nothing
  // else has no cards, an empty note and no meta.pdf, so testing only meta.pdf
  // would call it empty — and this predicate is consulted on BOTH sides of the
  // round trip, so such a deck would not merely stop autosaving, it would refuse
  // to load and report itself corrupted.
  return Boolean(meta?.pdf || meta?.notebook);
}

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
      //
      // ...and only when it is the LATER of the two. captureCurrentReadingAnchor
      // only runs while state.viewMode is "notes", but nothing CLEARS the
      // in-memory anchor when the reader leaves that tab — so a deck read in the
      // notes and then in the document kept writing the stale notes anchor over
      // the document position scheduleDocumentPositionSave had just recorded, on
      // every autosave and therefore on every sync. Settled by `at`, through the
      // same rule betterReadingPosition applies between the two stores, rather
      // than by asking which view is up: the pagehide flush legitimately writes
      // this after the reader has already left the view.
      if (currentReadingAnchor && currentReadingAnchorDeckKey === currentDeckKey()) {
        metaBag.readingPosition = newerReadingPosition(currentReadingAnchor, metaBag.readingPosition);
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

// `keepPlace` and `deckKey` are both the sync's, and both are inert for every
// other caller — see loadDeckFromLibrary for what keepPlace suppresses and why.
// `deckKey` exists because this function cannot work out the deck's identity for
// itself: state.localDeckId is assigned on the line AFTER this returns, which is
// the same reason the resume below is in a microtask. Passed in rather than
// read, so that the one thing needing it does not depend on an ordering the rest
// of the function is deliberately free of.
export function loadDeckSnapshot(payload, titleHint = "", append = false, { keepPlace = false, deckKey = null } = {}) {
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
  // `cards` here is the PARSED list (blank-question rows already dropped), not
  // payload.cards — a file of nothing but unusable rows is still empty.
  if (!deckPayloadHasContent({ cards, notes: payloadNotes, meta: payload.meta })) {
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
    // Whatever is being opened here is a real deck, so the folder-as-one-deck
    // mode is over. Cleared HERE rather than in each loader because every path
    // that replaces the open deck comes through this one — library open, cloud
    // open, file/JSON import, backup restore — and a folderDeck left set would
    // send the next save into the previous folder's member decks.
    state.folderDeck = null;
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
    // A PDF deck opens on its PDF tab: the document IS the deck, and
    // landing on an empty Notes tab would look like an import that lost the
    // file. A deck whose only document is a notebook it wrote itself opens on
    // Write, by exactly the same argument — its pages are the deck. (A deck
    // still carrying its notebook in the old `pdf` slot counts as one; it is
    // moved the moment that tab paints.) Every other deck opens on Notes.
    // ── Which surface the reader ends up on ────────────────────────────────
    //
    // Not moved at all on a keepPlace refresh: the sync rewrote the deck under
    // somebody who is reading it, and documentTabForOpenDeck answers "notes" for
    // any deck without a paper — which is the whole of the reported "when sync is
    // happening i am being moved to always Notes panel". Calling setViewMode with
    // the mode already in state.viewMode is what repaints the surface they ARE
    // on: `changed` comes out false, so resetChromeAutoHide and
    // measureChromeHeights stand down and it degenerates to the paint.
    //
    // The one exception is the case where moving them is the correct answer:
    // they are looking at a document that the other device has just removed.
    // Deliberately narrow — a deck whose paper is gone has nothing to show on
    // that tab — and it is exactly the new documentRemovedHere stat.
    // deckKey, not currentDeckKey(): state.localDeckId is assigned on the line
    // AFTER this function returns — the same reason the resume below is in a
    // microtask — so reading it here asks about a deck with no local id and
    // finds nothing remembered, on every library deck.
    if (!keepPlace) setViewMode(documentTabForOpenDeck(state.meta, deckTabKey(state.deckId, deckKey)));
    else if (onDocumentSurface() && !hasDocSlot(activeDocSlot(), state.meta)) setViewMode(documentTabForOpenDeck(state.meta, deckTabKey(state.deckId, deckKey)));
    else setViewMode(state.viewMode);
    // Cross-device resume — see the identical call in loadWebDeck for why
    // flash/smooth are both off and why the local store is consulted alongside
    // the deck's meta. Only reached on this non-append branch, so
    // merge-importing more cards into an already-open deck never triggers it.
    // In a microtask, because currentDeckKey() is not yet the key this deck's
    // position was SAVED under: loadDeckFromLibrary sets state.localDeckId on
    // the line after this function returns, and the key is
    // [deckId, localDeckId, folderPath]. Reading it synchronously here looked up
    // a deck with no local id and found nothing, on every library deck — the
    // common case. A microtask runs after the caller's own synchronous block,
    // which is exactly when the identity is complete.
    //
    // Not on a keepPlace refresh. The reader is already somewhere in this deck
    // and a background sync is not a reason to scroll them to wherever the
    // saved position happens to be — nor to raise a bookmark prompt, which is a
    // question about opening a deck and not about syncing one.
    if (!keepPlace) {
      queueMicrotask(() => {
        const resumeAt = betterReadingPosition(state.meta?.readingPosition, currentDeckKey());
        // ── ...but it must not choose the tab ──────────────────────────────
        //
        // scheduleNoteJump's document branch switches to the Document view by
        // itself when the anchor carries a pdfPage — which was right while the
        // tab a deck opened on was derived from its contents, and is wrong now
        // that the reader's own last choice decides. A paper deck left on the
        // cards was dragged onto the paper a moment after opening, by the
        // resume rather than by the loader, which is a hard thing to see and
        // exactly what the check for this caught.
        //
        // Nothing is lost by skipping it: a document position is resumed by
        // landOnReadingPosition when that document opens, which is the path
        // every other route onto the surface already takes.
        const documentAnchor = Number.isFinite(resumeAt?.pdfPage);
        if (documentAnchor && !onDocumentSurface()) {
          maybePromptBookmarkJump();
        } else if (resumeAt) {
          scheduleNoteJump(resumeAt, { flash: false, smooth: false, resume: true, onSettled: () => maybePromptBookmarkJump() });
        } else {
          maybePromptBookmarkJump();
        }
      });
    }
  }
  syncResults();
  closeAllCardsPanel();
  showCard();
}
