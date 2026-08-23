// The PDF's table of contents, in the drawer the notes TOC already uses.
//
// Deliberately the same drawer chrome, the same rows, the same fold-a-section
// affordance as src/notes/toc.js — a reader who has used one has used the other,
// and a second, differently-shaped TOC panel for the sake of a different
// document format would be a worse app, not a more capable one. The rows
// themselves are src/notes/toc-tree.js, called by both surfaces, so "the same"
// is enforced rather than promised.
//
// What cannot be shared is where the entries come from, and there are two
// answers:
//
//   1. the file's own outline dictionary, whose destinations are page references
//      that have to be resolved through the document one at a time;
//   2. failing that, the type on the page — src/documents/pdf-toc.js reads a
//      contents out of the headings, which is what makes this drawer useful on
//      the papers, preprints and printed-to-PDF chapters that carry no outline
//      at all (which is most of them).
//
// ── Opening it ─────────────────────────────────────────────────────────────
//
// openDocumentToc/closeDocumentToc are here rather than in main.js because
// there are two ways in — the ☰ beside the tabs and the reading rail's Contents
// row — and they were two copies of `drawer.hidden = !open`. Both of them were
// WRONG in the same way: .notes-toc-drawer is `transform: translateX(-104%);
// opacity: 0` until it is given `.is-open` (styles/12-notes.css:801), which
// openNotesToc gives the notes drawer and nothing ever gave this one. Unhiding
// it put a fully transparent panel off the left edge of the screen. One
// implementation, two callers, and the class cannot be forgotten again.

import { el } from "../core/dom.js?v=__BUILD__";
import { refreshDrawerOnOpen } from "../panels/drawer-highlights.js?v=__BUILD__";
import {
  TOC_TWISTY_CLASS,
  tocBranchesFromDepths,
  tocCarryFolds,
  tocDepthsFromLevels,
  tocPaintFoldAll,
  tocPaintFolding,
  tocParentsFromDepths,
  tocRowFor
} from "../notes/toc-tree.js?v=__BUILD__";
import { cachePdfContents, derivePdfContents, readCachedPdfContents } from "./pdf-toc.js?v=__BUILD__";

// Nesting deeper than this is folded into its parent's level rather than
// indented further. Books do go five deep, and at that point the indent is
// eating the drawer's width without telling the reader anything.
export const OUTLINE_MAX_DEPTH = 3;

// Resolving a destination costs a lookup per entry, and a reference work can
// carry thousands. Capped so opening one does not spend a second of main thread
// on a drawer nobody has opened yet; past the cap the entries are still listed,
// they just jump by resolving on demand when tapped.
export const OUTLINE_EAGER_LIMIT = 300;

// How long the drawer's slide lasts, for the same reason closeNotesToc keeps a
// timer: `transitionend` only fires if a transition actually runs, and under
// reduced motion it does not.
export const OUTLINE_CLOSE_MS = 260;

let outlineEntries = [];

// Whether what is listed was read out of the type on the page rather than out of
// the file's own outline. Shown above the list — an approximate contents is
// worth having and is not worth passing off as the author's.
let outlineDerived = false;

// Set while a derivation is running, so the note above the list can say the
// answer is still arriving.
let outlineScanning = false;

// Bumped on every build, so a background scan that finishes after the reader has
// opened another deck is dropped rather than painted into it. Same guard shape
// as pdfOpenToken in pdf-view.js.
let outlineToken = 0;

// The flat list's tree, and which branches are folded — by TITLE+PAGE rather
// than by index, exactly as the notes contents carries folds by slug.
let outlineDepths = [];
let outlineParents = [];
let outlineBranches = [];
let outlineItems = [];
let outlineLinks = [];
let outlineKeys = [];
let outlineCollapsed = new Set();
let outlineKnownBranches = new Set();
let outlineActiveIndex = -1;

export function documentOutlineEntries() {
  return outlineEntries;
}

