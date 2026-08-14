// The Quick Notes board: a skim view of every quick note, filtered by subject.
//
// Its own screen rather than the card deck, because quick notes are read by
// scanning rather than one at a time.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { loadWebDeck } from "../cloud/web-decks.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { appendCardToLocalLibraryDeck, loadDeckFromLibrary } from "../library/local-library.js?v=__BUILD__";
import { onAnchorSourceDeck, scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { flushPendingQuickNoteAnchors, noteAnchorsFromMeta, queuePendingQuickNoteAnchors, resolveMissingQuickNoteSources, saveQuickNoteAnchors, setQnDeckNotesCache, setQuickNoteCardCategory, trimNoteAnchor } from "./anchors.js?v=__BUILD__";
import { applyQuickNoteCategoryOps, cachedUserId, categoryDeleteOp, categoryUpsertOp, ensureLocalQuickNotesSnapshot, flushPendingQuickNoteCategories, generateCategoryId, getQuickNotesDeckId, normalizeCategoryColor, normalizeQuickNoteCategories, quickNoteCategoriesFromMeta, readCachedQuickNoteCategories, readLocalSnapshotByDeckId, writeCachedQuickNoteCategories } from "./categories.js?v=__BUILD__";
import { QUICK_NOTES_DECK_TITLE, QUICK_NOTE_COLOR_PALETTE, QUICK_NOTE_DEFAULT_COLOR } from "./palette.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { mergeCloudCardsIntoSnapshot } from "../sync/cards.js?v=__BUILD__";
import { formatRelativeTime } from "../sync/indicator.js?v=__BUILD__";
import { setStatus, showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { recordNavHistory, refreshNavBack, suppressNavRecording } from "../ui/nav-history.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

// ── Quick Notes board (dedicated skim surface) ───────────────────
// Independent of the active study deck: pulls the quick_notes deck's cards
// straight from the cloud (falling back to the local snapshot offline), so the
// board can be opened at any time without disturbing whatever you're studying.
export const qnBoard = {
  cards: [],       // [{ id, question, answer, category, noteAnchor, updatedAt }]
  // Selected category chips: a Set of category ids, plus the literal "none" for
  // uncategorised. Empty means "All". Multi-select, so several subjects can be
  // read side by side.
  filters: new Set(),
  query: "",       // free-text search across note bodies
  loading: false
};

// A card passes when nothing is selected (All), or when its own category is
// among the selected chips.
export function quickNoteMatchesFilters(card) {
  if (!qnBoard.filters.size) return true;
  const known = card.category && findQuickNoteCategory(card.category);
  return known ? qnBoard.filters.has(card.category) : qnBoard.filters.has("none");
}

// The search box narrows the board before the category filter and the chip
// counts are applied, so the counts always describe what you can actually see.
export function quickNotesMatchingQuery() {
  const q = qnBoard.query.trim().toLowerCase();
  if (!q) return qnBoard.cards;
  return qnBoard.cards.filter((c) =>
    String(c.question || "").toLowerCase().includes(q) ||
    String(c.answer || "").toLowerCase().includes(q)
  );
}

export function findQuickNoteCategory(id) {
  return state.quickNoteCategories.find((c) => c.id === id) || null;
}

// Merge cloud cards (authoritative for text/category) with the deck's cloud
// meta bag (source anchors) and the local snapshot (offline fallback + anchors
// pinned before anchors were synced).
export async function loadQuickNotesData() {
  const deckId = getQuickNotesDeckId();
  const local = await readLocalSnapshotByDeckId(deckId);
  const localCards = local && Array.isArray(local.snapshot.cards) ? local.snapshot.cards : [];
  const anchorById = new Map(
    localCards.filter((c) => c.noteAnchor).map((c) => [String(c.id), c.noteAnchor])
  );

  let categories = readCachedQuickNoteCategories();
  if (!categories.length && local) categories = quickNoteCategoriesFromMeta(local.snapshot.meta);

  let cards = localCards.map((c) => ({
    id: String(c.id),
    question: String(c.question || ""),
    answer: String(c.answer || ""),
    category: c.category || null,
    noteAnchor: c.noteAnchor || null,
    updatedAt: c.updatedAt || null
  }));

  if (supabaseClient && isSignedIn && navigator.onLine && deckId) {
    try {
      // Deliver pending offline meta edits BEFORE the read below, because that
      // read treats the cloud row as authoritative. Reading first would show the
      // pre-offline categories, and the next edit from the board would then
      // write that stale list back and clear the pending record — losing the
      // offline edit permanently. Same ordering rule as reconcileAllDecks.
      await flushPendingQuickNoteCategories();
      await flushPendingQuickNoteAnchors();

      const [deckRes, cardsRes] = await Promise.all([
        supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle(),
        supabaseClient.from("cards").select("id, question, answer, status, category, updated_at").eq("deck_id", deckId).order("position", { ascending: true })
      ]);
      const cloudAnchors = deckRes.data && !deckRes.error ? noteAnchorsFromMeta(deckRes.data.meta) : {};
      if (!cardsRes.error && Array.isArray(cardsRes.data)) {
        // Merged, not replaced. Pins are local writes now, so a note made since
        // the last sync exists only on this device — reading the cloud straight
        // into the board would make it disappear the moment you opened the
        // board, which is exactly the bug the pull-side merge exists to stop.
        const { cards: mergedCards } = mergeCloudCardsIntoSnapshot(
          local?.snapshot || { cards: localCards },
          cardsRes.data,
          new Date().toISOString()
        );
        cards = mergedCards.map((c) => ({
          id: String(c.id),
          question: String(c.question || ""),
          answer: String(c.answer || ""),
          category: c.category || null,
          // Cloud anchor first (works on every device), local snapshot second.
          noteAnchor: cloudAnchors[String(c.id)] || c.noteAnchor || anchorById.get(String(c.id)) || null,
          updatedAt: c.updatedAt || null
        }));
      }
      // The cloud deck row is authoritative whenever we could read it —
      // including when it comes back empty. Preferring the local cache on an
      // empty cloud set meant deleting your last category on another device
      // never propagated: the stale cache kept resurrecting it here.
      if (deckRes.data && !deckRes.error) categories = quickNoteCategoriesFromMeta(deckRes.data.meta);

      // Repair pins made before anchors were synced: any anchor this device
      // still has locally but the cloud doesn't gets pushed up once, so the
      // source button comes back here and appears on other devices too. Only
      // safe when the cloud card list actually loaded — pruning against the
      // local fallback list would delete anchors for cards this device simply
      // hasn't pulled yet.
      if (!cardsRes.error && Array.isArray(cardsRes.data)) {
        const backfill = {};
        for (const card of cards) {
          const id = String(card.id);
          if (cloudAnchors[id]) continue;
          const trimmed = trimNoteAnchor(anchorById.get(id));
          if (trimmed) backfill[id] = trimmed;
        }
        const liveIds = new Set(cards.map((c) => String(c.id)));
        const orphaned = Object.keys(cloudAnchors).some((id) => !liveIds.has(String(id)));
        if (Object.keys(backfill).length || orphaned) {
          saveQuickNoteAnchors(backfill, { keepIds: liveIds });
        }
      }
    } catch (error) {
      console.warn("Quick notes cloud load failed; using local snapshot", error);
    }
  }

  state.quickNoteCategories = normalizeQuickNoteCategories(categories);
  writeCachedQuickNoteCategories(state.quickNoteCategories);
  // Newest pins first — a skim board wants the freshest thoughts on top.
  cards.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  qnBoard.cards = cards;
}

export function quickNoteCounts(cards = quickNotesMatchingQuery()) {
  const counts = { all: cards.length, none: 0 };
  for (const cat of state.quickNoteCategories) counts[cat.id] = 0;
  for (const card of cards) {
    if (card.category && counts[card.category] !== undefined) counts[card.category] += 1;
    else counts.none += 1;
  }
  return counts;
}

// The chips ARE the category navigation now that the board is one flat grid:
// each toggles independently, so you can read two or three subjects together.
// "All" is simply the state where nothing is selected.
export function renderQuickNotesFilters(cards = quickNotesMatchingQuery()) {
  const counts = quickNoteCounts(cards);
  const chip = (key, label, color) => {
    const selected = key === "all" ? !qnBoard.filters.size : qnBoard.filters.has(key);
    const dot = color ? `<span class="qn-chip-dot" style="background:${color}"></span>` : "";
    // The chip wears its category's colour while selected, so the active
    // filters and the cards they let through read as the same thing.
    const style = color ? ` style="--qn-accent:${color}"` : "";
    return `<button type="button" class="qn-chip${selected ? " is-active" : ""}"${style}` +
      ` data-qn-filter="${escapeHtml(key)}" aria-pressed="${selected}">` +
      `${dot}${escapeHtml(label)} <span class="qn-chip-count">${counts[key] || 0}</span></button>`;
  };
  let html = chip("all", "All");
  for (const cat of state.quickNoteCategories) html += chip(cat.id, cat.name, cat.color);
  html += chip("none", "Uncategorized");
  el.qnFilters.innerHTML = html;
}

export function renderQnCard(card) {
  const cat = card.category ? findQuickNoteCategory(card.category) : null;
  // The category colour drives the whole card (tint, border, badge) via this
  // one custom property — uncategorised cards fall back to a neutral treatment.
  const accent = cat ? cat.color : "var(--qn-neutral)";
  const anchor = card.noteAnchor;
  // A recovered anchor is a best guess (matched by text), so say so on hover
  // rather than promising it's exactly where you pinned from.
  const hint = anchor && anchor.guessed
    ? "Best match — found by searching your decks' notes"
    : "Go to where this was pinned";
  const source = anchor && (anchor.deckTitle || anchor.deckId || anchor.deckLocalId)
    ? `<button type="button" class="qn-card-source" data-qn-jump="${escapeHtml(card.id)}" title="${escapeHtml(hint)}">&#8618; ${escapeHtml(anchor.deckTitle || "source")}</button>`
    : "";
  const catLabel = cat
    ? `<span class="qn-chip-dot" style="background:${cat.color}"></span>${escapeHtml(cat.name)}`
    : `<span class="qn-chip-dot qn-dot-empty"></span><span class="qn-card-cat-empty">Set category</span>`;
  const when = formatRelativeTime(card.updatedAt);
  const time = when ? `<time class="qn-card-time" datetime="${escapeHtml(card.updatedAt || "")}">${escapeHtml(when)}</time>` : "";
  const classes = `qn-card${cat ? "" : " qn-card-uncat"}`;
  return `<article class="${classes}" data-qn-card="${escapeHtml(card.id)}" style="--qn-accent:${accent}">
    <div class="qn-card-top">
      <button type="button" class="qn-card-cat-btn" data-qn-cat-btn="${escapeHtml(card.id)}" aria-haspopup="true" title="Change category">${catLabel}<span class="qn-caret" aria-hidden="true">&#9662;</span></button>
      ${time}
    </div>
    <div class="qn-card-body">${markdownToSafeHtml(card.question || "")}</div>
    <div class="qn-card-foot">
      ${source}
      <button type="button" class="qn-card-copy" data-qn-copy="${escapeHtml(card.id)}" title="Copy this note" aria-label="Copy this note">&#128203;</button>
    </div>
  </article>`;
}

export function updateQnSummary(matching = quickNotesMatchingQuery()) {
  const total = qnBoard.cards.length;
  const cats = state.quickNoteCategories.length;
  if (!total) {
    el.qnSummary.textContent = "Pinned snippets across all your decks, at a glance.";
    return;
  }
  if (qnBoard.query.trim()) {
    el.qnSummary.textContent = `${matching.length} of ${total} note${total === 1 ? "" : "s"} match your search.`;
    return;
  }
  const uncategorized = quickNoteCounts(qnBoard.cards).none;
  const tail = uncategorized ? ` · ${uncategorized} to sort` : "";
  el.qnSummary.textContent = `${total} note${total === 1 ? "" : "s"} across ${cats} categor${cats === 1 ? "y" : "ies"}${tail}.`;
}

// Masonry pass: give every card a row span equal to its own rendered height, so
// a short note doesn't reserve the height of the tallest card in its row. The
// grid is 1px rows (see .qn-grid) and the 12px gap is the card's margin-bottom.
export function layoutQuickNotesGrid(retries = 3) {
  const grid = el.qnBody?.querySelector(".qn-grid");
  if (!grid) return;
  const gap = 12;
  const cards = [...grid.children];
  // Zero heights mean the grid hasn't been laid out yet (the board was still
  // hidden when this ran). Retry on the next frame rather than burning in a
  // wrong span — a bounded retry so a permanently-hidden board can't spin.
  if (cards.length && cards.every((card) => !card.getBoundingClientRect().height)) {
    if (retries > 0) requestAnimationFrame(() => layoutQuickNotesGrid(retries - 1));
    return;
  }
  for (const card of cards) {
    const height = card.getBoundingClientRect().height;
    if (!height) continue;
    card.style.gridRowEnd = `span ${Math.max(1, Math.ceil(height) + gap)}`;
  }
  grid.classList.add("is-measured");
}

// Cards change height when the window resizes (text rewraps) or when late
// content lands (images, fonts, KaTeX), so re-measure on both.
export let qnCardResizeObserver = null;

export function observeQuickNotesGrid() {
  const grid = el.qnBody?.querySelector(".qn-grid");
  if (!grid || typeof ResizeObserver === "undefined") return;
  if (!qnCardResizeObserver) {
    // rAF-batched: one relayout per frame no matter how many cards report.
    let queued = false;
    qnCardResizeObserver = new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; layoutQuickNotesGrid(); });
    });
  }
  qnCardResizeObserver.disconnect();
  for (const card of grid.children) qnCardResizeObserver.observe(card);
}

