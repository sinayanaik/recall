// Painting the My Decks library in whichever view is selected, and the render
// sequencing that keeps a slow cloud fetch from overwriting a newer paint.

import { fetchCloudDeckList, populateMyDecksCategoryFilter } from "../cloud/deck-list.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { buildFolderTree, categoriesFromDecks, setKnownWebDeckCategories, webDeckCategories } from "./categories.js?v=__BUILD__";
import { buildCloudDeckRow, buildLocalDeckRow } from "./deck-rows.js?v=__BUILD__";
import { allFoldersExpanded, buildDeckTile, buildFolderNavRow, buildFolderTile, buildRootDropRow, findTreeNode, makeDeckDraggable, myDecksSortComparator, renderFolderChildren, renderFolderDecks, renderMyDecksBreadcrumb, setMyDecksRendered, sortedFolderChildren } from "./folder-tree.js?v=__BUILD__";
import { isCategoryUnder, readExpandedFolders, readKnownFolders } from "./folders.js?v=__BUILD__";
import { listLocalDecks } from "./local-library.js?v=__BUILD__";
import { deckSelOf } from "./my-decks-actions.js?v=__BUILD__";
import { hydrateMyDecksIcons } from "./my-decks-icons.js?v=__BUILD__";
import { setMyDecksCwd } from "./my-decks-prefs.js?v=__BUILD__";
import { myDeckMatchesSearch, myDecksSearchTerm, updateMyDecksBulkBar } from "./my-decks-selection.js?v=__BUILD__";
import { isDeckTombstoned } from "./tombstones.js?v=__BUILD__";

// ── Empty states ────────────────────────────────────────────────────────────
export function myDecksEmptyMessage(ctx) {
  if (ctx.search) return `No decks match “${ctx.search}”.`;
  if (ctx.totalDecks === 0) return ctx.loading ? "Checking the cloud for your decks…" : "No decks yet. Use ＋ New deck to create your first one.";
  return "Nothing filed here yet. Use ＋ New deck, or drag a deck onto a folder.";
}

export function buildEmptyCard(message) {
  const div = document.createElement("div");
  div.className = "my-decks-empty-card";
  div.textContent = message;
  return div;
}

