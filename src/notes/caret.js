// Keeping the caret visible in the raw editor.
//
// The textarea is a SECOND scroller inside the page's, and measuring a caret
// position in it is O(offset) — doing that per frame on a large note freezes
// everything. Hence the mirror backdrop, and the rationing here.

import { el } from "../core/dom.js?v=__BUILD__";
import { caretFromPoint } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";

// Counts newlines in value[0..pos) without materialising the prefix. The old
// `value.slice(0, pos).match(/\n/g).length` allocated a copy of everything above
// the caret AND an array with one entry per line in it — on a book chapter that
// is megabytes of garbage every time the editor opens.
export function lineIndexAtOffset(value, pos) {
  let count = 0;
  let at = value.indexOf("\n");
  while (at !== -1 && at < pos) {
    count += 1;
    at = value.indexOf("\n", at + 1);
  }
  return count;
}

export function textareaLineHeight(textarea) {
  return parseFloat(getComputedStyle(textarea).lineHeight) || 20;
}

// The syntax-highlight mirror, when there is one to measure against.
//
// A <textarea> will not report where a character sits, but the backdrop behind
// it is a character-for-character copy under an identical metrics rule (see
// .highlight-textarea-backdrop / .edit-textarea in styles.css — deliberately
// ONE declaration for both), so a Range inside the mirror answers the question
// exactly. Null whenever there is nothing trustworthy to measure: no mirror
// yet, or plain mode (a note past HIGHLIGHT_MIRROR_MAX_CHARS, where the mirror
// is emptied on purpose).
export function backdropForTextarea(textarea) {
  const wrapper = textarea?.parentElement;
  if (!wrapper || wrapper.classList.contains("is-plain")) return null;
  return wrapper.querySelector(".highlight-textarea-backdrop") || null;
}

export function caretRectInBackdrop(textarea, offset) {
  const backdrop = backdropForTextarea(textarea);
  if (!backdrop) return null;
  const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    const len = node.nodeValue.length;
    if (seen + len >= offset) {
      try {
        const range = document.createRange();
        range.setStart(node, Math.max(0, offset - seen));
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        if (rect && (rect.top || rect.left)) return { rect, backdrop };
      } catch {
        // A detached or mid-rebuild mirror; the caller's fallback is fine.
      }
      return null;
    }
    seen += len;
    node = walker.nextNode();
  }
  return null;
}

// The reverse walk: a (node, offset) inside the mirror back to a character
// offset in the textarea's value. The mirror's text content is the value
// verbatim (only <span> colour wrappers are added — see enableSyntaxHighlighting,
// which is forbidden from changing any metric), so summing the text nodes before
// `node` is an exact conversion. Null when the node isn't in this mirror.
export function backdropTextOffset(backdrop, node, offsetInNode) {
  const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return seen + Math.max(0, offsetInNode);
    seen += current.nodeValue.length;
    current = walker.nextNode();
  }
  return null;
}

// Character offset -> its VISUAL top, in the textarea's own scroll coordinates.
//
// This is the fix for "triple-click takes me somewhere off-screen". The old
// arithmetic counted "\n" characters and multiplied by the line height, but
// both boxes are `white-space: pre-wrap` — a paragraph of prose occupies many
// visual rows per hard line break, and every one of them was unaccounted for.
// The result undershot monotonically, so the further into a note you clicked
// the further BELOW the viewport the caret landed. Measuring the mirror counts
// wrapped rows because the browser already laid them out.
//
// The \n-counting math survives only as the plain-mode fallback, where there is
// no mirror to measure and an approximation is the only thing on offer.
export function visualLineTopForOffset(textarea, pos) {
  const hit = caretRectInBackdrop(textarea, pos);
  if (hit) {
    const box = hit.backdrop.getBoundingClientRect();
    // The backdrop scrolls in lockstep with the textarea (see syncScroll) and
    // shares its padding, so subtracting the border and adding back the scroll
    // converts a viewport rect straight into scroll-content space.
    return hit.rect.top - box.top - hit.backdrop.clientTop + hit.backdrop.scrollTop;
  }
  const padTop = parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  return lineIndexAtOffset(textarea.value, pos) * textareaLineHeight(textarea) + padTop;
}

// setSelectionRange alone doesn't reliably re-scroll a long textarea in every
// browser, so drive the scroll from the measured position of `pos`. Puts the
// line on the same reading line the rendered view samples from and restores to
// (notesReadingLineOffset) — previously this centred while the sampler read
// from near the top, so a round trip drifted by half a viewport.
export function scrollTextareaToOffset(textarea, pos) {
  const top = visualLineTopForOffset(textarea, pos);
  const gap = textarea === el.notesEdit
    ? notesReadingLineOffset(textarea.clientHeight)
    : textarea.clientHeight / 2;
  const max = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
  textarea.scrollTop = Math.min(max, Math.max(0, top - gap));
  // Writing scrollTop programmatically doesn't reliably fire a scroll event in
  // every browser, and the mirror is the only thing painting visible text — so
  // without this nudge the reader can end up looking at the OLD text with the
  // caret sitting over it. (scrollNotesEditToHeadingIndex has carried this
  // workaround on its own since before there were other callers.)
  textarea.dispatchEvent(new Event("scroll"));
}

