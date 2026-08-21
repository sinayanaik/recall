// A note attached to a highlight, said in the note itself.
//
// format/highlight-notes.js is the storage side: the text lives as plain
// markdown in a "## Highlight Notes" section at the end of the same note, and
// the <mark> in the body carries only a short id pointing at it. That is a good
// place to KEEP a note and a bad place to READ one — the annotation for a
// sentence on page 3 sits four hundred paragraphs below the sentence, and until
// you tap the highlight there is nothing on screen to say the note exists at
// all.
//
// Two layers, and they are deliberately different in kind:
//
//   1. ALWAYS ON — an annotated highlight is marked as annotated. A dotted
//      underline and a small ✎, both drawn without advancing a single pixel
//      (see below). It says "there is something here"; tapping the mark opens
//      the menu that shows it, exactly as before.
//
//   2. OPT-IN — every note is numbered in reading order and PRINTED where it
//      belongs: merged into its own paragraph in brackets when it is one line,
//      as a tinted block straight after that paragraph when it is more. The
//      "## Highlight Notes" section is hidden while this is on, so each note is
//      on screen once rather than twice. Toggled from the notes ⋯ menu and
//      remembered across sessions.
//
// ── Nothing here may advance the text by a pixel ──────────────────────────
//
// Every indicator that sits ON a <mark> is drawn with position/text-decoration
// and never with inline content. styles/23-highlight-marks.css exists entirely
// because a mark that widens its own text re-wraps the block it is in, and a
// rewrap after renderNotesViewPinned has measured its anchor is the "severe
// shivering when I highlight" report. A superscript number added as real
// content would reintroduce that, once per annotated highlight.
//
// The note BODIES do add content, of course — that is what they are — but only
// in the opt-in mode, only on a deliberate toggle, and the toggle repaints
// through preserveNotesReadingPosition so the reader does not move.
//
// ── Why they go INSIDE a block and never beside one ───────────────────────
//
// placeNotesChunks (render/block-cache.js) compares each chunk's childNodes
// identity-for-identity against the block list it planned, and skips the chunk
// whole when they already agree. An unplanned top-level sibling breaks that
// comparison permanently — every chunk would read as stale on every render,
// which is the ~18,000 pointless DOM moves that optimisation exists to avoid —
// and the sweep right after it would delete the node anyway. Appending a child
// INSIDE a block node is invisible to all of it, survives patchRenderedBlocks
// (which replaces whole blocks), and leaves the block-index mapping that
// raw-offset.js, toc.js and scroll-anchor.js depend on completely intact.
//
// ── ...and why the source matcher must never see them ─────────────────────
//
// locateSelectionInSource finds a rendered selection in the raw markdown by
// matching its text. Note text injected into a <p> would make every highlight,
// cloze and erase on that paragraph miss. Two places already know how to skip
// an element: cleanedSelectionFragment's removal list and the walk in
// emitTextWithLineBreaks (which is what the occurrence counter uses, over the
// LIVE dom, so it needs the skip independently of the clone). Both carry
// .hl-inline-note now, and the CSS adds user-select: none on top.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { HIGHLIGHT_SCAN_RE } from "../format/highlight.js?v=__BUILD__";
import { HIGHLIGHT_NOTES_HEADING, decodeHighlightNote, isHighlightNoteId, readHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, isTopLevelBlockParent } from "../render/block-cache.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { preserveNotesReadingPosition } from "./toc.js?v=__BUILD__";

export const INLINE_HIGHLIGHT_NOTES_KEY = "recall:inlineHighlightNotes";

// The class every injected node carries. Named once because four other files
// have to agree on it: two selection skips, the stylesheet, and the sweep here.
export const INLINE_NOTE_CLASS = "hl-inline-note";

// Blocks of the hidden "Highlight Notes" section carry this; the section is
// only actually hidden while <body> also carries `inline-hl-notes`, so a stale
// class left on a block by a mode that has since been turned off is inert.
export const HIDDEN_SECTION_CLASS = "hl-notes-section-block";

export const BODY_INLINE_CLASS = "inline-hl-notes";

// Where a note is allowed to land. The nearest of these ANCESTORS of the mark,
// which is "the paragraph the highlight is in" for every shape a note takes —
// a list item, a table cell, a heading, a line of a blockquote. The search
// stops at the block boundary (see noteHostFor), so it can never walk out of
// the block and into the chunk wrapper.
const NOTE_HOST_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption";

