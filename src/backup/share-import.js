// Somebody else's decks, as decks of your own.
//
// A restore puts YOUR library back: it matches a deck in the archive to the deck
// it was on this device, by the ids the two share, and merges. None of that is
// right for a package somebody handed you. Their deck ids are rows in THEIR
// account — `decks.id`, `cards.id` and `deleted_decks.deck_id` are primary keys
// across every user of a Supabase project, so a deck imported with its sender's
// ids is a deck whose first push collides with the sender's row, is read as a
// lost race, retries, finds nothing it is allowed to see, and never syncs.
// Their images and papers are objects in THEIR storage, which this account can
// never read. And the pointers between their decks — [[links]], a quick note's
// "pinned from", a card an anchor belongs to — all name ids that mean nothing
// here.
//
// So an import is a translation, done once, in front of a preview:
//
//   • every deck gets a local id of its own and NO cloud id, so its first push
//     creates a row that belongs to this account;
//   • every card gets a new id — derived from this account, the deck's origin
//     and the card's old id, so importing the SAME package again (an update
//     from the sender) lands on the same cards instead of beside them;
//   • every id that points between decks — [[Label|id]], [[Label|qn:card]],
//     a pinned-from anchor, meta.noteAnchors — is rewritten to the new ones;
//   • every picture is adopted into this device's outbox and uploaded to this
//     account's storage, and every paper is stored on this device under the new
//     deck and uploaded to this account's bucket, with the sender's locators
//     stripped;
//   • the quick-notes deck, which every account has exactly one of, is merged
//     into yours rather than arriving as a second one.
//
// The recipient's own progress always wins over the sender's: a card they have
// marked known stays known when an update arrives.

import { LAST_USER_STORAGE_KEY } from "../boot.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { flushPendingImageUploads } from "../images/outbox.js?v=__BUILD__";
import { FOLDER_SEP, addKnownFolder, folderSegments, normalizeDeckCategory, readKnownFolders } from "../library/folders.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { ensureLocalQuickNotesSnapshot, getQuickNotesDeckId, quickNotesLocalId } from "../quick-notes/categories.js?v=__BUILD__";
import { QUICK_NOTES_DECK_TITLE } from "../quick-notes/palette.js?v=__BUILD__";
import { NOTE_LINK_PATTERN } from "../render/note-links.js?v=__BUILD__";
import { deckWriteSettled, forEachDeckSnapshot, readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { scheduleDocumentBackfill } from "../storage/document-migration.js?v=__BUILD__";
import { repairSnapshotText } from "../sync/text-repair.js?v=__BUILD__";
import { flushWorkingDeck } from "../ui/edit-mode.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import {
  PACKAGE_KIND_SHARE, SHARE_META_POLICY, SHARE_POLICY_PROGRESS, stripAccountLocators
} from "./archive-format.js?v=__BUILD__";
import { mergeBackupMeta, normalizeBackupMeta, showBackupProgress } from "./backup.js?v=__BUILD__";
import { commitBackupDocuments, planBackupDocumentRestore } from "./documents.js?v=__BUILD__";
import { formatJobBytes } from "./job-console.js?v=__BUILD__";
import {
  RESTORE_STEPS, applyBackupAssetRewrites, applyRestore, backupDeckFingerprint, backupDeckToSnapshot,
  commitBackupAssets, mergeDeckSnapshots, planBackupAssetAdoption, planRestore, readRecallPackage,
  showRestorePreview, upsertRestoredMeta
} from "./restore.js?v=__BUILD__";
import { LiteZip, yieldToPage } from "./zip-lite.js?v=__BUILD__";

// ── Ids ─────────────────────────────────────────────────────────────────────

// cyrb53, twice with different seeds: a 106-bit hash, which for ids minted per
// account from a few thousand cards is comfortably past any collision anyone
// will live to see. Synchronous and dependency-free, because it runs once per
// card and has to give the same answer on every device.
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

export function stableImportHash(text) {
  const value = String(text);
  return `${cyrb53(value, 1)}${cyrb53(value, 2)}`;
}

// Whose library this is. The account's id when there is one (it is what keeps
// two people's imports of the same package from minting the same card ids), a
// fixed stand-in when there is not.
export function importingUserId() {
  try { return localStorage.getItem(LAST_USER_STORAGE_KEY) || "device"; } catch { return "device"; }
}

// What a deck in a package is recognised by. The writer records it; an archive
// written before v4 falls back to the deck's cloud id, and then to its content.
export function packageDeckOrigin(deck) {
  return String(deck?.origin || deck?.deckId || deck?.archiveLocalId || `t:${backupDeckFingerprint(deck)}`);
}

export function importLocalIdFor(uid, origin, salt = "") {
  return `ld_imp_${stableImportHash(`${uid}\u0000${origin}\u0000${salt}`)}`;
}