export function renderQuickNotesBoard() {
  const matching = quickNotesMatchingQuery();
  renderQuickNotesFilters(matching);
  updateQnSummary(matching);

  if (qnBoard.loading) {
    el.qnBody.innerHTML = `<div class="qn-empty">Loading your quick notes&#8230;</div>`;
    return;
  }
  if (!qnBoard.cards.length) {
    el.qnBody.innerHTML = `<div class="qn-empty"><p class="qn-empty-title">No quick notes yet</p><p>Select text anywhere in a deck's notes and tap &#128204; to pin it here for a quick skim later.</p></div>`;
    return;
  }

  // One flat, newest-first grid — never grouped by category. Grouping meant a
  // card physically jumped to another section the moment you categorised it,
  // which loses your place; here it stays exactly where it is and only its
  // colour changes.
  const visible = matching.filter(quickNoteMatchesFilters);
  if (visible.length) {
    el.qnBody.innerHTML = `<div class="qn-grid">${visible.map(renderQnCard).join("")}</div>`;
    layoutQuickNotesGrid();
    observeQuickNotesGrid();
    return;
  }
  el.qnBody.innerHTML = qnBoard.query.trim()
    ? `<div class="qn-empty"><p class="qn-empty-title">No matches</p><p>Nothing here matches &ldquo;${escapeHtml(qnBoard.query.trim())}&rdquo;.</p></div>`
    : `<div class="qn-empty">No notes in the selected categories.</div>`;
}

