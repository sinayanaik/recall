// The Highlights half of a contents drawer.
//
// ── Why the drawer and not the tab ────────────────────────────────────────
//
// There is one Highlights tab, and on a PDF deck it lists the paper's
// highlights and the deck note's highlights together. That is right for the
// place you go to READ your highlights and wrong for the place you go to FIND
// one: a reader inside the Document panel wants what they marked on the paper,
// and a reader inside the Notes panel wants what they marked in the note, and
// neither of them wants to leave the surface they are reading to see it.
//
// Both panels already have a drawer for exactly this question — "what is in
// this thing, and take me there" — so this is a second section of that drawer
// rather than new chrome of its own. Contents and Highlights are two answers to
// one question and belong behind one control.
//
// ── One implementation, two drawers ───────────────────────────────────────
//
// #notesTocDrawer and #documentOutlineDrawer are the same markup with different
// ids (.notes-toc-drawer > .notes-toc-head + .notes-toc-scroll), and the switch
// and the list are built here rather than written into index.html twice. Two
// hand-written copies of one control is the thing that drifts: the second one
// gets the fix and the first one does not.
//
// ── What a row costs ──────────────────────────────────────────────────────
//
// Nothing is rendered. A row is the highlighted words as plain text, a colour
// chip, where it is, and — clipped to DRAWER_NOTE_CHARS by
// panels/highlight-index.js — whatever was written about it. A book with five
// hundred highlights would otherwise be five hundred marked+DOMPurify passes
// for a list being scanned rather than read.
//
// ── ...and how many rows there are ────────────────────────────────────────
//
// A closely-read book runs to thousands of highlights, and a drawer is not an
// index: the list is capped at DRAWER_ROW_LIMIT with one row at the bottom that
// lifts the cap. The cap is per OPEN, so a reader who wanted the whole list
// gets it and does not have to ask twice while the drawer stays open, and a
// reader who did not never pays to build it.
//
// The list is built when the drawer opens and only if it is stale, the same
// discipline notesTocDirty/ensureNotesTocBuilt already enforces on the contents
// list — and for the same reason: the drawer is closed almost all of the time.

import { el } from "../core/dom.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { documentHighlightEntries, noteHighlightEntries } from "./highlight-index.js?v=__BUILD__";

// How many rows are built before the list offers to show the rest. Comfortably
// more than a drawer's worth of scrolling, and far short of the thousands a
// marked-up textbook carries.
export const DRAWER_ROW_LIMIT = 300;

export const DRAWER_SECTION_ATTR = "data-drawer-section";

export const DRAWER_HIGHLIGHTS_CLASS = "drawer-highlights";

// ── The way into side by side ──────────────────────────────────────────────
//
// Registered by src/main.js rather than imported, and that is not ceremony: this
// module is reached from src/documents/pdf-outline.js (refreshDrawerOnOpen),
// which src/documents/pdf-view.js imports — so importing a module that imports
// pdf-view.js back would close a cycle right through the document surface. The
// same reason setHighlightsChangedHandler and setDocumentAttachHandler exist:
// main.js is the file that knows both ends.
//
//   onSideBySide(surface)     the button above the list was pressed
//   onHighlightsOnly(surface) ...and its neighbour, for the pane on its own
//   onRowJump(locator)        a row was pressed, and something else may want to
//                             follow it
let onSideBySide = null;

let onHighlightsOnly = null;

let onRowJump = null;

export function setDrawerSideBySideHandler(fn) {
  onSideBySide = fn;
}

export function setDrawerHighlightsOnlyHandler(fn) {
  onHighlightsOnly = fn;
}

export function setDrawerRowJumpHook(fn) {
  onRowJump = fn;
}

function drawerSurface(drawer) {
  return drawer === el.documentOutlineDrawer ? "document" : "notes";
}

// Which section each drawer is showing. Keyed on the drawer ELEMENT rather than
// held as one flag, because the two drawers are independent surfaces: switching
// the Document drawer to Highlights must not switch the Notes one under a
// reader who is not looking at it.
const drawerShowing = new WeakMap();

