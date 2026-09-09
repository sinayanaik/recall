// The `[[` autocomplete in the raw editor: notes, and headings within them.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { notesAnchorPlainText } from "./anchors.js?v=__BUILD__";
import { caretRectInBackdrop } from "./caret.js?v=__BUILD__";
import { browseRowsFor, folderCrumbs, noteLinkBrowseSort, noteLinkHomeFolder, noteLinkSortLabel, parentFolder, toggleNoteLinkBrowseSort } from "./link-browse.js?v=__BUILD__";
import { scoreNoteEntry } from "./link-fuzzy.js?v=__BUILD__";
import { createLinkedNoteFlow, loadNoteLinkIndex } from "./note-links.js?v=__BUILD__";
import { currentDeckKey } from "./scroll-anchor.js?v=__BUILD__";
import { slugifyHeading } from "./toc.js?v=__BUILD__";
import { noteLinkIdFor } from "../render/note-links.js?v=__BUILD__";
import { readDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";
import { showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { currentKeyboardInset } from "../ui/style-settings.js?v=__BUILD__";

// ── The [[ picker ───────────────────────────────────────────────────────────
//
// Type "[[" in the raw notes editor and every note in the library becomes
// searchable from where the caret already is. This is the only place that
// writes the id form of a link, which is what makes picked links survive a
// rename while hand-typed ones do not.
//
// The last row is always "create what you just typed" — and, when nothing was
// typed, "＋ New note…", which asks for a name and files it in the folder being
// browsed. A reference to something that does not exist yet is the normal way to
// write — you name the idea while it is in your head and fill it in later — so
// that has to be one keystroke from either view, not a trip to My Decks and back.
//
// With NOTHING typed it is a browser rather than a list: recents, the folder
// tree, and what is in the folder you are standing in, newest first. Searching
// only helps when you can remember the name — and "what was that note called?"
// is exactly the moment you reach for a link. See src/notes/link-browse.js for
// the rows and their order, and Alt+S (or the chip in the breadcrumb) for A–Z.
export const NOTE_LINK_PICKER_LIMIT = 8;

// Which folder the browse view is showing. "" is the root (every top-level
// folder); it opens on the current note's own folder and is reset when the
// picker closes, so a "[[" is never answered with wherever you happened to
// wander last time.
export let noteLinkBrowseCwd = "";

export let noteLinkBrowseHome = "";

// Which of the three modes drew the rows now on screen. Set by
// updateNoteLinkPicker rather than inferred from the rows, because "no query
// typed" is true of heading mode too ("[[#" lists this note's own headings) and
// that must not sprout a breadcrumb.
export let noteLinkBrowsingRows = false;

// What was typed the last time rows were built. When it changes the rows are a
// different list of different things, so the highlight goes back to the top —
// carrying it over is how typing "chnrl" left the highlight sitting on "Create
// chnrl as a new note" while the note it found sat unhighlighted above.
export let noteLinkPickerQuery = null;

// Is the picker showing the browser rather than search results? The arrow keys
// mean different things in the two modes — see the keydown handler in main.js —
// and this is what tells them apart.
export function isNoteLinkBrowsing() {
  if (!isNoteLinkPickerOpen()) return false;
  const textarea = el.notesEdit;
  if (!textarea) return false;
  const typed = textarea.value.slice(noteLinkPickerStart + 2, textarea.selectionStart);
  return !typed.includes("#") && !typed.trim();
}

// One level up, or false at the root. Backspace only steals the keystroke while
// there is somewhere to go: at the root it has to fall through and delete a
// "[", or the caret would be trapped inside a "[[" with no way out but the
// mouse.
export function noteLinkBrowseUp() {
  if (!noteLinkBrowseCwd) return false;
  noteLinkBrowseCwd = parentFolder(noteLinkBrowseCwd);
  return true;
}

export let noteLinkPickerEl = null;

export let noteLinkPickerRows = [];

export let noteLinkPickerIndex = 0;

export let noteLinkPickerStart = -1;

export function isNoteLinkPickerOpen() {
  return noteLinkPickerStart >= 0 && noteLinkPickerEl && !noteLinkPickerEl.hidden;
}

// How far a finger may travel and still have meant "this row". Beyond it the
// gesture was a scroll of the list.
export const NOTE_LINK_TAP_SLOP = 10;

// The touch that is being watched to see whether it becomes a tap or a scroll.
let noteLinkPickerTap = null;

// A row or the sort chip was chosen, by whichever pointer got there.
export function activateNoteLinkPickerTarget(hit) {
  if (!hit) return;
  if (hit.dataset.pickerSort !== undefined) {
    toggleNoteLinkBrowseSort();
    // Redraw from the index rather than re-sorting the rows in place: the order
    // lives in browseRowsFor, so there is one implementation of it.
    noteLinkPickerIndex = 0;
    updateNoteLinkPicker();
    return;
  }
  noteLinkPickerIndex = Number(hit.dataset.pickerIndex);
  commitNoteLinkPicker();
}

export function ensureNoteLinkPickerEl() {
  if (noteLinkPickerEl) return noteLinkPickerEl;
  noteLinkPickerEl = document.createElement("div");
  noteLinkPickerEl.className = "note-link-picker";
  noteLinkPickerEl.id = "noteLinkPicker";
  noteLinkPickerEl.hidden = true;
  noteLinkPickerEl.setAttribute("role", "listbox");
  noteLinkPickerEl.setAttribute("aria-label", "Link a note");
  // pointerdown, not click: clicking moves focus out of the textarea and the
  // selection/caret is what the insert is measured against.
  //
  // ── Except under a finger ────────────────────────────────────────────────
  //
  // preventDefault() on a touch pointerdown cancels the gesture the browser was
  // about to turn into a scroll — and every pixel of this popup is a row, so
  // there was nowhere left to put a finger that could scroll it. A browse list
  // is up to NOTE_LINK_BROWSE_LIMIT rows in a box that holds six: "the items
  // are not scrollable" was this one line. So touch keeps its default (the list
  // scrolls) and commits on pointerup instead, only if the finger stayed put.
  noteLinkPickerEl.addEventListener("pointerdown", (event) => {
    const hit = event.target.closest("[data-picker-index], [data-picker-sort]");
    if (!hit) return;
    if (event.pointerType === "touch") {
      noteLinkPickerTap = { id: event.pointerId, x: event.clientX, y: event.clientY, hit };
      return;
    }
    event.preventDefault();
    activateNoteLinkPickerTarget(hit);
  });
  noteLinkPickerEl.addEventListener("pointerup", (event) => {
    const tap = noteLinkPickerTap;
    noteLinkPickerTap = null;
    if (!tap || tap.id !== event.pointerId) return;
    // A drag is a scroll, not a choice.
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > NOTE_LINK_TAP_SLOP) return;
    if (!event.target.closest("[data-picker-index], [data-picker-sort]")) return;
    // The tap may have taken focus off the textarea on the way in; the caret it
    // left behind is still recorded there, so putting focus back restores
    // exactly what the insert is measured against. Also cancels the deferred
    // close the editor's blur handler armed.
    const textarea = el.notesEdit;
    if (textarea && document.activeElement !== textarea) {
      const at = textarea.selectionStart;
      textarea.focus();
      textarea.setSelectionRange(at, at);
    }
    activateNoteLinkPickerTarget(tap.hit);
  });
  noteLinkPickerEl.addEventListener("pointercancel", () => { noteLinkPickerTap = null; });
  // A scroll that starts under the finger is the browser telling us this was
  // never a tap, on the platforms that do not move the pointer enough to trip
  // the slop test above.
  noteLinkPickerEl.addEventListener("scroll", () => { noteLinkPickerTap = null; }, { passive: true });
  document.body.appendChild(noteLinkPickerEl);
  return noteLinkPickerEl;
}

export function closeNoteLinkPicker() {
  noteLinkPickerStart = -1;
  noteLinkBrowseCwd = "";
  noteLinkBrowseHome = "";
  noteLinkBrowsingRows = false;
  noteLinkPickerQuery = null;
  noteLinkPickerRows = [];
  noteLinkPickerIndex = 0;
  noteLinkPickerDrawn = "";
  noteLinkPickerTap = null;
  if (noteLinkPickerEl) noteLinkPickerEl.hidden = true;
}

// Where the caret is on screen, so the popup opens next to what is being typed.
//
// A textarea will not report this, so the position is read off the highlight
// backdrop — a character-for-character mirror of the same text with the same
// metrics, which is exactly what is needed. On a note big enough for the mirror
// to be switched off (see HIGHLIGHT_MIRROR_MAX_CHARS) there is nothing to
// measure, and the popup is pinned to the bottom of the editor instead: a
// predictable place beats a wrong one.
export function caretScreenRect(textarea, offset) {
  // caretRectInBackdrop does the measuring — it is shared with
  // visualLineTopForOffset, which needs the same answer in scroll coordinates
  // rather than viewport ones. Keeping one walker means the popup and the
  // scroll restore can never disagree about where a character is.
  const hit = caretRectInBackdrop(textarea, offset);
  if (hit) return { left: hit.rect.left, top: hit.rect.top, bottom: hit.rect.bottom };
  const box = textarea.getBoundingClientRect();
  return { left: box.left + 12, top: box.bottom - 28, bottom: box.bottom - 8 };
}

export function positionNoteLinkPicker(textarea, offset) {
  const el2 = ensureNoteLinkPickerEl();
  const caret = caretScreenRect(textarea, offset);
  el2.style.visibility = "hidden";
  el2.hidden = false;
  const size = el2.getBoundingClientRect();
  const margin = 8;
  let left = Math.min(caret.left, window.innerWidth - size.width - margin);
  left = Math.max(margin, left);
  // Below the caret by default, above it when that would run off the bottom —
  // which on a phone with the keyboard up is most of the time.
  let top = caret.bottom + 6;
  const usableBottom = window.innerHeight - currentKeyboardInset() - margin;
  if (top + size.height > usableBottom) top = Math.max(margin, caret.top - size.height - 6);
  el2.style.left = `${Math.round(left)}px`;
  el2.style.top = `${Math.round(top)}px`;
  el2.style.visibility = "";
}

// A title with the characters the query matched wrapped in <mark>. Each segment
// is escaped on its own — the ranges are offsets into the RAW title, so slicing
// escaped HTML by them would cut an entity in half.
export function markedTitle(title, ranges) {
  const text = String(title || "");
  if (!ranges || !ranges.length) return escapeHtml(text);
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out += escapeHtml(text.slice(at, start));
    out += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escapeHtml(text.slice(at));
}

// The "you are here" bar above the browse rows. Not clickable: it sits over a
// textarea whose caret is what every insert is measured against, and one more
// thing that can move focus is one more way for that to go wrong. Walking back
// out is ← / Backspace, or the ⤴ row that heads the list.
export function renderNoteLinkCrumbs(host, cwd) {
  const bar = document.createElement("div");
  bar.className = "note-link-picker-crumbs";
  const crumbs = folderCrumbs(cwd);
  const where = document.createElement("span");
  where.className = "note-link-picker-where";
  where.textContent = crumbs.length ? `\u2302 ${crumbs.map((crumb) => crumb.name).join(" \u203a ")}` : "\u2302 All folders";
  bar.appendChild(where);
  // The one thing in this popup that is clickable and is not a destination.
  // Rendered as a button so it can be tapped, but it never takes focus (its
  // pointerdown is prevented, exactly as a row's is) — the caret in the
  // textarea is what every insert is measured against.
  const sort = document.createElement("button");
  sort.type = "button";
  sort.className = "note-link-picker-sort";
  sort.dataset.pickerSort = noteLinkBrowseSort();
  sort.tabIndex = -1;
  sort.textContent = `\u21c5 ${noteLinkSortLabel()}`;
  sort.title = noteLinkBrowseSort() === "title"
    ? "Sorted A\u2013Z \u00b7 Alt+S for most recently edited"
    : "Sorted by most recently edited \u00b7 Alt+S for A\u2013Z";
  sort.setAttribute("aria-label", sort.title);
  bar.appendChild(sort);
  host.appendChild(bar);
}

// The rows the popup was last drawn with, as one string. A redraw of the SAME
// list (an arrow key, a re-render on a caret move) must not throw away how far
// down it the reader had scrolled; a redraw of a different list must start at
// the top.
export let noteLinkPickerDrawn = "";

export function renderNoteLinkPicker(query) {
  const el2 = ensureNoteLinkPickerEl();
  const signature = JSON.stringify(noteLinkPickerRows.map((row) => `${row.kind || ""}:${row.create ? "new" : ""}:${row.path || ""}:${row.title}`));
  const keepScroll = signature === noteLinkPickerDrawn ? el2.scrollTop : 0;
  noteLinkPickerDrawn = signature;
  el2.innerHTML = "";
  el2.classList.toggle("is-browsing", noteLinkBrowsingRows);
  if (noteLinkBrowsingRows) renderNoteLinkCrumbs(el2, noteLinkBrowseCwd);
  noteLinkPickerRows.forEach((row, index) => {
    // Section headings are drawn from the first row of each group rather than
    // being rows themselves: commitNoteLinkPicker indexes this array by number,
    // so anything unselectable in it would offset every choice below it.
    if (row.sectionLabel) {
      const label = document.createElement("div");
      label.className = "note-link-picker-section";
      label.textContent = row.sectionLabel;
      el2.appendChild(label);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "note-link-picker-row" + (index === noteLinkPickerIndex ? " is-active" : "");
    item.dataset.pickerIndex = String(index);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === noteLinkPickerIndex ? "true" : "false");
    if (row.heading) {
      item.classList.add("is-heading");
      item.innerHTML = `<span class="note-link-picker-title">${escapeHtml(row.headingText)}</span>`
        + `<span class="note-link-picker-path">heading in ${escapeHtml(row.entry.title)}</span>`;
    } else if (row.create) {
      item.classList.add("is-create");
      // Browsing, so there is no typed name to offer: the row asks for one.
      // Creating has to be reachable from the browser too — you go looking for
      // the note you meant to link to, find it does not exist yet, and that is
      // the moment to make it, not a trip to My Decks and back.
      const where = row.browseCreate
        ? (folderCrumbs(row.path).map((crumb) => crumb.name).join(" \u203a ") || "you'll choose the folder")
        : "";
      item.innerHTML = row.browseCreate
        ? `<span class="note-link-picker-title">\uff0b New note\u2026</span>`
          + `<span class="note-link-picker-path">In ${escapeHtml(where)}</span>`
        : `<span class="note-link-picker-title">Create \u201c${escapeHtml(query)}\u201d as a new note</span>`
          + `<span class="note-link-picker-path">You'll choose the folder</span>`;
    } else if (row.kind === "up") {
      item.classList.add("is-up");
      item.innerHTML = `<span class="note-link-picker-title">\u2934 ${escapeHtml(row.title)}</span>`
        + `<span class="note-link-picker-path">Back out one folder</span>`;
    } else if (row.kind === "folder") {
      item.classList.add("is-folder");
      item.innerHTML = `<span class="note-link-picker-title">${escapeHtml(row.title)}</span>`
        + `<span class="note-link-picker-path">${row.count === 1 ? "1 note" : `${row.count} notes`}</span>`;
    } else {
      item.innerHTML = `<span class="note-link-picker-title">${markedTitle(row.title, row.ranges)}</span>`
        + `<span class="note-link-picker-path">${escapeHtml(row.category)}${row.localId ? "" : " \u00b7 in the cloud"}</span>`;
    }
    el2.appendChild(item);
  });
  if (keepScroll) el2.scrollTop = keepScroll;
}

// Is the caret sitting inside an unclosed "[[…"? Returns the offset of the "["
// pair, or -1. Bounded to one line so an old stray "[[" further up the note
// cannot keep the picker permanently armed.
export function noteLinkPickerContext(value, caret) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const open = value.lastIndexOf("[[", caret);
  if (open < lineStart) return -1;
  const between = value.slice(open + 2, caret);
  if (between.includes("]]") || between.includes("[")) return -1;
  return open;
}

