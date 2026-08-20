// The notes table of contents, and the backlinks panel beside it.
//
// Heading ids are assigned lazily, on first use — a note can hold thousands of
// headings and slugifying them all on every render is wasted work.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { convergeNotesScroll, scrollNotesBlockToReadingLine } from "./anchors.js?v=__BUILD__";
import { revealNotesCaretAt } from "./caret-line.js?v=__BUILD__";
import { parseNoteLinkTarget } from "./note-links.js?v=__BUILD__";
import { activeChapterIndex, firstVisibleNotesBlock, isNotesPaged, notesCurrentPage, notesPageForElement, revealInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, NOTES_TOP_LEVEL_SELECTOR, ensureNotesLazyOffsetBuilt, notesHeadingScan, notesLazyTopAtOffset, renderedBlockCache, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
import { NOTE_LINK_PATTERN, noteLinkEntryMatchesId } from "../render/note-links.js?v=__BUILD__";
import { forEachDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";

// ── Notes table of contents ────────────────────────────────────────
// The rendered notes carry no navigation of their own; long study notes
// become a wall of text. buildNotesToc() scans the freshly rendered
// headings, gives each a stable anchor id, and mirrors them into a
// slide-in drawer (the ☰ hamburger in the notes head). Clicking an entry
// scrolls that heading to the top of the notes viewport, and a scroll-spy
// keeps the entry for the section you're reading highlighted.
export let notesTocHeadings = [];

// ── Built when it is looked at, not when the note renders ──────────────────
//
// buildNotesToc walks every heading in the note, slugifies each one and makes
// three DOM nodes per row. On a book that is ~70ms, it used to run on the tail
// of EVERY render (an edit, a highlight, a raw<->rendered toggle), and the
// drawer it draws into is closed almost all of the time — so the reader paid it
// to produce something nobody was looking at, right at the moment they were
// reaching for a control.
//
// So the render tail only marks the list stale. It is built when the drawer
// opens, and rebuilt on the next frame if a render lands while it is open —
// which is also the fix for the other half of the report, "the TOC does not
// reliably update": a rebuild used to forget which row was lit, and nothing
// re-lit it until the reader scrolled again.
export let notesTocDirty = true;

export function markNotesTocDirty() {
  notesTocDirty = true;
  // The drawer is on screen right now, so "stale" is not good enough. One frame
  // later, so a burst of renders (a streamed note finishing, an edit committing)
  // costs one rebuild rather than one each.
  if (isNotesTocOpen()) scheduleNotesTocRebuild();
}

export let notesTocRebuildFrame = 0;

export function scheduleNotesTocRebuild() {
  if (notesTocRebuildFrame) return;
  notesTocRebuildFrame = requestAnimationFrame(() => {
    notesTocRebuildFrame = 0;
    if (!notesTocDirty) return;
    buildNotesToc();
    // Re-light the row for wherever the reader is. buildNotesToc resets
    // notesTocActiveIndex to -1 because every link it held is now detached, and
    // without this the drawer sat with nothing active until the next scroll.
    updateNotesTocActive();
  });
}

// Build it if it is stale. THE entry point for anything that is about to read
// the list or the arrays beside it.
export function ensureNotesTocBuilt() {
  if (notesTocDirty) buildNotesToc();
}

// Does this note have any headings at all? The only thing the render tail still
// needs to know, because it decides whether the ☰ button offers a contents at
// all — and `querySelector` stops at the first hit instead of collecting every
// heading in the book.
export function refreshNotesTocAvailability() {
  if (!el.notesView || !el.notesTocBtn) return;
  // Off the SOURCE, not off the DOM. A note whose spans are built as the reader
  // reaches them has almost none of its headings on screen at first paint, and
  // the ☰ button would have offered nothing on exactly the notes that most need
  // a contents. The scan is memoized per prepared string (notesHeadingScan), so
  // this is a string compare on every render after the first.
  const prepared = preparedNotesSource();
  const has = prepared == null
    ? Boolean(el.notesView.querySelector("h1, h2, h3, h4, h5, h6"))
    : notesHeadingScan(prepared).length > 0;
  el.notesTocBtn.classList.toggle("has-toc", has);
}

export let notesTocScrollFrame = 0;

// Setter: an imported binding is read-only, and the scroll listener in main.js drives this rAF handle.
export function setNotesTocScrollFrame(value) {
  notesTocScrollFrame = value;
}

// The rendered <a> for each heading, captured as buildNotesToc creates them so
// the scroll handler never has to re-query the list, plus which one is lit right
// now so it can touch only the two rows that change.
export let notesTocLinks = [];

export let notesTocActiveIndex = -1;

// ── Folding ────────────────────────────────────────────────────────────────
//
// The list is FLAT — one <li> per heading, with the tree drawn by the rail
// spans rather than by nesting — so folding cannot be "hide the child <ul>".
// These three arrays are the parent/child relation the flat DOM does not carry,
// rebuilt with the list and indexed the same way as notesTocHeadings.
export let notesTocItems = [];

export let notesTocParent = [];

export let notesTocBranch = [];

// Which branches are folded, by heading SLUG rather than by index: an edit that
// adds a paragraph renumbers every heading after it, and the reader's folds
// would jump one row up the tree each time.
export let notesTocCollapsed = new Set();

// Every branch slug the current note has already been given a state. A slug in
// here keeps whatever the reader chose; a slug that is NOT in here is new and
// starts folded — which is what makes the drawer open as an outline instead of
// as several hundred rows, and, because the set is pruned to the note's own
// slugs on every rebuild, is also what resets the folds when a different note
// opens without needing a hook on the deck-load path.
let notesTocKnownBranches = new Set();

export function slugifyHeading(text, used) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
  let slug = `toc-${base}`;
  let n = 2;
  while (used.has(slug)) slug = `toc-${base}-${n++}`;
  used.add(slug);
  return slug;
}

// Is `depths[i]` the last item among its own sibling group? (No later entry
// at the same depth before the group is closed by something shallower.)
export function tocIsLastSibling(depths, i) {
  const depth = depths[i];
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return true;
    if (depths[j] === depth) return false;
  }
  return true;
}