// Rebuilt on open, not on change, and per drawer for the same reason the map
// above is. (Both carry the drawer- prefix because a top-level `dirty` or
// `showing` collides with a module-local one somewhere else in the tree, which
// is what tools/module-symbols.mjs is for.)
const drawerDirty = new WeakMap();

// Whether this drawer has been asked to show past DRAWER_ROW_LIMIT. Reset when
// the list is next rebuilt from scratch — a different deck's highlights are a
// different question.
const drawerShowAll = new WeakMap();

export function drawerSection(drawer) {
  return drawer ? (drawerShowing.get(drawer) || "contents") : "contents";
}

// Every highlight change marks both drawers stale — a highlight made in the
// Notes panel and one made on the Document surface both land in the one handler
// main.js registers, and neither of them knows which drawer is open.
export function markDrawerHighlightsDirty() {
  [el.notesTocDrawer, el.documentOutlineDrawer].forEach((drawer) => {
    if (!drawer) return;
    drawerDirty.set(drawer, true);
    // A highlight made or deleted is a new list, and the reader's "show me all
    // of them" belonged to the old one. Kept only for as long as the list it
    // was asked of.
    drawerShowAll.delete(drawer);
  });
}

// ── Building the drawer's second half ─────────────────────────────────────

function drawerSectionButton(label, section) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "drawer-tab";
  button.dataset.drawerTab = section;
  button.textContent = label;
  button.setAttribute("role", "tab");
  return button;
}

// Idempotent: called on every open, and does its work once. The alternative —
// building it alongside the drawer at boot — would put the switch on screen
// before anything has asked for it, and this runs at most once per drawer per
// session either way.
export function installDrawerSections(drawer) {
  if (!drawer || drawer.querySelector(`.${DRAWER_HIGHLIGHTS_CLASS}`)) return;
  const head = drawer.querySelector(".notes-toc-head");
  const scroll = drawer.querySelector(".notes-toc-scroll");
  if (!head || !scroll) return;

  // The switch goes UNDER the head rather than in it: the head is a flex row
  // holding a title and a close button, and a third child would push the × off
  // the end at drawer width. Its own row, full width, two equal halves.
  const tabs = document.createElement("div");
  tabs.className = "drawer-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.append(drawerSectionButton("Contents", "contents"), drawerSectionButton("Highlights", "highlights"));
  head.after(tabs);

  // The head said "On this page" / "Contents", which is what the first tab now
  // says one line below it — the same words twice, with a switch in between
  // implying they were different things. It names the DRAWER instead: what you
  // are looking into, rather than which half of it is showing.
  const title = head.querySelector(".notes-toc-title");
  if (title) title.textContent = drawer === el.documentOutlineDrawer ? "In this document" : "In this note";

  const section = document.createElement("div");
  section.className = `${DRAWER_HIGHLIGHTS_CLASS} notes-toc-scroll`;
  section.hidden = true;
  // "Side by side", above the list rather than beside the tabs: the decision to
  // work through your highlights is made while looking at them, and this is the
  // only place in the app where you are looking at the highlights of the exact
  // surface you are reading. It closes the drawer on the way, because the split
  // it opens is what the drawer is covering.
  const sideBySide = document.createElement("button");
  sideBySide.type = "button";
  sideBySide.className = "drawer-side-by-side";
  sideBySide.textContent = "Side by side";
  sideBySide.title = "Put these beside the page — walk through them without leaving it";
  sideBySide.addEventListener("click", () => {
    closeDrawerForJump(drawer);
    onSideBySide?.(drawerSurface(drawer));
  });
  // ...and the same pane without the page. Beside the first rather than in a
  // menu because they are one decision made once — which of the two you want —
  // and the pane's own ≡ switches between them afterwards.
  const only = document.createElement("button");
  only.type = "button";
  only.className = "drawer-side-by-side drawer-highlights-only";
  only.textContent = "Highlights only";
  only.title = "Read the highlights on their own, with the whole panel";
  only.addEventListener("click", () => {
    closeDrawerForJump(drawer);
    onHighlightsOnly?.(drawerSurface(drawer));
  });
  const modes = document.createElement("div");
  modes.className = "drawer-highlights-modes";
  modes.append(sideBySide, only);
  const list = document.createElement("ol");
  list.className = "drawer-highlights-list";
  const empty = document.createElement("p");
  empty.className = "notes-toc-empty drawer-highlights-empty";
  empty.hidden = true;
  section.append(modes, list, empty);
  scroll.after(section);

  // The existing scroll box is the contents section from here on, so the switch
  // has something to switch away from.
  scroll.setAttribute(DRAWER_SECTION_ATTR, "contents");
  section.setAttribute(DRAWER_SECTION_ATTR, "highlights");

  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-drawer-tab]");
    if (!tab) return;
    setDrawerSection(drawer, tab.dataset.drawerTab);
  });

  setDrawerSection(drawer, drawerSection(drawer));
}

