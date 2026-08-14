// The background sync timer. Per device, and an explicit Off is remembered.

import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { renderSyncCountdown } from "./indicator.js?v=__BUILD__";
import { reconcileAllDecks, reconcileInFlight } from "./reconcile.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// ── User-defined auto-sync ──────────────────────────────────────────────────
// Runs the same two-way reconcile as "Sync Now" on a cadence the user picks, so
// they don't have to click it. Device-local (each device sets its own).
//
// This used to be a bare setInterval(mins × 60s), which is why auto-sync looked
// like it ran once and then went to sleep:
//
//   • A backgrounded tab has its timers throttled hard (on mobile, often frozen
//     outright), so a 5-minute interval on a phone fires nowhere near every 5
//     minutes — and nothing caught up when the tab came back.
//   • A tick that landed while signed out or offline was dropped entirely, and
//     the next one was a full interval away. Coming back online meant waiting.
//   • An explicit Sync Now didn't reset the interval, so a sync could fire
//     seconds after the user had just synced by hand.
//
// So the schedule is a DEADLINE (autoSyncNextAt) rather than an interval, and a
// 1-second ticker compares it against the clock. Wall-clock time can't be
// throttled away: however long the tab was frozen, the first tick after it wakes
// sees the deadline is past and syncs. The same ticker paints the pill's
// countdown, and every completed sync — background or explicit — re-arms the
// deadline from when it actually finished.
export const AUTOSYNC_KEY = "recall_autosync_minutes";

export const AUTOSYNC_ALLOWED = new Set([0, 1, 2, 5, 10, 15, 30]);

export const AUTOSYNC_TICK_MS = 1000;

export let autoSyncTicker = null;

export let autoSyncNextAt = Infinity;

// What a device that has never opened the setting gets. It used to be 0 — off —
// which meant a new user's only syncs were: boot, reconnect, returning to the
// foreground after a minute away, and the manual button. Nothing was broken;
// nothing was scheduled either, and "my decks don't reach my other device" is
// what that feels like. Anyone who once set an interval (including the
// developer) had a completely different experience of the same build.
export const AUTOSYNC_DEFAULT_MINUTES = 5;

export function getAutoSyncMinutes() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTOSYNC_KEY);
  } catch (_) {
    raw = null;
  }
  // Absent means "never chosen", which is NOT the same as a stored 0. An
  // explicit "Off" is a real preference and has to survive; only the untouched
  // case gets the default.
  if (raw === null) return AUTOSYNC_DEFAULT_MINUTES;
  const v = parseInt(raw, 10);
  return AUTOSYNC_ALLOWED.has(v) ? v : 0;
}

// Push the next auto-sync a full interval out from now. Called when the cadence
// changes and after every sync completes, so "next in 5m" always means five
// minutes since the last one actually ran, not since some fixed grid.
export function rearmAutoSync() {
  const mins = getAutoSyncMinutes();
  autoSyncNextAt = mins ? Date.now() + mins * 60 * 1000 : Infinity;
  renderSyncCountdown();
}

export function autoSyncTick() {
  // Only the repaint is skipped behind a hidden tab — the sync check below
  // still runs, because a backgrounded tab is exactly when an auto-sync is
  // worth having. The countdown is derived from wall-clock time, so it is
  // correct again as soon as the tab is shown.
  if (!document.hidden) renderSyncCountdown();
  if (!getAutoSyncMinutes()) return;
  if (Date.now() < autoSyncNextAt) return;
  // Not syncable right now (signed out, offline, or a sync already running).
  // Leave the deadline in the past so the very next tick that CAN sync does,
  // instead of silently forfeiting this cycle and waiting a whole interval.
  if (!supabaseClient || !isSignedIn || !navigator.onLine || reconcileInFlight) return;
  // reconcileAllDecks re-arms in its finally block; do it here too so a rejected
  // promise (it handles its own errors, but be safe) can't wedge the loop into
  // firing on every single tick.
  rearmAutoSync();
  reconcileAllDecks({ explicit: false });
}

export function applyAutoSyncInterval() {
  const mins = getAutoSyncMinutes();
  if (el.autoSyncSelect) el.autoSyncSelect.value = String(mins);
  rearmAutoSync();
  // One ticker for the life of the page: it also drives the countdown, which is
  // wanted even with auto-sync off (it's what says "off").
  if (!autoSyncTicker) autoSyncTicker = setInterval(autoSyncTick, AUTOSYNC_TICK_MS);
}

export function setAutoSyncMinutes(mins) {
  const clean = AUTOSYNC_ALLOWED.has(mins) ? mins : 0;
  try {
    localStorage.setItem(AUTOSYNC_KEY, String(clean));
  } catch (_) {
    /* storage unavailable (private mode) — timer still applies for this session */
  }
  applyAutoSyncInterval();
  showToast(clean ? `Auto-sync on — every ${clean} min${clean === 1 ? "" : "s"}` : "Auto-sync off", "info");
}