// ── The index: numbers that do not depend on what has been built ──────────
//
// Numbering has to come from the SOURCE, never from DOM order. A note long
// enough to matter is built lazily, chunk by chunk, as the reader comes near
// each part of it (see findSafeLexerBoundaries) — so a counter that walked the
// rendered document would hand out 1, 2, 3 for whatever happened to exist, and
// renumber everything the moment the reader scrolled far enough to build more.
//
// Keyed on the raw data-note attribute rather than on the id, so a note written
// before the section format existed (inline base64, see decodeHighlightNote)
// is numbered and printed alongside the rest instead of being a second case
// every caller has to remember.
//
// Memoized on the source STRING IDENTITY — every path that edits a note assigns
// a fresh string to state.notes, and every path that does not leaves the very
// same object, so this is an O(1) pointer compare in the common case.
let indexSource = null;
let indexValue = null;

// Cheap, stable and small enough to keep: the ids, their numbers and a hash of
// each body. What a full refresh actually needs to know is "did any number or
// any note text change", and this answers it without holding a second copy of
// every note. See refreshInlineHighlightNotes.
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function buildIndex(source) {
  const byAttr = new Map();
  // The gate that keeps this off the hot path of opening an unannotated note:
  // one memchr over the source, and the overwhelming majority of notes stop
  // here. Same test migrateLegacyHighlightNotes opens with, for the same
  // reason.
  if (source && source.includes("data-note=")) {
    const section = readHighlightNotes(source);
    let n = 0;
    HIGHLIGHT_SCAN_RE.lastIndex = 0;
    let match;
    while ((match = HIGHLIGHT_SCAN_RE.exec(source))) {
      const attr = match[2];
      // A group split across blocks only ever carries the id on its FIRST
      // piece (see rewriteFirstMarkNote), so `has` here is about the section's
      // own text mentioning an id, not about a highlight being seen twice.
      if (!attr || byAttr.has(attr)) continue;
      // Resolved through the section rather than trusted: an id whose entry was
      // deleted by hand is not a note and must not be numbered, the same rule
      // mark-menu.js follows before it lights its pencil up.
      const text = isHighlightNoteId(attr) ? section.get(attr) || "" : decodeHighlightNote(attr);
      if (!text) continue;
      n += 1;
      byAttr.set(attr, { n, text });
    }
  }
  let signature = `${byAttr.size}`;
  byAttr.forEach((info, attr) => { signature += `|${attr}:${info.n}:${hash32(info.text)}`; });
  return { byAttr, signature };
}

export function highlightNoteIndex(source) {
  if (indexSource === source && indexValue) return indexValue;
  indexSource = source;
  indexValue = buildIndex(source);
  return indexValue;
}

// ── The mode ──────────────────────────────────────────────────────────────

let inlineNotesOn = false;

export function isInlineHighlightNotesOn() {
  return inlineNotesOn;
}

// Seeded by main.js at startup, the same shape as FOCUS_MODE_KEY: an imported
// binding is read-only, so the flag needs a setter of its own.
export function setInlineHighlightNotesFlag(value) {
  inlineNotesOn = Boolean(value);
}

function paintInlineNotesButton() {
  const button = el.inlineNotesBtn;
  if (!button) return;
  button.setAttribute("aria-pressed", inlineNotesOn ? "true" : "false");
  button.title = inlineNotesOn
    ? "Hide highlight notes in the text — read them from the highlight instead"
    : "Show every highlight's note in the text, numbered where it belongs";
}

// One path for both ways in, so the button, the stored preference and the DOM
// can never disagree about what "on" means.
export function applyInlineHighlightNotes() {
  document.body.classList.toggle(BODY_INLINE_CLASS, inlineNotesOn);
  paintInlineNotesButton();
  // The added note bodies change how tall the note is, so the reader would
  // otherwise be somewhere else when it settles. Everything above them moves;
  // this pins the block they were reading and puts it back.
  preserveNotesReadingPosition(() => refreshInlineHighlightNotes({ force: true }));
}

export function toggleInlineHighlightNotes() {
  inlineNotesOn = !inlineNotesOn;
  try {
    localStorage.setItem(INLINE_HIGHLIGHT_NOTES_KEY, inlineNotesOn ? "1" : "0");
  } catch (_) {
    /* private mode — the toggle still works for this session */
  }
  applyInlineHighlightNotes();
}

// ── Finding the paragraph a note belongs after ────────────────────────────

