// The notes table of contents, and the backlinks panel beside it.
//
// Heading ids are assigned lazily, on first use — a note can hold thousands of
// headings and slugifying them all on every render is wasted work.

import { el } from "../core/dom.js?v=__BUILD__";
import { drawerSection, refreshDrawerOnOpen } from "../panels/drawer-highlights.js?v=__BUILD__";
import { TOC_TWISTY_CLASS, tocBranchesFromDepths, tocCarryFolds, tocDepthsFromLevels, tocPaintFoldAll, tocPaintFolding, tocParentsFromDepths, tocRowFor, tocRowIsHidden } from "./toc-tree.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { convergeNotesScroll, scrollNotesBlockToReadingLine } from "./anchors.js?v=__BUILD__";
import { revealNotesCaretAt } from "./caret-line.js?v=__BUILD__";
import { parseNoteLinkTarget } from "./note-links.js?v=__BUILD__";
import { activeChapterIndex, firstVisibleNotesBlock, isNotesPaged, notesCurrentPage, notesPageForElement, revealInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
import { MARK_BADGE_CLASS } from "./highlight-badges.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, NOTES_CHUNK_PENDING_CLASS, NOTES_TOP_LEVEL_SELECTOR, ensureNotesLazyOffsetBuilt, notesHeadingScan, notesLazyPlan, notesLazyTopAtOffset, renderedBlockCache, scanPreparedHeadings, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
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

// What a rendered heading SAYS, for comparison against a descriptor's `text`.
//
// The badge a highlight's note hangs on its mark is a button printed into the
// text (src/notes/highlight-badges.js) and is not part of what the heading says
// — the same exception the selection walk makes at src/notes/selection.js:563,
// and for the same reason: a number that came from the machine must not change
// what a line is compared as.
export function renderedHeadingText(node) {
  let text = "";
  for (const child of node?.childNodes || []) {
    if (child.nodeType === 1 && child.classList?.contains(MARK_BADGE_CLASS)) continue;
    text += child.textContent || "";
  }
  return text.replace(/\s+/g, " ").trim();
}

// Does this rendered heading say what this descriptor says? Level and text are
// the two things each side can answer without consulting the other, and
// plainHeadingText exists precisely so the scanner's answer is the one the DOM
// will produce.
export function notesHeadingMatchesNode(heading, node) {
  if (!heading || !node) return false;
  if (heading.level !== Number(node.tagName[1])) return false;
  return heading.text === renderedHeadingText(node);
}

// How far either side may be out of step before the pairing stops trying to
// resynchronise and falls back to position. Deliberately small: this is for the
// one heading the other side does not have, not for re-deriving the list.
export const NOTES_HEADING_RESYNC_LOOKAHEAD = 4;

// Pair the descriptors covering [from, to) with the rendered headings inside
// `root`, in document order, and give each element its descriptor's id.
//
// Called once per span as that span is built, and once over the whole surface
// for an ordinary (eagerly rendered) note.
//
// ── Why this is not simply "the Nth element is the Nth descriptor" ─────────
//
// It was, and that is what "the contents takes me to the wrong heading" was.
// The descriptors come from a scan of the SOURCE and the elements come from
// marked, and the two do not always agree about how many headings a note has:
//
//   • `- ## thing` renders as a heading and is deliberately NOT in the contents
//     (see the heading-index property in tools/viewport-split-check.mjs), and a
//     raw `<h2>` in an HTML block is not in the scan either — the DOM has one
//     the descriptors do not, so every row after it named the heading BEFORE it
//     and the last rows named nothing at all;
//   • the reverse used to happen too, for a `- foo` / `---` pair and for a
//     commented-out section (both fixed in scanPreparedHeadings, both still
//     possible for a shape nobody has thought of yet).
//
// So position is the expectation, not the rule. Each element is checked against
// the descriptor it would have taken, and a disagreement is resynchronised —
// look ahead a few descriptors for one this element matches (the DOM is missing
// some) and a few elements for one the descriptor matches (the DOM has extra).
// When neither side can resync, the two are paired positionally anyway, which
// is exactly what this did before and is the right answer for a heading whose
// text simply does not round-trip.
export function bindNotesHeadingElements(container, from = null, to = null, root = null) {
  if (!container || container !== el.notesView) return;
  const prepared = preparedNotesSource();
  if (prepared == null) return;
  const headings = notesHeadingsForPrepared(prepared);
  if (!headings.length) return;
  const scope = root || container;
  const nodes = Array.from(scope.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((h) => h.textContent.trim() !== "")
    // A heading inside a list item is one the contents does not carry, so it
    // has no descriptor to take and must not consume the next one.
    .filter((h) => !h.closest("li"))
    // ...and a chunk that has not been built yet holds nothing, so anything
    // found inside one is not this note's rendered heading.
    .filter((h) => !h.closest(`.${NOTES_CHUNK_PENDING_CLASS}`));
  let at = from == null ? 0 : firstNotesHeadingAtOrAfter(headings, from);
  const within = (index) => {
    const heading = headings[index];
    return Boolean(heading) && (to == null || heading.offset < to);
  };
  for (let i = 0; i < nodes.length; i += 1) {
    if (!within(at)) break;
    const node = nodes[i];
    let target = at;
    if (!notesHeadingMatchesNode(headings[at], node)) {
      // The DOM is missing headings the scan has: is one of the next few
      // descriptors this element?
      let ahead = -1;
      for (let d = at + 1; d <= at + NOTES_HEADING_RESYNC_LOOKAHEAD && within(d); d += 1) {
        if (notesHeadingMatchesNode(headings[d], node)) { ahead = d; break; }
      }
      // The DOM has headings the scan does not: is one of the next few elements
      // this descriptor? Then THIS element is the extra one — skip it and leave
      // the descriptor where it is.
      let extra = false;
      for (let n = i + 1; n <= i + NOTES_HEADING_RESYNC_LOOKAHEAD && n < nodes.length; n += 1) {
        if (notesHeadingMatchesNode(headings[at], nodes[n])) { extra = true; break; }
      }
      if (ahead !== -1 && (!extra || ahead - at <= 1)) target = ahead;
      else if (extra) continue;
    }
    headings[target].el = node;
    node.id = headings[target].id;
    at = target + 1;
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
  bindNotesHeadingsAcrossView(el.notesView);
  return headings;
}

// Bind every heading the surface currently holds — SPAN BY SPAN when the note is
// one that is built as it is read.
//
// A whole-view pass over such a note was the largest single source of "the
// contents takes me to the wrong heading". Only some spans are in the DOM (a
// resumed reading position builds exactly one, in the middle of the book), and
// the pass began at descriptor 0 regardless — so the headings of a span
// nineteen chapters in were paired with the descriptors for chapter one, and
// because buildNotesToc runs this on every rebuild it also OVERWROTE the correct
// pairings each span made as it was built.
//
// Per span, each range of descriptors meets only the elements actually rendered
// from it, which is the same call buildNotesLazySpan already makes. The
// whole-view call is kept for an eagerly rendered note, where it is complete by
// construction.
export function bindNotesHeadingsAcrossView(container) {
  const plan = notesLazyPlan(container);
  if (!plan?.spans?.length) {
    bindNotesHeadingElements(container);
    return;
  }
  plan.spans.forEach((span, index) => {
    const chunk = plan.chunks?.[index];
    if (!chunk?.isConnected || !plan.built?.[index]) return;
    bindNotesHeadingElements(container, span.start, span.end, chunk);
  });
}

// The element for a heading, building the chunk it lives in if that is what it
// takes. THE way to turn a contents row into something with geometry.
//
// The cached element is CHECKED rather than trusted. A pairing that went wrong
// leaves a live element on the descriptor, and a live element short-circuited
// everything below it — so the one path that could have recovered (build the
// span this heading's offset falls in, then pair again) was never reached, and
// the wrong heading was returned for as long as the note stayed open. The id is
// what the pairing writes, so comparing it is asking the element whether it
// agrees that it is this heading, and it costs one string compare.
export function resolveNotesHeadingElement(heading) {
  if (!heading) return null;
  const cached = (node) => (node?.isConnected && node.id === heading.id ? node : null);
  if (cached(heading.el)) return heading.el;
  if (Number.isFinite(heading.offset) && el.notesView) {
    ensureNotesLazyOffsetBuilt(el.notesView, heading.offset);
    if (cached(heading.el)) return heading.el;
    bindNotesHeadingsAcrossView(el.notesView);
  }
  return cached(heading.el);
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

// Is any ancestor of `index` folded? The walk itself is src/notes/toc-tree.js —
// this is the notes list's own keys handed to it.
export function isNotesTocRowHidden(index) {
  return tocRowIsHidden(notesTocParent, notesTocHeadings.map((h) => h?.id), notesTocCollapsed, index);
}

export function applyNotesTocFolding() {
  tocPaintFolding({
    items: notesTocItems,
    keys: notesTocHeadings.map((heading) => heading?.id),
    parents: notesTocParent,
    branches: notesTocBranch,
    collapsed: notesTocCollapsed
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
  tocPaintFoldAll(button, {
    anyBranch: notesTocBranch.some(Boolean),
    allCollapsed: allNotesTocBranchesCollapsed()
  });
}

// One delegated listener for the whole list, however many thousand rows it has.
export function initNotesTocFolding() {
  el.notesTocList?.addEventListener("click", (event) => {
    const twisty = event.target.closest(`.${TOC_TWISTY_CLASS}`);
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
  const depths = tocDepthsFromLevels(notesTocHeadings.map((h) => h.level));
  applyFolderSectionDepths(depths);

  // The relation the flat list does not carry — see src/notes/toc-tree.js,
  // which the document contents builds its own tree with too.
  notesTocParent = tocParentsFromDepths(depths);
  notesTocBranch = tocBranchesFromDepths(depths);

  // Fold state, carried over by slug. Anything not seen before is folded, so a
  // note opens as its top-level outline; pruning to the current note's slugs is
  // what makes a different note start folded again.
  const carried = tocCarryFolds({
    keys: notesTocHeadings.map((heading) => heading.id),
    branches: notesTocBranch,
    known: notesTocKnownBranches,
    collapsed: notesTocCollapsed
  });
  notesTocKnownBranches = carried.known;
  notesTocCollapsed = carried.collapsed;

  notesTocHeadings.forEach((heading, index) => {
    // Ids are already assigned by ensureNotesHeadingIds above. The row itself —
    // rail, dot, text, twisty — is src/notes/toc-tree.js, so this list and the
    // document's cannot drift apart. `href` is what makes these <a>s: a heading
    // in a note has a real anchor to be middle-clicked to, where a PDF page has
    // none.
    const { li, link } = tocRowFor({
      index,
      depth: depths[index],
      depths,
      level: heading.level,
      text: heading.text,
      href: `#${heading.id}`,
      branch: notesTocBranch[index]
    });
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
//
// `null`, not 0, when there is no element to measure. This is the residual the
// convergence loop aims at, and null is how that loop is told the target has
// stopped being measurable and it should stand down (see convergeNotesScroll).
// Answering 0 made the residual `0 - NOTES_HEADING_SCROLL_GAP`, so a jump whose
// target was replaced by a re-render mid-flight scrolled the reader UP eight
// pixels and then stalled — which from the outside is a contents row that does
// nothing at all.
export function notesHeadingOffset(heading) {
  const node = heading?.el?.isConnected ? heading.el : null;
  if (!node) return null;
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
// The descriptor for a slug, re-derived from whatever the note is NOW.
//
// A descriptor is not a durable handle: every render mints a fresh list with
// every `el` reset (notesHeadingsForPrepared), so one captured before an await
// is orphaned the moment a render lands — pointing at an element that has been
// replaced and carrying an offset into a string that is no longer the note. The
// SLUG survives, because it is derived from the heading's own text.
export function notesHeadingById(id) {
  if (!id) return null;
  const prepared = preparedNotesSource();
  if (prepared == null) return null;
  return notesHeadingsForPrepared(prepared).find((heading) => heading.id === id) || null;
}

export async function scrollNotesHeadingIntoView(heading) {
  if (!heading || !el.notesView) return null;
  // The reader asked to go here, so this is exactly the case that may not wait
  // for a scroll to bring the span into view: build it now. A no-op on an
  // eagerly rendered note, and on a heading whose span is already built.
  if (!resolveNotesHeadingElement(heading)) return null;
  // Paged mode: turn to the heading's page. Handled by revealInPagedNotes, which
  // has its own convergence loop over PAGES rather than heights.
  if (revealInPagedNotes(heading.el)) return heading;
  // Re-resolved on every correction rather than measured against the element
  // captured above. This loop runs for up to HEADING_AIM_BUDGET_MS, which is
  // ample time for an autosave, a highlight or a streamed note finishing to
  // re-render the surface underneath it — and the old code answered a replaced
  // element with a residual of `0 - NOTES_HEADING_SCROLL_GAP`, so the jump
  // scrolled the reader UP eight pixels and stopped.
  let landed = heading;
  await convergeNotesScroll(
    () => {
      const live = notesHeadingById(landed.id) || landed;
      landed = live;
      if (!resolveNotesHeadingElement(live)) return null;
      const top = notesHeadingOffset(live);
      return top == null ? null : top - NOTES_HEADING_SCROLL_GAP;
    },
    HEADING_AIM_BUDGET_MS
  );
  return landed;
}

// Raw-mode counterpart of scrollNotesHeadingIntoView: the rendered notes view is
// hidden while editing, so a TOC click must scroll the textarea instead.
//
// ── Counted by the SAME scanner the rows came from ────────────────────────
//
// This used to carry a walker of its own, on the stated premise that "the Nth
// TOC entry is the Nth ATX heading in source order". That premise is false, and
// each way it is false silently moved the caret to a different section:
//
//   Overview            the rows are  Overview / Setup / Warning / Indented /
//   ========            Done, and the ATX-only walk found only "## Setup" and
//                       "## Done" — so pressing "Overview" landed on Setup,
//   ## Setup            pressing "Setup" landed on Done, and the last three
//                       rows did nothing at all.
//   > ### Warning
//     ## Indented       (HEADING_ATX_RE allows up to three spaces of indent;
//   ## Done             `^#` does not. Blockquoted and setext headings are in
//                       the contents too, and were in neither walk.)
//
// So it asks scanPreparedHeadings, which is where the rows themselves come
// from, and takes that heading's own offset. One definition of "what a heading
// is", for the rows and for the jump alike.
//
// The textarea holds the note's BODY with the highlight-notes block sliced off
// its end (src/notes/notes-edit-split.js). That block is a suffix, so an offset
// measured from the start means the same thing in both strings — the same
// argument the header of src/format/notes-fence.js already makes — and the
// block is fenced, so the scanner never reported a heading inside it anyway.
export function scrollNotesEditToHeadingIndex(index) {
  const textarea = el.notesEdit;
  if (!textarea) return;
  // scanPreparedHeadings rather than the memoized notesHeadingScan: that memo
  // holds ONE answer and the note on screen is what wants it. Swapping it for
  // the textarea's value would make the next render re-scan the whole note.
  const heading = scanPreparedHeadings(textarea.value)[index];
  if (!heading) return;
  const pos = heading.offset;
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
  // Nothing to track while the drawer is showing its highlights instead of its
  // contents. This runs on every scroll frame of the notes — its own comments
  // below are about how carefully that has to be paid for — and scroll-spying a
  // heading list nobody can see is the whole of that cost for none of the
  // benefit.
  if (drawerSection(el.notesTocDrawer) !== "contents") return;
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
  // Paging is per SPAN: only the active span is laid out and the rest are
  // display:none, so a heading outside it has no box at all and
  // notesPageForElement answers with whatever page the current scrollLeft
  // happens to be on. "page <= current page" was therefore TRUE for every
  // heading in every chapter the reader had not reached — the search below ran
  // straight off the end of the book and lit its last heading. Measured on a
  // 60-chapter fixture: reading chapter 37, the contents lit "Chapter 60", and
  // it did that on every multi-chapter note.
  //
  // Span index first (monotonic in document order, and knowable without a
  // box), page only within the span being read.
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
  // The drawer's other half: this note's own highlights, on the same terms —
  // built on the way in, and only when a highlight has changed since it was
  // last built. Installs the Contents/Highlights switch on first use.
  refreshDrawerOnOpen(el.notesTocDrawer);
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
