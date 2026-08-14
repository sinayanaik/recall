// The universal Back button: no wiring per feature and no destination name —
// it steps back through the places you have been (decks, notes, the Quick Notes
// board), the way the back key on a remote does.

import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { loadWebDeck } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { closeQuickNotesBoard, loadDeckFromLibrary, openQuickNotesBoard, qnBoard, setQnReturnState, state } from "../main.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { captureCurrentReadingAnchor, currentDeckKey, currentReadingAnchor, currentReadingAnchorDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { setStatus } from "./feedback.js?v=__BUILD__";
import { setViewMode } from "./view-mode.js?v=__BUILD__";

// ── Universal back ───────────────────────────────────────────────
// The appbar's ← works like the back key on a remote: it steps back through the
// places you've been, whatever they were. There is no per-feature wiring and no
// destination label — every navigation records where you WERE on its way out,
// and back replays that.
//
// A "location" is whatever you're looking at: a deck (with the card you were on
// and the view mode) or the Quick Notes board (with its filters/search/scroll).
// Recording happens at the three doors every navigation goes through:
// loadDeckFromLibrary, loadWebDeck and openQuickNotesBoard.
export const navHistory = [];

// Bounded: an unbounded stack would pin snapshots forever, and nobody steps
// back further than this.
export const NAV_HISTORY_LIMIT = 25;

// >0 while we're replaying history — restoring a location must never be
// recorded as a new navigation, or back would bounce between two places.
export let navSuppressDepth = 0;

// Pre-existing bug, surfaced while auditing (not introduced by the async deck
// storage work, but made worse by it): a `finally` after `fn()` decrements the
// depth the instant fn RETURNS, not when it's done. That's correct for a sync
// fn, but goToNavLocation was already async before this, and loadDeckFromLibrary
// is now async too — for either, `fn()` returns a pending promise immediately,
// the finally fires right away, and the suppression window closes BEFORE the
// async work inside (which is what calls recordNavHistory) has even run. The
// net effect: a navigation meant to be suppressed gets recorded anyway,
// corrupting the back-history stack. Await the result when it's a promise,
// and only then decrement.
export function suppressNavRecording(fn) {
  navSuppressDepth += 1;
  let result;
  try {
    result = fn();
  } catch (error) {
    navSuppressDepth -= 1;
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => { navSuppressDepth -= 1; return value; },
      (error) => { navSuppressDepth -= 1; throw error; }
    );
  }
  navSuppressDepth -= 1;
  return result;
}

// Where the user is right now, or null on the welcome screen (nothing to record).
export function currentNavLocation(hint = {}) {
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) {
    return {
      kind: "quick-notes",
      state: {
        cardId: hint.cardId || null,
        filters: [...qnBoard.filters],
        query: qnBoard.query,
        scrollTop: el.qnBody ? el.qnBody.scrollTop : 0
      }
    };
  }
  if (state.localDeckId || state.deckId) {
    return {
      kind: "deck",
      localId: state.localDeckId || null,
      deckId: state.deckId || null,
      current: Number.isFinite(state.current) ? state.current : 0,
      viewMode: state.viewMode,
      // Where in the note you were reading, so back lands on the paragraph you
      // left rather than the top. Only captured when actually RECORDING a
      // departure: currentNavLocation is also called by peekNavBack and
      // refreshNavBack, which run on every overlay change, and
      // captureCurrentReadingAnchor costs a caretPositionFromPoint plus a
      // couple of snippet searches — not something to pay for on a question
      // as cheap as "is the back button enabled?".
      anchor: hint.captureAnchor ? freshReadingAnchor() : null
    };
  }
  return null;
}

// The reading anchor for the deck that is open RIGHT NOW, or null. The deck-key
// check is the same guard deckSnapshot uses: an anchor captured while reading
// deck A must never be attached to deck B just because no scroll has happened
// in B yet.
export function freshReadingAnchor() {
  if (state.viewMode !== "notes") return null;
  captureCurrentReadingAnchor();
  if (!currentReadingAnchor) return null;
  return currentReadingAnchorDeckKey === currentDeckKey() ? currentReadingAnchor : null;
}

