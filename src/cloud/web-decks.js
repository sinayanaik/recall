// Reading and writing the deck rows in the user's Supabase project, and the
// payload shape both sides of the sync agree on.

import { closeAllCardsPanel } from "../cards/all-cards-edit.js?v=__BUILD__";
import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { resetStudyDeck, syncResults } from "../cards/study.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "./net.js?v=__BUILD__";
import { supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { notesExportBlock } from "../import/parse-cards.js?v=__BUILD__";
import { setKnownWebDeckCategories, webDeckCategories } from "../library/categories.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { flushPendingDeckAutosave, formatCardList, isQuickNotesDeck, normalizeCardStatus, quickNoteCategoriesFromMeta, readCachedQuickNoteCategories, readLocalDeckIndex, refreshSyncIndicatorBaseline, resetChromeAutoHide, revokeLocalImageUrls, saveDeckToLibrary, scheduleNoteJump, setViewMode, showCard, state, syncLocalLibraryMetaForDeck, writeCachedQuickNoteCategories, writeLocalDeckIndex } from "../main.js?v=__BUILD__";
import { discardNotesEditingForDeckSwap } from "../notes/notes-view.js?v=__BUILD__";
import { closeImportPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import { recordNavHistory, refreshNavBack } from "../ui/nav-history.js?v=__BUILD__";
import { unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

// Whichever of two ISO timestamps (either may be null/undefined) is later,
// or null if neither parses.
export function laterIsoTimestamp(a, b) {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

// Local counterpart of touchWebDeckAccess: bumps a deck's "last opened" time
// without touching updatedAt, so background reconcile reloads (which also call
// loadDeckFromLibrary) don't masquerade as a real visit — only the explicit
// open-from-My-Decks call sites invoke this.
export function touchLocalDeckAccess(id) {
  if (!id) return;
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.id === id);
  if (!entry) return;
  entry.accessedAt = new Date().toISOString();
  writeLocalDeckIndex(index);
}

// A PostgREST UPDATE that matches NO rows is not an error — it is a successful
// request that changed nothing. Under RLS that is the normal shape of "this row
// isn't yours" and of "this row no longer exists", so these three writers
// reported success for both. `.select("id")` makes the server return what it
// actually touched, which is the only way to tell the difference. The decks.meta
// writers already do this; these did not.
export async function updatedDeckRow(builder, label) {
  const { data, error } = await builder.select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(
      `Couldn't ${label} in the cloud — that deck isn't there, or it belongs to another account.`
    );
  }
  return true;
}

export async function touchWebDeckAccess(deckId) {
  if (!deckId || !supabaseClient) return false;

  // The one exception: this is a background bookkeeping touch fired whenever a
  // deck is opened or exported. A deck that only exists locally has no cloud row
  // to touch, which is ordinary rather than a fault, so a zero-row result here
  // stays quiet — nothing downstream depends on it having landed.
  const { error } = await supabaseClient
    .from("decks")
    .update({
      last_accessed_at: new Date().toISOString()
    })
    .eq("id", deckId);

  if (error) throw error;
  return true;
}

export async function updateWebDeckTitle(deckId, title) {
  if (!deckId || !supabaseClient) return false;

  const now = new Date().toISOString();
  await updatedDeckRow(
    supabaseClient.from("decks").update({ title, updated_at: now }).eq("id", deckId),
    "rename that deck"
  );
  await syncLocalLibraryMetaForDeck(deckId, { title, now });
  return true;
}

export async function updateWebDeckCategory(deckId, category) {
  if (!deckId || !supabaseClient) return false;

  const normalized = normalizeDeckCategory(category);
  const now = new Date().toISOString();
  await updatedDeckRow(
    supabaseClient.from("decks").update({ category: normalized, updated_at: now }).eq("id", deckId),
    "move that deck"
  );
  await syncLocalLibraryMetaForDeck(deckId, { category: normalized, now });
  return true;
}

export async function applyWebDeckCategory(deckId, category) {
  const normalized = normalizeDeckCategory(category);
  setKnownWebDeckCategories([...webDeckCategories, normalized]);
  await updateWebDeckCategory(deckId, normalized);

  if (state.deckId === deckId) {
    state.deckCategory = normalized;
    updateMeta();
  }

  return normalized;
}

export function closeWebDeckExportMenus(exceptMenu = null) {
  document.querySelectorAll(".web-deck-export-menu, .bulk-export-menu").forEach((menu) => {
    if (menu !== exceptMenu) {
      menu.hidden = true;
      const trigger = menu.previousElementSibling;
      if (trigger?.matches("[aria-expanded]")) trigger.setAttribute("aria-expanded", "false");
    }
  });
}

export function downloadTextFile(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function normalizeWebDeckPayload(deckData, cardsData = []) {
  const deck = {
    id: String(deckData.id || ""),
    title: String(deckData.title || "Untitled"),
    category: normalizeDeckCategory(deckData.category),
    notes: String(deckData.notes || ""),
    meta: deckData.meta && typeof deckData.meta === "object" ? deckData.meta : {},
    current_card_index: Number(deckData.current_card_index) || 0,
    created_at: deckData.created_at || null,
    updated_at: deckData.updated_at || null,
    last_accessed_at: deckData.last_accessed_at || null
  };

  const cards = (cardsData || []).map((card, index) => ({
    id: String(card.id || `${deck.id}-${index}`),
    deck_id: String(card.deck_id || deck.id),
    question: String(card.question || ""),
    answer: String(card.answer || ""),
    position: Number.isFinite(Number(card.position)) ? Number(card.position) : index,
    status: normalizeCardStatus(card.status),
    // Free subject label for quick_notes cards; null on regular study cards.
    category: card.category ? String(card.category) : null,
    created_at: card.created_at || null,
    updated_at: card.updated_at || null
  }));

  return { deck, cards };
}

export function deckPayloadSnapshot(payload) {
  return {
    app: "recall", // informational only — imports never read this field, so old "markdown-flashcards" exports still load
    version: 1,
    exportedAt: new Date().toISOString(),
    // The deck's REAL last-edited time (distinct from exportedAt, the moment the
    // archive was written). Restore compares this to decide newest-wins, so it
    // must survive the round-trip; falls back to null for older exports.
    updatedAt: payload.deck.updated_at || null,
    deckTitle: payload.deck.title,
    deckCategory: payload.deck.category,
    notes: payload.deck.notes || "",
    // Deck-level bag — carries the quick_notes managed category set through
    // backup/restore so restored notes still resolve their labels.
    meta: payload.deck.meta && typeof payload.deck.meta === "object" ? payload.deck.meta : {},
    sourceTitle: payload.deck.title,
    importTitleHint: payload.deck.title,
    deckId: payload.deck.id,
    current: payload.deck.current_card_index || 0,
    cards: payload.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      status: card.status,
      // Quick-note subject label carried through backup/restore + reconcile.
      category: card.category || null,
      // Per-card last-edited time when known, so card-level conflicts can also
      // resolve newest-wins instead of blindly overwriting a newer local edit.
      updatedAt: card.updated_at || null
    }))
  };
}