export function appendEmptyRow(tbody, message) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td colspan="7" class="web-decks-empty"></td>`;
  tr.querySelector("td").textContent = message;
  tbody.appendChild(tr);
}

// ── The three views ─────────────────────────────────────────────────────────
export function renderDeckRowInto(tbody, entry, ctx, { draggable = false } = {}) {
  const tr = entry.kind === "local"
    ? buildLocalDeckRow(entry.deck, ctx.cloudById, ctx.categories)
    : buildCloudDeckRow(entry.deck, ctx.categories);
  if (draggable) makeDeckDraggable(tr, deckSelOf(entry.deck, entry.kind), entry.deck);
  tbody.appendChild(tr);
}

// Tree — the full nested, collapsible hierarchy (always a list).
export function renderMyDecksTreeView(entries, ctx) {
  const tbody = el.myDecksListTable;
  tbody.innerHTML = "";
  const knownFolders = ctx.search ? [] : readKnownFolders().filter((path) => !ctx.scope || isCategoryUnder(path, ctx.scope));
  const tree = buildFolderTree(entries, knownFolders);
  const rctx = { cloudById: ctx.cloudById, categories: ctx.categories, expanded: readExpandedFolders() };
  tbody.appendChild(buildRootDropRow());
  renderFolderChildren(tbody, tree, 0, rctx);
  renderFolderDecks(tbody, tree, 0, rctx); // loose (Uncategorized) decks at the root
  if (!tbody.querySelector(".my-deck-row, .deck-folder-row:not(.deck-root-row)")) {
    appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// Grid — every deck flat, no hierarchy.
export function renderMyDecksGridView(entries, ctx) {
  if (state.myDecksDisplay === "tiles") {
    const grid = el.myDecksGrid;
    grid.innerHTML = "";
    entries.forEach((entry) => grid.appendChild(buildDeckTile(entry, ctx)));
    if (!entries.length) grid.appendChild(buildEmptyCard(myDecksEmptyMessage(ctx)));
  } else {
    const tbody = el.myDecksListTable;
    tbody.innerHTML = "";
    entries.forEach((entry) => renderDeckRowInto(tbody, entry, ctx));
    if (!entries.length) appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// Folder — Finder-style, one level of the tree at `state.myDecksCwd`.
export function renderMyDecksFolderView(entries, ctx) {
  const knownFolders = ctx.search ? [] : readKnownFolders();
  const tree = buildFolderTree(entries, knownFolders);
  let node = findTreeNode(tree, state.myDecksCwd);
  if (!node) { setMyDecksCwd(""); node = tree; renderMyDecksBreadcrumb(); }
  const childFolders = sortedFolderChildren(node);
  const decks = node.decks;

  if (state.myDecksDisplay === "tiles") {
    const grid = el.myDecksGrid;
    grid.innerHTML = "";
    childFolders.forEach((child) => grid.appendChild(buildFolderTile(child)));
    decks.forEach((entry) => grid.appendChild(buildDeckTile(entry, ctx)));
    if (!childFolders.length && !decks.length) grid.appendChild(buildEmptyCard(myDecksEmptyMessage(ctx)));
  } else {
    const tbody = el.myDecksListTable;
    tbody.innerHTML = "";
    // No root drop row here — the breadcrumb's "🏠 All" crumb is the drop-to-root
    // target, so a second "All decks" row would just be a confusing duplicate.
    childFolders.forEach((child) => tbody.appendChild(buildFolderNavRow(child)));
    decks.forEach((entry) => renderDeckRowInto(tbody, entry, ctx, { draggable: true }));
    if (!childFolders.length && !decks.length) appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// ── Chrome (view switch / display toggle / breadcrumb / host) ───────────────
export function setMyDecksHost(useTiles) {
  if (el.myDecksTableWrap) el.myDecksTableWrap.hidden = useTiles;
  if (el.myDecksGrid) el.myDecksGrid.hidden = !useTiles;
  // Clear the inactive host so stale nodes — and crucially their selection
  // checkboxes, which the bulk bar counts across the whole body — don't linger.
  // Runs before the active renderer repopulates its own host.
  if (useTiles) { if (el.myDecksListTable) el.myDecksListTable.innerHTML = ""; }
  else if (el.myDecksGrid) el.myDecksGrid.innerHTML = "";
}

export function syncMyDecksChrome() {
  const view = state.myDecksView;
  const display = view === "tree" ? "list" : state.myDecksDisplay;
  el.myDecksViewSwitch?.querySelectorAll("[data-mydecks-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mydecksView === view)));
  el.myDecksDisplayToggle?.querySelectorAll("[data-mydecks-display]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mydecksDisplay === display)));
  if (el.myDecksSort && el.myDecksSort.value !== state.myDecksSort) el.myDecksSort.value = state.myDecksSort;
  if (el.myDecksDisplayToggle) el.myDecksDisplayToggle.hidden = (view === "tree");
  if (el.myDecksTreeToggleAll) {
    el.myDecksTreeToggleAll.hidden = (view !== "tree");
    if (view === "tree") {
      const allOpen = allFoldersExpanded();
      // Rewrite the label span and swap the icon in place — assigning
      // textContent on the button itself would take its <svg> with it.
      const labelEl = el.myDecksTreeToggleAll.querySelector("span");
      if (labelEl) labelEl.textContent = allOpen ? "Collapse all" : "Expand all";
      el.myDecksTreeToggleAll.dataset.mdIcon = allOpen ? "collapse" : "expand";
      el.myDecksTreeToggleAll.querySelector("svg.md-ico")?.remove();
      hydrateMyDecksIcons(el.myDecksTreeToggleAll.parentElement || document);
      el.myDecksTreeToggleAll.dataset.expandAll = allOpen ? "0" : "1";
    }
  }
  if (el.myDecksBreadcrumb) {
    el.myDecksBreadcrumb.hidden = (view !== "folder");
    if (view === "folder") renderMyDecksBreadcrumb();
  }
  // Folder view's breadcrumb IS the "which folder am I in" control — the
  // scope dropdown is a second, unsynced way to answer the same question
  // (and can silently narrow the view further than the breadcrumb shows).
  // Only Grid/Tree need it, since they have no drill-down of their own.
  if (el.myDecksFilterWrap) el.myDecksFilterWrap.hidden = (view === "folder");
  setMyDecksHost(display === "tiles");
}

// Last painted data set, so pure presentation changes (switching view/display,
// searching, drilling into a folder, expand/collapse) can repaint instantly from
// memory instead of re-hitting the cloud.
export let myDecksCache = null;

// Repaints the current view from the cached data set — no network. Falls back to a
// full (re)load if nothing has been painted yet.
export function repaintMyDecks() {
  if (!myDecksCache) { renderMyDecksList(); return; }
  const c = myDecksCache;
  paintMyDecks(c.localDecks, c.cloudById, { cloudOnly: c.cloudOnly, categories: c.categories, scope: c.scope, loading: false });
}

// Renders whichever view is active from an already-scoped deck set, applying the
// title search first. `loading` marks a first paint still awaiting the cloud.
export function paintMyDecks(localDecks, cloudById, { cloudOnly = [], categories = webDeckCategories, scope = "", loading = false } = {}) {
  myDecksCache = { localDecks, cloudById, cloudOnly, categories, scope };
  setMyDecksRendered({ local: localDecks, cloudOnly });
  const search = myDecksSearchTerm();
  // Sorted per state.myDecksSort (default: most-recently-accessed first),
  // local and cloud-only decks interleaved on the same timeline.
  const entries = [
    ...localDecks.filter(myDeckMatchesSearch).map((deck) => ({ deck, kind: "local" })),
    ...cloudOnly.filter(myDeckMatchesSearch).map((deck) => ({ deck, kind: "cloud" })),
  ].sort(myDecksSortComparator(state.myDecksSort));
  const ctx = { cloudById, categories, scope, search, loading, totalDecks: localDecks.length + cloudOnly.length };
  // The header count replaces the descriptive paragraph that used to sit there:
  // same vertical space, but it says something that changes.
  if (el.myDecksCount) {
    el.myDecksCount.textContent = ctx.totalDecks === 1 ? "1 deck" : `${ctx.totalDecks} decks`;
    el.myDecksCount.hidden = false;
  }
  syncMyDecksChrome();
  if (state.myDecksView === "grid") renderMyDecksGridView(entries, ctx);
  else if (state.myDecksView === "folder") renderMyDecksFolderView(entries, ctx);
  else renderMyDecksTreeView(entries, ctx);
  updateMyDecksBulkBar();
}

// Guards against a stale cloud fetch overwriting a newer render.
export let myDecksRenderSeq = 0;

export async function renderMyDecksList() {
  if (!el.myDecksBody) return;
  const seq = ++myDecksRenderSeq;

  const localDecks = listLocalDecks();
  const localCloudIds = new Set(localDecks.map((d) => String(d.deckId)).filter((id) => id && id !== "null"));
  const canCloud = Boolean(supabaseClient && isSignedIn);

  // Category lists (for the filter and the inline per-row category editor) include
  // empty "known" folders so they can be selected before a deck lands.
  let categories = categoriesFromDecks(localDecks, [...webDeckCategories, ...readKnownFolders()]);
  // Repopulate the dropdown regardless of view so it's ready the moment the
  // user switches to Grid/Tree, but only let its value narrow the result set
  // there — Folder view scopes itself via the breadcrumb + cwd instead, and
  // applying both would silently narrow it further than the breadcrumb shows.
  const filterValue = populateMyDecksCategoryFilter(categories);
  let selectedCategory = state.myDecksView === "folder" ? "" : filterValue;
  const inScope = (deck) => !selectedCategory || isCategoryUnder(deck.category, selectedCategory);

  // Paint on-device decks immediately (tentative Sync column) so the library never
  // waits on the network; the cloud fetch below repaints with real sync state.
  paintMyDecks(localDecks.filter(inScope), null, { categories, scope: selectedCategory, loading: canCloud && navigator.onLine });

  if (!(canCloud && navigator.onLine)) return;

  try {
    const cloudDecks = await fetchCloudDeckList();
    if (seq !== myDecksRenderSeq) return; // a newer render superseded this one
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudOnly = cloudDecks.filter((deck) => !localCloudIds.has(String(deck.id)) && !isDeckTombstoned(deck.id));
    categories = categoriesFromDecks([...localDecks, ...cloudOnly], [...webDeckCategories, ...readKnownFolders()]);
    setKnownWebDeckCategories(categoriesFromDecks([...localDecks, ...cloudOnly], webDeckCategories));
    const filterValue2 = populateMyDecksCategoryFilter(categories);
    selectedCategory = state.myDecksView === "folder" ? "" : filterValue2;
    const inScope2 = (deck) => !selectedCategory || isCategoryUnder(deck.category, selectedCategory);
    paintMyDecks(localDecks.filter(inScope2), cloudById, { cloudOnly: cloudOnly.filter(inScope2), categories, scope: selectedCategory, loading: false });
  } catch (error) {
    if (seq !== myDecksRenderSeq) return;
    console.warn("Could not fetch cloud decks for My Decks", error);
    // The on-device paint already stands; nothing more to show.
  }
}
