// The sync pill: when the last sync was, when the next one is, and what the
// empty library says while it is still loading.

import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { listLocalDecks, readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { autoSyncNextAt, getAutoSyncMinutes, state } from "../main.js?v=__BUILD__";
import { LAST_GLOBAL_SYNC_ERROR_KEY, LAST_GLOBAL_SYNC_KEY } from "../storage/keys.js?v=__BUILD__";
import { restoreStashedNotes } from "./notes-conflict.js?v=__BUILD__";
import { lastStartupSyncReport, reconcileInFlight } from "./reconcile.js?v=__BUILD__";
import { buildSyncReportHtml } from "./report.js?v=__BUILD__";

// Coarse "Xm ago" style relative time, for the sync pill's last-synced suffix.
export function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// ── The pill's countdown to the next auto-sync ─────────────────────────────
// The pill said whether a sync had happened but nothing about whether another
// one was coming, which made an armed auto-sync indistinguishable from one
// that had quietly stopped. It now carries "↻ 4m" / "↻ 45s" / "↻ off".
//
// The countdown lives in its own child node so the once-a-second tick rewrites
// only that, instead of rebuilding the whole label — which would mean parsing
// the local deck index out of localStorage every second for the relative
// last-synced time.
export let syncCountdownEl = null;

// Rounds UP above a minute, the way a countdown should: with 117s left this says
// "2m", not the "1m" a floor would give a full minute too early.
export function formatSyncCountdown(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.ceil(mins / 60)}h`;
}

// The suffix text, or "" when there's nothing worth saying (signed out, no deck,
// mid-sync — "next in 4m" while it's actually syncing is just noise).
export function syncCountdownText() {
  if (!supabaseClient || !isSignedIn || !hasActiveDeck()) return "";
  const mins = getAutoSyncMinutes();
  if (!mins) return "↻ off";
  if (reconcileInFlight) return "";
  if (!navigator.onLine) return "↻ paused";
  return `↻ ${formatSyncCountdown(autoSyncNextAt - Date.now())}`;
}

export function renderSyncCountdown() {
  const node = el.syncIndicator;
  if (!node) return;
  const text = syncCountdownText();
  const mins = getAutoSyncMinutes();
  const title = mins
    ? `Auto-sync every ${mins} min${mins === 1 ? "" : "s"}${text ? ` — ${text.replace("↻ ", "")} to the next one` : ""}`
    : "Auto-sync is off — use Sync Now, or pick an interval in the menu";
  // Compared before assigning, like the countdown's own textContent below.
  // This runs from a 1s ticker that never stops, so an unconditional write was
  // an attribute mutation every second for the life of the tab even when
  // auto-sync is off and the string never changes.
  if (node.title !== title) node.title = title;
  // `!node.textContent` means the pill itself is empty (no deck): nothing to
  // hang a countdown off, and an orphan "↻ 4m" on its own would be nonsense.
  if (!text || !node.textContent) {
    syncCountdownEl?.remove();
    syncCountdownEl = null;
    return;
  }
  if (!syncCountdownEl || syncCountdownEl.parentNode !== node) {
    syncCountdownEl = document.createElement("span");
    syncCountdownEl.className = "sync-countdown";
    node.appendChild(syncCountdownEl);
  }
  if (syncCountdownEl.textContent !== text) syncCountdownEl.textContent = text;
}

// Reflects the auto-save / cloud-sync lifecycle in the deck-meta pill.
export function setSyncIndicator(stateName) {
  const node = el.syncIndicator;
  if (!node) return;
  // textContent below drops the countdown child, so it's re-appended at the end.
  syncCountdownEl = null;
  if (!hasActiveDeck()) {
    node.textContent = "";
    node.dataset.state = "idle";
    // An empty pill must not keep whatever the last deck left behind, or it
    // stays clickable and opens a resolver for a deck nobody has open.
    node.dataset.action = "";
    node.dataset.conflictDeck = "";
    node.style.pointerEvents = "";
    return;
  }
  const labels = {
    signin: "Saved on device",
    saved: "Saved on device",
    saving: "Syncing…",
    synced: "Synced",
    offline: "Offline · saved on device",
    // A lapsed token is not a lapsed connection. This used to reuse "offline",
    // so a phone whose refresh token had expired in a pocket showed an offline
    // badge on a perfectly good network and never synced again — the one state
    // the user could have fixed in two taps, dressed as the one they couldn't.
    signedout: "Signed out · tap to sign in",
    error: "Sync failed · saved on device",
  };
  let resolvedState = stateName === "signin" ? "saved" : stateName;
  let text = labels[stateName] || "";
  // Which deck the pill would open the notes-conflict resolver for, if any.
  let conflictId = "";
  if (stateName === "synced" && state.localDeckId) {
    const localMeta = readLocalDeckIndex().find((m) => m.id === state.localDeckId);
    // Timestamps alone (all this state normally reflects) can't tell "fully
    // synced" apart from "cards synced, notes silently didn't" — check the
    // flags pushLibraryDeckToCloud/pullCloudDeckToLibrary persist for exactly
    // this, so the pill doesn't claim success a deck's notes didn't reach.
    if (localMeta?.notesSyncFailed) {
      resolvedState = "error";
      text = "Notes not synced";
    } else if (localMeta?.notesConflicted) {
      resolvedState = "error";
      // Was "see Sync Now", which led nowhere: a second sync finds the deck
      // already matching, so it logs nothing and renders no report — and the
      // report was the only thing that ever carried a way out.
      text = "Notes conflict — tap to fix";
      conflictId = state.localDeckId;
    } else {
      const relative = formatRelativeTime(localMeta?.lastSyncedAt);
      if (relative) text += ` · ${relative}`;
    }
  }
  node.dataset.state = resolvedState;
  node.textContent = text;
  // Two pills say "tap to …", so both have to accept a tap. Everything else is
  // a status report and stays inert.
  node.dataset.action = resolvedState === "signedout" ? "signin" : (conflictId ? "notes-conflict" : "");
  node.dataset.conflictDeck = conflictId;
  node.style.pointerEvents = node.dataset.action ? "auto" : "";
  renderSyncCountdown();
}

// Sets the resting state of the pill (used after a deck loads, when there are no
// pending edits) based on where the deck currently lives.
export function refreshSyncIndicatorBaseline() {
  if (!hasActiveDeck()) return setSyncIndicator("idle");
  if (!supabaseClient || !isSignedIn) return setSyncIndicator("saved");
  if (!navigator.onLine) return setSyncIndicator("offline");
  return setSyncIndicator(state.deckId ? "synced" : "signin");
}

// Swaps the shared #deckEmptyState container between two variants: "none"
// (nothing loaded at all — New Deck/Import/My Decks) and "active" (a deck
// exists but has zero cards yet — prompts to add one or draft notes first).
export function renderDeckEmptyState(mode) {
  const isActive = mode === "active";
  if (el.deckEmptyIcon) el.deckEmptyIcon.textContent = isActive ? "🗂️" : "📚";
  if (el.deckEmptyTitle) el.deckEmptyTitle.textContent = isActive ? "No cards yet" : "Recall";
  if (el.deckEmptyBody) {
    el.deckEmptyBody.textContent = isActive
      ? "Add your first card, or draft in Notes first:"
      : "Choose how to get started:";
  }
  if (el.deckEmptyActionsNone) el.deckEmptyActionsNone.hidden = isActive;
  if (el.deckEmptyActionsActive) el.deckEmptyActionsActive.hidden = !isActive;
  if (el.deckEmptyPanel) el.deckEmptyPanel.hidden = isActive;
  if (isActive) {
    if (el.deckEmptySyncReport) el.deckEmptySyncReport.hidden = true;
  } else {
    updateDeckEmptyStatus();
    renderWelcomeSyncReport();
  }
}

// Inline replacement for the old "Startup Sync Report" popup: the same
// per-deck breakdown, rendered directly on the welcome screen instead of a
// modal, so it's only ever seen where it's actually relevant (nothing else
// to look at) and never interrupts active use.
export function renderWelcomeSyncReport() {
  const node = el.deckEmptySyncReport;
  if (!node) return;
  if (!lastStartupSyncReport) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  const { deckLog, pulled, pushed, failed } = lastStartupSyncReport;
  node.innerHTML = `<p class="deck-empty-sync-report-title">Startup Sync Report</p>${buildSyncReportHtml(deckLog, { pulled, pushed, failed })}`;
  // The report can carry a "Restore my notes" button; a background sync's
  // report is the one the user is most likely to be looking at, so it has to
  // work here too, not only in the explicit-sync modal.
  node.onclick = async (event) => {
    const button = event.target.closest("[data-recover-notes]");
    if (!button) return;
    if (await restoreStashedNotes(button.dataset.recoverNotes)) button.remove();
  };
  node.hidden = false;
}

// Fills in the Sync Status / Your Decks rows on the "Recall" welcome screen so
// it's never a dead end — this is the same information the per-deck sync
// pill (setSyncIndicator) shows once a deck is loaded, plus the local
// library's deck count, laid out as two clearly labeled fields instead of one
// blended sentence. Called whenever that screen is shown, at the start/end of
// a reconcile, and on online/offline transitions.
export function updateDeckEmptyStatus() {
  const syncNode = el.deckEmptySyncValue;
  const libraryNode = el.deckEmptyLibraryValue;
  if (!syncNode || !libraryNode) return;

  const count = listLocalDecks().length;
  libraryNode.textContent = count ? `${count} saved deck${count === 1 ? "" : "s"} on this device` : "No decks yet";

  if (!supabaseClient || !isSignedIn) {
    syncNode.textContent = "💾 Local only — sign in to back up to the cloud";
    return;
  }
  if (!navigator.onLine) {
    syncNode.textContent = "📴 Offline — will sync once you're back online";
    return;
  }
  if (reconcileInFlight) {
    syncNode.textContent = "🔄 Checking for updates from the cloud…";
    return;
  }
  if (localStorage.getItem(LAST_GLOBAL_SYNC_ERROR_KEY)) {
    syncNode.textContent = "⚠️ Sync failed — will retry automatically";
    return;
  }
  const lastSync = formatRelativeTime(localStorage.getItem(LAST_GLOBAL_SYNC_KEY));
  syncNode.textContent = lastSync ? `✅ Synced · last checked ${lastSync}` : "✅ Signed in and ready to sync";
}
