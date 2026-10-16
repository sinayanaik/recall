// The time log: how long the reader has actually spent in the app, today, this
// week and in all, and in which file and which part of it.
//
// ACTIVE time only. The clock runs while the app is on screen and the reader
// has touched it — a press, a key, a wheel, a scroll — in the last two minutes,
// and stops two minutes after the last one. A tab left open overnight is not a
// night of reading.
//
// A 5-second heartbeat does the counting, and also hands each beat's active
// time to the reading tracker (src/stats/reading-progress.js) so the time left
// is recomputed on every beat, not only when the page moves.

import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { activePdfId, PDF_PRIMARY_ID } from "../documents/pdf-multi.js?v=__BUILD__";
import { openDocumentPdfId } from "../documents/pdf-view.js?v=__BUILD__";
import { isHomeVisible } from "../ui/home-state.js?v=__BUILD__";
import { activeSpan } from "./reading-math.js?v=__BUILD__";
import { leaveReadingSurface, tickReadingProgress } from "./reading-progress.js?v=__BUILD__";
import { flushReadingStats, recordActiveTime, statsFileKey } from "./reading-stats-store.js?v=__BUILD__";

export const ACTIVITY_TICK_MS = 5 * 1000;
export const ACTIVITY_IDLE_MS = 2 * 60 * 1000;

let lastInputAt = 0;
let lastTickAt = 0;
let tickTimer = 0;


// Where the reader is: { ids, title, part } inside a file, null on Home or
// with nothing open (the time still counts toward the day and the total).
export function activityPlace() {
  if (isHomeVisible() || !hasActiveDeck() || state.folderDeck) return null;
  const ids = { deckId: state.deckId || null, localDeckId: state.localDeckId || null };
  if (!statsFileKey(ids)) return null;
  const mode = state.viewMode;
  const part = mode === "notes" ? "notes"
    : mode === "document" ? `doc:${openDocumentPdfId() || activePdfId(state.meta) || PDF_PRIMARY_ID}`
      : mode === "handwriting" ? "handwriting"
        : "cards";
  return { ids, title: state.deckTitle || "", part };
}

function appOnScreen() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

// Counts up to now. Called by the heartbeat, and before anything that changes
// where the reader is, so the time already spent goes to the place it was
// spent in.
// `leaving` is the app going to the background: the page already reads as
// hidden by then, and the seconds before it still count.
export function tickActivity(now = Date.now(), { leaving = false } = {}) {
  const from = lastTickAt || now;
  lastTickAt = now;
  if (!leaving && !appOnScreen()) return 0;
  const active = activeSpan(from, now, lastInputAt, ACTIVITY_IDLE_MS);
  const place = activityPlace();
  if (active > 0) recordActiveTime(active, place, now);
  tickReadingProgress(place && (place.part === "notes" || place.part.startsWith("doc:")) ? active : 0);
  return active;
}

// setViewMode, just before the switch lands.
export function noteViewSwitch(previous, next) {
  if (previous === next) return;
  tickActivity();
  leaveReadingSurface();
}

function noteInput() {
  lastInputAt = Date.now();
}

export function flushActivity() {
  tickActivity(Date.now(), { leaving: true });
  leaveReadingSurface();
  flushReadingStats();
}

export function initActivityLog() {
  if (tickTimer) return;
  const now = Date.now();
  lastInputAt = now;
  lastTickAt = now;
  const options = { capture: true, passive: true };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(type, noteInput, options);
  // Scroll does not bubble, but it does pass through the capture phase.
  window.addEventListener("scroll", noteInput, options);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushActivity();
      return;
    }
    // Back on screen: the time away is not counted, and coming back counts as
    // the reader being here.
    lastTickAt = Date.now();
    lastInputAt = lastTickAt;
  });
  tickTimer = setInterval(() => tickActivity(), ACTIVITY_TICK_MS);
}
