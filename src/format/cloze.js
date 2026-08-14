// Making and removing clozes, and erasing a selection from the source.

import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../main.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Wrap the located occurrence in {{ }} — or strip the braces if it's already
// exactly a cloze. Returns { text, action } or null when the selection can't be
// located in the source (the user can still use the raw editor).
export function clozeToggleInSource(source, sel) {
  const loc = locateSelectionInSource(source, sel);
  if (!loc) return null;
  const { idx, end, needle } = loc;
  // Already exactly wrapped in {{ }}? Toggle the cloze off.
  if (source.slice(Math.max(0, idx - 2), idx) === "{{" && source.slice(end, end + 2) === "}}") {
    return { text: source.slice(0, idx - 2) + needle + source.slice(end + 2), action: "removed" };
  }
  // Sub-selection inside a larger existing cloze (an unclosed {{ precedes the
  // match, with a }} still to come): wrapping it would nest clozes and break
  // rendering. Report it as already hidden instead.
  const before = source.slice(0, idx);
  if (before.lastIndexOf("{{") > before.lastIndexOf("}}") && source.indexOf("}}", end) !== -1) {
    return { text: source, action: "already" };
  }
  return { text: source.slice(0, idx) + "{{" + needle + "}}" + source.slice(end), action: "added" };
}

// Shared driver for the three "make cloze from selection" header buttons.
// `selOverride` is the pill's position-time snapshot (see pillSelectionCapture)
// — on touch screens the tap that fires this can have already dissolved the
// live selection, so re-reading it here would find nothing.
export function makeClozeFromSelection({ view, label, getSource, setSource, rerender }, selOverride = null) {
  const sel = selOverride || renderedSelectionStrings(view);
  if (!sel) {
    showToast(`Select some text in the ${label} first, then tap […] to hide it as a cloze.`, "error");
    return;
  }
  const result = clozeToggleInSource(getSource(), sel);
  if (!result) {
    showToast("Couldn't match that selection in the source — try selecting whole words, or use the editor to place the {{cloze}}.", "error");
    return;
  }
  if (result.action === "already") {
    showToast("That text is already inside a cloze", "info");
    return;
  }
  setSource(result.text);
  window.getSelection()?.removeAllRanges();
  rerender();
  scheduleDeckAutosave();
  showToast(result.action === "removed" ? "Cloze removed" : "Cloze added");
}

// Repair the join after a splice that crossed a block boundary.
//
// Only the seam is touched — the rest of the note is left byte for byte alone,
// so an intentional run of blank lines elsewhere in a long note isn't quietly
// reflowed by an unrelated deletion.
//
// Whether the two leftovers become ONE paragraph or stay two turns on where the
// cut began and ended. Mid-line at both ends means the reader cut the middle
// out of a sentence that happened to span blocks, and the halves belong
// together. If either end sat on a block boundary, the break the reader did NOT
// select is theirs to keep.
export function tidyErasedSeam(before, after) {
  const headRun = /(?:\n[ \t]*)+$/.exec(before);
  const tailRun = /^(?:[ \t]*\n)+/.exec(after);
  const head = before.replace(/[ \t\n]+$/, "");
  const tail = after.replace(/^[ \t\n]+/, "");
  if (!head) return tail;
  if (!tail) return `${head}\n`;
  // Neither end sat on a line break: the reader cut the middle out of a
  // sentence that happened to span blocks, and the halves belong together.
  if (!headRun && !tailRun) return `${head} ${tail}`;
  // One or both ends did. Keep the SHORTER of the two surviving separators —
  // the cut removed what sat between two breaks, and only one of them should
  // remain. Taking the shorter is what keeps a deleted list item from turning
  // its tight "\n"-separated list into a loose one, while a deleted paragraph
  // still leaves the "\n\n" that separates blocks.
  const newlines = (m) => (m ? (m[0].match(/\n/g) || []).length : Infinity);
  const keep = Math.max(1, Math.min(newlines(headRun), newlines(tailRun)));
  return head + "\n".repeat(keep) + tail;
}

