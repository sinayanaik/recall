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

export let chromeFocusPinned = false;

// Setter: an imported binding is read-only, and main.js seeds it from localStorage at startup.
export function setChromeFocusPinned(value) {
  chromeFocusPinned = value;
}

export let chromeAutoHidden = false;

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

export function readChromeHeights() {
  const root = document.documentElement;
  const appbar = document.querySelector(".appbar");
  const appbarHeight = naturalHeight(appbar);
  if (appbarHeight) root.style.setProperty("--appbar-h", `${appbarHeight}px`);
  // The ROW, not the toggle inside it. The Cards/Notes/Highlights tabs now share
  // a row with the table of contents, the edit pill and the ⋯ menu, and it is
  // that row which folds away in focus mode — measuring only the tabs left the
  // three lifted controls on screen with the chrome supposedly hidden, which is
  // what "the focus toggle does nothing" looked like.
  const toggle = document.getElementById("viewModeRow") || el.viewModeToggle;
  const toggleHeight = toggle && !toggle.hidden ? naturalHeight(toggle) : 0;
  if (toggleHeight) root.style.setProperty("--view-toggle-h", `${toggleHeight}px`);
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
  const collapsed = chromeFocusPinned || (isMobileChrome() && chromeAutoHidden);
  const changed = document.body.classList.contains("chrome-collapsed") !== collapsed;
  // Measured while still expanded — after the class flip the guard in
  // measureChromeHeights (correctly) refuses to read anything.
  if (changed && collapsed) measureChromeHeights();
  document.body.classList.toggle("chrome-collapsed", collapsed);
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
    el.focusModeBtn.textContent = chromeFocusPinned ? "⤡" : "⤢";
    el.focusModeBtn.title = chromeFocusPinned
      ? "Focus mode on (Ctrl + . or Esc) — bring the header back"
      : "Focus mode (Ctrl + .) — keep the header hidden while you read";
  }
}

// Called when the user navigates rather than reads (deck load, Cards⇄Notes):
// arriving somewhere new should start from the top, with the header visible.
export function resetChromeAutoHide() {
  chromeAutoHidden = false;
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
  if (top <= CHROME_TOP_ZONE) {
    chromeAnchorTop = top;
    if (chromeAutoHidden) {
      chromeAutoHidden = false;
      applyChromeCollapse();
    }
    return;
  }
  const delta = top - chromeAnchorTop;
  if (delta > CHROME_HIDE_DELTA) {
    chromeAnchorTop = top;
    if (!chromeAutoHidden) {
      chromeAutoHidden = true;
      applyChromeCollapse();
    }
  } else if (delta < -CHROME_SHOW_DELTA) {
    chromeAnchorTop = top;
    if (chromeAutoHidden) {
      chromeAutoHidden = false;
      applyChromeCollapse();
    }
  }
}

// One path for all three ways in and out — the ⤢ button, Escape, and the
// keyboard shortcut — so they can't drift on what "off" means.
export function setFocusMode(pinned) {
  if (chromeFocusPinned === pinned) return;
  setChromeFocusPinned(pinned);
  try {
    localStorage.setItem(FOCUS_MODE_KEY, chromeFocusPinned ? "1" : "0");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
  // Leaving focus mode should actually show the header, even mid-scroll — and
  // it has to stay shown.
  //
  // Resetting chromeAutoHidden alone was not enough, and this was the single
  // biggest reason the toggle read as "broken". The scroll listener bails on
  // `chromeFocusPinned` BEFORE it updates the anchor, so chromeAnchorTop stays
  // frozen at wherever you were when focus mode was switched on. Read 2000px
  // further down the note, tap ⤡, then nudge the page: delta comes out as
  // ~2000, sails past CHROME_HIDE_DELTA, and the header you just asked for
  // folds straight back away. Drop the anchor with it, exactly as
  // resetChromeAutoHide does — the next scroll then re-anchors from where you
  // actually are.
  chromeAutoHidden = false;
  chromeAnchorEl = null;
  chromeAnchorTop = 0;
  applyChromeCollapse();
}