export function isDocumentOutlineDerived() {
  return outlineDerived;
}

export function clearDocumentOutline() {
  outlineToken += 1;
  outlineEntries = [];
  outlineDerived = false;
  outlineScanning = false;
  outlineItems = [];
  outlineLinks = [];
  outlineKeys = [];
  outlineActiveIndex = -1;
  outlineCollapsed = new Set();
  outlineKnownBranches = new Set();
  const list = el.documentOutlineList;
  if (list) list.innerHTML = "";
  if (el.documentOutlineEmpty) el.documentOutlineEmpty.hidden = false;
  paintOutlineDerivedNote();
}

// A pdf.js outline destination → a 1-based page number, or 0 when it cannot be
// resolved (a broken link, or a named destination the file does not define).
export async function outlineDestinationPage(doc, dest) {
  try {
    const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return 0;
    const index = await doc.getPageIndex(resolved[0]);
    return index + 1;
  } catch (_) {
    return 0;
  }
}

export function flattenOutline(items, depth = 0, out = []) {
  (items || []).forEach((item) => {
    out.push({
      title: String(item.title || "").replace(/\s+/g, " ").trim(),
      dest: item.dest,
      depth: Math.min(depth, OUTLINE_MAX_DEPTH),
      page: 0
    });
    if (item.items?.length) flattenOutline(item.items, depth + 1, out);
  });
  return out;
}

export async function buildDocumentOutline(doc) {
  const token = (outlineToken += 1);
  const outline = await doc.getOutline();
  outlineEntries = flattenOutline(outline).filter((entry) => entry.title);
  outlineDerived = false;
  outlineScanning = false;
  if (outlineEntries.length) {
    // Resolved in order and in the background: the drawer renders immediately
    // with every title in it, and each row becomes a jump as its page lands.
    const eager = outlineEntries.slice(0, OUTLINE_EAGER_LIMIT);
    renderDocumentOutline();
    for (const entry of eager) {
      if (token !== outlineToken) return outlineEntries;
      entry.page = await outlineDestinationPage(doc, entry.dest);
    }
    if (token !== outlineToken) return outlineEntries;
    renderDocumentOutline();
    return outlineEntries;
  }

  // ── No outline in the file ───────────────────────────────────────────────
  //
  // The cache first, because it is free and because the file it was derived
  // from cannot have changed. Only then the scan, which is minutes of worker
  // time on a big book and is why the result is worth keeping.
  const cached = readCachedPdfContents(doc.numPages);
  if (cached?.length) {
    outlineEntries = cached;
    outlineDerived = true;
    renderDocumentOutline();
    return outlineEntries;
  }

  outlineDerived = true;
  outlineScanning = true;
  renderDocumentOutline();
  const found = await derivePdfContents(doc, {
    alive: () => token === outlineToken,
    onProgress: (entries) => {
      if (token !== outlineToken) return;
      outlineEntries = entries;
      renderDocumentOutline();
    }
  });
  if (token !== outlineToken) return outlineEntries;
  outlineScanning = false;
  outlineEntries = found;
  renderDocumentOutline();
  if (found.length) cachePdfContents(found, doc.numPages);
  return outlineEntries;
}

// ── The list ───────────────────────────────────────────────────────────────

function outlineKeyFor(entry, index) {
  return `${entry.depth}:${entry.page}:${entry.title}:${index}`;
}

function paintOutlineDerivedNote() {
  const list = el.documentOutlineList;
  const scroll = list?.parentElement;
  if (!scroll) return;
  let note = scroll.querySelector(".document-toc-derived");
  if (!outlineDerived || !outlineEntries.length) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.className = "document-toc-derived";
    scroll.insertBefore(note, list);
  }
  note.dataset.scanning = outlineScanning ? "true" : "false";
  note.textContent = outlineScanning
    ? "Reading the headings off the pages"
    : "This PDF carries no contents of its own — these headings were found in the text";
}

