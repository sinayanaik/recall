// When a deck's notes were edited on two devices, neither copy is safe to
// discard, so the loser is stashed and the user is asked. Nothing here throws
// text away without an answer.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { deleteDeckSnapshot, readDeckSnapshot, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { NOTES_CONFLICT_SUFFIX } from "../storage/keys.js?v=__BUILD__";
import { mergeRestoredNotes, promoteStashedNotes } from "./notes-conflict-merge.js?v=__BUILD__";
import { refreshSyncIndicatorBaseline } from "./indicator.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

// Put back the deck-notes body a pull replaced. The stash holds the copy this
// device had; restoring appends it below the incoming text under a marker
// rather than replacing it, so neither version is lost and the user can edit
// the two together. Bumps updatedAt so the merged result is what gets pushed.
export async function restoreStashedNotes(localId) {
  const stash = await readDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  if (!stash || !String(stash.notes || "").trim()) {
    // Nothing to put back, so there is no longer a conflict to answer. Without
    // this the flag outlived the stash and the deck advertised a conflict whose
    // resolver could only ever say "nothing left to restore" — a dead end that
    // no amount of syncing cleared.
    clearNotesConflictFlag(localId);
    await refreshAfterNotesConflictResolved(localId, { reload: false });
    showToast("Nothing left to restore", "info");
    return false;
  }

  const snapshot = await readDeckSnapshot(localId);
  if (!snapshot) {
    showToast("That deck is no longer on this device", "error");
    return false;
  }

  const when = stash.savedAt ? new Date(stash.savedAt).toLocaleString() : "an earlier sync";
  // Through mergeRestoredNotes rather than a bare concatenation. A stash holds
  // the WHOLE notes string — the fenced highlight-note block included, because
  // the pull mines its tail to recover stranded annotations — and appending that
  // verbatim made the stash's OLDER block the live one (highlightNotesBlockSpan
  // takes the last opening marker), demoted the merged block into the body where
  // it rendered as prose, and then pushed the deck to every device in that
  // state. On the button that says "Nothing is lost".
  snapshot.notes = mergeRestoredNotes(snapshot.notes, stash.notes, when);
  const now = new Date().toISOString();
  writeDeckSnapshot(localId, snapshot);
  const index = readLocalDeckIndex();
  const entry = index.find((m) => m.id === localId);
  if (entry) {
    entry.updatedAt = now;
    entry.hasNotes = true;
    // The conflict is resolved — both versions are now in the notes body, and
    // the stash below is about to be deleted. Without clearing this the deck
    // would keep showing "Notes conflict" forever, pointing at a stash that no
    // longer exists.
    entry.notesConflicted = false;
    writeLocalDeckIndex(index);
  }
  deleteDeckSnapshot(localId + NOTES_CONFLICT_SUFFIX);
  await refreshAfterNotesConflictResolved(localId);
  showToast("Your notes were added back at the end of the deck's notes", "success");
  return true;
}

export function notesConflictStashKey(localId) {
  return localId + NOTES_CONFLICT_SUFFIX;
}

// Clears the persisted flag. Deliberately does NOT touch the stash — callers
// decide whether the losing copy is still wanted.
export function clearNotesConflictFlag(localId, { touch = false } = {}) {
  const index = readLocalDeckIndex();
  const entry = index.find((m) => m.id === localId);
  if (!entry) return false;
  entry.notesConflicted = false;
  // Only when the resolution CHANGED the notes: a bumped updatedAt is what makes
  // the next push carry the result up. Accepting the synced copy changes nothing
  // locally and must not fake an edit.
  if (touch) entry.updatedAt = new Date().toISOString();
  writeLocalDeckIndex(index);
  return true;
}

export async function refreshAfterNotesConflictResolved(localId, { reload = true } = {}) {
  if (reload && state.localDeckId === localId) await loadDeckFromLibrary(localId);
  if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
  refreshSyncIndicatorBaseline();
}

// "both" is restoreStashedNotes (append under a dated marker, nothing lost).
// "mine" promotes the stashed copy to BE the notes. "synced" accepts what
// arrived and drops the stash. All three clear the flag, because a conflict the
// reader has answered must stop advertising itself — the flag used to be sticky
// until the deck happened to be pulled again (only a pull recomputes it, and a
// push never clears it), so a deck that was never pulled again showed "Notes
// conflict" for good.
export async function resolveNotesConflict(localId, choice) {
  if (choice === "both") return restoreStashedNotes(localId);

  const snapshot = await readDeckSnapshot(localId);
  if (!snapshot) {
    showToast("That deck is no longer on this device", "error");
    return false;
  }

  if (choice === "mine") {
    const stash = await readDeckSnapshot(notesConflictStashKey(localId));
    if (!stash || !String(stash.notes || "").trim()) {
      clearNotesConflictFlag(localId);
      await refreshAfterNotesConflictResolved(localId, { reload: false });
      showToast("Nothing left to restore", "info");
      return false;
    }
    // The stash's PROSE, joined to the block the deck currently holds. Assigning
    // the stash whole replaced the merged highlight notes with whatever copy
    // happened to be in the stash when it was written, discarding every note
    // that has merged in since — the reader asked to keep their own writing, not
    // to roll back their annotations.
    snapshot.notes = promoteStashedNotes(snapshot.notes, stash.notes);
    writeDeckSnapshot(localId, snapshot);
    const index = readLocalDeckIndex();
    const entry = index.find((m) => m.id === localId);
    if (entry) entry.hasNotes = Boolean(snapshot.notes.trim());
    writeLocalDeckIndex(index);
    clearNotesConflictFlag(localId, { touch: true });
  } else {
    clearNotesConflictFlag(localId);
  }

  deleteDeckSnapshot(notesConflictStashKey(localId));
  await refreshAfterNotesConflictResolved(localId, { reload: choice === "mine" });
  showToast(
    choice === "mine"
      ? "Your version is back — it will upload on the next sync"
      : "Kept the synced version; your saved copy was discarded",
    "success"
  );
  return true;
}