// ── Quick Notes return state ─────────────────────────────────────
// The board's slice of a history location (filters/search/scroll, and the note
// you opened from it). Set by goToNavLocation from the recorded location, then
// consumed by the next board render. See currentNavLocation.
export let qnReturnState = null;

// Setter: an imported binding is read-only, and this is written both from the
// Quick Notes board below and from ui/nav-history.js when Back restores it.
export function setQnReturnState(value) {
  qnReturnState = value;
}

// Put the board back the way it was and mark the note you left from, so it's
// obvious where you were.
export function restoreQnReturnState() {
  if (!qnReturnState) return;
  const { cardId, scrollTop } = qnReturnState;
  setQnReturnState(null);
  el.qnBody.scrollTop = scrollTop || 0;
  // cardId is only set when the board was left by opening a note from it — a
  // board recorded any other way has no card to point at.
  if (!cardId) return;
  const card = el.qnBody.querySelector(`.qn-card[data-qn-card="${CSS.escape(cardId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.classList.add("is-returned");
  setTimeout(() => card.classList.remove("is-returned"), 1600);
}

export async function openQuickNotesBoard({ restore = false } = {}) {
  if (!getQuickNotesDeckId()) {
    setStatus("Sign in to use quick notes.", "error");
    return;
  }
  closeAllCardsPanel();
  // A navigation door — remember the deck the user is leaving behind.
  recordNavHistory();
  lockPageScroll();
  el.quickNotesBoard.hidden = false;
  refreshNavBack(); // arrived — now the button knows where "here" is
  const returning = restore && qnReturnState;
  if (returning) {
    // Coming back from a source jump — keep the view the user left behind.
    qnBoard.query = qnReturnState.query;
    qnBoard.filters = new Set(qnReturnState.filters);
  } else {
    // A fresh open starts clean — a stale search or chip selection from last
    // time would look like missing notes.
    qnBoard.query = "";
    qnBoard.filters.clear();
    setQnReturnState(null);
  }
  if (el.qnSearch) el.qnSearch.value = qnBoard.query;
  // Deck notes may have changed since the last open — rebuild the search index.
  setQnDeckNotesCache(null);
  qnBoard.loading = true;
  renderQuickNotesBoard();
  try {
    await loadQuickNotesData();
  } finally {
    qnBoard.loading = false;
    renderQuickNotesBoard();
    if (returning) restoreQnReturnState();
  }
  // Deliberately not awaited: the board is already usable, and recovering the
  // missing source links repaints them a moment later.
  resolveMissingQuickNoteSources().catch((error) =>
    console.warn("Could not recover quick-note sources", error)
  );
}

export function closeQuickNotesBoard() {
  closeQnCatMenu();
  closeQnCatModal();
  el.quickNotesBoard.hidden = true;
  unlockPageScroll();
  // Closing changes where "here" is, which changes whether back has anywhere
  // to go (the deck below is usually the newest history entry).
  refreshNavBack();
}

// Jump from a board card to the notes spot it was pinned from (may live in a
// different deck), closing the board first. Mirrors jumpToNoteForCurrentCard.
export async function jumpToQuickNoteSource(cardId) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  const anchor = card && card.noteAnchor;
  if (!anchor) {
    setStatus("This note isn't linked to a source spot.", "info");
    return;
  }
  // Record the board itself, WHILE it's still open and tagged with the note
  // being opened, so back returns to this exact card. The deck loads below are
  // part of this same navigation — they must not record on top of it.
  recordNavHistory({ cardId });
  closeQuickNotesBoard();
  if (onAnchorSourceDeck(anchor)) { scheduleNoteJump(anchor); return; }
  setStatus("Opening the source deck…");
  if (anchor.deckLocalId && (await suppressNavRecording(() => loadDeckFromLibrary(anchor.deckLocalId)))) {
    scheduleNoteJump(anchor);
    return;
  }
  if (anchor.deckId && supabaseClient && navigator.onLine) {
    suppressNavRecording(() => loadWebDeck(anchor.deckId))
      .then(() => scheduleNoteJump(anchor))
      .catch(() => setStatus("Couldn't open the source deck for this note.", "error"));
    return;
  }
  setStatus("Couldn't open the source deck for this note — it isn't available on this device.", "error");
}

// Copy a note's text straight to the clipboard — the most common thing to want
// from a board you're skimming.
export async function copyQuickNote(cardId, button) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;
  const text = [card.question, card.answer].filter((part) => String(part || "").trim()).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.classList.add("is-copied");
      setTimeout(() => button.classList.remove("is-copied"), 1000);
    }
    showToast("Note copied");
  } catch (error) {
    console.warn("Clipboard write failed", error);
    showToast("Couldn't copy the note", "error");
  }
}

// ── Floating category picker (assign a category to one card) ──────
export function closeQnCatMenu() {
  document.querySelectorAll(".qn-cat-menu").forEach((m) => m.remove());
  document.removeEventListener("click", qnCatMenuOutside, true);
  document.removeEventListener("keydown", qnCatMenuEsc, true);
}

export function qnCatMenuOutside(e) {
  if (!e.target.closest(".qn-cat-menu") && !e.target.closest("[data-qn-cat-btn]")) closeQnCatMenu();
}

export function qnCatMenuEsc(e) { if (e.key === "Escape") closeQnCatMenu(); }

export function openQnCatMenu(cardId, btn) {
  const already = document.querySelector(`.qn-cat-menu[data-card="${CSS.escape(String(cardId))}"]`);
  closeQnCatMenu();
  if (already) return; // second click on the same button closes it
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;

  const menu = document.createElement("div");
  menu.className = "qn-cat-menu";
  menu.dataset.card = String(cardId);
  const item = (id, name, color) => {
    const active = (card.category || "") === (id || "") ? " is-active" : "";
    const dot = color
      ? `<span class="qn-chip-dot" style="background:${color}"></span>`
      : `<span class="qn-chip-dot qn-dot-empty"></span>`;
    return `<button type="button" class="qn-cat-menu-item${active}" data-qn-set="${escapeHtml(id)}">${dot}<span>${escapeHtml(name)}</span></button>`;
  };
  let html = state.quickNoteCategories.map((c) => item(c.id, c.name, c.color)).join("");
  html += item("", "Uncategorized", null);
  html += `<button type="button" class="qn-cat-menu-item qn-cat-menu-manage" data-qn-manage="1">&#9881; Manage categories&#8230;</button>`;
  menu.innerHTML = html;
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  const width = menu.offsetWidth || 200;
  menu.style.left = `${Math.min(r.left, window.innerWidth - width - 12)}px`;
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < menu.offsetHeight + 12) menu.style.top = `${Math.max(12, r.top - menu.offsetHeight - 6)}px`;
  else menu.style.top = `${r.bottom + 6}px`;

  setTimeout(() => {
    document.addEventListener("click", qnCatMenuOutside, true);
    document.addEventListener("keydown", qnCatMenuEsc, true);
  }, 0);
}

