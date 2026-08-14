// Switching a card between rendered and raw editing, and committing the edit.
//
// An edit in flight must be committed before anything navigates away, or the
// text is silently lost — which is why several unrelated paths call in here.

import { createBlankCard, pushCardUndoSnapshot, snapshotCardsState } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { navigateCard } from "../cards/deck-actions.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { saveDeckToLibrarySync } from "../library/local-library.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { scrollTextareaToOffset } from "../notes/caret.js?v=__BUILD__";
import { hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { journalPendingDeckWrites, scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus } from "./feedback.js?v=__BUILD__";

// Commit any in-progress edit into the session before the tab is hidden or closed.
export function flushWorkingDeck() {
  try {
    commitEditIfActive();
  } catch (error) {
    console.warn("Could not commit active edit before save", error);
  }
  // The working-deck localStorage snapshot that used to be taken here is gone —
  // it was write-only (see persistWorkingDeck) and on a large deck it meant a
  // multi-megabyte synchronous JSON.stringify on every single app switch, which
  // on a phone PWA is constant. The durable save below is the one that matters.
  //
  // If the tab/process is killed right after this — the whole reason this
  // handler exists — an edit committed above but not yet flushed by the
  // debounced scheduleDeckAutosave() timer would otherwise never reach the
  // library, and the next reconcile wouldn't even know it happened.
  //
  // saveDeckToLibrarySync, deliberately NOT the async saveDeckToLibrary: this
  // runs from pagehide/visibilitychange, and there is no guarantee an awaited
  // IndexedDB round trip gets to complete before the page is torn down — an
  // OS killing a backgrounded phone app doesn't wait for pending disk I/O.
  // The sync version reads the (already cache-resident, see its own comment)
  // previous snapshot with zero I/O, so by the time this line returns the
  // write has genuinely been issued — pendingDeckWrites already reflects it —
  // and journalPendingDeckWrites below has something real to write down.
  saveDeckToLibrarySync({ silent: true });
  // That write itself still reaches IndexedDB asynchronously in the
  // background. Mirror it into a synchronous localStorage journal so the next
  // boot can replay it — without this, the last edit before a phone kills the
  // backgrounded app is lost.
  journalPendingDeckWrites();
}


export function commitEditIfActive() {
  const sides = [
    { side: "question", view: el.questionView, edit: el.questionEdit, toolbar: el.questionEditToolbar, renderToolbar: el.questionRenderToolbar, btn: el.editQuestionBtn },
    { side: "answer",   view: el.answerView,   edit: el.answerEdit,   toolbar: el.answerEditToolbar,   renderToolbar: el.answerRenderToolbar,   btn: el.editAnswerBtn },
  ];
  const card = state.cards[state.current];
  let committed = false;
  for (const { side, view, edit, toolbar, renderToolbar, btn } of sides) {
    if (view.hidden === false) continue; // not in edit mode for this side
    committed = true;
    if (card) {
      const newValue = edit.value.trim();
      // A card with no question is dropped outright by loadDeckSnapshot on the
      // next deck load, so committing a blank one destroys the card — and the
      // next push then deletes it from the cloud too. Discard the empty edit and
      // keep what was there. (A blank ANSWER is legitimate: every quick_notes
      // pin is front-only, which is why only the question is guarded.)
      if (side === "question" && !newValue) {
        setStatus("Question cannot be empty — kept the previous text.", "error");
      } else {
        if (side === "question") card.question = newValue;
        else card.answer = newValue;
        const masterIndex = state.masterCards.findIndex(c => c.id === card.id);
        if (masterIndex > -1) {
          if (side === "question") state.masterCards[masterIndex].question = newValue;
          else state.masterCards[masterIndex].answer = newValue;
        }
      }
    }
    view.hidden = false;
    edit.hidden = true;
    edit.value = "";
    if (toolbar) toolbar.hidden = true;
    if (renderToolbar) renderToolbar.hidden = false;
    if (btn) {
      btn.classList.remove('is-editing');
      btn.title = side === "question" ? "Edit question" : "Edit answer";
    }
  }
  return committed;
}

// Whether the user has explicitly asked to see the card as raw markdown. Every
// flip used to drop back to the rendered view, so editing both sides of a card
// meant re-tapping ✎ after each flip. Only the EXPLICIT toggles (the ✎ buttons,
// Ctrl+E, triple-click) write this — never the blur-driven commit, which is
// exactly what tapping the card to flip triggers on the way out of the side you
// were editing, and which would otherwise clear the preference every time.
// Reset in showCard, so arriving at a different card always starts rendered.
export let cardRawModePreferred = false;

// Setter: an imported binding is read-only, and cards/card-view.js records the preference when a card is shown.
export function setCardRawModePreferred(value) {
  cardRawModePreferred = value;
}

// Carries that choice across a flip: the newly-shown side opens in whichever
// mode was last chosen instead of always resetting to rendered.
export function applyCardRawModePreference() {
  if (!state.cards[state.current]) return;
  const shownSide = state.flipped ? "answer" : "question";
  const hiddenSide = state.flipped ? "question" : "answer";
  const viewFor = (side) => (side === "answer" ? el.answerView : el.questionView);

  // Commit the side we just turned away from. Tapping the card to flip normally
  // blurs its textarea and the blur handler does this, but a flip from anywhere
  // that doesn't move focus (Ctrl+E, a swipe, the nav buttons) would otherwise
  // leave that editor open behind the now-hidden face — so it reappeared, still
  // open, the next time the card was flipped back.
  if (viewFor(hiddenSide)?.hidden) toggleEditMode(hiddenSide, { remember: false });

  if (!cardRawModePreferred) return;
  const view = viewFor(shownSide);
  if (!view || view.hidden) return; // already raw on this side
  toggleEditMode(shownSide, { remember: false });
}

// `cursorOffset` (raw-markdown character index) places the caret there instead
// of at the start of the text — used by the triple-click handler so switching to
// raw mode doesn't lose your place, the same way enterNotesEditing does it.
// `remember: false` opts out of updating cardRawModePreferred, for the toggles
// that are a side effect of something else (a blur, a flip) rather than a
// deliberate choice.
export function toggleEditMode(side, { cursorOffset = null, remember = true } = {}) {
  const isQuestion = side === 'question';
  const btn = isQuestion ? el.editQuestionBtn : el.editAnswerBtn;
  const view = isQuestion ? el.questionView : el.answerView;
  const edit = isQuestion ? el.questionEdit : el.answerEdit;
  const toolbar = isQuestion ? el.questionEditToolbar : el.answerEditToolbar;
  const renderToolbar = isQuestion ? el.questionRenderToolbar : el.answerRenderToolbar;
  const currentCard = state.cards[state.current];

  if (!currentCard) return;

  const isEditing = view.hidden;
  hideNotesSelectionButton();
  if (remember) cardRawModePreferred = !isEditing;

  if (!isEditing) {
    view.hidden = true;
    edit.hidden = false;
    if (toolbar) toolbar.hidden = false;
    if (renderToolbar) renderToolbar.hidden = true;
    edit.value = isQuestion ? currentCard.question : currentCard.answer;
    if (btn) {
      btn.classList.add('is-editing');
      btn.title = 'Back to preview';
    }
    refreshHighlightBackdrop(edit);
    edit.focus();
    // Assigning .value leaves the caret at the very end in most browsers, so
    // always place it explicitly — a matched offset when we have one, otherwise
    // the top of the text. Never let a failed match silently dump you at the end.
    const pos = cursorOffset != null
      ? Math.max(0, Math.min(cursorOffset, edit.value.length))
      : 0;
    edit.setSelectionRange(pos, pos);
    scrollTextareaToOffset(edit, pos);
  } else {
    const typed = edit.value.trim();
    // A card with no question is dropped by loadDeckSnapshot on the next deck
    // load, so committing a blank one silently destroys the card — and the next
    // push deletes it from the cloud too. This path also runs on BLUR, so it
    // discards the empty edit and keeps the existing question rather than
    // refusing to close and trapping focus in the textarea. (A blank ANSWER is
    // legitimate: every quick_notes pin is front-only.)
    const rejected = isQuestion && !typed;
    const newValue = rejected ? currentCard.question : typed;

    if (!rejected) {
      if (isQuestion) {
        currentCard.question = newValue;
      } else {
        currentCard.answer = newValue;
      }

      const masterIndex = state.masterCards.findIndex(c => c.id === currentCard.id);
      if (masterIndex > -1) {
        if (isQuestion) state.masterCards[masterIndex].question = newValue;
        else state.masterCards[masterIndex].answer = newValue;
      }
    }

    view.hidden = false;
    edit.hidden = true;
    if (toolbar) toolbar.hidden = true;
    if (renderToolbar) renderToolbar.hidden = false;
    if (btn) {
      btn.classList.remove('is-editing');
      btn.title = isQuestion ? 'Edit question' : 'Edit answer';
    }

    renderMarkdown(view, newValue, true).then(() => {
      if (isQuestion) scheduleLiveQuestionFit();
    });

    if (rejected) {
      setStatus("Question cannot be empty — kept the previous text.", "error");
      return;
    }

    scheduleDeckAutosave();
    setStatus(state.deckId ? "Card updated locally. Sync to update the web deck." : "Card updated.");
  }
}


export function addBlankCardAtCursor() {
  if (!state.masterCards.length && !state.deckTitle) {
    setStatus("Create a new deck or import one first.", "error");
    return;
  }
  // From zero cards there's no "current" card to navigate from — land
  // directly on the new sole card instead of animating navigateCard(1),
  // which assumes a real current card and would overshoot to the
  // deck-complete summary.
  const wasEmpty = state.masterCards.length === 0;
  pushCardUndoSnapshot(snapshotCardsState());
  const newCard = createBlankCard();
  const insertAt = wasEmpty ? 0 : state.current + 1;
  state.masterCards.splice(insertAt, 0, newCard);
  state.cards.splice(insertAt, 0, newCard);
  if (wasEmpty) {
    state.current = 0;
    showCard();
  } else {
    navigateCard(1, "next");
  }
  setStatus("Card added. Click the edit icon to modify it.");
}