// Enough of each version to tell them apart at a glance. Plain text, not
// rendered markdown: the point is to identify a version, and a 300KB note
// rendered into a modal would be neither quick nor readable.
export const NOTES_CONFLICT_PREVIEW_CHARS = 600;

export function notesConflictPreview(text) {
  const body = String(text || "").trim();
  if (!body) return `<p class="notes-conflict-empty">(empty)</p>`;
  const clipped = body.slice(0, NOTES_CONFLICT_PREVIEW_CHARS);
  const more = body.length > clipped.length ? "\n…" : "";
  return `<pre class="notes-conflict-preview">${escapeHtml(clipped + more)}</pre>`;
}

// The resolver itself. Reuses the #syncModal chrome the same way showSyncReport
// does — its footer Cancel becomes "Close", and the three real choices are
// buttons in the body so they can carry their own explanation.
export async function showNotesConflictModal(localId) {
  const modal = el.syncModal;
  const content = el.syncDetailsContent;
  if (!modal || !content || !localId) return;

  const [snapshot, stash] = await Promise.all([
    readDeckSnapshot(localId),
    readDeckSnapshot(notesConflictStashKey(localId))
  ]);

  if (!stash || !String(stash.notes || "").trim()) {
    clearNotesConflictFlag(localId);
    await refreshAfterNotesConflictResolved(localId, { reload: false });
    showToast("That conflict has already been dealt with", "info");
    return;
  }

  const titleEl = document.getElementById("syncModalTitle");
  const confirmBtn = document.getElementById("confirmSyncBtn");
  const cancelBtn = document.getElementById("cancelSyncBtn");
  if (titleEl) titleEl.textContent = "Notes conflict";
  if (confirmBtn) confirmBtn.hidden = true;
  if (cancelBtn) cancelBtn.textContent = "Decide later";

  const when = stash.savedAt ? new Date(stash.savedAt).toLocaleString() : "an earlier sync";
  const deckTitle = snapshot?.deckTitle || stash.deckTitle || "this deck";

  content.innerHTML = `
    <p class="notes-conflict-intro">
      Another device saved a newer version of <strong>${escapeHtml(deckTitle)}</strong>'s notes, and
      syncing replaced the copy on this device. Your copy was saved on ${escapeHtml(when)} and is still
      here — choose which one to keep.
    </p>
    <div class="notes-conflict-versions">
      <section class="notes-conflict-version">
        <h3>Now on this device (from the other device)</h3>
        ${notesConflictPreview(snapshot?.notes)}
      </section>
      <section class="notes-conflict-version">
        <h3>Your saved copy</h3>
        ${notesConflictPreview(stash.notes)}
      </section>
    </div>
    <div class="notes-conflict-choices">
      <button type="button" class="sync-modal-btn is-primary" data-conflict-choice="both">
        Keep both
        <span>Adds your copy to the end, under a dated heading. Nothing is lost.</span>
      </button>
      <button type="button" class="sync-modal-btn" data-conflict-choice="mine">
        Keep mine
        <span>Replaces the notes with your copy and uploads it on the next sync.</span>
      </button>
      <button type="button" class="sync-modal-btn" data-conflict-choice="synced">
        Keep the synced version
        <span>Discards your saved copy. This cannot be undone.</span>
      </button>
    </div>
  `;

  content.onclick = async (event) => {
    const button = event.target.closest("[data-conflict-choice]");
    if (!button) return;
    const choice = button.dataset.conflictChoice;
    // Both destructive answers are one tap from here, so the irreversible one
    // asks first. "Keep both" and "Keep mine" leave every version recoverable.
    // Disabled rather than put through setButtonLoading: these buttons carry a
    // <span> of explanation, and that helper swaps textContent, which would
    // flatten the span away and never bring it back.
    const choices = Array.from(content.querySelectorAll("[data-conflict-choice]"));
    const run = async () => {
      choices.forEach((node) => { node.disabled = true; });
      try {
        if (await resolveNotesConflict(localId, choice)) modal.hidden = true;
      } finally {
        choices.forEach((node) => { node.disabled = false; });
      }
    };
    if (choice === "synced") {
      showConfirmModal(
        "Discard your saved copy of these notes and keep the synced version? This cannot be undone.",
        run,
        { confirmLabel: "Discard my copy", danger: true }
      );
      return;
    }
    await run();
  };

  modal.hidden = false;
}