// Same place? Deck identity only — flipping cards inside a deck isn't a
// navigation, and there's only ever one Quick Notes board.
export function sameNavLocation(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "quick-notes") return true;
  return (a.localId || a.deckId) === (b.localId || b.deckId);
}

// Called by each navigation door BEFORE it moves the user.
//
// Deliberately does NOT refresh the button: at this instant the user is still
// at the old location, so "is there anywhere to go back to?" would answer no.
// Each door calls refreshNavBack() once it has actually arrived.
export function recordNavHistory(hint) {
  if (navSuppressDepth) return;
  const here = currentNavLocation({ ...hint, captureAnchor: true });
  if (!here) return;
  const top = navHistory[navHistory.length - 1];
  if (top && sameNavLocation(top, here)) navHistory.pop(); // refresh, don't stack
  navHistory.push(here);
  if (navHistory.length > NAV_HISTORY_LIMIT) navHistory.shift();
}

// The newest entry that isn't simply where we already are. Closing the board,
// for instance, lands you back on the deck that's still sitting on top of the
// history — going "back" to it would be a no-op, so skip past it.
export function peekNavBack() {
  const here = currentNavLocation();
  for (let i = navHistory.length - 1; i >= 0; i--) {
    if (!sameNavLocation(navHistory[i], here)) return { entry: navHistory[i], index: i };
  }
  return null;
}

export function refreshNavBack() {
  if (el.appBackBtn) el.appBackBtn.disabled = !peekNavBack();
}

export function clearNavHistory() {
  navHistory.length = 0;
  refreshNavBack();
}

export async function goToNavLocation(location) {
  if (location.kind === "quick-notes") {
    setQnReturnState(location.state);
    await openQuickNotesBoard({ restore: true });
    return;
  }
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) closeQuickNotesBoard();
  // Prefer the local copy: instant, and works offline.
  if (location.localId && (await loadDeckFromLibrary(location.localId))) {
    restoreDeckPosition(location);
    return;
  }
  if (location.deckId && supabaseClient && navigator.onLine) {
    await loadWebDeck(location.deckId);
    restoreDeckPosition(location);
    return;
  }
  setStatus("Couldn't go back — that deck isn't available on this device.", "error");
}

// Step back one place. Re-entrancy guarded: restoring is async (it may load a
// deck), and a double-tap would otherwise skip two entries.
//
// Returns whether it actually went anywhere. The hardware Back key needs that
// answer to decide between "handled — stay in the app" and "nothing left — let
// the browser leave".
export let navBackBusy = false;

export async function goNavBack() {
  if (navBackBusy) return false;
  const found = peekNavBack();
  if (!found) return false;
  // Drop the target and anything above it, so back never revisits.
  navHistory.length = found.index;
  navBackBusy = true;
  try {
    await suppressNavRecording(() => goToNavLocation(found.entry));
  } catch (error) {
    console.warn("Could not go back", error);
    setStatus("Couldn't go back to where you were.", "error");
  } finally {
    navBackBusy = false;
    refreshNavBack();
  }
  return true;
}

// Put the user back on the card and view they were on when they left.
export function restoreDeckPosition(location) {
  if (Array.isArray(state.cards) && state.cards.length) {
    state.current = Math.min(Math.max(location.current || 0, 0), state.cards.length - 1);
    showCard();
  }
  if (location.viewMode) setViewMode(location.viewMode);
  // ...and at the paragraph they were reading, not the top of the note. Left
  // until after setViewMode on purpose: setViewMode resets scrollTop before it
  // renders whenever the note differs from the one currently laid out, so a
  // jump scheduled before it would simply be undone. scheduleNoteJump does its
  // own retrying across the frames the render takes.
  if (location.anchor && location.viewMode === "notes") {
    scheduleNoteJump(location.anchor, { flash: false, smooth: false });
  }
}
