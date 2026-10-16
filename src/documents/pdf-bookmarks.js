// Bookmarks in a PDF, and the hands-on half of the reader's own contents.
//
// The arithmetic and the saving are in src/documents/pdf-outline.js (and the
// tree moves in pdf-toc-arrange.js); this is the part a person touches:
//
//   • right-click on a page → "Add bookmark here", titled from the line under
//     the pointer, which becomes a row of the contents drawer;
//   • 🔖 in the drawer's head, and Ctrl/⌘+D, for the place on screen — the way
//     in on a touch screen, where a long-press already means "select text";
//   • right-click (or the keyboard) on a row of the drawer: rename, move,
//     indent, outdent, delete;
//   • ⟲ in the drawer's head, back to the PDF's own contents.
//
// Dragging rows is src/documents/pdf-outline-drag.js.

import { el } from "../core/dom.js?v=__BUILD__";
import { showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { DOC_SLOT_DOC } from "./doc-slot.js?v=__BUILD__";
import {
  addDocumentOutlineBookmark,
  canEditDocumentOutline,
  canStepDocumentOutlineEntry,
  deleteDocumentOutlineEntry,
  documentOutlineEntries,
  isDocumentOutlineUser,
  isDocumentTocOpen,
  openDocumentToc,
  renameDocumentOutlineEntry,
  resetDocumentOutline,
  stepDocumentOutlineEntry
} from "./pdf-outline.js?v=__BUILD__";
import { setOutlineHoldMenu } from "./pdf-outline-drag.js?v=__BUILD__";
import {
  currentDocumentPage,
  currentDocumentRatio,
  isDocumentViewActive,
  openDocumentSlot,
  pdfPageTextItems,
  pdfPageViewport
} from "./pdf-view.js?v=__BUILD__";

// A bookmark made with the pointer is saved a little above the line that was
// pressed, so jumping to it shows that line rather than putting it under the
// top edge of the screen.
const BOOKMARK_LEAD_PX = 40;

// A title read off the page is a line of text, not a paragraph.
const BOOKMARK_TITLE_MAX_CHARS = 80;

// ── The menu ───────────────────────────────────────────────────────────────
//
// One small floating list of actions, at the pointer. Built here rather than
// shared with the block or highlight popovers for the reason
// block-actions-popover.js gives for itself: each is small, and they are never
// open at once.

let contextMenuEl = null;

export function closeDocumentContextMenu() {
  if (!contextMenuEl) return false;
  contextMenuEl.remove();
  contextMenuEl = null;
  document.removeEventListener("pointerdown", onMenuOutside, true);
  document.removeEventListener("keydown", onMenuKey, true);
  window.removeEventListener("resize", closeDocumentContextMenu);
  el.documentView?.removeEventListener("scroll", closeDocumentContextMenu);
  el.documentOutlineList?.parentElement?.removeEventListener("scroll", closeDocumentContextMenu);
  return true;
}

function onMenuOutside(event) {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) closeDocumentContextMenu();
}

function onMenuKey(event) {
  if (!contextMenuEl) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeDocumentContextMenu();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
  if (!buttons.length) return;
  event.preventDefault();
  const at = buttons.indexOf(document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  buttons[(at + step + buttons.length) % buttons.length].focus();
}

// items: [{ label, run, disabled, danger }]
function openContextMenu(x, y, items, label) {
  closeDocumentContextMenu();
  const root = document.createElement("div");
  root.className = "pdf-context-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", label);
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pdf-context-menu-item${item.danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      closeDocumentContextMenu();
      item.run();
    });
    root.appendChild(button);
  });
  document.body.appendChild(root);
  contextMenuEl = root;
  // At the pointer, kept inside the window.
  const box = root.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  document.addEventListener("pointerdown", onMenuOutside, true);
  document.addEventListener("keydown", onMenuKey, true);
  window.addEventListener("resize", closeDocumentContextMenu);
  el.documentView?.addEventListener("scroll", closeDocumentContextMenu, { passive: true });
  el.documentOutlineList?.parentElement?.addEventListener("scroll", closeDocumentContextMenu, { passive: true });
  root.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

