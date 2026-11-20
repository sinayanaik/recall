// The picker the "To the Canvas" buttons open (src/documents/canvas-feed.js):
// every highlight of the Notes or of the PDFs, or every card, one row each —
// the new ones ticked, the ones already on the Canvas not, and marked so —
// and Add, which puts the ticked ones at the end of the Canvas.
//
// Built once, on first use, from the .confirm-modal chrome the other small
// dialogs use (styles/11-chrome.css); its own rules are styles/a8-canvas-feed.css.

import { cardItems, keysOnCanvas, notesHighlightItems, pdfHighlightItems, placeOnCanvas } from "./canvas-feed.js?v=__BUILD__";
import { activePdfId, deckPdfs } from "./pdf-multi.js?v=__BUILD__";
import { MARK_HIGHLIGHT_HEX } from "../format/highlight-colors.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

let feedDialog = null;
// { source, items, ticked: Set, onCanvas: Set, colourFilter, allPdfs, colours }
let feedModel = null;

const FEED_TITLE = {
  notes: "Notes highlights to the Canvas",
  pdf: "PDF highlights to the Canvas",
  cards: "Cards to the Canvas"
};

const FEED_EMPTY = {
  notes: "No highlights in the Notes yet — highlight something first",
  pdf: "No highlights in this PDF yet — highlight something first",
  cards: "No cards in this file yet"
};

function feedItemsFor(source, { allPdfs = false } = {}) {
  if (source === "notes") return notesHighlightItems();
  if (source === "cards") return cardItems();
  return pdfHighlightItems(allPdfs ? null : activePdfId(state.meta));
}

function buildCanvasFeedDialog() {
  const section = document.createElement("section");
  section.className = "confirm-modal canvas-feed-modal";
  section.id = "canvasFeedModal";
  section.hidden = true;
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-modal", "true");
  section.setAttribute("aria-labelledby", "canvasFeedTitle");
  section.innerHTML = `
    <div class="confirm-modal-content canvas-feed-content">
      <header class="canvas-feed-head">
        <h3 class="prompt-modal-title" id="canvasFeedTitle"></h3>
        <p class="canvas-feed-note">Ticked items become Blocks at the end of the Canvas, sized and placed for you. New pages are added when one fills up.</p>
        <div class="canvas-feed-tools">
          <button type="button" class="canvas-feed-chip" data-cf-pickFeedRows="new">New only</button>
          <button type="button" class="canvas-feed-chip" data-cf-pickFeedRows="all">All</button>
          <button type="button" class="canvas-feed-chip" data-cf-pickFeedRows="none">None</button>
          <span class="canvas-feed-colours" data-cf-colours></span>
        </div>
        <label class="canvas-feed-check" data-cf-all-pdfs-row hidden><input type="checkbox" data-cf-all-pdfs> Every PDF of this file</label>
      </header>
      <ol class="canvas-feed-list" data-cf-list></ol>
      <footer class="sync-modal-actions canvas-feed-actions">
        <label class="canvas-feed-check" data-cf-colours-row><input type="checkbox" data-cf-keep-colours checked> Keep highlight colours</label>
        <span class="canvas-feed-spacer"></span>
        <button type="button" class="sync-modal-btn" data-cf-action="cancel">Cancel</button>
        <button type="button" class="sync-modal-btn is-primary" data-cf-action="add"></button>
      </footer>
    </div>`;
  document.body.appendChild(section);
  section.addEventListener("click", onCanvasFeedClick);
  section.addEventListener("change", onCanvasFeedChange);
  section.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCanvasFeedDialog();
    }
  });
  return section;
}

function feedVisibleItems() {
  if (!feedModel) return [];
  return feedModel.items.filter((item) => !feedModel.colourFilter || item.color === feedModel.colourFilter);
}

