// The folder tree: sorting, drag-and-drop between folders, and the rows,
// tiles and breadcrumb it renders into.
//
// Moving a deck between folders is a category rewrite — there is no folder
// table — so a rename has to rewrite every descendant path too.

import { newDeckInFolder } from "../cards/new-deck.js?v=__BUILD__";
import { deckSyncStatus } from "../cloud/deck-list.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { buildFolderTree } from "./categories.js?v=__BUILD__";
import { buildCloudDeckRow, buildDeckDeleteButton, buildDeckLoadButton, buildLocalDeckRow } from "./deck-rows.js?v=__BUILD__";
import { openFolderAsDeck } from "./folder-deck.js?v=__BUILD__";
import { FOLDER_SEP, addKnownFolder, folderSegments, isCategoryUnder, normalizeDeckCategory, readExpandedFolders, readKnownFolders, rewriteCategoryPrefix, writeExpandedFolders, writeKnownFolders } from "./folders.js?v=__BUILD__";
import { createDeckExportControl, deckCardInfo, deckSelOf, loadDeckEntry } from "./my-decks-actions.js?v=__BUILD__";
import { mdIcon } from "./my-decks-icons.js?v=__BUILD__";
import { importIntoFolder } from "./my-decks-menu.js?v=__BUILD__";
import { setMyDecksCwd } from "./my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList, repaintMyDecks } from "./my-decks-render.js?v=__BUILD__";
import { createDeckSelectControl, createFolderSelectControl, renameMyDeck, setMyDeckCategory } from "./my-decks-selection.js?v=__BUILD__";
import { showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { chooseDeckCategory } from "../ui/pickers.js?v=__BUILD__";

// ── Folder tree: drag-and-drop state & operations ──────────────────────────
// The deck currently being dragged, or a folder being re-parented. Held at
// module scope because dragstart (on the row) and drop (on a folder) are
// separate events on different elements.
export let myDecksDrag = null;

// Snapshot of the decks in the last render, so folder rename/move/delete can
// iterate every affected deck (including cloud-only ones) without re-fetching.
export let myDecksRendered = { local: [], cloudOnly: [] };

// Setter: an imported binding is read-only, and the paint pass in
// library/my-decks-render.js is what fills this in.
export function setMyDecksRendered(value) {
  myDecksRendered = value;
}

export function clearFolderDropHighlights() {
  el.myDecksListTable?.querySelectorAll(".drag-over").forEach((row) => row.classList.remove("drag-over"));
}

export function toggleFolderCollapsed(path) {
  const expanded = readExpandedFolders();
  const key = normalizeDeckCategory(path);
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  writeExpandedFolders(expanded);
  repaintMyDecks();
}

// Expands (or collapses) every folder currently in the tree at once.
export function setAllFoldersExpanded(expand) {
  if (!expand) { writeExpandedFolders(new Set()); repaintMyDecks(); return; }
  const paths = new Set();
  const walk = (node) => node.children.forEach((child) => { paths.add(child.path); walk(child); });
  const entries = [
    ...(myDecksRendered.local || []).map((deck) => ({ deck, kind: "local" })),
    ...(myDecksRendered.cloudOnly || []).map((deck) => ({ deck, kind: "cloud" })),
  ];
  walk(buildFolderTree(entries, readKnownFolders()));
  writeExpandedFolders(paths);
  repaintMyDecks();
}

// True when every folder in the current tree is already expanded (drives the
// Expand-all / Collapse-all toggle label).
export function allFoldersExpanded() {
  const expanded = readExpandedFolders();
  const entries = [
    ...(myDecksRendered.local || []).map((deck) => ({ deck, kind: "local" })),
    ...(myDecksRendered.cloudOnly || []).map((deck) => ({ deck, kind: "cloud" })),
  ];
  let total = 0, open = 0;
  const walk = (node) => node.children.forEach((child) => { total += 1; if (expanded.has(child.path)) open += 1; walk(child); });
  walk(buildFolderTree(entries, readKnownFolders()));
  return total > 0 && open === total;
}

export function folderTotalDeckCount(node) {
  let count = node.decks.length;
  node.children.forEach((child) => { count += folderTotalDeckCount(child); });
  return count;
}

// Most-recent "opened" time for one deck entry, local or cloud, as epoch ms
// (0 if never recorded) — the shared key everything in the My Decks
// navigation sorts by, so recently-used decks and folders surface first.
export function deckAccessTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local"
    ? (deck.accessedAt || deck.updatedAt)
    : (deck.last_accessed_at || deck.updated_at);
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

// A folder's own recency is the most recent access time among any deck it
// (or any of its descendants) contains — so a folder you touched five
// minutes ago outranks one you haven't opened in months, same as a deck would.
export function folderMostRecentAccess(node) {
  let max = 0;
  node.decks.forEach((entry) => { max = Math.max(max, deckAccessTime(entry)); });
  node.children.forEach((child) => { max = Math.max(max, folderMostRecentAccess(child)); });
  return max;
}

// Sort key builders for My Decks — each returns a comparable value for one
// entry ({ deck, kind }). deckAccessTime() above is the "recent" key; these
// cover the rest of MYDECKS_SORT_OPTIONS.
export function deckUpdatedTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local" ? deck.updatedAt : deck.updated_at;
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

// Local decks only started recording createdAt once this sort existed — a
// deck saved before that falls back to updatedAt, the closest thing on hand.
export function deckCreatedTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local" ? (deck.createdAt || deck.updatedAt) : (deck.created_at || deck.updated_at);
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

export function deckSizeValue(entry) {
  return deckCardInfo(entry.deck, entry.kind).count ?? 0;
}

export function deckTitleValue(entry) {
  return (entry.deck.title || "Untitled deck").toLowerCase();
}

export function myDecksSortComparator(sort) {
  switch (sort) {
    case "title-asc": return (a, b) => deckTitleValue(a).localeCompare(deckTitleValue(b));
    case "title-desc": return (a, b) => deckTitleValue(b).localeCompare(deckTitleValue(a));
    case "updated-desc": return (a, b) => deckUpdatedTime(b) - deckUpdatedTime(a);
    case "created-desc": return (a, b) => deckCreatedTime(b) - deckCreatedTime(a);
    case "size-desc": return (a, b) => deckSizeValue(b) - deckSizeValue(a);
    default: return (a, b) => deckAccessTime(b) - deckAccessTime(a);
  }
}

export function sortedFolderChildren(node) {
  const children = Array.from(node.children.values());
  const sort = state.myDecksSort;
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (sort === "title-asc" || sort === "title-desc") {
    children.sort((a, b) => byName(a, b) * (sort === "title-desc" ? -1 : 1));
  } else if (sort === "size-desc") {
    children.sort((a, b) => folderTotalDeckCount(b) - folderTotalDeckCount(a) || byName(a, b));
  } else {
    // recent / updated / created all fall back to the same recency proxy —
    // a folder has no single "updated at" of its own beyond what its decks did.
    children.sort((a, b) => folderMostRecentAccess(b) - folderMostRecentAccess(a) || byName(a, b));
  }
  return children;
}

// Every visible deck (local + cloud-only) whose category is `path` or nested
// under it, as { sel, category } — the unit folder rename/move/delete act on.
export function decksUnderFolder(path) {
  const out = [];
  (myDecksRendered.local || []).forEach((deck) => {
    if (isCategoryUnder(deck.category, path)) {
      out.push({ sel: { localId: deck.id, deckId: deck.deckId || null }, category: normalizeDeckCategory(deck.category), title: deck.title || "" });
    }
  });
  (myDecksRendered.cloudOnly || []).forEach((deck) => {
    if (isCategoryUnder(deck.category, path)) {
      out.push({ sel: { localId: null, deckId: String(deck.id) }, category: normalizeDeckCategory(deck.category), title: deck.title || "" });
    }
  });
  return out;
}

// Re-paths every deck under `fromPath` (and the known-folder + collapsed
// registries) so the `fromPath` prefix becomes `toPath`. Used by folder
// rename, move (re-parent), and delete-into-parent.
export async function rewriteFolderPaths(fromPath, toPath) {
  const affected = decksUnderFolder(fromPath);
  // Per-deck, not all-or-nothing. The cloud category write now reports a
  // zero-row update as a failure instead of silently succeeding, so one deck
  // whose cloud row is gone (or belongs to another account) would otherwise
  // abort the whole rename part-way and leave the folder split across two
  // names. Every deck that CAN move still moves; the rest keep their old path
  // and are named.
  const stuck = [];
  for (const item of affected) {
    try {
      await setMyDeckCategory(item.sel, rewriteCategoryPrefix(item.category, fromPath, toPath));
    } catch (error) {
      console.warn(`Could not re-path deck "${item.title}"`, error);
      stuck.push(item.title || "Untitled");
    }
  }
  if (stuck.length) {
    showToast(
      `${stuck.length} deck${stuck.length === 1 ? "" : "s"} couldn't be moved: ${stuck.slice(0, 2).join(", ")}` +
      `${stuck.length > 2 ? ` and ${stuck.length - 2} more` : ""}`,
      "error"
    );
  }
  writeKnownFolders(readKnownFolders().map((p) => rewriteCategoryPrefix(p, fromPath, toPath)));
  const nextExpanded = new Set();
  readExpandedFolders().forEach((p) => nextExpanded.add(rewriteCategoryPrefix(p, fromPath, toPath)));
  writeExpandedFolders(nextExpanded);
  // Keep the Folder-view cwd pointing at the renamed/moved folder if we were in it.
  if (state.myDecksCwd && isCategoryUnder(state.myDecksCwd, fromPath)) {
    setMyDecksCwd(rewriteCategoryPrefix(state.myDecksCwd, fromPath, toPath));
  }
  return affected.length;
}

export function createFolder(parentPath = "") {
  showPromptModal("New folder", parentPath ? `Inside "${parentPath}"` : "", "", (rawName) => {
    // Empty field, "New folder" placeholder — falls back to that indicative name
    // if left blank, so there's nothing to clear before typing.
    const name = String(rawName || "").trim() || "New folder";
    const path = normalizeDeckCategory(parentPath ? `${parentPath}${FOLDER_SEP}${name}` : name);
    if (path === defaultDeckCategory) { showToast("Folder name can't be empty", "error"); return; }
    addKnownFolder(path);
    if (parentPath) { const ex = readExpandedFolders(); ex.add(normalizeDeckCategory(parentPath)); writeExpandedFolders(ex); }
    showToast(`Folder "${path}" created`);
    renderMyDecksList();
  }, { placeholder: "New folder" });
}

export function renameFolder(path) {
  const segments = folderSegments(path);
  const parent = segments.slice(0, -1).join(FOLDER_SEP);
  showPromptModal("Rename folder", "", segments[segments.length - 1] || "", async (name) => {
    const nextPath = normalizeDeckCategory(parent ? `${parent}${FOLDER_SEP}${name}` : name);
    if (nextPath === defaultDeckCategory) { showToast("Folder name can't be empty", "error"); return; }
    if (nextPath === normalizeDeckCategory(path)) return;
    try {
      await rewriteFolderPaths(path, nextPath);
      showToast(`Renamed to "${nextPath}"`);
      renderMyDecksList();
    } catch (error) {
      console.error("Folder rename failed", error);
      showToast("Couldn't rename — offline?", "error");
    }
  });
}

// Re-parents `fromPath` under `newParentPath` (root when ""), keeping its own
// last segment. Refuses to drop a folder into itself or its own descendant.
export async function moveFolder(fromPath, newParentPath) {
  const from = normalizeDeckCategory(fromPath);
  const leaf = folderSegments(from).slice(-1)[0] || "";
  const nextPath = normalizeDeckCategory(newParentPath ? `${newParentPath}${FOLDER_SEP}${leaf}` : leaf);
  if (nextPath === from) return 0;
  if (isCategoryUnder(nextPath, from)) return 0; // would nest a folder inside itself
  return rewriteFolderPaths(from, nextPath);
}

export function deleteFolder(path) {
  const segments = folderSegments(path);
  const leaf = segments[segments.length - 1] || path;
  const parent = segments.slice(0, -1).join(FOLDER_SEP);
  const total = decksUnderFolder(path).length;
  const message = total > 0
    ? `Delete folder "${leaf}"? Its ${total === 1 ? "1 deck moves" : total + " decks move"} to ${parent || "Uncategorized"}. No decks are deleted.`
    : `Delete empty folder "${leaf}"?`;
  showConfirmModal(message, async () => {
    try {
      await rewriteFolderPaths(path, parent);
      showToast(`Folder "${leaf}" deleted`);
      renderMyDecksList();
    } catch (error) {
      console.error("Folder delete failed", error);
      showToast("Couldn't delete — offline?", "error");
    }
  }, { confirmLabel: "Delete", danger: true });
}

// Resolves a completed drop onto `folderPath` ("" = root/Uncategorized).
export async function handleDropOnFolder(folderPath) {
  const drag = myDecksDrag;
  myDecksDrag = null;
  clearFolderDropHighlights();
  if (!drag) return;
  try {
    if (drag.type === "deck") {
      if (normalizeDeckCategory(drag.category) === normalizeDeckCategory(folderPath)) return;
      await setMyDeckCategory(drag.sel, folderPath);
      showToast(`Moved to "${normalizeDeckCategory(folderPath)}"`);
      renderMyDecksList();
    } else if (drag.type === "folder") {
      if (folderPath === drag.path || isCategoryUnder(folderPath, drag.path)) return;
      await moveFolder(drag.path, folderPath);
      showToast("Folder moved");
      renderMyDecksList();
    }
  } catch (error) {
    console.error("Drop failed", error);
    showToast("Couldn't move — offline?", "error");
  }
}

// Wires an element as a drop target for `folderPath`; rejects illegal folder
// drops (onto self/descendant) so the cursor shows "no-drop".
export function attachFolderDropTarget(row, folderPath) {
  row.addEventListener("dragover", (e) => {
    if (!myDecksDrag) return;
    if (myDecksDrag.type === "folder" && (folderPath === myDecksDrag.path || isCategoryUnder(folderPath, myDecksDrag.path))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => { e.preventDefault(); handleDropOnFolder(folderPath); });
}

// One collapsible folder header row (spans all columns).
export function buildFolderRow(node, depth, isCollapsed) {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row";
  tr.dataset.folderPath = node.path;
  tr.style.setProperty("--folder-depth", String(depth));
  tr.draggable = true;

  const td = document.createElement("td");
  td.colSpan = 7;
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-wrap";
  wrap.appendChild(createFolderSelectControl(node.path, node.name));

  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "deck-folder-twisty";
  twisty.setAttribute("aria-label", isCollapsed ? "Expand folder" : "Collapse folder");
  // One chevron for both states — CSS rotates it 90° when open, so the change
  // reads as a movement rather than as two unrelated glyphs swapping places.
  twisty.setAttribute("aria-expanded", String(!isCollapsed));
  twisty.innerHTML = mdIcon("chevron");
  twisty.addEventListener("click", () => toggleFolderCollapsed(node.path));

  const label = document.createElement("button");
  label.type = "button";
  label.className = "deck-folder-label";
  label.innerHTML = `<span class="deck-folder-icon">${mdIcon("folder")}</span><span class="deck-folder-name"></span>`;
  label.querySelector(".deck-folder-name").textContent = node.name;
  label.addEventListener("click", () => toggleFolderCollapsed(node.path));

  const total = folderTotalDeckCount(node);
  const count = document.createElement("span");
  count.className = "deck-folder-count";
  // data-count is the bare number; the phone layout swaps to it, because
  // "12 decks" costs a third of the room the folder's own name needs.
  count.dataset.count = String(total);
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;

  // Shared with the Folder-view nav rows, so a folder offers the same four
  // actions wherever it appears. (Tree rows used to build their own three-button
  // cluster and were missing "New deck in this folder" entirely.)
  const actions = buildFolderActionCluster(node.path);

  wrap.append(twisty, label, count, actions);
  td.append(wrap);
  tr.append(td);

  attachFolderDropTarget(tr, node.path);
  tr.addEventListener("dragstart", (e) => {
    if (e.target.closest(".deck-folder-action, .deck-folder-twisty, input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tr.addEventListener("dragend", () => { tr.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tr;
}

// The always-present root drop target — drag a deck or folder here to lift it
// out of any folder (back to Uncategorized / top level).
export function buildRootDropRow() {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row deck-root-row";
  const td = document.createElement("td");
  td.colSpan = 7;
  td.innerHTML = `<div class="deck-folder-wrap"><span class="deck-folder-icon">${mdIcon("home")}</span><span class="deck-folder-name">All decks</span><span class="deck-root-hint">drop here to remove from a folder</span></div>`;
  tr.append(td);
  attachFolderDropTarget(tr, "");
  return tr;
}

// Makes any deck element (table row or grid tile) a drag source for filing into a
// folder. Dragging is suppressed when it starts on an interactive control so the
// checkbox, buttons, and inline category editor stay usable.
export function makeDeckDraggable(el, sel, deck) {
  el.dataset.folder = normalizeDeckCategory(deck.category);
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    if (e.target.closest("input, select, textarea, button, a, .web-deck-category-editor")) { e.preventDefault(); return; }
    myDecksDrag = { type: "deck", sel, category: normalizeDeckCategory(deck.category), title: deck.title || "" };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", deck.title || "deck"); } catch (_) {}
  });
  el.addEventListener("dragend", () => { el.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
}

// Table-row variant: adds the tree indent (the row class comes from the row
// builders), then shared drag behaviour.
export function decorateDeckRow(tr, sel, deck, indentLevel) {
  tr.style.setProperty("--folder-depth", String(indentLevel));
  makeDeckDraggable(tr, sel, deck);
}

export function renderFolderDecks(tbody, node, depth, ctx) {
  node.decks.forEach((entry) => {
    const tr = entry.kind === "local"
      ? buildLocalDeckRow(entry.deck, ctx.cloudById, ctx.categories)
      : buildCloudDeckRow(entry.deck, ctx.categories);
    const sel = entry.kind === "local"
      ? { localId: entry.deck.id, deckId: entry.deck.deckId || null }
      : { localId: null, deckId: String(entry.deck.id) };
    decorateDeckRow(tr, sel, entry.deck, depth);
    tbody.appendChild(tr);
  });
}

export function renderFolderChildren(tbody, node, depth, ctx) {
  sortedFolderChildren(node).forEach((child) => {
    const isCollapsed = !ctx.expanded.has(child.path);
    tbody.appendChild(buildFolderRow(child, depth, isCollapsed));
    if (!isCollapsed) {
      renderFolderChildren(tbody, child, depth + 1, ctx);
      renderFolderDecks(tbody, child, depth + 1, ctx);
    }
  });
}

// The unified library view rendered as a nested folder tree: folders (from deck
// category paths plus any empty "known" folders) with their decks nested
// beneath, and Uncategorized decks loose at the root. `cloudById` (a Map, or
// null before/without a cloud fetch) drives the per-deck Sync column.
// ── Folder-view navigation helpers ─────────────────────────────────────────
export function setMyDecksCwdAndRender(path) {
  setMyDecksCwd(path);
  repaintMyDecks();
}

// Walks the built tree to the node for `path` (root when ""), or null if the path
// no longer exists (e.g. the folder was just deleted out from under the cwd).
export function findTreeNode(tree, path) {
  if (!path) return tree;
  let node = tree;
  for (const seg of folderSegments(path)) {
    node = node.children.get(seg);
    if (!node) return null;
  }
  return node;
}

export function renderMyDecksBreadcrumb() {
  const nav = el.myDecksBreadcrumb;
  if (!nav) return;
  nav.innerHTML = "";
  const cwd = state.myDecksCwd;
  const mk = (label, path, isCurrent, icon) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "breadcrumb-crumb";
    if (icon) b.innerHTML = mdIcon(icon);
    b.append(label);
    if (isCurrent) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => setMyDecksCwdAndRender(path));
    attachFolderDropTarget(b, path); // drop a deck/folder on a crumb to move it here
    return b;
  };
  nav.appendChild(mk("All decks", "", cwd === "", "home"));
  let acc = "";
  const segs = folderSegments(cwd);
  segs.forEach((seg, i) => {
    acc = acc ? acc + FOLDER_SEP + seg : seg;
    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "›";
    nav.appendChild(sep);
    nav.appendChild(mk(seg, acc, i === segs.length - 1));
  });
}

// ── Folder + deck cluster builders (shared by tiles and folder-nav rows) ────
export function buildFolderActionCluster(path) {
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-actions";
  // Icon + label, so the phone layout can drop to icons alone and keep all five
  // actions on the folder's own line instead of wrapping them onto a second.
  const mk = (icon, text, title, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "deck-folder-action";
    b.innerHTML = mdIcon(icon);
    const label = document.createElement("span");
    label.className = "md-btn-label";
    label.textContent = text;
    b.append(label);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
    return b;
  };
  wrap.append(
    // First, because it is the only one of these that is about READING rather
    // than about managing the folder.
    mk("book", "Read", "Read every deck in this folder as one document — edits are saved back to each deck", () => openFolderAsDeck(path)),
    mk("newDeck", "Deck", "New deck in this folder", () => newDeckInFolder(path)),
    mk("newFolder", "Folder", "New subfolder", () => createFolder(path)),
    mk("importDeck", "Import", "Import a file into this folder — as notes, as cards, or both", () => importIntoFolder(path)),
    mk("pencil", "Rename", "Rename folder", () => renameFolder(path)),
    mk("trash", "Delete", "Delete folder", () => deleteFolder(path)),
  );
  return wrap;
}

// A folder as a grid tile (Folder view, Tiles display). Double-click / Enter drills
// in; it is a drop target and is itself draggable for re-parenting. No inline action
// buttons — folder management lives in the toolbar and Tree view.
export function buildFolderTile(node) {
  const tile = document.createElement("div");
  tile.className = "folder-tile";
  tile.tabIndex = 0;
  tile.dataset.folderPath = node.path;
  tile.title = "Open folder";
  const total = folderTotalDeckCount(node);

  // Same absolutely-positioned wrapper the deck tiles use (.deck-tile-select),
  // for identical placement AND because it's what keeps the global
  // `input { width: 100% }` text-field rule from stretching the checkbox into a
  // full-width slab — a bare checkbox in the flex row below does exactly that.
  const selWrap = document.createElement("label");
  selWrap.className = "deck-tile-select";
  selWrap.title = "Select folder";
  selWrap.appendChild(createFolderSelectControl(node.path, node.name));
  // The whole tile is a click-to-open target; ticking its checkbox must not
  // also drill into the folder. Needed on the label as well as the checkbox —
  // a click landing on the label's padding never touches the input itself.
  selWrap.addEventListener("click", (e) => e.stopPropagation());

  const main = document.createElement("div");
  main.className = "folder-tile-main";
  main.innerHTML = `<span class="folder-tile-icon">${mdIcon("folder")}</span><span class="folder-tile-name"></span>`;
  main.querySelector(".folder-tile-name").textContent = node.name;
  const count = document.createElement("span");
  count.className = "folder-tile-count";
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;
  // A sibling row below the name (not crammed into the same flex row as the
  // icon) — otherwise a long name has almost no width left to wrap into.
  tile.append(selWrap, main, count);

  const enter = () => setMyDecksCwdAndRender(node.path);
  tile.addEventListener("click", enter);
  tile.addEventListener("dblclick", enter);
  tile.addEventListener("keydown", (e) => { if (e.target !== tile) return; if (e.key === "Enter") { e.preventDefault(); enter(); } });
  attachFolderDropTarget(tile, node.path);
  tile.draggable = true;
  tile.addEventListener("dragstart", (e) => {
    if (e.target.closest("input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tile.addEventListener("dragend", () => { tile.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tile;
}

// A folder as a table row for Folder view (List display) — single level, click to
// enter (unlike the Tree view's expand-in-place row).
export function buildFolderNavRow(node) {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row deck-folder-nav";
  tr.dataset.folderPath = node.path;
  const td = document.createElement("td");
  td.colSpan = 7;
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-wrap";
  wrap.appendChild(createFolderSelectControl(node.path, node.name));
  const label = document.createElement("button");
  label.type = "button";
  label.className = "deck-folder-label";
  label.innerHTML = `<span class="deck-folder-icon">${mdIcon("folder")}</span><span class="deck-folder-name"></span>`;
  label.querySelector(".deck-folder-name").textContent = node.name;
  label.addEventListener("click", () => setMyDecksCwdAndRender(node.path));
  const total = folderTotalDeckCount(node);
  const count = document.createElement("span");
  count.className = "deck-folder-count";
  // data-count is the bare number; the phone layout swaps to it, because
  // "12 decks" costs a third of the room the folder's own name needs.
  count.dataset.count = String(total);
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;
  wrap.append(label, count, buildFolderActionCluster(node.path));
  td.append(wrap);
  tr.append(td);
  attachFolderDropTarget(tr, node.path);
  tr.draggable = true;
  tr.addEventListener("dragstart", (e) => {
    if (e.target.closest("button, input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tr.addEventListener("dragend", () => { tr.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tr;
}

// The per-deck "⋯" menu (Rename / Move to folder / Delete), shared by grid tiles
// and — below 720px, where the row has no space for four inline icons — list
// rows. One implementation so both surfaces offer exactly the same actions.
export function buildDeckOverflowMenu(deck, kind, sel) {
  const overflow = document.createElement("div");
  overflow.className = "deck-tile-overflow";

  const ovBtn = document.createElement("button");
  ovBtn.type = "button";
  ovBtn.className = "deck-tile-overflow-btn";
  ovBtn.setAttribute("aria-haspopup", "true");
  ovBtn.setAttribute("aria-expanded", "false");
  ovBtn.title = "More actions";
  ovBtn.setAttribute("aria-label", `More actions for ${deck.title || "deck"}`);
  ovBtn.innerHTML = mdIcon("more");

  const menu = document.createElement("div");
  menu.className = "deck-tile-overflow-menu";
  menu.hidden = true;
  const mkItem = (text, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => { menu.hidden = true; ovBtn.setAttribute("aria-expanded", "false"); handler(); });
    return b;
  };
  menu.append(
    mkItem("Rename", () => renameMyDeck(sel, deck.title || "")),
    mkItem("Move to folder…", () => moveDeckViaMenu(deck, kind)),
    mkItem("Delete", () => buildDeckDeleteButton(deck, kind).click()),
  );

  ovBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    closeAllDeckTileMenus(menu);
    menu.hidden = !willOpen;
    ovBtn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      // The grid/table this button lives in scrolls, and the menu can otherwise
      // be clipped by that scroll container near the bottom of the list —
      // promote it to a viewport-fixed position computed from the button.
      const r = ovBtn.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.right = "auto"; // the default CSS anchors with `right: 0`, which
      // would otherwise stretch the box once `left` is also set explicitly below.
      menu.style.left = "0px";
      menu.style.top = "0px";
      const menuW = menu.offsetWidth;
      const menuH = menu.offsetHeight;
      menu.style.left = `${Math.max(4, Math.min(r.right - menuW, window.innerWidth - menuW - 4))}px`;
      menu.style.top = (r.bottom + menuH + 4 > window.innerHeight)
        ? `${r.top - menuH - 4}px`
        : `${r.bottom + 4}px`;
    }
  });

  overflow.append(ovBtn, menu);
  return overflow;
}

// Closes any open deck overflow menus (one-at-a-time behaviour). Scoped to the
// whole panel body, not just the tile grid — list rows carry the same menu now.
export function closeAllDeckTileMenus(except) {
  (el.myDecksBody || document).querySelectorAll(".deck-tile-overflow-menu:not([hidden])").forEach((menu) => {
    if (menu !== except) {
      menu.hidden = true;
      menu.style.position = "";
      menu.style.right = "";
      menu.style.left = "";
      menu.style.top = "";
      menu.previousElementSibling?.setAttribute("aria-expanded", "false");
    }
  });
}

// A deck as a grid tile. Reuses the shared select control, sync status, category,
// and Load/Export/Rename/Delete operations so tiles behave exactly like rows.
export function buildDeckTile(entry, ctx) {
  const { deck, kind } = entry;
  const sel = deckSelOf(deck, kind);
  const { count, hasNotes } = deckCardInfo(deck, kind);
  const status = deckSyncStatus(deck, ctx.cloudById, kind === "cloud");

  const tile = document.createElement("div");
  tile.className = "deck-tile";
  tile.tabIndex = 0;
  if (kind === "local" && deck.id === state.localDeckId) tile.classList.add("is-current-local-deck");
  if (kind === "cloud") tile.classList.add("is-cloud-only-deck");

  const selWrap = document.createElement("label");
  selWrap.className = "deck-tile-select";
  selWrap.title = "Select";
  selWrap.appendChild(createDeckSelectControl({ ...sel, title: deck.title }));

  const title = document.createElement("div");
  title.className = "deck-tile-title";
  title.textContent = deck.title || "Untitled deck";
  title.title = deck.title || "";

  const chip = document.createElement("span");
  chip.className = "deck-tile-chip";
  chip.textContent = normalizeDeckCategory(deck.category);
  chip.title = normalizeDeckCategory(deck.category);

  const meta = document.createElement("div");
  meta.className = "deck-tile-meta";
  const countEl = document.createElement("span");
  countEl.className = "deck-tile-count";
  countEl.textContent = `${count ?? "—"} ${count === 1 ? "card" : "cards"}${hasNotes ? " · 📝" : ""}`;
  if (hasNotes) countEl.title = "This deck has study notes";
  const badge = document.createElement("span");
  badge.className = `deck-tile-sync ${status.cls}`;
  badge.textContent = status.label;
  badge.title = status.title;
  meta.append(countEl, badge);

  const actions = document.createElement("div");
  actions.className = "deck-tile-actions";
  actions.append(buildDeckLoadButton(deck, kind), createDeckExportControl(sel, deck.title));

  actions.append(buildDeckOverflowMenu(deck, kind, sel));

  tile.append(selWrap, title, chip, meta, actions);

  // Enter / double-click loads the deck (checkbox handles selection).
  tile.addEventListener("dblclick", (e) => { if (e.target.closest("button, input, label, .deck-tile-overflow")) return; loadDeckEntry(deck, kind); });
  tile.addEventListener("keydown", (e) => { if (e.target !== tile) return; if (e.key === "Enter") { e.preventDefault(); loadDeckEntry(deck, kind); } });
  makeDeckDraggable(tile, sel, deck);
  return tile;
}

export async function moveDeckViaMenu(deck, kind) {
  const sel = deckSelOf(deck, kind);
  const category = await chooseDeckCategory(normalizeDeckCategory(deck.category));
  if (category === null) return;
  try {
    await setMyDeckCategory(sel, category);
    showToast(`Moved to "${normalizeDeckCategory(category)}"`);
    renderMyDecksList();
  } catch (error) {
    console.error("Move via menu failed", error);
    showToast("Couldn't move — offline?", "error");
  }
}
