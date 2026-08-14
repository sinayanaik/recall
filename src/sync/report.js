// What a sync actually did, per deck: pulled, pushed, failed.

import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { restoreStashedNotes } from "./notes-conflict.js?v=__BUILD__";
import { describeSyncStats } from "./stats.js?v=__BUILD__";

// Shared HTML for a sync report — every deck reconcileAllDecks() touched,
// what direction it went, and exactly what changed (cards added/updated/
// deleted, notes). Used both by the explicit-sync modal and the inline
// startup report on the welcome screen.
export function buildSyncReportHtml(deckLog, { pulled = 0, pushed = 0, failed = 0 } = {}) {
  const describeCounts = (entry) => {
    const parts = describeSyncStats(entry);
    return parts.length ? parts.join(", ") : "no per-card changes (deck metadata only)";
  };

  const rows = deckLog.map((entry) => {
    if (entry.direction === "failed") {
      return `<li class="sync-report-row sync-report-row-error">
        <strong>${escapeHtml(entry.title)}</strong> — sync failed
        <div class="sync-report-detail">${escapeHtml(entry.error || "Unknown error")}</div>
      </li>`;
    }
    const dirLabel = entry.direction === "pulled"
      ? "⬇ Downloaded from cloud"
      : entry.direction === "removed"
        ? "🗑 Removed from this device"
        : "⬆ Uploaded to cloud";
    // A replaced notes body is the one thing sync can still overwrite, so it
    // gets an actual way out rather than only a line of prose saying it happened.
    const recover = entry.notesConflicted && entry.localId
      ? `<button type="button" class="sync-report-recover" data-recover-notes="${escapeHtml(entry.localId)}">Restore my notes</button>`
      : "";
    return `<li class="sync-report-row">
      <strong>${escapeHtml(entry.title)}</strong> — ${dirLabel}
      <div class="sync-report-detail">${describeCounts(entry)}</div>
      ${recover}
    </li>`;
  }).join("");

  return `
    <p class="sync-report-summary">${pulled} deck${pulled === 1 ? "" : "s"} downloaded, ${pushed} deck${pushed === 1 ? "" : "s"} uploaded${failed ? `, ${failed} failed` : ""}</p>
    <ul class="sync-report-list">${rows}</ul>
  `;
}

// Post-sync report modal for an EXPLICIT "Sync Now" click only — background
// startup/reconnect syncs render their report inline on the welcome screen
// instead (see renderWelcomeSyncReport) rather than popping a modal.
// Reuses the (otherwise-dead, since the manual "Sync to Cloud" button it was
// written for no longer exists) #syncModal chrome, repurposed as a plain
// report instead of a confirm-before-you-sync prompt.
export function showSyncReport(deckLog, { pulled = 0, pushed = 0, failed = 0 } = {}) {
  const modal = el.syncModal;
  const content = el.syncDetailsContent;
  if (!modal || !content) return;

  const titleEl = document.getElementById("syncModalTitle");
  const confirmBtn = document.getElementById("confirmSyncBtn");
  const cancelBtn = document.getElementById("cancelSyncBtn");
  if (titleEl) titleEl.textContent = "Sync Report";
  if (confirmBtn) confirmBtn.hidden = true;
  if (cancelBtn) cancelBtn.textContent = "Close";

  content.innerHTML = buildSyncReportHtml(deckLog, { pulled, pushed, failed });
  // Delegated so the buttons keep working across re-renders of the report.
  content.onclick = async (event) => {
    const button = event.target.closest("[data-recover-notes]");
    if (!button) return;
    if (await restoreStashedNotes(button.dataset.recoverNotes)) button.remove();
  };
  modal.hidden = false;
}