export function importCardIdFor(uid, origin, cardId, salt = "") {
  return `c-${stableImportHash(`${uid}\u0000${origin}\u0000${cardId}\u0000${salt}`)}`;
}

export function isQuickNotesPackageDeck(deck) {
  if (String(deck?.deckId || "").startsWith("quick-notes-")) return true;
  return String(deck?.title || "").trim().toLowerCase() === QUICK_NOTES_DECK_TITLE;
}

// ── Rewriting what points between decks ─────────────────────────────────────

// [[Label|target]] with the target translated. A target naming a deck or a
// quick note that came in the same package is pointed at its new id; one naming
// something that did not is left exactly as written — it still resolves by its
// label, which is what a hand-typed [[Title]] link does anyway.
export function rewritePackageLinks(text, { deckIds = new Map(), cardIds = new Map() } = {}) {
  const source = String(text || "");
  if (!source.includes("[[")) return source;
  return source.replace(NOTE_LINK_PATTERN, (match, label, target) => {
    if (target === undefined || target === null || target === "") return match;
    const hash = target.indexOf("#");
    const id = hash >= 0 ? target.slice(0, hash) : target;
    const tail = hash >= 0 ? target.slice(hash) : "";
    let next = null;
    if (id.startsWith("qn:")) {
      const card = cardIds.get(id.slice(3));
      if (card) next = `qn:${card}`;
    } else if (deckIds.has(id)) {
      next = deckIds.get(id);
    }
    return next ? `[[${label}|${next}${tail}]]` : match;
  });
}

// A pinned-from anchor, pointed at the deck it came from here — or, when that
// deck did not come along, stripped of the sender's ids and left with the title
// it names, which is what the UI shows anyway.
export function remapPackageAnchor(anchor, deckIds) {
  if (!anchor || typeof anchor !== "object") return anchor;
  const out = { ...anchor };
  const target = (anchor.deckId && deckIds.get(String(anchor.deckId)))
    || (anchor.deckLocalId && deckIds.get(String(anchor.deckLocalId)))
    || null;
  out.deckId = null;
  out.deckLocalId = target;
  return out;
}

// One package deck, translated into this account. Pure: the archive's deck is
// not touched, so a preview can be planned, cancelled and planned again.
export function remintPackageDeck(deck, { targetLocalId, cardIds, deckIds, origin, packageId, salt = "", importedAt = new Date().toISOString(), title = "", category = "", keepCardIds = false }) {
  const mapCard = (id) => (keepCardIds ? String(id) : cardIds.get(String(id)) || String(id));
  const meta = { ...normalizeBackupMeta(deck.meta) };
  // A library backup imported as copies still carries its owner's locators; a
  // share never does. Stripped either way — they name somebody else's storage.
  for (const key of ["pdf", "notebook"]) {
    if (meta[key] && typeof meta[key] === "object") meta[key] = stripAccountLocators(meta[key]);
  }
  if (Array.isArray(meta.pdfs)) meta.pdfs = meta.pdfs.map(stripAccountLocators);
  if (meta.noteAnchors && typeof meta.noteAnchors === "object") {
    const anchors = {};
    for (const [cardId, anchor] of Object.entries(meta.noteAnchors)) {
      anchors[mapCard(cardId)] = remapPackageAnchor(anchor, deckIds);
    }
    meta.noteAnchors = anchors;
  }
  if (Array.isArray(meta.pdfBlocks)) {
    meta.pdfBlocks = meta.pdfBlocks.map((block) => (block && typeof block.md === "string"
      ? { ...block, md: rewritePackageLinks(block.md, { deckIds, cardIds }) }
      : block));
  }
  meta.linkIds = [targetLocalId];
  meta.importedFrom = { origin, packageId: String(packageId || ""), importedAt, ...(salt ? { salt } : {}) };
  return {
    ...deck,
    deckId: null,
    targetLocalId,
    title: title || deck.title,
    category: category || deck.category,
    notes: rewritePackageLinks(deck.notes, { deckIds, cardIds }),
    meta,
    cards: (deck.cards || []).map((card) => ({
      ...card,
      id: mapCard(card.id),
      question: rewritePackageLinks(card.question, { deckIds, cardIds }),
      answer: rewritePackageLinks(card.answer, { deckIds, cardIds }),
      ...(card.noteAnchor ? { noteAnchor: remapPackageAnchor(card.noteAnchor, deckIds) } : {})
    }))
  };
}

// ── Planning ────────────────────────────────────────────────────────────────

export const IMPORT_CHOICE_NEW = "new";

export const IMPORT_CHOICE_UPDATE = "update";

export const IMPORT_CHOICE_COPY = "copy";

export const IMPORT_CHOICE_SKIP = "skip";

