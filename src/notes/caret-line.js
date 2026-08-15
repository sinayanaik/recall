// A visible cue for where the caret is in the raw editor.
//
// The complaint this fixes: triple-click a paragraph in the rendered note, land
// in raw markdown, and then spend a moment hunting for the caret. The app places
// it correctly — the round trip is accurate to about a paragraph — but a 1px
// blinking bar in a wall of monospace-ish markdown is not something you FIND,
// and until you find it you cannot tell whether the jump worked, let alone start
// typing.
//
// So the line the caret is on gets a band behind it, and the band moves with the
// caret. Arriving from the rendered view it also pulses once, which is what turns
// "where am I?" into "there".
//
// ── Why it is drawn here rather than in the highlight mirror ───────────────
//
// The mirror (editor/highlight-mirror.js) is the obvious place — it already
// paints the text — but it switches itself OFF above 60,000 characters, which is
// exactly the size of note where finding the caret is hardest. A single absolutely
// positioned band in the wrapper works at any size, costs one element, and needs
// nothing from the mirror.
//
// ── The rule about being right ─────────────────────────────────────────────
//
// A band drawn in the wrong place is worse than no band: it does not just fail
// to answer "did the jump land where I was reading?", it answers it wrongly.
// So the band is only ever drawn from a measurement that is EXACT.
//
//   • Mirror present (under 60,000 chars) — measuring a Range in the mirror is
//     exact and cheap, so the band tracks the caret continuously.
//   • Plain mode (no mirror) — the only exact measurement is measuredCaretTop's
//     focus probe, which moves focus and cannot run per keystroke. So the band is
//     shown for the ARRIVAL, positioned from the number the jump itself
//     measured, and retires the moment the caret moves under the reader's own
//     control. That is the whole job it was added to do.
//
// ── And the rule about scroll ──────────────────────────────────────────────
//
// Measuring the mirror is O(offset) — fine per keystroke, ruinous per scroll
// frame (see the notes on the raw editor's scroll hot path). So the
// content-space top is measured ONLY when the caret could have moved, cached,
// and turned into a screen position on scroll with arithmetic alone.

import { el } from "../core/dom.js?v=__BUILD__";
import { backdropForTextarea, isCaretProbeRunning, measuredCaretTop, scrollTextareaToOffset, textareaLineHeight, visualLineTopForOffset } from "./caret.js?v=__BUILD__";

export const CARET_LINE_FLASH_MS = 1400;

let caretLineEl = null;
let caretLineTop = null;   // content space, i.e. independent of scrollTop
let caretLineHeight = 0;
let caretLineFrame = 0;
// Plain mode has no continuous measurement, so a band shown there is only valid
// until the caret next moves. See the rule at the top.
let caretLinePinned = false;
// True between a jump's first placement and its post-reflow correction. The
// blur/focus of the plain-mode probe and the browser's own caret reveal both
// fire caret events in that window, and letting them re-measure would undo the
// placement the jump just made.
let revealInFlight = false;

function wrapperFor(textarea) {
  // The wrapper, or nothing. NOT `textarea.parentElement` as a fallback: without
  // the highlight wrapper that is .notes-stage — a positioned, padded ancestor
  // with .notes-head above the editor — and the band would be drawn a whole
  // header height away from the caret, which is the exact bug this file exists
  // to avoid.
  return textarea?.closest(".highlight-textarea-wrapper") || null;
}

export function ensureNotesCaretLine() {
  const textarea = el.notesEdit;
  if (!textarea) return null;
  const wrapper = wrapperFor(textarea);
  if (!wrapper) return null;
  if (caretLineEl?.isConnected && caretLineEl.parentElement === wrapper) return caretLineEl;
  caretLineEl = document.createElement("div");
  caretLineEl.className = "notes-caret-line";
  caretLineEl.setAttribute("aria-hidden", "true");
  caretLineEl.hidden = true;
  // ABOVE both layers, not behind them. The obvious placement — first child, so
  // it reads as a background — is invisible: .highlight-textarea-backdrop is
  // `background: var(--card) !important` and paints straight over it, and in
  // plain mode (>60k chars, no mirror) the textarea itself does the same. The
  // band is translucent and pointer-events: none, so sitting on top tints the
  // line exactly the way a current-line highlight is supposed to and lets every
  // click through to the textarea underneath.
  wrapper.appendChild(caretLineEl);
  return caretLineEl;
}

// Cheap: no measurement, just the cached content-space top turned into a screen
// position. Safe to call from a scroll handler.
export function repositionNotesCaretLine() {
  const textarea = el.notesEdit;
  const band = caretLineEl;
  if (!band || !textarea || textarea.hidden || caretLineTop == null) return;
  // Against the TEXTAREA's own box, not the wrapper's origin. caretLineTop is in
  // the text's content space (padding box, scroll included), and the band is
  // positioned in the wrapper — so the textarea's offset inside the wrapper and
  // its border have to be added back, or the two frames differ by however the
  // wrapper happens to be laid out.
  const inset = textarea.offsetTop + textarea.clientTop;
  const top = caretLineTop - textarea.scrollTop;
  // Off the top or bottom of the box: hide rather than draw a band clamped to
  // the edge, which would read as "the caret is here" when it is not.
  const outside = top + caretLineHeight < 0 || top > textarea.clientHeight;
  band.hidden = outside;
  if (outside) return;
  band.style.top = `${inset + top}px`;
  band.style.height = `${caretLineHeight}px`;
}