function paintCanvasFeedDialog() {
  if (!feedDialog || !feedModel) return;
  feedDialog.querySelector("#canvasFeedTitle").textContent = FEED_TITLE[feedModel.source] || "To the Canvas";
  const severalPdfs = feedModel.source === "pdf" && deckPdfs(state.meta).length > 1;
  const allRow = feedDialog.querySelector("[data-cf-all-pdfs-row]");
  allRow.hidden = !severalPdfs;
  allRow.querySelector("input").checked = feedModel.allPdfs;
  feedDialog.querySelector("[data-cf-colours-row]").hidden = feedModel.source === "cards";
  const colours = [...new Set(feedModel.items.map((item) => item.color).filter(Boolean))];
  feedDialog.querySelector("[data-cf-colours]").innerHTML = colours.length > 1
    ? colours.map((color) => `<button type="button" class="canvas-feed-swatch" data-cf-colour="${escapeHtml(color)}" aria-pressed="${feedModel.colourFilter === color}" title="Only ${escapeHtml(color)}" style="--swatch:${escapeHtml(MARK_HIGHLIGHT_HEX?.[color] || color)}"></button>`).join("")
    : "";
  let lastLabel = null;
  const rows = feedVisibleItems().map((item) => {
    const index = feedModel.items.indexOf(item);
    const on = feedModel.onCanvas.has(item.from);
    const head = item.label && item.label !== lastLabel ? `<li class="canvas-feed-group">${escapeHtml(item.label)}</li>` : "";
    lastLabel = item.label;
    const dot = item.color ? `<span class="canvas-feed-dot" style="--swatch:${escapeHtml(MARK_HIGHLIGHT_HEX?.[item.color] || item.color)}"></span>` : "";
    return `${head}<li class="canvas-feed-row${on ? " is-on-canvas" : ""}"><label>`
      + `<input type="checkbox" data-cf-item="${index}"${feedModel.ticked.has(index) ? " checked" : ""}>`
      + `${dot}<span class="canvas-feed-text">${escapeHtml(item.preview || "")}</span>`
      + `${on ? '<span class="canvas-feed-badge">on the Canvas</span>' : ""}</label></li>`;
  });
  feedDialog.querySelector("[data-cf-list]").innerHTML = rows.join("");
  const count = feedModel.ticked.size;
  const blocks = feedModel.source === "cards" ? count * 2 : count;
  const addButton = feedDialog.querySelector('[data-cf-action="add"]');
  addButton.textContent = count ? `Add ${blocks} Block${blocks === 1 ? "" : "s"}` : "Add";
  addButton.disabled = !count;
}

function pickFeedRows(which) {
  feedModel.ticked = new Set();
  feedVisibleItems().forEach((item) => {
    const index = feedModel.items.indexOf(item);
    if (which === "all" || (which === "new" && !feedModel.onCanvas.has(item.from))) feedModel.ticked.add(index);
  });
  paintCanvasFeedDialog();
}

function onCanvasFeedClick(event) {
  if (event.target === feedDialog) { closeCanvasFeedDialog(); return; }
  const chip = event.target.closest("[data-cf-pickFeedRows]");
  if (chip) { pickFeedRows(chip.dataset.cfPick); return; }
  const swatch = event.target.closest("[data-cf-colour]");
  if (swatch) {
    feedModel.colourFilter = feedModel.colourFilter === swatch.dataset.cfColour ? "" : swatch.dataset.cfColour;
    pickFeedRows("new");
    return;
  }
  const action = event.target.closest("[data-cf-action]")?.dataset.cfAction;
  if (action === "cancel") closeCanvasFeedDialog();
  else if (action === "add") addFeedItems();
}

function onCanvasFeedChange(event) {
  const box = event.target;
  if (box.matches("[data-cf-item]")) {
    const index = Number(box.dataset.cfItem);
    if (box.checked) feedModel.ticked.add(index);
    else feedModel.ticked.delete(index);
    paintCanvasFeedDialog();
  } else if (box.matches("[data-cf-all-pdfs]")) {
    feedModel.allPdfs = box.checked;
    loadFeedItems();
  } else if (box.matches("[data-cf-keep-colours]")) {
    feedModel.colours = box.checked;
  }
}

function loadFeedItems() {
  feedModel.items = feedItemsFor(feedModel.source, { allPdfs: feedModel.allPdfs });
  feedModel.onCanvas = keysOnCanvas();
  feedModel.colourFilter = "";
  feedModel.ticked = new Set(feedModel.items.map((item, index) => (feedModel.onCanvas.has(item.from) ? -1 : index)).filter((index) => index >= 0));
  paintCanvasFeedDialog();
}

async function addFeedItems() {
  const chosen = [...feedModel.ticked].sort((a, b) => a - b).map((index) => feedModel.items[index]).filter(Boolean);
  const colours = feedModel.colours;
  closeCanvasFeedDialog();
  if (chosen.length) await placeOnCanvas(chosen, { colours });
}

function closeCanvasFeedDialog() {
  if (!feedDialog || feedDialog.hidden) return;
  feedDialog.hidden = true;
  unlockPageScroll();
  feedModel = null;
}

export function isCanvasFeedDialogOpen() {
  return Boolean(feedDialog && !feedDialog.hidden);
}

// `source`: "notes", "pdf" or "cards".
export function openCanvasFeedDialog(source) {
  const items = feedItemsFor(source);
  if (!items.length && !(source === "pdf" && deckPdfs(state.meta).length > 1)) {
    showToast(FEED_EMPTY[source] || "Nothing to put on the Canvas", "info");
    return false;
  }
  if (!feedDialog) feedDialog = buildCanvasFeedDialog();
  feedModel = { source, items: [], ticked: new Set(), onCanvas: new Set(), colourFilter: "", allPdfs: false, colours: true };
  feedDialog.querySelector("[data-cf-keep-colours]").checked = true;
  loadFeedItems();
  feedDialog.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => feedDialog.querySelector('[data-cf-action="add"]')?.focus({ preventScroll: true }));
  return true;
}
