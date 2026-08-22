// The collapsing header/footer, and focus mode.
//
// There is no Fullscreen API here — this hides the app's own chrome. The
// collapse is deliberately not a tween over the header's height: animating
// 300px of content against a 60px header stalls, and the scroll anchor has to
// be frozen or the page re-expands the header the moment it settles.

import { adjustCornellRows } from "../cards/all-cards.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { isNotesStreamBusy } from "../render/block-cache.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "../render/tables.js?v=__BUILD__";
import { FOCUS_MODE_KEY } from "./view-mode.js?v=__BUILD__";

export const CHROME_MOBILE_QUERY = "(max-width: 720px)";

export const CHROME_HIDE_DELTA = 10;

export const CHROME_SHOW_DELTA = 28;

                              // larger, so overscroll bounce and the odd
                              // thumb wobble don't flap the header
export const CHROME_TOP_ZONE = 24;

export const CHROME_SETTLE_MS = 260;

// The reading rail is shown from the same one fact this file publishes — is the
// chrome collapsed — and it is REGISTERED rather than imported, for the reason
// src/notes/selection.js sets out at length: this module sits low in the graph
// (view-mode.js imports it) and src/ui/reading-rail.js sits high (it reaches
// setViewMode, the table of contents and My Decks), so importing it here would
// close a cycle and pull that whole subtree in ahead of things that are
// currently evaluated before it. Same shape as setHighlightsChangedHandler.
let onChromeCollapse = () => {};

export function setChromeCollapseHandler(fn) {
  onChromeCollapse = typeof fn === "function" ? fn : () => {};
}

export let chromeFocusPinned = false;

// Setter: an imported binding is read-only, and main.js seeds it from localStorage at startup.
export function setChromeFocusPinned(value) {
  chromeFocusPinned = value;
}

// ── The lock, which replaced the auto-hide ─────────────────────────────────
//
// There used to be a `chromeAutoHidden` beside the pin, and it was reversible:
// scrolling down folded the header away and scrolling up — by
// CHROME_SHOW_DELTA, twenty-eight pixels — brought it straight back. Which
// reads as focus mode leaking away while you read, because nobody scrolls in
// one direction for a whole chapter: a thumb correcting past a figure, a tap
// that nudges the page, and the header is back over the text.
//
// So scrolling down does not HIDE the chrome any more. It LOCKS it away, and it
// stays away until the reader says otherwise — through the reading rail's Leave
// focus, Escape, the phone's Back key, or Ctrl+. Everything that already meant
// "the reader is done with focus mode" clears this, and so does navigating
// somewhere new (resetChromeAutoHide, which kept its name because that is still
// exactly what it does).
//
// Deliberately NOT written to localStorage[FOCUS_MODE_KEY]. That key means "the
// reader pressed the focus button", and it decides what the app starts up in;
// one scroll in one note should not be the reason a deck opens with no header
// three days later. This lasts as long as the reading does.
export let chromeFocusLocked = false;

export let chromeAnchorEl = null;

export let chromeAnchorTop = 0;

export let chromeScrollFrame = 0;

// Setter: an imported binding is read-only, and the scroll listener in main.js drives this rAF handle.
export function setChromeScrollFrame(value) {
  chromeScrollFrame = value;
}

export let chromeSettleUntil = 0;

// Cached, like styleMobileMedia at the top of the file. This is read from the
// document-wide scroll handler below, and building a fresh MediaQueryList per
// scroll event — which is faster than 60Hz on a fling — is pure garbage.
export const chromeMobileMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia(CHROME_MOBILE_QUERY)
  : null;

export function isMobileChrome() {
  return Boolean(chromeMobileMedia?.matches);
}

// Any live (non-collapsed) selection in the study area — a rendered surface or
// one of the raw-edit textareas. Broader than hasCardTextSelection(), which is
// specifically about whether the card's own swipe/flip gestures should stand
// down; this one is about not moving the layout out from under a selection.
export function hasStudyTextSelection() {
  const active = document.activeElement;
  if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
      && typeof active.selectionStart === "number"
      && active.selectionStart !== active.selectionEnd) {
    return true;
  }
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const node = selection.anchorNode || selection.focusNode;
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest?.(".study-layout"));
}