// ── Adding a bookmark ──────────────────────────────────────────────────────

// The words on the line at a height on a page (PDF user space), left to right,
// from the text items the page already has — which exist whether or not its
// text layer is awake.
export function lineTitleAt(items, y) {
  if (!Array.isArray(items) || !Number.isFinite(y)) return "";
  const line = items.filter((item) => {
    if (!item?.str?.trim() || !Array.isArray(item.transform)) return false;
    const base = item.transform[5];
    const height = Math.abs(item.height) || Math.abs(item.transform[3]) || 0;
    if (!height) return false;
    return y >= base - height * 0.3 && y <= base + height * 1.1;
  });
  line.sort((a, b) => a.transform[4] - b.transform[4]);
  const text = line.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= BOOKMARK_TITLE_MAX_CHARS) return text;
  return `${text.slice(0, BOOKMARK_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function placeOnPage(pageEl, clientX, clientY) {
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page) return null;
  const box = pageEl.getBoundingClientRect();
  if (!box.height) return null;
  const ratio = Math.max(0, Math.min(1, (clientY - box.top - BOOKMARK_LEAD_PX) / box.height));
  let title = "";
  const viewport = pdfPageViewport(page);
  if (viewport && box.width) {
    const x = (clientX - box.left) * (viewport.width / box.width);
    const y = (clientY - box.top) * (viewport.height / box.height);
    title = lineTitleAt(pdfPageTextItems(page), viewport.convertToPdfPoint(x, y)[1]);
  }
  return { page, ratio, title };
}

function promptForBookmark({ page, ratio, title }) {
  showPromptModal(
    "Add bookmark",
    `Page ${page}. It goes into this PDF's contents, where you can drag it under any heading.`,
    title || `Bookmark — p. ${page}`,
    async (value) => {
      const id = await addDocumentOutlineBookmark({ page, ratio, title: value });
      if (!id) {
        showToast("Could not add the bookmark to this PDF's contents", "error");
        return;
      }
      if (!isDocumentTocOpen()) openDocumentToc();
      showToast("Bookmark added to the contents");
    }
  );
}

// The place on screen: the page at the top of the view, and how far down it.
export function bookmarkCurrentPlace() {
  if (!canBookmark()) return false;
  const page = currentDocumentPage();
  if (!page) return false;
  promptForBookmark({ page, ratio: currentDocumentRatio(), title: "" });
  return true;
}

function canBookmark() {
  return isDocumentViewActive() && openDocumentSlot() === DOC_SLOT_DOC && canEditDocumentOutline();
}

function onPageContextMenu(event) {
  // Shift+right-click is the browser's own menu, always — and so is a
  // right-click on selected words, whose menu is where Copy lives.
  if (event.defaultPrevented || event.shiftKey || !canBookmark()) return;
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed && String(selection).trim()) return;
  if (event.target?.closest?.(".pdf-block, .pdf-badge-layer > *, input, textarea, [contenteditable='true']")) return;
  const pageEl = event.target?.closest?.(".pdf-page[data-page-number]");
  if (!pageEl) return;
  // A touch long-press is the selection controller's (src/notes/
  // touch-selection.js), which refuses this event itself; a pen's press is
  // ink's. Only a mouse gets a menu.
  if (event.pointerType && event.pointerType !== "mouse") return;
  if (event.sourceCapabilities?.firesTouchEvents) return;
  const place = placeOnPage(pageEl, event.clientX, event.clientY);
  if (!place) return;
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY, [
    { label: `Add bookmark here (p. ${place.page})`, run: () => promptForBookmark(place) }
  ], "Page actions");
}

// ── A row of the contents ──────────────────────────────────────────────────

function rowIndexOf(target) {
  const link = target?.closest?.(".notes-toc-link");
  const index = Number(link?.dataset.outlineIndex);
  return Number.isInteger(index) && documentOutlineEntries()[index] ? index : -1;
}

function renameRow(index) {
  const entry = documentOutlineEntries()[index];
  if (!entry) return;
  showPromptModal(entry.bookmark ? "Rename bookmark" : "Rename heading", "", entry.title, (value) => {
    renameDocumentOutlineEntry(index, value);
  });
}

