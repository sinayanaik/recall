// Version history: every earlier version of a note's text, so that nothing a
// sync or a merge ever replaces is gone for good.
//
// Two sources, one list:
//
//   on this device  an IndexedDB store of its own (recall-history), written
//                   whenever a sync or another window replaces the body this
//                   device held, and as a checkpoint at most every ten minutes
//                   while the reader types — so even an edit the reader regrets
//                   can be walked back.
//   in the cloud    the deck_revisions table (supabase_setup.sql, section 9),
//                   filled by a trigger on every write that changes the notes,
//                   from every device. Absent on an older project, and then the
//                   panel says so and shows the local half.
//
// Restoring is an ordinary edit: the chosen text becomes the note, the version
// it replaces is kept here first, and the next sync sends it. The highlight
// notes at the end of a note are left as they are — they are merged entry by
// entry and are never part of what a version restores.

import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "../cloud/net.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { joinHighlightNotesTail, splitHighlightNotesTail } from "../format/notes-fence.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { deviceLabel } from "./device.js?v=__BUILD__";

export const HISTORY_DB = "recall-history";
const HISTORY_STORE = "versions";
export const HISTORY_MAX_PER_DECK = 40;
export const HISTORY_CHECKPOINT_MS = 10 * 60 * 1000;

let historyDbPromise = null;

function openHistoryDb() {
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("byDeck", "localId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  historyDbPromise.catch(() => { historyDbPromise = null; });
  return historyDbPromise;
}

function historyRequest(mode, run) {
  return openHistoryDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, mode);
    const request = run(tx.objectStore(HISTORY_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export async function listNoteVersions(localId) {
  if (!localId) return [];
  try {
    const rows = await historyRequest("readonly", (store) => store.index("byDeck").getAll(String(localId)));
    return (rows || []).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  } catch (error) {
    console.warn("Could not read this note's version history", error);
    return [];
  }
}

// Keep a version of a note's BODY. Never throws — history is a safety net, and
// a net that can fail the save it protects is worse than none. A version equal
// to the newest one already kept is not kept twice.
export async function recordNoteVersion(localId, { notes, deckTitle = "", source = "this device", reason = "" } = {}) {
  const body = splitHighlightNotesTail(String(notes || "")).body;
  if (!localId || !body.trim()) return false;
  try {
    const existing = (await listNoteVersions(localId)).filter((v) => v.kind !== "card");
    if (existing[0] && existing[0].notes === body) return false;
    await historyRequest("readwrite", (store) => store.add({
      localId: String(localId),
      notes: body,
      deckTitle: String(deckTitle || ""),
      source,
      reason,
      device: deviceLabel(),
      savedAt: new Date().toISOString()
    }));
    const stale = existing.slice(HISTORY_MAX_PER_DECK - 1);
    for (const old of stale) {
      await historyRequest("readwrite", (store) => store.delete(old.id));
    }
    return true;
  } catch (error) {
    console.warn("Could not keep a version of this note", error);
    return false;
  }
}

// A card field both devices changed differently keeps this device's text; the
// other device's goes here, so it is never simply gone. Shown in the panel as
// card text to copy back, not as a note version to restore.
export function recordLostCardText(localId, deckTitle, items, otherFrom = "another device") {
  for (const item of items || []) {
    if (!String(item.text || "").trim()) continue;
    historyRequest("readwrite", (store) => store.add({
      localId: String(localId),
      kind: "card",
      notes: String(item.text),
      deckTitle: String(deckTitle || ""),
      source: otherFrom,
      reason: `card ${item.field} from ${otherFrom}, not kept`,
      device: otherFrom,
      savedAt: new Date().toISOString()
    })).catch((error) => console.warn("Could not keep a card's other version", error));
  }
}

// A checkpoint while typing: the body as it was before this save, at most once
// per HISTORY_CHECKPOINT_MS per deck.
const lastCheckpointAt = new Map();
export function checkpointNoteVersion(localId, previousNotes, deckTitle) {
  if (!localId) return;
  const now = Date.now();
  if (now - (lastCheckpointAt.get(String(localId)) || 0) < HISTORY_CHECKPOINT_MS) return;
  lastCheckpointAt.set(String(localId), now);
  recordNoteVersion(localId, { notes: previousNotes, deckTitle, source: "this device", reason: "while editing" });
}

// ── The cloud's half ───────────────────────────────────────────────────────

export async function listCloudRevisions(deckId) {
  if (!deckId || !supabaseClient || !isSignedIn || !navigator.onLine) return { rows: [], available: false };
  try {
    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient
        .from("deck_revisions")
        .select("id, created_at, version_at, device, replaced_by, title")
        .eq("deck_id", deckId)
        .order("created_at", { ascending: false })
        .limit(50)
        .abortSignal(signal)),
      CLOUD_TIMEOUT_MS,
      "read version history"
    );
    if (error) return { rows: [], available: false, missing: /deck_revisions|relation|schema cache/i.test(error.message || "") };
    return { rows: data || [], available: true };
  } catch (error) {
    console.warn("Could not read the cloud's version history", error);
    return { rows: [], available: false };
  }
}

async function readCloudRevisionNotes(id) {
  const { data, error } = await withTimeout(
    abortable((signal) => supabaseClient.from("deck_revisions").select("notes").eq("id", id).abortSignal(signal)),
    CLOUD_TIMEOUT_MS,
    "read a version"
  );
  if (error) throw error;
  return String(data?.[0]?.notes ?? "");
}

// ── Restoring ──────────────────────────────────────────────────────────────

export async function restoreNoteVersion(localId, body) {
  const ok = await withDeckLock(localId, async () => {
    const snapshot = await readDeckSnapshot(localId);
    if (!snapshot) return false;
    // The version being replaced is kept first, so a restore can be undone by
    // restoring again.
    await recordNoteVersion(localId, { notes: snapshot.notes, deckTitle: snapshot.deckTitle, reason: "before a restore" });
    const tail = splitHighlightNotesTail(String(snapshot.notes || "")).tail;
    snapshot.notes = joinHighlightNotesTail(splitHighlightNotesTail(String(body || "")).body, tail);
    writeDeckSnapshot(localId, snapshot);
    const index = readLocalDeckIndex();
    const entry = index.find((m) => m.id === localId);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      entry.hasNotes = Boolean(snapshot.notes.trim());
      writeLocalDeckIndex(index);
    }
    return true;
  });
  if (ok) showToast("Version restored — it will sync to your other devices", "success");
  return ok;
}

