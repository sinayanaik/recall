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
import { stripInvalidUnicode } from "../core/text.js?v=__BUILD__";
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
import { cachePdfContents, clearUserPdfContents, derivePdfContents, readCachedPdfContents, readUserPdfContents, writeUserPdfContents } from "./pdf-toc.js?v=__BUILD__";
import { destinationPageNumber, explicitDestination, resolvePdfDestination } from "./pdf-dest.js?v=__BUILD__";
import { indent, insertionFor, moveDown, moveSubtree, moveUp, outdent, parentOf, removeEntry } from "./pdf-toc-arrange.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { PDF_PRIMARY_ID } from "./pdf-multi.js?v=__BUILD__";

// Nesting deeper than this is folded into its parent's level rather than
// indented further. Books do go five deep, and at that point the indent is
// eating the drawer's width without telling the reader anything.
export const OUTLINE_MAX_DEPTH = 3;

// Resolving a destination costs a lookup per entry, and a reference work can
// carry thousands. Capped so opening one does not spend a second of main thread
// on a drawer nobody has opened yet.
//
// ── What the cap is, and what it is not ────────────────────────────────────
//
// It used to be the whole story: the first 300 entries were resolved and the
// rest kept `page: 0` forever, which the click handler in src/main.js reads as
// "nowhere to go" and answers by doing nothing at all. On a book with more than
// 300 outline entries that is a contents list whose bottom half is dead — press
// a chapter and the drawer just sits there. The comment here claimed those
// entries "jump by resolving on demand when tapped"; nothing ever did that.
//
// Two things do now, and both are needed. resolveOutlineTail keeps going after
// the eager batch, in chunks, so the numbers fill in by themselves on a document
// left open — and resolveOutlineEntryPage resolves ONE on the way to a jump, so
// a press that beats the tail to it still lands. The cap is back to being what
// it says: how much is resolved before the drawer first paints.
export const OUTLINE_EAGER_LIMIT = 300;

// How many of the remaining entries are resolved between yields. Each one is a
// round trip to the pdf.js worker, so the main thread is idle for most of a
// chunk anyway; this is the granularity at which the tail gets out of the way
// of something the reader actually asked for.
export const OUTLINE_TAIL_CHUNK = 50;

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

// Whether what is listed is the reader's own arrangement (meta.pdfUserToc, see
// "The reader's own contents" below) rather than the file's or the derived one.
let outlineUser = false;

// The document and PDF the list belongs to — what an edit needs to resolve the
// file's destinations into pages and to know where to save.
let outlineDoc = null;
let outlinePdfId = PDF_PRIMARY_ID;

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

export function isDocumentOutlineUser() {
  return outlineUser;
}

export function clearDocumentOutline() {
  outlineToken += 1;
  outlineEntries = [];
  outlineUser = false;
  outlineDoc = null;
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
  paintOutlineEditable();
}

// A pdf.js outline destination → a 1-based page number, or 0 when it cannot be
// resolved (a broken link, or a named destination the file does not define).
export async function outlineDestinationPage(doc, dest) {
  return destinationPageNumber(doc, await explicitDestination(doc, dest));
}

export function flattenOutline(items, depth = 0, out = []) {
  (items || []).forEach((item) => {
    out.push({
      // The file's own outline strings come out of the same pdf.js decoder as
      // the Info-dict Title, so they carry the same U+0000 when the PDF wrote
      // them as UTF-16BE without a BOM — and these titles are cached into the
      // deck's synced meta by cachePdfContents. See stripInvalidUnicode.
      title: stripInvalidUnicode(item.title).replace(/\s+/g, " ").trim(),
      dest: item.dest,
      depth: Math.min(depth, OUTLINE_MAX_DEPTH),
      page: 0
    });
    if (item.items?.length) flattenOutline(item.items, depth + 1, out);
  });
  return out;
}

