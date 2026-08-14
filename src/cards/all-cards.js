// The All Cards panel: every card in the deck at once, editable in place.

import { clearAllCardDropTargets, refreshAllCardsAround } from "./all-cards-edit.js?v=__BUILD__";
import { setCardStatusBadge, updateMeta } from "./card-status.js?v=__BUILD__";
import { showCard } from "./card-view.js?v=__BUILD__";
import { afterPaint } from "./question-fit.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { createToolbarHtml } from "../editor/toolbars.js?v=__BUILD__";
import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { cornellCardHtml } from "../export/pdf.js?v=__BUILD__";
import { enableSyntaxHighlighting, setDraggedAllCardId, state } from "../main.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export function handleAllCardDragEnd() {
  setDraggedAllCardId("");
  clearAllCardDropTargets();
}

export function updateAllCardStatuses() {
  el.allCardsList.querySelectorAll(".all-card").forEach((node) => {
    const status = state.statusById[node.dataset.cardId] || "";
    node.dataset.status = status;
    setCardStatusBadge(node.querySelector("[data-all-status-label]"), status);
    node.querySelectorAll("[data-all-status]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.allStatus === status);
    });
  });
  // A card whose status just changed may fall in/out of an active filter —
  // refresh the CSS filter + header count so it drops out (or the count updates).
  applyAllCardsFilter();
}

export function allCardById(cardId) {
  return state.masterCards.find((card) => card.id === cardId) || null;
}

export function closeAllCardEditor(item) {
  const editor = item?.querySelector(".all-card-editor");
  if (!editor) return;
  editor.hidden = true;
  editor.dataset.side = "";
  item.classList.remove("is-editing");
  item.draggable = true;
  updateAllCardEditButton(item);
  adjustCornellRowHeight(item);
}

export function closeAllCardEditors(exceptItem = null) {
  el.allCardsList.querySelectorAll(".all-card.is-editing").forEach((item) => {
    if (item !== exceptItem) closeAllCardEditor(item);
  });
}

export function allCardVisibleSide(item) {
  return item?.classList.contains("is-flipped") ? "answer" : "question";
}

export function updateAllCardEditButton(item) {
  const button = item?.querySelector("[data-all-edit-current]");
  if (!button) return;
  const editing = item.classList.contains("is-editing");
  const side = editing
    ? item.querySelector(".all-card-editor")?.dataset.side || allCardVisibleSide(item)
    : allCardVisibleSide(item);
  button.innerHTML = editing ? "&#128190;" : "&#9998;";
  button.classList.toggle("is-saving", editing);
  button.title = editing
    ? `Save ${side}`
    : `Edit ${side}`;
  button.setAttribute("aria-label", button.title);
}

// Built on first edit, not at render time.
//
// renderAllCards used to give every card its own editor up front, each carrying
// a full copy of createToolbarHtml() — ~73 lines of markup per card, in a
// container that starts hidden and that most cards never open. On a few-hundred
// card deck that was the single biggest slice of the freeze when All Cards was
// opened.
export function ensureAllCardEditor(item) {
  const existing = item?.querySelector(".all-card-editor");
  if (existing || !item) return existing || null;
  const cell = item.querySelector(".cornell-answer-cell");
  if (!cell) return null;
  const editor = document.createElement("div");
  editor.className = "all-card-editor";
  editor.hidden = true;
  editor.innerHTML = `
    <label>
      <div class="all-card-editor-header">
        <span data-all-edit-label>Question</span>
        <div class="edit-toolbar" data-all-card-toolbar>
          ${createToolbarHtml()}
        </div>
      </div>
      <textarea data-all-edit-value spellcheck="false"></textarea>
    </label>
  `;
  cell.appendChild(editor);
  return editor;
}

