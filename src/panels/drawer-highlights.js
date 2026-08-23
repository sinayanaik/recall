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
// chip, where it is, and a badge if a note hangs off it — see
// panels/highlight-index.js for why that is a different shape from the panel's
// rows. A book with five hundred highlights would otherwise be five hundred
// marked+DOMPurify passes for a list being scanned rather than read.
//
// The list is built when the drawer opens and only if it is stale, the same
// discipline notesTocDirty/ensureNotesTocBuilt already enforces on the contents
// list — and for the same reason: the drawer is closed almost all of the time.

import { el } from "../core/dom.js?v=__BUILD__";
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { documentHighlightEntries, noteHighlightEntries } from "./highlight-index.js?v=__BUILD__";

export const DRAWER_SECTION_ATTR = "data-drawer-section";

export const DRAWER_HIGHLIGHTS_CLASS = "drawer-highlights";

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

export function drawerSection(drawer) {
  return drawer ? (drawerShowing.get(drawer) || "contents") : "contents";
}

// Every highlight change marks both drawers stale — a highlight made in the
// Notes panel and one made on the Document surface both land in the one handler
// main.js registers, and neither of them knows which drawer is open.
export function markDrawerHighlightsDirty() {
  [el.notesTocDrawer, el.documentOutlineDrawer].forEach((drawer) => {
    if (drawer) drawerDirty.set(drawer, true);
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
  const contentsTab = drawerSectionButton(drawer === el.documentOutlineDrawer ? "Contents" : "On this page", "contents");
  const highlightsTab = drawerSectionButton("Highlights", "highlights");
  tabs.append(contentsTab, highlightsTab);
  head.after(tabs);

  const section = document.createElement("div");
  section.className = `${DRAWER_HIGHLIGHTS_CLASS} notes-toc-scroll`;
  section.hidden = true;
  const list = document.createElement("ol");
  list.className = "drawer-highlights-list";
  const empty = document.createElement("p");
  empty.className = "notes-toc-empty drawer-highlights-empty";
  empty.hidden = true;
  section.append(list, empty);
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
  if (entry.where) {
    const where = document.createElement("span");
    where.className = "drawer-highlight-where";
    where.textContent = entry.where;
    jump.appendChild(where);
  }
  // A note is said, not shown. The drawer is a way back to the highlight; the
  // note itself is read in the Highlights tab or by pressing the number on the
  // mark, and a drawer row that unfolded into a paragraph would stop being a
  // list you can scan.
  if (entry.note) {
    const noted = document.createElement("span");
    noted.className = "drawer-highlight-noted";
    noted.textContent = "✎";
    noted.title = "This highlight has a note on it";
    jump.appendChild(noted);
  }

  jump.addEventListener("click", () => {
    // The same call the Highlights panel's "Go to →" makes, so a jump from here
    // takes the identical exact-target path: a <mark>'s ordinal in the note, or
    // a document highlight's id, with the anchor's text as the fallback search.
    scheduleNoteJump(entry.anchor, { patient: true }, entry.locator);
    // On a phone the drawer covers the text it is about to scroll, so it gets
    // out of the way — the same thing a contents row does. Where the drawer
    // pushes instead of covering, it stays: the reader can walk down the list.
    if (!tocPushesDrawer()) closeDrawerForJump(drawer);
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
  entries.forEach((entry) => frag.appendChild(drawerRowFor(drawer, entry)));
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