export async function buildDocumentOutline(doc, pdfId = PDF_PRIMARY_ID) {
  const token = (outlineToken += 1);
  outlineDoc = doc;
  outlinePdfId = pdfId || PDF_PRIMARY_ID;
  outlineUser = false;
  paintOutlineEditable();

  // ── The reader's own, first ──────────────────────────────────────────────
  //
  // Once someone has added a bookmark or moved a heading, what they arranged
  // IS the contents of this PDF — the file's outline and the derived one are
  // what it was made from, and what a reset goes back to.
  if (activeDocSlot() !== DOC_SLOT_NOTEBOOK) {
    const own = readUserPdfContents(doc.numPages, outlinePdfId);
    if (own) {
      outlineEntries = own.map((entry) => ({ ...entry, dead: !entry.page }));
      outlineUser = true;
      outlineDerived = false;
      outlineScanning = false;
      renderDocumentOutline();
      return outlineEntries;
    }
  }

  const outline = await doc.getOutline();
  if (token !== outlineToken) return outlineEntries;
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
      if (!entry.page) entry.dead = true;
    }
    if (token !== outlineToken) return outlineEntries;
    renderDocumentOutline();
    // ...and then everything past the cap, unhurried. Awaited rather than left
    // running so a caller that wants the finished list gets it, and so the
    // token guard has one owner.
    await resolveOutlineTail(doc, token);
    return outlineEntries;
  }

  // ── ...and a notebook has neither ────────────────────────────────────────
  //
  // Deriving a contents means reading the TYPE on the pages, and paper this app
  // generated has none — a markdown block on it is DOM over the page, not text
  // in the file. So the scan below can only ever find nothing, at the cost of a
  // pass over every page; and `pdfToc` is one key on the deck, shared with
  // whatever paper the deck is also carrying, which is not a cache to write an
  // empty answer into. The drawer still opens: its Highlights half is the half
  // that means something here.
  if (activeDocSlot() === DOC_SLOT_NOTEBOOK) {
    outlineEntries = [];
    outlineDerived = true;
    renderDocumentOutline();
    return outlineEntries;
  }

  // ── No outline in the file ───────────────────────────────────────────────
  //
  // The cache first, because it is free and because the file it was derived
  // from cannot have changed. Only then the scan, which is minutes of worker
  // time on a big book and is why the result is worth keeping.
  const cached = readCachedPdfContents(doc.numPages, pdfId);
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
  if (found.length) cachePdfContents(found, doc.numPages, pdfId);
  return outlineEntries;
}

// ── Resolving the rest of them ─────────────────────────────────────────────

function outlineBreathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Everything past OUTLINE_EAGER_LIMIT, a chunk at a time.
//
// Rows are patched in place rather than re-rendered. renderDocumentOutline
// rebuilds every <li> in the list, and doing that sixty times over a
// three-thousand-entry outline would cost more than the lookups it is
// reporting — and would do it while the reader is scrolling the thing being
// rebuilt. Only the page number of the one row that just resolved changes, so
// only that is written.
async function resolveOutlineTail(doc, token) {
  if (!doc) return;
  for (let index = OUTLINE_EAGER_LIMIT; index < outlineEntries.length; index += 1) {
    if (token !== outlineToken) return;
    const entry = outlineEntries[index];
    // Already answered — by the eager batch on a rebuild, or by a press that
    // got there first (resolveOutlineEntryPage).
    if (entry.page || entry.dead) continue;
    entry.page = await outlineDestinationPage(doc, entry.dest);
    if (!entry.page) entry.dead = true;
    if (token !== outlineToken) return;
    paintOutlineRowPage(index);
    if ((index - OUTLINE_EAGER_LIMIT + 1) % OUTLINE_TAIL_CHUNK === 0) await outlineBreathe();
  }
  if (token !== outlineToken) return;
  // The pages the scroll-spy had nothing to compare against until now.
  updateDocumentOutlineActive();
}

// One entry, resolved because it is about to be jumped to.
//
// `doc` is passed in rather than read from src/documents/pdf-view.js:
// pdf-view.js imports THIS module (setDocumentOutlinePage, from
// updatePageIndicator), and importing it back would add a cycle to the graph
// for the sake of one accessor. src/main.js has both and hands it over.
//
// Returns the page, or 0 for a destination the file does not actually define —
// a broken link in the PDF, which the row is marked with so it can say so
// instead of looking like a press that missed.
export async function resolveOutlineEntryPage(index, doc) {
  const entry = outlineEntries[index];
  if (!entry) return 0;
  if (entry.page) return entry.page;
  if (entry.dead || !doc) return 0;
  const token = outlineToken;
  const page = await outlineDestinationPage(doc, entry.dest);
  // Another document opened while the lookup was in flight; this answer is
  // about a list that is no longer on screen.
  if (token !== outlineToken) return 0;
  entry.page = page;
  if (!page) entry.dead = true;
  paintOutlineRowPage(index);
  return page;
}