// Every deck this device already has from some package, by the origin it came
// under. Read off the snapshots because the index does not carry meta — once,
// and only when the quick lookups have not already found everything.
async function importedOriginsOnDevice() {
  const byOrigin = new Map();
  await forEachDeckSnapshot((id, snapshot) => {
    const origin = snapshot?.meta?.importedFrom?.origin;
    if (origin && !String(id).includes(":")) byOrigin.set(String(origin), { localId: String(id), salt: String(snapshot.meta.importedFrom.salt || "") });
  });
  return byOrigin;
}

// The same folder the sender had, under the one the reader chose to put the
// package in.
export function importedCategory(destination, category) {
  const own = normalizeDeckCategory(category);
  const base = folderSegments(String(destination || "")).join(FOLDER_SEP);
  if (!base || base === defaultDeckCategory) return own;
  if (own === defaultDeckCategory) return base;
  return `${base}${FOLDER_SEP}${own}`;
}

export async function planPackageImport(archive, { progress = null } = {}) {
  const uid = importingUserId();
  const index = readLocalDeckIndex();
  const byId = new Map(index.map((entry) => [String(entry.id), entry]));
  let scanned = null;
  const entries = [];
  for (const deck of archive.decks) {
    const origin = packageDeckOrigin(deck);
    const quick = isQuickNotesPackageDeck(deck);
    let existing = null;
    let existingSalt = "";
    let own = false;
    if (!quick) {
      const deterministic = byId.get(importLocalIdFor(uid, origin));
      if (deterministic) existing = deterministic;
      if (!existing) {
        // Your own deck, in a package you made (or one passed back to you).
        const mine = index.find((entry) => entry.deckId && String(entry.deckId) === origin);
        if (mine) { existing = mine; own = true; }
      }
      if (!existing) {
        if (!scanned) {
          progress?.current?.("Looking for decks already imported from this package…");
          scanned = await importedOriginsOnDevice();
        }
        const hit = scanned.get(origin);
        if (hit && byId.has(hit.localId)) {
          existing = byId.get(hit.localId);
          existingSalt = hit.salt;
        }
      }
    }
    const marks = Array.isArray(deck.meta?.pdfHighlights) ? deck.meta.pdfHighlights.length : 0;
    const papers = (Array.isArray(deck.meta?.pdfs) && deck.meta.pdfs.length) ? deck.meta.pdfs.length : (deck.meta?.pdf ? 1 : 0);
    entries.push({
      deck,
      origin,
      quick,
      own,
      existing,
      existingSalt,
      title: deck.title || "Untitled deck",
      choice: quick ? IMPORT_CHOICE_UPDATE : existing ? IMPORT_CHOICE_UPDATE : IMPORT_CHOICE_NEW,
      counts: { cards: deck.cards.length, marks, papers: papers + (deck.meta?.notebook ? 1 : 0) }
    });
  }
  return {
    uid,
    entries,
    destination: "",
    packageId: String(archive.manifest?.packageId || `pkg-${stableImportHash(archive.decks.map(packageDeckOrigin).join("|")).slice(0, 12)}`),
    title: String(archive.manifest?.title || "")
  };
}

// ── The preview ─────────────────────────────────────────────────────────────