export function openAllCardEditor(item, side = allCardVisibleSide(item)) {
  const card = allCardById(item?.dataset.cardId);
  const editor = ensureAllCardEditor(item);
  if (!card || !editor) return;

  closeAllCardEditors(item);
  item.classList.add("is-editing");
  item.draggable = false;
  if (side === "answer") item.classList.add("is-flipped");
  editor.hidden = false;
  editor.dataset.side = side;
  editor.querySelector("[data-all-edit-label]").textContent = side === "answer" ? "Answer" : "Question";
  const textarea = editor.querySelector("[data-all-edit-value]");
  textarea.value = side === "answer" ? card.answer : card.question;
  updateAllCardEditButton(item);
  adjustCornellRowHeight(item);
  enableSyntaxHighlighting(textarea);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function toggleAllCardEditor(item) {
  if (!item) return;
  const editor = item.querySelector(".all-card-editor");
  if (item.classList.contains("is-editing")) {
    saveAllCardEditor(item);
    return;
  }
  openAllCardEditor(item, allCardVisibleSide(item));
}

export function saveAllCardEditor(item) {
  const card = allCardById(item?.dataset.cardId);
  const editor = item?.querySelector(".all-card-editor");
  if (!card || !editor) return;

  const side = editor.dataset.side === "answer" ? "answer" : "question";
  const value = editor.querySelector("[data-all-edit-value]").value.trim();

  if (!value) {
    setStatus(`${side === "answer" ? "Answer" : "Question"} cannot be empty.`, "error");
    return;
  }

  card[side] = value;
  updateMeta();
  // showCard (below) schedules an autosave, but only runs when the edited card
  // is the one on screen — schedule explicitly so edits to any other card are
  // persisted too instead of waiting for the next navigation/tab-hide flush.
  scheduleDeckAutosave();
  if (state.cards[state.current]?.id === card.id || state.previewCard?.id === card.id) {
    showCard();
  }

  refreshAllCardsAround(card.id, side);
  setStatus(state.deckId ? "Card updated locally. Sync to update the web deck." : "Card updated.");
}

export async function ensureAllCardAnswer(item) {
  if (item.dataset.answerRendered === "true") {
    adjustCornellRowHeight(item);
    return;
  }
  if (item.dataset.answerRendered === "rendering") return;
  const card = item.cardData;
  if (!card) return;

  item.dataset.answerRendered = "rendering";
  const answerView = item.querySelector(".all-card-answer .rendered");
  answerView.textContent = "Rendering...";
  await renderMarkdown(answerView, card.answer, true);
  item.dataset.answerRendered = "true";
  adjustCornellRowHeight(item);
}

export function flipAllCard(item) {
  if (item.dataset.answerRendered === "rendering") return;
  if (item.classList.contains("is-editing")) return;
  const willShowAnswer = !item.classList.contains("is-flipped");
  item.classList.toggle("is-flipped", willShowAnswer);
  if (willShowAnswer) {
    ensureAllCardAnswer(item).then(() => adjustCornellRowHeight(item));
  } else {
    adjustCornellRowHeight(item);
  }
  updateAllCardEditButton(item);
}

// Sizing a Cornell row is a write (clear the min-height) followed by reads
// (scrollHeight, a rect), so doing it row by row forces one full layout PER ROW.
// Split into its three phases so a caller with many rows can reset them all,
// measure them all, then write them all — three flushes instead of 3n.
export function resetCornellRowHeight(row) {
  if (row) row.style.minHeight = "";
}

export function measureCornellRowHeight(row) {
  if (!row) return null;
  // Compact rows size to their content — no forced min-height.
  if (row.closest(".all-cards-list.is-compact")) return null;
  const rail = row.querySelector(".cornell-question-rail");
  const question = rail?.querySelector(".rendered");
  const answerCell = row.querySelector(".cornell-answer-cell");
  if (!rail || !question || !answerCell) return null;

  const railStyle = getComputedStyle(rail);
  const railPaddingY = (parseFloat(railStyle.paddingTop) || 0) + (parseFloat(railStyle.paddingBottom) || 0);
  const railGap = parseFloat(railStyle.rowGap || railStyle.gap) || 0;
  const badge = rail.querySelector(".cornell-row-number");
  const badgeHeight = badge ? badge.getBoundingClientRect().height : 0;
  const questionBuffer = row.classList.contains("cornell-print-row") ? 10 : 16;
  const questionHeight = question.scrollHeight + railPaddingY + badgeHeight + railGap + questionBuffer;
  const answerHeight = answerCell.scrollHeight;
  const minHeight = row.classList.contains("cornell-print-row") ? 72 : 108;
  return Math.ceil(Math.max(minHeight, rail.scrollHeight, questionHeight, answerHeight));
}

export function applyCornellRowHeight(row, height) {
  if (row && height != null) row.style.minHeight = `${height}px`;
}

export function adjustCornellRowHeight(row) {
  if (!row) return;
  resetCornellRowHeight(row);
  applyCornellRowHeight(row, measureCornellRowHeight(row));
}

export function adjustCornellRows(container = document) {
  const rows = Array.from(container.querySelectorAll(".cornell-card, .cornell-print-row"));
  if (!rows.length) return;
  rows.forEach(resetCornellRowHeight);
  const heights = rows.map(measureCornellRowHeight);
  rows.forEach((row, at) => applyCornellRowHeight(row, heights[at]));
}

export function updateAllAnswersToggleButton() {
  if (!el.toggleAllAnswersBtn) return;
  el.toggleAllAnswersBtn.textContent = allCardsAnswersVisible ? "Hide answers" : "Show answers";
  el.toggleAllAnswersBtn.setAttribute("aria-pressed", allCardsAnswersVisible ? "true" : "false");
}

export function updateCompactToggleButton() {
  if (!el.toggleCompactBtn) return;
  el.toggleCompactBtn.classList.toggle("is-active", allCardsCompact);
  el.toggleCompactBtn.setAttribute("aria-pressed", allCardsCompact ? "true" : "false");
}

// Toggle the dense one-line-per-card view. Pure CSS switch on the list, so no
// re-render is needed — just clear the JS-computed inline row heights (compact
// rows size to their content) and re-measure.
export function setAllCardsCompact(on) {
  allCardsCompact = Boolean(on);
  try { localStorage.setItem("recall:allCardsCompact", allCardsCompact ? "1" : "0"); } catch (_) {}
  updateCompactToggleButton();
  if (el.allCardsList) {
    el.allCardsList.classList.toggle("is-compact", allCardsCompact);
    el.allCardsList.querySelectorAll(".cornell-card").forEach((row) => { row.style.minHeight = ""; });
    if (!allCardsCompact) adjustCornellRows(el.allCardsList);
  }
}

// Number of cards matching the active status filter.
export function allCardsFilterMatchCount() {
  if (allCardsFilter === "all") return state.masterCards.length;
  return state.masterCards.filter((card) => {
    const status = normalizeCardStatus(state.statusById[card.id]);
    return allCardsFilter === "none" ? !status : status === allCardsFilter;
  }).length;
}

// Reflect the active filter on the list (drives the CSS hide/show), the filter
// buttons, and the header count. Called on render, on filter change, and after
// a status change (so a card toggled under an active filter drops out live).
export function applyAllCardsFilter() {
  if (el.allCardsList) el.allCardsList.dataset.filter = allCardsFilter;
  if (el.allCardsFilter) {
    el.allCardsFilter.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.filter === allCardsFilter);
    });
  }
  if (el.allCardsSummary) {
    const total = state.masterCards.length;
    const totalLabel = `${total} ${total === 1 ? "card" : "cards"}`;
    if (allCardsFilter === "all") {
      el.allCardsSummary.textContent = totalLabel;
    } else {
      el.allCardsSummary.textContent = `${allCardsFilterMatchCount()} of ${totalLabel}`;
    }
  }
}