function noteHostFor(mark, container) {
  let node = mark.parentElement;
  // Bounded by the block, never by the document: a chunk wrapper is not a
  // paragraph, and #notesView itself certainly is not.
  while (node && node !== container && !node.classList?.contains(NOTES_CHUNK_CLASS)) {
    if (node.matches(NOTE_HOST_SELECTOR)) return node;
    node = node.parentElement;
  }
  // Nothing paragraph-shaped in between — the mark sits directly in a
  // top-level block of a kind not in the list. Fall back to that block, which
  // is still inside the chunk and so still safe to append to.
  let top = mark;
  while (top.parentElement && !isTopLevelBlockParent(top.parentElement, container)) top = top.parentElement;
  return isTopLevelBlockParent(top.parentElement, container) ? top : null;
}

// Markdown, sanitized, and unwrapped for the merged form. A one-line note comes
// back from marked as a single <p>, which cannot be dropped into the middle of
// the paragraph it is being merged into — so that one wrapper is peeled off.
// Anything with real structure keeps it and takes the block form instead.
function noteHtml(text, merged) {
  const html = markdownToSafeHtml(text);
  if (!merged) return html;
  const probe = document.createElement("div");
  probe.innerHTML = html;
  if (probe.children.length === 1 && probe.firstElementChild.tagName === "P") {
    return probe.firstElementChild.innerHTML;
  }
  return html;
}

// A note is "one paragraph" when it has no line break in it at all — the
// reader's own test, and the one they described: written on one line, it reads
// as an aside and belongs in the sentence; written over several, it is a
// passage of its own and belongs under it.
function isMergedNote(text) {
  return !/\n/.test(text.trim());
}

function inlineNoteNode(info) {
  const merged = isMergedNote(info.text);
  const node = document.createElement("span");
  node.className = `${INLINE_NOTE_CLASS} ${merged ? "is-merged" : "is-block"}`;
  node.dataset.hnKey = `${info.n}`;
  node.dataset.hnSig = hash32(info.text);
  // Not focusable, not selectable, not a link — this is a printed copy of
  // something you edit from the highlight itself. aria-hidden because the note
  // is already reachable (and editable) through the mark's own menu, and a
  // screen reader hitting the same words twice in one paragraph is worse than
  // reaching them one way.
  node.setAttribute("aria-hidden", "true");
  const number = document.createElement("span");
  number.className = "hl-inline-note-num";
  number.textContent = `${info.n}`;
  const body = document.createElement("span");
  body.className = "hl-inline-note-body";
  body.innerHTML = noteHtml(info.text, merged);
  node.append(number, body);
  return node;
}

// ── Hiding the section the notes are stored in ────────────────────────────
//
// Only while the inline mode is on, and only in the RENDERED view: the markdown
// is untouched, so the raw editor, the Highlights tab and every export still
// carry it. Without this the same note is on screen twice — once where it
// belongs and once at the foot of the document.
//
// Walked BACKWARDS from the end of the note rather than found with a query.
// The section is always the last thing in the document (sectionStartIn takes
// the LAST "## Highlight Notes" heading, so that a book whose own text contains
// those words is not mistaken for it), and a querySelectorAll for "h2" is a
// full walk of a document that can be a couple of hundred thousand elements.
// Backwards, the search costs about two blocks per note and stops the moment it
// finds the heading.
//
// Nothing is marked unless the heading is actually found. A note with no
// section at all (every one written before a highlight was annotated) would
// otherwise have its tail hidden by a walk that ran out of budget.
let hiddenSectionNodes = [];

function clearHiddenSection() {
  hiddenSectionNodes.forEach((node) => node.classList?.remove(HIDDEN_SECTION_CLASS));
  hiddenSectionNodes = [];
}

function topLevelBlocksFromEnd(container, limit) {
  const out = [];
  let outer = container.lastElementChild;
  while (outer && out.length < limit) {
    if (outer.classList?.contains(NOTES_CHUNK_CLASS)) {
      let child = outer.lastElementChild;
      while (child && out.length < limit) {
        out.push(child);
        child = child.previousElementSibling;
      }
    } else {
      out.push(outer);
    }
    outer = outer.previousElementSibling;
  }
  return out;
}

function hideHighlightNotesSection(container, noteCount) {
  clearHiddenSection();
  if (!noteCount) return;
  // Each entry is a "### [id] …" heading plus its body, so the section is
  // roughly two blocks per note plus the "## Highlight Notes" heading. Three
  // per note leaves room for a note written as several paragraphs, and the
  // walk stops early the moment the heading turns up.
  const budget = noteCount * 3 + 8;
  const blocks = topLevelBlocksFromEnd(container, budget);
  const at = blocks.findIndex(
    (node) => node.tagName === "H2" && node.textContent.trim() === HIGHLIGHT_NOTES_HEADING
  );
  if (at === -1) return; // not built yet, or this note has no section
  const section = blocks.slice(0, at + 1);
  section.forEach((node) => node.classList.add(HIDDEN_SECTION_CLASS));
  hiddenSectionNodes = section;
}