export function showPackageImportPreview(plan, archive) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal restore-preview-modal package-import-modal";
    modal.setAttribute("aria-label", "Import decks");

    const manifest = archive.manifest || {};
    const images = archive.assets?.size || 0;
    const papers = archive.documentIndex?.documents?.length || 0;
    const papersMissing = archive.documentIndex?.missing?.length || 0;
    const made = manifest.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : "";
    const verification = archive.verification;
    const integrity = !verification || !verification.checked
      ? "This file carries no index, so it could not be checked."
      : verification.ok
        ? `Checked: every file is present${verification.hashedFiles ? ", the right size and the right bytes" : " and the right size"}.`
        : `This file does not match its own index. ${verification.notes.join(" ")} Everything readable can still be imported.`;

    const rowsHtml = plan.entries.map((entry, i) => {
      const bits = [`${entry.counts.cards} card${entry.counts.cards === 1 ? "" : "s"}`];
      if (entry.counts.papers) bits.push(`${entry.counts.papers} PDF${entry.counts.papers === 1 ? "" : "s"}`);
      if (entry.counts.marks) bits.push(`${entry.counts.marks} highlight${entry.counts.marks === 1 ? "" : "s"} & ink`);
      let control;
      let badge;
      let cls;
      if (entry.quick) {
        badge = "MERGE";
        cls = "is-conflict";
        control = `<select data-import-choice="${i}"><option value="${IMPORT_CHOICE_UPDATE}">Add to my quick notes</option><option value="${IMPORT_CHOICE_SKIP}">Skip</option></select>`;
      } else if (entry.existing) {
        badge = "HAVE";
        cls = "is-conflict";
        control = `<select data-import-choice="${i}">`
          + `<option value="${IMPORT_CHOICE_UPDATE}">Update mine</option>`
          + `<option value="${IMPORT_CHOICE_COPY}">Add as a copy</option>`
          + `<option value="${IMPORT_CHOICE_SKIP}">Skip</option></select>`;
      } else {
        badge = "NEW";
        cls = "is-new";
        control = `<select data-import-choice="${i}"><option value="${IMPORT_CHOICE_NEW}">Import</option><option value="${IMPORT_CHOICE_SKIP}">Skip</option></select>`;
      }
      return `<li class="restore-row ${cls}">`
        + `<span class="restore-badge">${badge}</span>`
        + `<span class="restore-name"><span class="restore-title"></span><span class="restore-folder"></span></span>`
        + `<span class="restore-detail">${escapeHtml(bits.join(" · "))}${entry.existing ? `<br><small>${entry.own ? "your own deck" : "imported before"} — "${escapeHtml(entry.existing.title || "")}"</small>` : ""}</span>`
        + `<span class="package-import-choice">${control}</span>`
        + `</li>`;
    }).join("");

    const folderOptions = readKnownFolders().map((path) => `<option value="${escapeHtml(path)}"></option>`).join("");
    const shell = document.createElement("div");
    shell.className = "category-choice-shell restore-preview-shell package-import-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Import ${plan.entries.length} deck${plan.entries.length === 1 ? "" : "s"}${plan.title ? ` — ${escapeHtml(plan.title)}` : ""}</h2>
          <p>${escapeHtml([manifest.kind === PACKAGE_KIND_SHARE ? "A shared package" : "A library backup, imported as separate decks", made ? `made ${made}` : ""].filter(Boolean).join(" · "))}. Nothing changes until you press Import.</p>
        </div>
        <button type="button" data-import-cancel aria-label="Close">&#215;</button>
      </div>
      <ul class="restore-deck-list">${rowsHtml}</ul>
      <label class="package-import-folder">Put new decks in folder
        <input type="text" data-import-folder list="packageImportFolders" placeholder="Keep the folders they came in" autocomplete="off" value="${escapeHtml(plan.destination || "")}">
        <datalist id="packageImportFolders">${folderOptions}</datalist>
      </label>
      <p class="restore-summary">${escapeHtml([
        images ? `${images} image${images === 1 ? "" : "s"} — stored on this device, then uploaded to your own storage` : "",
        papers ? `${papers} PDF${papers === 1 ? "" : "s"} — stored on this device, then uploaded to your own bucket if you have one` : "",
        papersMissing ? `${papersMissing} PDF${papersMissing === 1 ? " was" : "s were"} not in the package (those decks will ask for the file)` : "",
        manifest.includesProgress === false ? "The sender's study progress was not included" : ""
      ].filter(Boolean).join(" · ") || "Text only.")}</p>
      <p class="restore-integrity${verification && verification.checked && !verification.ok ? " is-warning" : ""}">${escapeHtml(integrity)}</p>
      <p class="restore-note">"Update mine" merges the package into the deck you already have: new and changed cards come in, your own cards and your study progress are kept.</p>
      <div class="category-choice-actions">
        <button type="button" data-import-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-import-confirm>Import</button>
      </div>
    `;
    const titleSpans = shell.querySelectorAll(".restore-title");
    const folderSpans = shell.querySelectorAll(".restore-folder");
    plan.entries.forEach((entry, i) => {
      if (titleSpans[i]) titleSpans[i].textContent = entry.title;
      if (folderSpans[i]) {
        const folder = normalizeDeckCategory(entry.deck.category);
        folderSpans[i].textContent = folder === defaultDeckCategory ? "" : folder.split(FOLDER_SEP).join(" / ");
      }
    });
    const folderInput = shell.querySelector("[data-import-folder]");
    const confirm = shell.querySelector("[data-import-confirm]");
    const refresh = () => {
      const any = plan.entries.some((entry, i) => (shell.querySelector(`[data-import-choice="${i}"]`)?.value || entry.choice) !== IMPORT_CHOICE_SKIP);
      confirm.disabled = !any;
    };
    shell.querySelectorAll("[data-import-choice]").forEach((select) => select.addEventListener("change", refresh));

    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-import-cancel]").forEach((button) => button.addEventListener("click", () => cleanup(null)));
    confirm.addEventListener("click", () => {
      plan.entries.forEach((entry, i) => {
        const select = shell.querySelector(`[data-import-choice="${i}"]`);
        if (select) entry.choice = select.value;
      });
      plan.destination = folderSegments(String(folderInput?.value || "")).join(FOLDER_SEP);
      cleanup(plan);
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });
    modal.appendChild(shell);
    document.body.appendChild(modal);
    refresh();
    confirm.focus?.();
  });
}

// ── Applying ────────────────────────────────────────────────────────────────

export const IMPORT_STEPS = [
  ["images", "Store images"],
  ["decks", "Write decks"],
  ["papers", "Store papers"],
  ["upload", "Upload to your storage"],
  ["finish", "Finish"]
];

// The meta keys that are the reader's own progress — which an update must never
// take from the sender.
const PROGRESS_META_KEYS = Object.entries(SHARE_META_POLICY)
  .filter(([, policy]) => policy === SHARE_POLICY_PROGRESS)
  .map(([key]) => key);

// An update, merged into what this device holds: the package's content by the
// restore's own newest-wins rules, the reader's progress kept whole.
function mergeImportUpdate(fresh, reminted, { backupNewer, keepIdentity = true }) {
  const merged = mergeDeckSnapshots(fresh, reminted, backupNewer);
  const snapshot = merged.snapshot;
  const statusById = new Map((fresh?.cards || []).map((card) => [String(card.id), card.status || null]));
  snapshot.cards = snapshot.cards.map((card) => (statusById.has(String(card.id))
    ? { ...card, status: statusById.get(String(card.id)) }
    : card));
  const localMeta = normalizeBackupMeta(fresh?.meta);
  for (const key of PROGRESS_META_KEYS) {
    if (key in localMeta) snapshot.meta[key] = localMeta[key];
  }
  if (keepIdentity) {
    snapshot.current = Number(fresh?.current) || 0;
    // The origin record is the package's, refreshed — it is what the next
    // update will be matched by.
    if (reminted.meta?.importedFrom) snapshot.meta.importedFrom = { ...(localMeta.importedFrom || {}), ...reminted.meta.importedFrom };
  }
  return merged;
}

export async function applyPackageImport(plan, archive, { progress = null } = {}) {
  // The open deck's unsaved edits reach disk before anything is merged into it
  // (see applyRestore for why).
  try { flushWorkingDeck(); } catch (error) { console.warn("Could not save the open deck before importing", error); }
  const uid = plan.uid || importingUserId();
  const importedAt = new Date().toISOString();
  const active = plan.entries.filter((entry) => entry.choice !== IMPORT_CHOICE_SKIP);

  // Where each deck goes, and under what salt its cards are minted. Settled for
  // every deck before any is translated, because a [[link]] in the first deck
  // can name the last.
  let quickTarget = null;
  const quickEntry = active.find((entry) => entry.quick);
  if (quickEntry) {
    try {
      const qid = getQuickNotesDeckId();
      if (qid) {
        await ensureLocalQuickNotesSnapshot();
        quickTarget = quickNotesLocalId(qid);
      }
    } catch (error) {
      console.warn("Could not find this account's quick notes — importing them as a deck of their own", error);
    }
    if (!quickTarget) quickEntry.choice = IMPORT_CHOICE_NEW;
  }
  const copySalt = `copy-${Date.now().toString(36)}`;
  for (const entry of active) {
    if (entry.quick && quickTarget) {
      entry.targetLocalId = quickTarget;
      entry.salt = "";
      entry.keepCardIds = false;
      entry.mode = IMPORT_CHOICE_UPDATE;
    } else if (entry.choice === IMPORT_CHOICE_UPDATE && entry.existing) {
      entry.targetLocalId = String(entry.existing.id);
      entry.salt = entry.existingSalt || "";
      // Your own deck coming home: its cards already have the ids in the
      // package, and those are the ones to merge onto.
      entry.keepCardIds = entry.own;
      entry.mode = IMPORT_CHOICE_UPDATE;
    } else if (entry.choice === IMPORT_CHOICE_COPY) {
      entry.salt = copySalt;
      entry.targetLocalId = importLocalIdFor(uid, entry.origin, entry.salt);
      entry.keepCardIds = false;
      entry.mode = IMPORT_CHOICE_NEW;
    } else {
      entry.salt = "";
      entry.targetLocalId = importLocalIdFor(uid, entry.origin);
      entry.keepCardIds = false;
      entry.mode = IMPORT_CHOICE_NEW;
    }
  }
  const deckIds = new Map();
  const cardIds = new Map();
  for (const entry of active) {
    const ids = new Set([entry.origin, entry.deck.deckId, entry.deck.archiveLocalId, ...(entry.deck.archiveIds || [])].filter(Boolean).map(String));
    ids.forEach((id) => deckIds.set(id, entry.targetLocalId));
    for (const card of entry.deck.cards || []) {
      cardIds.set(String(card.id), entry.keepCardIds ? String(card.id) : importCardIdFor(uid, entry.origin, card.id, entry.salt));
    }
  }

  const reminted = active.map((entry) => {
    const next = remintPackageDeck(entry.deck, {
      targetLocalId: entry.targetLocalId,
      cardIds,
      deckIds,
      origin: entry.origin,
      packageId: plan.packageId,
      salt: entry.salt,
      importedAt,
      category: entry.mode === IMPORT_CHOICE_NEW ? importedCategory(plan.destination, entry.deck.category) : "",
      keepCardIds: entry.keepCardIds
    });
    if (entry.quick && quickTarget) delete next.meta.importedFrom;
    entry.reminted = next;
    return next;
  });

  // ── Images ──
  progress?.step?.("images", "Storing images on this device…");
  const assetPlan = await planBackupAssetAdoption(reminted, archive.assets);
  applyBackupAssetRewrites(reminted, assetPlan.rewrites);
  const assetResult = await commitBackupAssets(assetPlan, (done, total) => {
    progress?.count?.(done, total, `Storing images ${done}/${total}…`);
  });
  progress?.stepDone?.("images", `${assetResult.kept + assetResult.adopted}${assetResult.failed ? `, ${assetResult.failed} failed` : ""}`);

  // ── Decks ──
  progress?.step?.("decks", "Writing decks…");
  const written = [];
  const failed = [];
  let added = 0;
  let updated = 0;
  let cardsIn = 0;
  for (let i = 0; i < active.length; i += 1) {
    const entry = active[i];
    const deck = entry.reminted;
    progress?.count?.(i + 1, active.length, `Writing decks ${i + 1}/${active.length}…`);
    try {
      if (entry.mode === IMPORT_CHOICE_NEW) {
        const snapshot = backupDeckToSnapshot(deck, entry.targetLocalId);
        snapshot.deckId = null;
        repairSnapshotText(snapshot);
        await withDeckLock(entry.targetLocalId, async () => {
          writeDeckSnapshot(entry.targetLocalId, snapshot);
          await deckWriteSettled(entry.targetLocalId);
        });
        upsertRestoredMeta(entry.targetLocalId, snapshot, deck);
        added += 1;
        cardsIn += deck.cards.length;
        progress?.log?.(`Imported "${deck.title}" — ${deck.cards.length} cards${deck.category && deck.category !== defaultDeckCategory ? ` into ${deck.category.split(FOLDER_SEP).join(" / ")}` : ""}`);
      } else {
        let result = null;
        const snapshot = await withDeckLock(entry.targetLocalId, async () => {
          const fresh = await readDeckSnapshot(entry.targetLocalId);
          const localTime = Date.parse(readLocalDeckIndex().find((row) => row.id === entry.targetLocalId)?.updatedAt || "") || 0;
          const packageTime = Date.parse(deck.updatedAt || "") || 0;
          // Quick notes: only ever ADD — the reader's own board is theirs.
          result = mergeImportUpdate(fresh, deck, { backupNewer: !entry.quick && packageTime > localTime });
          repairSnapshotText(result.snapshot);
          writeDeckSnapshot(entry.targetLocalId, result.snapshot);
          await deckWriteSettled(entry.targetLocalId);
          return result.snapshot;
        });
        upsertRestoredMeta(entry.targetLocalId, snapshot, deck);
        updated += 1;
        cardsIn += result.added;
        progress?.log?.(`${entry.quick ? "Added to your quick notes" : `Updated "${snapshot.deckTitle || deck.title}"`} — ${result.added} new card${result.added === 1 ? "" : "s"}, ${result.updated} changed`);
      }
      written.push(entry.targetLocalId);
    } catch (error) {
      console.warn("Could not import a deck", entry.title, error);
      failed.push(entry.title);
      progress?.error?.(`Could not save "${entry.title}": ${error?.message || error}`);
    }
    if (i % 5 === 4) await yieldToPage();
  }
  progress?.stepDone?.("decks", `${added} new, ${updated} updated${failed.length ? `, ${failed.length} failed` : ""}`);

  // ── Papers ──
  let documentResult = { stored: 0, rebound: 0, present: 0, failed: 0, refused: 0 };
  progress?.step?.("papers", "Storing papers on this device…");
  if (archive.zip && archive.documentIndex?.documents?.length) {
    try {
      // Matched to the reminted decks by the path they had in the archive —
      // every one of them kept it — and filed under the id they have now.
      const docPlan = await planBackupDocumentRestore(archive.zip, archive.documentIndex, reminted, (deck) => deck.targetLocalId || "");
      documentResult = await commitBackupDocuments(docPlan, (done, total, item) => {
        progress?.count?.(done, total, `Storing papers ${done}/${total}…`);
        if (item) progress?.log?.(`Paper ${done}/${total} · ${item.name || "document.pdf"}${item.bytes ? ` · ${formatJobBytes(item.bytes)}` : ""} · ${item.outcome}`, item.outcome === "stored" || item.outcome === "re-keyed" ? "info" : "warn");
      });
    } catch (error) {
      console.warn("Could not import this package's papers", error);
      progress?.error?.(`The papers could not be stored: ${error?.message || error}`);
    }
    progress?.stepDone?.("papers", `${documentResult.stored + documentResult.rebound} stored${documentResult.present ? `, ${documentResult.present} already here` : ""}`);
  } else {
    progress?.stepSkipped?.("papers", "none in this file");
  }

  // ── Upload ──
  // The pictures go up now (they are small, and they are what the other
  // devices of this account need to show the decks at all). The papers go up
  // through the bucket's own backfill, in the background: a hundred megabytes
  // of PDFs must not hold this panel open, and the backfill already knows how
  // to upload a paper this device holds and the bucket does not.
  progress?.step?.("upload", "Uploading to your storage…");
  let uploadedImages = 0;
  if (assetResult.adopted) {
    const stop = progress?.wait?.("Uploading images to your storage") || (() => {});
    try {
      uploadedImages = await flushPendingImageUploads();
      stop(`Uploaded ${uploadedImages} image${uploadedImages === 1 ? "" : "s"}`);
    } catch (error) {
      stop("Images will upload on the next sync");
      console.warn("Imported images will upload on the next sync", error);
    }
  }
  if (documentResult.stored + documentResult.rebound) {
    scheduleDocumentBackfill({ force: true });
    progress?.log?.("Papers are uploading to your bucket in the background (if you have one set up).");
  }
  progress?.stepDone?.("upload", uploadedImages ? `${uploadedImages} images` : "");

  // ── Finish ──
  progress?.step?.("finish", "Finishing…");
  if (plan.destination) addKnownFolder(plan.destination);
  if (state.localDeckId && written.includes(state.localDeckId)) {
    try { await loadDeckFromLibrary(state.localDeckId, { keepPlace: true }); } catch (error) { console.warn("Could not reload the open deck after the import", error); }
  }
  await renderMyDecksList();

  const parts = [];
  if (added) parts.push(`${added} deck${added === 1 ? "" : "s"} imported`);
  if (updated) parts.push(`${updated} updated`);
  if (cardsIn) parts.push(`${cardsIn} card${cardsIn === 1 ? "" : "s"}`);
  const images = assetResult.kept + assetResult.adopted;
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  const papers = documentResult.stored + documentResult.rebound;
  if (papers) parts.push(`${papers} paper${papers === 1 ? "" : "s"}`);
  const problems = [];
  if (failed.length) problems.push(`${failed.length} deck${failed.length === 1 ? "" : "s"} could not be saved (${failed.slice(0, 3).join(", ")}) — this device may be out of space`);
  if (documentResult.refused) problems.push(`${documentResult.refused} paper${documentResult.refused === 1 ? "" : "s"} did not match the deck recorded for ${documentResult.refused === 1 ? "it" : "them"} and ${documentResult.refused === 1 ? "was" : "were"} not stored`);
  if (documentResult.failed) problems.push(`${documentResult.failed} paper${documentResult.failed === 1 ? "" : "s"} could not be stored on this device`);
  if (assetResult.failed) problems.push(`${assetResult.failed} image${assetResult.failed === 1 ? "" : "s"} could not be stored on this device`);
  const summary = parts.join(", ") || "nothing to import";
  if (problems.length) {
    setStatus(`Import finished with problems — ${summary}. ${problems.join(". ")}.`, "error");
    showToast("Import finished with problems", "error");
    problems.forEach((problem) => progress?.error?.(problem));
    progress?.finish?.("Import finished with problems.", { warning: `${summary}. ${problems.join(". ")}.`, failed: true });
    return { ok: false, added, updated, written, problems };
  }
  setStatus(`Import complete — ${summary}.`);
  showToast("Import complete", "success");
  progress?.finish?.(`Import complete — ${summary}.`);
  return { ok: true, added, updated, written, problems };
}

// ── The one way in ──────────────────────────────────────────────────────────

export const OPEN_STEPS = [
  ["open", "Open the file"],
  ["check", "Check it"],
  ["compare", "Compare with your library"]
];

// Open any package (or archive, or deck bundle) and take it to the right
// preview: a library backup to the restore preview, which can hand over to an
// import-as-copies; a share to the import preview. `prefer` overrides the
// file's own kind: "restore" from the Restore button, "import" from Import.
export async function openRecallPackage(file, { prefer = "", destination = "" } = {}) {
  const reading = showBackupProgress(`Opening ${file?.name || "the file"}`, { steps: OPEN_STEPS, stats: [["decks", "Decks"], ["cards", "Cards"], ["images", "Images"], ["papers", "Papers"], ["size", "Size"], ["time", "Time"]] });
  let archive;
  try {
    setStatus("Reading the file…");
    reading.step("open", "Opening the file…");
    reading.setStat("size", formatJobBytes(file.size));
    archive = await readRecallPackage(file, reading);
    reading.setStat("decks", archive.decks.length);
    reading.setStat("cards", archive.decks.reduce((n, deck) => n + deck.cards.length, 0));
    reading.setStat("images", archive.assets.size);
    reading.setStat("papers", archive.documentIndex?.documents?.length || 0);
    reading.stepDone("open");
    reading.stepDone("check", archive.verification?.checked ? (archive.verification.ok ? "intact" : "problems found") : "no index");
    if (reading.cancelled()) {
      reading.close();
      setStatus("Cancelled.");
      return;
    }
  } catch (error) {
    console.error("Could not open the package", error);
    const message = /not a zip/i.test(error?.message || "") ? "This is not a Recall package or backup." : `Could not read this file: ${error?.message || "unreadable"}`;
    reading.error(message);
    reading.finish(message, { warning: String(error?.message || ""), failed: true });
    setStatus(message, "error");
    showToast("Could not open the file", "error");
    return;
  }

  const wantsRestore = prefer === "restore" || (prefer !== "import" && archive.kind !== PACKAGE_KIND_SHARE);
  try {
    if (wantsRestore) {
      reading.step("compare", "Comparing against your decks…");
      // Images are re-homed BEFORE the diff: a foreign backup's references get
      // rewritten to local placeholders, and the preview then compares (and the
      // apply then writes) exactly the text the decks will end up with.
      const assetPlan = await planBackupAssetAdoption(archive.decks, archive.assets);
      applyBackupAssetRewrites(archive.decks, assetPlan.rewrites);
      const report = await planRestore(archive.decks);
      Object.assign(report, {
        assetPlan,
        zip: archive.zip,
        manifest: archive.manifest,
        verification: archive.verification,
        documentIndex: archive.documentIndex,
        libraryState: archive.libraryState,
        settings: archive.settings,
        skipped: archive.manifest?.skipped || [],
        allowCopies: true
      });
      reading.close();
      const decision = await showRestorePreview(report);
      if (!decision) {
        setStatus("Restore cancelled.");
        return;
      }
      if (decision?.action === "copies") {
        // Re-read: the restore plan rewrote the decks' image references in
        // place, and an import plans its own adoption from the originals.
        const again = await readRecallPackage(file, null);
        await importAsShare(again, destination);
        return;
      }
      const applying = showBackupProgress("Restoring", { steps: RESTORE_STEPS });
      setStatus("Restoring…");
      try {
        await applyRestore(report, { progress: applying, includeSettings: Boolean(decision?.settings) });
      } catch (error) {
        console.error("Restore failed", error);
        applying.error(`Failed: ${error?.message || error}`);
        applying.finish("Restore failed.", { warning: String(error?.message || ""), failed: true });
        setStatus(`Restore failed: ${error?.message || "unknown error"}`, "error");
        showToast("Restore failed", "error");
      }
      return;
    }
    reading.step("compare", "Looking for decks you already have…");
    reading.close();
    await importAsShare(archive, destination);
  } catch (error) {
    console.error("Import failed", error);
    reading.close();
    setStatus(`Import failed: ${error?.message || "unknown error"}`, "error");
    showToast("Import failed", "error");
  }
}

async function importAsShare(archive, destination = "") {
  const plan = await planPackageImport(archive);
  plan.destination = folderSegments(String(destination || "")).join(FOLDER_SEP);
  const chosen = await showPackageImportPreview(plan, archive);
  if (!chosen) {
    setStatus("Import cancelled.");
    return;
  }
  const progress = showBackupProgress(`Importing ${plan.entries.filter((entry) => entry.choice !== IMPORT_CHOICE_SKIP).length} deck(s)`, { steps: IMPORT_STEPS });
  setStatus("Importing…");
  try {
    await applyPackageImport(chosen, archive, { progress });
  } catch (error) {
    console.error("Import failed", error);
    progress.error(`Failed: ${error?.message || error}`);
    progress.finish("Import failed.", { warning: String(error?.message || ""), failed: true });
    setStatus(`Import failed: ${error?.message || "unknown error"}`, "error");
    showToast("Import failed", "error");
  }
}

// Does this file look like something openRecallPackage should take, rather than
// the markdown importer? A .recall always; a zip whose index says it is ours; a
// JSON bundle of several decks, which the markdown importer has always dropped.
export async function isRecallPackageFile(file) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".recall")) return true;
  if (name.endsWith(".zip")) {
    try {
      const names = Object.keys((await LiteZip.loadAsync(file)).files);
      return names.some((entry) => /(^|\/)manifest\.json$/i.test(entry))
        && names.some((entry) => /(^|\/)decks\/.+\.json$/i.test(entry));
    } catch {
      return false;
    }
  }
  if (name.endsWith(".json") && file.size < 200 * 1024 * 1024) {
    try {
      const parsed = JSON.parse(await file.text());
      return Boolean(parsed && Array.isArray(parsed.decks) && parsed.decks.length);
    } catch {
      return false;
    }
  }
  return false;
}