// ── The panel ──────────────────────────────────────────────────────────────

const PREVIEW_CHARS = 1200;
function versionFirstLine(text) {
  return String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "(empty)";
}

function versionWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

export async function showVersionHistory(localId = state.localDeckId) {
  const modal = el.syncModal;
  const content = el.syncDetailsContent;
  if (!modal || !content) return;
  if (!localId) {
    showToast("Open a note first — Version history is per note", "info");
    return;
  }
  const entry = readLocalDeckIndex().find((m) => m.id === localId);
  const titleEl = document.getElementById("syncModalTitle");
  const confirmBtn = document.getElementById("confirmSyncBtn");
  const cancelBtn = document.getElementById("cancelSyncBtn");
  if (titleEl) titleEl.textContent = "Version history";
  if (confirmBtn) confirmBtn.hidden = true;
  if (cancelBtn) cancelBtn.textContent = "Close";
  content.innerHTML = `<p class="version-history-loading">Loading versions…</p>`;
  modal.hidden = false;

  const [local, cloud] = await Promise.all([listNoteVersions(localId), listCloudRevisions(entry?.deckId)]);
  const localRows = local.map((v) => `
    <li class="version-row">
      <div class="version-meta"><strong>${escapeHtml(versionWhen(v.savedAt))}</strong>
        <span>${escapeHtml(v.reason || v.source || "")}${v.device ? ` · ${escapeHtml(v.device)}` : ""}</span></div>
      <div class="version-first-line">${escapeHtml(versionFirstLine(v.notes).slice(0, 140))}</div>
      <div class="version-actions">
        <button type="button" class="sync-modal-btn" data-version-preview="local:${v.id}">Preview</button>
        ${v.kind === "card"
          ? `<button type="button" class="sync-modal-btn" data-version-copy="local:${v.id}">Copy text</button>`
          : `<button type="button" class="sync-modal-btn" data-version-restore="local:${v.id}">Restore</button>`}
      </div>
      <pre class="version-preview" hidden></pre>
    </li>`).join("");
  const cloudRows = cloud.rows.map((r) => `
    <li class="version-row">
      <div class="version-meta"><strong>${escapeHtml(versionWhen(r.version_at || r.created_at))}</strong>
        <span>${r.device ? `written on ${escapeHtml(r.device)}` : "written on a device"}${r.replaced_by === "deleted" ? " · last version before the deck was deleted" : r.replaced_by ? ` · replaced by ${escapeHtml(r.replaced_by)}` : ""}</span></div>
      <div class="version-first-line">${escapeHtml(r.title || "")}</div>
      <div class="version-actions">
        <button type="button" class="sync-modal-btn" data-version-preview="cloud:${r.id}">Preview</button>
        <button type="button" class="sync-modal-btn" data-version-restore="cloud:${r.id}">Restore</button>
      </div>
      <pre class="version-preview" hidden></pre>
    </li>`).join("");
  const cloudNote = cloud.available
    ? (cloud.rows.length ? "" : `<p class="version-empty">No earlier versions in the cloud yet.</p>`)
    : cloud.missing
      ? `<p class="version-empty">Cloud history isn't set up on this project yet — re-run <code>supabase_setup.sql</code> in Supabase to turn it on.</p>`
      : `<p class="version-empty">Cloud history isn't reachable right now (offline or signed out).</p>`;

  content.innerHTML = `
    <p class="notes-conflict-intro">Earlier versions of <strong>${escapeHtml(entry?.title || "this note")}</strong>'s text.
      Restoring one keeps the current text as a version too, so nothing is lost either way.</p>
    <h3 class="version-heading">In the cloud (from all your devices)</h3>
    ${cloudNote}<ul class="version-list">${cloudRows}</ul>
    <h3 class="version-heading">On this device</h3>
    ${local.length ? `<ul class="version-list">${localRows}</ul>` : `<p class="version-empty">No earlier versions kept on this device yet.</p>`}
  `;

  const textFor = async (key) => {
    const [kind, id] = key.split(":");
    if (kind === "local") return local.find((v) => String(v.id) === id)?.notes ?? "";
    return readCloudRevisionNotes(id);
  };
  content.onclick = async (event) => {
    const preview = event.target.closest("[data-version-preview]");
    const restore = event.target.closest("[data-version-restore]");
    if (preview) {
      const row = preview.closest(".version-row");
      const pre = row?.querySelector(".version-preview");
      if (!pre) return;
      if (!pre.hidden) { pre.hidden = true; return; }
      try {
        const text = splitHighlightNotesTail(await textFor(preview.dataset.versionPreview)).body;
        pre.textContent = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : (text || "(empty)");
        pre.hidden = false;
      } catch (error) {
        showToast("Couldn't load that version", "error");
      }
      return;
    }
    const copy = event.target.closest("[data-version-copy]");
    if (copy) {
      try {
        await navigator.clipboard.writeText(await textFor(copy.dataset.versionCopy));
        showToast("Copied", "success");
      } catch {
        showToast("Couldn't copy — use Preview and select the text", "error");
      }
      return;
    }
    if (restore) {
      try {
        const text = await textFor(restore.dataset.versionRestore);
        if (await restoreNoteVersion(localId, text)) modal.hidden = true;
      } catch (error) {
        console.warn("Could not restore a version", error);
        showToast("Couldn't restore that version", "error");
      }
    }
  };
}
