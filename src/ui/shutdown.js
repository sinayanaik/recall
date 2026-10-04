// Shut down: save everything, sync it, then close.
//
// Closing the tab was the only way out, and it is a gamble. The pagehide flush
// (src/main.js) writes the open deck to this device synchronously, but it cannot
// wait for the network — so whatever had not reached the cloud yet stays behind
// until the next launch on THIS device, and an edit made in the last few seconds
// can miss even the local save if the browser tears the page down first.
//
// So the ☰ drawer and the reading rail offer a Shut down that does the whole
// thing in order and says when it is done:
//
//   1. the local flush the pagehide handler makes, run now while there is time;
//   2. a full sync (reconcileAllDecks), which also commits an open editor,
//      flushes the pending autosave and uploads queued images. Run as a
//      background sync, not an explicit one: an explicit run ends in the sync
//      report modal, which would open behind this screen. It waits for a run
//      already under way first, because a background run that finds one in
//      flight returns without doing anything;
//   3. only if that sync really carried everything: stop auto-sync and close.
//
// window.close() only works on a window a script opened — an installed app's
// window counts, an ordinary browser tab does not — so when the page is still
// here a moment later the screen says it is safe to close the tab instead.
//
// A sync that did not finish never closes on its own: the screen says the decks
// are safe on this device but not in the cloud, and offers Try again, Close
// anyway and Cancel.

import { flushReadingPositionSave } from "../notes/reading-position.js?v=__BUILD__";
import { flushIndexBatch } from "../library/local-library.js?v=__BUILD__";
import { flushWorkingDeck } from "./edit-mode.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { lastReconcileOutcome, reconcileAllDecks, reconcileInFlight, reconcilePromise } from "../sync/reconcile.js?v=__BUILD__";
import { suspendAutoSync } from "../sync/auto-sync.js?v=__BUILD__";

// How long window.close() gets to take the page away before the screen says to
// close the tab by hand.
export const SHUTDOWN_CLOSE_WAIT_MS = 400;

let shutdownRunning = false;
let shutdownClosed = false;

const shutdownEl = (id) => document.getElementById(id);

// Everything but the overlay is made inert while it is up: no press, no focus,
// no typing into a note behind a screen that says the note has been saved.
function setAppInertForShutdown(on) {
  const view = shutdownEl("shutdownView");
  [...document.body.children].forEach((node) => {
    if (node === view || node.tagName === "SCRIPT") return;
    if (on) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  });
}

function paintShutdown({ state, title, text }) {
  const view = shutdownEl("shutdownView");
  if (!view) return;
  view.dataset.state = state;
  shutdownEl("shutdownTitle").textContent = title;
  shutdownEl("shutdownText").textContent = text;
  // Which buttons a state offers is the stylesheet's business
  // (styles/77-shutdown.css), keyed on data-state.
}

function showShutdownView() {
  const view = shutdownEl("shutdownView");
  if (!view) return;
  view.hidden = false;
  setAppInertForShutdown(true);
}

function hideShutdownView() {
  const view = shutdownEl("shutdownView");
  if (!view) return;
  view.hidden = true;
  setAppInertForShutdown(false);
}

// The same three writes the pagehide handler makes, in the same order: the
// reading position first (it rides in the deck snapshot), then the deck, then
// the deck index a sync may be holding open.
function flushForShutdown() {
  try { flushReadingPositionSave(); } catch (error) { console.warn("Shut down: could not save the reading position", error); }
  try { flushWorkingDeck(); } catch (error) { console.warn("Shut down: could not save the open deck", error); }
  try { flushIndexBatch(); } catch (error) { console.warn("Shut down: could not flush the deck index", error); }
}

// The sync writes what it is doing into the Sync Now button on every run
// ("Uploading decks… (3 of 12)"); this screen repeats it, so a long sync on a
// slow connection reads as progress rather than a hang.
async function syncForShutdown() {
  const label = el.syncNowBtn;
  const timer = setInterval(() => {
    const text = label?.textContent?.trim();
    if (text && /…/.test(text)) shutdownEl("shutdownText").textContent = text;
  }, 250);
  try {
    // A few rounds at most: each waits out whichever run is in flight, and the
    // run that follows is ours.
    for (let round = 0; round < 3; round++) {
      if (reconcileInFlight && reconcilePromise) {
        try { await reconcilePromise; } catch (_) { /* reported by its own run */ }
        continue;
      }
      await reconcileAllDecks({ explicit: false });
      return;
    }
  } finally {
    clearInterval(timer);
  }
}

const SHUTDOWN_NOT_SYNCED_REASONS = {
  offline: "You're offline, so the latest changes didn't reach the cloud.",
  signedout: "Your sign-in has lapsed, so the latest changes didn't reach the cloud.",
  error: "The sync didn't finish, so the latest changes may not be in the cloud.",
  partial: "Some decks didn't sync, so their latest changes aren't in the cloud yet."
};

function finishShutdown(text) {
  shutdownClosed = true;
  suspendAutoSync();
  paintShutdown({ state: "done", title: "Recall is shut down", text });
  // Works in an installed app's window; a browser tab ignores it, and the
  // screen above is then the answer.
  try { window.close(); } catch (_) { /* not ours to close */ }
  setTimeout(() => {
    if (document.visibilityState === "visible") shutdownEl("shutdownReopenBtn")?.focus();
  }, SHUTDOWN_CLOSE_WAIT_MS);
}

export async function shutDownApp() {
  if (shutdownRunning || shutdownClosed) return;
  shutdownRunning = true;
  showShutdownView();
  try {
    paintShutdown({ state: "working", title: "Shutting down…", text: "Saving your work on this device…" });
    flushForShutdown();
    paintShutdown({ state: "working", title: "Shutting down…", text: "Syncing your decks with the cloud…" });
    await syncForShutdown();
    // Once more after the sync: a pull can reload the open deck, and the index
    // batch it opened is shutdownClosed in its finally.
    flushForShutdown();
    const outcome = lastReconcileOutcome;
    if (outcome === "synced") {
      finishShutdown("Everything is saved on this device and synced to the cloud. It's safe to close this tab.");
    } else if (outcome === "signin") {
      finishShutdown("Everything is saved on this device. Sign in next time to sync it to your other devices. It's safe to close this tab.");
    } else {
      paintShutdown({
        state: "unsynced",
        title: "Not synced yet",
        text: `${SHUTDOWN_NOT_SYNCED_REASONS[outcome] || SHUTDOWN_NOT_SYNCED_REASONS.error} Everything is saved on this device.`
      });
      shutdownEl("shutdownRetryBtn")?.focus();
    }
  } catch (error) {
    console.error("Shut down failed", error);
    paintShutdown({ state: "unsynced", title: "Not synced yet", text: `${SHUTDOWN_NOT_SYNCED_REASONS.error} Everything is saved on this device.` });
  } finally {
    shutdownRunning = false;
  }
}

export function initShutdown() {
  const on = (id, handler) => shutdownEl(id)?.addEventListener("click", handler);
  on("shutdownBtn", () => shutDownApp());
  on("shutdownRetryBtn", () => shutDownApp());
  on("shutdownCloseAnywayBtn", () => {
    flushForShutdown();
    finishShutdown("Everything is saved on this device. It will sync the next time you open Recall online. It's safe to close this tab.");
  });
  on("shutdownCancelBtn", () => { if (!shutdownClosed) hideShutdownView(); });
  on("shutdownReopenBtn", () => location.reload());
}