// ── The passes ────────────────────────────────────────────────────────────

// One mark. Both layers, because they resolve the same note and it would be a
// second lookup to separate them.
function annotateMark(mark, index, container) {
  const info = index.byAttr.get(mark.getAttribute("data-note"));
  mark.classList.toggle("has-note", Boolean(info));
  if (!info || !inlineNotesOn) {
    if (mark.dataset.hnNum) delete mark.dataset.hnNum;
    return null;
  }
  mark.dataset.hnNum = `${info.n}`;
  const host = noteHostFor(mark, container);
  if (!host) return null;
  // Idempotent. The enhancement passes run again on re-render, and a block that
  // patchRenderedBlocks reused still carries the note it was given last time —
  // so this replaces one whose number or text has moved and leaves the rest
  // exactly where they are.
  const already = host.querySelector(`:scope > .${INLINE_NOTE_CLASS}[data-hn-key="${info.n}"]`);
  if (already) {
    if (already.dataset.hnSig === hash32(info.text)) return already;
    // The REPLACEMENT is what gets returned, held rather than re-queried:
    // replaceWith puts it exactly where the old one was, which is not
    // necessarily last — a paragraph can carry two notes — and the caller adds
    // this to the set of nodes it will not sweep away.
    const fresh = inlineNoteNode(info);
    already.replaceWith(fresh);
    return fresh;
  }
  const node = inlineNoteNode(info);
  host.append(node);
  return node;
}

// Per-chunk. Called from enhanceRenderedMarkdown with the nodes the incremental
// renderer just built, which is what keeps a book paying only for the part of
// itself that is on screen.
export function annotateHighlightNotes(container, roots = null) {
  if (!container) return;
  const index = highlightNoteIndex(state.notes || "");
  if (!index.byAttr.size) return;
  scopedQueryAll(roots || [container], "mark[data-note]")
    .forEach((mark) => annotateMark(mark, index, container));
  if (!inlineNotesOn) return;
  // Only when the tail of the document is part of what was just built — the
  // section lives there and nowhere else, so every other chunk's arrival is
  // irrelevant to it.
  const last = container.lastElementChild;
  const touchedTail = !roots || roots.some((root) => root === last || last?.contains(root));
  if (touchedTail) hideHighlightNotesSection(container, index.byAttr.size);
}

// Whole-document. Every path that can change a NUMBER or a note's TEXT comes
// through renderNotesView, so that is the single hook — but it is also the path
// a plain repaint takes, and sweeping a book-sized document for
// `mark[data-note]` (an attribute selector, so no index can answer it) on every
// repaint is exactly the kind of cost this codebase keeps having to take back
// out. The signature is what makes it free: it changes only when a note's
// number or body changed, which is the only time there is anything to redo.
let appliedSignature = null;
let appliedInline = null;

export function refreshInlineHighlightNotes({ force = false } = {}) {
  const container = el.notesView;
  if (!container) return;
  const index = highlightNoteIndex(state.notes || "");
  if (!force && index.signature === appliedSignature && inlineNotesOn === appliedInline) return;
  appliedSignature = index.signature;
  appliedInline = inlineNotesOn;

  // Turning the mode off, or opening a note with no annotations at all: sweep
  // whatever a previous note or a previous mode left behind. Scoped to the
  // class, which is rare enough that nothing here is on a hot path.
  if (!inlineNotesOn || !index.byAttr.size) {
    container.querySelectorAll(`.${INLINE_NOTE_CLASS}`).forEach((node) => node.remove());
    container.querySelectorAll("mark[data-hn-num]").forEach((mark) => { delete mark.dataset.hnNum; });
    clearHiddenSection();
    if (!index.byAttr.size) {
      container.querySelectorAll("mark.has-note").forEach((mark) => mark.classList.remove("has-note"));
      return;
    }
  }

  const wanted = new Set();
  container.querySelectorAll("mark[data-note]").forEach((mark) => {
    const node = annotateMark(mark, index, container);
    if (node) wanted.add(node);
  });
  // A note whose highlight has gone (its mark removed, or the note deleted)
  // leaves a printed copy behind in a block nobody rebuilt. Anything not
  // claimed by the pass above is one of those.
  container.querySelectorAll(`.${INLINE_NOTE_CLASS}`).forEach((node) => {
    if (!wanted.has(node)) node.remove();
  });
  if (inlineNotesOn) hideHighlightNotesSection(container, index.byAttr.size);
}
