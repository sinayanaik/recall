// The notes table of contents, and the backlinks panel beside it.
//
// Heading ids are assigned lazily, on first use — a note can hold thousands of
// headings and slugifying them all on every render is wasted work.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { scrollNotesBlockToReadingLine } from "./anchors.js?v=__BUILD__";
import { scrollTextareaToOffset } from "./caret.js?v=__BUILD__";
import { parseNoteLinkTarget } from "./note-links.js?v=__BUILD__";
import { NOTES_PROGRAMMATIC_SCROLL_MS, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import { firstVisibleNotesBlock, isNotesPaged, notesCurrentPage, notesPageForElement, revealInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
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
export function ensureNotesHeadingIds() {
  if (!el.notesView) return [];
  const used = new Set();
  const headings = Array.from(
    el.notesView.querySelectorAll("h1, h2, h3, h4, h5, h6")
  ).filter((h) => h.textContent.trim() !== "");
  headings.forEach((heading) => {
    if (!heading.id) heading.id = slugifyHeading(heading.textContent, used);
    else used.add(heading.id);
  });
  return headings;
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
    if (heading.tagName !== "H1") return;
    if (heading.textContent.trim() !== String(members[expect].title || "").trim()) return;
    starts.push(index);
    expect += 1;
  });
  if (!starts.length) return;

  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : depths.length;
    depths[start] = 0;
    let inner = 6;
    for (let i = start + 1; i < end; i += 1) inner = Math.min(inner, Number(notesTocHeadings[i].tagName[1]));
    for (let i = start + 1; i < end; i += 1) {
      depths[i] = 1 + Math.min(Number(notesTocHeadings[i].tagName[1]) - inner, 3);
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
      twisty.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${notesTocHeadings[index]?.textContent.trim() || "section"}`);
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
  const minLevel = notesTocHeadings.reduce(
    (min, h) => Math.min(min, Number(h.tagName[1])),
    6
  );
  const depths = notesTocHeadings.map((h) => Math.min(Number(h.tagName[1]) - minLevel, 4));
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
    const level = Number(heading.tagName[1]);
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
    link.querySelector(".notes-toc-text").textContent = heading.textContent.trim();
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

export function notesHeadingOffset(heading) {
  return heading.getBoundingClientRect().top - el.notesView.getBoundingClientRect().top;
}

// A long note doesn't know its own height until you get there: diagrams below
// the fold are only drawn as they approach the viewport, images only load then,
// and each one that arrives pushes everything under it down. So aiming once at
// where the heading LOOKS like it is can land thousands of pixels off. Re-aim
// until it settles (or until the corrections stop helping).
export async function scrollNotesHeadingIntoView(heading) {
  if (!heading || !el.notesView) return;
  // Paged mode: turn to the heading's page. No re-aiming loop, because there is
  // nothing to converge on — a page boundary is exact, and the re-aiming exists
  // for heights that keep changing under a vertical scroll.
  if (revealInPagedNotes(heading)) return;
  const aim = (behavior) => {
    const target = el.notesView.scrollTop + notesHeadingOffset(heading) - NOTES_HEADING_SCROLL_GAP;
    markProgrammaticNotesScroll(behavior === "smooth" ? 800 : NOTES_PROGRAMMATIC_SCROLL_MS);
    el.notesView.scrollTo({ top: Math.max(0, target), behavior });
  };

  aim("smooth");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 130));
    if (!heading.isConnected) return;
    if (Math.abs(notesHeadingOffset(heading) - NOTES_HEADING_SCROLL_GAP) <= 4) return;
    aim("auto");
  }
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
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  // scrollTextareaToOffset nudges the highlight backdrop itself now — this call
  // site used to carry that workaround alone, which is why the other two callers
  // (enterNotesEditing, toggleEditMode) could leave the mirror stale.
  scrollTextareaToOffset(textarea, pos);
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
  if (!el.notesTocList || !notesTocHeadings.length) return;
  // Closed drawer: nothing to show, so nothing to compute. openNotesToc() calls
  // this on the way open, so it still lands on the right entry.
  if (!isNotesTocOpen()) return;

  // The active section is the last heading whose top has scrolled to (or above)
  // a line a little below the viewport top — or, in paged mode, the last one
  // whose page is at or before the page being read. Same "last one at or above
  // the mark" question, asked of a different axis.
  const paged = isNotesPaged();
  const page = paged ? notesCurrentPage() : 0;
  const mark = el.notesView.getBoundingClientRect().top + 24;
  const atOrAbove = (index) => (paged
    ? notesPageForElement(notesTocHeadings[index]) <= page
    : notesTocHeadings[index].getBoundingClientRect().top <= mark);
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
  return hit.closest(NOTES_BLOCK_SELECTOR)?.closest(".notes-rendered > *") || hit.closest(".notes-rendered > *");
}

export function openNotesToc() {
  if (!el.notesTocDrawer) return;
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

export async function renderNotesBacklinks() {
  const section = el.notesBacklinks;
  const list = el.notesBacklinksList;
  if (!section || !list) return;
  // Opening the drawer, switching decks and opening it again can overlap; only
  // the newest request may write to the list.
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
  if (token !== backlinksToken || !hits.length) return;

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