export async function assignQuickNoteCategory(cardId, categoryId) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (card) card.category = categoryId || null;
  closeQnCatMenu();
  renderQuickNotesBoard();
  // A local write now — it rides the next sync rather than costing a round trip
  // per tap. Still say where it landed: silence here used to read as "your
  // change was lost" when a later sync reported "nothing to sync".
  const cat = categoryId ? findQuickNoteCategory(categoryId) : null;
  const label = cat ? `“${cat.name}”` : "Uncategorized";
  const ok = await setQuickNoteCardCategory(cardId, categoryId || null);
  if (!ok) {
    showToast(`Could not set ${label} — this note isn't saved on this device`, "error");
  } else {
    showToast(`Set to ${label} — saved here, syncs with everything else`, "success");
  }
}

// Floating palette used to recolour a category from the manage modal.
export function openQnRecolorMenu(catId, anchorEl) {
  closeQnCatMenu();
  const menu = document.createElement("div");
  menu.className = "qn-cat-menu qn-recolor-menu";
  menu.innerHTML = QUICK_NOTE_COLOR_PALETTE
    .map((color) => `<button type="button" class="qn-swatch" style="background:${color}" data-qn-pick="${color}" aria-label="Colour ${color}"></button>`)
    .join("");
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-qn-pick]");
    if (!swatch) return;
    recolorQuickNoteCategory(catId, swatch.dataset.qnPick);
    closeQnCatMenu();
  });
  setTimeout(() => {
    document.addEventListener("click", qnCatMenuOutside, true);
    document.addEventListener("keydown", qnCatMenuEsc, true);
  }, 0);
}

