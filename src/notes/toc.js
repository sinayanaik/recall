// The notes table of contents, and the backlinks panel beside it.
//
// Heading ids are assigned lazily, on first use — a note can hold thousands of
// headings and slugifying them all on every render is wasted work.

import { el } from "../core/dom.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { loadDeckFromLibrary, readLocalDeckIndex, state } from "../main.js?v=__BUILD__";
import { scrollNotesBlockToReadingLine } from "./anchors.js?v=__BUILD__";
import { scrollTextareaToOffset } from "./caret.js?v=__BUILD__";
import { parseNoteLinkTarget } from "./note-links.js?v=__BUILD__";
import { NOTES_PROGRAMMATIC_SCROLL_MS, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
import { NOTE_LINK_PATTERN } from "../render/note-links.js?v=__BUILD__";
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

export function buildNotesToc() {
  if (!el.notesView || !el.notesTocList) return;
  notesTocHeadings = ensureNotesHeadingIds();

  el.notesTocList.innerHTML = "";
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

  notesTocHeadings.forEach((heading, index) => {
    // Ids are already assigned by ensureNotesHeadingIds above.
    const level = Number(heading.tagName[1]);
    const depth = depths[index];

    const li = document.createElement("li");
    li.className = "notes-toc-item";
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
    el.notesTocList.appendChild(li);
    notesTocLinks.push(link);
  });

  updateNotesTocActive();
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
  // a line a little below the viewport top.
  const mark = el.notesView.getBoundingClientRect().top + 24;
  let low = 0;
  let high = notesTocHeadings.length - 1;
  let activeIndex = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (notesTocHeadings[mid].getBoundingClientRect().top <= mark) {
      activeIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

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