export function setDrawerSection(drawer, section) {
  if (!drawer) return;
  const next = section === "highlights" ? "highlights" : "contents";
  drawerShowing.set(drawer, next);
  drawer.querySelectorAll("[data-drawer-tab]").forEach((tab) => {
    const active = tab.dataset.drawerTab === next;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  drawer.querySelectorAll(`[${DRAWER_SECTION_ATTR}]`).forEach((pane) => {
    pane.hidden = pane.getAttribute(DRAWER_SECTION_ATTR) !== next;
  });
  if (next === "highlights") renderDrawerHighlights(drawer);
}

// ── The rows ──────────────────────────────────────────────────────────────

// Which highlights this drawer is about. The Document drawer lists the paper's;
// the Notes drawer lists the note's own <mark>s — including on a PDF deck,
// where the Notes tab is an ordinary note the reader may well have highlighted
// too. That split is the whole point of the feature: each panel lists what was
// marked on IT.
function drawerEntriesFor(drawer) {
  return drawer === el.documentOutlineDrawer ? documentHighlightEntries() : noteHighlightEntries();
}

function drawerRowFor(drawer, entry) {
  const item = document.createElement("li");
  item.className = "drawer-highlight";
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "drawer-highlight-jump";
  jump.dataset.highlightKey = entry.key;

  const chip = document.createElement("span");
  chip.className = "drawer-highlight-chip";
  chip.dataset.color = entry.color || "";
  chip.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "drawer-highlight-text";
  text.textContent = entry.text;

  jump.append(chip, text);
  // ── The two small things, on a line of their own under the words ─────────
  //
  // They used to be the third and fourth COLUMNS of the first line, beside the
  // highlight: "in the Highlights panel the page indicators and contents are in
  // the same row, reducing space to actual highlights". They were, and the page
  // column was allowed up to 8em of a ~300px drawer — a third of every row
  // spent on metadata, taken from the one thing in the row a reader recognises
  // a passage by.
  //
  // A wrapper rather than two more grid cells, because these two share a line
  // and a grid cell holds one thing. It is built only when there is something
  // to put in it, so a row with neither a note nor a page keeps exactly the two
  // lines it always had.
  //
  // Both class names, and the order they are appended in, are unchanged —
  // tools/pdf-preview-check.mjs reads .drawer-highlight-noted and
  // .drawer-highlight-where off the row, and both are descendant lookups a
  // wrapper does not disturb.
  if (entry.note || entry.where) {
    const meta = document.createElement("span");
    meta.className = "drawer-highlight-meta";
    if (entry.note) {
      const noted = document.createElement("span");
      noted.className = "drawer-highlight-noted";
      noted.textContent = "✎";
      noted.title = "This highlight has a note on it";
      meta.appendChild(noted);
    }
    if (entry.where) {
      const where = document.createElement("span");
      where.className = "drawer-highlight-where";
      where.textContent = entry.where;
      meta.appendChild(where);
    }
    jump.appendChild(meta);
  }
  // ...and the note itself, under the words it is about.
  //
  // This used to be the ✎ and nothing else, on the argument that a drawer says
  // a note is THERE and the note is read somewhere else. On a paper that falls
  // down: the note is in a different TAB from the page being read, and "which
  // of these did I write something about, and what" is the whole question the
  // drawer is open to answer. It arrives already clipped (clipDrawerNote), and
  // the CSS clamps what is left to two lines, so a row can grow by a line or
  // two and never into a paragraph.
  if (entry.noteText) {
    const note = document.createElement("span");
    note.className = "drawer-highlight-note";
    note.textContent = entry.noteText;
    jump.appendChild(note);
  }

  jump.addEventListener("click", () => {
    // The same call the Highlights panel's "Go to →" makes, so a jump from here
    // takes the identical exact-target path: a <mark>'s ordinal in the note, or
    // a document highlight's id, with the anchor's text as the fallback search.
    scheduleNoteJump(entry.anchor, { patient: true }, entry.locator);
    // ...and if the split is open, it is showing a list this row is in: point it
    // at the same highlight rather than leaving the two disagreeing about which
    // one the reader is on.
    onRowJump?.(entry.locator);
    // The drawer gets out of the way when it is COVERING what the jump is about
    // to show. Above 720px the notes stage makes room for its drawer and the
    // reader can walk down the list; the Document surface never does — a page is
    // fit to the width of its scroller, so narrowing it would re-rasterise every
    // page in the render window for as long as the drawer was open — so there it
    // always closes.
    if (drawer === el.documentOutlineDrawer || !tocPushesDrawer()) closeDrawerForJump(drawer);
  });
  item.appendChild(jump);
  return item;
}

// The Notes drawer's own push rule, asked without importing notes/toc.js — that
// module imports half the notes subtree and this one is reached from the
// Document surface too. THE definition still lives there (TOC_PUSH_MIN_WIDTH);
// this is the same query, and the value is repeated in exactly one other place
// for a reason its own comment gives.
function tocPushesDrawer() {
  return window.matchMedia("(min-width: 721px)").matches;
}

function closeDrawerForJump(drawer) {
  // Each drawer closes the way its own panel opens it, and the two are not the
  // same: the notes drawer animates on an is-open class, the document one is
  // shown and hidden outright. Rather than reimplement either, the button that
  // opens it is pressed — which is also what keeps aria-expanded honest.
  const toggle = drawer === el.documentOutlineDrawer ? el.documentTocBtn : el.notesTocBtn;
  if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
}

export function renderDrawerHighlights(drawer) {
  if (!drawer) return;
  const list = drawer.querySelector(".drawer-highlights-list");
  const empty = drawer.querySelector(".drawer-highlights-empty");
  if (!list) return;
  const entries = drawerEntriesFor(drawer);
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  const limit = drawerShowAll.get(drawer) ? entries.length : DRAWER_ROW_LIMIT;
  entries.slice(0, limit).forEach((entry) => frag.appendChild(drawerRowFor(drawer, entry)));
  if (entries.length > limit) {
    const more = document.createElement("li");
    more.className = "drawer-highlight drawer-highlight-more";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drawer-highlight-jump drawer-highlight-more-btn";
    button.textContent = `Show all ${entries.length}`;
    button.addEventListener("click", () => {
      drawerShowAll.set(drawer, true);
      renderDrawerHighlights(drawer);
    });
    more.appendChild(button);
    frag.appendChild(more);
  }
  list.appendChild(frag);
  if (empty) {
    empty.hidden = entries.length > 0;
    empty.textContent = drawer === el.documentOutlineDrawer
      ? "Nothing highlighted in this document yet. Select some words on the page and press Highlight."
      : "Nothing highlighted in this note yet. Select some text and press the highlight button.";
  }
  drawerDirty.set(drawer, false);
}

// Called by whichever panel is opening its drawer. Builds the switch on first
// use, and refreshes the list only when a highlight has changed since it was
// last built — a book's highlights are a scan of the whole source, which is not
// something to do because somebody opened the contents.
export function refreshDrawerOnOpen(drawer) {
  if (!drawer) return;
  installDrawerSections(drawer);
  if (drawerSection(drawer) !== "highlights") return;
  if (drawerDirty.get(drawer) === false) return;
  renderDrawerHighlights(drawer);
}
