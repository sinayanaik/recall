// The collapsing header/footer, and focus mode.
//
// There is no Fullscreen API here — this hides the app's own chrome. The
// collapse is deliberately not a tween over the header's height: animating
// 300px of content against a 60px header stalls, and the scroll anchor has to
// be frozen or the page re-expands the header the moment it settles.
//
// ── Folding the header is a manual act now, full stop ──────────────────────
//
// This used to also fold on its own: scrolling down on a phone past a small
// threshold "locked" the chrome away without the reader pressing anything
// (chromeFocusLocked/trackChromeScroll, plus the mobile-only scroll listener
// in main.js that drove them). It read as intrusive — the header vanishing
// mid-read because of an ordinary scroll, not because anyone asked for it —
// so it is gone. The only ways in now are the ones a reader actually presses:
// the ⤢ button, Ctrl+., the reading rail's Focus row, and (for the browser's
// own chrome) the ⛶ button / Ctrl+Q for full screen. isFocusModeActive() is
// just the pin; there is no second, scroll-driven half to OR it with any more.

import { adjustCornellRows } from "../cards/all-cards.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { isNotesStreamBusy } from "../render/block-cache.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "../render/tables.js?v=__BUILD__";
import { FOCUS_MODE_KEY } from "./view-mode.js?v=__BUILD__";

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

// ...and a second one, for the same reason and registered the same way: the
// rail carries its own copy of the Focus mode and Full screen rows, and it
// reads their state back off the original buttons rather than deriving it
// (refreshReadingRailModes). Copying an answer means being told when the answer
// changes — otherwise a mode flipped by Ctrl+Q, by Escape, or by the browser's
// own F11 while the tray is open leaves the rail showing the state before.
// The tray repainting only when it is OPENED covered the common case and not
// that one.
let onChromeModes = () => {};

export function setChromeModesHandler(fn) {
  onChromeModes = typeof fn === "function" ? fn : () => {};
}

export let chromeFocusPinned = false;

// Setter: an imported binding is read-only, and main.js seeds it from localStorage at startup.
export function setChromeFocusPinned(value) {
  chromeFocusPinned = value;
}

export let chromeSettleUntil = 0;

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
// It runs far more often than it looks. Every focus-mode fold and unfold
// animates the appbar's height, and main.js watches that box with a
// ResizeObserver that calls straight back in here. So a reader toggling focus
// mode was paying hundreds of milliseconds of whole-document work per press,
// for two numbers that only three elements read.
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
  // Purely the pin now — there is no scroll-driven lock any more. Focus mode
  // folds the chrome if and only if the reader pressed something that means
  // "fold it": the ⤢ button, Ctrl+., the reading rail's Focus row, or Escape/
  // Back to leave. Scrolling never changes this.
  const collapsed = chromeFocusPinned;
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
  // Gated on the ANSWER changing, not on `changed` — cheap either way now that
  // isFocusModeActive() is just the pin, but there is no reason to rewrite
  // three attributes on a button that is hidden in Cards view anyway when
  // nothing about it actually changed.
  const active = isFocusModeActive();
  if (active !== focusBtnShowsPinned && el.focusModeBtn) {
    focusBtnShowsPinned = active;
    el.focusModeBtn.setAttribute("aria-pressed", active ? "true" : "false");
    // Into the glyph SPAN, never onto the button. The button also carries its
    // name and its On/Off switch now (it is a row in the ⋯ menu, see
    // notes-head-overflow.js), and `button.textContent = …` would delete both
    // the first time the pin was turned on. The fallback is for a layout that
    // has not got a glyph span — the old behaviour, unchanged.
    const glyph = el.focusModeBtn.querySelector(".nhm-ico") || el.focusModeBtn;
    glyph.textContent = active ? "⤡" : "⤢";
    el.focusModeBtn.title = active
      ? "Focus mode on (Ctrl + . or Esc) — bring the header back"
      : "Focus mode (Ctrl + .) — keep the header hidden while you read";
    onChromeModes();
  }
}

// Is the header folded because the reader asked for it? There is only one way
// in now — the pin — so this is a thin, stable name for the callers that used
// to have to think about "pin OR lock" (Escape, the phone's Back key, Ctrl+.,
// the reading rail).
export function isFocusModeActive() {
  return Boolean(chromeFocusPinned);
}