// The measuring half. Call it when the caret may have moved — never on scroll.
//
// `measured` is the content-space top when the caller already has one (the
// arrival jump measured it to decide where to scroll); passing it is what keeps
// the band and the viewport from disagreeing.
export function refreshNotesCaretLine({ flash = false, measured = null } = {}) {
  const textarea = el.notesEdit;
  if (!textarea || textarea.hidden) {
    if (caretLineEl) caretLineEl.hidden = true;
    return;
  }
  if (measured == null && !backdropForTextarea(textarea)) {
    // Plain mode with nothing handed in: there is no exact measurement to be had
    // without a focus probe, so retire the band rather than guess at it.
    hideNotesCaretLine();
    return;
  }
  const band = ensureNotesCaretLine();
  if (!band) return;
  caretLineTop = measured == null
    ? visualLineTopForOffset(textarea, textarea.selectionStart ?? 0)
    : measured;
  caretLineHeight = textareaLineHeight(textarea);
  caretLinePinned = measured != null && !backdropForTextarea(textarea);
  repositionNotesCaretLine();
  if (!flash) return;
  // No slide-in on arrival. The band transitions `top` so that ordinary caret
  // movement glides, but the first placement has no meaningful "from" — letting
  // it animate in from wherever the band last sat is itself the "the ribbon is
  // in the wrong place" complaint.
  band.classList.add("is-placing");
  // Restarting an animation needs the class off for a frame, or a second
  // arrival within the flash window does nothing at all.
  band.classList.remove("is-flash");
  void band.offsetWidth;
  band.classList.remove("is-placing");
  band.classList.add("is-flash");
  setTimeout(() => band.classList.remove("is-flash"), CARET_LINE_FLASH_MS);
}

// Coalesced to one measurement per frame: a click fires several caret-moving
// events in a row, and every one of them would otherwise pay the O(offset) walk.
export function scheduleNotesCaretLine(options) {
  if (caretLineFrame) return;
  caretLineFrame = requestAnimationFrame(() => {
    caretLineFrame = 0;
    refreshNotesCaretLine(options);
  });
}

export function hideNotesCaretLine() {
  if (caretLineEl) caretLineEl.hidden = true;
  caretLineTop = null;
  caretLinePinned = false;
}

// ── The one entry point for an explicit jump ───────────────────────────────
//
// Everything that lands the reader somewhere in the raw editor goes through
// here, and it owns BOTH halves: one measurement decides where to scroll AND
// where to draw the band, so they cannot drift apart.
//
// It also re-asserts after the layout settles. Opening the editor un-hides
// .notes-head (a `:has(#notesEdit:not([hidden]))` rule) and the browser performs
// its own caret reveal on focus — both land after the synchronous scroll, and
// before this nothing corrected for either, so the reading line was stale by
// whatever the reflow moved.
export function revealNotesCaretAt(pos, { flash = false } = {}) {
  const textarea = el.notesEdit;
  if (!textarea || textarea.hidden) return;
  revealInFlight = true;
  const width = textarea.clientWidth;
  const measured = measuredCaretTop(textarea, pos);
  scrollTextareaToOffset(textarea, pos, { measured });
  refreshNotesCaretLine({ flash, measured });
  // One correction after the reflow. Not a loop: unlike the rendered view's
  // heights, a textarea's own layout settles in a single frame once the header
  // is in place.
  requestAnimationFrame(() => {
    revealInFlight = false;
    if (textarea.hidden || document.activeElement !== textarea) return;
    // Re-measure only if the box actually re-wrapped. A header appearing above
    // the editor changes its HEIGHT, which moves nothing in content space; only
    // a width change moves the caret's line. Skipping the re-measure also skips
    // a second plain-mode focus probe, which would blink the keyboard twice on
    // a phone for no gain.
    const again = textarea.clientWidth === width ? measured : measuredCaretTop(textarea, pos);
    scrollTextareaToOffset(textarea, pos, { measured: again });
    refreshNotesCaretLine({ measured: again });
  });
}

export function initNotesCaretLine() {
  const textarea = el.notesEdit;
  if (!textarea) return;
  ["keyup", "click", "select", "focus", "input"].forEach((type) => {
    textarea.addEventListener(type, () => {
      // The focus probe blurs and refocuses the textarea to make the engine
      // reveal the caret; without this its own focus event would re-enter here.
      if (isCaretProbeRunning() || revealInFlight) return;
      // A pinned (plain-mode) band was placed from a jump's exact measurement.
      // The reader moving the caret invalidates it and there is no cheap way to
      // measure again, so it retires rather than lingering in the wrong place.
      if (caretLinePinned) { hideNotesCaretLine(); return; }
      scheduleNotesCaretLine();
    }, { passive: true });
  });
  // Arithmetic only — see the note at the top about the scroll hot path.
  textarea.addEventListener("scroll", repositionNotesCaretLine, { passive: true });
  // A resize re-wraps every line, so the cached top is stale.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (revealInFlight) return;
      if (caretLinePinned) { hideNotesCaretLine(); return; }
      scheduleNotesCaretLine();
    }).observe(textarea);
  }
}