export function statusByIdFromCards(cards = []) {
  return cards.reduce((statusById, card) => {
    const status = normalizeCardStatus(card.status);
    if (status) statusById[card.id] = status;
    return statusById;
  }, {});
}

// Quick-note subject label for a card: state.categoryById is authoritative
// while a deck is open (the board writes there), with the card's own field as
// the fallback for cards that never went through a deck load.
export function quickNoteCategoryForCard(card) {
  if (!card || !card.id) return null;
  const assigned = state.categoryById[card.id];
  if (assigned) return String(assigned);
  return card.category ? String(card.category) : null;
}

// Apply a loaded deck's meta bag to the in-memory category set. Only the
// quick_notes deck owns this set: loading an ordinary deck must leave it alone,
// or its (empty) meta would blank the categories the board still needs. Falls
// back to the local cache so an offline/pre-migration load still has labels.
export function applyDeckMetaCategories(meta, deckId, title) {
  if (!isQuickNotesDeck(deckId, title)) return;
  const fromMeta = quickNoteCategoriesFromMeta(meta);
  if (fromMeta.length) {
    state.quickNoteCategories = fromMeta;
    writeCachedQuickNoteCategories(fromMeta);
  } else {
    state.quickNoteCategories = readCachedQuickNoteCategories();
  }
}

export async function fetchWebDeckPayload(deckId) {
  const { data: deckData, error: deckError } = await supabaseClient
    .from("decks")
    .select("*")
    .eq("id", deckId)
    .single();

  if (deckError) throw deckError;

  const { data: cardsData, error: cardsError } = await supabaseClient
    .from("cards")
    .select("*")
    .eq("deck_id", deckId)
    .order("position", { ascending: true });

  if (cardsError) throw cardsError;
  return normalizeWebDeckPayload(deckData, cardsData || []);
}