// ── Manage categories modal ──────────────────────────────────────
export let qnNewColor = QUICK_NOTE_DEFAULT_COLOR;

// Setter: an imported binding is read-only, and the colour picker in main.js sets the pending colour.
export function setQnNewColor(value) {
  qnNewColor = value;
}

export function renderQnColorPicker(container, selected, attr) {
  container.innerHTML = QUICK_NOTE_COLOR_PALETTE.map((color) => {
    const active = color === selected ? " is-active" : "";
    return `<button type="button" class="qn-swatch${active}" style="background:${color}" data-${attr}="${color}" aria-label="Colour ${color}"></button>`;
  }).join("");
}

export function renderQnCatModal() {
  el.qnCatList.innerHTML = state.quickNoteCategories.length
    ? state.quickNoteCategories.map((c) => `
      <div class="qn-cat-row" data-cat="${escapeHtml(c.id)}">
        <button type="button" class="qn-cat-row-swatch" data-qn-recolor="${escapeHtml(c.id)}" style="background:${c.color}" title="Change colour" aria-label="Change colour"></button>
        <input type="text" class="qn-cat-row-name" data-qn-rename="${escapeHtml(c.id)}" value="${escapeHtml(c.name)}" maxlength="40" aria-label="Category name" />
        <button type="button" class="qn-cat-row-del" data-qn-del="${escapeHtml(c.id)}" title="Delete category" aria-label="Delete category">&#128465;</button>
      </div>`).join("")
    : `<p class="qn-cat-empty">No categories yet — add your first below.</p>`;
  renderQnColorPicker(el.qnCatColorPicker, qnNewColor, "qn-new-color");
}