// ── Heading mode ───────────────────────────────────────────────────────────
//
// Type "#" after a note's name and the picker switches from "which note?" to
// "which heading in it?". The resolver has understood "id#slug" targets all
// along; there was simply no way to WRITE one short of typing the internal
// element id by hand, prefix and all. This is that way.
//
// The slugs offered here are generated with the same slugifyHeading() the
// rendered view uses, over a fresh `used` set, so a duplicate title
// disambiguates to "-2" identically on both sides and the link lands.
export const NOTE_LINK_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(\S.*?)[ \t]*#*[ \t]*$/;

export async function headingRowsForEntry(entry, query) {
  let notes = "";
  if (entry?.sameNote || (entry?.localId && entry.localId === state.localDeckId)) {
    // The note being typed in. Read live state, not the saved snapshot: the
    // snapshot lags the editor, so a heading added a minute ago would not be
    // offered. (sameNote also covers a note with no id at all — never saved.)
    notes = state.notes || "";
  } else if (entry?.localId) {
    try {
      notes = (await readDeckSnapshot(entry.localId))?.notes || "";
    } catch (error) {
      console.warn("Could not read that note's headings", error);
      return [];
    }
  } else {
    // A cloud-only deck has no local snapshot to read. Offering nothing beats
    // erroring — the note-level link is still there to fall back on, the same
    // way loadNoteLinkIndex degrades when the network is down.
    return [];
  }
  const used = new Set();
  const rows = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of notes.split("\n")) {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    const match = NOTE_LINK_HEADING_RE.exec(line);
    if (!match) continue;
    // Strip the inline markdown the renderer would have removed before
    // slugifying, so "## The **chain** rule" slugs the same on both sides.
    const text = notesAnchorPlainText(match[1]).replace(/\s+/g, " ").trim();
    if (!text) continue;
    rows.push({ heading: true, entry, headingText: text, slug: slugifyHeading(text, used), title: `${entry.title} › ${text}` });
  }
  const needle = query.toLowerCase();
  return (needle ? rows.filter((r) => r.headingText.toLowerCase().includes(needle)) : rows)
    .slice(0, NOTE_LINK_PICKER_LIMIT);
}

