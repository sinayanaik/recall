// Reading a whole folder as one document — and writing the edits back.
//
// A folder in Recall is not a record: it is the deck's `category` string, a
// `/`-delimited path (see folders.js). So "open this folder" means "read every
// deck under this path, in alphabetical order, and join their notes into one
// markdown string". decksUnderFolder() already returns exactly the selector
// shape myDeckPayload() takes, and loadSelectedMyDecks() already merges N decks'
// CARDS the same way — this is that, for notes, plus the half that makes it
// safe to type in.
//
// ── Why the write-back needs its own path ─────────────────────────────────
//
// There is no read-only deck in this app. Setting state.localDeckId = null does
// NOT make the open deck ephemeral: resolveSaveTarget() falls through to
// generateLocalDeckId(), so the first autosave — and highlighting a passage is
// enough to schedule one — would mint a brand-new library entry holding every
// deck in the folder glued together, write it to IndexedDB, and push it to
// Supabase, where it would land on every other device. That is the failure this
// module exists to prevent.
//
// So state.folderDeck is set while a folder is open, and the two save funnels
// (saveDeckToLibrary and its synchronous pagehide twin) hand over to
// saveFolderDeck() here instead of writing a deck of their own. Gating the two
// funnels rather than the ~20 scheduleDeckAutosave() call sites is deliberate:
// flushWorkingDeck() calls the sync one directly on pagehide, and
// reconcileAllDecks() flushes independently at boot, on reconnect and on every
// explicit Sync, so a gate further out would be walked around three ways.
//
// ── How a section is found again ──────────────────────────────────────────
//
// The document format — a `<!-- recall-section:local-1a2b3c -->` marker and a
// `# Title` heading per deck — and the parser that undoes it live in
// src/format/merged-notes.js, because a bulk Load of several decks builds the
// very same document and tools/ has to be able to drive the format from Node.
//
// If the markers do not come back exactly as they went out, saveFolderDeck
// REFUSES to write anything at all. A deleted marker would otherwise fold one
// deck's notes silently into its neighbour and delete the first deck's content
// on the next sync — the one unrecoverable outcome here, and not one worth
// trading for the convenience of a partial save.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "../cards/study.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import {
  buildMergedNotes,
  mergedSectionBody,
  mergedSplitProblem,
  ownerForNewCard,
  splitMergedNotes
} from "../format/merged-notes.js?v=__BUILD__";
import { decksUnderFolder } from "./folder-tree.js?v=__BUILD__";
import { normalizeDeckCategory } from "./folders.js?v=__BUILD__";
import { cachedDeckSnapshotSync, finishSaveDeckToLibrary } from "./local-library.js?v=__BUILD__";
import { myDeckPayload } from "./my-decks-selection.js?v=__BUILD__";
import { readDeckSnapshot, withDeckLock } from "../storage/deck-store.js?v=__BUILD__";
import { closeMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { flushWorkingDeck } from "../ui/edit-mode.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

// finishSaveDeckToLibrary only assigns state.localDeckId when the token it was
// given still matches activeDeckLoadToken. -1 can never match (the counter only
// ever increments from 0), which is exactly what is wanted here: these writes
// are for decks that are NOT the open one, and adopting any of their ids would
// point the next ordinary save at whichever member happened to be written last.
const NEVER_THE_OPEN_DECK = -1;

// Is a folder REALLY the thing on screen?
//
// Not just `Boolean(state.folderDeck)`. Eight places in the app replace the
// open deck (library open, cloud open, two import paths, EPUB's two, delete,
// sign-out), and asking each of them to clear a flag they know nothing about is
// how a stale flag eventually routes an ordinary deck's save into some folder's
// member decks. Every one of them does two things this can check instead: it
// claims an id, and it rewrites the title. So the flag is verified against what
// `state` actually says, and dropped the moment it disagrees.
export function isFolderDeckActive() {
  const folder = state.folderDeck;
  if (!folder) return false;
  if (state.localDeckId || state.deckId || state.deckTitle !== folder.path) {
    state.folderDeck = null;
    return false;
  }
  return true;
}

// ── Opening ────────────────────────────────────────────────────────────────

export async function openFolderAsDeck(path) {
  const folderPath = normalizeDeckCategory(path);
  const found = decksUnderFolder(folderPath);
  if (!found.length) {
    // Named, because the two ways to get here look identical from the outside:
    // the folder really is empty, or My Decks has not been painted this session
    // and decksUnderFolder therefore has nothing to read.
    setStatus(`No decks found in "${folderPath}".`, "error");
    showToast(`No decks in "${folderPath}" to read`, "error");
    return false;
  }

  // BEFORE the payloads are read, not after. The deck being left is very often
  // one of the folder's own decks, and its last 400ms of typing lives only in
  // memory until this runs — reading first captured the stale copy from disk,
  // and the merged document then wrote that stale copy back over the edit.
  // Measured: a 2,687-character note came back as 2,658.
  flushWorkingDeck();

  setStatus(`Opening ${found.length} deck${found.length === 1 ? "" : "s"} in ${folderPath}…`);

  // Alphabetical, by the title as shown in the library. localeCompare with
  // numeric:true so "Chapter 2" sorts before "Chapter 10".
  const ordered = found.slice().sort((a, b) =>
    String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" }));

  const members = [];
  const skipped = [];
  for (const entry of ordered) {
    // Per member, never all-or-nothing — the lesson rewriteFolderPaths already
    // learned. A cloud-only deck read offline throws, and one unreachable deck
    // must not cost the reader the other twenty.
    try {
      const payload = await myDeckPayload(entry.sel);
      // Only a deck with a local id can be written back to, so a cloud-only one
      // is carried read-only rather than silently swallowing edits.
      members.push({
        localId: entry.sel.localId ? String(entry.sel.localId) : null,
        deckId: payload.deck?.id ? String(payload.deck.id) : (entry.sel.deckId || null),
        title: String(payload.deck?.title || entry.title || "Untitled deck"),
        notes: String(payload.deck?.notes || ""),
        cards: payload.cards || [],
      });
    } catch (error) {
      console.warn(`Could not open "${entry.title}" as part of ${folderPath}`, error);
      skipped.push(entry.title || "Untitled");
    }
  }

  const writable = members.filter((member) => member.localId);
  if (!writable.length) {
    setStatus(`Couldn't read any of the ${found.length} decks in "${folderPath}" on this device.`, "error");
    showToast("None of those decks could be read on this device", "error");
    return false;
  }

  const cards = [];
  const statusById = {};
  const categoryById = {};
  const cardOwner = {};
  const originalCardId = {};
  const usedIds = new Set();
  writable.forEach((member) => {
    (member.cards || []).forEach((card) => {
      // Same remint-on-collision rule as loadSelectedMyDecks: older decks carry
      // deterministic ids that repeat across decks, and here a collision would
      // also mean two decks claiming the same card on the way back.
      let id = String(card.id);
      while (usedIds.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
      usedIds.add(id);
      cards.push({ id, question: card.question, answer: card.answer, ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {}) });
      const status = normalizeCardStatus(card.status);
      if (status) statusById[id] = status;
      if (card.category) categoryById[id] = card.category;
      cardOwner[id] = member.localId;
      // Remembered so a card whose id was reminted is written back under the id
      // its own deck already knows it by — the remint exists only to keep the
      // merged view's per-card state apart, and must not leak into the deck.
      if (id !== String(card.id)) originalCardId[id] = String(card.id);
    });
  });

  // Built in full BEFORE anything is assigned, and refused if it came out
  // empty. Everything above this line is reads; everything below is writes.
  // Interleaving them is how a throw halfway through leaves `state` describing
  // a deck that does not exist — the open deck replaced, the notes not yet
  // written, and all three tabs blank with no way back but a reload.
  const mergedNotes = buildMergedNotes(writable);
  if (!mergedNotes.trim()) {
    setStatus(`The decks in "${folderPath}" have no notes to read.`, "error");
    showToast(`Nothing to read in "${folderPath}"`, "error");
    return false;
  }

  state.deckId = null;
  state.localDeckId = null;
  state.folderDeck = { path: folderPath, members: writable, cardOwner, originalCardId, readOnlyCount: members.length - writable.length };
  state.masterCards = cards;
  resetStudyDeck(state.masterCards);
  state.statusById = statusById;
  state.categoryById = categoryById;
  state.meta = {};
  state.current = 0;
  state.deckTitle = folderPath;
  state.deckCategory = folderPath;
  state.sourceTitle = folderPath;
  state.importTitleHint = folderPath;
  state.notes = mergedNotes;
  setViewMode("notes");

  syncResults();
  closeAllCardsPanel();
  closeMyDecksPanel();
  showCard();

  const note = `${writable.length} deck${writable.length === 1 ? "" : "s"} · ${cards.length} card${cards.length === 1 ? "" : "s"}`;
  setStatus(`Reading ${folderPath} — ${note}. Edits are saved back to each deck.`);
  showToast(`Reading ${folderPath} · ${note}`);
  if (skipped.length) {
    showToast(
      `${skipped.length} deck${skipped.length === 1 ? "" : "s"} couldn't be opened: ${skipped.slice(0, 2).join(", ")}` +
      `${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ""}`,
      "error"
    );
  }
  return true;
}

// ── Writing back ───────────────────────────────────────────────────────────

let folderDeckRefusalShown = false;

// Everything the two save paths agree on: whether it is safe to write at all,
// and what each member deck should end up holding. Returns null when the
// document has been broken, having already said so.
export function planFolderDeckWrite({ announce = true } = {}) {
  const folder = state.folderDeck;
  if (!folder) return null;

  const problem = mergedSplitProblem(state.notes, folder.members);
  if (problem) {
    // Latched: the autosave fires every 400ms of typing, and a note whose
    // markers are broken would otherwise raise the same toast on every
    // keystroke. Cleared as soon as a save succeeds.
    if (announce && !folderDeckRefusalShown) {
      folderDeckRefusalShown = true;
      setStatus(`Not saving — ${problem}. Put the "recall-section" comment back, or reopen the folder.`, "error");
      showToast("Folder edits not saved — a section marker is missing", "error");
    }
    return null;
  }
  if (announce) folderDeckRefusalShown = false;

  const { sections } = splitMergedNotes(state.notes);
  const bodyById = new Map(sections.map((section) => [section.localId, mergedSectionBody(section)]));
  const titleById = new Map(sections.map((section) => [section.localId, section.title]));

  // Cards, back to the deck each came from. state.masterCards is the live list,
  // so a card deleted in the merged view is simply absent here and the member's
  // own save records the deletion through the ordinary diff.
  const cardsByOwner = new Map(folder.members.map((member) => [member.localId, []]));
  state.masterCards.forEach((card) => {
    const owner = folder.cardOwner[card.id]
      // A card created inside the merged document has no owner yet. It belongs
      // to the section its source text sits in; falling back to the first deck
      // is the honest answer when there is nothing to go on.
      || ownerForNewCard(card, sections)
      || folder.members[0].localId;
    const list = cardsByOwner.get(owner) || cardsByOwner.get(folder.members[0].localId);
    // Carried as `mergedId` because state.statusById and state.categoryById
    // are keyed by the id the MERGED view used, while the deck must be
    // written with the id it already knows the card by.
    const originalId = folder.originalCardId[card.id];
    list.push({ ...card, id: originalId || card.id, mergedId: card.id });
  });

  return { folder, bodyById, titleById, cardsByOwner };
}

// The synchronous twin, for flushWorkingDeck's pagehide/visibilitychange path —
// where there is no guarantee the event loop gets another turn, so the async
// save above would simply not happen.
//
// Uses the cache-only snapshot read for the same reason saveDeckToLibrarySync
// does, and skips any member that is NOT cache-resident rather than writing
// with a null previousSnapshot: that would drop the deck's meta bag and let
// finishSaveDeckToLibrary treat an existing deck as a first-ever save. Skipping
// costs that one deck the last few hundred milliseconds of typing; the
// alternative costs it everything it was carrying.
export function saveFolderDeckSync() {
  const plan = planFolderDeckWrite({ announce: false });
  if (!plan) return null;
  const { folder, bodyById, titleById, cardsByOwner } = plan;
  let written = 0;
  for (const member of folder.members) {
    const notes = bodyById.get(member.localId);
    if (notes === undefined) continue;
    const previousSnapshot = cachedDeckSnapshotSync(member.localId);
    if (!previousSnapshot) continue;
    const title = titleById.get(member.localId) || member.title;
    try {
      finishSaveDeckToLibrary({
        snapshot: memberSnapshot(member, previousSnapshot, notes, title, cardsByOwner.get(member.localId) || []),
        localId: member.localId,
        previousSnapshot,
        silent: true,
        loadToken: NEVER_THE_OPEN_DECK,
      });
      member.notes = notes;
      member.title = title;
      written += 1;
    } catch (error) {
      console.warn(`Could not flush "${member.title}" back from ${folder.path}`, error);
    }
  }
  return written ? { id: null, title: folder.path, folder: true } : null;
}

export async function saveFolderDeck({ silent = true } = {}) {
  const plan = planFolderDeckWrite();
  if (!plan) return null;
  const { folder, bodyById, titleById, cardsByOwner } = plan;

  let written = 0;
  for (const member of folder.members) {
    const notes = bodyById.get(member.localId);
    if (notes === undefined) continue;
    const title = titleById.get(member.localId) || member.title;
    try {
      // eslint-disable-next-line no-await-in-loop -- per-deck lock, deliberately serial
      await withDeckLock(member.localId, async () => {
        const previousSnapshot = await readDeckSnapshot(member.localId);
        const snapshot = memberSnapshot(member, previousSnapshot, notes, title, cardsByOwner.get(member.localId) || []);
        finishSaveDeckToLibrary({
          snapshot,
          localId: member.localId,
          previousSnapshot,
          silent: true,
          loadToken: NEVER_THE_OPEN_DECK,
        });
      });
      member.notes = notes;
      member.title = title;
      written += 1;
    } catch (error) {
      console.warn(`Could not save "${member.title}" back from ${folder.path}`, error);
    }
  }

  if (written !== folder.members.length && !silent) {
    setStatus(`Saved ${written} of ${folder.members.length} decks.`, "error");
  }
  // A truthy return is what the autosave reads as "saved" for the sync pill.
  return written ? { id: null, title: folder.path, folder: true } : null;
}

// A member deck's snapshot: its previous one with the notes, title and cards
// replaced. Built from the PREVIOUS snapshot rather than from deckSnapshot(),
// which reads `state` — and `state` here describes the folder, not this deck,
// so every per-deck field (its cloud id, its meta bag, its reading position)
// would be replaced by the merged view's.
export function memberSnapshot(member, previousSnapshot, notes, title, cards) {
  const previous = previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : {};
  return {
    ...previous,
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: title,
    deckCategory: normalizeDeckCategory(previous.deckCategory || member.category || state.folderDeck?.path),
    notes,
    sourceTitle: previous.sourceTitle || title,
    importTitleHint: previous.importTitleHint || "",
    deckId: previous.deckId || member.deckId || null,
    current: Number.isFinite(previous.current) ? previous.current : 0,
    cards: cards.map((card) => {
      // `mergedId` is the key the open view's per-card maps use; `id` is what
      // this deck knows the card by. They differ only for a card whose id
      // collided with another deck's on the way in.
      const key = card.mergedId || card.id;
      return {
        id: card.id,
        question: card.question,
        answer: card.answer,
        status: normalizeCardStatus(state.statusById[key]) || normalizeCardStatus(card.status),
        category: state.categoryById[key] || card.category || null,
        ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {}),
      };
    }),
  };
}