export function setAllCardsFilter(filter) {
  allCardsFilter = ALL_CARDS_FILTERS.has(filter) ? filter : "all";
  try { localStorage.setItem("recall:allCardsFilter", allCardsFilter); } catch (_) {}
  applyAllCardsFilter();
}

export async function setAllCardsAnswersVisible(visible) {
  allCardsAnswersVisible = Boolean(visible);
  updateAllAnswersToggleButton();

  const rows = Array.from(el.allCardsList.querySelectorAll(".cornell-card"));
  for (const row of rows) {
    row.classList.toggle("is-flipped", allCardsAnswersVisible);
    // Hiding answers needs no per-row measurement — the batched adjustCornellRows
    // below re-sizes every row anyway, in three layout flushes instead of one
    // per row.
    if (allCardsAnswersVisible) await ensureAllCardAnswer(row);
  }
  await afterPaint();
  adjustCornellRows(el.allCardsList);
}

export async function renderAllCards() {
  const cards = state.masterCards;
  const renderId = allCardsRenderId;
  el.allCardsList.innerHTML = "";
  el.allCardsList.classList.toggle("is-compact", allCardsCompact);
  updateAllAnswersToggleButton();
  updateCompactToggleButton();
  applyAllCardsFilter();

  // Built in chunks. Every card here is a full markdown render plus a forced
  // layout to size its row, and awaiting enhanceRenderedMarkdown yields only a
  // microtask — so the whole loop used to be ONE uninterrupted task and a deck
  // of a few hundred cards froze the tab for seconds with nothing on screen.
  // afterPaint() between chunks hands the frame back, so the first cards are
  // readable while the rest arrive.
  const CHUNK = 20;
  let chunk = [];
  const settleChunk = async () => {
    if (!chunk.length) return;
    // Read every row, then write every row. Interleaving them made each card
    // invalidate the layout the next card was about to measure.
    const heights = chunk.map(measureCornellRowHeight);
    chunk.forEach((row, at) => applyCornellRowHeight(row, heights[at]));
    chunk = [];
    await afterPaint();
  };

  for (const [index, card] of cards.entries()) {
    if (renderId !== allCardsRenderId) return;

    const template = document.createElement("template");
    template.innerHTML = cornellCardHtml(card, index, { answerVisible: allCardsAnswersVisible });
    const item = template.content.firstElementChild;
    item.cardData = card;
    const dragHandle = document.createElement("div");
    dragHandle.className = "all-card-drag-handle";
    dragHandle.setAttribute("aria-hidden", "true");
    dragHandle.textContent = "⠿";
    item.prepend(dragHandle);
    el.allCardsList.appendChild(item);
    await enhanceRenderedMarkdown(item.querySelector(".all-card-question .rendered"));
    if (allCardsAnswersVisible) {
      await enhanceRenderedMarkdown(item.querySelector(".cornell-answer-body"));
    }
    chunk.push(item);
    if (chunk.length >= CHUNK) await settleChunk();
  }
  if (renderId !== allCardsRenderId) return;
  await settleChunk();

  updateAllCardStatuses();
  await afterPaint();
  if (renderId !== allCardsRenderId) return;
  // Final pass: a row measured while the rows after it did not yet exist can be
  // off once everything has settled (a late web font, an image). Batched, so the
  // whole sweep is three layout flushes rather than one per row.
  adjustCornellRows(el.allCardsList);
}