// Does the ancestor guide line at `depth` still have a later sibling coming
// (i.e. should the vertical rail continue straight through this row at that
// column), or has that branch already closed?
export function tocGuideContinues(depths, i, depth) {
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return false;
    if (depths[j] === depth) return true;
  }
  return false;
}

// Give every heading in the rendered note a stable slug id, and hand back the
// headings in document order.
//
// Split out of buildNotesToc because a [[Note#heading]] reference has to be
// able to find its target whether or not the table of contents was ever opened
// — and buildNotesToc, which used to be the only thing that assigned these ids,
// returns early when there is no #notesTocList to draw into. Same slugs from
// both callers, because it is the same code.
// ── The list comes from the SOURCE, not from the rendered DOM ──────────────
//
// This used to be `el.notesView.querySelectorAll("h1, h2, h3, h4, h5, h6")`,
// which makes the contents of a note a function of how far its render has got.
// That was already the wrong shape — the drawer of a big note was short or empty
// until the last block landed — and it is flatly incompatible with a note whose
// spans are built as the reader approaches them (see the viewport-driven
// rendering note in render/block-cache.js), where most of the book is
// deliberately not in the DOM at all.
//
// So the headings are scanned out of the same PREPARED string the view was
// rendered from (scanPreparedHeadings), and each one is a small descriptor
// rather than an element:
//
//   { level, text, offset, id, el }
//
// `offset` is a character position in that prepared string, which is what lets
// a heading say which chunk it belongs to before that chunk exists; `el` is
// filled in when the chunk holding it is built, and is null until then. Every
// consumer below reads `.level`/`.text`/`.id` where it used to read
// `.tagName`/`.textContent`/`.id`, and anything wanting geometry goes through
// notesHeadingBox / resolveNotesHeadingElement, which know how to answer for a
// heading whose block is not built yet.
export let notesHeadingSource = null;

export let notesHeadingList = [];

// The prepared markdown the notes view is currently showing. The block cache
// records it as part of the render, so this costs nothing and — unlike
// re-deriving it from state.notes — is guaranteed to be the exact string the
// headings on screen came from.
export function preparedNotesSource() {
  const cached = el.notesView ? renderedBlockCache.get(el.notesView) : null;
  return typeof cached?.prepared === "string" ? cached.prepared : null;
}

export function notesHeadingsForPrepared(prepared) {
  if (prepared === notesHeadingSource) return notesHeadingList;
  const used = new Set();
  notesHeadingList = notesHeadingScan(prepared).map((entry) => ({
    level: entry.level,
    text: entry.text,
    offset: entry.offset,
    id: slugifyHeading(entry.text, used),
    el: null
  }));
  notesHeadingSource = prepared;
  return notesHeadingList;
}

// First index whose offset is at or after `from`. The list is in document
// order, so a binary search keeps per-span binding off the O(headings x spans)
// path a filter would put it on.
export function firstNotesHeadingAtOrAfter(headings, from) {
  let lo = 0;
  let hi = headings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].offset < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Pair the descriptors covering [from, to) with the rendered headings inside