// Delete the located occurrence from the source, same locate-then-splice
// shape as clozeToggleInSource but removing instead of wrapping. Closes the
// gap with a single space when leaving none would glue two words together.
//
// Multi-paragraph selections used to be REFUSED here (`needle.includes("\n\n")
// → null`), which is what made "delete only works inside one paragraph" true:
// drag across two paragraphs and the only response was an error toast. Raw mode
// has always allowed it — eraseTextareaSelection just splices [start,end) — so
// the same gesture succeeded or failed purely on which mode you were in.
//
// It is allowed now, and the leftovers of the first and last blocks merge into
// one paragraph. That is not a compromise: it is what every text editor does
// with a selection that starts mid-paragraph-1 and ends mid-paragraph-3, and it
// is what this app's own raw editor already did.
export function eraseSelectionFromSource(source, sel) {
  // fuzzy: the eraser REMOVES the whole match, markers included, so the
  // block-boundary concern that keeps cloze/colour on strict matching doesn't
  // apply — and without it a selection spanning list items (padded "-   "
  // markers, "*" bullets, ordered numbers) could never be found, which is
  // exactly the "delete does nothing on bullet points" case.
  const loc = locateSelectionInSource(source, sel, { fuzzy: true, boundedFuzzy: true });
  if (!loc) return null;
  const { idx, end, needle } = loc;
  const before = source.slice(0, idx);
  const after = source.slice(end);

  // Crossed a block boundary: splice, then tidy the seam. The three
  // single-line space rules below are about words running together inside one
  // line and say nothing useful here — what matters instead is that removing
  // the middle of "para1 … para3" must not leave a stray blank line or a run of
  // three-plus newlines where two blocks used to be.
  if (needle.includes("\n\n")) {
    return tidyErasedSeam(before, after);
  }
  // The cut landed on a line break at BOTH ends, so it consumed a whole line or
  // block and left the separators on either side of it stranded next to each
  // other. Selecting one entire paragraph and deleting it is the most ordinary
  // way to reach this, and it used to leave four newlines where two say the
  // same thing.
  if (/\n[ \t]*$/.test(before) && /^[ \t]*\n/.test(after)) {
    return tidyErasedSeam(before, after);
  }
  // The match ran to the very start of the note but the item separators lived
  // AFTER it — erasing from the top otherwise leaves a stray blank first line
  // behind. (This used to drop exactly one newline, which was one short
  // whenever the cut ended at a paragraph break rather than a list one.)
  if (!before) return tidyErasedSeam(before, after);
  const beforeEndsWithSpace = /[ \t]$/.test(before);
  const afterStartsWithSpace = /^[ \t]/.test(after);
  // Both sides already carried their own separating space (the usual case —
  // the selection itself was just the word, not its surrounding spaces) —
  // erasing what sat between them would otherwise leave a double space.
  if (beforeEndsWithSpace && afterStartsWithSpace) return before + after.slice(1);
  // Neither side had any padding at all (selection abutted words on both
  // sides with nothing between) — erasing it would glue two words together
  // without a space to replace what was removed.
  if (!beforeEndsWithSpace && !afterStartsWithSpace && before && after && !/\s$/.test(before) && !/^\s/.test(after)) {
    return before + " " + after;
  }
  return before + after;
}

// Driver for the eraser button — same shape as makeClozeFromSelection, but
// splices the selection OUT of the source instead of wrapping it. Runs against
// whichever rendered face the selection is in (notes, question or answer —
// renderTargetConfig handles all three).
export function eraseNotesSelection({ view, label, getSource, setSource, rerender }, selOverride = null) {
  const sel = selOverride || renderedSelectionStrings(view);
  if (!sel) {
    showToast(`Select some text in the ${label} first, then tap the eraser to delete it.`, "error");
    return;
  }
  const result = eraseSelectionFromSource(getSource(), sel);
  if (result == null) {
    showToast("Couldn't match that selection in the source — try selecting whole words, or use the raw editor.", "error");
    return;
  }
  setSource(result);
  window.getSelection()?.removeAllRanges();
  rerender();
  scheduleDeckAutosave();
  showToast("Selection erased");
}