export function openQnCatModal() {
  setQnNewColor(QUICK_NOTE_COLOR_PALETTE.find((c) => !state.quickNoteCategories.some((x) => x.color === c)) || QUICK_NOTE_DEFAULT_COLOR);
  renderQnCatModal();
  el.qnCatModal.hidden = false;
  setTimeout(() => el.qnCatNewName && el.qnCatNewName.focus(), 30);
}

export function closeQnCatModal() {
  if (el.qnCatModal) el.qnCatModal.hidden = true;
}

// `what` names the edit that was just made ("Added “Vocabulary”"), so the toast
// reports the specific action rather than a generic "saved".
export async function commitQuickNoteCategoryOps(ops, what = "Categories updated") {
  await applyQuickNoteCategoryOps(ops);
  renderQnCatModal();
  renderQuickNotesBoard();
  showToast(`${what} — saved here, syncs with everything else`, "success");
}

export async function addQuickNoteCategory() {
  const name = String(el.qnCatNewName.value || "").trim();
  if (!name) { el.qnCatNewName.focus(); return; }
  const cat = { id: generateCategoryId(), name, color: normalizeCategoryColor(qnNewColor) };
  el.qnCatNewName.value = "";
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { name: cat.name, color: cat.color })], `Added “${name}”`);
}