export function renderDocumentOutline() {
  const list = el.documentOutlineList;
  if (!list) return;
  list.innerHTML = "";
  outlineItems = [];
  outlineLinks = [];
  outlineActiveIndex = -1;
  const has = outlineEntries.length > 0;
  list.hidden = !has;
  if (el.documentOutlineEmpty) el.documentOutlineEmpty.hidden = has || outlineScanning;
  paintOutlineDerivedNote();
  if (!has) return;

  outlineDepths = tocDepthsFromLevels(outlineEntries.map((entry) => entry.depth));
  outlineParents = tocParentsFromDepths(outlineDepths);
  outlineBranches = tocBranchesFromDepths(outlineDepths);
  outlineKeys = outlineEntries.map(outlineKeyFor);
  const carried = tocCarryFolds({
    keys: outlineKeys,
    branches: outlineBranches,
    known: outlineKnownBranches,
    collapsed: outlineCollapsed
  });
  outlineKnownBranches = carried.known;
  outlineCollapsed = carried.collapsed;

  const frag = document.createDocumentFragment();
  outlineEntries.forEach((entry, index) => {
    // The page number rides inside the link, after the text, so a column of them
    // lines up down the right of the drawer whatever depth each row is at.
    let tail = null;
    if (entry.page) {
      tail = document.createElement("span");
      tail.className = "document-toc-page";
      tail.textContent = String(entry.page);
    }
    const { li, link } = tocRowFor({
      index,
      depth: outlineDepths[index],
      depths: outlineDepths,
      // The dot's size ladder is the notes' heading level, 1-6. A depth of 0
      // here is the same kind of thing as an h1 there.
      level: outlineDepths[index] + 1,
      text: entry.title,
      id: outlineKeys[index],
      branch: outlineBranches[index],
      tail
    });
    link.dataset.outlineIndex = String(index);
    frag.appendChild(li);
    outlineItems.push(li);
    outlineLinks.push(link);
  });
  list.appendChild(frag);
  applyDocumentOutlineFolding();
  updateDocumentOutlineFoldAll();
}

export function applyDocumentOutlineFolding() {
  tocPaintFolding({
    items: outlineItems,
    keys: outlineKeys,
    parents: outlineParents,
    branches: outlineBranches,
    collapsed: outlineCollapsed
  });
  // Every link the spy held is either newly hidden or newly revealed, so it
  // picks again from scratch — the same reset applyNotesTocFolding makes, and
  // for the same reason: clearing the index without clearing the classes leaves
  // two rows lit at once.
  outlineLinks.forEach((link) => {
    link.classList.remove("is-active");
    link.removeAttribute("aria-current");
  });
  outlineActiveIndex = -1;
  updateDocumentOutlineActive();
}

export function toggleDocumentOutlineBranch(index) {
  const key = outlineKeys[index];
  if (!key || !outlineBranches[index]) return;
  if (outlineCollapsed.has(key)) outlineCollapsed.delete(key);
  else outlineCollapsed.add(key);
  applyDocumentOutlineFolding();
  updateDocumentOutlineFoldAll();
}

export function allDocumentOutlineBranchesCollapsed() {
  return outlineBranches.every((isBranch, index) => !isBranch || outlineCollapsed.has(outlineKeys[index]));
}

export function setAllDocumentOutlineBranches(collapsed) {
  outlineCollapsed = new Set();
  if (collapsed) {
    outlineBranches.forEach((isBranch, index) => {
      if (isBranch) outlineCollapsed.add(outlineKeys[index]);
    });
  }
  applyDocumentOutlineFolding();
  updateDocumentOutlineFoldAll();
}

export function updateDocumentOutlineFoldAll() {
  const button = document.getElementById("documentTocFoldAllBtn");
  tocPaintFoldAll(button, {
    anyBranch: outlineBranches.some(Boolean),
    allCollapsed: allDocumentOutlineBranchesCollapsed()
  });
}