function deleteRow(index) {
  const entry = documentOutlineEntries()[index];
  if (!entry) return;
  const run = () => deleteDocumentOutlineEntry(index);
  // A bookmark is the reader's own and one press made it; a heading came with
  // the PDF and the only way back is a reset, so it asks first.
  if (entry.bookmark) run();
  else showConfirmModal(`Remove "${entry.title}" from the contents? Anything under it moves up a level. Reset contents brings it back.`, run, { confirmLabel: "Remove", danger: true });
}

function stepOutlineRow(index, direction) {
  stepDocumentOutlineEntry(index, direction).then((moved) => {
    if (!moved) return;
    // Keep the keyboard on the row it was moving — the one the move flashed.
    el.documentOutlineList?.querySelector(".is-flash .notes-toc-link")?.focus({ preventScroll: true });
  });
}

function onRowContextMenu(event) {
  if (event.shiftKey || !canEditDocumentOutline()) return;
  const index = rowIndexOf(event.target);
  if (index < 0) return;
  event.preventDefault();
  openRowMenu(index, event.clientX, event.clientY);
}

function openRowMenu(index, x, y) {
  const entry = documentOutlineEntries()[index];
  if (!entry || !canEditDocumentOutline()) return;
  openContextMenu(x, y, [
    { label: "Rename…", run: () => renameRow(index) },
    { label: "Move up", run: () => stepOutlineRow(index, "up"), disabled: !canStepDocumentOutlineEntry(index, "up") },
    { label: "Move down", run: () => stepOutlineRow(index, "down"), disabled: !canStepDocumentOutlineEntry(index, "down") },
    { label: "Indent (nest under the row above)", run: () => stepOutlineRow(index, "indent"), disabled: !canStepDocumentOutlineEntry(index, "indent") },
    { label: "Outdent", run: () => stepOutlineRow(index, "outdent"), disabled: !canStepDocumentOutlineEntry(index, "outdent") },
    { label: entry.bookmark ? "Delete bookmark" : "Remove from contents", run: () => deleteRow(index), danger: true }
  ], "Contents row actions");
}

const ROW_KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "indent", ArrowLeft: "outdent" };

function onRowKey(event) {
  if (!canEditDocumentOutline()) return;
  const index = rowIndexOf(event.target);
  if (index < 0) return;
  if (event.altKey && ROW_KEYS[event.key]) {
    event.preventDefault();
    stepOutlineRow(index, ROW_KEYS[event.key]);
    return;
  }
  if (event.key === "F2") {
    event.preventDefault();
    renameRow(index);
    return;
  }
  if (event.key === "Delete") {
    event.preventDefault();
    deleteRow(index);
  }
}

function onResetPress() {
  if (!isDocumentOutlineUser()) return;
  showConfirmModal(
    "Reset this PDF's contents? Your bookmarks, renamed headings and arrangement are removed, and the contents go back to the PDF's own.",
    () => resetDocumentOutline(),
    { confirmLabel: "Reset", danger: true }
  );
}

function bookmarkKeyInField(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

export function initDocumentBookmarks() {
  // A finger's press-and-hold on a row, let go without dragging it.
  setOutlineHoldMenu(openRowMenu);
  el.documentView?.addEventListener("contextmenu", onPageContextMenu);
  el.documentOutlineList?.addEventListener("contextmenu", onRowContextMenu);
  el.documentOutlineList?.addEventListener("keydown", onRowKey);
  document.getElementById("documentTocBookmarkBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    bookmarkCurrentPlace();
  });
  document.getElementById("documentTocResetBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    onResetPress();
  });
  // Ctrl/⌘+D, which a browser would spend on bookmarking the app's own page.
  // On the window, so it is heard after src/main.js's own keys: with ink
  // lassoed or a block selected the same key duplicates it, and that handler
  // has already taken the press (and prevented it) by the time it gets here.
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key !== "d" && event.key !== "D") return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (bookmarkKeyInField(event.target) || !canBookmark()) return;
    event.preventDefault();
    bookmarkCurrentPlace();
  });
}
