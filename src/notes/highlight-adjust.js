// "Adjust": resizing a highlight that already exists, in a note.
//
// There was no way to do it. Selecting more words and pressing highlight again
// either turned the old highlight off (the selection overlapped it, so it was
// read as "re-select this one") or wrapped a second highlight round the first,
// and selecting fewer said "already highlighted". On a phone, where a selection
// is made with handles that are hard to land precisely the first time, that
// meant a highlight one word short could only be fixed by removing it and
// starting again — and its note went with it.
//
// So the mark menu offers it directly. Two grips sit on the highlight's ends
// (src/ui/adjust-handles.js — the app's own, on pointer events, so they are
// there on a desktop and a tablet as well as a phone), the words they cover are
// previewed in the highlight's colour, and ✓ moves the highlight there — the
// same colour and the same note, more words or fewer (adjustHighlightAt in
// src/format/highlight-edit.js). ✕, Escape, or the note re-rendering under the
// grips cancels, and nothing is written.
//
// While it is up the selection pill is hidden (styles/24-highlight-tools.css):
// its buttons would act on a selection as a NEW highlight, which is the
// confusion this exists to remove.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { markGroupSpanAt } from "../format/highlight.js?v=__BUILD__";
import { adjustHighlightAt } from "../format/highlight-edit.js?v=__BUILD__";
import { highlightRefIndex } from "../format/highlight-notes.js?v=__BUILD__";
import { renderedRangeStrings } from "../format/locate-selection.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import {
  ADJUSTING_CLASS, applyAdjustHandles, closeAdjustHandles, isAdjustHandlesOpen, openAdjustHandles
} from "../ui/adjust-handles.js?v=__BUILD__";
import { markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import { caretInRoot, clearTouchSelection } from "./touch-selection.js?v=__BUILD__";
import { caretFromPoint } from "./raw-offset.js?v=__BUILD__";

export { ADJUSTING_CLASS };

// The marks being adjusted paint nothing of their own while the grips are up —
// the preview is the highlight — so shrinking one visibly shrinks it.
export const ADJUST_SOURCE_CLASS = "is-adjust-source";

// One Custom Highlight per colour: a ::highlight() rule cannot read a data
// attribute, so the colour is in the name (styles/24-highlight-tools.css).
export const ADJUST_HIGHLIGHT_PREFIX = "recall-adjust-";

let noteAdjustRef = null;

export function isHighlightAdjustOpen() {
  return noteAdjustRef != null && isAdjustHandlesOpen();
}

// The mark's own words, without the fold the badge pass appends inside it.
function noteAdjustWordsEnd(range, mark) {
  const badge = mark.lastElementChild?.classList?.contains("hl-note-badge") ? mark.lastElementChild : null;
  if (badge) range.setEndBefore(badge);
}

// The tapped mark and the marks after it that the edit will treat as the same
// highlight (one per block, when it was made across several — markGroupSpanAt).
function noteAdjustGroupMarks(mark, ref) {
  const index = highlightRefIndex(ref);
  const span = index != null && index >= 0 ? markGroupSpanAt(state.notes || "", index) : null;
  const count = span?.count || 1;
  if (count <= 1) return [mark];
  const all = Array.from(el.notesView.querySelectorAll("mark"));
  const at = all.indexOf(mark);
  if (at === -1) return [mark];
  return all.slice(at, at + count);
}

function noteAdjustMarksRange(marks) {
  const range = document.createRange();
  const first = marks[0];
  const last = marks[marks.length - 1];
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  noteAdjustWordsEnd(range, last);
  return range;
}

function noteAdjustHighlightApi() {
  return Boolean(window.CSS?.highlights && typeof window.Highlight === "function");
}

function noteAdjustPaint(color, range) {
  if (noteAdjustHighlightApi()) {
    CSS.highlights.forEach((_, name) => {
      if (name.startsWith(ADJUST_HIGHLIGHT_PREFIX)) CSS.highlights.delete(name);
    });
    if (range) CSS.highlights.set(`${ADJUST_HIGHLIGHT_PREFIX}${color}`, new window.Highlight(range));
    return;
  }
  // No Highlight API: the document selection is the preview. The pill is
  // hidden while adjusting, so it raises nothing.
  const selection = window.getSelection();
  selection?.removeAllRanges();
  if (range) {
    try { selection?.addRange(range.cloneRange()); } catch (_) { /* detached */ }
  }
}

// The caret under a point, as the touch controller resolves it (robust at the
// edges of a block and in the gaps between them), with the platform's own
// hit-test as the fallback for a surface the controller does not bind.
function noteAdjustPointAt(x, y) {
  const view = el.notesView;
  const caret = caretInRoot(x, y, view) || caretFromPoint(x, y);
  if (!caret?.node || !view.contains(caret.node)) return null;
  // Never inside the grips' own furniture — a note badge is not words.
  if (caret.node.parentElement?.closest(".hl-note-badge")) return null;
  return { node: caret.node, offset: caret.offset };
}

// `ref` is whatever the notes mark handlers key a highlight by (a ref from
// highlightRefAt, which survives other highlights being made meanwhile).
export function startHighlightAdjust(mark, ref) {
  if (!mark || ref == null || !el.notesView?.contains(mark)) return false;
  endHighlightAdjust();
  clearTouchSelection();
  window.getSelection()?.removeAllRanges();
  const marks = noteAdjustGroupMarks(mark, ref);
  let range;
  try { range = noteAdjustMarksRange(marks); } catch (_) { return false; }
  if (range.collapsed) return false;
  const color = mark.dataset.color || "yellow";
  marks.forEach((m) => m.classList.add(ADJUST_SOURCE_CLASS));
  const restore = () => {
    noteAdjustRef = null;
    marks.forEach((m) => m.classList.remove(ADJUST_SOURCE_CLASS));
  };
  noteAdjustRef = ref;
  const opened = openAdjustHandles({
    scroller: el.notesView,
    range,
    color,
    pointAt: noteAdjustPointAt,
    preview: (next) => noteAdjustPaint(color, next),
    horizontal: () => el.notesView.classList.contains("is-paged"),
    beforeScroll: () => markProgrammaticNotesScroll(),
    cancel: restore,
    apply: (next) => {
      const sel = renderedRangeStrings(el.notesView, next);
      restore();
      if (!sel) {
        showToast("Cover at least one word with the highlight, then tap Apply.", "error");
        return false;
      }
      return adjustHighlightAt(ref, sel);
    }
  });
  if (!opened) restore();
  return opened;
}

export function applyHighlightAdjust() {
  if (!isHighlightAdjustOpen()) return false;
  return applyAdjustHandles();
}

export function endHighlightAdjust() {
  if (noteAdjustRef == null) return;
  closeAdjustHandles();
}