// One path for all four ways in and out — the ⤢ button, Escape, the keyboard
// shortcut, and the reading rail's Leave focus — so they can't drift on what
// "off" means.
export function setFocusMode(pinned) {
  if (chromeFocusPinned === pinned) return;
  setChromeFocusPinned(pinned);
  try {
    localStorage.setItem(FOCUS_MODE_KEY, chromeFocusPinned ? "1" : "0");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
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
// ── ...and they are INDEPENDENT, which they were not ───────────────────────
//
// Entering full screen used to turn focus mode on, and leaving it used to turn
// focus mode off, on the argument that a fullscreen window still showing the
// deck title and the tabs is not what anyone means by full screen. That reads
// well and it is wrong the moment either mode has a light on it: the reader
// presses one toggle and watches a different toggle change by itself, and then
// presses Escape and watches a mode they set by hand ten minutes ago switch off
// with it. A control that moves when you did not touch it is not a control.
//
// So each one now does exactly what its own label says. Full screen is the
// browser's chrome; focus mode is the app's; wanting both is two presses, and
// both of them stay pressed until something the reader did unpresses them.
// Escape still leaves full screen first and focus mode second
// (src/ui/back-gesture.js), which is the right order and unaffected by this.
//
// ⚠ Ctrl+Q is the browser's own quit accelerator in Chrome on Linux and (as
// Cmd+Q) on macOS, and preventDefault cannot always take that back. Where it is
// swallowed, the ⛶ button in the ⋯ menu is the way in.
export function isFullscreenAvailable() {
  return typeof document !== "undefined"
    && Boolean(document.documentElement?.requestFullscreen)
    && document.fullscreenEnabled !== false;
}

// Where the API is missing (iOS Safari has it on <video> only) there is no
// immersive mode to be in, and this says so.
//
// It used to answer `chromeFocusPinned` there, which was the honest answer
// while entering full screen implied focus mode. Now that the two are
// independent it would be a lie in the one direction that matters: the Full
// screen button would light up because the reader turned FOCUS mode on, on the
// device where pressing Full screen does nothing at all.
export function isImmersive() {
  return isFullscreenAvailable() ? Boolean(document.fullscreenElement) : false;
}

// What #immersiveModeBtn currently says. Starts null (not false) for the same
// reason focusBtnShowsPinned does: the first call must always paint it.
export let immersiveBtnShowsOn = null;

export function paintImmersiveButton() {
  if (!el.immersiveModeBtn) return;
  const on = isImmersive();
  if (on === immersiveBtnShowsOn) return;
  immersiveBtnShowsOn = on;
  // The rail carries a copy of this row and reads its state back off this
  // button. Told, rather than left to notice on its next open.
  onChromeModes();
  el.immersiveModeBtn.setAttribute("aria-pressed", on ? "true" : "false");
  el.immersiveModeBtn.title = !isFullscreenAvailable()
    ? "Full screen isn't available in this browser — Ctrl + Q hides the app's own header instead"
    : on
      ? "Leave full screen (Ctrl + Q, or Esc)"
      : "Full screen (Ctrl + Q) — hide the browser as well";
}

// Fire-and-forget: requestFullscreen/exitFullscreen REJECT rather than throw
// when the gesture has expired or a policy refuses, and there is nothing useful
// to do about it. The button is repainted from the fullscreenchange listener
// below rather than from here, so what it shows is what actually happened and
// not what was asked for.
//
// Focus mode is deliberately not touched — see the note above this section.
// This function is about the browser's chrome; setFocusMode is about the app's;
// a reader who wants both presses both, and neither light moves on its own.
export function setImmersiveMode(on) {
  if (on) {
    if (isFullscreenAvailable() && !document.fullscreenElement) {
      Promise.resolve(document.documentElement.requestFullscreen()).catch(() => paintImmersiveButton());
    } else {
      paintImmersiveButton();
    }
    return;
  }
  if (document.fullscreenElement) Promise.resolve(document.exitFullscreen()).catch(() => {});
  else paintImmersiveButton();
}

export function toggleImmersiveMode() {
  setImmersiveMode(!isImmersive());
}

// Leaving fullscreen by F11, by Escape, or by the browser's own control has to
// be reflected here, or the ⛶ button stays lit for a mode the window is no
// longer in. One path out, whoever asked for it.
//
// It used to call setFocusMode(false) here as well, to match setImmersiveMode
// turning focus mode on. Both halves of that coupling are gone (see the note
// above isFullscreenAvailable): pressing F11 must not switch off a mode the
// reader set by hand and did not ask to leave. What comes back is a window with
// its browser chrome restored and the app's own chrome exactly as it was.
export function initImmersiveMode() {
  paintImmersiveButton();
  document.addEventListener("fullscreenchange", () => paintImmersiveButton());
}