export async function renameQuickNoteCategory(id, name) {
  const clean = String(name || "").trim();
  const previous = findQuickNoteCategory(id);
  // A blank rename is ignored, so report — and send — the name that stuck.
  const applied = clean || previous?.name || "Category";
  if (previous && applied === previous.name) return;
  // Only `name` travels: sending the whole category would revert a recolour
  // another device made while this one was offline.
  const cat = { ...(previous || { id }), name: applied };
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { name: applied })], `Renamed to “${applied}”`);
}

export async function recolorQuickNoteCategory(id, color) {
  const previous = findQuickNoteCategory(id);
  const applied = normalizeCategoryColor(color);
  if (previous && previous.color === applied) return;
  const cat = { ...(previous || { id }), color: applied };
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { color: applied })], `Recoloured “${previous ? previous.name : "category"}”`);
}

export function deleteQuickNoteCategory(id) {
  const cat = findQuickNoteCategory(id);
  const used = qnBoard.cards.filter((c) => c.category === id).length;
  const msg = used
    ? `Delete "${cat ? cat.name : "this category"}"? ${used} note${used === 1 ? "" : "s"} will become Uncategorized.`
    : `Delete "${cat ? cat.name : "this category"}"?`;
  showConfirmModal(msg, async () => {
    // Detach the category from any board cards + persist those clears.
    const affected = qnBoard.cards.filter((c) => c.category === id);
    for (const card of affected) { card.category = null; await setQuickNoteCardCategory(card.id, null); }
    // Drop the deleted category's chip from the selection, or the board would
    // keep filtering on an id that no longer exists and look empty.
    qnBoard.filters.delete(id);
    const freed = affected.length ? `, ${affected.length} note${affected.length === 1 ? "" : "s"} now Uncategorized` : "";
    await commitQuickNoteCategoryOps([categoryDeleteOp(id)], `Deleted “${cat ? cat.name : "category"}”${freed}`);
  }, { confirmLabel: "Delete", danger: true });
}

