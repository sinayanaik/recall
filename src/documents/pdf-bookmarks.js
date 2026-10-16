// Bookmarks in a PDF, and the hands-on half of the reader's own contents.
//
// The arithmetic and the saving are in src/documents/pdf-outline.js (and the
// tree moves in pdf-toc-arrange.js); this is the part a person touches:
//
//   • 🔖 in the drawer's head, and Ctrl/⌘+D, bookmark the place on screen,
//     titled from the first line of text there; it becomes a row of the
//     contents drawer, filed under its section;
//   • the keyboard on a row of the drawer — F2 renames, Delete removes,
//     Alt+arrows move, indent and outdent — and a finger's press-and-hold on a
//     row opens the same actions as a menu;
//   • ⟲ in the drawer's head, back to the PDF's own contents.
//
// No right-click menu of the app's own, on a page or on a row: right-click is
// the browser's, which is where Copy and the rest live. (There used to be one
// on each, and the drawer and the keys already did everything they offered.)
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
  documentSurfaceHidden,
  isDocumentViewActive,
  openDocumentSlot,
  pdfPageTextItems,
  pdfPageViewport
} from "./pdf-view.js?v=__BUILD__";

// A title read off the page is a line of text, not a paragraph.
const BOOKMARK_TITLE_MAX_CHARS = 80;

// ── The menu ───────────────────────────────────────────────────────────────
//
// One small floating list of actions, at the finger. Built here rather than
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
  const buttons = [...contextMenuEl.querySelectorAll("button:not(:disabled)")];
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

// The first line of text at or below a height on a page (PDF user space, so
// "below" is a smaller y): the line the reader sees first when that height is
// the top of their screen. Its baseline is the highest one not above the
// height, and lineTitleAt reads the words along it. "" when there is no text
// below (a figure, the foot of the page, a scan).
function firstLineTitleBelow(items, y) {
  if (!Array.isArray(items) || !Number.isFinite(y)) return "";
  let baseline = -Infinity;
  for (const item of items) {
    if (!item?.str?.trim() || !Array.isArray(item.transform)) continue;
    const base = item.transform[5];
    if (base <= y && base > baseline) baseline = base;
  }
  return Number.isFinite(baseline) ? lineTitleAt(items, baseline) : "";
}

// The words at the top of the screen, when the page has its text: `ratio` is
// how far down the page the top of the view is.
function titleAtPlace(page, ratio) {
  const viewport = pdfPageViewport(page);
  if (!viewport?.height) return "";
  const y = viewport.convertToPdfPoint(0, Math.max(0, Math.min(1, ratio)) * viewport.height)[1];
  return firstLineTitleBelow(pdfPageTextItems(page), y);
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
  const ratio = currentDocumentRatio();
  let title = "";
  try { title = titleAtPlace(page, ratio); } catch { title = ""; }
  promptForBookmark({ page, ratio, title });
  return true;
}

// Not with the PDF off screen (Home over it): Ctrl+D there would bookmark a
// page the reader cannot see.
function canBookmark() {
  return isDocumentViewActive() && !documentSurfaceHidden() && openDocumentSlot() === DOC_SLOT_DOC && canEditDocumentOutline();
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
