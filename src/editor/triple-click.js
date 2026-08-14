// Triple-clicking a rendered paragraph drops you into the raw editor with the
// caret in the same place — matched back by text, since there is no source map.

import { allCardById, openAllCardEditor } from "../cards/all-cards.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { refreshHighlightBackdrop, state } from "../main.js?v=__BUILD__";
import { scrollTextareaToOffset } from "../notes/caret.js?v=__BUILD__";
import { findRawOffsetForRenderedPoint } from "../notes/raw-offset.js?v=__BUILD__";
import { toggleEditMode } from "../ui/edit-mode.js?v=__BUILD__";

// ── Triple-click a rendered card → open its editor, caret at that spot ──────
// Mirrors the notes triple-click-to-edit, reusing findRawOffsetForRenderedPoint.
//
// The flip is NOT deferred while we wait to see whether a second and third
// click follow. It used to be — a 250ms setTimeout on EVERY single click of
// every card in this list — which is a quarter-second of nothing after each
// tap, paid by everyone, to smooth over a gesture almost nobody uses. The
// study card had already made the opposite call for exactly this reason (see
// tripleClickCardToEditor); this list simply never got the same treatment.
//
// Clicks 1 and 2 cancel out, so on click 3 the face under the pointer IS the
// face the user started on — which is what makes `side` below correct without
// any deferral. The card is then flipped back to it before the editor opens,
// because clicks 1 and 2 leave the DOM mid-gesture.
export function tripleClickAllCardToEditor(item, rendered, clientX, clientY) {
  const card = allCardById(item.dataset.cardId);
  if (!card) return;
  const side = rendered.closest(".all-card-answer") ? "answer" : "question";
  const source = side === "answer" ? card.answer : card.question;
  const offset = findRawOffsetForRenderedPoint(rendered, source, clientX, clientY);
  // openAllCardEditor only ever ADDS is-flipped (for the answer side), so an
  // odd number of preceding flips would leave the item showing the wrong face
  // behind the editor. Settle it here, as the study card does.
  item.classList.toggle("is-flipped", side === "answer");
  openAllCardEditor(item, side);
  const textarea = item.querySelector(".all-card-editor [data-all-edit-value]");
  if (!textarea) return;
  const pos = offset != null ? Math.max(0, Math.min(offset, textarea.value.length)) : 0;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  // scrollTextareaToOffset measures the highlight mirror, so it has to be
  // painted first — the editor was only just opened with this card's text.
  refreshHighlightBackdrop(textarea);
  scrollTextareaToOffset(textarea, pos);
}

// ── Triple-click a rendered card face → raw editor, caret at that spot ──────
// The notes view and the All Cards list both have this; the study card didn't,
// so there was no way to jump from a spot in the rendered card to the same spot
// in its markdown. Reuses findRawOffsetForRenderedPoint, exactly as the other
// two do.
//
// Unlike All Cards, the flip is NOT deferred while we wait to see whether a
// second and third click follow: a quarter-second of nothing after tapping the
// card would be far worse than the flicker three fast clicks cause, and flipping
// is the card's main gesture. The clicked side is recovered afterwards instead —
// clicks 1 and 2 cancel out, so the face under the pointer on click 3 is the one
// the user started on, and the card is flipped back to it before its editor
// opens.
export function tripleClickCardToEditor(view, clientX, clientY) {
  const card = state.cards[state.current];
  if (!card || view.hidden) return;
  const side = view === el.answerView ? "answer" : "question";
  const offset = findRawOffsetForRenderedPoint(view, side === "answer" ? card.answer : card.question, clientX, clientY);
  const shouldBeFlipped = side === "answer";
  if (state.flipped !== shouldBeFlipped) {
    state.flipped = shouldBeFlipped;
    el.card.classList.toggle("is-flipped", state.flipped);
  }
  // Clears the browser's own triple-click word/paragraph selection, which would
  // otherwise sit behind the editor and make hasCardTextSelection() true.
  window.getSelection()?.removeAllRanges();
  toggleEditMode(side, { cursorOffset: offset });
}