export async function updateNoteLinkPicker() {
  const textarea = el.notesEdit;
  if (!textarea || textarea.hidden) return closeNoteLinkPicker();
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) return closeNoteLinkPicker();

  const open = noteLinkPickerContext(textarea.value, caret);
  if (open === -1) return closeNoteLinkPicker();

  const typed = textarea.value.slice(open + 2, caret);
  const index = await loadNoteLinkIndex();
  // Recheck: the index may have taken a cloud round trip, and the caret has had
  // time to move somewhere else entirely.
  if (noteLinkPickerContext(textarea.value, textarea.selectionStart) !== open) return closeNoteLinkPicker();

  // "Note#head" — the note part is settled, so offer that note's headings.
  const hash = typed.indexOf("#");
  if (hash !== -1) {
    const noteName = typed.slice(0, hash).trim().toLowerCase();
    // "[[#" with no note named means a heading in THIS note. Prefix-matching an
    // empty string would otherwise hand back whichever deck happens to sort
    // first, which is never what was meant.
    const entry = !noteName
      ? { localId: state.localDeckId, deckId: state.deckId, title: state.deckTitle || "This note", sameNote: true }
      : index.find((e) => e.title.trim().toLowerCase() === noteName)
        || index.find((e) => e.title.toLowerCase().startsWith(noteName));
    const headingQuery = typed.slice(hash + 1).trim();
    noteLinkBrowsingRows = false;
    if (typed !== noteLinkPickerQuery) {
      noteLinkPickerQuery = typed;
      noteLinkPickerIndex = 0;
    }
    noteLinkPickerRows = entry ? await headingRowsForEntry(entry, headingQuery) : [];
    if (noteLinkPickerContext(textarea.value, textarea.selectionStart) !== open) return closeNoteLinkPicker();
    if (!noteLinkPickerRows.length) return closeNoteLinkPicker();
    noteLinkPickerStart = open;
    noteLinkPickerIndex = Math.min(noteLinkPickerIndex, noteLinkPickerRows.length - 1);
    renderNoteLinkPicker(headingQuery);
    positionNoteLinkPicker(textarea, open);
    return;
  }

  const query = typed.trim();
  if (query !== noteLinkPickerQuery) {
    noteLinkPickerQuery = query;
    noteLinkPickerIndex = 0;
  }

  // Nothing typed: browse. The library as folders you can walk, headed by what
  // you had open recently — which is the answer often enough that most links
  // never need a query at all.
  if (!query) {
    if (!isNoteLinkPickerOpen()) {
      noteLinkBrowseHome = noteLinkHomeFolder();
      noteLinkBrowseCwd = noteLinkBrowseHome;
    }
    noteLinkBrowsingRows = true;
    noteLinkPickerRows = browseRowsFor(index, noteLinkBrowseCwd, { includeRecent: noteLinkBrowseCwd === noteLinkBrowseHome });
    if (!noteLinkPickerRows.length) {
      // A folder with nothing in it is still somewhere you can be — dropping
      // back to the root beats closing the popup out from under the caret.
      if (noteLinkBrowseCwd) {
        noteLinkBrowseCwd = "";
        noteLinkPickerRows = browseRowsFor(index, "", { includeRecent: true });
      }
      if (!noteLinkPickerRows.length) return closeNoteLinkPicker();
    }
    // Last, the way to make something that is not there yet — the same offer
    // the search view ends on, in the browser's own terms: it has no typed name
    // to use, so it asks for one and files it where you were standing.
    noteLinkPickerRows.push({ create: true, browseCreate: true, path: noteLinkBrowseCwd, title: "" });
    noteLinkPickerStart = open;
    noteLinkPickerIndex = Math.min(noteLinkPickerIndex, noteLinkPickerRows.length - 1);
    // Never open ON the "back out" row: it is a way out of somewhere you have
    // not been yet, and pressing Enter on it would answer "[[" by doing nothing
    // visible. Only when it is where the highlight LANDED by default — moving
    // onto it deliberately is fine.
    if (noteLinkPickerIndex === 0 && noteLinkPickerRows[0]?.kind === "up" && noteLinkPickerRows.length > 1) {
      noteLinkPickerIndex = 1;
    }
    renderNoteLinkPicker("");
    positionNoteLinkPicker(textarea, open);
    return;
  }

  // Something typed: search, across the whole library rather than the folder
  // being browsed. Half-remembering a name is the normal case, so the match is
  // fuzzy — see scoreNoteEntry — where it used to be a strict substring, which
  // returned nothing for one typo or one skipped word.
  noteLinkBrowsingRows = false;
  const matches = index
    // The note you are in is never a useful thing to link to.
    .filter((entry) => !(entry.localId && entry.localId === state.localDeckId))
    .map((entry) => ({ entry, hit: scoreNoteEntry(entry, query) }))
    .filter((row) => row.hit)
    .sort((a, b) => {
      // Whole notes before quick-note pins: a pin is a scrap, a note is a
      // destination, and there can be far more of the former.
      const aPin = a.entry.pinId ? 1 : 0;
      const bPin = b.entry.pinId ? 1 : 0;
      return aPin - bPin || b.hit.score - a.hit.score || a.entry.title.localeCompare(b.entry.title);
    })
    .slice(0, NOTE_LINK_PICKER_LIMIT);

  noteLinkPickerRows = matches.map(({ entry, hit }) => ({ ...entry, kind: "note", ranges: hit.ranges, create: false }));
  noteLinkPickerRows.push({ create: true, title: query });

  noteLinkPickerStart = open;
  noteLinkPickerIndex = Math.min(noteLinkPickerIndex, noteLinkPickerRows.length - 1);
  renderNoteLinkPicker(query);
  positionNoteLinkPicker(textarea, open);
}

