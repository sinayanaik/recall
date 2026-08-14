// Folding the notes header away with the rest of the chrome.
//
// `body.chrome-collapsed` (src/ui/chrome.js) already folds the appbar and the
// Cards/Notes toggle — on a phone when you scroll down, at any width when focus
// mode is pinned. It has never touched the notes header, so the "reading room"
// it buys stops one bar short of the thing you are reading.
//
// This publishes --notes-head-h so the CSS can animate that header over its
// REAL height, and does nothing else: the class, the scroll tracking and the
// pin all stay where they are.
//
// The measurement carries the two guards from readChromeHeights(), and both are
// load-bearing:
//
//   • never measure while collapsed — the box is 0 tall by definition, and
//     recording that makes 0 the height the expand animates *to*, so the header
//     could never come back;
//   • never measure mid-transition — a ResizeObserver fires on every frame of
//     an expand, and adopting an intermediate height leaves the header settling
//     a little shorter on each cycle.
//
// A 300px→0 tween over a ~40px bar is the exact mistake that made focus mode
// feel broken before it was measured; see the block comment at
// styles/12-notes.css:1155.

import { CHROME_SETTLE_MS, chromeSettleUntil } from "../ui/chrome.js?v=__BUILD__";

let notesHeadEl = null;
let notesHeadRefitTimer = 0;

// scrollHeight, not offsetHeight — and this one is not a nicety.
//
// The variable being written here is the SAME variable the CSS clamps the
// header with (max-height: var(--notes-head-h)), so offsetHeight reports the
// clamped box, not the natural one. Once 41px had been recorded for a one-row
// header, opening the formatting strip could never widen it past 41px: the box
// stayed clamped, the observer re-read 41, and the second row spilled over the
// note instead of pushing it down. scrollHeight is the content height and
// ignores max-height entirely; the borders are added back because it excludes
// them and the clamp is on the border box.
export function readNotesHeadHeight() {
  if (!notesHeadEl?.scrollHeight) return;
  const styles = getComputedStyle(notesHeadEl);
  const borders = (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
  document.documentElement.style.setProperty("--notes-head-h", `${Math.ceil(notesHeadEl.scrollHeight + borders)}px`);
}

export function measureNotesHeadHeight() {
  if (document.body.classList.contains("chrome-collapsed")) return;
  // chromeSettleUntil is an imported live binding — it tracks the window
  // applyChromeCollapse() opens on every fold, so the two headers agree about
  // when the layout has stopped moving.
  if (performance.now() < chromeSettleUntil) return;
  readNotesHeadHeight();
}

// Re-armed, not stacked: the observer fires many times across one fold, and one
// unguarded read once everything has stopped moving is all that is wanted.
export function scheduleNotesHeadRefit() {
  clearTimeout(notesHeadRefitTimer);
  notesHeadRefitTimer = setTimeout(() => {
    notesHeadRefitTimer = 0;
    if (!document.body.classList.contains("chrome-collapsed")) readNotesHeadHeight();
  }, CHROME_SETTLE_MS + 40);
}

// Called by anything that changes the header's natural height on purpose —
// today that is the phone-only formatting-strip disclosure, which turns the
// header from one row into two. It needs its own hook precisely BECAUSE of the
// clamp above: the observer watches the border box, the border box is pinned to
// the last measurement, so the growth the observer exists to notice is exactly
// the growth it cannot see.
export function refreshNotesHeadHeight() {
  measureNotesHeadHeight();
  scheduleNotesHeadRefit();
}

export function initNotesHeadFold() {
  notesHeadEl = document.querySelector("#notesStage .notes-head");
  if (!notesHeadEl || typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(() => {
    measureNotesHeadHeight();
    scheduleNotesHeadRefit();
  });
  // The header AND its children. The header's own box is clamped, so a child
  // growing (a wider toolbar, a taller button after a style change) may not
  // change it at all; the children are unclamped and always report.
  observer.observe(notesHeadEl);
  Array.from(notesHeadEl.children).forEach((child) => observer.observe(child));
  measureNotesHeadHeight();
}