// The raw write. Only ever called when the chrome is expanded and still.
//
// scrollHeight, not offsetHeight — and this is not a nicety. The variables
// written here are the SAME ones the CSS clamps these elements with
// (`.appbar { max-height: var(--appbar-h) }`), so offsetHeight reports the
// clamped box rather than the natural one: once a short height has been
// recorded, the element can never be measured taller than it, because the clamp
// is what it is being measured through.
//
// Latent until the appbar's height started depending on the VIEW — the card
// counters are hidden while reading (see styles/16-mobile-reading.css), so a
// height measured in Notes view was then too small for Cards or Highlights, and
// the meta row spilled out over the tabs below it. scrollHeight is the content
// height and ignores max-height entirely; the borders are added back because it
// excludes them and the clamp is on the border box.
function naturalHeight(node) {
  if (!node?.scrollHeight) return 0;
  const styles = getComputedStyle(node);
  const borders = (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
  return Math.ceil(node.scrollHeight + borders);
}

// Published ON THE ELEMENT THAT USES IT, not on :root — and that is a
// performance fix, not tidiness.
//
// A custom property set on the root element is inherited by every element in
// the document, so writing one makes the browser re-resolve variables for the
// whole tree. That is cheap on an ordinary page and is not cheap here: measured
// on a 2.5MB / 19,380-block book at a 6x CPU throttle (a mid-range phone), one
// `--appbar-h` write on :root costs ~600ms, and this function writes two.
//
// It runs far more often than it looks. On a phone the chrome auto-hides as you
// scroll (see trackChromeScroll — phone-only), every fold and unfold animates
// the appbar's height, and main.js watches that box with a ResizeObserver that
// calls straight back in here. So a reader scrolling a book was paying hundreds
// of milliseconds of whole-document work per direction change, for two numbers
// that only three elements read.
//
// Grepped before moving them: `--appbar-h` is read by `.appbar` alone
// (styles/12-notes.css:1209), and `--view-toggle-h` by `.quiz-panel
// .view-mode-toggle` (styles/12-notes.css:1213) and `.view-mode-row`
// (styles/16-mobile-reading.css:335) — the toggle being a child of the row, so
// the row is the one place that covers both. None of them is an ancestor of
// #notesView, so the note no longer has any reason to hear about this at all.
export function readChromeHeights() {
  const appbar = document.querySelector(".appbar");
  const appbarHeight = naturalHeight(appbar);
  if (appbarHeight) appbar.style.setProperty("--appbar-h", `${appbarHeight}px`);
  // The ROW, not the toggle inside it. The Cards/Notes/Highlights tabs now share
  // a row with the table of contents, the edit pill and the ⋯ menu, and it is
  // that row which folds away in focus mode — measuring only the tabs left the
  // three lifted controls on screen with the chrome supposedly hidden, which is
  // what "the focus toggle does nothing" looked like.
  const toggle = document.getElementById("viewModeRow") || el.viewModeToggle;
  const toggleHeight = toggle && !toggle.hidden ? naturalHeight(toggle) : 0;
  // Written on whichever element was MEASURED. When the row exists the toggle
  // inherits it; when it doesn't, the toggle is both the measured box and the
  // only consumer left.
  if (toggleHeight) toggle.style.setProperty("--view-toggle-h", `${toggleHeight}px`);
}

// Two guards, both load-bearing:
//  • collapsed — the box is 0 tall by definition; recording that would make 0
//    the value the expand animates TO, and the header could never come back.
//  • mid-transition — the observer fires on every frame of an expand, and
//    adopting one of those intermediate heights as the new target would leave
//    the header settling short of its real size, a little shorter each time.
export function measureChromeHeights() {
  if (document.body.classList.contains("chrome-collapsed")) return;
  if (performance.now() < chromeSettleUntil) return;
  // A big note mid-stream has a backlog of freshly appended, never-laid-out
  // blocks; forcing a layout read here (of the appbar, nothing to do with the
  // note) would flush that backlog synchronously right inside whatever click
  // triggered the collapse. Skip it — the last known --appbar-h/--view-toggle-h
  // stay in place, which is correct in the overwhelmingly common case where
  // those elements haven't actually changed size — and scheduleChromeRefit's
  // own deferred read (also stream-gated) will catch up once the note settles.
  if (isNotesStreamBusy()) return;
  readChromeHeights();
}

// One refit after the fold has settled, shared by every toggle. Collapsing
// hands the card face ~100-130px it did not have, and fitLiveQuestion's memo
// key includes that box — but a class toggle fires no resize event, so nothing
// invalidated it and the question stayed sized for the old viewport until the
// next flip. Re-armed rather than stacked, so holding the shortcut down costs
// one refit, not one per press.
export let chromeRefitTimer = 0;

export function scheduleChromeRefit() {
  clearTimeout(chromeRefitTimer);
  chromeRefitTimer = setTimeout(() => {
    // A big note is still streaming in — re-arm rather than force the read now
    // (see measureChromeHeights). Rare: only matters for a note large enough to
    // still be streaming CHROME_SETTLE_MS+40ms after the toggle.
    if (isNotesStreamBusy()) {
      chromeRefitTimer = setTimeout(() => scheduleChromeRefit(), CHROME_SETTLE_MS);
      return;
    }
    chromeRefitTimer = 0;
    // Straight to the unguarded read: the settle window has just expired and
    // this is the one moment we know the chrome is expanded AND still, so
    // measureChromeHeights' now-stale timing guard must not veto it.
    if (!document.body.classList.contains("chrome-collapsed")) readChromeHeights();
    if (state.viewMode === "cards") scheduleLiveQuestionFit();
    adjustCornellRows();
    scheduleMarkdownTableFit();
  }, CHROME_SETTLE_MS + 40);
}

// What #focusModeBtn currently says. Starts null (not false) so the first call
// always paints it, including a session restored with the pin already on.
export let focusBtnShowsPinned = null;

export function applyChromeCollapse() {
  // The pin applies at any width; only the scroll-driven half is phone-gated,
  // so resizing a window up past the breakpoint restores an auto-hidden header
  // without disturbing a deliberate pin.
  const collapsed = chromeFocusPinned || (isMobileChrome() && chromeFocusLocked);
  const changed = document.body.classList.contains("chrome-collapsed") !== collapsed;
  // Measured while still expanded — after the class flip the guard in
  // measureChromeHeights (correctly) refuses to read anything.
  if (changed && collapsed) measureChromeHeights();
  document.body.classList.toggle("chrome-collapsed", collapsed);
  // In the same breath as the class, never from a second listener that could
  // fall out of step with it — the rail IS the collapsed chrome's stand-in.
  onChromeCollapse(collapsed);
  // Collapsing makes the notes viewport taller, which can clamp scrollTop when
  // you're near the bottom — that clamp fires a scroll event that looks like a
  // big upward flick and would immediately un-collapse (then re-collapse, then
  // …). Ignore scrolling until the transition has settled.
  if (changed) {
    chromeSettleUntil = performance.now() + CHROME_SETTLE_MS;
    scheduleChromeRefit();
  }
  // Gated on the PIN changing, not on `changed`. This used to run on every
  // call, which on a phone means every scroll-driven auto-hide tick rewriting
  // three attributes on a button that is hidden in Cards view anyway — but it
  // cannot be gated on `collapsed` changing either: pinning while the phone
  // has already auto-hidden the chrome leaves `collapsed` true throughout, and
  // the button would keep showing ⤢ for a mode that is now on.
  if (chromeFocusPinned !== focusBtnShowsPinned && el.focusModeBtn) {
    focusBtnShowsPinned = chromeFocusPinned;
    el.focusModeBtn.setAttribute("aria-pressed", chromeFocusPinned ? "true" : "false");
    // Into the glyph SPAN, never onto the button. The button also carries its
    // name and its On/Off switch now (it is a row in the ⋯ menu, see
    // notes-head-overflow.js), and `button.textContent = …` would delete both
    // the first time the pin was turned on. The fallback is for a layout that
    // has not got a glyph span — the old behaviour, unchanged.
    const glyph = el.focusModeBtn.querySelector(".nhm-ico") || el.focusModeBtn;
    glyph.textContent = chromeFocusPinned ? "⤡" : "⤢";
    el.focusModeBtn.title = chromeFocusPinned
      ? "Focus mode on (Ctrl + . or Esc) — bring the header back"
      : "Focus mode (Ctrl + .) — keep the header hidden while you read";
  }
}

// Called when the user navigates rather than reads (deck load, Cards⇄Notes):
// arriving somewhere new should start from the top, with the header visible.
export function resetChromeAutoHide() {
  chromeFocusLocked = false;
  chromeAnchorEl = null;
  chromeAnchorTop = 0;
  applyChromeCollapse();
}

export function trackChromeScroll(target) {
  const top = target.scrollTop;
  // Never fold or unfold the chrome while text is selected. Extending a
  // selection past the visible edge means dragging a handle until the surface
  // auto-scrolls — and collapsing the appbar mid-drag changes the viewport
  // height underneath the selection, which is what made the handles jump and the
  // selection collapse on a phone. The anchor is still advanced so the first
  // real scroll after the selection is dropped doesn't read as one huge jump.
  if (hasStudyTextSelection()) {
    chromeAnchorEl = target;
    chromeAnchorTop = top;
    return;
  }
  if (chromeAnchorEl !== target) {
    chromeAnchorEl = target;
    chromeAnchorTop = top;
    return;
  }
  if (performance.now() < chromeSettleUntil) {
    chromeAnchorTop = top;
    return;
  }
  // Defensive: the listener in main.js already bails while the mode is on, and
  // this is the second half of that fact rather than a second opinion about it.
  if (chromeFocusLocked) return;
  // Reaching the top of the note used to bring the header back, and so did any
  // upward scroll past CHROME_SHOW_DELTA. Both are gone — see chromeFocusLocked:
  // the lock is what makes focus mode a mode rather than something that leaks
  // away the first time a thumb corrects past a figure.
  if (top <= CHROME_TOP_ZONE) {
    chromeAnchorTop = top;
    return;
  }
  const delta = top - chromeAnchorTop;
  if (delta > CHROME_HIDE_DELTA) {
    chromeAnchorTop = top;
    chromeFocusLocked = true;
    applyChromeCollapse();
  }
}

// Is the header folded because the reader wants it folded — by the button, or
// by having scrolled into the lock? The two are one question everywhere the
// answer is acted on (Escape, the phone's Back key, Ctrl+.), and only
// setFocusMode below cares which of them it was.
export function isFocusModeActive() {
  return Boolean(chromeFocusPinned || chromeFocusLocked);
}

// One path for all four ways in and out — the ⤢ button, Escape, the keyboard
// shortcut, and the reading rail's Leave focus — so they can't drift on what
// "off" means.
export function setFocusMode(pinned) {
  // Not `chromeFocusPinned === pinned` on its own. The lock folds the chrome
  // without touching the pin, so turning focus mode OFF has real work to do
  // even when the pin is already off — which is exactly the state the rail's
  // Leave focus is pressed in. Only a call that would change nothing returns.
  if (chromeFocusPinned === pinned && !chromeFocusLocked) return;
  setChromeFocusPinned(pinned);
  try {
    localStorage.setItem(FOCUS_MODE_KEY, chromeFocusPinned ? "1" : "0");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
  // Leaving focus mode should actually show the header, even mid-scroll — and
  // it has to stay shown.
  //
  // Resetting the scroll-driven flag alone was not enough, and this was the
  // single biggest reason the toggle read as "broken". The listener bails on
  // `chromeFocusPinned` BEFORE it updates the anchor, so chromeAnchorTop stays
  // frozen at wherever you were when focus mode was switched on. Read 2000px
  // further down the note, tap ⤡, then nudge the page: delta comes out as
  // ~2000, sails past CHROME_HIDE_DELTA, and the header you just asked for
  // folds straight back away. Drop the anchor with it, exactly as
  // resetChromeAutoHide does — the next scroll then re-anchors from where you
  // actually are.
  // The lock is a second way INTO the same state, so leaving has to clear it as
  // well as the pin — otherwise pressing "Leave focus" would turn the pin off
  // and leave the chrome folded by the lock, which is the toggle reading as
  // broken all over again.
  chromeFocusLocked = false;
  chromeAnchorEl = null;
  chromeAnchorTop = 0;
  applyChromeCollapse();
}

// ── Immersive mode: the app's chrome AND the browser's ─────────────────────
//
// Focus mode above folds the app's own furniture. What it cannot touch is the
// ~110px of tab strip, address bar and bookmarks above it — which on a laptop
// is more than everything this file has been arguing about put together. The
// Fullscreen API is the only thing that can, and it is a real mode change
// rather than a class: the browser owns it, the user can leave it with F11 or
// Escape without telling us, and it needs a gesture to enter.
//
// So the two are deliberately separate buttons with separate shortcuts rather
// than three states on one control. ⤢ / Ctrl+. is reversible with a glance at
// the header; ⛶ / Ctrl+Q takes over the screen. A tri-state toggle would make
// you press it once to find out which of the two you were about to get.
//
// Entering does BOTH: a fullscreen window still showing the deck title, the
// category and the tabs is not what anyone means by full screen.
//
// ⚠ Ctrl+Q is the browser's own quit accelerator in Chrome on Linux and (as
// Cmd+Q) on macOS, and preventDefault cannot always take that back. Where it is
// swallowed, the ⛶ button in the ⋯ menu is the way in.
export function isFullscreenAvailable() {
  return typeof document !== "undefined"
    && Boolean(document.documentElement?.requestFullscreen)
    && document.fullscreenEnabled !== false;
}

// Where the API is missing (iOS Safari has it on <video> only), immersive mode
// degrades to focus mode — so "am I in it" degrades to the same question.
export function isImmersive() {
  return isFullscreenAvailable() ? Boolean(document.fullscreenElement) : chromeFocusPinned;
}

// What #immersiveModeBtn currently says. Starts null (not false) for the same
// reason focusBtnShowsPinned does: the first call must always paint it.
export let immersiveBtnShowsOn = null;

export function paintImmersiveButton() {
  if (!el.immersiveModeBtn) return;
  const on = isImmersive();
  if (on === immersiveBtnShowsOn) return;
  immersiveBtnShowsOn = on;
  el.immersiveModeBtn.setAttribute("aria-pressed", on ? "true" : "false");
  el.immersiveModeBtn.title = !isFullscreenAvailable()
    ? "Full screen isn't available in this browser — Ctrl + Q hides the app's own header instead"
    : on
      ? "Leave full screen (Ctrl + Q, or Esc)"
      : "Full screen (Ctrl + Q) — hide the browser as well";
}

// Fire-and-forget: requestFullscreen/exitFullscreen REJECT rather than throw
// when the gesture has expired or a policy refuses, and there is nothing useful
// to do about it beyond leaving focus mode in whatever state it reached. The
// button is repainted from the fullscreenchange listener below rather than from
// here, so what it shows is what actually happened and not what was asked for.
export function setImmersiveMode(on) {
  if (on) {
    setFocusMode(true);
    if (isFullscreenAvailable() && !document.fullscreenElement) {
      Promise.resolve(document.documentElement.requestFullscreen()).catch(() => paintImmersiveButton());
    } else {
      paintImmersiveButton();
    }
    return;
  }
  setFocusMode(false);
  if (document.fullscreenElement) Promise.resolve(document.exitFullscreen()).catch(() => {});
  else paintImmersiveButton();
}

export function toggleImmersiveMode() {
  setImmersiveMode(!isImmersive());
}

// Leaving fullscreen by F11, by Escape, or by the browser's own control has to
// leave immersive mode as a WHOLE — otherwise the window comes back with the
// app's header still folded away and a lit ⛶ button, and nothing the reader
// pressed did either of those. One path out, whoever asked for it.
export function initImmersiveMode() {
  paintImmersiveButton();
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) setFocusMode(false);
    paintImmersiveButton();
  });
}