export function openAllCardsPanel() {
  if (!state.masterCards.length) {
    setStatus("Import a deck before opening all cards.", "error");
    return;
  }

  lockPageScroll();
  allCardsRenderId += 1;
  el.allCardsPanel.hidden = false;
  renderAllCards();
}

export let allCardsRenderId = 0;

// Bumping the render generation cancels any in-flight All Cards render, and
// callers outside this module cannot assign to an imported binding. Theme
// changes need it: a rendered card carries the old theme's colours baked in.
export function bumpAllCardsRenderId() {
  allCardsRenderId += 1;
  return allCardsRenderId;
}

export let allCardsAnswersVisible = false;

// Dense one-line-per-card view for the All Cards panel — ideal for decks of
// short entries (e.g. quick_notes single words / phrases). Persisted so the
// preference sticks across sessions.
export let allCardsCompact = localStorage.getItem("recall:allCardsCompact") === "1";

// Status filter for the All Cards panel: "all" | "none" (uncategorized) |
// "review" | "known". Applied as a data-attr on the list so it's a pure CSS
// hide/show that survives status changes without a re-render.
export const ALL_CARDS_FILTERS = new Set(["all", "none", "review", "known"]);

export let allCardsFilter = localStorage.getItem("recall:allCardsFilter") || "all";
// A value persisted by an older release may name a filter that no longer
// exists; fall back rather than render an empty panel.
if (!ALL_CARDS_FILTERS.has(allCardsFilter)) allCardsFilter = "all";
