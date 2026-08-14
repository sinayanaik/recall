// The `[[` autocomplete in the raw editor: notes, and headings within them.

import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { readDeckSnapshot, state } from "../main.js?v=__BUILD__";
import { notesAnchorPlainText } from "./anchors.js?v=__BUILD__";
import { caretRectInBackdrop } from "./caret.js?v=__BUILD__";
import { createLinkedNoteFlow, loadNoteLinkIndex } from "./note-links.js?v=__BUILD__";
import { currentDeckKey } from "./scroll-anchor.js?v=__BUILD__";
import { slugifyHeading } from "./toc.js?v=__BUILD__";
import { noteLinkIdFor } from "../render/note-links.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { currentKeyboardInset } from "../ui/style-settings.js?v=__BUILD__";

// ── The [[ picker ───────────────────────────────────────────────────────────
//
// Type "[[" in the raw notes editor and every note in the library becomes
// searchable from where the caret already is. This is the only place that
// writes the id form of a link, which is what makes picked links survive a
// rename while hand-typed ones do not.
//
// The last row is always "create what you just typed". A reference to something
// that does not exist yet is the normal way to write — you name the idea while
// it is in your head and fill it in later — so that has to be one keystroke,
// not a trip to My Decks and back.
export const NOTE_LINK_PICKER_LIMIT = 8;

export let noteLinkPickerEl = null;

export let noteLinkPickerRows = [];

export let noteLinkPickerIndex = 0;

export let noteLinkPickerStart = -1;

export function isNoteLinkPickerOpen() {
  return noteLinkPickerStart >= 0 && noteLinkPickerEl && !noteLinkPickerEl.hidden;
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
  noteLinkPickerEl.addEventListener("pointerdown", (event) => {
    const row = event.target.closest("[data-picker-index]");
    if (!row) return;
    event.preventDefault();
    noteLinkPickerIndex = Number(row.dataset.pickerIndex);
    commitNoteLinkPicker();
  });
  document.body.appendChild(noteLinkPickerEl);
  return noteLinkPickerEl;
}

export function closeNoteLinkPicker() {
  noteLinkPickerStart = -1;
  noteLinkPickerRows = [];
  noteLinkPickerIndex = 0;
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

export function renderNoteLinkPicker(query) {
  const el2 = ensureNoteLinkPickerEl();
  el2.innerHTML = "";
  noteLinkPickerRows.forEach((row, index) => {
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
      item.innerHTML = `<span class="note-link-picker-title">Create “${escapeHtml(query)}” as a new note</span>`
        + `<span class="note-link-picker-path">You'll choose the folder</span>`;
    } else {
      item.innerHTML = `<span class="note-link-picker-title">${escapeHtml(row.title)}</span>`
        + `<span class="note-link-picker-path">${escapeHtml(row.category)}${row.localId ? "" : " · in the cloud"}</span>`;
    }
    el2.appendChild(item);
  });
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
  const needle = query.toLowerCase();
  const matches = (needle
    ? index.filter((entry) => entry.title.toLowerCase().includes(needle))
    : index
  )
    // The note you are in is never a useful thing to link to.
    .filter((entry) => !(entry.localId && entry.localId === state.localDeckId))
    .sort((a, b) => {
      // Whole notes before quick-note pins: a pin is a scrap, a note is a
      // destination, and there can be far more of the former.
      const aPin = a.pinId ? 1 : 0;
      const bPin = b.pinId ? 1 : 0;
      // Then titles that START with what was typed — almost always the one
      // meant, and it stops a short query burying it under substring matches
      // from elsewhere in the library.
      const aStarts = a.title.toLowerCase().startsWith(needle) ? 0 : 1;
      const bStarts = b.title.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPin - bPin || aStarts - bStarts || a.title.localeCompare(b.title);
    })
    .slice(0, NOTE_LINK_PICKER_LIMIT);

  noteLinkPickerRows = matches.map((entry) => ({ ...entry, create: false }));
  if (query) noteLinkPickerRows.push({ create: true, title: query });
  if (!noteLinkPickerRows.length) return closeNoteLinkPicker();

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
  // and it is what renderNoteLinkPicker highlights.
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

export async function commitNoteLinkPicker() {
  const row = noteLinkPickerRows[noteLinkPickerIndex];
  if (!row) return;
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
  const title = row.title;
  const startedIn = currentDeckKey();
  closeNoteLinkPicker();
  const created = await createLinkedNoteFlow(title);
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