// `root`, in document order, and give each element its descriptor's id.
//
// Called once per span as that span is built, and once over the whole surface
// for an ordinary (eagerly rendered) note. Pairing positionally within a span
// is what keeps it O(what was just built); a count mismatch binds the common
// prefix and leaves the rest unbound, where a jump still lands on the right
// chunk — a degraded answer rather than a wrong one.
export function bindNotesHeadingElements(container, from = null, to = null, root = null) {
  if (!container || container !== el.notesView) return;
  const prepared = preparedNotesSource();
  if (prepared == null) return;
  const headings = notesHeadingsForPrepared(prepared);
  if (!headings.length) return;
  const scope = root || container;
  const nodes = Array.from(scope.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((h) => h.textContent.trim() !== "");
  const start = from == null ? 0 : firstNotesHeadingAtOrAfter(headings, from);
  for (let i = 0; i < nodes.length; i += 1) {
    const heading = headings[start + i];
    if (!heading) break;
    if (to != null && heading.offset >= to) break;
    heading.el = nodes[i];
    nodes[i].id = heading.id;
  }
}

// Every heading in the note, whether or not its block has been built. Kept
// under its old name because it is still what the callers want — "the headings,
// with stable ids" — and it still assigns those ids to whatever is on screen.
export function ensureNotesHeadingIds() {
  if (!el.notesView) return [];
  const prepared = preparedNotesSource();
  // No render has happened on this surface yet (or it fell back to the
  // unsplittable whole-document path, which writes no cache entry). Then the
  // DOM is all there is, and it is complete by definition.
  if (prepared == null) {
    const used = new Set();
    return Array.from(el.notesView.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter((h) => h.textContent.trim() !== "")
      .map((node) => {
        if (!node.id) node.id = slugifyHeading(node.textContent, used);
        else used.add(node.id);
        return { level: Number(node.tagName[1]), text: node.textContent.trim(), offset: null, id: node.id, el: node };
      });
  }
  const headings = notesHeadingsForPrepared(prepared);
  bindNotesHeadingElements(el.notesView);
  return headings;
}

// The element for a heading, building the chunk it lives in if that is what it
// takes. THE way to turn a contents row into something with geometry.
export function resolveNotesHeadingElement(heading) {
  if (!heading) return null;
  if (heading.el?.isConnected) return heading.el;
  if (Number.isFinite(heading.offset) && el.notesView) {
    ensureNotesLazyOffsetBuilt(el.notesView, heading.offset);
    if (heading.el?.isConnected) return heading.el;
    bindNotesHeadingElements(el.notesView);
  }
  return heading.el?.isConnected ? heading.el : null;
}

// Roughly where a heading sits on the glass, WITHOUT forcing anything to be
// built: its own box once its block exists, and an interpolated position inside
// its standing-in chunk until then (see notesLazyTopAtOffset). Both are
// monotonic in document order, which is all the scroll-spy's binary search
// needs, and neither costs a layout of anything that was not already laid out.
export function notesHeadingTop(heading) {
  if (heading?.el?.isConnected) return heading.el.getBoundingClientRect().top;
  if (!Number.isFinite(heading?.offset)) return null;
  return notesLazyTopAtOffset(el.notesView, heading.offset);
}

// The brief highlight a jump leaves on its target. Here rather than at each
// call site because a heading is a descriptor now, and two callers used to
// reach straight for its classList.
export function flashNotesHeading(heading) {
  const node = heading?.el?.isConnected ? heading.el : null;
  if (!node) return;
  node.classList.add("notes-heading-flash");
  setTimeout(() => node.classList.remove("notes-heading-flash"), 1200);
}

// When a whole folder is open as one document, each member deck is introduced
// by a generated `# <Deck title>` heading and every heading below it belongs to
// that deck. Nothing in the rendered DOM says so: the `<!-- recall-section -->`
// marker that carries the deck id in the markdown is a comment, and DOMPurify
// strips comments — which is exactly what keeps it invisible while reading, and
// exactly why it cannot be used here.
//
// So the section starts are found by matching the generated headings against
// the member titles, in order. Each section is then renormalised on its own:
// its heading is depth 0, and the headings inside it start at depth 1 no matter
// what level they use. Without this a deck whose own notes begin at `#` — quite
// normal — put its headings at the same depth as the deck titles, so folding a
// deck away left its own sections behind.
export function applyFolderSectionDepths(depths) {
  const members = state.folderDeck?.members;
  if (!members?.length || !depths.length) return;

  const starts = [];
  let expect = 0;
  notesTocHeadings.forEach((heading, index) => {
    if (expect >= members.length) return;
    if (heading.level !== 1) return;
    if (heading.text !== String(members[expect].title || "").trim()) return;
    starts.push(index);
    expect += 1;
  });
  if (!starts.length) return;

  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : depths.length;
    depths[start] = 0;
    let inner = 6;
    for (let i = start + 1; i < end; i += 1) inner = Math.min(inner, notesTocHeadings[i].level);
    for (let i = start + 1; i < end; i += 1) {
      depths[i] = 1 + Math.min(notesTocHeadings[i].level - inner, 3);
    }
  });
}

// Is any ancestor of `index` folded? Walks the parent chain rather than
// consulting a per-row flag, so folding a branch needs no bookkeeping on the
// rows below it.
export function isNotesTocRowHidden(index) {
  for (let p = notesTocParent[index]; p >= 0; p = notesTocParent[p]) {
    if (notesTocCollapsed.has(notesTocHeadings[p]?.id)) return true;
  }
  return false;
}