// Keep the caret off the bottom edge while writing at the END of a note.
//
// The complaint this fixes: type past the last visible line and the new text
// went under the bottom of the box (on a phone, under the keyboard) with no
// way to see it except adding blank lines and scrolling up by hand.
//
// Two things had to be true and neither was. There has to be somewhere to
// scroll TO — that is the scroll-past-end padding on .notes-stage's editor
// wrapper — and something has to scroll there. Browsers only scroll far enough
// to make the caret *technically* visible, which lands it flush against the
// bottom frame; the comfortable gap that every other editor leaves is ours to
// add.
//
// Scoped deliberately to a caret with nothing but whitespace after it. That is
// the reported case, it needs no line arithmetic at all (the content bottom is
// just scrollHeight minus the padding), and it leaves the browser's own
// behaviour alone when you are editing mid-document — where scrolling the line
// you touched up to a fixed height would be a surprise, not a fix.
//
// Note the lower bound: this only ever scrolls DOWN. Scrolling back up would
// fight the user the moment they deliberately scrolled away from the caret.
export const NOTES_CARET_TAIL_LINES = 3;

export function keepNotesCaretVisible() {
  const textarea = el.notesEdit;
  if (!textarea || textarea.hidden) return;
  // A range selection isn't a typing caret; leave it where the user put it.
  if (textarea.selectionStart !== textarea.selectionEnd) return;
  // Anything of substance below the caret means there is context to read down
  // there, and the native behaviour is already the right one.
  //
  // Scanned rather than `value.slice(selectionEnd).trim()`, which allocated a
  // copy of everything below the caret AND a trimmed copy of that — on every
  // keystroke, on a note that may be hundreds of KB. Same defect, same fix, as
  // lineIndexAtOffset above.
  const value = textarea.value;
  for (let i = textarea.selectionEnd; i < value.length; i += 1) {
    if (!/\s/.test(value[i])) return;
  }

  const styles = getComputedStyle(textarea);
  const lineHeight = parseFloat(styles.lineHeight) || 20;
  const padBottom = parseFloat(styles.paddingBottom) || 0;
  // scrollHeight includes the scroll-past-end padding; the last line of actual
  // text ends where that padding starts.
  const contentBottom = textarea.scrollHeight - padBottom;
  const maxScroll = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
  const want = Math.min(
    maxScroll,
    Math.max(0, contentBottom + lineHeight * NOTES_CARET_TAIL_LINES - textarea.clientHeight)
  );
  // Writing scrollTop fires the textarea's own scroll event, which is what the
  // highlight backdrop listens to — the mirror follows on its own.
  if (want > textarea.scrollTop) textarea.scrollTop = want;
}

// Coalesced to one check per frame: autorepeat and fast typing fire input far
// faster than the box can be re-measured, and each measurement forces layout.
//
// Deliberately NOT wired to the textarea's scroll event. It briefly was, to keep
// a caret-following band drawn over the editor in step, and that single listener
// put a getComputedStyle, a scrollHeight read and a walk of the highlight mirror
// on every frame of every scroll — the cost growing with how far down the note
// the caret sat. Scrolling is not typing: nothing here can change while the
// reader is only moving the view.
export let notesCaretFrame = 0;

export function scheduleNotesCaretCheck() {
  if (notesCaretFrame) return;
  notesCaretFrame = requestAnimationFrame(() => {
    notesCaretFrame = 0;
    keepNotesCaretVisible();
  });
}

// Inverse of scrollTextareaToOffset: the raw character offset sitting at the
// textarea's CURRENT reading line. Both directions must use the SAME measure or
// a round trip (scroll → offset → scroll) compounds error instead of cancelling
// it — so this asks the mirror which character is painted on the reading line,
// exactly as visualLineTopForOffset asks it where a character is painted, and
// only falls back to the line-height arithmetic when there is no mirror.
export function textareaOffsetFromScroll(textarea) {
  const lineHeight = textareaLineHeight(textarea);
  const gap = textarea === el.notesEdit
    ? notesReadingLineOffset(textarea.clientHeight)
    : textarea.clientHeight / 2;

  const backdrop = backdropForTextarea(textarea);
  if (backdrop) {
    const box = backdrop.getBoundingClientRect();
    // A couple of pixels in from the text edge: dead on the padding edge can
    // land outside every text node and report nothing.
    const caret = caretFromPoint(
      box.left + backdrop.clientLeft + 2,
      box.top + backdrop.clientTop + gap
    );
    if (caret && backdrop.contains(caret.node)) {
      const offset = backdropTextOffset(backdrop, caret.node, caret.offset);
      if (offset != null) return Math.min(offset, textarea.value.length);
    }
  }

  const lineIndex = Math.max(0, Math.round((textarea.scrollTop + gap) / lineHeight));
  const value = textarea.value;
  // Walk to the start of the target line by scanning for newlines with
  // indexOf — this only touches the prefix up to the caret line, and never
  // materialises the whole document as an array (split("\n") on a huge note
  // is what made the raw→rendered toggle slow).
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) {
    const nl = value.indexOf("\n", offset);
    if (nl === -1) break;
    offset = nl + 1;
  }
  return Math.min(offset, value.length);
}
