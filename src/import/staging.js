// The two-step import: stage what was found, show the user what it will do,
// and only then commit.
//
// The staging step exists because the destructive mistake — shredding a
// document into one card per heading — is invisible until after it happens.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "../cards/study.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { analyzeMarkdownImport, importContentModesFor, resolveIncomingDeck, snapshotIncomingDeck } from "./analyze.js?v=__BUILD__";
import { titleFromImportHint } from "./parse-cards.js?v=__BUILD__";
import { addKnownFolder, normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { setMyDecksCwd, setMyDecksView } from "../library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { loadDeckSnapshot } from "../storage/deck-snapshot.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { lastSaveErrorWasQuota, persistWorkingDeck } from "../storage/quota.js?v=__BUILD__";
import { closeImportPanel, openImportPanel, openMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

// ── Importing into a specific folder ────────────────────────────────────────
// My Decks can create a deck or a subfolder in whatever folder you're looking
// at, but importing always dropped the deck in "Uncategorized" and left you to
// move it — so the folder an import is aimed at is recorded here.
//
// Deliberately a module-level value rather than a parameter threaded through
// loadFile → loadZipFile → the review step, because the review step breaks that
// chain across a user interaction. Every import entry point sets it — to a
// folder for the My Decks buttons, to null for the ordinary Import panel — so a
// stale value can't leak from one import into the next.
export let pendingImportFolder = null;

// Setter: an imported binding is read-only, and the import entry points in main.js choose the destination folder.
export function setPendingImportFolder(value) {
  pendingImportFolder = value;
}

// The folder the last import was filed into. Every Import entry point outside
// My Decks (the toolbar, the home screen) aims at no folder in particular, so
// without this every one of them defaulted to the root and had to be corrected
// by hand — which, for anyone who keeps their decks in folders, is every time.
export const LAST_IMPORT_FOLDER_KEY = "flashcards_last_import_folder_v1";

export function readLastImportFolder() {
  try {
    const value = localStorage.getItem(LAST_IMPORT_FOLDER_KEY);
    return value ? normalizeDeckCategory(value) : null;
  } catch (error) {
    return null;
  }
}

export function writeLastImportFolder(path) {
  try {
    localStorage.setItem(LAST_IMPORT_FOLDER_KEY, normalizeDeckCategory(path));
  } catch (error) {
    /* private mode / quota — the default just won't be remembered */
  }
}

// The category a freshly imported deck should land in, consuming the pending
// folder so it applies to exactly one import.
export function importTargetCategory(fallback = defaultDeckCategory) {
  const pending = pendingImportFolder;
  setPendingImportFolder(null);
  if (pending == null) return fallback;
  return normalizeDeckCategory(pending);
}

// ── Import staging ──────────────────────────────────────────────────────────
// One or more sources that have been read and analysed but not yet committed.
// Nothing touches the working deck or the library until commitStagedImport runs.
//
//   decks       every candidate deck found across all the picked sources, each
//               with its own `selected` flag
//   sources     [{ kind: "markdown" | "snapshot", name, … }] — what was read
//   content     the chosen "Import as" mode: "notes" | "cards" | "both"
//   target      the chosen destination:
//                 "separate" — one saved deck per candidate (batch default)
//                 "new"      — one new working deck, everything merged
//                 "current"  — appended to the deck already open
//   folder      the My Decks folder this import was aimed at, if any
export let importStaging = null;

export function currentDeckIsOpen() {
  return Boolean(state.masterCards.length || state.notes.trim() || state.deckTitle.trim());
}

// A lone Recall .json export can take the full-fidelity path through
// loadDeckSnapshot (cloud id, per-card statuses, quick-note labels, current
// position). In a batch those decks are written fresh, so only the content and
// per-card statuses carry over.
export function stagingIsLoneSnapshot(staging) {
  return staging.sources.length === 1
    && staging.sources[0].kind === "snapshot"
    && staging.decks.length === 1
    && Boolean(staging.decks[0].snapshot);
}

export function importSourceLabel(sources) {
  if (!sources.length) return "";
  if (sources.length === 1) return sources[0].name || "Pasted Markdown";
  return `${sources.length} files`;
}

// Builds the staging area from everything that was read. `sources` is already
// flat: zips have been expanded into their Markdown entries, so one picked file
// can contribute several sources.
export function stageImportSources(sources, { folder = null, skipped = [] } = {}) {
  const usable = sources.filter((source) => source && (source.kind === "snapshot" || String(source.markdown || "").trim()));
  if (!usable.length) {
    setStatus(sources.length ? "Nothing importable in those files." : "That source was empty — nothing to import.", "error");
    return null;
  }

  const decks = [];
  usable.forEach((source) => {
    if (source.kind === "snapshot") {
      const candidate = snapshotIncomingDeck(source.payload, { name: source.name, source: source.name });
      if (candidate.cards.length || candidate.notesBody.trim()) decks.push(candidate);
      return;
    }
    decks.push(...analyzeMarkdownImport(source.markdown, { name: source.name }).decks);
  });

  if (!decks.length) {
    setStatus("Those files had neither notes nor cards.", "error");
    return null;
  }

  // Keeps the legacy single-source buffer in step for anything still reading it.
  el.sourceInput.value = usable.length === 1 && usable[0].kind === "markdown" ? usable[0].markdown : "";

  // Where these decks land, when the caller didn't aim at a folder. Files that
  // carry their own category (a Recall export's `Category:` line) keep it —
  // null means "each file's own folder". Anything else falls back to wherever
  // the last import went, which is nearly always where this one belongs too.
  const declaresOwnFolder = decks.some((deck) => normalizeDeckCategory(deck.category) !== defaultDeckCategory);
  // An EMPTY folder string is "nothing in particular", not "the root". My Decks
  // hands one over whenever there is no folder in view — grid/tree view with no
  // scope selected, or folder view sitting at the top — and treating that as an
  // explicit instruction was overriding both the remembered folder and each
  // file's own category, dumping every import into Uncategorized.
  const aimedAt = folder != null && String(folder).trim() !== "" ? folder : null;
  const resolvedFolder = aimedAt != null
    ? aimedAt
    : (declaresOwnFolder ? null : readLastImportFolder());

  const { modes, suggested } = importContentModesFor(decks);
  importStaging = {
    sources: usable,
    sourceLabel: importSourceLabel(usable),
    // Only meaningful for a single source; a batch names each deck from its own file.
    titleHint: usable.length === 1 ? usable[0].name : "",
    folder: resolvedFolder,
    skipped,
    decks,
    multi: decks.length > 1,
    modes,
    content: suggested,
    // More than one deck in play almost always means "one deck each" — that is
    // what picking twelve lecture notes at once is asking for.
    target: decks.length > 1 ? "separate" : "new"
  };
  openImportPanel();
  renderImportReview();
  return importStaging;
}

export function stageMarkdownImport(markdown, { name = "", folder = null } = {}) {
  return stageImportSources([{ kind: "markdown", name, markdown: String(markdown || "") }], { folder });
}

export function stageSnapshotImport(payload, { name = "", folder = null } = {}) {
  return stageImportSources([{ kind: "snapshot", name, payload }], { folder });
}

export function clearImportStaging() {
  importStaging = null;
  setPendingImportFolder(null);
  if (el.importReviewStep) el.importReviewStep.hidden = true;
  if (el.importSourceStep) el.importSourceStep.hidden = false;
}

export const IMPORT_CONTENT_LABELS = {
  notes: { label: "Notes", icon: "📝" },
  cards: { label: "Cards", icon: "🗂" },
  both: { label: "Notes + cards", icon: "📝🗂" }
};

export function importSelectedDecks() {
  if (!importStaging) return [];
  return importStaging.decks.filter((deck) => deck.selected);
}

export function importResolvedDecks() {
  return importSelectedDecks().map((deck) => resolveIncomingDeck(deck, importStaging.content));
}

export function importTotals() {
  if (!importStaging) return { cards: 0, notes: 0, decks: 0 };
  const resolved = importResolvedDecks();
  return {
    cards: resolved.reduce((sum, deck) => sum + deck.cards.length, 0),
    notes: resolved.filter((deck) => deck.notes.trim()).length,
    decks: resolved.length
  };
}

export function importDetectionChips() {
  if (!importStaging) return [];
  const decks = importStaging.decks;
  const chips = [];

  const fileCount = importStaging.sources.length;
  if (fileCount > 1) chips.push({ text: `${fileCount} files read`, tone: "ok" });
  if (decks.length > 1) {
    chips.push({ text: `${decks.length} decks found`, tone: "ok" });
  }

  const snapshotDecks = decks.filter((deck) => deck.snapshot);
  if (snapshotDecks.length) {
    chips.push({ text: `${snapshotDecks.length} Recall deck export${snapshotDecks.length === 1 ? "" : "s"}`, tone: "ok" });
    const saved = snapshotDecks.reduce((sum, deck) => sum + deck.cards.length, 0);
    const withNotes = snapshotDecks.filter((deck) => deck.notesBody.trim()).length;
    chips.push({ text: `${saved} saved card${saved === 1 ? "" : "s"}` });
    chips.push({ text: withNotes ? `${withNotes} with notes` : "no notes" });
  }

  const parsed = decks.filter((deck) => !deck.snapshot);
  const explicit = parsed.reduce((sum, deck) => sum + deck.explicitCards.length, 0);
  const heuristic = parsed.reduce((sum, deck) => sum + deck.cards.length, 0);
  const notesBlocks = parsed.filter((deck) => deck.notesFromBlock.trim()).length;

  if (parsed.length) {
    if (explicit) {
      chips.push({ text: `${explicit} card${explicit === 1 ? "" : "s"} in card syntax`, tone: "ok" });
    } else if (heuristic) {
      chips.push({ text: `${heuristic} heading section${heuristic === 1 ? "" : "s"} — could be cards`, tone: "warn" });
    } else {
      chips.push({ text: "no card syntax found" });
    }

    if (notesBlocks) chips.push({ text: `${notesBlocks} saved notes document${notesBlocks === 1 ? "" : "s"}`, tone: "ok" });
    else chips.push({ text: fileCount > 1 ? "read as Markdown documents" : "reads as a Markdown document" });
  }

  importStaging.skipped.forEach((name) => {
    chips.push({ text: `skipped ${name}`, tone: "warn" });
  });

  return chips;
}

export function importContentHintText() {
  if (!importStaging) return "";
  const parsed = importStaging.decks.filter((deck) => !deck.snapshot);
  if (!parsed.length) {
    return "A Recall export already says which half is notes and which is cards, so both come across as they were saved.";
  }
  const what = importStaging.decks.length > 1 ? "Each file is kept as" : "Kept as";
  const heuristicOnly = parsed.every((deck) => deck.cardSyntax !== "explicit");
  if (importStaging.content === "notes") {
    return heuristicOnly
      ? `${what} one Markdown document, exactly as written. Nothing is split into cards.`
      : `${what} one Markdown document. The cards inside are ignored.`;
  }
  if (importStaging.content === "cards") {
    return heuristicOnly
      ? "Every ## heading becomes a card question and the text under it becomes the answer. Use Notes instead if these are documents you want to read."
      : "Only the flashcards are kept; the surrounding document is dropped.";
  }
  return importStaging.decks.length > 1
    ? "Each document is kept whole as its notes, and any cards written in card syntax are pulled out alongside it. Files with no card syntax stay pure notes."
    : "The whole document is kept as notes, and the cards written in card syntax are pulled out alongside it.";
}

export function importTargetHintText() {
  if (!importStaging) return "";

  if (importStaging.target === "current") {
    const bits = [];
    if (importStaging.content !== "notes") bits.push("cards are added after the existing ones");
    if (importStaging.content !== "cards") bits.push("notes are appended to the end of this deck's notes");
    return `Nothing is replaced — ${bits.join(", ")}.`;
  }
  if (importStaging.target === "separate") {
    const count = importTotals().decks;
    return `Saves ${count} separate deck${count === 1 ? "" : "s"} into that folder and opens the library there. The deck you have open now is untouched.`;
  }
  return "Merges everything into one new deck in that folder and opens it. The deck you have open now is left saved in My Decks.";
}

export function importChoiceButtonHtml(value, label, { active, disabled = false, title = "" } = {}) {
  return `<button type="button" class="import-choice-btn${active ? " is-active" : ""}" data-import-choice="${escapeHtml(value)}"${disabled ? " disabled" : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(label)}</button>`;
}

export function renderImportDetection() {
  if (!el.importDetect) return;
  const chips = importDetectionChips();
  el.importDetect.innerHTML = `
    <div class="import-detect-source" title="${escapeHtml(importStaging?.sourceLabel || "")}">${escapeHtml(importStaging?.sourceLabel || "")}</div>
    <div class="import-detect-chips">${chips.map((chip) => `<span class="import-chip${chip.tone ? ` is-${chip.tone}` : ""}">${escapeHtml(chip.text)}</span>`).join("")}</div>
  `;
}

export function renderImportChoices() {
  if (!importStaging) return;

  if (el.importContentOptions) {
    el.importContentOptions.innerHTML = ["notes", "cards", "both"].map((mode) => {
      const meta = IMPORT_CONTENT_LABELS[mode];
      const available = importStaging.modes.includes(mode);
      return importChoiceButtonHtml(mode, `${meta.icon} ${meta.label}`, {
        active: importStaging.content === mode,
        disabled: !available,
        title: available ? "" : "This file has nothing that could become that."
      });
    }).join("");
  }
  if (el.importContentHint) el.importContentHint.textContent = importContentHintText();

  if (el.importTargetOptions) {
    const hasDeck = currentDeckIsOpen();
    // Based on what is actually SELECTED: "separate" means "don't merge these",
    // which is vacuous once the selection narrows to a single deck — so the
    // option disappears and the target falls back to the plain new-deck path
    // rather than silently saving one deck into the library without opening it.
    const multiple = importSelectedDecks().length > 1;
    if (!multiple && importStaging.target === "separate") importStaging.target = "new";
    const currentLabel = state.deckTitle.trim() ? `Current deck — ${state.deckTitle.trim()}` : "Current deck";
    el.importTargetOptions.innerHTML = [
      // Only offered when there is more than one deck to separate — with a
      // single candidate it would be indistinguishable from "one new deck".
      multiple
        ? importChoiceButtonHtml("separate", "🗃 Separate decks", { active: importStaging.target === "separate" })
        : "",
      importChoiceButtonHtml("new", multiple ? "✦ One new deck" : "✦ A new deck", { active: importStaging.target === "new" }),
      importChoiceButtonHtml("current", `⊕ ${currentLabel}`, {
        active: importStaging.target === "current",
        disabled: !hasDeck,
        title: hasDeck ? "" : "No deck is open yet."
      })
    ].filter(Boolean).join("");
  }
  renderImportFolderRow();
  if (el.importTargetHint) el.importTargetHint.textContent = importTargetHintText();
}

// The folder new decks will be filed under, and the control to change it.
// Before this, the destination came only from wherever the import was launched
// (a My Decks folder button armed one, the Import panel armed none) with no way
// to correct it in the review step — so anything started from the toolbar had
// to land in the root and be dragged afterwards.
export function renderImportFolderRow() {
  if (!el.importFolderRow) return;
  const appending = importStaging.target === "current";
  el.importFolderRow.hidden = appending;
  if (appending || !el.importFolderPath) return;

  // With no folder chosen, each deck keeps whatever category its own file
  // declared — say so rather than showing just the first one's and implying
  // they all land together.
  if (importStaging.folder == null) {
    const categories = new Set(importSelectedDecks().map((deck) => normalizeDeckCategory(deck.category)));
    if (categories.size > 1) {
      el.importFolderPath.textContent = "each file's own folder";
      return;
    }
  }
  el.importFolderPath.textContent = importDestinationFolder();
}

// Where decks will actually be filed: the folder chosen for this import, else
// the category the file itself declared, else the default. Kept in one place so
// the row, the hint and the commit paths can never disagree.
export function importDestinationFolder() {
  if (!importStaging) return defaultDeckCategory;
  if (importStaging.folder != null) return normalizeDeckCategory(importStaging.folder);
  const first = importSelectedDecks()[0];
  return normalizeDeckCategory(first ? first.category : defaultDeckCategory);
}

export function renderImportDeckList() {
  if (!el.importDeckList) return;
  if (!importStaging || importStaging.decks.length < 2) {
    el.importDeckList.hidden = true;
    return;
  }

  el.importDeckList.hidden = false;
  if (el.importDeckListLabel) {
    el.importDeckListLabel.textContent = importStaging.sources.length > 1
      ? "Decks these files will become"
      : "Decks found in this file";
  }
  el.importDeckListRows.innerHTML = importStaging.decks.map((deck, index) => {
    const resolved = resolveIncomingDeck(deck, importStaging.content);
    const parts = [];
    if (resolved.cards.length) parts.push(`${resolved.cards.length} card${resolved.cards.length === 1 ? "" : "s"}`);
    if (resolved.notes.trim()) parts.push("notes");
    // Name the file when it isn't already obvious from the deck title, so a
    // batch of similarly-titled documents is still tellable apart.
    const meta = deck.source && titleFromImportHint(deck.source) !== deck.title
      ? deck.source
      : deck.category;
    return `
      <label class="import-decklist-row">
        <input type="checkbox" data-import-deck="${index}"${deck.selected ? " checked" : ""}>
        <span class="import-decklist-title">${escapeHtml(deck.title || `Deck ${index + 1}`)}</span>
        <span class="import-decklist-meta">${escapeHtml(meta)}</span>
        <span class="import-decklist-count">${escapeHtml(parts.join(" · ") || "empty")}</span>
      </label>
    `;
  }).join("");

  if (el.importDeckSelectAll) {
    el.importDeckSelectAll.checked = importStaging.decks.every((deck) => deck.selected);
  }
}

export async function renderImportPreview() {
  if (!el.importPreviewBody) return;
  const totals = importTotals();

  if (el.importPreviewSummary) {
    const bits = [];
    if (totals.decks > 1) bits.push(`${totals.decks} decks`);
    if (totals.cards) bits.push(`${totals.cards} card${totals.cards === 1 ? "" : "s"}`);
    if (totals.notes) bits.push(`${totals.notes} notes document${totals.notes === 1 ? "" : "s"}`);
    el.importPreviewSummary.textContent = bits.join(" · ") || "nothing to import";
  }

  const resolved = importResolvedDecks();
  if (!resolved.length) {
    el.importPreviewBody.innerHTML = `<div class="import-preview-empty">Select at least one deck above.</div>`;
    return;
  }

  // Notes preview reads as the document it will become; card preview lists the
  // first few question/answer pairs. Both are capped so a huge file can't lock
  // the panel up while you are still deciding.
  if (importStaging.content === "notes") {
    const body = resolved.map((deck) => deck.notes).filter((notes) => notes.trim()).join("\n\n---\n\n");
    const clipped = body.length > 6000;
    el.importPreviewBody.innerHTML = `<div class="rendered import-preview-notes">${markdownToSafeHtml(clipped ? `${body.slice(0, 6000)}\n\n…` : body)}</div>`;
    await enhanceRenderedMarkdown(el.importPreviewBody);
    return;
  }

  const cards = [];
  resolved.forEach((deck) => deck.cards.forEach((card) => cards.push({ ...card, deckTitle: deck.title })));
  const shown = cards.slice(0, 12);
  const notesLead = importStaging.content === "both" && resolved.some((deck) => deck.notes.trim())
    ? `<div class="import-preview-note">${resolved.length > 1 ? "Each document is also kept as its deck's notes." : "The full document is also kept as this deck's notes."}</div>`
    : "";

  if (!shown.length) {
    el.importPreviewBody.innerHTML = `${notesLead}<div class="import-preview-empty">No cards to show for this choice.</div>`;
    return;
  }

  el.importPreviewBody.innerHTML = notesLead + shown.map((card, index) => `
    <article class="import-preview-card">
      <div class="import-preview-card-head">Card ${index + 1}${resolved.length > 1 ? ` · ${escapeHtml(card.deckTitle)}` : ""}</div>
      <div class="import-preview-card-side">
        <span class="import-preview-card-label">Question</span>
        <div class="rendered">${markdownToSafeHtml(card.question)}</div>
      </div>
      <div class="import-preview-card-side">
        <span class="import-preview-card-label">Answer</span>
        <div class="rendered">${markdownToSafeHtml(card.answer)}</div>
      </div>
    </article>
  `).join("") + (cards.length > shown.length
    ? `<div class="import-preview-empty">…and ${cards.length - shown.length} more.</div>`
    : "");
  await enhanceRenderedMarkdown(el.importPreviewBody);
}

export function renderImportReview() {
  if (!importStaging || !el.importReviewStep) return;
  el.importReviewStep.hidden = false;
  if (el.importSourceStep) el.importSourceStep.hidden = true;
  renderImportDetection();
  renderImportChoices();
  renderImportDeckList();
  if (el.importConfirmBtn) {
    const totals = importTotals();
    el.importConfirmBtn.disabled = !totals.cards && !totals.notes;
    el.importConfirmBtn.textContent = importStaging.target === "current"
      ? "Add to this deck"
      : importStaging.target === "separate"
        ? `Create ${totals.decks} deck${totals.decks === 1 ? "" : "s"}`
        : "Create deck";
  }
  renderImportPreview();
}

export function appendNotesToCurrentDeck(body) {
  const incoming = String(body || "").trim();
  if (!incoming) return false;
  const existing = String(state.notes || "").trim();
  state.notes = existing ? `${existing}\n\n---\n\n${incoming}` : incoming;
  return true;
}

// Mints fresh ids for incoming cards and pulls any statuses they carried (a
// Recall .json export has them) into the parallel statusById map the rest of the
// app reads. Ids get a random suffix for the same reason as parseCards: card ids
// are globally unique in the cloud, so deterministic index+question ids collide
// across decks and the sync upsert would reassign the existing row's deck_id.
export function mintImportCards(incoming) {
  const statusById = {};
  const cards = incoming.map((card, index) => {
    const id = `${index}-${card.question.slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`;
    const status = normalizeCardStatus(card.status);
    if (status) statusById[id] = status;
    return { id, question: card.question, answer: card.answer };
  });
  return { cards, statusById };
}

// One saved deck per candidate — what picking a folder full of notes is asking
// for. These go straight into the library rather than through the working deck,
// so the deck the user has open is saved off and put back afterwards, exactly
// the way the EPUB chapter importer does it.
export async function commitSeparateDecks() {
  const resolved = importResolvedDecks();
  if (!resolved.length) {
    setStatus("Select at least one deck to import.", "error");
    return false;
  }

  const folder = importStaging.folder;
  setPendingImportFolder(null);
  const landingFolder = normalizeDeckCategory(folder != null ? folder : resolved[0].category);
  if (folder != null) addKnownFolder(landingFolder);

  const restore = {
    deckId: state.deckId, localDeckId: state.localDeckId, deckTitle: state.deckTitle,
    deckCategory: state.deckCategory, notes: state.notes, masterCards: state.masterCards,
    cards: state.cards, statusById: state.statusById, sourceTitle: state.sourceTitle,
    importTitleHint: state.importTitleHint, current: state.current
  };

  // Staggered a second apart so My Decks' default "recent" sort lists them in
  // the order they were picked rather than an arbitrary one.
  const baseTime = Date.now();
  let written = 0;
  let failed = false;
  for (let i = 0; i < resolved.length; i++) {
    const deck = resolved[i];
    const { cards, statusById } = mintImportCards(deck.cards);
    state.deckId = null;
    state.localDeckId = null;
    state.deckTitle = deck.title || `Imported deck ${i + 1}`;
    // A folder the import was aimed at wins; otherwise each deck keeps the
    // category its own file declared.
    state.deckCategory = folder != null ? landingFolder : normalizeDeckCategory(deck.category);
    state.notes = deck.notes;
    // Each imported deck is brand new — don't let the previously-open deck's
    // meta bag (e.g. a synced reading position) leak into it.
    state.meta = {};
    state.masterCards = cards;
    state.cards = cards;
    state.statusById = statusById;
    state.sourceTitle = state.deckTitle;
    state.importTitleHint = deck.source || "";
    state.current = 0;
    // saveDeckToLibrary returns null (never throws) when storage is full —
    // ignoring that would leave a half-written batch behind a success message.
    if (!(await saveDeckToLibrary({ silent: true, updatedAt: new Date(baseTime - i * 1000).toISOString() }))) {
      failed = true;
      break;
    }
    written += 1;
  }

  Object.assign(state, restore);
  persistWorkingDeck();
  closeImportPanel();

  // You cannot "open" twelve decks, so the batch lands you in the library
  // looking at where they went.
  setMyDecksView("folder");
  setMyDecksCwd(landingFolder);
  if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
  else openMyDecksPanel();

  if (failed) {
    const message = lastSaveErrorWasQuota
      ? `Only ${written} of ${resolved.length} decks saved — device storage is full. Delete some decks and try again.`
      : `Only ${written} of ${resolved.length} decks could be saved.`;
    setStatus(message, "error");
    showToast(message, "error");
    return written > 0;
  }

  const message = `Imported ${written} deck${written === 1 ? "" : "s"} into ${landingFolder}.`;
  setStatus(message);
  showToast(message);
  return true;
}

// Returns true when the import actually happened, so commitStagedImport knows
// whether the staging area may be cleared.
export function commitMarkdownImport() {
  const resolved = importResolvedDecks();
  if (!resolved.length) {
    setStatus("Select at least one deck to import.", "error");
    return false;
  }

  const { cards, statusById } = mintImportCards(resolved.flatMap((deck) => deck.cards));
  const notes = resolved.map((deck) => deck.notes).filter((body) => body.trim()).join("\n\n---\n\n");

  if (importStaging.target === "current") {
    pendingImportFolder = null; // appending never re-files the open deck
    if (cards.length) {
      state.cards = state.cards.concat(cards);
      state.masterCards = state.masterCards.concat(cards);
      Object.assign(state.statusById, statusById);
      syncResults();
    }
    const notesChanged = appendNotesToCurrentDeck(notes);
    closeAllCardsPanel();
    closeImportPanel();
    setViewMode(notesChanged && !cards.length ? "notes" : state.viewMode);
    scheduleDeckAutosave();
    showCard();
    setStatus(importCommitMessage(cards.length, notesChanged ? 1 : 0, resolved.length, true));
    return true;
  }

  state.masterCards = cards.slice();
  state.deckId = null;
  // Fresh import → detach from any previously-loaded library entry so the first
  // autosave creates a NEW deck instead of overwriting the old one.
  state.localDeckId = null;
  resetStudyDeck(state.masterCards);
  // After resetStudyDeck, which clears the per-card maps for the outgoing deck.
  state.statusById = statusById;
  syncResults();

  const title = resolved.length === 1
    ? (resolved[0].title || titleFromImportHint(importStaging.titleHint) || "Imported deck")
    : `Combined: ${resolved.map((deck) => deck.title || "Untitled").join(", ")}`.slice(0, 80);
  state.deckTitle = title;
  state.deckCategory = importTargetCategory(resolved.length === 1 ? resolved[0].category : defaultDeckCategory);
  state.sourceTitle = title;
  state.importTitleHint = importStaging.titleHint;
  state.notes = notes;

  closeAllCardsPanel();
  closeImportPanel();
  // Land on whichever view actually received content, so an imported document
  // opens on its notes instead of an empty card stage.
  setViewMode(cards.length ? "cards" : "notes");
  showCard();
  setStatus(importCommitMessage(cards.length, notes.trim() ? 1 : 0, resolved.length, false));
  return true;
}

export function importCommitMessage(cardCount, notesCount, deckCount, appended) {
  const bits = [];
  if (cardCount) bits.push(`${cardCount} card${cardCount === 1 ? "" : "s"}`);
  if (notesCount) bits.push("notes");
  const what = bits.join(" and ") || "nothing";
  if (appended) return `Added ${what} to "${state.deckTitle || "this deck"}".`;
  if (deckCount > 1) return `Imported ${what} from ${deckCount} decks.`;
  return `Imported ${what}.`;
}

export function commitSnapshotImport() {
  const candidate = importStaging.decks[0];
  const append = importStaging.target === "current";
  setPendingImportFolder(append ? null : importStaging.folder);
  try {
    loadDeckSnapshot(candidate.snapshot, importStaging.titleHint, append);
  } catch (error) {
    setStatus("Could not read this Recall JSON export.", "error");
    return false;
  }
  const title = state.deckTitle || candidate.title;
  closeImportPanel();
  setStatus(append
    ? `Added ${state.masterCards.length} card${state.masterCards.length === 1 ? "" : "s"} to "${title || "this deck"}".`
    : `Imported "${title}".`);
  if (append) scheduleDeckAutosave();
  return true;
}

export async function commitStagedImport() {
  if (!importStaging) return;
  if (importStaging.target !== "current") {
    setPendingImportFolder(importStaging.folder);
    // Remember it BEFORE committing: the commit paths clear the staging area.
    writeLastImportFolder(importDestinationFolder());
  }
  const done = importStaging.target === "separate"
    ? await commitSeparateDecks()
    // A lone .json export keeps its cloud id, per-card statuses and quick-note
    // labels by going through loadDeckSnapshot; in a batch it is written fresh
    // like any other candidate.
    : stagingIsLoneSnapshot(importStaging)
      ? commitSnapshotImport()
      : commitMarkdownImport();
  if (done) importStaging = null;
}