export function applyNotesTocFolding() {
  notesTocItems.forEach((li, index) => {
    if (!li) return;
    li.hidden = isNotesTocRowHidden(index);
    if (!notesTocBranch[index]) return;
    const collapsed = notesTocCollapsed.has(notesTocHeadings[index]?.id);
    li.dataset.tocCollapsed = collapsed ? "true" : "false";
    const twisty = li.querySelector(".notes-toc-twisty");
    if (twisty) {
      twisty.setAttribute("aria-expanded", collapsed ? "false" : "true");
      twisty.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${notesTocHeadings[index]?.text || "section"}`);
    }
  });
  // The row that was lit may have just been folded away, or revealed, so the
  // scroll-spy has to pick again from scratch. Clearing the class from every
  // link first is what makes that safe: updateNotesTocActive un-lights
  // `notesTocLinks[notesTocActiveIndex]`, and resetting the index to -1 without
  // this leaves the previously-lit row lit forever — two rows highlighted at
  // once, with the stale one usually winning any querySelector.
  notesTocLinks.forEach((link) => {
    link.classList.remove("is-active");
    link.removeAttribute("aria-current");
  });
  notesTocActiveIndex = -1;
  updateNotesTocActive();
}

export function setNotesTocBranchCollapsed(index, collapsed) {
  const slug = notesTocHeadings[index]?.id;
  if (!slug || !notesTocBranch[index]) return;
  if (collapsed) notesTocCollapsed.add(slug);
  else notesTocCollapsed.delete(slug);
  applyNotesTocFolding();
}

export function toggleNotesTocBranch(index) {
  setNotesTocBranchCollapsed(index, !notesTocCollapsed.has(notesTocHeadings[index]?.id));
}

export function setAllNotesTocBranches(collapsed) {
  notesTocCollapsed = new Set();
  if (collapsed) {
    notesTocHeadings.forEach((heading, index) => {
      if (notesTocBranch[index]) notesTocCollapsed.add(heading.id);
    });
  }
  applyNotesTocFolding();
  updateNotesTocFoldAllButton();
}

export function allNotesTocBranchesCollapsed() {
  return notesTocBranch.every((isBranch, index) => !isBranch || notesTocCollapsed.has(notesTocHeadings[index]?.id));
}

export function updateNotesTocFoldAllButton() {
  // Looked up here rather than added to the `el` map, which is one big object
  // literal shared by the whole app: a new module's own elements do not need to
  // be in it, and keeping them out keeps that file the pre-split one.
  const button = document.getElementById("notesTocFoldAllBtn");
  if (!button) return;
  const anyBranch = notesTocBranch.some(Boolean);
  button.hidden = !anyBranch;
  if (!anyBranch) return;
  const collapsed = allNotesTocBranchesCollapsed();
  button.textContent = collapsed ? "⊞" : "⊟";
  button.title = collapsed ? "Expand all sections" : "Collapse all sections";
  button.setAttribute("aria-label", button.title);
}

// One delegated listener for the whole list, however many thousand rows it has.
export function initNotesTocFolding() {
  el.notesTocList?.addEventListener("click", (event) => {
    const twisty = event.target.closest(".notes-toc-twisty");
    if (!twisty) return;
    // Stopped as well as prevented: the row's own click handler (which jumps to
    // the heading) is on the same list, and the twisty sits ON TOP of the <a>.
    event.preventDefault();
    event.stopPropagation();
    toggleNotesTocBranch(Number(twisty.dataset.tocIndex));
    updateNotesTocFoldAllButton();
  });
  const foldAll = document.getElementById("notesTocFoldAllBtn");
  foldAll?.addEventListener("click", () => { setAllNotesTocBranches(!allNotesTocBranchesCollapsed()); });
}

export function buildNotesToc() {
  if (!el.notesView || !el.notesTocList) return;
  notesTocDirty = false;
  notesTocHeadings = ensureNotesHeadingIds();

  el.notesTocList.innerHTML = "";
  notesTocItems = [];
  notesTocParent = [];
  notesTocBranch = [];
  // The list is being rebuilt, so every link reference updateNotesTocActive
  // held is now detached and the remembered active row means nothing.
  notesTocLinks = [];
  notesTocActiveIndex = -1;
  const hasHeadings = notesTocHeadings.length > 0;
  if (el.notesTocEmpty) el.notesTocEmpty.hidden = hasHeadings;
  el.notesTocList.hidden = !hasHeadings;

  if (!hasHeadings) {
    if (el.notesTocDrawer && !el.notesTocDrawer.hidden) closeNotesToc();
    if (el.notesTocBtn) el.notesTocBtn.classList.remove("has-toc");
    return;
  }
  if (el.notesTocBtn) el.notesTocBtn.classList.add("has-toc");

  // Normalise the shallowest heading level to depth 0 so notes that start at
  // ## still indent from the left edge rather than looking pushed-in.
  const minLevel = notesTocHeadings.reduce((min, h) => Math.min(min, h.level), 6);
  const depths = notesTocHeadings.map((h) => Math.min(h.level - minLevel, 4));
  applyFolderSectionDepths(depths);

  // The relation the flat list does not carry. A heading's parent is the
  // nearest earlier heading shallower than it; a heading is a branch when the
  // very next one is deeper, which is the only way a child can begin.
  const openAtDepth = [];
  notesTocParent = depths.map((depth, index) => {
    openAtDepth.length = depth;
    // Walks DOWN for the nearest open ancestor rather than reading depth-1
    // directly: depths are not guaranteed contiguous — a note that goes from #
    // straight to ###, or a folder section whose decks nest differently from
    // one another, leaves a hole, and a hole read as "no parent" would make a
    // heading unfoldable from the section above it.
    let parent = -1;
    for (let d = depth - 1; d >= 0; d -= 1) {
      if (openAtDepth[d] !== undefined) { parent = openAtDepth[d]; break; }
    }
    openAtDepth[depth] = index;
    return parent;
  });
  notesTocBranch = depths.map((depth, index) => index + 1 < depths.length && depths[index + 1] > depth);

  // Fold state, carried over by slug. Anything not seen before is folded, so a
  // note opens as its top-level outline; pruning to the current note's slugs is
  // what makes a different note start folded again.
  const nextKnown = new Set();
  const nextCollapsed = new Set();
  notesTocHeadings.forEach((heading, index) => {
    if (!notesTocBranch[index]) return;
    nextKnown.add(heading.id);
    if (!notesTocKnownBranches.has(heading.id) || notesTocCollapsed.has(heading.id)) nextCollapsed.add(heading.id);
  });
  notesTocKnownBranches = nextKnown;
  notesTocCollapsed = nextCollapsed;

  notesTocHeadings.forEach((heading, index) => {
    // Ids are already assigned by ensureNotesHeadingIds above.
    const level = heading.level;
    const depth = depths[index];

    const li = document.createElement("li");
    li.className = "notes-toc-item";
    // The twisty is positioned against the row, at this row's own indent, so
    // the depth has to be readable from the <li> as well as from the link.
    li.style.setProperty("--toc-depth", String(depth));
    const link = document.createElement("a");
    link.className = "notes-toc-link";
    link.href = `#${heading.id}`;
    link.dataset.tocIndex = String(index);
    link.style.setProperty("--toc-depth", String(depth));

    // Tree rail: one column per ancestor level, plus an elbow connecting up
    // to the parent chain and across to this item's dot — the last column
    // is a "├" (more siblings follow) or "└" (last child) elbow, columns
    // before it are plain vertical guides that only continue if that
    // ancestor branch still has more siblings coming later in the list.
    let rail = "";
    for (let d = 0; d < depth; d++) {
      if (d === depth - 1) {
        rail += `<span class="notes-toc-elbow" data-last="${tocIsLastSibling(depths, index)}"></span>`;
      } else {
        // Column d represents the ancestor ONE level below it (d+1) — e.g.
        // column 0 for a depth-3 item is its grandparent's level (depth 1),
        // not the root's (depth 0); the root gets no column of its own since
        // depth-0 headings never get a rail at all.
        rail += `<span class="notes-toc-guide" data-state="${tocGuideContinues(depths, index, d + 1) ? "line" : "blank"}"></span>`;
      }
    }

    link.innerHTML =
      (rail ? `<span class="notes-toc-rail" aria-hidden="true">${rail}</span>` : "") +
      `<span class="notes-toc-dot" data-level="${level}"></span>` +
      `<span class="notes-toc-text"></span>`;
    link.querySelector(".notes-toc-text").textContent = heading.text;
    li.appendChild(link);

    // A <button> cannot live inside the <a> — nesting interactive content is
    // invalid and browsers reparent it out of the link, which in a list built
    // with innerHTML lands it somewhere unpredictable. It is a SIBLING of the
    // link, laid over the dot cell, and the row keeps working as one big target
    // everywhere the twisty is not.
    if (notesTocBranch[index]) {
      li.classList.add("is-branch");
      const twisty = document.createElement("button");
      twisty.type = "button";
      twisty.className = "notes-toc-twisty";
      twisty.dataset.tocIndex = String(index);
      twisty.innerHTML = '<span class="notes-toc-twisty-glyph" aria-hidden="true">▸</span>';
      li.appendChild(twisty);
    }

    el.notesTocList.appendChild(li);
    notesTocLinks.push(link);
    notesTocItems.push(li);
  });

  applyNotesTocFolding();
  updateNotesTocFoldAllButton();
}

// Distance kept between the top of the notes viewport and the heading it
// scrolled to.
export const NOTES_HEADING_SCROLL_GAP = 8;

// Measured with the heading's CHUNK forced to lay out. On a chunked note the
// containment sits on the wrapper, so a heading inside a skipped chunk answers
// with its chunk's box — the same answer all 40 of its neighbours give, which is
// a jump landing up to 40 blocks early.
export function notesHeadingOffset(heading) {
  const node = heading?.el?.isConnected ? heading.el : null;
  if (!node) return 0;
  return withChunkRendered(node, el.notesView, () =>
    node.getBoundingClientRect().top - el.notesView.getBoundingClientRect().top);
}

// How long we are willing to keep correcting. Longer than the anchor jump's
// budget (NOTE_JUMP_BUDGET_MS): a heading jump usually crosses the whole note,
// so there is more unrealised height between here and there to settle.
const HEADING_AIM_BUDGET_MS = 1500;

// It used to be six tries at a flat 130ms — on a big note the corrections were
// still moving when that ran out, and it simply stopped wherever it had got to,
// which is what "the TOC takes me to the wrong place" looked like. The
// convergence loop that replaced it now lives in anchors.js, shared with the
// anchor/highlight jump, which had exactly the same problem for exactly the same
// reasons; all that differs is what counts as "arrived", which is the callback.
export async function scrollNotesHeadingIntoView(heading) {
  if (!heading || !el.notesView) return;
  // The reader asked to go here, so this is exactly the case that may not wait
  // for a scroll to bring the span into view: build it now. A no-op on an
  // eagerly rendered note, and on a heading whose span is already built.
  const node = resolveNotesHeadingElement(heading);
  if (!node) return;
  // Paged mode: turn to the heading's page. Handled by revealInPagedNotes, which
  // has its own convergence loop over PAGES rather than heights.
  if (revealInPagedNotes(node)) return;
  await convergeNotesScroll(
    () => (node.isConnected ? notesHeadingOffset(heading) - NOTES_HEADING_SCROLL_GAP : null),
    HEADING_AIM_BUDGET_MS
  );
}

// Raw-mode counterpart of scrollNotesHeadingIntoView: the rendered notes view is
// hidden while editing, so a TOC click must scroll the textarea instead. The Nth
// TOC entry is the Nth ATX heading in source order (rendering preserves order and
// count), so walk the raw lines — skipping fenced code, where a leading # isn't a
// heading — to the Nth heading and drop the caret on that line.
export function scrollNotesEditToHeadingIndex(index) {
  const textarea = el.notesEdit;
  if (!textarea) return;
  const lines = textarea.value.split("\n");
  let inFence = false;
  let fenceChar = "";
  let count = -1;
  let targetLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+\S/.test(line)) {
      count += 1;
      if (count === index) { targetLine = i; break; }
    }
  }
  if (targetLine < 0) return;
  const pos = lines.slice(0, targetLine).reduce((n, l) => n + l.length + 1, 0);
  // Caret before focus, then the shared reveal — same path as opening the editor
  // from the rendered view, so a raw-mode TOC jump gets the same exact
  // measurement and the same arrival band. (revealNotesCaretAt also nudges the
  // highlight backdrop, the workaround this call site used to carry alone.)
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
  revealNotesCaretAt(pos, { flash: true });
}