export function webDeckPayloadMarkdown(payload) {
  const notesBlock = notesExportBlock(payload.deck.notes);
  return [
    `# ${payload.deck.title}`,
    "",
    `Category: ${payload.deck.category}`,
    `Deck ID: ${payload.deck.id}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    formatCardList("Cards", payload.cards),
    notesBlock ? "" : null,
    notesBlock || null
  ].filter((line) => line !== null).join("\n");
}

// Bumped by every deck-open attempt (web or local), so an in-flight one can
// tell whether it's still the load the user actually wants applied. A big
// note's web fetch can take long enough that the user opens a different deck
// from My Decks before it resolves — without this, the slower response lands
// LAST and silently overwrites whatever the user navigated to with the deck
// they left. See the checks in loadWebDeck and loadDeckFromLibrary below.
export let activeDeckLoadToken = 0;

export async function loadWebDeck(deckId) {
  if (!deckId || !supabaseClient) return;
  if (!navigator.onLine) {
    setStatus("Offline — can't load web decks. Try “My Decks” for device copies.", "error");
    showToast("Offline — can't load web deck", "info");
    return;
  }

  setStatus("Loading deck from web...");
  // A navigation door — see recordNavHistory. Recorded synchronously, before
  // the await below can let anything else move the user.
  recordNavHistory();
  const loadToken = ++activeDeckLoadToken;

  try {
    const [deckResult, cardsResult] = await Promise.all([
      withTimeout(abortable((signal) => supabaseClient.from("decks").select("*").eq("id", deckId).single().abortSignal(signal)), CLOUD_TIMEOUT_MS, "load deck"),
      withTimeout(abortable((signal) => supabaseClient.from("cards").select("*").eq("deck_id", deckId).order("position", { ascending: true }).abortSignal(signal)), CLOUD_TIMEOUT_MS, "load cards")
    ]);

    const { data: deckData, error: deckError } = deckResult;
    if (deckError) throw deckError;

    const { data: cardsData, error: cardsError } = cardsResult;
    if (cardsError) throw cardsError;

    // The user opened a different deck (local or web) while this fetch was in
    // flight — that newer load already owns the view. Applying this response
    // now would yank the screen back to the deck the user left.
    if (loadToken !== activeDeckLoadToken) return;
    // Flush the outgoing deck's debounced keystrokes while `state` still
    // describes it — see flushPendingDeckAutosave — then re-check the token,
    // because that flush is another await.
    await flushPendingDeckAutosave();
    if (loadToken !== activeDeckLoadToken) return;

    const statusById = {};
    const categoryById = {};
    const cards = cardsData.map((rawCard, index) => {
      const id = String(rawCard.id || `${index}-${rawCard.question.slice(0, 32)}`);
      const status = normalizeCardStatus(rawCard.status);
      if (status) {
        statusById[id] = status;
      }
      if (rawCard.category) categoryById[id] = String(rawCard.category);
      return { id, question: rawCard.question, answer: rawCard.answer };
    });

    state.deckId = deckData.id;
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
    state.categoryById = categoryById;
    // Managed category set lives on the deck's meta bag (quick_notes only).
    applyDeckMetaCategories(deckData.meta, deckData.id, deckData.title);
    // Carry the whole meta bag forward (not just the quick_notes categories
    // pulled out above) so per-deck fields like a synced reading position
    // survive the next autosave instead of being silently dropped.
    state.meta = deckData.meta && typeof deckData.meta === "object" ? deckData.meta : {};
    state.current = 0; // always start from the first card on fresh load
    state.deckTitle = deckData.title || "";
    state.deckCategory = normalizeDeckCategory(deckData.category);
    // MUST come before state.notes is replaced — the loadDeckSnapshot sibling
    // of this line explains why an open raw editor outlives a deck swap and
    // what it overwrites when it does.
    discardNotesEditingForDeckSwap();
    // The deck being left is the last thing that needed its queued images'
    // blob URLs. See revokeLocalImageUrls for why the session can't wait for
    // pagehide to release them.
    revokeLocalImageUrls();
    // Pre-migration databases have no notes column; select("*") just omits it.
    state.notes = String(deckData.notes || "");
    state.sourceTitle = deckData.title || "";
    state.importTitleHint = deckData.title || "";
    setViewMode("notes");
    // Cross-device resume: this deck's meta may carry a reading position
    // synced from another device. Ambient landing, not a deliberate jump —
    // no flash, no animated scroll. scheduleNoteJump no-ops quietly if the
    // anchor can't be found (notes changed since, or this is the first time
    // this deck has ever had a position saved).
    if (state.meta?.readingPosition) scheduleNoteJump(state.meta.readingPosition, { flash: false, smooth: false });

    syncResults();
    touchWebDeckAccess(deckData.id).catch((error) => console.error("Failed to touch deck access", error));
    closeAllCardsPanel();
    setStatus(`Loaded ${cards.length} cards from web successfully.`);
    showToast(`Loaded "${state.deckTitle || "deck"}" · ${cards.length} cards`);
    if (el.myDecksPanel) el.myDecksPanel.hidden = true;
    unlockPageScroll();
    closeImportPanel();
    showCard();
    // Mirror the freshly-loaded web deck into the on-device library (deduped by
    // cloud id) so it stays readable offline without an extra manual save. Align
    // its timestamps to the cloud copy so it reads as already in-sync — otherwise
    // it would look "newer" and trigger a redundant re-push on the next reconcile.
    // Skipped entirely once superseded: saveDeckToLibrary assigns state.localDeckId
    // as a side effect, and running that for a deck the user has since navigated
    // away from would yank state.localDeckId back to it out from under whatever
    // deck is actually on screen now.
    if (loadToken === activeDeckLoadToken) {
      state.localDeckId = null;
      const mirroredMeta = await saveDeckToLibrary({ silent: true, updatedAt: deckData.updated_at, lastSyncedAt: deckData.updated_at, synced: true });
      if (loadToken === activeDeckLoadToken) {
        if (mirroredMeta) touchLocalDeckAccess(mirroredMeta.id);
        refreshSyncIndicatorBaseline();
        refreshNavBack(); // arrived — now the button knows where "here" is
        resetChromeAutoHide(); // a new deck starts at the top, header showing
      }
    }
  } catch (error) {
    setStatus("Failed to load deck from web.", "error");
    showToast("Couldn't load deck", "error");
    console.error(error);
  }
}