// The page number on one already-rendered row, written without rebuilding the
// list around it. A no-op before the row exists, which is the case while the
// eager batch is still running.
function paintOutlineRowPage(index) {
  const link = outlineLinks[index];
  const entry = outlineEntries[index];
  if (!link || !entry) return;
  markOutlineRowDead(outlineItems[index], entry);
  let tail = link.querySelector(".document-toc-page");
  if (!entry.page) {
    tail?.remove();
    return;
  }
  if (!tail) {
    tail = document.createElement("span");
    tail.className = "document-toc-page";
    link.appendChild(tail);
  }
  tail.textContent = String(entry.page);
}

// A row whose destination was looked up and came back with nothing. Kept
// distinct from "not looked up yet", which is the same missing page number and
// a completely different thing to tell the reader: one is a file that lies
// about where its own chapter is, the other is a lookup that has not run.
function markOutlineRowDead(li, entry) {
  if (!li) return;
  if (entry.dead) li.dataset.tocUnresolved = "true";
  else delete li.dataset.tocUnresolved;
}

// ── The list ───────────────────────────────────────────────────────────────

// A row's identity, for carrying folds across a rebuild.
//
// Deliberately NOT including the row's index. A derived contents is rendered
// AS IT IS SCANNED — every sixteen pages, with more rows each time — so an
// index-keyed fold would move one row further down the tree on every pass, and
// a reader folding a branch while the scan ran would watch it walk away from
// them. Two rows with the same words on the same page at the same depth share a
// fold state, which is a fair price and is a shape a real document essentially
// never produces (pdfTocEntriesFrom drops consecutive repeats).
function outlineKeyFor(entry) {
  // The reader's own rows carry an id that survives a move, a rename and a
  // change of depth — which none of the three parts below does.
  if (entry.id) return `id:${entry.id}`;
  return `${entry.depth}:${entry.page}:${entry.title}`;
}