// ── Why this is gated, and searched rather than swept ──────────────────────
// This runs on the notes scroll, so it is on the hot path of every frame of
// every scroll. Two things made it the largest single cost there:
//
//   1. It ran whether or not the TOC drawer was open — and the drawer is closed
//      almost all the time. The work was invisible by construction.
//   2. getBoundingClientRect() on a heading inside a `content-visibility: auto`
//      block FORCES that block to lay out. Sweeping EVERY heading in the note
//      therefore un-skipped the whole document, 60 times a second, defeating
//      the point of the content-visibility rule in styles.css (and of the
//      deferred-work machinery built around it).
//
// Headings are in document order, so "the last one at or above the mark" is a
// binary search: ~9 rect reads on a 500-heading chapter instead of 500. Rects
// (not offsetTop) are kept deliberately — .notes-rendered is not positioned, so
// offsetTop would be measured against some ancestor and would not answer the
// question being asked here. The links are captured once when the list is built
// rather than re-queried per frame, and only the two that change are touched.
export function isNotesTocOpen() {
  return Boolean(el.notesTocDrawer?.classList.contains("is-open"));
}

export function updateNotesTocActive() {
  if (!el.notesTocList) return;
  // Closed drawer: nothing to show, so nothing to compute. openNotesToc() calls
  // this on the way open, so it still lands on the right entry.
  if (!isNotesTocOpen()) return;
  // An open drawer over a stale list is a list of detached nodes — every link
  // this would light belongs to a note that is no longer on screen.
  ensureNotesTocBuilt();
  if (!notesTocHeadings.length) return;

  // The active section is the last heading whose top has scrolled to (or above)
  // a line a little below the viewport top — or, in paged mode, the last one
  // whose page is at or before the page being read. Same "last one at or above
  // the mark" question, asked of a different axis.
  const paged = isNotesPaged();
  const page = paged ? notesCurrentPage() : 0;
  const mark = el.notesView.getBoundingClientRect().top + 24;
  // ── Paged mode asks the question in TWO parts ────────────────────────────
  //
  // Paging is per CHAPTER: only the active chapter is laid out and the rest are
  // display:none, so a heading outside it has no box at all and
  // notesPageForElement answers with whatever page the current scrollLeft
  // happens to be on. "page <= current page" was therefore TRUE for every
  // heading in every chapter the reader had not reached — the search below ran
  // straight off the end of the book and lit its last heading. Measured on a
  // 60-chapter fixture: reading chapter 37, the contents lit "Chapter 60", and
  // it did that on every multi-chapter note.
  //
  // Chapter index first (monotonic in document order, and knowable without a
  // box), page only within the chapter being read.
  const chapterOf = new Map();
  if (paged) {
    Array.from(el.notesView.querySelectorAll(`:scope > .${NOTES_CHUNK_CLASS}`))
      .forEach((chunk, index) => chapterOf.set(chunk, index));
  }
  const chapterIndexOf = (heading) => {
    const chunk = heading.el?.parentElement?.closest(`.${NOTES_CHUNK_CLASS}`);
    const found = chunk ? chapterOf.get(chunk) : undefined;
    return found === undefined ? activeChapterIndex : found;
  };
  const atOrAbove = (index) => {
    const heading = notesTocHeadings[index];
    if (!paged) {
      // Deliberately a bare rect, with no withChunkRendered: the chunk holding
      // the reading line is on screen and therefore laid out, so its headings
      // answer honestly, and the chunks either side of it answer with their own
      // (monotonic) boxes — which is all a binary search needs. Forcing chunks
      // to lay out here would cost 40 blocks of layout per probe, on a handler
      // that runs on every scroll frame.
      //
      // notesHeadingBox rather than the element's own rect, because on a
      // viewport-built note a heading whose span has not been built has no
      // element yet — it answers with its CHUNK's box, which is monotonic in
      // document order for exactly the same reason a skipped chunk's is, and is
      // therefore still a sound predicate for the search. Building the span here
      // instead would make every scroll frame render whatever it probed.
      const top = notesHeadingTop(heading);
      return top == null ? false : top <= mark;
    }
    const chapter = chapterIndexOf(heading);
    if (chapter !== activeChapterIndex) return chapter < activeChapterIndex;
    return heading.el ? notesPageForElement(heading.el) <= page : chapter <= activeChapterIndex;
  };
  let low = 0;
  let high = notesTocHeadings.length - 1;
  let activeIndex = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (atOrAbove(mid)) {
      activeIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Folded away? Light the nearest ancestor that IS on screen, the way a file
  // tree lights the folder holding the open file. Deliberately not "unfold the
  // ancestors": that would re-open the tree a branch at a time as you scrolled,
  // which is the opposite of what folding it was for.
  while (activeIndex > 0 && isNotesTocRowHidden(activeIndex)) activeIndex = notesTocParent[activeIndex];

  if (activeIndex === notesTocActiveIndex) return;
  const previous = notesTocLinks[notesTocActiveIndex];
  if (previous) {
    previous.classList.remove("is-active");
    previous.removeAttribute("aria-current");
  }
  const next = notesTocLinks[activeIndex];
  if (next) {
    next.classList.add("is-active");
    next.setAttribute("aria-current", "true");
  }
  notesTocActiveIndex = activeIndex;
}

// Above this width the notes make room for the drawer instead of hiding under
// it. THE one definition — the CSS media query, the click-outside exemption and
// the tap-to-close-after-jump behaviour all have to agree about which mode the
// drawer is in, and three separate copies of "720" would eventually not.
export const TOC_PUSH_MIN_WIDTH = 721;

export function tocPushesNotes() {
  return window.matchMedia(`(min-width: ${TOC_PUSH_MIN_WIDTH}px)`).matches;
}

// Opening or closing a pushing drawer changes the width of the notes column,
// which re-wraps every line and re-estimates every deferred block height (see
// content-visibility on .notes-rendered). Left alone, the reader's place slides
// away under them. Capturing the block on the reading line and putting it back
// afterwards makes the width change look like what it is: the text getting
// narrower, not the note scrolling.
export function preserveNotesReadingPosition(mutate) {
  const view = el.notesView;
  if (!view || view.hidden || !tocPushesNotes()) {
    mutate();
    return;
  }
  const anchor = blockAtNotesReadingLine();
  mutate();
  if (!anchor) return;
  // After layout has settled on the new width — the padding change and the
  // re-measure both land in the next frame, not this one.
  requestAnimationFrame(() => scrollNotesBlockToReadingLine(anchor, false));
}

// The rendered block currently sitting on the reading line, or null.
export function blockAtNotesReadingLine() {
  const view = el.notesView;
  if (!view) return null;
  // Paged mode: the first block on the current page IS what the reader is
  // looking at, and asking elementFromPoint instead would probe the column gap
  // in two-column layouts — where it returns #notesView itself, whose
  // `closest(".notes-rendered > *")` is null, so this returned null every time.
  if (isNotesPaged()) return firstVisibleNotesBlock();
  const rect = view.getBoundingClientRect();
  const y = rect.top + notesReadingLineOffset(rect.height);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
  if (!hit || !view.contains(hit)) return null;
  // NOTES_TOP_LEVEL_SELECTOR, not ".notes-rendered > *": on a long enough note
  // the direct children are chunk wrappers of 40 blocks, and anchoring the
  // reading position on one of those is 40 blocks of slop.
  return hit.closest(NOTES_BLOCK_SELECTOR)?.closest(NOTES_TOP_LEVEL_SELECTOR) || hit.closest(NOTES_TOP_LEVEL_SELECTOR);
}

export function openNotesToc() {
  if (!el.notesTocDrawer) return;
  // Built here rather than on every render — see notesTocDirty. Before the
  // drawer is revealed, so it never opens on a list belonging to another note.
  ensureNotesTocBuilt();
  el.notesTocDrawer.hidden = false;
  // Force reflow so the open transition runs from the hidden state.
  void el.notesTocDrawer.offsetWidth;
  preserveNotesReadingPosition(() => {
    el.notesTocDrawer.classList.add("is-open");
    el.notesStage?.classList.add("is-toc-open");
  });
  el.notesTocBtn?.classList.add("is-active");
  el.notesTocBtn?.setAttribute("aria-expanded", "true");
  updateNotesTocActive();
  // Built only from here, never on render and never on scroll: it reads every
  // deck body in the library, which is far too much work to do speculatively
  // for a panel that is closed almost all of the time.
  renderNotesBacklinks();
}

// ── "Linked from" ───────────────────────────────────────────────────────────
//
// The other half of a reference. Without it a link is one-way, and a note you
// arrived at gives you no idea what it belongs to — which for a note that was
// split out of a longer one is the single most useful thing to know.
//
// Derived by scanning, not stored. A backlinks table would be a second copy of
// something the markdown already says, and every edit anywhere would have to
// keep it honest; a scan cannot disagree with the text.
export async function findBacklinksToOpenNote() {
  const localId = state.localDeckId;
  const deckId = state.deckId;
  const title = String(state.deckTitle || "").trim().toLowerCase();
  if (!localId && !deckId) return [];
  // The open note as the link index sees it, so "does this link point here?"
  // is the same question noteLinkEntryMatchesId answers everywhere else. Links
  // written on another device carry an id only that device minted, and without
  // the alias set every one of them was invisible here — "Linked from" came up
  // empty on exactly the devices where the links themselves looked broken.
  const self = {
    localId,
    deckId,
    aliasIds: readLocalDeckIndex().find((entry) => entry.id === localId)?.linkIds || []
  };

  const hits = [];
  await forEachDeckSnapshot((id, snapshot) => {
    if (id === localId) return; // a note linking to itself isn't a backlink
    const notes = snapshot?.notes || "";
    if (!notes.includes("[[")) return;
    for (const match of notes.matchAll(NOTE_LINK_PATTERN)) {
      const target = parseNoteLinkTarget(match[2] || "");
      // A pipe-less label may carry its own "#Heading" (see resolveNoteLink) —
      // strip it, or "[[This Note#Proof]]" would compare "this note#proof"
      // against the title and never register as a backlink.
      const labelTitle = String(match[1]).split("#")[0].trim().toLowerCase();
      const points = target.id
        ? noteLinkEntryMatchesId(self, target.id)
        // A title-form link only counts when it has no id at all — one that
        // names a different note is not pointing here.
        : (title && labelTitle === title);
      if (points) {
        hits.push({ localId: id, title: snapshot.deckTitle || "Untitled", category: normalizeDeckCategory(snapshot.deckCategory) });
        return;
      }
    }
  });
  return hits.sort((a, b) => a.title.localeCompare(b.title));
}

export let backlinksToken = 0;

// findBacklinksToOpenNote reads every deck body in the library (see its own
// comment) — real work, not "far too much to do speculatively" but also not
// free, and openNotesToc runs it on EVERY open with nothing remembered between
// them. A reader flipping the ☰ drawer open and shut repeatedly while
// navigating a book's chapters — the ordinary way this button gets used — paid
// that full-library scan again each time, which is what "the menu freezes"
// looked like: the drawer itself opens (this call isn't awaited there), but
// the scan then owns the main thread for whatever's tapped next.
//
// Cached per open note (keyed the same way currentNotesParseKey is) and
// reused until a different note opens. Staleness this accepts: a link added to
// SOME OTHER note while this one has stayed open since the last scan won't
// show up until this note is reopened. That's the right trade against a
// multi-second freeze on every tap — the same trade notesTocDirty already
// makes for the heading list itself.
let notesBacklinksCacheKey = null;

let notesBacklinksCache = null;

function paintNotesBacklinks(section, list, hits) {
  list.innerHTML = "";
  if (!hits.length) {
    section.hidden = true;
    return;
  }
  for (const hit of hits) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notes-backlink";
    button.innerHTML = `<span class="notes-backlink-title"></span><span class="notes-backlink-path"></span>`;
    button.querySelector(".notes-backlink-title").textContent = hit.title;
    button.querySelector(".notes-backlink-path").textContent = hit.category;
    button.addEventListener("click", async () => {
      closeNotesToc();
      await loadDeckFromLibrary(hit.localId);
    });
    li.appendChild(button);
    list.appendChild(li);
  }
  section.hidden = false;
}