export function moveNoteLinkPicker(delta) {
  if (!noteLinkPickerRows.length) return;
  const count = noteLinkPickerRows.length;
  noteLinkPickerIndex = (noteLinkPickerIndex + delta + count) % count;
  const typed = el.notesEdit.value.slice(noteLinkPickerStart + 2, el.notesEdit.selectionStart);
  // In heading mode only the part after "#" is what the rows were matched on,
  // and it is what renderNoteLinkPicker highlights. In browse mode nothing was
  // typed at all, so the query is empty and the rows keep their own marks.
  const hash = typed.indexOf("#");
  const query = (hash === -1 ? typed : typed.slice(hash + 1)).trim();
  renderNoteLinkPicker(query);
  noteLinkPickerEl.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
}

// The label sits between [[ and | in the source, so those characters cannot
// appear inside it. A quick-note pin's label is a slice of somebody's prose and
// a deck title is free text, so neither can be trusted to be clean.
export function sanitizeNoteLinkLabel(title) {
  return String(title).replace(/[[\]|\n]+/g, " ").replace(/\s+/g, " ").trim() || "note";
}

// Replace the "[[query" the user has typed with a finished reference.
export function insertNoteLinkAtPicker(entry, headingSlug = "") {
  const textarea = el.notesEdit;
  if (!textarea || noteLinkPickerStart < 0) return;
  const caret = textarea.selectionStart;
  // noteLinkIdFor, not `entry.localId || entry.deckId` — that preference was
  // backwards, and every link written through this picker went into the
  // markdown addressed by an id no other device had ever heard of. See the
  // note-reference header.
  const baseId = noteLinkIdFor(entry);
  const id = baseId && headingSlug ? `${baseId}#${headingSlug}` : baseId;
  const label = sanitizeNoteLinkLabel(
    headingSlug && entry.headingText ? `${entry.title} › ${entry.headingText}` : entry.title
  );
  // A heading in a note with no id yet (never saved, so nothing to point at):
  // fall back to the pipe-less same-note form, which resolveNoteLink reads as
  // "a heading in whatever note this is" and so cannot go stale.
  const link = !baseId && headingSlug && entry.headingText
    ? `[[#${sanitizeNoteLinkLabel(entry.headingText)}]]`
    : id ? `[[${label}|${id}]]` : `[[${label}]]`;
  const before = textarea.value.slice(0, noteLinkPickerStart);
  // Swallow a closing "]]" the caret is sitting in front of. Typing "[" twice
  // produces "[[]]" with the caret between them on any keyboard that
  // auto-pairs brackets — which is most phone keyboards and several desktop
  // IMEs — and this used to keep it, so picking a note gave "[[Note|ld_x]]]]".
  // A lone "]" is eaten too, for the half-paired case.
  const rest = textarea.value.slice(caret);
  const trailing = rest.startsWith("]]") ? 2 : rest.startsWith("]") ? 1 : 0;
  const after = rest.slice(trailing);
  textarea.value = before + link + after;
  const at = before.length + link.length;
  textarea.setSelectionRange(at, at);
  closeNoteLinkPicker();
  // The input event is what keeps state.notes, the autosave and the highlight
  // mirror in step — dispatching it means this edit is treated as any typed
  // edit would be, rather than needing its own copy of all three.
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

// Step into a folder (or back out of one) and redraw. Deliberately does not
// touch the textarea: the row's pointerdown already called preventDefault, so
// focus never left the editor and the caret the eventual insert is measured
// against is still exactly where it was.
// True when the highlighted row is a folder, so a key that means "open this"
// can tell whether there is anything to open — pressing → on a NOTE row must
// not quietly insert a link nobody asked for.
export function noteLinkPickerRowIsFolder() {
  const row = noteLinkPickerRows[noteLinkPickerIndex];
  return Boolean(row && (row.kind === "folder" || row.kind === "up"));
}

export function enterNoteLinkFolder(path) {
  noteLinkBrowseCwd = String(path || "");
  noteLinkPickerIndex = 0;
  updateNoteLinkPicker();
}

export async function commitNoteLinkPicker() {
  const row = noteLinkPickerRows[noteLinkPickerIndex];
  if (!row) return;
  // A folder is a place, not a destination — choosing it opens it.
  if (row.kind === "folder" || row.kind === "up") {
    enterNoteLinkFolder(row.path);
    return;
  }
  if (row.heading) {
    // headingText rides along so the written label reads "Note › Heading"
    // rather than just the note's name, which would give two links to two
    // different places in one note identical text.
    insertNoteLinkAtPicker({ ...row.entry, headingText: row.headingText }, row.slug);
    return;
  }
  if (!row.create) {
    insertNoteLinkAtPicker(row);
    return;
  }
  // Creating: the folder picker is a modal, so remember where the reference
  // goes before the caret can be disturbed, and put it back afterwards.
  const textarea = el.notesEdit;
  const start = noteLinkPickerStart;
  const caret = textarea.selectionStart;
  const into = row.browseCreate ? row.path : "";
  const startedIn = currentDeckKey();
  closeNoteLinkPicker();
  // Browsing had nothing typed to name the note with, so ask. Cancelling here
  // is a no-op that puts the caret back, exactly as cancelling the folder
  // chooser below is.
  const title = row.browseCreate ? await askForNewNoteTitle(into) : row.title;
  if (!title) {
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    return;
  }
  const created = await createLinkedNoteFlow(title, "", { into });
  if (!created) {
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    return;
  }
  // Both offsets were captured BEFORE awaiting a modal, and an autosave or a
  // link rewrite can rewrite the textarea while it is open. Splicing at a stale
  // offset would drop the reference into the middle of some other sentence, so
  // re-check that the "[[" we opened on is still where we left it and give up
  // quietly rather than corrupt the note. The deck check is the coarser half of
  // the same guard: if the open note changed outright, the offsets describe a
  // document that is no longer loaded.
  if (currentDeckKey() !== startedIn || textarea.value.slice(start, start + 2) !== "[[" || caret > textarea.value.length) {
    textarea.focus();
    showToast(`Created "${created.title}" — the note changed while it was being made, so no link was inserted`, "info");
    return;
  }
  noteLinkPickerStart = start;
  textarea.setSelectionRange(caret, caret);
  insertNoteLinkAtPicker(created);
}

// Alt+S while browsing: newest-first ⇄ A–Z. A bare letter cannot do it — every
// unmodified key belongs to the query being typed — and the chip in the
// breadcrumb is the same switch for a pointer.
export function toggleNoteLinkPickerSort() {
  if (!isNoteLinkPickerOpen()) return false;
  toggleNoteLinkBrowseSort();
  noteLinkPickerIndex = 0;
  updateNoteLinkPicker();
  return true;
}

// The name for a note being created from the browser. Resolves to "" on a
// cancel — showPromptModal's onCancel exists for exactly this, so an awaited
// prompt cannot leave its caller hanging on a dismissed modal.
export function askForNewNoteTitle(into) {
  const where = folderCrumbs(into).map((crumb) => crumb.name).join(" \u203a ");
  return new Promise((resolve) => {
    showPromptModal(
      "New note",
      where ? `It will be filed in ${where}, and linked from here.` : "You'll choose the folder next.",
      "",
      (value) => resolve(String(value || "").trim()),
      { placeholder: "Note title", onCancel: () => resolve("") }
    );
  });
}