function paintOutlineDerivedNote() {
  const list = el.documentOutlineList;
  const scroll = list?.parentElement;
  if (!scroll) return;
  let note = scroll.querySelector(".document-toc-derived");
  // While the scan is running the note is the ONLY thing in the drawer — the
  // list is empty and the "no contents" message is being held back because the
  // answer is not in yet. Without this the first few seconds of a big book were
  // a blank panel.
  if (!outlineDerived || (!outlineEntries.length && !outlineScanning)) {
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
      branch: outlineBranches[index],
      tail
    });
    link.dataset.outlineIndex = String(index);
    if (entry.id) li.dataset.tocId = entry.id;
    if (entry.bookmark) li.dataset.tocBookmark = "true";
    markOutlineRowDead(li, entry);
    frag.appendChild(li);
    outlineItems.push(li);
    outlineLinks.push(link);
  });
  list.appendChild(frag);
  applyDocumentOutlineFolding();
  updateDocumentOutlineFoldAll();
  paintOutlineEditable();
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
  // The entry furthest into the document that is still at or before this page,
  // skipping folded-away rows — lighting a row the reader cannot see says
  // nothing. Not simply "the last one before the first that is past it": the
  // reader's own arrangement need not be in page order (a bookmark dragged
  // under the chapter it is about, wherever that chapter is), so every row is
  // looked at, and a tie goes to the later row as the old scan's did.
  let found = -1;
  let foundPage = 0;
  let foundRatio = -1;
  for (let index = 0; index < outlineEntries.length; index += 1) {
    const entry = outlineEntries[index];
    if (!entry.page || entry.page > outlineCurrentPage) {
      if (!outlineUser && entry.page > outlineCurrentPage) break;
      continue;
    }
    if (outlineItems[index]?.hidden) continue;
    const ratio = Number(entry.ratio) || 0;
    if (entry.page > foundPage || (entry.page === foundPage && ratio >= foundRatio)) {
      found = index;
      foundPage = entry.page;
      foundRatio = ratio;
    }
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

// ── The reader's own contents ──────────────────────────────────────────────
//
// A bookmark the reader adds, a heading dragged under another, a row renamed
// or deleted: each turns the list on screen into the reader's own copy the
// first time, saved as meta.pdfUserToc (src/documents/pdf-toc.js) and listed in
// place of the file's or the derived contents from then on. Every operation
// here is by INDEX into the list as it is on screen, and the copy keeps every
// row in the same place, so an index taken from a row before the copy is still
// the right one after it.

// Bookmarks and edits are for a PDF. The Canvas has no contents to arrange;
// its drawer is there for its highlights.
export function canEditDocumentOutline() {
  return Boolean(outlineDoc) && activeDocSlot() !== DOC_SLOT_NOTEBOOK;
}

function paintOutlineEditable() {
  const editable = canEditDocumentOutline();
  el.documentOutlineDrawer?.classList.toggle("is-editable", editable);
  const reset = document.getElementById("documentTocResetBtn");
  if (reset) reset.hidden = !(editable && outlineUser);
  const bookmark = document.getElementById("documentTocBookmarkBtn");
  if (bookmark) bookmark.hidden = !editable;
}

function mintOutlineId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The list on screen as the reader's own copy, made the first time it is
// edited. The file's own outline has its destinations looked up in full on the
// way — page and height — because the copy has to stand on its own: it is
// saved, synced, and listed on a device that never resolved a thing.
//
// Resolves false when the list changed underneath (another document opened)
// while the lookups were running.
export async function ensureUserDocumentOutline() {
  if (outlineUser) return true;
  if (!canEditDocumentOutline()) return false;
  const doc = outlineDoc;
  const token = outlineToken;
  const source = outlineEntries.slice();
  const copied = [];
  // Each row's fold key before the copy, so the folds can follow the rows to
  // their new keys (which are by id) rather than every branch the reader had
  // opened snapping shut as "new" — see tocCarryFolds.
  const oldKeys = source.map(outlineKeyFor);
  for (const entry of source) {
    let page = entry.page || 0;
    let ratio = Number(entry.ratio) || 0;
    if (entry.dest && !entry.dead) {
      const target = await resolvePdfDestination(doc, entry.dest);
      if (token !== outlineToken) return false;
      page = target.page;
      ratio = target.ratio;
    }
    copied.push({
      id: mintOutlineId("toc"),
      title: entry.title,
      page,
      ratio,
      depth: entry.depth,
      bookmark: Boolean(entry.bookmark),
      user: true,
      dead: !page
    });
  }
  if (token !== outlineToken) return false;
  // Depths as the drawer draws them (tocDepthsFromLevels), and never more
  // than one deeper than the row above: the arithmetic in pdf-toc-arrange.js
  // reads a row's children off the depths, and a derived contents whose first
  // heading is a level 2 is not a list of orphans.
  const least = copied.reduce((min, entry) => Math.min(min, entry.depth), Infinity);
  copied.forEach((entry, index) => {
    const ceiling = index ? copied[index - 1].depth + 1 : 0;
    entry.depth = Math.max(0, Math.min(entry.depth - least, ceiling, OUTLINE_MAX_DEPTH));
  });
  const known = new Set();
  const collapsed = new Set();
  copied.forEach((entry, index) => {
    const key = outlineKeyFor(entry);
    if (outlineKnownBranches.has(oldKeys[index])) known.add(key);
    if (outlineCollapsed.has(oldKeys[index])) collapsed.add(key);
  });
  outlineKnownBranches = known;
  outlineCollapsed = collapsed;
  // A newer build from here on: a derivation still scanning, or the outline's
  // tail still resolving, is about a list that has just been replaced.
  outlineToken += 1;
  outlineUser = true;
  outlineDerived = false;
  outlineScanning = false;
  outlineEntries = copied;
  return true;
}

// Save and show. `focusId` is a row to make visible — its ancestors unfolded
// and the row scrolled to and flashed — after a bookmark or a move.
function commitUserOutline(entries, focusId = null) {
  outlineEntries = entries;
  writeUserPdfContents(entries, outlineDoc?.numPages || 0, outlinePdfId);
  if (focusId) {
    // Every heading above it open — marked KNOWN as well as not collapsed,
    // because a branch the drawer has never seen starts folded, and a heading
    // that has just been given its first child is exactly that.
    const index = entries.findIndex((entry) => entry.id === focusId);
    for (let at = parentOf(entries, index); at >= 0; at = parentOf(entries, at)) {
      const key = outlineKeyFor(entries[at]);
      outlineKnownBranches.add(key);
      outlineCollapsed.delete(key);
    }
  }
  renderDocumentOutline();
  if (focusId) flashDocumentOutlineRow(focusId);
}

export function flashDocumentOutlineRow(id) {
  const li = el.documentOutlineList?.querySelector(`[data-toc-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: "nearest" });
  li.classList.remove("is-flash");
  void li.offsetWidth;
  li.classList.add("is-flash");
  setTimeout(() => li.classList.remove("is-flash"), 1600);
}

// A bookmark at a place in the document: { page, ratio, title }. Resolves the
// new row's id, or null when nothing was added.
export async function addDocumentOutlineBookmark({ page, ratio = 0, title = "" } = {}) {
  if (!page || !(await ensureUserDocumentOutline())) return null;
  const clean = String(title || "").replace(/\s+/g, " ").trim() || `Bookmark — p. ${page}`;
  const row = {
    id: mintOutlineId("bm"),
    title: clean,
    page,
    ratio: Math.min(1, Math.max(0, Number(ratio) || 0)),
    depth: 0,
    bookmark: true,
    user: true,
    dead: false
  };
  const at = insertionFor(outlineEntries, row.page, row.ratio, OUTLINE_MAX_DEPTH);
  row.depth = at.depth;
  const next = outlineEntries.slice();
  next.splice(at.index, 0, row);
  commitUserOutline(next, row.id);
  return row.id;
}

// A branch dragged in the drawer: the row at `from` and everything under it,
// put in front of `before` with its top row at `depth`.
export async function moveDocumentOutlineEntry(from, before, depth) {
  if (!outlineEntries[from] || !(await ensureUserDocumentOutline())) return false;
  const moved = moveSubtree(outlineEntries, from, before, depth, OUTLINE_MAX_DEPTH);
  const id = moved.entries[moved.index]?.id;
  commitUserOutline(moved.entries, id);
  return true;
}

const OUTLINE_STEPS = { up: moveUp, down: moveDown, indent, outdent };

// One keyboard step — "up", "down", "indent", "outdent". False when the row
// cannot go that way (the first of its siblings cannot go up).
export async function stepDocumentOutlineEntry(index, step) {
  const apply = OUTLINE_STEPS[step];
  if (!apply || !outlineEntries[index]) return false;
  if (!apply(outlineEntries, index, OUTLINE_MAX_DEPTH)) return false;
  if (!(await ensureUserDocumentOutline())) return false;
  const moved = apply(outlineEntries, index, OUTLINE_MAX_DEPTH);
  if (!moved) return false;
  const id = moved.entries[moved.index]?.id;
  commitUserOutline(moved.entries, id);
  return true;
}

export function canStepDocumentOutlineEntry(index, step) {
  const apply = OUTLINE_STEPS[step];
  return Boolean(apply && outlineEntries[index] && apply(outlineEntries, index, OUTLINE_MAX_DEPTH));
}

export async function renameDocumentOutlineEntry(index, title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  if (!clean || !outlineEntries[index] || !(await ensureUserDocumentOutline())) return false;
  if (outlineEntries[index].title === clean) return true;
  const next = outlineEntries.slice();
  next[index] = { ...next[index], title: clean };
  commitUserOutline(next);
  return true;
}

export async function deleteDocumentOutlineEntry(index) {
  if (!outlineEntries[index] || !(await ensureUserDocumentOutline())) return false;
  commitUserOutline(removeEntry(outlineEntries, index));
  return true;
}

// Back to the file's own outline, or the derived contents.
export async function resetDocumentOutline() {
  if (!outlineDoc) return;
  clearUserPdfContents(outlinePdfId);
  outlineCollapsed = new Set();
  outlineKnownBranches = new Set();
  await buildDocumentOutline(outlineDoc, outlinePdfId);
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