export async function renderNotesBacklinks() {
  const section = el.notesBacklinks;
  const list = el.notesBacklinksList;
  if (!section || !list) return;

  const key = `${state.localDeckId || ""}:${state.deckId || ""}`;
  if (key === notesBacklinksCacheKey && notesBacklinksCache) {
    paintNotesBacklinks(section, list, notesBacklinksCache);
    return;
  }

  // Opening the drawer, switching decks and opening it again can overlap; only
  // the newest request may write to the list or the cache.
  const token = ++backlinksToken;
  list.innerHTML = "";
  section.hidden = true;

  let hits = [];
  try {
    hits = await findBacklinksToOpenNote();
  } catch (error) {
    console.warn("Could not work out backlinks", error);
    return;
  }
  if (token !== backlinksToken) return;
  notesBacklinksCacheKey = key;
  notesBacklinksCache = hits;
  paintNotesBacklinks(section, list, hits);
}

export function closeNotesToc() {
  if (!el.notesTocDrawer) return;
  preserveNotesReadingPosition(() => {
    el.notesTocDrawer.classList.remove("is-open");
    el.notesStage?.classList.remove("is-toc-open");
  });
  el.notesTocBtn?.classList.remove("is-active");
  el.notesTocBtn?.setAttribute("aria-expanded", "false");
  const drawer = el.notesTocDrawer;
  // Torn down explicitly rather than with { once: true }, which only removes the
  // listener if the event actually FIRES — and the whole reason for the timeout
  // below is that it often doesn't (reduced motion, or a drawer that was already
  // closed). On those devices every close left another listener on an element
  // that is never recreated, so they accumulated for the whole session and then
  // all ran on every unrelated transition on the drawer.
  let timer = 0;
  const hideAfter = () => {
    drawer.removeEventListener("transitionend", hideAfter);
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!drawer.classList.contains("is-open")) drawer.hidden = true;
  };
  drawer.addEventListener("transitionend", hideAfter);
  // Fallback in case the transition never fires (e.g. reduced motion).
  timer = setTimeout(hideAfter, 260);
}

export function toggleNotesToc() {
  if (el.notesTocDrawer?.classList.contains("is-open")) closeNotesToc();
  else openNotesToc();
}