// Ensure the quick_notes web deck ROW exists for the current user, returning
// its id. No longer on the pin path — a pin is a pure local write now, and the
// reconcile push creates this row as a side effect of upserting the deck. Still
// used by the meta writers, which UPDATE a row that has to already exist.
export async function ensureQuickNotesDeck(userId) {
  const deckId = `quick-notes-${userId}`;

  const { data: existing, error: lookupError } = await supabaseClient
    .from("decks")
    .select("id")
    .eq("id", deckId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return deckId;

  const now = new Date().toISOString();
  const { error: insertError } = await supabaseClient
    .from("decks")
    .upsert({
      id: deckId,
      title: QUICK_NOTES_DECK_TITLE,
      category: defaultDeckCategory,
      current_card_index: 0,
      updated_at: now,
      last_accessed_at: now
    });
  if (insertError) throw insertError;
  return deckId;
}

// Save the selected text as a new card (text becomes the question, answer left
// blank to fill in later) appended to the quick_notes deck.
//
// Entirely local. Pinning used to cost five sequential Supabase round trips —
// deck lookup, deck insert, card count, card insert, deck bump — plus a sixth
// read-merge-write for the source anchor, all before the toast appeared. On a
// phone that's most of a second per pin, and offline it simply failed, losing
// the selection. Now it's a localStorage write, and the whole batch of pins
// goes up with everything else on the next reconcile.
export async function saveQuickNote(rawText, button, sourceAnchor = null) {
  const text = String(rawText || "").trim();
  if (!text) {
    setStatus("Select some text first to save a quick note.", "error");
    return;
  }

  // cachedUserId reads the marker ensureLocalLibraryOwner wrote at sign-in, so
  // this stays synchronous and works offline — getCurrentUser() was a network
  // round trip that made pinning impossible with no connection.
  if (!cachedUserId()) {
    setStatus("Sign in to save quick notes.", "error");
    showToast("Sign in to save quick notes", "error");
    return;
  }

  const local = await ensureLocalQuickNotesSnapshot();
  if (!local) {
    setStatus("Could not save quick note — try signing in again.", "error");
    showToast("Couldn't save quick note", "error");
    return;
  }

  const now = new Date().toISOString();
  const cardId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The source location (deck + note offset) behind the card's "Go to notes"
  // jump. Kept on the card locally AND queued for the deck's cloud meta bag —
  // the cards table has no column for it, so the queue is the only way it
  // reaches another device.
  const anchor = trimNoteAnchor(sourceAnchor);
  const quickCard = { id: cardId, question: text, answer: "", status: null, category: null };
  if (anchor) quickCard.noteAnchor = anchor;

  // The only write that makes this pin real. It can now genuinely fail (an
  // IndexedDB read failure throws rather than silently reading as "no such
  // deck" — see readDeckSnapshot), and a pin that failed must NEVER report
  // success: the user has already moved on from the text they selected, and a
  // false "Saved" is how a note is lost without anyone noticing.
  try {
    await appendCardToLocalLibraryDeck(local.snapshot.deckId, quickCard, now);
  } catch (error) {
    console.error("Could not save quick note", error);
    setStatus("Couldn't save that quick note — reload the app and try again.", "error");
    showToast("Couldn't save quick note — nothing was written", "error");
    return;
  }
  if (anchor) queuePendingQuickNoteAnchors({ [cardId]: anchor });

  // Mirror into the open board so a pin shows up without a reload.
  if (Array.isArray(qnBoard.cards)) {
    qnBoard.cards.unshift({
      id: cardId, question: text, answer: "", category: null,
      noteAnchor: anchor || null, updatedAt: now
    });
  }

  setStatus("Saved to quick_notes.");
  showToast(navigator.onLine ? "Saved to quick_notes" : "Saved to quick_notes — syncs when you're back online");
  if (button) {
    button.classList.add("quick-note-saved");
    setTimeout(() => button.classList.remove("quick-note-saved"), 1200);
  }
}
