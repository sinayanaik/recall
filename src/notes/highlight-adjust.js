// "Adjust": resizing a highlight that already exists.
//
// There was no way to do it. Selecting more words and pressing highlight again
// either turned the old highlight off (the selection overlapped it, so it was
// read as "re-select this one") or wrapped a second highlight round the first,
// and selecting fewer said "already highlighted". On a phone, where a selection
// is made with handles that are hard to land precisely the first time, that
// meant a highlight one word short could only be fixed by removing it and
// starting again — and its note went with it.
//
// So the mark menu offers it directly. The highlight's words are selected,
// with the reader's handles on them (src/notes/touch-selection.js), a bar says
// what to do, and ✓ moves the highlight to whatever is selected by then — the
// same colour and the same note, more words or fewer (adjustHighlightAt in
// src/format/highlight-edit.js). ✕, Escape, or the selection going away
// cancels, and nothing is written.
//
// While it is up the selection pill is hidden (styles/24-highlight-tools.css):
// its buttons would act on the selection as a NEW one, which is the confusion
// this exists to remove.

import { el } from "../core/dom.js?v=__BUILD__";
import { adjustHighlightAt } from "../format/highlight-edit.js?v=__BUILD__";
import { renderedSelectionStrings } from "../format/locate-selection.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { clearTouchSelection, selectRangeWithHandles } from "./touch-selection.js?v=__BUILD__";

export const ADJUSTING_CLASS = "is-adjusting-highlight";

let barEl = null;
let adjustRef = null;

export function isHighlightAdjustOpen() {
  return adjustRef != null;
}

function ensureAdjustBar() {
  if (barEl?.isConnected) return barEl;
  barEl = document.createElement("div");
  barEl.className = "highlight-adjust-bar";
  barEl.hidden = true;
  barEl.setAttribute("role", "toolbar");
  barEl.setAttribute("aria-label", "Adjust the highlight");
  barEl.innerHTML = '<span class="highlight-adjust-hint">Drag the handles to cover the words you want</span>'
    + '<button type="button" class="highlight-adjust-cancel" data-adjust="cancel" aria-label="Cancel">&#10005;</button>'
    + '<button type="button" class="highlight-adjust-apply" data-adjust="apply">&#10003; Apply</button>';
  // pointerdown + preventDefault, like every floating control over a selection:
  // a click would first collapse the very selection being applied.
  barEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("[data-adjust]");
    if (!button) return;
    if (button.dataset.adjust === "apply") applyHighlightAdjust();
    else endHighlightAdjust();
  });
  document.body.appendChild(barEl);
  return barEl;
}

// The mark's own words, without the fold the badge pass appends inside it.
function markWordsRange(mark) {
  const range = document.createRange();
  range.selectNodeContents(mark);
  const badge = mark.lastElementChild?.classList?.contains("hl-note-badge") ? mark.lastElementChild : null;
  if (badge) range.setEndBefore(badge);
  return range;
}

// `ref` is whatever the notes mark handlers key a highlight by (a ref from
// highlightRefAt, which survives other highlights being made meanwhile).
export function startHighlightAdjust(mark, ref) {
  if (!mark || ref == null) return;
  endHighlightAdjust();
  const range = markWordsRange(mark);
  if (!selectRangeWithHandles(range)) {
    // Not a touch screen: the native selection is the handles. A mouse drag
    // or a shift-click re-selects, and ✓ takes whatever is selected then.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    try { selection?.addRange(range); } catch (_) { return; }
  }
  adjustRef = ref;
  document.body.classList.add(ADJUSTING_CLASS);
  ensureAdjustBar().hidden = false;
}

export function applyHighlightAdjust() {
  if (adjustRef == null) return;
  const sel = renderedSelectionStrings(el.notesView);
  if (!sel) {
    showToast("Select the words the highlight should cover, then tap Apply.", "error");
    return;
  }
  const ref = adjustRef;
  endHighlightAdjust({ keepSelection: true });
  adjustHighlightAt(ref, sel);
  clearTouchSelection();
  window.getSelection()?.removeAllRanges();
}

export function endHighlightAdjust({ keepSelection = false } = {}) {
  if (adjustRef == null && (!barEl || barEl.hidden)) return;
  adjustRef = null;
  document.body.classList.remove(ADJUSTING_CLASS);
  if (barEl) barEl.hidden = true;
  if (!keepSelection) {
    clearTouchSelection();
    window.getSelection()?.removeAllRanges();
  }
}

export function initHighlightAdjust() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isHighlightAdjustOpen()) endHighlightAdjust();
    if (event.key === "Enter" && isHighlightAdjustOpen()) {
      event.preventDefault();
      applyHighlightAdjust();
    }
  });
}