// ── Where the reader is ────────────────────────────────────────────────────
//
// The notes contents lights the section you are reading; this lights the entry
// whose page you are on. Driven from updatePageIndicator in pdf-view.js, which
// already runs on every scroll settle — so this costs nothing extra and cannot
// be a second opinion about which page is current.
let outlineCurrentPage = 0;

export function setDocumentOutlinePage(page) {
  const next = Number(page) || 0;
  if (next === outlineCurrentPage) return;
  outlineCurrentPage = next;
  updateDocumentOutlineActive();
}

export function updateDocumentOutlineActive() {
  if (!outlineLinks.length || !outlineCurrentPage) return;
  // The last entry at or before this page, skipping folded-away rows — lighting
  // a row the reader cannot see says nothing.
  let found = -1;
  for (let index = 0; index < outlineEntries.length; index += 1) {
    const entry = outlineEntries[index];
    if (!entry.page || entry.page > outlineCurrentPage) break;
    if (outlineItems[index]?.hidden) continue;
    found = index;
  }
  if (found === outlineActiveIndex) return;
  const previous = outlineLinks[outlineActiveIndex];
  if (previous) {
    previous.classList.remove("is-active");
    previous.removeAttribute("aria-current");
  }
  outlineActiveIndex = found;
  const next = outlineLinks[found];
  if (!next) return;
  next.classList.add("is-active");
  next.setAttribute("aria-current", "true");
}

// ── Opening and closing ────────────────────────────────────────────────────

export function isDocumentTocOpen() {
  return Boolean(el.documentOutlineDrawer?.classList.contains("is-open"));
}

export function openDocumentToc() {
  const drawer = el.documentOutlineDrawer;
  if (!drawer) return;
  // The drawer's second half — this document's own highlights — built on the way
  // in and only when it is stale, the same discipline openNotesToc keeps.
  refreshDrawerOnOpen(drawer);
  drawer.hidden = false;
  // Force reflow so the open transition runs from the hidden state.
  void drawer.offsetWidth;
  drawer.classList.add("is-open");
  el.documentTocBtn?.classList.add("is-active");
  el.documentTocBtn?.setAttribute("aria-expanded", "true");
  updateDocumentOutlineActive();
}

export function closeDocumentToc() {
  const drawer = el.documentOutlineDrawer;
  if (!drawer) return;
  drawer.classList.remove("is-open");
  el.documentTocBtn?.classList.remove("is-active");
  el.documentTocBtn?.setAttribute("aria-expanded", "false");
  // Torn down explicitly rather than with { once: true }, for the reason
  // closeNotesToc gives: the listener only fires if a transition actually runs,
  // and under reduced motion it does not.
  let timer = 0;
  const hideAfter = () => {
    drawer.removeEventListener("transitionend", hideAfter);
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!drawer.classList.contains("is-open")) drawer.hidden = true;
  };
  drawer.addEventListener("transitionend", hideAfter);
  timer = setTimeout(hideAfter, OUTLINE_CLOSE_MS);
}

export function toggleDocumentToc() {
  if (isDocumentTocOpen()) closeDocumentToc();
  else openDocumentToc();
}

// One delegated listener for the whole list, however many rows it has.
export function initDocumentOutlineFolding() {
  el.documentOutlineList?.addEventListener("click", (event) => {
    const twisty = event.target.closest(`.${TOC_TWISTY_CLASS}`);
    if (!twisty) return;
    // Stopped as well as prevented: the row's own handler (which jumps to the
    // page) is on the same list, and the twisty sits over the row.
    event.preventDefault();
    event.stopPropagation();
    toggleDocumentOutlineBranch(Number(twisty.dataset.tocIndex));
  });
  document.getElementById("documentTocFoldAllBtn")?.addEventListener("click", () => {
    setAllDocumentOutlineBranches(!allDocumentOutlineBranchesCollapsed());
  });
}
